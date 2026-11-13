/**
 * Is a student "fresh" (new to the school this session) or "returning", for fee purposes?
 *
 * Worked out automatically, and the admin can override it for any student:
 *   - the override (Student.feeCategory) always wins;
 *   - otherwise a student is RETURNING if they were enrolled in an EARLIER session, or if their own
 *     record belongs to an earlier session (older students may have no enrollment history);
 *   - otherwise they are FRESH.
 * "Earlier" is by session id: sessions are created in order, so a larger id is a later session.
 */

const CATEGORIES = ["fresh", "returning"];

/** The rule itself, with no database. */
function categoryFor({ override, enrolledEarlier, ownSessionEarlier }) {
  if (CATEGORIES.includes(override)) return { category: override, source: "override" };
  return { category: enrolledEarlier || ownSessionEarlier ? "returning" : "fresh", source: "automatic" };
}

/** The id of the school's session with this name, or null (free-text sessions cannot be compared). */
async function resolveSessionId(client, schoolId, sessionName) {
  const session = await client.academicSession.findFirst({ where: { schoolId, name: sessionName }, select: { id: true } });
  return session?.id ?? null;
}

/**
 * Classifies many students against one session with a single query.
 * @param {object} client prisma or a transaction client
 * @param {Array<{ id: number, feeCategory: string | null, academicSessionId: number }>} students
 * @param {number} sessionId the session the fee is for
 * @returns {Promise<Map<number, { category: "fresh" | "returning", source: "override" | "automatic" }>>}
 */
async function classifyStudents(client, students, sessionId) {
  const needHistory = students.filter((s) => !CATEGORIES.includes(s.feeCategory)).map((s) => s.id);
  const earlier = needHistory.length
    ? await client.studentEnrollment.findMany({
        where: { studentId: { in: needHistory }, academicSessionId: { lt: sessionId } },
        select: { studentId: true },
        distinct: ["studentId"],
      })
    : [];
  const enrolledEarlier = new Set(earlier.map((e) => e.studentId));

  return new Map(
    students.map((s) => [
      s.id,
      categoryFor({ override: s.feeCategory, enrolledEarlier: enrolledEarlier.has(s.id), ownSessionEarlier: s.academicSessionId < sessionId }),
    ]),
  );
}

module.exports = { CATEGORIES, categoryFor, resolveSessionId, classifyStudents };
