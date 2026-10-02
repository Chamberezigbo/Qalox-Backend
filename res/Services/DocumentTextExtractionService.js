const { PDFParse } = require("pdf-parse");
const GeminiProseService = require("./GeminiProseService");
const logger = require("../config/logger");

/**
 * Pulls plain prose out of an uploaded Scheme of Work.
 *
 * Separate from DocumentExtractionService.js, which exists to turn a register
 * into a matrix of rows. This one wants the opposite: the document's text as
 * written, structure intact, because it becomes the grounding context for AI
 * lesson-note and exam-question generation.
 *
 * Two paths, and the difference matters commercially:
 *   - PDF   → pdf-parse. Local, free, no AI involved.
 *   - Image → Gemini Vision, which costs the school AI credits; Tesseract is
 *             the free fallback when Gemini is unavailable or the school is
 *             out of credits, trading accuracy for still-working.
 *
 * Errors thrown here are shown to the admin verbatim, so they read as
 * instructions, never as internals.
 */

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function textFromPdf(buffer) {
  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result && result.text) || "";

    if (!text.trim()) {
      throw new Error(
        "No text could be read from this PDF. If it is a scan, upload photos of each page instead so they can be read with OCR."
      );
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No text")) throw error;
    throw new Error(`This PDF could not be read: ${error.message}`);
  } finally {
    if (parser) await parser.destroy().catch(() => {});
  }
}

/**
 * OCR via tesseract.js. Required lazily — it pulls in a WASM core and language
 * data, and requiring it at module load would slow every boot for a path most
 * requests never take. Mirrors DocumentExtractionService's Tesseract handling.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function textFromTesseract(buffer) {
  let createWorker, PSM;
  try {
    ({ createWorker, PSM } = require("tesseract.js"));
  } catch (error) {
    throw new Error(
      "Image scanning is not available on this server. Upload the scheme of work as a PDF instead."
    );
  }

  let worker;
  try {
    worker = await createWorker("eng");
    // AUTO segments the whole page into its blocks; the default SINGLE_BLOCK
    // reads only the first one and silently drops the rest of the page.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data } = await worker.recognize(buffer);
    const text = (data && data.text) || "";

    if (!text.trim()) {
      throw new Error(
        "No text could be read from this photo. Try a sharper, straight-on shot in better light, or upload the scheme of work as a PDF."
      );
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No text")) throw error;
    throw new Error(`This photo could not be scanned: ${error.message}`);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

/**
 * Reads one page image. Gemini is tried first when it's affordable and
 * configured, because it reads handwriting far more reliably than Tesseract;
 * any failure falls back rather than failing the upload.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {boolean} allowGemini false when the school has no credits left
 * @returns {Promise<{ text: string, method: "gemini_vision"|"tesseract", usage: { inputTokens: number, outputTokens: number } }>}
 */
async function textFromImage(buffer, mimeType, allowGemini = true) {
  if (allowGemini && process.env.GEMINI_API_KEY) {
    try {
      const { text, usage } = await GeminiProseService.extractProse(buffer, mimeType);
      if (text.trim()) {
        return { text, method: "gemini_vision", usage };
      }
      logger.warn("[SCHEME_EXTRACTION] Gemini returned empty text, falling back to Tesseract");
    } catch (error) {
      logger.warn("[SCHEME_EXTRACTION] Gemini OCR failed, falling back to Tesseract", {
        error: error.message,
      });
    }
  }

  const text = await textFromTesseract(buffer);
  return { text, method: "tesseract", usage: { inputTokens: 0, outputTokens: 0 } };
}

module.exports = { textFromPdf, textFromImage, textFromTesseract };
