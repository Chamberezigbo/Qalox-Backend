// The exam-paper chat: whatever the AI sends is rebuilt before it is stored, a failed turn
// refunds and saves nothing, a diagram that cannot be drawn is refunded, and one teacher
// never reaches another's paper.
/* eslint-disable @typescript-eslint/no-var-requires */
import path from "path";
import { spawnSync } from "child_process";

const mockPrisma: any = {
  teacherAssignment: { findFirst: jest.fn() },
  examPaperChat: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  examPaperChatMessage: { findMany: jest.fn(), createMany: jest.fn() },
  class: { findFirst: jest.fn() },
  subject: { findFirst: jest.fn() },
  academicTerm: { findFirst: jest.fn() },
  schemeOfWork: { findFirst: jest.fn() },
  school: { findUnique: jest.fn() },
  campus: { findFirst: jest.fn(), count: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../Services/AiCreditService", () => ({
  reserveCredits: jest.fn(),
  trueUpCredits: jest.fn(),
  refundCredits: jest.fn(),
  creditsForTokens: jest.fn(() => 40),
  estimateTokensFromText: jest.fn((t: string) => Math.ceil((t?.length ?? 0) / 4)),
  TOKENS_PER_IMAGE: 800,
  CREDITS_PER_GENERATED_IMAGE: 80,
}));
jest.mock("../Services/ExamPaperAiService", () => ({
  chatTurn: jest.fn(),
  generateImage: jest.fn(),
  buildSystemPrompt: jest.fn(() => "system"),
  PAPER_MAX_OUTPUT_TOKENS: 8192,
}));
jest.mock("../Services/GeminiTextService", () => ({ buildContextExcerpt: jest.fn(() => "scheme excerpt") }));
jest.mock("../Services/R2Service", () => ({
  uploadObject: jest.fn(async ({ key }: any) => key),
  getPresignedUrl: jest.fn(async (k: string) => `https://r2.test/${k}`),
  getObjectBuffer: jest.fn(),
  deleteObject: jest.fn(),
}));
jest.mock("../controller/public/publicController", () => ({ schoolMediaUrl: jest.fn(async () => null) }));

const credits = require("../Services/AiCreditService");
const r2 = require("../Services/R2Service");
const ai = require("../Services/ExamPaperAiService");
const controller = require("../controller/teacher/ExamPaperChatController");
const { normalizePaper } = require("../util/examPaper");
const { buildExamPaperPdf } = require("../util/examPaperPdf");

const CHAT = { id: 4, schoolId: 5, staffId: 3, classId: 9, subjectId: 2, title: "Biology", paperJson: null };

const call = async (handler: any, req: any) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ schoolId: 5, staffId: 3, params: { id: "4" }, body: {}, query: {}, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0]?.[0], next };
};

const objective = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `Q${i + 1}?`, options: ["a", "b", "c", "d"], answer: "B", marks: 1 }));

beforeEach(() => {
  jest.resetAllMocks();
  credits.reserveCredits.mockResolvedValue({ reserved: 40 });
  credits.trueUpCredits.mockResolvedValue({ charged: 12 });
  credits.refundCredits.mockResolvedValue(undefined);
  r2.uploadObject.mockImplementation(async ({ key }: any) => key);
  r2.getPresignedUrl.mockImplementation(async (k: string) => `https://r2.test/${k}`);
  r2.deleteObject.mockResolvedValue(undefined);
  credits.creditsForTokens.mockReturnValue(40);
  credits.estimateTokensFromText.mockImplementation((t: string) => Math.ceil((t?.length ?? 0) / 4));
  mockPrisma.examPaperChat.findFirst.mockResolvedValue({ ...CHAT });
  mockPrisma.examPaperChatMessage.findMany.mockResolvedValue([]);
  mockPrisma.class.findFirst.mockResolvedValue({ name: "SS 1", customName: null, campusId: null });
  mockPrisma.subject.findFirst.mockResolvedValue({ name: "Biology" });
  mockPrisma.academicTerm.findFirst.mockResolvedValue({ id: 1, name: "First Term" });
  mockPrisma.schemeOfWork.findFirst.mockResolvedValue(null);
  mockPrisma.examPaperChat.update.mockResolvedValue({});
  mockPrisma.examPaperChatMessage.createMany.mockResolvedValue({});
  ai.buildSystemPrompt.mockReturnValue("system");
});

