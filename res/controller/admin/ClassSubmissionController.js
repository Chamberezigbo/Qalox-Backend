const Workflow = require("../../Services/ResultWorkflowService");
const { sendPdf } = require("../../util/sendPdf");
const { buildReportCardsPdf, buildBroadsheetPdf } = require("../../util/reportCardPdf");
const campusScope = require("../../util/campusScope");

/**
 * The admin's side of the result workflow: complete class results from class
 * teachers to approve or return, not individual subject sheets.
 *
 * Approving publishes through the existing publish step, so it needs the same
 * permission as publishing (RESULTS_GENERATE); reading the queue needs
 * RESULTS_MANAGE. Both are applied on the routes.
 */

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const handle = (fn) => async (req, res, next) => {
  try {
    if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });
    await fn(req, res);
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.code && { code: error.code }),
        ...(error.details && { data: error.details }),
      });
    }
    next(error);
  }
};

exports.list = handle(async (req, res) => {
  campusScope.assertCampusAllowed(req, req.query.campusId);
  const data = await Workflow.listCompilations({
    classScope: campusScope.classWhere(req),
    schoolId: req.schoolId,
    status: ["SUBMITTED", "RETURNED", "APPROVED"].includes(req.query.status) ? req.query.status : undefined,
    campusId: toId(req.query.campusId) ?? undefined,
    classId: toId(req.query.classId) ?? undefined,
    termId: toId(req.query.termId) ?? undefined,
  });
  res.json({ success: true, data });
});

exports.get = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "Invalid class submission" });
  res.json({ success: true, data: await Workflow.getCompilation({ schoolId: req.schoolId, id, classScope: campusScope.classWhere(req) }) });
});

exports.approve = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "Invalid class submission" });
  const data = await Workflow.approveCompilation({ schoolId: req.schoolId, adminId: req.user?.id, id, classScope: campusScope.classWhere(req) });
  // Some subjects failing is not a server fault: the admin retries, and nothing is half-marked approved.
  res.status(data.approved ? 200 : 207).json({
    success: data.approved,
    message: data.approved ? "Class results approved and published" : "Some subjects could not be published. Nothing was marked approved; try again.",
    data,
  });
});

exports.returnToClassTeacher = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "Invalid class submission" });
  const data = await Workflow.returnCompilation({
    schoolId: req.schoolId, adminId: req.user?.id, id, comment: req.body?.comment, classScope: campusScope.classWhere(req),
  });
  res.json({ success: true, message: "Returned to the class teacher", data });
});

exports.classesWithoutTeacher = handle(async (req, res) => {
  res.json({ success: true, data: await Workflow.classesWithoutClassTeacher({ schoolId: req.schoolId, classScope: campusScope.classWhere(req) }) });
});

/** The principal's remark for students, set by the admin. */
exports.savePrincipalRemarks = handle(async (req, res) => {
  const data = await Workflow.savePrincipalRemarks({
    schoolId: req.schoolId, adminId: req.user?.id, termId: toId(req.body?.termId) ?? undefined, remarks: req.body?.remarks,
    studentScope: campusScope.studentWhere(req),
  });
  res.json({ success: true, message: "Remarks saved", data });
});

/** Any class's students with their remarks, for the admin to write principal's remarks. */
exports.listPrincipalRemarks = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  if (!classId) return res.status(400).json({ success: false, message: "classId is required" });
  const hasGroup = req.query.classGroupId !== undefined && req.query.classGroupId !== "";
  const data = await Workflow.listPrincipalRemarks({
    schoolId: req.schoolId, classId,
    classGroupId: hasGroup ? Number(req.query.classGroupId) || 0 : undefined,
    termId: toId(req.query.termId) ?? undefined,
    classScope: campusScope.classWhere(req),
    studentScope: campusScope.studentWhere(req),
  });
  res.json({ success: true, data });
});

const scopeTitle = (d) => `${d.class.customName ? `${d.class.name} — ${d.class.customName}` : d.class.name}${d.groupName ? ` — ${d.groupName}` : ""}`;
const COUNTED = ["accepted", "own", "published"];

/** Every report card of a submitted class (or group), a card per page. */
exports.reportCardsPdf = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "Invalid class submission" });
  const d = await Workflow.getCompilation({ schoolId: req.schoolId, id, classScope: campusScope.classWhere(req) });
  const subjectIds = d.subjects.filter((s) => COUNTED.includes(s.state)).map((s) => s.subjectId);
  if (subjectIds.length === 0) return res.status(409).json({ success: false, message: "No subject has been accepted, so there are no report cards." });

  const cards = await Workflow.classReportCards({
    schoolId: req.schoolId, classId: d.class.id, classGroupId: d.classGroupId,
    sessionId: d.academicSessionId, termId: d.termId, subjectIds,
  });
  sendPdf(res, await buildReportCardsPdf(cards), `report-cards-${scopeTitle(d)}`, { inline: req.query.inline === "1" });
});

/** A submitted class (or group) as a landscape broadsheet. */
exports.broadsheetPdf = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "Invalid class submission" });
  const d = await Workflow.getCompilation({ schoolId: req.schoolId, id, classScope: campusScope.classWhere(req) });
  if (!d.broadsheet) return res.status(409).json({ success: false, message: "No subject has been accepted, so there is no broadsheet." });
  const pdf = await buildBroadsheetPdf({ title: `Class Broadsheet — ${scopeTitle(d)}`, subtitle: `Round ${d.round}` }, d.broadsheet);
  sendPdf(res, pdf, `broadsheet-${scopeTitle(d)}`, { inline: req.query.inline === "1" });
});
