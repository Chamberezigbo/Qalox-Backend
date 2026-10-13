const prisma = require("./prisma");

/**
 * Whether a school has been suspended by Super Admin.
 *
 * Suspending a school is meant to stop everyone in it from using Qalox, and the
 * Super Admin dialog says so, but nothing ever read the flag: it only changed a
 * badge in a list. This is the one place that reads it, shared by every login and
 * auth middleware so the rule cannot drift between portals.
 *
 * A request is checked on every call, which would be a database read each time,
 * so the answer is remembered for a few seconds. Suspending or reactivating from
 * this server clears it at once (clearSchoolSuspensionCache); another server
 * instance sees the change within TTL_MS.
 */

const TTL_MS = 15 * 1000;
const cache = new Map(); // schoolId -> { suspended, at }

const SCHOOL_SUSPENDED_MESSAGE =
  "This school's account has been suspended. Please contact Qalox support.";
const ACCOUNT_SUSPENDED_MESSAGE =
  "This account has been suspended. Please contact your school administrator.";

/** @param {number} schoolId */
async function isSchoolSuspended(schoolId) {
  if (!schoolId) return false;

  const hit = cache.get(schoolId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.suspended;

  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { isSuspended: true } });
  const suspended = school?.isSuspended === true;
  cache.set(schoolId, { suspended, at: Date.now() });
  return suspended;
}

function clearSchoolSuspensionCache(schoolId) {
  if (schoolId === undefined) cache.clear();
  else cache.delete(schoolId);
}

module.exports = {
  isSchoolSuspended,
  clearSchoolSuspensionCache,
  SCHOOL_SUSPENDED_MESSAGE,
  ACCOUNT_SUSPENDED_MESSAGE,
  TTL_MS,
};
