const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const emailService = require("../../Services/EmailService");

/**
 * GET /api/communications
 */
exports.getCommunications = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));

    const [rows, total] = await Promise.all([
      prisma.platformCommunication.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.platformCommunication.count(),
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

    const schools = await prisma.school.findMany({
      where: { isSuspended: false },
      select: { id: true, email: true },
    });
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
