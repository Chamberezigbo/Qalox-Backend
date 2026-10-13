/**
 * Marking and timing rules for multiple-choice tests. Pure functions, no
 * database access, so every rule that decides a student's score is pinned by a
 * test.
 */

/**
 * Marks an attempt.
 *
 * An unanswered question scores zero, and so does an answer that names an option
 * which is not one of that question's options (a stale or tampered request must
 * never earn marks). There is no negative marking.
 *
 * @param {Array<{ id: number, marks: number, options: Array<{ id: number, isCorrect: boolean }> }>} questions
 * @param {Array<{ questionId: number, selectedOptionId: number | null }>} answers
 * @returns {{ score: number, totalPossible: number, perQuestion: Map<number, { selectedOptionId: number | null, isCorrect: boolean, marksAwarded: number }> }}
 */
function gradeAttempt(questions, answers) {
  const chosen = new Map(answers.map((a) => [a.questionId, a.selectedOptionId]));
  const perQuestion = new Map();
  let score = 0;
  let totalPossible = 0;

  for (const question of questions) {
    totalPossible += question.marks;

    const selected = chosen.get(question.id) ?? null;
    const option = selected === null ? null : question.options.find((o) => o.id === selected) ?? null;
    const isCorrect = option !== null && option.isCorrect === true;
    const marksAwarded = isCorrect ? question.marks : 0;

    score += marksAwarded;
    perQuestion.set(question.id, {
      // Only a real option is kept as the student's answer.
      selectedOptionId: option ? option.id : null,
      isCorrect,
      marksAwarded,
    });
  }

  return { score, totalPossible, perQuestion };
}

/** A small seeded generator, so a given attempt always sees the same order. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A repeatable shuffle. Seeded by the attempt, so a student who refreshes the
 * page or resumes on another device gets the same order, while each attempt (and
 * each student) gets a different one. Returns a new array.
 */
function shuffleWithSeed(items, seed) {
  const result = [...items];
  const random = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * The moment an attempt must end: the time allowed from the start, but never
 * later than the test's closing time. Frozen when the attempt starts, so editing
 * the test afterwards cannot move a student's deadline.
 *
 * @param {Date} startedAt
 * @param {number} durationMinutes
 * @param {Date | null} closesAt
 * @returns {Date}
 */
function deadlineFor(startedAt, durationMinutes, closesAt) {
  const byDuration = new Date(startedAt.getTime() + durationMinutes * 60 * 1000);
  if (closesAt && new Date(closesAt) < byDuration) return new Date(closesAt);
  return byDuration;
}

/** Whether a test can be started right now, and if not, why. */
function availability(test, now) {
  if (test.status !== "published") return { open: false, reason: "TEST_NOT_AVAILABLE" };
  if (test.opensAt && now < new Date(test.opensAt)) return { open: false, reason: "TEST_NOT_OPEN" };
  if (test.closesAt && now >= new Date(test.closesAt)) return { open: false, reason: "TEST_CLOSED" };
  return { open: true, reason: null };
}

/** Allowed lateness for the final autosave of a student who pressed Submit at the buzzer. */
const SUBMIT_GRACE_MS = 5 * 1000;

module.exports = { gradeAttempt, shuffleWithSeed, deadlineFor, availability, SUBMIT_GRACE_MS };
