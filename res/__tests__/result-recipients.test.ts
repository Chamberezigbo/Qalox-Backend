// A subject teacher picks the teacher to send results to, but only the class teacher the
// admin assigned for that class/group can receive them.
jest.mock("../util/prisma", () => ({
  class: { findFirst: jest.fn() },
  classGroup: { findFirst: jest.fn() },
  staff: { findMany: jest.fn(), findFirst: jest.fn() },
}));

import prisma from "../util/prisma";
import { TeacherService } from "../Services/teacher/TeacherService";

const db = prisma as unknown as {
  class: { findFirst: jest.Mock };
  classGroup: { findFirst: jest.Mock };
  staff: { findMany: jest.Mock; findFirst: jest.Mock };
};

const service = new TeacherService();

beforeEach(() => {
  jest.clearAllMocks();
  db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", customName: null, staffId: 30, campusId: null });
  db.staff.findMany.mockResolvedValue([
    { id: 10, name: "Ada" },
    { id: 30, name: "Zainab" },
    { id: 20, name: "Bola" },
  ]);
});

describe("getResultRecipients", () => {
  it("lists the school's teachers with the assigned class teacher first and flagged", async () => {
    const out = await service.getResultRecipients({ schoolId: 5, classId: 9 });
    expect(out.classTeacherId).toBe(30);
    expect(out.teachers.map((t: any) => t.name)).toEqual(["Zainab", "Ada", "Bola"]);
    expect(out.teachers[0].isClassTeacher).toBe(true);
    expect(out.teachers.slice(1).every((t: any) => !t.isClassTeacher)).toBe(true);
  });

  it("only looks at this school's staff", async () => {
    await service.getResultRecipients({ schoolId: 5, classId: 9 });
    expect(db.staff.findMany.mock.calls[0][0].where).toMatchObject({ schoolId: 5 });
  });

  it("reports no class teacher when none is assigned", async () => {
    db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", customName: null, staffId: null, campusId: null });
    const out = await service.getResultRecipients({ schoolId: 5, classId: 9 });
    expect(out.classTeacherId).toBeNull();
    expect(out.teachers.every((t: any) => !t.isClassTeacher)).toBe(true);
  });

  it("refuses a class of another school", async () => {
    db.class.findFirst.mockResolvedValue(null);
    await expect(service.getResultRecipients({ schoolId: 5, classId: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("limits a campus class to its campus's teachers, staff with no campus, and its class teacher", async () => {
    db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", customName: null, staffId: 30, campusId: 2 });
    await service.getResultRecipients({ schoolId: 5, classId: 9 });
    expect(db.staff.findMany.mock.calls[0][0].where.OR).toEqual([{ campusId: 2 }, { campusId: null }, { id: 30 }]);
  });
});

describe("sending to a chosen teacher", () => {
  const handTo = (recipientStaffId: number) =>
    (service as any).handToClassTeacher({
      staffId: 6, schoolId: 5, classId: 9, subjectId: 1, academicSessionId: 2, termId: 3, scope: 0, recipientStaffId,
    });

  it("refuses anyone who is not the class teacher of record", async () => {
    db.staff.findFirst.mockResolvedValue({ name: "Bola" });
    await expect(handTo(20)).rejects.toMatchObject({ code: "NOT_CLASS_TEACHER", statusCode: 400 });
  });
});

export {};
