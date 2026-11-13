const { callGemini, readStructured } = require("./GeminiTextService");
const { examByKey } = require("../util/practiceCatalog");

/**
 * Writes practice questions in the style of a public exam, and independently re-solves them.
 *
 * Unlike the teacher tools, this is NOT billed to a school's AI credits: the practice bank is a
 * platform asset, built by the platform owner. It is also never allowed to reproduce real papers:
 * the questions follow the syllabus and the style, they are not copies.
 *
 * Two passes, because a wrong "correct answer" in a revision tool teaches a student the wrong thing:
 *   1. generate: write the questions with their answers;
 *   2. solve: a separate call answers each question WITHOUT seeing the author's answer.
 * Only questions where both agree go straight to students (see PracticeBankService).
 */

const OPTIONS_PER_QUESTION = 4;
const MAX_PER_CALL = 20;

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
          topic: { type: "string" },
        },
        required: ["text", "options", "correctIndex", "explanation", "topic"],
      },
    },
  },
  required: ["questions"],
};

const SOLVE_SCHEMA = {
  type: "object",
  properties: {
    answers: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, index: { type: "integer" } }, required: ["id", "index"] } },
  },
  required: ["answers"],
};

const TOPICS_SCHEMA = { type: "object", properties: { topics: { type: "array", items: { type: "string" } } }, required: ["topics"] };

const styleOf = (examKey) => {
  const exam = examByKey(examKey);
  if (examKey === "bece") return `the ${exam.fullName} (BECE) objective paper for JSS 3 students in Nigeria`;
  if (examKey === "tvet") return `a Nigerian technical and vocational (TVET) trade examination objective paper`;
  return `the ${exam.fullName} objective (multiple-choice) paper taken by senior secondary students in Nigeria`;
};

const generationPrompt = ({ exam, subject, topic, count, difficulty }) => `You write revision questions for Nigerian students preparing for ${styleOf(exam)}.

Subject: ${subject}.${topic ? ` Topic: ${topic}.` : " Spread the questions across the whole syllabus of the subject."}
Difficulty: ${difficulty}.

Write exactly ${count} multiple-choice questions in the style, wording and difficulty of that exam's papers. Rules:
- Follow the official syllabus for the subject. Test what students are actually taught.
- Write ORIGINAL questions. Do not reproduce any real past paper question word for word.
- Each question has exactly ${OPTIONS_PER_QUESTION} options and exactly one correct answer. correctIndex is the 0-based position of the correct option. Never use "all of the above" or "none of the above".
- Make wrong options plausible but clearly wrong to a student who learned the topic. Vary which position holds the correct answer.
- Questions must be self-contained: no pictures, diagrams, tables or passages the student cannot see.
- Do not put the option letter in the option text, and do not refer to an option by its letter in the explanation.
- explanation is one or two short sentences saying why the answer is correct.
- topic is the specific syllabus topic the question belongs to, in 2 to 5 words.
- Facts, figures and units must be correct. If you are not certain of an answer, write a different question.

Return only the requested JSON.`;

const DIFFICULTY = ["easy", "medium", "hard"];

/** @returns {Promise<Array<{ text: string, options: string[], correctIndex: number, explanation: string, topic: string }>>} */
async function generateQuestions({ exam, subject, topic, count, difficulty = "medium" }) {
  const n = Math.min(Math.max(1, Math.floor(count)), MAX_PER_CALL);
  const level = DIFFICULTY.includes(difficulty) ? difficulty : "medium";
  const json = await callGemini({
    contents: [{ parts: [{ text: generationPrompt({ exam, subject, topic, count: n, difficulty: level }) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: QUESTIONS_SCHEMA,
      temperature: 0.8,
      maxOutputTokens: 1200 + n * 450,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const { parsed } = readStructured(json, {
    cutOff: "The questions were cut off before they finished. Try fewer at a time.",
    declined: "The AI declined to write these questions. Try a different topic.",
    empty: "The AI returned no questions",
  });
  return Array.isArray(parsed.questions) ? parsed.questions : [];
}

/**
 * The independent second pass: answers each question without seeing the author's answer.
 * @param {Array<{ text: string, options: string[] }>} questions
 * @returns {Promise<number[]>} the chosen option index for each question, in order (-1 if it gave none)
 */
async function solveQuestions({ exam, subject, questions }) {
  const listing = questions
    .map((q, i) => `Question ${i}: ${q.text}\n${q.options.map((o, k) => `  ${k}. ${o}`).join("\n")}`)
    .join("\n\n");
  const json = await callGemini({
    contents: [{ parts: [{ text: `You are an experienced examiner for ${styleOf(exam)}, subject: ${subject}.\nFor each question below choose the single best answer. Work carefully and use only what is taught in the syllabus.\nReturn, for every question id, the 0-based index of the option you choose.\n\n${listing}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SOLVE_SCHEMA,
      temperature: 0,
      maxOutputTokens: 300 + questions.length * 30,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const { parsed } = readStructured(json, { cutOff: "The answers were cut off", declined: "The AI declined to answer", empty: "The AI returned no answers" });
  const byId = new Map((parsed.answers ?? []).map((a) => [a.id, a.index]));
  return questions.map((_, i) => (Number.isInteger(byId.get(i)) ? byId.get(i) : -1));
}

/** The syllabus topics worth covering for a subject, so bulk generation spreads across it. */
async function suggestTopics({ exam, subject, max = 12 }) {
  const json = await callGemini({
    contents: [{ parts: [{ text: `List up to ${max} distinct syllabus topics for ${subject} as examined in ${styleOf(exam)}. Short names only (2 to 5 words each), the broadest areas first. Return only the requested JSON.` }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: TOPICS_SCHEMA, temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
  });
  const { parsed } = readStructured(json, { cutOff: "The topic list was cut off", declined: "The AI declined", empty: "The AI returned no topics" });
  return [...new Set((parsed.topics ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, max);
}

module.exports = { generateQuestions, solveQuestions, suggestTopics, MAX_PER_CALL, OPTIONS_PER_QUESTION };
