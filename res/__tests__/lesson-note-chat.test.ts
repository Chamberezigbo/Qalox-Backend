// The chat bills per turn: reserve, call, settle. The properties worth locking in
// are the ones a mistake would hide: a failed turn must refund and leave no
// half-saved conversation, and one teacher must never reach another's chat.
const mockPrisma: any = {
  teacherAssignment: { findFirst: jest.fn() },
  lessonNoteChat: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  lessonNoteChatMessage: { findMany: jest.fn(), createMany: jest.fn(), count: jest.fn() },
  lessonNote: { findFirst: jest.fn(), update: jest.fn() },
  academicTerm: { findFirst: jest.fn() },
  schemeOfWork: { findFirst: jest.fn() },
  class: { findFirst: jest.fn() },
  subject: { findFirst: jest.fn() },
  aiGenerationJob: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);

jest.mock("../Services/AiCreditService", () => ({
  reserveCredits: jest.fn(),
  trueUpCredits: jest.fn(),
  refundCredits: jest.fn(),
  creditsForTokens: jest.fn(() => 5),
  estimateTokensFromText: jest.fn((t: string) => Math.ceil((t?.length ?? 0) / 4)),
}));
jest.mock("../Services/AiGenerationWorker", () => ({ processJob: jest.fn(() => Promise.resolve()) }));
jest.mock("../Services/GeminiTextService", () => {
  const actual = jest.requireActual("../Services/GeminiTextService");
  return { ...actual, chatTurn: jest.fn(), refineNote: jest.fn(), getModel: () => "test-model" };
});

import AiCreditService from "../Services/AiCreditService";
import AiGenerationWorker from "../Services/AiGenerationWorker";
import GeminiTextService from "../Services/GeminiTextService";
const controller = require("../controller/teacher/LessonNoteChatController");

const credits = AiCreditService as unknown as Record<string, jest.Mock>;
const gemini = GeminiTextService as unknown as Record<string, jest.Mock>;

const run = async (handler: any, req: any) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ staffId: 3, schoolId: 7, params: {}, body: {}, ...req }, res, next);
  return { res, next, status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

const CHAT = {
  id: 20, schoolId: 7, staffId: 3, classId: 11, subjectId: 12, academicTermId: 2, schemeOfWorkId: 5,
  topic: "Photosynthesis", weekRange: null, duration: null, status: "open", lessonNoteId: null,
  schemeOfWork: { extractedText: "Week 1: Photosynthesis" },
  class: { name: "SS2", customName: null }, subject: { name: "Biology" },
};
const TURN = { reply: "What method do you prefer?", readyToGenerate: false, usage: { inputTokens: 900, outputTokens: 40 } };

beforeEach(() => {
  jest.resetAllMocks();
  (AiGenerationWorker as any).processJob.mockResolvedValue(undefined);
  credits.reserveCredits.mockResolvedValue({ reserved: 5 });
  credits.trueUpCredits.mockResolvedValue({ charged: 2 });
  credits.refundCredits.mockResolvedValue(undefined);
  credits.creditsForTokens.mockReturnValue(5);
  credits.estimateTokensFromText.mockImplementation((t: string) => Math.ceil((t?.length ?? 0) / 4));
  mockPrisma.teacherAssignment.findFirst.mockResolvedValue({ id: 1 });
  mockPrisma.lessonNoteChat.count.mockResolvedValue(0);
  mockPrisma.academicTerm.findFirst.mockResolvedValue({ id: 2 });
  mockPrisma.schemeOfWork.findFirst.mockResolvedValue({ id: 5, extractedText: "Week 1: Photosynthesis", extractedTextStatus: "ready" });
  mockPrisma.class.findFirst.mockResolvedValue({ name: "SS2", customName: null });
  mockPrisma.subject.findFirst.mockResolvedValue({ name: "Biology" });
  mockPrisma.lessonNoteChat.findFirst.mockResolvedValue(CHAT);
});

describe("startChat", () => {
  const body = { classId: 11, subjectId: 12, topic: "Photosynthesis" };

  it("creates the chat only after the AI answers, hides the opening message, and bills the real usage", async () => {
    gemini.chatTurn.mockResolvedValue(TURN);
    mockPrisma.lessonNoteChat.create.mockImplementation(async ({ data }: any) => ({
      id: 20, status: "open",
      messages: data.messages.create.map((m: any, i: number) => ({ id: i + 1, createdAt: new Date(), ...m })),
    }));

    const { status, body: out } = await run(controller.startChat, { body });

    expect(status).toBe(201);
    expect(out.data.messages).toHaveLength(1);
    expect(out.data.messages[0]).toMatchObject({ role: "model", content: TURN.reply });
    expect(credits.trueUpCredits).toHaveBeenCalledWith(7, 5, TURN.usage);
    expect(gemini.chatTurn.mock.calls[0][0].history).toHaveLength(1);
  });

  it("refunds and saves nothing when the AI fails", async () => {
    gemini.chatTurn.mockRejectedValue(new Error("Gemini request failed: boom"));

    const { status, body: out } = await run(controller.startChat, { body });

    expect(status).toBe(502);
    expect(out.code).toBe("AI_FAILED");
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 5);
    expect(credits.trueUpCredits).not.toHaveBeenCalled();
    expect(mockPrisma.lessonNoteChat.create).not.toHaveBeenCalled();
  });

  it("refuses a class the teacher does not teach, before spending anything", async () => {
    mockPrisma.teacherAssignment.findFirst.mockResolvedValue(null);
    const { status } = await run(controller.startChat, { body });
    expect(status).toBe(403);
    expect(credits.reserveCredits).not.toHaveBeenCalled();
  });

  it("needs a scheme of work", async () => {
    mockPrisma.schemeOfWork.findFirst.mockResolvedValue(null);
    const { status, body: out } = await run(controller.startChat, { body });
    expect(status).toBe(404);
    expect(out.code).toBe("SCHEME_OF_WORK_NOT_FOUND");
  });

  it("stops at the daily chat limit", async () => {
    mockPrisma.lessonNoteChat.count.mockResolvedValue(20);
    expect((await run(controller.startChat, { body })).status).toBe(429);
  });

  it("surfaces 'not enough credits' as it is, without calling the AI", async () => {
    credits.reserveCredits.mockRejectedValue(Object.assign(new Error("Not enough AI credits"), { statusCode: 400 }));
    const { status, body: out } = await run(controller.startChat, { body });
    expect(status).toBe(400);
    expect(out.message).toContain("Not enough AI credits");
    expect(gemini.chatTurn).not.toHaveBeenCalled();
  });
});

