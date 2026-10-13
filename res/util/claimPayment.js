/**
 * Claims a payment for fulfilment, so that only ONE of any number of concurrent
 * deliveries goes on to grant what it unlocks.
 *
 * Why a row lock and not `updateMany({ where: { status: { not: "success" } } })`:
 * on MySQL, Prisma runs updateMany as "select the matching ids, then update
 * those ids". Under the default REPEATABLE READ isolation every concurrent
 * transaction selects the row while it is still pending, and each then updates
 * it by id, so each one "wins". Three simultaneous webhook deliveries granted
 * three times. SELECT ... FOR UPDATE is a locking read: the second transaction
 * waits for the first to commit, then reads the committed status.
 *
 * Must be called inside a $transaction, and as its FIRST statement: a plain read
 * before it would pin the transaction to a snapshot that predates the winner's
 * commit.
 *
 * @param {object} tx a Prisma transaction client
 * @param {number} paymentId
 * @param {object} data fields to set on the payment when it is claimed
 * @returns {Promise<boolean>} true if this caller claimed it; false if it was already paid
 */
async function claimPayment(tx, paymentId, data) {
  const rows = await tx.$queryRaw`SELECT status FROM school_payments WHERE id = ${paymentId} FOR UPDATE`;

  if (!rows || rows.length === 0 || rows[0].status === "success") return false;

  await tx.schoolPayment.update({ where: { id: paymentId }, data });
  return true;
}

module.exports = { claimPayment };
