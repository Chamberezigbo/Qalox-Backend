import type { Request, Response, NextFunction } from "express";
import { AcademicTermService } from "../../Services/AcademicTermService";

interface AuthenticatedRequest extends Request {
    schoolId?: string;
}

export class AcademicTermController {
    private service = new AcademicTermService();

    createTerm = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const { sessionId, name, resumptionDate } = req.body;
            if (!sessionId || !name) {
                return res.status(400).json({ message: "sessionId and name are required" });
            }

            const term = await this.service.createTerm({
                schoolId: Number(req.schoolId),
                sessionId: Number(sessionId),
                name,
                resumptionDate: resumptionDate ? new Date(resumptionDate) : undefined
            });

            return res.status(201).json({ success: true, message: "Term created", data: term });
        } catch (err) {
            next(err);
        }
    };

    activateTerm = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const termId = Number(req.params.id);
            if (isNaN(termId)) throw new Error("Invalid term ID");

            const result = await this.service.activateTerm({
                termId,
                schoolId: Number(req.schoolId)
            });

            return res.status(200).json({ success: true, message: "Term activated", data: result });
        } catch (err) {
            next(err);
        }
    };

    getTerms = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const sessionId = Number(req.query.sessionId);
            if (isNaN(sessionId)) throw new Error("sessionId is required");

            const result = await this.service.getTerms({
                schoolId: Number(req.schoolId),
                sessionId
            });

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };

    getActiveTerm = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const result = await this.service.getActiveTerm(Number(req.schoolId));

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };

    createSession = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");
            const { name } = req.body;
            if (!name) return res.status(400).json({ message: "Session name is required" });

            const session = await this.service.createSession({ schoolId: Number(req.schoolId), name });
            return res.status(201).json({ success: true, message: "Session created", data: session });
        } catch (err) {
            next(err);
        }
    };

    getSessions = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");
            const sessions = await this.service.getSessions(Number(req.schoolId));
            return res.status(200).json({ success: true, data: sessions });
        } catch (err) {
            next(err);
        }
    };

    updateTerm = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const termId = Number(req.params.id);
            if (isNaN(termId)) throw new Error("Invalid term ID");

            const { name, resumptionDate } = req.body;

            const result = await this.service.updateTerm({
                termId,
                schoolId: Number(req.schoolId),
                name,
                resumptionDate: resumptionDate ? new Date(resumptionDate) : undefined
            });

            return res.status(200).json({ success: true, message: "Term updated", data: result });
        } catch (err) {
            next(err);
        }
    };

}
