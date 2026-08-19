const notificationService = require("../Services/NotificationService");
const logger = require("../config/logger");

/**
 * One shared read/write API for the UserNotification feed, mounted three
 * times (admin/teacher/student routes) because each role's auth middleware
 * exposes the caller's identity under a different req property:
 *   admin   -> req.user.id       (authenticateSchoolLevelAdmin)
 *   teacher -> req.staffId       (teacherAuthMiddleware)
 *   student -> req.user.studentId (authLogin)
 */
const buildHandlers = (recipientType, getRecipientId) => ({
  list: async (req, res, next) => {
    try {
      const recipientId = getRecipientId(req);
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 20));
      const data = await notificationService.listNotifications({ recipientType, recipientId, page, limit });
      res.status(200).json({ success: true, data });
    } catch (err) {
      logger.error("[NOTIFICATIONS] Failed to list notifications", { recipientType, error: err.message });
      next(err);
    }
  },

  markRead: async (req, res, next) => {
    try {
      const recipientId = getRecipientId(req);
      const notificationId = parseInt(req.params.id, 10);
      const found = await notificationService.markRead({ recipientType, recipientId, notificationId });
      if (!found) {
        return res.status(404).json({ success: false, message: "Notification not found" });
      }
      res.status(200).json({ success: true, message: "Marked as read" });
    } catch (err) {
      logger.error("[NOTIFICATIONS] Failed to mark read", { recipientType, error: err.message });
      next(err);
    }
  },

  markAllRead: async (req, res, next) => {
    try {
      const recipientId = getRecipientId(req);
      await notificationService.markAllRead({ recipientType, recipientId });
      res.status(200).json({ success: true, message: "All marked as read" });
    } catch (err) {
      logger.error("[NOTIFICATIONS] Failed to mark all read", { recipientType, error: err.message });
      next(err);
    }
  },
});

module.exports = {
  admin: buildHandlers("admin", (req) => req.user.id),
  teacher: buildHandlers("teacher", (req) => req.staffId),
  student: buildHandlers("student", (req) => req.user.studentId),
};
