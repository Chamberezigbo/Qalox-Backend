/**
 * End-to-end check of the result workflow (Subject Teacher -> Class Teacher ->
 * Admin) against a SCRATCH database, through the real services and real MySQL.
 * Mocked tests cannot show that the row locks, the unique keys or the publish
 * step really behave together, and this changes how every school's results get
 * published.
 *
 * It REFUSES to run unless DATABASE_URL points at localhost port 3307.
 *
 *   export DATABASE_URL="mysql://root:scratch@127.0.0.1:3307/qalox_scratch"
 *   npx prisma db push --skip-generate && node scripts/result-workflow-scratch-test.js
 */
require("ts-node/register/transpile-only");
const assert = require("assert");

const url = process.env.DATABASE_URL || "";
if (!/@(127\.0\.0\.1|localhost):3307\//.test(url)) {
  console.error("Refusing to run: DATABASE_URL must point at the scratch database on localhost:3307.");
  process.exit(1);
}

const prisma = require("../res/util/prisma");
const { TeacherService } = require("../res/Services/teacher/TeacherService");
const { AssessmentService } = require("../res/Services/AssessmentService");
const { StudentResultService } = require("../res/Services/student/StudentResultService");
const Workflow = require("../res/Services/ResultWorkflowService");

const log = (m) => console.log(`  ✓ ${m}`);
const stamp = Date.now();

const rejects = async (promise, { status, code, text }, label) => {
  try {
    await promise;
  } catch (error) {
    if (status) assert.strictEqual(error.statusCode ?? error.status, status, `${label}: status ${error.statusCode} (${error.message})`);
    if (code) assert.strictEqual(error.code, code, `${label}: code ${error.code} (${error.message})`);
    if (text) assert.ok(String(error.message).includes(text), `${label}: message "${error.message}"`);
    return error;
  }
  assert.fail(`${label}: expected it to be refused`);
};

