const logger = require("../config/logger");
const { matchesAudience, totalOf } = require("./feeInvoices");
const { resolveSessionId, classifyStudents } = require("./studentAdmission");

/**
 * Creates a StudentFee invoice for a student against every existing
 * FeeStructure of their class, for any structure that doesn't already have
 * one.
 *
 * FeeManagementController.upsertFeeStructure only backfills students who are
 * already in the class at the moment a fee structure is created. A student
 * who joins that class afterwards — created directly, bulk/photo-imported,
 * or moved in via a class change — never gets an invoice from that path, and
 * nothing surfaces the gap: the parent portal just quietly shows "no fee
 * records yet" even after the admin has genuinely set fees up. This is the
 * other half of that: call it anywhere a student's classId is set or
 * changes, so a fee structure that predates the student still reaches them.
 *
 * Limited to fee structures of the school's active session, so a student
 * who joins a class later is not invoiced for last year's fees.
 *
 * Never throws — a fee-sync failure should not block the student
 * create/move it rides along with; it is logged and swallowed instead.
 *
 * @param {Object} tx a Prisma client or transaction client
 * @param {{ id: Number, schoolId: Number, classId: Number|null }} student
 * @param {{ sessionName?: string }} [options] invoice this session's structures
 *   instead of the active session's. Promotion moves students into the NEXT
 *   session, which may not be active yet, and must bill that session's fees.
 */
async function syncStudentFeeInvoices(tx, student, options = {}) {
  if (!student.classId) return;

  try {
    // Only the current session's fees. A class keeps every fee structure it has
    // ever had, so invoicing all of them billed a student moved in at the start
    // of a new session for every term of every previous year, as unpaid.
    //
    // A school with no active session is left as it was — it cannot be told
    // apart from one that simply does not use sessions, and would otherwise
    // stop invoicing late joiners altogether.
    const activeSession = options.sessionName
      ? { name: options.sessionName }
      : await tx.academicSession.findFirst({
          where: { schoolId: student.schoolId, isActive: true },
          select: { name: true },
        });

    const structures = await tx.feeStructure.findMany({
      where: { classId: student.classId, ...(activeSession && { session: activeSession.name }) },
      select: { id: true, session: true, audience: true, items: { select: { amount: true } } },
    });
    if (structures.length === 0) return;

    // Fees for everyone need no classification; a fresh-only or returning-only fee needs to know which
    // this student is. Read lazily, once, and only if such a fee exists.
    let record = null;
    const categoryFor = async (structure) => {
      record ??= await tx.student.findUnique({ where: { id: student.id }, select: { id: true, feeCategory: true, academicSessionId: true } });
      const sessionId = await resolveSessionId(tx, student.schoolId, structure.session);
      if (!record || sessionId === null) return null;
      return (await classifyStudents(tx, [record], sessionId)).get(record.id).category;
    };

    for (const structure of structures) {
      // No audience means a fee for everyone (every fee before audiences existed).
      if ((structure.audience ?? "all") !== "all") {
        const category = await categoryFor(structure);
        // Unknown session or student: leave it for the admin rather than guess who owes what.
        if (!category || !matchesAudience(structure.audience, category)) continue;
      }

      const existing = await tx.studentFee.findUnique({
        where: { studentId_feeStructureId: { studentId: student.id, feeStructureId: structure.id } },
      });
      if (existing) continue;

      const totalFee = totalOf(structure.items);
      await tx.studentFee.create({
        data: {
          schoolId: student.schoolId,
          studentId: student.id,
          feeStructureId: structure.id,
          totalFee,
          amountPaid: 0,
          status: "unpaid",
        },
      });
    }
  } catch (error) {
    logger.error("[STUDENT_FEE_SYNC] Failed to sync fee invoices for student", {
      studentId: student.id,
      classId: student.classId,
      error: error.message,
    });
  }
}

module.exports = { syncStudentFeeInvoices };
