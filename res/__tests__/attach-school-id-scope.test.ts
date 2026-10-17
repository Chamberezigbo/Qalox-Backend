// attachSchoolId is where a request learns its campus scope. It reads the admin row on
// every request, so a change to a sub-admin's campuses applies on their next click.
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
const { attachSchoolId } = require("../middleware/authenticateSuperAdmin");

const run = async (admin: object | null) => {
  mockPrisma.admin.findUnique.mockResolvedValue(admin);
  const req: any = { user: { id: 3 } };
  const next = jest.fn();
  await attachSchoolId(req, {}, next);
  return { req, next };
};

beforeEach(() => jest.resetAllMocks());

describe("attachSchoolId and the campus scope", () => {
  it("leaves a head admin unrestricted, without asking for campuses", async () => {
    const { req, next } = await run({ id: 3, schoolId: 7, role: "school_admin", allCampuses: true });
    expect(req.schoolId).toBe(7);
    expect(req.campusIds).toBeNull();
    expect(mockPrisma.adminCampusAccess.findMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("leaves a sub-admin with all campuses unrestricted, which is every existing sub-admin", async () => {
    const { req } = await run({ id: 3, schoolId: 7, role: "sub_admin", allCampuses: true });
    expect(req.campusIds).toBeNull();
    expect(mockPrisma.adminCampusAccess.findMany).not.toHaveBeenCalled();
  });

  it("gives a restricted sub-admin their campuses, read fresh each time", async () => {
    mockPrisma.adminCampusAccess.findMany.mockResolvedValueOnce([{ campusId: 2 }, { campusId: 4 }]);
    const first = await run({ id: 3, schoolId: 7, role: "sub_admin", allCampuses: false });
    expect(first.req.campusIds).toEqual([2, 4]);

    // A campus is taken away: the very next request sees it.
    mockPrisma.adminCampusAccess.findMany.mockResolvedValueOnce([{ campusId: 2 }]);
    const second = await run({ id: 3, schoolId: 7, role: "sub_admin", allCampuses: false });
    expect(second.req.campusIds).toEqual([2]);
  });

  it("still refuses an admin with no school, and an unknown admin", async () => {
    expect((await run({ id: 3, schoolId: null, role: "sub_admin", allCampuses: false })).next.mock.calls[0][0].statusCode).toBe(401);
    expect((await run(null)).next.mock.calls[0][0].statusCode).toBe(401);
  });
});

export {};
