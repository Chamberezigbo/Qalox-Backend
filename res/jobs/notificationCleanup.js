const prisma = require("../util/prisma");
const logger = require("../config/logger");

const READ_RETENTION_DAYS = parseInt(process.env.NOTIFICATION_READ_RETENTION_DAYS, 10) || 30;
const MAX_RETENTION_DAYS = parseInt(process.env.NOTIFICATION_MAX_RETENTION_DAYS, 10) || 90;

/**
 * Two-tier prune for the notification feeds (UserNotification: admin/teacher
 * /student, and ParentAlert: parent) — a read notification has no further
 * purpose after a short while, but an unread one is kept much longer since
 * someone may genuinely not have opened the app in a few weeks.
 */
async function cleanupOldNotifications() {
  const readCutoff = new Date();
  readCutoff.setDate(readCutoff.getDate() - READ_RETENTION_DAYS);

  const maxCutoff = new Date();
  maxCutoff.setDate(maxCutoff.getDate() - MAX_RETENTION_DAYS);

  const [userReadDeleted, userMaxDeleted, alertReadDeleted, alertMaxDeleted] = await Promise.all([
    prisma.userNotification.deleteMany({ where: { isRead: true, createdAt: { lt: readCutoff } } }),
    prisma.userNotification.deleteMany({ where: { createdAt: { lt: maxCutoff } } }),
    prisma.parentAlert.deleteMany({ where: { isRead: true, createdAt: { lt: readCutoff } } }),
    prisma.parentAlert.deleteMany({ where: { createdAt: { lt: maxCutoff } } }),
  ]);

  logger.info("[NOTIFICATION_CLEANUP] Run complete", {
    readRetentionDays: READ_RETENTION_DAYS,
    maxRetentionDays: MAX_RETENTION_DAYS,
    userNotificationsDeleted: userReadDeleted.count + userMaxDeleted.count,
    parentAlertsDeleted: alertReadDeleted.count + alertMaxDeleted.count,
  });
}

module.exports = { cleanupOldNotifications, READ_RETENTION_DAYS, MAX_RETENTION_DAYS };