describe("sendMessage", () => {
  const stored = [
    { role: "user", kind: "start", content: "opening" },
    { role: "model", kind: "chat", content: "What method?" },
  ];
  beforeEach(() => mockPrisma.lessonNoteChatMessage.findMany.mockResolvedValue(stored));

  it("sends the whole conversation with the new message last, and saves the pair on success", async () => {
    gemini.chatTurn.mockResolvedValue({ ...TURN, readyToGenerate: true });

    const { status, body } = await run(controller.sendMessage, { params: { id: "20" }, body: { message: "  group work  " } });

    expect(status).toBe(200);
    expect(body.data.readyToGenerate).toBe(true);
    const history = gemini.chatTurn.mock.calls[0][0].history;
    expect(history.map((m: any) => m.role)).toEqual(["user", "model", "user"]);
    expect(history[2].content).toBe("group work");
    const saved = mockPrisma.lessonNoteChatMessage.createMany.mock.calls[0][0].data;
    expect(saved.map((m: any) => m.role)).toEqual(["user", "model"]);
  });

  it("saves nothing and refunds when the AI fails", async () => {
    gemini.chatTurn.mockRejectedValue(new Error("down"));
    const { status } = await run(controller.sendMessage, { params: { id: "20" }, body: { message: "hello" } });
    expect(status).toBe(502);
    expect(credits.refundCredits).toHaveBeenCalled();
    expect(mockPrisma.lessonNoteChatMessage.createMany).not.toHaveBeenCalled();
  });

  it("cannot reach another teacher's chat", async () => {
    mockPrisma.lessonNoteChat.findFirst.mockResolvedValue(null);
    const { status } = await run(controller.sendMessage, { params: { id: "20" }, body: { message: "hi" } });
    expect(status).toBe(404);
    expect(mockPrisma.lessonNoteChat.findFirst.mock.calls[0][0].where).toMatchObject({ staffId: 3, schoolId: 7 });
  });

  it.each(["generated", "generating"])("refuses to chat once the chat is %s", async (state) => {
    mockPrisma.lessonNoteChat.findFirst.mockResolvedValue({ ...CHAT, status: state });
    expect((await run(controller.sendMessage, { params: { id: "20" }, body: { message: "hi" } })).status).toBe(409);
    expect(credits.reserveCredits).not.toHaveBeenCalled();
  });

  it("stops at the message limit", async () => {
    mockPrisma.lessonNoteChatMessage.findMany.mockResolvedValue(
      Array.from({ length: controller.MAX_CHAT_MESSAGES }, () => ({ role: "user", kind: "chat", content: "x" }))
    );
    expect((await run(controller.sendMessage, { params: { id: "20" }, body: { message: "hi" } })).status).toBe(429);
  });

  it.each(["", "   ", "x".repeat(1001)])("rejects a bad message", async (message) => {
    expect((await run(controller.sendMessage, { params: { id: "20" }, body: { message } })).status).toBe(400);
  });
});

