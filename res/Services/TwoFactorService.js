/**
 * Two-factor authentication (TOTP) for the Marketer Portal.
 *
 * Enrolment is two-phase: setup() stores a PENDING secret and does not enable
 * anything; only activate() promotes it, and only against a genuinely valid
 * code. That way an abandoned setup never leaves an account half-protected.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");

const prisma = require("../util/prisma");
const logger = require("../config/logger");
const totp = require("../util/totp");
const secretBox = require("../util/secretBox");

const PENDING_TTL_MS = 15 * 60 * 1000; // §3: pending secret survives modal close
const RECOVERY_CODE_COUNT = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Recovery code: 10 base32 chars (~50 bits). Displayed grouped as XXXXX-XXXXX
 * for legibility; the dash is cosmetic and stripped before hashing so users can
 * type it either way.
 */
const generateRecoveryCode = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  // rejection-free: 32 divides 256 evenly, so a byte mod 32 is unbiased
  for (const byte of crypto.randomBytes(10)) out += alphabet[byte % 32];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
};

const normaliseRecoveryCode = (code) =>
  String(code || "").toUpperCase().replace(/[^A-Z2-7]/g, "");

/** ---- throttling (§7) ---- */

const isLockedOut = (admin) =>
  Boolean(admin.twoFactorLockedUntil && admin.twoFactorLockedUntil > new Date());

const lockoutSecondsRemaining = (admin) =>
  Math.max(0, Math.ceil((admin.twoFactorLockedUntil - new Date()) / 1000));

const recordFailure = async (adminId, currentAttempts) => {
  const attempts = (currentAttempts || 0) + 1;
  const locked = attempts >= MAX_FAILED_ATTEMPTS;

  await prisma.admin.update({
    where: { id: adminId },
    data: {
      twoFactorFailedAttempts: locked ? 0 : attempts,
      twoFactorLockedUntil: locked ? new Date(Date.now() + LOCKOUT_MS) : null,
    },
  });

  logger.warn(`[2FA] Failed attempt`, { adminId, attempts, locked });
  return { attempts, locked };
};

const clearFailures = (adminId) =>
  prisma.admin.update({
    where: { id: adminId },
    data: { twoFactorFailedAttempts: 0, twoFactorLockedUntil: null },
  });

/** ---- audit (§9) ---- */

const recordSecurityEvent = async ({ adminId, event, detail, req }) => {
  try {
    await prisma.securityEvent.create({
      data: {
        adminId,
        event,
        detail: detail || null,
        ipAddress: req?.ip || req?.headers?.["x-forwarded-for"] || null,
        userAgent: req?.headers?.["user-agent"] || null,
      },
    });
  } catch (err) {
    // Never let audit failure break the security operation it describes.
    logger.error(`[2FA] Failed to write security event`, { adminId, event, error: err.message });
  }
};

/** ---- enrolment ---- */

/**
 * Begin enrolment. Reuses an unexpired pending secret so reopening the modal
 * does not rotate the QR the user is mid-way through scanning (§3).
 */
const setup = async (admin) => {
  const reusable =
    admin.twoFactorPendingSecret &&
    admin.twoFactorPendingExpiresAt &&
    admin.twoFactorPendingExpiresAt > new Date();

  let secret;
  if (reusable) {
    secret = secretBox.decrypt(admin.twoFactorPendingSecret);
  } else {
    secret = totp.generateSecret();
    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        twoFactorPendingSecret: secretBox.encrypt(secret),
        twoFactorPendingExpiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
  }

  const uri = totp.buildOtpAuthUri({ secret, accountName: admin.email });
  const qrCodeDataUrl = await QRCode.toDataURL(uri, { width: 240, margin: 1 });

  // The ONLY place the plaintext secret is ever returned (§1).
  return { qrCodeDataUrl, secret };
};

/**
 * Promote pending -> active against a real code, and issue recovery codes.
 * Returns null if the code is wrong, so the caller can leave 2FA off.
 */
