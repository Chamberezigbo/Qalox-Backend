import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
const { getSchoolLockStatus } = require("../util/getSchoolLockStatus");

export interface TeacherRequest extends Request {
    staffId?: number;
    schoolId?: number;
}

const JWT_SECRET = process.env.JWT_SECRET as string;
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

export const teacherAuthMiddleware = async (
    req: TeacherRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized: Missing token"
            });
        }

        const token = authHeader.split(" ")[1];

        const decoded = jwt.verify(token, JWT_SECRET) as {
            staffId: number;
            schoolId: number;
            role: string;
        };

        if (decoded.role !== "teacher") {
            return res.status(403).json({
                success: false,
                message: "Forbidden: Not a teacher"
            });
        }

        req.staffId = Number(decoded.staffId);
        req.schoolId = Number(decoded.schoolId);

        // Only the school admin can pay/redeem a coupon to unlock the school,
        // so unlike the admin auth middleware, teachers have no allowlisted
        // routes here — every mutation is blocked while locked, GETs pass.
        if (!SAFE_METHODS.includes(req.method)) {
            const { locked, graceEndsAt } = await getSchoolLockStatus(req.schoolId);
            if (locked) {
                return res.status(402).json({
                    success: false,
                    message: "This school's free period has ended. Ask your school admin to select a plan or redeem a coupon.",
                    code: "PAYMENT_REQUIRED",
                    lockedSince: graceEndsAt,
                });
            }
        }

        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized: Invalid token",
            error: err instanceof Error ? err.message : err
        });
    }
};
