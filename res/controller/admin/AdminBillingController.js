const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { parsePlanFeatures } = require("../../util/planFeatures");
const { getActivePlanForSchool } = require("../../util/getActivePlanForSchool");
const { getSchoolLockStatus } = require("../../util/getSchoolLockStatus");
const billingService = require("../../Services/BillingService");

/**
 * GET /api/admin/billing/plans
 * List active plans a school admin can self-serve into.
 */
exports.getAvailablePlans = async (req, res, next) => {
  try {
    const plans = await prisma.billingPlan.findMany({
      where: { isActive: true },
      orderBy: [{ highlighted: "desc" }, { monthlyPrice: "asc" }],
    });

    res.status(200).json({
      success: true,
      data: plans.map((plan) => ({ ...plan, features: parsePlanFeatures(plan.features) })),
    });
  } catch (err) {
    logger.error("[ADMIN_BILLING] Failed to fetch plans", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/billing/status
 * The requesting admin's school's current plan/subscription/lock state —
 * powers the dashboard's payment-lock banner.
 */
exports.getMyBillingStatus = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;

    const [subscription, plan, lockStatus] = await Promise.all([
      prisma.schoolSubscription.findFirst({ where: { schoolId }, orderBy: { createdAt: "desc" } }),
      getActivePlanForSchool(schoolId),
      getSchoolLockStatus(schoolId),
    ]);

    res.status(200).json({
      success: true,
      data: {
        plan: plan ? { ...plan, features: parsePlanFeatures(plan.features) } : null,
        subscriptionStatus: subscription?.status ?? null,
        trialEndsAt: subscription?.status === "trial" ? subscription.trialEndsAt : null,
        locked: lockStatus.locked,
        graceEndsAt: lockStatus.graceEndsAt,
      },
    });
  } catch (err) {
    logger.error("[ADMIN_BILLING] Failed to fetch billing status", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/billing/select-plan
 * School admin self-service: pick a plan + cycle, get a Flutterwave bank
 * transfer to pay into. Same underlying flow as the Super Admin-initiated
 * one, just scoped to the requesting admin's own school.
 */
exports.selectPlan = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { billingPlanId, billingCycle } = req.body;

    const result = await billingService.initializePaymentForSchool({ schoolId, billingPlanId, billingCycle });

    if (!result.success) {
      const statusByCode = { INVALID_REQUEST: 400, SCHOOL_NOT_FOUND: 404, PLAN_NOT_FOUND: 404, INVALID_PLAN_PRICE: 400, MISSING_SCHOOL_EMAIL: 400 };
      return res.status(statusByCode[result.code] || 400).json(result);
    }

    logger.info("[ADMIN_BILLING] Self-service payment initialized", { schoolId, billingPlanId, billingCycle });
    res.status(201).json({ success: true, message: "Payment initialized", data: result.data });
  } catch (err) {
    logger.error("[ADMIN_BILLING] Failed to initialize self-service payment", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/billing/redeem-coupon
 * School admin redeems a launch-campaign coupon code for N free days on the
 * coupon's plan. One redemption per school, ever; blocked if the school
 * already has a paid ("active") subscription, to prevent using a coupon to
 * downgrade off a paid plan.
 */
exports.redeemCoupon = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { code } = req.body;

    if (!code || typeof code !== "string") {
      return res.status(400).json({ success: false, message: "code is required", code: "INVALID_REQUEST" });
    }

    const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || !coupon.isActive) {
      return res.status(404).json({ success: false, message: "Coupon not found or inactive", code: "COUPON_NOT_FOUND" });
    }
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: "This coupon has expired", code: "COUPON_EXPIRED" });
    }
    if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) {
      return res.status(400).json({ success: false, message: "This coupon has reached its redemption limit", code: "COUPON_EXHAUSTED" });
    }

    const alreadyRedeemed = await prisma.couponRedemption.findUnique({ where: { schoolId } });
    if (alreadyRedeemed) {
      return res.status(400).json({ success: false, message: "This school has already redeemed a coupon", code: "ALREADY_REDEEMED" });
    }

    const existingSubscription = await prisma.schoolSubscription.findFirst({ where: { schoolId }, orderBy: { createdAt: "desc" } });
    if (existingSubscription?.status === "active") {
      return res.status(400).json({ success: false, message: "This school already has a paid plan — a coupon can't replace it", code: "ALREADY_PAID" });
    }

    const subscription = await prisma.$transaction(async (tx) => {
      const sub = await billingService.grantTrial({
        schoolId,
        billingPlanId: coupon.billingPlanId,
        durationDays: coupon.freeDays,
        client: tx,
      });
      await tx.coupon.update({ where: { id: coupon.id }, data: { redemptionCount: { increment: 1 } } });
      await tx.couponRedemption.create({ data: { couponId: coupon.id, schoolId } });
      return sub;
    });

    logger.info("[ADMIN_BILLING] Coupon redeemed", { schoolId, couponCode: coupon.code, billingPlanId: coupon.billingPlanId });

    res.status(200).json({
      success: true,
      message: `Coupon redeemed — free access until ${subscription.trialEndsAt.toISOString().slice(0, 10)}`,
      data: { billingPlanId: coupon.billingPlanId, trialEndsAt: subscription.trialEndsAt },
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(400).json({ success: false, message: "This school has already redeemed a coupon", code: "ALREADY_REDEEMED" });
    }
    logger.error("[ADMIN_BILLING] Failed to redeem coupon", { error: err.message });
    next(err);
  }
};
