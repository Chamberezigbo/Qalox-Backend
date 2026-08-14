const crypto = require("crypto");

/**
 * Short-lived signed URLs for marketer identity documents.
 *
 * The problem this solves: the Super Admin Portal previews documents with
 * <img src>, <iframe src> and target="_blank" links. Those are plain browser
 * requests — the browser sends no Authorization or x-service-key header, so a
 * header-authenticated route can only ever answer 401 to them.
 *
 * The two obvious fixes are both bad:
 *   - Serve the files from res/uploads (public express.static): a government ID
 *     scan becomes world-readable forever to anyone who learns the filename.
 *   - Make the portal fetch with headers and build a blob: URL: works, but it
 *     is a frontend change and blob URLs break "open in new tab".
 *
 * So instead the capability travels IN the URL and expires. The link works
 * header-free for a short window, and is useless afterwards.
 */

// Default lifetime. Long enough that an operator can open the marketers list,
// scroll, and click through to a document without the link dying under them;
// short enough that a URL copied out of devtools or a screen-share is stale by
// the time anyone else tries it.
const DEFAULT_TTL_SECONDS = 30 * 60;

/**
 * Domain-separated signing key.
 *
 * Derived from JWT_SECRET rather than used directly: the same raw secret also
 * signs session tokens, and one key doing two unrelated jobs means a flaw in
 * either context weakens both. Hashing with a fixed label gives an independent
 * key without adding another value to .env that someone has to remember to set
 * in production.
 *
 * The label carries a version so the scheme can be rotated later by bumping it,
 * which invalidates every outstanding URL at once.
 */
const signingKey = () => {
  const base = process.env.DOCUMENT_URL_SECRET || process.env.JWT_SECRET;

  if (!base) {
    throw new Error("Cannot sign document URLs: neither DOCUMENT_URL_SECRET nor JWT_SECRET is set");
  }

  return crypto.createHmac("sha256", base).update("qalox-document-url-v1").digest();
};

/**
 * The exact bytes covered by the signature.
 *
 * marketerId, documentId AND exp are all inside it. Leaving any one out would
 * let a valid link be edited into a different one — drop documentId and a
 * signature for document 1 opens document 2; drop exp and the link never dies.
 * The separator is ":" and every part is a number, so no value can contain the
 * separator and shift the boundaries.
 */
const canonicalString = (marketerId, documentId, exp) => `${marketerId}:${documentId}:${exp}`;

const computeSignature = (marketerId, documentId, exp) =>
  crypto
    .createHmac("sha256", signingKey())
    .update(canonicalString(marketerId, documentId, exp))
    .digest("hex");

/**
 * Query parameters granting time-limited access to one document.
 *
 * @returns {{ exp: number, sig: string }} exp is a unix timestamp in seconds
 */
const signDocumentUrl = (marketerId, documentId, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;

  return { exp, sig: computeSignature(marketerId, documentId, exp) };
};

/**
 * Validate a signature from a request's query string.
 *
 * Returns a reason code rather than a bare false so the caller can tell an
 * expired link (operator left a tab open — recoverable, just reload) from a
 * forged one (worth logging), without leaking that distinction to the client.
 *
 * @returns {{ valid: boolean, reason?: 'MISSING' | 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE' }}
 */
const verifyDocumentSignature = (marketerId, documentId, exp, sig) => {
  if (!exp || !sig) return { valid: false, reason: "MISSING" };

  const expiresAt = Number(exp);

  // Number() turns "" and null into 0 and junk into NaN; reject both rather
  // than letting a weird value reach the comparison below.
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) {
    return { valid: false, reason: "MALFORMED" };
  }

  const expected = computeSignature(marketerId, documentId, expiresAt);
  const provided = String(sig);

  // Shape check before the compare: exactly 64 lowercase hex characters, which
  // is what a SHA-256 HMAC digest always is.
  //
  // This used to compare `provided.length !== expected.length`, which was
  // wrong: JS string length counts UTF-16 code units but timingSafeEqual
  // compares BYTE length. A 64-character signature containing a multi-byte
  // character (e.g. "%C3%A9" in the path, which Express URL-decodes to one
  // 2-byte char) passed the length check, then made timingSafeEqual throw
  // RangeError — surfacing as a 500 that echoed the internal crypto error,
  // instead of a 401, and skipping the forgery warning log entirely.
  //
  // Constraining the character set fixes it at the root: anything matching
  // this is ASCII, so code units and bytes are the same count by construction.
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }

  // Constant-time compare: a plain === leaks how many leading characters were
  // right, which is enough to reconstruct a signature byte by byte.
  const matches = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!matches) return { valid: false, reason: "BAD_SIGNATURE" };

  // Expiry is checked only AFTER the signature verifies. Checking it first
  // would answer "expired" to an attacker probing with a forged signature and
  // a past timestamp, confirming the timestamp format for free.
  if (expiresAt < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: "EXPIRED" };
  }

  return { valid: true };
};

module.exports = {
  signDocumentUrl,
  verifyDocumentSignature,
  DEFAULT_TTL_SECONDS,
};
