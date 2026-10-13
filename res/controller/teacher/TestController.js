const crypto = require("crypto");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const AiCreditService = require("../../Services/AiCreditService");
const AiGenerationWorker = require("../../Services/AiGenerationWorker");
const GeminiTextService = require("../../Services/GeminiTextService");
const { validateQuestionInput, publishProblems, MAX_QUESTIONS } = require("../../util/testQuestions");
const { buildRows, summarize, questionStats } = require("../../util/testResults");
const { settleExpiredForTest } = require("../../Services/student/StudentTestService");

/**
 * Multiple-choice tests for a teacher's own classes.
 *
 * Generating questions is the only step that costs AI credits; administering a
 * test to any number of students costs nothing, because marking is a plain
 * comparison. A generated test is always a draft: the teacher reviews and edits
 * the questions and publishes it deliberately.
 */

const MAX_JOBS_PER_TEACHER_PER_DAY = 20;
const MAX_GENERATED_QUESTIONS = 40;
const DIFFICULTIES = ["easy", "medium", "hard"];

class TestError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const ok = (res, data, status = 200, message) => res.status(status).json({ success: true, ...(message && { message }), data });

/** Turns a TestError into its response; AppError (credits) and the rest as before. */
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof TestError) {
      return res.status(error.status).json({ success: false, message: error.message, code: error.code, data: error.data });
    }
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    logger.error("[TESTS] Request failed", { error: error.message });
    next(error);
  }
};

async function assertTeaches(staffId, classId, subjectId) {
  const taught = await prisma.teacherAssignment.findFirst({ where: { staffId, classId, subjectId } });
  if (!taught) throw new TestError(403, "You do not teach this subject in this class", "NOT_YOUR_CLASS");
}

/** The teacher's own test, or 404. Another teacher's test is simply not found. */
async function loadTest(req, include) {
  const id = Number(req.params.id);
  const test = Number.isInteger(id)
    ? await prisma.test.findFirst({
        where: { id, createdByStaffId: req.staffId, schoolId: req.schoolId },
        include,
      })
    : null;
  if (!test) throw new TestError(404, "Test not found", "TEST_NOT_FOUND");
  return test;
}

const requireDraft = (test) => {
  if (test.status !== "draft") {
    throw new TestError(409, "This test is already published. Close it to stop students taking it.", "TEST_NOT_DRAFT");
  }
};

const withQuestions = {
  questions: {
    orderBy: { order: "asc" },
    include: { options: { orderBy: { order: "asc" } } },
  },
};

const shapeQuestion = (q) => ({
  id: q.id,
  text: q.text,
  explanation: q.explanation,
  order: q.order,
  marks: q.marks,
  options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, order: o.order })),
});

// ---------------------------------------------------------------------------

/**
 * POST /api/teacher/tests/generate
 * Body: { classId, subjectId, topic?, weekRange?, count, difficulty? }
 */
