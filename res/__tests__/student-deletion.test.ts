import { StudentDeletionBlocked, StudentNotFound, deleteStudent, planStudentDeletion } from "../Services/studentDeletion";

/** Counts per table, plus a log of every write in order. */
function fake(opts: { student?: any; counts?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const counts = opts.counts ?? {};
  const student = opts.student === undefined
    ? { id: 5, name: "Ada", surname: "Obi", registrationNumber: "REG/1", passportUrl: "r2:passports/a.jpeg" }
    : opts.student;
  const count = (name: string) => jest.fn(async () => counts[name] ?? 0);
  const write = (name: string, op: string) => jest.fn(async (arg: any) => { calls.push(`${op}:${name}:${JSON.stringify(arg.where)}`); return {}; });
  const client: any = {
    student: { findFirst: jest.fn(async ({ where }: any) => (student && where.schoolId === 7 ? student : null)), delete: write("student", "delete") },
    publishedResultRow: { count: count("published") },
    studentFee: { count: count("fees"), deleteMany: write("studentFee", "deleteMany") },
    payment: { count: count("payments") },
    cAResult: { count: count("ca"), deleteMany: write("cAResult", "deleteMany") },
    examResult: { count: count("exam"), deleteMany: write("examResult", "deleteMany") },
    attendance: { count: count("attendance"), deleteMany: write("attendance", "deleteMany") },
    parentAlert: { count: count("alerts"), deleteMany: write("parentAlert", "deleteMany") },
    studentTestAttempt: { count: count("attempts"), deleteMany: write("studentTestAttempt", "deleteMany") },
    $transaction: async (fn: any) => fn(client),
  };
  return { client, calls };
}

describe("planStudentDeletion", () => {
  it("allows a student with nothing official on record, and lists what goes with them", async () => {
    const { client } = fake({ counts: { fees: 2, ca: 4, attendance: 10 } });
    const plan = await planStudentDeletion(client, 5, 7);
    expect(plan.blockers).toEqual([]);
    expect(plan.willRemove).toEqual({ "fee records": 2, "CA scores": 4, "attendance records": 10 });
    expect(plan.label).toBe("Ada Obi (REG/1)");
    expect(plan.passportKey).toBe("passports/a.jpeg");
  });

  it("refuses a student with published results", async () => {
    const { client } = fake({ counts: { published: 6 } });
    const plan = await planStudentDeletion(client, 5, 7);
    expect(plan.blockers[0]).toContain("published results");
  });

  it("refuses a student who has paid fees", async () => {
    const { client } = fake({ counts: { payments: 1 } });
    expect((await planStudentDeletion(client, 5, 7)).blockers[0]).toContain("1 recorded fee payment.");
  });

  it("reads another school's student as not found", async () => {
    const { client } = fake();
    await expect(planStudentDeletion(client, 5, 8)).rejects.toBeInstanceOf(StudentNotFound);
  });
});

describe("deleteStudent", () => {
  it("removes the dependants first and the student last", async () => {
    const { client, calls } = fake({ counts: { fees: 1, ca: 1 } });
    await deleteStudent(client, 5, 7);
    expect(calls[calls.length - 1]).toBe('delete:student:{"id":5}');
    expect(calls.indexOf('deleteMany:studentFee:{"studentId":5}')).toBeLessThan(calls.length - 1);
    expect(calls).toContain('deleteMany:cAResult:{"studentId":5}');
  });

  it("deletes nothing when refused", async () => {
    const { client, calls } = fake({ counts: { published: 1 } });
    await expect(deleteStudent(client, 5, 7)).rejects.toBeInstanceOf(StudentDeletionBlocked);
    expect(calls).toEqual([]);
  });

  it("deletes nothing for another school's student", async () => {
    const { client, calls } = fake();
    await expect(deleteStudent(client, 5, 8)).rejects.toBeInstanceOf(StudentNotFound);
    expect(calls).toEqual([]);
  });
});
