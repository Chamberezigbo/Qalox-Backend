/**
 * Rules for multiple-choice test questions, shared by the generator (which must
 * clean up what a model returns) and the editor and publish step (which must
 * never let a broken question reach a student).
 *
 * Pure functions with no database access.
 */

const OPTION_COUNT = 4;
const MAX_QUESTION_CHARS = 1000;
const MAX_OPTION_CHARS = 500;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 50;

const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/**
 * Turns a model's output into questions that are safe to store.
 *
 * A model occasionally returns a question with a missing option, two identical
 * options or an answer index that points nowhere. Those are dropped rather than
 * stored, because a student would be marked against a broken question. The
 * caller decides what to do if too few survive.
 *
 * @param {unknown} raw the parsed `questions` array
 * @returns {Array<{ text: string, explanation: string | null, options: Array<{ text: string, isCorrect: boolean }> }>}
 */
function normalizeGeneratedQuestions(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const questions = [];

  for (const item of raw) {
    const text = clean(item?.text);
    const options = Array.isArray(item?.options) ? item.options.map(clean) : [];
    const correctIndex = item?.correctIndex;

    if (!text || text.length > MAX_QUESTION_CHARS) continue;
    if (options.length !== OPTION_COUNT || options.some((o) => !o || o.length > MAX_OPTION_CHARS)) continue;
    if (new Set(options.map((o) => o.toLowerCase())).size !== OPTION_COUNT) continue;
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= OPTION_COUNT) continue;

    // The same question twice in one test only wastes the student's time.
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const explanation = clean(item?.explanation);
    questions.push({
      text,
      explanation: explanation || null,
      options: options.map((optionText, i) => ({ text: optionText, isCorrect: i === correctIndex })),
    });
  }

  return questions;
}

/**
 * Checks a question as edited by a teacher.
 * @param {{ text?: unknown, options?: unknown }} input
 * @returns {string | null} the first problem
 */
function validateQuestionInput(input) {
  const text = clean(input?.text);
  if (!text) return "The question cannot be blank";
  if (text.length > MAX_QUESTION_CHARS) return `The question is too long (over ${MAX_QUESTION_CHARS} characters)`;

  const options = Array.isArray(input?.options) ? input.options : [];
  if (options.length < 2 || options.length > 6) return "A question needs between 2 and 6 options";

  const texts = options.map((o) => clean(o?.text));
  if (texts.some((t) => !t)) return "Every option needs some text";
  if (texts.some((t) => t.length > MAX_OPTION_CHARS)) return `An option is too long (over ${MAX_OPTION_CHARS} characters)`;
  if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length) return "Two options are the same";

  const correct = options.filter((o) => o?.isCorrect === true).length;
  if (correct !== 1) return "Mark exactly one option as the correct answer";

  return null;
}

/**
 * Everything wrong with a test that stops it being published.
 * @param {{ questions: Array<{ id: number, text: string, options: Array<{ text: string, isCorrect: boolean }> }>, durationMinutes: number, opensAt?: Date | null, closesAt?: Date | null }} test
 * @returns {string[]}
 */
function publishProblems(test) {
  const problems = [];
  const questions = test.questions ?? [];

  if (questions.length < MIN_QUESTIONS) problems.push("Add at least one question");
  if (questions.length > MAX_QUESTIONS) problems.push(`A test can have at most ${MAX_QUESTIONS} questions`);

  questions.forEach((q, index) => {
    const problem = validateQuestionInput(q);
    if (problem) problems.push(`Question ${index + 1}: ${problem}`);
  });

  if (!Number.isFinite(test.durationMinutes) || test.durationMinutes < 1 || test.durationMinutes > 300) {
    problems.push("The duration must be between 1 and 300 minutes");
  }
  if (test.opensAt && test.closesAt && new Date(test.closesAt) <= new Date(test.opensAt)) {
    problems.push("The closing time must be after the opening time");
  }

  return problems;
}

module.exports = {
  OPTION_COUNT,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  normalizeGeneratedQuestions,
  validateQuestionInput,
  publishProblems,
};
