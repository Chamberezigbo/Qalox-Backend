import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";

function generatePassword() {
    // Matches the shape the (previously fake) admin UI already generated —
    // memorable enough to read off a phone screen, random enough to be safe.
    return `Qalox@${crypto.randomBytes(4).toString("hex")}`;
}

/** Case/whitespace differences must never produce two accounts for the same person. */
function normalizeEmail(email: string) {
    return email.trim().toLowerCase();
}

/** True when a Prisma unique-constraint violation was on the given field. */
function isUniqueViolationOn(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
    const target = error.meta?.target as unknown;
    const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
    return fields.some((name) => String(name).toLowerCase().includes(field.toLowerCase()));
}

interface CreateOrLinkInput {
    schoolId: number;
    name: string;
    email: string;
    phone?: string;
    registrationNumbers: string[];
}

interface LinkResult {
    registrationNumber: string;
    ok: boolean;
    reason?: string;
    studentId?: number;
    studentName?: string;
}

interface LinkCandidate {
    id: number;
    regNo: string;
    name: string;
}

export class AdminParentService {
    /**
     * Looks up every requested registration number and sorts them into
     * `results` (already-decided outcomes: not found, or claimed by a
     * different parent) and `toLink` (students that are safe to attach to
     * `existingParentId`, or to a parent not created yet when it's `null`).
     *
     * Read-only on purpose: callers decide whether to actually create a
     * parent / perform the updates, which matters because a brand-new
     * parent should never be created over a batch where nothing is
     * actually linkable — that would leave an orphan account with zero
     * children and a password nobody can use.
     */
    private async classifyLinks(
        schoolId: number,
        existingParentId: number | null,
        registrationNumbers: string[]
    ): Promise<{ results: LinkResult[]; toLink: LinkCandidate[] }> {
        const trimmed = [...new Set(registrationNumbers.map((r) => r.trim()).filter(Boolean))];
        const students = await prisma.student.findMany({
            where: { schoolId, registrationNumber: { in: trimmed } },
            select: { id: true, name: true, surname: true, registrationNumber: true, parentId: true },
        });
        const byRegNo = new Map(students.map((s) => [s.registrationNumber, s]));

        const results: LinkResult[] = [];
        const toLink: LinkCandidate[] = [];

        for (const regNo of trimmed) {
            const student = byRegNo.get(regNo);
            if (!student) {
                results.push({
                    registrationNumber: regNo,
                    ok: false,
                    reason: "No student in your school matches that registration number",
                });
                continue;
            }

            const fullName = `${student.name} ${student.surname}`;

            if (student.parentId && student.parentId !== existingParentId) {
                results.push({
                    registrationNumber: regNo,
                    ok: false,
                    reason: `${fullName} is already linked to a different parent's account`,
                });
                continue;
            }

            if (existingParentId != null && student.parentId === existingParentId) {
                // Already linked to this exact parent — nothing to do, not a failure.
                results.push({ registrationNumber: regNo, ok: true, studentId: student.id, studentName: fullName });
                continue;
            }

            toLink.push({ id: student.id, regNo, name: fullName });
        }

        return { results, toLink };
    }

    /**
     * Creates a real Parent account (or reuses one that already exists for
     * this email) and links it to every given student — the admin-driven
     * counterpart to the parent's own self-signup + "link child" flow, which
     * requires the parent to already know a matching guardian email/phone on
     * the student record. Here the admin already has that authority directly.
     */
    async createOrLinkParent(input: CreateOrLinkInput) {
        const { schoolId, name, email, phone, registrationNumbers } = input;

        if (
            !name?.trim() ||
            !email?.trim() ||
            !Array.isArray(registrationNumbers) ||
            registrationNumbers.filter((r) => r?.trim()).length === 0
        ) {
            throw new AppError("Parent name, email and at least one student registration number are required", 400);
        }

        const normalizedEmail = normalizeEmail(email);
        let parent = await prisma.parent.findUnique({ where: { email: normalizedEmail } });
        let rawPassword: string | null = null;

        const { results, toLink } = await this.classifyLinks(schoolId, parent?.id ?? null, registrationNumbers);

        if (!parent) {
            if (toLink.length === 0) {
                // Every requested student was invalid or already claimed —
                // never create an orphan parent account with zero children
                // over that. Surface the first reason directly.
                const failure = results.find((r) => !r.ok);
                throw new AppError(
                    failure?.reason ?? "No valid student to link",
                    failure?.reason?.includes("already linked") ? 409 : 404
                );
            }

            rawPassword = generatePassword();
            const hashed = await bcrypt.hash(rawPassword, 10);
            try {
                parent = await prisma.parent.create({
                    data: { name: name.trim(), email: normalizedEmail, phone: phone?.trim() || null, password: hashed },
                });
            } catch (error) {
                if (isUniqueViolationOn(error, "email")) {
                    // Lost a race with another request creating the same
                    // parent moments ago — reuse it instead of failing the
                    // whole submission. (The classification above ran
                    // against no parent yet, so a student already linked to
                    // *this* just-created-elsewhere parent would show as a
                    // conflict here — rare enough not to chase further.)
                    parent = await prisma.parent.findUnique({ where: { email: normalizedEmail } });
                    rawPassword = null;
                    if (!parent) {
                        throw new AppError("A parent account with this email already exists — try again.", 409);
                    }
                } else {
                    throw error;
                }
            }
        }

        const linkedStudents: { id: number; name: string; registrationNumber: string }[] = [];
        for (const candidate of toLink) {
            await prisma.student.update({ where: { id: candidate.id }, data: { parentId: parent.id } });
            linkedStudents.push({ id: candidate.id, name: candidate.name, registrationNumber: candidate.regNo });
            results.push({ registrationNumber: candidate.regNo, ok: true, studentId: candidate.id, studentName: candidate.name });
        }

        return {
            id: parent.id,
            name: parent.name,
            email: parent.email,
            phone: parent.phone,
            createdAt: parent.createdAt,
            // Only present the moment the account is first created — never
            // retrievable again afterward, since only the bcrypt hash is kept.
            password: rawPassword,
            linkedStudents,
            results,
        };
    }

