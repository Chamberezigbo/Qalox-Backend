/**
 * The short-lived token handed out between password success and TOTP success.
 *
 * It is signed with a key DERIVED from JWT_SECRET rather than JWT_SECRET
 * itself. That is the whole point: every other middleware in this codebase
 * calls jwt.verify(token, JWT_SECRET), so a temp token signed with a different
 * key fails verification there automatically. Correctness does not depend on
 * remembering to add a `type !== "2fa-temp"` guard to each of the six auth
 * middlewares — a forgotten guard would silently turn 2FA into a no-op.
 *
 * Derivation (rather than a new env var) keeps deployment unchanged; rotating
 * JWT_SECRET rotates this too, which is the desired coupling.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const TTL_SECONDS = 5 * 60; // §6: <= 5 minutes

const tempTokenSecret = () => {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("JWT_SECRET is not set");
  return crypto.createHash("sha256").update(`${base}::2fa-temp`).digest("hex");
};

/**
 * Returns the token plus its jti. Persist the jti on the user and clear it on
 * use — that is what makes the token single-use rather than merely expiring.
 */
const issue = (adminId) => {
  const jti = crypto.randomBytes(24).toString("hex");
  const token = jwt.sign({ id: adminId, type: "2fa-temp", jti }, tempTokenSecret(), {
    expiresIn: TTL_SECONDS,
  });
  return { token, jti };
};

/** Returns { id, jti } or null. Never throws. */
const verify = (token) => {
  try {
    const decoded = jwt.verify(token, tempTokenSecret());
    // Defence in depth: the derived key already makes cross-use impossible.
    if (decoded.type !== "2fa-temp" || !decoded.id || !decoded.jti) return null;
    return { id: decoded.id, jti: decoded.jti };
  } catch {
    return null;
  }
};

module.exports = { issue, verify, TTL_SECONDS };
