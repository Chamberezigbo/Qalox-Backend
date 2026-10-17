// A restricted sub-admin may hold different permissions on each campus: a Bursar on
// campus 1 and a Secretary on campus 2. A campus with no list of its own uses the
// sub-admin's global permissions, so every existing sub-admin behaves as before.
const mockPrisma: any = {
  admin: { findUnique: jest.fn() },
  adminCampusAccess: { findMany: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/getSchoolLockStatus", () => ({ getSchoolLockStatus: jest.fn() }));
jest.mock("../util/schoolSuspension", () => ({
  isSchoolSuspended: jest.fn(), SCHOOL_SUSPENDED_MESSAGE: "x", ACCOUNT_SUSPENDED_MESSAGE: "y",
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { requirePermission, attachSchoolId } = require("../middleware/authenticateSuperAdmin");
const scope = require("../util/campusScope");

const GLOBAL = JSON.stringify(["students.manage"]);
const rows = [
  { campusId: 1, permissions: JSON.stringify(["fees.manage"]) }, // Bursar on campus 1
  { campusId: 2, permissions: JSON.stringify(["students.manage", "classes.manage"]) }, // Secretary on campus 2
  { campusId: 3, permissions: null }, // inherits the global list
];
const admin = { id: 3, schoolId: 7, role: "sub_admin", allCampuses: false, permissions: GLOBAL };

const gate = (key: string | string[], user: object) => {
  const req: any = { user };
  const next = jest.fn();
  requirePermission(key)(req, {}, next);
  return { req, error: next.mock.calls[0]?.[0] };
};

const narrowed = async (key: string, campusAccess = rows) => {
  const { req, error } = gate(key, { ...admin, campusAccess });
  if (error) return { error };
  mockPrisma.admin.findUnique.mockResolvedValue(admin);
  mockPrisma.adminCampusAccess.findMany.mockResolvedValue(campusAccess);
  await attachSchoolId(req, {}, jest.fn());
  return { campusIds: req.campusIds };
};

beforeEach(() => jest.resetAllMocks());

describe("effectivePermissions", () => {
  it("uses the campus's own list when it has one, else the global list", () => {
    expect(scope.effectivePermissions(rows[0], GLOBAL)).toEqual(["fees.manage"]);
    expect(scope.effectivePermissions(rows[2], GLOBAL)).toEqual(["students.manage"]);
  });

  it("treats an empty own list as no permissions on that campus", () => {
    expect(scope.effectivePermissions({ permissions: "[]" }, GLOBAL)).toEqual([]);
  });
});

describe("the permission gate", () => {
  it("lets a sub-admin in when they hold the permission on any campus, even if not globally", () => {
    expect(gate("fees.manage", { ...admin, campusAccess: rows }).error).toBeUndefined();
  });

  it("refuses a permission held nowhere", () => {
    expect(gate("exams.manage", { ...admin, campusAccess: rows }).error?.statusCode).toBe(403);
  });

  it("still uses the global list for a sub-admin with no per-campus lists, as before", () => {
    const inherit = [{ campusId: 1, permissions: null }];
    expect(gate("students.manage", { ...admin, campusAccess: inherit }).error).toBeUndefined();
    expect(gate("fees.manage", { ...admin, campusAccess: inherit }).error?.statusCode).toBe(403);
  });

  it("uses the global list for a sub-admin with all campuses (no campus rows)", () => {
    const all = { ...admin, allCampuses: true };
    expect(gate("students.manage", all).error).toBeUndefined();
    expect(gate("fees.manage", all).error?.statusCode).toBe(403);
  });

  it("never restricts a head admin", () => {
    expect(gate("fees.manage", { id: 1, role: "school_admin" }).error).toBeUndefined();
  });
});

describe("campus scope follows the permission", () => {
  it("gives fees only the Bursar's campus", async () => {
    expect((await narrowed("fees.manage")).campusIds).toEqual([1]);
  });

  it("gives students the Secretary's campus and the inheriting one", async () => {
    expect((await narrowed("students.manage")).campusIds).toEqual([2, 3]);
  });

  it("gives classes only the Secretary's campus", async () => {
    expect((await narrowed("classes.manage")).campusIds).toEqual([2]);
  });

  it("answers 403 for a module held nowhere, before any data is read", async () => {
    expect((await narrowed("exams.manage")).error?.statusCode).toBe(403);
  });

  it("leaves the scope whole on a route that names no permission", async () => {
    const req: any = { user: { ...admin, campusAccess: rows } };
    mockPrisma.admin.findUnique.mockResolvedValue(admin);
    mockPrisma.adminCampusAccess.findMany.mockResolvedValue(rows);
    await attachSchoolId(req, {}, jest.fn());
    expect(req.campusIds).toEqual([1, 2, 3]);
  });
});

export {};
