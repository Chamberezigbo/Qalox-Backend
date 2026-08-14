/**
 * RFC 6238 TOTP / RFC 4226 HOTP, implemented on node's crypto.
 *
 * Written out rather than pulled from a package so the auth-critical path has
 * no third-party surface, and so the parameters are visible and pinned:
 *
 *   HMAC-SHA1, 6 digits, 30-second period
 *
 * SHA1 is not a mistake here. Google Authenticator, Authy, 1Password and
 * Microsoft Authenticator all assume SHA1/6/30 and silently produce wrong
 * codes against SHA-256 even when the otpauth URI declares it. Interoperability
 * wins; the HMAC construction is not the weak link in a 6-digit OTP.
 *
 * Validated against the RFC 6238 Appendix B test vectors — see
 * res/__tests__/totp.test.js.
 */

const crypto = require("crypto");

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const ALGORITHM = "sha1";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding. */
const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
};

const base32Decode = (input) => {
  const cleaned = String(input).toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in secret");

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

/**
 * 160-bit secret, the RFC 4226 recommended size and what authenticator apps
 * expect. randomBytes is a CSPRNG — never derive this from user data.
 */
const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** RFC 4226 HOTP: dynamic truncation of an HMAC over the 8-byte counter. */
const hotp = (secretBuffer, counter) => {
  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. writeBigUInt64BE keeps this exact
  // past 2^32 steps, where a naive 32-bit write would silently wrap.
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac(ALGORITHM, secretBuffer).update(counterBuffer).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
};

/** The 30-second time step for a given moment (defaults to now). */
const currentStep = (atMs = Date.now()) => Math.floor(atMs / 1000 / PERIOD_SECONDS);

const generateToken = (base32Secret, step = currentStep()) =>
  hotp(base32Decode(base32Secret), step);

/**
 * Verify a submitted code.
 *
 * Accepts steps t-1, t, t+1 only — one period of drift either way. Widening
 * this multiplies the attacker's guessing window for no real usability gain.
 *
 * `minStep` enforces replay protection: pass the last step already accepted for
 * this user and any code at or below it is refused, so a valid code works once.
 *
 * Returns the matched step, or null. Comparison is constant-time.
 */
const verifyToken = (base32Secret, submittedCode, { atMs = Date.now(), window = 1, minStep = null } = {}) => {
  if (typeof submittedCode !== "string" || !/^\d{6}$/.test(submittedCode)) return null;

  const secretBuffer = base32Decode(base32Secret);
  const centre = currentStep(atMs);
  const submitted = Buffer.from(submittedCode, "utf8");

  let matchedStep = null;

  for (let offset = -window; offset <= window; offset++) {
    const step = centre + offset;
    if (step < 0) continue;
    if (minStep !== null && step <= minStep) continue; // already-used step: replay

    const expected = Buffer.from(hotp(secretBuffer, step), "utf8");

    // timingSafeEqual needs equal lengths; both are always 6 ASCII digits.
    // Do NOT break on match — returning early would leak, via timing, which
    // step matched. Scan every candidate regardless.
    if (expected.length === submitted.length && crypto.timingSafeEqual(expected, submitted)) {
      matchedStep = step;
    }
  }

  return matchedStep;
};

/**
 * otpauth:// URI for the QR code. Label and issuer are percent-encoded; the
 * duplicated issuer (in the label prefix and as a parameter) is what every
 * authenticator app expects.
 */
const buildOtpAuthUri = ({ secret, accountName, issuer = "Qalox" }) => {
  const label = encodeURIComponent(`${issuer} Marketer Portal`) + ":" + encodeURIComponent(accountName);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  currentStep,
  generateToken,
  verifyToken,
  buildOtpAuthUri,
  DIGITS,
  PERIOD_SECONDS,
};
