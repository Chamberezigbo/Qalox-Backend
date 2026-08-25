import { Response, NextFunction } from "express";
import { TeacherRequest } from "../../middleware/teacherMiddleware";
import { ExamTimetableService } from "../../Services/teacher/ExamTimetableService";

export class ExamTimetableController {
    private service = new ExamTimetableService();

    getUpcomingExams = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            const data = await this.service.getUpcomingExams(req.staffId!, req.schoolId!);
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
