const xlsx = require("xlsx");
const { PDFParse } = require("pdf-parse");
const DataMappingService = require("./DataMappingService");

/**
 * Pulls a table of rows out of whatever the admin uploaded.
 *
 * Every path funnels into the same shape — a matrix of cells — so header
 * detection and row building are written once and shared by spreadsheets, PDF
 * tables and OCR'd photos.
 *
 * Errors thrown here are surfaced to the admin verbatim as `errorMessage`, so
 * they are written as instructions ("make sure the first row names the
 * columns"), never as internals ("ENOENT", "undefined is not a function").
 */

// How far down the sheet to look for the header row. Real files often start
// with a school name, a logo row and a blank line before the actual headers.
const HEADER_SEARCH_DEPTH = 25;

// A row must map at least this many columns to count as the header. Two guards
// against a stray line like "Name of School: Ecolex" being read as headers.
const MIN_HEADER_MATCHES = 2;

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls (and what some browsers send for .csv)
  "text/csv",
  "application/csv",
  "text/plain", // some clients send .csv as text/plain
  "application/octet-stream", // ...and some send nothing useful at all
]);

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg"]);

class DocumentExtractionService {
  /**
   * @param {Object} params
   * @param {Buffer} params.buffer    the uploaded file
   * @param {String} params.mimeType  reported mime type
   * @param {String} params.fileName  original name, used to resolve the extension
   * @param {String} params.entity    "students" | "staff"
   * @param {Function} [params.onProgress] async (percent, stage) progress reporter
   * @returns {Promise<Array<{ rowNumber: Number, raw: Object }>>}
   */
  static async extract({ buffer, mimeType, fileName, entity, onProgress }) {
    const report = onProgress || (async () => {});
    const extension = String(fileName || "").split(".").pop().toLowerCase();

    let matrix;

    if (extension === "pdf" || mimeType === "application/pdf") {
      await report(30, "Reading the PDF");
      matrix = await this.matrixFromPdf(buffer, entity);
    } else if (IMAGE_MIMES.has(mimeType) || ["png", "jpg", "jpeg"].includes(extension)) {
      await report(30, "Reading text from the image");
      matrix = await this.matrixFromImage(buffer);
    } else if (SPREADSHEET_MIMES.has(mimeType) || ["xlsx", "xls", "csv"].includes(extension)) {
      await report(30, "Reading the spreadsheet");
      matrix = this.matrixFromSpreadsheet(buffer);
    } else {
      throw new Error(
        "That file type is not supported. Upload an Excel (.xlsx, .xls), CSV, PDF, PNG or JPG file."
      );
    }

    await report(55, "Matching columns");
    return this.rowsFromMatrix(matrix, entity);
  }

  // --- source-specific readers ------------------------------------------

  /**
   * Reads the first sheet that actually has content. `cellDates` makes Excel
   * date cells come back as Date objects rather than 40000-ish serial numbers;
   * `defval: ""` keeps blank cells in place so columns stay aligned.
   */
  static matrixFromSpreadsheet(buffer) {
    let workbook;
    try {
      workbook = xlsx.read(buffer, { type: "buffer", cellDates: true });
    } catch (error) {
      throw new Error(
        "This file could not be opened as a spreadsheet. It may be corrupted or saved in an unsupported format."
      );
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error("This spreadsheet has no sheets in it.");
    }

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const matrix = xlsx.utils.sheet_to_json(sheet, {
        header: 1, // array-of-arrays, so we can find the header ourselves
        defval: "",
        blankrows: true, // kept so row numbers match what the admin sees in Excel
        raw: false,
      });
      if (matrix.some((row) => row.some((cell) => String(cell).trim()))) {
        return matrix;
      }
    }

