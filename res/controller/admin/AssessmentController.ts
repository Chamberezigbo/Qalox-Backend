import type { Request, Response, NextFunction } from "express";
import { AssessmentService } from "../../Services/AssessmentService";

interface AuthenticatedRequest extends Request {
    schoolId?: string;
}

export class AssessmentController {
    private service = new AssessmentService();

    createCATemplate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const schoolId = Number(req.schoolId);
            const { classId, templates } = req.body;

            // templates must be a non-empty array
            if (!Array.isArray(templates) || templates.length === 0) {
                throw new Error("templates must be a non-empty array");
            }

            // each template must have name, maxScore, isExam
            for (const t of templates) {
                if (!t.name || t.maxScore === undefined || t.isExam === undefined) {
                    throw new Error("Each template must have name, maxScore and isExam");
                }
            }

            const result = await this.service.createCATemplate({
                schoolId,
                classId: classId ? Number(classId) : undefined,
                templates
            });

            const scope = classId ? `class ${classId}` : "school";

            return res.status(201).json({
                success: true,
                message: `CA template set for ${scope}`,
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    getCATemplates = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const classId = req.query.classId ? Number(req.query.classId) : undefined;

            const result = await this.service.getCATemplates(Number(req.schoolId), classId);

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };


    assignSubjectsToClass = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const { classId, subjectIds } = req.body;
            const adminId = (req as any).user?.id;

            if (!classId || isNaN(Number(classId))) throw new Error("Invalid classId");
            if (!Array.isArray(subjectIds) || subjectIds.length === 0) {
                throw new Error("subjectIds must be a non-empty array");
            }

            const result = await this.service.assignSubjectsToClass({
                classId: Number(classId),
                subjectIds: subjectIds.map(Number),
                schoolId: Number(req.schoolId),
                adminId: Number(adminId)
            });

            return res.status(201).json({
                success: true,
                message: `${result.assigned} subject(s) assigned. ${result.casCreated} CA(s) and ${result.examsCreated} exam(s) auto-generated.`,
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    getClassSubjects = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const classId = Number(req.params.classId);
            if (isNaN(classId)) throw new Error("Invalid classId");

            const result = await this.service.getClassSubjects(classId, Number(req.schoolId));

            return res.status(200).json({
                success: true,
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    deleteSubjectFromClass = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const classId = Number(req.params.classId);
            const subjectId = Number(req.params.subjectId);

            if (isNaN(classId)) throw new Error("Invalid classId");
            if (isNaN(subjectId)) throw new Error("Invalid subjectId");

            const result = await this.service.deleteSubjectFromClass(classId, subjectId, Number(req.schoolId));

            return res.status(200).json({
                success: true,
                message: "Subject removed from class and all associated CAs/Exams deleted",
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    publishResults = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const { classId, subjectId, academicSessionId } = req.body;
            const adminId = (req as any).user?.id;

            if (!classId || !subjectId || !academicSessionId) {
                throw new Error("classId, subjectId and academicSessionId are all required");
            }

            const result = await this.service.publishResults({
                classId: Number(classId),
                subjectId: Number(subjectId),
                academicSessionId: Number(academicSessionId),
                schoolId: Number(req.schoolId),
                adminId: Number(adminId)
            });

            return res.status(201).json({
                success: true,
                message: "Results published successfully",
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    getPendingSubmissions = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const campusId = req.query.campusId ? Number(req.query.campusId) : undefined;
            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;
            const subjectId = req.query.subjectId ? Number(req.query.subjectId) : undefined;

            const result = await this.service.getPendingSubmissions({
                schoolId: Number(req.schoolId),
                campusId,
                classId,
                academicSessionId,
                termId,
                subjectId
            });

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };

    getRejectedResults = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const campusId = req.query.campusId ? Number(req.query.campusId) : undefined;
            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;
            const subjectId = req.query.subjectId ? Number(req.query.subjectId) : undefined;

            const result = await this.service.getRejectedResults({
                schoolId: Number(req.schoolId),
                campusId,
                classId,
                academicSessionId,
                termId,
                subjectId
            });

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };

    rejectSubmission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const submissionId = Number(req.params.submissionId);
            if (isNaN(submissionId)) throw new Error("Invalid submissionId");

            const result = await this.service.rejectSubmission(submissionId, Number(req.schoolId));

            return res.status(200).json({
                success: true,
                message: "Submission rejected. Teacher can now re-enter scores.",
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    restoreRejectedSubmission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const submissionId = Number(req.params.submissionId);
            if (isNaN(submissionId)) throw new Error("Invalid submissionId");

            const result = await this.service.restoreRejectedSubmission(submissionId, Number(req.schoolId));

            return res.status(200).json({
                success: true,
                message: result.message,
                data: result.data
            });
        } catch (err) {
            next(err);
        }
    };

    getAdminBroadsheet = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const classGroupId = req.query.classGroupId ? Number(req.query.classGroupId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const result = await this.service.getAdminBroadsheet({
                classId,
                academicSessionId,
                schoolId: Number(req.schoolId),
                classGroupId,
                termId
            });

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };

    getStudentResult = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const studentId = req.query.studentId ? Number(req.query.studentId) : undefined;
            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;
            const page = req.query.page ? Number(req.query.page) : 1;
            const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 10;

            const result = await this.service.getStudentResult({
                studentId,
                classId,
                schoolId: Number(req.schoolId),
                academicSessionId,
                termId,
                page,
                pageSize
            });

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };


    getTeacherResult = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const staffId = req.query.staffId ? Number(req.query.staffId) : undefined;
            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const subjectId = req.query.subjectId ? Number(req.query.subjectId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const page = req.query.page ? Number(req.query.page) : 1;
            const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 8;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const result = await this.service.getTeacherResult({
                staffId,
                classId,
                subjectId,
                schoolId: Number(req.schoolId),
                academicSessionId,
                page,
                pageSize,
                termId
            });

            return res.status(200).json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };


    scheduleExam = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) throw new Error("Missing schoolId");

            const examId = Number(req.params.examId);
            const { scheduledDate } = req.body;

            if (!scheduledDate) {
                return res.status(400).json({ message: "scheduledDate is required" });
            }

            const result = await this.service.scheduleExam({
                examId,
                schoolId: Number(req.schoolId),
                scheduledDate: new Date(scheduledDate)
            });

            return res.status(200).json({ success: true, message: "Exam scheduled", data: result });
        } catch (err) {
            next(err);
        }
    };

    getStudentCompleteResult = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const studentId = Number(req.params.studentId);
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            if (Number.isNaN(studentId)) {
                return res.status(400).json({ message: "Invalid studentId" });
            }

            const data = await this.service.getStudentCompleteResult({
                studentId,
                schoolId: Number(req.schoolId),
                academicSessionId,
                termId
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    unpublishResults = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const publishedResultId = Number(req.params.publishedResultId);
            if (isNaN(publishedResultId)) {
                return res.status(400).json({ message: "Invalid publishedResultId" });
            }

            const result = await this.service.unpublishResults(publishedResultId, Number(req.schoolId));

            return res.status(200).json({
                success: true,
                message: result.message,
                data: result.data
            });
        } catch (err) {
            next(err);
        }
    };

    createRemarkScheme = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const { name, rules } = req.body;

            if (!name) {
                return res.status(400).json({ message: "Scheme name is required" });
            }

            if (!Array.isArray(rules) || rules.length === 0) {
                return res.status(400).json({ message: "Rules must be a non-empty array" });
            }

            for (const rule of rules) {
                if (rule.minScore === undefined || rule.maxScore === undefined || !rule.remark) {
                    return res.status(400).json({ message: "Each rule must have minScore, maxScore, and remark" });
                }
            }

            const data = await this.service.createRemarkScheme({
                schoolId: Number(req.schoolId),
                name,
                rules
            });

            return res.status(201).json({
                success: true,
                message: "Remark scheme created successfully",
                data
            });
        } catch (err) {
            next(err);
        }
    };

    addRemarkRules = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const schemeId = Number(req.params.schemeId);
            const { rules } = req.body;

            if (Number.isNaN(schemeId)) {
                return res.status(400).json({ message: "Invalid schemeId" });
            }

            if (!Array.isArray(rules) || rules.length === 0) {
                return res.status(400).json({ message: "Rules must be a non-empty array" });
            }

            const data = await this.service.addRemarkRules({
                schemeId,
                schoolId: Number(req.schoolId),
                rules
            });

            return res.status(201).json({
                success: true,
                message: "Remark rules added successfully",
                data
            });
        } catch (err) {
            next(err);
        }
    };

    getRemarkScheme = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const data = await this.service.getRemarkScheme(Number(req.schoolId));

            return res.status(200).json({
                success: true,
                data
            });
        } catch (err) {
            next(err);
        }
    };

    getResultsByStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const status = req.query.status as string;
            const campusId = req.query.campusId ? Number(req.query.campusId) : undefined;
            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;
            const subjectId = req.query.subjectId ? Number(req.query.subjectId) : undefined;

            if (!status || !["published", "rejected", "pending"].includes(status.toLowerCase())) {
                return res.status(400).json({
                    message: "Invalid status. Use 'published', 'rejected', or 'pending'"
                });
            }

            const filterParams = {
                schoolId: Number(req.schoolId),
                campusId,
                classId,
                academicSessionId,
                termId,
                subjectId
            };

            let data;
            if (status.toLowerCase() === "published") {
                data = await this.service.getPublishedResults(filterParams);
            } else if (status.toLowerCase() === "rejected") {
                data = await this.service.getRejectedResults(filterParams);
            } else {
                data = await this.service.getPendingSubmissions(filterParams);
            }

            return res.status(200).json({
                success: true,
                status: status.toLowerCase(),
                data
            });
        } catch (err) {
            next(err);
        }
    };

}
