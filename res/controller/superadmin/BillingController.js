const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { parsePlanFeatures } = require("../../util/planFeatures");
const crypto = require("crypto");
const billingService = require("../../Services/BillingService");
const { createNotification } = require("../../util/notify");
const {
  getAiCreditsStatusForSchool,
  getAiCreditsAllowanceForSchool,
} = require("../../util/getAiCreditsAllowanceForSchool");
const { maxTakeBack } = require("../../util/creditTakeBack");

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

    const [cancelledThisMonth, totalRevenueAgg, creditPackRevenueAgg, activeCount, trialCount] = await Promise.all([
      prisma.schoolSubscription.count({ where: { status: "cancelled", updatedAt: { gte: startOfMonth } } }),
      // Plan revenue only. Credit packs are reported separately so each figure
      // still means one thing and the two add up to what was actually received.
      prisma.schoolPayment.aggregate({ where: { status: "success", purpose: "subscription" }, _sum: { amount: true } }),
      prisma.schoolPayment.aggregate({ where: { status: "success", purpose: "credit_pack" }, _sum: { amount: true } }),
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
        where: { status: "success", purpose: "subscription", paidAt: { gte: start, lt: end } },
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
        creditPackRevenue: creditPackRevenueAgg._sum.amount || 0,
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
    const { name, description, monthlyPrice, annualPrice, features, isActive, highlighted, minStudents, maxStudents, maxSubAdmins, smsQuotaPerTerm, aiCreditsPerTerm } = req.body;
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
        // null here means AI generation is excluded from the plan outright, not
        // "zero credits" — getAiCreditsAllowanceForSchool treats both the same,
        // but the distinction is what the plan form's blank field expresses.
        aiCreditsPerTerm: aiCreditsPerTerm === "" || aiCreditsPerTerm == null ? null : aiCreditsPerTerm,
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
    const { name, description, monthlyPrice, annualPrice, features, isActive, highlighted, minStudents, maxStudents, maxSubAdmins, smsQuotaPerTerm, aiCreditsPerTerm } = req.body;

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
    if (aiCreditsPerTerm !== undefined) updateData.aiCreditsPerTerm = aiCreditsPerTerm === "" || aiCreditsPerTerm == null ? null : aiCreditsPerTerm;

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


// ---------------------------------------------------------------------------
// AI credit packs (what schools can buy on top of their plan)
// ---------------------------------------------------------------------------

/** Validates a pack body; returns `{ error }` or the cleaned fields. */
function parsePack(body, { partial }) {
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) return { error: "The name must be 1 to 100 characters" };
    out.name = name;
  }
  if (!partial || body.credits !== undefined) {
    const credits = Number(body.credits);
    if (!Number.isInteger(credits) || credits < 1 || credits > 1_000_000) {
      return { error: "Credits must be a whole number between 1 and 1,000,000" };
    }
    out.credits = credits;
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0 || price > 100_000_000) return { error: "The price must be more than zero" };
    out.price = price;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return { error: "isActive must be true or false" };
    out.isActive = body.isActive;
  }
  if (body.sortOrder !== undefined) {
    const order = Number(body.sortOrder);
    if (!Number.isInteger(order)) return { error: "sortOrder must be a whole number" };
    out.sortOrder = order;
  }
  return { fields: out };
}

/** GET /api/billing/credit-packs — all packs, including inactive ones. */
exports.getCreditPacks = async (req, res, next) => {
  try {
    const packs = await prisma.aiCreditPack.findMany({ orderBy: [{ sortOrder: "asc" }, { credits: "asc" }] });
    res.json({ success: true, data: packs });
  } catch (err) {
    next(err);
  }
};

/** POST /api/billing/credit-packs */
exports.createCreditPack = async (req, res, next) => {
  try {
    const { error, fields } = parsePack(req.body ?? {}, { partial: false });
    if (error) return res.status(400).json({ success: false, message: error, code: "INVALID_REQUEST" });

    const pack = await prisma.aiCreditPack.create({ data: fields });
    logger.info("[BILLING] Credit pack created", { packId: pack.id, adminId: req.admin?.id });
    res.status(201).json({ success: true, data: pack });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/billing/credit-packs/:id
 * Changing a pack's credits or price affects only FUTURE purchases: a payment
 * already started keeps the credits it was sold with.
 */
exports.updateCreditPack = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: "Invalid pack id" });

    const { error, fields } = parsePack(req.body ?? {}, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error, code: "INVALID_REQUEST" });

    const existing = await prisma.aiCreditPack.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ success: false, message: "Pack not found" });

    const pack = await prisma.aiCreditPack.update({ where: { id }, data: fields });
    logger.info("[BILLING] Credit pack updated", { packId: id, adminId: req.admin?.id });
    res.json({ success: true, data: pack });
  } catch (err) {
    next(err);
  }
};


// ---------------------------------------------------------------------------
// Granting AI credits to a school (goodwill, a pilot, or putting right a fault)
// ---------------------------------------------------------------------------

const MAX_GRANT = 100_000;

