// Generating questions is billed like a lesson note: reserved up front, trued up
// on success and refunded in full on failure. A generated test is a draft.
const mockPrisma: any = {
  aiGenerationJob: { findUnique: jest.fn(), update: jest.fn() },
  test: { create: jest.fn() },
  question: { create: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../config/logger", () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../Services/GeminiTextService", () => ({ generateExamQuestions: jest.fn(), generateLessonNote: jest.fn(), buildTeacherBrief: jest.fn() }));
jest.mock("../Services/AiCreditService", () => ({ trueUpCredits: jest.fn(), refundCredits: jest.fn() }));

import GeminiTextService from "../Services/GeminiTextService";
import AiCreditService from "../Services/AiCreditService";
import { processJob } from "../Services/AiGenerationWorker";

const gemini = GeminiTextService as unknown as { generateExamQuestions: jest.Mock };
const credits = AiCreditService as unknown as { trueUpCredits: jest.Mock; refundCredits: jest.Mock };

const JOB = {
  id: "aig_t", schoolId: 7, staffId: 3, classId: 9, subjectId: 4, academicTermId: 2, schemeOfWorkId: 6,
  jobType: "exam_questions", creditsReserved: 20,
  inputParamsJson: JSON.stringify({ topic: "Cells", count: 3, difficulty: "medium" }),
  schemeOfWork: { extractedText: "text", extractedTextStatus: "ready" },
  class: { name: "SS1", customName: null }, subject: { name: "Biology" },
};
const good = (n: number) => ({ text: `Question ${n}?`, options: ["a", "b", "c", "d"], correctIndex: n % 4, explanation: "because" });

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.aiGenerationJob.findUnique.mockResolvedValue(JOB);
  mockPrisma.aiGenerationJob.update.mockResolvedValue({});
  mockPrisma.test.create.mockResolvedValue({ id: 55 });
  mockPrisma.question.create.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  credits.trueUpCredits.mockResolvedValue({ charged: 6 });
  credits.refundCredits.mockResolvedValue(undefined);
});

describe("exam_questions job", () => {
  it("saves a draft test with its questions and settles the credits against real usage", async () => {
    gemini.generateExamQuestions.mockResolvedValue({ questions: [good(0), good(1), good(2)], usage: { inputTokens: 900, outputTokens: 500 } });

    await processJob({ jobId: "aig_t" });

    const test = mockPrisma.test.create.mock.calls[0][0].data;
    expect(test).toMatchObject({ status: "draft", classId: 9, subjectId: 4, createdByStaffId: 3, title: "Biology: Cells" });
    expect(mockPrisma.question.create).toHaveBeenCalledTimes(3);
    expect(credits.trueUpCredits).toHaveBeenCalledWith(7, 20, { inputTokens: 900, outputTokens: 500 });
    expect(credits.refundCredits).not.toHaveBeenCalled();
    expect(mockPrisma.aiGenerationJob.update.mock.calls.at(-1)[0].data).toMatchObject({ status: "done", resultTestId: 55 });
  });

  it("keeps the usable questions and drops the broken ones", async () => {
    gemini.generateExamQuestions.mockResolvedValue({
      questions: [good(0), { text: "No options", options: ["a"], correctIndex: 0 }, good(1)],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await processJob({ jobId: "aig_t" });
    expect(mockPrisma.question.create).toHaveBeenCalledTimes(2);
  });

  it("fails and refunds in full when nothing usable comes back", async () => {
    gemini.generateExamQuestions.mockResolvedValue({ questions: [{ text: "x", options: [] }], usage: { inputTokens: 1, outputTokens: 1 } });

    await processJob({ jobId: "aig_t" });

    expect(mockPrisma.test.create).not.toHaveBeenCalled();
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 20);
    expect(credits.trueUpCredits).not.toHaveBeenCalled();
    expect(mockPrisma.aiGenerationJob.update.mock.calls.at(-1)[0].data).toMatchObject({ status: "failed", creditsCharged: 0 });
  });

  it("fails and refunds when the AI call fails", async () => {
    gemini.generateExamQuestions.mockRejectedValue(new Error("Gemini down"));
    await processJob({ jobId: "aig_t" });
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 20);
    expect(mockPrisma.test.create).not.toHaveBeenCalled();
  });
});

export {};
