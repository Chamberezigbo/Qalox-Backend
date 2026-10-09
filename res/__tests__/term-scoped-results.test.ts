// A result belongs to a term, not just a session. Results were keyed by session
// alone, so Second Term would have overwritten First Term's scores, been refused
// publication because First Term was published, and been summed together with it
// in every broadsheet and report card. It never showed because production has
// only ever had a First Term. These tests pin down that a second term is
// independent of the first.
jest.mock("../util/prisma", () => ({
  $transaction: jest.fn(),
  academicTerm: { findFirst: jest.fn() },
  academicSession: { findFirst: jest.fn() },
  continuousAssessment: { findUnique: jest.fn() },
  exam: { findUnique: jest.fn() },
  teacherAssignment: { findFirst: jest.fn() },
  cAResult: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  examResult: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  resultSubmission: { findFirst: jest.fn(), deleteMany: jest.fn() },
  publishedResult: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  publishedResultRow: { createMany: jest.fn() },
  userNotification: { createMany: jest.fn() },
  parentAlert: { createMany: jest.fn() },
  class: { findFirst: jest.fn() },
  subject: { findFirst: jest.fn() },
  student: { findUnique: jest.fn(), findMany: jest.fn() },
  classSubject: { findMany: jest.fn() },
}));

import prisma from "../util/prisma";
import { TeacherService } from "../Services/teacher/TeacherService";
import { AssessmentService } from "../Services/AssessmentService";
import { StudentResultService } from "../Services/student/StudentResultService";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };

const TERM_1 = 1;
const TERM_2 = 2;
const SESSION = 5;
const SCHOOL = 7;

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  // Any term id the code asks about belongs to this school and session.
  db.academicTerm.findFirst.mockImplementation(async ({ where }: any) =>
    where.id ? { id: where.id } : where.isActive ? { id: TERM_2 } : { id: TERM_2 }
  );
});

describe("saving CA scores in a second term", () => {
  const entry = { studentId: 11, caId: 21, score: 8 };
  const save = (termId?: number) =>
    new TeacherService().upsertCAScores({
      staffId: 3, schoolId: SCHOOL, academicSessionId: SESSION, termId, entries: [entry],
    });

  beforeEach(() => {
    db.continuousAssessment.findUnique.mockResolvedValue({
      id: 21, classId: 9, subjectId: 5, maxScore: 10, class: { schoolId: SCHOOL },
    });
    db.teacherAssignment.findFirst.mockResolvedValue({ id: 1 });
    db.resultSubmission.findFirst.mockResolvedValue(null);
    db.publishedResult.findFirst.mockResolvedValue(null);
    db.cAResult.findFirst.mockResolvedValue(null);
    db.cAResult.create.mockResolvedValue({});
  });

  it("creates a new row for the new term instead of overwriting the first term's", async () => {
    // Student 11 already has a Term 1 score for this CA.
    db.cAResult.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_1 ? { id: 100 } : null
    );

    await save(TERM_2);

    expect(db.cAResult.update).not.toHaveBeenCalled();
    expect(db.cAResult.create).toHaveBeenCalledWith({
      data: { studentId: 11, caId: 21, academicSessionId: SESSION, score: 8, termId: TERM_2 },
    });
  });

  it("looks the existing row up within the term being saved", async () => {
    await save(TERM_2);

    expect(db.cAResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ termId: TERM_2 }) })
    );
  });

  it("still updates a score within the same term", async () => {
    db.cAResult.findFirst.mockResolvedValue({ id: 100 });

    await save(TERM_2);

    expect(db.cAResult.update).toHaveBeenCalledWith({ where: { id: 100 }, data: { score: 8 } });
    expect(db.cAResult.create).not.toHaveBeenCalled();
  });

  it("is not blocked by a First Term submission or publication", async () => {
    db.resultSubmission.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_1 ? { id: 1 } : null
    );
    db.publishedResult.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_1 ? { id: 1 } : null
    );

    await expect(save(TERM_2)).resolves.toMatchObject({ updated: 1 });
  });

  it("is still locked by a submission for the same term", async () => {
    db.resultSubmission.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_2 ? { id: 1 } : null
    );

    await expect(save(TERM_2)).rejects.toThrow(/locked/i);
  });

  it("is still locked by a publication for the same term", async () => {
    db.publishedResult.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_2 ? { id: 1 } : null
    );

    await expect(save(TERM_2)).rejects.toThrow(/permanently locked/i);
  });

  it("uses the active term when none is given, rather than leaving it open", async () => {
    await save(undefined);

    expect(db.cAResult.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ termId: TERM_2 }) })
    );
  });

  it("refuses a term that is not part of this school's session", async () => {
    db.academicTerm.findFirst.mockResolvedValue(null);

    await expect(save(99)).rejects.toThrow("Term not found for this session");
    expect(db.cAResult.create).not.toHaveBeenCalled();
  });

  it("refuses to save when no term is active and none was named", async () => {
    db.academicTerm.findFirst.mockResolvedValue(null);

    await expect(save(undefined)).rejects.toThrow(/no active term/i);
  });
});

