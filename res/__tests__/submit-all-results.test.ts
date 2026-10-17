// Submitting results locks the scores until an admin approves a change, so
// doing it for every subject in one go is only safe if it leaves alone what
// should not be locked: subjects already submitted or published, and subjects
// with no scores entered at all. Single submission checks none of that.
jest.mock("../util/prisma", () => ({
  class: { findFirst: jest.fn() },
  teacherAssignment: { findMany: jest.fn(), findFirst: jest.fn() },
  resultSubmission: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  resultWorkflowEvent: { create: jest.fn() },
  publishedResult: { findFirst: jest.fn() },
  publishedResultRow: { count: jest.fn() },
  academicTerm: { findFirst: jest.fn() },
  cAResult: { count: jest.fn(), findMany: jest.fn() },
  examResult: { count: jest.fn(), findMany: jest.fn() },
  classGroup: { findMany: jest.fn(), findFirst: jest.fn() },
  student: { findMany: jest.fn(), groupBy: jest.fn() },
  subject: { findUnique: jest.fn() },
  staff: { findUnique: jest.fn() },
  userNotification: { create: jest.fn() },
  $transaction: jest.fn(),
}));

import prisma from "../util/prisma";
import { TeacherService } from "../Services/teacher/TeacherService";

const db = prisma as unknown as {
  class: { findFirst: jest.Mock };
  teacherAssignment: { findMany: jest.Mock; findFirst: jest.Mock };
  resultSubmission: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock; update: jest.Mock };
  resultWorkflowEvent: { create: jest.Mock };
  subject: { findUnique: jest.Mock };
  staff: { findUnique: jest.Mock };
  userNotification: { create: jest.Mock };
  $transaction: jest.Mock;
  publishedResult: { findFirst: jest.Mock };
  publishedResultRow: { count: jest.Mock };
  academicTerm: { findFirst: jest.Mock };
  cAResult: { count: jest.Mock; findMany: jest.Mock };
  examResult: { count: jest.Mock; findMany: jest.Mock };
  classGroup: { findMany: jest.Mock; findFirst: jest.Mock };
  student: { findMany: jest.Mock; groupBy: jest.Mock };
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
  // SS 1 has a class teacher (staff 99), who is not the submitting teacher (6).
  db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", staffId: 99 });
  assigned();
  db.resultSubmission.findFirst.mockResolvedValue(null);
  db.resultSubmission.findMany.mockResolvedValue([]);
  db.resultSubmission.update.mockResolvedValue({ id: 1 });
  db.resultWorkflowEvent.create.mockResolvedValue({});
  db.subject.findUnique.mockResolvedValue({ name: "Mathematics" });
  db.staff.findUnique.mockResolvedValue({ name: "Teacher" });
  db.userNotification.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.publishedResult.findFirst.mockResolvedValue(null);
  // Every submission is for a known term; the one INPUT names exists.
  db.academicTerm.findFirst.mockResolvedValue({ id: 3 });
  db.cAResult.count.mockResolvedValue(10);
  db.examResult.count.mockResolvedValue(10);
  db.resultSubmission.create.mockResolvedValue({ id: 1 });
  // Most classes have no groups, which is the case every test above assumes.
  // A class with no groups: one scope (the class itself), two active students in it.
  db.classGroup.findMany.mockResolvedValue([]);
  db.classGroup.findFirst.mockResolvedValue(null);
  db.student.groupBy.mockResolvedValue([{ classGroupId: null, _count: { _all: 2 } }]);
  db.student.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  db.publishedResultRow.count.mockResolvedValue(0);
  db.cAResult.findMany.mockResolvedValue([]);
  db.examResult.findMany.mockResolvedValue([]);
});

const service = () => new TeacherService();

