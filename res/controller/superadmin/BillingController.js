const crypto = require("crypto");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const flutterwave = require("../../Services/FlutterwaveService");

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

    if (!schoolId || !billingPlanId || !["monthly", "annual"].includes(billingCycle)) {
      logger.warn("[BILLING] Invalid initialize-payment request", { schoolId, billingPlanId, billingCycle });
      return res.status(400).json({
        success: false,
        message: "schoolId, billingPlanId and billingCycle ('monthly'|'annual') are required",
        code: "INVALID_REQUEST",
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      include: { admins: { take: 1, select: { name: true, email: true, phone: true } } },
    });
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found", code: "SCHOOL_NOT_FOUND" });
    }

    const plan = await prisma.billingPlan.findUnique({ where: { id: billingPlanId } });
    if (!plan || !plan.isActive) {
      return res.status(404).json({ success: false, message: "Billing plan not found", code: "PLAN_NOT_FOUND" });
    }

    const amount = billingCycle === "annual" ? plan.annualPrice : plan.monthlyPrice;
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: `Plan has no price configured for the '${billingCycle}' cycle`,
        code: "INVALID_PLAN_PRICE",
      });
    }

    const email = school.email || school.admins[0]?.email;
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "School has no email on file — required to initiate a Flutterwave charge",
        code: "MISSING_SCHOOL_EMAIL",
      });
    }

    // Flutterwave's v3 API throws a misleading "decrypt" error on non-ASCII
    // characters (confirmed live — an em-dash alone was enough to trigger it).
    // Strip anything outside printable ASCII from fields we send them.
    const toAscii = (str) => String(str).replace(/[^\x20-\x7E]/g, "").trim();

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

    res.status(201).json({
      success: true,
      message: "Payment initialized",
      data: {
        reference,
        amount,
        currency: "NGN",
        bankTransfer: charge.bankTransfer,
      },
    });
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

    const [cancelledThisMonth, totalRevenueAgg, activeCount] = await Promise.all([
      prisma.schoolSubscription.count({ where: { status: "cancelled", updatedAt: { gte: startOfMonth } } }),
      prisma.schoolPayment.aggregate({ where: { status: "success" }, _sum: { amount: true } }),
      prisma.schoolSubscription.count({ where: { status: "active" } }),
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
        trialSubscriptions: 0, // no trial concept in this schema
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
    const { name, description, monthlyPrice, annualPrice, features, isActive, highlighted } = req.body;
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
    const { name, description, monthlyPrice, annualPrice, features, isActive, highlighted } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (monthlyPrice !== undefined) updateData.monthlyPrice = monthlyPrice;
    if (annualPrice !== undefined) updateData.annualPrice = annualPrice;
    if (features !== undefined) updateData.features = JSON.stringify(features);
    if (isActive !== undefined) updateData.isActive = isActive;
    if (highlighted !== undefined) updateData.highlighted = highlighted;

    const plan = await prisma.billingPlan.update({ where: { id }, data: updateData });

    logger.info("[BILLING] Plan updated", { planId: id });
    res.json({ success: true, message: "Plan updated", data: { ...plan, features: JSON.parse(plan.features) } });
  } catch (err) {
    logger.error("[BILLING] Failed to update plan", { error: err.message });
    next(err);
  }
};
