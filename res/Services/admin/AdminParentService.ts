import bcrypt from "bcryptjs";
import crypto from "crypto";
import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";

function generatePassword() {
    // Matches the shape the (previously fake) admin UI already generated —
    // memorable enough to read off a phone screen, random enough to be safe.
    return `Qalox@${crypto.randomBytes(4).toString("hex")}`;
}

interface CreateOrLinkInput {
    schoolId: number;
    name: string;
    email: string;
    phone?: string;
    registrationNumber: string;
}

export class AdminParentService {
    /**
     * Creates a real Parent account (or reuses one that already exists for
     * this email) and links it to the given student — the admin-driven
     * counterpart to the parent's own self-signup + "link child" flow, which
     * requires the parent to already know a matching guardian email/phone on
     * the student record. Here the admin already has that authority directly.
     */
    async createOrLinkParent(input: CreateOrLinkInput) {
        const { schoolId, name, email, phone, registrationNumber } = input;

        if (!name?.trim() || !email?.trim() || !registrationNumber?.trim()) {
            throw new AppError("Parent name, email and student registration number are required", 400);
        }

        const student = await prisma.student.findFirst({
            where: { registrationNumber: registrationNumber.trim(), schoolId },
            select: { id: true, name: true, surname: true, parentId: true },
        });
        if (!student) {
            throw new AppError("No student in your school matches that registration number", 404);
        }

        let parent = await prisma.parent.findUnique({ where: { email: email.trim() } });
        let rawPassword: string | null = null;

        // Must run regardless of whether `parent` is new or existing — a
        // brand-new email with someone else's child's registration number is
        // just as much a hijack as reusing an existing parent account would
        // be, and was previously only checked in the latter case.
        if (student.parentId && student.parentId !== parent?.id) {
            throw new AppError("This student is already linked to a different parent account", 409);
        }

        if (!parent) {
            rawPassword = generatePassword();
            const hashed = await bcrypt.hash(rawPassword, 10);
            parent = await prisma.parent.create({
                data: { name: name.trim(), email: email.trim(), phone: phone?.trim() || null, password: hashed },
            });
        }

        if (student.parentId !== parent.id) {
            await prisma.student.update({ where: { id: student.id }, data: { parentId: parent.id } });
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
            linkedStudent: { id: student.id, name: `${student.name} ${student.surname}` },
        };
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
