/**
 * The money maths for in-app fee payments. All amounts are worked out in whole kobo
 * (integers), so no floating-point drift can ever put the school a kobo short.
 *
 * The parent pays the fee PLUS the service charge; the school receives the full fee.
 */

const DEFAULT_RATE_PERCENT = 2;
const MIN_PAYMENT_NAIRA = 100;
const MAX_RATE_PERCENT = 20;

const toKobo = (naira) => Math.round(Number(naira) * 100);
const toNaira = (kobo) => kobo / 100;

/** The service charge rate: the school's own if it has one, else the platform's (env), else 2. */
function serviceChargeRate(settings) {
  const own = settings?.serviceChargePercent;
  const fromEnv = process.env.FEE_SERVICE_CHARGE_PERCENT === undefined ? NaN : Number(process.env.FEE_SERVICE_CHARGE_PERCENT);
  const candidate = typeof own === "number" ? own : Number.isFinite(fromEnv) ? fromEnv : DEFAULT_RATE_PERCENT;
  return candidate >= 0 && candidate <= MAX_RATE_PERCENT ? candidate : DEFAULT_RATE_PERCENT;
}

/**
 * What the payer is charged for a fee of `feeNaira`.
 * The charge is rounded UP to the next kobo, so Qalox's share is never rounded away.
 * @returns {{ fee: number, serviceCharge: number, total: number, ratePercent: number }} naira amounts
 */
function computeBreakdown(feeNaira, ratePercent) {
  const feeKobo = toKobo(feeNaira);
  // The rate in hundredths of a percent (2 -> 200), so the arithmetic stays integer: kobo * bp / 10000.
  const rateBp = Math.round(ratePercent * 100);
  const chargeKobo = Math.floor((feeKobo * rateBp + 9999) / 10000);
  return {
    fee: toNaira(feeKobo),
    serviceCharge: toNaira(chargeKobo),
    total: toNaira(feeKobo + chargeKobo),
    ratePercent,
  };
}

/**
 * Checks a requested payment against what is still owed.
 * @returns {string | null} the problem in plain words, or null when the amount is fine
 */
function amountProblem(amountNaira, outstandingNaira) {
  const amount = Number(amountNaira);
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a valid amount";
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return "The amount can have at most two decimal places";
  const outstandingKobo = toKobo(outstandingNaira);
  if (outstandingKobo <= 0) return "This fee is already fully paid";
  // A small balance can be paid in full even when it is under the usual minimum.
  const minKobo = Math.min(toKobo(MIN_PAYMENT_NAIRA), outstandingKobo);
  if (toKobo(amount) < minKobo) return `The smallest payment is ₦${toNaira(minKobo).toLocaleString("en-NG")}`;
  if (toKobo(amount) > outstandingKobo) return `You only owe ₦${toNaira(outstandingKobo).toLocaleString("en-NG")}`;
  return null;
}

module.exports = { DEFAULT_RATE_PERCENT, MIN_PAYMENT_NAIRA, serviceChargeRate, computeBreakdown, amountProblem, toKobo, toNaira };
