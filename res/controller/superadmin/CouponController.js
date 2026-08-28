const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

/**
 * POST /api/billing/coupons
 * Platform Super Admin creates a launch-campaign coupon: redeeming `code`
 * grants a school `freeDays` free access on `billingPlanId`.
 */
exports.createCoupon = async (req, res, next) => {
  try {
    const { code, billingPlanId, freeDays, maxRedemptions, expiresAt } = req.body;
    const adminId = req.admin?.id;

    if (!code || !billingPlanId) {
      return res.status(400).json({ success: false, message: "code and billingPlanId are required", code: "INVALID_REQUEST" });
    }

    const plan = await prisma.billingPlan.findUnique({ where: { id: billingPlanId } });
    if (!plan) {
      return res.status(404).json({ success: false, message: "Billing plan not found", code: "PLAN_NOT_FOUND" });
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: String(code).trim().toUpperCase(),
        billingPlanId,
        freeDays: freeDays || 30,
        maxRedemptions: maxRedemptions === "" || maxRedemptions == null ? null : maxRedemptions,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdByAdminId: adminId,
      },
    });

    logger.info("[COUPON] Created", { couponId: coupon.id, code: coupon.code, billingPlanId, adminId });
    res.status(201).json({ success: true, message: "Coupon created", data: coupon });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ success: false, message: "A coupon with this code already exists", code: "DUPLICATE_CODE" });
    }
    logger.error("[COUPON] Failed to create", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/billing/coupons
 */
exports.getCoupons = async (req, res, next) => {
  try {
    const coupons = await prisma.coupon.findMany({
      include: { billingPlan: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ success: true, data: coupons });
  } catch (err) {
    logger.error("[COUPON] Failed to list", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/billing/coupons/:id/deactivate
 */
exports.deactivateCoupon = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const coupon = await prisma.coupon.update({ where: { id }, data: { isActive: false } });
    logger.info("[COUPON] Deactivated", { couponId: id });
    res.status(200).json({ success: true, message: "Coupon deactivated", data: coupon });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ success: false, message: "Coupon not found", code: "COUPON_NOT_FOUND" });
    }
    logger.error("[COUPON] Failed to deactivate", { error: err.message });
    next(err);
  }
};
