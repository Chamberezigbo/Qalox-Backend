import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface TeacherRequest extends Request {
    staffId?: number;
    schoolId?: number;
}

const JWT_SECRET = process.env.JWT_SECRET as string;


export const teacherAuthMiddleware = (
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

        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized: Invalid token",
            error: err instanceof Error ? err.message : err
        });
    }
};
