const crypto = require("crypto");
const prisma = require("../util/prisma");
const logger = require("../config/logger");
const flutterwave = require("./FlutterwaveService");
const { AppError } = require("../util/AppError");
const { createNotification } = require("../util/notify");
const { generateReceiptNo } = require("../util/receiptNo");
const { serviceChargeRate, computeBreakdown, amountProblem } = require("../util/feeCharge");
const { claimFeePayment, applyFeePayment } = require("../util/applyFeePayment");

/**
 * In-app school fee payment.
 *
 * A school that chooses "in_app" has parents (and students) pay inside Qalox. The payment goes
 * through Flutterwave's hosted checkout with a split: the school's settlement account (a
 * Flutterwave "subaccount") receives exactly the fee, and Qalox keeps the service charge the payer
 * paid on top. Nothing is credited to the invoice until Flutterwave itself confirms the payment.
 */

const MODES = ["direct", "in_app"];
const PORTAL = () => (process.env.SCHOOL_PORTAL_URL || "").replace(/\/+$/, "");
const FALLBACK_EMAIL = () => process.env.FEE_PAYER_FALLBACK_EMAIL || "payments@qalox.net";
// A payment nobody finished is closed after this long. Money that still arrives for it is credited anyway.
const ABANDONED_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

async function getSettings(schoolId) {
  return (await prisma.schoolFeeSettings.findUnique({ where: { schoolId } })) ?? { schoolId, mode: "direct", flwSubaccountId: null, settlementBankAccountId: null, serviceChargePercent: null };
}

/** What a screen needs to know about how this school collects fees. */
async function getCollection(schoolId) {
  const settings = await getSettings(schoolId);
  const settlement = settings.settlementBankAccountId
    ? await prisma.schoolBankAccount.findFirst({
        where: { id: settings.settlementBankAccountId, schoolId },
        select: { id: true, bankName: true, accountName: true, accountNumber: true },
      })
    : null;
  return {
    mode: settings.mode,
    ready: settings.mode === "in_app" && !!settings.flwSubaccountId,
    serviceChargePercent: serviceChargeRate(settings),
    settlementAccount: settlement,
  };
}

/** Switches how the school collects fees. Going to in_app needs a verified settlement account. */
async function setCollection({ schoolId, mode, settlementBankAccountId }) {
  if (!MODES.includes(mode)) throw new AppError('mode must be "direct" or "in_app"', 400);
  const current = await getSettings(schoolId);

  if (mode === "direct") {
    await prisma.schoolFeeSettings.upsert({ where: { schoolId }, create: { schoolId, mode }, update: { mode } });
    return getCollection(schoolId);
  }

  const chosen = settlementBankAccountId ?? current.settlementBankAccountId;
  const accountId = chosen == null ? NaN : Number(chosen); // null is "not chosen", not account 0
  if (!Number.isInteger(accountId)) throw new AppError("Choose the bank account your fees should be paid into", 400);
  const account = await prisma.schoolBankAccount.findFirst({ where: { id: accountId, schoolId, isActive: true } });
  if (!account) throw new AppError("That bank account was not found", 404);
  if (!account.bankCode) {
    throw new AppError("This bank account was saved without choosing its bank. Edit it, pick the bank from the list, and try again.", 400);
  }

  // Reuse the subaccount when the same account is already set up; otherwise make one for this account.
  let subaccountId = current.settlementBankAccountId === accountId ? current.flwSubaccountId : null;
  if (!subaccountId) {
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, email: true, phoneNumber: true } });
    try {
      ({ subaccountId } = await flutterwave.createSubaccount({
        bankCode: account.bankCode,
        accountNumber: account.accountNumber,
        businessName: school?.name || account.accountName,
        email: school?.email || undefined,
        phoneNumber: school?.phoneNumber || undefined,
      }));
    } catch (error) {
      logger.warn("[IN_APP_FEES] Could not create subaccount", { schoolId, reason: error.message });
      throw new AppError(`We could not set up this account with our payment partner: ${error.message}`, 502);
    }
  }

  await prisma.schoolFeeSettings.upsert({
    where: { schoolId },
    create: { schoolId, mode, settlementBankAccountId: accountId, flwSubaccountId: subaccountId },
    update: { mode, settlementBankAccountId: accountId, flwSubaccountId: subaccountId },
  });
  return getCollection(schoolId);
}

/**
 * The settlement account's details changed or it was removed. The Flutterwave subaccount still points at
 * the OLD account number, so keeping in_app on would send school money there. Fall back to direct payments.
 * @returns {Promise<boolean>} true when the school was switched back
 */
