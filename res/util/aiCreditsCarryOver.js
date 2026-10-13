/**
 * How purchased AI credits survive the term reset.
 *
 * A school spends credits from one counter (aiCreditsUsedThisTerm) against
 * "plan allowance + purchased". The plan's allowance is renewed every term, so at
 * the reset the counter goes back to zero. Purchased credits must not be renewed
 * with it, or every term's overspend would be handed back for free.
 *
 * The allowance is spent first, so only usage ABOVE the allowance came out of
 * purchased credits. That is the amount to take off at the reset; the rest of the
 * purchase is carried over untouched.
 *
 * Pure function, no database access.
 *
 * @param {{ used: number, baseAllowance: number, purchased: number }} input
 * @returns {number} the purchased balance to carry into the new term
 */
function purchasedAfterReset({ used, baseAllowance, purchased }) {
  const u = Math.max(0, Number(used) || 0);
  const base = Math.max(0, Number(baseAllowance) || 0);
  const bought = Math.max(0, Number(purchased) || 0);

  const spentFromPurchased = Math.max(0, u - base);
  return Math.max(0, bought - spentFromPurchased);
}

module.exports = { purchasedAfterReset };