describe("generateFromChat", () => {
  beforeEach(() => {
    mockPrisma.aiGenerationJob.findFirst.mockResolvedValue(null);
    mockPrisma.aiGenerationJob.count.mockResolvedValue(0);
    mockPrisma.lessonNoteChatMessage.findMany.mockResolvedValue([{ role: "user", kind: "chat", content: "use market examples" }]);
    mockPrisma.aiGenerationJob.create.mockResolvedValue({ id: "aig_1" });
  });

  it("creates a job that carries the chat, and marks the chat generating", async () => {
    const { status, body } = await run(controller.generateFromChat, { params: { id: "20" } });

    expect(status).toBe(202);
    expect(body.data.jobId).toBe("aig_1");
    const data = mockPrisma.aiGenerationJob.create.mock.calls[0][0].data;
    expect(JSON.parse(data.inputParamsJson).chatId).toBe(20);
    expect(mockPrisma.lessonNoteChat.update).toHaveBeenCalledWith({ where: { id: 20 }, data: { status: "generating" } });
  });

  it("refunds the reservation if the job cannot be created", async () => {
    mockPrisma.aiGenerationJob.create.mockRejectedValue(new Error("db"));
    const { next } = await run(controller.generateFromChat, { params: { id: "20" } });
    expect(credits.refundCredits).toHaveBeenCalledWith(7, 5);
    expect(next).toHaveBeenCalled();
  });

  it("will not start a second generation", async () => {
    mockPrisma.aiGenerationJob.findFirst.mockResolvedValue({ id: "aig_busy" });
    const { status, body } = await run(controller.generateFromChat, { params: { id: "20" } });
    expect(status).toBe(409);
    expect(body.data.jobId).toBe("aig_busy");
    expect(credits.reserveCredits).not.toHaveBeenCalled();
  });

  it("does not generate twice from one chat", async () => {
    mockPrisma.lessonNoteChat.findFirst.mockResolvedValue({ ...CHAT, status: "generated", lessonNoteId: 99 });
    expect((await run(controller.generateFromChat, { params: { id: "20" } })).status).toBe(409);
  });
});

describe("refineNote", () => {
  const generated = { ...CHAT, status: "generated", lessonNoteId: 99 };
  const note = { id: 99, title: "T", content: "## Objectives", objectivesJson: '["a"]', source: "ai_generated" };

  beforeEach(() => {
    mockPrisma.lessonNoteChat.findFirst.mockResolvedValue(generated);
    mockPrisma.lessonNote.findFirst.mockResolvedValue(note);
    mockPrisma.lessonNoteChatMessage.count.mockResolvedValue(0);
    mockPrisma.lessonNote.update.mockImplementation(async ({ data }: any) => ({ ...note, ...data }));
  });

  it("applies the revision to the saved note without marking it hand-edited", async () => {
    gemini.refineNote.mockResolvedValue({
      parsed: { title: "T2", objectives: ["b"], content: "revised" },
      usage: { inputTokens: 2000, outputTokens: 900 },
    });

    const { status, body } = await run(controller.refineNote, { params: { id: "20" }, body: { instruction: "shorter" } });

    expect(status).toBe(200);
    expect(body.data.note.content).toBe("revised");
    expect(mockPrisma.lessonNote.update.mock.calls[0][0].data).not.toHaveProperty("source");
    expect(gemini.refineNote.mock.calls[0][0].note).toEqual({ title: "T", objectives: ["a"], content: "## Objectives" });
  });

  it("leaves the note untouched and refunds when the AI fails", async () => {
    gemini.refineNote.mockRejectedValue(new Error("down"));
    const { status } = await run(controller.refineNote, { params: { id: "20" }, body: { instruction: "shorter" } });
    expect(status).toBe(502);
    expect(mockPrisma.lessonNote.update).not.toHaveBeenCalled();
    expect(credits.refundCredits).toHaveBeenCalled();
  });

  it("needs the note to be written first", async () => {
    mockPrisma.lessonNoteChat.findFirst.mockResolvedValue(CHAT);
    expect((await run(controller.refineNote, { params: { id: "20" }, body: { instruction: "x" } })).status).toBe(409);
  });

  it("stops at the refinement limit", async () => {
    mockPrisma.lessonNoteChatMessage.count.mockResolvedValue(controller.MAX_REFINEMENTS);
    expect((await run(controller.refineNote, { params: { id: "20" }, body: { instruction: "x" } })).status).toBe(429);
  });
});
