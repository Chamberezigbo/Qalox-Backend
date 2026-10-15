/**
 * How many bought or granted credits can be taken back from a school.
 *
 * Bounded by the bought balance (the plan's own allowance is not Super Admin's
 * to take away here) and by what is still unspent, so the school is never left
 * with more used than allowed.
 *
 * @param {{ base: number, purchased: number, used: number }} position
 * @returns {number} a whole number, never negative
 */
function maxTakeBack({ base, purchased, used }) {
  const unspent = Math.max(0, base + purchased - used);
  return Math.max(0, Math.min(purchased, unspent));
}

module.exports = { maxTakeBack };
