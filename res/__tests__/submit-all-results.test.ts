// Submitting results locks the scores until an admin approves a change, so
// doing it for every subject in one go is only safe if it leaves alone what
// should not be locked: subjects already submitted or published, and subjects
// with no scores entered at all. Single submission checks none of that.
jest.mock("../util/prisma", () => ({
  class: { findFirst: jest.fn() },
  teacherAssignment: { findMany: jest.fn(), findFirst: jest.fn() },
  resultSubmission: { findFirst: jest.fn(), create: jest.fn() },
  publishedResult: { findUnique: jest.fn() },
  cAResult: { count: jest.fn(), findMany: jest.fn() },
  examResult: { count: jest.fn(), findMany: jest.fn() },
  classGroup: { findMany: jest.fn() },
  student: { findMany: jest.fn() },
}));

import prisma from "../util/prisma";
import { TeacherService } from "../Services/teacher/TeacherService";

const db = prisma as unknown as {
  class: { findFirst: jest.Mock };
  teacherAssignment: { findMany: jest.Mock };
  resultSubmission: { findFirst: jest.Mock; create: jest.Mock };
  publishedResult: { findUnique: jest.Mock };
  cAResult: { count: jest.Mock; findMany: jest.Mock };
  examResult: { count: jest.Mock; findMany: jest.Mock };
  classGroup: { findMany: jest.Mock };
  student: { findMany: jest.Mock };
};

const INPUT = { staffId: 6, schoolId: 5, classId: 9, academicSessionId: 2, termId: 3 };

/** The teacher's assignments in the class: Mathematics, English, Further Maths. */
const assigned = (subjects: Array<[number, string]> = [[5, "Mathematics"], [6, "English Language"], [7, "Further Mathematics"]]) =>
  db.teacherAssignment.findMany.mockResolvedValue(
    subjects.map(([subjectId, name]) => ({ subjectId, subject: { name } }))
  );

const outcomes = (result: { results: Array<{ subjectName: string; outcome: string }> }) =>
  Object.fromEntries(result.results.map((r) => [r.subjectName, r.outcome]));

beforeEach(() => {
  jest.clearAllMocks();
  db.class.findFirst.mockResolvedValue({ id: 9 });
  assigned();
  db.resultSubmission.findFirst.mockResolvedValue(null);
  db.publishedResult.findUnique.mockResolvedValue(null);
  db.cAResult.count.mockResolvedValue(10);
  db.examResult.count.mockResolvedValue(10);
  db.resultSubmission.create.mockResolvedValue({ id: 1 });
  // Most classes have no groups, which is the case every test above assumes.
  db.classGroup.findMany.mockResolvedValue([]);
  db.student.findMany.mockResolvedValue([]);
  db.cAResult.findMany.mockResolvedValue([]);
  db.examResult.findMany.mockResolvedValue([]);
});

const service = () => new TeacherService();

