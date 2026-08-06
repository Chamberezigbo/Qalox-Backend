// src/controllers/teacher/TeacherAnalyticsController.ts
import { Response, NextFunction } from "express";
import { TeacherRequest } from "../../middleware/teacherMiddleware";
import { TeacherAnalyticsService } from "../../Services/teacher/TeacherAnalyticsService";

export class TeacherAnalyticsController {
    private service = new TeacherAnalyticsService();

    private handleError(err: unknown, res: Response, next: NextFunction) {
        if (err instanceof Error && err.message === "You are not assigned to this class") {
            return res.status(403).json({ success: false, message: err.message });
        }
        next(err);
    }

    getOverview = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const { classId } = req.query;
            if (!classId) return res.status(400).json({ success: false, message: "classId is required" });

            const data = await this.service.getOverview({ staffId: req.staffId, classId: Number(classId) });
            res.json({ success: true, data });
        } catch (err) {
            this.handleError(err, res, next);
        }
    };

    getBestStudents = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const { classId, limit } = req.query;
            if (!classId) return res.status(400).json({ success: false, message: "classId is required" });

            const data = await this.service.getBestStudents({
                staffId: req.staffId,
                classId: Number(classId),
                limit: limit ? Number(limit) : undefined,
            });
            res.json({ success: true, data });
        } catch (err) {
            this.handleError(err, res, next);
        }
    };

    getWeakStudents = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const { classId, limit } = req.query;
            if (!classId) return res.status(400).json({ success: false, message: "classId is required" });

            const data = await this.service.getWeakStudents({
                staffId: req.staffId,
                classId: Number(classId),
                limit: limit ? Number(limit) : undefined,
            });
            res.json({ success: true, data });
        } catch (err) {
            this.handleError(err, res, next);
        }
    };

    getSubjectFailureRates = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const { classId } = req.query;
            if (!classId) return res.status(400).json({ success: false, message: "classId is required" });

            const data = await this.service.getSubjectFailureRates({ staffId: req.staffId, classId: Number(classId) });
            res.json({ success: true, data });
        } catch (err) {
            this.handleError(err, res, next);
        }
    };
}
