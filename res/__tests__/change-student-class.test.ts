// The bulk "change class" action found students, the class and the group by
// bare id, so an admin could move another school's students — or move their own
// into another school's class — just by knowing ids. It also left the previous
// class's group on a student when none was given, and committed students one at
// a time, so a failure left a half-moved class. Promotion at the end of a
// session will lean on this, so it has to be right first.
jest.mock("../util/prisma", () => ({
  $transaction: jest.fn(),
  class: { findFirst: jest.fn() },
  campus: { findFirst: jest.fn() },
  classGroup: { findFirst: jest.fn() },
  student: { findMany: jest.fn(), updateMany: jest.fn() },
}));

jest.mock("../util/studentFeeSync", () => ({ syncStudentFeeInvoices: jest.fn() }));
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));
jest.mock("../Models/generateUniqueIdentifier", () => ({ generateUniqueIdentifier: jest.fn() }));

import prisma from "../util/prisma";
import { syncStudentFeeInvoices } from "../util/studentFeeSync";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
const fees = syncStudentFeeInvoices as jest.Mock;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { changeStudentClass } = require("../controller/admin/StudentController");

const SCHOOL = 5;
const NEW_CLASS = { id: 20, name: "SS 2", campusId: 2 };

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const run = async (body: Record<string, unknown>) => {
  const res = mockRes();
  const next = jest.fn();
  await changeStudentClass({ body, schoolId: SCHOOL }, res, next);
  return { res, next, status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  db.class.findFirst.mockResolvedValue(NEW_CLASS);
  db.campus.findFirst.mockResolvedValue({ id: 2 });
  db.classGroup.findFirst.mockResolvedValue({ id: 77 });
  db.student.findMany.mockImplementation(async ({ where }: any) =>
    // First call: the students being moved (select id + classId). Later call: the response include.
    where.id.in.map((id: number) => ({ id, classId: 10 }))
  );
  db.student.updateMany.mockResolvedValue({ count: 1 });
});

describe("changeStudentClass — staying within the admin's school", () => {
  it("looks the class up within the admin's school, so another school's class is not found", async () => {
    db.class.findFirst.mockResolvedValue(null);

    const { status, body } = await run({ studentIds: [1], classId: 99 });

    expect(db.class.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 99, schoolId: SCHOOL } })
    );
    expect(status).toBe(404);
    expect(body.message).toBe("Class not found");
    expect(db.student.updateMany).not.toHaveBeenCalled();
  });

  it("only ever selects students from this school", async () => {
    await run({ studentIds: [1, 2], classId: 20 });

    expect(db.student.findMany.mock.calls[0][0].where).toEqual({ id: { in: [1, 2] }, schoolId: SCHOOL });
  });

  it("refuses the whole batch if any student is not in this school", async () => {
    // Student 2 belongs to another school, so the school-scoped lookup does not return it.
    db.student.findMany.mockResolvedValueOnce([{ id: 1, classId: 10 }]);

    const { status, body } = await run({ studentIds: [1, 2], classId: 20 });

    expect(status).toBe(400);
    expect(body.errors).toEqual([{ studentId: 2, message: "Student with ID 2 not found" }]);
    expect(body.message).toMatch(/no changes were made/i);
    expect(db.student.updateMany).not.toHaveBeenCalled();
  });

  it("scopes the update itself to the school as well", async () => {
    await run({ studentIds: [1], classId: 20 });

    expect(db.student.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1] }, schoolId: SCHOOL } })
    );
  });

  it("looks the campus up within the school", async () => {
    db.campus.findFirst.mockResolvedValue(null);

    const { status } = await run({ studentIds: [1], classId: 20, campusId: 9 });

    expect(db.campus.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9, schoolId: SCHOOL } })
    );
    expect(status).toBe(404);
  });
});

