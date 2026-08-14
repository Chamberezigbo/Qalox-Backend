const prisma = require("../util/prisma");
const logger = require("../config/logger");
const flutterwave = require("../Services/FlutterwaveService");

const addBillingCycle = (from, billingCycle) => {
  const d = new Date(from);
  if (billingCycle === "annual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

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

    const school = await prisma.school.findUnique({ where: { id: payment.schoolId } });
    const subscription = payment.subscriptionId
      ? await prisma.schoolSubscription.findUnique({ where: { id: payment.subscriptionId } })
      : null;

    // First-vs-renewal: any OTHER successful payment for this school already exist?
    const priorSuccessCount = await prisma.schoolPayment.count({
      where: { schoolId: payment.schoolId, status: "success", id: { not: payment.id } },
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
      // Admin.commissionRate defaults to 0.0 (not null) at signup, so "> 0"
      // is what actually distinguishes a real per-marketer override from an
      // unset default — a `!= null` check alone would treat every new
      // marketer's default as an explicit 0% override.
      commissionRate = marketer.commissionRate > 0
        ? marketer.commissionRate
        : (isFirstPayment ? settings.firstPaymentCommissionRate : settings.renewalCommissionRate);
      commissionAmount = payment.amount * (commissionRate / 100);
    }

    const now = paidAt;
    const writes = [
      prisma.schoolPayment.update({
        where: { id: payment.id },
        data: { status: "success", isFirstPayment, paidAt, flwChargeId: String(event.data.id) },
      }),
    ];

    if (subscription) {
      writes.push(
        prisma.schoolSubscription.update({
          where: { id: subscription.id },
          data: { status: "active", nextBillingDate },
        })
      );
      writes.push(
        prisma.school.update({
          where: { id: payment.schoolId },
          data: { billingPlanId: subscription.billingPlanId },
        })
      );
    }

    if (marketer) {
      writes.push(
        prisma.commission.create({
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
      writes.push(
        prisma.marketerSchoolLead.update({
          where: { id: marketerLead.id },
          data: {
            totalRevenue: { increment: payment.amount },
            totalCommission: { increment: commissionAmount },
          },
        })
      );
      writes.push(
        prisma.admin.update({
          where: { id: marketer.id },
          data: {
            walletBalance: { increment: commissionAmount },
            totalEarned: { increment: commissionAmount },
            transactionCount: { increment: 1 },
          },
        })
      );
      writes.push(
        prisma.walletTransaction.create({
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

    await prisma.$transaction(writes, { timeout: 20000 });

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
