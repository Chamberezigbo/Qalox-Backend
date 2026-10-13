// The logins refuse a suspended school or admin up front, with a message, rather
// than issuing a token that then fails on every screen.
const mockPrisma: any = {
  staff: { findUnique: jest.fn() },
  student: { findFirst: jest.fn() },
  admin: { findUnique: jest.fn(), update: jest.fn() },
  school: { findUnique: jest.fn() },
};
jest.mock("../util/prisma", () => ({ __esModule: true, default: mockPrisma, ...mockPrisma }));
jest.mock("../util/logLoginEvent", () => ({ logLoginEvent: jest.fn() }));
jest.mock("../util/jwt", () => ({ signTeacherToken: jest.fn(() => "t"), signStudentToken: jest.fn(() => "s") }));
jest.mock("bcryptjs", () => ({ compare: jest.fn().mockResolvedValue(true) }));

import { TeacherAuthService } from "../Services/auth/TeacherAuthService";
import { StudentAuthService } from "../Services/auth/StudentAuthService";
/* eslint-disable @typescript-eslint/no-var-requires */
const { clearSchoolSuspensionCache } = require("../util/schoolSuspension");
const { loginAdmin } = require("../controller/admin/admin");

beforeEach(() => {
  jest.resetAllMocks();
  clearSchoolSuspensionCache();
  // resetAllMocks clears these implementations too, so they are set again here.
  (require("../util/jwt").signTeacherToken as jest.Mock).mockReturnValue("t");
  (require("../util/jwt").signStudentToken as jest.Mock).mockReturnValue("s");
  (require("bcryptjs").compare as jest.Mock).mockResolvedValue(true);
});

describe("teacher login", () => {
  const teacher = { id: 3, name: "T", schoolId: 7, campusId: null, duty: "teacher", registrationNumber: "R", school: {}, campus: null };

  it("signs in a teacher of an active school", async () => {
    mockPrisma.staff.findUnique.mockResolvedValue(teacher);
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: false });
    expect((await new TeacherAuthService().login({ registrationNumber: "R" } as any)).token).toBe("t");
  });

  it("refuses a teacher of a suspended school", async () => {
    mockPrisma.staff.findUnique.mockResolvedValue(teacher);
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: true });
    await expect(new TeacherAuthService().login({ registrationNumber: "R" } as any)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("student login", () => {
  const student = { id: 4, name: "S", schoolId: 7, status: "active", registrationNumber: "R", school: {}, campus: null, class: {} };

  it("refuses a student of a suspended school", async () => {
    mockPrisma.student.findFirst.mockResolvedValue(student);
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: true });
    await expect(new StudentAuthService().login("R")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a withdrawn student like an unknown number", async () => {
    mockPrisma.student.findFirst.mockResolvedValue({ ...student, status: "withdrawn" });
    await expect(new StudentAuthService().login("R")).rejects.toMatchObject({ message: "Invalid registration number" });
  });
});

describe("admin login", () => {
  const run = async (admin: object) => {
    mockPrisma.admin.findUnique.mockResolvedValue({ id: 5, email: "a@x.com", password: "h", role: "school_admin", schoolId: 7, hasLoggedIn: true, isSuspended: false, ...admin });
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await loginAdmin({ body: { email: "a@x.com", password: "p" } }, res, jest.fn());
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };

  it("refuses a suspended admin with a clear code", async () => {
    const { status, body } = await run({ isSuspended: true });
    expect(status).toBe(403);
    expect(body.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("refuses an admin of a suspended school", async () => {
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: true });
    const { status, body } = await run({});
    expect(status).toBe(403);
    expect(body.code).toBe("SCHOOL_SUSPENDED");
  });
});

export {};
