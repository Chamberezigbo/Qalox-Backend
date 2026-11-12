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


const COL_GAP = 20;
const COMPACT_SIZE = 9.5;
const COMPACT_NUMBER_WIDTH = 23;
const COMPACT_IMAGE_MAX_HEIGHT = 110;

/**
 * An objective section in two columns with tight spacing (the "compact" layout). Each question is
 * measured first and placed whole: it goes in the left column until that is full, then the right,
 * then a new page, so a question is never split. Returns the last question number used.
 */
async function drawCompactObjective(doc, section, startNumber, layout, ctx, width) {
  const colWidth = (width - COL_GAP) / 2;
  const textWidth = colWidth - COMPACT_NUMBER_WIDTH;
  const xOf = (c) => MARGIN + c * (colWidth + COL_GAP);

  let col = 0;
  let pageTop = doc.y;
  let y = pageTop;
  const bottoms = [pageTop, pageTop];
  let number = startNumber;

  for (const q of section.questions) {
    number += 1;
    const marks = layout.showMarks && q.marks ? ` [${q.marks}]` : "";
    const text = `${q.text}${marks}`;
    const options = q.options ?? [];
    // A short marker keeps the answers copy as compact as the question paper.
    const optionText = (o) => `${o.label}. ${o.text}${ctx.answers && o.label === q.answer ? " *" : ""}`;

    doc.font("Body").fontSize(COMPACT_SIZE);
    const lineHeight = doc.currentLineHeight(true);
    const textHeight = doc.heightOfString(text, { width: textWidth });
    // All options on one line when they fit, otherwise one per line.
    const inline = options.map(optionText).join("     ");
    const inlineFits = options.length > 0 && doc.heightOfString(inline, { width: textWidth }) <= lineHeight * 1.2;
    // Otherwise two options per row (a 2 x 2 grid for four options) when each fits its half, else one per line.
    const cellWidth = textWidth / 2;
    const gridFits = !inlineFits && options.length > 0 && options.every((o) => doc.heightOfString(optionText(o), { width: cellWidth - 4 }) <= lineHeight * 1.2);
    const optionsHeight = inlineFits
      ? lineHeight
      : gridFits
        ? Math.ceil(options.length / 2) * lineHeight
        : options.reduce((sum, o) => sum + doc.heightOfString(optionText(o), { width: textWidth }), 0);

    const imageBytes = q.imageKey ? ctx.images.get(q.imageKey) : null;
    const image = imageBytes ? await prepareImage(imageBytes) : null;
    const scale = image ? Math.min(textWidth / image.width, COMPACT_IMAGE_MAX_HEIGHT / image.height, 1) : 1;
    const imageHeight = image ? image.height * scale + 4 : 0;

    const block = textHeight + imageHeight + optionsHeight + 5;

    if (y + block > bottom(doc)) {
      if (col === 0) {
        col = 1;
        y = pageTop;
      } else {
        doc.addPage();
        col = 0;
        pageTop = MARGIN;
        y = pageTop;
        bottoms[0] = bottoms[1] = pageTop;
      }
    }

    const x = xOf(col);
    doc.font("Bold").fontSize(COMPACT_SIZE).fillColor(INK).text(`${number}.`, x, y, { width: COMPACT_NUMBER_WIDTH, lineBreak: false });
    doc.font("Body").fontSize(COMPACT_SIZE).fillColor(INK).text(text, x + COMPACT_NUMBER_WIDTH, y, { width: textWidth });
    let cursor = y + textHeight;

    if (image) {
      doc.image(image.buffer, x + COMPACT_NUMBER_WIDTH, cursor + 2, { width: image.width * scale, height: image.height * scale });
      cursor += imageHeight;
    }

    if (inlineFits) {
      // Each option is placed at a measured position (not "continued" text, which wraps unpredictably).
      let ox = x + COMPACT_NUMBER_WIDTH;
      for (const o of options) {
        const correct = ctx.answers && o.label === q.answer;
        const label = optionText(o);
        doc.font(correct ? "Bold" : "Body").fontSize(COMPACT_SIZE).fillColor(INK).text(label, ox, cursor, { lineBreak: false });
        ox += doc.widthOfString(label) + 14;
      }
    } else if (gridFits) {
      options.forEach((o, i) => {
        const correct = ctx.answers && o.label === q.answer;
        doc.font(correct ? "Bold" : "Body").fontSize(COMPACT_SIZE).fillColor(INK).text(
          optionText(o),
          x + COMPACT_NUMBER_WIDTH + (i % 2) * cellWidth,
          cursor + Math.floor(i / 2) * lineHeight,
          { width: cellWidth - 4, lineBreak: false },
        );
      });
    } else {
      let oy = cursor;
      for (const o of options) {
        const correct = ctx.answers && o.label === q.answer;
        doc.font(correct ? "Bold" : "Body").fontSize(COMPACT_SIZE).fillColor(INK).text(optionText(o), x + COMPACT_NUMBER_WIDTH, oy, { width: textWidth });
        oy += doc.heightOfString(optionText(o), { width: textWidth });
      }
    }

    y += block;
    bottoms[col] = y;
  }

  doc.y = Math.max(bottoms[0], bottoms[1]);
  return number;
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

  const layout = { showNameDate: true, answerLines: true, showMarks: true, showHeader: true, compact: false, ...(paper.layout || {}) };

  // Header: logo and school name (unless switched off), then the paper title
  doc.y = MARGIN;
  if (layout.showHeader) {
    const logo = ctx.school.logo ? await prepareImage(ctx.school.logo) : null;
    if (logo) {
      const h = 44;
      const w = Math.min((logo.width / logo.height) * h, 90);
      doc.image(logo.buffer, MARGIN, MARGIN - 6, { fit: [w, h] });
    }
    doc.font("Bold").fontSize(15).fillColor(INK).text(ctx.school.name || "", MARGIN, MARGIN, { width, align: "center" });
  }
  doc.font("Bold").fontSize(12).fillColor(INK).text(paper.title || "Exam paper", MARGIN, doc.y, { width, align: "center" });
  const meta = [ctx.subjectName, ctx.className, ctx.termName].filter(Boolean).join("  ·  ");
  doc.font("Body").fontSize(10).fillColor(MUTED).text(meta, { width, align: "center" });
  doc.moveDown(0.6);

  const facts = [
    paper.durationMinutes ? `Time allowed: ${paper.durationMinutes} minutes` : null,
    `Total marks: ${paper.totalMarks}`,
    ctx.answers ? (layout.compact ? "TEACHER'S COPY (with answers, * = correct)" : "TEACHER'S COPY (with answers)") : null,
  ].filter(Boolean);
  doc.font("Body").fontSize(10).fillColor(INK).text(facts.join("      "), MARGIN, doc.y, { width, align: "center" });
  doc.moveDown(0.8);

  if (!ctx.answers && layout.showNameDate) {
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

    if (layout.compact && section.type === "objective") {
      number = await drawCompactObjective(doc, section, number, layout, ctx, width);
      doc.moveDown(0.3);
      continue;
    }

    for (const q of section.questions) {
      number += 1;
      room(doc, 60);
      const numberWidth = 26;
      const top = doc.y;
      // The number sits in its own column and the text in a block beside it, so a long or
      // multi-line question never runs under the number or the marks.
      doc.font("Bold").fontSize(10.5).fillColor(INK).text(`${number}.`, MARGIN, top, { width: numberWidth, lineBreak: false });
      const markLabel = layout.showMarks && q.marks ? `[${q.marks} mark${q.marks === 1 ? "" : "s"}]` : null;
      const textWidth = width - numberWidth;
      doc.font("Body").fontSize(10.5);
      // A one-line question keeps its marks on the same line; a longer one puts them after the
      // last line, so the label can never print over the text.
      const oneLine = markLabel && doc.heightOfString(q.text, { width: textWidth - 70 }) < 16;
      doc.fillColor(INK).text(q.text, MARGIN + numberWidth, top, { width: oneLine ? textWidth - 70 : textWidth });
      if (markLabel) {
        const y = oneLine ? top + 1.5 : doc.y + 1;
        doc.font("Italic").fontSize(9).fillColor(MUTED).text(markLabel, MARGIN + numberWidth, y, { width: textWidth, align: "right", lineBreak: false });
        if (!oneLine) doc.y = y + 12;
      }

      const imageBytes = q.imageKey ? ctx.images.get(q.imageKey) : null;
      const image = imageBytes ? await prepareImage(imageBytes) : null;
      if (image) {
        const scale = Math.min(IMAGE_MAX_WIDTH / image.width, IMAGE_MAX_HEIGHT / image.height, 1);
        const h = image.height * scale;
        room(doc, h + 8);
        doc.image(image.buffer, MARGIN + numberWidth, doc.y + 4, { width: image.width * scale, height: h });
        doc.y += h + 10;
      }

      if (section.type === "objective") {
        doc.moveDown(0.15);
        for (const o of q.options ?? []) {
          room(doc, 16);
          const correct = ctx.answers && o.label === q.answer;
          doc.font(correct ? "Bold" : "Body").fontSize(10).fillColor(INK).text(`${o.label}.  ${o.text}${correct ? "   (correct)" : ""}`, MARGIN + numberWidth + 8, doc.y, { width: width - numberWidth - 8 });
        }
      } else if (ctx.answers && q.answer) {
        doc.moveDown(0.15);
        doc.font("Italic").fontSize(9.5).fillColor(MUTED).text(`Marking guide: ${q.answer}`, MARGIN + numberWidth, doc.y, { width: width - numberWidth });
      } else if (!ctx.answers && layout.answerLines) {
        // Writing space for a theory answer.
        const lineGap = layout.compact ? 14 : 18;
        const lines = layout.compact ? Math.max(1, Math.min(4, Math.round((q.marks || 5) / 2.5))) : Math.max(2, Math.min(8, Math.round((q.marks || 5) / 1.5)));
        for (let i = 0; i < lines; i++) {
          room(doc, lineGap);
          doc.moveTo(MARGIN + numberWidth, doc.y + lineGap - 4).lineTo(MARGIN + width, doc.y + lineGap - 4).strokeColor("#d1d5db").lineWidth(0.5).stroke();
          doc.y += lineGap;
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
    // The footer sits inside the bottom margin. With the margin in force pdfkit treats that as
    // running off the page and adds a blank page for every footer, doubling the page count.
    const margins = doc.page.margins;
    const saved = margins.bottom;
    margins.bottom = 0;
    doc.font("Body").fontSize(8.5).fillColor(MUTED).text(`Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 14, { width, align: "center", lineBreak: false });
    margins.bottom = saved;
  }

  doc.end();
  return done;
}

module.exports = { buildExamPaperPdf, prepareImage };
