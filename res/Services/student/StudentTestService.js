const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const { gradeAttempt, shuffleWithSeed, deadlineFor, availability, SUBMIT_GRACE_MS } = require("../../util/testGrading");

/**
 * A student taking a multiple-choice test.
 *
 * Every rule that protects the paper lives here, not in the browser:
 *   - the deadline is fixed when the attempt starts and enforced by the server;
 *   - the correct answers never leave the server before the attempt is over, and
 *     are shown afterwards only if the teacher allowed it;
 *   - marking is a plain comparison, so a student's answer can only ever be
 *     matched against the options of that question.
 *
 * An attempt past its deadline is finished lazily, the next time anything reads
 * or writes it, so no background job is needed and a student who simply closed
 * the tab is still marked.
 */

class StudentTestError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const num = (decimal) => (decimal === null || decimal === undefined ? null : Number(decimal));

const questionInclude = {
  orderBy: { order: "asc" },
  include: { options: { orderBy: { order: "asc" } } },
};

/** The active student and their class: tests are only ever for the student's own class. */
async function loadStudent(studentId, schoolId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId, status: "active" },
    select: { id: true, classId: true },
  });
  if (!student) throw new StudentTestError(404, "Student not found", "STUDENT_NOT_FOUND");
  return student;
}

/** The student's own attempt with its test, or 404: another student's attempt is simply not found. */
async function loadAttempt(studentId, schoolId, attemptId) {
  const id = Number(attemptId);
  const attempt = Number.isInteger(id)
    ? await prisma.studentTestAttempt.findFirst({
        where: { id, studentId, test: { schoolId } },
        include: { test: { include: { questions: questionInclude } }, answers: true },
      })
    : null;
  if (!attempt) throw new StudentTestError(404, "Attempt not found", "ATTEMPT_NOT_FOUND");
  return attempt;
}

/**
 * Marks and closes an attempt that is still in progress.
 *
 * Guarded on the attempt still being in progress, so a submit and an automatic
 * finish racing each other mark it once, and the loser simply reads the result.
 *
 * @param {object} attempt loaded with test.questions.options and answers
 * @param {"submitted" | "auto_submitted"} status
 */
async function finalizeAttempt(attempt, status) {
  const questions = attempt.test.questions.map((q) => ({
    id: q.id,
    marks: q.marks,
    options: q.options.map((o) => ({ id: o.id, isCorrect: o.isCorrect })),
  }));
  const graded = gradeAttempt(
    questions,
    attempt.answers.map((a) => ({ questionId: a.questionId, selectedOptionId: a.selectedOptionId }))
  );

  // An automatic finish is stamped with the deadline, not with whenever the
  // server next noticed, so a late read does not make the attempt look late.
  const now = new Date();
  const submittedAt = status === "auto_submitted" && attempt.deadlineAt < now ? attempt.deadlineAt : now;

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.studentTestAttempt.updateMany({
      where: { id: attempt.id, status: "in_progress" },
      data: { status, submittedAt, score: graded.score, totalPossible: graded.totalPossible },
    });
    if (count === 0) return; // someone else finished it first

    for (const [questionId, result] of graded.perQuestion) {
      if (!attempt.answers.some((a) => a.questionId === questionId)) continue;
      await tx.studentAnswer.updateMany({
        where: { attemptId: attempt.id, questionId },
        data: { isCorrect: result.isCorrect, marksAwarded: result.marksAwarded },
      });
    }
  });

  return loadAttempt(attempt.studentId, attempt.test.schoolId, attempt.id);
}

/** Finishes the attempt if its time is up, and returns the (possibly updated) attempt. */
async function settleIfExpired(attempt) {
  if (attempt.status !== "in_progress") return attempt;

  const now = new Date();
  const ended = attempt.test.status === "closed" || now > attempt.deadlineAt;
  return ended ? finalizeAttempt(attempt, "auto_submitted") : attempt;
}

/** What the student may see of an attempt that is still going: no answers marked. */
function inProgressPayload(attempt) {
  const { test } = attempt;
  const ordered = test.shuffleQuestions ? shuffleWithSeed(test.questions, attempt.id) : test.questions;

  return {
    attemptId: attempt.id,
    status: "in_progress",
    test: { id: test.id, title: test.title, instructions: test.instructions, durationMinutes: test.durationMinutes },
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    // The clock the deadline is judged by, so the browser can correct for a wrong device clock.
    serverNow: new Date(),
    questions: ordered.map((q, index) => ({
      id: q.id,
      number: index + 1,
      text: q.text,
      marks: q.marks,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
    })),
    answers: Object.fromEntries(attempt.answers.map((a) => [a.questionId, a.selectedOptionId])),
  };
}

