const prisma = require("../util/prisma");
const logger = require("../config/logger");

const RETENTION_DAYS = parseInt(process.env.LOGIN_EVENT_RETENTION_DAYS, 10) || 180;

/**
 * Prunes LoginEvent rows older than the retention window. Pure analytics —
 * append-only, referenced by nothing — so a straight age-based delete is
 * safe. Deliberately does NOT touch SecurityEvent (2FA enable/disable,
 * recovery code use): that's a security audit trail, not a login log, and
 * warrants a longer/manual retention decision rather than this default.
 */
async function cleanupOldLoginEvents() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const { count } = await prisma.loginEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  logger.info("[AUDIT_LOG_CLEANUP] Run complete", { retentionDays: RETENTION_DAYS, deleted: count });
}

module.exports = { cleanupOldLoginEvents, RETENTION_DAYS };
