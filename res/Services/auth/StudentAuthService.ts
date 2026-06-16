import prisma from "../../util/prisma";
import { signStudentToken } from "../../util/jwt";
import { AppError } from "../../util/AppError";

export class StudentAuthService {

    async login(registrationNumber: string) {
        // Look up the student by their reg number
        const student = await prisma.student.findFirst({
            where: { registrationNumber },
            include: {
                school: { select: { id: true, name: true } },
                campus: { select: { id: true, name: true } },
                class: { select: { id: true, name: true } }
            }
        });

        // If no match, reject — don't reveal whether it exists or not
        if (!student) {
            throw new AppError("Invalid registration number");
        }

        // schoolId comes FROM the database, never from the client
        const token = signStudentToken({
            studentId: student.id,
            schoolId: student.schoolId,
            role: "student"
        });

        return {
            token,
            student: {
                id: student.id,
                name: student.name,
                registrationNumber: student.registrationNumber,
                school: student.school,
                campus: student.campus,
                class: student.class
            }
        };
    }
}
