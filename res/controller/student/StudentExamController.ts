import { Response, NextFunction } from "express";
import { StudentRequest } from "../../middleware/studentMiddleware";
import { StudentExamService } from "../../Services/student/StudentExamService";

export class StudentExamController {
    private service = new StudentExamService();

    getUpcomingExams = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const data = await this.service.getUpcomingExams(req.studentId!);
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
