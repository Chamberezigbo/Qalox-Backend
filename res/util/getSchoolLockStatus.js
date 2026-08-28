const prisma = require("./prisma");
const { getActivePlanForSchool } = require("./getActivePlanForSchool");

const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;

/**
 * A school is locked once its 48-hour post-setup grace period has passed AND
 * it has no active/trial plan right now. This also covers a later lapse (a
 * paid subscription going past_due), not just the initial signup window —
 * it's re-derived on every check, lazily, same philosophy as
 * getActivePlanForSchool's trial-expiry resolution.
 * @param {number} schoolId
 * @returns {Promise<{locked: boolean, graceEndsAt: Date|null}>}
 */
async function getSchoolLockStatus(schoolId) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { createdAt: true, setupCompletedAt: true },
  });
  if (!school) return { locked: false, graceEndsAt: null };

  // setupCompletedAt is set once, precisely, at school-creation time — unlike
  // createdAt, which res/util/prisma.js's global middleware truncates to a
  // date-only value (drops time-of-day) for every model. Using the truncated
  // createdAt here would let the 48h grace period run as short as ~24h for a
  // school set up late in the day. Pre-existing schools from before this
  // field existed fall back to createdAt (already truncated, but those are
  // one-time legacy cases, not the ongoing precision-sensitive path).
  const anchor = school.setupCompletedAt ?? school.createdAt;
  const anchorDate = anchor instanceof Date ? anchor : new Date(anchor);
  const graceEndsAt = new Date(anchorDate.getTime() + GRACE_PERIOD_MS);
  if (Date.now() < graceEndsAt.getTime()) {
    return { locked: false, graceEndsAt };
  }

  const plan = await getActivePlanForSchool(schoolId);
  return { locked: !plan, graceEndsAt };
}

module.exports = { getSchoolLockStatus, GRACE_PERIOD_MS };
