import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";

interface CreateAssignmentInput {
    staffId: number;
    schoolId: number;
    classId: number;
    subjectId: number;
    title: string;
    description?: string;
    dueDate: string;
}

interface UpdateAssignmentInput {
    title?: string;
    description?: string;
    dueDate?: string;
    classId?: number;
    subjectId?: number;
}

export class AssignmentService {
    /** A teacher may only post to a class+subject they actually teach. */
    private async assertTeaches(staffId: number, classId: number, subjectId: number) {
        const taught = await prisma.teacherAssignment.findFirst({
            where: { staffId, classId, subjectId },
        });
        if (!taught) {
            throw new AppError("You do not teach this subject in this class", 403);
        }
    }

    async create(input: CreateAssignmentInput) {
        const { staffId, schoolId, classId, subjectId, title, description, dueDate } = input;

        if (!title?.trim()) throw new AppError("Title is required", 400);
        if (!dueDate) throw new AppError("Due date is required", 400);

        await this.assertTeaches(staffId, classId, subjectId);

        return prisma.assignment.create({
            data: {
                schoolId,
                classId,
                subjectId,
                staffId,
                title: title.trim(),
                description: description?.trim() || null,
                dueDate: new Date(`${dueDate}T00:00:00Z`),
            },
        });
    }

    async listForTeacher(staffId: number) {
        return prisma.assignment.findMany({
            where: { staffId },
            include: {
                class: { select: { id: true, name: true, customName: true } },
                subject: { select: { id: true, name: true } },
            },
            orderBy: { dueDate: "asc" },
        });
    }

    async update(staffId: number, id: number, patch: UpdateAssignmentInput) {
        const existing = await prisma.assignment.findUnique({ where: { id } });
        if (!existing || existing.staffId !== staffId) {
            throw new AppError("Assignment not found", 404);
        }

        const nextClassId = patch.classId ?? existing.classId;
        const nextSubjectId = patch.subjectId ?? existing.subjectId;
        if (patch.classId || patch.subjectId) {
            await this.assertTeaches(staffId, nextClassId, nextSubjectId);
        }

        return prisma.assignment.update({
            where: { id },
            data: {
                ...(patch.title !== undefined && { title: patch.title.trim() }),
                ...(patch.description !== undefined && { description: patch.description.trim() || null }),
                ...(patch.dueDate !== undefined && { dueDate: new Date(`${patch.dueDate}T00:00:00Z`) }),
                ...(patch.classId !== undefined && { classId: patch.classId }),
                ...(patch.subjectId !== undefined && { subjectId: patch.subjectId }),
            },
        });
    }

    async remove(staffId: number, id: number) {
        const existing = await prisma.assignment.findUnique({ where: { id } });
        if (!existing || existing.staffId !== staffId) {
            throw new AppError("Assignment not found", 404);
        }
        await prisma.assignment.delete({ where: { id } });
        return { deleted: true };
    }

    async listForStudent(studentId: number) {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: { classId: true },
        });
        if (!student) throw new AppError("Student not found", 404);

        return prisma.assignment.findMany({
            where: { classId: student.classId },
            include: {
                subject: { select: { id: true, name: true } },
                staff: { select: { id: true, name: true } },
            },
            orderBy: { dueDate: "asc" },
        });
    }
}
