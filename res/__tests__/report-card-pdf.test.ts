// The PDF is drawn from the same payload the on-screen card uses, so it must carry
// the same numbers, names and remarks, one card per page, with the characters
// Nigerian names need.
/* eslint-disable @typescript-eslint/no-var-requires */
const { spawnSync } = require("child_process");
const path = require("path");
const { buildReportCardsPdf, buildBroadsheetPdf, formatDate, naira } = require("../util/reportCardPdf");
const { safeFileName, sendPdf } = require("../util/sendPdf");

const card = (over: any = {}) => ({
  school: { name: "Daniel's College", logoUrl: null, stampUrl: null },
  studentInformation: {
    name: "Ọlaṣubọmi", surname: "Adéwálé", otherNames: "Grace", registrationNumber: "DSCS-1939-STD",
    className: "SS 1", campus: "Main", gender: "Female", dateOfBirth: "2010-09-20", passportUrl: null,
  },
  academicInfo: { academicSessionName: "2026/2027", termName: "Second Term" },
  subjects: [
    { name: "Mathematics", code: "MTH", cas: [{ score: 20 }, { score: 10 }], caTotal: 30, examTotal: 60, subjectTotal: 90, grade: "A", remark: "Excellent" },
    { name: "English Language", code: "ENG", cas: [{ score: 30 }, { score: null }], caTotal: 30, examTotal: 55, subjectTotal: 85, grade: "A", remark: "Very good" },
  ],
  performanceSummary: { totalScore: 175, averageScore: 88, classPosition: "2", overallGrade: "A" },
  teacherRemark: "A diligent student.",
  principalRemark: null,
  schoolRecommendationDate: "2027-01-11",
  sessionSummary: null,
  feeSummary: { outstanding: 0 },
  ...over,
});

// Reads the PDF in a separate node process (see helpers/pdfText.js).
const read = async (buffer: Buffer): Promise<{ text: string; pages: number }> => {
  const run = spawnSync(process.execPath, [path.join(__dirname, "helpers", "pdfText.js")], { input: buffer, maxBuffer: 20 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`Could not read the PDF: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString());
};

describe("report card PDF", () => {
  it("is a real PDF with the card's names, scores and remark", async () => {
    const pdf = await buildReportCardsPdf([card()], { loadImages: false });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    const { text } = await read(pdf);
    for (const expected of ["Daniel's College", "Adéwálé", "Ọlaṣubọmi", "DSCS-1939-STD", "Mathematics", "English Language", "Excellent", "175", "88", "A diligent student."]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain("20/09/2010");
    expect(text).toContain("11/01/2027");
  });

  it("makes one page per card, and shows each student's own figures", async () => {
    const second = card({ studentInformation: { ...card().studentInformation, surname: "Obi" }, performanceSummary: { totalScore: 123, averageScore: 61, classPosition: "5", overallGrade: "B" } });
    const { text, pages } = await read(await buildReportCardsPdf([card(), second], { loadImages: false }));

    expect(pages).toBe(2);
    expect(text).toContain("Adéwálé");
    expect(text).toContain("Obi");
    expect(text).toContain("123");
  });

  it("shows the principal's remark, session lines and outstanding fees only when there are any", async () => {
    const plain = (await read(await buildReportCardsPdf([card()], { loadImages: false }))).text;
    expect(plain).not.toContain("Principal's Remark");
    expect(plain).not.toContain("Outstanding Fees");
    expect(plain).not.toContain("Session Average");

    const full = (
      await read(
        await buildReportCardsPdf(
          [card({ principalRemark: "Promoted with honours", sessionSummary: { sessionAverage: 93, promotion: { label: "Promoted to SS 2" } }, feeSummary: { outstanding: 30000 } })],
          { loadImages: false }
        )
      )
    ).text;
    expect(full).toContain("Principal's Remark");
    expect(full).toContain("Promoted with honours");
    expect(full).toContain("Promoted to SS 2");
    expect(full).toContain("₦30,000");
  });

  it("runs a long subject list onto another page rather than off the page", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `Subject ${i + 1}`, code: "S", cas: [{ score: 10 }], caTotal: 10, examTotal: 50, subjectTotal: 60, grade: "B", remark: "Good" }));
    const { text, pages } = await read(await buildReportCardsPdf([card({ subjects: many })], { loadImages: false }));
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain("Subject 30");
    expect(text).toContain("Performance Summary");
  });

  it("still makes a document when there are no cards", async () => {
    const { text } = await read(await buildReportCardsPdf([], { loadImages: false }));
    expect(text).toContain("no report cards");
  });
});

describe("broadsheet PDF", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    studentName: `Student ${i + 1}`, scores: { Maths: { subjectTotal: 50 + (i % 40) }, English: { subjectTotal: 60 } }, grandTotal: 100 + i, position: i + 1,
  }));

  it("lists every student, repeats across pages, and shows positions", async () => {
    const { text, pages } = await read(await buildBroadsheetPdf({ title: "Class Broadsheet — SS 1", subtitle: "First Term" }, { subjects: ["Maths", "English"], usePosition: true, rows }));
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain("Class Broadsheet — SS 1");
    expect(text).toContain("Student 1");
    expect(text).toContain("Student 50");
    expect(text).toContain("Pos.");
  });

  it("leaves out the position column when the school does not rank students", async () => {
    const { text } = await read(await buildBroadsheetPdf({ title: "T" }, { subjects: ["Maths"], usePosition: false, rows: rows.slice(0, 3) }));
    expect(text).not.toContain("Pos.");
  });
});

describe("helpers", () => {
  it("formats a date-only value without moving the day", () => {
    expect(formatDate("2027-01-11")).toBe("11/01/2027");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });

  it("formats money in naira", () => {
    expect(naira(30000)).toBe("₦30,000");
  });

  it("makes a safe download name", () => {
    expect(safeFileName("Report cards — SS 1 A / First Term")).toBe("Report-cards-SS-1-A-First-Term.pdf");
    expect(safeFileName("Adéwálé Ọlá")).toBe("Adewale-Ola.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("etc-passwd.pdf");
    expect(safeFileName("")).toBe("document.pdf");
  });

  it("sends a download, or an inline view for printing, and never lets it be cached", () => {
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    sendPdf(res, Buffer.from("%PDF-x"), "Report card");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", 'attachment; filename="Report-card.pdf"');
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");

    const inline: any = { setHeader: jest.fn(), end: jest.fn() };
    sendPdf(inline, Buffer.from("%PDF-x"), "x", { inline: true });
    expect(inline.setHeader).toHaveBeenCalledWith("Content-Disposition", 'inline; filename="x.pdf"');
  });
});

export {};
