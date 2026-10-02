// DB-independent checks for the two fixes made to the "Select Group" dropdown
// bug: requirePermission now accepts an array of acceptable keys, and
// getClassGroups scopes its pagination count by schoolId like the main query.
jest.mock("../util/prisma", () => ({
  classGroup: { count: jest.fn(), findMany: jest.fn() },
}));

import { requirePermission } from "../middleware/authenticateSuperAdmin";
import { PERMISSIONS } from "../util/permissions";
import prisma from "../util/prisma";
import { getClassGroups } from "../controller/admin/ClassController";

function mockReqRes(user: unknown) {
  const req: any = { user, query: { classId: "5" }, schoolId: 42 };
  const res: any = {
    statusCode: undefined,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

describe("requirePermission — array-of-keys support", () => {
  it("lets a sub_admin through when they hold ANY of the required keys", () => {
    const { req, res, next } = mockReqRes({
      role: "sub_admin",
      permissions: JSON.stringify([PERMISSIONS.STUDENTS_MANAGE]),
    });
    requirePermission([PERMISSIONS.CLASSES_MANAGE, PERMISSIONS.STUDENTS_MANAGE])(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error = passed through
  });

  it("still rejects a sub_admin holding none of the required keys", () => {
    const { req, res, next } = mockReqRes({
      role: "sub_admin",
      permissions: JSON.stringify([PERMISSIONS.STAFF_MANAGE]),
    });
    requirePermission([PERMISSIONS.CLASSES_MANAGE, PERMISSIONS.STUDENTS_MANAGE])(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("still works with a single (non-array) permission key, unchanged", () => {
    const { req, res, next } = mockReqRes({
      role: "sub_admin",
      permissions: JSON.stringify([PERMISSIONS.CLASSES_MANAGE]),
    });
    requirePermission(PERMISSIONS.CLASSES_MANAGE)(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("head admins always pass regardless of permissions array", () => {
    const { req, res, next } = mockReqRes({ role: "school_admin" });
    requirePermission([PERMISSIONS.CLASSES_MANAGE, PERMISSIONS.STUDENTS_MANAGE])(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe("getClassGroups — pagination count scoped to schoolId", () => {
  it("passes the same schoolId-scoped where clause to both count and findMany", async () => {
    (prisma.classGroup.count as jest.Mock).mockResolvedValue(3);
    (prisma.classGroup.findMany as jest.Mock).mockResolvedValue([
      { id: 1, classId: 5, name: "JSS1A", class: { id: 5, name: "JSS1" } },
    ]);

    const { req, res, next } = mockReqRes({ role: "school_admin" });
    await getClassGroups(req, res, next);

    const countWhere = (prisma.classGroup.count as jest.Mock).mock.calls[0][0].where;
    const findManyWhere = (prisma.classGroup.findMany as jest.Mock).mock.calls[0][0].where;

    expect(countWhere).toEqual(findManyWhere);
    expect(countWhere).toMatchObject({ classId: 5, class: { schoolId: 42 } });
    expect(res.statusCode).toBe(200);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.groups).toHaveLength(1);
  });
});
