import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";

/**
 * The student-facing view of a published exam timetable — reads
 * ExamScheduleEntry directly, the same reasoning as
 * ExamTimetableService (the teacher equivalent): Exam.scheduledDate is
 * only a best-effort sync ExamScheduleService.publish() performs onto a
 * pre-existing Exam row and can be null even once published.
 */
export class StudentExamService {
    async getUpcomingExams(studentId: number) {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: { classId: true, schoolId: true },
        });
        if (!student) throw new AppError("Student not found", 404);

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const entries = await prisma.examScheduleEntry.findMany({
            where: {
                classId: student.classId,
                date: { gte: startOfToday },
                examSchedule: { status: "published", schoolId: student.schoolId },
            },
            include: {
                subject: { select: { name: true } },
                examSchedule: { select: { name: true, examType: true } },
            },
            orderBy: [{ date: "asc" }, { startTime: "asc" }],
        });

        return entries.map((e) => ({
            id: e.id,
            date: e.date.toISOString().slice(0, 10),
            startTime: e.startTime,
            durationMinutes: e.durationMinutes,
            subject: e.subject.name,
            examName: e.examSchedule.name,
            examType: e.examSchedule.examType,
        }));
    }
}