/** GET /api/billing/schools/:schoolId/credits — a school's credit position. */
exports.getSchoolCredits = async (req, res, next) => {
  try {
    const schoolId = Number(req.params.schoolId);
    if (!Number.isInteger(schoolId)) return res.status(400).json({ success: false, message: "Invalid school id" });

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, name: true } });
    if (!school) return res.status(404).json({ success: false, message: "School not found" });

    const credits = await getAiCreditsStatusForSchool(schoolId);
    res.json({ success: true, data: { school, credits } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/billing/schools/:schoolId/grant-credits
 * Body: { credits, reason? }
 *
 * Adds free credits to the school's bought balance, so they carry over between
 * terms exactly like purchased ones. A zero-amount SchoolPayment with purpose
 * "credit_grant" is the durable record of it (revenue figures only count
 * subscription and credit_pack payments, so it never appears as income). The
 * reason goes in the log, with who granted it.
 */
exports.grantSchoolCredits = async (req, res, next) => {
  try {
    const schoolId = Number(req.params.schoolId);
    const credits = Number(req.body?.credits);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 255) : "";

    if (!Number.isInteger(schoolId)) return res.status(400).json({ success: false, message: "Invalid school id" });
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_GRANT) {
      return res.status(400).json({
        success: false,
        message: `Credits must be a whole number between 1 and ${MAX_GRANT.toLocaleString("en-NG")}`,
        code: "INVALID_REQUEST",
      });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, name: true } });
    if (!school) return res.status(404).json({ success: false, message: "School not found" });

    const reference = `grant-${schoolId}-${crypto.randomUUID().slice(0, 8)}`;

    // One transaction: the balance and its record move together.
    const [updated] = await prisma.$transaction([
      prisma.school.update({
        where: { id: schoolId },
        data: { aiCreditsPurchased: { increment: credits } },
        select: { aiCreditsPurchased: true },
      }),
      prisma.schoolPayment.create({
        data: {
          schoolId,
          amount: 0,
          flwReference: reference,
          status: "success",
          paidAt: new Date(),
          purpose: "credit_grant",
          creditsGranted: credits,
        },
      }),
    ]);

    logger.info("[BILLING] AI credits granted", { schoolId, credits, reason, reference, adminId: req.admin?.id ?? null });

    // Tell the school's head admins. Best effort: the grant has already happened.
    try {
      const admins = await prisma.admin.findMany({
        where: { schoolId, role: { in: ["school_admin", "super_admin"] } },
        select: { id: true },
      });
      for (const admin of admins) {
        await createNotification({
          recipientType: "admin",
          recipientId: admin.id,
          schoolId,
          title: "AI credits added",
          message: `${credits.toLocaleString("en-NG")} AI credits have been added to your school.`,
          type: "success",
          link: "/admin/billing",
        });
      }
    } catch (error) {
      logger.warn("[BILLING] Could not notify school about granted credits", { schoolId, error: error.message });
    }

    res.status(201).json({
      success: true,
      message: `${credits.toLocaleString("en-NG")} credits added to ${school.name}`,
      data: { schoolId, granted: credits, purchasedBalance: updated.aiCreditsPurchased },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/billing/schools/:schoolId/deduct-credits
 * Body: { credits, reason }   (reason is required)
 *
 * Takes back credits granted or sold by mistake. Only the BOUGHT/GRANTED balance
 * is touched, and never more than the school has not yet spent: taking back
 * credits it has already used would leave it overdrawn and locked out of
 * generation until the next term. The school's row is read FOR UPDATE inside one
 * transaction, which is what stops a generation reserving credits between the
 * check and the deduction (every reservation also updates that row).
 *
 * Recorded as a zero-amount SchoolPayment with purpose "credit_adjustment" and a
 * negative creditsGranted, so revenue figures (which filter by purpose) are
 * unaffected and the history shows it.
 */
exports.deductSchoolCredits = async (req, res, next) => {
  try {
    const schoolId = Number(req.params.schoolId);
    const credits = Number(req.body?.credits);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 255) : "";

    if (!Number.isInteger(schoolId)) return res.status(400).json({ success: false, message: "Invalid school id" });
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_GRANT) {
      return res.status(400).json({
        success: false,
        message: `Credits must be a whole number between 1 and ${MAX_GRANT.toLocaleString("en-NG")}`,
        code: "INVALID_REQUEST",
      });
    }
    if (reason.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Give a reason for taking credits back",
        code: "INVALID_REQUEST",
      });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, name: true } });
    if (!school) return res.status(404).json({ success: false, message: "School not found" });

    const base = await getAiCreditsAllowanceForSchool(schoolId);
    const reference = `adjust-${schoolId}-${crypto.randomUUID().slice(0, 8)}`;

    const outcome = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT aiCreditsPurchased, aiCreditsUsedThisTerm FROM schools WHERE id = ${schoolId} FOR UPDATE`;
      const purchased = Number(rows?.[0]?.aiCreditsPurchased ?? 0);
      const used = Number(rows?.[0]?.aiCreditsUsedThisTerm ?? 0);

      const available = maxTakeBack({ base, purchased, used });
      if (credits > available) return { ok: false, available, purchased };

      const updated = await tx.school.update({
        where: { id: schoolId },
        data: { aiCreditsPurchased: { decrement: credits } },
        select: { aiCreditsPurchased: true },
      });
      await tx.schoolPayment.create({
        data: {
          schoolId,
          amount: 0,
          flwReference: reference,
          status: "success",
          paidAt: new Date(),
          purpose: "credit_adjustment",
          creditsGranted: -credits,
        },
      });
      return { ok: true, balance: updated.aiCreditsPurchased };
    });

    if (!outcome.ok) {
      return res.status(409).json({
        success: false,
        code: "NOT_ENOUGH_TO_TAKE_BACK",
        message:
          outcome.available === 0
            ? `${school.name} has no unspent bought or granted credits to take back.`
            : `Only ${outcome.available.toLocaleString("en-NG")} credits can be taken back from ${school.name}: the rest are already spent.`,
        data: { available: outcome.available, purchasedBalance: outcome.purchased },
      });
    }

    logger.info("[BILLING] AI credits taken back", { schoolId, credits, reason, reference, adminId: req.admin?.id ?? null });

    res.status(201).json({
      success: true,
      message: `${credits.toLocaleString("en-NG")} credits taken back from ${school.name}`,
      data: { schoolId, deducted: credits, purchasedBalance: outcome.balance },
    });
  } catch (err) {
    next(err);
  }
};