const activate = async (admin, submittedCode) => {
  if (!admin.twoFactorPendingSecret || !admin.twoFactorPendingExpiresAt) return { error: "NO_PENDING_SETUP" };
  if (admin.twoFactorPendingExpiresAt <= new Date()) return { error: "SETUP_EXPIRED" };

  const secret = secretBox.decrypt(admin.twoFactorPendingSecret);
  const step = totp.verifyToken(secret, submittedCode);
  if (step === null) return { error: "INVALID_CODE" };

  const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashed = await Promise.all(
    plainCodes.map((code) => bcrypt.hash(normaliseRecoveryCode(code), 10))
  );

  await prisma.$transaction(
    async (tx) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { adminId: admin.id } });
      await tx.twoFactorRecoveryCode.createMany({
        data: hashed.map((codeHash) => ({ adminId: admin.id, codeHash })),
      });
      await tx.admin.update({
        where: { id: admin.id },
        data: {
          twoFactorEnabled: true,
          twoFactorSecret: admin.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorPendingExpiresAt: null,
          twoFactorLastUsedStep: BigInt(step), // burn the enrolment code too
          twoFactorFailedAttempts: 0,
          twoFactorLockedUntil: null,
        },
      });
    },
    { timeout: 20000, maxWait: 10000 }
  );

  return { recoveryCodes: plainCodes };
};

/**
 * Verify a login challenge. Accepts a TOTP code OR a single-use recovery code.
 */
const verifyChallenge = async (admin, submittedCode) => {
  // TOTP first — the common path.
  if (admin.twoFactorSecret) {
    const secret = secretBox.decrypt(admin.twoFactorSecret);
    const minStep =
      admin.twoFactorLastUsedStep === null || admin.twoFactorLastUsedStep === undefined
        ? null
        : Number(admin.twoFactorLastUsedStep);

    const step = totp.verifyToken(secret, submittedCode, { minStep });
    if (step !== null) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: {
          twoFactorLastUsedStep: BigInt(step),
          twoFactorFailedAttempts: 0,
          twoFactorLockedUntil: null,
        },
      });
      return { method: "totp" };
    }
  }

  // Recovery code fallback. bcrypt hashes are not searchable, so every unused
  // code is compared; the set is capped at 10, so this stays cheap.
  const candidate = normaliseRecoveryCode(submittedCode);
  if (candidate.length === RECOVERY_CODE_COUNT) {
    const unused = await prisma.twoFactorRecoveryCode.findMany({
      where: { adminId: admin.id, usedAt: null },
    });

    for (const row of unused) {
      if (await bcrypt.compare(candidate, row.codeHash)) {
        await prisma.twoFactorRecoveryCode.update({
          where: { id: row.id },
          data: { usedAt: new Date() },
        });
        await clearFailures(admin.id);

        const remaining = await prisma.twoFactorRecoveryCode.count({
          where: { adminId: admin.id, usedAt: null },
        });
        return { method: "recovery_code", recoveryCodesRemaining: remaining };
      }
    }
  }

  return null;
};

/** Clear every trace of 2FA for this account. */
const disable = async (adminId) => {
  await prisma.$transaction(
    async (tx) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { adminId } });
      await tx.admin.update({
        where: { id: adminId },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorPendingSecret: null,
          twoFactorPendingExpiresAt: null,
          twoFactorLastUsedStep: null,
          twoFactorTempTokenId: null,
          twoFactorFailedAttempts: 0,
          twoFactorLockedUntil: null,
        },
      });
    },
    { timeout: 20000, maxWait: 10000 }
  );
};

/** Fresh set, old set invalidated. */
const regenerateRecoveryCodes = async (adminId) => {
  const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashed = await Promise.all(
    plainCodes.map((code) => bcrypt.hash(normaliseRecoveryCode(code), 10))
  );

  await prisma.$transaction(
    async (tx) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { adminId } });
      await tx.twoFactorRecoveryCode.createMany({
        data: hashed.map((codeHash) => ({ adminId, codeHash })),
      });
    },
    { timeout: 20000, maxWait: 10000 }
  );

  return plainCodes;
};

module.exports = {
  setup,
  activate,
  verifyChallenge,
  disable,
  regenerateRecoveryCodes,
  isLockedOut,
  lockoutSecondsRemaining,
  recordFailure,
  clearFailures,
  recordSecurityEvent,
  generateRecoveryCode,
  normaliseRecoveryCode,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MS,
  PENDING_TTL_MS,
  RECOVERY_CODE_COUNT,
};
