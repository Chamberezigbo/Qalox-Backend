const logger = require("../config/logger");

/**
 * Keeps StudentEnrollment (which class a student was in during a session) in
 * step with the student record. See the model in schema.prisma.
 *
 * Both functions are best effort: they log and carry on rather than throw. The
 * history is secondary to the operation that triggered it (registering a
 * student, moving a class), and a reader that finds no row falls back to the
 * student's current class, so a failure here must never undo the real change.
 */

/**
 * @param {object} client prisma or a transaction client
 * @param {{ id: number, schoolId: number, academicSessionId: number, classId: number, classGroupId?: number | null, campusId?: number | null }} student
 */
async function recordEnrollment(client, student) {
  try {
    const fields = {
      schoolId: student.schoolId,
      classId: student.classId,
      classGroupId: student.classGroupId ?? null,
      campusId: student.campusId ?? null,
    };

    await client.studentEnrollment.upsert({
      where: { studentId_academicSessionId: { studentId: student.id, academicSessionId: student.academicSessionId } },
      create: { studentId: student.id, academicSessionId: student.academicSessionId, ...fields },
      update: fields,
    });
  } catch (error) {
    logger.warn("[ENROLLMENT] Could not record a student's class for the session", {
      studentId: student.id,
      error: error.message,
    });
  }
}

/**
 * Re-reads students and records where each one is now. Used after a bulk move.
 * @param {object} client
 * @param {number[]} studentIds
 * @param {number} schoolId
 */
async function syncEnrollments(client, studentIds, schoolId) {
  try {
    const students = await client.student.findMany({
      where: { id: { in: studentIds }, schoolId },
      select: { id: true, schoolId: true, academicSessionId: true, classId: true, classGroupId: true, campusId: true },
    });
    for (const student of students) await recordEnrollment(client, student);
  } catch (error) {
    logger.warn("[ENROLLMENT] Could not sync enrollments after a move", { error: error.message });
  }
}

module.exports = { recordEnrollment, syncEnrollments };
