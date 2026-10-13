// Student.classId moves when a student is promoted. The history keeps the class
// for each session, so a result view for an old session still describes the
// class it was earned in.
const mockPrisma: any = {
  studentEnrollment: { upsert: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  student: { findMany: jest.fn() },
  class: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  teacherAssignment: { deleteMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock("../util/prisma", () => mockPrisma);

/* eslint-disable @typescript-eslint/no-var-requires */
const { recordEnrollment, syncEnrollments } = require("../util/studentEnrollment");
const { getEnrolledClassId } = require("../util/enrolledClass");
const { saveClassLadder } = require("../controller/admin/ClassLadderController");
const { deleteClass } = require("../controller/admin/ClassController");

const student = { id: 5, schoolId: 7, academicSessionId: 2, classId: 11, classGroupId: null, campusId: 3 };

beforeEach(() => jest.resetAllMocks());

describe("recordEnrollment", () => {
  it("records the class for the student's session, one row per student per session", async () => {
    await recordEnrollment(mockPrisma, student);
    const arg = mockPrisma.studentEnrollment.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ studentId_academicSessionId: { studentId: 5, academicSessionId: 2 } });
    expect(arg.create).toMatchObject({ classId: 11, campusId: 3, classGroupId: null, schoolId: 7 });
    expect(arg.update).toMatchObject({ classId: 11 });
  });

  it("never throws: the history must not undo the change that triggered it", async () => {
    mockPrisma.studentEnrollment.upsert.mockRejectedValue(new Error("db down"));
    await expect(recordEnrollment(mockPrisma, student)).resolves.toBeUndefined();
  });
});

describe("syncEnrollments", () => {
  it("re-reads the students within the school and records each", async () => {
    mockPrisma.student.findMany.mockResolvedValue([student, { ...student, id: 6 }]);
    await syncEnrollments(mockPrisma, [5, 6], 7);
    expect(mockPrisma.student.findMany.mock.calls[0][0].where).toEqual({ id: { in: [5, 6] }, schoolId: 7 });
    expect(mockPrisma.studentEnrollment.upsert).toHaveBeenCalledTimes(2);
  });
});

describe("getEnrolledClassId", () => {
  it("returns the class they were in that session, not the one they are in now", async () => {
    mockPrisma.studentEnrollment.findUnique.mockResolvedValue({ classId: 10 });
    expect(await getEnrolledClassId(mockPrisma, 5, 1, 11)).toBe(10);
  });

  it("falls back to the current class when there is no history row", async () => {
    mockPrisma.studentEnrollment.findUnique.mockResolvedValue(null);
    expect(await getEnrolledClassId(mockPrisma, 5, 1, 11)).toBe(11);
  });

  it("falls back without a lookup when no session is given", async () => {
    expect(await getEnrolledClassId(mockPrisma, 5, undefined, 11)).toBe(11);
    expect(mockPrisma.studentEnrollment.findUnique).not.toHaveBeenCalled();
  });
});

describe("saveClassLadder", () => {
  const run = async (body: object) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await saveClassLadder({ schoolId: 7, body, user: { id: 1 } }, res, jest.fn());
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };
  const schoolClasses = [
    { id: 1, name: "JSS1", campusId: 1, promotesToClassId: null },
    { id: 2, name: "JSS2", campusId: 1, promotesToClassId: null },
  ];

  beforeEach(() => {
    mockPrisma.class.findMany.mockResolvedValue(schoolClasses);
    mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockResolvedValue([]);
  });

  it("saves a valid ladder, scoped to the school", async () => {
    const { status } = await run({ classes: [{ classId: 1, promotesToClassId: 2, passMark: 45 }] });
    expect(status).toBe(200);
    expect(mockPrisma.class.updateMany).toHaveBeenCalledWith({
      where: { id: 1, schoolId: 7 },
      data: { promotesToClassId: 2, passMark: 45 },
    });
  });

  it("refuses a pass mark out of range, and a class from another school, before writing", async () => {
    expect((await run({ classes: [{ classId: 1, promotesToClassId: null, passMark: 150 }] })).status).toBe(400);
    expect((await run({ classes: [{ classId: 1, promotesToClassId: 99 }] })).status).toBe(400);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
  });
});

describe("deleteClass", () => {
  const run = async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await deleteClass({ schoolId: 7, params: { classId: "11" } }, res, jest.fn());
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };

  it("only finds a class in the admin's own school", async () => {
    mockPrisma.class.findFirst.mockResolvedValue(null);
    const { status } = await run();
    expect(status).toBe(404);
    expect(mockPrisma.class.findFirst.mock.calls[0][0].where).toEqual({ id: 11, schoolId: 7 });
  });

  it("keeps a class that past sessions' students were in", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: 11, students: [], assignments: [] });
    mockPrisma.studentEnrollment.count.mockResolvedValue(4);
    const { status, body } = await run();
    expect(status).toBe(400);
    expect(body.message).toContain("history");
    expect(mockPrisma.class.delete).not.toHaveBeenCalled();
  });

  it("clears other classes' links to it, then deletes", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: 11, students: [], assignments: [] });
    mockPrisma.studentEnrollment.count.mockResolvedValue(0);
    mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.teacherAssignment.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.class.delete.mockResolvedValue({});
    const { status } = await run();
    expect(status).toBe(200);
    expect(mockPrisma.class.updateMany).toHaveBeenCalledWith({
      where: { schoolId: 7, promotesToClassId: 11 },
      data: { promotesToClassId: null },
    });
  });
});

export {};
