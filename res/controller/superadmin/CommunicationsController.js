const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const emailService = require("../../Services/EmailService");

const normalizeRecipientTarget = (value) => (typeof value === "string" ? value.trim() : "");

const resolveRecipientTargetFilter = (recipientTarget, regionFilter) => {
  const target = normalizeRecipientTarget(recipientTarget);
  if (!target) {
    throw new Error("recipientTarget is required");
  }

  if (["all", "active"].includes(target)) {
    return { isSuspended: false };
  }

  if (target === "suspended") {
    return { isSuspended: true };
  }

  if (target === "trial") {
    return {
      OR: [
        { billingPlan: { name: { contains: "trial" } } },
        { subscriptions: { some: { status: "trialing" } } },
      ],
    };
  }

  if (["premium", "enterprise", "basic"].includes(target)) {
    return {
      billingPlan: { name: { contains: target, mode: "insensitive" } },
    };
  }

  if (target === "past_due") {
    return {
      subscriptions: { some: { status: "past_due" } },
    };
  }

  if (target === "region") {
    const region = normalizeRecipientTarget(regionFilter);
    if (!region) {
      return { isSuspended: false };
    }

    return {
      isSuspended: false,
      OR: [
        { address: { contains: region } },
        { city: { contains: region } },
        { state: { contains: region } },
        { name: { contains: region } },
      ],
    };
  }

  if (target.startsWith("school:")) {
    const schoolId = Number(target.split(":")[1]);
    if (Number.isInteger(schoolId) && schoolId > 0) {
      return { id: schoolId, isSuspended: false };
    }
  }

  throw new Error(`Unsupported recipientTarget: ${recipientTarget}`);
};

const getSchoolsForRecipientTarget = async (recipientTarget, regionFilter) => {
  const where = resolveRecipientTargetFilter(recipientTarget, regionFilter);

  return prisma.school.findMany({
    where,
    select: { id: true, email: true, name: true, address: true, city: true, state: true },
  });
};

/**
 * GET /api/communications
 */
exports.getCommunications = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const type = req.query.type;
    const status = req.query.status;

    const where = {};
    if (type && ["email", "sms"].includes(type)) {
      where.type = type;
    }
    if (status && ["pending", "sent", "failed", "partial"].includes(status)) {
      where.status = status;
    }

    const [rows, total] = await Promise.all([
      prisma.platformCommunication.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.platformCommunication.count({ where }),
    ]);

    const data = rows.map((c) => ({
      id: c.id,
      type: c.type,
      subject: c.subject,
      message: c.message,
      recipientCount: c.recipientCount,
      recipientTarget: c.recipientTarget,
      sentAt: c.sentAt,
      status: c.status,
    }));

    res.json({ success: true, data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error("[COMMUNICATIONS] Failed to fetch communications", { error: err.message });
    next(err);
  }
};

exports.getCommunicationRecipients = async (req, res, next) => {
  try {
    const { recipientTarget, regionFilter, type = "email" } = req.query;

    if (!recipientTarget) {
      return res.status(400).json({ success: false, message: "recipientTarget is required" });
    }

    if (type && !["email", "sms"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be 'email' or 'sms'" });
    }

    const schools = await getSchoolsForRecipientTarget(recipientTarget, regionFilter);
    const count = type === "email"
      ? schools.filter((school) => Boolean(school.email)).length
      : schools.length;

    res.json({ success: true, data: { count, recipientTarget, regionFilter: regionFilter || null, type } });
  } catch (err) {
    logger.error("[COMMUNICATIONS] Failed to resolve recipients", { error: err.message });
    res.status(400).json({ success: false, message: err.message || "Unable to resolve recipient target" });
  }
};

/**
 * POST /api/communications
 *
 * Resolves real recipients (schools/admins) and records a real communication
 * row. For type "email", actually dispatches via Resend. For type "sms",
 * still just records as "pending" — no SMS provider is wired up for
 * platform-wide broadcasts (the existing SmartSMS integration is scoped to
 * a single school's own quota, not a cross-school broadcast budget).
 */
exports.sendCommunication = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { type, subject, message, recipientTarget, regionFilter } = req.body;

    if (!type || !message || !recipientTarget) {
      return res.status(400).json({ success: false, message: "type, message and recipientTarget are required" });
    }
    if (!["email", "sms"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be 'email' or 'sms'" });
    }

    const schools = await getSchoolsForRecipientTarget(recipientTarget, regionFilter);
    const emailRecipients = schools.map((s) => s.email).filter(Boolean);
    const recipientCount = type === "email" ? emailRecipients.length : schools.length;

    let status = "pending";
    let sentAt = null;
    let dispatchResult = null;

    if (type === "email") {
      if (emailRecipients.length === 0) {
        status = "failed";
      } else {
        try {
          dispatchResult = await emailService.sendBulkEmail({
            recipients: emailRecipients,
            subject: subject || "Message from Qalox",
            html: `<p>${message.replace(/\n/g, "<br/>")}</p>`,
          });
          status = dispatchResult.sent > 0 ? "sent" : "failed";
          sentAt = dispatchResult.sent > 0 ? new Date() : null;
        } catch (dispatchErr) {
          logger.error("[COMMUNICATIONS] Email dispatch failed", { error: dispatchErr.message });
          status = "failed";
        }
      }
    }

    const communication = await prisma.platformCommunication.create({
      data: {
        type,
        subject: subject || null,
        message,
        recipientTarget,
        recipientCount,
        status,
        sentAt,
        createdByAdminId: adminId,
      },
    });

    logger.info("[COMMUNICATIONS] Communication processed", {
      id: communication.id, type, status, recipientCount, regionFilter, dispatchResult,
    });

    res.status(201).json({
      success: true,
      message:
        type === "sms"
          ? "Communication recorded. SMS dispatch is not yet wired up for platform-wide broadcasts."
          : status === "sent"
            ? `Email sent to ${dispatchResult.sent} of ${recipientCount} recipients${dispatchResult.failed > 0 ? ` (${dispatchResult.failed} failed)` : ""}.`
            : "Email dispatch failed.",
      data: {
        id: communication.id,
        type: communication.type,
        subject: communication.subject,
        message: communication.message,
        recipientCount: communication.recipientCount,
        recipientTarget: communication.recipientTarget,
        sentAt: communication.sentAt,
        status: communication.status,
      },
    });
  } catch (err) {
    logger.error("[COMMUNICATIONS] Failed to send communication", { error: err.message });
    next(err);
  }
};

module.exports = {
  ...module.exports,
  resolveRecipientTargetFilter,
};