async function settlementAccountChanged(schoolId, bankAccountId) {
  const settings = await prisma.schoolFeeSettings.findUnique({ where: { schoolId } });
  if (!settings || settings.settlementBankAccountId !== Number(bankAccountId)) return false;
  await prisma.schoolFeeSettings.update({
    where: { schoolId },
    data: { mode: "direct", flwSubaccountId: null, settlementBankAccountId: null },
  });
  logger.warn("[IN_APP_FEES] Settlement account changed; school switched back to direct payments", { schoolId, bankAccountId });
  return true;
}

/**
 * Starts an online payment for one invoice. Creates the pending Payment and the hosted checkout.
 * @param {{ schoolId: number, studentFeeId: number, studentId: number, amount: number, area: "parent" | "student",
 *           payer: { type: "parent" | "student", id: number, name?: string, email?: string | null, phone?: string | null } }} input
 */
async function startPayment({ schoolId, studentFeeId, studentId, amount, area, payer }) {
  const settings = await getSettings(schoolId);
  if (settings.mode !== "in_app" || !settings.flwSubaccountId) {
    throw new AppError("This school does not accept in-app payments", 409);
  }

  const studentFee = await prisma.studentFee.findFirst({
    where: { id: studentFeeId, studentId, schoolId },
    include: { student: { select: { name: true, surname: true, guardianEmail: true } }, feeStructure: { select: { term: true, session: true, title: true } } },
  });
  if (!studentFee) throw new AppError("Fee record not found", 404);

  const problem = amountProblem(amount, studentFee.totalFee - studentFee.amountPaid);
  if (problem) throw new AppError(problem, 400);

  const breakdown = computeBreakdown(amount, serviceChargeRate(settings));
  const reference = `FEE-${studentFeeId}-${crypto.randomBytes(6).toString("hex")}`;

  const payment = await createPendingPayment({
    studentFeeId,
    amount: breakdown.fee,
    serviceCharge: breakdown.serviceCharge,
    chargedAmount: breakdown.total,
    reference,
    payer,
  });

  const studentName = `${studentFee.student.name} ${studentFee.student.surname}`;
  try {
    const { checkoutUrl } = await flutterwave.createStandardCheckout({
      amount: breakdown.total,
      email: payer.email || studentFee.student.guardianEmail || FALLBACK_EMAIL(),
      fullname: payer.name || studentName,
      phoneNumber: payer.phone || undefined,
      reference,
      redirectUrl: `${PORTAL()}/${area}/fees/payment-result?ref=${reference}`,
      title: "School fees",
      description: `${studentFee.feeStructure.title}, ${studentFee.feeStructure.term} ${studentFee.feeStructure.session}, for ${studentName}`,
      // The school receives exactly the fee; the service charge stays with Qalox.
      subaccounts: [{ id: settings.flwSubaccountId, transaction_charge_type: "flat_subaccount", transaction_charge: breakdown.fee }],
      meta: { studentFeeId, paymentId: payment.id },
    });
    if (!checkoutUrl) throw new Error("No checkout link returned");
    return { reference, checkoutUrl, breakdown, receiptNo: payment.receiptNo };
  } catch (error) {
    try {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "failed", rejectionReason: "Could not start checkout" } });
    } catch (updateError) {
      logger.warn("[IN_APP_FEES] Could not close the failed payment", { reference, reason: updateError.message });
    }
    logger.error("[IN_APP_FEES] Checkout could not be created", { reference, reason: error.message });
    throw new AppError("We could not start the payment. Please try again in a moment.", 502);
  }
}

/** Receipt numbers are sequential, so two payments created together can collide; retry with a suffix. */
async function createPendingPayment({ studentFeeId, amount, serviceCharge, chargedAmount, reference, payer }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const base = await generateReceiptNo();
    const receiptNo = attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    try {
      return await prisma.payment.create({
        data: {
          studentFeeId, amount, serviceCharge, chargedAmount, receiptNo,
          paymentMethod: "Online (Qalox)", channel: "in_app", status: "pending", flwReference: reference,
          payerType: payer.type, payerId: payer.id,
        },
      });
    } catch (error) {
      if (error.code !== "P2002" || attempt === 3) throw error;
    }
  }
  throw new AppError("Could not create the payment", 500);
}

/**
 * Settles a payment from what Flutterwave itself says about it. Safe to call any number of times and
 * from any number of places at once (the webhook, the page the payer returns to): the invoice is
 * credited exactly once.
 * @param {string} reference our reference (tx_ref)
 * @param {{ transactionId?: string | number }} [options] the Flutterwave id when the webhook gave one
 * @returns {Promise<{ status: "success" | "pending" | "failed" | "unknown", payment?: object }>}
 */
