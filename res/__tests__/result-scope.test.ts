// A class with groups has a class teacher per group; students in no group (and every
// student of a class with no groups) belong to the class-level scope.
/* eslint-disable @typescript-eslint/no-var-requires */
const scope = require("../util/resultScope");

const client = (over: Record<string, unknown> = {}) => ({
  class: { findFirst: jest.fn().mockResolvedValue({ id: 9, staffId: 50, name: "SS 1", campusId: 1 }) },
  classGroup: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
  student: { groupBy: jest.fn().mockResolvedValue([]) },
  academicTerm: { findFirst: jest.fn().mockResolvedValue({ id: 3, sessionId: 2 }) },
  classCompilation: { findUnique: jest.fn().mockResolvedValue(null) },
  ...over,
});

describe("scope helpers", () => {
  it("treats no group as scope 0 and a group as its id", () => {
    expect(scope.groupValue(0)).toBeNull();
    expect(scope.groupValue(undefined)).toBeNull();
    expect(scope.groupValue(7)).toBe(7);
    expect(scope.scopeOfStudent({ classGroupId: null })).toBe(0);
    expect(scope.scopeOfStudent({ classGroupId: 4 })).toBe(4);
    expect(scope.studentScopeWhere(0)).toEqual({ classGroupId: null });
    expect(scope.studentScopeWhere(4)).toEqual({ classGroupId: 4 });
  });

  it("reads a scope off a request, defaulting to the class level", () => {
    expect(scope.parseScope("5")).toBe(5);
    for (const bad of [undefined, null, "", "abc", "-2", 0, 1.5]) expect(scope.parseScope(bad)).toBe(0);
  });

  it("labels a group with its class", () => {
    expect(scope.scopeLabel("SS 1", "A")).toBe("SS 1 — A");
    expect(scope.scopeLabel("SS 1", null)).toBe("SS 1");
  });
});

describe("scopesOfClass", () => {
  it("is one class-level scope, with every student, when the class has no groups", async () => {
    const c = client({ student: { groupBy: jest.fn().mockResolvedValue([{ classGroupId: null, _count: { _all: 12 } }]) } });
    expect(await scope.scopesOfClass(c, { schoolId: 1, classId: 9, sessionId: 2 })).toEqual([
      { classGroupId: 0, groupName: null, staffId: 50, studentCount: 12 },
    ]);
  });

  it("is a scope per group, plus the class level only when someone is in no group", async () => {
    const groups = [{ id: 1, name: "A", staffId: 11 }, { id: 2, name: "B", staffId: null }];
    const c = client({
      classGroup: { findMany: jest.fn().mockResolvedValue(groups), findFirst: jest.fn() },
      student: { groupBy: jest.fn().mockResolvedValue([{ classGroupId: 1, _count: { _all: 5 } }, { classGroupId: 2, _count: { _all: 6 } }]) },
    });
    const all = await scope.scopesOfClass(c, { schoolId: 1, classId: 9, sessionId: 2 });
    expect(all.map((s: any) => s.groupName)).toEqual(["A", "B"]);
    expect(all[1].staffId).toBeNull();

    const withUngrouped = client({
      classGroup: { findMany: jest.fn().mockResolvedValue(groups), findFirst: jest.fn() },
      student: { groupBy: jest.fn().mockResolvedValue([{ classGroupId: 1, _count: { _all: 5 } }, { classGroupId: null, _count: { _all: 2 } }]) },
    });
    const more = await scope.scopesOfClass(withUngrouped, { schoolId: 1, classId: 9, sessionId: 2 });
    expect(more.map((s: any) => s.classGroupId)).toEqual([1, 2, 0]);
    expect(more[2]).toMatchObject({ staffId: 50, studentCount: 2 });
  });

  it("is nothing for a class of another school", async () => {
    const c = client({ class: { findFirst: jest.fn().mockResolvedValue(null) } });
    expect(await scope.scopesOfClass(c, { schoolId: 1, classId: 9, sessionId: 2 })).toEqual([]);
  });
});

describe("classTeacherOfScope", () => {
  it("is the class's teacher at class level and the group's teacher for a group", async () => {
    const c = client({ classGroup: { findMany: jest.fn(), findFirst: jest.fn().mockResolvedValue({ id: 4, name: "A", staffId: 77 }) } });
    expect((await scope.classTeacherOfScope(c, { schoolId: 1, classId: 9, scope: 0 })).staffId).toBe(50);
    const g = await scope.classTeacherOfScope(c, { schoolId: 1, classId: 9, scope: 4 });
    expect(g).toMatchObject({ valid: true, staffId: 77, groupName: "A" });
  });

  it("refuses a group that is not in the class, or a class that is not the school's", async () => {
    expect((await scope.classTeacherOfScope(client(), { schoolId: 1, classId: 9, scope: 4 })).valid).toBe(false);
    const none = client({ class: { findFirst: jest.fn().mockResolvedValue(null) } });
    expect((await scope.classTeacherOfScope(none, { schoolId: 1, classId: 9, scope: 0 })).cls).toBeNull();
  });
});

describe("groupChangeBlockedReason", () => {
  it("blocks while the student's group is with the admin or approved", async () => {
    for (const status of ["SUBMITTED", "APPROVED"]) {
      const c = client({ classCompilation: { findUnique: jest.fn().mockResolvedValue({ status }) } });
      expect(await scope.groupChangeBlockedReason(c, { schoolId: 1, classId: 9, classGroupId: 4 })).toContain("sent to the admin");
    }
  });

  it("allows it otherwise, and when there is no active term", async () => {
    const returned = client({ classCompilation: { findUnique: jest.fn().mockResolvedValue({ status: "RETURNED" }) } });
    expect(await scope.groupChangeBlockedReason(returned, { schoolId: 1, classId: 9, classGroupId: 4 })).toBeNull();
    expect(await scope.groupChangeBlockedReason(client(), { schoolId: 1, classId: 9, classGroupId: null })).toBeNull();
    const noTerm = client({ academicTerm: { findFirst: jest.fn().mockResolvedValue(null) } });
    expect(await scope.groupChangeBlockedReason(noTerm, { schoolId: 1, classId: 9, classGroupId: 4 })).toBeNull();
  });

  it("looks up the compilation of the student's own scope", async () => {
    const c = client();
    await scope.groupChangeBlockedReason(c, { schoolId: 1, classId: 9, classGroupId: null });
    expect(c.classCompilation.findUnique).toHaveBeenCalledWith({
      where: { classId_academicSessionId_termId_classGroupId: { classId: 9, academicSessionId: 2, termId: 3, classGroupId: 0 } },
      select: { status: true },
    });
  });
});

export {};
