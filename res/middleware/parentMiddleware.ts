import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface ParentRequest extends Request {
    parentId?: number;
}

const JWT_SECRET = process.env.JWT_SECRET as string;

export const parentAuthMiddleware = (
    req: ParentRequest,
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
            parentId: number;
            role: string;
        };

        if (decoded.role !== "parent") {
            return res.status(403).json({
                success: false,
                message: "Forbidden: Not a parent"
            });
        }

        req.parentId = Number(decoded.parentId);

        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized: Invalid token",
            error: err instanceof Error ? err.message : err
        });
    }
};
