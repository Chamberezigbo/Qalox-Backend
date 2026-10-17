// What a campus-restricted sub-admin's requests actually ask the database for.
// The scope helpers are tested in campus-scope.test.ts; this checks the controllers
// apply them, and that an admin with no restriction (a head admin, an "all campuses"
// sub-admin, any school with no campuses) gets queries without a campus filter.
/* eslint-disable @typescript-eslint/no-var-requires */
const mockPrisma: any = {
  student: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  staff: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  subject: { findFirst: jest.fn(), findMany: jest.fn() },
  class: { findFirst: jest.fn(), findMany: jest.fn() },
  campus: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  studentFee: { findFirst: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
  broadcast: { findMany: jest.fn(), count: jest.fn() },
  schemeOfWork: { findMany: jest.fn() },
  examSchedule: { findFirst: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));
jest.mock("../util/studentFeeSync", () => ({ syncStudentFeeInvoices: jest.fn() }));
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn() }));
jest.mock("../config/compress", () => jest.fn());
jest.mock("../Models/generateUniqueIdentifier", () => ({ generateUniqueIdentifier: jest.fn() }));
jest.mock("../controller/public/publicController", () => ({ schoolMediaUrl: jest.fn() }));
jest.mock("../Services/FlutterwaveService", () => ({}));
jest.mock("../Services/EmailService", () => ({ sendEmail: jest.fn() }));
jest.mock("../Services/BulkSmsService", () => ({ sendSms: jest.fn() }));
jest.mock("../util/getSmsQuotaForSchool", () => ({ getSmsQuotaForSchool: jest.fn() }));

const students = require("../controller/admin/StudentController");
const staff = require("../controller/admin/StaffController");
const subjects = require("../controller/admin/SubjectController");
const classes = require("../controller/admin/ClassController");
const fees = require("../controller/admin/FeeManagementController");
const notices = require("../controller/admin/NoticeController");
const campuses = require("../controller/admin/campusController");

const SCOPE = [1, 2];
const restricted = (extra: object = {}) => ({ schoolId: 7, campusIds: SCOPE, user: { id: 9 }, query: {}, params: {}, body: {}, ...extra });
const unrestricted = (extra: object = {}) => ({ schoolId: 7, campusIds: null, user: { id: 9 }, query: {}, params: {}, body: {}, ...extra });

const call = async (handler: any, req: any) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler(req, res, next);
  return { res, next, status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] };
};

const json = (value: unknown) => JSON.stringify(value);

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.student.findMany.mockResolvedValue([]);
  mockPrisma.student.count.mockResolvedValue(0);
  mockPrisma.staff.findMany.mockResolvedValue([]);
  mockPrisma.staff.count.mockResolvedValue(0);
  mockPrisma.subject.findMany.mockResolvedValue([]);
  mockPrisma.class.findMany.mockResolvedValue([]);
  mockPrisma.campus.findMany.mockResolvedValue([]);
  mockPrisma.campus.count.mockResolvedValue(0);
  mockPrisma.studentFee.aggregate.mockResolvedValue({ _sum: { totalFee: 0, amountPaid: 0 } });
  mockPrisma.studentFee.count.mockResolvedValue(0);
  mockPrisma.broadcast.findMany.mockResolvedValue([]);
  mockPrisma.broadcast.count.mockResolvedValue(0);
});

