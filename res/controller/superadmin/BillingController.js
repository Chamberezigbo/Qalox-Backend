const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { parsePlanFeatures } = require("../../util/planFeatures");
const billingService = require("../../Services/BillingService");

/**
 * POST /api/billing/initialize-payment
 * Super Admin picks a school + billing plan + cycle; we create a Flutterwave
 * bank-transfer charge in one call and return the virtual account details
 * for the school to pay into. The SchoolPayment row starts "pending" and is
 * only marked "success" once the Flutterwave webhook confirms the transfer
 * landed (re-verified server-side, not just trusted from the webhook body).
 */
exports.initializePayment = async (req, res, next) => {
  try {
    const { schoolId, billingPlanId, billingCycle } = req.body;
    const result = await billingService.initializePaymentForSchool({ schoolId, billingPlanId, billingCycle });

    if (!result.success) {
      const statusByCode = { INVALID_REQUEST: 400, SCHOOL_NOT_FOUND: 404, PLAN_NOT_FOUND: 404, INVALID_PLAN_PRICE: 400, MISSING_SCHOOL_EMAIL: 400 };
      return res.status(statusByCode[result.code] || 400).json(result);
    }

    res.status(201).json({ success: true, message: "Payment initialized", data: result.data });
  } catch (err) {
    logger.error("[BILLING] Failed to initialize payment", { error: err.message });
    next(err);
  }
};

const monthlyEquivalent = (sub) =>
  sub.billingCycle === "annual" ? sub.billingPlan.annualPrice / 12 : sub.billingPlan.monthlyPrice;

/**
 * GET /api/billing/stats
 */