describe("submitAllResults", () => {
  it("submits every subject the teacher is assigned in the class", async () => {
    const result = await service().submitAllResults(INPUT);

    expect(db.resultSubmission.create).toHaveBeenCalledTimes(3);
    expect(result.counts).toEqual({ submitted: 3, included: 0, skipped: 0, failed: 0 });
    expect(outcomes(result)).toEqual({
      Mathematics: "submitted",
      "English Language": "submitted",
      "Further Mathematics": "submitted",
    });
  });

  it("records the session, term and teacher on each submission", async () => {
    await service().submitAllResults(INPUT);

    expect(db.resultSubmission.create).toHaveBeenCalledWith({
      data: { classId: 9, subjectId: 5, academicSessionId: 2, staffId: 6, termId: 3, status: "SUBMITTED", classGroupId: 0 },
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
    db.resultSubmission.findMany.mockImplementation(async ({ where }: any) =>
      where.subjectId === 5 ? [{ id: 99, staffId: 6, status: "SUBMITTED" }] : []
    );

    const result = await service().submitAllResults(INPUT);

    expect(outcomes(result).Mathematics).toBe("already_submitted");
    expect(result.counts).toEqual({ submitted: 2, included: 0, skipped: 1, failed: 0 });
    expect(db.resultSubmission.create).toHaveBeenCalledTimes(2);
  });

  it("skips a subject whose results were already published", async () => {
    // Both of the group's students have a published row for English.
    db.publishedResultRow.count.mockImplementation(async ({ where }: any) =>
      where.publishedResult.subjectId === 6 ? 2 : 0
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

    expect(result.counts).toEqual({ submitted: 2, included: 0, skipped: 0, failed: 1 });
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
    expect(db.class.findFirst).toHaveBeenCalledWith({ where: { id: 9, schoolId: 5 }, select: { id: true, name: true, staffId: true } });
  });

  describe("when the class has groups", () => {
    // Each group has its own class teacher, so each is its own submission:
    // Group A being scored says nothing about Group B.
    const GROUPS = [
      { id: 1, name: "A", staffId: 99 },
      { id: 2, name: "B", staffId: 98 },
    ];
    const withGroups = () => {
      db.classGroup.findMany.mockResolvedValue(GROUPS);
      db.classGroup.findFirst.mockImplementation(async ({ where }: any) => GROUPS.find((g) => g.id === where.id) ?? null);
      db.student.groupBy.mockResolvedValue([
        { classGroupId: 1, _count: { _all: 10 } },
        { classGroupId: 2, _count: { _all: 10 } },
      ]);
    };

    it("submits every group separately, each to its own class teacher", async () => {
      withGroups();

      const result = await service().submitAllResults(INPUT);

      // 3 subjects x 2 groups
      expect(db.resultSubmission.create).toHaveBeenCalledTimes(6);
      const groupsUsed = db.resultSubmission.create.mock.calls.map((c: any) => c[0].data.classGroupId);
      expect(groupsUsed.filter((g: number) => g === 1)).toHaveLength(3);
      expect(groupsUsed.filter((g: number) => g === 2)).toHaveLength(3);
      expect(result.counts).toEqual({ submitted: 6, included: 0, skipped: 0, failed: 0 });
      expect(result.results.map((r) => r.groupName).sort()).toEqual(["A", "A", "A", "B", "B", "B"]);
    });

    it("submits only the named group", async () => {
      withGroups();

      const result = await service().submitAllResults({ ...INPUT, classGroupId: 2 });

      expect(result.counts.submitted).toBe(3);
      expect(db.resultSubmission.create.mock.calls.every((c: any) => c[0].data.classGroupId === 2)).toBe(true);
    });

    it("skips a group with no scores yet, without holding back the others", async () => {
      withGroups();
      // Scores exist for Group A's students only.
      db.cAResult.count.mockImplementation(async ({ where }: any) => (where.student.classGroupId === 1 ? 10 : 0));
      db.examResult.count.mockResolvedValue(0);

      const result = await service().submitAllResults(INPUT);

      const byScope = (name: string) => result.results.filter((r) => r.groupName === name).map((r) => r.outcome);
      expect(byScope("A")).toEqual(["submitted", "submitted", "submitted"]);
      expect(byScope("B")).toEqual(["no_scores", "no_scores", "no_scores"]);
    });

    it("skips only the group that has no class teacher, and says so", async () => {
      withGroups();
      db.classGroup.findMany.mockResolvedValue([{ id: 1, name: "A", staffId: 99 }, { id: 2, name: "B", staffId: null }]);

      const result = await service().submitAllResults(INPUT);

      expect(result.results.filter((r) => r.groupName === "B").every((r) => r.outcome === "no_class_teacher")).toBe(true);
      expect(result.counts.submitted).toBe(3);
    });

    it("refuses the whole batch only when no group has a class teacher", async () => {
      withGroups();
      db.classGroup.findMany.mockResolvedValue([{ id: 1, name: "A", staffId: null }, { id: 2, name: "B", staffId: null }]);
      db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", staffId: null });

      await expect(service().submitAllResults(INPUT)).rejects.toMatchObject({ code: "NO_CLASS_TEACHER" });
    });

    it("includes the submitter's own group automatically and sends the others on", async () => {
      withGroups();
      db.classGroup.findMany.mockResolvedValue([{ id: 1, name: "A", staffId: 6 }, { id: 2, name: "B", staffId: 98 }]);
      db.classGroup.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id, name: where.id === 1 ? "A" : "B", staffId: where.id === 1 ? 6 : 98 }));

      const result = await service().submitAllResults(INPUT);

      expect(result.counts).toEqual({ submitted: 3, included: 3, skipped: 0, failed: 0 });
    });

    it("includes students in no group as their own scope when the class has groups", async () => {
      withGroups();
      db.student.groupBy.mockResolvedValue([
        { classGroupId: 1, _count: { _all: 10 } },
        { classGroupId: 2, _count: { _all: 10 } },
        { classGroupId: null, _count: { _all: 3 } },
      ]);

      const result = await service().submitAllResults(INPUT);

      expect(result.results.filter((r) => r.groupName === null)).toHaveLength(3);
      expect(db.resultSubmission.create.mock.calls.filter((c: any) => c[0].data.classGroupId === 0)).toHaveLength(3);
    });

    it("refuses a group that is not in the class", async () => {
      withGroups();
      await expect(service().submitAllResults({ ...INPUT, classGroupId: 77 })).rejects.toThrow(/not in this class/i);
    });
  });
});

