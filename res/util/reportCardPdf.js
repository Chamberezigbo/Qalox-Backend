const PDFDocument = require("pdfkit");
const fs = require("fs").promises;
const path = require("path");
const sharp = require("sharp");
const logger = require("../config/logger");

/**
 * Report card and broadsheet PDFs, drawn from the SAME payloads the on-screen card
 * and broadsheet use (AssessmentService.getStudentCompleteResult and
 * computeBroadsheet), so a PDF can only differ from the screen in layout.
 *
 * pdfkit draws the page itself (no headless browser, so nothing extra to host).
 * DejaVu Sans is used for the text because the standard PDF fonts cannot draw ₦ or
 * the accented letters in Nigerian names (ẹ, ọ, ṣ).
 */

const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const FONT_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const FONT_ITALIC = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf");

const INK = "#1f2937";
const MUTED = "#6b7280";
const BRAND = "#1a237e";
const HEADER_FILL = "#f0f4ff";
const LINE = "#d1d5db";

const MARGIN = 36;

// ---------------------------------------------------------------------------
// Images: best effort. A missing logo must never stop a report card.
// ---------------------------------------------------------------------------

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

/** The bytes behind an image reference, or null. Never throws. */
async function loadImage(ref, { timeoutMs = 4000 } = {}) {
  if (!ref || typeof ref !== "string") return null;
  try {
    let bytes = null;
    if (/^https?:\/\//i.test(ref)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(ref, { signal: controller.signal });
        if (!res.ok) return null;
        bytes = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    } else if (ref.startsWith("/uploads/")) {
      // A file this server stored itself. Resolved inside the uploads folder only.
      const target = path.resolve(UPLOADS_ROOT, ref.slice("/uploads/".length));
      if (!target.startsWith(UPLOADS_ROOT + path.sep)) return null;
      bytes = await fs.readFile(target);
    }
    if (!bytes) return null;
    // pdfkit takes PNG and JPEG; anything else (webp, svg, gif) is converted.
    return await sharp(bytes).resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch (error) {
    logger.warn("[PDF] Could not load an image", { ref: String(ref).slice(0, 80), error: error.message });
    return null;
  }
}

/** The logo, stamp and passport of a card, loaded together. */
async function loadCardImages(card) {
  const [logo, stamp, passport] = await Promise.all([
    loadImage(card.school?.logoUrl),
    loadImage(card.school?.stampUrl),
    loadImage(card.studentInformation?.passportUrl),
  ]);
  return { logo, stamp, passport };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const naira = (n) => `₦${Number(n).toLocaleString("en-NG")}`;

/** A date-only value shown in UTC, so the viewer's time zone cannot move the day. */
function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

const fullName = (info) => [info.surname, info.name, info.otherNames].filter(Boolean).join(" ");

function openDocument(options = {}) {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, autoFirstPage: false, ...options });
  doc.registerFont("Body", FONT);
  doc.registerFont("Bold", FONT_BOLD);
  doc.registerFont("Italic", FONT_ITALIC);
  return doc;
}

/** Collects the document's bytes. Resolves when the document is ended. */
function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/** Draws a table row of cells; returns the row's height. Text is clipped, never wrapped over the next cell. */
function row(doc, y, cells, { height, fill, bold = false, size = 8.5, aligns = [] }) {
  const total = cells.reduce((sum, c) => sum + c.width, 0);
  if (fill) doc.save().rect(MARGIN, y, total, height).fill(fill).restore();
  let x = MARGIN;
  cells.forEach((cell, i) => {
    doc.save().rect(x, y, cell.width, height).lineWidth(0.5).strokeColor(LINE).stroke().restore();
    doc
      .font(bold ? "Bold" : "Body")
      .fontSize(size)
      .fillColor(bold ? BRAND : INK)
      .text(String(cell.text ?? ""), x + 4, y + (height - size) / 2 - 1, {
        width: cell.width - 8,
        height: height - 2,
        align: aligns[i] ?? "left",
        lineBreak: false,
        ellipsis: true,
      });
    x += cell.width;
  });
  return height;
}

