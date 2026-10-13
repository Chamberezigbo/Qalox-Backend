// The promotion endpoints write to many students at once, so the guards in front
// of the service matter: confirmation is required, ids are validated, and the
// service's own refusals reach the client with their status.
const mockService = {
  getPolicy: jest.fn(),
  savePolicy: jest.fn(),
  previewClass: jest.fn(),
  applyPromotion: jest.fn(),
  undoRun: jest.fn(),
  listRuns: jest.fn(),
};
jest.mock("../Services/PromotionService", () => mockService);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require("../controller/admin/PromotionController");

const call = async (handler: any, req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ schoolId: 7, user: { id: 1 }, query: {}, body: {}, params: {}, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
};

beforeEach(() => jest.resetAllMocks());

describe("apply", () => {
  const good = {
    classId: "3", fromSessionId: "1", toSessionId: "2", confirm: true,
    decisions: [{ studentId: "10", outcome: "promoted" }],
  };

  it("applies once confirmed, with ids as numbers and the admin recorded", async () => {
    mockService.applyPromotion.mockResolvedValue({ runId: 5, studentCount: 1, counts: { promoted: 1 } });
    const { status } = await call(controller.apply, { body: good });
    expect(status).toBe(200);
    expect(mockService.applyPromotion).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 7, adminId: 1, classId: 3, fromSessionId: 1, toSessionId: 2 })
    );
    expect(mockService.applyPromotion.mock.calls[0][0].decisions[0].studentId).toBe(10);
  });

  it("refuses without confirm: true, before touching anything", async () => {
    const { status, body } = await call(controller.apply, { body: { ...good, confirm: undefined } });
    expect(status).toBe(400);
    expect(body.code).toBe("NOT_CONFIRMED");
    expect(mockService.applyPromotion).not.toHaveBeenCalled();
  });

  it.each([{ classId: "abc" }, { fromSessionId: "0" }, { toSessionId: undefined }])("refuses bad ids %j", async (patch) => {
    const { status } = await call(controller.apply, { body: { ...good, ...patch } });
    expect(status).toBe(400);
    expect(mockService.applyPromotion).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on with its own status and message", async () => {
    mockService.applyPromotion.mockRejectedValue(Object.assign(new Error("2 students still need a decision"), { statusCode: 400 }));
    const { status, body } = await call(controller.apply, { body: good });
    expect(status).toBe(400);
    expect(body.message).toContain("still need a decision");
  });

  it("sends an unexpected failure to the error middleware", async () => {
    mockService.applyPromotion.mockRejectedValue(new Error("db down"));
    const { next } = await call(controller.apply, { body: good });
    expect(next).toHaveBeenCalled();
  });
});

describe("preview and undo", () => {
  it("needs a class and a session to preview", async () => {
    expect((await call(controller.preview, { query: { classId: "3" } })).status).toBe(400);
    mockService.previewClass.mockResolvedValue({});
    expect((await call(controller.preview, { query: { classId: "3", fromSessionId: "1" } })).status).toBe(200);
  });

  it("undoes the named run for this school", async () => {
    mockService.undoRun.mockResolvedValue({ runId: 9, restored: 4 });
    await call(controller.undo, { params: { id: "9" } });
    expect(mockService.undoRun).toHaveBeenCalledWith({ schoolId: 7, runId: 9 });
  });
});

describe("savePolicy", () => {
  it("turns a blank trial margin into null (trial switched off)", async () => {
    mockService.savePolicy.mockResolvedValue({ basis: "all_terms", trialMargin: null });
    await call(controller.savePolicy, { body: { basis: "all_terms", trialMargin: "" } });
    expect(mockService.savePolicy).toHaveBeenCalledWith(7, { basis: "all_terms", trialMargin: null });
  });
});

export {};