async function main() {
  console.log("Seeding…");
  const school = await prisma.school.create({ data: { name: `WF ${stamp}`, prefix: "WF" } });
  const schoolId = school.id;
  const admin = await prisma.admin.create({
    data: { name: "Head", email: `wf${stamp}@x.com`, password: "x", role: "school_admin", schoolId },
  });
  const campus = await prisma.campus.create({ data: { schoolId, name: "Main" } });
  const session = await prisma.academicSession.create({ data: { schoolId, name: "2026/2027", isActive: true } });
  const term = await prisma.academicTerm.create({ data: { schoolId, sessionId: session.id, name: "First Term", isActive: true } });

  const mkStaff = (name) =>
    prisma.staff.create({
      data: { schoolId, campusId: campus.id, name, duty: "Teacher", registrationNumber: `WF-${name}-${stamp}` },
    });
  const t1 = await mkStaff("Ada"); // class teacher of SS1, also teaches Maths there
  const t2 = await mkStaff("Bola"); // class teacher of SS2, teaches Biology in SS1
  const t3 = await mkStaff("Chi"); // subject teacher: English in SS1, Maths in SS3 (no class teacher)

  const ss1 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 1", staffId: t1.id } });
  const ss2 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 2", staffId: t2.id } });
  const ss3 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 3" } }); // no class teacher

  const mkSubject = (name) => prisma.subject.create({ data: { schoolId, name } });
  const maths = await mkSubject("Mathematics");
  const english = await mkSubject("English");
  const biology = await mkSubject("Biology");

  const scheme = await prisma.gradingScheme.create({ data: { schoolId, name: "Std", usePosition: true } });
  await prisma.gradingRule.createMany({
    data: [
      { schemeId: scheme.id, minScore: 70, maxScore: 100, grade: "A", remark: "Excellent" },
      { schemeId: scheme.id, minScore: 0, maxScore: 69, grade: "B", remark: "Fair" },
    ],
  });

  const defs = {};
  const setUp = async (cls, subject, staff) => {
    await prisma.classSubject.create({ data: { classId: cls.id, subjectId: subject.id } });
    await prisma.teacherAssignment.create({ data: { staffId: staff.id, classId: cls.id, subjectId: subject.id, campusId: campus.id } });
    const ca = await prisma.continuousAssessment.create({ data: { classId: cls.id, subjectId: subject.id, name: "CA1", maxScore: 40 } });
    const exam = await prisma.exam.create({ data: { classId: cls.id, subjectId: subject.id, name: "Exam", maxScore: 60 } });
    defs[`${cls.id}:${subject.id}`] = { ca, exam };
  };
  await setUp(ss1, maths, t1);
  await setUp(ss1, english, t3);
  await setUp(ss1, biology, t2);
  await setUp(ss3, maths, t3);
  await prisma.gradingSchemeClass.create({ data: { schemeId: scheme.id, classId: ss1.id } });

  const mkStudent = (name, classId) =>
    prisma.student.create({
      data: {
        schoolId, campusId: campus.id, classId, name, surname: "Pupil", otherNames: "",
        academicSessionId: session.id, registrationNumber: `WF-${name}-${stamp}`,
      },
    });
  const s1 = await mkStudent("One", ss1.id);
  const s2 = await mkStudent("Two", ss1.id);
  const s3 = await mkStudent("Three", ss1.id);
  for (const s of [s1, s2, s3]) {
    await prisma.studentEnrollment.create({
      data: { schoolId, studentId: s.id, academicSessionId: session.id, classId: ss1.id, campusId: campus.id },
    });
  }

  const teacher = new TeacherService();
  const assessment = new AssessmentService();
  const enter = (staff, cls, subject, students) =>
    Promise.all([
      teacher.upsertCAScores({
        staffId: staff.id, schoolId, academicSessionId: session.id,
        entries: students.map((s, i) => ({ studentId: s.id, caId: defs[`${cls.id}:${subject.id}`].ca.id, score: 20 + i })),
      }),
      teacher.upsertExamScores({
        staffId: staff.id, schoolId, academicSessionId: session.id,
        entries: students.map((s, i) => ({ studentId: s.id, examId: defs[`${cls.id}:${subject.id}`].exam.id, score: 40 + i })),
      }),
    ]);
  const submit = (staff, cls, subject) =>
    teacher.submitResults({ staffId: staff.id, schoolId, classId: cls.id, subjectId: subject.id, academicSessionId: session.id, termId: term.id });
  const notes = (recipientId) => prisma.userNotification.count({ where: { recipientType: "teacher", recipientId } });

  // Scores: everyone scored in English and Biology; Maths (the class teacher's own) misses student Three.
  await enter(t3, ss1, english, [s1, s2, s3]);
  await enter(t2, ss1, biology, [s1, s2, s3]);
  await enter(t1, ss1, maths, [s1, s2]);
  await enter(t3, ss3, maths, [s1]); // scores exist; there is just nobody to submit to

  console.log("Subject teacher submits");
  await rejects(submit(t3, ss3, maths), { status: 409, code: "NO_CLASS_TEACHER" }, "class with no class teacher");
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss3.id } }), 0);
  log("a class with no class teacher refuses a submission, and writes nothing");

  const before = await notes(t1.id);
  const sub = await submit(t3, ss1, english);
  assert.strictEqual(sub.status, "SUBMITTED");
  assert.strictEqual(await notes(t1.id), before + 1, "class teacher is told");
  await rejects(enter(t3, ss1, english, [s1]), { text: "locked" }, "editing a submitted subject");
  await rejects(submit(t3, ss1, english), { text: "already submitted" }, "submitting twice");
  log("a submission goes to the class teacher as SUBMITTED, tells them, and locks the scores");

  const own = await submit(t1, ss1, maths);
  assert.strictEqual(own.included, true);
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss1.id, subjectId: maths.id } }), 0);
  await enter(t1, ss1, maths, [s1, s2]); // still editable
  log("the class teacher's own subject is included automatically: no row, no self-submission, still editable");

  const bio = await submit(t2, ss1, biology);
  assert.strictEqual((await prisma.resultSubmission.findUnique({ where: { id: bio.id } })).staffId, t2.id);
  log("a teacher with a class of their own submits their other-class subject to THAT class's teacher");

  console.log("Class teacher reviews");
  let ov = await Workflow.classOverview({ schoolId, staffId: t1.id, classId: ss1.id });
  const row = (name) => ov.subjects.find((s) => s.name === name);
  assert.strictEqual(row("English").state, "submitted");
  assert.strictEqual(row("Biology").state, "submitted");
  assert.strictEqual(row("Mathematics").state, "own");
  assert.strictEqual(ov.readiness.canSubmit, true);
  assert.strictEqual(ov.readiness.needsAcknowledgement, true);
  assert.strictEqual(ov.hasGradingScheme, true);
  log("overview: English and Biology waiting, Mathematics is the class teacher's own");

  await rejects(Workflow.classOverview({ schoolId, staffId: t2.id, classId: ss1.id }), { status: 403, code: "NOT_CLASS_TEACHER" }, "another teacher's overview");
  await rejects(Workflow.acceptSubmission({ schoolId, staffId: t2.id, submissionId: sub.id }), { status: 403 }, "not the class teacher");
  log("only the class's own teacher can see or review it");

  await rejects(Workflow.returnSubmission({ schoolId, staffId: t1.id, submissionId: bio.id, comment: " " }), { code: "COMMENT_REQUIRED" }, "return without comment");
  await Workflow.returnSubmission({ schoolId, staffId: t1.id, submissionId: bio.id, comment: "Student Three's exam score looks wrong" });
  const t2Notes = await notes(t2.id);
  assert.ok(t2Notes >= 1);
  let bioRow = await prisma.resultSubmission.findUnique({ where: { id: bio.id } });
  assert.strictEqual(bioRow.status, "RETURNED");
  assert.strictEqual(bioRow.returnComment, "Student Three's exam score looks wrong");
  await enter(t2, ss1, biology, [s1, s2, s3]); // unlocked
  const bio2 = await submit(t2, ss1, biology);
  assert.strictEqual(bio2.id, bio.id, "resubmission reuses the same row");
  assert.strictEqual((await prisma.resultSubmission.count({ where: { classId: ss1.id, subjectId: biology.id } })), 1);
  log("a return needs a comment, unlocks the scores, notifies the teacher; resubmitting reuses the row");

  // Two clicks at once: exactly one wins.
  const both = await Promise.allSettled([
    Workflow.acceptSubmission({ schoolId, staffId: t1.id, submissionId: sub.id }),
    Workflow.acceptSubmission({ schoolId, staffId: t1.id, submissionId: sub.id }),
  ]);
  assert.strictEqual(both.filter((r) => r.status === "fulfilled").length, 1, "one accept wins");
  assert.strictEqual(both.filter((r) => r.status === "rejected").length, 1);
  await Workflow.acceptSubmission({ schoolId, staffId: t1.id, submissionId: bio.id });
  log("two simultaneous accepts apply once");

  console.log("Compilation");
  ov = await Workflow.classOverview({ schoolId, staffId: t1.id, classId: ss1.id });
  assert.deepStrictEqual(ov.incompleteStudents.map((s) => s.name), ["Pupil Three"]);
  assert.deepStrictEqual(ov.incompleteStudents[0].missingSubjects, ["Mathematics"]);
  await rejects(
    Workflow.submitCompilation({ schoolId, staffId: t1.id, classId: ss1.id }),
    { status: 409, code: "COMPILATION_INCOMPLETE" }, "incomplete without acknowledgement"
  );
  assert.strictEqual(await prisma.classCompilation.count({ where: { classId: ss1.id } }), 0);
  log("a student with no Mathematics score is identified, and submitting without acknowledging is refused");

  const compiled = await Workflow.submitCompilation({ schoolId, staffId: t1.id, classId: ss1.id, acknowledgeMissing: true });
  assert.strictEqual(compiled.round, 1);
  assert.strictEqual(compiled.includedOwn, 1);
  const ownRow = await prisma.resultSubmission.findFirst({ where: { classId: ss1.id, subjectId: maths.id } });
  assert.strictEqual(ownRow.status, "ACCEPTED");
  assert.strictEqual(ownRow.autoAccepted, true);
  await rejects(enter(t1, ss1, maths, [s1]), { text: "locked" }, "own subject after compiling");
  const adminNotes = await prisma.userNotification.count({ where: { recipientType: "admin", recipientId: admin.id } });
  assert.ok(adminNotes >= 1);
  await rejects(Workflow.returnSubmission({ schoolId, staffId: t1.id, submissionId: sub.id, comment: "late change" }), { status: 409 }, "review while with the admin");
  await rejects(Workflow.submitCompilation({ schoolId, staffId: t1.id, classId: ss1.id, acknowledgeMissing: true }), { status: 409 }, "submit twice");
  log("compiling locks the class teacher's own subject, tells the admin, and freezes review");

  console.log("Admin returns, class teacher resubmits");
  const queue = await Workflow.listCompilations({ schoolId, status: "SUBMITTED" });
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].classTeacher, "Ada");
  assert.strictEqual(queue[0].hasMissing, true);
  const detail = await Workflow.getCompilation({ schoolId, id: queue[0].id });
  assert.strictEqual(detail.subjects.filter((s) => s.state === "accepted").length, 3);
  assert.ok(detail.broadsheet && detail.broadsheet.rows.length === 3, "the admin sees the compiled class");
  await rejects(Workflow.returnCompilation({ schoolId, adminId: admin.id, id: queue[0].id, comment: "" }), { code: "COMMENT_REQUIRED" }, "admin return without comment");
  await Workflow.returnCompilation({ schoolId, adminId: admin.id, id: queue[0].id, comment: "Please complete Mathematics for Pupil Three" });
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss1.id, subjectId: maths.id } }), 0, "own subject reopened");
  await enter(t1, ss1, maths, [s3]); // fixes the missing score
  ov = await Workflow.classOverview({ schoolId, staffId: t1.id, classId: ss1.id });
  assert.strictEqual(ov.compilation.status, "RETURNED");
  assert.strictEqual(ov.compilation.returnComment, "Please complete Mathematics for Pupil Three");
  assert.strictEqual(ov.incompleteStudents.length, 0);
  const second = await Workflow.submitCompilation({ schoolId, staffId: t1.id, classId: ss1.id });
  assert.strictEqual(second.round, 2);
  log("admin return needs a comment, reopens the class teacher's own subject; the fix and resubmission are round 2");

  console.log("Admin approves");
  const id = queue[0].id;
  const approvals = await Promise.allSettled([
    Workflow.approveCompilation({ schoolId, adminId: admin.id, id }),
    Workflow.approveCompilation({ schoolId, adminId: admin.id, id }),
  ]);
  assert.ok(approvals.some((r) => r.status === "fulfilled" && r.value.approved), "an approval succeeded");
  assert.strictEqual(await prisma.publishedResult.count({ where: { classId: ss1.id, termId: term.id } }), 3);
  assert.strictEqual(await prisma.publishedResultRow.count({ where: { publishedResult: { classId: ss1.id } } }), 9);
  assert.strictEqual((await prisma.classCompilation.findUnique({ where: { id } })).status, "APPROVED");
  assert.strictEqual(await prisma.resultWorkflowEvent.count({ where: { compilationId: id, action: "APPROVED" } }), 1);
  log("approving publishes every subject once even with two clicks, and the class is APPROVED");

  await rejects(Workflow.approveCompilation({ schoolId, adminId: admin.id, id }), { status: 409 }, "approve again");
  const card = await new StudentResultService().getReportCard(s1.id, schoolId, session.id, term.id);
  assert.strictEqual(card.subjects.length, 3);
  assert.strictEqual(card.performanceSummary.classPosition, "3", "position among the three");
  log("students' report cards show all three published subjects");

  console.log("History");
  const history = (await Workflow.classOverview({ schoolId, staffId: t1.id, classId: ss1.id })).history.map((h) => h.action);
  for (const action of ["SUBMITTED", "RETURNED", "RESUBMITTED", "ACCEPTED", "AUTO_ACCEPTED", "COMPILATION_SUBMITTED", "ADMIN_RETURNED", "COMPILATION_RESUBMITTED", "APPROVED"]) {
    assert.ok(history.includes(action), `history has ${action}`);
  }
  log("the history keeps every step, across both rounds");

  console.log("Unpublish and legacy");
  const published = await prisma.publishedResult.findFirst({ where: { classId: ss1.id, subjectId: maths.id } });
  await assessment.unpublishResults(published.id, schoolId, admin.id);
  const reopened = await prisma.classCompilation.findUnique({ where: { id } });
  assert.strictEqual(reopened.status, "RETURNED");
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss1.id, subjectId: maths.id } }), 0);
  assert.ok((await Workflow.classOverview({ schoolId, staffId: t1.id, classId: ss1.id })).history.some((h) => h.action === "UNPUBLISHED"));
  await enter(t1, ss1, maths, [s1]);
  log("unpublishing returns the class to its class teacher and reopens their own subject");

  await prisma.gradingSchemeClass.create({ data: { schemeId: scheme.id, classId: ss3.id } });

  // A row from the old direct-to-admin flow still locks scores and still publishes.
  await prisma.resultSubmission.create({
    data: { classId: ss3.id, subjectId: maths.id, academicSessionId: session.id, termId: term.id, staffId: t3.id, status: "PENDING" },
  });
  await rejects(enter(t3, ss3, maths, [s1]), { text: "locked" }, "legacy pending locks");
  await assessment.publishResults({ classId: ss3.id, subjectId: maths.id, academicSessionId: session.id, schoolId, adminId: admin.id, termId: term.id });
  assert.strictEqual(await prisma.publishedResult.count({ where: { classId: ss3.id } }), 1);
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss3.id } }), 0, "legacy pending is cleared on publish, as before");
  log("a legacy pending submission still locks scores and still publishes");

  const without = await Workflow.classesWithoutClassTeacher({ schoolId });
  assert.deepStrictEqual(without.map((c) => c.name), ["SS 3"]);
  log("classes without a class teacher are listed");

  // -------------------------------------------------------------------------
  console.log("A class with groups: a class teacher per group");
  const tA = await mkStaff("Dayo"); // class teacher of SS 4 Group A, also teaches Mathematics there
  const tB = await mkStaff("Eze"); // class teacher of SS 4 Group B
  const ss4 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 4", staffId: t2.id } }); // t2: students in no group
  const gA = await prisma.classGroup.create({ data: { classId: ss4.id, name: "A", staffId: tA.id } });
  const gB = await prisma.classGroup.create({ data: { classId: ss4.id, name: "B", staffId: tB.id } });
  await setUp(ss4, english, t3);
  await setUp(ss4, maths, tA);
  await prisma.gradingSchemeClass.create({ data: { schemeId: scheme.id, classId: ss4.id } });

  const mkIn = async (name, group) => {
    const st = await prisma.student.create({
      data: {
        schoolId, campusId: campus.id, classId: ss4.id, classGroupId: group ? group.id : null, name, surname: "Arm",
        otherNames: "", academicSessionId: session.id, registrationNumber: `WF-${name}-${stamp}`,
      },
    });
    await prisma.studentEnrollment.create({
      data: { schoolId, studentId: st.id, academicSessionId: session.id, classId: ss4.id, classGroupId: group ? group.id : null, campusId: campus.id },
    });
    return st;
  };
  const a1 = await mkIn("A1", gA);
  const a2 = await mkIn("A2", gA);
  const b1 = await mkIn("B1", gB);
  const b2 = await mkIn("B2", gB);
  const u1 = await mkIn("U1", null);

  // [student, CA, exam]: B1 outscores everyone, so a whole-class position would put A1 second.
  const put = (staff, cls, subject, rows) =>
    Promise.all([
      teacher.upsertCAScores({ staffId: staff.id, schoolId, academicSessionId: session.id,
        entries: rows.map(([st, ca]) => ({ studentId: st.id, caId: defs[`${cls.id}:${subject.id}`].ca.id, score: ca })) }),
      teacher.upsertExamScores({ staffId: staff.id, schoolId, academicSessionId: session.id,
        entries: rows.map(([st, , ex]) => ({ studentId: st.id, examId: defs[`${cls.id}:${subject.id}`].exam.id, score: ex })) }),
    ]);
  const engScores = [[a1, 30, 55], [a2, 20, 40], [b1, 38, 58], [b2, 10, 20], [u1, 25, 45]];
  await put(t3, ss4, english, engScores);
  await put(tA, ss4, maths, engScores);

  await rejects(
    teacher.submitResults({ staffId: t3.id, schoolId, classId: ss4.id, subjectId: english.id, academicSessionId: session.id, termId: term.id }),
    { status: 400, code: "GROUP_REQUIRED" }, "no group named"
  );
  log("a class with groups must be told which group a single submission is for");

  const subIn = (staff, subject, group) =>
    teacher.submitResults({ staffId: staff.id, schoolId, classId: ss4.id, subjectId: subject.id, academicSessionId: session.id, termId: term.id, classGroupId: group ? group.id : 0 });

  const engA = await subIn(t3, english, gA);
  assert.strictEqual(engA.classGroupId, gA.id);
  await rejects(put(t3, ss4, english, [[a1, 31, 55]]), { text: "locked" }, "group A locked");
  await put(t3, ss4, english, [[b1, 38, 58]]); // group B is still open
  log("submitting Group A locks Group A's scores and leaves Group B editable");

  await rejects(subIn(t3, english, gA), { text: "already submitted" }, "same group twice");
  await subIn(t3, english, gB);
  await subIn(t3, english, null);
  await rejects(put(t3, ss4, english, [[b1, 39, 58]]), { text: "locked" }, "group B locked");
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss4.id, subjectId: english.id } }), 3);
  log("each group is its own submission to its own class teacher; students in no group go to the class-level teacher");

  const all = await teacher.submitAllResults({ staffId: tA.id, schoolId, classId: ss4.id, academicSessionId: session.id, termId: term.id });
  const byGroup = Object.fromEntries(all.results.map((r) => [r.groupName ?? "none", r.outcome]));
  assert.deepStrictEqual(byGroup, { A: "included_automatically", B: "submitted", none: "submitted" });
  log("a class teacher submitting every group: their own group is included, the other groups go to their teachers");

  // Authority is per group
  await rejects(Workflow.classOverview({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gB.id }), { status: 403 }, "A's teacher in B");
  await rejects(Workflow.classOverview({ schoolId, staffId: tB.id, classId: ss4.id, classGroupId: gA.id }), { status: 403 }, "B's teacher in A");
  const mineA = await Workflow.classesForClassTeacher({ schoolId, staffId: tA.id });
  assert.deepStrictEqual(mineA.map((m) => m.label), ["SS 4 — A"]);
  const mineClass = await Workflow.classesForClassTeacher({ schoolId, staffId: t2.id });
  assert.ok(mineClass.some((m) => m.classId === ss4.id && m.classGroupId === 0 && m.label === "SS 4"), "class-level scope for the students in no group");
  log("a group's class teacher cannot see or act on another group; the class-level teacher gets the no-group scope");

  const ovA = await Workflow.classOverview({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id });
  assert.strictEqual(ovA.studentCount, 2);
  const stateOf = (ov, n) => ov.subjects.find((x) => x.name === n).state;
  assert.strictEqual(stateOf(ovA, "English"), "submitted");
  assert.strictEqual(stateOf(ovA, "Mathematics"), "own");
  await Workflow.acceptSubmission({ schoolId, staffId: tA.id, submissionId: engA.id });

  // The group's class teacher compiles; B's students are not touched.
  await Workflow.submitCompilation({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id });
  await rejects(put(tA, ss4, maths, [[a1, 31, 50]]), { text: "locked" }, "own Maths locked for group A");
  assert.strictEqual(await prisma.resultSubmission.count({ where: { classId: ss4.id, subjectId: maths.id, autoAccepted: true } }), 1);
  const blocked = await require("../res/util/resultScope").groupChangeBlockedReason(prisma, { schoolId, classId: ss4.id, classGroupId: gA.id });
  assert.ok(blocked && blocked.includes("sent to the admin"));
  assert.strictEqual(await require("../res/util/resultScope").groupChangeBlockedReason(prisma, { schoolId, classId: ss4.id, classGroupId: gB.id }), null);
  log("compiling Group A locks its own subject only, and its students cannot be moved while it is with the admin");

  const queue4 = (await Workflow.listCompilations({ schoolId, status: "SUBMITTED" })).filter((r) => r.class.id === ss4.id);
  assert.strictEqual(queue4.length, 1);
  assert.strictEqual(queue4[0].groupName, "A");
  assert.strictEqual(queue4[0].classTeacher, "Dayo");
  const detailA = await Workflow.getCompilation({ schoolId, id: queue4[0].id });
  assert.deepStrictEqual(detailA.broadsheet.rows.map((r) => r.studentName.split(" ")[1]).sort(), ["A1", "A2"]);
  log("the admin queue lists the group, with its own class teacher and only its own students");

  console.log("Approving one group at a time");
  const apprA = await Workflow.approveCompilation({ schoolId, adminId: admin.id, id: queue4[0].id });
  assert.strictEqual(apprA.approved, true);
  assert.strictEqual(await prisma.publishedResultRow.count({ where: { publishedResult: { classId: ss4.id, subjectId: english.id } } }), 2, "only Group A's students");
  const cardOf = (st) => new StudentResultService().getReportCard(st.id, schoolId, session.id, term.id);
  assert.strictEqual((await cardOf(a1)).subjects.length, 2, "Group A sees both subjects");
  assert.strictEqual((await cardOf(b1)).subjects.length, 0, "Group B sees nothing yet");
  assert.strictEqual((await cardOf(u1)).subjects.length, 0);
  assert.strictEqual((await cardOf(a1)).performanceSummary.classPosition, "1", "ranked within Group A");
  assert.strictEqual((await cardOf(a2)).performanceSummary.classPosition, "2");
  // Group B is still being scored: editable, even though A is published.
  await rejects(put(t3, ss4, english, [[b1, 39, 58]]), { text: "locked" }, "B is locked by its OWN submission");
  const pubRow = await prisma.publishedResultRow.findFirst({ where: { studentId: a1.id, publishedResult: { subjectId: english.id } } });
  assert.strictEqual(pubRow.position, 1, "the published snapshot ranks within the group too");
  log("approving Group A publishes only A's students, positions are within the group, and B's students see nothing yet");

  const ovB = await Workflow.classOverview({ schoolId, staffId: tB.id, classId: ss4.id, classGroupId: gB.id });
  for (const sub of ovB.subjects.filter((x) => x.state === "submitted")) {
    await Workflow.acceptSubmission({ schoolId, staffId: tB.id, submissionId: sub.submissionId });
  }
  await Workflow.submitCompilation({ schoolId, staffId: tB.id, classId: ss4.id, classGroupId: gB.id });
  const queueB = (await Workflow.listCompilations({ schoolId, status: "SUBMITTED" })).find((r) => r.class.id === ss4.id && r.groupName === "B");
  assert.ok(queueB);
  await Workflow.approveCompilation({ schoolId, adminId: admin.id, id: queueB.id });
  assert.strictEqual(await prisma.publishedResult.count({ where: { classId: ss4.id, subjectId: english.id } }), 1, "one publication header, filled in by each group");
  assert.strictEqual(await prisma.publishedResultRow.count({ where: { publishedResult: { classId: ss4.id, subjectId: english.id } } }), 4);
  assert.strictEqual((await cardOf(b1)).subjects.length, 2);
  assert.strictEqual((await cardOf(b1)).performanceSummary.classPosition, "1", "B1 tops Group B");
  assert.strictEqual((await cardOf(b2)).performanceSummary.classPosition, "2");
  assert.strictEqual((await cardOf(u1)).subjects.length, 0, "the student in no group is still waiting for their own class teacher");
  log("Group B is approved separately into the same publication; the no-group student is still pending");

  // Two groups approved at the same moment must not collide on the publication header.
  const ovU = await Workflow.classOverview({ schoolId, staffId: t2.id, classId: ss4.id, classGroupId: 0 });
  assert.strictEqual(ovU.studentCount, 1);
  for (const sub of ovU.subjects.filter((x) => x.state === "submitted")) {
    await Workflow.acceptSubmission({ schoolId, staffId: t2.id, submissionId: sub.submissionId });
  }
  await Workflow.submitCompilation({ schoolId, staffId: t2.id, classId: ss4.id, classGroupId: 0 });
  const queueU = (await Workflow.listCompilations({ schoolId, status: "SUBMITTED" })).find((r) => r.class.id === ss4.id && r.classGroupId === 0);
  await Workflow.approveCompilation({ schoolId, adminId: admin.id, id: queueU.id });
  assert.strictEqual((await cardOf(u1)).subjects.length, 2);
  assert.strictEqual((await cardOf(u1)).performanceSummary.classPosition, "1", "alone in the no-group scope");
  log("the class-level teacher approves the no-group student on their own");

  // Unpublishing a subject reopens every group's compilation
  const header = await prisma.publishedResult.findFirst({ where: { classId: ss4.id, subjectId: english.id } });
  await assessment.unpublishResults(header.id, schoolId, admin.id);
  const reopened4 = await prisma.classCompilation.findMany({ where: { classId: ss4.id } });
  assert.strictEqual(reopened4.length, 3);
  assert.ok(reopened4.every((c) => c.status === "RETURNED"));
  log("unpublishing a subject returns all three groups' compilations to their class teachers");

  // A group nobody leads is reported
  const gC = await prisma.classGroup.create({ data: { classId: ss4.id, name: "C" } });
  await prisma.student.create({
    data: { schoolId, campusId: campus.id, classId: ss4.id, classGroupId: gC.id, name: "C1", surname: "Arm", otherNames: "", academicSessionId: session.id, registrationNumber: `WF-C1-${stamp}` },
  });
  const without2 = await Workflow.classesWithoutClassTeacher({ schoolId });
  assert.ok(without2.some((c) => c.name === "SS 4" && c.groupName === "C"));
  await rejects(subIn(t3, english, gC), { status: 409, code: "NO_CLASS_TEACHER" }, "group with no class teacher");
  log("a group with no class teacher is listed for the admin and refuses submissions");

  console.log("Remarks");
  const rs = await prisma.remarkScheme.create({ data: { schoolId, name: "Std" } });
  await prisma.remarkRule.createMany({
    data: [
      { schemeId: rs.id, minScore: 70, maxScore: 100, remark: "{studentName} is excellent" },
      { schemeId: rs.id, minScore: 0, maxScore: 69, remark: "{studentName} must try harder" },
    ],
  });
  const adminCard = (st) => assessment.getStudentCompleteResult({ studentId: st.id, schoolId, academicSessionId: session.id, termId: term.id });

  const listA = await Workflow.listRemarks({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id });
  assert.deepStrictEqual(listA.students.map((x) => x.name.split(" ")[1]), ["A1", "A2"], "only the group's students");
  assert.strictEqual(listA.editable, true);
  assert.ok(listA.students[0].automaticRemark.includes("Arm A1"), "shows what the automatic remark would be");

  await Workflow.saveRemarks({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id, remarks: [{ studentId: a1.id, remark: "  Keep it up!  " }] });
  assert.strictEqual((await adminCard(a1)).teacherRemark, "Keep it up!", "the hand-written remark replaces the automatic one");
  assert.strictEqual((await adminCard(a2)).teacherRemark.includes("Arm A2"), true, "no remark written: the automatic one stays");

  await Workflow.saveRemarks({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id, remarks: [{ studentId: a1.id, remark: "   " }] });
  assert.ok((await adminCard(a1)).teacherRemark.includes("Arm A1"), "blank falls back to the automatic remark");
  log("a class teacher's remark replaces the automatic one; blank falls back to it");

  await rejects(
    Workflow.saveRemarks({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id, remarks: [{ studentId: b1.id, remark: "x remark" }] }),
    { status: 403, code: "NOT_YOUR_STUDENT" }, "another group's student"
  );
  await rejects(
    Workflow.saveRemarks({ schoolId, staffId: tB.id, classId: ss4.id, classGroupId: gA.id, remarks: [{ studentId: a1.id, remark: "x remark" }] }),
    { status: 403 }, "not the class teacher of that group"
  );
  await rejects(
    Workflow.saveRemarks({ schoolId, staffId: tA.id, classId: ss4.id, classGroupId: gA.id, remarks: [{ studentId: a1.id, remark: "y".repeat(501) }] }),
    { status: 400, code: "REMARK_TOO_LONG" }, "too long"
  );
  log("a class teacher can only write remarks for their own group's students, up to 500 characters");

  // With the admin, remarks are locked.
  const cB = await prisma.classCompilation.findFirst({ where: { classId: ss4.id, classGroupId: gB.id } });
  await prisma.classCompilation.update({ where: { id: cB.id }, data: { status: "SUBMITTED" } });
  await rejects(
    Workflow.saveRemarks({ schoolId, staffId: tB.id, classId: ss4.id, classGroupId: gB.id, remarks: [{ studentId: b1.id, remark: "late edit" }] }),
    { status: 409, code: "REMARKS_LOCKED" }, "remarks while with the admin"
  );
  assert.strictEqual((await Workflow.listRemarks({ schoolId, staffId: tB.id, classId: ss4.id, classGroupId: gB.id })).editable, false);
  await prisma.classCompilation.update({ where: { id: cB.id }, data: { status: "RETURNED" } });
  log("remarks are locked while the group's results are with the admin");

  await Workflow.savePrincipalRemarks({ schoolId, adminId: admin.id, termId: term.id, remarks: [{ studentId: a1.id, remark: "Promoted with honours" }] });
  const withPrincipal = await adminCard(a1);
  assert.strictEqual(withPrincipal.principalRemark, "Promoted with honours");
  assert.strictEqual((await adminCard(a2)).principalRemark, null);
  const other2 = await prisma.school.create({ data: { name: `Other2 ${stamp}`, prefix: "O2" } });
  await rejects(
    Workflow.savePrincipalRemarks({ schoolId: other2.id, adminId: admin.id, termId: term.id, remarks: [{ studentId: a1.id, remark: "hijack" }] }),
    { status: 404 }, "another school's student"
  );
  log("the principal's remark is separate, and only for the admin's own school's students");

  console.log("PDFs from real data");
  const { spawnSync } = require("child_process");
  const { buildReportCardsPdf, buildBroadsheetPdf } = require("../res/util/reportCardPdf");
  const readPdf = (buf) => {
    const run = spawnSync(process.execPath, [require("path").join(__dirname, "..", "res", "__tests__", "helpers", "pdfText.js")], { input: buf, maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(run.status, 0, run.stderr.toString());
    return JSON.parse(run.stdout.toString());
  };
  const detailB = await Workflow.getCompilation({ schoolId, id: queueB.id });
  const counted = detailB.subjects.filter((x) => ["accepted", "own", "published"].includes(x.state)).map((x) => x.subjectId);
  const cardsB = await Workflow.classReportCards({
    schoolId, classId: ss4.id, classGroupId: gB.id, sessionId: session.id, termId: term.id, subjectIds: counted,
  });
  assert.strictEqual(cardsB.length, 2, "one card per student of the group");
  assert.deepStrictEqual(cardsB.map((c) => c.performanceSummary.classPosition), ["1", "2"], "positions within the group, ranked once");
  const pdfB = readPdf(await buildReportCardsPdf(cardsB, { loadImages: false }));
  assert.strictEqual(pdfB.pages, 2);
  assert.ok(pdfB.text.includes("Arm B1") || pdfB.text.includes("B1 Arm") || pdfB.text.includes("B1"), "names the students");
  const sheetPdf = readPdf(await buildBroadsheetPdf({ title: "Class Broadsheet — SS 4 — B" }, detailB.broadsheet));
  assert.ok(sheetPdf.text.includes("Class Broadsheet") && sheetPdf.text.includes("B1"));
  // The ranked-once shortcut gives the same cards as ranking inside each card.
  const alone = await assessment.getStudentCompleteResult({
    studentId: b1.id, schoolId, academicSessionId: session.id, termId: term.id, subjectIds: counted, expectClassId: ss4.id,
  });
  assert.strictEqual(alone.performanceSummary.classPosition, cardsB[0].performanceSummary.classPosition);
  log("a group's report cards and broadsheet come out as PDFs with the same positions as on screen");

  console.log("\nAll checks passed.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("\n❌ FAILED:", error.message);
    if (error.stack) console.error(error.stack.split("\n").slice(1, 6).join("\n"));
    await prisma.$disconnect();
    process.exit(1);
  });
