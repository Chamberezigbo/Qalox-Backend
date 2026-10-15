// Reopening a closed test and moving a published test's closing time. The
// questions and rules stay locked; attempts already recorded are never touched.
const mockPrisma: any = {
  test: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../Services/AiCreditService", () => ({}));
jest.mock("../Services/AiGenerationWorker", () => ({ processJob: jest.fn() }));
jest.mock("../Services/GeminiTextService", () => ({}));
jest.mock("../Services/student/StudentTestService", () => ({ settleExpiredForTest: jest.fn().mockResolvedValue(0) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { hasEnded, validateNewClosingTime, planReopen } = require("../util/testSchedule");
const { settleExpiredForTest } = require("../Services/student/StudentTestService");
const controller = require("../controller/teacher/TestController");

const now = new Date("2026-10-15T12:00:00Z");
const past = "2026-10-14T12:00:00Z";
const future = "2026-10-20T12:00:00Z";

describe("hasEnded", () => {
  it("is true for a closed test and for a published one past its closing time", () => {
    expect(hasEnded({ status: "closed", closesAt: null }, now)).toBe(true);
    expect(hasEnded({ status: "published", closesAt: past }, now)).toBe(true);
  });
  it("is false for an open one and for a draft", () => {
    expect(hasEnded({ status: "published", closesAt: future }, now)).toBe(false);
    expect(hasEnded({ status: "published", closesAt: null }, now)).toBe(false);
    expect(hasEnded({ status: "draft", closesAt: past }, now)).toBe(false);
  });
});

describe("validateNewClosingTime", () => {
  it("accepts a future time after the opening time", () => {
    const r = validateNewClosingTime({ now, opensAt: past, requested: future });
    expect(r.ok).toBe(true);
    expect(r.closesAt.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });
  it.each([
    [undefined, "Choose"],
    [null, "Choose"],
    ["not a date", "valid date"],
    [past, "future"],
  ])("refuses %j", (requested, text) => {
    const r = validateNewClosingTime({ now, opensAt: null, requested });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(text);
  });
  it("refuses a closing time before the test opens", () => {
    const r = validateNewClosingTime({ now, opensAt: "2026-10-25T00:00:00Z", requested: future });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("after the opening time");
  });
});

describe("planReopen", () => {
  it("reopens a manually closed test with no new time when the old one is still ahead", () => {
    expect(planReopen({ test: { status: "closed", closesAt: future }, now, requested: undefined })).toEqual({ ok: true, closesAt: undefined });
    expect(planReopen({ test: { status: "closed", closesAt: null }, now, requested: undefined })).toEqual({ ok: true, closesAt: undefined });
  });
  it("needs a new time when the old one has passed, or it would close again at once", () => {
    const r = planReopen({ test: { status: "closed", closesAt: past }, now, requested: undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("new closing time");
  });
  it("uses a given time, and checks it", () => {
    expect(planReopen({ test: { status: "closed", closesAt: past }, now, requested: future }).ok).toBe(true);
    expect(planReopen({ test: { status: "closed", closesAt: past }, now, requested: past }).ok).toBe(false);
  });
  it("refuses a test that is still open", () => {
    expect(planReopen({ test: { status: "published", closesAt: future }, now, requested: future }).ok).toBe(false);
  });
});

const call = async (handler: any, req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handler({ staffId: 3, schoolId: 7, params: { id: "5" }, body: {}, ...req }, res, jest.fn());
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

describe("reopen (controller)", () => {
  const FUTURE = new Date(Date.now() + 5 * 86400_000).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.test.update.mockImplementation(async ({ data }: any) => ({ closesAt: data.closesAt ?? null }));
  });

  it("settles running attempts first, then publishes with the new time", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "closed", opensAt: null, closesAt: null });
    const { status, body } = await call(controller.reopen, { body: { closesAt: FUTURE } });

    expect(status).toBe(200);
    expect(body.data.status).toBe("published");
    expect(settleExpiredForTest).toHaveBeenCalledWith(5, 7);
    expect(mockPrisma.test.update.mock.calls[0][0].data).toMatchObject({ status: "published" });
    expect(mockPrisma.test.update.mock.calls[0][0].data.closesAt.toISOString()).toBe(FUTURE);
  });

  it("only changes the status when no new time was given and none is needed", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "closed", opensAt: null, closesAt: null });
    await call(controller.reopen, {});
    expect(mockPrisma.test.update.mock.calls[0][0].data).toEqual({ status: "published" });
  });

  it("refuses without a time when the old one has passed, changing nothing", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "closed", opensAt: null, closesAt: new Date(past) });
    const { status } = await call(controller.reopen, {});
    expect(status).toBe(400);
    expect(mockPrisma.test.update).not.toHaveBeenCalled();
    expect(settleExpiredForTest).not.toHaveBeenCalled();
  });

  it("is a conflict for a test that is still open, and a draft is not reopened", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "published", opensAt: null, closesAt: new Date(FUTURE) });
    expect((await call(controller.reopen, { body: { closesAt: FUTURE } })).status).toBe(409);
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "draft", opensAt: null, closesAt: null });
    expect((await call(controller.reopen, { body: { closesAt: FUTURE } })).status).toBe(409);
    expect(mockPrisma.test.update).not.toHaveBeenCalled();
  });

  it("is not found for another teacher's test", async () => {
    mockPrisma.test.findFirst.mockResolvedValue(null);
    expect((await call(controller.reopen, {})).status).toBe(404);
  });
});

describe("changing the closing time of a published test", () => {
  const FUTURE = new Date(Date.now() + 5 * 86400_000).toISOString();
  beforeEach(() => jest.clearAllMocks());

  it("moves the closing time and nothing else", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "published", opensAt: null, closesAt: new Date(past) });
    const { status } = await call(controller.update, { body: { closesAt: FUTURE } });
    expect(status).toBe(200);
    expect(Object.keys(mockPrisma.test.update.mock.calls[0][0].data)).toEqual(["closesAt"]);
  });

  it("will not take any other setting once published", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "published", opensAt: null, closesAt: null });
    expect((await call(controller.update, { body: { closesAt: FUTURE, durationMinutes: 5 } })).status).toBe(409);
    expect((await call(controller.update, { body: { maxAttempts: 5 } })).status).toBe(409);
    expect(mockPrisma.test.update).not.toHaveBeenCalled();
  });

  it("refuses a time in the past", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "published", opensAt: null, closesAt: null });
    expect((await call(controller.update, { body: { closesAt: past } })).status).toBe(400);
  });

  it("tells a teacher a closed test must be reopened", async () => {
    mockPrisma.test.findFirst.mockResolvedValue({ id: 5, status: "closed", opensAt: null, closesAt: null });
    const { status, body } = await call(controller.update, { body: { closesAt: FUTURE } });
    expect(status).toBe(409);
    expect(body.message).toContain("Reopen");
  });
});

export {};
