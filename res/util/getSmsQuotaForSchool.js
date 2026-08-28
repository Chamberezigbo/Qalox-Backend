const prisma = require("./prisma");
const { getActivePlanForSchool } = require("./getActivePlanForSchool");

/**
 * Resolves a school's SMS quota per term: a Super Admin manual override if
 * set, otherwise the school's active plan's smsQuotaPerTerm (falling back to
 * the plan's maxStudents when smsQuotaPerTerm isn't explicitly set — the
 * default 1:1 rule). A school with no active plan gets 0 — no plan, no SMS.
 * @param {number} schoolId
 * @returns {Promise<number>}
 */
async function getSmsQuotaForSchool(schoolId) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { smsQuotaOverride: true },
  });

  if (school?.smsQuotaOverride != null) {
    return school.smsQuotaOverride;
  }

  const plan = await getActivePlanForSchool(schoolId);
  if (!plan) return 0;

  return plan.smsQuotaPerTerm ?? plan.maxStudents ?? 0;
}

module.exports = { getSmsQuotaForSchool };
