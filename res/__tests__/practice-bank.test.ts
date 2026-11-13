export {};

jest.mock("../util/prisma", () => ({
  practiceQuestion: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  practiceOption: { deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock("../config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../Services/GeminiPracticeService", () => ({ generateQuestions: jest.fn(), solveQuestions: jest.fn(), suggestTopics: jest.fn(), MAX_PER_CALL: 20 }));

const prismaMock = require("../util/prisma");
const gemini = require("../Services/GeminiPracticeService");
const bank = require("../Services/PracticeBankService");

const real = (over: any = {}) => ({ exam: "waec", subject: "Biology", year: 2019, text: "Which organelle is the site of photosynthesis?", options: ["Mitochondrion", "Chloroplast", "Nucleus", "Ribosome"], correct: "B", ...over });
const ai = (n: number, correctIndex = 1) => ({ text: `Which statement about topic ${n} is correct?`, options: ["one", "two", "three", "four"], correctIndex, explanation: "because", topic: "Cells" });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.practiceQuestion.findMany.mockResolvedValue([]);
  prismaMock.practiceQuestion.create.mockImplementation((a: any) => a);
  prismaMock.$transaction.mockImplementation((ops: any) => Promise.all(ops));
});

describe("import", () => {
  it("stores valid real questions as approved past questions, reporting bad ones by position", async () => {
    const out = await bank.importQuestions({ items: [real(), real({ text: "Another valid question here?" }), real({ subject: "Astrology" }), real({ year: undefined })] });
    expect(out).toMatchObject({ received: 4, created: 2, duplicates: 0 });
    expect(out.invalid.map((i: any) => i.index)).toEqual([3, 4]);
    const data = prismaMock.practiceQuestion.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ exam: "waec", subject: "Biology", source: "past_question", year: 2019, status: "approved" });
    expect(data.options.create.filter((o: any) => o.isCorrect)).toHaveLength(1);
  });

  it("skips duplicates, within the file and already in the bank", async () => {
    const first = await bank.importQuestions({ items: [real(), real()] });
    expect(first).toMatchObject({ created: 1, duplicates: 1 });
    const hash = prismaMock.practiceQuestion.create.mock.calls[0][0].data.contentHash;
    prismaMock.practiceQuestion.create.mockClear();
    prismaMock.practiceQuestion.findMany.mockResolvedValue([{ exam: "waec", subject: "Biology", contentHash: hash }]);
    expect(await bank.importQuestions({ items: [real()] })).toMatchObject({ created: 0, duplicates: 1 });
    expect(prismaMock.practiceQuestion.create).not.toHaveBeenCalled();
  });

  it("reads CSV, applies defaults, and refuses an empty or oversized load", async () => {
    const csv = "question,optionA,optionB,optionC,optionD,correct\nWhat is the powerhouse of the cell?,Nucleus,Mitochondrion,Ribosome,Vacuole,B\n";
    expect(await bank.importQuestions({ csv, defaults: { exam: "bece", subject: "Basic Science", year: 2020 } })).toMatchObject({ created: 1 });
    await expect(bank.importQuestions({})).rejects.toMatchObject({ code: "NO_ITEMS" });
    await expect(bank.importQuestions({ items: [] })).rejects.toMatchObject({ code: "NO_ITEMS" });
    await expect(bank.importQuestions({ items: new Array(2001).fill(real()) })).rejects.toMatchObject({ code: "TOO_MANY" });
  });
});

