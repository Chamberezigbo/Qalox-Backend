const logger = require("../config/logger");

/**
 * The class a student was in during a given session.
 *
 * Student.classId is where they are now and moves on promotion, so a result view
 * for an earlier session must not read it. The enrollment history has the class
 * for each session. A student with no row for that session (history was added
 * after their records, or the write failed) falls back to the current class,
 * which is what every view did before and is right for the session they are in.
 *
 * @param {object} client prisma or a transaction client
 * @param {number} studentId
 * @param {number} sessionId
 * @param {number} fallbackClassId the student's current class
 * @returns {Promise<number>}
 */
async function getEnrolledClassId(client, studentId, sessionId, fallbackClassId) {
  if (!sessionId) return fallbackClassId;

  try {
    const enrollment = await client.studentEnrollment.findUnique({
      where: { studentId_academicSessionId: { studentId, academicSessionId: sessionId } },
      select: { classId: true },
    });
    return enrollment?.classId ?? fallbackClassId;
  } catch (error) {
    // History is a refinement. A result view must still load if the lookup fails.
    logger.warn("[ENROLLMENT] Could not read a student's class for a session", { studentId, sessionId, error: error.message });
    return fallbackClassId;
  }
}

module.exports = { getEnrolledClassId };
