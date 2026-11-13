export {};

jest.mock("../util/prisma", () => ({
  practiceQuestion: { findMany: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
  practiceSession: { create: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  practiceAnswer: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
  practiceReport: { create: jest.fn() },
  $transaction: jest.fn(),
}));

const prismaMock = require("../util/prisma");
const service = require("../Services/student/PracticeService");

const opts = (base: number, correct: number) => [0, 1, 2, 3].map((i) => ({ id: base + i, text: `opt${i}`, isCorrect: i === correct, order: i + 1 }));
const Q = (id: number, correct = 1, extra: any = {}) => ({ id, exam: "waec", subject: "Biology", source: "ai_practice", year: null, topic: "Cells", text: `Question ${id}?`, explanation: `Because ${id}`, options: opts(id * 10, correct), ...extra });
const session = (over: any = {}) => ({ id: 7, studentId: 1, schoolId: 1, exam: "waec", subject: "Biology", mode: "practice", topic: null, year: null, questionIds: [1, 2, 3], total: 3, status: "in_progress", startedAt: new Date(), deadlineAt: null, durationMinutes: null, score: null, submittedAt: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.practiceSession.count.mockResolvedValue(0);
  prismaMock.practiceSession.findFirst.mockResolvedValue(session());
  prismaMock.practiceSession.findUnique.mockResolvedValue(session());
  prismaMock.practiceQuestion.findMany.mockResolvedValue([Q(1), Q(2), Q(3)]);
  prismaMock.practiceAnswer.findMany.mockResolvedValue([]);
  prismaMock.practiceAnswer.findUnique.mockResolvedValue(null);
  prismaMock.practiceSession.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
});

describe("starting", () => {
  const start = (over: any = {}) => service.startSession({ studentId: 1, schoolId: 1, exam: "waec", subject: "biology", mode: "practice", count: 10, ...over });

  it("freezes a set of questions and sends them without any answers", async () => {
    prismaMock.practiceQuestion.findMany
      .mockResolvedValueOnce(Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })))   // candidates
      .mockResolvedValue([Q(1), Q(2)]);
    prismaMock.practiceSession.create.mockImplementation(({ data }: any) => Promise.resolve(session({ ...data, id: 9 })));
    const payload = await start();
    const created = prismaMock.practiceSession.create.mock.calls[0][0].data;
    expect(created.questionIds).toHaveLength(10);
    expect(created).toMatchObject({ exam: "waec", subject: "Biology", mode: "practice", total: 10, deadlineAt: null });
    expect(JSON.stringify(payload)).not.toContain("isCorrect");
  });

  it("exam mode is timed on the server", async () => {
    prismaMock.practiceQuestion.findMany.mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }))).mockResolvedValue([]);
    prismaMock.practiceSession.create.mockImplementation(({ data }: any) => Promise.resolve(session({ ...data, id: 9 })));
    await start({ mode: "exam", count: 20 });
    const created = prismaMock.practiceSession.create.mock.calls[0][0].data;
    expect(created.durationMinutes).toBe(18);
    expect(created.deadlineAt.getTime()).toBeGreaterThan(Date.now() + 17 * 60 * 1000);
  });

  it("refuses a thin bank, a bad subject, a bad count, a bad mode and too many sessions in a day", async () => {
    prismaMock.practiceQuestion.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    await expect(start()).rejects.toMatchObject({ code: "NOT_ENOUGH_QUESTIONS", status: 409 });
    await expect(start({ subject: "Astrology" })).rejects.toMatchObject({ code: "UNKNOWN_SUBJECT" });
    await expect(start({ count: 15 })).rejects.toMatchObject({ code: "INVALID_COUNT" });
    await expect(start({ mode: "cheat" })).rejects.toMatchObject({ code: "INVALID_MODE" });
    prismaMock.practiceSession.count.mockResolvedValue(40);
    await expect(start()).rejects.toMatchObject({ code: "DAILY_LIMIT", status: 429 });
  });

  it("retry uses only the questions missed last time", async () => {
    prismaMock.practiceSession.findFirst.mockResolvedValue(session({ status: "submitted", questionIds: [1, 2, 3] }));
    prismaMock.practiceAnswer.findMany.mockResolvedValue([{ questionId: 1, isCorrect: true }, { questionId: 2, isCorrect: false }]);
    prismaMock.practiceQuestion.findMany.mockResolvedValueOnce([{ id: 2 }, { id: 3 }]).mockResolvedValue([Q(2), Q(3)]);
    prismaMock.practiceSession.create.mockImplementation(({ data }: any) => Promise.resolve(session({ ...data, id: 10 })));
    await start({ retryFromSessionId: 7 });
    expect(prismaMock.practiceSession.create.mock.calls[0][0].data.questionIds).toEqual([2, 3]);
  });

  it("has nothing to retry when everything was right", async () => {
    prismaMock.practiceSession.findFirst.mockResolvedValue(session({ status: "submitted", questionIds: [1] }));
    prismaMock.practiceAnswer.findMany.mockResolvedValue([{ questionId: 1, isCorrect: true }]);
    await expect(start({ retryFromSessionId: 7 })).rejects.toMatchObject({ code: "NOTHING_TO_RETRY" });
  });
});

