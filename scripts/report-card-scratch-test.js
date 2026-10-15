/**
 * Real-database check of the report card additions: class position of a
 * session that has since been promoted out of, the resumption date, the
 * closing-term promotion line, session average and outstanding fees.
 *
 * Refuses unless DATABASE_URL targets the scratch database on localhost:3307.
 *   export DATABASE_URL="mysql://root:scratch@127.0.0.1:3307/qalox_scratch"
 *   npx prisma db push --skip-generate && node scripts/report-card-scratch-test.js
 */
require("ts-node/register/transpile-only");
const assert = require("assert");

const url = process.env.DATABASE_URL || "";
if (!/@(127\.0\.0\.1|localhost):3307\//.test(url)) {
  console.error("Refusing to run: DATABASE_URL must point at the scratch database on localhost:3307.");
  process.exit(1);
}

const prisma = require("../res/util/prisma");
const PromotionService = require("../res/Services/PromotionService");
const { AssessmentService } = require("../res/Services/AssessmentService");

const log = (m) => console.log(`  ✓ ${m}`);
const stamp = Date.now();

async function main() {
  const school = await prisma.school.create({ data: { name: `RC ${stamp}`, prefix: "RC" } });
  const schoolId = school.id;
  const admin = await prisma.admin.create({
    data: { name: "Head", email: `rc${stamp}@x.com`, password: "x", role: "school_admin", schoolId },
  });
  const campus = await prisma.campus.create({ data: { schoolId, name: "Main" } });
  const sessA = await prisma.academicSession.create({ data: { schoolId, name: "2026/2027", isActive: true } });
  const t1 = await prisma.academicTerm.create({ data: { schoolId, sessionId: sessA.id, name: "First Term" } });
  const t2 = await prisma.academicTerm.create({
    data: { schoolId, sessionId: sessA.id, name: "Second Term", createdAt: new Date(Date.now() + 1000) },
  });
  const sessB = await prisma.academicSession.create({
    data: { schoolId, name: "2027/2028", createdAt: new Date(Date.now() + 5000) },
  });
  await prisma.academicTerm.create({
    data: { schoolId, sessionId: sessB.id, name: "First Term", resumptionDate: new Date("2027-09-13T00:00:00.000Z") },
  });

  const ss1 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 1" } });
  const jss3 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "JSS 3", promotesToClassId: ss1.id } });
  const subject = await prisma.subject.create({ data: { schoolId, name: "Maths" } });
  await prisma.classSubject.create({ data: { classId: jss3.id, subjectId: subject.id } });

  const ca = await prisma.continuousAssessment.create({ data: { classId: jss3.id, subjectId: subject.id, name: "CA1", maxScore: 40 } });
  const exam = await prisma.exam.create({ data: { classId: jss3.id, subjectId: subject.id, name: "Exam", maxScore: 60 } });

  const mk = (name) =>
    prisma.student.create({
      data: {
        schoolId, campusId: campus.id, classId: jss3.id, name, surname: "Card", otherNames: "",
        academicSessionId: sessA.id, registrationNumber: `RC-${name}-${stamp}`,
      },
    });
  const top = await mk("Top");
  const mid = await mk("Mid");
  const low = await mk("Low");
  for (const s of [top, mid, low]) {
    await prisma.studentEnrollment.create({
      data: { schoolId, studentId: s.id, academicSessionId: sessA.id, classId: jss3.id, campusId: campus.id },
    });
  }

  // [CA, exam] per term.
  const scores = { [top.id]: [[35, 55], [38, 58]], [mid.id]: [[25, 40], [26, 42]], [low.id]: [[10, 15], [12, 16]] };
  for (const [i, term] of [t1, t2].entries()) {
    const pr = await prisma.publishedResult.create({
      data: { classId: jss3.id, subjectId: subject.id, academicSessionId: sessA.id, termId: term.id, publishedByAdminId: admin.id },
    });
    for (const [sid, perTerm] of Object.entries(scores)) {
      const [c, e] = perTerm[i];
      await prisma.cAResult.create({ data: { studentId: +sid, caId: ca.id, academicSessionId: sessA.id, termId: term.id, score: c } });
      await prisma.examResult.create({ data: { studentId: +sid, examId: exam.id, academicSessionId: sessA.id, termId: term.id, score: e } });
      await prisma.publishedResultRow.create({
        data: { publishedResultId: pr.id, studentId: +sid, caTotal: c, examTotal: e, total: c + e },
      });
    }
  }

  const fs = await prisma.feeStructure.create({ data: { schoolId, classId: jss3.id, term: "First Term", session: "2026/2027" } });
  await prisma.studentFee.create({
    data: { schoolId, studentId: mid.id, feeStructureId: fs.id, totalFee: 50000, amountPaid: 20000, status: "partial" },
  });

  const svc = new AssessmentService();
  const card = (studentId, termId) =>
    svc.getStudentCompleteResult({ studentId, schoolId, academicSessionId: sessA.id, termId });

  console.log("Before promotion");
  let c = await card(mid.id, t2.id);
  assert.strictEqual(c.performanceSummary.classPosition, "2");
  assert.strictEqual(c.sessionSummary.promotion, null, "no run yet, so no claim");
  assert.strictEqual(c.feeSummary.outstanding, 30000);
  log("position 2 of 3, no promotion claim, owes 30,000");

  console.log("Promote the class out of the session");
  await PromotionService.applyPromotion({
    schoolId, adminId: admin.id, classId: jss3.id, fromSessionId: sessA.id, toSessionId: sessB.id,
    decisions: [
      { studentId: top.id, outcome: "promoted" },
      { studentId: mid.id, outcome: "trial" },
      { studentId: low.id, outcome: "repeat" },
    ],
  });
  const moved = await prisma.student.findUnique({ where: { id: top.id } });
  assert.strictEqual(moved.classId, ss1.id, "student really moved on");

  console.log("After promotion, the old session's card");
  c = await card(top.id, t2.id);
  assert.strictEqual(c.studentInformation.className, "JSS 3");
  assert.strictEqual(c.performanceSummary.classPosition, "1");
  c = await card(mid.id, t2.id);
  assert.strictEqual(c.performanceSummary.classPosition, "2", "ranked among the old classmates, not nobody");
  c = await card(low.id, t2.id);
  assert.strictEqual(c.performanceSummary.classPosition, "3");
  log("positions 1, 2, 3 survive the class moving on");

  c = await card(top.id, t2.id);
  assert.strictEqual(c.sessionSummary.promotion.label, "Promoted to SS 1");
  assert.strictEqual(c.sessionSummary.sessionAverage, 93, "mean of terms (90, 96)");
  log('closing term says "Promoted to SS 1" with a session average of 93');

  c = await card(mid.id, t2.id);
  assert.strictEqual(c.sessionSummary.promotion.label, "Promoted on trial to SS 1");
  c = await card(low.id, t2.id);
  assert.strictEqual(c.sessionSummary.promotion.label, "To repeat to JSS 3");

  c = await card(top.id, t1.id);
  assert.strictEqual(c.sessionSummary, null, "First Term makes no session claim");
  assert.strictEqual(c.schoolRecommendationDate, null, "Second Term has no date: dash, not today");
  log("First Term card has no session claim and no invented date");

  c = await card(top.id, t2.id);
  assert.strictEqual(c.schoolRecommendationDate, "2027-09-13", "next session's first term date");
  log("last term resumes on the next session's first term date");

  const { StudentResultService } = require("../res/Services/student/StudentResultService");
  const sum = await new StudentResultService().getSummary(top.id, schoolId, sessA.id, t2.id);
  assert.strictEqual(sum.className, "JSS 3");
  assert.strictEqual(sum.termName, "Second Term");
  assert.strictEqual(sum.resumptionDate, "2027-09-13");
  assert.strictEqual(sum.sessionSummary.promotion.label, "Promoted to SS 1");
  assert.strictEqual((await new StudentResultService().getSummary(mid.id, schoolId, sessA.id, t2.id)).outstandingFees, 30000);
  log("student summary matches the admin card");

  const run = await prisma.promotionRun.findFirst({ where: { schoolId } });
  await PromotionService.undoRun({ schoolId, runId: run.id });
  c = await card(top.id, t2.id);
  assert.strictEqual(c.sessionSummary.promotion, null, "undone run is not claimed");
  log("undoing the promotion removes the claim");
}
main().then(() => { console.log("\nAll report card checks passed"); return prisma.$disconnect(); }).catch((e) => { console.error(e); process.exit(1); });