describe("AI generation with the independent second pass", () => {
  it("approves only the questions where the second pass agrees; the rest wait for review", async () => {
    gemini.generateQuestions.mockResolvedValue([ai(1), ai(2), ai(3)]);
    gemini.solveQuestions.mockResolvedValue([1, 2, 1]); // the second pass disagrees on question 2
    const out = await bank.generate({ exam: "wassce", subject: "biology", topic: "Cells", count: 3 });
    expect(out).toMatchObject({ written: 3, approved: 2, needsReview: 1 });
    const stored = prismaMock.practiceQuestion.create.mock.calls.map((c: any) => [c[0].data.status, c[0].data.source]);
    expect(stored).toEqual([["approved", "ai_practice"], ["needs_review", "ai_practice"], ["approved", "ai_practice"]]);
  });

  it("approves nothing when the second pass cannot run", async () => {
    gemini.generateQuestions.mockResolvedValue([ai(1), ai(2)]);
    gemini.solveQuestions.mockRejectedValue(new Error("busy"));
    const out = await bank.generate({ exam: "waec", subject: "Biology", count: 2 });
    expect(out).toMatchObject({ approved: 0, needsReview: 2 });
  });

  it("drops malformed AI questions and skips ones already in the bank", async () => {
    gemini.generateQuestions.mockResolvedValue([ai(1), { ...ai(2), options: ["only", "only"] }, ai(3)]);
    gemini.solveQuestions.mockResolvedValue([1, 1]);
    const out = await bank.generate({ exam: "waec", subject: "Biology", count: 3 });
    expect(out).toMatchObject({ written: 2, rejected: 1 });
    const hash = prismaMock.practiceQuestion.create.mock.calls[0][0].data.contentHash;
    prismaMock.practiceQuestion.create.mockClear();
    gemini.generateQuestions.mockResolvedValue([ai(1)]);
    gemini.solveQuestions.mockResolvedValue([1]);
    prismaMock.practiceQuestion.findMany.mockResolvedValue([{ exam: "waec", subject: "Biology", contentHash: hash }]);
    expect(await bank.generate({ exam: "waec", subject: "Biology", count: 1 })).toMatchObject({ written: 0, duplicates: 1 });
  });

  it("refuses a subject the exam does not offer", async () => {
    await expect(bank.generate({ exam: "bece", subject: "Biology" })).rejects.toMatchObject({ code: "UNKNOWN_SUBJECT" });
    expect(gemini.generateQuestions).not.toHaveBeenCalled();
  });
});

describe("topic suggestions", () => {
  it("asks the AI for the subject's topics, using the canonical subject name", async () => {
    gemini.suggestTopics.mockResolvedValue(["Cells", "Genetics"]);
    expect(await bank.suggestTopics({ exam: "waec", subject: "biology", max: 5 })).toEqual({ subject: "Biology", topics: ["Cells", "Genetics"] });
    expect(gemini.suggestTopics).toHaveBeenCalledWith({ exam: "waec", subject: "Biology", max: 5 });
  });
  it("refuses a subject the exam does not offer, and caps the number of topics", async () => {
    await expect(bank.suggestTopics({ exam: "bece", subject: "Biology" })).rejects.toMatchObject({ code: "UNKNOWN_SUBJECT" });
    gemini.suggestTopics.mockResolvedValue([]);
    await bank.suggestTopics({ exam: "waec", subject: "Biology", max: 500 });
    expect(gemini.suggestTopics).toHaveBeenLastCalledWith({ exam: "waec", subject: "Biology", max: 20 });
  });
});

describe("review", () => {
  const current = { id: 4, exam: "waec", subject: "Biology", source: "past_question", year: 2019, topic: null, text: "Which organelle is the site of photosynthesis?", explanation: null, options: [{ text: "Mitochondrion", isCorrect: false }, { text: "Chloroplast", isCorrect: true }, { text: "Nucleus", isCorrect: false }, { text: "Ribosome", isCorrect: false }] };
  beforeEach(() => {
    prismaMock.practiceQuestion.findUnique.mockResolvedValue(current);
    prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
  });

  it("approving a question clears its reports", async () => {
    await bank.updateQuestion(4, { status: "approved" });
    expect(prismaMock.practiceQuestion.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { status: "approved", reportCount: 0 } });
  });
  it("correcting a question re-checks it and replaces its options", async () => {
    await bank.updateQuestion(4, { options: ["Mitochondrion", "Chloroplast", "Nucleus", "Vacuole"], correct: "B" });
    expect(prismaMock.practiceOption.deleteMany).toHaveBeenCalledWith({ where: { questionId: 4 } });
    expect(prismaMock.practiceOption.createMany.mock.calls[0][0].data).toHaveLength(4);
    expect(prismaMock.practiceQuestion.update.mock.calls[0][0].data.contentHash).toHaveLength(40);
  });
  it("refuses an invalid status, an invalid edit, nothing to change, and an unknown question", async () => {
    await expect(bank.updateQuestion(4, { status: "great" })).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(bank.updateQuestion(4, { options: ["a", "b"], correct: "Z" })).rejects.toMatchObject({ code: "INVALID_QUESTION" });
    await expect(bank.updateQuestion(4, {})).rejects.toMatchObject({ code: "NO_CHANGE" });
    prismaMock.practiceQuestion.findUnique.mockResolvedValue(null);
    await expect(bank.updateQuestion(99, { status: "approved" })).rejects.toMatchObject({ status: 404 });
  });
});