exports.generate = handle(async (req, res) => {
  const { staffId, schoolId } = req;
  const classId = Number(req.body.classId);
  const subjectId = Number(req.body.subjectId);
  const { topic, weekRange } = req.body;
  const count = parseInt(req.body.count, 10);
  const difficulty = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : "medium";

  if (!classId || !subjectId) throw new TestError(400, "classId and subjectId are required", "INVALID_REQUEST");
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_QUESTIONS) {
    throw new TestError(400, `Choose between 1 and ${MAX_GENERATED_QUESTIONS} questions`, "INVALID_REQUEST");
  }

  await assertTeaches(staffId, classId, subjectId);

  const inFlight = await prisma.aiGenerationJob.findFirst({
    where: { staffId, status: { in: ["queued", "processing"] } },
    select: { id: true },
  });
  if (inFlight) {
    throw new TestError(
      409,
      "You already have a generation running. Wait for it to finish before starting another.",
      "GENERATION_IN_PROGRESS",
      { jobId: inFlight.id }
    );
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if ((await prisma.aiGenerationJob.count({ where: { staffId, createdAt: { gte: since } } })) >= MAX_JOBS_PER_TEACHER_PER_DAY) {
    throw new TestError(429, `You've reached the daily limit of ${MAX_JOBS_PER_TEACHER_PER_DAY} generations. Try again tomorrow.`, "DAILY_LIMIT_REACHED");
  }

  const term = await prisma.academicTerm.findFirst({
    where: { schoolId, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!term) throw new TestError(400, "No active term is set for your school.", "NO_ACTIVE_TERM");

  // Grounding is required, as for lesson notes: without a scheme the questions
  // would be generic and could contradict what the class was actually taught.
  const scheme = await prisma.schemeOfWork.findFirst({
    where: { schoolId, classId, subjectId, academicTermId: term.id, status: "active" },
    select: { id: true, extractedText: true, extractedTextStatus: true },
  });
  if (!scheme) {
    throw new TestError(
      404,
      "No scheme of work has been uploaded for this class and subject this term. Upload one first, or ask your admin to.",
      "SCHEME_OF_WORK_NOT_FOUND"
    );
  }
  if (scheme.extractedTextStatus !== "ready") {
    throw new TestError(400, "The scheme of work for this class and subject couldn't be read. Replace it with a PDF or clearer photos.", "SCHEME_OF_WORK_UNREADABLE");
  }

  const excerpt = GeminiTextService.buildContextExcerpt(scheme.extractedText, topic);
  const estimatedInputTokens = AiCreditService.estimateTokensFromText(excerpt) + 500;
  const estimatedOutputTokens = GeminiTextService.examOutputCeiling(count);

  // Throws before any job exists if the school cannot afford it.
  const { reserved } = await AiCreditService.reserveCredits(
    schoolId,
    AiCreditService.creditsForTokens({ inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens })
  );

  let job;
  try {
    job = await prisma.aiGenerationJob.create({
      data: {
        id: `aig_${crypto.randomBytes(12).toString("hex")}`,
        schoolId,
        staffId,
        jobType: "exam_questions",
        schemeOfWorkId: scheme.id,
        classId,
        subjectId,
        academicTermId: term.id,
        inputParamsJson: JSON.stringify({ topic, weekRange, count, difficulty }),
        status: "queued",
        model: GeminiTextService.getModel(),
        estimatedInputTokens,
        estimatedOutputTokens,
        creditsReserved: reserved,
      },
    });
  } catch (error) {
    await AiCreditService.refundCredits(schoolId, reserved).catch(() => {});
    throw error;
  }

  setImmediate(() => {
    AiGenerationWorker.processJob({ jobId: job.id }).catch((error) => {
      logger.error("[TESTS] Worker crashed", { jobId: job.id, error: error.message });
    });
  });

  return ok(res, { jobId: job.id, creditsReserved: reserved }, 202, "Generation started");
});

/** GET /api/teacher/tests */
exports.list = handle(async (req, res) => {
  const tests = await prisma.test.findMany({
    where: { createdByStaffId: req.staffId, schoolId: req.schoolId },
    orderBy: { createdAt: "desc" },
    include: {
      class: { select: { id: true, name: true, customName: true } },
      subject: { select: { id: true, name: true } },
      _count: { select: { questions: true, attempts: true } },
    },
  });

  return ok(
    res,
    tests.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      durationMinutes: t.durationMinutes,
      class: t.class,
      subject: t.subject,
      questionCount: t._count.questions,
      attemptCount: t._count.attempts,
      publishedAt: t.publishedAt,
      createdAt: t.createdAt,
    }))
  );
});

/** GET /api/teacher/tests/:id */
exports.get = handle(async (req, res) => {
  const test = await loadTest(req, {
    ...withQuestions,
    class: { select: { id: true, name: true, customName: true } },
    subject: { select: { id: true, name: true } },
    _count: { select: { attempts: true } },
  });

  return ok(res, {
    id: test.id,
    title: test.title,
    instructions: test.instructions,
    status: test.status,
    durationMinutes: test.durationMinutes,
    maxAttempts: test.maxAttempts,
    shuffleQuestions: test.shuffleQuestions,
    showResultsImmediately: test.showResultsImmediately,
    opensAt: test.opensAt,
    closesAt: test.closesAt,
    publishedAt: test.publishedAt,
    class: test.class,
    subject: test.subject,
    attemptCount: test._count.attempts,
    questions: test.questions.map(shapeQuestion),
  });
});

/**
 * PATCH /api/teacher/tests/:id
 * Settings, while the test is still a draft.
 */
