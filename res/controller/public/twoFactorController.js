/**
 * Two-factor authentication endpoints (Marketer Portal).
 *
 * Replaces the previous placeholder implementation, which issued every user the
 * same hardcoded secret and accepted any six digits.
 *
 * Response shapes are held to the contract agreed with the frontend:
 *   POST /settings/2fa/setup        -> { qrCodeDataUrl, secret }
 *   POST /settings/2fa/verify-setup -> { twoFactorEnabled: true, recoveryCodes }
 *   POST /settings/2fa/disable      -> { twoFactorEnabled: false }
 *   POST /auth/2fa/verify           -> { token, user }
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const twoFactor = require("../../Services/TwoFactorService");
const secretBox = require("../../util/secretBox");
const twoFactorTempToken = require("../../util/twoFactorTempToken");
const emailService = require("../../Services/EmailService");
const { logLoginEvent } = require("../../util/logLoginEvent");

const unauthorized = (res) =>
  res.status(401).json({ success: false, message: "Unauthorized", code: "UNAUTHORIZED" });

const notConfigured = (res) =>
  res.status(503).json({
    success: false,
    message: "Two-factor authentication is not configured on the server.",
    code: "TWO_FACTOR_NOT_CONFIGURED",
  });

/** Fire-and-forget: a mail failure must never fail the security operation. */
const notify = (to, subject, html) => {
  emailService
    .sendEmail({ to, subject, html })
    .catch((err) => logger.error(`[2FA] Notification email failed`, { to, error: err.message }));
};

const loadMarketer = (id) =>
  prisma.admin.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, role: true, tier: true, password: true,
      referralCode: true, isEmailVerified: true, isSuspended: true,
      twoFactorEnabled: true, twoFactorSecret: true,
      twoFactorPendingSecret: true, twoFactorPendingExpiresAt: true,
      twoFactorLastUsedStep: true, twoFactorTempTokenId: true,
      twoFactorFailedAttempts: true, twoFactorLockedUntil: true,
    },
  });

/**
 * POST /api/public/settings/2fa/setup
 * Stores a PENDING secret and returns the QR. Does not enable anything.
 */
