/**
 * End-to-end check of a student taking a multiple-choice test, against a SCRATCH
 * database. Refuses to run unless DATABASE_URL is the scratch container on
 * localhost:3307.
 *
 *   docker run -d --name qalox-scratch-mysql -e MYSQL_ROOT_PASSWORD=scratch \
 *     -e MYSQL_DATABASE=qalox_scratch -p 3307:3306 mysql:8.0
 *   export DATABASE_URL="mysql://root:scratch@127.0.0.1:3307/qalox_scratch"
 *   npx prisma db push --skip-generate
 *   node scripts/cbt-scratch-test.js
 */
require("ts-node/register/transpile-only");
const assert = require("assert");

if (!/@(127\.0\.0\.1|localhost):3307\//.test(process.env.DATABASE_URL || "")) {
  console.error("Refusing to run: DATABASE_URL must point at the scratch database on localhost:3307.");
  process.exit(1);
}

const prisma = require("../res/util/prisma");
const S = require("../res/Services/student/StudentTestService");

const log = (m) => console.log(`  ✓ ${m}`);
const refused = async (promise, code, label) => {
  try {
    await promise;
  } catch (e) {
    assert.strictEqual(e.code, code, `${label}: expected ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  assert.fail(`${label}: expected it to be refused with ${code}`);
};

async function seed() {
  const school = await prisma.school.create({ data: { name: `CBT ${Date.now()}`, prefix: "CBT" } });
  const schoolId = school.id;
  const campus = await prisma.campus.create({ data: { schoolId, name: "Main" } });
  const session = await prisma.academicSession.create({ data: { schoolId, name: "2026/2027", isActive: true } });
  const term = await prisma.academicTerm.create({ data: { schoolId, sessionId: session.id, name: "First Term", isActive: true } });
  const cls = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 1" } });
  const otherCls = await prisma.class.create({ data: { schoolId, campusId: campus.id, name: "SS 2" } });
  const subject = await prisma.subject.create({ data: { schoolId, name: "Biology" } });
  const staff = await prisma.staff.create({
    data: { schoolId, campusId: campus.id, name: "Teacher", duty: "teacher", registrationNumber: `T${Date.now()}` },
  });

  const mkStudent = (name, classId) =>
    prisma.student.create({
      data: { schoolId, campusId: campus.id, classId, name, surname: "T", otherNames: "", academicSessionId: session.id, registrationNumber: `CBT-${name}-${Date.now()}` },
    });
  const ada = await mkStudent("Ada", cls.id);
  const bola = await mkStudent("Bola", cls.id);
  const outsider = await mkStudent("Out", otherCls.id);

  const mkTest = async (over = {}) => {
    const test = await prisma.test.create({
      data: {
        schoolId, classId: cls.id, subjectId: subject.id, academicTermId: term.id, createdByStaffId: staff.id,
        title: "Cells", durationMinutes: 30, maxAttempts: 1, shuffleQuestions: true, showResultsImmediately: true,
        status: "published", publishedAt: new Date(), ...over,
      },
    });
    for (let n = 1; n <= 3; n++) {
      await prisma.question.create({
        data: {
          testId: test.id, text: `Question ${n}?`, order: n, explanation: `Because ${n}`,
          options: { create: [1, 2, 3, 4].map((o) => ({ text: `Q${n} option ${o}`, order: o, isCorrect: o === n })) },
        },
      });
    }
    return prisma.test.findUnique({ where: { id: test.id }, include: { questions: { include: { options: true } } } });
  };

  return { schoolId, cls, ada, bola, outsider, mkTest, staff };
}

const correctOf = (test, questionId) => test.questions.find((q) => q.id === questionId).options.find((o) => o.isCorrect).id;
const wrongOf = (test, questionId) => test.questions.find((q) => q.id === questionId).options.find((o) => !o.isCorrect).id;

async function main() {
  console.log("Seeding…");
  const w = await seed();
  const { schoolId } = w;
  const test = await w.mkTest();

  console.log("Listing");
  const list = await S.listForStudent(w.ada.id, schoolId);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].state, "available");
  assert.strictEqual((await S.listForStudent(w.outsider.id, schoolId)).length, 0);
  log("a student sees their class's published test, and another class sees nothing");

  console.log("Starting");
  const started = await S.startAttempt(w.ada.id, schoolId, test.id);
  assert.strictEqual(started.status, "in_progress");
  assert.strictEqual(started.questions.length, 3);
  const leaked = JSON.stringify(started);
  assert.ok(!leaked.includes("isCorrect"), "the paper must not carry the answer key");
  assert.ok(!leaked.includes("Because"), "the paper must not carry explanations");
  log("a started paper has no answer key and no explanations");

  const again = await S.startAttempt(w.ada.id, schoolId, test.id);
  assert.strictEqual(again.attemptId, started.attemptId);
  assert.deepStrictEqual(again.questions.map((q) => q.id), started.questions.map((q) => q.id));
  log("starting again resumes the same attempt, in the same order");

  const dl = new Date(started.deadlineAt).getTime();
  assert.ok(Math.abs(dl - (Date.now() + 30 * 60 * 1000)) < 5000, "deadline is about 30 minutes ahead");
  log("the deadline is set from the time allowed");

  await refused(S.startAttempt(w.outsider.id, schoolId, test.id), "TEST_NOT_FOUND", "other class starting");
  await refused(S.getAttempt(w.bola.id, schoolId, started.attemptId), "ATTEMPT_NOT_FOUND", "another student's attempt");
  log("another class cannot start it, and another student cannot open Ada's attempt");

  console.log("Answering");
  const ids = started.questions.map((q) => q.id);
  await S.saveAnswer(w.ada.id, schoolId, started.attemptId, { questionId: ids[0], optionId: correctOf(test, ids[0]) });
  await S.saveAnswer(w.ada.id, schoolId, started.attemptId, { questionId: ids[1], optionId: wrongOf(test, ids[1]) });
  // Changing an answer replaces it rather than adding another.
  await S.saveAnswer(w.ada.id, schoolId, started.attemptId, { questionId: ids[1], optionId: correctOf(test, ids[1]) });
  await refused(
    S.saveAnswer(w.ada.id, schoolId, started.attemptId, { questionId: ids[2], optionId: correctOf(test, ids[0]) }),
    "INVALID_OPTION",
    "option from another question"
  );
  await refused(
    S.saveAnswer(w.ada.id, schoolId, started.attemptId, { questionId: 999999, optionId: 1 }),
    "INVALID_QUESTION",
    "unknown question"
  );
  const resumed = await S.getAttempt(w.ada.id, schoolId, started.attemptId);
  assert.strictEqual(resumed.answers[ids[0]], correctOf(test, ids[0]));
  assert.strictEqual(resumed.answers[ids[1]], correctOf(test, ids[1]));
  assert.strictEqual(await prisma.studentAnswer.count({ where: { attemptId: started.attemptId } }), 2);
  log("answers autosave, a changed answer replaces the old one, and bad ones are refused");

  console.log("Submitting");
  const result = await S.submitAttempt(w.ada.id, schoolId, started.attemptId);
  assert.strictEqual(result.status, "submitted");
  assert.strictEqual(result.score, 2);
  assert.strictEqual(result.totalPossible, 3);
  assert.strictEqual(result.review.length, 3);
  assert.strictEqual(result.review.find((r) => r.questionId === ids[2]).selectedOptionId, null);
  assert.strictEqual(result.review.find((r) => r.questionId === ids[0]).explanation !== null, true);
  log("two of three correct, the blank question scores nothing, and the review is shown");

  const twice = await S.submitAttempt(w.ada.id, schoolId, started.attemptId);
  assert.strictEqual(twice.score, 2);
  await refused(
    S.saveAnswer(w.ada.id, schoolId, started.attemptId, { questionId: ids[2], optionId: correctOf(test, ids[2]) }),
    "ATTEMPT_FINISHED",
    "answer after submit"
  );
  const stored = await prisma.studentAnswer.findMany({ where: { attemptId: started.attemptId } });
  assert.ok(stored.every((a) => a.marksAwarded !== null));
  log("submitting twice gives the same result, and nothing can be changed afterwards");

  await refused(S.startAttempt(w.ada.id, schoolId, test.id), "NO_ATTEMPTS_LEFT", "second attempt");
  log("the attempt limit is enforced");

  console.log("Running out of time");
  const t2 = await w.mkTest({ title: "Timed", durationMinutes: 10 });
  const s2 = await S.startAttempt(w.bola.id, schoolId, t2.id);
  const q2 = s2.questions.map((q) => q.id);
  await S.saveAnswer(w.bola.id, schoolId, s2.attemptId, { questionId: q2[0], optionId: correctOf(t2, q2[0]) });
  // Wind the clock back by editing the stored deadline: the student walked away.
  await prisma.studentTestAttempt.update({ where: { id: s2.attemptId }, data: { deadlineAt: new Date(Date.now() - 60 * 1000) } });
  await refused(
    S.saveAnswer(w.bola.id, schoolId, s2.attemptId, { questionId: q2[1], optionId: correctOf(t2, q2[1]) }),
    "TEST_TIME_UP",
    "answer after the deadline"
  );
  const timed = await S.getAttempt(w.bola.id, schoolId, s2.attemptId);
  assert.strictEqual(timed.status, "auto_submitted");
  assert.strictEqual(timed.score, 1);
  assert.strictEqual(timed.autoSubmitted, true);
  log("an answer after the deadline is refused, and the attempt is marked as it stood");

  console.log("Not showing results");
  const t3 = await w.mkTest({ title: "Hidden", showResultsImmediately: false });
  const s3 = await S.startAttempt(w.ada.id, schoolId, t3.id);
  const q3 = s3.questions.map((q) => q.id);
  await S.saveAnswer(w.ada.id, schoolId, s3.attemptId, { questionId: q3[0], optionId: correctOf(t3, q3[0]) });
  const hidden = await S.submitAttempt(w.ada.id, schoolId, s3.attemptId);
  assert.strictEqual(hidden.score, null);
  assert.strictEqual(hidden.review, undefined);
  assert.ok(!JSON.stringify(hidden).includes("isCorrect"));
  const stored3 = await prisma.studentTestAttempt.findUnique({ where: { id: s3.attemptId } });
  assert.strictEqual(Number(stored3.score), 1, "the score is still recorded for the teacher");
  log("when the teacher hides results the student gets no score and no answer key, but it is recorded");

  console.log("Window");
  const future = await w.mkTest({ title: "Later", opensAt: new Date(Date.now() + 3600 * 1000) });
  await refused(S.startAttempt(w.bola.id, schoolId, future.id), "TEST_NOT_OPEN", "before opening");
  const past = await w.mkTest({ title: "Over", closesAt: new Date(Date.now() - 3600 * 1000) });
  await refused(S.startAttempt(w.bola.id, schoolId, past.id), "TEST_CLOSED", "after closing");
  const draft = await w.mkTest({ title: "Draft", status: "draft" });
  await refused(S.startAttempt(w.bola.id, schoolId, draft.id), "TEST_NOT_AVAILABLE", "draft");
  const states = Object.fromEntries((await S.listForStudent(w.bola.id, schoolId)).map((t) => [t.title, t.state]));
  assert.strictEqual(states.Later, "upcoming");
  assert.strictEqual(states.Over, "ended");
  assert.strictEqual(states.Draft, undefined);
  log("not open yet, already closed and draft tests cannot be started, and drafts are not listed");

  console.log("Two taps at once");
  const t4 = await w.mkTest({ title: "Race", maxAttempts: 2 });
  const [a, b] = await Promise.all([S.startAttempt(w.ada.id, schoolId, t4.id), S.startAttempt(w.ada.id, schoolId, t4.id)]);
  assert.strictEqual(a.attemptId, b.attemptId);
  assert.strictEqual(await prisma.studentTestAttempt.count({ where: { testId: t4.id, studentId: w.ada.id } }), 1);
  log("a double tap makes one attempt, not two");

  console.log("Reopening a closed test");
  const ctl = require("../res/controller/teacher/TestController");
  const teacherCall = async (fn, testId, body = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await ctl[fn]({ staffId: w.staff.id, schoolId, params: { id: String(testId) }, body }, res, (e) => { throw e; });
    return res;
  };
  // Ada finishes her one attempt; Bola has one running when the teacher closes.
  const t6 = await w.mkTest({ title: "Reopen me", maxAttempts: 1 });
  const adaRun = await S.startAttempt(w.ada.id, schoolId, t6.id);
  await S.submitAttempt(w.ada.id, schoolId, adaRun.attemptId);
  const bolaRun = await S.startAttempt(w.bola.id, schoolId, t6.id);
  assert.strictEqual((await teacherCall("close", t6.id)).code, 200);
  await refused(S.startAttempt(w.bola.id, schoolId, t6.id), "TEST_NOT_AVAILABLE", "closed test");

  const reopened = await teacherCall("reopen", t6.id);
  assert.strictEqual(reopened.code, 200, JSON.stringify(reopened.body));
  const bolaDone = await prisma.studentTestAttempt.findUnique({ where: { id: bolaRun.attemptId } });
  assert.strictEqual(bolaDone.status, "auto_submitted", "the run that was in progress when it closed stays finished");
  const adaStill = await prisma.studentTestAttempt.findUnique({ where: { id: adaRun.attemptId } });
  assert.strictEqual(adaStill.status, "submitted", "recorded scores are untouched");
  assert.strictEqual((await prisma.studentTestAttempt.count({ where: { testId: t6.id } })), 2);
  // Both used their only attempt, so reopening does not give them another.
  await refused(S.startAttempt(w.ada.id, schoolId, t6.id), "NO_ATTEMPTS_LEFT", "attempts used");
  await refused(S.startAttempt(w.bola.id, schoolId, t6.id), "NO_ATTEMPTS_LEFT", "attempts used (auto-submitted)");
  log("reopening keeps scores, finishes the run that was open at close, and does not give out extra attempts");

  // A student who never started can take it after it reopens.
  const t7 = await w.mkTest({ title: "Missed it", maxAttempts: 1 });
  await teacherCall("close", t7.id);
  await refused(S.startAttempt(w.ada.id, schoolId, t7.id), "TEST_NOT_AVAILABLE", "while closed");
  await teacherCall("reopen", t7.id);
  const late = await S.startAttempt(w.ada.id, schoolId, t7.id);
  assert.strictEqual(late.status, "in_progress");
  log("a student who missed a closed test can take it once it is reopened");

  // Closing time passed: needs a new time; then it opens again.
  const t8 = await w.mkTest({ title: "Expired", closesAt: new Date(Date.now() - 3600 * 1000) });
  await refused(S.startAttempt(w.bola.id, schoolId, t8.id), "TEST_CLOSED", "past closing time");
  assert.strictEqual((await teacherCall("update", t8.id, { closesAt: new Date(Date.now() - 1000).toISOString() })).code, 400);
  assert.strictEqual((await teacherCall("update", t8.id, { closesAt: new Date(Date.now() + 3600 * 1000).toISOString() })).code, 200);
  assert.strictEqual((await S.startAttempt(w.bola.id, schoolId, t8.id)).status, "in_progress");
  log("moving the closing time of an expired test opens it again, and a past time is refused");

  console.log("Teacher results");
  const { settleExpiredForTest } = S;
  // Bola walked away from a timed test; her attempt must be finished and counted.
  const t5 = await w.mkTest({ title: "Walked away", durationMinutes: 10 });
  const s5 = await S.startAttempt(w.bola.id, schoolId, t5.id);
  const q5 = s5.questions.map((q) => q.id);
  await S.saveAnswer(w.bola.id, schoolId, s5.attemptId, { questionId: q5[0], optionId: correctOf(t5, q5[0]) });
  await prisma.studentTestAttempt.update({ where: { id: s5.attemptId }, data: { deadlineAt: new Date(Date.now() - 60 * 1000) } });
  assert.strictEqual(await settleExpiredForTest(t5.id, schoolId), 1);
  const settled = await prisma.studentTestAttempt.findUnique({ where: { id: s5.attemptId } });
  assert.strictEqual(settled.status, "auto_submitted");
  assert.strictEqual(Number(settled.score), 1);
  assert.strictEqual(await settleExpiredForTest(t5.id, schoolId), 0);
  log("an attempt left running past its deadline is finished and scored when the teacher looks, once");

  const controller = require("../res/controller/teacher/TestController");
  const callResults = async (testId, staffId = w.staff.id) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await controller.results({ staffId, schoolId, params: { id: String(testId) } }, res, (e) => { throw e; });
    return res;
  };

  const r1 = await callResults(test.id);
  assert.strictEqual(r1.code, 200);
  const rows = Object.fromEntries(r1.body.data.students.map((x) => [x.name.split(" ")[1], x]));
  assert.strictEqual(rows.Ada.status, "submitted");
  assert.strictEqual(rows.Ada.score, 2);
  assert.strictEqual(rows.Ada.percentage, 66.7);
  assert.strictEqual(rows.Bola.status, "not_started");
  assert.strictEqual(r1.body.data.students.some((x) => x.name.includes("Out")), false, "another class is not listed");
  assert.deepStrictEqual(
    { c: r1.body.data.summary.classSize, s: r1.body.data.summary.submitted, n: r1.body.data.summary.notStarted, a: r1.body.data.summary.average },
    { c: 2, s: 1, n: 1, a: 66.7 }
  );
  const byNumber = r1.body.data.questions;
  assert.strictEqual(byNumber.length, 3);
  assert.strictEqual(byNumber.find((q) => q.questionId === ids[2]).correctPercent, 0);
  assert.strictEqual(byNumber.find((q) => q.questionId === ids[0]).correctPercent, 100);
  log("the teacher sees each student's score, who has not started, class figures and per-question results");

  const notOwner = await callResults(test.id, w.staff.id + 999);
  assert.strictEqual(notOwner.code, 404);
  const draft2 = await callResults(draft.id);
  assert.strictEqual(draft2.code, 409);
  log("another teacher cannot read the results, and a draft has none");

  console.log("\nAll checks passed.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("\n❌ FAILED:", error.message);
    if (error.stack) console.error(error.stack.split("\n").slice(1, 5).join("\n"));
    await prisma.$disconnect();
    process.exit(1);
  });
