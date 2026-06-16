// src/controllers/teacher/TeacherOverviewController.ts
import { Response, NextFunction } from "express";
import { TeacherOverviewService } from "../../Services/teacher/OverviewService";

export interface TeacherRequest extends Request {
    staffId?: number;
    schoolId?: number;
}

export class TeacherOverviewController {
    private service = new TeacherOverviewService();

    getOverview = async (
        req: TeacherRequest,
        res: Response,
        next: NextFunction
    ) => {
        try {
            if (!req.staffId) {
                throw new Error("Unauthorized");
            }

            const metrics = await this.service.getOverview(req.staffId);

            res.json({
                success: true,
                data: metrics
            });
        } catch (err) {
            next(err);
        }
    };
}
