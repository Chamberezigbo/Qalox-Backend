import { Response, NextFunction } from "express";
import { StudentRequest } from "../../middleware/studentMiddleware";
import { StudentFeeService } from "../../Services/student/StudentFeeService";

export class StudentFeeController {
    private service = new StudentFeeService();

    getFees = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const data = await this.service.getFees(req.studentId!);
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    initiateFeePayment = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const studentFeeId = Number(req.params.studentFeeId);
            const data = await this.service.initiateFeePayment(req.studentId!, studentFeeId);
            res.status(201).json({ success: true, message: "Payment initialized", data });
        } catch (err) {
            next(err);
        }
    };
}
