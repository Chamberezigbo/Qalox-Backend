const PromotionService = require("../../Services/PromotionService");

/**
 * End-of-session promotion. Head admins only: it moves many students at once and
 * changes which class their records belong to going forward.
 */

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Service errors carry their own status; everything else goes to the error middleware. */
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};

exports.getPolicy = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await PromotionService.getPolicy(req.schoolId) });
});

exports.savePolicy = handle(async (req, res) => {
  const { basis } = req.body ?? {};
  const raw = req.body?.trialMargin;
  // null (or "") switches the trial outcome off.
  const trialMargin = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  const data = await PromotionService.savePolicy(req.schoolId, { basis, trialMargin });
  res.status(200).json({ success: true, message: "Promotion policy saved", data });
});

/** GET /api/admin/promotion/overview?fromSessionId= — every class and where it stands. */
exports.overview = handle(async (req, res) => {
  const fromSessionId = toId(req.query.fromSessionId);
  if (!fromSessionId) return res.status(400).json({ success: false, message: "fromSessionId is required" });
  const data = await PromotionService.schoolOverview({ schoolId: req.schoolId, fromSessionId });
  res.status(200).json({ success: true, data });
});

/** GET /api/admin/promotion/preview?classId=&fromSessionId= */
exports.preview = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  const fromSessionId = toId(req.query.fromSessionId);
  if (!classId || !fromSessionId) {
    return res.status(400).json({ success: false, message: "classId and fromSessionId are required" });
  }
  const data = await PromotionService.previewClass({ schoolId: req.schoolId, classId, fromSessionId });
  res.status(200).json({ success: true, data });
});

/**
 * POST /api/admin/promotion/apply
 * Body: { classId, fromSessionId, toSessionId, decisions: [{ studentId, outcome, toClassId?, toGroupId?, reason?, average? }] }
 */
exports.apply = handle(async (req, res) => {
  const classId = toId(req.body?.classId);
  const fromSessionId = toId(req.body?.fromSessionId);
  const toSessionId = toId(req.body?.toSessionId);
  if (!classId || !fromSessionId || !toSessionId) {
    return res.status(400).json({ success: false, message: "classId, fromSessionId and toSessionId are required" });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      success: false,
      message: "Promotion needs confirm: true. Review the list first.",
      code: "NOT_CONFIRMED",
    });
  }

  const decisions = (Array.isArray(req.body?.decisions) ? req.body.decisions : []).map((d) => ({
    studentId: toId(d.studentId),
    outcome: d.outcome,
    toClassId: d.toClassId ? toId(d.toClassId) : undefined,
    toGroupId: d.toGroupId ? toId(d.toGroupId) : undefined,
    reason: d.reason,
    average: d.average,
  }));
  if (decisions.some((d) => d.studentId === null)) {
    return res.status(400).json({ success: false, message: "Every decision needs a studentId" });
  }

  const data = await PromotionService.applyPromotion({
    schoolId: req.schoolId,
    adminId: req.user?.id,
    classId,
    fromSessionId,
    toSessionId,
    decisions,
  });
  res.status(200).json({ success: true, message: "Promotion applied", data });
});

exports.listRuns = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await PromotionService.listRuns(req.schoolId) });
});

exports.undo = handle(async (req, res) => {
  const runId = toId(req.params.id);
  if (!runId) return res.status(400).json({ success: false, message: "Invalid promotion id" });
  const data = await PromotionService.undoRun({ schoolId: req.schoolId, runId });
  res.status(200).json({ success: true, message: "Promotion undone", data });
});
