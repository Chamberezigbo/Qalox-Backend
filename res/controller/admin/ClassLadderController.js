const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { effectivePassMark, suggestLadder, validateLadder } = require("../../util/classLadder");

/**
 * The class ladder and pass marks: which class each class's students move up to,
 * and the score they need to pass. Read with suggestions, saved after review.
 * Nothing here moves a student; promotion itself is a later step.
 */

/**
 * GET /api/admin/class-ladder
 * Every class of the school with what is saved, what would be suggested from the
 * name, and the pass mark that applies.
 */
exports.getClassLadder = async (req, res, next) => {
  try {
    const classes = await prisma.class.findMany({
      where: { schoolId: req.schoolId },
      select: {
        id: true,
        name: true,
        customName: true,
        campusId: true,
        promotesToClassId: true,
        passMark: true,
        campus: { select: { name: true } },
        _count: { select: { students: { where: { status: "active" } } } },
      },
      orderBy: [{ campusId: "asc" }, { id: "asc" }],
    });

    const suggestions = suggestLadder(classes);

    res.status(200).json({
      success: true,
      data: classes.map((c) => {
        const suggestion = suggestions.get(c.id) ?? null;
        return {
          id: c.id,
          name: c.name,
          customName: c.customName,
          campusId: c.campusId,
          campusName: c.campus?.name ?? null,
          studentCount: c._count.students,
          promotesToClassId: c.promotesToClassId,
          passMark: c.passMark,
          effectivePassMark: effectivePassMark(c),
          // Only offered where nothing is saved yet, or where it differs from what is.
          suggestion,
          isSet: c.promotesToClassId != null,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/admin/class-ladder
 * Body: { classes: [{ classId, promotesToClassId: number | null, passMark: number | null }] }
 * Saves what the admin confirmed. A class not named is left as it is.
 */
exports.saveClassLadder = async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body?.classes) ? req.body.classes : null;
    if (!entries || entries.length === 0) {
      return res.status(400).json({ success: false, message: "classes is required" });
    }

    const parsed = [];
    for (const entry of entries) {
      const classId = Number(entry.classId);
      if (!Number.isInteger(classId) || classId <= 0) {
        return res.status(400).json({ success: false, message: "Every entry needs a classId" });
      }

      const next = entry.promotesToClassId;
      const promotesToClassId = next === null || next === undefined || next === "" ? null : Number(next);
      if (promotesToClassId !== null && (!Number.isInteger(promotesToClassId) || promotesToClassId <= 0)) {
        return res.status(400).json({ success: false, message: "promotesToClassId must be a class id or null" });
      }

      const mark = entry.passMark;
      const passMark = mark === null || mark === undefined || mark === "" ? null : Number(mark);
      if (passMark !== null && (!Number.isFinite(passMark) || passMark < 0 || passMark > 100)) {
        return res.status(400).json({ success: false, message: "Pass mark must be between 0 and 100" });
      }

      parsed.push({ classId, promotesToClassId, passMark });
    }

    const schoolClasses = await prisma.class.findMany({
      where: { schoolId: req.schoolId },
      select: { id: true, name: true, campusId: true, promotesToClassId: true },
    });

    // Same school, same campus, no loops — see validateLadder.
    const problem = validateLadder(schoolClasses, parsed);
    if (problem) return res.status(400).json({ success: false, message: problem });

    await prisma.$transaction(
      parsed.map((p) =>
        prisma.class.updateMany({
          where: { id: p.classId, schoolId: req.schoolId },
          data: { promotesToClassId: p.promotesToClassId, passMark: p.passMark },
        })
      )
    );

    logger.info("[CLASS_LADDER] Saved", { schoolId: req.schoolId, classes: parsed.length, actorId: req.user?.id ?? null });
    res.status(200).json({ success: true, message: "Class ladder saved", data: { saved: parsed.length } });
  } catch (error) {
    next(error);
  }
};
