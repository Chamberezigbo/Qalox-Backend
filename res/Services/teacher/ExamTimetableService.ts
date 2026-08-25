import prisma from "../../util/prisma";

/**
 * The teacher-facing view of a published exam timetable.
 *
 * Reads ExamScheduleEntry directly rather than Exam.scheduledDate — the
 * latter is only a best-effort sync onto a pre-existing Exam row that
 * ExamScheduleService.publish() performs, and can be null even for a
 * published entry. ExamScheduleEntry is always complete for whatever was
 * actually published.
 */
export class ExamTimetableService {
    async getUpcomingExams(staffId: number, schoolId: number) {
        const assignments = await prisma.teacherAssignment.findMany({
            where: { staffId },
            select: { classId: true, subjectId: true },
        });

        const pairs = assignments.filter((a) => a.classId && a.subjectId);
        if (pairs.length === 0) return [];

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const entries = await prisma.examScheduleEntry.findMany({
            where: {
                date: { gte: startOfToday },
                examSchedule: { status: "published", schoolId },
                // A plain classId-IN/subjectId-IN pair would false-match a
                // combination this teacher isn't actually assigned to teach
                // (e.g. Class A/Math + Class B/English also matching Class
                // A/English) — OR-ing the exact assigned pairs avoids that.
                OR: pairs.map((p) => ({ classId: p.classId!, subjectId: p.subjectId! })),
            },
            include: {
                class: { select: { name: true } },
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
            class: e.class.name,
            examName: e.examSchedule.name,
            examType: e.examSchedule.examType,
        }));
    }
}