exports.update = handle(async (req, res) => {
  const test = await loadTest(req);
  requireDraft(test);

  const b = req.body ?? {};
  const data = {};

  if (b.title !== undefined) {
    const title = String(b.title).trim();
    if (!title || title.length > 255) throw new TestError(400, "The title must be 1 to 255 characters", "INVALID_REQUEST");
    data.title = title;
  }
  if (b.instructions !== undefined) {
    const text = b.instructions === null ? "" : String(b.instructions).trim();
    if (text.length > 2000) throw new TestError(400, "The instructions are too long", "INVALID_REQUEST");
    data.instructions = text || null;
  }
  if (b.durationMinutes !== undefined) {
    const n = Number(b.durationMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 300) throw new TestError(400, "The duration must be between 1 and 300 minutes", "INVALID_REQUEST");
    data.durationMinutes = n;
  }
  if (b.maxAttempts !== undefined) {
    const n = Number(b.maxAttempts);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new TestError(400, "Attempts must be between 1 and 5", "INVALID_REQUEST");
    data.maxAttempts = n;
  }
  for (const key of ["shuffleQuestions", "showResultsImmediately"]) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== "boolean") throw new TestError(400, `${key} must be true or false`, "INVALID_REQUEST");
      data[key] = b[key];
    }
  }
  for (const key of ["opensAt", "closesAt"]) {
    if (b[key] !== undefined) {
      if (b[key] === null || b[key] === "") data[key] = null;
      else {
        const date = new Date(b[key]);
        if (Number.isNaN(date.getTime())) throw new TestError(400, `${key} is not a valid date`, "INVALID_REQUEST");
        data[key] = date;
      }
    }
  }

  const opens = "opensAt" in data ? data.opensAt : test.opensAt;
  const closes = "closesAt" in data ? data.closesAt : test.closesAt;
  if (opens && closes && closes <= opens) {
    throw new TestError(400, "The closing time must be after the opening time", "INVALID_REQUEST");
  }

  const updated = await prisma.test.update({ where: { id: test.id }, data });
  return ok(res, { id: updated.id }, 200, "Test updated");
});

/** POST /api/teacher/tests/:id/questions */
exports.addQuestion = handle(async (req, res) => {
  const test = await loadTest(req, { _count: { select: { questions: true } } });
  requireDraft(test);

  if (test._count.questions >= MAX_QUESTIONS) {
    throw new TestError(400, `A test can have at most ${MAX_QUESTIONS} questions`, "INVALID_REQUEST");
  }
  const problem = validateQuestionInput(req.body);
  if (problem) throw new TestError(400, problem, "INVALID_QUESTION");

  const last = await prisma.question.findFirst({ where: { testId: test.id }, orderBy: { order: "desc" }, select: { order: true } });
  const question = await prisma.question.create({
    data: {
      testId: test.id,
      type: "multiple_choice",
      text: String(req.body.text).trim(),
      explanation: req.body.explanation ? String(req.body.explanation).trim() : null,
      order: (last?.order ?? 0) + 1,
      options: {
        create: req.body.options.map((o, i) => ({ text: String(o.text).trim(), isCorrect: o.isCorrect === true, order: i + 1 })),
      },
    },
    include: { options: { orderBy: { order: "asc" } } },
  });

  return ok(res, shapeQuestion(question), 201, "Question added");
});

/** PATCH /api/teacher/tests/:id/questions/:questionId  (replaces the question's text and options) */
exports.updateQuestion = handle(async (req, res) => {
  const test = await loadTest(req);
  requireDraft(test);

  const questionId = Number(req.params.questionId);
  const existing = Number.isInteger(questionId)
    ? await prisma.question.findFirst({ where: { id: questionId, testId: test.id } })
    : null;
  if (!existing) throw new TestError(404, "Question not found", "QUESTION_NOT_FOUND");

  const problem = validateQuestionInput(req.body);
  if (problem) throw new TestError(400, problem, "INVALID_QUESTION");

  // A draft has no answers, so replacing the options outright is safe and keeps
  // the "exactly one correct" rule in one place.
  const question = await prisma.$transaction(async (tx) => {
    await tx.questionOption.deleteMany({ where: { questionId: existing.id } });
    return tx.question.update({
      where: { id: existing.id },
      data: {
        text: String(req.body.text).trim(),
        explanation: req.body.explanation ? String(req.body.explanation).trim() : null,
        options: {
          create: req.body.options.map((o, i) => ({ text: String(o.text).trim(), isCorrect: o.isCorrect === true, order: i + 1 })),
        },
      },
      include: { options: { orderBy: { order: "asc" } } },
    });
  });

  return ok(res, shapeQuestion(question), 200, "Question updated");
});

/** DELETE /api/teacher/tests/:id/questions/:questionId */
exports.deleteQuestion = handle(async (req, res) => {
  const test = await loadTest(req);
  requireDraft(test);

  const questionId = Number(req.params.questionId);
  const existing = Number.isInteger(questionId)
    ? await prisma.question.findFirst({ where: { id: questionId, testId: test.id }, select: { id: true } })
    : null;
  if (!existing) throw new TestError(404, "Question not found", "QUESTION_NOT_FOUND");

  await prisma.$transaction(async (tx) => {
    await tx.questionOption.deleteMany({ where: { questionId: existing.id } });
    await tx.question.delete({ where: { id: existing.id } });
    // Keep the numbering gapless, so "question 7" always means the 7th.
    const rest = await tx.question.findMany({ where: { testId: test.id }, orderBy: { order: "asc" }, select: { id: true } });
    for (let i = 0; i < rest.length; i++) {
      await tx.question.update({ where: { id: rest[i].id }, data: { order: i + 1 } });
    }
  });

  return ok(res, { deleted: true }, 200, "Question deleted");
});

