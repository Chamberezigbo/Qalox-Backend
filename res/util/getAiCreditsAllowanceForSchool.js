const prisma = require("./prisma");
const { getActivePlanForSchool } = require("./getActivePlanForSchool");

/**
 * Resolves a school's AI generation credit allowance per term: a Super Admin
 * manual override if set, otherwise the active plan's aiCreditsPerTerm.
 *
 * Deliberately unlike getSmsQuotaForSchool, there is NO maxStudents fallback.
 * SMS volume scales with how many students you message; AI usage scales with
 * teacher activity, so "the plan didn't set a number" means the feature isn't
 * included rather than "derive one from the student cap". That matches the
 * plan catalogue, where only Standard and Premium list the AI generator
 * (see scripts/seed-billing-plans.js).
 *
 * @param {number} schoolId
 * @returns {Promise<number>} credits per term; 0 when the plan excludes AI
 */
async function getAiCreditsAllowanceForSchool(schoolId) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { aiCreditsOverride: true },
  });

  if (school?.aiCreditsOverride != null) {
    return school.aiCreditsOverride;
  }

  const plan = await getActivePlanForSchool(schoolId);
  if (!plan) return 0;

  return plan.aiCreditsPerTerm ?? 0;
}

/**
 * Allowance + what's been used so far this term, for both the pre-flight
 * check and the UI meter. Mirrors the shape GET /admin/sms/quota returns.
 *
 * @param {number} schoolId
 * @returns {Promise<{ allowance: number, used: number, remaining: number, included: boolean }>}
 */
async function getAiCreditsStatusForSchool(schoolId) {
  const [allowance, school] = await Promise.all([
    getAiCreditsAllowanceForSchool(schoolId),
    prisma.school.findUnique({
      where: { id: schoolId },
      select: { aiCreditsUsedThisTerm: true },
    }),
  ]);

  const used = school?.aiCreditsUsedThisTerm ?? 0;

  return {
    allowance,
    used,
    remaining: Math.max(0, allowance - used),
    included: allowance > 0,
  };
}

module.exports = { getAiCreditsAllowanceForSchool, getAiCreditsStatusForSchool };
