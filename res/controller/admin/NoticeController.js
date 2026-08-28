const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const bulkSms = require("../../Services/BulkSmsService");
const { getSmsQuotaForSchool } = require("../../util/getSmsQuotaForSchool");
const { toInternationalFormat } = require("../../util/phoneFormat");

const CATEGORIES = ["fee", "pta", "event", "general"];
const RECIPIENT_TYPES = ["all", "parents", "teachers", "students"];

/**
 * Resolve the phone numbers for a given recipientType, deduplicated.
 */
const resolveRecipientPhones = async (schoolId, recipientType) => {
  const numbers = new Set();

  if (recipientType === "parents" || recipientType === "all") {
    const students = await prisma.student.findMany({
      where: { schoolId, guardianNumber: { not: null } },
      select: { guardianNumber: true },
    });
    students.forEach((s) => {
      const n = toInternationalFormat(s.guardianNumber);
      if (n) numbers.add(n);
    });
  }

  if (recipientType === "teachers" || recipientType === "all") {
    const staff = await prisma.staff.findMany({
      where: { schoolId, phoneNumber: { not: null } },
      select: { phoneNumber: true },
    });
    staff.forEach((s) => {
      const n = toInternationalFormat(s.phoneNumber);
      if (n) numbers.add(n);
    });
  }

  // recipientType === "students": students have no phone number of their own in
  // this schema, so there's nothing to SMS — in-app only for that audience.

  return Array.from(numbers);
};

/**
 * Count total in-app recipients for a given recipientType (used even when SMS is off).
 */
const countRecipients = async (schoolId, recipientType) => {
  if (recipientType === "students") {
    return prisma.student.count({ where: { schoolId } });
  }
  if (recipientType === "teachers") {
    return prisma.staff.count({ where: { schoolId } });
  }
  if (recipientType === "parents") {
    return prisma.student.count({ where: { schoolId, guardianNumber: { not: null } } });
  }
  // all
  const [students, staff] = await Promise.all([
    prisma.student.count({ where: { schoolId } }),
    prisma.staff.count({ where: { schoolId } }),
  ]);
  return students + staff;
};

/**
 * GET /api/admin/sms/quota
 * Current school's SMS broadcast quota/usage for this term.
 */
exports.getSmsQuota = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { smsUsedThisTerm: true },
    });

    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }

    const quotaPerTerm = await getSmsQuotaForSchool(schoolId);

    res.status(200).json({
      success: true,
      data: {
        quotaPerTerm,
        used: school.smsUsedThisTerm,
        remaining: Math.max(quotaPerTerm - school.smsUsedThisTerm, 0),
      },
    });
  } catch (err) {
    logger.error("[GET_SMS_QUOTA] Failed", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admin/broadcasts
 * Create and send a notice/announcement. Always recorded in-app; optionally
 * also sent as SMS to the resolved recipient phone numbers (subject to the
 * school's per-term SMS quota).
 */
exports.createBroadcast = async (req, res, next) => {
  try {
    const adminId = req.user?.id;
    const schoolId = req.schoolId;
    const { title, message, category, recipientType, sendSms } = req.body;

    if (!title || !message || !category || !recipientType) {
      return res.status(400).json({
        success: false,
        message: "title, message, category, and recipientType are required",
        code: "MISSING_FIELDS",
      });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `category must be one of: ${CATEGORIES.join(", ")}`,
        code: "INVALID_CATEGORY",
      });
    }
    if (!RECIPIENT_TYPES.includes(recipientType)) {
      return res.status(400).json({
        success: false,
        message: `recipientType must be one of: ${RECIPIENT_TYPES.join(", ")}`,
        code: "INVALID_RECIPIENT_TYPE",
      });
    }

    const totalRecipients = await countRecipients(schoolId, recipientType);
    let smsSentCount = 0;

    if (sendSms) {
      if (recipientType === "students") {
        return res.status(400).json({
          success: false,
          message: "SMS is not available for recipientType 'students' — students have no phone number on file. Use in-app only, or target parents/teachers/all.",
          code: "SMS_UNAVAILABLE_FOR_RECIPIENT",
        });
      }

      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { smsUsedThisTerm: true, prefix: true },
      });

      const quotaPerTerm = await getSmsQuotaForSchool(schoolId);
      const phones = await resolveRecipientPhones(schoolId, recipientType);
      const remaining = quotaPerTerm - school.smsUsedThisTerm;

      if (phones.length > remaining) {
        return res.status(400).json({
          success: false,
          message: `This broadcast would send ${phones.length} SMS but only ${remaining} remain in this term's quota (${school.smsUsedThisTerm}/${quotaPerTerm} used). Reduce the audience, select a plan, or ask Super Admin to raise the quota.`,
          code: "SMS_QUOTA_EXCEEDED",
        });
      }

      if (phones.length === 0) {
        logger.warn("[CREATE_BROADCAST] No phone numbers found for SMS send", { schoolId, recipientType });
      } else {
        const result = await bulkSms.sendSms({
          recipients: phones,
          message: `${title}: ${message}`,
          sender: school.prefix || "SCHOOL",
        });

        if (!result.success) {
          return res.status(502).json({
            success: false,
            message: `BulkSMSNigeria send failed: ${result.message || result.status}`,
            code: "SMS_PROVIDER_ERROR",
          });
        }

        smsSentCount = result.totalSent;
        await prisma.school.update({
          where: { id: schoolId },
          data: { smsUsedThisTerm: { increment: smsSentCount } },
        });
      }
    }

    const broadcast = await prisma.broadcast.create({
      data: {
        schoolId,
        title,
        message,
        category,
        recipientType,
        smsEnabled: !!sendSms,
        totalRecipients,
        smsSentCount,
        createdByAdminId: adminId,
      },
    });

    logger.info("[CREATE_BROADCAST] Broadcast sent", { broadcastId: broadcast.id, smsSentCount, totalRecipients });

    res.status(201).json({
      success: true,
      message: sendSms
        ? `Notice sent — ${smsSentCount} SMS delivered to ${totalRecipients} recipients`
        : "Notice sent (in-app only)",
      data: broadcast,
    });
  } catch (err) {
    logger.error("[CREATE_BROADCAST] Failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/broadcasts
 * Notice history for this school.
 */
exports.getBroadcasts = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));

    const [broadcasts, total] = await Promise.all([
      prisma.broadcast.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.broadcast.count({ where: { schoolId } }),
    ]);

    res.status(200).json({
      success: true,
      data: broadcasts.map((b) => ({
        id: b.id,
        title: b.title,
        message: b.message,
        recipientType: b.recipientType,
        category: b.category,
        sentAt: b.createdAt,
        status: "sent",
        // No in-app read-tracking yet — meaningful once Parent/Student portals exist
        readCount: 0,
        totalRecipients: b.totalRecipients,
        smsEnabled: b.smsEnabled,
        smsSentCount: b.smsSentCount,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("[GET_BROADCASTS] Failed", { error: err.message });
    next(err);
  }
};
