const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { createNotification } = require("../../util/notify");
const { schoolMediaUrl } = require("../public/publicController");
const { generateReceiptNo } = require("../../util/receiptNo");
const { sendEmail } = require("../../Services/EmailService");
const { brandedEmail } = require("../../util/emailTemplate");
const { loadStudentFeeForReceipt, buildReceiptData } = require("../../util/receiptData");
const flutterwave = require("../../Services/FlutterwaveService");
const campusScope = require("../../util/campusScope");
const { claimFeePayment, applyFeePayment } = require("../../util/applyFeePayment");
const inAppFees = require("../../Services/InAppFeeService");
const { AUDIENCES, studentsToBill } = require("../../util/feeInvoices");
const { resolveSessionId } = require("../../util/studentAdmission");
const { notifyNewFees } = require("../../Services/FeeNotifyService");
const { resolveBranding } = require("../../util/campusBranding");

/**
 * A student-fee record of this school, in the admin's campus scope (by the student's
 * campus); 404 otherwise, so another campus's invoice reads as not found.
 */
async function assertFeeInScope(req, studentFeeId) {
  const found = await prisma.studentFee.findFirst({
    where: campusScope.withScope({ id: studentFeeId, schoolId: req.schoolId }, campusScope.viaStudent(req)),
    select: { id: true },
  });
  if (!found) {
    const { AppError } = require("../../util/AppError");
    throw new AppError("Student fee record not found", 404);
  }
}

const PAYMENT_METHODS = ["Bank Transfer", "Cash", "Card"];

/**
 * Nigerian banks whose NIP codes are stable and long-established — used only
 * when Flutterwave's live bank list is unreachable, so the school's own
 * bank-account form isn't blocked by a provider outage. Same list used for
 * the marketer withdrawal-account setup (publicController.js).
 */
