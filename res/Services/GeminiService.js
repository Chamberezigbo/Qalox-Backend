const logger = require("../config/logger");

/**
 * Thin wrapper around the Gemini generateContent API for reading a student /
 * staff register out of a photo.
 *
 * Tesseract (res/Services/DocumentExtractionService.js's other image path) is
 * trained on printed text and reads handwritten, especially cursive, registers
 * badly — no amount of column/row-geometry tuning fixes character-level
 * misreads. A vision-capable model reads handwriting far more reliably
 * because it understands the image in context rather than doing per-character
 * feature matching. This is deliberately the ONLY thing this service does —
 * table transcription — not a general Gemini client.
 */

const DEFAULT_MODEL = "gemini-2.0-flash";
const REQUEST_TIMEOUT_MS = 30000;

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY must be set in the environment");
  return key;
};

const getModel = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

const PROMPT = `You are transcribing a table of student or staff records from a photograph of a school register. The register may be handwritten (including cursive) or printed.

Read the header row and every data row exactly as written:
- Do not correct spelling, expand abbreviations, or invent a value for a cell that is blank or illegible — leave it as an empty string instead.
- Keep each row's cells in the same left-to-right column order as the header row.
- For every data row, also list the 0-based column indices of any cells you were NOT confident you read correctly (illegible handwriting, ambiguous characters, or you are guessing) — leave this list empty if you're confident about every cell in that row.

Return only the requested JSON.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    headers: { type: "array", items: { type: "string" } },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cells: { type: "array", items: { type: "string" } },
          uncertain: { type: "array", items: { type: "integer" } },
        },
        required: ["cells"],
      },
    },
  },
  required: ["headers", "rows"],
};

/**
 * Transcribes the table in an image into headers + rows, with per-row
 * low-confidence column indices.
 *
 * @param {Buffer} imageBuffer
 * @param {String} mimeType e.g. "image/png", "image/jpeg"
 * @returns {Promise<{ headers: string[], rows: Array<{ cells: string[], uncertain: number[] }> }>}
 */
async function extractTable(imageBuffer, mimeType) {
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
    logger.warn("[GEMINI] Request failed", { error: error.message });
    throw new Error(`Gemini request failed: ${error.message}`);
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    logger.warn("[GEMINI] Non-OK response", { status: response.status, raw: json });
    throw new Error(json?.error?.message || `Gemini request failed with status ${response.status}`);
  }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    logger.warn("[GEMINI] No text in response", { raw: json });
    throw new Error("Gemini returned no transcription");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn("[GEMINI] Response was not valid JSON", { text });
    throw new Error("Gemini returned a response that could not be parsed as JSON");
  }

  if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw new Error("Gemini returned an unexpected shape");
  }

  return {
    headers: parsed.headers.map((h) => String(h ?? "")),
    rows: parsed.rows.map((r) => ({
      cells: Array.isArray(r.cells) ? r.cells.map((c) => String(c ?? "")) : [],
      uncertain: Array.isArray(r.uncertain) ? r.uncertain.filter((i) => Number.isInteger(i)) : [],
    })),
  };
}

module.exports = { extractTable };
