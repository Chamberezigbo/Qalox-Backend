const prisma = require("./prisma");

/**
 * A simple, sequential-looking receipt number, shared by every path that
 * creates a Payment: admin manually recording one, and a parent/student
 * declaring a bank-transfer payment. Generated once, at creation time — a
 * declared (pending) payment keeps the same number through to approval,
 * rather than getting a new one once confirmed.
 */
async function generateReceiptNo() {
  const count = await prisma.payment.count();
  const year = new Date().getFullYear();
  return `RCP-${year}-${String(count + 1).padStart(4, "0")}`;
}

module.exports = { generateReceiptNo };
