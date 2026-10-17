const { isTeacherDuty } = require("./staffDuty");

/**
 * Whether this staff member may be made class teacher of a class.
 *
 * The class teacher receives and compiles the class's results, so it has to be a
 * real teacher of the same school, and of the class's campus when both have one
 * (a teacher with no campus works across campuses).
 *
 * @param {object} client prisma or a transaction client
 * @param {{ schoolId: number, staffId: number, campusId: number | null }} input
 * @returns {Promise<string | null>} why not, or null when it is fine
 */
async function classTeacherProblem(client, { schoolId, staffId, campusId }) {
  const staff = await client.staff.findFirst({
    where: { id: staffId, schoolId },
    select: { id: true, duty: true, campusId: true },
  });
  if (!staff) return "That staff member was not found in this school";
  if (!isTeacherDuty(staff.duty)) return "Only staff whose duty is Teacher can be a class teacher";
  if (campusId && staff.campusId && staff.campusId !== campusId) {
    return "That teacher belongs to a different campus from this class";
  }
  return null;
}

module.exports = { classTeacherProblem };
