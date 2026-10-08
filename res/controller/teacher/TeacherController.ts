// src/controllers/teacher/TeacherController.ts
import { Response, NextFunction } from "express";
import { TeacherRequest } from "../../middleware/teacherMiddleware";
import { TeacherService } from "../../Services/teacher/TeacherService";
import { AcademicTermService } from "../../Services/AcademicTermService";
import prisma from "../../util/prisma";


export class TeacherController {
    private service = new TeacherService();
    private academicTermService = new AcademicTermService();

    getStudentsForGrading = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            const { classId, subjectId } = req.query;
            const { academicSessionId } = req.query;

            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const data = await this.service.getStudentsForGrading({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: classId ? Number(classId) : undefined,
                subjectId: subjectId ? Number(subjectId) : undefined,
                academicSessionId: academicSessionId ? Number(academicSessionId) : undefined
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    upsertCAScores = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.upsertCAScores({
                staffId: req.staffId,
                schoolId: req.schoolId,
                academicSessionId: Number(req.body.academicSessionId),
                termId: req.body.termId ? Number(req.body.termId) : undefined,
                entries: req.body.entries
            });

            return res.json({ success: true, ...data });
        } catch (err) {
            next(err);
        }
    };

    upsertExamScores = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.upsertExamScores({
                staffId: req.staffId,
                schoolId: req.schoolId,
                termId: req.body.termId ? Number(req.body.termId) : undefined,
                academicSessionId: Number(req.body.academicSessionId),
                entries: req.body.entries
            });

