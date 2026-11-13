const prisma = require("../util/prisma");
const logger = require("../config/logger");
const gemini = require("./GeminiPracticeService");
const { canonicalSubject, EXAMS } = require("../util/practiceCatalog");
const { normalizeQuestion, csvToItems, LIMITS, STATUSES } = require("../util/practiceQuestions");
const { PracticeError } = require("../util/practiceError");

/**
 * The platform owner's side of the practice bank: load real past questions, have AI write exam-style
 * ones (double-checked), review what needs a look, and see what is in the bank.
 * Students only ever see `approved` questions (see Services/student/PracticeService.js).
 */

const CHUNK = 100;

const optionRows = (options) => options.map((o) => ({ text: o.text, isCorrect: o.isCorrect, order: o.order }));

/** Which of these (exam, subject, hash) combinations are already in the bank. */
async function existingKeys(questions) {
  if (questions.length === 0) return new Set();
  const found = await prisma.practiceQuestion.findMany({
    where: { contentHash: { in: [...new Set(questions.map((q) => q.contentHash))] } },
    select: { exam: true, subject: true, contentHash: true },
  });
  return new Set(found.map((f) => `${f.exam}|${f.subject}|${f.contentHash}`));
}

async function insertQuestions(questions, status) {
  let created = 0;
  for (let i = 0; i < questions.length; i += CHUNK) {
    const slice = questions.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((q) =>
        prisma.practiceQuestion.create({
          data: {
            exam: q.exam, subject: q.subject, topic: q.topic, year: q.year, source: q.source, text: q.text,
            explanation: q.explanation, status: q.status ?? status, contentHash: q.contentHash,
            options: { create: optionRows(q.options) },
          },
        })
      )
    );
    created += slice.length;
  }
  return created;
}

/**
 * Loads questions (JSON items, or CSV text). Each is checked; bad ones are reported with their position,
 * duplicates (same exam, subject, text and options) are skipped, and the rest are stored as approved.
 * @param {{ items?: object[], csv?: string, defaults?: object }} input defaults fill exam/subject/year/source for every item
 */
async function importQuestions({ items, csv, defaults = {} }) {
  const list = Array.isArray(items) ? items : typeof csv === "string" ? csvToItems(csv) : null;
  if (!list) throw new PracticeError("Send `items` (a list of questions) or `csv` (text with a header row)", 400, "NO_ITEMS");
  if (list.length === 0) throw new PracticeError("There are no questions in this file", 400, "NO_ITEMS");
  if (list.length > LIMITS.items) throw new PracticeError(`Load at most ${LIMITS.items} questions at a time`, 400, "TOO_MANY");

  const valid = [];
  const invalid = [];
  list.forEach((raw, index) => {
    const result = normalizeQuestion(raw, { defaults });
    if (result.problem) invalid.push({ index: index + 1, problem: result.problem });
    else valid.push(result.question);
  });

  const have = await existingKeys(valid);
  const seenInFile = new Set();
  const fresh = [];
  let duplicates = 0;
  for (const q of valid) {
    const key = `${q.exam}|${q.subject}|${q.contentHash}`;
    if (have.has(key) || seenInFile.has(key)) duplicates += 1;
    else {
      seenInFile.add(key);
      fresh.push(q);
    }
  }

  const created = await insertQuestions(fresh, "approved");
  logger.info("[PRACTICE_BANK] Import finished", { received: list.length, created, duplicates, invalid: invalid.length });
  return { received: list.length, created, duplicates, invalid };
}

/**
 * Has AI write exam-style questions, then re-solves them independently. Agreement -> approved (students can
 * see it); disagreement -> needs_review (hidden until the owner looks).
 * @param {{ exam: string, subject: string, topic?: string, count?: number, difficulty?: string }} input
 */
async function generate({ exam, subject, topic, count = 10, difficulty = "medium" }) {
  const canonical = canonicalSubject(exam, subject);
  if (!canonical) throw new PracticeError(`"${subject}" is not a ${String(exam).toUpperCase()} subject`, 400, "UNKNOWN_SUBJECT");
  const wanted = Math.min(Math.max(1, Math.floor(Number(count) || 10)), gemini.MAX_PER_CALL);

  const written = await gemini.generateQuestions({ exam, subject: canonical, topic: topic || undefined, count: wanted, difficulty });

  const candidates = [];
  let rejected = 0;
  for (const raw of written) {
    const result = normalizeQuestion({ exam, subject: canonical, source: "ai_practice", topic: raw.topic || topic, text: raw.text, options: raw.options, correct: raw.correctIndex, explanation: raw.explanation });
    if (result.problem) rejected += 1;
    else candidates.push(result.question);
  }
  if (candidates.length === 0) return { requested: wanted, written: 0, approved: 0, needsReview: 0, duplicates: 0, rejected };

  // The independent check. If it fails, nothing is approved: unchecked questions wait for a person.
  let answers = candidates.map(() => -1);
  try {
    answers = await gemini.solveQuestions({ exam, subject: canonical, questions: candidates.map((c) => ({ text: c.text, options: c.options.map((o) => o.text) })) });
  } catch (error) {
    logger.warn("[PRACTICE_BANK] Second pass failed; questions saved for review", { reason: error.message });
  }
  candidates.forEach((q, i) => {
    const correct = q.options.findIndex((o) => o.isCorrect);
    q.status = answers[i] === correct ? "approved" : "needs_review";
  });

  const have = await existingKeys(candidates);
  const fresh = candidates.filter((q) => !have.has(`${q.exam}|${q.subject}|${q.contentHash}`));
  const created = await insertQuestions(fresh, "needs_review");
  const approved = fresh.filter((q) => q.status === "approved").length;
  logger.info("[PRACTICE_BANK] Generated", { exam, subject: canonical, topic, created, approved });
  return { requested: wanted, written: created, approved, needsReview: created - approved, duplicates: candidates.length - fresh.length, rejected };
}

