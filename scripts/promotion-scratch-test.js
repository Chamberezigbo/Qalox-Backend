/**
 * End-to-end check of end-of-session promotion against a SCRATCH database.
 *
 * Seeds a small school, then runs preview, apply, a repeated apply, graduation,
 * undo and a refused undo through the real service and real MySQL, and asserts
 * what lands in the tables. Unit tests with mocked Prisma cannot show that
 * the queries and transactions actually behave, and a promotion writes to many
 * students at once, so this exists to be run before it is ever used on real data.
 *
 * It REFUSES to run unless DATABASE_URL points at localhost port 3307, the
 * scratch container, so it cannot touch production by accident.
 *
 *   docker run -d --name qalox-scratch-mysql -e MYSQL_ROOT_PASSWORD=scratch \
 *     -e MYSQL_DATABASE=qalox_scratch -p 3307:3306 mysql:8.0
 *   export DATABASE_URL="mysql://root:scratch@127.0.0.1:3307/qalox_scratch"
 *   npx prisma db push --skip-generate
 *   node scripts/promotion-scratch-test.js
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

const log = (msg) => console.log(`  ✓ ${msg}`);
const rejects = async (promise, status, label) => {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.statusCode, status, `${label}: expected status ${status}, got ${error.statusCode} (${error.message})`);
    return error;
  }
  assert.fail(`${label}: expected it to be refused`);
};

async function seed() {
  const school = await prisma.school.create({ data: { name: `Scratch ${Date.now()}`, prefix: "SCR" } });
  const schoolId = school.id;
  const admin = await prisma.admin.create({
    data: { name: "Head", email: `head${Date.now()}@x.com`, password: "x", role: "school_admin", schoolId },
  });
  const campus = await prisma.campus.create({ data: { schoolId, name: "Main" } });
  const sessionA = await prisma.academicSession.create({ data: { schoolId, name: "2026/2027", isActive: true } });
  const sessionB = await prisma.academicSession.create({ data: { schoolId, name: "2027/2028", isActive: false } });
  const t1 = await prisma.academicTerm.create({ data: { schoolId, sessionId: sessionA.id, name: "First Term" } });
  const t2 = await prisma.academicTerm.create({ data: { schoolId, sessionId: sessionA.id, name: "Second Term" } });

  const ss1 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 1" } });
  const jss3 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "JSS 3", promotesToClassId: ss1.id } });
  const ss3 = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 3" } }); // final class
  const subject = await prisma.subject.create({ data: { schoolId, name: "Mathematics" } });

  const mk = (name, classId) =>
    prisma.student.create({
      data: {
        schoolId, campusId: campus.id, classId, name, surname: "Test", otherNames: "",
        academicSessionId: sessionA.id, registrationNumber: `SCR-${name}-${Date.now()}`,
      },
    });
  const students = {
    pass: await mk("Pass", jss3.id),
    near: await mk("Near", jss3.id),
    fail: await mk("Fail", jss3.id),
    none: await mk("None", jss3.id),
    partial: await mk("Partial", jss3.id),
    grad: await mk("Grad", ss3.id),
  };
  for (const s of Object.values(students)) {
    await prisma.studentEnrollment.create({
      data: { schoolId, studentId: s.id, academicSessionId: sessionA.id, classId: s.classId, campusId: campus.id },
    });
  }

  const publish = async (classId, termId, totals) => {
    const pr = await prisma.publishedResult.create({
      data: { classId, subjectId: subject.id, academicSessionId: sessionA.id, termId, publishedByAdminId: admin.id },
    });
    for (const [studentId, total] of totals) {
      await prisma.publishedResultRow.create({
        data: { publishedResultId: pr.id, studentId, caTotal: total / 2, examTotal: total / 2, total },
      });
    }
  };
  await publish(jss3.id, t1.id, [[students.pass.id, 70], [students.near.id, 36], [students.fail.id, 20], [students.partial.id, 50]]);
  await publish(jss3.id, t2.id, [[students.pass.id, 80], [students.near.id, 38], [students.fail.id, 25]]);
  await publish(ss3.id, t1.id, [[students.grad.id, 60]]);

  // Near owes 30,000.
  const fs = await prisma.feeStructure.create({ data: { schoolId, classId: jss3.id, term: "First Term", session: "2026/2027" } });
  await prisma.studentFee.create({
    data: { schoolId, studentId: students.near.id, feeStructureId: fs.id, totalFee: 50000, amountPaid: 20000, status: "partial" },
  });

  // SS 1's fees for the NEW session, and for the old one. Only the new session's
  // may be billed to students who move in, even though the old session is the
  // one that is still active.
  const newFees = await prisma.feeStructure.create({
    data: { schoolId, classId: ss1.id, term: "First Term", session: "2027/2028", items: { create: [{ name: "Tuition", amount: 40000 }] } },
  });
  const oldFees = await prisma.feeStructure.create({
    data: { schoolId, classId: ss1.id, term: "First Term", session: "2026/2027", items: { create: [{ name: "Tuition", amount: 99999 }] } },
  });

  return { schoolId, admin, campus, sessionA, sessionB, jss3, ss1, ss3, students, newFees, oldFees };
}

async function main() {
  console.log("Seeding…");
  const w = await seed();
  const s = w.students;
  const base = { schoolId: w.schoolId, classId: w.jss3.id, fromSessionId: w.sessionA.id };

  console.log("School overview, before anything is applied");
  const ovBefore = await PromotionService.schoolOverview({ schoolId: w.schoolId, fromSessionId: w.sessionA.id });
  const row = (o, id) => o.classes.find((c) => c.classId === id);
  assert.strictEqual(row(ovBefore, w.jss3.id).status, "ready");
  assert.strictEqual(row(ovBefore, w.jss3.id).studentsLeft, 5);
  assert.strictEqual(row(ovBefore, w.jss3.id).publishedTerms, 2);
  assert.strictEqual(row(ovBefore, w.jss3.id).nextClassName, "SS 1");
  assert.strictEqual(row(ovBefore, w.ss3.id).isFinalClass, true);
  assert.strictEqual(row(ovBefore, w.ss3.id).status, "ready");
  assert.strictEqual(row(ovBefore, w.ss1.id), undefined, "a class with nobody in it is not listed");
  assert.strictEqual(ovBefore.totals.studentsLeft, 6);
  log("every class with students is listed with its count, terms and next class");

  console.log("Preview");
  const preview = await PromotionService.previewClass(base);
  const byName = Object.fromEntries(preview.students.map((p) => [p.name.split(" ")[1], p]));
  assert.strictEqual(preview.passMark, 40);
  assert.strictEqual(preview.isFinalClass, false);
  assert.strictEqual(preview.nextClass.id, w.ss1.id);
  assert.strictEqual(preview.termsPublished, 2);
  assert.strictEqual(byName.Pass.average, 75);
  assert.strictEqual(byName.Pass.suggestedOutcome, "promoted");
  assert.strictEqual(byName.Near.average, 37);
  assert.strictEqual(byName.Near.suggestedOutcome, "trial");
  assert.strictEqual(byName.Near.amountOwed, 30000);
  assert.strictEqual(byName.Fail.suggestedOutcome, "repeat");
  assert.strictEqual(byName.None.suggestedOutcome, null);
  assert.strictEqual(byName.None.noResults, true);
  assert.strictEqual(byName.Partial.incompleteResults, true);
  assert.strictEqual(byName.Partial.suggestedOutcome, "promoted");
  log("averages, suggestions, owed amount and flags are right");

  const decisions = [
    { studentId: s.pass.id, outcome: "promoted" },
    { studentId: s.near.id, outcome: "trial" },
    { studentId: s.fail.id, outcome: "repeat" },
    { studentId: s.none.id, outcome: "repeat", reason: "No results; repeating" },
    { studentId: s.partial.id, outcome: "promoted" },
  ];

  console.log("Refusals before applying");
  await rejects(PromotionService.applyPromotion({ ...base, toSessionId: w.sessionA.id, decisions }), 400, "same session");
  await rejects(PromotionService.applyPromotion({ ...base, toSessionId: w.sessionB.id, decisions: decisions.slice(0, 3) }), 400, "missing students");
  const stillThere = await prisma.student.findUnique({ where: { id: s.pass.id } });
  assert.strictEqual(stillThere.classId, w.jss3.id);
  log("an incomplete or invalid promotion changes nothing");

  console.log("Apply");
  const applied = await PromotionService.applyPromotion({ ...base, adminId: w.admin.id, toSessionId: w.sessionB.id, decisions });
  assert.deepStrictEqual(applied.counts, { promoted: 2, trial: 1, repeat: 2 });

  const after = await prisma.student.findMany({ where: { id: { in: Object.values(s).map((x) => x.id) } } });
  const get = (st) => after.find((x) => x.id === st.id);
  assert.strictEqual(get(s.pass).classId, w.ss1.id);
  assert.strictEqual(get(s.pass).academicSessionId, w.sessionB.id);
  assert.strictEqual(get(s.near).classId, w.ss1.id);
  assert.strictEqual(get(s.fail).classId, w.jss3.id);
  assert.strictEqual(get(s.fail).academicSessionId, w.sessionB.id);
  assert.strictEqual(get(s.grad).academicSessionId, w.sessionA.id);
  log("promoted and trial students are in SS 1, repeaters stay in JSS 3, all in the new session");

  const ovAfter = await PromotionService.schoolOverview({ schoolId: w.schoolId, fromSessionId: w.sessionA.id });
  assert.strictEqual(row(ovAfter, w.jss3.id).status, "done");
  assert.strictEqual(row(ovAfter, w.jss3.id).studentsLeft, 0);
  assert.ok(row(ovAfter, w.jss3.id).lastRun.counts.promoted >= 1);
  assert.strictEqual(ovAfter.suggestedToSessionId, w.sessionB.id);
  assert.strictEqual(row(ovAfter, w.ss3.id).status, "ready", "other classes are unaffected");
  log("after applying, the class shows as done and the other class is untouched");

  const enrolB = await prisma.studentEnrollment.findMany({ where: { academicSessionId: w.sessionB.id } });
  assert.strictEqual(enrolB.length, 5);
  assert.strictEqual(enrolB.find((e) => e.studentId === s.pass.id).classId, w.ss1.id);
  const enrolA = await prisma.studentEnrollment.findUnique({
    where: { studentId_academicSessionId: { studentId: s.pass.id, academicSessionId: w.sessionA.id } },
  });
  assert.strictEqual(enrolA.classId, w.jss3.id, "the old session's history must still say JSS 3");
  log("class history: new session recorded, old session still shows JSS 3");

  const items = await prisma.promotionRunItem.findMany({ where: { runId: applied.runId } });
  assert.strictEqual(items.length, 5);
  assert.strictEqual(items.find((i) => i.studentId === s.none.id).overrideReason, "No results; repeating");
  log("the run and every student's previous state are recorded");

  console.log("Fees");
  const passFees = await prisma.studentFee.findMany({ where: { studentId: s.pass.id } });
  assert.ok(passFees.some((f) => f.feeStructureId === w.newFees.id && f.totalFee === 40000), "billed the new session's fee");
  assert.ok(!passFees.some((f) => f.feeStructureId === w.oldFees.id), "must not bill last session's fee for the new class");
  const nearFees = await prisma.studentFee.findMany({ where: { studentId: s.near.id } });
  assert.strictEqual(nearFees.length, 2, "Near keeps the old invoice and gains the new one");
  const noInvoiceForRepeater = await prisma.studentFee.count({ where: { studentId: s.fail.id } });
  assert.strictEqual(noInvoiceForRepeater, 0, "a repeater's class has no structure for the new session here");
  const recorded = (await prisma.promotionRunItem.findFirst({ where: { runId: applied.runId, studentId: s.pass.id } })).createdFeeIdsJson;
  assert.strictEqual(JSON.parse(recorded).length, 1);
  log("the new session's fee is billed, last session's is not, and the created invoice is recorded");

  console.log("Running it again");
  await rejects(PromotionService.applyPromotion({ ...base, toSessionId: w.sessionB.id, decisions }), 400, "second apply");
  const empty = await PromotionService.previewClass(base);
  assert.strictEqual(empty.students.length, 0);
  log("a second run finds nobody left to move and is refused");

  console.log("Two applies at once");
  const jss2 = await prisma.class.create({
    data: { schoolId: w.schoolId, campusId: w.campus.id, name: "JSS 2", promotesToClassId: w.jss3.id },
  });
  const twoStudents = [];
  for (const name of ["Race1", "Race2"]) {
    const st = await prisma.student.create({
      data: {
        schoolId: w.schoolId, campusId: w.campus.id, classId: jss2.id, name, surname: "T", otherNames: "",
        academicSessionId: w.sessionA.id, registrationNumber: `SCR-${name}-${Date.now()}`,
      },
    });
    twoStudents.push(st);
  }
  const raceInput = {
    schoolId: w.schoolId, adminId: w.admin.id, classId: jss2.id, fromSessionId: w.sessionA.id, toSessionId: w.sessionB.id,
    decisions: twoStudents.map((st) => ({ studentId: st.id, outcome: "promoted" })),
  };
  const raced = await Promise.allSettled([PromotionService.applyPromotion(raceInput), PromotionService.applyPromotion(raceInput)]);
  assert.strictEqual(raced.filter((r) => r.status === "fulfilled").length, 1, "exactly one of two simultaneous applies succeeds");
  assert.strictEqual(raced.filter((r) => r.status === "rejected").length, 1);
  assert.strictEqual(await prisma.promotionRun.count({ where: { classId: jss2.id } }), 1, "only one run is recorded");
  log("two simultaneous applies of the same class move the students once and record one run");

  console.log("Graduation");
  const grad = await PromotionService.previewClass({ schoolId: w.schoolId, classId: w.ss3.id, fromSessionId: w.sessionA.id });
  assert.strictEqual(grad.isFinalClass, true);
  assert.strictEqual(grad.students[0].suggestedOutcome, "graduated");
  await rejects(
    PromotionService.applyPromotion({
      schoolId: w.schoolId, classId: w.jss3.id, fromSessionId: w.sessionB.id, toSessionId: w.sessionB.id, decisions: [],
    }),
    400,
    "no decisions"
  );
  const g = await PromotionService.applyPromotion({
    schoolId: w.schoolId, adminId: w.admin.id, classId: w.ss3.id, fromSessionId: w.sessionA.id, toSessionId: w.sessionB.id,
    decisions: [{ studentId: s.grad.id, outcome: "graduated" }],
  });
  assert.strictEqual((await prisma.student.findUnique({ where: { id: s.grad.id } })).status, "graduated");
  log("a final-class pass graduates");

  console.log("Undo");
  await PromotionService.undoRun({ schoolId: w.schoolId, runId: applied.runId });
  const restored = await prisma.student.findUnique({ where: { id: s.pass.id } });
  assert.strictEqual(restored.classId, w.jss3.id);
  assert.strictEqual(restored.academicSessionId, w.sessionA.id);
  const enrolAfterUndo = await prisma.studentEnrollment.count({ where: { academicSessionId: w.sessionB.id, studentId: { in: [s.pass.id, s.near.id] } } });
  assert.strictEqual(enrolAfterUndo, 0);
  assert.ok((await prisma.promotionRun.findUnique({ where: { id: applied.runId } })).undoneAt);
  log("every student is back where they were, and the new-session history is removed");
  await rejects(PromotionService.undoRun({ schoolId: w.schoolId, runId: applied.runId }), 409, "double undo");
  log("undoing twice is refused");

  await PromotionService.undoRun({ schoolId: w.schoolId, runId: g.runId });
  assert.strictEqual((await prisma.student.findUnique({ where: { id: s.grad.id } })).status, "active");
  log("an undone graduation is active again");

  const feesAfterUndo = await prisma.studentFee.findMany({ where: { studentId: { in: [s.pass.id, s.near.id] } } });
  assert.ok(!feesAfterUndo.some((f) => f.feeStructureId === w.newFees.id), "undo removes the invoices the promotion raised");
  const nearOld = feesAfterUndo.filter((f) => f.studentId === s.near.id);
  assert.strictEqual(nearOld.length, 1);
  assert.strictEqual(nearOld[0].amountPaid, 20000, "the student's own paid invoice is untouched");
  log("undo removes only the invoices the promotion raised; a paid invoice is untouched");

  console.log("Undo is refused once work is built on it");
  const again = await PromotionService.applyPromotion({ ...base, adminId: w.admin.id, toSessionId: w.sessionB.id, decisions });
  // A score entered for a student in the new session.
  await prisma.cAResult.create({
    data: { studentId: s.pass.id, caId: 999999, academicSessionId: w.sessionB.id, termId: null, score: 5 },
  });
  const blocked = await rejects(PromotionService.undoRun({ schoolId: w.schoolId, runId: again.runId }), 409, "undo after scores");
  assert.match(blocked.message, /Scores have already been entered/);
  assert.strictEqual((await prisma.student.findUnique({ where: { id: s.pass.id } })).classId, w.ss1.id);
  log("undo after scores were entered is refused and changes nothing");

  console.log("\nAll checks passed.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("\n❌ FAILED:", error.message);
    if (error.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
    await prisma.$disconnect();
    process.exit(1);
  });
