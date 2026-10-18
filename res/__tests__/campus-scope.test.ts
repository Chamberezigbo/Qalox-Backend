// A restricted sub-admin may work only in their campuses. Records with no campus are
// school-wide and stay visible; everyone else (head admins, unrestricted sub-admins,
// every admin of a school with no campuses) gets no filter at all.
/* eslint-disable @typescript-eslint/no-var-requires */
const scope = require("../util/campusScope");

const restricted = (ids: number[], schoolId = 7) => ({ schoolId, campusIds: ids });
const open = (schoolId = 7) => ({ schoolId, campusIds: null });

describe("who is restricted", () => {
  it("only a sub-admin marked 'not all campuses'", () => {
    expect(scope.isRestrictedAdmin({ role: "sub_admin", allCampuses: false })).toBe(true);
    expect(scope.isRestrictedAdmin({ role: "sub_admin", allCampuses: true })).toBe(false);
    expect(scope.isRestrictedAdmin({ role: "sub_admin" })).toBe(false); // an old row
    expect(scope.isRestrictedAdmin({ role: "school_admin", allCampuses: false })).toBe(false);
    expect(scope.isRestrictedAdmin({ role: "super_admin", allCampuses: false })).toBe(false);
  });

  it("loads the campuses only for a restricted admin, and asks the database for no one else", async () => {
    const client = { adminCampusAccess: { findMany: jest.fn().mockResolvedValue([{ campusId: 2 }, { campusId: 5 }]) } };

    expect(await scope.loadCampusScope(client, { id: 1, role: "sub_admin", allCampuses: false })).toEqual([2, 5]);
    expect(await scope.loadCampusScope(client, { id: 1, role: "sub_admin", allCampuses: true })).toBeNull();
    expect(await scope.loadCampusScope(client, { id: 1, role: "school_admin", allCampuses: true })).toBeNull();
    expect(client.adminCampusAccess.findMany).toHaveBeenCalledTimes(1);
    expect(client.adminCampusAccess.findMany).toHaveBeenCalledWith({ where: { adminId: 1 }, select: { campusId: true, permissions: true } });
  });

  it("is restricted with no campuses at all when none were assigned, so they see nothing", async () => {
    const client = { adminCampusAccess: { findMany: jest.fn().mockResolvedValue([]) } };
    expect(await scope.loadCampusScope(client, { id: 1, role: "sub_admin", allCampuses: false })).toEqual([]);
  });
});

describe("inScope", () => {
  it("lets an unrestricted admin see everything", () => {
    expect(scope.inScope(open(), 3)).toBe(true);
    expect(scope.inScope(open(), null)).toBe(true);
  });

  it("lets a restricted admin see their campuses only: a record with no campus is the owner's", () => {
    const req = restricted([1, 2]);
    expect(scope.inScope(req, 1)).toBe(true);
    expect(scope.inScope(req, 2)).toBe(true);
    expect(scope.inScope(req, null)).toBe(false);
    expect(scope.inScope(req, undefined)).toBe(false);
    expect(scope.inScope(req, 3)).toBe(false);
  });
});