describe("normalizePaper", () => {
  const ctx = { imagePrefix: "exam-papers/5/4/" };

  it("keeps only what a paper has, works out the marks and numbers the options", () => {
    const { paper } = normalizePaper(
      { title: "T", evil: "x", sections: [{ type: "objective", questions: [{ text: "Q?", options: ["a", "b", "c", "d"], answer: "c", marks: 2 }] }, { type: "theory", questions: [{ text: "Explain", marks: 10 }] }] },
      ctx
    );
    expect(paper.totalMarks).toBe(12);
    expect(paper.sections[0].questions[0].options.map((o: any) => o.label)).toEqual(["A", "B", "C", "D"]);
    expect(paper.sections[0].questions[0].answer).toBe("C");
    expect((paper as any).evil).toBeUndefined();
  });

  it("drops an answer that is not one of the options, and blank questions", () => {
    const { paper } = normalizePaper({ sections: [{ type: "objective", questions: [{ text: "Q?", options: ["a", "b"], answer: "D" }, { text: "   " }] }] }, ctx);
    expect(paper.sections[0].questions).toHaveLength(1);
    expect(paper.sections[0].questions[0].answer).toBe("");
  });

  it("caps the number of questions", () => {
    const { paper } = normalizePaper({ sections: [{ type: "objective", questions: objective(200) }] }, ctx);
    expect(paper.sections[0].questions).toHaveLength(80);
  });

  it("gives every question a unique id, even when the AI repeats one", () => {
    const { paper } = normalizePaper({ sections: [{ type: "theory", questions: [{ id: "q1", text: "a" }, { id: "q1", text: "b" }] }] }, ctx);
    const ids = paper.sections[0].questions.map((q: any) => q.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("accepts an image only from this paper's own folder or already on the paper", () => {
    const previous = { sections: [{ questions: [{ imageKey: "exam-papers/5/4/old.png" }] }] };
    const { paper } = normalizePaper(
      { sections: [{ type: "theory", questions: [
        { text: "mine", imageKey: "exam-papers/5/4/new.png" },
        { text: "old", imageKey: "exam-papers/5/4/old.png" },
        { text: "theirs", imageKey: "exam-papers/6/9/stolen.png" },
        { text: "path", imageKey: "exam-papers/5/4/../../6/x.png" },
      ] }] },
      { ...ctx, previous }
    );
    expect(paper.sections[0].questions.map((q: any) => q.imageKey)).toEqual(["exam-papers/5/4/new.png", "exam-papers/5/4/old.png", undefined, undefined]);
  });
});

describe("sendMessage", () => {
  it("stores the paper the AI writes, with the marks worked out, and charges the turn", async () => {
    ai.chatTurn.mockResolvedValue({
      reply: "Here is your paper.",
      paper: { title: "Bio", sections: [{ type: "objective", questions: objective(3) }, { type: "theory", questions: [{ text: "Explain", marks: 10 }] }] },
      usage: { inputTokens: 100, outputTokens: 500 },
    });
    const { body } = await call(controller.sendMessage, { body: { message: "10 theory and 30 objective on week 1-4" } });

    expect(body.data.paperChanged).toBe(true);
    expect(body.data.paper.totalMarks).toBe(13);
    const saved = JSON.parse(mockPrisma.examPaperChat.update.mock.calls[0][0].data.paperJson);
    expect(saved.sections).toHaveLength(2);
    expect(body.data.creditsCharged).toBe(12);
    expect(mockPrisma.examPaperChatMessage.createMany).toHaveBeenCalledTimes(1);
  });

  it("only talks when the AI sends no paper, and leaves the stored paper alone", async () => {
    ai.chatTurn.mockResolvedValue({ reply: "Which topics?", paper: null, usage: { inputTokens: 50, outputTokens: 20 } });
    const { body } = await call(controller.sendMessage, { body: { message: "make an exam" } });
    expect(body.data.paperChanged).toBe(false);
    expect(mockPrisma.examPaperChat.update).not.toHaveBeenCalled();
  });

  it("refunds the whole reservation and saves nothing when the AI fails", async () => {
    ai.chatTurn.mockRejectedValue(new Error("Gemini is down"));
    const { status } = await call(controller.sendMessage, { body: { message: "hello" } });

    expect(status).toBe(502);
    expect(credits.refundCredits).toHaveBeenCalledWith(5, 40);
    expect(credits.trueUpCredits).not.toHaveBeenCalled();
    expect(mockPrisma.examPaperChatMessage.createMany).not.toHaveBeenCalled();
  });

  it("draws a requested diagram, billing it, and refunds it when it cannot be drawn", async () => {
    ai.chatTurn.mockResolvedValue({
      reply: "Done.",
      paper: { sections: [{ type: "theory", questions: [{ text: "Label the cell", imagePrompt: "an animal cell", marks: 5 }] }] },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    ai.generateImage.mockRejectedValue(new Error("The diagram could not be drawn."));
    credits.reserveCredits.mockResolvedValueOnce({ reserved: 40 }).mockResolvedValueOnce({ reserved: 80 });

    const { body } = await call(controller.sendMessage, { body: { message: "add a diagram" } });

    expect(credits.reserveCredits).toHaveBeenCalledWith(5, 80);
    expect(credits.refundCredits).toHaveBeenCalledWith(5, 80);
    expect(body.data.reply).toMatch(/could not be drawn/);
    expect(body.data.creditsCharged).toBe(12); // text only: the diagram was refunded
  });

  it("charges a diagram that was drawn and puts it on the question", async () => {
    const png = await require("sharp")({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
    ai.chatTurn.mockResolvedValue({
      reply: "Done.",
      paper: { sections: [{ type: "theory", questions: [{ text: "Label the cell", imagePrompt: "an animal cell", marks: 5 }] }] },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    ai.generateImage.mockResolvedValue({ buffer: png, mimeType: "image/png" });
    credits.reserveCredits.mockResolvedValueOnce({ reserved: 40 }).mockResolvedValueOnce({ reserved: 80 });

    const { body } = await call(controller.sendMessage, { body: { message: "add a diagram" } });

    expect(body.data.paper.sections[0].questions[0].imageKey).toMatch(/^exam-papers\/5\/4\//);
    expect(body.data.creditsCharged).toBe(12 + 80);
  });

  it("will not open another teacher's paper", async () => {
    mockPrisma.examPaperChat.findFirst.mockResolvedValue(null);
    const { status } = await call(controller.sendMessage, { body: { message: "hi" } });
    expect(status).toBe(404);
    expect(mockPrisma.examPaperChat.findFirst.mock.calls[0][0].where).toMatchObject({ staffId: 3, schoolId: 5 });
    expect(ai.chatTurn).not.toHaveBeenCalled();
  });

  it("needs a message", async () => {
    expect((await call(controller.sendMessage, { body: { message: "  " } })).status).toBe(400);
  });
});

describe("start and save", () => {
  it("only starts a paper for a class and subject the teacher teaches", async () => {
    mockPrisma.teacherAssignment.findFirst.mockResolvedValue(null);
    const { status } = await call(controller.start, { body: { classId: 9, subjectId: 2 } });
    expect(status).toBe(403);
  });

  it("saves the teacher's edits through the same validation", async () => {
    const { body } = await call(controller.savePaper, { body: { paper: { title: "Edited", sections: [{ type: "objective", questions: [{ text: "Q?", options: ["a", "b"], answer: "A" }] }] } } });
    expect(body.data.paper.title).toBe("Edited");
    expect(mockPrisma.examPaperChat.update.mock.calls[0][0].data.title).toBe("Edited");
  });
});

describe("the printable PDF", () => {
  const read = (buffer: Buffer) => {
    const run = spawnSync(process.execPath, [path.join(__dirname, "helpers", "pdfText.js")], { input: buffer, maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(run.stdout.toString());
  };
  const { paper } = normalizePaper(
    { title: "First Term Biology", durationMinutes: 90, sections: [
      { type: "objective", questions: [{ text: "Which organelle makes energy?", options: ["Nucleus", "Mitochondrion", "Ribosome", "Vacuole"], answer: "B" }] },
      { type: "theory", questions: [{ text: "Describe photosynthesis.", marks: 10, answer: "Light, water, CO2" }] },
    ] },
    { imagePrefix: "p/" }
  );
  const ctx = { school: { name: "Daniel College" }, className: "SS 1", subjectName: "Biology", termName: "First Term", images: new Map() };

  it("prints the student copy without answers", async () => {
    const { text } = read(await buildExamPaperPdf(paper, ctx));
    expect(text).toContain("Daniel College");
    expect(text).toContain("First Term Biology");
    expect(text).toContain("Time allowed: 90 minutes");
    expect(text).toContain("Which organelle makes energy?");
    expect(text).not.toContain("(correct)");
    expect(text).not.toContain("Marking guide");
  });

  it("prints the teacher's copy with the answers", async () => {
    const { text } = read(await buildExamPaperPdf(paper, { ...ctx, answers: true }));
    expect(text).toContain("TEACHER'S COPY");
    expect(text).toMatch(/Mitochondrion\s+\(correct\)/);
    expect(text).toContain("Marking guide: Light, water, CO2");
  });
});

export {};
