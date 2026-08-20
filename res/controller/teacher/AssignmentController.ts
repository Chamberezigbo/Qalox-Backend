import { Response, NextFunction } from "express";
import { TeacherRequest } from "../../middleware/teacherMiddleware";
import { AssignmentService } from "../../Services/teacher/AssignmentService";

export class AssignmentController {
    private service = new AssignmentService();

    create = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const { classId, subjectId, title, description, dueDate } = req.body;
            const data = await this.service.create({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: Number(classId),
                subjectId: Number(subjectId),
                title,
                description,
                dueDate,
            });

            return res.status(201).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    list = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.listForTeacher(req.staffId);
            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    update = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ message: "Unauthorized" });

            const { classId, subjectId, title, description, dueDate } = req.body;
            const data = await this.service.update(req.staffId, Number(req.params.id), {
                ...(classId !== undefined && { classId: Number(classId) }),
                ...(subjectId !== undefined && { subjectId: Number(subjectId) }),
                ...(title !== undefined && { title }),
                ...(description !== undefined && { description }),
                ...(dueDate !== undefined && { dueDate }),
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    remove = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.remove(req.staffId, Number(req.params.id));
            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