describe("saving exam scores in a second term", () => {
  const save = (termId?: number) =>
    new TeacherService().upsertExamScores({
      staffId: 3, schoolId: SCHOOL, academicSessionId: SESSION, termId,
      entries: [{ studentId: 11, examId: 31, score: 50 }],
    });

  beforeEach(() => {
    db.exam.findUnique.mockResolvedValue({
      id: 31, classId: 9, subjectId: 5, maxScore: 60, class: { schoolId: SCHOOL },
    });
    db.teacherAssignment.findFirst.mockResolvedValue({ id: 1 });
    db.resultSubmission.findFirst.mockResolvedValue(null);
    db.publishedResult.findFirst.mockResolvedValue(null);
    db.examResult.findFirst.mockResolvedValue(null);
    db.examResult.create.mockResolvedValue({});
  });

  it("creates a new row for the new term instead of overwriting the first term's", async () => {
    db.examResult.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_1 ? { id: 200 } : null
    );

    await save(TERM_2);

    expect(db.examResult.update).not.toHaveBeenCalled();
    expect(db.examResult.create).toHaveBeenCalledWith({
      data: { studentId: 11, examId: 31, academicSessionId: SESSION, score: 50, termId: TERM_2 },
    });
  });

  it("is not blocked by a First Term publication", async () => {
    db.publishedResult.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_1 ? { id: 1 } : null
    );

    await expect(save(TERM_2)).resolves.toMatchObject({ updated: 1 });
  });
});

describe("publishing results for a term", () => {
  const PUBLISH = { classId: 9, subjectId: 5, academicSessionId: SESSION, schoolId: SCHOOL, adminId: 2 };

  const broadsheet = {
    rows: [{ studentId: 11, position: 1, scores: { Maths: { caTotal: 20, examTotal: 50, subjectTotal: 70, grade: "A" } } }],
  };

  const setup = () => {
    const service = new AssessmentService();
    const compute = jest.spyOn(service, "computeBroadsheet").mockResolvedValue(broadsheet as any);
    db.class.findFirst.mockResolvedValue({ id: 9 });
    db.subject.findFirst.mockResolvedValue({ id: 5, name: "Maths" });
    db.publishedResult.findFirst.mockResolvedValue(null);
    db.publishedResult.create.mockResolvedValue({ id: 50, publishedAt: new Date() });
    db.student.findMany.mockResolvedValue([]);
    return { service, compute };
  };

  it("publishes Second Term even though First Term is already published", async () => {
    const { service } = setup();
    db.publishedResult.findFirst.mockImplementation(async ({ where }: any) =>
      where.termId === TERM_1 ? { id: 1 } : null
    );

    await expect(service.publishResults({ ...PUBLISH, termId: TERM_2 })).resolves.toMatchObject({ termId: TERM_2 });
  });

  it("refuses to publish the same term twice", async () => {
    const { service } = setup();
    db.publishedResult.findFirst.mockResolvedValue({ id: 1 });

    await expect(service.publishResults({ ...PUBLISH, termId: TERM_2 })).rejects.toThrow(/already been published/i);
    expect(db.publishedResult.create).not.toHaveBeenCalled();
  });

  it("snapshots only that term's scores, not the sum of every term", async () => {
    const { service, compute } = setup();

    await service.publishResults({ ...PUBLISH, termId: TERM_2 });

    expect(compute).toHaveBeenCalledWith(expect.objectContaining({ termId: TERM_2 }));
  });

  it("stamps the publication with its term", async () => {
    const { service } = setup();

    await service.publishResults({ ...PUBLISH, termId: TERM_2 });

    expect(db.publishedResult.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ termId: TERM_2, academicSessionId: SESSION }),
    });
  });

  it("clears only that term's pending submission", async () => {
    const { service } = setup();

    await service.publishResults({ ...PUBLISH, termId: TERM_2 });

    expect(db.resultSubmission.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ termId: TERM_2, status: "PENDING" }),
    });
  });

  it("publishes the active term when none is named", async () => {
    const { service, compute } = setup();

    await service.publishResults(PUBLISH);

    expect(compute).toHaveBeenCalledWith(expect.objectContaining({ termId: TERM_2 }));
  });

  it("refuses a session that has no term at all", async () => {
    const { service } = setup();
    db.academicTerm.findFirst.mockResolvedValue(null);

    await expect(service.publishResults(PUBLISH)).rejects.toThrow(/no term yet/i);
    expect(db.publishedResult.create).not.toHaveBeenCalled();
  });
});

