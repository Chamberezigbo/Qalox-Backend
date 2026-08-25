import prisma from "../../util/prisma";

export class StudentDashboardService {

    async getDashboard(studentId: number) {
        // Get the student + their class + school info in one query
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                school: { select: { id: true, name: true } },
                campus: { select: { id: true, name: true } },
                class:  { select: { id: true, name: true } }
            }
        });

        if (!student) throw new Error("Student not found");

        // Count how many students share the same class
        const classmateCount = await prisma.student.count({
            where: { classId: student.classId }
        });

        // "Active" = not yet overdue, matching the due-status badge logic
        // (Overdue / Due soon / Upcoming) already used on the Assignment
        // Board — Due soon and Upcoming both count as active.
        //
        // Built in UTC, not local time: AssignmentService.create() stores
        // dueDate as explicit UTC midnight (`${dueDate}T00:00:00Z`), so
        // comparing against local midnight (`setHours(0,0,0,0)`) would drift
        // out of sync with that on any server not running in the UTC
        // timezone — silently excluding an assignment due today or tomorrow.
        const now = new Date();
        const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const activeAssignmentsCount = await prisma.assignment.count({
            where: { classId: student.classId, dueDate: { gte: startOfToday } }
        });

        // Get current active term for the school
        const activeSession = await prisma.academicSession.findFirst({
            where: { schoolId: student.schoolId, isActive: true },
            select: { id: true, name: true }
        });

        let currentTerm: any = null;
        if (activeSession) {
            const activeTerm = await prisma.academicTerm.findFirst({
                where: { sessionId: activeSession.id, isActive: true },
                select: { id: true, name: true, resumptionDate: true }
            });
            if (activeTerm) {
                currentTerm = {
                    id: activeTerm.id,
                    name: activeTerm.name,
                    resumptionDate: activeTerm.resumptionDate ? activeTerm.resumptionDate.toISOString().split('T')[0] : null
                };
            }
        }

        // Every fee record this student has (any term) — totalSchoolFee is
        // just the current term's, but pendingDebt covers everything still
        // owed, including any carried over from earlier terms.
        const fees = await prisma.studentFee.findMany({
            where: { studentId: student.id },
            select: {
                totalFee: true,
                amountPaid: true,
                feeStructure: { select: { term: true, session: true } }
            }
        });

        const currentTermFee = activeSession && currentTerm
            ? fees.find(
                (f) => f.feeStructure.session === activeSession.name && f.feeStructure.term === currentTerm.name
              )
            : undefined;

        const totalSchoolFee = currentTermFee?.totalFee ?? 0;
        const pendingDebt = fees.reduce((sum, f) => sum + Math.max(f.totalFee - f.amountPaid, 0), 0);

        return {
            student: {
                name: `${student.name} ${student.surname}`,
                registrationNumber: student.registrationNumber,
                class: student.class.name,
                school: student.school
            },
            currentTerm,
            stats: {
                totalSchoolFee,
                totalStudentsInClass: classmateCount,
                pendingDebt,
                activeAssignments: activeAssignmentsCount
            }
        };
    }
}
