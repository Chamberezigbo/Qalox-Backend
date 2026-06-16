// res/util/adminStep.js
const prisma = require("./prisma");

const MAX_STEPS = 6;

/**
 * Increment an admin's setup steps by 1 without exceeding MAX_STEPS.
 * Returns { previous, current, incremented: boolean, capped: boolean }.
 */
async function incrementAdminStep(adminId) {
  if (!adminId || isNaN(parseInt(adminId))) {
    throw new Error("Valid adminId is required to increment steps.");
  }

  // Fetch current steps
  const admin = await prisma.admin.findUnique({
    where: { id: parseInt(adminId) },
    select: { steps: true },
  });

  if (!admin) {
    throw new Error("Admin not found.");
  }

  const previous = admin.steps ?? 0;
  if (previous >= MAX_STEPS) {
    return {
      previous,
      current: previous,
      incremented: false,
      capped: true,
      message: "Maximum setup step already reached.",
    };
  }

  const next = previous + 1 > MAX_STEPS ? MAX_STEPS : previous + 1;

  const updated = await prisma.admin.update({
    where: { id: parseInt(adminId) },
    data: { steps: next },
    select: { steps: true },
  });

  return {
    previous,
    current: updated.steps,
    incremented: updated.steps !== previous,
    capped: updated.steps >= MAX_STEPS,
  };
}

module.exports = {
  incrementAdminStep,
  MAX_STEPS,
};