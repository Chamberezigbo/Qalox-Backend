const Workflow = require("../../Services/ResultWorkflowService");
const prisma = require("../../util/prisma");
const { parseScope } = require("../../util/resultScope");
const { sendPdf } = require("../../util/sendPdf");
const { buildReportCardsPdf, buildBroadsheetPdf } = require("../../util/reportCardPdf");
const AssessmentServiceModule = require("../../Services/AssessmentService");

/**
 * The class teacher's side of the result workflow: review the subjects that
 * teachers submit, compile the class, send it to the admin.
 *
 * Who the teacher is, and which school, come from the verified token only.
 * Whether they are THIS class's teacher is checked in the service, on every call.
 */

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const handle = (fn) => async (req, res, next) => {
  try {
    if (!req.staffId || !req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });
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

const badRequest = (res, message) => res.status(400).json({ success: false, message });

exports.myClasses = handle(async (req, res) => {
  const data = await Workflow.classesForClassTeacher({ schoolId: req.schoolId, staffId: req.staffId });
  res.json({ success: true, data });
});

exports.overview = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  if (!classId) return badRequest(res, "classId is required");
  const data = await Workflow.classOverview({
    schoolId: req.schoolId, staffId: req.staffId, classId,
    classGroupId: parseScope(req.query.classGroupId), termId: toId(req.query.termId) ?? undefined,
  });
  res.json({ success: true, data });
});

exports.accept = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return badRequest(res, "Invalid submission");
  const data = await Workflow.acceptSubmission({ schoolId: req.schoolId, staffId: req.staffId, submissionId: id });
  res.json({ success: true, message: "Subject accepted", data });
});

exports.returnSubmission = handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return badRequest(res, "Invalid submission");
  const data = await Workflow.returnSubmission({
    schoolId: req.schoolId, staffId: req.staffId, submissionId: id, comment: req.body?.comment,
  });
  res.json({ success: true, message: "Returned to the subject teacher", data });
});

exports.remarks = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  if (!classId) return badRequest(res, "classId is required");
  const data = await Workflow.listRemarks({
    schoolId: req.schoolId, staffId: req.staffId, classId,
    classGroupId: parseScope(req.query.classGroupId), termId: toId(req.query.termId) ?? undefined,
  });
  res.json({ success: true, data });
});

exports.saveRemarks = handle(async (req, res) => {
  const classId = toId(req.body?.classId);
  if (!classId) return badRequest(res, "classId is required");
  const data = await Workflow.saveRemarks({
    schoolId: req.schoolId, staffId: req.staffId, classId,
    classGroupId: parseScope(req.body?.classGroupId), termId: toId(req.body?.termId) ?? undefined,
    remarks: req.body?.remarks,
  });
  res.json({ success: true, message: "Remarks saved", data });
});

exports.submit = handle(async (req, res) => {
  const classId = toId(req.body?.classId);
  if (!classId) return badRequest(res, "classId is required");
  const data = await Workflow.submitCompilation({
    schoolId: req.schoolId, staffId: req.staffId, classId,
    classGroupId: parseScope(req.body?.classGroupId),
    termId: toId(req.body?.termId) ?? undefined,
    // Strictly true: anything else must not skip the missing-results check.
    acknowledgeMissing: req.body?.acknowledgeMissing === true,
  });
  res.status(201).json({ success: true, message: "Class results submitted to the admin", data });
});

/** The class as one broadsheet, for the subjects that count. Class teacher only. */
exports.broadsheet = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  if (!classId) return badRequest(res, "classId is required");
  const classGroupId = parseScope(req.query.classGroupId);
  const overview = await Workflow.classOverview({
    schoolId: req.schoolId, staffId: req.staffId, classId, classGroupId, termId: toId(req.query.termId) ?? undefined,
  });
  const counted = overview.subjects.filter((s) => ["accepted", "own", "published"].includes(s.state)).map((s) => s.subjectId);
  if (counted.length === 0) return res.json({ success: true, data: null });

  const data = await new AssessmentServiceModule.AssessmentService().computeBroadsheet({
    classId, schoolId: req.schoolId, academicSessionId: overview.academicSessionId,
    subjectIds: counted, termId: overview.termId, classGroupId: classGroupId === 0 ? null : classGroupId,
  });
  res.json({ success: true, data });
});