/** POST /api/teacher/tests/:id/publish */
exports.publish = handle(async (req, res) => {
  const test = await loadTest(req, withQuestions);
  requireDraft(test);

  const problems = publishProblems({
    questions: test.questions.map(shapeQuestion),
    durationMinutes: test.durationMinutes,
    opensAt: test.opensAt,
    closesAt: test.closesAt,
  });
  if (problems.length > 0) {
    throw new TestError(400, problems[0], "CANNOT_PUBLISH", { problems });
  }

  // Guarded on still being a draft, so two taps cannot publish twice.
  const { count } = await prisma.test.updateMany({
    where: { id: test.id, status: "draft" },
    data: { status: "published", publishedAt: new Date() },
  });
  if (count === 0) throw new TestError(409, "This test was just published.", "TEST_NOT_DRAFT");

  return ok(res, { id: test.id, status: "published" }, 200, "Test published");
});

/**
 * GET /api/teacher/tests/:id/results
 * How the class did: a row per student, class figures and which questions were
 * missed most. Only for the teacher who set the test.
 */
exports.results = handle(async (req, res) => {
  const test = await loadTest(req, {
    questions: { orderBy: { order: "asc" }, select: { id: true, text: true, order: true } },
  });
  if (test.status === "draft") {
    throw new TestError(409, "Nobody can take a draft, so there are no results yet.", "TEST_NOT_PUBLISHED");
  }

  // Finish attempts that ran out of time unseen, so every score is final.
  await settleExpiredForTest(test.id, req.schoolId);

  const attempts = await prisma.studentTestAttempt.findMany({
    where: { testId: test.id },
    select: { id: true, studentId: true, attemptNumber: true, status: true, score: true, totalPossible: true, submittedAt: true },
  });
  const numeric = attempts.map((a) => ({
    ...a,
    score: a.score === null ? null : Number(a.score),
    totalPossible: a.totalPossible === null ? null : Number(a.totalPossible),
  }));

  // The class as it is now, plus anyone outside it who has an attempt on record.
  const inClass = await prisma.student.findMany({
    where: { schoolId: req.schoolId, classId: test.classId, status: "active" },
    select: { id: true, name: true, surname: true, registrationNumber: true },
    orderBy: [{ surname: "asc" }, { name: "asc" }],
  });
  const known = new Set(inClass.map((s) => s.id));
  const extraIds = [...new Set(numeric.map((a) => a.studentId))].filter((id) => !known.has(id));
  const others = extraIds.length
    ? await prisma.student.findMany({
        where: { id: { in: extraIds }, schoolId: req.schoolId },
        select: { id: true, name: true, surname: true, registrationNumber: true },
      })
    : [];

  const rows = buildRows([...inClass, ...others], numeric);

  const bestIds = rows.map((r) => r.bestAttemptId).filter((id) => id !== null);
  const answers = bestIds.length
    ? await prisma.studentAnswer.findMany({
        where: { attemptId: { in: bestIds } },
        select: { questionId: true, isCorrect: true, selectedOptionId: true },
      })
    : [];

  return ok(res, {
    test: { id: test.id, title: test.title, status: test.status, questionCount: test.questions.length },
    summary: summarize(rows),
    students: rows,
    questions: questionStats(test.questions, answers, bestIds.length),
  });
});

/** POST /api/teacher/tests/:id/close — students can no longer start or continue it. */
exports.close = handle(async (req, res) => {
  const test = await loadTest(req);
  if (test.status !== "published") {
    throw new TestError(409, "Only a published test can be closed.", "TEST_NOT_PUBLISHED");
  }
  await prisma.test.update({ where: { id: test.id }, data: { status: "closed" } });
  return ok(res, { id: test.id, status: "closed" }, 200, "Test closed");
});

/**
 * DELETE /api/teacher/tests/:id
 * A draft, or a test no student has started. Anything with attempts is kept:
 * those are students' recorded work.
 */
exports.remove = handle(async (req, res) => {
  const test = await loadTest(req, { _count: { select: { attempts: true } } });
  if (test._count.attempts > 0) {
    throw new TestError(409, "Students have already taken this test, so it is kept. Close it instead.", "TEST_HAS_ATTEMPTS");
  }

  await prisma.$transaction(async (tx) => {
    const questions = await tx.question.findMany({ where: { testId: test.id }, select: { id: true } });
    await tx.questionOption.deleteMany({ where: { questionId: { in: questions.map((q) => q.id) } } });
    await tx.question.deleteMany({ where: { testId: test.id } });
    await tx.test.delete({ where: { id: test.id } });
  });

  return ok(res, { deleted: true }, 200, "Test deleted");
});

exports.TestError = TestError;
