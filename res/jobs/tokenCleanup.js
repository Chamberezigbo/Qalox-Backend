const prisma = require("../util/prisma");
const logger = require("../config/logger");

const RETENTION_DAYS = parseInt(process.env.TOKEN_RETENTION_DAYS, 10) || 30;

/**
 * Prunes dead auth artifacts a modest while after they stopped being valid:
 *
 * - Token (school-onboarding registration invites): once used (usedAt set)
 *   or expired (expiresAt passed), it can never register another admin —
 *   it's just history at that point.
 * - TwoFactorRecoveryCode: single-use by design. ONLY rows with usedAt set
 *   are touched — an unused code must never be deleted, it's still a live
 *   recovery path for that admin's account.
 *
 * The retention window (default 30 days) is a grace period, not a safety
 * margin — these rows are already permanently dead before it starts.
 */
async function cleanupDeadAuthArtifacts() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const [tokensDeleted, recoveryCodesDeleted] = await Promise.all([
    prisma.token.deleteMany({
      where: {
        OR: [
          { usedAt: { not: null, lt: cutoff } },
          { expiresAt: { not: null, lt: cutoff } },
        ],
      },
    }),
    prisma.twoFactorRecoveryCode.deleteMany({
      where: { usedAt: { not: null, lt: cutoff } },
    }),
  ]);

  logger.info("[TOKEN_CLEANUP] Run complete", {
    retentionDays: RETENTION_DAYS,
    tokensDeleted: tokensDeleted.count,
    recoveryCodesDeleted: recoveryCodesDeleted.count,
  });
}

module.exports = { cleanupDeadAuthArtifacts, RETENTION_DAYS };
