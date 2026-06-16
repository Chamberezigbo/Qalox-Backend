import { Response, NextFunction } from "express";
import { StudentRequest } from "../../middleware/studentMiddleware";
import { StudentDashboardService } from "../../Services/student/StudentDashboardService";

export class StudentDashboardController {
    private dashboardService = new StudentDashboardService();

    getDashboard = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            // studentId comes from the decoded JWT, not from req.body
            const result = await this.dashboardService.getDashboard(req.studentId!);

            res.status(200).json({
                success: true,
                data: result
            });
        } catch (err) {
            next(err);
        }
    };
}