describe("submitAllResults", () => {
  it("submits every subject the teacher is assigned in the class", async () => {
    const result = await service().submitAllResults(INPUT);

    expect(db.resultSubmission.create).toHaveBeenCalledTimes(3);
    expect(result.counts).toEqual({ submitted: 3, skipped: 0, failed: 0 });
    expect(outcomes(result)).toEqual({
      Mathematics: "submitted",
      "English Language": "submitted",
      "Further Mathematics": "submitted",
    });
  });

  it("records the session, term and teacher on each submission", async () => {
    await service().submitAllResults(INPUT);

    expect(db.resultSubmission.create).toHaveBeenCalledWith({
      data: { classId: 9, subjectId: 5, academicSessionId: 2, staffId: 6, termId: 3 },
    });
  });

  it("only touches the subjects this teacher is assigned, never the whole class", async () => {
    await service().submitAllResults(INPUT);

    expect(db.teacherAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId: 6, classId: 9, subjectId: { not: null } } })
    );
  });

  it("skips a subject that was already submitted, rather than failing", async () => {
    // Pressing the button twice, or after a partial run, must be harmless.
    db.resultSubmission.findFirst.mockImplementation(async ({ where }: any) =>
      where.subjectId === 5 ? { id: 99 } : null
    );

    const result = await service().submitAllResults(INPUT);

    expect(outcomes(result).Mathematics).toBe("already_submitted");
    expect(result.counts).toEqual({ submitted: 2, skipped: 1, failed: 0 });
    expect(db.resultSubmission.create).toHaveBeenCalledTimes(2);
  });

  it("skips a subject whose results were already published", async () => {
    db.publishedResult.findUnique.mockImplementation(async ({ where }: any) =>
      where.classId_subjectId_academicSessionId.subjectId === 6 ? { id: 1 } : null
    );

    const result = await service().submitAllResults(INPUT);

    expect(outcomes(result)["English Language"]).toBe("already_published");
    expect(db.resultSubmission.create).toHaveBeenCalledTimes(2);
  });

  it("will not lock a subject with no scores entered at all", async () => {
    // Locking an empty subject would put a blank result in front of the admin.
    db.cAResult.count.mockImplementation(async ({ where }: any) => (where.ca.subjectId === 7 ? 0 : 10));
    db.examResult.count.mockImplementation(async ({ where }: any) => (where.exam.subjectId === 7 ? 0 : 10));

    const result = await service().submitAllResults(INPUT);

    expect(outcomes(result)["Further Mathematics"]).toBe("no_scores");
    expect(result.results.find((r) => r.outcome === "no_scores")?.message).toMatch(/no ca or exam scores/i);
    expect(db.resultSubmission.create).toHaveBeenCalledTimes(2);
  });

  it("accepts a subject that has only CA scores, or only exam scores", async () => {
    db.cAResult.count.mockImplementation(async ({ where }: any) => (where.ca.subjectId === 5 ? 4 : 0));
    db.examResult.count.mockImplementation(async ({ where }: any) => (where.exam.subjectId === 6 ? 4 : 0));

    const result = await service().submitAllResults(INPUT);

    expect(outcomes(result).Mathematics).toBe("submitted");
    expect(outcomes(result)["English Language"]).toBe("submitted");
    expect(outcomes(result)["Further Mathematics"]).toBe("no_scores");
  });

  it("lets one failure stand without stopping the others", async () => {
    db.resultSubmission.create
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error("database went away"))
      .mockResolvedValueOnce({ id: 3 });

    const result = await service().submitAllResults(INPUT);

    expect(result.counts).toEqual({ submitted: 2, skipped: 0, failed: 1 });
    expect(result.results.filter((r) => r.outcome === "failed")[0].message).toBe("database went away");
  });

  it("treats losing a race on the unique key as already submitted, not a fault", async () => {
    db.resultSubmission.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));

    const result = await service().submitAllResults(INPUT);

    expect(result.counts.failed).toBe(0);
    expect(result.results.map((r) => r.outcome)).toContain("already_submitted");
  });

  it("counts a subject assigned on more than one campus once", async () => {
    assigned([[5, "Mathematics"], [5, "Mathematics"], [6, "English Language"]]);

    const result = await service().submitAllResults(INPUT);

    expect(result.results).toHaveLength(2);
    expect(db.resultSubmission.create).toHaveBeenCalledTimes(2);
  });

  it("lists subjects alphabetically so the summary reads predictably", async () => {
    const result = await service().submitAllResults(INPUT);

    expect(result.results.map((r) => r.subjectName)).toEqual([
      "English Language",
      "Further Mathematics",
      "Mathematics",
    ]);
  });

  it("refuses a teacher who has no subject in the class", async () => {
    assigned([]);

    await expect(service().submitAllResults(INPUT)).rejects.toThrow(/not assigned/i);
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });

  it("refuses a class that is not in the teacher's school", async () => {
    db.class.findFirst.mockResolvedValue(null);

    await expect(service().submitAllResults(INPUT)).rejects.toThrow("Class not found");
    expect(db.class.findFirst).toHaveBeenCalledWith({ where: { id: 9, schoolId: 5 }, select: { id: true } });
  });

  describe("when the class has groups", () => {
    // A group only filters who the teacher sees while entering scores, so a
    // class can end up with Group A scored and Group B untouched.
    const groups = () =>
      db.classGroup.findMany.mockResolvedValue([
        { id: 1, name: "PINK CLASS" },
        { id: 2, name: "yellow arms" },
      ]);

    /** Students 1-2 in PINK, 3 in yellow, 4-9 not placed in any group. */
    const students = () =>
      db.student.findMany.mockResolvedValue([
        { id: 1, classGroupId: 1 },
        { id: 2, classGroupId: 1 },
        { id: 3, classGroupId: 2 },
      ]);

    const scoredStudents = (...ids: number[]) =>
      db.cAResult.findMany.mockResolvedValue(ids.map((studentId) => ({ studentId })));

    it("holds a subject back when a whole group has no scores", async () => {
      groups();
      students();
      scoredStudents(1, 2); // PINK CLASS entered, yellow arms not

      const result = await service().submitAllResults(INPUT);

      expect(outcomes(result).Mathematics).toBe("incomplete");
      expect(result.results[0].message).toBe("No scores entered yet for yellow arms");
      expect(db.resultSubmission.create).not.toHaveBeenCalled();
    });

    it("counts a held-back subject as skipped, not failed", async () => {
      groups();
      students();
      scoredStudents(1, 2);

      const result = await service().submitAllResults(INPUT);

      expect(result.counts).toEqual({ submitted: 0, skipped: 3, failed: 0 });
    });

    it("names every group that is missing scores", async () => {
      groups();
      students();
      db.cAResult.findMany.mockResolvedValue([{ studentId: 99 }]); // someone elsewhere

      const result = await service().submitAllResults(INPUT);

      expect(result.results[0].message).toBe("No scores entered yet for PINK CLASS, yellow arms");
    });

    it("submits once every group has at least one score", async () => {
      groups();
      students();
      scoredStudents(1, 3);

      const result = await service().submitAllResults(INPUT);

      expect(result.counts.submitted).toBe(3);
    });

    it("does not hold a subject back over one absent student", async () => {
      // Student 2 has no score, but PINK CLASS is otherwise scored.
      groups();
      students();
      scoredStudents(1, 3);

      const result = await service().submitAllResults(INPUT);

      expect(outcomes(result).Mathematics).toBe("submitted");
    });

    it("counts a score from either the CA or the exam side", async () => {
      groups();
      students();
      db.cAResult.findMany.mockResolvedValue([{ studentId: 1 }]);
      db.examResult.findMany.mockResolvedValue([{ studentId: 3 }]);

      const result = await service().submitAllResults(INPUT);

      expect(outcomes(result).Mathematics).toBe("submitted");
    });

    it("ignores students who are not in any group", async () => {
      // Real data: SS 1 has 6 of its 9 students unplaced. Treating them as a
      // group that needs scores would block bulk submission there for good.
      groups();
      students();
      scoredStudents(1, 3); // the six unplaced students have no scores

      const result = await service().submitAllResults(INPUT);

      expect(outcomes(result).Mathematics).toBe("submitted");
      expect(db.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { classId: 9, classGroupId: { not: null } } })
      );
    });

    it("ignores a group nobody is in", async () => {
      db.classGroup.findMany.mockResolvedValue([
        { id: 1, name: "PINK CLASS" },
        { id: 2, name: "yellow arms" },
        { id: 3, name: "empty group" },
      ]);
      students();
      scoredStudents(1, 3);

      const result = await service().submitAllResults(INPUT);

      expect(outcomes(result).Mathematics).toBe("submitted");
    });

    it("never looks at students or scores when the class has no groups", async () => {
      await service().submitAllResults(INPUT);

      expect(db.student.findMany).not.toHaveBeenCalled();
      expect(db.cAResult.findMany).not.toHaveBeenCalled();
    });
  });
});
