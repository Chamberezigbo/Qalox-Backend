const {
  Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, Footer, PageNumber, SectionType, BorderStyle, TabStopType,
} = require("docx");
const { prepareImage } = require("./examPaperPdf");

/**
 * The exam paper as a Word document (.docx), drawn from the same paper JSON as the PDF, so a teacher
 * can edit it further in Word. It honours the same print-layout switches, including "compact":
 * objective questions in two columns, so 20 or more fit on a page.
 *
 * @param {object} paper the normalized paper
 * @param {{ school: { name: string | null, logo?: Buffer | null }, className: string, subjectName: string, termName?: string | null, images: Map<string, Buffer>, answers?: boolean }} ctx
 * @returns {Promise<Buffer>}
 */

const INK = "111827";
const MUTED = "6B7280";
const LINE = "D1D5DB";
const FONT = "Calibri";

// docx sizes: text in half-points, spacing and indents in twips (1/20 pt).
const TEXT = 22;
const COMPACT_TEXT = 19;
const PAGE_MARGIN = 1000;
const COMPACT_MARGIN = 800;
const COLUMN_GAP = 360;

const px = (points) => Math.round(points * 1.333);

async function buildExamPaperDocx(paper, ctx) {
  const layout = { showNameDate: true, answerLines: true, showMarks: true, showHeader: true, compact: false, ...(paper.layout || {}) };
  const size = layout.compact ? COMPACT_TEXT : TEXT;
  const margin = layout.compact ? COMPACT_MARGIN : PAGE_MARGIN;
  // Text width of an A4 page between the margins, and of one of two columns.
  const pageText = 11906 - margin * 2;
  const columnText = Math.floor((pageText - COLUMN_GAP) / 2);

  const run = (text, options = {}) => new TextRun({ text, font: FONT, size, color: INK, ...options });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], font: FONT, size: 17, color: MUTED })],
      }),
    ],
  });

  const pageProps = { page: { margin: { top: margin, bottom: margin, left: margin, right: margin } } };
  const sections = [];
  const flush = (children, extra = {}) => {
    if (children.length === 0) return;
    sections.push({
      properties: { ...pageProps, ...(sections.length > 0 ? { type: SectionType.CONTINUOUS } : {}), ...extra },
      footers: { default: footer },
      children,
    });
  };

  // ── Header ────────────────────────────────────────────────────────────────
  const head = [];
  if (layout.showHeader) {
    const logo = ctx.school.logo ? await prepareImage(ctx.school.logo) : null;
    if (logo) {
      const h = 50;
      const w = Math.min((logo.width / logo.height) * h, 100);
      head.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: "png", data: logo.buffer, transformation: { width: px(w), height: px(h) } })],
      }));
    }
    head.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run(ctx.school.name || "", { bold: true, size: 30 })] }));
  }
  head.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run(paper.title || "Exam paper", { bold: true, size: 26 })] }));
  const meta = [ctx.subjectName, ctx.className, ctx.termName].filter(Boolean).join("  ·  ");
  if (meta) head.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run(meta, { color: MUTED })] }));

  const facts = [
    paper.durationMinutes ? `Time allowed: ${paper.durationMinutes} minutes` : null,
    `Total marks: ${paper.totalMarks}`,
    ctx.answers ? (layout.compact ? "TEACHER'S COPY (with answers, * = correct)" : "TEACHER'S COPY (with answers)") : null,
  ].filter(Boolean);
  head.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 160 }, children: [run(facts.join("        "))] }));

  if (!ctx.answers && layout.showNameDate) {
    head.push(new Paragraph({
      spacing: { after: 160 },
      tabStops: [{ type: TabStopType.LEFT, position: Math.floor(pageText * 0.62) }],
      children: [run("Name: ____________________________________"), run("\tDate: ____________________")],
    }));
  }
  if (paper.instructions) {
    head.push(new Paragraph({ spacing: { after: 120 }, children: [run(`Instructions: ${paper.instructions}`, { italics: true })] }));
  }
  head.push(new Paragraph({ spacing: { after: 160 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK, space: 1 } }, children: [] }));
  flush(head);

  // ── Questions ─────────────────────────────────────────────────────────────
  let number = 0;
  for (const section of paper.sections) {
    if (section.questions.length === 0) continue;

    const heading = [new Paragraph({ keepNext: true, spacing: { before: 120, after: 60 }, children: [run(section.title, { bold: true, size: size + 2 })] })];
    if (section.instructions) {
      heading.push(new Paragraph({ keepNext: true, spacing: { after: 80 }, children: [run(section.instructions, { italics: true, color: MUTED })] }));
    }
    flush(heading);

    const twoColumns = layout.compact && section.type === "objective";
    const hang = twoColumns ? 380 : 460;
    const body = [];

    for (const q of section.questions) {
      number += 1;
      const marks = layout.showMarks && q.marks ? (layout.compact ? ` [${q.marks}]` : `  [${q.marks} mark${q.marks === 1 ? "" : "s"}]`) : "";
      body.push(new Paragraph({
        keepNext: true,
        keepLines: true,
        spacing: { before: twoColumns ? 40 : 100, after: twoColumns ? 10 : 30 },
        indent: { left: hang, hanging: hang },
        tabStops: [{ type: TabStopType.LEFT, position: hang }],
        children: [run(`${number}.`, { bold: true }), run("\t"), run(q.text), ...(marks ? [run(marks, { italics: true, color: MUTED, size: size - 2 })] : [])],
      }));

      const imageBytes = q.imageKey ? ctx.images.get(q.imageKey) : null;
      const image = imageBytes ? await prepareImage(imageBytes) : null;
      if (image) {
        const maxW = twoColumns ? 150 : 300;
        const maxH = twoColumns ? 100 : 200;
        const scale = Math.min(maxW / image.width, maxH / image.height, 1);
        body.push(new Paragraph({
          keepNext: true,
          indent: { left: hang },
          children: [new ImageRun({ type: "png", data: image.buffer, transformation: { width: px(image.width * scale), height: px(image.height * scale) } })],
        }));
      }

      if (section.type === "objective") {
        const options = q.options ?? [];
        const label = (o) => `${o.label}. ${o.text}${ctx.answers && o.label === q.answer ? (layout.compact ? " *" : "   (correct)") : ""}`;
        const correct = (o) => ctx.answers && o.label === q.answer;
        const longest = Math.max(0, ...options.map((o) => label(o).length));
        const charsPerColumn = Math.floor(((twoColumns ? columnText : pageText) - hang) / (size * 5.6));

        if (layout.compact && options.length > 0 && longest * options.length + (options.length - 1) * 4 <= charsPerColumn) {
          // All options on one line.
          body.push(new Paragraph({
            keepLines: true,
            spacing: { after: 20 },
            indent: { left: hang },
            children: options.flatMap((o, i) => [run(label(o), { bold: correct(o) }), ...(i < options.length - 1 ? [run("    ")] : [])]),
          }));
        } else if (layout.compact && options.length > 0 && longest <= Math.floor(charsPerColumn / 2) - 2) {
          // Two per line: a 2 x 2 grid for four options.
          const cell = Math.floor((columnText - hang) / 2);
          for (let i = 0; i < options.length; i += 2) {
            const pair = options.slice(i, i + 2);
            body.push(new Paragraph({
              keepNext: i + 2 < options.length,
              keepLines: true,
              spacing: { after: i + 2 >= options.length ? 20 : 0 },
              indent: { left: hang },
              tabStops: [{ type: TabStopType.LEFT, position: hang + cell }],
              children: pair.flatMap((o, k) => [run(label(o), { bold: correct(o) }), ...(k === 0 && pair.length > 1 ? [run("\t")] : [])]),
            }));
          }
        } else {
          options.forEach((o, i) => {
            body.push(new Paragraph({
              keepNext: i < options.length - 1,
              keepLines: true,
              spacing: { after: i === options.length - 1 ? 40 : 0 },
              indent: { left: hang + 120 },
              children: [run(label(o), { bold: correct(o) })],
            }));
          });
        }
      } else if (ctx.answers && q.answer) {
        body.push(new Paragraph({ indent: { left: hang }, spacing: { after: 60 }, children: [run(`Marking guide: ${q.answer}`, { italics: true, color: MUTED })] }));
      } else if (!ctx.answers && layout.answerLines) {
        const lines = layout.compact
          ? Math.max(1, Math.min(4, Math.round((q.marks || 5) / 2.5)))
          : Math.max(2, Math.min(8, Math.round((q.marks || 5) / 1.5)));
        for (let i = 0; i < lines; i++) {
          body.push(new Paragraph({
            indent: { left: hang },
            spacing: { before: layout.compact ? 120 : 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 1 } },
            children: [],
          }));
        }
      }
    }

    flush(body, twoColumns ? { column: { count: 2, space: COLUMN_GAP, equalWidth: true } } : {});
  }

  flush([new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200 }, children: [run("END OF PAPER", { bold: true, color: MUTED })] })]);

  const doc = new Document({
    creator: ctx.school.name || "Qalox",
    title: paper.title || "Exam paper",
    styles: { default: { document: { run: { font: FONT, size } } } },
    sections,
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildExamPaperDocx };
