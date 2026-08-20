import { Response, NextFunction } from "express";
import { StudentRequest } from "../../middleware/studentMiddleware";
import { AssignmentService } from "../../Services/teacher/AssignmentService";

export class StudentAssignmentController {
    private service = new AssignmentService();

    list = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const data = await this.service.listForStudent(req.studentId!);
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
