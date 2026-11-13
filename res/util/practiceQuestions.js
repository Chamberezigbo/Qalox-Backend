const crypto = require("crypto");
const { canonicalSubject, EXAM_KEYS } = require("./practiceCatalog");

/**
 * Pure rules for the practice bank: checking and normalising a question (for imports and AI output),
 * de-duplicating, reading a CSV, choosing a set for a session and grading it. No database here.
 */

const LIMITS = { text: 2000, option: 500, explanation: 2000, topic: 120, items: 2000, minOptions: 2, maxOptions: 6 };
const SOURCES = ["past_question", "ai_practice"];
const STATUSES = ["approved", "needs_review", "rejected", "hidden"];
const LETTERS = ["A", "B", "C", "D", "E", "F"];

const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Same question text and options => same hash, however the spacing or capitals differ. */
function contentHash({ text, options }) {
  const normal = [text, ...options.map((o) => o.text)].map((s) => squash(s).toLowerCase()).join("|");
  return crypto.createHash("sha1").update(normal).digest("hex");
}

/** Strips a leading "A." / "(b)" / "1)" the source may have put in front of an option. */
const stripOptionLabel = (text) => squash(text).replace(/^\(?[A-Fa-f1-6][.):\-]\s+/, "");

/**
 * Which option is correct, from a letter ("B"), a 1-based number ("2") or the option's own text.
 * @returns {number} index, or -1
 */
function correctIndexOf(correct, options) {
  if (typeof correct === "number" && Number.isInteger(correct)) return correct >= 0 && correct < options.length ? correct : -1;
  const value = squash(correct);
  if (!value) return -1;
  const byLetter = LETTERS.indexOf(value.toUpperCase());
  if (byLetter !== -1 && value.length === 1) return byLetter < options.length ? byLetter : -1;
  if (/^\d+$/.test(value)) {
    const n = Number(value) - 1;
    return n >= 0 && n < options.length ? n : -1;
  }
  return options.findIndex((o) => squash(o.text).toLowerCase() === value.toLowerCase());
}

/**
 * Checks one incoming question and returns it in the shape that is stored, or the first problem.
 * @param {object} raw { exam, subject, year, topic, source, text, options: string[] | {text}[], correct, explanation }
 * @param {{ defaults?: object, currentYear?: number }} [context]
 * @returns {{ question: object } | { problem: string }}
 */
function normalizeQuestion(raw, { defaults = {}, currentYear = new Date().getUTCFullYear() } = {}) {
  // A blank cell (a CSV column left empty) must not wipe out a default such as the exam or the year.
  const input = { ...defaults };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null || (typeof value === "string" && squash(value) === "")) continue;
    input[key] = value;
  }
  const exam = squash(input.exam).toLowerCase();
  if (!EXAM_KEYS.includes(exam)) return { problem: `Unknown exam "${input.exam}"` };
  const subject = canonicalSubject(exam, input.subject);
  if (!subject) return { problem: `"${input.subject}" is not a ${exam.toUpperCase()} subject` };

  const source = squash(input.source || "past_question");
  if (!SOURCES.includes(source)) return { problem: `source must be ${SOURCES.join(" or ")}` };
  let year = null;
  if (input.year !== undefined && input.year !== null && squash(input.year) !== "") {
    year = Number(input.year);
    if (!Number.isInteger(year) || year < 1970 || year > currentYear) return { problem: `"${input.year}" is not a valid exam year` };
  }
  if (source === "past_question" && year === null) return { problem: "A past question needs the year it was set" };

  const text = squash(input.text);
  if (text.length < 8) return { problem: "The question text is missing or too short" };
  if (text.length > LIMITS.text) return { problem: `The question is longer than ${LIMITS.text} characters` };

  const optionsRaw = Array.isArray(input.options) ? input.options : [];
  const options = optionsRaw.map((o) => ({ text: stripOptionLabel(typeof o === "string" ? o : o?.text) }));
  if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) {
    return { problem: `A question needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options` };
  }
  if (options.some((o) => !o.text || o.text.length > LIMITS.option)) return { problem: `Every option needs text of up to ${LIMITS.option} characters` };
  if (new Set(options.map((o) => o.text.toLowerCase())).size !== options.length) return { problem: "Two options are the same" };

  const correct = correctIndexOf(input.correct ?? input.correctIndex, options);
  if (correct === -1) return { problem: "Say which option is correct (a letter, a number or the option's text)" };

  const explanation = squash(input.explanation) || null;
  if (explanation && explanation.length > LIMITS.explanation) return { problem: `The explanation is longer than ${LIMITS.explanation} characters` };
  const topic = squash(input.topic) || null;
  if (topic && topic.length > LIMITS.topic) return { problem: `The topic is longer than ${LIMITS.topic} characters` };

  const status = input.status === undefined ? undefined : squash(input.status);
  if (status !== undefined && !STATUSES.includes(status)) return { problem: `status must be one of ${STATUSES.join(", ")}` };

  const normalizedOptions = options.map((o, i) => ({ text: o.text, isCorrect: i === correct, order: i + 1 }));
  return { question: { exam, subject, source, year, topic, text, explanation, status, options: normalizedOptions, contentHash: contentHash({ text, options }) } };
}

/** A small CSV reader (quoted fields, doubled quotes, commas and newlines inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * CSV with a header row: exam, subject, year, topic, question, optionA..optionF, correct, explanation, source.
 * Column names are matched loosely (case and spaces ignored).
 */
function csvToItems(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => squash(h).toLowerCase().replace(/[^a-z]/g, ""));
  return rows.map((cells) => {
    const get = (name) => cells[keys.indexOf(name)] ?? "";
    const options = LETTERS.map((l) => get(`option${l.toLowerCase()}`)).filter((v) => squash(v) !== "");
    return {
      exam: get("exam"), subject: get("subject"), year: get("year"), topic: get("topic"),
      text: get("question") || get("text"), options, correct: get("correct") || get("answer"),
      explanation: get("explanation"), source: get("source") || undefined,
    };
  });
}

const shuffle = (list, random = Math.random) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Chooses the questions for a session: ones the student has not seen first (random among them), then,
 * only if more are needed, ones they have seen. Always exactly min(count, available).
 * @param {number[]} candidateIds approved questions matching the filters
 * @param {Set<number>} seen question ids this student has already answered
 */
function pickQuestionIds(candidateIds, seen, count, random = Math.random) {
  const unseen = shuffle(candidateIds.filter((id) => !seen.has(id)), random);
  const seenOnes = shuffle(candidateIds.filter((id) => seen.has(id)), random);
  return [...unseen, ...seenOnes].slice(0, count);
}

/** Right answers out of the questions asked; a skipped question is wrong. */
function gradeAnswers(questionIds, optionsByQuestion, selectedByQuestion) {
  let score = 0;
  const marked = questionIds.map((id) => {
    const selected = selectedByQuestion.get(id) ?? null;
    const correct = (optionsByQuestion.get(id) ?? []).find((o) => o.isCorrect);
    const isCorrect = selected !== null && !!correct && correct.id === selected;
    if (isCorrect) score += 1;
    return { questionId: id, selectedOptionId: selected, isCorrect };
  });
  return { score, total: questionIds.length, marked };
}

/** A session's time allowance for exam mode: just under a minute a question, at least ten minutes. */
const examMinutes = (count) => Math.max(10, Math.round(count * 0.9));

module.exports = { LIMITS, SOURCES, STATUSES, contentHash, normalizeQuestion, parseCsv, csvToItems, pickQuestionIds, gradeAnswers, examMinutes, shuffle };
