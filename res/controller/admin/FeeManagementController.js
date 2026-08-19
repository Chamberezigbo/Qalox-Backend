const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { createNotification } = require("../../util/notify");
const { schoolMediaUrl } = require("../public/publicController");

const PAYMENT_METHODS = ["Bank Transfer", "Cash", "Card"];

const computeStatus = (totalFee, amountPaid) => {
  if (amountPaid <= 0) return "unpaid";
  if (amountPaid >= totalFee) return "paid";
  return "partial";
};

const generateReceiptNo = async () => {
  const count = await prisma.payment.count();
  const year = new Date().getFullYear();
  return `RCP-${year}-${String(count + 1).padStart(4, "0")}`;
};

const formatStudentFee = (sf) => ({
  id: sf.id,
  studentName: `${sf.student.name} ${sf.student.surname}`,
  admissionNo: sf.student.registrationNumber,
  class: sf.feeStructure.class.name,
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
    const { classId, term, session, items } = req.body;

    if (!classId || !term || !session || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "classId, term, session, and a non-empty items array are required",
        code: "MISSING_FIELDS",
      });
    }

    const invalidItems = items.filter((i) => !i.name || typeof i.amount !== "number" || i.amount < 0);
    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Each item requires a name and a non-negative numeric amount",
        code: "INVALID_ITEMS",
      });
    }

    const classRecord = await prisma.class.findFirst({ where: { id: parseInt(classId), schoolId } });
    if (!classRecord) {
      return res.status(404).json({ success: false, message: "Class not found", code: "CLASS_NOT_FOUND" });
    }

    const totalAmount = items.reduce((sum, i) => sum + i.amount, 0);

    const result = await prisma.$transaction(async (tx) => {
      // Upsert the structure itself
      const existing = await tx.feeStructure.findUnique({
        where: { classId_term_session: { classId: classRecord.id, term, session } },
      });

      let structure;
      if (existing) {
        await tx.feeStructureItem.deleteMany({ where: { feeStructureId: existing.id } });
        structure = await tx.feeStructure.update({
          where: { id: existing.id },
          data: { items: { create: items.map((i) => ({ name: i.name, amount: i.amount })) } },
          include: { items: true },
        });
      } else {
        structure = await tx.feeStructure.create({
          data: {
            schoolId,
            classId: classRecord.id,
            term,
            session,
            items: { create: items.map((i) => ({ name: i.name, amount: i.amount })) },
          },
          include: { items: true },
        });
      }

      // Generate/refresh StudentFee invoices for all students currently in this class
      const students = await tx.student.findMany({ where: { classId: classRecord.id, schoolId } });
      for (const student of students) {
        const existingFee = await tx.studentFee.findUnique({
          where: { studentId_feeStructureId: { studentId: student.id, feeStructureId: structure.id } },
        });
        if (!existingFee) {
          await tx.studentFee.create({
            data: {
              schoolId,
              studentId: student.id,
              feeStructureId: structure.id,
              totalFee: totalAmount,
              amountPaid: 0,
              status: "unpaid",
            },
          });
        } else if (existingFee.totalFee !== totalAmount) {
          // Fee structure amount changed — resync the invoice total and status,
          // preserving whatever the student has already paid
          await tx.studentFee.update({
            where: { id: existingFee.id },
            data: { totalFee: totalAmount, status: computeStatus(totalAmount, existingFee.amountPaid) },
          });
        }
      }

      return structure;
    }, { timeout: 20000 });

    logger.info("[FEE_STRUCTURE_UPSERT] Fee structure saved", { classId: classRecord.id, term, session });

    res.status(200).json({
      success: true,
      message: `Fee breakdown saved for ${classRecord.name}`,
      data: {
        className: classRecord.name,
        term: result.term,
        session: result.session,
        items: result.items.map((i) => ({ id: i.id, name: i.name, amount: i.amount })),
        totalAmount,
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
      where,
      include: { items: true, class: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const data = structures.map((s) => ({
      id: s.id,
      className: s.class.name,
      term: s.term,
      session: s.session,
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

    const [records, total] = await Promise.all([
      prisma.studentFee.findMany({
        where,
        include: {
          student: true,
          feeStructure: { include: { class: { select: { name: true } } } },
          payments: { orderBy: { paymentDate: "desc" }, take: 1 },
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.studentFee.count({ where }),
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

    const [totals, paidCount, partialCount, unpaidCount] = await Promise.all([
      prisma.studentFee.aggregate({
        where: { schoolId },
        _sum: { totalFee: true, amountPaid: true },
      }),
      prisma.studentFee.count({ where: { schoolId, status: "paid" } }),
      prisma.studentFee.count({ where: { schoolId, status: "partial" } }),
      prisma.studentFee.count({ where: { schoolId, status: "unpaid" } }),
    ]);

    const totalExpected = totals._sum.totalFee || 0;
    const totalCollected = totals._sum.amountPaid || 0;

    res.status(200).json({
      success: true,
      data: {
        totalExpected,
        totalCollected,
        totalOutstanding: Math.max(totalExpected - totalCollected, 0),
        paidCount,
        partialCount,
        unpaidCount,
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

    const studentFee = await prisma.studentFee.findUnique({
      where: { id: parseInt(studentFeeId) },
      include: {
        student: true,
        feeStructure: { include: { items: true, class: { select: { name: true } } } },
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
    prisma.admin.findMany({
      where: { schoolId: studentFee.schoolId, role: { in: ["school_admin", "sub_admin", "super_admin"] } },
      select: { id: true },
    }).then((admins) => {
      const studentName = `${studentFee.student.name} ${studentFee.student.surname}`;
      admins.forEach((a) =>
        createNotification({
          recipientType: "admin",
          recipientId: a.id,
          schoolId: studentFee.schoolId,
          title: "Fee payment received",
          message: `${studentName} paid ₦${amount.toLocaleString()} (receipt ${receiptNo}).`,
          type: "fee_payment",
        })
      );
    });

    const school = await prisma.school.findUnique({
      where: { id: studentFee.schoolId },
      select: { name: true, logoUrl: true, stampUrl: true },
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

    const studentFee = await prisma.studentFee.findUnique({
      where: { id: studentFeeId },
      include: {
        student: true,
        feeStructure: { include: { items: true, class: { select: { name: true } } } },
        payments: { orderBy: { paymentDate: "desc" }, take: 1 },
      },
    });

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

    const latestPayment = studentFee.payments[0];

    const school = await prisma.school.findUnique({
      where: { id: studentFee.schoolId },
      select: { name: true, logoUrl: true, stampUrl: true },
    });
    const [schoolLogo, schoolStamp] = await Promise.all([
      schoolMediaUrl(school?.logoUrl),
      schoolMediaUrl(school?.stampUrl),
    ]);

    res.status(200).json({
      success: true,
      data: {
        receiptNo: latestPayment.receiptNo,
        studentName: `${studentFee.student.name} ${studentFee.student.surname}`,
        admissionNo: studentFee.student.registrationNumber,
        class: studentFee.feeStructure.class.name,
        amountPaid: studentFee.amountPaid,
        paymentDate: latestPayment.paymentDate,
        paymentMethod: latestPayment.paymentMethod,
        items: studentFee.feeStructure.items.map((i) => ({ name: i.name, amount: i.amount })),
        term: studentFee.feeStructure.term,
        session: studentFee.feeStructure.session,
        isPartial: studentFee.status === "partial",
        outstanding: Math.max(studentFee.totalFee - studentFee.amountPaid, 0),
        parentEmail: studentFee.student.guardianEmail,
        parentPhone: studentFee.student.guardianNumber,
        schoolName: school?.name,
        logoUrl: schoolLogo,
        stampUrl: schoolStamp,
      },
    });
  } catch (err) {
    logger.error("[GET_RECEIPT] Failed", { error: err.message });
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
      where: { id: { in: studentFeeIds.map((id) => parseInt(id)) } },
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
