import crypto from "crypto";
import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const r2Service = require("../R2Service");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { schoolMediaUrl } = require("../../controller/public/publicController");

interface AttachmentInput {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
}

interface CreateAssignmentInput {
    staffId: number;
    schoolId: number;
    classId: number;
    subjectId: number;
    title: string;
    description?: string;
    dueDate: string;
    attachment?: AttachmentInput;
}

interface UpdateAssignmentInput {
    title?: string;
    description?: string;
    dueDate?: string;
    classId?: number;
    subjectId?: number;
    attachment?: AttachmentInput;
}

/** Keeps the R2 key readable and collision-free without leaking path separators from the original filename. */
function buildAttachmentKey(schoolId: number, originalname: string) {
    const safeName = originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    return `assignments/${schoolId}/${crypto.randomBytes(8).toString("hex")}-${safeName}`;
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

    /** Uploads to the private R2 bucket, returns the fields to store — never a raw URL, see schema comment. */
    private async uploadAttachment(schoolId: number, attachment: AttachmentInput) {
        const key = buildAttachmentKey(schoolId, attachment.originalname);
        await r2Service.uploadObject({ buffer: attachment.buffer, key, contentType: attachment.mimetype });
        return { attachmentUrl: `r2:${key}`, attachmentName: attachment.originalname };
    }

    /** Resolves attachmentUrl to a fresh presigned URL for every row — the raw "r2:<key>" value must never reach a client. */
    private async withResolvedAttachments<T extends { attachmentUrl: string | null }>(rows: T[]) {
        return Promise.all(
            rows.map(async (row) => ({ ...row, attachmentUrl: await schoolMediaUrl(row.attachmentUrl) }))
        );
    }

    async create(input: CreateAssignmentInput) {
        const { staffId, schoolId, classId, subjectId, title, description, dueDate, attachment } = input;

        if (!title?.trim()) throw new AppError("Title is required", 400);
        if (!dueDate) throw new AppError("Due date is required", 400);

        await this.assertTeaches(staffId, classId, subjectId);

        const attachmentFields = attachment ? await this.uploadAttachment(schoolId, attachment) : {};

        return prisma.assignment.create({
            data: {
                schoolId,
                classId,
                subjectId,
                staffId,
                title: title.trim(),
                description: description?.trim() || null,
                dueDate: new Date(`${dueDate}T00:00:00Z`),
                ...attachmentFields,
            },
        });
    }

    async listForTeacher(staffId: number) {
        const rows = await prisma.assignment.findMany({
            where: { staffId },
            include: {
                class: { select: { id: true, name: true, customName: true } },
                subject: { select: { id: true, name: true } },
            },
            orderBy: { dueDate: "asc" },
        });
        return this.withResolvedAttachments(rows);
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

        // A new file replaces the old one outright — the superseded R2
        // object is simply left orphaned, same as the existing school
        // logo/stamp update path (no cleanup job for either).
        const attachmentFields = patch.attachment
            ? await this.uploadAttachment(existing.schoolId, patch.attachment)
            : {};

        return prisma.assignment.update({
            where: { id },
            data: {
                ...(patch.title !== undefined && { title: patch.title.trim() }),
                ...(patch.description !== undefined && { description: patch.description.trim() || null }),
                ...(patch.dueDate !== undefined && { dueDate: new Date(`${patch.dueDate}T00:00:00Z`) }),
                ...(patch.classId !== undefined && { classId: patch.classId }),
                ...(patch.subjectId !== undefined && { subjectId: patch.subjectId }),
                ...attachmentFields,
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

        const rows = await prisma.assignment.findMany({
            where: { classId: student.classId },
            include: {
                subject: { select: { id: true, name: true } },
                staff: { select: { id: true, name: true } },
            },
            orderBy: { dueDate: "asc" },
        });
        return this.withResolvedAttachments(rows);
    }
}
