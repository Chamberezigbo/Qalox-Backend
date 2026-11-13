const { resolveSessionId, classifyStudents } = require("./studentAdmission");

/**
 * The ONE rule for which students a fee invoices, shared by fee setup (the class's students at that moment)
 * and by the sync that bills a student who joins a class later.
 */

const AUDIENCES = ["all", "fresh", "returning"];

const matchesAudience = (audience, category) => (audience ?? "all") === "all" || audience === category;

const totalOf = (items) => items.reduce((sum, item) => sum + item.amount, 0);

/**
 * Which of these students a structure should bill.
 * @param {object} client prisma or a transaction client
 * @param {{ audience: string, session: string, schoolId: number }} structure
 * @param {Array<{ id: number, feeCategory: string | null, academicSessionId: number }>} students
 * @returns {Promise<{ billed: typeof students, counts: { fresh: number, returning: number } }>}
 *          counts: how the students split, whatever the audience (for the preview)
 */
async function studentsToBill(client, structure, students) {
  const sessionId = await resolveSessionId(client, structure.schoolId, structure.session);
  // An unknown (free-text) session cannot be compared, so a fresh/returning split is not possible.
  if (sessionId === null) {
    return { billed: structure.audience === "all" ? students : [], counts: { fresh: 0, returning: 0 }, sessionKnown: false };
  }
  const classified = await classifyStudents(client, students, sessionId);
  const counts = { fresh: 0, returning: 0 };
  for (const { category } of classified.values()) counts[category] += 1;
  return {
    billed: students.filter((s) => matchesAudience(structure.audience, classified.get(s.id).category)),
    counts,
    sessionKnown: true,
  };
}

module.exports = { AUDIENCES, matchesAudience, totalOf, studentsToBill };
