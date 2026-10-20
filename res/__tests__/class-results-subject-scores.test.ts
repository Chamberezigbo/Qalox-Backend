// The class teacher can look at a subject's scores before accepting or returning it, and a
// class whose custom name is just punctuation reads as the plain class name.
/* eslint-disable @typescript-eslint/no-var-requires */
const mockOverview = jest.fn();
const mockBroadsheet = jest.fn();
jest.mock("../Services/ResultWorkflowService", () => ({ classOverview: (...a: unknown[]) => mockOverview(...a) }));
jest.mock("../Services/AssessmentService", () => ({
  AssessmentService: class { computeBroadsheet(...a: unknown[]) { return mockBroadsheet(...a); } },
}));
jest.mock("../util/prisma", () => ({}));
jest.mock("../util/sendPdf", () => ({ sendPdf: jest.fn() }));
jest.mock("../util/reportCardPdf", () => ({ buildReportCardsPdf: jest.fn(), buildBroadsheetPdf: jest.fn() }));

const { classDisplayName, usableCustomName } = require("../util/classLabel");
const controller = require("../controller/teacher/ClassResultController");

const run = async (query: object, staffId: number | undefined = 3) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await controller.subjectScores({ schoolId: 5, staffId, query }, res, jest.fn());
  return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  jest.resetAllMocks();
  mockOverview.mockResolvedValue({
    academicSessionId: 2, termId: 3,
    subjects: [{ subjectId: 7, name: "Mathematics", state: "submitted", teachers: ["Mr Atiba"], submissionId: 11, submittedBy: "Mr Atiba", submittedAt: "2026-10-01", actions: { accept: true, return: true } }],
  });
  mockBroadsheet.mockResolvedValue({
    rows: [
      { studentId: 2, studentName: "Zed Bako", registrationNumber: "R2", scores: { Mathematics: { caTotal: 20, examTotal: 50, subjectTotal: 70, grade: "A", remark: "Good" } } },
      { studentId: 1, studentName: "Ada Obi", registrationNumber: "R1", scores: { Mathematics: { caTotal: 10, examTotal: 30, subjectTotal: 40, grade: "C", remark: null } } },
    ],
  });
});

describe("classDisplayName", () => {
  it("drops a custom name that is only punctuation", () => {
    expect(classDisplayName("SS 2", ".")).toBe("SS 2");
    expect(classDisplayName("SS 2", " - ")).toBe("SS 2");
    expect(classDisplayName("SS 2", "")).toBe("SS 2");
    expect(classDisplayName("SS 2", null)).toBe("SS 2");
    expect(usableCustomName("...")).toBeNull();
  });

  it("keeps a real custom name", () => {
    expect(classDisplayName("SS 2", "Science")).toBe("SS 2 — Science");
    expect(classDisplayName("SS 2", "A1")).toBe("SS 2 — A1");
  });
});

describe("subject scores", () => {
  it("returns the subject's scores for the group's students, sorted by name, with the review actions", async () => {
    const { body } = await run({ classId: "9", subjectId: "7" });
    expect(body.data.subjectName).toBe("Mathematics");
    expect(body.data.rows.map((r: any) => r.studentName)).toEqual(["Ada Obi", "Zed Bako"]);
    expect(body.data.rows[1]).toMatchObject({ caTotal: 20, examTotal: 50, subjectTotal: 70, grade: "A" });
    expect(body.data.actions).toEqual({ accept: true, return: true });
    expect(body.data.submittedBy).toBe("Mr Atiba");
  });

  it("asks the class-teacher check first, with the group's scope", async () => {
    await run({ classId: "9", subjectId: "7", classGroupId: "4" });
    expect(mockOverview).toHaveBeenCalledWith(expect.objectContaining({ schoolId: 5, staffId: 3, classId: 9, classGroupId: 4 }));
    expect(mockBroadsheet).toHaveBeenCalledWith(expect.objectContaining({ subjectIds: [7], classGroupId: 4 }));
  });

  it("is refused for anyone who is not the class teacher", async () => {
    mockOverview.mockRejectedValue(Object.assign(new Error("You are not the class teacher of this class"), { statusCode: 403 }));
    const { status, body } = await run({ classId: "9", subjectId: "7" });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(mockBroadsheet).not.toHaveBeenCalled();
  });

  it("does not know a subject that is not taught in the class", async () => {
    const { status } = await run({ classId: "9", subjectId: "99" });
    expect(status).toBe(404);
    expect(mockBroadsheet).not.toHaveBeenCalled();
  });

  it("needs a class and a subject", async () => {
    expect((await run({ classId: "9" })).status).toBe(400);
  });
});

export {};