/** A draft report card: only the subjects that count, so it matches what will be approved. */
exports.studentReportCard = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  const studentId = toId(req.params.studentId);
  if (!classId || !studentId) return badRequest(res, "classId and a student are required");

  const classGroupId = parseScope(req.query.classGroupId);
  const overview = await Workflow.classOverview({
    schoolId: req.schoolId, staffId: req.staffId, classId, classGroupId, termId: toId(req.query.termId) ?? undefined,
  });
  const counted = overview.subjects.filter((s) => ["accepted", "own", "published"].includes(s.state)).map((s) => s.subjectId);

  // Only a student of the class teacher's own group: another group's card is not theirs to see.
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId: req.schoolId, classId },
    select: { classGroupId: true },
  });
  if (!student || (student.classGroupId ?? 0) !== classGroupId) {
    return res.status(403).json({ success: false, message: "This student is not in your group", code: "NOT_YOUR_STUDENT" });
  }

  const data = await new AssessmentServiceModule.AssessmentService().getStudentCompleteResult({
    studentId, schoolId: req.schoolId, academicSessionId: overview.academicSessionId,
    termId: overview.termId, subjectIds: counted, expectClassId: classId,
  });
  res.json({ success: true, data });
});

const COUNTED = ["accepted", "own", "published"];

/**
 * Every student of the class teacher's group as one PDF, a card per page, with
 * the subjects that count (accepted plus their own). `?inline=1` opens it in the
 * viewer so it can be printed.
 */
exports.reportCardsPdf = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  if (!classId) return badRequest(res, "classId is required");
  const classGroupId = parseScope(req.query.classGroupId);
  const overview = await Workflow.classOverview({
    schoolId: req.schoolId, staffId: req.staffId, classId, classGroupId, termId: toId(req.query.termId) ?? undefined,
  });
  const subjectIds = overview.subjects.filter((s) => COUNTED.includes(s.state)).map((s) => s.subjectId);
  if (subjectIds.length === 0) return res.status(409).json({ success: false, message: "No subject has been accepted yet, so there are no report cards to print." });

  const cards = await Workflow.classReportCards({
    schoolId: req.schoolId, classId, classGroupId, sessionId: overview.academicSessionId, termId: overview.termId, subjectIds,
  });
  const pdf = await buildReportCardsPdf(cards);
  sendPdf(res, pdf, `report-cards-${overview.label}-${overview.termName}`, { inline: req.query.inline === "1" });
});

/** The class teacher's group as a landscape broadsheet. */
exports.broadsheetPdf = handle(async (req, res) => {
  const classId = toId(req.query.classId);
  if (!classId) return badRequest(res, "classId is required");
  const classGroupId = parseScope(req.query.classGroupId);
  const overview = await Workflow.classOverview({
    schoolId: req.schoolId, staffId: req.staffId, classId, classGroupId, termId: toId(req.query.termId) ?? undefined,
  });
  const subjectIds = overview.subjects.filter((s) => COUNTED.includes(s.state)).map((s) => s.subjectId);
  if (subjectIds.length === 0) return res.status(409).json({ success: false, message: "No subject has been accepted yet, so there is no broadsheet to print." });

  const sheet = await new AssessmentServiceModule.AssessmentService().computeBroadsheet({
    classId, schoolId: req.schoolId, academicSessionId: overview.academicSessionId, subjectIds,
    termId: overview.termId, classGroupId: classGroupId === 0 ? null : classGroupId,
  });
  const pdf = await buildBroadsheetPdf(
    { title: `Class Broadsheet — ${overview.label}`, subtitle: `${overview.termName} (draft: accepted subjects only)` },
    sheet
  );
  sendPdf(res, pdf, `broadsheet-${overview.label}-${overview.termName}`, { inline: req.query.inline === "1" });
});
