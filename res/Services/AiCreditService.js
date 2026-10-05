const prisma = require("../util/prisma");
const logger = require("../config/logger");
const { AppError } = require("../util/AppError");
const { getAiCreditsAllowanceForSchool } = require("../util/getAiCreditsAllowanceForSchool");

/**
 * Metering for every Gemini call the product makes on a school's behalf
 * (lesson notes, exam questions, and reading a photographed Scheme of Work).
 *
 * Why not a flat per-call counter like SMS: an SMS costs the same every time,
 * a Gemini call does not — cost moves with how much text goes in and how much
 * comes back. A flat counter would either overcharge a one-page request or let
 * a single large one swallow the term's budget.
 *
 * So cost is estimated in tokens, converted to credits, and charged in two
 * steps: reserve the worst case before the call (so a request that can't be
 * afforded never runs), then true up against the real token usage Gemini
 * reports back. A call that fails is refunded in full — a school is never
 * charged for output it didn't get.
 */

// Gemini 2.0 Flash list price, USD per 1M tokens. Re-verify against current
// Google AI pricing when changing models — AiGenerationJob.model records which
// model a historical job used so old rows stay interpretable.
const USD_PER_1M_INPUT_TOKENS = 0.1;
const USD_PER_1M_OUTPUT_TOKENS = 0.4;

// 1 credit = $0.0005 of spend, so $1 ≈ 2000 credits. Chosen so a typical
// lesson note lands at ~2 credits and a 30-question exam set at ~4 — small
// enough to price fairly, large enough that a termly allowance is a round
// number a school admin can reason about.
const USD_PER_CREDIT = 0.0005;

// Nothing in this codebase does real tokenisation and Gemini has no cheap
// pre-call tokeniser worth a round trip. ~4 characters per token is the usual
// rule of thumb and only has to be good enough to gate the request — the true
// number arrives with the response and is what actually gets charged.
const CHARS_PER_TOKEN = 4;

/** Image input is billed as a flat tile cost rather than by character. */
const TOKENS_PER_IMAGE = 800;

const estimateTokensFromText = (text) => Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);

/**
 * @param {{ inputTokens: number, outputTokens: number }} usage
 * @returns {number} credits, always at least 1 for a call that happened
 */
const creditsForTokens = ({ inputTokens = 0, outputTokens = 0 }) => {
  const usd =
    (inputTokens / 1_000_000) * USD_PER_1M_INPUT_TOKENS +
    (outputTokens / 1_000_000) * USD_PER_1M_OUTPUT_TOKENS;
  return Math.max(1, Math.ceil(usd / USD_PER_CREDIT));
};

/**
 * Takes credits off a school's termly balance before the work runs.
 *
 * The read and the increment share one transaction so two generations started
 * at the same moment can't both see the same remaining balance and overspend
 * it. Throws before anything is charged when the balance can't cover it.
 *
 * @param {number} schoolId
 * @param {number} credits worst-case cost of the call about to be made
 * @returns {Promise<{ reserved: number, remainingAfter: number }>}
 */
async function reserveCredits(schoolId, credits) {
  const allowance = await getAiCreditsAllowanceForSchool(schoolId);

  return prisma.$transaction(async (tx) => {
    const school = await tx.school.findUnique({
      where: { id: schoolId },
      select: { aiCreditsUsedThisTerm: true },
    });

    const used = school?.aiCreditsUsedThisTerm ?? 0;
    const remaining = allowance - used;

    // Every paid plan now carries an AI allowance, so reaching this means the
    // school has no active plan at all — getActivePlanForSchool returned null
    // because the subscription lapsed or was never started. Naming a tier to
    // upgrade to would be misleading advice.
    if (allowance <= 0) {
      throw new AppError(
        "AI generation needs an active subscription. Ask your school admin to renew your plan.",
        403
      );
    }

    if (credits > remaining) {
      throw new AppError(
        `Not enough AI credits left this term — this needs ${credits} and ${Math.max(0, remaining)} remain. Credits reset when the next term starts.`,
        400
      );
    }

    await tx.school.update({
      where: { id: schoolId },
      data: { aiCreditsUsedThisTerm: { increment: credits } },
    });

    return { reserved: credits, remainingAfter: remaining - credits };
  });
}

/**
 * Settles a reservation against what the call actually cost. The delta is
 * normally negative — the reservation assumed the output cap and real output
 * is usually shorter — so this mostly hands credits back.
 *
 * @param {number} schoolId
 * @param {number} reserved
 * @param {{ inputTokens: number, outputTokens: number }} actualUsage
 * @returns {Promise<{ charged: number }>}
 */
async function trueUpCredits(schoolId, reserved, actualUsage) {
  const charged = creditsForTokens(actualUsage);
  const delta = charged - reserved;

  if (delta !== 0) {
    await prisma.school.update({
      where: { id: schoolId },
      data: { aiCreditsUsedThisTerm: { increment: delta } },
    });
  }

  logger.info("[AI_CREDITS] Trued up", { schoolId, reserved, charged, delta });
  return { charged };
}

/**
 * Hands a whole reservation back after a failed call. Clamped at 0 so a
 * double refund (a retry of the same cleanup) can't push a school's usage
 * negative and silently grant free credits.
 *
 * @param {number} schoolId
 * @param {number} reserved
 */
async function refundCredits(schoolId, reserved) {
  if (!reserved) return;

  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { aiCreditsUsedThisTerm: true },
  });

  const used = school?.aiCreditsUsedThisTerm ?? 0;
  await prisma.school.update({
    where: { id: schoolId },
    data: { aiCreditsUsedThisTerm: Math.max(0, used - reserved) },
  });

  logger.info("[AI_CREDITS] Refunded", { schoolId, reserved });
}

module.exports = {
  reserveCredits,
  trueUpCredits,
  refundCredits,
  creditsForTokens,
  estimateTokensFromText,
  TOKENS_PER_IMAGE,
};