describe("students", () => {
  it("lists and counts only the admin's campuses", async () => {
    await call(students.getStudentDetails, restricted());
    expect(json(mockPrisma.student.findMany.mock.calls[0][0].where)).toContain('"in":[1,2]');
    expect(json(mockPrisma.student.count.mock.calls[0][0].where)).toContain('"in":[1,2]');
  });

  it("refuses a campus filter that is not theirs, instead of widening", async () => {
    const { error } = await call(students.getStudentDetails, restricted({ query: { campusId: "3" } }));
    expect(error?.statusCode).toBe(403);
    expect(mockPrisma.student.findMany).not.toHaveBeenCalled();
  });

  it("adds no campus filter for an unrestricted admin", async () => {
    await call(students.getStudentDetails, unrestricted());
    expect(json(mockPrisma.student.findMany.mock.calls[0][0].where)).not.toContain('"in"');
  });

  it("reads another campus's student as not found", async () => {
    mockPrisma.student.findFirst.mockResolvedValue(null);
    const { res } = await call(students.getSingleStudent, restricted({ params: { id: "5" } }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(json(mockPrisma.student.findFirst.mock.calls[0][0].where)).toContain('"in":[1,2]');
    expect(json(mockPrisma.student.findFirst.mock.calls[0][0].where)).toContain('"schoolId":7');
  });

  it("looks a student up within the school even for a head admin", async () => {
    mockPrisma.student.findFirst.mockResolvedValue(null);
    await call(students.getSingleStudent, unrestricted({ params: { id: "5" } }));
    expect(json(mockPrisma.student.findFirst.mock.calls[0][0].where)).toContain('"schoolId":7');
  });

  it("will not delete a student on another campus", async () => {
    mockPrisma.student.findFirst.mockResolvedValue(null);
    const { error } = await call(students.deleteStudent, restricted({ params: { id: "5" }, body: { confirmDeletion: true } }));
    expect(error?.statusCode).toBe(404);
  });
});

describe("staff", () => {
  it("lists staff of their campuses and school-wide staff, never another campus", async () => {
    await call(staff.getAllStaff, restricted());
    const where = json(mockPrisma.staff.findMany.mock.calls[0][0].where);
    expect(where).toContain('"campusId":null');
    expect(where).toContain('"in":[1,2]');
  });

  it("refuses to filter by another campus", async () => {
    const { error } = await call(staff.getAllStaff, restricted({ query: { campusId: "4" } }));
    expect(error?.statusCode).toBe(403);
  });

  it("reads a staff member on another campus as not found", async () => {
    mockPrisma.staff.findFirst.mockResolvedValue(null);
    const { res } = await call(staff.getStaffDetails, restricted({ params: { staffId: "3" } }));
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("will not create staff on a campus that is not theirs", async () => {
    const { error } = await call(staff.createStaff, restricted({ body: { name: "A", duty: "Teacher", campusId: 5 } }));
    expect(error?.statusCode).toBe(403);
  });
});

describe("classes and subjects", () => {
  it("lists only classes of their campuses (and school-wide ones)", async () => {
    await call(classes.getAllClasses, restricted());
    const where = json(mockPrisma.class.findMany.mock.calls[0][0].where);
    expect(where).toContain('"in":[1,2]');
    expect(where).toContain('"campusId":null');
  });

  it("will not let a restricted admin create a class with no campus", async () => {
    const { res } = await call(classes.createClass, restricted({ body: { name: "JSS 1" } }));
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("will not let a restricted admin create a class on someone else's campus", async () => {
    const { error } = await call(classes.createClass, restricted({ body: { name: "JSS 1", campusId: 9 } }));
    expect(error?.statusCode).toBe(403);
  });

  it("lists only subjects of their campuses", async () => {
    await call(subjects.getAllSubjects, restricted());
    expect(json(mockPrisma.subject.findMany.mock.calls[0][0].where)).toContain('"in":[1,2]');
  });

  it("adds no filter for an unrestricted admin", async () => {
    await call(subjects.getAllSubjects, unrestricted());
    expect(json(mockPrisma.subject.findMany.mock.calls[0][0].where)).not.toContain('"in"');
  });
});

describe("fees", () => {
  it("counts and totals only their campuses' students, so the debt summary never includes another campus", async () => {
    await call(fees.getDebtSummary, restricted());
    expect(mockPrisma.studentFee.aggregate).toHaveBeenCalledTimes(1);
    expect(json(mockPrisma.studentFee.aggregate.mock.calls[0][0].where)).toContain('"in":[1,2]');
    for (const [arg] of mockPrisma.studentFee.count.mock.calls) {
      expect(json(arg.where)).toContain('"in":[1,2]');
    }
  });

  it("is school-wide for an unrestricted admin", async () => {
    await call(fees.getDebtSummary, unrestricted());
    expect(json(mockPrisma.studentFee.aggregate.mock.calls[0][0].where)).toBe('{"schoolId":7}');
  });

  it("reads another campus's receipt as not found", async () => {
    mockPrisma.studentFee.findFirst.mockResolvedValue(null);
    const { error } = await call(fees.getReceipt, restricted({ params: { studentFeeId: "4" } }));
    expect(error?.statusCode).toBe(404);
  });

  it("keeps the school's bank accounts for the head admin", async () => {
    for (const handler of [fees.createBankAccount, fees.updateBankAccount, fees.deleteBankAccount]) {
      const { res } = await call(handler, restricted({ params: { id: "1" } }));
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });
});

describe("notices", () => {
  it("shows a restricted admin only the notices they sent", async () => {
    await call(notices.getBroadcasts, restricted());
    expect(mockPrisma.broadcast.findMany.mock.calls[0][0].where).toEqual({ schoolId: 7, createdByAdminId: 9 });
  });

  it("shows the head admin every notice", async () => {
    await call(notices.getBroadcasts, unrestricted());
    expect(mockPrisma.broadcast.findMany.mock.calls[0][0].where).toEqual({ schoolId: 7 });
  });
});

describe("campuses", () => {
  it("lists only their campuses", async () => {
    await call(campuses.getCampuses, restricted());
    expect(mockPrisma.campus.findMany.mock.calls[0][0].where.id).toEqual({ in: SCOPE });
  });

  it("will not let them add a campus", async () => {
    const { res } = await call(campuses.createCampus, restricted({ body: { name: "North" } }));
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("reads a campus that is not theirs as not found when editing it", async () => {
    mockPrisma.campus.findFirst.mockResolvedValue(null);
    const { res } = await call(campuses.updateCampus, restricted({ params: { campusId: "8" }, body: { name: "x" } }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockPrisma.campus.findFirst.mock.calls[0][0].where.id).toEqual({ in: [] });
  });
});

export {};
