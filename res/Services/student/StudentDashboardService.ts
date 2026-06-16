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

        // Get current active term for the school
        const activeSession = await prisma.academicSession.findFirst({
            where: { schoolId: student.schoolId, isActive: true },
            select: { id: true }
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

        return {
            student: {
                name: `${student.name} ${student.surname}`,
                registrationNumber: student.registrationNumber,
                class: student.class.name,
                school: student.school
            },
            currentTerm,
            stats: {
                totalSchoolFee: 0,       // static — fees not yet implemented
                totalStudentsInClass: classmateCount,
                pendingDebt: 0,          // static — fees not yet implemented
                activeAssignments: 0     // static — assignments not yet implemented
            }
        };
    }
}
