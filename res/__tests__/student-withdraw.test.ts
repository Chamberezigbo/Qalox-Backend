// A real student who leaves must keep their results and payments. Withdrawing
// hides them from the day-to-day lists instead of deleting them.
const mockPrisma: any = { student: { updateMany: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/studentFeeSync", () => ({ syncStudentFeeInvoices: jest.fn() }));
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn() }));
jest.mock("../config/compress", () => jest.fn());
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));
jest.mock("../Models/generateUniqueIdentifier", () => ({ generateUniqueIdentifier: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withdrawStudent, restoreStudent, getStudentDetails } = require("../controller/admin/StudentController");

const call = async (handler: any, req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ schoolId: 7, params: { id: "5" }, body: {}, query: {}, user: { id: 1 }, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
};

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.student.updateMany.mockResolvedValue({ count: 1 });
});

describe("withdrawStudent / restoreStudent", () => {
  it("withdraws an active student of this school, with a reason and a date", async () => {
    const { status, body } = await call(withdrawStudent, { body: { reason: "  Moved abroad  " } });

    expect(status).toBe(200);
    expect(body.data).toEqual({ studentId: 5, status: "withdrawn" });
    const arg = mockPrisma.student.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 5, schoolId: 7, status: "active" });
    expect(arg.data).toMatchObject({ status: "withdrawn", withdrawnReason: "Moved abroad" });
    expect(arg.data.withdrawnAt).toBeInstanceOf(Date);
  });

  it("restores a withdrawn student and clears the date and reason", async () => {
    await call(restoreStudent, {});
    const arg = mockPrisma.student.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 5, schoolId: 7, status: "withdrawn" });
    expect(arg.data).toEqual({ status: "active", withdrawnAt: null, withdrawnReason: null });
  });

  it("reads another school's student as not found", async () => {
    mockPrisma.student.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.student.findFirst.mockResolvedValue(null);
    const { status } = await call(withdrawStudent, {});
    expect(status).toBe(404);
  });

  it("treats withdrawing an already-withdrawn student as done, not as an error", async () => {
    mockPrisma.student.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.student.findFirst.mockResolvedValue({ status: "withdrawn" });
    const { status } = await call(withdrawStudent, {});
    expect(status).toBe(200);
  });
});

describe("the admin student list", () => {
  beforeEach(() => {
    mockPrisma.student.findMany.mockResolvedValue([]);
    mockPrisma.student.count.mockResolvedValue(0);
  });

  it("hides withdrawn students by default", async () => {
    await call(getStudentDetails, {});
    expect(mockPrisma.student.findMany.mock.calls[0][0].where).toMatchObject({ schoolId: 7, status: "active" });
  });

  it("shows only withdrawn students when asked", async () => {
    await call(getStudentDetails, { query: { status: "withdrawn" } });
    expect(mockPrisma.student.findMany.mock.calls[0][0].where).toMatchObject({ status: "withdrawn" });
  });
});

export {};
