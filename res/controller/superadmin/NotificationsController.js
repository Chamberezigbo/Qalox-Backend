const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

const NOTIF_TYPES = ["maintenance", "announcement", "token_expiry", "security", "update"];

/**
 * GET /api/notifications
 * (Super Admin system notifications — distinct from the marketer-only
 * /api/public/notifications.)
 */
exports.getSystemNotifications = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));

    const [rows, total] = await Promise.all([
      prisma.systemNotification.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.systemNotification.count(),
    ]);

    const data = rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      recipientCount: n.recipientCount,
      recipientTarget: n.recipientTarget,
      scheduledAt: n.scheduledAt,
      sentAt: n.sentAt,
      status: n.scheduledAt && n.scheduledAt > new Date() ? "scheduled" : "sent",
      createdAt: n.createdAt,
    }));

    res.json({ success: true, data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error("[NOTIFICATIONS] Failed to fetch notifications", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/notifications
 * Real in-app system notification — fans out to every school-level head
 * admin (role in school_admin/super_admin), scoped by recipientTarget.
 */
exports.sendSystemNotification = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { type, title, message, recipientTarget, scheduledAt } = req.body;

    if (!type || !title || !message || !recipientTarget) {
      return res.status(400).json({ success: false, message: "type, title, message and recipientTarget are required" });
    }
    if (!NOTIF_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: `type must be one of: ${NOTIF_TYPES.join(", ")}` });
    }

    const recipients = await prisma.admin.count({
      where: { role: { in: ["school_admin", "super_admin"] } },
    });

    const notification = await prisma.systemNotification.create({
      data: {
        type,
        title,
        message,
        recipientTarget,
        recipientCount: recipients,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        sentAt: scheduledAt && new Date(scheduledAt) > new Date() ? null : new Date(),
        createdByAdminId: adminId,
      },
    });

    logger.info("[NOTIFICATIONS] System notification created", { id: notification.id, recipients });

    res.status(201).json({
      success: true,
      message: "Notification created",
      data: {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        recipientCount: notification.recipientCount,
        recipientTarget: notification.recipientTarget,
        scheduledAt: notification.scheduledAt,
        sentAt: notification.sentAt,
        status: notification.scheduledAt && notification.scheduledAt > new Date() ? "scheduled" : "sent",
        createdAt: notification.createdAt,
      },
    });
  } catch (err) {
    logger.error("[NOTIFICATIONS] Failed to create notification", { error: err.message });
    next(err);
  }
};
