const prisma = require("../util/prisma");

/**
 * Shared read-side logic for the UserNotification feed (admin/teacher/student).
 * Write-side lives in res/util/notify.js (createNotification), called from
 * the actual trigger points elsewhere in the codebase.
 */

const listNotifications = async ({ recipientType, recipientId, page = 1, limit = 20 }) => {
  const where = { recipientType, recipientId };
  const [notifications, total, unreadCount] = await Promise.all([
    prisma.userNotification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.userNotification.count({ where }),
    prisma.userNotification.count({ where: { ...where, isRead: false } }),
  ]);

  return {
    notifications,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    unreadCount,
  };
};

const markRead = async ({ recipientType, recipientId, notificationId }) => {
  const result = await prisma.userNotification.updateMany({
    where: { id: notificationId, recipientType, recipientId },
    data: { isRead: true },
  });
  return result.count > 0;
};

const markAllRead = async ({ recipientType, recipientId }) => {
  await prisma.userNotification.updateMany({
    where: { recipientType, recipientId, isRead: false },
    data: { isRead: true },
  });
};

module.exports = { listNotifications, markRead, markAllRead };
