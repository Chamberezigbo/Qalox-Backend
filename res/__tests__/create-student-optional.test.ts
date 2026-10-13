// The admin form now treats guardian name/number, campus and lifestyle as
// optional. The form sends "" for anything left blank, which Joi used to reject
// for campusId, and a student with no campus used to be saved with none at all.
const mockPrisma: any = {
  school: { findUnique: jest.fn() },
  class: { findFirst: jest.fn() },
  student: { count: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  academicSession: { upsert: jest.fn(), findFirst: jest.fn() },
  admin: { findMany: jest.fn().mockResolvedValue([]) },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/studentFeeSync", () => ({ syncStudentFeeInvoices: jest.fn() }));
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn().mockResolvedValue(null) }));
jest.mock("../config/compress", () => jest.fn());
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));
jest.mock("../Models/generateUniqueIdentifier", () => ({ generateUniqueIdentifier: jest.fn().mockReturnValue("ABC-0001-STD") }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { studentSchema } = require("../schemas/adminSchemas");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStudent } = require("../controller/admin/StudentController");

const base = { surname: "Obi", name: "Ada", gender: "Female", dateOfBirth: "2012-05-01", session: "2026/2027", classId: "11" };

describe("studentSchema (the form's request body)", () => {
  it("accepts a student with no guardian, campus, group or lifestyle, as the form sends them", () => {
    const { error } = studentSchema.validate({
      ...base, guardianName: "", guardianNumber: "", guardianEmail: "", lifestyle: "", campusId: "", groupId: "", email: "", otherNames: "",
    });
    expect(error).toBeUndefined();
  });

  it("still requires the register's essentials", () => {
    for (const key of ["surname", "name", "gender", "dateOfBirth", "classId"]) {
      const { [key]: _omitted, ...rest } = base as any;
      expect(studentSchema.validate(rest).error?.message).toContain(key);
    }
  });
});

describe("createStudent", () => {
  const run = async (body: object) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await createStudent({ schoolId: 7, body, user: { id: 1 } }, res, next);
    return { res, next, status: res.status.mock.calls[0]?.[0] };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.school.findUnique.mockResolvedValue({ prefix: "ABC", name: "School" });
    mockPrisma.student.count.mockResolvedValue(0);
    mockPrisma.academicSession.upsert.mockResolvedValue({ id: 2 });
    mockPrisma.academicSession.findFirst.mockResolvedValue({ id: 2 });
    mockPrisma.student.create.mockResolvedValue({ id: 99, name: "Ada", surname: "Obi" });
  });

  it("gives a student registered without a campus the campus of their class", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: 11, campusId: 3, classGroups: [] });
    await run({ ...base, campusId: "", guardianName: "", guardianNumber: "", lifestyle: "" });

    const data = mockPrisma.student.create.mock.calls[0][0].data;
    expect(data.campusId).toBe(3);
    expect(data.guardianName).toBeNull();
    expect(data.guardianNumber).toBeNull();
    expect(data.lifestyle).toBeNull();
  });

  it("refuses a class from another school", async () => {
    mockPrisma.class.findFirst.mockResolvedValue(null);
    const { status } = await run({ ...base });
    expect(status).toBe(404);
    expect(mockPrisma.class.findFirst.mock.calls[0][0].where).toEqual({ id: 11, schoolId: 7 });
    expect(mockPrisma.student.create).not.toHaveBeenCalled();
  });
});

export {};