/** The result of a finished attempt, with a review only if the teacher allowed it. */
function resultPayload(attempt) {
  const { test } = attempt;
  const show = test.showResultsImmediately;
  const score = num(attempt.score);
  const total = num(attempt.totalPossible);

  const payload = {
    attemptId: attempt.id,
    status: attempt.status,
    autoSubmitted: attempt.status === "auto_submitted",
    test: { id: test.id, title: test.title },
    submittedAt: attempt.submittedAt,
    showResults: show,
    // Withheld, not just hidden, when the teacher chose not to show results.
    score: show ? score : null,
    totalPossible: show ? total : null,
    percentage: show && total ? Math.round((score / total) * 1000) / 10 : null,
  };

  if (show) {
    const answerByQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    payload.review = test.questions.map((q, index) => {
      const answer = answerByQuestion.get(q.id);
      return {
        number: index + 1,
        questionId: q.id,
        text: q.text,
        explanation: q.explanation,
        selectedOptionId: answer?.selectedOptionId ?? null,
        isCorrect: answer?.isCorrect === true,
        options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
      };
    });
  }

  return payload;
}

const payloadFor = (attempt) => (attempt.status === "in_progress" ? inProgressPayload(attempt) : resultPayload(attempt));

/** Tests for the student's class, with where they stand on each. */
async function listForStudent(studentId, schoolId) {
  const student = await loadStudent(studentId, schoolId);

  const tests = await prisma.test.findMany({
    where: {
      schoolId,
      classId: student.classId,
      // A closed test is still listed when the student has taken it, so they can see their score.
      OR: [{ status: "published" }, { status: "closed", attempts: { some: { studentId } } }],
    },
    orderBy: { createdAt: "desc" },
    include: {
      subject: { select: { name: true } },
      _count: { select: { questions: true } },
      attempts: { where: { studentId }, orderBy: { attemptNumber: "desc" } },
    },
  });

  const now = new Date();

  return tests.map((t) => {
    const finished = t.attempts.filter((a) => a.status !== "in_progress");
    // An in-progress attempt whose time is up counts as over; it is marked when opened.
    const live = t.attempts.find((a) => a.status === "in_progress" && a.deadlineAt > now && t.status === "published");
    const window = availability(t, now);

    let state;
    if (live) state = "in_progress";
    else if (!window.open && finished.length === 0) state = window.reason === "TEST_NOT_OPEN" ? "upcoming" : "ended";
    else if (t.attempts.length >= t.maxAttempts) state = "completed";
    else if (!window.open) state = "ended";
    else state = "available";

    const best = finished.length ? Math.max(...finished.map((a) => num(a.score) ?? 0)) : null;

    return {
      id: t.id,
      title: t.title,
      subject: t.subject.name,
      durationMinutes: t.durationMinutes,
      questionCount: t._count.questions,
      maxAttempts: t.maxAttempts,
      attemptsUsed: t.attempts.length,
      opensAt: t.opensAt,
      closesAt: t.closesAt,
      state,
      inProgressAttemptId: live?.id ?? null,
      latestAttemptId: finished[0]?.id ?? null,
      // Scores are only revealed when the teacher allowed it.
      bestScore: t.showResultsImmediately ? best : null,
      showResults: t.showResultsImmediately,
    };
  });
}