// ---------------------------------------------------------------------------
// One report card, on its own page(s)
// ---------------------------------------------------------------------------

function drawCard(doc, card, images) {
  doc.addPage();
  const pageWidth = doc.page.width - MARGIN * 2;
  const info = card.studentInformation;
  const summary = card.performanceSummary;
  let y = MARGIN;

  // School header
  const schoolName = card.school?.name || "School";
  if (images.logo) doc.image(images.logo, MARGIN, y, { fit: [46, 46] });
  doc.font("Bold").fontSize(16).fillColor(BRAND).text(schoolName, MARGIN, y + 8, { width: pageWidth, align: "center" });
  doc.font("Body").fontSize(9).fillColor(MUTED).text("Terminal Report Card", MARGIN, y + 30, { width: pageWidth, align: "center" });
  y += 58;
  doc.save().moveTo(MARGIN, y).lineTo(MARGIN + pageWidth, y).lineWidth(0.8).strokeColor(BRAND).stroke().restore();
  y += 10;

  // Student information
  const boxHeight = 96;
  doc.save().rect(MARGIN, y, pageWidth, boxHeight).fill("#f5f6fa").restore();
  const details = [
    ["Name", fullName(info)],
    ["Reg. Number", info.registrationNumber],
    ["Class", info.className],
    ["Campus", info.campus],
    ["Gender", info.gender],
    ["Date of Birth", formatDate(info.dateOfBirth)],
    ["Academic Session", card.academicInfo?.academicSessionName],
    ["Term", card.academicInfo?.termName],
  ];
  let ty = y + 8;
  for (const [label, value] of details) {
    doc.font("Bold").fontSize(8.5).fillColor(INK).text(`${label}:`, MARGIN + 10, ty, { width: 110, lineBreak: false });
    doc.font("Body").fontSize(8.5).fillColor(INK).text(String(value ?? "—"), MARGIN + 126, ty, { width: pageWidth - 260, lineBreak: false, ellipsis: true });
    ty += 10.5;
  }
  if (images.passport) {
    doc.image(images.passport, MARGIN + pageWidth - 86, y + 8, { fit: [76, 80], align: "center", valign: "center" });
  }
  y += boxHeight + 12;

  // Subjects table
  const subjects = card.subjects;
  const caCount = Math.max(0, ...subjects.map((s) => s.cas.length));
  const fixed = { total: 36, exam: 36, subjectTotal: 36, grade: 34 };
  const remarkWidth = 80;
  const caWidth = 32;
  const subjectWidth = Math.max(
    90,
    pageWidth - (caCount * caWidth + 42 + fixed.exam + fixed.subjectTotal + fixed.grade + remarkWidth)
  );
  const header = [
    { width: subjectWidth, text: "Subject" },
    ...Array.from({ length: caCount }, (_, i) => ({ width: caWidth, text: `CA ${i + 1}` })),
    { width: 42, text: "CA Total" },
    { width: fixed.exam, text: "Exam" },
    { width: fixed.subjectTotal, text: "Total" },
    { width: fixed.grade, text: "Grade" },
    { width: remarkWidth, text: "Remark" },
  ];
  const aligns = ["left", ...Array(caCount + 4).fill("center"), "left"];
  const drawHeader = () => {
    y += row(doc, y, header, { height: 22, fill: HEADER_FILL, bold: true, size: 7.5, aligns });
  };
  drawHeader();

  if (subjects.length === 0) {
    y += row(doc, y, [{ width: pageWidth, text: "No subject data found" }], { height: 24 });
  }
  for (const subject of subjects) {
    if (y + 22 > doc.page.height - MARGIN - 160) {
      doc.addPage();
      y = MARGIN;
      drawHeader();
    }
    const cells = [
      { width: subjectWidth, text: `${subject.name}${subject.code ? ` (${subject.code})` : ""}` },
      ...Array.from({ length: caCount }, (_, i) => ({
        width: caWidth,
        text: subject.cas[i] != null ? (subject.cas[i].score ?? "—") : "—",
      })),
      { width: 42, text: subject.caTotal },
      { width: fixed.exam, text: subject.examTotal },
      { width: fixed.subjectTotal, text: subject.subjectTotal },
      { width: fixed.grade, text: subject.grade },
      { width: remarkWidth, text: subject.remark },
    ];
    y += row(doc, y, cells, { height: 22, aligns });
  }
  y += 16;

  // Performance summary
  if (y + 150 > doc.page.height - MARGIN) {
    doc.addPage();
    y = MARGIN;
  }
  doc.font("Bold").fontSize(10).fillColor(INK).text("Performance Summary", MARGIN, y);
  y += 16;

  const cells = [
    ["Total Score", summary.totalScore],
    ["Average Score", summary.averageScore],
    ["Class Position", summary.classPosition],
    ["Overall Grade", summary.overallGrade],
    ["No. of Subjects", subjects.length],
    ["School Resumption Date", formatDate(card.schoolRecommendationDate)],
  ];
  if (card.sessionSummary?.sessionAverage != null) cells.push(["Session Average", card.sessionSummary.sessionAverage]);
  if (card.sessionSummary?.promotion?.label) cells.push(["Outcome", card.sessionSummary.promotion.label]);
  if ((card.feeSummary?.outstanding ?? 0) > 0) cells.push(["Outstanding Fees", naira(card.feeSummary.outstanding)]);

  const colWidth = pageWidth / 3;
  cells.forEach(([label, value], i) => {
    const cx = MARGIN + (i % 3) * colWidth;
    const cy = y + Math.floor(i / 3) * 34;
    doc.save().moveTo(cx, cy).lineTo(cx + colWidth - 12, cy).lineWidth(0.5).strokeColor(LINE).stroke().restore();
    doc.font("Body").fontSize(8).fillColor(MUTED).text(label, cx, cy + 5, { width: colWidth - 12, lineBreak: false });
    doc.font("Bold").fontSize(10).fillColor(INK).text(String(value ?? "—"), cx, cy + 16, { width: colWidth - 12, lineBreak: false, ellipsis: true });
  });
  y += Math.ceil(cells.length / 3) * 34 + 10;

  // Remarks and stamp
  const stampSize = 64;
  const remarksWidth = pageWidth - (images.stamp ? stampSize + 20 : 0);
  doc.save().moveTo(MARGIN, y).lineTo(MARGIN + pageWidth, y).lineWidth(0.5).strokeColor(LINE).stroke().restore();
  y += 8;
  const remarksTop = y;
  doc.font("Body").fontSize(8).fillColor(MUTED).text("Class Teacher's Remark", MARGIN, y, { width: remarksWidth });
  y += 11;
  const teacherText = `"${card.teacherRemark ?? ""}"`;
  doc.font("Italic").fontSize(9.5).fillColor(INK).text(teacherText, MARGIN, y, { width: remarksWidth });
  y = doc.y + 8;
  if (card.principalRemark) {
    doc.font("Body").fontSize(8).fillColor(MUTED).text("Principal's Remark", MARGIN, y, { width: remarksWidth });
    y += 11;
    doc.font("Italic").fontSize(9.5).fillColor(INK).text(`"${card.principalRemark}"`, MARGIN, y, { width: remarksWidth });
  }
  if (images.stamp) {
    doc.image(images.stamp, MARGIN + pageWidth - stampSize, remarksTop, { fit: [stampSize, stampSize] });
  }
}

