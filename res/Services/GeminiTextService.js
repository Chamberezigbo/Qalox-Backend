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

/** How much of a chat is handed to the generator, in characters; the newest part wins. */
const MAX_BRIEF_CHARS = 6000;

/**
 * Turns a chat into the brief the generator is given.
 *
 * Both sides are kept: a teacher's "yes, the second one" means nothing without
 * the question it answers. The hidden opening message and any refinement
 * requests are left out — the first only exists to make the AI ask a question,
 * and refinements apply to a note that already exists.
 *
 * @param {Array<{ role: string, kind?: string, content: string }>} messages oldest first
 * @returns {string} empty when the teacher said nothing
 */
function buildTeacherBrief(messages) {
  const turns = (messages || []).filter((m) => (m.kind ?? "chat") === "chat");
  if (!turns.some((m) => m.role === "user")) return "";

  const text = turns.map((m) => `${m.role === "user" ? "Teacher" : "Assistant"}: ${m.content}`).join("\n");
  return text.length > MAX_BRIEF_CHARS ? text.slice(text.length - MAX_BRIEF_CHARS) : text;
}

const buildLessonNotePrompt = ({ className, subjectName, topic, weekRange, duration, teacherBrief }) => `You are helping a Nigerian secondary school teacher write a lesson note, grounded in their school's own scheme of work.

Lesson details:
- Class: ${className}
- Subject: ${subjectName}
${topic ? `- Topic: ${topic}` : ""}
${weekRange ? `- Week(s): ${weekRange}` : ""}
${duration ? `- Lesson duration: ${duration}` : ""}

Write the lesson note from the scheme of work below. Rules:
- The scheme of work decides WHAT is covered. Cover only what it actually says for this topic. Do not introduce topics, facts or figures it does not contain.
- Where the scheme is thin on a point, keep the note thin on it too rather than padding it out.${
  teacherBrief
    ? `
- The teacher's own instructions (their conversation with you, below) decide HOW the lesson is taught: approach, activities, examples, resources, depth and length. Follow them closely and let them shape every section, so the note fits this teacher's class and is not generic. If an instruction asks for content the scheme does not contain, keep to the scheme.`
    : ""
}
- Write for a teacher to deliver in class: clear structure, plain language, practical classroom activities.
- Use Nigerian examples and context where examples are useful.
- Structure the content in markdown with these sections: Objectives, Entry Behaviour, Instructional Materials, Presentation (step by step), Evaluation, Summary, Assignment.
- The objectives array should hold each learning objective as its own short string.

Return only the requested JSON.`;

/** One generateContent call. Throws a readable Error on transport or API failure. */
async function callGemini(body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent?key=${getApiKey()}`;

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

  return json;
}

/**
 * Reads the JSON a structured-output call returns, and its token usage.
 *
 * The finish reason is checked before parsing, not just when text is missing. A
 * run that stops at the ceiling usually DOES return text — just a JSON document
 * cut off mid-string — so testing only for an empty response reported a
 * truthful-looking "could not be parsed as JSON" that pointed at the wrong cause.
 */
function readStructured(json, { cutOff, declined, empty }) {
  const finish = json.candidates?.[0]?.finishReason;
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text;

  if (finish === "MAX_TOKENS") {
    logger.warn("[GEMINI_TEXT] Hit the output ceiling", {
      thoughtsTokens: json.usageMetadata?.thoughtsTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
    });
    throw new Error(cutOff);
  }

  if (!raw) {
    logger.warn("[GEMINI_TEXT] No text in response", { finishReason: finish });
    throw new Error(finish === "SAFETY" ? declined : empty);
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

  return {
    parsed,
    usage: {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

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
async function generateLessonNote({ schemeText, className, subjectName, topic, weekRange, duration, teacherBrief }) {
  const excerpt = buildContextExcerpt(schemeText, topic);

  if (!excerpt) {
    throw new Error(
      "This scheme of work has no readable text, so a lesson note cannot be generated from it."
    );
  }

  const json = await callGemini({
    contents: [
      {
        parts: [
          { text: buildLessonNotePrompt({ className, subjectName, topic, weekRange, duration, teacherBrief }) },
          { text: `\n\nSCHEME OF WORK:\n${excerpt}` },
          ...(teacherBrief ? [{ text: `\n\nTEACHER'S INSTRUCTIONS (their conversation with you):\n${teacherBrief}` }] : []),
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
  });

  return finishNote(readStructured(json, {
    cutOff: "The lesson note was cut off before it finished. Try a single topic rather than several weeks.",
    declined: "Gemini declined to write this lesson note. Try rewording the topic.",
    empty: "Gemini returned no lesson note",
  }), topic);
}

/** Validates a parsed note and gives it the shape the rest of the app expects. */
function finishNote({ parsed, usage }, topic) {
  if (typeof parsed.content !== "string" || !parsed.content.trim()) {
    throw new Error("Gemini returned an empty lesson note");
  }

  return {
    parsed: {
      title: String(parsed.title || topic || "Lesson Note"),
      objectives: Array.isArray(parsed.objectives) ? parsed.objectives.map((o) => String(o)) : [],
      content: parsed.content,
    },
    usage,
  };
}