describe("resolving which term a computation is for", () => {
  const resolve = (termId?: number) =>
    (new AssessmentService() as any).resolveTermForSession(SCHOOL, SESSION, termId);

  it("uses the term it is given, after checking it belongs to the session", async () => {
    await expect(resolve(TERM_1)).resolves.toBe(TERM_1);
    expect(db.academicTerm.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TERM_1, schoolId: SCHOOL, sessionId: SESSION } })
    );
  });

  it("rejects a term from another session or school", async () => {
    db.academicTerm.findFirst.mockResolvedValue(null);

    await expect(resolve(99)).rejects.toThrow("Term not found for this session");
  });

  it("falls back to the session's active term", async () => {
    db.academicTerm.findFirst.mockImplementation(async ({ where }: any) => (where.isActive ? { id: TERM_2 } : null));

    await expect(resolve()).resolves.toBe(TERM_2);
  });

  it("falls back to the latest term when none is active, as for a past session", async () => {
    db.academicTerm.findFirst.mockImplementation(async ({ where }: any) =>
      where.isActive ? null : { id: 3 }
    );

    await expect(resolve()).resolves.toBe(3);
  });

  it("leaves a session with no terms unfiltered, so older results still show", async () => {
    db.academicTerm.findFirst.mockResolvedValue(null);

    await expect(resolve()).resolves.toBeUndefined();
  });
});

describe("a student's results across terms", () => {
  const view = (requestedTermId?: number) => new StudentResultService().getResults(11, SCHOOL, SESSION, requestedTermId);

  beforeEach(() => {
    db.student.findUnique.mockResolvedValue({ classId: 9, school: { id: SCHOOL } });
    db.publishedResult.findMany.mockResolvedValue([]);
    db.classSubject.findMany.mockResolvedValue([]);
  });

  it("shows the term published most recently when none is chosen", async () => {
    db.publishedResult.findFirst.mockResolvedValue({ termId: TERM_2 });

    await view();

    expect(db.publishedResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { publishedAt: "desc" } })
    );
    expect(db.publishedResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ termId: TERM_2 }) })
    );
  });

  it("shows the term that was asked for", async () => {
    await view(TERM_1);

    expect(db.publishedResult.findFirst).not.toHaveBeenCalled();
    expect(db.publishedResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ termId: TERM_1 }) })
    );
  });

  it("applies no term filter when nothing has been published yet", async () => {
    db.publishedResult.findFirst.mockResolvedValue(null);

    await view();

    const where = db.publishedResult.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("termId");
  });
});