    throw new Error("This spreadsheet is empty — there are no rows to import.");
  }

  /**
   * PDFs are tried table-first: pdf-parse reconstructs table cells from the
   * page's line geometry, which is far more reliable than splitting text on
   * whitespace. Text extraction is the fallback for PDFs drawn without ruled
   * tables.
   */
  static async matrixFromPdf(buffer, entity) {
    let parser;
    try {
      parser = new PDFParse({ data: buffer });

      const tableResult = await parser.getTable().catch(() => null);
      const candidates = (tableResult && tableResult.mergedTables) || [];

      // A PDF can hold several tables; keep the one whose best row maps the most
      // columns, so a summary table at the top does not win over the real data.
      let best = null;
      let bestScore = 0;
      for (const table of candidates) {
        const matrix = (table || []).map((row) => (row || []).map((cell) => (cell == null ? "" : String(cell))));
        const score = this.bestHeaderScore(matrix, entity);
        if (score > bestScore) {
          best = matrix;
          bestScore = score;
        }
      }
      if (best && bestScore >= MIN_HEADER_MATCHES) return best;

      const textResult = await parser.getText();
      const text = (textResult && textResult.text) || "";
      if (!text.trim()) {
        throw new Error(
          "No text could be read from this PDF. If it is a scan, upload it as a PNG or JPG instead so it can be read with OCR."
        );
      }
      return this.matrixFromText(text);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No text")) throw error;
      throw new Error(`This PDF could not be read: ${error.message}`);
    } finally {
      if (parser) await parser.destroy().catch(() => {});
    }
  }

  /**
   * OCR via tesseract.js. Required lazily: it pulls in a WASM core and language
   * data, and nothing else in the app needs it — requiring it at module load
   * would slow every boot for a feature most requests never touch.
   */
  static async matrixFromImage(buffer) {
    let createWorker;
    try {
      ({ createWorker } = require("tesseract.js"));
    } catch (error) {
      throw new Error(
        "Image scanning is not available on this server. Upload the list as an Excel, CSV or PDF file instead."
      );
    }

    let worker;
    try {
      worker = await createWorker("eng");
      const { data } = await worker.recognize(buffer);
      const text = (data && data.text) || "";
      if (!text.trim()) {
        throw new Error(
          "No text could be read from this image. Try a sharper, straight-on photo, or upload the list as a spreadsheet."
        );
      }
      return this.matrixFromText(text);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No text")) throw error;
      throw new Error(`This image could not be scanned: ${error.message}`);
    } finally {
      if (worker) await worker.terminate().catch(() => {});
    }
  }

  /**
   * Splits flat text into a matrix. The delimiter is chosen by looking at the
   * whole document rather than line by line, because a single line rarely has
   * enough signal — a tab-separated file with one comma in an address would
   * otherwise flip mid-way and misalign every column after it.
   */
  static matrixFromText(text) {
    const lines = String(text)
      .split(/\r?\n/)
      .filter((line) => line.trim());

    if (lines.length === 0) return [];

    const tabbed = lines.filter((line) => line.includes("\t")).length;
    const piped = lines.filter((line) => line.includes("|")).length;
    const commaed = lines.filter((line) => (line.match(/,/g) || []).length >= 2).length;
    const spaced = lines.filter((line) => /\S {2,}\S/.test(line)).length;

    let split;
    if (tabbed >= lines.length * 0.6) split = (line) => line.split("\t");
    else if (piped >= lines.length * 0.6) split = (line) => line.split("|");
    else if (commaed >= lines.length * 0.6) split = (line) => line.split(",");
    else if (spaced >= lines.length * 0.6) split = (line) => line.split(/\s{2,}/);
    else split = (line) => line.split(/\s{2,}/); // last resort; header check catches failure

    return lines.map((line) => split(line).map((cell) => cell.trim()));
  }

  // --- shared matrix -> rows --------------------------------------------

  /** Highest header match count found in the first rows of a matrix. */
  static bestHeaderScore(matrix, entity) {
    let best = 0;
    const depth = Math.min(matrix.length, HEADER_SEARCH_DEPTH);
    for (let i = 0; i < depth; i++) {
      const { matchCount } = DataMappingService.mapHeaderRow(matrix[i] || [], entity);
      if (matchCount > best) best = matchCount;
    }
    return best;
  }

  /**
   * Finds the header row, then turns every row beneath it into a raw
   * { header: value } object.
   *
   * `rowNumber` is the 1-based position in the source file, not an index into
   * the returned array — so it lines up with the row number the admin sees in
   * Excel and can go straight back to and fix.
   */
  static rowsFromMatrix(matrix, entity) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
      throw new Error("No rows could be read from this file.");
    }

    let headerIndex = -1;
    let headerCells = null;
    let bestMatches = 0;

    const depth = Math.min(matrix.length, HEADER_SEARCH_DEPTH);
    for (let i = 0; i < depth; i++) {
      const cells = matrix[i] || [];
      const { matchCount } = DataMappingService.mapHeaderRow(cells, entity);
      if (matchCount > bestMatches) {
        bestMatches = matchCount;
        headerIndex = i;
        headerCells = cells;
      }
    }

    if (headerIndex === -1 || bestMatches < MIN_HEADER_MATCHES) {
      const expected =
        entity === "students"
          ? "First Name, Last Name, Gender, Date of Birth, Class"
          : "First Name, Last Name, Email, Duty";
      throw new Error(
        `The column headings in this file could not be recognised. Make sure there is a heading row naming each column — for example: ${expected}.`
      );
    }

    // Unnamed columns get a placeholder key so two blank headers do not collide
    // into one property and drop a column of data.
    const headers = headerCells.map((cell, index) => {
      const text = String(cell == null ? "" : cell).trim();
      return text || `__column_${index}`;
    });

    const rows = [];
    for (let i = headerIndex + 1; i < matrix.length; i++) {
      const cells = matrix[i] || [];
      const raw = {};
      for (let c = 0; c < headers.length; c++) {
        raw[headers[c]] = cells[c] == null ? "" : cells[c];
      }
      // Skip spacer rows, and rows that are just the header repeated on page 2
      // of a PDF, which would otherwise import as a student called "First Name".
      if (Object.values(raw).every((value) => !String(value).trim())) continue;
      if (DataMappingService.mapHeaderRow(cells, entity).matchCount >= MIN_HEADER_MATCHES) continue;

      rows.push({ rowNumber: i + 1, raw });
    }

    if (rows.length === 0) {
      throw new Error("This file has column headings but no rows underneath them.");
    }

    return rows;
  }
}

module.exports = DocumentExtractionService;
