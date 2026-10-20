const crypto = require("crypto");

/**
 * The exam paper a teacher builds with the AI, kept as one JSON document.
 *
 * Both the AI and the teacher's manual edits arrive here as untrusted input, so every
 * paper is rebuilt from scratch: only known fields survive, text and counts are capped,
 * ids are made unique, totals are worked out by the server, and an image can only be one
 * that belongs to this paper's own folder in storage.
 */

const LIMITS = {
  sections: 6,
  questions: 80,
  options: 6,
  textChars: 2000,
  titleChars: 200,
  instructionChars: 800,
  marks: 100,
  images: 12,
};

const SECTION_TYPES = ["objective", "theory"];

const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString("hex")}`;

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

const toMarks = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 2) / 2, LIMITS.marks) : fallback;
};

/** Folder in storage that every image of one paper lives under. */
const imagePrefix = (schoolId, chatId) => `exam-papers/${schoolId}/${chatId}/`;

const OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];

/** What the printed paper shows. All on by default, so an older paper prints as it always did. */
const LAYOUT_DEFAULTS = { showNameDate: true, answerLines: true, showMarks: true, showHeader: true };

const normalizeLayout = (raw) => {
  const input = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(LAYOUT_DEFAULTS)) {
    out[key] = typeof input[key] === "boolean" ? input[key] : fallback;
  }
  return out;
};

// The AI often writes the number or the option letter into the text ("1. Which…", "A. Nigeria"),
// and the printout adds its own, so it would print twice.
const stripQuestionNumber = (text) => text.replace(/^\s*(?:q(?:uestion)?\s*)?\d{1,3}\s*[.):\-–]\s+/i, "").trim();
const stripOptionLetter = (text) => text.replace(/^\s*\(?[A-Fa-f]\s*[.):\-–]\s+/, "").trim();
const stripInstructionsLabel = (text) => text.replace(/^\s*(?:general\s+)?instructions?\s*[:\-–]\s*/i, "").trim();

/**
 * Rebuilds a paper from untrusted input.
 *
 * @param {unknown} raw
 * @param {{ imagePrefix: string, previous?: object | null, fallbackTitle?: string }} ctx
 *   `previous` is the paper before this change: an image the new paper names must either
 *   already be on it or live under `imagePrefix`.
 * @returns {{ paper: object, imageCount: number }}
 */
function normalizePaper(raw, { imagePrefix: prefix, previous = null, fallbackTitle = "Exam paper" }) {
  const input = raw && typeof raw === "object" ? raw : {};
  const sectionsIn = Array.isArray(input.sections) ? input.sections.slice(0, LIMITS.sections) : [];

  const seen = new Set();
  const uniqueId = (candidate, prefixName) => {
    let id = typeof candidate === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(candidate) ? candidate : newId(prefixName);
    while (seen.has(id)) id = newId(prefixName);
    seen.add(id);
    return id;
  };

  const knownImages = new Set(
    (previous?.sections ?? []).flatMap((s) => (s.questions ?? []).map((q) => q.imageKey).filter(Boolean))
  );
  const imageOk = (key) => typeof key === "string" && (key.startsWith(prefix) || knownImages.has(key)) && !key.includes("..");

  let questionCount = 0;
  let imageCount = 0;

  const sections = sectionsIn.map((s, si) => {
    const type = SECTION_TYPES.includes(s?.type) ? s.type : "objective";
    const questionsIn = Array.isArray(s?.questions) ? s.questions : [];

    const questions = [];
    for (const q of questionsIn) {
      if (questionCount >= LIMITS.questions) break;
      const text = stripQuestionNumber(clean(q?.text, LIMITS.textChars));
      if (!text) continue;
      questionCount += 1;

      const question = {
        id: uniqueId(q?.id, "q"),
        text,
        marks: toMarks(q?.marks, type === "objective" ? 1 : 5),
      };

      if (type === "objective") {
        const options = (Array.isArray(q?.options) ? q.options : [])
          .map((o) => stripOptionLetter(clean(typeof o === "string" ? o : o?.text, 500)))
          .filter(Boolean)
          .slice(0, LIMITS.options)
          .map((optText, i) => ({ label: OPTION_LABELS[i], text: optText }));
        question.options = options;
        // The answer is a label (A, B…) that has to be one of the options.
        const answer = clean(q?.answer, 4).toUpperCase();
        question.answer = options.some((o) => o.label === answer) ? answer : "";
      } else {
        question.answer = clean(q?.answer, LIMITS.textChars);
      }

      if (imageOk(q?.imageKey) && imageCount < LIMITS.images) {
        question.imageKey = q.imageKey;
        imageCount += 1;
      }
      questions.push(question);
    }

    return {
      id: uniqueId(s?.id, "s"),
      type,
      title: clean(s?.title, LIMITS.titleChars) || (type === "objective" ? `Section ${String.fromCharCode(65 + si)}: Objective` : `Section ${String.fromCharCode(65 + si)}: Theory`),
      instructions: stripInstructionsLabel(clean(s?.instructions, LIMITS.instructionChars)),
      questions,
    };
  });

  const totalMarks = sections.reduce((sum, s) => sum + s.questions.reduce((n, q) => n + q.marks, 0), 0);
  const duration = Math.round(Number(input.durationMinutes));

  return {
    paper: {
      title: clean(input.title, LIMITS.titleChars) || fallbackTitle,
      instructions: stripInstructionsLabel(clean(input.instructions, LIMITS.instructionChars)),
      layout: normalizeLayout(input.layout ?? previous?.layout),
      durationMinutes: Number.isFinite(duration) && duration > 0 ? Math.min(duration, 600) : null,
      totalMarks,
      sections,
    },
    imageCount,
  };
}

/** Number of questions across all sections. */
const questionCount = (paper) => (paper?.sections ?? []).reduce((n, s) => n + (s.questions?.length ?? 0), 0);

/** Parses a stored paper; null when there is none or it is damaged. */
function parsePaper(json) {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

module.exports = { LAYOUT_DEFAULTS, normalizeLayout, LIMITS, normalizePaper, parsePaper, questionCount, imagePrefix, newId };
