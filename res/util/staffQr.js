const crypto = require("crypto");

/**
 * Staff attendance QR tokens.
 *   live     v<version>.<site>.<window>.<sig>   changes every WINDOW_SECONDS; valid for this and the previous window
 *   printed  p<version>.<site>.<sig>            valid until the school regenerates (version bump)
 * `site` is the campus id (0 = whole school). The signature is an HMAC with the school's own secret,
 * so a token from one school or campus can never work at another, and a screenshot of a live code
 * is dead within about a minute.
 */

const WINDOW_SECONDS = 30;
const ACCEPT_WINDOWS_BACK = 1; // the current window and one before it, for scan + network delay

const hmac = (secret, text) => crypto.createHmac("sha256", secret).update(text).digest("base64url").slice(0, 22);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const windowOf = (nowMs) => Math.floor(nowMs / 1000 / WINDOW_SECONDS);

const newSecret = () => crypto.randomBytes(32).toString("base64url");

const liveToken = ({ secret, version, site, nowMs = Date.now() }) => {
  const w = windowOf(nowMs);
  const body = `v${version}.${site}.${w}`;
  return { token: `${body}.${hmac(secret, body)}`, expiresInSeconds: WINDOW_SECONDS - (Math.floor(nowMs / 1000) % WINDOW_SECONDS) };
};

const printedToken = ({ secret, version, site }) => {
  const body = `p${version}.${site}`;
  return `${body}.${hmac(secret, body)}`;
};

/** { ok, site, kind } or { ok:false, reason: malformed|bad_signature|expired|revoked|wrong_mode } */
const verifyToken = ({ token, secret, version, mode, nowMs = Date.now() }) => {
  if (typeof token !== "string" || token.length > 80) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  const kind = parts[0]?.[0];
  if (kind === "v" && parts.length === 4) {
    const tokVersion = Number(parts[0].slice(1));
    const site = Number(parts[1]);
    const w = Number(parts[2]);
    if (![tokVersion, site, w].every(Number.isInteger) || site < 0) return { ok: false, reason: "malformed" };
    if (!safeEqual(parts[3], hmac(secret, parts.slice(0, 3).join(".")))) return { ok: false, reason: "bad_signature" };
    if (tokVersion !== version) return { ok: false, reason: "revoked" };
    if (mode !== "live") return { ok: false, reason: "wrong_mode" };
    const now = windowOf(nowMs);
    if (w > now + 1 || w < now - ACCEPT_WINDOWS_BACK) return { ok: false, reason: "expired" };
    return { ok: true, site, kind: "live" };
  }
  if (kind === "p" && parts.length === 3) {
    const tokVersion = Number(parts[0].slice(1));
    const site = Number(parts[1]);
    if (![tokVersion, site].every(Number.isInteger) || site < 0) return { ok: false, reason: "malformed" };
    if (!safeEqual(parts[2], hmac(secret, parts.slice(0, 2).join(".")))) return { ok: false, reason: "bad_signature" };
    if (tokVersion !== version) return { ok: false, reason: "revoked" };
    if (mode !== "printed") return { ok: false, reason: "wrong_mode" };
    return { ok: true, site, kind: "printed" };
  }
  return { ok: false, reason: "malformed" };
};

module.exports = { WINDOW_SECONDS, newSecret, liveToken, printedToken, verifyToken, windowOf };
