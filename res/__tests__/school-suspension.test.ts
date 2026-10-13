// Suspending a school is meant to stop everyone in it, and the Super Admin dialog
// says so, but nothing read the flag. A suspended head admin also kept access
// because one guard trusted the token without reading the account.
const mockPrisma: any = {
  school: { findUnique: jest.fn() },
  admin: { findUnique: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/getSchoolLockStatus", () => ({ getSchoolLockStatus: jest.fn().mockResolvedValue({ locked: false }) }));

import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  isSchoolSuspended,
  clearSchoolSuspensionCache,
} = require("../util/schoolSuspension");
const {
  authenticateAdmin,
  authenticateSuperAdmin,
  authenticateSchoolLevelAdmin,
} = require("../middleware/authenticateSuperAdmin");

const tokenFor = (role: string, id = 5) => jwt.sign({ id, role }, process.env.JWT_SECRET as string);
const reqWith = (role: string) => ({ headers: { authorization: `Bearer ${tokenFor(role)}` }, method: "GET", path: "/x" });
const run = async (guard: any, role: string) => {
  const next = jest.fn();
  await guard(reqWith(role), {}, next);
  return next.mock.calls[0]?.[0];
};

beforeEach(() => {
  jest.resetAllMocks();
  clearSchoolSuspensionCache();
  mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: false });
});

describe("isSchoolSuspended", () => {
  it("reads the school's flag", async () => {
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: true });
    expect(await isSchoolSuspended(7)).toBe(true);
  });

  it("remembers the answer for a moment, and forgets it when told", async () => {
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: false });
    await isSchoolSuspended(7);
    await isSchoolSuspended(7);
    expect(mockPrisma.school.findUnique).toHaveBeenCalledTimes(1);

    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: true });
    clearSchoolSuspensionCache(7);
    expect(await isSchoolSuspended(7)).toBe(true);
  });

  it("treats no school as not suspended", async () => {
    expect(await isSchoolSuspended(undefined)).toBe(false);
  });
});

describe.each([
  ["authenticateAdmin", authenticateAdmin],
  ["authenticateSuperAdmin", authenticateSuperAdmin],
  ["authenticateSchoolLevelAdmin", authenticateSchoolLevelAdmin],
])("%s", (_name, guard) => {
  const account = (over: object = {}) => ({ id: 5, role: "school_admin", schoolId: 7, isSuspended: false, permissions: null, ...over });

  it("lets an active admin of an active school through", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(account());
    expect(await run(guard, "school_admin")).toBeUndefined();
  });

  it("refuses a suspended admin", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(account({ isSuspended: true }));
    const error = await run(guard, "school_admin");
    expect(error?.statusCode).toBe(401);
    expect(error.message).toContain("suspended");
  });

  it("refuses an admin of a suspended school", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(account());
    mockPrisma.school.findUnique.mockResolvedValue({ isSuspended: true });
    const error = await run(guard, "school_admin");
    expect(error?.statusCode).toBe(403);
    expect(error.message).toContain("school's account has been suspended");
  });

  it("refuses an admin who no longer exists", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(null);
    expect((await run(guard, "school_admin"))?.statusCode).toBe(401);
  });
});

describe("authenticateSuperAdmin keeps its output", () => {
  it("still attaches the token's own claims", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue({ id: 5, role: "school_admin", schoolId: 7, isSuspended: false });
    const req: any = reqWith("school_admin");
    await authenticateSuperAdmin(req, {}, jest.fn());
    expect(req.user).toMatchObject({ id: 5, role: "school_admin" });
  });

  it("still refuses a sub-admin token", async () => {
    expect((await run(authenticateSuperAdmin, "sub_admin"))?.statusCode).toBe(401);
  });
});

export {};
