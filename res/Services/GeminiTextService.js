const logger = require("../config/logger");

/**
 * Text generation grounded in a school's own Scheme of Work.
 *
 * Sibling to GeminiService.js (register table transcription) and
 * GeminiProseService.js (reading a photographed page). Same provider and call
 * shape, different job: this one writes new content rather than transcribing
 * existing content, so it is the only one of the three whose output a teacher
 * is expected to edit before use.
 *
 * Every call here is billed to a school's AI credits, so the response's own
 * token counts are returned alongside the text — those are what get charged
 * (see AiCreditService). maxOutputTokens is set per call type and is also the
 * ceiling the credit reservation is calculated against, so a generation can
 * never cost more than was reserved for it.
 */

const DEFAULT_MODEL = "gemini-2.0-flash";
const REQUEST_TIMEOUT_MS = 60000; // generation is slower than transcription

/**
 * Also the ceiling AiCreditService reserves against — keep the two in step.
 *
 * This budget covers the model's *thinking* tokens as well as the text it
 * returns. gemini-2.5-flash was spending 700-1200 tokens thinking before
 * writing anything, which at the previous 2048 ceiling left too little for the
 * note itself: roughly one generation in three came back truncated mid-string
 * and therefore unparseable as JSON. Thinking is disabled below and the
 * ceiling raised, so the whole budget goes to the note.
 */
const LESSON_NOTE_MAX_OUTPUT_TOKENS = 4096;

/** How much scheme-of-work text is ever sent as context, in characters. */
const MAX_CONTEXT_CHARS = 12000;

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY must be set in the environment");
  return key;
};

const getModel = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

const LESSON_NOTE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    objectives: { type: "array", items: { type: "string" } },
    content: { type: "string" },
  },
  required: ["title", "objectives", "content"],
};

/**
 * Trims the scheme to the part that matters for this topic.
 *
 * Sending the whole term's scheme for a single week's lesson costs input
 * tokens on every generation and buries the relevant section in noise. When a
 * topic is given, the excerpt is centred on where that topic appears; only if
 * it isn't found does this fall back to the opening section.
 *
 * @param {string} schemeText
 * @param {string} [topic]
 * @returns {string}
 */
function buildContextExcerpt(schemeText, topic) {
  const text = (schemeText || "").trim();
  if (text.length <= MAX_CONTEXT_CHARS) return text;

  if (topic) {
    const index = text.toLowerCase().indexOf(topic.trim().toLowerCase());
    if (index !== -1) {
      // Keep a little before the match so the week/heading above it survives.
      const start = Math.max(0, index - 1500);
      return text.slice(start, start + MAX_CONTEXT_CHARS);
    }
  }

  return text.slice(0, MAX_CONTEXT_CHARS);
}

const buildLessonNotePrompt = ({ className, subjectName, topic, weekRange, duration }) => `You are helping a Nigerian secondary school teacher write a lesson note, grounded in their school's own scheme of work.

Lesson details:
- Class: ${className}
- Subject: ${subjectName}
${topic ? `- Topic: ${topic}` : ""}
${weekRange ? `- Week(s): ${weekRange}` : ""}
${duration ? `- Lesson duration: ${duration}` : ""}

Write the lesson note from the scheme of work below. Rules:
- Cover only what the scheme of work actually says for this topic. Do not introduce topics, facts or figures it does not contain.
- Where the scheme is thin on a point, keep the note thin on it too rather than padding it out.
- Write for a teacher to deliver in class: clear structure, plain language, practical classroom activities.
- Use Nigerian examples and context where examples are useful.
- Structure the content in markdown with these sections: Objectives, Entry Behaviour, Instructional Materials, Presentation (step by step), Evaluation, Summary, Assignment.
- The objectives array should hold each learning objective as its own short string.

Return only the requested JSON.`;

/**
 * Generates one lesson note.
 *
 * @param {object} input
 * @param {string} input.schemeText the scheme of work's extracted text
 * @param {string} input.className
 * @param {string} input.subjectName
 * @param {string} [input.topic]
 * @param {string} [input.weekRange]
 * @param {string} [input.duration]
 * @returns {Promise<{ parsed: { title: string, objectives: string[], content: string }, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function generateLessonNote({ schemeText, className, subjectName, topic, weekRange, duration }) {
  const excerpt = buildContextExcerpt(schemeText, topic);

  if (!excerpt) {
    throw new Error(
      "This scheme of work has no readable text, so a lesson note cannot be generated from it."
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent?key=${getApiKey()}`;

  const body = {
    contents: [
      {
        parts: [
          { text: buildLessonNotePrompt({ className, subjectName, topic, weekRange, duration }) },
          { text: `\n\nSCHEME OF WORK:\n${excerpt}` },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: LESSON_NOTE_SCHEMA,
      maxOutputTokens: LESSON_NOTE_MAX_OUTPUT_TOKENS,
      // Writing a lesson note from a short scheme of work is not a reasoning
      // task, and thinking tokens are billed exactly like output tokens — so
      // leaving this on cost the school roughly half of every generation's
      // credits to produce nothing the teacher ever sees. Ignored by models
      // that do not think, so it is safe for gemini-2.0-flash too.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("[GEMINI_TEXT] Request failed", { error: error.message });
    throw new Error(`Gemini request failed: ${error.message}`);
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    logger.warn("[GEMINI_TEXT] Non-OK response", { status: response.status, raw: json });
    throw new Error(json?.error?.message || `Gemini request failed with status ${response.status}`);
  }

  const finish = json.candidates?.[0]?.finishReason;
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text;

  // Checked before parsing, not just when text is missing. A run that stops at
  // the ceiling usually DOES return text — just a JSON document cut off
  // mid-string — so testing this only on an empty response reported a
  // truthful-looking "could not be parsed as JSON" that pointed at the wrong
  // cause entirely.
  if (finish === "MAX_TOKENS") {
    logger.warn("[GEMINI_TEXT] Hit the output ceiling", {
      thoughtsTokens: json.usageMetadata?.thoughtsTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
    });
    throw new Error(
      "The lesson note was cut off before it finished. Try a single topic rather than several weeks."
    );
  }

  if (!raw) {
    logger.warn("[GEMINI_TEXT] No text in response", { finishReason: finish });
    throw new Error(
      finish === "SAFETY"
        ? "Gemini declined to write this lesson note. Try rewording the topic."
        : "Gemini returned no lesson note"
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn("[GEMINI_TEXT] Response was not valid JSON", {
      finishReason: finish,
      rawLength: raw.length,
      tail: raw.slice(-120),
    });
    throw new Error("Gemini returned a response that could not be parsed as JSON");
  }

  if (typeof parsed.content !== "string" || !parsed.content.trim()) {
    throw new Error("Gemini returned an empty lesson note");
  }

  return {
    parsed: {
      title: String(parsed.title || topic || "Lesson Note"),
      objectives: Array.isArray(parsed.objectives) ? parsed.objectives.map((o) => String(o)) : [],
      content: parsed.content,
    },
    usage: {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

module.exports = {
  generateLessonNote,
  getModel,
  buildContextExcerpt,
  LESSON_NOTE_MAX_OUTPUT_TOKENS,
  MAX_CONTEXT_CHARS,
};
