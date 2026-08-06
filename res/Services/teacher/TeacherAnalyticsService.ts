// src/services/teacher/TeacherAnalyticsService.ts
import prisma from "../../util/prisma";

const PASS_MARK = 40;

type RowWithMeta = {
    studentId: number;
    total: number;
    publishedResult: { subject: { name: string }; academicSessionId: number; termId: number | null; publishedAt: Date };
};

export class TeacherAnalyticsService {
    private async assertAssignedToClass(staffId: number, classId: number) {
        const assignment = await prisma.teacherAssignment.findFirst({ where: { staffId, classId } });
        if (!assignment) throw new Error("You are not assigned to this class");
    }

    private async getClassRows(classId: number): Promise<RowWithMeta[]> {
        return prisma.publishedResultRow.findMany({
            where: { publishedResult: { classId } },
            select: {
                studentId: true,
                total: true,
                publishedResult: {
                    select: { subject: { select: { name: true } }, academicSessionId: true, termId: true, publishedAt: true },
                },
            },
        });
    }

    async getOverview(input: { staffId: number; classId: number }) {
        const { staffId, classId } = input;
        await this.assertAssignedToClass(staffId, classId);

        const rows = await this.getClassRows(classId);
        const totalStudents = new Set(rows.map((r) => r.studentId)).size;
        const averageClassScore = rows.length > 0 ? rows.reduce((s, r) => s + r.total, 0) / rows.length : 0;
        const passCount = rows.filter((r) => r.total >= PASS_MARK).length;
        const passRate = rows.length > 0 ? (passCount / rows.length) * 100 : 0;

        return {
            totalStudents,
            averageClassScore: Math.round(averageClassScore * 10) / 10,
            passRate: Math.round(passRate * 10) / 10,
            failRate: Math.round((100 - passRate) * 10) / 10,
        };
    }

    private async rankedStudents(input: { staffId: number; classId: number; limit: number; order: "best" | "weak" }) {
        const { staffId, classId, limit, order } = input;
        await this.assertAssignedToClass(staffId, classId);

        const rows = await this.getClassRows(classId);
        const students = await prisma.student.findMany({
            where: { classId, id: { in: [...new Set(rows.map((r) => r.studentId))] } },
            select: { id: true, name: true, surname: true, class: { select: { name: true, customName: true } } },
        });
        const studentById = new Map(students.map((s) => [s.id, s]));

        const byStudent = new Map<number, RowWithMeta[]>();
        rows.forEach((r) => {
            if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
            byStudent.get(r.studentId)!.push(r);
        });

        const summaries = [...byStudent.entries()].map(([studentId, studentRows]) => {
            const averageScore = studentRows.reduce((s, r) => s + r.total, 0) / studentRows.length;
            const passedSubjects = studentRows.filter((r) => r.total >= PASS_MARK).length;

            // Trend: compare the two most recent (session, term) periods by average total.
            const byPeriod = new Map<string, { total: number; count: number; latestAt: Date }>();
            studentRows.forEach((r) => {
                const key = `${r.publishedResult.academicSessionId}-${r.publishedResult.termId ?? "none"}`;
                const entry = byPeriod.get(key) ?? { total: 0, count: 0, latestAt: r.publishedResult.publishedAt };
                entry.total += r.total;
                entry.count += 1;
                if (r.publishedResult.publishedAt > entry.latestAt) entry.latestAt = r.publishedResult.publishedAt;
                byPeriod.set(key, entry);
            });
            const periods = [...byPeriod.values()].sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
            let trend: "up" | "down" | "stable" = "stable";
            if (periods.length >= 2) {
                const latestAvg = periods[0].total / periods[0].count;
                const priorAvg = periods[1].total / periods[1].count;
                if (latestAvg > priorAvg + 0.5) trend = "up";
                else if (latestAvg < priorAvg - 0.5) trend = "down";
            }

            const student = studentById.get(studentId);
            return {
                id: studentId,
                name: student ? `${student.name} ${student.surname}` : "Unknown",
                class: student ? (student.class.customName ?? student.class.name) : "",
                averageScore: Math.round(averageScore * 10) / 10,
                totalSubjects: studentRows.length,
                passedSubjects,
                trend,
            };
        });

        summaries.sort((a, b) => (order === "best" ? b.averageScore - a.averageScore : a.averageScore - b.averageScore));

        return summaries.slice(0, limit).map((s, i) => ({ ...s, rank: order === "best" ? i + 1 : summaries.length - i }));
    }

    async getBestStudents(input: { staffId: number; classId: number; limit?: number }) {
        return this.rankedStudents({ ...input, limit: input.limit ?? 5, order: "best" });
    }

    async getWeakStudents(input: { staffId: number; classId: number; limit?: number }) {
        return this.rankedStudents({ ...input, limit: input.limit ?? 5, order: "weak" });
    }

    async getSubjectFailureRates(input: { staffId: number; classId: number }) {
        const { staffId, classId } = input;
        await this.assertAssignedToClass(staffId, classId);

        const rows = await this.getClassRows(classId);
        const bySubject = new Map<string, { total: number; failed: number }>();
        rows.forEach((r) => {
            const key = r.publishedResult.subject.name;
            const entry = bySubject.get(key) ?? { total: 0, failed: 0 };
            entry.total += 1;
            if (r.total < PASS_MARK) entry.failed += 1;
            bySubject.set(key, entry);
        });

        return [...bySubject.entries()].map(([subject, { total, failed }]) => ({
            subject,
            totalStudents: total,
            failedStudents: failed,
            failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
        }));
    }
}