describe("submitResults — one subject, with the same readiness rules", () => {
  // Single submission used to check none of this, which is how a subject can
  // end up locked with no scores. It now refuses by default, but a teacher can
  // override on purpose (a group away, a subject with no assessments).
  const ONE = { staffId: 6, schoolId: 5, classId: 9, subjectId: 5, academicSessionId: 2, termId: 3 };

  beforeEach(() => {
    db.teacherAssignment.findFirst.mockResolvedValue({ id: 1 });
  });

  it("submits a subject whose scores are in", async () => {
    const result = await service().submitResults(ONE);

    expect(db.resultSubmission.create).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  it("refuses a subject with no scores, with a code the screen can act on", async () => {
    db.cAResult.count.mockResolvedValue(0);
    db.examResult.count.mockResolvedValue(0);

    await expect(service().submitResults(ONE)).rejects.toMatchObject({
      statusCode: 409,
      code: "SUBMISSION_NOT_READY",
      details: { reason: "no_scores" },
    });
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });

  it("needs a group when the class has several, since each has its own class teacher", async () => {
    db.classGroup.findMany.mockResolvedValue([{ id: 1, name: "A", staffId: 99 }, { id: 2, name: "B", staffId: 98 }]);
    db.student.groupBy.mockResolvedValue([
      { classGroupId: 1, _count: { _all: 10 } },
      { classGroupId: 2, _count: { _all: 10 } },
    ]);

    await expect(service().submitResults(ONE)).rejects.toMatchObject({ statusCode: 400, code: "GROUP_REQUIRED" });
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });

  it("submits one named group to that group's class teacher", async () => {
    db.classGroup.findMany.mockResolvedValue([{ id: 1, name: "A", staffId: 99 }, { id: 2, name: "B", staffId: 98 }]);
    db.student.groupBy.mockResolvedValue([
      { classGroupId: 1, _count: { _all: 10 } },
      { classGroupId: 2, _count: { _all: 10 } },
    ]);
    db.classGroup.findFirst.mockResolvedValue({ id: 2, name: "B", staffId: 98 });

    await service().submitResults({ ...ONE, classGroupId: 2 });

    expect(db.resultSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ classGroupId: 2, status: "SUBMITTED" }),
    });
    expect(db.userNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientId: 98 }),
    });
  });

  it("says a group has no class teacher before looking at its scores", async () => {
    db.classGroup.findFirst.mockResolvedValue({ id: 2, name: "B", staffId: null });
    db.cAResult.count.mockResolvedValue(0);
    db.examResult.count.mockResolvedValue(0);

    await expect(service().submitResults({ ...ONE, classGroupId: 2 })).rejects.toMatchObject({ code: "NO_CLASS_TEACHER" });
  });

  it("submits anyway when the teacher forces it", async () => {
    db.cAResult.count.mockResolvedValue(0);
    db.examResult.count.mockResolvedValue(0);

    await service().submitResults({ ...ONE, force: true });

    expect(db.resultSubmission.create).toHaveBeenCalledTimes(1);
  });

  it("never forces past a subject that was already submitted", async () => {
    db.resultSubmission.findMany.mockResolvedValue([{ id: 99, staffId: 6, status: "SUBMITTED" }]);

    await expect(service().submitResults({ ...ONE, force: true })).rejects.toThrow(/already submitted/i);
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });

  it("never forces past results that are already published", async () => {
    db.publishedResultRow.count.mockResolvedValue(2);

    await expect(service().submitResults({ ...ONE, force: true })).rejects.toThrow(/already been published/i);
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });

  it("still requires the teacher to be assigned to the subject", async () => {
    db.teacherAssignment.findFirst.mockResolvedValue(null);

    await expect(service().submitResults({ ...ONE, force: true })).rejects.toThrow(/not assigned/i);
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });
});

