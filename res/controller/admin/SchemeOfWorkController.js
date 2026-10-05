const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const SchemeOfWorkService = require("../../Services/SchemeOfWorkService");
const { getAiCreditsStatusForSchool } = require("../../util/getAiCreditsAllowanceForSchool");

/**
 * Scheme of Work management for school admins. The uploaded document is what
 * grounds AI lesson-note and exam-question generation, so one active document
 * per class + subject + term is the unit teachers generate against.
 */

/**
 * POST /api/admin/scheme-of-work
 * multipart: files[] (one PDF, or up to 10 page photos) + classId, subjectId,
 * academicTermId, title
 */
exports.uploadSchemeOfWork = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { classId, subjectId, academicTermId, title, replaceExisting } = req.body;

    if (!classId || !subjectId) {
      return res.status(400).json({
        success: false,
        message: "classId and subjectId are required",
        code: "INVALID_REQUEST",
      });
    }

    // A scheme of work is almost always for the term in progress, and listing
    // terms is a Super-Admin-only route, so the active term is resolved here
    // rather than made the admin's problem. An explicit academicTermId still
    // wins, for uploading next term's scheme ahead of time.
    let termId = academicTermId ? Number(academicTermId) : null;
    if (!termId) {
      const activeTerm = await prisma.academicTerm.findFirst({
        where: { schoolId, isActive: true },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!activeTerm) {
        return res.status(400).json({
          success: false,
          message: "No active term is set for this school. Activate a term first, or pass academicTermId.",
          code: "NO_ACTIVE_TERM",
        });
      }
      termId = activeTerm.id;
    }

    const scheme = await SchemeOfWorkService.createSchemeOfWork({
      schoolId,
      classId: Number(classId),
      subjectId: Number(subjectId),
      academicTermId: termId,
      title,
      files: req.files || [],
      uploadedByAdminId: req.user?.id,
      // Multipart form values arrive as strings, so a plain truthiness check
      // would treat "false" as true.
      replaceExisting: replaceExisting === "true" || replaceExisting === true,
    });

    return res.status(201).json({
      success: true,
      message: "Scheme of work uploaded",
      data: scheme,
    });
  } catch (err) {
    logger.error("[SCHEME_OF_WORK] Upload failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/scheme-of-work
 * Optional filters: classId, subjectId, academicTermId, includeArchived
 */
exports.listSchemesOfWork = async (req, res, next) => {
  try {
    const { classId, subjectId, academicTermId, includeArchived } = req.query;

    const schemes = await SchemeOfWorkService.listSchemesOfWork(req.schoolId, {
      classId,
      subjectId,
      academicTermId,
      includeArchived: includeArchived === "true",
    });

    return res.status(200).json({ success: true, data: schemes });
  } catch (err) {
    logger.error("[SCHEME_OF_WORK] List failed", { error: err.message });
    next(err);
  }
};

/** GET /api/admin/scheme-of-work/:id */
exports.getSchemeOfWork = async (req, res, next) => {
  try {
    const scheme = await SchemeOfWorkService.getSchemeOfWork(req.schoolId, Number(req.params.id));
    return res.status(200).json({ success: true, data: scheme });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/admin/scheme-of-work/:id */
exports.deleteSchemeOfWork = async (req, res, next) => {
  try {
    const result = await SchemeOfWorkService.deleteSchemeOfWork(req.schoolId, Number(req.params.id));
    return res.status(200).json({ success: true, message: "Scheme of work deleted", data: result });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/ai/credits
 * Powers the credit meter so the UI can warn (or disable the action) before
 * an admin or teacher spends a request they can't afford. Mirrors the shape
 * of GET /admin/sms/quota.
 */
exports.getAiCredits = async (req, res, next) => {
  try {
    const status = await getAiCreditsStatusForSchool(req.schoolId);
    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
};
