// src/controllers/grading/GradingController.ts
import type { Request, Response, NextFunction } from "express"
import { GradingService } from "../../Services/teacher/GradingService"

interface AuthenticatedRequest extends Request {
    schoolId?: string
}

export class GradingController {
    private gradingService: GradingService;

    public create: (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) => Promise<void>;

    public addApplicableClasses: (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) => Promise<void>;

    public deleteRemark: (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) => Promise<void>;

    public getSchemes: (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) => Promise<void>;

    public update: (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) => Promise<void>;

    public deleteScheme: (
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) => Promise<void>;

    constructor() {
        this.gradingService = new GradingService();

        this.create = async (req, res, next) => {
            try {
                if (req.schoolId === undefined) throw new Error("Missing schoolId");

                const schoolId = Number(req.schoolId);
                if (isNaN(schoolId)) throw new Error("Invalid schoolId");

                const schema = await this.gradingService.createScheme(schoolId, req.body);
                
                res.status(201).json({
                    success: true,
                    message: "Grading scheme created successfully",
                    data: schema
                });
            } catch (error) {
                next(error as Error);    
            }
        }

        this.addApplicableClasses = async (req, res, next) => {
            try {
                if (req.schoolId === undefined) throw new Error("Missing schoolId");
                const schoolId = Number(req.schoolId);
                if (isNaN(schoolId)) throw new Error("Invalid schoolId");

                const schemeId = Number(req.params.schemeId);
                if (isNaN(schemeId)) throw new Error("Invalid schemeId");

                const { classIds } = req.body;
                const result = await this.gradingService.addClassesToScheme(schoolId, schemeId, classIds);

                res.status(200).json({
                    success: true,
                    message: "Applicable classes updated",
                    data: result
                });
            } catch (error) {
                next(error as Error);
            }
        };

        this.deleteRemark = async (req, res, next) => {
            try {
                if (req.schoolId === undefined) throw new Error("Missing schoolId");
                const schoolId = Number(req.schoolId);
                if (isNaN(schoolId)) throw new Error("Invalid schoolId");

                const ruleId = Number(req.params.ruleId);
                if (isNaN(ruleId)) throw new Error("Invalid ruleId");

                const result = await this.gradingService.deleteRemarkRule(schoolId, ruleId);

                res.status(200).json({
                    success: true,
                    message: "Remark deleted successfully",
                    data: result
                });
            } catch (error) {
                next(error as Error);
            }
        };

        this.getSchemes = async (req, res, next) => {
            try {
                if (req.schoolId === undefined) throw new Error("Missing schoolId");
                const schoolId = Number(req.schoolId);
                if (isNaN(schoolId)) throw new Error("Invalid schoolId");

                const schemes = await this.gradingService.getSchemesBySchool(schoolId);

                res.status(200).json({
                    success: true,
                    message: "Grading schemes retrieved successfully",
                    data: schemes
                });
            } catch (error) {
                next(error as Error);
            }
        };

        this.update = async (req, res, next) => {
            try {
                if (req.schoolId === undefined) throw new Error("Missing schoolId");
                const schoolId = Number(req.schoolId);
                if (isNaN(schoolId)) throw new Error("Invalid schoolId");

                const schemeId = Number(req.params.schemeId);
                if (isNaN(schemeId)) throw new Error("Invalid schemeId");

                const result = await this.gradingService.updateScheme(schoolId, schemeId, req.body);

                res.status(200).json({
                    success: true,
                    message: "Grading scheme updated successfully",
                    data: result
                });
            } catch (error) {
                next(error as Error);
            }
        };

        this.deleteScheme = async (req, res, next) => {
            try {
                if (req.schoolId === undefined) throw new Error("Missing schoolId");
                const schoolId = Number(req.schoolId);
                if (isNaN(schoolId)) throw new Error("Invalid schoolId");

                const schemeId = Number(req.params.schemeId);
                if (isNaN(schemeId)) throw new Error("Invalid schemeId");

                const result = await this.gradingService.deleteScheme(schoolId, schemeId);

                res.status(200).json({
                    success: true,
                    message: "Grading scheme deleted successfully",
                    data: result
                });
            } catch (error) {
                next(error as Error);
            }
        };
    }
}