describe("answering", () => {
  it("practice mode shows the right answer and the explanation straight away, and locks the answer", async () => {
    prismaMock.practiceQuestion.findMany.mockResolvedValue([Q(1, 2)]);
    const out = await service.saveAnswer(1, 7, { questionId: 1, optionId: 10 }); // option 0, correct is index 2
    expect(out).toMatchObject({ saved: true, isCorrect: false, correctOptionId: 12, explanation: "Because 1" });
    prismaMock.practiceAnswer.findUnique.mockResolvedValue({ selectedOptionId: 10 });
    await expect(service.saveAnswer(1, 7, { questionId: 1, optionId: 12 })).rejects.toMatchObject({ code: "ALREADY_ANSWERED", reveal: { correctOptionId: 12 } });
  });

  it("exam mode never reveals anything before the end", async () => {
    prismaMock.practiceSession.findFirst.mockResolvedValue(session({ mode: "exam", deadlineAt: new Date(Date.now() + 60000) }));
    prismaMock.practiceQuestion.findMany.mockResolvedValue([Q(1, 2)]);
    const out = await service.saveAnswer(1, 7, { questionId: 1, optionId: 12 });
    expect(out).toEqual({ saved: true });
    expect(prismaMock.practiceAnswer.upsert.mock.calls[0][0].create).not.toHaveProperty("isCorrect");
    // The in-progress payload carries no answers or reveals either.
    prismaMock.practiceAnswer.findMany.mockResolvedValue([{ questionId: 1, selectedOptionId: 12 }]);
    const payload = await service.getSession(1, 7);
    expect(payload.revealed).toEqual({});
    expect(JSON.stringify(payload)).not.toContain("isCorrect");
    expect(JSON.stringify(payload)).not.toContain("Because");
  });

  it("refuses a question or option that is not part of the session, and answers after it ended", async () => {
    prismaMock.practiceQuestion.findMany.mockResolvedValue([Q(1)]);
    await expect(service.saveAnswer(1, 7, { questionId: 99, optionId: 1 })).rejects.toMatchObject({ code: "NOT_IN_SESSION" });
    await expect(service.saveAnswer(1, 7, { questionId: 1, optionId: 9999 })).rejects.toMatchObject({ code: "BAD_OPTION" });
    prismaMock.practiceSession.findFirst.mockResolvedValue(session({ status: "submitted" }));
    await expect(service.saveAnswer(1, 7, { questionId: 1, optionId: 10 })).rejects.toMatchObject({ code: "FINISHED" });
  });

  it("another student's session is not found", async () => {
    prismaMock.practiceSession.findFirst.mockResolvedValue(null);
    await expect(service.getSession(2, 7)).rejects.toMatchObject({ status: 404 });
  });
});