exports.getBillingStats = async (req, res, next) => {
  try {
    const activeSubs = await prisma.schoolSubscription.findMany({
      where: { status: "active" },
      include: { billingPlan: true },
    });

    const mrr = activeSubs.reduce((sum, s) => sum + monthlyEquivalent(s), 0);

    const revenueByPlanMap = new Map();
    activeSubs.forEach((s) => {
      const key = s.billingPlan.name;
      const entry = revenueByPlanMap.get(key) ?? { plan: key, amount: 0, count: 0 };
      entry.amount += monthlyEquivalent(s);
      entry.count += 1;
      revenueByPlanMap.set(key, entry);
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [cancelledThisMonth, totalRevenueAgg, activeCount, trialCount] = await Promise.all([
      prisma.schoolSubscription.count({ where: { status: "cancelled", updatedAt: { gte: startOfMonth } } }),
      prisma.schoolPayment.aggregate({ where: { status: "success" }, _sum: { amount: true } }),
      prisma.schoolSubscription.count({ where: { status: "active" } }),
      prisma.schoolSubscription.count({ where: { status: "trial" } }),
    ]);

    // Real revenue trend for the last 6 months, from actual successful payments.
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date();
      start.setMonth(start.getMonth() - i, 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);

      const agg = await prisma.schoolPayment.aggregate({
        where: { status: "success", paidAt: { gte: start, lt: end } },
        _sum: { amount: true },
      });
      monthlyRevenue.push({ month: start.toLocaleString("en-US", { month: "short" }), amount: agg._sum.amount || 0 });
    }

    res.json({
      success: true,
      data: {
        mrr: Math.round(mrr),
        arr: Math.round(mrr * 12),
        activeSubscriptions: activeCount,
        trialSubscriptions: trialCount,
        cancelledThisMonth,
        totalRevenue: totalRevenueAgg._sum.amount || 0,
        revenueByPlan: [...revenueByPlanMap.values()].map((r) => ({ ...r, amount: Math.round(r.amount) })),
        monthlyRevenue,
      },
    });
  } catch (err) {
    logger.error("[BILLING] Failed to fetch stats", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/billing/subscriptions
 */
exports.getSubscriptions = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const { search, status } = req.query;

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.school = { name: { contains: search } };
    }

    const [subs, total] = await Promise.all([
      prisma.schoolSubscription.findMany({
        where,
        include: { school: { include: { admins: { take: 1, select: { email: true } } } }, billingPlan: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.schoolSubscription.count({ where }),
    ]);

    const data = subs.map((s) => ({
      id: s.id,
      schoolId: s.schoolId,
      schoolName: s.school.name,
      adminEmail: s.school.admins[0]?.email || "",
      plan: s.billingPlan.name,
      billingCycle: s.billingCycle,
      amount: monthlyEquivalent(s) * (s.billingCycle === "annual" ? 12 : 1),
      status: s.status,
      startDate: s.startedAt,
      nextBillingDate: s.nextBillingDate,
      trialEndsAt: s.trialEndsAt,
      region: "",
    }));

    res.json({ success: true, data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error("[BILLING] Failed to fetch subscriptions", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/billing/subscriptions/:id
 * Accepts a billing plan name + cycle; `amount` (if sent) is accepted but not
 * persisted since real pricing always comes from the linked BillingPlan.
 */
exports.updateSubscription = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { plan, billingCycle } = req.body;

    const subscription = await prisma.schoolSubscription.findUnique({ where: { id } });
    if (!subscription) {
      return res.status(404).json({ success: false, message: "Subscription not found" });
    }

    const updateData = {};
    if (billingCycle) updateData.billingCycle = billingCycle;
    if (plan) {
      const billingPlan = await prisma.billingPlan.findUnique({ where: { name: plan } });
      if (!billingPlan) {
        return res.status(404).json({ success: false, message: `Billing plan '${plan}' not found` });
      }
      updateData.billingPlanId = billingPlan.id;
    }

    const updated = await prisma.schoolSubscription.update({ where: { id }, data: updateData });

    logger.info("[BILLING] Subscription updated", { id });
    res.json({ success: true, message: "Subscription updated", data: { id: updated.id } });
  } catch (err) {
    logger.error("[BILLING] Failed to update subscription", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/billing/plans
 */
exports.createBillingPlan = async (req, res, next) => {
  try {
    const { name, description, monthlyPrice, annualPrice, features, isActive, highlighted, minStudents, maxStudents, maxSubAdmins, smsQuotaPerTerm } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const plan = await prisma.billingPlan.create({
      data: {
        name,
        description: description || null,
        monthlyPrice: monthlyPrice || 0,
        annualPrice: annualPrice || 0,
        features: JSON.stringify(features || []),
        isActive: isActive ?? true,
        highlighted: highlighted ?? false,
        minStudents: minStudents || 0,
        maxStudents: maxStudents === "" || maxStudents == null ? null : maxStudents,
        maxSubAdmins: maxSubAdmins === "" || maxSubAdmins == null ? null : maxSubAdmins,
        smsQuotaPerTerm: smsQuotaPerTerm === "" || smsQuotaPerTerm == null ? null : smsQuotaPerTerm,
      },
    });

    logger.info("[BILLING] Plan created", { planId: plan.id });
    res.status(201).json({ success: true, message: "Plan created", data: { ...plan, features: features || [] } });
  } catch (err) {
    logger.error("[BILLING] Failed to create plan", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/billing/plans/:id
 */
exports.updateBillingPlan = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, monthlyPrice, annualPrice, features, isActive, highlighted, minStudents, maxStudents, maxSubAdmins, smsQuotaPerTerm } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (monthlyPrice !== undefined) updateData.monthlyPrice = monthlyPrice;
    if (annualPrice !== undefined) updateData.annualPrice = annualPrice;
    if (features !== undefined) updateData.features = JSON.stringify(features);
    if (isActive !== undefined) updateData.isActive = isActive;
    if (highlighted !== undefined) updateData.highlighted = highlighted;
    if (minStudents !== undefined) updateData.minStudents = minStudents || 0;
    if (maxStudents !== undefined) updateData.maxStudents = maxStudents === "" || maxStudents == null ? null : maxStudents;
    if (maxSubAdmins !== undefined) updateData.maxSubAdmins = maxSubAdmins === "" || maxSubAdmins == null ? null : maxSubAdmins;
    if (smsQuotaPerTerm !== undefined) updateData.smsQuotaPerTerm = smsQuotaPerTerm === "" || smsQuotaPerTerm == null ? null : smsQuotaPerTerm;

    const plan = await prisma.billingPlan.update({ where: { id }, data: updateData });

    logger.info("[BILLING] Plan updated", { planId: id });
    // Safe parse: when the caller omits `features`, plan.features is whatever
    // was already stored, which may not be valid JSON.
    res.json({ success: true, message: "Plan updated", data: { ...plan, features: parsePlanFeatures(plan.features) } });
  } catch (err) {
    logger.error("[BILLING] Failed to update plan", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/billing/schools/:schoolId/start-trial
 * Super Admin grants a school a free trial directly — no redeemable code,
 * just a direct action with an audit trail (trialGrantedByAdminId).
 */
exports.startTrial = async (req, res, next) => {
  try {
    const schoolId = parseInt(req.params.schoolId, 10);
    const { billingPlanId, durationDays } = req.body;
    const adminId = req.admin?.id;

    if (!billingPlanId) {
      return res.status(400).json({ success: false, message: "billingPlanId is required" });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found", code: "SCHOOL_NOT_FOUND" });
    }

    const plan = await prisma.billingPlan.findUnique({ where: { id: billingPlanId } });
    if (!plan) {
      return res.status(404).json({ success: false, message: "Billing plan not found", code: "PLAN_NOT_FOUND" });
    }

    const subscription = await billingService.grantTrial({
      schoolId,
      billingPlanId,
      durationDays,
      trialGrantedByAdminId: adminId,
    });

    logger.info("[BILLING] Trial started", { schoolId, billingPlanId, trialEndsAt: subscription.trialEndsAt, adminId });

    res.json({
      success: true,
      message: `Trial started for ${school.name}, ends ${subscription.trialEndsAt.toISOString().slice(0, 10)}`,
      data: { id: subscription.id, schoolId, billingPlanId, status: "trial", trialEndsAt: subscription.trialEndsAt },
    });
  } catch (err) {
    logger.error("[BILLING] Failed to start trial", { error: err.message });
    next(err);
  }
};
