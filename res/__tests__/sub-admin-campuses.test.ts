// Giving a sub-admin campuses. A school with no campus, or one, has nothing to choose;
// a school with several must be told which, and only its own campuses are allowed.
const mockPrisma: any = {
  campus: { findMany: jest.fn() },
  admin: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  adminCampusAccess: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn().mockResolvedValue(null) }));
jest.mock("bcryptjs", () => ({ hash: jest.fn().mockResolvedValue("hashed") }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { resolveCampusAccess, saveCampusAccess, campusesByAdmin } = require("../util/subAdminCampuses");
const controller = require("../controller/admin/SubAdminController");

const campuses = (...ids: number[]) => mockPrisma.campus.findMany.mockResolvedValue(ids.map((id) => ({ id })));
const resolve = (body: object, creating = true) => resolveCampusAccess(mockPrisma, { schoolId: 7, body, creating });

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe("resolveCampusAccess", () => {
  it("is always 'all campuses' for a school with no campuses or one: nothing to choose", async () => {
    campuses();
    expect(await resolve({})).toMatchObject({ allCampuses: true, campusIds: [] });
    campuses(1);
    expect(await resolve({})).toMatchObject({ allCampuses: true, campusIds: [] });
    campuses(1);
    expect(await resolve({ allCampuses: false, campusIds: [1] })).toMatchObject({ allCampuses: true, campusIds: [] });
  });

  it("leaves an existing sub-admin alone when the request does not mention campuses", async () => {
    campuses(1, 2);
    expect(await resolve({ name: "x" }, false)).toBeUndefined();
    campuses(1);
    expect(await resolve({ name: "x" }, false)).toBeUndefined();
  });

  it("asks a school with several campuses to choose, for a NEW sub-admin", async () => {
    campuses(1, 2);
    await expect(resolve({})).rejects.toMatchObject({ statusCode: 400, code: "CAMPUSES_REQUIRED" });
  });

  it("accepts 'all campuses'", async () => {
    campuses(1, 2);
    expect(await resolve({ allCampuses: true, campusIds: [1] })).toMatchObject({ allCampuses: true, campusIds: [] });
  });

  it("accepts one or several of the school's campuses, once each", async () => {
    campuses(1, 2, 3);
    expect(await resolve({ allCampuses: false, campusIds: [2, "3", 2] })).toMatchObject({ allCampuses: false, campusIds: [2, 3] });
    campuses(1, 2, 3);
    expect(await resolve({ campusIds: [1] })).toMatchObject({ allCampuses: false, campusIds: [1] });
  });

  it("refuses restricted access with no campus chosen", async () => {
    campuses(1, 2);
    await expect(resolve({ allCampuses: false, campusIds: [] })).rejects.toMatchObject({ code: "CAMPUSES_REQUIRED" });
    campuses(1, 2);
    await expect(resolve({ allCampuses: false })).rejects.toMatchObject({ code: "CAMPUSES_REQUIRED" });
    campuses(1, 2);
    await expect(resolve({ allCampuses: false, campusIds: ["x"] })).rejects.toMatchObject({ code: "CAMPUSES_REQUIRED" });
  });

  it("refuses a campus that is not this school's", async () => {
    campuses(1, 2);
    await expect(resolve({ allCampuses: false, campusIds: [1, 99] })).rejects.toMatchObject({ code: "INVALID_CAMPUSES" });
    expect(mockPrisma.campus.findMany).toHaveBeenCalledWith({ where: { schoolId: 7 }, select: { id: true } });
  });

  it("can switch an existing sub-admin to restricted, or back to all", async () => {
    campuses(1, 2);
    expect(await resolve({ campusIds: [2] }, false)).toMatchObject({ allCampuses: false, campusIds: [2] });
    campuses(1, 2);
    expect(await resolve({ allCampuses: true }, false)).toMatchObject({ allCampuses: true, campusIds: [] });
  });
});

describe("per-campus permissions", () => {
  it("keeps a campus's own list and leaves the others inheriting", async () => {
    mockPrisma.campus.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const out = await resolve({ campuses: [{ campusId: 2, permissions: ["fees.manage", "fees.manage"] }, { campusId: 3 }] });
    expect(out).toEqual({ allCampuses: false, campusIds: [2, 3], permissionsByCampus: { 2: ["fees.manage"], 3: null } });
  });

  it("refuses a permission that does not exist", async () => {
    mockPrisma.campus.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await expect(resolve({ campuses: [{ campusId: 2, permissions: ["nope.manage"] }] })).rejects.toMatchObject({ code: "INVALID_PERMISSIONS" });
  });

  it("stores each campus's list as JSON, and null for inherit", async () => {
    await saveCampusAccess(mockPrisma, 5, { allCampuses: false, campusIds: [1, 2], permissionsByCampus: { 1: ["fees.manage"], 2: null } });
    expect(mockPrisma.adminCampusAccess.createMany).toHaveBeenCalledWith({
      data: [{ adminId: 5, campusId: 1, permissions: '["fees.manage"]' }, { adminId: 5, campusId: 2, permissions: null }],
    });
  });

  it("reports each campus's list", async () => {
    mockPrisma.adminCampusAccess.findMany.mockResolvedValue([{ adminId: 5, campusId: 1, permissions: '["fees.manage"]' }]);
    mockPrisma.campus.findMany.mockResolvedValue([{ id: 1, name: "Main" }]);
    const map = await campusesByAdmin(mockPrisma, [{ id: 5, allCampuses: false }]);
    expect(map.get(5)).toEqual([{ id: 1, name: "Main", permissions: ["fees.manage"] }]);
  });
});

describe("saveCampusAccess", () => {
  it("replaces the rows", async () => {
    await saveCampusAccess(mockPrisma, 5, { allCampuses: false, campusIds: [1, 2] });
    expect(mockPrisma.adminCampusAccess.deleteMany).toHaveBeenCalledWith({ where: { adminId: 5 } });
    expect(mockPrisma.adminCampusAccess.createMany).toHaveBeenCalledWith({ data: [{ adminId: 5, campusId: 1, permissions: null }, { adminId: 5, campusId: 2, permissions: null }] });
  });

  it("clears them when the sub-admin gets all campuses", async () => {
    await saveCampusAccess(mockPrisma, 5, { allCampuses: true, campusIds: [] });
    expect(mockPrisma.adminCampusAccess.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.adminCampusAccess.createMany).not.toHaveBeenCalled();
  });
});

describe("campusesByAdmin", () => {
  it("names the campuses of the restricted admins only", async () => {
    mockPrisma.adminCampusAccess.findMany.mockResolvedValue([{ adminId: 5, campusId: 1, permissions: null }, { adminId: 5, campusId: 2, permissions: null }]);
    mockPrisma.campus.findMany.mockResolvedValue([{ id: 1, name: "Main" }, { id: 2, name: "Annex" }]);

    const map = await campusesByAdmin(mockPrisma, [{ id: 5, allCampuses: false }, { id: 6, allCampuses: true }]);

    expect(map.get(5)).toEqual([{ id: 1, name: "Main", permissions: null }, { id: 2, name: "Annex", permissions: null }]);
    expect(map.has(6)).toBe(false);
    expect(mockPrisma.adminCampusAccess.findMany).toHaveBeenCalledWith({ where: { adminId: { in: [5] } }, select: { adminId: true, campusId: true, permissions: true } });
  });

  it("asks the database for nothing when nobody is restricted", async () => {
    await campusesByAdmin(mockPrisma, [{ id: 6, allCampuses: true }]);
    expect(mockPrisma.adminCampusAccess.findMany).not.toHaveBeenCalled();
  });
});

describe("creating and updating a sub-admin", () => {
  const call = async (handler: any, req: object) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await handler({ user: { id: 1 }, schoolId: 7, params: {}, body: {}, ...req }, res, next);
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
  };
  const base = { name: "Ada", email: "ada@x.com", password: "secret1", subAdminType: "hr", permissions: ["staff.manage"] };

  beforeEach(() => {
    mockPrisma.admin.findUnique.mockResolvedValue(null);
    mockPrisma.admin.create.mockImplementation(async ({ data }: any) => ({ id: 50, createdAt: new Date(), isSuspended: false, ...data }));
    mockPrisma.adminCampusAccess.findMany.mockResolvedValue([{ adminId: 50, campusId: 2, permissions: null }]);
  });

  it("creates a sub-admin for one campus, and returns the campus", async () => {
    campuses(1, 2);
    mockPrisma.campus.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]).mockResolvedValueOnce([{ id: 2, name: "Annex" }]);

    const { status, body } = await call(controller.createSubAdmin, { body: { ...base, allCampuses: false, campusIds: [2] } });

    expect(status).toBe(201);
    expect(mockPrisma.admin.create.mock.calls[0][0].data.allCampuses).toBe(false);
    expect(mockPrisma.adminCampusAccess.createMany).toHaveBeenCalledWith({ data: [{ adminId: 50, campusId: 2, permissions: null }] });
    expect(body.data).toMatchObject({ allCampuses: false, campuses: [{ id: 2, name: "Annex" }] });
  });

  it("will not create one for a school with several campuses without saying which", async () => {
    campuses(1, 2);
    const { next } = await call(controller.createSubAdmin, { body: base });
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, code: "CAMPUSES_REQUIRED" });
    expect(mockPrisma.admin.create).not.toHaveBeenCalled();
  });

  it("creates one as before for a school with no campuses", async () => {
    campuses();
    const { status, body } = await call(controller.createSubAdmin, { body: base });
    expect(status).toBe(201);
    expect(mockPrisma.admin.create.mock.calls[0][0].data.allCampuses).toBe(true);
    expect(body.data).toMatchObject({ allCampuses: true, campuses: [] });
  });

  it("changes a sub-admin's campuses on update, and leaves them alone when not mentioned", async () => {
    mockPrisma.admin.findFirst.mockResolvedValue({ id: 50, subAdminLabel: null });
    mockPrisma.admin.update.mockImplementation(async ({ data }: any) => ({ id: 50, createdAt: new Date(), allCampuses: data.allCampuses ?? true, ...data }));
    campuses(1, 2);
    await call(controller.updateSubAdmin, { params: { id: "50" }, body: { allCampuses: false, campusIds: [1] } });
    expect(mockPrisma.admin.update.mock.calls[0][0].data.allCampuses).toBe(false);
    expect(mockPrisma.adminCampusAccess.createMany).toHaveBeenCalledWith({ data: [{ adminId: 50, campusId: 1, permissions: null }] });

    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.admin.findFirst.mockResolvedValue({ id: 50, subAdminLabel: null });
    mockPrisma.admin.update.mockResolvedValue({ id: 50, createdAt: new Date(), allCampuses: false });
    mockPrisma.adminCampusAccess.findMany.mockResolvedValue([]);
    mockPrisma.campus.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    await call(controller.updateSubAdmin, { params: { id: "50" }, body: { name: "New name" } });
    expect(mockPrisma.adminCampusAccess.deleteMany).not.toHaveBeenCalled();
  });

  it("removes the campus rows when a sub-admin is deleted", async () => {
    mockPrisma.admin.findFirst.mockResolvedValue({ id: 50 });
    await call(controller.deleteSubAdmin, { params: { id: "50" } });
    expect(mockPrisma.adminCampusAccess.deleteMany).toHaveBeenCalledWith({ where: { adminId: 50 } });
    expect(mockPrisma.admin.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

export {};
