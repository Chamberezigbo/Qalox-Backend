const prisma = require("../../util/prisma");
const { EXAMS, canonicalSubject, questionLabel } = require("../../util/practiceCatalog");
const { pickQuestionIds, gradeAnswers, examMinutes } = require("../../util/practiceQuestions");
const { PracticeError } = require("../../util/practiceError");

/**
 * A student practising past questions. Two modes:
 *   practice: the right answer and the explanation appear straight after each answer;
 *   exam:     timed, nothing is revealed until the end.
 * The set of questions is chosen once, at the start, and frozen on the session. In exam mode the correct
 * answers never leave the server before the session is finished.
 */

const COUNTS = [10, 20, 40];
const MIN_BANK = 5; // fewer approved questions than this: not enough to practise from yet
const COMING_SOON_BELOW = 10;
const SESSIONS_PER_DAY = 40;
const REPORTS_TO_HIDE = 3;

const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const idsOf = (session) => (Array.isArray(session.questionIds) ? session.questionIds : []);

async function loadSession(studentId, sessionId) {
  const id = Number(sessionId);
  const session = Number.isInteger(id) ? await prisma.practiceSession.findFirst({ where: { id, studentId } }) : null;
  if (!session) throw new PracticeError("Practice session not found", 404, "NOT_FOUND");
  return session;
}

