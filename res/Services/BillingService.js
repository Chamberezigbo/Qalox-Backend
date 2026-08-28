const crypto = require("crypto");
const prisma = require("../util/prisma");
const logger = require("../config/logger");
const flutterwave = require("./FlutterwaveService");

// Flutterwave's v3 API throws a misleading "decrypt" error on non-ASCII
// characters (confirmed live — an em-dash alone was enough to trigger it).
// Strip anything outside printable ASCII from fields we send them.
const toAscii = (str) => String(str).replace(/[^\x20-\x7E]/g, "").trim();

/**
 * Creates a Flutterwave bank-transfer charge for a school + plan + cycle, and
 * upserts the SchoolSubscription ("past_due" until the webhook confirms) and
 * a "pending" SchoolPayment. Shared by the Super Admin-initiated flow and the
 * school admin self-service flow — identical behavior either way, since the
 * webhook that confirms payment operates generically on schoolId/subscriptionId.
 * @returns {Promise<{success: boolean, code?: string, message?: string, data?: object}>}
 */
async function initializePaymentForSchool({ schoolId, billingPlanId, billingCycle }) {
  if (!schoolId || !billingPlanId || !["monthly", "annual"].includes(billingCycle)) {
    return {
      success: false,
      code: "INVALID_REQUEST",
      message: "schoolId, billingPlanId and billingCycle ('monthly'|'annual') are required",
    };
  }

  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    include: { admins: { take: 1, select: { name: true, email: true, phone: true } } },
  });
  if (!school) {
    return { success: false, code: "SCHOOL_NOT_FOUND", message: "School not found" };
  }

  const plan = await prisma.billingPlan.findUnique({ where: { id: billingPlanId } });
  if (!plan || !plan.isActive) {
    return { success: false, code: "PLAN_NOT_FOUND", message: "Billing plan not found" };
  }

  const amount = billingCycle === "annual" ? plan.annualPrice : plan.monthlyPrice;
  if (!amount || amount <= 0) {
    return {
      success: false,
      code: "INVALID_PLAN_PRICE",
      message: `Plan has no price configured for the '${billingCycle}' cycle`,
    };
  }

  const email = school.email || school.admins[0]?.email;
  if (!email) {
    return {
      success: false,
      code: "MISSING_SCHOOL_EMAIL",
      message: "School has no email on file — required to initiate a Flutterwave charge",
    };
  }

  const reference = `qalox-${schoolId}-${crypto.randomUUID().slice(0, 8)}`;
  const charge = await flutterwave.createBankTransferCharge({
    amount,
    email,
    fullname: toAscii(school.admins[0]?.name || school.name),
    phoneNumber: school.phoneNumber || school.admins[0]?.phone || undefined,
    reference,
    narration: toAscii(`Qalox ${plan.name} (${billingCycle}) - ${school.name}`),
  });

  let subscription = await prisma.schoolSubscription.findFirst({
    where: { schoolId },
    orderBy: { createdAt: "desc" },
  });

  if (subscription) {
    subscription = await prisma.schoolSubscription.update({
      where: { id: subscription.id },
      data: { billingPlanId, billingCycle, status: "past_due" },
    });
  } else {
    subscription = await prisma.schoolSubscription.create({
      data: { schoolId, billingPlanId, billingCycle, status: "past_due" },
    });
  }

  await prisma.schoolPayment.create({
    data: {
      schoolId,
      subscriptionId: subscription.id,
      amount,
      flwReference: reference,
      flwChargeId: charge.transferReference,
      status: "pending",
    },
  });

  logger.info("[BILLING] Payment initialized", { schoolId, billingPlanId, billingCycle, reference });

  return {
    success: true,
    data: {
      reference,
      amount,
      currency: "NGN",
      bankTransfer: charge.bankTransfer,
    },
  };
}

/**
 * Grants a school a free trial on a plan for durationDays — no payment
 * involved. Shared by the Super Admin direct-grant flow (startTrial) and
 * coupon redemption; trialGrantedByAdminId is left null for coupon-sourced
 * trials (there's no admin action to attribute). Pass `client` (a
 * $transaction callback's tx) to run this as part of a larger transaction —
 * e.g. coupon redemption also increments the coupon's redemption counter and
 * records the redemption atomically alongside this.
 */
async function grantTrial({ schoolId, billingPlanId, durationDays, trialGrantedByAdminId = null, client = prisma }) {
  const trialEndsAt = new Date(Date.now() + (durationDays || 90) * 24 * 60 * 60 * 1000);

  let subscription = await client.schoolSubscription.findFirst({
    where: { schoolId },
    orderBy: { createdAt: "desc" },
  });

  if (subscription) {
    subscription = await client.schoolSubscription.update({
      where: { id: subscription.id },
      data: { billingPlanId, status: "trial", trialEndsAt, trialGrantedByAdminId },
    });
  } else {
    subscription = await client.schoolSubscription.create({
      data: {
        schoolId,
        billingPlanId,
        billingCycle: "monthly",
        status: "trial",
        trialEndsAt,
        trialGrantedByAdminId,
      },
    });
  }

  logger.info("[BILLING] Trial granted", { schoolId, billingPlanId, trialEndsAt, trialGrantedByAdminId });

  return subscription;
}

module.exports = { initializePaymentForSchool, grantTrial };
