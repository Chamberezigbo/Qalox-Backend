const prisma = require("../util/prisma");
const logger = require("../config/logger");
const flutterwave = require("../Services/FlutterwaveService");
const { createNotification } = require("../util/notify");
const { claimPayment } = require("../util/claimPayment");

const addBillingCycle = (from, billingCycle) => {
  const d = new Date(from);
  if (billingCycle === "annual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

/**
 * Fulfils a paid AI credit pack. Called only after the signature, the event and
 * Flutterwave's own verification have all passed.
 *
 * The payment is claimed and the credits added in one transaction, and the claim
 * only succeeds while the payment is not yet "success". So a webhook delivered
 * twice, or two at once, grants the credits exactly once.
 */
async function handleCreditPackPayment({ payment, reference, transactionId, res }) {
  const credits = Number(payment.creditsGranted);
  if (!Number.isInteger(credits) || credits <= 0) {
    logger.error("[FLW_WEBHOOK] Credit pack payment has no credits to grant", { reference, creditsGranted: payment.creditsGranted });
    return res.status(200).json({ success: true, message: "Nothing to grant" });
  }

  const granted = await prisma.$transaction(
    async (tx) => {
      const claimed = await claimPayment(tx, payment.id, {
        status: "success",
        paidAt: new Date(),
        flwChargeId: String(transactionId),
      });
      if (!claimed) return false;

      await tx.school.update({
        where: { id: payment.schoolId },
        data: { aiCreditsPurchased: { increment: credits } },
      });
      return true;
    },
    { timeout: 20000 }
  );

  if (!granted) {
    logger.info("[FLW_WEBHOOK] Credit pack already granted — ignoring duplicate", { reference });
    return res.status(200).json({ success: true, message: "Already processed" });
  }

  // Tell the school's head admins. After the grant, and never able to undo it.
  try {
    const admins = await prisma.admin.findMany({
      where: { schoolId: payment.schoolId, role: { in: ["school_admin", "super_admin"] } },
      select: { id: true },
    });
    for (const admin of admins) {
      await createNotification({
        recipientType: "admin",
        recipientId: admin.id,
        schoolId: payment.schoolId,
        title: "AI credits added",
        message: `${credits.toLocaleString("en-NG")} AI credits have been added to your school.`,
        type: "success",
        link: "/admin/billing",
      });
    }
  } catch (error) {
    logger.error("[FLW_WEBHOOK] Credit pack notification failed (credits unaffected)", { reference, error: error.message });
  }

  logger.info("[FLW_WEBHOOK] Credit pack granted", { reference, schoolId: payment.schoolId, credits });
  return res.status(200).json({ success: true, message: "Webhook processed" });
}

/**
 * POST /api/webhooks/flutterwave
 *
 * Verifies the `verif-hash` header (plain string match against
 * FLW_SECRET_HASH — v3's scheme, not HMAC), re-verifies the transaction
 * server-side via GET /transactions/:id/verify (per Flutterwave's own
 * recommendation — never trust the webhook body alone), then on a
 * successful charge: marks the SchoolPayment paid, activates/renews the
 * SchoolSubscription, and — if the school has an attributed marketer via
 * MarketerSchoolLead.schoolId — creates the Commission row and credits the
 * marketer's wallet at the two-tier rate (first payment vs. renewal).
 */
exports.handleFlutterwaveWebhook = async (req, res, next) => {
  try {
    const signature = req.headers["verif-hash"];
    const valid = flutterwave.verifyWebhookSignature(signature);

    if (!valid) {
      logger.warn("[FLW_WEBHOOK] Invalid signature — rejecting");
      return res.status(401).json({ success: false, message: "Invalid signature" });
    }

    const event = req.body;

    if (event.event !== "charge.completed" || event.data?.status !== "successful") {
      logger.debug("[FLW_WEBHOOK] Ignoring non-success event", { event: event.event, status: event.data?.status });
      return res.status(200).json({ success: true, message: "Event acknowledged" });
    }

    const reference = event.data.tx_ref;

    const payment = await prisma.schoolPayment.findUnique({ where: { flwReference: reference } });

    if (!payment) {
      logger.warn("[FLW_WEBHOOK] No SchoolPayment found for reference", { reference });
      return res.status(200).json({ success: true, message: "No matching payment record" });
    }

    if (payment.status === "success") {
      logger.info("[FLW_WEBHOOK] Payment already processed — ignoring duplicate webhook", { reference });
      return res.status(200).json({ success: true, message: "Already processed" });
    }

    // Re-verify server-side before granting any value — the webhook body alone is not trusted.
    // A failed lookup (unknown/invalid transaction id) is an expected outcome here, not a
    // server error — acknowledge with 200 so Flutterwave doesn't retry-storm us over it.
    let verified;
    try {
      verified = await flutterwave.verifyTransaction(event.data.id);
    } catch (verifyErr) {
      logger.warn("[FLW_WEBHOOK] Verification lookup failed — refusing to credit", {
        reference, transactionId: event.data.id, error: verifyErr.message,
      });
      return res.status(200).json({ success: true, message: "Verification lookup failed, not processed" });
    }

    if (verified.status !== "successful" || verified.tx_ref !== reference || Number(verified.amount) < payment.amount) {
      logger.warn("[FLW_WEBHOOK] Verification mismatch — refusing to credit", {
        reference, verifiedStatus: verified.status, verifiedAmount: verified.amount, expectedAmount: payment.amount,
      });
      return res.status(200).json({ success: true, message: "Verification failed, not processed" });
    }

    // Everything is priced in naira. A charge in another currency whose number
    // happens to be large enough must not unlock anything.
    if (verified.currency && verified.currency !== "NGN") {
      logger.warn("[FLW_WEBHOOK] Unexpected currency — refusing to credit", { reference, currency: verified.currency });
      return res.status(200).json({ success: true, message: "Currency mismatch, not processed" });
    }

    // A credit pack adds AI credits and nothing else: no subscription change, no
    // marketer commission and no effect on first-vs-renewal.
    if (payment.purpose === "credit_pack") {
      return handleCreditPackPayment({ payment, reference, transactionId: event.data.id, res });
    }

    const school = await prisma.school.findUnique({ where: { id: payment.schoolId } });
    const subscription = payment.subscriptionId
      ? await prisma.schoolSubscription.findUnique({ where: { id: payment.subscriptionId } })
      : null;

    // First-vs-renewal: any OTHER successful payment for this school already exist?
    const priorSuccessCount = await prisma.schoolPayment.count({
      where: { schoolId: payment.schoolId, status: "success", purpose: "subscription", id: { not: payment.id } },
    });
    const isFirstPayment = priorSuccessCount === 0;

    const paidAt = new Date();
    const nextBillingDate = subscription ? addBillingCycle(paidAt, subscription.billingCycle) : null;

    let settings = await prisma.platformSettings.findFirst();
    if (!settings) settings = await prisma.platformSettings.create({ data: {} });

    const marketerLead = await prisma.marketerSchoolLead.findUnique({ where: { schoolId: payment.schoolId } });
    const marketer = marketerLead
      ? await prisma.admin.findUnique({ where: { id: marketerLead.marketerId } })
      : null;

    let commissionRate = null;
    let commissionAmount = 0;
    if (marketer) {
      const customRate = isFirstPayment
        ? marketer.newSchoolCommissionRate ?? null
        : marketer.renewalCommissionRate ?? null;

      const legacyOverride = marketer.commissionRate > 0 ? marketer.commissionRate : null;
      const defaultRate = isFirstPayment
        ? settings.firstPaymentCommissionRate ?? settings.commissionRate ?? 0
        : settings.renewalCommissionRate ?? settings.commissionRate ?? 0;

      commissionRate = customRate ?? legacyOverride ?? defaultRate;
      commissionAmount = payment.amount * (commissionRate / 100);
    }

    const now = paidAt;
    // Each operation runs against the transaction client, after the payment has
    // been claimed (see below).
    const ops = [];

    if (subscription) {
      ops.push((tx) =>
        tx.schoolSubscription.update({
          where: { id: subscription.id },
          data: { status: "active", nextBillingDate },
        })
      );
      ops.push((tx) =>
        tx.school.update({
          where: { id: payment.schoolId },
          data: { billingPlanId: subscription.billingPlanId },
        })
      );
    }

    if (marketer) {
      ops.push((tx) =>
        tx.commission.create({
          data: {
            marketerId: marketer.id,
            schoolId: payment.schoolId,
            amount: commissionAmount,
            rate: commissionRate,
            status: "paid",
            month: now.getMonth() + 1,
            year: now.getFullYear(),
            source: isFirstPayment ? "First Payment" : "Renewal",
            description: `Commission for ${school?.name ?? "school"} payment (${reference})`,
          },
        })
      );
      ops.push((tx) =>
        tx.marketerSchoolLead.update({
          where: { id: marketerLead.id },
          data: {
            totalRevenue: { increment: payment.amount },
            totalCommission: { increment: commissionAmount },
          },
        })
      );
      ops.push((tx) =>
        tx.admin.update({
          where: { id: marketer.id },
          data: {
            walletBalance: { increment: commissionAmount },
            totalEarned: { increment: commissionAmount },
            transactionCount: { increment: 1 },
          },
        })
      );
      ops.push((tx) =>
        tx.walletTransaction.create({
          data: {
            marketerId: marketer.id,
            type: "credit",
            amount: commissionAmount,
            description: `${isFirstPayment ? "First payment" : "Renewal"} commission — ${school?.name ?? "school"}`,
            balanceAfter: (marketer.walletBalance || 0) + commissionAmount,
          },
        })
      );
    }

    // The payment is claimed and everything it unlocks is written in ONE
    // transaction. The claim only succeeds for a payment that is not already
    // "success", so two deliveries of the same webhook arriving together cannot
    // both pass: the loser claims nothing, writes nothing and pays no commission.
    const processed = await prisma.$transaction(
      async (tx) => {
        const claimed = await claimPayment(tx, payment.id, {
          status: "success",
          isFirstPayment,
          paidAt,
          flwChargeId: String(event.data.id),
        });
        if (!claimed) return false;

        for (const op of ops) await op(tx);
        return true;
      },
      { timeout: 20000 }
    );

    if (!processed) {
      logger.info("[FLW_WEBHOOK] Payment was processed by a concurrent delivery — ignoring", { reference });
      return res.status(200).json({ success: true, message: "Already processed" });
    }

    // Tell the marketer they've been paid. Deliberately OUTSIDE the transaction
    // above and swallowed on failure: the money is already credited at this
    // point, and a notification is a courtesy. It must never roll back a
    // payment or turn a successful charge into a 500 that Flutterwave retries.
    if (marketer) {
      try {
        await prisma.notification.create({
          data: {
            marketerId: marketer.id,
            title: isFirstPayment ? "New commission earned" : "Renewal commission earned",
            message: `You earned ₦${commissionAmount.toLocaleString("en-NG", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} from ${school?.name ?? "a school"}.`,
            type: "success",
            link: "/commissions",
            relatedType: "commission",
          },
        });
      } catch (notifyErr) {
        logger.error("[FLW_WEBHOOK] Commission notification failed (payment unaffected)", {
          reference, marketerId: marketer.id, error: notifyErr.message,
        });
      }
    }

    logger.info("[FLW_WEBHOOK] Payment processed", {
      reference, schoolId: payment.schoolId, isFirstPayment, marketerId: marketer?.id, commissionAmount,
    });

    res.status(200).json({ success: true, message: "Webhook processed" });
  } catch (err) {
    logger.error("[FLW_WEBHOOK] Failed to process webhook", { error: err.message });
    next(err);
  }
};