describe("changeStudentClass — groups", () => {
  it("clears the old group when a student moves to a class and none is chosen", async () => {
    await run({ studentIds: [1], classId: 20 });

    // A group belongs to a class; keeping the old one showed the student under a
    // group that is not in their new class.
    expect(db.student.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ classId: 20, classGroupId: null }) })
    );
  });

  it("treats a group id of 0 — what the form sends for 'none' — as no group", async () => {
    await run({ studentIds: [1], classId: 20, groupId: 0 });

    expect(db.classGroup.findFirst).not.toHaveBeenCalled();
    expect(db.student.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ classGroupId: null }) })
    );
  });

  it("puts students in the group that was chosen", async () => {
    await run({ studentIds: [1], classId: 20, groupId: 77 });

    expect(db.student.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ classGroupId: 77 }) })
    );
  });

  it("only accepts a group that belongs to the class being moved into", async () => {
    db.classGroup.findFirst.mockResolvedValue(null);

    const { status } = await run({ studentIds: [1], classId: 20, groupId: 5 });

    expect(db.classGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, classId: 20 } })
    );
    expect(status).toBe(404);
    expect(db.student.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the group of a student who is already in the class, when only the class is named", async () => {
    // How an admin changes just a group: same class, no new group given.
    db.student.findMany.mockImplementationOnce(async ({ where }: any) =>
      where.id.in.map((id: number) => ({ id, classId: 20 }))
    );

    await run({ studentIds: [1], classId: 20 });

    const data = db.student.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("classGroupId");
  });

  it("changes the group of a student already in the class when a new one is chosen", async () => {
    db.student.findMany.mockImplementationOnce(async ({ where }: any) =>
      where.id.in.map((id: number) => ({ id, classId: 20 }))
    );

    await run({ studentIds: [1], classId: 20, groupId: 77 });

    expect(db.student.updateMany.mock.calls[0][0].data).toMatchObject({ classGroupId: 77 });
  });

  it("handles movers and stayers in one batch with one statement each", async () => {
    db.student.findMany.mockImplementationOnce(async () => [
      { id: 1, classId: 10 }, // moving
      { id: 2, classId: 20 }, // already there
    ]);

    await run({ studentIds: [1, 2], classId: 20 });

    expect(db.student.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("changeStudentClass — campus", () => {
  it("takes the campus from the class when none is named", async () => {
    await run({ studentIds: [1], classId: 20 });

    expect(db.student.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ campusId: 2 }) })
    );
  });

  it("refuses a campus that is not the class's own", async () => {
    db.campus.findFirst.mockResolvedValue({ id: 3 });

    const { status, body } = await run({ studentIds: [1], classId: 20, campusId: 3 });

    expect(status).toBe(400);
    expect(body.message).toBe("This class belongs to a different campus");
    expect(db.student.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a student's campus alone when the class has none", async () => {
    db.class.findFirst.mockResolvedValue({ ...NEW_CLASS, campusId: null });

    await run({ studentIds: [1], classId: 20 });

    expect(db.student.updateMany.mock.calls[0][0].data).not.toHaveProperty("campusId");
  });
});

describe("changeStudentClass — the batch", () => {
  it("runs inside one transaction", async () => {
    await run({ studentIds: [1, 2, 3], classId: 20 });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("applies the move in a single statement, not one per student", async () => {
    await run({ studentIds: [1, 2, 3, 4, 5], classId: 20 });

    expect(db.student.updateMany).toHaveBeenCalledTimes(1);
    expect(db.student.updateMany.mock.calls[0][0].where.id.in).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a repeated id once", async () => {
    await run({ studentIds: [1, 1, 2], classId: 20 });

    expect(db.student.findMany.mock.calls[0][0].where.id.in).toEqual([1, 2]);
  });

  it("invoices the new class's fees for students who moved, after the move is committed", async () => {
    await run({ studentIds: [1, 2], classId: 20 });

    expect(fees).toHaveBeenCalledTimes(2);
    expect(fees).toHaveBeenCalledWith(prisma, { id: 1, schoolId: SCHOOL, classId: 20 });
  });

  it("does not re-invoice students who were already in the class", async () => {
    db.student.findMany.mockImplementationOnce(async () => [{ id: 1, classId: 20 }]);

    await run({ studentIds: [1], classId: 20 });

    expect(fees).not.toHaveBeenCalled();
  });

  it("rejects an empty list and a missing class", async () => {
    expect((await run({ studentIds: [], classId: 20 })).status).toBe(400);
    expect((await run({ studentIds: [1] })).status).toBe(400);
  });

  it("rejects ids that are not numbers", async () => {
    const { status, body } = await run({ studentIds: ["abc"], classId: 20 });

    expect(status).toBe(400);
    expect(body.message).toBe("Student IDs must be numbers");
  });

  it("reports success with the moved students", async () => {
    const { status, body } = await run({ studentIds: [1], classId: 20 });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/moved to class SS 2/);
  });
});
