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

    getBankAccounts = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const data = await this.service.getBankAccounts(req.studentId!);
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    declarePayment = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const studentFeeId = Number(req.params.studentFeeId);
            const { bankAccountId, amount } = req.body;
            const data = await this.service.declarePayment(
                req.studentId!,
                studentFeeId,
                Number(bankAccountId),
                Number(amount)
            );
            res.status(201).json({ success: true, message: "Payment declared — awaiting confirmation from the school", data });
        } catch (err) {
            next(err);
        }
    };

    getReceipt = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const studentFeeId = Number(req.params.studentFeeId);
            const data = await this.service.getReceipt(req.studentId!, studentFeeId);
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
