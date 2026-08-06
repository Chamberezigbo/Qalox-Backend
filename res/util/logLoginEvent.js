const prisma = require("./prisma");
const logger = require("../config/logger");

/**
 * Best-effort login telemetry — never let a failure here break an actual
 * login. Written going forward only; there is no historical data to backfill.
 */
const logLoginEvent = async ({ actorType, actorId, schoolId, req }) => {
  try {
    await prisma.loginEvent.create({
      data: {
        actorType,
        actorId,
        schoolId: schoolId ?? null,
        ip: req?.ip || req?.headers?.["x-forwarded-for"] || null,
        userAgent: req?.headers?.["user-agent"] || null,
      },
    });
  } catch (err) {
    logger.warn("[LOGIN_EVENT] Failed to record login event", { actorType, actorId, error: err.message });
  }
};

module.exports = { logLoginEvent };
