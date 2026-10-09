/**
 * Deleting a student, safely.
 *
 * A student's scores, fee records, attendance and so on hang off them with no
 * database foreign keys (`relationMode = "prisma"`), so deleting the student row
 * alone fails while any of them exist — which is why Delete never worked. The
 * dependants are removed with the student, in one transaction, except for the
 * records that are not the school's to lose casually:
 *
 *   - published results: they are the school's official, admin-approved record
 *   - recorded payments: they are money received, with receipts issued against them
 *
 * A student who has either is refused, with the reason. That keeps the delete for
 * what it is needed for (a wrong upload, a duplicate, a test record) and stops it
 * quietly erasing a real student's history.
 */

export interface StudentDeletionPlan {
  studentId: number;
  /** Shown in the dialog: the student's name and registration number. */
  label: string;
  /** Why this cannot be deleted. Empty when it can. */
  blockers: string[];
  /** Records that go with the student, by kind. */
  willRemove: Record<string, number>;
  /** The passport photo, to remove from storage once the delete has committed. */
  passportKey: string | null;
}

export class StudentDeletionBlocked extends Error {
  readonly code = "DELETION_BLOCKED";
  constructor(readonly plan: StudentDeletionPlan) {
    super(plan.blockers[0] ?? "This student cannot be deleted");
  }
}

export class StudentNotFound extends Error {
  readonly code = "NOT_FOUND";
}

export async function planStudentDeletion(client: any, studentId: number, schoolId: number): Promise<StudentDeletionPlan> {
  // Always within the school: another school's student reads as simply not found.
  const student = await client.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, name: true, surname: true, registrationNumber: true, passportUrl: true },
  });
  if (!student) throw new StudentNotFound("Student not found");

  const [published, studentFees, payments, caResults, examResults, attendance, alerts, attempts] = await Promise.all([
    client.publishedResultRow.count({ where: { studentId } }),
    client.studentFee.count({ where: { studentId } }),
    client.payment.count({ where: { studentFee: { studentId } } }),
    client.cAResult.count({ where: { studentId } }),
    client.examResult.count({ where: { studentId } }),
    client.attendance.count({ where: { studentId } }),
    client.parentAlert.count({ where: { studentId } }),
    client.studentTestAttempt.count({ where: { studentId } }),
  ]);

  const blockers: string[] = [];
  const name = `${student.name} ${student.surname}`.trim();
  if (published > 0) {
    blockers.push(
      `${name} has published results (${published} subject record${published === 1 ? "" : "s"}). Those are the school's official record and are not deleted with a student.`
    );
  }
  if (payments > 0) {
    blockers.push(
      `${name} has ${payments} recorded fee payment${payments === 1 ? "" : "s"}. Payments have receipts issued against them and are not deleted with a student.`
    );
  }

  const counts: Record<string, number> = {
    "fee records": studentFees,
    "CA scores": caResults,
    "exam scores": examResults,
    "attendance records": attendance,
    "parent alerts": alerts,
    "test attempts": attempts,
  };
  const willRemove: Record<string, number> = {};
  for (const [kind, count] of Object.entries(counts)) if (count > 0) willRemove[kind] = count;

  const passport: string | null = student.passportUrl;
  return {
    studentId,
    label: `${name} (${student.registrationNumber})`,
    blockers,
    willRemove,
    passportKey: typeof passport === "string" && passport.startsWith("r2:") ? passport.slice(3) : null,
  };
}

export async function deleteStudent(prisma: any, studentId: number, schoolId: number): Promise<StudentDeletionPlan> {
  return prisma.$transaction(
    async (tx: any) => {
      // Planned again inside the transaction, so a payment recorded between the
      // preview and the delete is still caught.
      const plan = await planStudentDeletion(tx, studentId, schoolId);
      if (plan.blockers.length > 0) throw new StudentDeletionBlocked(plan);

      // StudentAnswer cascades from its attempt (emulated by Prisma).
      await tx.studentTestAttempt.deleteMany({ where: { studentId } });
      await tx.parentAlert.deleteMany({ where: { studentId } });
      await tx.attendance.deleteMany({ where: { studentId } });
      await tx.cAResult.deleteMany({ where: { studentId } });
      await tx.examResult.deleteMany({ where: { studentId } });
      // No payments exist (checked above), so the fee rows have no children.
      await tx.studentFee.deleteMany({ where: { studentId } });
      await tx.student.delete({ where: { id: studentId } });

      return plan;
    },
    { timeout: 30 * 1000, maxWait: 10 * 1000 }
  );
}
