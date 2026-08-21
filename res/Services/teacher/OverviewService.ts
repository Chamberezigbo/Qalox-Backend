// src/services/teacher/TeacherOverviewService.ts
import prisma from "../../util/prisma";

export class TeacherOverviewService {
    async getOverview(staffId: number) {
        // 1️⃣ Get all assignments for teacher
        const assignments = await prisma.teacherAssignment.findMany({
            where: { staffId },
            select: {
                classId: true,
                subjectId: true
            }
        });

        const classIds = new Set<number>();
        const subjectIds = new Set<number>();

        for (const a of assignments) {
            if (a.classId) classIds.add(a.classId);
            if (a.subjectId) subjectIds.add(a.subjectId);
        }

        // 2️⃣ Count students in assigned classes
        const totalStudents = classIds.size
            ? await prisma.student.count({
                where: { classId: { in: [...classIds] } }
            })
            : 0;

        // "In progress" = posted by this teacher and not yet past its due date.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const assignmentsInProgress = await prisma.assignment.count({
            where: { staffId, dueDate: { gte: startOfToday } }
        });

        return {
            totalStudents,
            totalClasses: classIds.size,
            totalSubjects: subjectIds.size,
            assignmentsInProgress
        };
    }
}
