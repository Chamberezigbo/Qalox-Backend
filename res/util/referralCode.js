const crypto = require("crypto");

/**
 * Marketer referral codes: QAL-XXXXXX, six uppercase alphanumerics.
 *
 * The alphabet deliberately drops I, O, 0 and 1 — codes get read off a screen
 * and typed by a school administrator, and those four are the pairs people
 * mistype. That leaves 32 symbols, so 32^6 ≈ 1.07 billion codes; collisions
 * are rare but not impossible, which is why generateUniqueReferralCode()
 * checks rather than assuming.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars
const CODE_LENGTH = 6;

/**
 * One candidate code. crypto.randomBytes, not Math.random — a referral code is
 * an identifier a signup gets attributed to, so it should not be predictable
 * from codes already issued.
 */
const generateReferralCode = () => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";

  for (let i = 0; i < CODE_LENGTH; i++) {
    // 256 is exactly 8 * 32, so `% 32` maps the byte range onto the alphabet
    // evenly — no character comes up more often than any other.
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return `QAL-${code}`;
};

/**
 * A code that is free at the moment we return it.
 *
 * Two callers can still generate the same code between this check and their
 * insert, so this narrows the odds rather than eliminating them — the UNIQUE
 * index on admins.referralCode is the real defence. Callers should catch
 * Prisma's P2002 and retry with a fresh code.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} attempts candidates to try before giving up
 */
const generateUniqueReferralCode = async (prisma, attempts = 5) => {
  for (let i = 0; i < attempts; i++) {
    const code = generateReferralCode();

    const taken = await prisma.admin.findUnique({
      where: { referralCode: code },
      select: { id: true }, // only existence matters, don't pull the whole row
    });

    if (!taken) return code;
  }

  // Five collisions in a row against a 1.07-billion space means something else
  // is wrong. Fail loudly rather than hand back a code we know is taken.
  throw new Error("Could not generate a unique referral code after 5 attempts");
};

module.exports = { generateReferralCode, generateUniqueReferralCode };