/** Starts an attempt, or resumes the one in progress. */
async function startAttempt(studentId, schoolId, testId) {
  const student = await loadStudent(studentId, schoolId);

  const id = Number(testId);
  const test = Number.isInteger(id)
    ? await prisma.test.findFirst({
        where: { id, schoolId, classId: student.classId },
        include: { questions: questionInclude, attempts: { where: { studentId }, orderBy: { attemptNumber: "desc" } } },
      })
    : null;
  if (!test) throw new StudentTestError(404, "Test not found", "TEST_NOT_FOUND");

  // A leftover in-progress attempt is either still running (resume it) or out of
  // time (mark it, which then counts as a used attempt).
  const open = test.attempts.find((a) => a.status === "in_progress");
  if (open) {
    const loaded = await loadAttempt(studentId, schoolId, open.id);
    const settled = await settleIfExpired(loaded);
    if (settled.status === "in_progress") return inProgressPayload(settled);
  }

  const window = availability(test, new Date());
  if (!window.open) {
    const messages = {
      TEST_NOT_OPEN: "This test has not opened yet.",
      TEST_CLOSED: "This test has closed.",
      TEST_NOT_AVAILABLE: "This test is not available.",
    };
    throw new StudentTestError(403, messages[window.reason], window.reason);
  }

  const used = await prisma.studentTestAttempt.count({ where: { testId: test.id, studentId } });
  if (used >= test.maxAttempts) {
    throw new StudentTestError(
      403,
      test.maxAttempts === 1 ? "You have already taken this test." : `You have used all ${test.maxAttempts} attempts.`,
      "NO_ATTEMPTS_LEFT"
    );
  }
  if (test.questions.length === 0) throw new StudentTestError(409, "This test has no questions.", "TEST_EMPTY");

  const startedAt = new Date();
  let created;
  try {
    created = await prisma.studentTestAttempt.create({
      data: {
        testId: test.id,
        studentId,
        attemptNumber: used + 1,
        startedAt,
        // Frozen now: editing the test later cannot move this student's deadline.
        deadlineAt: deadlineFor(startedAt, test.durationMinutes, test.closesAt),
        status: "in_progress",
      },
    });
  } catch (error) {
    // Two taps at once: the unique (test, student, attempt number) index lets one
    // through. The other resumes it instead of failing.
    if (error?.code === "P2002") {
      const existing = await prisma.studentTestAttempt.findFirst({
        where: { testId: test.id, studentId, status: "in_progress" },
      });
      if (existing) return inProgressPayload(await loadAttempt(studentId, schoolId, existing.id));
    }
    throw error;
  }

  logger.info("[CBT] Attempt started", { testId: test.id, studentId, attemptId: created.id });
  return inProgressPayload(await loadAttempt(studentId, schoolId, created.id));
}

/** Resumes an attempt, or shows its result; finishes it first if its time is up. */
async function getAttempt(studentId, schoolId, attemptId) {
  const attempt = await settleIfExpired(await loadAttempt(studentId, schoolId, attemptId));
  return payloadFor(attempt);
}

/** Saves one answer. `optionId: null` clears it. */
async function saveAnswer(studentId, schoolId, attemptId, { questionId, optionId }) {
  const attempt = await loadAttempt(studentId, schoolId, attemptId);

  if (attempt.status !== "in_progress") {
    throw new StudentTestError(409, "This test has already been submitted.", "ATTEMPT_FINISHED");
  }

  // A few seconds of grace, so an answer typed at the buzzer is not lost to
  // network lag; beyond it the attempt is marked as it stands.
  if (attempt.test.status === "closed" || new Date() > new Date(attempt.deadlineAt.getTime() + SUBMIT_GRACE_MS)) {
    await finalizeAttempt(attempt, "auto_submitted");
    throw new StudentTestError(409, "Time is up. Your test has been submitted.", "TEST_TIME_UP");
  }

  const question = attempt.test.questions.find((q) => q.id === Number(questionId));
  if (!question) throw new StudentTestError(400, "That question is not part of this test.", "INVALID_QUESTION");

  let selectedOptionId = null;
  if (optionId !== null && optionId !== undefined) {
    const option = question.options.find((o) => o.id === Number(optionId));
    if (!option) throw new StudentTestError(400, "That option does not belong to this question.", "INVALID_OPTION");
    selectedOptionId = option.id;
  }

  await prisma.studentAnswer.upsert({
    where: { attemptId_questionId: { attemptId: attempt.id, questionId: question.id } },
    create: { attemptId: attempt.id, questionId: question.id, selectedOptionId },
    update: { selectedOptionId },
  });

  return { saved: true, questionId: question.id, selectedOptionId };
}

/** Submits the attempt now. Submitting twice returns the same result. */
async function submitAttempt(studentId, schoolId, attemptId) {
  const attempt = await loadAttempt(studentId, schoolId, attemptId);
  if (attempt.status !== "in_progress") return resultPayload(attempt);

  const finished = await finalizeAttempt(attempt, "submitted");
  logger.info("[CBT] Attempt submitted", { attemptId: attempt.id, studentId, status: finished.status });
  return resultPayload(finished);
}

module.exports = {
  StudentTestError,
  listForStudent,
  startAttempt,
  getAttempt,
  saveAnswer,
  submitAttempt,
  // exposed for the tests
  inProgressPayload,
  resultPayload,
};
