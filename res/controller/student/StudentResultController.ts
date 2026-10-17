import { Response, NextFunction } from "express";
import { StudentRequest } from "../../middleware/studentMiddleware";
import { StudentResultService } from "../../Services/student/StudentResultService";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendPdf } = require("../../util/sendPdf");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildReportCardsPdf } = require("../../util/reportCardPdf");

export class StudentResultController {
    private resultService = new StudentResultService();

    getSessions = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const sessions = await this.resultService.getSessions(req.schoolId!);
            res.status(200).json({ success: true, data: sessions });
        } catch (err) {
            next(err);
        }
    };

    getResults = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const data = await this.resultService.getResults(
                req.studentId!,
                Number(req.schoolId!),
                academicSessionId,
                termId
            );
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getReportCard = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const data = await this.resultService.getReportCard(
                req.studentId!,
                Number(req.schoolId!),
                academicSessionId,
                termId
            );
            res.status(200).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    /** The student's own report card (published subjects only) as a PDF. */
    getReportCardPdf = async (req: StudentRequest, res: Response, next: NextFunction) => {
        try {
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const card = await this.resultService.getReportCard(req.studentId!, Number(req.schoolId!), academicSessionId, termId);
            const pdf = await buildReportCardsPdf([card]);
            sendPdf(res, pdf, `report-card-${card.academicInfo.termName ?? "term"}`, { inline: req.query.inline === "1" });
        } catch (err) {
            next(err);
        }
    };

}