/** The questions of a session, in the order they were chosen, with their options. */
async function loadQuestions(ids) {
  const rows = await prisma.practiceQuestion.findMany({
    where: { id: { in: ids } },
    include: { options: { orderBy: { order: "asc" } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

const label = (q) => questionLabel({ exam: q.exam, source: q.source, year: q.year });

/** The answer for one question: what to show the student once they have answered (or finished). */
const reveal = (q, selectedOptionId) => {
  const correct = q.options.find((o) => o.isCorrect);
  return { selectedOptionId, correctOptionId: correct?.id ?? null, isCorrect: !!correct && selectedOptionId === correct.id, explanation: q.explanation };
};

async function inProgressPayload(session) {
  const [questions, answers] = await Promise.all([
    loadQuestions(idsOf(session)),
    prisma.practiceAnswer.findMany({ where: { sessionId: session.id } }),
  ]);
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const answeredMap = {};
  const revealed = {};
  for (const q of questions) {
    const a = byQuestion.get(q.id);
    if (!a) continue;
    answeredMap[q.id] = a.selectedOptionId;
    // Practice mode shows the answer as soon as it is given, so a returning student sees what they saw.
    if (session.mode === "practice") revealed[q.id] = reveal(q, a.selectedOptionId);
  }
  return {
    sessionId: session.id,
    status: "in_progress",
    exam: session.exam,
    examName: EXAMS.find((e) => e.key === session.exam)?.name ?? session.exam,
    subject: session.subject,
    mode: session.mode,
    startedAt: session.startedAt,
    deadlineAt: session.deadlineAt,
    serverNow: new Date().toISOString(),
    questions: questions.map((q, i) => ({
      id: q.id, number: i + 1, text: q.text, topic: q.topic, label: label(q),
      options: q.options.map((o) => ({ id: o.id, text: o.text })), // never isCorrect
    })),
    answers: answeredMap,
    revealed,
  };
}

async function resultPayload(session) {
  const [questions, answers] = await Promise.all([
    loadQuestions(idsOf(session)),
    prisma.practiceAnswer.findMany({ where: { sessionId: session.id } }),
  ]);
  const selected = new Map(answers.map((a) => [a.questionId, a.selectedOptionId]));
  const review = questions.map((q, i) => {
    const r = reveal(q, selected.get(q.id) ?? null);
    return {
      number: i + 1, questionId: q.id, text: q.text, topic: q.topic, label: label(q), explanation: q.explanation,
      selectedOptionId: r.selectedOptionId, isCorrect: r.isCorrect,
      options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
    };
  });
  const wrong = review.filter((r) => !r.isCorrect);
  const weak = new Map();
  for (const r of wrong) if (r.topic) weak.set(r.topic, (weak.get(r.topic) ?? 0) + 1);
  return {
    sessionId: session.id, status: session.status, exam: session.exam, subject: session.subject, mode: session.mode,
    score: session.score ?? 0, total: session.total, percent: session.total ? Math.round(((session.score ?? 0) / session.total) * 100) : 0,
    submittedAt: session.submittedAt, autoSubmitted: session.status === "auto_submitted",
    review,
    topicsToRevise: [...weak.entries()].sort((a, b) => b[1] - a[1]).map(([topic, missed]) => ({ topic, missed })),
    canRetryMissed: wrong.length > 0,
  };
}

/** Grades and closes a session. Safe to call twice at once: only the call that flips the status does the work. */
async function finalize(session, status) {
  const ids = idsOf(session);
  const [questions, answers] = await Promise.all([loadQuestions(ids), prisma.practiceAnswer.findMany({ where: { sessionId: session.id } })]);
  const optionsByQuestion = new Map(questions.map((q) => [q.id, q.options]));
  const selected = new Map(answers.map((a) => [a.questionId, a.selectedOptionId]));
  const { score, total, marked } = gradeAnswers(ids, optionsByQuestion, selected);

  const claimed = await prisma.practiceSession.updateMany({
    where: { id: session.id, status: "in_progress" },
    data: { status, submittedAt: new Date(), score, total },
  });
  if (claimed.count === 1) {
    for (const m of marked.filter((x) => x.selectedOptionId !== null)) {
      await prisma.practiceAnswer.updateMany({ where: { sessionId: session.id, questionId: m.questionId }, data: { isCorrect: m.isCorrect } });
    }
  }
  return resultPayload(await prisma.practiceSession.findUnique({ where: { id: session.id } }));
}

/** Closes a session whose time has run out; returns the settled session, or the same one if time remains. */
async function settleIfExpired(session) {
  if (session.status === "in_progress" && session.deadlineAt && new Date() > session.deadlineAt) {
    await finalize(session, "auto_submitted");
    return prisma.practiceSession.findUnique({ where: { id: session.id } });
  }
  return session;
}

// ─── What the student can pick from ───────────────────────────────────────────

async function catalog() {
  const [counts, years, topics] = await Promise.all([
    prisma.practiceQuestion.groupBy({ by: ["exam", "subject"], where: { status: "approved" }, _count: { _all: true } }),
    prisma.practiceQuestion.groupBy({ by: ["exam", "subject", "year"], where: { status: "approved", year: { not: null } }, _count: { _all: true } }),
    prisma.practiceQuestion.groupBy({ by: ["exam", "subject", "topic"], where: { status: "approved", topic: { not: null } }, _count: { _all: true } }),
  ]);
  return {
    counts: COUNTS,
    exams: EXAMS.map((e) => {
      const subjects = e.subjects.map((name) => {
        const count = counts.find((c) => c.exam === e.key && c.subject === name)?._count._all ?? 0;
        return {
          name, count, comingSoon: count < COMING_SOON_BELOW,
          years: years.filter((y) => y.exam === e.key && y.subject === name).map((y) => y.year).sort((a, b) => b - a),
          topics: topics.filter((t) => t.exam === e.key && t.subject === name).map((t) => ({ name: t.topic, count: t._count._all })).sort((a, b) => b.count - a.count),
        };
      });
      return { key: e.key, name: e.name, fullName: e.fullName, level: e.level, total: subjects.reduce((s, x) => s + x.count, 0), subjects };
    }),
  };
}

// ─── Sessions ──────────────────────────────────────────────────────────────────

/**
 * @param {{ studentId: number, schoolId: number, exam: string, subject: string, mode: string, count?: number, year?: number, topic?: string, retryFromSessionId?: number }} input
 */
async function startSession({ studentId, schoolId, exam, subject, mode, count = 20, year, topic, retryFromSessionId }) {
  if (!["practice", "exam"].includes(mode)) throw new PracticeError("mode must be practice or exam", 400, "INVALID_MODE");

  const today = await prisma.practiceSession.count({ where: { studentId, startedAt: { gte: startOfToday() } } });
  if (today >= SESSIONS_PER_DAY) throw new PracticeError("You have done a lot of practice today. Come back tomorrow for more.", 429, "DAILY_LIMIT");

  let useExam = exam;
  let useSubject = subject;
  let ids;
  let topicFilter = topic || null;
  let yearFilter = year ? Number(year) : null;

  if (retryFromSessionId) {
    // Only the questions missed (or skipped) last time.
    const previous = await loadSession(studentId, retryFromSessionId);
    if (previous.status === "in_progress") throw new PracticeError("Finish that practice first", 409, "STILL_IN_PROGRESS");
    useExam = previous.exam;
    useSubject = previous.subject;
    topicFilter = previous.topic;
    yearFilter = previous.year;
    const answers = await prisma.practiceAnswer.findMany({ where: { sessionId: previous.id } });
    const rightIds = new Set(answers.filter((a) => a.isCorrect).map((a) => a.questionId));
    const missed = idsOf(previous).filter((id) => !rightIds.has(id));
    if (missed.length === 0) throw new PracticeError("You got every question right. Nothing to retry.", 409, "NOTHING_TO_RETRY");
    // Questions hidden or rejected since are dropped.
    const stillGood = await prisma.practiceQuestion.findMany({ where: { id: { in: missed }, status: "approved" }, select: { id: true } });
    const good = new Set(stillGood.map((q) => q.id));
    ids = missed.filter((id) => good.has(id));
    if (ids.length === 0) throw new PracticeError("Those questions are no longer available", 409, "NOTHING_TO_RETRY");
  } else {
    const canonical = canonicalSubject(useExam, useSubject);
    if (!canonical) throw new PracticeError("Choose an exam and a subject from the list", 400, "UNKNOWN_SUBJECT");
    useSubject = canonical;
    if (!COUNTS.includes(Number(count))) throw new PracticeError(`Choose ${COUNTS.join(", ")} questions`, 400, "INVALID_COUNT");

    const candidates = await prisma.practiceQuestion.findMany({
      where: { exam: useExam, subject: useSubject, status: "approved", ...(yearFilter ? { year: yearFilter } : {}), ...(topicFilter ? { topic: topicFilter } : {}) },
      select: { id: true },
      take: 5000,
    });
    if (candidates.length < MIN_BANK) {
      throw new PracticeError("There are not enough questions for that choice yet. Try another subject, or all years and topics.", 409, "NOT_ENOUGH_QUESTIONS");
    }
    const seenRows = await prisma.practiceAnswer.findMany({
      where: { session: { studentId, exam: useExam, subject: useSubject } },
      select: { questionId: true },
      distinct: ["questionId"],
    });
    ids = pickQuestionIds(candidates.map((c) => c.id), new Set(seenRows.map((r) => r.questionId)), Number(count));
  }

  const minutes = mode === "exam" ? examMinutes(ids.length) : null;
  const session = await prisma.practiceSession.create({
    data: {
      studentId, schoolId, exam: useExam, subject: useSubject, mode, topic: topicFilter, year: yearFilter,
      questionIds: ids, total: ids.length, durationMinutes: minutes,
      deadlineAt: minutes ? new Date(Date.now() + minutes * 60 * 1000) : null,
    },
  });
  return inProgressPayload(session);
}

async function getSession(studentId, sessionId) {
  const session = await settleIfExpired(await loadSession(studentId, sessionId));
  return session.status === "in_progress" ? inProgressPayload(session) : resultPayload(session);
}

async function saveAnswer(studentId, sessionId, { questionId, optionId }) {
  const session = await settleIfExpired(await loadSession(studentId, sessionId));
  if (session.status !== "in_progress") throw new PracticeError("This practice has finished", 409, "FINISHED");

  const qid = Number(questionId);
  if (!idsOf(session).includes(qid)) throw new PracticeError("That question is not part of this practice", 400, "NOT_IN_SESSION");
  const question = (await loadQuestions([qid]))[0];
  if (!question) throw new PracticeError("That question is no longer available", 409, "GONE");
  const oid = Number(optionId);
  if (!question.options.some((o) => o.id === oid)) throw new PracticeError("That option does not belong to the question", 400, "BAD_OPTION");

  const existing = await prisma.practiceAnswer.findUnique({ where: { sessionId_questionId: { sessionId: session.id, questionId: qid } } });
  if (session.mode === "practice") {
    // The answer is shown at once, so it cannot be changed afterwards.
    if (existing?.selectedOptionId != null) {
      throw Object.assign(new PracticeError("You already answered this one", 409, "ALREADY_ANSWERED"), { reveal: reveal(question, existing.selectedOptionId) });
    }
    const r = reveal(question, oid);
    await prisma.practiceAnswer.upsert({
      where: { sessionId_questionId: { sessionId: session.id, questionId: qid } },
      create: { sessionId: session.id, questionId: qid, selectedOptionId: oid, isCorrect: r.isCorrect },
      update: { selectedOptionId: oid, isCorrect: r.isCorrect },
    });
    return { saved: true, ...r };
  }

  // Exam mode: kept, but not graded or revealed until the end.
  await prisma.practiceAnswer.upsert({
    where: { sessionId_questionId: { sessionId: session.id, questionId: qid } },
    create: { sessionId: session.id, questionId: qid, selectedOptionId: oid },
    update: { selectedOptionId: oid },
  });
  return { saved: true };
}

async function submit(studentId, sessionId) {
  const session = await loadSession(studentId, sessionId);
  if (session.status !== "in_progress") return resultPayload(session);
  const expired = session.deadlineAt && new Date() > session.deadlineAt;
  return finalize(session, expired ? "auto_submitted" : "submitted");
}

// ─── History and progress ──────────────────────────────────────────────────────

async function history(studentId) {
  const rows = await prisma.practiceSession.findMany({
    where: { studentId, status: { not: "in_progress" } },
    orderBy: { id: "desc" }, take: 20,
  });
  return rows.map((s) => ({
    sessionId: s.id, exam: s.exam, examName: EXAMS.find((e) => e.key === s.exam)?.name ?? s.exam, subject: s.subject, mode: s.mode,
    score: s.score ?? 0, total: s.total, percent: s.total ? Math.round(((s.score ?? 0) / s.total) * 100) : 0, submittedAt: s.submittedAt,
  }));
}

/** Score per subject and the topics a student gets wrong most often. */
async function progress(studentId) {
  const [sessions, answers] = await Promise.all([
    prisma.practiceSession.findMany({ where: { studentId, status: { not: "in_progress" } }, select: { exam: true, subject: true, score: true, total: true } }),
    prisma.practiceAnswer.findMany({
      where: { session: { studentId, status: { not: "in_progress" } }, isCorrect: { not: null } },
      orderBy: { id: "desc" }, take: 1000,
      select: { isCorrect: true, questionId: true },
    }),
  ]);

  const bySubject = new Map();
  for (const s of sessions) {
    const key = `${s.exam}|${s.subject}`;
    const row = bySubject.get(key) ?? { exam: s.exam, subject: s.subject, sessions: 0, score: 0, total: 0 };
    row.sessions += 1; row.score += s.score ?? 0; row.total += s.total;
    bySubject.set(key, row);
  }

  const topicRows = answers.length
    ? await prisma.practiceQuestion.findMany({ where: { id: { in: [...new Set(answers.map((a) => a.questionId))] } }, select: { id: true, topic: true, subject: true } })
    : [];
  const topicOf = new Map(topicRows.map((q) => [q.id, q]));
  const byTopic = new Map();
  for (const a of answers) {
    const q = topicOf.get(a.questionId);
    if (!q?.topic) continue;
    const key = `${q.subject}|${q.topic}`;
    const row = byTopic.get(key) ?? { subject: q.subject, topic: q.topic, answered: 0, correct: 0 };
    row.answered += 1; if (a.isCorrect) row.correct += 1;
    byTopic.set(key, row);
  }

  return {
    subjects: [...bySubject.values()].map((r) => ({ ...r, examName: EXAMS.find((e) => e.key === r.exam)?.name ?? r.exam, percent: r.total ? Math.round((r.score / r.total) * 100) : 0 })).sort((a, b) => b.sessions - a.sessions),
    // Only topics with enough answers to mean something.
    weakestTopics: [...byTopic.values()].filter((t) => t.answered >= 4).map((t) => ({ ...t, percent: Math.round((t.correct / t.answered) * 100) })).sort((a, b) => a.percent - b.percent).slice(0, 5),
  };
}

// ─── "This question looks wrong" ───────────────────────────────────────────────

async function report(studentId, questionId, reason) {
  const qid = Number(questionId);
  // Only a student who has actually met the question can flag it.
  const met = await prisma.practiceAnswer.findFirst({ where: { questionId: qid, session: { studentId } }, select: { id: true } });
  if (!met) throw new PracticeError("You can only report a question you have answered", 403, "NOT_ANSWERED");

  const text = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.practiceReport.create({ data: { questionId: qid, studentId, reason: text } });
      const updated = await tx.practiceQuestion.update({ where: { id: qid }, data: { reportCount: { increment: 1 } }, select: { reportCount: true, status: true } });
      // Enough students doubting it: off the shelf until the owner looks.
      if (updated.reportCount >= REPORTS_TO_HIDE && updated.status === "approved") {
        await tx.practiceQuestion.update({ where: { id: qid }, data: { status: "hidden" } });
      }
    });
  } catch (error) {
    if (error.code === "P2002") return { reported: true, alreadyReported: true };
    throw error;
  }
  return { reported: true };
}

module.exports = { catalog, startSession, getSession, saveAnswer, submit, history, progress, report, PracticeError, COUNTS, REPORTS_TO_HIDE, SESSIONS_PER_DAY };
