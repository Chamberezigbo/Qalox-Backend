// The worker settles a credit reservation that was taken before the Gemini
// call, so every exit path has to either true it up or refund it. A path that
// forgets silently overcharges the school, which no type check would catch.
jest.mock("../util/prisma", () => ({
  aiGenerationJob: { findUnique: jest.fn(), update: jest.fn() },
  lessonNote: { create: jest.fn() },
  school: { findUnique: jest.fn(), update: jest.fn() },
}));

jest.mock("../Services/GeminiTextService", () => ({
  generateLessonNote: jest.fn(),
  buildContextExcerpt: jest.requireActual("../Services/GeminiTextService").buildContextExcerpt,
  LESSON_NOTE_MAX_OUTPUT_TOKENS: 2048,
}));

jest.mock("../Services/AiCreditService", () => ({
  trueUpCredits: jest.fn(),
  refundCredits: jest.fn(),
}));

import prisma from "../util/prisma";
import GeminiTextService from "../Services/GeminiTextService";
import AiCreditService from "../Services/AiCreditService";
import { processJob } from "../Services/AiGenerationWorker";

const db = prisma as unknown as {
  aiGenerationJob: { findUnique: jest.Mock; update: jest.Mock };
  lessonNote: { create: jest.Mock };
};
const gemini = GeminiTextService as unknown as { generateLessonNote: jest.Mock };
const credits = AiCreditService as unknown as { trueUpCredits: jest.Mock; refundCredits: jest.Mock };

const JOB = {
  id: "aig_test",
  schoolId: 7,
  staffId: 3,
  classId: 11,
  subjectId: 12,
  academicTermId: 2,
  schemeOfWorkId: 5,
  creditsReserved: 10,
  inputParamsJson: JSON.stringify({ topic: "Photosynthesis" }),
  schemeOfWork: { extractedText: "Week 1: Photosynthesis...", extractedTextStatus: "ready" },
  class: { name: "SS2", customName: null },
  subject: { name: "Biology" },
};

beforeEach(() => {
  jest.clearAllMocks();
  db.aiGenerationJob.findUnique.mockResolvedValue(JOB);
  db.aiGenerationJob.update.mockResolvedValue({});
  db.lessonNote.create.mockResolvedValue({ id: 99 });
  credits.trueUpCredits.mockResolvedValue({ charged: 2 });
  credits.refundCredits.mockResolvedValue(undefined);
});

describe("processJob — success", () => {
  beforeEach(() => {
    gemini.generateLessonNote.mockResolvedValue({
      parsed: { title: "Photosynthesis", objectives: ["Define it"], content: "## Objectives\n..." },
      usage: { inputTokens: 1500, outputTokens: 900 },
    });
  });

  it("trues up the reservation against real token usage, and never refunds", async () => {
    await processJob({ jobId: "aig_test" });

    expect(credits.trueUpCredits).toHaveBeenCalledWith(7, 10, {
      inputTokens: 1500,
      outputTokens: 900,
    });
    expect(credits.refundCredits).not.toHaveBeenCalled();
  });

  it("saves the note as a draft, never published", async () => {
    await processJob({ jobId: "aig_test" });

    const created = db.lessonNote.create.mock.calls[0][0].data;
    expect(created.status).toBe("draft");
    expect(created.source).toBe("ai_generated");
    expect(created.schoolId).toBe(7);
    expect(created.generationJobId).toBe("aig_test");
  });

  it("marks the job done with the charged amount and the resulting note id", async () => {
    await processJob({ jobId: "aig_test" });

    const final = db.aiGenerationJob.update.mock.calls[db.aiGenerationJob.update.mock.calls.length - 1][0].data;
    expect(final.status).toBe("done");
    expect(final.creditsCharged).toBe(2);
    expect(final.resultLessonNoteId).toBe(99);
  });
});

describe("processJob — failure", () => {
  it("refunds the whole reservation when Gemini fails", async () => {
    gemini.generateLessonNote.mockRejectedValue(new Error("Gemini request failed: timeout"));

    await processJob({ jobId: "aig_test" });

    expect(credits.refundCredits).toHaveBeenCalledWith(7, 10);
    expect(credits.trueUpCredits).not.toHaveBeenCalled();
  });

  it("records the failure with a zero charge and no lesson note", async () => {
    gemini.generateLessonNote.mockRejectedValue(new Error("Gemini returned an empty lesson note"));

    await processJob({ jobId: "aig_test" });

    expect(db.lessonNote.create).not.toHaveBeenCalled();
    const final = db.aiGenerationJob.update.mock.calls[db.aiGenerationJob.update.mock.calls.length - 1][0].data;
    expect(final.status).toBe("failed");
    expect(final.creditsCharged).toBe(0);
    expect(final.errorMessage).toMatch(/empty lesson note/);
  });

  it("refunds rather than calling Gemini at all when the scheme has no readable text", async () => {
    db.aiGenerationJob.findUnique.mockResolvedValue({
      ...JOB,
      schemeOfWork: { extractedText: null, extractedTextStatus: "failed" },
    });

    await processJob({ jobId: "aig_test" });

    expect(gemini.generateLessonNote).not.toHaveBeenCalled();
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 10);
  });

  it("does nothing at all when the job row has vanished", async () => {
    db.aiGenerationJob.findUnique.mockResolvedValue(null);

    await processJob({ jobId: "aig_test" });

    expect(credits.refundCredits).not.toHaveBeenCalled();
    expect(credits.trueUpCredits).not.toHaveBeenCalled();
  });
});

describe("buildContextExcerpt — bounding what gets sent to Gemini", () => {
  const { buildContextExcerpt, MAX_CONTEXT_CHARS } =
    jest.requireActual("../Services/GeminiTextService");

  it("passes a short scheme through untouched", () => {
    expect(buildContextExcerpt("Week 1: Cells", "Cells")).toBe("Week 1: Cells");
  });

  it("never exceeds the character ceiling, however long the scheme", () => {
    const huge = "x".repeat(MAX_CONTEXT_CHARS * 3);
    expect(buildContextExcerpt(huge, "nothing").length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("centres the excerpt on the topic rather than always taking the opening", () => {
    const filler = "a".repeat(MAX_CONTEXT_CHARS);
    const scheme = `${filler}\nWeek 9: Photosynthesis in detail\n${filler}`;

    const excerpt = buildContextExcerpt(scheme, "Photosynthesis");

    expect(excerpt).toContain("Photosynthesis");
    expect(excerpt.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("falls back to the opening section when the topic isn't found", () => {
    const scheme = "START-MARKER" + "b".repeat(MAX_CONTEXT_CHARS * 2);
    expect(buildContextExcerpt(scheme, "absent topic").startsWith("START-MARKER")).toBe(true);
  });
});
