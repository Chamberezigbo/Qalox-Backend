const sharp = require("sharp");
const { openDocument, collect } = require("./reportCardPdf");

/**
 * The printable exam paper (PDF), drawn from the same paper JSON the teacher edits on
 * screen. With `answers` it is the teacher's copy: correct options marked and a marking
 * guide under theory questions.
 *
 * pdfkit lays the text out itself, so a long paper flows onto as many A4 pages as it needs.
 */

const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#9ca3af";
const MARGIN = 48;
const IMAGE_MAX_WIDTH = 300;
const IMAGE_MAX_HEIGHT = 200;

/** PNG bytes sized for the page, or null when the bytes are not an image. */
async function prepareImage(buffer) {
  try {
    const out = await sharp(buffer).resize({ width: 900, height: 600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(out).metadata();
    return { buffer: out, width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

const bottom = (doc) => doc.page.height - MARGIN;

/** Starts a new page when fewer than `needed` points remain. */
function room(doc, needed) {
  if (doc.y + needed > bottom(doc)) doc.addPage();
}

/**
 * @param {object} paper the normalized paper
 * @param {{ school: { name: string | null, logo?: Buffer | null }, className: string, subjectName: string, termName?: string | null, images: Map<string, Buffer>, answers?: boolean }} ctx
 * @returns {Promise<Buffer>}
 */
async function buildExamPaperPdf(paper, ctx) {
  const doc = openDocument({ margin: MARGIN });
  const done = collect(doc);
  doc.addPage();
  const width = doc.page.width - MARGIN * 2;

  // Header: logo, school name, paper title
  const logo = ctx.school.logo ? await prepareImage(ctx.school.logo) : null;
  if (logo) {
    const h = 44;
    const w = Math.min((logo.width / logo.height) * h, 90);
    doc.image(logo.buffer, MARGIN, MARGIN - 6, { fit: [w, h] });
  }
  doc.font("Bold").fontSize(15).fillColor(INK).text(ctx.school.name || "", MARGIN, MARGIN, { width, align: "center" });
  doc.font("Bold").fontSize(12).text(paper.title || "Exam paper", { width, align: "center" });
  const meta = [ctx.subjectName, ctx.className, ctx.termName].filter(Boolean).join("  ·  ");
  doc.font("Body").fontSize(10).fillColor(MUTED).text(meta, { width, align: "center" });
  doc.moveDown(0.6);

  const facts = [
    paper.durationMinutes ? `Time allowed: ${paper.durationMinutes} minutes` : null,
    `Total marks: ${paper.totalMarks}`,
    ctx.answers ? "TEACHER'S COPY (with answers)" : null,
  ].filter(Boolean);
  doc.font("Body").fontSize(10).fillColor(INK).text(facts.join("      "), MARGIN, doc.y, { width, align: "center" });
  doc.moveDown(0.8);

  if (!ctx.answers) {
    // Name / date lines for the student.
    const y = doc.y;
    doc.font("Body").fontSize(10).fillColor(INK);
    doc.text("Name: ", MARGIN, y);
    doc.moveTo(MARGIN + 36, y + 11).lineTo(MARGIN + width * 0.62, y + 11).strokeColor(LINE).lineWidth(0.6).stroke();
    doc.text("Date: ", MARGIN + width * 0.68, y);
    doc.moveTo(MARGIN + width * 0.68 + 32, y + 11).lineTo(MARGIN + width, y + 11).strokeColor(LINE).lineWidth(0.6).stroke();
    doc.y = y + 24;
  }

  if (paper.instructions) {
    doc.font("Italic").fontSize(10).fillColor(INK).text(`Instructions: ${paper.instructions}`, MARGIN, doc.y, { width });
    doc.moveDown(0.6);
  }
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor(INK).lineWidth(1).stroke();
  doc.moveDown(0.8);

  let number = 0;
  for (const section of paper.sections) {
    if (section.questions.length === 0) continue;
    room(doc, 70);
    doc.font("Bold").fontSize(11.5).fillColor(INK).text(section.title, MARGIN, doc.y, { width });
    if (section.instructions) {
      doc.font("Italic").fontSize(9.5).fillColor(MUTED).text(section.instructions, { width });
    }
    doc.moveDown(0.5);

    for (const q of section.questions) {
      number += 1;
      room(doc, 60);
      const marks = q.marks ? `  [${q.marks} mark${q.marks === 1 ? "" : "s"}]` : "";
      doc.font("Bold").fontSize(10.5).fillColor(INK).text(`${number}.  `, MARGIN, doc.y, { continued: true, width });
      doc.font("Body").text(q.text, { continued: !!marks });
      if (marks) doc.font("Italic").fillColor(MUTED).fontSize(9).text(marks);

      const imageBytes = q.imageKey ? ctx.images.get(q.imageKey) : null;
      const image = imageBytes ? await prepareImage(imageBytes) : null;
      if (image) {
        const scale = Math.min(IMAGE_MAX_WIDTH / image.width, IMAGE_MAX_HEIGHT / image.height, 1);
        const h = image.height * scale;
        room(doc, h + 8);
        doc.image(image.buffer, MARGIN + 18, doc.y + 4, { width: image.width * scale, height: h });
        doc.y += h + 10;
      }

      if (section.type === "objective") {
        doc.moveDown(0.15);
        for (const o of q.options ?? []) {
          room(doc, 16);
          const correct = ctx.answers && o.label === q.answer;
          doc.font(correct ? "Bold" : "Body").fontSize(10).fillColor(INK).text(`${o.label}.  ${o.text}${correct ? "   (correct)" : ""}`, MARGIN + 22, doc.y, { width: width - 22 });
        }
      } else if (ctx.answers && q.answer) {
        doc.moveDown(0.15);
        doc.font("Italic").fontSize(9.5).fillColor(MUTED).text(`Marking guide: ${q.answer}`, MARGIN + 22, doc.y, { width: width - 22 });
      } else if (!ctx.answers) {
        // Writing space for a theory answer.
        const lines = Math.max(2, Math.min(8, Math.round((q.marks || 5) / 1.5)));
        for (let i = 0; i < lines; i++) {
          room(doc, 18);
          doc.moveTo(MARGIN + 22, doc.y + 14).lineTo(MARGIN + width, doc.y + 14).strokeColor("#d1d5db").lineWidth(0.5).stroke();
          doc.y += 18;
        }
      }
      doc.moveDown(0.7);
    }
    doc.moveDown(0.3);
  }

  doc.font("Bold").fontSize(10).fillColor(MUTED).text("END OF PAPER", MARGIN, doc.y, { width, align: "center" });

  // Page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font("Body").fontSize(8.5).fillColor(MUTED).text(`Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 14, { width, align: "center", lineBreak: false });
  }

  doc.end();
  return done;
}

module.exports = { buildExamPaperPdf };
