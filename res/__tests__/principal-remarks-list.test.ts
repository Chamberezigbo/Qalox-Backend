// The admin can write a principal's remark for any class, not only ones submitted through
// Class Results. The list is the class's students with what is saved, scoped to the school
// and (for a campus-restricted admin) to their campuses.
/* eslint-disable @typescript-eslint/no-var-requires */
const mockPrisma: any = {
  class: { findFirst: jest.fn() },
  academicTerm: { findFirst: jest.fn() },
  student: { findMany: jest.fn() },
  studentTermRemark: { findMany: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));

const Workflow = require("../Services/ResultWorkflowService");

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", customName: "." });
  mockPrisma.academicTerm.findFirst.mockResolvedValue({ id: 1, name: "First Term", sessionId: 2 });
  mockPrisma.student.findMany.mockResolvedValue([
    { id: 16, name: "joy", surname: "emmanuel", otherNames: null, registrationNumber: "R16" },
    { id: 41, name: "Temilade", surname: "Adebayo", otherNames: null, registrationNumber: "R41" },
  ]);
  mockPrisma.studentTermRemark.findMany.mockResolvedValue([{ studentId: 41, classTeacherRemark: "Good", principalRemark: "Well done" }]);
});

describe("listPrincipalRemarks", () => {
  it("lists every active student of the class with the remarks saved so far", async () => {
    const out = await Workflow.listPrincipalRemarks({ schoolId: 5, classId: 9 });
    expect(out.label).toBe("SS 1"); // a custom name of just punctuation is not shown
    expect(out.termName).toBe("First Term");
    expect(out.students).toEqual([
      expect.objectContaining({ studentId: 16, principalRemark: "", classTeacherRemark: "" }),
      expect.objectContaining({ studentId: 41, principalRemark: "Well done", classTeacherRemark: "Good" }),
    ]);
  });

  it("asks only for this school's active students of the session", async () => {
    await Workflow.listPrincipalRemarks({ schoolId: 5, classId: 9 });
    expect(mockPrisma.student.findMany.mock.calls[0][0].where).toMatchObject({ schoolId: 5, classId: 9, academicSessionId: 2, status: "active" });
  });

  it("limits to one group, or the students in no group, when asked", async () => {
    await Workflow.listPrincipalRemarks({ schoolId: 5, classId: 9, classGroupId: 4 });
    expect(mockPrisma.student.findMany.mock.calls[0][0].where).toMatchObject({ classGroupId: 4 });
    await Workflow.listPrincipalRemarks({ schoolId: 5, classId: 9, classGroupId: 0 });
    expect(mockPrisma.student.findMany.mock.calls[1][0].where).toMatchObject({ classGroupId: null });
  });

  it("applies a campus-restricted admin's reach to the class and the students", async () => {
    const classScope = { campusId: { in: [2] } };
    const studentScope = { OR: [{ campusId: { in: [2] } }] };
    await Workflow.listPrincipalRemarks({ schoolId: 5, classId: 9, classScope, studentScope });
    expect(mockPrisma.class.findFirst.mock.calls[0][0].where).toMatchObject({ id: 9, schoolId: 5, campusId: { in: [2] } });
    expect(mockPrisma.student.findMany.mock.calls[0][0].where.OR).toEqual(studentScope.OR);
  });

  it("reads another campus's (or school's) class as not found", async () => {
    mockPrisma.class.findFirst.mockResolvedValue(null);
    await expect(Workflow.listPrincipalRemarks({ schoolId: 5, classId: 99 })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.student.findMany).not.toHaveBeenCalled();
  });
});

export {};