/**
 * Output ceiling for one chat turn. A reply is a few sentences; keeping the
 * ceiling low is also what keeps the credit reservation for a turn small.
 */
const CHAT_MAX_OUTPUT_TOKENS = 768;

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    readyToGenerate: { type: "boolean" },
  },
  required: ["reply", "readyToGenerate"],
};

const buildChatSystemPrompt = ({ className, subjectName, topic, weekRange, duration, excerpt }) => `You are a friendly teaching assistant helping a Nigerian secondary school teacher plan ONE lesson note before it is written. Your job is to find out how THIS teacher wants to teach it, so the note is specific to their class and not generic.

Lesson: ${subjectName}, ${className}${topic ? `, topic: ${topic}` : ""}${weekRange ? `, week(s): ${weekRange}` : ""}${duration ? `, duration: ${duration}` : ""}.

How to behave:
- Ask at most two short questions at a time. Useful things to learn: what the class already knows, how able or mixed the class is, the teaching method they prefer (discussion, demonstration, group work, practical), resources they actually have (no projector, only a board, local materials), local examples that suit their pupils, how they like to test understanding, and how long or detailed the note should be.
- Accept what they tell you. If they give an instruction ("make it more practical", "use market examples"), agree briefly and build on it. Do not argue or repeat a question they have answered.
- You do NOT write the lesson note in this chat. Never output the note itself.
- The scheme of work below is the authority on WHAT the lesson covers. If the teacher asks for something outside it, say so kindly and suggest how it could fit.
- Once you know enough to write something specific (usually after two or three exchanges), or the teacher says to go ahead, set readyToGenerate to true and say in one or two sentences what you will write.
- Plain text only, no markdown, no lists. Keep every reply under 80 words.

Return only the requested JSON: reply (what you say to the teacher) and readyToGenerate.

SCHEME OF WORK:
${excerpt}`;

/**
 * One turn of the planning chat.
 *
 * @param {object} input
 * @param {Array<{ role: "user" | "model", content: string }>} input.history oldest first; must start and end with a user turn
 * @returns {Promise<{ reply: string, readyToGenerate: boolean, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function chatTurn({ history, schemeText, className, subjectName, topic, weekRange, duration }) {
  const excerpt = buildContextExcerpt(schemeText, topic);
  if (!excerpt) {
    throw new Error("This scheme of work has no readable text, so a lesson note cannot be planned from it.");
  }

  const json = await callGemini({
    systemInstruction: {
      parts: [{ text: buildChatSystemPrompt({ className, subjectName, topic, weekRange, duration, excerpt }) }],
    },
    contents: history.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: CHAT_SCHEMA,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const { parsed, usage } = readStructured(json, {
    cutOff: "The reply was cut off. Please send your message again.",
    declined: "Gemini declined to reply to that. Try rewording your message.",
    empty: "Gemini returned no reply",
  });

  if (typeof parsed.reply !== "string" || !parsed.reply.trim()) {
    throw new Error("Gemini returned an empty reply");
  }

  return { reply: parsed.reply.trim(), readyToGenerate: parsed.readyToGenerate === true, usage };
}

/**
 * Revises a finished note as the teacher asks, returning the whole new note.
 *
 * @returns {Promise<{ parsed: { title: string, objectives: string[], content: string }, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function refineNote({ schemeText, className, subjectName, topic, note, instruction }) {
  const excerpt = buildContextExcerpt(schemeText, topic);

  const json = await callGemini({
    contents: [
      {
        parts: [
          {
            text: `You are helping a Nigerian secondary school teacher revise a lesson note for ${subjectName}, ${className}. Apply the teacher's request to the note below and return the COMPLETE revised note.

Rules:
- Change only what the request asks for. Keep every other part, and the section structure, as it is.
- The scheme of work decides WHAT is covered: do not add topics, facts or figures it does not contain. Examples, activities, wording, depth and length are yours to change as asked.
- The objectives array holds each learning objective as its own short string.

Return only the requested JSON.`,
          },
          { text: `\n\nSCHEME OF WORK:\n${excerpt}` },
          { text: `\n\nCURRENT NOTE:\nTitle: ${note.title}\nObjectives:\n${note.objectives.map((o) => `- ${o}`).join("\n")}\n\n${note.content}` },
          { text: `\n\nTEACHER'S REQUEST:\n${instruction}` },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: LESSON_NOTE_SCHEMA,
      maxOutputTokens: LESSON_NOTE_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  return finishNote(
    readStructured(json, {
      cutOff: "The revised note was cut off before it finished. Try asking for a smaller change.",
      declined: "Gemini declined to make that change. Try rewording the request.",
      empty: "Gemini returned no revised note",
    }),
    note.title
  );
}

module.exports = {
  generateLessonNote,
  chatTurn,
  refineNote,
  buildTeacherBrief,
  buildLessonNotePrompt,
  CHAT_MAX_OUTPUT_TOKENS,
  MAX_BRIEF_CHARS,
  getModel,
  buildContextExcerpt,
  LESSON_NOTE_MAX_OUTPUT_TOKENS,
  MAX_CONTEXT_CHARS,
};
