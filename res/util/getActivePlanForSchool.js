const prisma = require("./prisma");

/**
 * Resolves a school's currently active (or trialing) BillingPlan, if any.
 * A trial past its trialEndsAt is lazily flipped to "past_due" here — there's
 * no cron in this codebase, so expiry is resolved the moment it's checked
 * rather than on a schedule.
 * @param {number} schoolId
 * @returns {Promise<import("@prisma/client").BillingPlan | null>}
 */
async function getActivePlanForSchool(schoolId) {
  const sub = await prisma.schoolSubscription.findFirst({
    where: { schoolId, status: { in: ["active", "trial"] } },
    orderBy: { createdAt: "desc" },
    include: { billingPlan: true },
  });

  if (!sub) return null;

  if (sub.status === "trial" && sub.trialEndsAt && sub.trialEndsAt < new Date()) {
    await prisma.schoolSubscription.update({
      where: { id: sub.id },
      data: { status: "past_due" },
    });
    return null;
  }

  return sub.billingPlan;
}

module.exports = { getActivePlanForSchool };
