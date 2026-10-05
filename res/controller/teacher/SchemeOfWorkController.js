const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const SchemeOfWorkService = require("../../Services/SchemeOfWorkService");

/**
 * Scheme of Work management for teachers.
 *
 * Admins can upload for any class in the school; a teacher is confined to the
 * class + subject pairs they are actually assigned to teach. Both write to the
 * same table, and the same one-active-document-per-class+subject+term rule
 * applies to both — see SchemeOfWorkService.createSchemeOfWork.
 */

/** A teacher may only touch a class+subject they actually teach. */
async function assertTeaches(staffId, classId, subjectId) {
  const taught = await prisma.teacherAssignment.findFirst({
    where: { staffId, classId, subjectId },
  });
  if (!taught) {
    const error = new Error("You do not teach this subject in this class");
    error.statusCode = 403;
    throw error;
  }
}

/** Every class+subject pair this teacher is assigned, for scoping list queries. */
async function taughtPairs(staffId) {
  return prisma.teacherAssignment.findMany({
    where: { staffId },
    select: { classId: true, subjectId: true },
  });
}

/**
 * Resolves the term a scheme belongs to. Teachers have no term-management UI,
 * so this is always the active term — unlike the admin route, which accepts an
 * explicit academicTermId for uploading next term's scheme ahead of time.
 */
async function resolveActiveTermId(schoolId) {
  const activeTerm = await prisma.academicTerm.findFirst({
    where: { schoolId, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return activeTerm?.id ?? null;
}

/**
 * POST /api/teacher/scheme-of-work
 * multipart: files[] (one PDF, or up to 10 page photos)
 * body: classId, subjectId, title, replaceExisting?
 */
exports.uploadSchemeOfWork = async (req, res, next) => {
  try {
    const staffId = req.staffId;
    const schoolId = req.schoolId;
    const { classId, subjectId, title, replaceExisting } = req.body;

    if (!classId || !subjectId) {
      return res.status(400).json({
        success: false,
        message: "classId and subjectId are required",
        code: "INVALID_REQUEST",
      });
    }

    await assertTeaches(staffId, Number(classId), Number(subjectId));

    const termId = await resolveActiveTermId(schoolId);
    if (!termId) {
      return res.status(400).json({
        success: false,
        message: "No active term is set for your school. Ask your admin to activate one first.",
        code: "NO_ACTIVE_TERM",
      });
    }

    const scheme = await SchemeOfWorkService.createSchemeOfWork({
      schoolId,
      classId: Number(classId),
      subjectId: Number(subjectId),
      academicTermId: termId,
      title,
      files: req.files || [],
      uploadedByStaffId: staffId,
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
    logger.error("[TEACHER_SCHEME_OF_WORK] Upload failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/teacher/scheme-of-work
 * Every scheme for the classes this teacher teaches — including ones uploaded
 * by an admin or a colleague, since those are what their generations will be
 * grounded in.
 */
exports.listSchemesOfWork = async (req, res, next) => {
  try {
    const pairs = await taughtPairs(req.staffId);
    if (pairs.length === 0) return res.status(200).json({ success: true, data: [] });

    const schemes = await prisma.schemeOfWork.findMany({
      where: {
        schoolId: req.schoolId,
        status: "active",
        OR: pairs.map(({ classId, subjectId }) => ({ classId, subjectId })),
      },
      include: {
        files: { orderBy: { order: "asc" } },
        class: { select: { id: true, name: true, customName: true } },
        subject: { select: { id: true, name: true } },
        academicTerm: { select: { id: true, name: true } },
        uploadedByStaff: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // extractedText is large and no list view needs it; hasText is the only
    // part the UI cares about (it gates the Generate action).
    const data = await Promise.all(
      schemes.map(async ({ extractedText, ...rest }) => ({
        ...(await SchemeOfWorkService.withResolvedFiles(rest)),
        hasText: Boolean(extractedText?.trim()),
        isMine: rest.uploadedByStaffId === req.staffId,
      }))
    );

    return res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error("[TEACHER_SCHEME_OF_WORK] List failed", { error: err.message });
    next(err);
  }
};

/** GET /api/teacher/scheme-of-work/:id */
exports.getSchemeOfWork = async (req, res, next) => {
  try {
    const scheme = await SchemeOfWorkService.getSchemeOfWork(req.schoolId, Number(req.params.id));
    await assertTeaches(req.staffId, scheme.classId, scheme.subjectId);
    return res.status(200).json({ success: true, data: scheme });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/teacher/scheme-of-work/:id
 * Only a teacher's own upload. An admin's document, or a colleague's, is not
 * theirs to remove — replacing is the supported way to supersede one.
 */
exports.deleteSchemeOfWork = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const scheme = await prisma.schemeOfWork.findFirst({
      where: { id, schoolId: req.schoolId },
      select: { id: true, uploadedByStaffId: true },
    });

    if (!scheme) {
      return res.status(404).json({
        success: false,
        message: "Scheme of work not found",
        code: "SCHEME_OF_WORK_NOT_FOUND",
      });
    }

    if (scheme.uploadedByStaffId !== req.staffId) {
      return res.status(403).json({
        success: false,
        message: "You can only delete a scheme of work you uploaded yourself.",
        code: "NOT_YOUR_UPLOAD",
      });
    }

    const result = await SchemeOfWorkService.deleteSchemeOfWork(req.schoolId, id);
    return res.status(200).json({ success: true, message: "Scheme of work deleted", data: result });
  } catch (err) {
    next(err);
  }
};
