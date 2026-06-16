import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Extend Express's Request type so TypeScript knows about our custom fields
export interface StudentRequest extends Request {
    studentId?: number;
    schoolId?: number;
}

const JWT_SECRET = process.env.JWT_SECRET as string;

export const studentAuthMiddleware = (
    req: StudentRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const authHeader = req.headers.authorization;

        // Must be a Bearer token
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized: Missing token"
            });
        }

        const token = authHeader.split(" ")[1]; // Extract the token after "Bearer "

        const decoded = jwt.verify(token, JWT_SECRET) as {
            studentId: number;
            schoolId: number;
            role: string;
        };

        // Make sure this token belongs to a student, not an admin or teacher
        if (decoded.role !== "student") {
            return res.status(403).json({
                success: false,
                message: "Forbidden: Not a student"
            });
        }

        // Attach to request so protected route handlers can use them
        req.studentId = Number(decoded.studentId);
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
