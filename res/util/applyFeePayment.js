const logger = require("../config/logger");

/**
 * The ONE place a successful payment is added to a student's fee invoice, so an admin approving
 * a bank transfer and an online payment landing can never disagree about the balance.
 */

const computeStatus = (totalFee, amountPaid) => {
  if (amountPaid <= 0) return "unpaid";
  if (amountPaid >= totalFee) return "paid";
  return "partial";
};

/**
 * Claims a payment for confirmation so that only ONE of any number of concurrent attempts
 * (a double webhook, the webhook racing the return page, two admins clicking Approve) goes on to
 * credit it. The row is locked first; whoever finds it already "success" has lost.
 *
 * Must be the first statement of an interactive $transaction (see util/claimPayment.js for why).
 * @param {object} tx a Prisma transaction client
 * @param {number} paymentId
 * @param {{ onlyPending?: boolean }} [options] onlyPending: a payment already "failed" cannot be claimed
 *        (an admin approving a declared transfer must not resurrect one an admin rejected). Online payments
 *        can: money that arrives after we marked a payment failed is still the school's money.
 * @returns {Promise<boolean>} true if this caller now owns the confirmation
 */
async function claimFeePayment(tx, paymentId, { onlyPending = false } = {}) {
  const rows = await tx.$queryRaw`SELECT status FROM payments WHERE id = ${paymentId} FOR UPDATE`;
  if (!rows || rows.length === 0) return false;
  const status = rows[0].status;
  if (status === "success") return false;
  if (onlyPending && status !== "pending") return false;
  return true;
}

/**
 * Adds `amount` to the invoice and refreshes its status. The invoice row is locked while it is
 * read, so two payments landing together add up instead of one overwriting the other.
 * @param {object} tx a Prisma transaction client
 * @returns {Promise<{ amountPaid: number, status: string, overpaid: number }>}
 */
async function applyFeePayment(tx, studentFeeId, amount) {
  const rows = await tx.$queryRaw`SELECT totalFee, amountPaid FROM student_fees WHERE id = ${studentFeeId} FOR UPDATE`;
  if (!rows || rows.length === 0) throw new Error(`Fee record ${studentFeeId} not found`);

  const totalFee = Number(rows[0].totalFee);
  const amountPaid = Number(rows[0].amountPaid) + amount;
  const status = computeStatus(totalFee, amountPaid);
  await tx.studentFee.update({ where: { id: studentFeeId }, data: { amountPaid, status } });

  // Money that arrived is credited in full even if it overshoots (an admin recorded cash while an
  // online payment was in flight); the surplus is reported so a person can follow it up.
  const overpaid = Math.max(0, Math.round((amountPaid - totalFee) * 100) / 100);
  if (overpaid > 0) logger.warn("[FEE_PAYMENT] Invoice overpaid", { studentFeeId, totalFee, amountPaid, overpaid });
  return { amountPaid, status, overpaid };
}

module.exports = { computeStatus, claimFeePayment, applyFeePayment };