/** The syllabus topics worth covering for a subject, so a whole subject can be filled topic by topic. */
async function suggestTopics({ exam, subject, max = 12 }) {
  const canonical = canonicalSubject(exam, subject);
  if (!canonical) throw new PracticeError(`"${subject}" is not a ${String(exam).toUpperCase()} subject`, 400, "UNKNOWN_SUBJECT");
  const topics = await gemini.suggestTopics({ exam, subject: canonical, max: Math.min(Math.max(1, Math.floor(Number(max) || 12)), 20) });
  return { subject: canonical, topics };
}

/** @param {{ status?: string, exam?: string, subject?: string, reported?: boolean, limit?: number, offset?: number }} filters */
async function listQuestions({ status, exam, subject, reported, limit = 50, offset = 0 } = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(exam ? { exam } : {}),
    ...(subject ? { subject } : {}),
    ...(reported ? { reportCount: { gt: 0 } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.practiceQuestion.findMany({
      where, orderBy: [{ reportCount: "desc" }, { id: "desc" }], take: Math.min(Math.max(1, limit), 200), skip: Math.max(0, offset),
      include: { options: { orderBy: { order: "asc" } }, reports: { select: { reason: true, createdAt: true }, take: 10 } },
    }),
    prisma.practiceQuestion.count({ where }),
  ]);
  return { total, questions: rows };
}

/** Approve, reject or hide a question, or correct its content (which re-checks it and re-computes its hash). */
async function updateQuestion(id, patch) {
  const current = await prisma.practiceQuestion.findUnique({ where: { id }, include: { options: { orderBy: { order: "asc" } } } });
  if (!current) throw new PracticeError("Question not found", 404, "NOT_FOUND");

  const data = {};
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new PracticeError(`status must be one of ${STATUSES.join(", ")}`, 400, "INVALID_STATUS");
    data.status = patch.status;
    if (patch.status === "approved") data.reportCount = 0;
  }

  const editsContent = ["text", "options", "correct", "explanation", "topic", "year"].some((k) => patch[k] !== undefined);
  let newOptions = null;
  if (editsContent) {
    const merged = {
      exam: current.exam, subject: current.subject, source: current.source, year: patch.year ?? current.year,
      topic: patch.topic ?? current.topic, text: patch.text ?? current.text, explanation: patch.explanation ?? current.explanation,
      options: patch.options ?? current.options.map((o) => o.text),
      correct: patch.correct ?? (patch.options ? undefined : current.options.findIndex((o) => o.isCorrect)),
    };
    const result = normalizeQuestion(merged);
    if (result.problem) throw new PracticeError(result.problem, 400, "INVALID_QUESTION");
    const q = result.question;
    Object.assign(data, { text: q.text, explanation: q.explanation, topic: q.topic, year: q.year, contentHash: q.contentHash });
    newOptions = optionRows(q.options);
  }
  if (Object.keys(data).length === 0) throw new PracticeError("Nothing to change", 400, "NO_CHANGE");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.practiceQuestion.update({ where: { id }, data });
      if (newOptions) {
        await tx.practiceOption.deleteMany({ where: { questionId: id } });
        await tx.practiceOption.createMany({ data: newOptions.map((o) => ({ ...o, questionId: id })) });
      }
    });
  } catch (error) {
    if (error.code === "P2002") throw new PracticeError("An identical question is already in the bank", 409, "DUPLICATE");
    throw error;
  }
  return prisma.practiceQuestion.findUnique({ where: { id }, include: { options: { orderBy: { order: "asc" } } } });
}

/** What is in the bank, by exam and subject, and what is waiting for a look. */
async function stats() {
  const [byStatus, bySubject, reported] = await Promise.all([
    prisma.practiceQuestion.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.practiceQuestion.groupBy({ by: ["exam", "subject", "status", "source"], _count: { _all: true } }),
    prisma.practiceQuestion.count({ where: { reportCount: { gt: 0 } } }),
  ]);
  return {
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    reported,
    exams: EXAMS.map((e) => ({
      key: e.key,
      name: e.name,
      subjects: e.subjects.map((name) => {
        const rows = bySubject.filter((r) => r.exam === e.key && r.subject === name);
        const sum = (pred) => rows.filter(pred).reduce((total, r) => total + r._count._all, 0);
        return { name, approved: sum((r) => r.status === "approved"), needsReview: sum((r) => r.status === "needs_review"), pastQuestions: sum((r) => r.source === "past_question"), aiPractice: sum((r) => r.source === "ai_practice") };
      }),
    })),
  };
}

module.exports = { importQuestions, generate, suggestTopics, listQuestions, updateQuestion, stats };
