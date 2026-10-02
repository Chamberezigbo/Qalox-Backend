const logger = require("../config/logger");

/**
 * Reads the prose off a photographed page — a scheme of work, a syllabus
 * sheet, anything laid out as headings and paragraphs rather than a table.
 *
 * Deliberately separate from GeminiService.js, which transcribes student and
 * staff registers into headers + rows. Same provider and the same call shape,
 * but a different job: forcing a scheme of work through a table schema would
 * flatten the week/topic/objective structure that makes it useful as grounding
 * for lesson-note generation.
 *
 * Unlike the table service, this one returns Gemini's own token counts
 * alongside the text — every call here is billed to a school's AI credits, and
 * the reported usage is what gets charged (see AiCreditService).
 */

const DEFAULT_MODEL = "gemini-2.0-flash";
const REQUEST_TIMEOUT_MS = 45000; // a dense page takes longer than a table
const MAX_OUTPUT_TOKENS = 2048; // one page of prose; also the reservation ceiling

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY must be set in the environment");
  return key;
};

const getModel = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

const PROMPT = `You are transcribing one page of a school scheme of work (a term's teaching plan) from a photograph. The page may be handwritten or printed, and is usually organised by week, topic, objectives and activities.

Transcribe the page as plain text, preserving its structure:
- Keep week numbers, topic headings and list items on their own lines, in the order they appear.
- Transcribe exactly what is written. Do not correct spelling, expand abbreviations, summarise, or invent content for anything blank or illegible.
- If a word or phrase is illegible, write [illegible] in its place rather than guessing.
- Do not add commentary, headings or explanation of your own.

Return only the requested JSON.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
};

/**
 * Transcribes one page image into plain prose.
 *
 * @param {Buffer} imageBuffer
 * @param {String} mimeType e.g. "image/png", "image/jpeg"
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function extractProse(imageBuffer, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent?key=${getApiKey()}`;

  const body = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType, data: imageBuffer.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
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
    logger.warn("[GEMINI_PROSE] Request failed", { error: error.message });
    throw new Error(`Gemini request failed: ${error.message}`);
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    logger.warn("[GEMINI_PROSE] Non-OK response", { status: response.status, raw: json });
    throw new Error(json?.error?.message || `Gemini request failed with status ${response.status}`);
  }

  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    logger.warn("[GEMINI_PROSE] No text in response", { raw: json });
    throw new Error("Gemini returned no transcription");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn("[GEMINI_PROSE] Response was not valid JSON", { raw });
    throw new Error("Gemini returned a response that could not be parsed as JSON");
  }

  if (typeof parsed.text !== "string") {
    throw new Error("Gemini returned an unexpected shape");
  }

  return {
    text: parsed.text,
    usage: {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

module.exports = { extractProse, MAX_OUTPUT_TOKENS };