exports.setup2FA = async (req, res, next) => {
  try {
    const id = req.user?.id || req.marketer?.id;
    if (!id) return unauthorized(res);
    if (!secretBox.isConfigured()) return notConfigured(res);

    const admin = await loadMarketer(id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Account not found", code: "NOT_FOUND" });
    }

    if (admin.twoFactorEnabled) {
      return res.status(409).json({
        success: false,
        message: "Two-factor authentication is already enabled. Disable it first to re-enrol.",
        code: "ALREADY_ENABLED",
      });
    }

    const { qrCodeDataUrl, secret } = await twoFactor.setup(admin);

    logger.info(`[2FA_SETUP] Pending secret issued`, { adminId: id });

    return res.status(200).json({
      success: true,
      message: "Scan the QR code with your authenticator app",
      data: { qrCodeDataUrl, secret },
    });
  } catch (err) {
    logger.error(`[2FA_SETUP] Failed`, { adminId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/settings/2fa/verify-setup   { code }
 * Promotes pending -> active and returns the one-time recovery codes.
 */
exports.verifySetup2FA = async (req, res, next) => {
  try {
    const id = req.user?.id || req.marketer?.id;
    if (!id) return unauthorized(res);
    if (!secretBox.isConfigured()) return notConfigured(res);

    const { code } = req.body || {};
    const admin = await loadMarketer(id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Account not found", code: "NOT_FOUND" });
    }

    if (twoFactor.isLockedOut(admin)) {
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Try again later.",
        code: "TWO_FACTOR_LOCKED",
        data: { retryAfterSeconds: twoFactor.lockoutSecondsRemaining(admin) },
      });
    }

    const result = await twoFactor.activate(admin, code);

    if (result.error) {
      // Any failure leaves 2FA OFF — never enable on a bad code.
      const { locked } = await twoFactor.recordFailure(id, admin.twoFactorFailedAttempts);
      const status = result.error === "INVALID_CODE" ? 422 : 400;

      return res.status(locked ? 429 : status).json({
        success: false,
        message: locked
          ? "Too many failed attempts. Try again later."
          : result.error === "SETUP_EXPIRED"
            ? "This setup has expired. Start again to get a new QR code."
            : result.error === "NO_PENDING_SETUP"
              ? "Start setup before verifying a code."
              : "That code is not valid. Check your authenticator app and try again.",
        code: locked ? "TWO_FACTOR_LOCKED" : result.error,
        data: { twoFactorEnabled: false },
      });
    }

    await twoFactor.recordSecurityEvent({ adminId: id, event: "2fa_enabled", req });
    notify(
      admin.email,
      "Two-factor authentication enabled",
      `<p>Hello ${admin.name || ""},</p>
       <p>Two-factor authentication was just enabled on your Qalox marketer account.</p>
       <p>If this wasn't you, contact support immediately.</p>`
    );

    logger.info(`[2FA_VERIFY_SETUP] 2FA activated`, { adminId: id });

    return res.status(200).json({
      success: true,
      message: "Two-factor authentication enabled",
      data: { twoFactorEnabled: true, recoveryCodes: result.recoveryCodes },
    });
  } catch (err) {
    logger.error(`[2FA_VERIFY_SETUP] Failed`, { adminId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/settings/2fa/disable   { password }
 * Re-authentication required so a hijacked session cannot strip 2FA silently.
 */
exports.disable2FA = async (req, res, next) => {
  try {
    const id = req.user?.id || req.marketer?.id;
    if (!id) return unauthorized(res);

    const { password } = req.body || {};
    const admin = await loadMarketer(id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Account not found", code: "NOT_FOUND" });
    }

    if (twoFactor.isLockedOut(admin)) {
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Try again later.",
        code: "TWO_FACTOR_LOCKED",
        data: { retryAfterSeconds: twoFactor.lockoutSecondsRemaining(admin) },
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Your account password is required to disable two-factor authentication",
        code: "MISSING_PASSWORD",
      });
    }

    if (!(await bcrypt.compare(password, admin.password))) {
      const { locked } = await twoFactor.recordFailure(id, admin.twoFactorFailedAttempts);
      return res.status(locked ? 429 : 401).json({
        success: false,
        message: locked ? "Too many failed attempts. Try again later." : "Incorrect password",
        code: locked ? "TWO_FACTOR_LOCKED" : "INVALID_PASSWORD",
      });
    }

    await twoFactor.disable(id);
    await twoFactor.recordSecurityEvent({ adminId: id, event: "2fa_disabled", req });
    notify(
      admin.email,
      "Two-factor authentication disabled",
      `<p>Hello ${admin.name || ""},</p>
       <p>Two-factor authentication was just disabled on your Qalox marketer account,
          and your recovery codes were deleted.</p>
       <p>If this wasn't you, secure your account immediately.</p>`
    );

    logger.info(`[2FA_DISABLE] 2FA disabled`, { adminId: id });

    return res.status(200).json({
      success: true,
      message: "Two-factor authentication disabled",
      data: { twoFactorEnabled: false },
    });
  } catch (err) {
    logger.error(`[2FA_DISABLE] Failed`, { adminId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/settings/2fa/recovery-codes/regenerate   { password }
 */
exports.regenerateRecoveryCodes = async (req, res, next) => {
  try {
    const id = req.user?.id || req.marketer?.id;
    if (!id) return unauthorized(res);

    const { password } = req.body || {};
    const admin = await loadMarketer(id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Account not found", code: "NOT_FOUND" });
    }

    if (!admin.twoFactorEnabled) {
      return res.status(400).json({
        success: false,
        message: "Two-factor authentication is not enabled",
        code: "TWO_FACTOR_NOT_ENABLED",
      });
    }

    if (twoFactor.isLockedOut(admin)) {
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Try again later.",
        code: "TWO_FACTOR_LOCKED",
        data: { retryAfterSeconds: twoFactor.lockoutSecondsRemaining(admin) },
      });
    }

    if (!password || !(await bcrypt.compare(password, admin.password))) {
      const { locked } = await twoFactor.recordFailure(id, admin.twoFactorFailedAttempts);
      return res.status(locked ? 429 : 401).json({
        success: false,
        message: locked ? "Too many failed attempts. Try again later." : "Incorrect password",
        code: locked ? "TWO_FACTOR_LOCKED" : "INVALID_PASSWORD",
      });
    }

    const recoveryCodes = await twoFactor.regenerateRecoveryCodes(id);
    await twoFactor.clearFailures(id);
    await twoFactor.recordSecurityEvent({ adminId: id, event: "2fa_recovery_codes_regenerated", req });
    notify(
      admin.email,
      "Your recovery codes were regenerated",
      `<p>Hello ${admin.name || ""},</p>
       <p>New two-factor recovery codes were generated for your Qalox marketer account.
          Your previous codes no longer work.</p>
       <p>If this wasn't you, secure your account immediately.</p>`
    );

    return res.status(200).json({
      success: true,
      message: "Recovery codes regenerated",
      data: { recoveryCodes },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/public/auth/2fa/verify   { tempToken, code }
 * Completes login. `code` accepts a TOTP code or a single-use recovery code.
 */
exports.verify2FA = async (req, res, next) => {
  try {
    const { tempToken, code } = req.body || {};

    if (!tempToken || !code) {
      return res.status(400).json({
        success: false,
        message: "tempToken and code are required",
        code: "MISSING_FIELDS",
      });
    }

    const claims = twoFactorTempToken.verify(tempToken);
    if (!claims) {
      return res.status(401).json({
        success: false,
        message: "This sign-in attempt has expired. Please log in again.",
        code: "INVALID_TEMP_TOKEN",
      });
    }

    const admin = await loadMarketer(claims.id);
    if (!admin || !admin.twoFactorEnabled) {
      return res.status(401).json({
        success: false,
        message: "This sign-in attempt is no longer valid.",
        code: "INVALID_TEMP_TOKEN",
      });
    }

    // Single-use: the jti must still be the outstanding one.
    if (admin.twoFactorTempTokenId !== claims.jti) {
      logger.warn(`[2FA_VERIFY] Temp token replay or superseded`, { adminId: admin.id });
      return res.status(401).json({
        success: false,
        message: "This sign-in attempt is no longer valid.",
        code: "INVALID_TEMP_TOKEN",
      });
    }

    if (twoFactor.isLockedOut(admin)) {
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Try again later.",
        code: "TWO_FACTOR_LOCKED",
        data: { retryAfterSeconds: twoFactor.lockoutSecondsRemaining(admin) },
      });
    }

    const outcome = await twoFactor.verifyChallenge(admin, code);

    if (!outcome) {
      const { locked } = await twoFactor.recordFailure(admin.id, admin.twoFactorFailedAttempts);
      return res.status(locked ? 429 : 401).json({
        success: false,
        message: locked
          ? "Too many failed attempts. Try again later."
          : "That code is not valid.",
        code: locked ? "TWO_FACTOR_LOCKED" : "INVALID_CODE",
      });
    }

    // Burn the temp token so it cannot complete a second login.
    await prisma.admin.update({
      where: { id: admin.id },
      data: { twoFactorTempTokenId: null },
    });

    if (outcome.method === "recovery_code") {
      await twoFactor.recordSecurityEvent({
        adminId: admin.id,
        event: "2fa_recovery_code_used",
        detail: `${outcome.recoveryCodesRemaining} remaining`,
        req,
      });
      notify(
        admin.email,
        "A recovery code was used to sign in",
        `<p>Hello ${admin.name || ""},</p>
         <p>A two-factor recovery code was just used to sign in to your Qalox marketer account.
            You have ${outcome.recoveryCodesRemaining} unused codes left.</p>
         <p>If this wasn't you, secure your account immediately.</p>`
      );
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    await logLoginEvent({
      actorType: admin.role === "marketer" ? "marketer" : "admin",
      actorId: admin.id,
      req,
    });

    logger.info(`[2FA_VERIFY] Login completed`, { adminId: admin.id, method: outcome.method });

    return res.status(200).json({
      success: true,
      message: "Authentication successful",
      data: {
        token,
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        tier: admin.tier,
        referralCode: admin.referralCode,
        isEmailVerified: admin.isEmailVerified,
        ...(outcome.method === "recovery_code"
          ? { usedRecoveryCode: true, recoveryCodesRemaining: outcome.recoveryCodesRemaining }
          : {}),
      },
    });
  } catch (err) {
    logger.error(`[2FA_VERIFY] Failed`, { error: err.message });
    next(err);
  }
};
