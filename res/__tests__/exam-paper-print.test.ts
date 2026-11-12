export {};
const { spawnSync } = require("child_process");
const path = require("path");
const AdmZipLike = require("zlib");
const { buildExamPaperPdf } = require("../util/examPaperPdf");
const { buildExamPaperDocx } = require("../util/examPaperDocx");

const question = (i: number) => ({
  id: `q${i}`, text: `What is the capital of country number ${i}?`, marks: 1, answer: "B",
  options: [{ label: "A", text: "Lagos" }, { label: "B", text: "Abuja" }, { label: "C", text: "Kano" }, { label: "D", text: "Ibadan" }],
});
const paper = (n: number, compact: boolean, extra: any[] = []) => ({
  title: "Social Studies", instructions: "Answer all.", durationMinutes: 40, totalMarks: n,
  layout: { showNameDate: true, answerLines: true, showMarks: true, showHeader: true, compact },
  sections: [{ title: "Section A", type: "objective", instructions: "", questions: Array.from({ length: n }, (_, i) => question(i + 1)) }, ...extra],
});
const ctx = (answers = false) => ({ school: { name: "Daniel's College", logo: null }, className: "JSS 1", subjectName: "Social", termName: "First Term", images: new Map(), answers });

// Reads each page's text in a separate node process (see res/testUtils/pdfPageText.js).
const pageTexts = async (buffer: Buffer): Promise<string[]> => {
  const run = spawnSync(process.execPath, [path.join(__dirname, "../testUtils/pdfPageText.js")], { input: buffer, maxBuffer: 50 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`could not read the PDF: ${run.stderr}`);
  return JSON.parse(run.stdout.toString());
};
const numbered = (text: string) => new Set([...text.matchAll(/(?:^|\s)(\d{1,3})\.\s/g)].map((m) => Number(m[1])));

describe("exam paper PDF", () => {
  it("does not add a blank page for every page number", async () => {
    const pages = await pageTexts(await buildExamPaperPdf(paper(1, false), ctx()));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Page 1 of 1");
  });

  it("the roomy layout needs several pages for 40 questions", async () => {
    expect((await pageTexts(await buildExamPaperPdf(paper(40, false), ctx()))).length).toBeGreaterThanOrEqual(4);
  });

  it("compact fits 20 or more questions on a full page", async () => {
    const pages = await pageTexts(await buildExamPaperPdf(paper(60, true), ctx()));
    expect(pages.length).toBeLessThanOrEqual(2);
    // Page 1 carries the header and still holds 20+; every question appears exactly once.
    const onFirst = [...numbered(pages[0])].filter((n) => n <= 60);
    expect(onFirst.length).toBeGreaterThanOrEqual(20);
    const all = new Set(pages.flatMap((p) => [...numbered(p)]).filter((n) => n <= 60));
    expect(all.size).toBe(60);
  });

  it("compact keeps a teacher's copy marked and readable", async () => {
    const text = (await pageTexts(await buildExamPaperPdf(paper(30, true), ctx(true)))).join(" ");
    expect(text).toContain("TEACHER'S COPY");
    expect(text).toContain("B. Abuja *");
  });

  it("compact leaves theory sections in one column with writing lines", async () => {
    const theory = { title: "Section B", type: "theory", instructions: "", questions: [{ id: "t1", text: "Explain the water cycle.", marks: 10, answer: "x" }] };
    const text = (await pageTexts(await buildExamPaperPdf(paper(20, true, [theory]), ctx()))).join(" ");
    expect(text).toContain("Explain the water cycle.");
    expect(text).toContain("END OF PAPER");
  });
});

// A .docx is a zip; read one part by name without a zip dependency.
function readDocxPart(buffer: Buffer, name: string): string {
  let offset = 0;
  while (offset < buffer.length - 30 && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const entry = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    if (entry === name) {
      const data = buffer.subarray(start, start + compressed);
      return (method === 8 ? AdmZipLike.inflateRawSync(data) : data).toString("utf8");
    }
    offset = start + compressed;
  }
  throw new Error(`${name} not found`);
}

describe("exam paper Word document", () => {
  it("is a real .docx with every question, in order", async () => {
    const buffer: Buffer = await buildExamPaperDocx(paper(12, false), ctx());
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const xml = readDocxPart(buffer, "word/document.xml");
    const numbers = [...xml.matchAll(/<w:t[^>]*>(\d+)\.<\/w:t>/g)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(xml).toContain("What is the capital of country number 12?");
    expect(xml).toContain("Daniel&apos;s College");
    expect(xml).not.toContain('w:num="2"');
  });

  it("compact puts objective questions in two columns", async () => {
    const xml = readDocxPart(await buildExamPaperDocx(paper(40, true), ctx()), "word/document.xml");
    expect(xml).toMatch(/<w:cols[^>]*w:num="2"/);
  });

  it("the teacher's copy marks each correct option in bold", async () => {
    const xml = readDocxPart(await buildExamPaperDocx(paper(5, false), ctx(true)), "word/document.xml");
    expect(xml).toContain("TEACHER&apos;S COPY");
    expect((xml.match(/\(correct\)/g) || []).length).toBe(5);
  });

  it("honours the layout switches", async () => {
    const off = { ...paper(3, false), layout: { showNameDate: false, answerLines: false, showMarks: false, showHeader: false, compact: false } };
    const xml = readDocxPart(await buildExamPaperDocx(off, ctx()), "word/document.xml");
    expect(xml).not.toContain("Name: ");
    expect(xml).not.toContain("Daniel");
    expect(xml).not.toContain("1 mark");
  });
});