describe("where fragments", () => {
  it("add nothing for an unrestricted admin, so a school with no campuses is untouched", () => {
    const req = open();
    for (const fn of [scope.classWhere, scope.staffWhere, scope.subjectWhere, scope.studentWhere, scope.examScheduleWhere, scope.viaClass, scope.viaStudent]) {
      expect(fn(req)).toEqual({});
    }
    expect(scope.campusIn(req)).toBeUndefined();
    expect(scope.withScope({ schoolId: 7 }, scope.classWhere(req))).toEqual({ schoolId: 7 });
  });

  it("hides rows with no campus from a restricted admin's own-campus models", () => {
    const expected = { campusId: { in: [1, 2] } };
    expect(scope.classWhere(restricted([1, 2]))).toEqual(expected);
    expect(scope.staffWhere(restricted([1, 2]))).toEqual(expected);
    expect(scope.subjectWhere(restricted([1, 2]))).toEqual(expected);
  });

  it("works out a student's campus as their own, else their class's", () => {
    expect(scope.studentWhere(restricted([4]))).toEqual({
      OR: [
        { campusId: { in: [4] } },
        { campusId: null, class: { campusId: { in: [4] } } },
      ],
    });
  });

  it("requires an exam schedule's campus, since it always has one", () => {
    expect(scope.examScheduleWhere(restricted([4]))).toEqual({ campusId: { in: [4] } });
  });

  it("reaches a record through its class or student", () => {
    expect(scope.viaClass(restricted([1]))).toEqual({ class: scope.classWhere(restricted([1])) });
    expect(scope.viaStudent(restricted([1]))).toEqual({ student: scope.studentWhere(restricted([1])) });
  });

  it("joins a where and a scope with AND, and never loosens the original", () => {
    const joined = scope.withScope({ schoolId: 7, id: 3 }, scope.classWhere(restricted([1])));
    expect(joined).toEqual({ AND: [{ schoolId: 7, id: 3 }, { campusId: { in: [1] } }] });
  });
});

describe("a campus named by the client", () => {
  it("is refused when it is not the restricted admin's, and never widens the scope", () => {
    expect(() => scope.assertCampusAllowed(restricted([1, 2]), 3)).toThrow(/do not have access/);
    expect(() => scope.assertCampusAllowed(restricted([1, 2]), "3")).toThrow(/do not have access/);
    expect(() => scope.assertCampusAllowed(restricted([1, 2]), 2)).not.toThrow();
    expect(scope.resolveCampusParam(restricted([1, 2]), "2")).toBe(2);
    expect(() => scope.resolveCampusParam(restricted([1, 2]), 9)).toThrow(/do not have access/);
  });

  it("passes through for an unrestricted admin, and is nothing when not given", () => {
    expect(scope.resolveCampusParam(open(), "9")).toBe(9);
    expect(scope.resolveCampusParam(restricted([1]), undefined)).toBeUndefined();
    expect(scope.resolveCampusParam(restricted([1]), "")).toBeUndefined();
    expect(() => scope.assertCampusAllowed(restricted([1]), null)).not.toThrow();
  });

  it("refuses any named campus for a restricted admin with none assigned", () => {
    expect(() => scope.assertCampusAllowed(restricted([]), 1)).toThrow();
  });
});

describe("asserting a record is in scope", () => {
  const client = (found: unknown) => ({
    class: { findFirst: jest.fn().mockResolvedValue(found) },
    student: { findFirst: jest.fn().mockResolvedValue(found) },
    staff: { findFirst: jest.fn().mockResolvedValue(found) },
    subject: { findFirst: jest.fn().mockResolvedValue(found) },
  });

  it("looks the record up in the school AND the scope, so another campus reads as not found", async () => {
    const c = client(null);
    await expect(scope.assertClassInScope(restricted([1]), 9, c)).rejects.toMatchObject({ statusCode: 404, message: "Class not found" });
    expect(c.class.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: 9, schoolId: 7 }, { campusId: { in: [1] } }] },
      select: { id: true, campusId: true },
    });
  });

  it("returns the record when it is in scope, and asks only for the school for an unrestricted admin", async () => {
    const c = client({ id: 9, campusId: 1 });
    expect(await scope.assertStudentInScope(open(), 9, c)).toEqual({ id: 9, campusId: 1 });
    expect(c.student.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 9, schoolId: 7 } }));
  });

  it.each([
    ["assertStaffInScope", "staff", "Staff member"],
    ["assertSubjectInScope", "subject", "Subject"],
    ["assertStudentInScope", "student", "Student"],
  ])("%s answers 404 for something outside the scope", async (fn, _model, label) => {
    await expect(scope[fn](restricted([1]), 5, client(null))).rejects.toMatchObject({ statusCode: 404, message: `${label} not found` });
  });
});

export {};
