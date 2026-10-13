// The controller maps the service's refusals to HTTP; everything else is covered
// by the end-to-end script (scripts/cbt-scratch-test.js) on a real database.
const mockService: any = {
  StudentTestError: class extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code: string) { super(message); this.status = status; this.code = code; }
  },
  listForStudent: jest.fn(), startAttempt: jest.fn(), getAttempt: jest.fn(), saveAnswer: jest.fn(), submitAttempt: jest.fn(),
};
jest.mock("../Services/student/StudentTestService", () => mockService);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require("../controller/student/StudentTestController");

const run = async (handler: any, req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ studentId: 4, schoolId: 7, params: {}, body: {}, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
};

beforeEach(() => jest.resetAllMocks());

describe("student test controller", () => {
  it("scopes every call to the signed-in student and school, never to ids in the request", async () => {
    mockService.startAttempt.mockResolvedValue({ attemptId: 1 });
    await run(controller.start, { params: { testId: "9" }, body: { studentId: 999, schoolId: 999 } });
    expect(mockService.startAttempt).toHaveBeenCalledWith(4, 7, "9");
  });

  it("passes the answer and question through", async () => {
    mockService.saveAnswer.mockResolvedValue({ saved: true });
    await run(controller.saveAnswer, { params: { attemptId: "3" }, body: { questionId: 5, optionId: 11 } });
    expect(mockService.saveAnswer).toHaveBeenCalledWith(4, 7, "3", { questionId: 5, optionId: 11 });
  });

  it("returns a refusal with its status and code", async () => {
    mockService.startAttempt.mockRejectedValue(new mockService.StudentTestError(403, "You have already taken this test.", "NO_ATTEMPTS_LEFT"));
    const { status, body } = await run(controller.start, { params: { testId: "9" } });
    expect(status).toBe(403);
    expect(body).toEqual({ success: false, message: "You have already taken this test.", code: "NO_ATTEMPTS_LEFT" });
  });

  it("sends an unexpected failure to the error middleware", async () => {
    mockService.listForStudent.mockRejectedValue(new Error("db"));
    const { next } = await run(controller.list, {});
    expect(next).toHaveBeenCalled();
  });
});

export {};
