import prisma from "../../util/prisma";
import { TeacherLoginDTO } from "../../dtos/auth/teacher-login.dto";
import { signTeacherToken } from "../../util/jwt";
import { AppError } from "../../util/AppError";
import { logLoginEvent } from "../../util/logLoginEvent";

// isActive field on Staff

// login audit logs

// first - time password setup

// OTP / PIN login

// device - based sessions

export class TeacherAuthService {

    async login(data: TeacherLoginDTO, req?: import("express").Request) {
        const teacher = await prisma.staff.findUnique({
            where: {
                registrationNumber: data.registrationNumber
            },
            include: {
                school: { select: { id: true, name: true } },
                campus: { select: { id: true, name: true } }
            }
        });

        if (!teacher) {
            throw new AppError("Invalid registration number");
        }

        if (teacher.duty !== "Teacher") {
            throw new AppError("Access denied");
        }

        // 🔐 schoolId comes FROM DB, not client
        const token = signTeacherToken({
            staffId: teacher.id,
            schoolId: teacher.schoolId,
            campusId: teacher.campusId ?? undefined,
            role: "teacher"
        });

        await logLoginEvent({ actorType: "teacher", actorId: teacher.id, schoolId: teacher.schoolId, req });

        return {
            token,
            teacher: {
                id: teacher.id,
                name: teacher.name,
                registrationNumber: teacher.registrationNumber,
                school: teacher.school,
                campus: teacher.campus
            }
        };
    }
}
