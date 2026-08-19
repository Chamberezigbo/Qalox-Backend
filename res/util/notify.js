const prisma = require("./prisma");
const logger = require("../config/logger");

/**
 * Create a UserNotification row for an admin/teacher/student recipient.
 * Never throws — a failed notification write shouldn't break the action
 * that triggered it (fee payment, result publish, etc.), so callers can
 * fire-and-forget this.
 * @param {{recipientType: "admin"|"teacher"|"student", recipientId: number, schoolId: number, title: string, message: string, type: string, link?: string}} params
 */
const createNotification = async ({ recipientType, recipientId, schoolId, title, message, type, link }) => {
  try {
    await prisma.userNotification.create({
      data: { recipientType, recipientId, schoolId, title, message, type, link: link || null },
    });
  } catch (err) {
    logger.error("[NOTIFY] Failed to create notification", { recipientType, recipientId, type, error: err.message });
  }
};

module.exports = { createNotification };
