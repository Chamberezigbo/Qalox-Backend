// Every admin route a sub-admin can reach by permission must also attach the school (and
// with it the campus scope). A route without it would look records up by id alone: it
// could read another school's data, and a campus restriction could not be applied to it.
// This walks the real router, so a route added later without it fails here.
jest.mock("../util/prisma", () => ({}));
jest.mock("../util/getSchoolLockStatus", () => ({ getSchoolLockStatus: jest.fn() }));
jest.mock("../util/schoolSuspension", () => ({ isSchoolSuspended: jest.fn(), SCHOOL_SUSPENDED_MESSAGE: "x", ACCOUNT_SUSPENDED_MESSAGE: "y" }));

/* eslint-disable @typescript-eslint/no-var-requires */
const auth = require("../middleware/authenticateSuperAdmin");
const router = require("../routes/admin/admin");

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: any }> } };

const routes = (router.stack as Layer[])
  .filter((l) => l.route)
  .map((l) => ({
    label: `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`,
    handlers: l.route!.stack.map((s) => s.handle),
  }));

describe("admin routes", () => {
  it("found the routes", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("attach the school on every permission-gated route", () => {
    const missing = routes
      .filter((r) => r.handlers.some((h) => h.isPermissionGate) && !r.handlers.includes(auth.attachSchoolId))
      .map((r) => r.label);
    expect(missing).toEqual([]);
  });

  it("attach the school on every head-admin and school-level route that is not a plain read of the admin's own data", () => {
    // Routes that legitimately need no school: they use only the admin's own id.
    const exempt = new Set([
      "GET /my-school", "GET /setup-status", "GET /permissions", "POST /create", "POST /login",
      "POST /forgot-password", "POST /reset-password", "GET /",
      "GET /notifications", "PATCH /notifications/:id/read", "PATCH /notifications/read-all", "GET /billing/plans",
    ]);
    const missing = routes
      .filter((r) => !exempt.has(r.label))
      .filter((r) => r.handlers.some((h) => [auth.authenticateSuperAdmin, auth.authenticateSchoolLevelAdmin, auth.authenticateAdmin].includes(h)))
      .filter((r) => !r.handlers.includes(auth.attachSchoolId))
      .map((r) => r.label);
    expect(missing).toEqual([]);
  });

  it("never leave an admin-changing route open to anyone", () => {
    const open = routes
      .filter((r) => /^(PUT|PATCH|DELETE) \/:id$/.test(r.label))
      .filter((r) => !r.handlers.includes(auth.authenticateSuperAdmin))
      .map((r) => r.label);
    expect(open).toEqual([]);
  });
});

export {};