/**
 * One PDF with a page (or more) per report card.
 *
 * @param {Array<object>} cards payloads from getStudentCompleteResult
 * @param {{ loadImages?: boolean }} [options] loadImages false skips logo, stamp and passport (tests)
 * @returns {Promise<Buffer>}
 */
async function buildReportCardsPdf(cards, { loadImages = true } = {}) {
  const doc = openDocument();
  const done = collect(doc);

  // The school's logo and stamp are the same for every card of a class: load them once.
  let shared = null;
  for (const card of cards) {
    if (!shared && loadImages) {
      const first = await loadCardImages(card);
      shared = { logo: first.logo, stamp: first.stamp };
      drawCard(doc, card, first);
      continue;
    }
    const passport = loadImages ? await loadImage(card.studentInformation?.passportUrl) : null;
    drawCard(doc, card, { logo: shared?.logo ?? null, stamp: shared?.stamp ?? null, passport });
  }
  if (cards.length === 0) {
    doc.addPage();
    doc.font("Body").fontSize(11).fillColor(MUTED).text("There are no report cards to show.", MARGIN, MARGIN);
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Broadsheet, landscape
// ---------------------------------------------------------------------------

/**
 * A class broadsheet as a landscape A4 table, with its header repeated on every page.
 *
 * @param {{ title: string, subtitle?: string }} heading
 * @param {{ subjects: string[], usePosition: boolean, rows: Array<{ studentName: string, registrationNumber?: string, scores: Record<string, { subjectTotal: number }>, grandTotal: number, position: number | null }> }} sheet
 * @returns {Promise<Buffer>}
 */
function drawBroadsheet(doc, heading, sheet) {
  doc.addPage();
  const pageWidth = doc.page.width - MARGIN * 2;

  doc.font("Bold").fontSize(14).fillColor(BRAND).text(heading.title, MARGIN, MARGIN, { width: pageWidth });
  if (heading.subtitle) doc.font("Body").fontSize(9).fillColor(MUTED).text(heading.subtitle, MARGIN, doc.y + 2, { width: pageWidth });
  let y = doc.y + 12;

  const subjectCount = sheet.subjects.length;
  const snWidth = 24;
  const totalWidth = 44;
  const positionWidth = sheet.usePosition ? 44 : 0;
  const nameWidth = 150;
  const remaining = pageWidth - snWidth - nameWidth - totalWidth - positionWidth;
  const subjectWidth = Math.max(34, remaining / Math.max(1, subjectCount));
  // Narrow subject columns (a long subject list) take a smaller type so names fit.
  const size = subjectWidth < 72 ? 6.5 : 8;

  const header = [
    { width: snWidth, text: "#" },
    { width: nameWidth, text: "Student" },
    ...sheet.subjects.map((name) => ({ width: subjectWidth, text: name })),
    { width: totalWidth, text: "Total" },
    ...(sheet.usePosition ? [{ width: positionWidth, text: "Pos." }] : []),
  ];
  const aligns = ["center", "left", ...Array(subjectCount + 1 + (sheet.usePosition ? 1 : 0)).fill("center")];
  const drawHeader = () => {
    y += row(doc, y, header, { height: 28, fill: HEADER_FILL, bold: true, size, aligns });
  };
  drawHeader();

  sheet.rows.forEach((r, index) => {
    if (y + 20 > doc.page.height - MARGIN) {
      doc.addPage();
      y = MARGIN;
      drawHeader();
    }
    y += row(
      doc,
      y,
      [
        { width: snWidth, text: index + 1 },
        { width: nameWidth, text: r.studentName },
        ...sheet.subjects.map((name) => ({ width: subjectWidth, text: r.scores[name]?.subjectTotal ?? "—" })),
        { width: totalWidth, text: r.grandTotal },
        ...(sheet.usePosition ? [{ width: positionWidth, text: r.position ?? "—" }] : []),
      ],
      { height: 20, size, aligns }
    );
  });

}

async function buildBroadsheetPdf(heading, sheet) {
  return buildBroadsheetsPdf([{ heading, sheet }]);
}

/** Several broadsheets (one per class) in one landscape document. */
async function buildBroadsheetsPdf(items) {
  const doc = openDocument({ layout: "landscape" });
  const done = collect(doc);
  if (items.length === 0) {
    doc.addPage();
    doc.font("Body").fontSize(11).fillColor(MUTED).text("There is no broadsheet to show.", MARGIN, MARGIN);
  }
  for (const { heading, sheet } of items) drawBroadsheet(doc, heading, sheet);
  doc.end();
  return done;
}


module.exports = { buildReportCardsPdf, buildBroadsheetPdf, buildBroadsheetsPdf, loadImage, formatDate, naira, openDocument, collect };