    /** Links one or more additional students to an already-existing parent. */
    async linkChildren(schoolId: number, parentId: number, registrationNumbers: string[]) {
        if (!Array.isArray(registrationNumbers) || registrationNumbers.filter((r) => r?.trim()).length === 0) {
            throw new AppError("At least one student registration number is required", 400);
        }

        const parent = await prisma.parent.findFirst({
            where: { id: parentId, children: { some: { schoolId } } },
        });
        if (!parent) throw new AppError("Parent not found", 404);

        const { results, toLink } = await this.classifyLinks(schoolId, parent.id, registrationNumbers);

        const linkedStudents: { id: number; name: string; registrationNumber: string }[] = [];
        for (const candidate of toLink) {
            await prisma.student.update({ where: { id: candidate.id }, data: { parentId: parent.id } });
            linkedStudents.push({ id: candidate.id, name: candidate.name, registrationNumber: candidate.regNo });
            results.push({ registrationNumber: candidate.regNo, ok: true, studentId: candidate.id, studentName: candidate.name });
        }

        return { id: parent.id, results, linkedStudents };
    }

    /** Edits a parent's own contact details (name / email / phone). */
    async updateParent(schoolId: number, parentId: number, input: { name?: string; email?: string; phone?: string }) {
        const parent = await prisma.parent.findFirst({
            where: { id: parentId, children: { some: { schoolId } } },
        });
        if (!parent) throw new AppError("Parent not found", 404);

        const data: { name?: string; email?: string; phone?: string | null } = {};
        if (input.name?.trim()) data.name = input.name.trim();
        if (input.phone !== undefined) data.phone = input.phone.trim() || null;

        if (input.email?.trim()) {
            const normalizedEmail = normalizeEmail(input.email);
            if (normalizedEmail !== parent.email) {
                const existing = await prisma.parent.findUnique({ where: { email: normalizedEmail } });
                if (existing && existing.id !== parent.id) {
                    throw new AppError("Another parent account already uses this email", 409);
                }
                data.email = normalizedEmail;
            }
        }

        try {
            const updated = await prisma.parent.update({ where: { id: parent.id }, data });
            return { id: updated.id, name: updated.name, email: updated.email, phone: updated.phone, createdAt: updated.createdAt };
        } catch (error) {
            if (isUniqueViolationOn(error, "email")) {
                throw new AppError("Another parent account already uses this email", 409);
            }
            throw error;
        }
    }

    /** Unlinks one child from a parent's account. */
    async unlinkChild(schoolId: number, parentId: number, studentId: number) {
        const student = await prisma.student.findFirst({
            where: { id: studentId, schoolId, parentId },
        });
        if (!student) throw new AppError("This student is not linked to that parent account", 404);

        await prisma.student.update({ where: { id: student.id }, data: { parentId: null } });
        return { studentId: student.id, unlinked: true };
    }

    async resetPassword(schoolId: number, parentId: number) {
        const parent = await prisma.parent.findFirst({
            where: { id: parentId, children: { some: { schoolId } } },
        });
        if (!parent) throw new AppError("Parent not found", 404);

        const rawPassword = generatePassword();
        const hashed = await bcrypt.hash(rawPassword, 10);
        await prisma.parent.update({ where: { id: parent.id }, data: { password: hashed } });

        return { id: parent.id, password: rawPassword };
    }

    /** Every parent with at least one child in this school. */
    async list(schoolId: number) {
        const parents = await prisma.parent.findMany({
            where: { children: { some: { schoolId } } },
            include: {
                children: {
                    where: { schoolId },
                    select: { id: true, name: true, surname: true, registrationNumber: true },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        return parents.map((p) => ({
            id: p.id,
            name: p.name,
            email: p.email,
            phone: p.phone,
            createdAt: p.createdAt,
            children: p.children.map((c) => ({ id: c.id, name: `${c.name} ${c.surname}`, registrationNumber: c.registrationNumber })),
        }));
    }
}
