const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

const NOTIF_TYPES = ["maintenance", "announcement", "token_expiry", "security", "update"];

const normalizeNotificationStatus = (notification) => {
  if (!notification || !notification.scheduledAt) return "sent";
  return new Date(notification.scheduledAt) > new Date() ? "scheduled" : "sent";
};

const buildNotificationQueryFilter = (status) => {
  if (!status) return {};

  if (status === "scheduled") {
    return { scheduledAt: { gt: new Date() } };
  }

  if (status === "sent") {
    return {
      OR: [
        { scheduledAt: null },
        { scheduledAt: { lte: new Date() } },
      ],
    };
  }

  return {};
};

/**
 * GET /api/notifications
 * (Super Admin system notifications — distinct from the marketer-only
 * /api/public/notifications.)
 */
exports.getSystemNotifications = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const type = req.query.type;
    const status = req.query.status;

    const where = {};
    if (type && NOTIF_TYPES.includes(type)) {
      where.type = type;
    }
    if (status && ["scheduled", "sent"].includes(status)) {
      Object.assign(where, buildNotificationQueryFilter(status));
    }

    const [rows, total] = await Promise.all([
      prisma.systemNotification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.systemNotification.count({ where }),
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
      status: normalizeNotificationStatus(n),
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

    const scheduledAtValue = scheduledAt ? new Date(scheduledAt) : null;
    const isScheduled = Boolean(scheduledAtValue && scheduledAtValue > new Date());

    const notification = await prisma.systemNotification.create({
      data: {
        type,
        title,
        message,
        recipientTarget,
        recipientCount: recipients,
        scheduledAt: scheduledAtValue,
        sentAt: isScheduled ? null : new Date(),
        createdByAdminId: adminId,
      },
    });

    logger.info("[NOTIFICATIONS] System notification created", { id: notification.id, recipients, scheduled: isScheduled });

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
        status: normalizeNotificationStatus(notification),
        createdAt: notification.createdAt,
      },
    });
  } catch (err) {
    logger.error("[NOTIFICATIONS] Failed to create notification", { error: err.message });
    next(err);
  }
};

exports.cancelSystemNotification = async (req, res, next) => {
  try {
    const { id } = req.params;
    const notificationId = Number(id);

    if (!Number.isInteger(notificationId)) {
      return res.status(400).json({ success: false, message: "Invalid notification id" });
    }

    const notification = await prisma.systemNotification.findUnique({ where: { id: notificationId } });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    if (!notification.scheduledAt || notification.scheduledAt <= new Date()) {
      return res.status(400).json({ success: false, message: "Only scheduled notifications can be cancelled" });
    }

    const updated = await prisma.systemNotification.update({
      where: { id: notificationId },
      data: {
        scheduledAt: null,
        sentAt: new Date(),
      },
    });

    res.status(200).json({
      success: true,
      message: "Scheduled notification cancelled",
      data: {
        id: updated.id,
        status: normalizeNotificationStatus(updated),
      },
    });
  } catch (err) {
    logger.error("[NOTIFICATIONS] Failed to cancel notification", { error: err.message });
    next(err);
  }
};

exports.getRecipientStats = async (req, res, next) => {
  try {
    const [
      schoolsAll,
      schoolsActive,
      schoolsPremiumEnterprise,
      schoolsEnterprise,
      schoolsTrial,
      marketersAll,
      marketersActive,
      marketersTopPerforming,
    ] = await Promise.all([
      prisma.school.count(),
      prisma.school.count({ where: { isSuspended: false } }),
      prisma.school.count({ where: { billingPlan: { name: { contains: "Premium Enterprise" } } } }),
      prisma.school.count({ where: { billingPlan: { name: { contains: "Enterprise" } } } }),
      prisma.school.count({ where: { subscriptions: { some: { status: "trialing" } } } }),
      prisma.admin.count({ where: { role: "marketer" } }),
      prisma.admin.count({ where: { role: "marketer", isSuspended: false } }),
      prisma.admin.count({ where: { role: "marketer", tier: { in: ["gold", "platinum"] } } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        schools: {
          all: schoolsAll,
          active: schoolsActive,
          premium_enterprise: schoolsPremiumEnterprise,
          enterprise: schoolsEnterprise,
          trial: schoolsTrial,
        },
        marketers: {
          all: marketersAll,
          active: marketersActive,
          top_performing: marketersTopPerforming,
        },
      },
    });
  } catch (err) {
    logger.error("[NOTIFICATIONS] Failed to fetch recipient stats", { error: err.message });
    next(err);
  }
};

exports.sendSuperAdminNotification = async (req, res, next) => {
  try {
    // If it's a super admin, they have an id. Let's find out from `req.user` or `req.admin`.
    const adminId = req.user?.id || req.admin?.id || 1; 
    const { type, title, message, recipientTarget, scheduledAt } = req.body;

    if (!type || !title || !message || !recipientTarget) {
      return res.status(400).json({ success: false, message: "type, title, message and recipientTarget are required" });
    }

    const scheduledAtValue = scheduledAt ? new Date(scheduledAt) : null;
    const isScheduled = Boolean(scheduledAtValue && scheduledAtValue > new Date());

    if (recipientTarget.startsWith("marketer")) {
      // Marketer targeting
      let targetMarketerIds = [];
      let recipientCount = 0;

      if (recipientTarget === "all_marketers") {
        const marketers = await prisma.admin.findMany({ where: { role: "marketer" }, select: { id: true } });
        targetMarketerIds = marketers.map(m => m.id);
      } else if (recipientTarget.startsWith("marketer:")) {
        targetMarketerIds = [parseInt(recipientTarget.split(":")[1])];
      }

      recipientCount = targetMarketerIds.length;

      if (recipientCount > 0) {
        const notificationsData = targetMarketerIds.map(id => ({
          marketerId: id,
          title,
          message,
          type,
          isRead: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        await prisma.notification.createMany({ data: notificationsData });
      }

      logger.info("[NOTIFICATIONS] Marketer notifications dispatched", { count: recipientCount, target: recipientTarget });
      
      return res.status(201).json({
        success: true,
        message: "Notifications dispatched to marketers",
        data: { recipientCount, target: recipientTarget }
      });
    } else {
      // School targeting -> SystemNotification
      let recipientCount = 0;
      let targetSchoolIds = null;

      if (recipientTarget === "all_schools") {
        recipientCount = await prisma.school.count();
      } else if (recipientTarget === "active_schools") {
        recipientCount = await prisma.school.count({ where: { isSuspended: false } });
      } else if (recipientTarget.startsWith("school:")) {
        recipientCount = 1;
        targetSchoolIds = JSON.stringify([parseInt(recipientTarget.split(":")[1])]);
      }

      const notification = await prisma.systemNotification.create({
        data: {
          type,
          title,
          message,
          recipientTarget,
          targetSchoolIds,
          recipientCount,
          scheduledAt: scheduledAtValue,
          sentAt: isScheduled ? null : new Date(),
          createdByAdminId: adminId, 
        },
      });

      logger.info("[NOTIFICATIONS] System notification created", { id: notification.id, target: recipientTarget });

      return res.status(201).json({
        success: true,
        message: "Notification created",
        data: notification
      });
    }
  } catch (err) {
    logger.error("[NOTIFICATIONS] Failed to dispatch notification", { error: err.message });
    next(err);
  }
};

module.exports = {
  ...module.exports,
  normalizeNotificationStatus,
  buildNotificationQueryFilter,
};
