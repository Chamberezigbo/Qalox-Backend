/**
 * Application-level AES-256-GCM encryption for secrets at rest.
 *
 * Used for TOTP secrets: a database dump must not hand an attacker the ability
 * to mint valid 2FA codes. GCM is authenticated, so tampering with a stored
 * ciphertext is detected on decrypt rather than silently yielding garbage.
 *
 * Key comes from TWO_FACTOR_ENCRYPTION_KEY — 32 bytes, hex or base64.
 * Generate one with:  openssl rand -hex 32
 *
 * Stored format:  v1.<iv-b64>.<authTag-b64>.<ciphertext-b64>
 * The version prefix leaves room to rotate algorithms later without guessing
 * how existing rows were written.
 */

const crypto = require("crypto");

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

let cachedKey = null;

const loadKey = () => {
  if (cachedKey) return cachedKey;

  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TWO_FACTOR_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32`. " +
        "Two-factor authentication cannot operate without it."
    );
  }

  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TWO_FACTOR_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`
    );
  }

  cachedKey = key;
  return cachedKey;
};

const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
};

const decrypt = (payload) => {
  if (typeof payload !== "string") throw new Error("Encrypted payload must be a string");

  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted payload");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, loadKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

/** True when a usable key is configured — lets callers fail with a clear 503. */
const isConfigured = () => {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
};

module.exports = { encrypt, decrypt, isConfigured };
