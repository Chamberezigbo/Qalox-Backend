const Gemini = require("./GeminiTextService");
const logger = require("../config/logger");

/**
 * Gemini calls for the exam-paper chat: one conversational turn (text + the teacher's
 * reference images, returning the updated paper), and drawing a diagram.
 */

/** A whole paper of 40+ questions is long; this is also what a turn's credits are reserved against. */
const PAPER_MAX_OUTPUT_TOKENS = 8192;
const IMAGE_REQUEST_TIMEOUT_MS = 90000;
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    answer: { type: "string" },
    marks: { type: "number" },
    // Ask for a diagram to be drawn for this question.
    imagePrompt: { type: "string" },
    // Use the Nth image the teacher attached to THIS message (1 = the first).
    attachmentIndex: { type: "integer" },
  },
  required: ["text", "answer", "marks"],
};

const TURN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    paper: {
      type: "object",
      properties: {
        title: { type: "string" },
        instructions: { type: "string" },
        durationMinutes: { type: "integer" },
        // What the printed paper shows. Set a flag to false to remove that part.
        layout: {
          type: "object",
          properties: {
            showNameDate: { type: "boolean" },
            answerLines: { type: "boolean" },
            showMarks: { type: "boolean" },
            showHeader: { type: "boolean" },
          },
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string", enum: ["objective", "theory"] },
              title: { type: "string" },
              instructions: { type: "string" },
              questions: { type: "array", items: QUESTION_SCHEMA },
            },
            required: ["type", "questions"],
          },
        },
      },
      required: ["sections"],
    },
  },
  required: ["reply"],
};

const buildSystemPrompt = ({ className, subjectName, termName, schemeExcerpt }) => `You are an experienced Nigerian secondary-school examiner helping a teacher build ONE printable exam paper by chat.

Subject: ${subjectName}. Class: ${className}.${termName ? ` Term: ${termName}.` : ""}

How to work:
- The teacher tells you exactly what they need: how many objective (multiple-choice) and theory questions, the topics or weeks to cover, the difficulty, marks, duration, and any special instructions. Follow the numbers EXACTLY (e.g. "10 theory and 30 objective" means 10 theory questions and 30 objective questions).
- If something essential is missing (the topics, or how many questions), ask ONE short question and do NOT return a paper yet. Otherwise write the paper straight away; do not keep asking.
- Objective questions have 4 options (A-D) and exactly one correct answer, given as the option's letter in "answer". Theory questions may carry a short marking guide in "answer". Give every question sensible "marks" (typically 1 for objective, 5-10 for theory) unless told otherwise.
- Questions must suit the class level and the Nigerian curriculum (WAEC/NECO style where fitting), be clear, unambiguous and free of errors.
- You are given the CURRENT paper as JSON. When the teacher asks for a change ("make question 4 harder", "replace the theory section", "add 5 more", "regenerate"), return the WHOLE updated paper, keeping each unchanged question's "id" exactly as given, and leaving the "id" out for new questions. If the teacher only asks a question or chats, reply and do NOT return a paper.
- Images: if the teacher attached images, you can see them. To put one of THIS message's images beside a question, set that question's "attachmentIndex" (1 = the first image attached). To have a diagram or illustration drawn (a labelled biology diagram, a geometry figure, a map outline), set "imagePrompt" to a precise description of the picture; use this only when a picture genuinely helps the question, and never more than 3 per paper turn. Do not describe images in the question text as if the student could not see them.
- PRINT LAYOUT: the printed paper has exactly four switches, in "layout": showNameDate (the Name and Date lines at the top), answerLines (the writing lines under each theory question), showMarks (the [n marks] label on each question) and showHeader (the school logo and name at the top). To remove or bring back any of these, return the paper with "layout" updated (false removes it, true shows it) and keep every question as it was. You CANNOT change any other part of the print design (fonts, sizes, spacing, page layout, colours); if asked, say plainly that you cannot, and do not pretend you did.
- Whenever you change ANYTHING about the paper (questions, instructions, marks, layout), you MUST return the whole paper. A reply that says something changed without the paper attached changes nothing.
- Never put question numbers ("1.") or option letters ("A.") inside a question's "text" or an option; the printout adds them.
- Never claim to have done something you did not put in the paper. Keep "reply" short (under 80 words), plain text, no markdown. Say what you did and offer one useful next step.

Return only the requested JSON: reply, and paper when you wrote or changed it.${
  schemeExcerpt ? `\n\nSCHEME OF WORK (the authority on what each week covers; weeks the teacher names map to it):\n${schemeExcerpt}` : "\n\nThere is no scheme of work for this class, so rely on the topics the teacher gives you."
}`;

/**
 * One chat turn.
 *
 * @param {object} input
 * @param {Array<{ role: "user" | "model", content: string }>} input.history oldest first, ends with the new user message
 * @param {object | null} input.paper the current paper (with question ids)
 * @param {Array<{ mimeType: string, data: string }>} input.images base64 images attached to the NEW message
 */
async function chatTurn({ history, paper, images = [], className, subjectName, termName, schemeExcerpt }) {
  const system = buildSystemPrompt({ className, subjectName, termName, schemeExcerpt });

  const contents = history.map((m, i) => {
    const parts = [{ text: m.content }];
    // Only the newest message carries its pictures; older ones are remembered as text.
    if (i === history.length - 1 && m.role === "user") {
      for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    return { role: m.role === "model" ? "model" : "user", parts };
  });

  // The paper as it stands, so edits are made to THIS paper and ids can be kept.
  const last = contents[contents.length - 1];
  last.parts.unshift({ text: `CURRENT PAPER:\n${paper ? JSON.stringify(paper) : "(none yet)"}\n\nTEACHER'S MESSAGE:\n` });

  const json = await Gemini.callGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: TURN_SCHEMA,
      maxOutputTokens: PAPER_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const { parsed, usage } = Gemini.readStructured(json, {
    cutOff: "The paper was too long to finish in one go. Ask for fewer questions at a time, or one section at a time.",
    declined: "The AI declined to write this. Try rewording your request.",
    empty: "The AI returned nothing. Please try again.",
  });

  return { reply: String(parsed.reply || "").trim(), paper: parsed.paper ?? null, usage };
}

/**
 * Draws one diagram. Returns the PNG/JPEG bytes, or throws a readable Error.
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function generateImage(prompt) {
  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${Gemini.getApiKey()}`;
  const styled = `A clear, clean, black-and-white educational line diagram for an exam paper, white background, no decorative colours, labels in legible capital letters where needed. ${prompt}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: styled }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("[EXAM_PAPER] Image request failed", { error: error.message });
    throw new Error("The diagram could not be drawn right now.");
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    logger.warn("[EXAM_PAPER] Image non-OK", { status: response.status, error: json?.error?.message });
    const noQuota = /limit:\s*0/.test(json?.error?.message || "");
    throw new Error(
      noQuota
        ? "Drawing diagrams is not switched on for this AI account yet. You can still attach your own images."
        : response.status === 429
          ? "The AI is busy; try the diagram again shortly."
          : "The diagram could not be drawn."
    );
  }

  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error("The AI did not return a picture for that description.");
  return { buffer: Buffer.from(part.inlineData.data, "base64"), mimeType: part.inlineData.mimeType || "image/png" };
}

module.exports = { chatTurn, generateImage, PAPER_MAX_OUTPUT_TOKENS, buildSystemPrompt, TURN_SCHEMA };
