// src/services/teacher/AttendanceService.ts
import prisma from "../../util/prisma";

type AttendanceStatus = "present" | "absent" | "late";
type MarkRecord = { studentId: number; status: AttendanceStatus };

const toDateOnly = (date: string) => new Date(`${date}T00:00:00.000Z`);

export class AttendanceService {
    /** Confirms the teacher is actually assigned to this class before allowing any read/write. */
    private async assertAssignedToClass(staffId: number, classId: number) {
        const assignment = await prisma.teacherAssignment.findFirst({ where: { staffId, classId } });
        if (!assignment) throw new Error("You are not assigned to this class");
    }

    async markAttendance(input: { staffId: number; schoolId: number; classId: number; date: string; records: MarkRecord[] }) {
        const { staffId, schoolId, classId, date, records } = input;
        await this.assertAssignedToClass(staffId, classId);

        if (!Array.isArray(records) || records.length === 0) {
            throw new Error("records must be a non-empty array");
        }

        // Only allow marking students who actually belong to this class/school
        const validStudents = await prisma.student.findMany({
            where: { schoolId, classId, id: { in: records.map(r => r.studentId) } },
            select: { id: true, parentId: true, name: true, surname: true },
        });
        const validById = new Map(validStudents.map(s => [s.id, s]));
        const toMark = records.filter(r => validById.has(r.studentId));

        const day = toDateOnly(date);

        await prisma.$transaction(async (tx) => {
            for (const r of toMark) {
                await tx.attendance.upsert({
                    where: { studentId_date: { studentId: r.studentId, date: day } },
                    create: { studentId: r.studentId, classId, date: day, status: r.status, markedByStaffId: staffId },
                    update: { status: r.status, markedByStaffId: staffId },
                });
            }

            // Child Performance Alerts: notify a linked parent when their child is marked absent.
            const newlyAbsent = toMark.filter(r => r.status === "absent");
            for (const r of newlyAbsent) {
                const student = validById.get(r.studentId)!;
                if (!student.parentId) continue;
                await tx.parentAlert.create({
                    data: {
                        parentId: student.parentId,
                        studentId: student.id,
                        type: "absence",
                        message: `${student.name} ${student.surname} was marked absent on ${date}`,
                    },
                });
            }
        }, { timeout: 20000 });

        return { marked: toMark.length, skipped: records.length - toMark.length };
    }

    async getAttendance(input: { staffId: number; schoolId: number; classId: number; date: string }) {
        const { staffId, schoolId, classId, date } = input;
        await this.assertAssignedToClass(staffId, classId);

        const day = toDateOnly(date);

        const [students, records] = await Promise.all([
            prisma.student.findMany({
                where: { schoolId, classId },
                select: { id: true, name: true, surname: true, otherNames: true, registrationNumber: true, gender: true },
                orderBy: { surname: "asc" },
            }),
            prisma.attendance.findMany({ where: { classId, date: day } }),
        ]);

        const byStudentId = new Map(records.map(r => [r.studentId, r.status]));

        return {
            date,
            classId,
            students: students.map(s => ({
                id: s.id,
                name: s.name,
                surname: s.surname,
                otherNames: s.otherNames,
                registrationNumber: s.registrationNumber,
                gender: s.gender,
                status: byStudentId.get(s.id) ?? null,
            })),
        };
    }

    async getAttendanceReport(input: { staffId: number; schoolId: number; classId: number; startDate: string; endDate: string }) {
        const { staffId, schoolId, classId, startDate, endDate } = input;
        await this.assertAssignedToClass(staffId, classId);

        const [students, records] = await Promise.all([
            prisma.student.findMany({
                where: { schoolId, classId },
                select: { id: true, name: true, surname: true, otherNames: true, registrationNumber: true },
                orderBy: { surname: "asc" },
            }),
            prisma.attendance.findMany({
                where: { classId, date: { gte: toDateOnly(startDate), lte: toDateOnly(endDate) } },
                orderBy: { date: "asc" },
            }),
        ]);

        const byStudent = new Map<number, { present: number; absent: number; late: number }>();
        students.forEach(s => byStudent.set(s.id, { present: 0, absent: 0, late: 0 }));

        const byDate = new Map<string, { present: number; absent: number; late: number }>();

        for (const r of records) {
            const dateKey = r.date.toISOString().slice(0, 10);
            const studentTotals = byStudent.get(r.studentId);
            if (studentTotals) studentTotals[r.status as AttendanceStatus] += 1;

            if (!byDate.has(dateKey)) byDate.set(dateKey, { present: 0, absent: 0, late: 0 });
            byDate.get(dateKey)![r.status as AttendanceStatus] += 1;
        }

        return {
            classId,
            startDate,
            endDate,
            byStudent: students.map(s => ({
                id: s.id,
                name: s.name,
                surname: s.surname,
                otherNames: s.otherNames,
                registrationNumber: s.registrationNumber,
                ...byStudent.get(s.id)!,
            })),
            byDate: [...byDate.entries()].map(([date, counts]) => ({ date, ...counts })),
        };
    }
}
