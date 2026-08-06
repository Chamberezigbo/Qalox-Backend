import bcrypt from "bcryptjs";
import prisma from "../../util/prisma";
import { signParentToken } from "../../util/jwt";
import { AppError } from "../../util/AppError";
import { logLoginEvent } from "../../util/logLoginEvent";

export class ParentAuthService {
    async signup(data: { email: string; password: string; name: string; phone?: string }) {
        const { email, password, name, phone } = data;

        const existing = await prisma.parent.findUnique({ where: { email } });
        if (existing) throw new AppError("An account with this email already exists", 409);

        const hashed = await bcrypt.hash(password, 10);
        const parent = await prisma.parent.create({
            data: { email, password: hashed, name, phone },
        });

        const token = signParentToken({ parentId: parent.id, role: "parent" });

        return { token, parent: { id: parent.id, email: parent.email, name: parent.name } };
    }

    async login(data: { email: string; password: string }, req?: import("express").Request) {
        const { email, password } = data;

        const parent = await prisma.parent.findUnique({ where: { email } });
        if (!parent) throw new AppError("Invalid email or password", 401);

        const valid = await bcrypt.compare(password, parent.password);
        if (!valid) throw new AppError("Invalid email or password", 401);

        const token = signParentToken({ parentId: parent.id, role: "parent" });

        await logLoginEvent({ actorType: "parent", actorId: parent.id, schoolId: undefined, req });

        return { token, parent: { id: parent.id, email: parent.email, name: parent.name } };
    }

    /** Links a child to this parent account by verifying the submitted contact
     * matches the student's existing guardianEmail or guardianNumber. */
    async linkChild(data: { parentId: number; admissionNo: string; contact: string }) {
        const { parentId, admissionNo, contact } = data;

        const student = await prisma.student.findUnique({ where: { registrationNumber: admissionNo } });
        if (!student) throw new AppError("No student found with that admission number", 404);

        const normalizedContact = contact.trim().toLowerCase();
        const matchesEmail = student.guardianEmail?.trim().toLowerCase() === normalizedContact;
        const matchesPhone = student.guardianNumber?.replace(/\D/g, "") === contact.replace(/\D/g, "");

        if (!matchesEmail && !matchesPhone) {
            throw new AppError("The contact provided doesn't match our records for this student", 400);
        }

        if (student.parentId && student.parentId !== parentId) {
            throw new AppError("This student is already linked to another parent account", 409);
        }

        const updated = await prisma.student.update({
            where: { id: student.id },
            data: { parentId },
        });

        return { id: updated.id, name: updated.name, surname: updated.surname, registrationNumber: updated.registrationNumber };
    }
}
