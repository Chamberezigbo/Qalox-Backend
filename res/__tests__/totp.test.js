/**
 * RFC 6238 Appendix B test vectors.
 *
 * The published vectors use an ASCII seed ("12345678901234567890") and 8-digit
 * codes; our implementation is fixed at 6 digits, so we assert the last 6
 * digits of each published value — the truncation is identical, only the
 * modulus differs.
 */

const {
  base32Encode,
  base32Decode,
  generateSecret,
  generateToken,
  verifyToken,
  currentStep,
  buildOtpAuthUri,
} = require("../util/totp");

const RFC_SEED_ASCII = "12345678901234567890";
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SEED_ASCII, "ascii"));

describe("base32", () => {
  it("round-trips", () => {
    const buf = Buffer.from(RFC_SEED_ASCII, "ascii");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it("encodes the RFC 4648 example", () => {
    expect(base32Encode(Buffer.from("foobar", "ascii"))).toBe("MZXW6YTBOI");
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("ABC!DEF")).toThrow(/Invalid base32/);
  });
});

describe("RFC 6238 Appendix B vectors (SHA1)", () => {
  // [unix seconds, published 8-digit TOTP] — we compare the last 6 digits.
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("t=%i produces %s", (seconds, expected8) => {
    const step = currentStep(seconds * 1000);
    expect(generateToken(RFC_SECRET_B32, step)).toBe(expected8.slice(-6));
  });
});

describe("generateSecret", () => {
  it("is 160 bits, base32, and unique per call", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toHaveLength(32); // 20 bytes -> 32 base32 chars
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20);
  });
});

describe("verifyToken", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it("accepts the current code and returns its step", () => {
    const code = generateToken(secret, currentStep(now));
    expect(verifyToken(secret, code, { atMs: now })).toBe(currentStep(now));
  });

  it("accepts one step of drift either way", () => {
    const past = generateToken(secret, currentStep(now) - 1);
    const future = generateToken(secret, currentStep(now) + 1);
    expect(verifyToken(secret, past, { atMs: now })).toBe(currentStep(now) - 1);
    expect(verifyToken(secret, future, { atMs: now })).toBe(currentStep(now) + 1);
  });

  it("rejects a code two steps old (~1 minute)", () => {
    const stale = generateToken(secret, currentStep(now) - 2);
    expect(verifyToken(secret, stale, { atMs: now })).toBeNull();
  });

  it("rejects a code from ~2+ minutes ago", () => {
    const old = generateToken(secret, currentStep(now - 130_000));
    expect(verifyToken(secret, old, { atMs: now })).toBeNull();
  });

  it("rejects a wrong code", () => {
    expect(verifyToken(secret, "000000", { atMs: now })).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyToken(secret, "12345", { atMs: now })).toBeNull();
    expect(verifyToken(secret, "abcdef", { atMs: now })).toBeNull();
    expect(verifyToken(secret, "", { atMs: now })).toBeNull();
    expect(verifyToken(secret, null, { atMs: now })).toBeNull();
  });

  it("blocks replay via minStep", () => {
    const step = currentStep(now);
    const code = generateToken(secret, step);
    // First use succeeds.
    expect(verifyToken(secret, code, { atMs: now })).toBe(step);
    // Once that step is recorded, the same code is dead.
    expect(verifyToken(secret, code, { atMs: now, minStep: step })).toBeNull();
  });

  it("still allows the NEXT code after a replay block", () => {
    const step = currentStep(now);
    const next = generateToken(secret, step + 1);
    expect(verifyToken(secret, next, { atMs: now, minStep: step })).toBe(step + 1);
  });

  it("gives different users different codes", () => {
    const other = generateSecret();
    const step = currentStep(now);
    expect(generateToken(secret, step)).not.toBe(generateToken(other, step));
  });
});

describe("buildOtpAuthUri", () => {
  it("matches the agreed format", () => {
    const uri = buildOtpAuthUri({ secret: "ABC123", accountName: "user@example.com" });
    expect(uri).toContain("otpauth://totp/Qalox%20Marketer%20Portal:user%40example.com");
    expect(uri).toContain("secret=ABC123");
    expect(uri).toContain("issuer=Qalox");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