describe("handing results to the class teacher", () => {
  beforeEach(() => db.teacherAssignment.findFirst.mockResolvedValue({ id: 1 }));

  it("refuses everything when the class has no class teacher, and writes nothing", async () => {
    db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", staffId: null });

    await expect(service().submitAllResults(INPUT)).rejects.toMatchObject({ code: "NO_CLASS_TEACHER", statusCode: 409 });
    await expect(
      service().submitResults({ ...INPUT, subjectId: 5 })
    ).rejects.toMatchObject({ code: "NO_CLASS_TEACHER" });
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });

  it("does not submit the class teacher's own subjects: they are included automatically", async () => {
    db.class.findFirst.mockResolvedValue({ id: 9, name: "SS 1", staffId: 6 }); // the submitter IS the class teacher

    const bulk = await service().submitAllResults(INPUT);
    expect(bulk.counts).toEqual({ submitted: 0, included: 3, skipped: 0, failed: 0 });
    expect(outcomes(bulk).Mathematics).toBe("included_automatically");

    const single = await service().submitResults({ ...INPUT, subjectId: 5 });
    expect(single).toMatchObject({ included: true });
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
    expect(db.userNotification.create).not.toHaveBeenCalled();
  });

  it("sends a submission to the class's own teacher, and tells them", async () => {
    await service().submitResults({ ...INPUT, subjectId: 5 });

    expect(db.userNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientType: "teacher", recipientId: 99, type: "result_submitted" }),
    });
    expect(db.resultWorkflowEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "SUBMITTED", actorType: "teacher", actorId: 6 }),
    });
  });

  it("lets a RETURNED subject be submitted again, on the same row", async () => {
    db.resultSubmission.findMany.mockResolvedValue([{ id: 40, staffId: 6, status: "RETURNED" }]);
    db.resultSubmission.findFirst.mockResolvedValue({ id: 40, status: "RETURNED" });

    await service().submitResults({ ...INPUT, subjectId: 5 });

    expect(db.resultSubmission.create).not.toHaveBeenCalled();
    expect(db.resultSubmission.update).toHaveBeenCalledWith({
      where: { id: 40 },
      data: expect.objectContaining({ status: "SUBMITTED", returnComment: null }),
    });
    expect(db.resultWorkflowEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "RESUBMITTED" }) });
  });

  it("treats a subject already with the class teacher or accepted as submitted", async () => {
    for (const status of ["SUBMITTED", "ACCEPTED", "PENDING"]) {
      db.resultSubmission.findMany.mockResolvedValue([{ id: 1, staffId: 77, status }]); // even another teacher's row
      await expect(service().submitResults({ ...INPUT, subjectId: 5 })).rejects.toThrow("already submitted");
    }
    expect(db.resultSubmission.create).not.toHaveBeenCalled();
  });
});

export {};