// src/controllers/ParentController.ts
import { Response, NextFunction } from "express";
import { ParentRequest } from "../middleware/parentMiddleware";
import { ParentService } from "../Services/ParentService";

export class ParentController {
    private service = new ParentService();

    getChildren = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const data = await this.service.getChildren(req.parentId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getChildResults = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const studentId = Number(req.params.studentId);
            const data = await this.service.getChildResults(req.parentId, studentId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getChildAttendance = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const studentId = Number(req.params.studentId);
            const { startDate, endDate } = req.query;
            const data = await this.service.getChildAttendance(
                req.parentId,
                studentId,
                startDate ? String(startDate) : undefined,
                endDate ? String(endDate) : undefined
            );
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getChildFees = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const studentId = Number(req.params.studentId);
            const data = await this.service.getChildFees(req.parentId, studentId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getAlerts = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const data = await this.service.getAlerts(req.parentId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    markAlertRead = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });
            const alertId = Number(req.params.alertId);
            const data = await this.service.markAlertRead(req.parentId, alertId);
            res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
