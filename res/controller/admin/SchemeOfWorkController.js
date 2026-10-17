const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const SchemeOfWorkService = require("../../Services/SchemeOfWorkService");
const { getAiCreditsStatusForSchool } = require("../../util/getAiCreditsAllowanceForSchool");
const campusScope = require("../../util/campusScope");

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

    // The class has to be one this admin can reach.
    await campusScope.assertClassInScope(req, classId, prisma);

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
      classScope: campusScope.classWhere(req),
    });

    return res.status(200).json({ success: true, data: schemes });
  } catch (err) {
    logger.error("[SCHEME_OF_WORK] List failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/scheme-of-work/terms
 * The school's terms, for choosing which one a scheme is for.
 *
 * The full terms route (/admin/terms) is head-admin only, so a sub-admin who is
 * allowed to upload schemes could not see what to choose. This is read-only and
 * returns just what a picker needs. Current session first, then the others.
 */
exports.listTermsForSchemes = async (req, res, next) => {
  try {
    const terms = await prisma.academicTerm.findMany({
      where: { schoolId: req.schoolId },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true,
        session: { select: { id: true, name: true, isActive: true } },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    const shaped = terms
      .map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        sessionId: t.session.id,
        sessionName: t.session.name,
        sessionIsActive: t.session.isActive,
      }))
      // Active term, then the rest of the active session, then older sessions.
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.sessionIsActive) - Number(a.sessionIsActive));

    return res.status(200).json({ success: true, data: shaped });
  } catch (err) {
    next(err);
  }
};

/** GET /api/admin/scheme-of-work/:id */
exports.getSchemeOfWork = async (req, res, next) => {
  try {
    const scheme = await SchemeOfWorkService.getSchemeOfWork(req.schoolId, Number(req.params.id), campusScope.classWhere(req));
    return res.status(200).json({ success: true, data: scheme });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/admin/scheme-of-work/:id */
exports.deleteSchemeOfWork = async (req, res, next) => {
  try {
    const result = await SchemeOfWorkService.deleteSchemeOfWork(req.schoolId, Number(req.params.id), campusScope.classWhere(req));
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
