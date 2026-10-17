// Editing a student bulk-uploaded without a campus failed: the form sends every
// field, blank ones as "", and a blank campusId went to Prisma as an invalid Int.
const mockPrisma: any = {
  student: { findFirst: jest.fn(), update: jest.fn() },
  class: { findFirst: jest.fn() },
  campus: { findFirst: jest.fn() },
  classGroup: { findFirst: jest.fn() },
  academicSession: { upsert: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/studentFeeSync", () => ({ syncStudentFeeInvoices: jest.fn() }));
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn() }));
jest.mock("../config/compress", () => jest.fn());
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));
// Whether a group's results are already with the admin is the workflow's business,
// and is tested there; here an edit is allowed unless a test says otherwise.
jest.mock("../util/resultScope", () => ({ groupChangeBlockedReason: jest.fn() }));
jest.mock("../Models/generateUniqueIdentifier", () => ({ generateUniqueIdentifier: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { updateStudent } = require("../controller/admin/StudentController");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncStudentFeeInvoices } = require("../util/studentFeeSync");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const blockedReason = require("../util/resultScope").groupChangeBlockedReason;

const STUDENT = { id: 5, schoolId: 7, classId: 11, campusId: null, registrationNumber: "REG/1" };

const run = async (body: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await updateStudent({ params: { id: "5" }, schoolId: 7, body }, res, next);
  return { res, next, status: res.status.mock.calls[0]?.[0], out: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.student.findFirst.mockResolvedValue(STUDENT);
  // The form always names a class; here it is the student's own, in this school.
  mockPrisma.class.findFirst.mockResolvedValue({ id: 11, campusId: null });
  mockPrisma.student.update.mockImplementation(async ({ data }: any) => ({ ...STUDENT, ...data }));
  blockedReason.mockResolvedValue(null);
});

describe("updateStudent", () => {
  it("saves a new phone number for a student with no campus, with the blank fields as nulls", async () => {
    const { status } = await run({
      name: "Ada", surname: "Obi", otherNames: "", gender: "Female", email: "", session: "",
      guardianNumber: "08012345678", guardianName: "", lifestyle: "", campusId: "", classId: "11",
    });

    expect(status).toBe(200);
    const data = mockPrisma.student.update.mock.calls[0][0].data;
    expect(data.guardianNumber).toBe("08012345678");
    expect(data).not.toHaveProperty("campusId", "");
    expect(data.email).toBeNull();
  });

  it("only finds a student in the admin's own school", async () => {
    await run({ name: "Ada" });
    expect(mockPrisma.student.findFirst.mock.calls[0][0].where).toEqual({ id: 5, schoolId: 7 });
  });

  it("reads another school's student as not found, and writes nothing", async () => {
    mockPrisma.student.findFirst.mockResolvedValue(null);
    const { status } = await run({ name: "Ada" });
    expect(status).toBe(404);
    expect(mockPrisma.student.update).not.toHaveBeenCalled();
  });

  it("refuses a class from another school", async () => {
    mockPrisma.class.findFirst.mockResolvedValue(null);
    const { status } = await run({ classId: "99" });
    expect(status).toBe(404);
    expect(mockPrisma.class.findFirst.mock.calls[0][0].where).toEqual({ id: 99, schoolId: 7 });
  });

  it("gives a student with no campus the campus of their class", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: 11, campusId: 3 });
    await run({ classId: "11" });
    expect(mockPrisma.student.update.mock.calls[0][0].data.campusId).toBe(3);
  });

  it("clears the group and invoices the new class when the class changes", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: 12, campusId: null });
    await run({ classId: "12" });
    expect(mockPrisma.student.update.mock.calls[0][0].data).toMatchObject({ classId: 12, classGroupId: null });
    expect(syncStudentFeeInvoices).toHaveBeenCalledWith(mockPrisma, { id: 5, schoolId: 7, classId: 12 });
  });

  it("does not let the request change the school or the registration number", async () => {
    await run({ name: "Ada", schoolId: 99, registrationNumber: "HACK" });
    const data = mockPrisma.student.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("schoolId");
    expect(data).not.toHaveProperty("registrationNumber");
  });
});

export {}; // makes this a module, so its top-level names stay out of the global scope

describe("updateStudent — a student whose group's results are with the admin", () => {
  it("cannot change class, and nothing is saved", async () => {
    blockedReason.mockResolvedValue("This student's class results have already been sent to the admin for this term.");
    mockPrisma.class.findFirst.mockResolvedValue({ id: 99, campusId: null });

    const { status, out } = await run({ classId: 99 });

    expect(status).toBe(409);
    expect(out.message).toContain("sent to the admin");
    expect(mockPrisma.student.update).not.toHaveBeenCalled();
  });

  it("can still have other details edited", async () => {
    blockedReason.mockResolvedValue("blocked");

    const { status } = await run({ phoneNumber: "08011111111" });

    expect(status).toBe(200);
    expect(mockPrisma.student.update).toHaveBeenCalled();
  });
});