describe("finishing", () => {
  it("grades, treats skipped questions as wrong, and gives a full review with topics to revise", async () => {
    prismaMock.practiceQuestion.findMany.mockResolvedValue([Q(1, 1), Q(2, 1, { topic: "Genetics" }), Q(3, 1, { topic: "Genetics" })]);
    prismaMock.practiceAnswer.findMany.mockResolvedValue([{ questionId: 1, selectedOptionId: 11 }, { questionId: 2, selectedOptionId: 20 }]); // 1 right, 2 wrong, 3 skipped
    prismaMock.practiceSession.findUnique.mockResolvedValue(session({ status: "submitted", score: 1, total: 3, submittedAt: new Date() }));
    const result = await service.submit(1, 7);
    expect(prismaMock.practiceSession.updateMany).toHaveBeenCalledWith({ where: { id: 7, status: "in_progress" }, data: expect.objectContaining({ status: "submitted", score: 1, total: 3 }) });
    expect(result).toMatchObject({ score: 1, total: 3, percent: 33, canRetryMissed: true });
    expect(result.review.map((r: any) => r.isCorrect)).toEqual([true, false, false]);
    expect(result.topicsToRevise).toEqual([{ topic: "Genetics", missed: 2 }]);
    expect(result.review[0].options.find((o: any) => o.isCorrect).id).toBe(11);
  });

  it("closes a session whose time ran out, as auto-submitted", async () => {
    prismaMock.practiceSession.findFirst.mockResolvedValue(session({ mode: "exam", deadlineAt: new Date(Date.now() - 1000) }));
    prismaMock.practiceSession.findUnique.mockResolvedValue(session({ mode: "exam", status: "auto_submitted", score: 0, total: 3, deadlineAt: new Date(Date.now() - 1000) }));
    const out = await service.getSession(1, 7);
    expect(prismaMock.practiceSession.updateMany.mock.calls[0][0].data.status).toBe("auto_submitted");
    expect(out.autoSubmitted).toBe(true);
  });
});

describe("reporting", () => {
  it("only a student who answered the question can report it, once", async () => {
    prismaMock.practiceAnswer.findFirst.mockResolvedValue(null);
    await expect(service.report(1, 5, "wrong")).rejects.toMatchObject({ code: "NOT_ANSWERED", status: 403 });
    prismaMock.practiceAnswer.findFirst.mockResolvedValue({ id: 1 });
    prismaMock.practiceQuestion.update.mockResolvedValue({ reportCount: 1, status: "approved" });
    expect(await service.report(1, 5, "wrong")).toEqual({ reported: true });
    prismaMock.practiceReport.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await service.report(1, 5, "again")).toEqual({ reported: true, alreadyReported: true });
  });

  it("the third report hides the question", async () => {
    prismaMock.practiceReport.create.mockResolvedValue({});
    prismaMock.practiceAnswer.findFirst.mockResolvedValue({ id: 1 });
    prismaMock.practiceQuestion.update.mockResolvedValueOnce({ reportCount: 3, status: "approved" }).mockResolvedValue({});
    await service.report(1, 5, "wrong");
    expect(prismaMock.practiceQuestion.update).toHaveBeenLastCalledWith({ where: { id: 5 }, data: { status: "hidden" } });
  });
});

describe("progress", () => {
  it("averages each subject and lists the weakest topics that have enough answers", async () => {
    prismaMock.practiceSession.findMany.mockResolvedValue([{ exam: "waec", subject: "Biology", score: 6, total: 10 }, { exam: "waec", subject: "Biology", score: 8, total: 10 }]);
    prismaMock.practiceAnswer.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, i) => ({ questionId: 1, isCorrect: i < 1 })),   // Genetics: 1 of 5
      ...Array.from({ length: 5 }, () => ({ questionId: 2, isCorrect: true })),        // Cells: 5 of 5
      { questionId: 3, isCorrect: false },                                              // too few answers: ignored
    ]);
    prismaMock.practiceQuestion.findMany.mockResolvedValue([{ id: 1, topic: "Genetics", subject: "Biology" }, { id: 2, topic: "Cells", subject: "Biology" }, { id: 3, topic: "Ecology", subject: "Biology" }]);
    const out = await service.progress(1);
    expect(out.subjects[0]).toMatchObject({ subject: "Biology", sessions: 2, percent: 70 });
    expect(out.weakestTopics.map((t: any) => [t.topic, t.percent])).toEqual([["Genetics", 20], ["Cells", 100]]);
  });
});
