const logger = require("../config/logger");

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
 * Never throws — a fee-sync failure should not block the student
 * create/move it rides along with; it is logged and swallowed instead.
 *
 * @param {Object} tx a Prisma client or transaction client
 * @param {{ id: Number, schoolId: Number, classId: Number|null }} student
 */
async function syncStudentFeeInvoices(tx, student) {
  if (!student.classId) return;

  try {
    const structures = await tx.feeStructure.findMany({
      where: { classId: student.classId },
      select: { id: true, items: { select: { amount: true } } },
    });
    if (structures.length === 0) return;

    for (const structure of structures) {
      const existing = await tx.studentFee.findUnique({
        where: { studentId_feeStructureId: { studentId: student.id, feeStructureId: structure.id } },
      });
      if (existing) continue;

      const totalFee = structure.items.reduce((sum, item) => sum + item.amount, 0);
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