const FALLBACK_NG_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "063", name: "Access Bank (Diamond)" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "033", name: "United Bank for Africa" },
  { code: "215", name: "Unity Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

const computeStatus = (totalFee, amountPaid) => {
  if (amountPaid <= 0) return "unpaid";
  if (amountPaid >= totalFee) return "paid";
  return "partial";
};

const formatStudentFee = (sf) => ({
  id: sf.id,
  studentName: `${sf.student.name} ${sf.student.surname}`,
  admissionNo: sf.student.registrationNumber,
  class: sf.feeStructure.class.name,
  feeTitle: sf.feeStructure.title,
  term: sf.feeStructure.term,
  session: sf.feeStructure.session,
  dueDate: sf.feeStructure.dueDate,
  totalFee: sf.totalFee,
  amountPaid: sf.amountPaid,
  outstanding: Math.max(sf.totalFee - sf.amountPaid, 0),
  status: sf.status,
  lastPaymentDate: sf.payments?.[0]?.paymentDate ?? null,
  parentName: sf.student.guardianName,
  parentPhone: sf.student.guardianNumber,
  parentEmail: sf.student.guardianEmail,
});

/**
 * POST /api/admin/fees/structure
 * Create or update a fee breakdown for a class in a given term/session.
 * Auto-generates a StudentFee invoice for every student currently in that class.
 */
exports.upsertFeeStructure = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { term, session, items, note } = req.body;
    const title = String(req.body.title ?? "School Fees").replace(/\s+/g, " ").trim();
    const audience = req.body.audience ?? "all";
    const dueDate = req.body.dueDate ? new Date(`${String(req.body.dueDate).slice(0, 10)}T00:00:00.000Z`) : null;
    // One class (the original shape) or several at once.
    const classIds = [...new Set((Array.isArray(req.body.classIds) ? req.body.classIds : [req.body.classId]).map((id) => parseInt(id)).filter(Number.isInteger))];

    if (classIds.length === 0 || !term || !session || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "classId (or classIds), term, session, and a non-empty items array are required",
        code: "MISSING_FIELDS",
      });
    }
    if (classIds.length > 80) {
      return res.status(400).json({ success: false, message: "Choose at most 80 classes at a time", code: "TOO_MANY_CLASSES" });
    }
    if (!title || title.length > 100) {
      return res.status(400).json({ success: false, message: "Give the fee a name of up to 100 characters", code: "INVALID_TITLE" });
    }
    if (!AUDIENCES.includes(audience)) {
      return res.status(400).json({ success: false, message: "audience must be all, fresh or returning", code: "INVALID_AUDIENCE" });
    }
    if (dueDate && Number.isNaN(dueDate.getTime())) {
      return res.status(400).json({ success: false, message: "The due date is not a valid date", code: "INVALID_DUE_DATE" });
    }
    if (note && String(note).length > 500) {
      return res.status(400).json({ success: false, message: "The note can be up to 500 characters", code: "INVALID_NOTE" });
    }

    const invalidItems = items.filter((i) => !i.name || typeof i.amount !== "number" || i.amount < 0);
    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Each item requires a name and a non-negative numeric amount",
        code: "INVALID_ITEMS",
      });
    }

    // Fresh / returning only means something against a real session, which is what "earlier" is measured from.
    if (audience !== "all" && (await resolveSessionId(prisma, schoolId, session)) === null) {
      return res.status(400).json({
        success: false,
        message: "Choose the session from your school's list for a fee that is only for fresh or returning students",
        code: "SESSION_NOT_FOUND",
      });
    }

    const classRecords = await prisma.class.findMany({
      where: campusScope.withScope({ id: { in: classIds }, schoolId }, campusScope.classWhere(req)),
    });
    if (classRecords.length !== classIds.length) {
      return res.status(404).json({ success: false, message: "One of the classes was not found", code: "CLASS_NOT_FOUND" });
    }

    const totalAmount = items.reduce((sum, i) => sum + i.amount, 0);
    const newInvoiceIds = [];

    const results = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const classRecord of classRecords) {
        const data = { dueDate, note: note ? String(note).trim() : null };
        const existing = await tx.feeStructure.findUnique({
          where: { classId_term_session_title_audience: { classId: classRecord.id, term, session, title, audience } },
        });

        let structure;
        if (existing) {
          await tx.feeStructureItem.deleteMany({ where: { feeStructureId: existing.id } });
          structure = await tx.feeStructure.update({
            where: { id: existing.id },
            data: { ...data, items: { create: items.map((i) => ({ name: i.name, amount: i.amount })) } },
            include: { items: true },
          });
        } else {
          structure = await tx.feeStructure.create({
            data: { schoolId, classId: classRecord.id, term, session, title, audience, ...data, items: { create: items.map((i) => ({ name: i.name, amount: i.amount })) } },
            include: { items: true },
          });
        }

        // Invoice the class's students this fee is for, and bring existing invoices up to the new total
        // (keeping whatever was already paid).
        const students = await tx.student.findMany({
          where: { classId: classRecord.id, schoolId, status: "active" },
          select: { id: true, feeCategory: true, academicSessionId: true },
        });
        const { billed } = await studentsToBill(tx, { audience, session, schoolId }, students);
        const have = await tx.studentFee.findMany({
          where: { feeStructureId: structure.id, studentId: { in: billed.map((st) => st.id) } },
        });
        const haveByStudent = new Map(have.map((fee) => [fee.studentId, fee]));

        let created = 0;
        let updated = 0;
        for (const student of billed) {
          const fee = haveByStudent.get(student.id);
          if (!fee) {
            const invoice = await tx.studentFee.create({
              data: { schoolId, studentId: student.id, feeStructureId: structure.id, totalFee: totalAmount, amountPaid: 0, status: "unpaid" },
            });
            newInvoiceIds.push(invoice.id);
            created += 1;
          } else if (fee.totalFee !== totalAmount) {
            await tx.studentFee.update({
              where: { id: fee.id },
              data: { totalFee: totalAmount, status: computeStatus(totalAmount, fee.amountPaid) },
            });
            updated += 1;
          }
        }
        out.push({ classId: classRecord.id, className: classRecord.name, structureId: structure.id, invoicesCreated: created, invoicesUpdated: updated, studentsInClass: students.length, studentsBilled: billed.length });
      }
      return out;
    }, { timeout: 60000 });

    logger.info("[FEE_STRUCTURE_UPSERT] Fee saved", { title, audience, classes: classIds.length, term, session, created: newInvoiceIds.length });

    // Optional: tell the parents. After the save, and never able to undo it.
    const notification = req.body.notifyParents ? await notifyNewFees({ schoolId, studentFeeIds: newInvoiceIds }) : null;

    res.status(200).json({
      success: true,
      message: classRecords.length === 1 ? `${title} saved for ${classRecords[0].name}` : `${title} saved for ${classRecords.length} classes`,
      data: {
        // The original single-class shape, kept for existing callers.
        className: classRecords[0].name,
        term,
        session,
        title,
        audience,
        items: items.map((i) => ({ name: i.name, amount: i.amount })),
        totalAmount,
        results,
        invoicesCreated: newInvoiceIds.length,
        notification,
      },
    });
  } catch (err) {
    logger.error("[FEE_STRUCTURE_UPSERT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/structure?classId=&term=&session=
 * List fee structures for the school, optionally filtered.
 */
exports.getFeeStructures = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { classId, term, session } = req.query;

    const where = { schoolId };
    if (classId) where.classId = parseInt(classId);
    if (term) where.term = term;
    if (session) where.session = session;

    const structures = await prisma.feeStructure.findMany({
      where: campusScope.withScope(where, campusScope.viaClass(req)),
      include: { items: true, class: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const data = structures.map((s) => ({
      id: s.id,
      className: s.class.name,
      term: s.term,
      session: s.session,
      classId: s.classId,
      title: s.title,
      audience: s.audience,
      dueDate: s.dueDate,
      note: s.note,
      items: s.items.map((i) => ({ id: i.id, name: i.name, amount: i.amount })),
      totalAmount: s.items.reduce((sum, i) => sum + i.amount, 0),
    }));

    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error("[GET_FEE_STRUCTURES] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/students
 * Paginated, filterable list of student fee records.
 */
exports.getStudentFees = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const { status, classId, search } = req.query;

    const where = { schoolId };
    if (status) where.status = status;
    if (classId) where.feeStructure = { classId: parseInt(classId) };
    if (search) {
      where.student = {
        OR: [
          { name: { contains: search } },
          { surname: { contains: search } },
          { registrationNumber: { contains: search } },
        ],
      };
    }

    // A restricted admin's list, and its total, hold only their campuses' students.
    const scopedWhere = campusScope.withScope(where, campusScope.viaStudent(req));

    const [records, total] = await Promise.all([
      prisma.studentFee.findMany({
        where: scopedWhere,
        include: {
          student: true,
          feeStructure: { include: { class: { select: { name: true } } } },
          payments: { orderBy: { paymentDate: "desc" }, take: 1 },
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.studentFee.count({ where: scopedWhere }),
    ]);

    res.status(200).json({
      success: true,
      data: records.map(formatStudentFee),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("[GET_STUDENT_FEES] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/debt-summary
 * Aggregate stats for the Debt Overview tab.
 */
exports.getDebtSummary = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;

    const scope = campusScope.viaStudent(req);
    const feeWhere = (extra = {}) => campusScope.withScope({ schoolId, ...extra }, scope);
    const [totals, paidCount, partialCount, unpaidCount] = await Promise.all([
      prisma.studentFee.aggregate({
        where: feeWhere(),
        _sum: { totalFee: true, amountPaid: true },
      }),
      prisma.studentFee.count({ where: feeWhere({ status: "paid" }) }),
      prisma.studentFee.count({ where: feeWhere({ status: "partial" }) }),
      prisma.studentFee.count({ where: feeWhere({ status: "unpaid" }) }),
    ]);

    const totalExpected = totals._sum.totalFee || 0;
    const totalCollected = totals._sum.amountPaid || 0;

    // How each fee (School Fees, PTA Levy...) is doing. A school has a handful of fee names, so one
    // aggregate per name is cheap, and it reuses the same campus scope as the totals above.
    const titles = await prisma.feeStructure.findMany({ where: { schoolId }, select: { title: true }, distinct: ["title"] });
    const byFee = await Promise.all(
      titles.map(async ({ title }) => {
        const agg = await prisma.studentFee.aggregate({ where: feeWhere({ feeStructure: { title } }), _sum: { totalFee: true, amountPaid: true }, _count: { _all: true } });
        const expected = agg._sum.totalFee || 0;
        const collected = agg._sum.amountPaid || 0;
        return { title, invoices: agg._count._all, expected, collected, outstanding: Math.max(expected - collected, 0) };
      }),
    );

    res.status(200).json({
      success: true,
      data: {
        totalExpected,
        totalCollected,
        totalOutstanding: Math.max(totalExpected - totalCollected, 0),
        paidCount,
        partialCount,
        unpaidCount,
        byFee: byFee.filter((f) => f.invoices > 0).sort((a, b) => b.expected - a.expected),
      },
    });
  } catch (err) {
    logger.error("[GET_DEBT_SUMMARY] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/fees/payments
 * Record a payment against a student's fee record. Returns receipt data.
 */
exports.recordPayment = async (req, res, next) => {
  try {
    const adminId = req.user?.id;
    const { studentFeeId, amount, paymentMethod, paymentDate } = req.body;

    if (!studentFeeId || typeof amount !== "number" || amount <= 0 || !paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "studentFeeId, a positive numeric amount, and paymentMethod are required",
        code: "MISSING_FIELDS",
      });
    }

    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(", ")}`,
        code: "INVALID_PAYMENT_METHOD",
      });
    }

    const studentFee = await prisma.studentFee.findFirst({
      where: campusScope.withScope({ id: parseInt(studentFeeId), schoolId: req.schoolId }, campusScope.viaStudent(req)),
      include: {
        student: true,
        feeStructure: { include: { items: true, class: { select: { name: true, campusId: true } } } },
      },
    });

    if (!studentFee) {
      return res.status(404).json({ success: false, message: "Student fee record not found", code: "NOT_FOUND" });
    }

    const receiptNo = await generateReceiptNo();
    const newAmountPaid = studentFee.amountPaid + amount;
    const newStatus = computeStatus(studentFee.totalFee, newAmountPaid);

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          studentFeeId: studentFee.id,
          amount,
          paymentMethod,
          paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
          receiptNo,
          recordedBy: adminId,
        },
      });

      await tx.studentFee.update({
        where: { id: studentFee.id },
        data: { amountPaid: newAmountPaid, status: newStatus },
      });

      return created;
    }, { timeout: 20000 });

    logger.info("[RECORD_PAYMENT] Payment recorded", { studentFeeId: studentFee.id, amount, receiptNo });

    // Notify the school's admins — fire-and-forget, never blocks the response.
    // Only the admins who can see this student's campus hear about the payment.
    campusScope.adminIdsWhoCanSee(prisma, studentFee.schoolId, studentFee.student.campusId ?? studentFee.feeStructure?.class?.campusId).then((adminIds) => {
      const studentName = `${studentFee.student.name} ${studentFee.student.surname}`;
      adminIds.forEach((adminRecipientId) =>
        createNotification({
          recipientType: "admin",
          recipientId: adminRecipientId,
          schoolId: studentFee.schoolId,
          title: "Fee payment received",
          message: `${studentName} paid ₦${amount.toLocaleString()} (receipt ${receiptNo}).`,
          type: "fee_payment",
        })
      );
    });

    const school = await resolveBranding(prisma, {
      schoolId: studentFee.schoolId,
      campusId: studentFee.student.campusId ?? studentFee.feeStructure?.class?.campusId ?? null,
    });
    const [schoolLogo, schoolStamp] = await Promise.all([
      schoolMediaUrl(school?.logoUrl),
      schoolMediaUrl(school?.stampUrl),
    ]);

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully",
      data: {
        receiptNo: payment.receiptNo,
        studentName: `${studentFee.student.name} ${studentFee.student.surname}`,
        admissionNo: studentFee.student.registrationNumber,
        class: studentFee.feeStructure.class.name,
        amountPaid: payment.amount,
        paymentDate: payment.paymentDate,
        paymentMethod: payment.paymentMethod,
        items: studentFee.feeStructure.items.map((i) => ({ name: i.name, amount: i.amount })),
        schoolName: school?.name,
        logoUrl: schoolLogo,
        stampUrl: schoolStamp,
        feeTitle: studentFee.feeStructure.title,
        term: studentFee.feeStructure.term,
        session: studentFee.feeStructure.session,
        isPartial: newStatus === "partial",
        outstanding: Math.max(studentFee.totalFee - newAmountPaid, 0),
        parentEmail: studentFee.student.guardianEmail,
        parentPhone: studentFee.student.guardianNumber,
      },
    });
  } catch (err) {
    logger.error("[RECORD_PAYMENT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/receipts/:studentFeeId
 * Get receipt data for a student's most recent payment.
 */
exports.getReceipt = async (req, res, next) => {
  try {
    const studentFeeId = parseInt(req.params.studentFeeId, 10);
    if (isNaN(studentFeeId)) {
      return res.status(400).json({ success: false, message: "Invalid student fee ID", code: "INVALID_REQUEST" });
    }

    await assertFeeInScope(req, studentFeeId);
    const studentFee = await loadStudentFeeForReceipt(studentFeeId);

    if (!studentFee) {
      return res.status(404).json({ success: false, message: "Student fee record not found", code: "NOT_FOUND" });
    }

    if (studentFee.status === "unpaid" || studentFee.payments.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No payment recorded for this student yet",
        code: "NO_PAYMENT",
      });
    }

    const data = await buildReceiptData(studentFee);
    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error("[GET_RECEIPT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/banks
 * Live list of Nigerian banks (name + NIP code), for the bank-account form's
 * dropdown — degrades to a fixed fallback list on a Flutterwave outage.
 */
exports.getBanks = async (req, res, next) => {
  try {
    let banks;
    try {
      banks = await flutterwave.listBanks();
    } catch (flwErr) {
      logger.warn("[GET_BANKS] Flutterwave unavailable, serving fallback list", { error: flwErr.message });
      banks = FALLBACK_NG_BANKS;
    }
    res.status(200).json({ success: true, data: banks });
  } catch (err) {
    logger.error("[GET_BANKS] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/resolve-account?accountNumber=&bankCode=
 * Resolves an account number to its registered name via Flutterwave, so an
 * admin never has to type the account name by hand (and can't accidentally
 * enter a name that doesn't match the actual account). Fails CLOSED: any
 * resolution error is reported as unverified, never silently ignored.
 */
exports.resolveBankAccount = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.query;
    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        success: false,
        message: "accountNumber and bankCode are required",
        code: "MISSING_FIELDS",
      });
    }

    let resolved;
    try {
      resolved = await flutterwave.resolveAccount({ accountNumber, bankCode });
    } catch (flwErr) {
      logger.warn("[RESOLVE_BANK_ACCOUNT] Could not resolve account", { bankCode, error: flwErr.message });

      if (String(process.env.FLW_SECRET_KEY || "").includes("TEST")) {
        return res.status(503).json({
          success: false,
          message:
            "Bank verification is unavailable while Flutterwave is in test mode. " +
            "The sandbox only resolves its own test accounts (0690000031 or 0690000032 at bank 044). " +
            "A live FLW_SECRET_KEY is required to verify real accounts.",
          code: "PROVIDER_TEST_MODE",
          data: { accountNumber, bankCode, verified: false },
        });
      }

      return res.status(422).json({
        success: false,
        message: "Could not verify this account. Check the account number and bank, then try again.",
        code: "ACCOUNT_VERIFICATION_FAILED",
        data: { accountNumber, bankCode, verified: false },
      });
    }

    if (!resolved.accountName) {
      return res.status(422).json({
        success: false,
        message: "Could not verify this account. Check the account number and bank, then try again.",
        code: "ACCOUNT_VERIFICATION_FAILED",
        data: { accountNumber, bankCode, verified: false },
      });
    }

    res.status(200).json({
      success: true,
      data: { accountNumber: resolved.accountNumber, accountName: resolved.accountName, bankCode, verified: true },
    });
  } catch (err) {
    logger.error("[RESOLVE_BANK_ACCOUNT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/fees/bank-accounts
 * Adds a school bank account parents/students can pay fees into directly.
 */
exports.createBankAccount = async (req, res, next) => {
  try {
    // Bank accounts are the school's, shared by every campus: head admins only.
    if (campusScope.isRestricted(req)) {
      return res.status(403).json({ success: false, message: "Only the head admin can change the school's bank accounts" });
    }
    const { bankName, bankCode, accountName, accountNumber, label } = req.body;
    if (!bankName || !accountName || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: "bankName, accountName and accountNumber are required",
        code: "MISSING_FIELDS",
      });
    }

    const account = await prisma.schoolBankAccount.create({
      data: { schoolId: req.schoolId, bankName, bankCode: bankCode || null, accountName, accountNumber, label: label || null },
    });

    res.status(201).json({ success: true, message: "Bank account added", data: account });
  } catch (err) {
    logger.error("[CREATE_BANK_ACCOUNT] Failed", { error: err.message });
    next(err);
  }
};

/** GET /api/admin/fees/bank-accounts */
exports.getBankAccounts = async (req, res, next) => {
  try {
    const accounts = await prisma.schoolBankAccount.findMany({
      where: { schoolId: req.schoolId },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ success: true, data: accounts });
  } catch (err) {
    logger.error("[GET_BANK_ACCOUNTS] Failed", { error: err.message });
    next(err);
  }
};

/** PATCH /api/admin/fees/bank-accounts/:id */
exports.updateBankAccount = async (req, res, next) => {
  try {
    // Bank accounts are the school's, shared by every campus: head admins only.
    if (campusScope.isRestricted(req)) {
      return res.status(403).json({ success: false, message: "Only the head admin can change the school's bank accounts" });
    }
    const id = parseInt(req.params.id, 10);
    const { bankName, bankCode, accountName, accountNumber, label, isActive } = req.body;

    const existing = await prisma.schoolBankAccount.findFirst({ where: { id, schoolId: req.schoolId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Bank account not found", code: "NOT_FOUND" });
    }

    const account = await prisma.schoolBankAccount.update({
      where: { id },
      data: {
        ...(bankName !== undefined && { bankName }),
        ...(bankCode !== undefined && { bankCode: bankCode || null }),
        ...(accountName !== undefined && { accountName }),
        ...(accountNumber !== undefined && { accountNumber }),
        ...(label !== undefined && { label: label || null }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });

    // The in-app payment subaccount points at the account as it WAS. If this is that account and
    // what it pays into changed, in-app payments are switched off rather than paying the old account.
    const payoutChanged =
      (accountNumber !== undefined && accountNumber !== existing.accountNumber) ||
      (bankCode !== undefined && (bankCode || null) !== existing.bankCode) ||
      (isActive !== undefined && !Boolean(isActive) && existing.isActive);
    const switchedToDirect = payoutChanged ? await inAppFees.settlementAccountChanged(req.schoolId, id) : false;

    res.status(200).json({
      success: true,
      message: switchedToDirect
        ? "Bank account updated. In-app payments were switched off because this was your payout account; choose it again in Collect fees to turn them back on."
        : "Bank account updated",
      data: account,
      switchedToDirect,
    });
  } catch (err) {
    logger.error("[UPDATE_BANK_ACCOUNT] Failed", { error: err.message });
    next(err);
  }
};

/** DELETE /api/admin/fees/bank-accounts/:id */
exports.deleteBankAccount = async (req, res, next) => {
  try {
    // Bank accounts are the school's, shared by every campus: head admins only.
    if (campusScope.isRestricted(req)) {
      return res.status(403).json({ success: false, message: "Only the head admin can change the school's bank accounts" });
    }
    const id = parseInt(req.params.id, 10);

    const existing = await prisma.schoolBankAccount.findFirst({ where: { id, schoolId: req.schoolId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Bank account not found", code: "NOT_FOUND" });
    }

    // Historical payments reference this account — deleting it would orphan
    // that record's "which account was this paid into" trail. Deactivating
    // (updateBankAccount with isActive:false) hides it from new declarations
    // without losing that history.
    const linkedPaymentCount = await prisma.payment.count({ where: { bankAccountId: id } });
    if (linkedPaymentCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete — ${linkedPaymentCount} payment(s) reference this account. Deactivate it instead.`,
        code: "ACCOUNT_IN_USE",
      });
    }

    await prisma.schoolBankAccount.delete({ where: { id } });
    const switchedToDirect = await inAppFees.settlementAccountChanged(req.schoolId, id);

    res.status(200).json({ success: true, message: "Bank account deleted", switchedToDirect });
  } catch (err) {
    logger.error("[DELETE_BANK_ACCOUNT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/fees/payments/pending
 * The approval queue: bank-transfer payments a parent/student has declared,
 * awaiting an admin to confirm the transfer actually landed.
 */
exports.listPendingPayments = async (req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { status: "pending", channel: "bank_transfer", studentFee: campusScope.withScope({ schoolId: req.schoolId }, campusScope.viaStudent(req)) },
      include: {
        studentFee: {
          include: { student: true, feeStructure: { include: { class: { select: { name: true } } } } },
        },
        bankAccount: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const data = payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      createdAt: p.createdAt,
      receiptNo: p.receiptNo,
      studentFeeId: p.studentFeeId,
      studentName: `${p.studentFee.student.name} ${p.studentFee.student.surname}`,
      admissionNo: p.studentFee.student.registrationNumber,
      class: p.studentFee.feeStructure.class.name,
      feeTitle: p.studentFee.feeStructure.title,
      bankAccount: p.bankAccount
        ? {
            id: p.bankAccount.id,
            bankName: p.bankAccount.bankName,
            accountName: p.bankAccount.accountName,
            accountNumber: p.bankAccount.accountNumber,
            label: p.bankAccount.label,
          }
        : null,
    }));

    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error("[LIST_PENDING_PAYMENTS] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/fees/payments/:id/approve
 * Confirms a declared bank-transfer payment actually landed: credits the
 * fee and returns the same receipt shape getReceipt() does, ready to
 * print/email/WhatsApp immediately.
 */
exports.approvePayment = async (req, res, next) => {
  try {
    const paymentId = parseInt(req.params.id, 10);
    const adminId = req.user?.id;
    if (isNaN(paymentId)) {
      return res.status(400).json({ success: false, message: "Invalid payment ID", code: "INVALID_REQUEST" });
    }

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, status: "pending", channel: "bank_transfer", studentFee: campusScope.withScope({ schoolId: req.schoolId }, campusScope.viaStudent(req)) },
      include: { studentFee: true },
    });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Pending payment not found", code: "NOT_FOUND" });
    }

    // Claimed under a row lock, so two admins clicking Approve together (or an approval racing a
    // rejection) credit the invoice at most once.
    const credited = await prisma.$transaction(
      async (tx) => {
        if (!(await claimFeePayment(tx, payment.id, { onlyPending: true }))) return false;
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: "success", recordedBy: adminId, paymentDate: new Date() },
        });
        await applyFeePayment(tx, payment.studentFeeId, payment.amount);
        return true;
      },
      { timeout: 20000 }
    );
    if (!credited) {
      return res.status(409).json({ success: false, message: "This payment has already been handled", code: "ALREADY_HANDLED" });
    }

    logger.info("[APPROVE_PAYMENT] Payment approved", { paymentId, adminId, amount: payment.amount });

    const studentFee = await loadStudentFeeForReceipt(payment.studentFeeId);
    const data = await buildReceiptData(studentFee);

    res.status(200).json({ success: true, message: "Payment approved", data });
  } catch (err) {
    logger.error("[APPROVE_PAYMENT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/fees/payments/:id/reject
 * The transfer never landed, or the amount/account doesn't match — never
 * touches StudentFee, unlike approve.
 */
exports.rejectPayment = async (req, res, next) => {
  try {
    const paymentId = parseInt(req.params.id, 10);
    const { reason } = req.body;
    if (isNaN(paymentId)) {
      return res.status(400).json({ success: false, message: "Invalid payment ID", code: "INVALID_REQUEST" });
    }

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, status: "pending", channel: "bank_transfer", studentFee: campusScope.withScope({ schoolId: req.schoolId }, campusScope.viaStudent(req)) },
    });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Pending payment not found", code: "NOT_FOUND" });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "failed", rejectionReason: reason || null },
    });

    logger.info("[REJECT_PAYMENT] Payment rejected", { paymentId, reason });

    res.status(200).json({ success: true, message: "Payment rejected" });
  } catch (err) {
    logger.error("[REJECT_PAYMENT] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/fees/receipts/:studentFeeId/send-email
 * Emails the same receipt getReceipt() returns to the student's guardian —
 * previously a frontend-only fake (a success toast with no real send behind
 * it; see receipt-generator.tsx's handleSendEmail).
 */
exports.sendReceiptEmail = async (req, res, next) => {
  try {
    const studentFeeId = parseInt(req.params.studentFeeId, 10);
    if (isNaN(studentFeeId)) {
      return res.status(400).json({ success: false, message: "Invalid student fee ID", code: "INVALID_REQUEST" });
    }

    await assertFeeInScope(req, studentFeeId);
    const studentFee = await loadStudentFeeForReceipt(studentFeeId);
    if (!studentFee) {
      return res.status(404).json({ success: false, message: "Student fee record not found", code: "NOT_FOUND" });
    }
    if (studentFee.status === "unpaid" || studentFee.payments.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No payment recorded for this student yet",
        code: "NO_PAYMENT",
      });
    }

    const recipient = studentFee.student.email || studentFee.student.guardianEmail;
    if (!recipient) {
      return res.status(400).json({
        success: false,
        message: "No email on file for this student or guardian",
        code: "NO_EMAIL",
      });
    }

    const receipt = await buildReceiptData(studentFee);

    const itemsHtml = receipt.items
      .map(
        (i) =>
          `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;">${i.name}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">₦${i.amount.toLocaleString()}</td></tr>`
      )
      .join("");

    const schoolName = receipt.schoolName ?? "Your School";
    const html = brandedEmail({
      schoolName,
      logoUrl: receipt.logoUrl,
      brandColor: receipt.brandColor,
      title: "Payment Receipt",
      bodyHtml: `
        <p style="margin:0 0 4px;">Receipt No: <strong>${receipt.receiptNo}</strong></p>
        <p style="margin:0 0 4px;color:#555;">${receipt.studentName} (${receipt.admissionNo}) — ${receipt.class}</p>
        <p style="margin:0 0 16px;color:#555;">${receipt.term} — ${receipt.session}</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px;">${itemsHtml}</table>
        <p style="font-size:18px;font-weight:bold;color:#1a237e;margin:0 0 8px;">Amount Paid: ₦${receipt.amountPaid.toLocaleString()}</p>
        ${
          receipt.isPartial
            ? `<p style="color:#b91c1c;margin:0 0 8px;">Outstanding: ₦${(receipt.outstanding ?? 0).toLocaleString()}</p>`
            : ""
        }
        <p style="color:#999;font-size:12px;margin:0;">Paid via ${receipt.paymentMethod} on ${new Date(
        receipt.paymentDate
      ).toLocaleDateString()}.</p>
      `,
    });

    await sendEmail({ to: recipient, subject: `Payment Receipt — ${receipt.receiptNo}`, html });

    logger.info("[SEND_RECEIPT_EMAIL] Sent", { studentFeeId, recipient });

    res.status(200).json({ success: true, message: `Receipt sent to ${recipient}` });
  } catch (err) {
    logger.error("[SEND_RECEIPT_EMAIL] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/fees/reminders/send-email
 * Email fee reminders to parents of the given student-fee records.
 *
 * NOTE: No email provider is configured yet — this logs the intended sends
 * and returns per-recipient results without actually dispatching email.
 * Swap in a real provider call inside the loop below once one is chosen.
 */
exports.sendFeeReminders = async (req, res, next) => {
  try {
    const { studentFeeIds } = req.body;

    if (!Array.isArray(studentFeeIds) || studentFeeIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "studentFeeIds must be a non-empty array",
        code: "MISSING_IDS",
      });
    }

    const records = await prisma.studentFee.findMany({
      where: campusScope.withScope(
        { id: { in: studentFeeIds.map((id) => parseInt(id)) }, schoolId: req.schoolId },
        campusScope.viaStudent(req)
      ),
      include: { student: true },
    });

    const results = records.map((sf) => {
      if (!sf.student.guardianEmail) {
        return { studentFeeId: sf.id, success: false, error: "No guardian email on file" };
      }
      // TODO: replace with a real email provider call once one is configured
      logger.info("[FEE_REMINDER_EMAIL_STUB] Would send reminder", {
        to: sf.student.guardianEmail,
        studentFeeId: sf.id,
        outstanding: Math.max(sf.totalFee - sf.amountPaid, 0),
      });
      return { studentFeeId: sf.id, success: true, sentTo: sf.student.guardianEmail };
    });

    res.status(200).json({
      success: true,
      message: "Email provider not yet configured — reminders logged, not actually sent",
      data: { results },
    });
  } catch (err) {
    logger.error("[SEND_FEE_REMINDERS] Failed", { error: err.message });
    next(err);
  }
};