            return res.json({ success: true, ...data });
        } catch (err) {
            next(err);
        }
    };

    getComputedResults = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.getComputedResults({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: req.query.classId ? Number(req.query.classId) : undefined,
                subjectId: req.query.subjectId ? Number(req.query.subjectId) : undefined,
                academicSessionId: req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined,
                termId: req.query.termId ? Number(req.query.termId) : undefined
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    // NOTE: Grading scheme creation/management has been moved to admin-only endpoints
    // See POST /admin/grading/create for the replacement endpoint
    // Teachers can only view results using existing schemes

    getTeacherBroadsheet = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const data = await this.service.getTeacherBroadsheet({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId,
                academicSessionId,
                termId
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    submitResults = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const { classId, subjectId, academicSessionId } = req.body;

            if (!classId || !subjectId || !academicSessionId) {
                throw new Error("classId, subjectId and academicSessionId are required");
            }

            const result = await this.service.submitResults({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: Number(classId),
                subjectId: Number(subjectId),
                academicSessionId: Number(academicSessionId),
                termId: req.body.termId ? Number(req.body.termId) : undefined,
                // Strictly `true`: anything else (a string, a missing field) must
                // not switch off the missing-scores check by accident.
                force: req.body.force === true
            });

            return res.status(201).json({
                success: true,
                message: "Results submitted successfully. Scores are now locked pending admin review.",
                data: result
            });
        } catch (err) {
            next(err);
        }
    };

    submitAllResults = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const { classId, academicSessionId } = req.body;

            if (!classId || !academicSessionId) {
                throw new Error("classId and academicSessionId are required");
            }

            const data = await this.service.submitAllResults({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: Number(classId),
                academicSessionId: Number(academicSessionId),
                termId: req.body.termId ? Number(req.body.termId) : undefined
            });

            const { submitted, skipped, failed } = data.counts;
            const message =
                submitted > 0
                    ? `Submitted ${submitted} subject${submitted === 1 ? "" : "s"}. Scores are now locked pending admin review.`
                    : failed > 0
                        ? "No subjects could be submitted."
                        : "Nothing new to submit — every subject was already submitted or has no scores yet.";

            return res.status(200).json({
                success: failed === 0,
                message: skipped > 0 && submitted > 0 ? `${message} ${skipped} skipped.` : message,
                data
            });
        } catch (err) {
            next(err);
        }
    };

    getSubjectCAs = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const subjectId = Number(req.params.subjectId);
            const classId = Number(req.query.classId);

            if (!subjectId || !classId) {
                throw new Error("subjectId (param) and classId (query) are required");
            }

            const data = await this.service.getSubjectCAs({
                staffId: req.staffId,
                schoolId: req.schoolId,
                subjectId,
                classId
            });

            return res.json({ success: true, data });
        } catch (err: any) {
            if (err.message?.includes("Forbidden")) {
                return res.status(403).json({ success: false, message: err.message });
            }
            next(err);
        }
    };

    getSubjectExams = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const subjectId = Number(req.params.subjectId);
            const classId = Number(req.query.classId);

            if (!subjectId || !classId) {
                throw new Error("subjectId (param) and classId (query) are required");
            }

            const data = await this.service.getSubjectExams({
                staffId: req.staffId,
                schoolId: req.schoolId,
                subjectId,
                classId
            });

            return res.json({ success: true, data });
        } catch (err: any) {
            if (err.message?.includes("Forbidden")) {
                return res.status(403).json({ success: false, message: err.message });
            }
            next(err);
        }
    };

    getActiveTerm = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const result = await this.academicTermService.getActiveTerm(req.schoolId);

            return res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    };

    getMyClasses = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.getTeacherClasses(req.staffId);

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getMyCampus = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.getTeacherCampus(req.staffId);

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getMyClassGroups = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.getTeacherClassGroups(req.staffId);

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getActiveSession = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ message: "Unauthorized" });

            const data = await this.service.getActiveSession(Number(req.schoolId));

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getStudents = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const classGroupId = req.query.classGroupId ? Number(req.query.classGroupId) : undefined;
            const subjectId = req.query.subjectId ? Number(req.query.subjectId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;

            const data = await this.service.getTeacherStudents({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId,
                classGroupId,
                subjectId,
                academicSessionId
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getCAs = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const classGroupId = req.query.classGroupId ? Number(req.query.classGroupId) : undefined;

            // At least one filter must be provided
            if (!classId && !classGroupId) {
                return res.status(400).json({ message: "Either classId or classGroupId is required" });
            }

            const data = await this.service.getCAsByFilters({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId,
                classGroupId
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getExams = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const classGroupId = req.query.classGroupId ? Number(req.query.classGroupId) : undefined;

            // At least one filter must be provided
            if (!classId && !classGroupId) {
                return res.status(400).json({ message: "Either classId or classGroupId is required" });
            }

            const data = await this.service.getExamsByFilters({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId,
                classGroupId
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getStudentsWithScores = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const classId = req.query.classId ? Number(req.query.classId) : undefined;
            const classGroupId = req.query.classGroupId ? Number(req.query.classGroupId) : undefined;
            const subjectId = req.query.subjectId ? Number(req.query.subjectId) : undefined;
            const academicSessionId = req.query.academicSessionId ? Number(req.query.academicSessionId) : undefined;
            const termId = req.query.termId ? Number(req.query.termId) : undefined;

            const data = await this.service.getTeacherStudentsWithScores({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId,
                classGroupId,
                subjectId,
                academicSessionId,
                termId
            });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    async getTeacherSubjects(req: TeacherRequest, res: Response) {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const teacherService = new TeacherService();
            const subjects = await teacherService.getTeacherSubjects(req.staffId);

            return res.status(200).json({
                success: true,
                total: subjects.length,
                subjects
            });
        } catch (error: any) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * GET /api/teacher/subjects?classId=N
     *
     * The subjects this teacher is assigned to teach IN a given class — not
     * every subject they teach anywhere, which is what /my-subjects returns.
     * Any screen that asks "which subject, in this class?" needs this one:
     * the AI lesson note generator and the scheme of work upload both do, and
     * both were calling this path while nothing served it (404), which is why
     * their Subject dropdowns came up empty.
     */
    getSubjectsForClass = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const classId = Number(req.query.classId);
            if (!classId) {
                return res.status(400).json({
                    success: false,
                    message: "classId is required",
                    code: "INVALID_REQUEST",
                });
            }

            const assignments = await prisma.teacherAssignment.findMany({
                where: { staffId: req.staffId, classId },
                select: { subject: { select: { id: true, name: true } } },
            });

            // subjectId is nullable on TeacherAssignment (a teacher can be
            // assigned to a class without a subject), and the same pair can
            // appear more than once across campuses — so drop the empties and
            // de-duplicate rather than handing the dropdown repeats.
            const byId = new Map<number, { id: number; name: string }>();
            for (const { subject } of assignments) {
                if (subject) byId.set(subject.id, subject);
            }

            return res.status(200).json({
                success: true,
                data: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
            });
        } catch (err) {
            next(err);
        }
    };

    getTeacherDetails = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const data = await this.service.getTeacherDetails(req.staffId);

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    getSchoolBranding = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const data = await this.service.getSchoolBranding(req.schoolId);

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

}
