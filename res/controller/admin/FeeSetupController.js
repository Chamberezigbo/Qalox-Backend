const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const campusScope = require("../../util/campusScope");
const { AUDIENCES, studentsToBill } = require("../../util/feeInvoices");
const { CATEGORIES, classifyStudents } = require("../../util/studentAdmission");

/**
 * The side of fee setup that is not saving a fee:
 *   POST   /fees/structure/preview         who a fee would bill, before it is saved
 *   DELETE /fees/structure/:id             remove a fee that nobody has paid anything towards
 *   GET    /fees/students-category         each student's fresh / returning answer for a session
 *   PUT    /fees/students/:studentId/category   override it for one student
 */

const bad = (res, message, status = 400, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

exports.preview = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { session } = req.body ?? {};
    const audience = req.body?.audience ?? "all";
    const classIds = [...new Set((req.body?.classIds ?? []).map((id) => parseInt(id)).filter(Number.isInteger))];
    if (!AUDIENCES.includes(audience)) return bad(res, "audience must be all, fresh or returning", 400, "INVALID_AUDIENCE");
    if (classIds.length === 0 || !session) return bad(res, "classIds and session are required", 400, "MISSING_FIELDS");

    const classes = await prisma.class.findMany({
      where: campusScope.withScope({ id: { in: classIds }, schoolId }, campusScope.classWhere(req)),
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (classes.length !== classIds.length) return bad(res, "One of the classes was not found", 404, "CLASS_NOT_FOUND");

    let sessionKnown = true;
    const perClass = [];
    for (const cls of classes) {
      const students = await prisma.student.findMany({
        where: { classId: cls.id, schoolId, status: "active" },
        select: { id: true, feeCategory: true, academicSessionId: true },
      });
      const result = await studentsToBill(prisma, { audience, session, schoolId }, students);
      sessionKnown = sessionKnown && result.sessionKnown;
      perClass.push({ classId: cls.id, className: cls.name, students: students.length, fresh: result.counts.fresh, returning: result.counts.returning, billed: result.billed.length });
    }

    const sum = (key) => perClass.reduce((total, c) => total + c[key], 0);
    res.json({
      success: true,
      data: {
        sessionKnown,
        audience,
        classes: perClass,
        totals: { students: sum("students"), fresh: sum("fresh"), returning: sum("returning"), billed: sum("billed") },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteStructure = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return bad(res, "Invalid fee id", 400, "INVALID_REQUEST");

    const structure = await prisma.feeStructure.findFirst({
      where: campusScope.withScope({ id, schoolId: req.schoolId }, campusScope.viaClass(req)),
      select: { id: true, title: true, class: { select: { name: true } } },
    });
    if (!structure) return bad(res, "Fee not found", 404, "NOT_FOUND");

    // Any payment (waiting or confirmed) is money someone is relying on: that fee stays.
    const payments = await prisma.payment.count({ where: { studentFee: { feeStructureId: id }, status: { in: ["pending", "success"] } } });
    if (payments > 0) {
      return bad(res, `${payments} payment${payments === 1 ? " has" : "s have"} already been made towards ${structure.title} for ${structure.class.name}, so it cannot be deleted.`, 409, "HAS_PAYMENTS");
    }

    const removed = await prisma.$transaction(async (tx) => {
      const invoices = await tx.studentFee.findMany({ where: { feeStructureId: id }, select: { id: true } });
      const invoiceIds = invoices.map((i) => i.id);
      await tx.payment.deleteMany({ where: { studentFeeId: { in: invoiceIds } } }); // only failed attempts remain
      await tx.studentFee.deleteMany({ where: { feeStructureId: id } });
      await tx.feeStructureItem.deleteMany({ where: { feeStructureId: id } });
      await tx.feeStructure.delete({ where: { id } });
      return invoiceIds.length;
    });

    logger.info("[FEE_STRUCTURE_DELETE] Fee deleted", { id, title: structure.title, invoicesRemoved: removed });
    res.json({ success: true, message: `${structure.title} removed for ${structure.class.name}`, data: { invoicesRemoved: removed } });
  } catch (error) {
    next(error);
  }
};

exports.listCategories = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const classId = parseInt(req.query.classId, 10);
    if (!Number.isInteger(classId)) return bad(res, "classId is required", 400, "MISSING_FIELDS");

    const cls = await prisma.class.findFirst({ where: campusScope.withScope({ id: classId, schoolId }, campusScope.classWhere(req)), select: { id: true } });
    if (!cls) return bad(res, "Class not found", 404, "CLASS_NOT_FOUND");

    // The session the fee is for: the one named, else the school's active one.
    const sessionName = req.query.session ? String(req.query.session) : null;
    const session = sessionName
      ? await prisma.academicSession.findFirst({ where: { schoolId, name: sessionName }, select: { id: true, name: true } })
      : await prisma.academicSession.findFirst({ where: { schoolId, isActive: true }, select: { id: true, name: true } });
    if (!session) return bad(res, "Choose a session from your school's list", 400, "SESSION_NOT_FOUND");

    const students = await prisma.student.findMany({
      where: { classId, schoolId, status: "active" },
      select: { id: true, name: true, surname: true, registrationNumber: true, feeCategory: true, academicSessionId: true },
      orderBy: { surname: "asc" },
    });
    const classified = await classifyStudents(prisma, students, session.id);

    res.json({
      success: true,
      data: {
        session: session.name,
        students: students.map((s) => ({
          id: s.id, name: s.name, surname: s.surname, registrationNumber: s.registrationNumber,
          category: classified.get(s.id).category, source: classified.get(s.id).source, override: s.feeCategory,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.setCategory = async (req, res, next) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    const category = req.body?.category ?? null;
    if (!Number.isInteger(studentId)) return bad(res, "Invalid student id", 400, "INVALID_REQUEST");
    if (category !== null && !CATEGORIES.includes(category)) return bad(res, "category must be fresh, returning, or null for automatic", 400, "INVALID_CATEGORY");

    const student = await prisma.student.findFirst({
      where: campusScope.withScope({ id: studentId, schoolId: req.schoolId }, campusScope.studentWhere(req)),
      select: { id: true },
    });
    if (!student) return bad(res, "Student not found", 404, "NOT_FOUND");

    await prisma.student.update({ where: { id: studentId }, data: { feeCategory: category } });
    res.json({ success: true, message: category ? `Marked as ${category}` : "Back to automatic", data: { studentId, override: category } });
  } catch (error) {
    next(error);
  }
};