async function fulfil(reference, { transactionId } = {}) {
  const payment = await prisma.payment.findUnique({ where: { flwReference: reference }, include: { studentFee: { select: { schoolId: true, studentId: true } } } });
  if (!payment || payment.channel !== "in_app") return { status: "unknown" };
  if (payment.status === "success") return { status: "success", payment };

  let verified;
  try {
    verified = transactionId ? await flutterwave.verifyTransaction(transactionId) : await flutterwave.verifyByReference(reference);
  } catch (error) {
    // Could not ask Flutterwave: say nothing is decided, never guess.
    logger.warn("[IN_APP_FEES] Could not verify payment", { reference, reason: error.message });
    return { status: "pending", payment };
  }
  if (!verified) return { status: "pending", payment };

  if (verified.tx_ref !== reference) {
    logger.error("[IN_APP_FEES] Reference mismatch; not crediting", { reference, got: verified.tx_ref });
    return { status: "pending", payment };
  }

  if (verified.status === "successful") {
    const paidEnough = Number(verified.amount) + 0.0001 >= Number(payment.chargedAmount);
    if (verified.currency !== "NGN" || !paidEnough) {
      logger.error("[IN_APP_FEES] Paid amount or currency does not match; not crediting", {
        reference, expected: payment.chargedAmount, got: verified.amount, currency: verified.currency,
      });
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "failed", rejectionReason: "The amount paid did not match" } });
      return { status: "failed", payment };
    }
    return creditPayment(payment, verified);
  }

  if (["failed", "cancelled"].includes(verified.status)) {
    await prisma.payment.updateMany({ where: { id: payment.id, status: "pending" }, data: { status: "failed", rejectionReason: "Payment was not completed" } });
    return { status: "failed", payment };
  }
  return { status: "pending", payment };
}

async function creditPayment(payment, verified) {
  const result = await prisma.$transaction(
    async (tx) => {
      if (!(await claimFeePayment(tx, payment.id))) return null;
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "success", paymentDate: new Date(), flwTransactionId: String(verified.id), rejectionReason: null },
      });
      return applyFeePayment(tx, payment.studentFeeId, payment.amount);
    },
    { timeout: 20000 }
  );

  const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
  if (!result) return { status: "success", payment: fresh }; // someone else already credited it

  logger.info("[IN_APP_FEES] Payment credited", { reference: payment.flwReference, paymentId: payment.id, amount: payment.amount });
  await notifyPaid(payment).catch((error) => logger.error("[IN_APP_FEES] Notification failed (payment unaffected)", { reason: error.message }));
  return { status: "success", payment: fresh };
}

async function notifyPaid(payment) {
  const fee = await prisma.studentFee.findUnique({
    where: { id: payment.studentFeeId },
    select: { schoolId: true, studentId: true, student: { select: { name: true, surname: true } } },
  });
  if (!fee) return;
  const naira = (n) => `₦${Number(n).toLocaleString("en-NG")}`;
  const who = `${fee.student.name} ${fee.student.surname}`;

  const admins = await prisma.admin.findMany({ where: { schoolId: fee.schoolId, role: { in: ["school_admin", "super_admin"] } }, select: { id: true } });
  for (const admin of admins) {
    await createNotification({
      recipientType: "admin", recipientId: admin.id, schoolId: fee.schoolId,
      title: "Fee payment received",
      message: `${naira(payment.amount)} was paid online for ${who} (receipt ${payment.receiptNo}).`,
      type: "success", link: "/admin/fee-management",
    });
  }
  if (payment.payerType === "student") {
    await createNotification({
      recipientType: "student", recipientId: fee.studentId, schoolId: fee.schoolId,
      title: "Payment received",
      message: `Your payment of ${naira(payment.amount)} was received (receipt ${payment.receiptNo}).`,
      type: "success", link: "/student/pay-school-fee",
    });
  }
}

/** Closes online payments nobody finished. Run daily. A late success for one is still credited. */
async function expireAbandoned() {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);
  const { count } = await prisma.payment.updateMany({
    where: { channel: "in_app", status: "pending", createdAt: { lt: cutoff } },
    data: { status: "failed", rejectionReason: "Not completed" },
  });
  if (count > 0) logger.info(`[IN_APP_FEES] Closed ${count} unfinished online payment(s)`);
  return count;
}

module.exports = { getSettings, getCollection, setCollection, settlementAccountChanged, startPayment, fulfil, expireAbandoned, MODES };
