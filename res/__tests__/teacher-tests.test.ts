// A published test is what students will be marked against, so the guards that
// matter are: only the owner can touch it, only a draft can be edited, and a
// broken question can never be published.
const mockPrisma: any = {
  teacherAssignment: { findFirst: jest.fn() },
  aiGenerationJob: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn() },
  academicTerm: { findFirst: jest.fn() },
  schemeOfWork: { findFirst: jest.fn() },
  test: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  question: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn(), delete: jest.fn() },
  questionOption: { deleteMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../Services/AiCreditService", () => ({
  reserveCredits: jest.fn(),
  refundCredits: jest.fn(),
  creditsForTokens: jest.fn(() => 12),
  estimateTokensFromText: jest.fn(() => 800),
}));
jest.mock("../Services/AiGenerationWorker", () => ({ processJob: jest.fn(() => Promise.resolve()) }));
jest.mock("../Services/GeminiTextService", () => ({
  buildContextExcerpt: jest.fn(() => "scheme"),
  examOutputCeiling: jest.fn((n: number) => 400 + 170 * n),
  getModel: () => "test-model",
}));

import AiCreditService from "../Services/AiCreditService";
import AiGenerationWorker from "../Services/AiGenerationWorker";
/* eslint-disable @typescript-eslint/no-var-requires */
const controller = require("../controller/teacher/TestController");
const credits = AiCreditService as unknown as Record<string, jest.Mock>;

const call = async (handler: any, req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ staffId: 3, schoolId: 7, params: { id: "5" }, body: {}, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
};

const goodQuestion = { id: 1, text: "Q?", explanation: null, order: 1, marks: 1, options: [
  { id: 1, text: "a", isCorrect: true, order: 1 }, { id: 2, text: "b", isCorrect: false, order: 2 },
] };
const draft = (over: object = {}) => ({ id: 5, status: "draft", durationMinutes: 30, opensAt: null, closesAt: null, questions: [goodQuestion], _count: { attempts: 0, questions: 1 }, ...over });

beforeEach(() => {
  jest.resetAllMocks();
  (AiGenerationWorker as any).processJob.mockResolvedValue(undefined);
  credits.creditsForTokens.mockReturnValue(12);
  credits.estimateTokensFromText.mockReturnValue(800);
  credits.reserveCredits.mockResolvedValue({ reserved: 12 });
  credits.refundCredits.mockResolvedValue(undefined);
});

describe("generate", () => {
  const body = { classId: 9, subjectId: 4, topic: "Cells", count: 10, difficulty: "easy" };
  beforeEach(() => {
    mockPrisma.teacherAssignment.findFirst.mockResolvedValue({ id: 1 });
    mockPrisma.aiGenerationJob.findFirst.mockResolvedValue(null);
    mockPrisma.aiGenerationJob.count.mockResolvedValue(0);
    mockPrisma.academicTerm.findFirst.mockResolvedValue({ id: 2 });
    mockPrisma.schemeOfWork.findFirst.mockResolvedValue({ id: 6, extractedText: "x", extractedTextStatus: "ready" });
    mockPrisma.aiGenerationJob.create.mockResolvedValue({ id: "aig_1" });
  });

  it("creates an exam_questions job with the reservation, and starts the worker", async () => {
    const { status, body: out } = await call(controller.generate, { body });
    expect(status).toBe(202);
    expect(out.data).toEqual({ jobId: "aig_1", creditsReserved: 12 });
    const data = mockPrisma.aiGenerationJob.create.mock.calls[0][0].data;
    expect(data.jobType).toBe("exam_questions");
    expect(JSON.parse(data.inputParamsJson)).toMatchObject({ count: 10, difficulty: "easy", topic: "Cells" });
  });

  it("refuses a class the teacher does not teach before spending anything", async () => {
    mockPrisma.teacherAssignment.findFirst.mockResolvedValue(null);
    expect((await call(controller.generate, { body })).status).toBe(403);
    expect(credits.reserveCredits).not.toHaveBeenCalled();
  });

  it.each([0, 41, "x"])("refuses %j questions", async (count) => {
    expect((await call(controller.generate, { body: { ...body, count } })).status).toBe(400);
  });

  it("needs a readable scheme of work", async () => {
    mockPrisma.schemeOfWork.findFirst.mockResolvedValue(null);
    const { status, body: out } = await call(controller.generate, { body });
    expect(status).toBe(404);
    expect(out.code).toBe("SCHEME_OF_WORK_NOT_FOUND");
  });

  it("returns the credits if the job cannot be created", async () => {
    mockPrisma.aiGenerationJob.create.mockRejectedValue(new Error("db"));
    const { next } = await call(controller.generate, { body });
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 12);
    expect(next).toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("only looks up the test among this teacher's own, in this school", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(null);
    const { status } = await call(controller.get, {});
    expect(status).toBe(404);
    expect(mockPrisma.test.findFirst.mock.calls[0][0].where).toEqual({ id: 5, createdByStaffId: 3, schoolId: 7 });
  });
});

describe("editing", () => {
  it.each([["update", { title: "New" }], ["addQuestion", { text: "Q?", options: [{ text: "a", isCorrect: true }, { text: "b" }] }]])(
    "%s is refused once the test is published",
    async (name, body) => {
      mockPrisma.test.findFirst.mockResolvedValue(draft({ status: "published" }));
      const { status, body: out } = await call((controller as any)[name], { body });
      expect(status).toBe(409);
      expect(out.code).toBe("TEST_NOT_DRAFT");
    }
  );

  it("refuses a question with no correct answer", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(draft());
    const { status, body } = await call(controller.addQuestion, {
      body: { text: "Q?", options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }] },
    });
    expect(status).toBe(400);
    expect(body.message).toContain("exactly one");
  });

  it("refuses an opening time after the closing time", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(draft());
    const { status } = await call(controller.update, { body: { opensAt: "2026-10-10T10:00:00Z", closesAt: "2026-10-10T09:00:00Z" } });
    expect(status).toBe(400);
  });
});

describe("publish", () => {
  it("publishes a sound draft, once", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(draft());
    mockPrisma.test.updateMany.mockResolvedValue({ count: 1 });
    const { status } = await call(controller.publish, {});
    expect(status).toBe(200);
    expect(mockPrisma.test.updateMany.mock.calls[0][0].where).toEqual({ id: 5, status: "draft" });
  });

  it("will not publish a test with a broken question, and lists the problems", async () => {
    const broken = { ...goodQuestion, options: [{ id: 1, text: "a", isCorrect: false, order: 1 }, { id: 2, text: "b", isCorrect: false, order: 2 }] };
    mockPrisma.test.findFirst.mockResolvedValue(draft({ questions: [broken] }));
    const { status, body } = await call(controller.publish, {});
    expect(status).toBe(400);
    expect(body.code).toBe("CANNOT_PUBLISH");
    expect(body.data.problems[0]).toMatch(/^Question 1:/);
    expect(mockPrisma.test.updateMany).not.toHaveBeenCalled();
  });

  it("will not publish an empty test", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(draft({ questions: [] }));
    expect((await call(controller.publish, {})).status).toBe(400);
  });
});

describe("delete and close", () => {
  it("keeps a test students have taken", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(draft({ status: "closed", _count: { attempts: 4 } }));
    const { status, body } = await call(controller.remove, {});
    expect(status).toBe(409);
    expect(body.code).toBe("TEST_HAS_ATTEMPTS");
    expect(mockPrisma.test.delete).not.toHaveBeenCalled();
  });

  it("closes only a published test", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(draft());
    expect((await call(controller.close, {})).status).toBe(409);
  });
});

export {};
