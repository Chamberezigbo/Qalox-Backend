const mockPrisma: any = {
  aiGenerationJob: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  lessonNote: { create: jest.fn() },
  lessonNoteChat: { update: jest.fn(), updateMany: jest.fn() },
  lessonNoteChatMessage: { findMany: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../config/logger", () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../Services/GeminiTextService", () => ({
  generateLessonNote: jest.fn(),
  buildTeacherBrief: jest.requireActual("../Services/GeminiTextService").buildTeacherBrief,
}));
jest.mock("../Services/AiCreditService", () => ({ trueUpCredits: jest.fn(), refundCredits: jest.fn() }));

import GeminiTextService from "../Services/GeminiTextService";
import AiCreditService from "../Services/AiCreditService";
import { processJob } from "../Services/AiGenerationWorker";
const { failStrandedAiJobs } = require("../jobs/aiJobRecovery");

const gemini = GeminiTextService as unknown as { generateLessonNote: jest.Mock };
const credits = AiCreditService as unknown as { trueUpCredits: jest.Mock; refundCredits: jest.Mock };

const job = (params: object) => ({
  id: "aig_1", schoolId: 7, staffId: 3, classId: 11, subjectId: 12, academicTermId: 2, schemeOfWorkId: 5,
  creditsReserved: 10, inputParamsJson: JSON.stringify(params),
  schemeOfWork: { extractedText: "Week 1", extractedTextStatus: "ready" },
  class: { name: "SS2", customName: null }, subject: { name: "Biology" },
});

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.aiGenerationJob.update.mockResolvedValue({});
  mockPrisma.lessonNote.create.mockResolvedValue({ id: 99 });
  mockPrisma.lessonNoteChat.update.mockResolvedValue({});
  mockPrisma.lessonNoteChatMessage.findMany.mockResolvedValue([
    { role: "model", kind: "chat", content: "Which method?" },
    { role: "user", kind: "chat", content: "group work" },
  ]);
  credits.trueUpCredits.mockResolvedValue({ charged: 3 });
  credits.refundCredits.mockResolvedValue(undefined);
});

describe("processJob for a chat", () => {
  it("hands the conversation to the generator and marks the chat generated", async () => {
    mockPrisma.aiGenerationJob.findUnique.mockResolvedValue(job({ topic: "Photo", chatId: 20 }));
    gemini.generateLessonNote.mockResolvedValue({
      parsed: { title: "T", objectives: [], content: "c" }, usage: { inputTokens: 1, outputTokens: 1 },
    });

    await processJob({ jobId: "aig_1" });

    expect(gemini.generateLessonNote.mock.calls[0][0].teacherBrief).toBe("Assistant: Which method?\nTeacher: group work");
    expect(mockPrisma.lessonNoteChat.update).toHaveBeenCalledWith({ where: { id: 20 }, data: { status: "generated", lessonNoteId: 99 } });
  });

  it("reopens the chat and refunds when generation fails", async () => {
    mockPrisma.aiGenerationJob.findUnique.mockResolvedValue(job({ chatId: 20 }));
    gemini.generateLessonNote.mockRejectedValue(new Error("boom"));

    await processJob({ jobId: "aig_1" });

    expect(credits.refundCredits).toHaveBeenCalledWith(7, 10);
    expect(mockPrisma.lessonNoteChat.update).toHaveBeenCalledWith({ where: { id: 20 }, data: { status: "open" } });
  });

  it("is unchanged for a job with no chat", async () => {
    mockPrisma.aiGenerationJob.findUnique.mockResolvedValue(job({ topic: "Photo" }));
    gemini.generateLessonNote.mockResolvedValue({
      parsed: { title: "T", objectives: [], content: "c" }, usage: { inputTokens: 1, outputTokens: 1 },
    });

    await processJob({ jobId: "aig_1" });

    expect(mockPrisma.lessonNoteChatMessage.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lessonNoteChat.update).not.toHaveBeenCalled();
    expect(gemini.generateLessonNote.mock.calls[0][0].teacherBrief).toBe("");
  });
});

describe("failStrandedAiJobs", () => {
  const stranded = { id: "aig_old", schoolId: 7, creditsReserved: 10, inputParamsJson: JSON.stringify({ chatId: 20 }) };

  it("fails an abandoned job, refunds it once, and reopens its chat", async () => {
    mockPrisma.aiGenerationJob.findMany.mockResolvedValue([stranded]);
    mockPrisma.aiGenerationJob.updateMany.mockResolvedValue({ count: 1 });

    await failStrandedAiJobs();

    expect(credits.refundCredits).toHaveBeenCalledTimes(1);
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 10);
    expect(mockPrisma.lessonNoteChat.updateMany).toHaveBeenCalledWith({ where: { id: 20, status: "generating" }, data: { status: "open" } });
  });

  it("does not refund a job that finished between the look and the claim", async () => {
    mockPrisma.aiGenerationJob.findMany.mockResolvedValue([stranded]);
    mockPrisma.aiGenerationJob.updateMany.mockResolvedValue({ count: 0 });

    await failStrandedAiJobs();

    expect(credits.refundCredits).not.toHaveBeenCalled();
  });

  it("only looks at jobs idle past the cutoff", async () => {
    mockPrisma.aiGenerationJob.findMany.mockResolvedValue([]);
    await failStrandedAiJobs();
    const where = mockPrisma.aiGenerationJob.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["queued", "processing"] });
    expect(where.updatedAt.lt.getTime()).toBeLessThan(Date.now() - 14 * 60 * 1000);
  });
});
