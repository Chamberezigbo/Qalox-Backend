// src/services/teacher/TeacherService.ts
import prisma from "../../util/prisma";

type GetStudentsForGradingInput = {
    staffId: number;
    schoolId: number;
    classId?: number;
    subjectId?: number;
    academicSessionId?: number;
};

type CAScoreEntry = { studentId: number; caId: number; score: number };
type ExamScoreEntry = { studentId: number; examId: number; score: number };

export class TeacherService {
    async getStudentsForGrading(input: GetStudentsForGradingInput) {
        const {
            staffId,
            schoolId,
            classId,
            subjectId,
            academicSessionId
        } = input;

        // 1️⃣ Get active academic session if none selected
        const session =
            academicSessionId
                ? await prisma.academicSession.findUnique({
                    where: { id: academicSessionId }
                })
                : await prisma.academicSession.findFirst({
                    where: { schoolId, isActive: true }
                });

        if (!session) {
            throw new Error("No active academic session found");
        }

        // 2️⃣ Fetch teacher's assigned classes
        const assignments = await prisma.teacherAssignment.findMany({
            where: {
                staffId,
                ...(classId && { classId }),
                ...(subjectId && { subjectId })
            },
            include: {
                class: true,
                subject: true
            }
        });

        // 3️⃣ Get unique class IDs from assignments
        const assignedClassIds = assignments
            .filter(a => a.classId)
            .map(a => a.classId!);

        // 4️⃣ Fetch students from assigned classes
        const students = await prisma.student.findMany({
            where: {
                schoolId,
                classId: classId || { in: assignedClassIds },
                academicSessionId: session.id
            },
            select: {
                id: true,
                name: true,
                surname: true,
                otherNames: true,
                registrationNumber: true,
                classId: true,
                class: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                surname: 'asc'
            }
        });

        // 5️⃣ Fetch grading scheme for the class(es)
        const gradingSchemes = await prisma.gradingScheme.findMany({
            where: {
                schoolId,
                classes: {
                    some: {
                        classId: classId || { in: assignedClassIds }
                    }
                }
            },
            include: {
                grades: {
                    orderBy: { minScore: "desc" }
                }
            }
        });

        return {
            academicSession: session,
            assignments,
            students,
            gradingSchemes
        };
    }

    private async ensureTeacherCanTouchClass(staffId: number, classId: number, subjectId?: number) {
        const assignment = await prisma.teacherAssignment.findFirst({
            where: {
                staffId,
                classId,
                ...(subjectId ? { subjectId } : {})
            },
            select: { id: true }
        });
        if (!assignment) throw new Error("Forbidden: teacher not assigned to this class/subject");
    }

    async upsertCAScores(input: {
        staffId: number;
        schoolId: number;
        academicSessionId: number;
        termId?: number;
        entries: { studentId: number; caId: number; score: number }[];
    }) {
        const { staffId, schoolId, academicSessionId, termId, entries } = input;
        if (!Array.isArray(entries) || entries.length === 0) throw new Error("entries is required");

        const done = await prisma.$transaction(async (tx) => {
            let count = 0;

            for (const e of entries) {
                const ca = await tx.continuousAssessment.findUnique({
                    where: { id: e.caId },
                    select: { id: true, classId: true, subjectId: true, maxScore: true, class: { select: { schoolId: true } } }
                });
                if (!ca) throw new Error(`CA ${e.caId} not found`);
                if (ca.class.schoolId !== schoolId) throw new Error("CA does not belong to your school");

                if (ca.subjectId) {
                    // Check submission lock
                    const isSubmitted = await tx.resultSubmission.findFirst({
                        where: {
                            classId: ca.classId,
                            subjectId: ca.subjectId,
                            academicSessionId,
                            status: "PENDING"
                        },
                        select: { id: true }
                    });

                    if (isSubmitted) {
                        throw new Error("Results have been submitted for review. Scores are locked.");
                    }

                    // Check publication lock
                    const isPublished = await tx.publishedResult.findUnique({
                        where: {
                            classId_subjectId_academicSessionId: {
                                classId: ca.classId,
                                subjectId: ca.subjectId,
                                academicSessionId
                            }
                        },
                        select: { id: true }
                    });

                    if (isPublished) {
                        throw new Error("Results have been published and are permanently locked.");
                    }
                }


                await this.ensureTeacherCanTouchClass(staffId, ca.classId, ca.subjectId ?? undefined);

                if (e.score < 0 || e.score > Number(ca.maxScore)) {
                    throw new Error(`Score must be between 0 and ${ca.maxScore} for CA ${e.caId}`);
                }

                const existing = await tx.cAResult.findFirst({
                    where: { studentId: e.studentId, caId: e.caId, academicSessionId },
                    select: { id: true }
                });

                if (existing) {
                    await tx.cAResult.update({
                        where: { id: existing.id },
                        data: { score: e.score }
                    });
                } else {
                    await tx.cAResult.create({
                        data: { studentId: e.studentId, caId: e.caId, academicSessionId, score: e.score, termId: termId ?? null }
                    });
                }

                count++;
            }

            return count;
        });

        return { message: "CA scores saved", updated: done };
    }

    async upsertExamScores(input: {
        staffId: number;
        schoolId: number;
        academicSessionId: number;
        termId?: number;
        entries: ExamScoreEntry[];
    }) {
        const { staffId, schoolId, academicSessionId, termId, entries } = input;
        if (!Array.isArray(entries) || entries.length === 0) throw new Error("entries is required");

        const done = await prisma.$transaction(async (tx) => {
            let count = 0;

            for (const e of entries) {
                const exam = await tx.exam.findUnique({
                    where: { id: e.examId },
                    select: { id: true, classId: true, subjectId: true, maxScore: true, class: { select: { schoolId: true } } }
                });
                if (!exam) throw new Error(`Exam ${e.examId} not found`);
                if (exam.class.schoolId !== schoolId) throw new Error("Exam does not belong to your school");

                // Add this lock check:
                if (exam.subjectId) {
                    const isSubmitted = await tx.resultSubmission.findFirst({
                        where: {
                            classId: exam.classId,
                            subjectId: exam.subjectId,
                            academicSessionId,
                            status: "PENDING"
                        },
                        select: { id: true }
                    });

                    if (isSubmitted) {
                        throw new Error("Results have been submitted for review. Scores are locked.");
                    }

                    const isPublished = await tx.publishedResult.findUnique({
                        where: {
                            classId_subjectId_academicSessionId: {
                                classId: exam.classId,
                                subjectId: exam.subjectId,
                                academicSessionId
                            }
                        },
                        select: { id: true }
                    });

                    if (isPublished) {
                        throw new Error("Results have been published and are permanently locked.");
                    }
                }


                await this.ensureTeacherCanTouchClass(staffId, exam.classId, exam.subjectId ?? undefined);

                if (e.score < 0 || e.score > Number(exam.maxScore)) {
                    throw new Error(`Score must be between 0 and ${exam.maxScore} for Exam ${e.examId}`);
                }

                const existing = await tx.examResult.findFirst({
                    where: { studentId: e.studentId, examId: e.examId, academicSessionId },
                    select: { id: true }
                });

                if (existing) {
                    await tx.examResult.update({
                        where: { id: existing.id },
                        data: { score: e.score }
                    });
                } else {
                    await tx.examResult.create({
                        data: { studentId: e.studentId, examId: e.examId, academicSessionId, score: e.score, termId: termId ?? null }
                    });
                }

                count++;
            }

            return count;
        });

        return { message: "Exam scores saved", updated: done };
    }

    async getComputedResults(input: {
        staffId: number;
        schoolId: number;
        classId?: number;
        subjectId?: number;
        academicSessionId?: number;
        termId?: number;
    }) {
        const { staffId, schoolId, classId, subjectId, academicSessionId, termId } = input;

        // Get active/latest session if not provided
        let sessionId = academicSessionId;
        if (!sessionId) {
            const activeSession = await prisma.academicSession.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true }
            });

            if (!activeSession) {
                const latestSession = await prisma.academicSession.findFirst({
                    where: { schoolId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true }
                });
                if (!latestSession) throw new Error("No academic session found");
                sessionId = latestSession.id;
            } else {
                sessionId = activeSession.id;
            }
        }

        // Get all classes this teacher teaches if classId not provided
        let classIds: number[] = [];
        if (classId) {
            classIds = [classId];
        } else {
            const assignments = await prisma.teacherAssignment.findMany({
                where: { staffId },
                select: { classId: true },
                distinct: ["classId"]
            });
            classIds = assignments.map(a => a.classId!).filter(Boolean);
            if (classIds.length === 0) throw new Error("Teacher not assigned to any classes");
        }

        // Fetch results for all applicable classes/subjects
        const results = await Promise.all(
            classIds.map(async (cId) => {
                const classSubjects = subjectId
                    ? [subjectId]
                    : (await prisma.classSubject.findMany({
                        where: { classId: cId },
                        select: { subjectId: true }
                    })).map(cs => cs.subjectId);

                return Promise.all(
                    classSubjects.map(sId =>
                        this.computeClassResults({
                            staffId,
                            schoolId,
                            classId: cId,
                            subjectId: sId,
                            academicSessionId: sessionId,
                            termId
                        })
                    )
                );
            })
        );

        return results.flat();
    }

    private async computeClassResults(input: {
        staffId: number;
        schoolId: number;
        classId: number;
        subjectId: number;
        academicSessionId: number;
        termId?: number;
    }) {
        const { staffId, schoolId, classId, subjectId, academicSessionId, termId } = input;

        // Verify teacher is assigned to this class/subject
        await this.ensureTeacherCanTouchClass(staffId, classId, subjectId);

        // Get students in this class
        const students = await prisma.student.findMany({
            where: { classId, schoolId, academicSessionId },
            select: {
                id: true,
                surname: true,
                name: true,
                otherNames: true,
                registrationNumber: true
            }
        });

        // Get grading scheme for this class
        const schemeClass = await prisma.gradingSchemeClass.findUnique({
            where: { classId },
            include: { scheme: { include: { grades: true } } }
        });

        if (!schemeClass) throw new Error("No grading scheme assigned to this class");
        const rules = [...schemeClass.scheme.grades].sort((a, b) => b.minScore - a.minScore);

        // Fetch CAs for this subject in this class
        const cas = await prisma.continuousAssessment.findMany({
            where: { classId, subjectId },
            include: {
                caResults: {
                    where: { academicSessionId, ...(termId ? { termId } : {}) }
                }
            }
        });

        // Fetch Exams for this subject in this class
        const exams = await prisma.exam.findMany({
            where: { classId, subjectId },
            include: {
                examResults: {
                    where: { academicSessionId, ...(termId ? { termId } : {}) }
                }
            }
        });

        // Get subject name
        const subject = await prisma.subject.findUnique({
            where: { id: subjectId },
            select: { id: true, name: true }
        });

        if (!subject) throw new Error("Subject not found");

        // Build results for each student
        const rows = students.map((student) => {
            const caTotal = cas.reduce((acc, ca) => {
                const result = ca.caResults.find((r) => r.studentId === student.id);
                return acc + Number(result?.score ?? 0);
            }, 0);

            const examTotal = exams.reduce((acc, exam) => {
                const result = exam.examResults.find((r) => r.studentId === student.id);
                return acc + Number(result?.score ?? 0);
            }, 0);

            const subjectTotal = caTotal + examTotal;
            const matched = rules.find((r) => subjectTotal >= r.minScore && subjectTotal <= r.maxScore);

            return {
                studentId: student.id,
                studentName: `${student.surname} ${student.name} ${student.otherNames ?? ""}`.trim(),
                registrationNumber: student.registrationNumber,
                caTotal,
                examTotal,
                subjectTotal,
                grade: matched?.grade ?? null,
                remark: matched?.remark ?? null
            };
        });

        // Sort by score descending
        const sorted = [...rows].sort((a, b) => b.subjectTotal - a.subjectTotal);

        const usePosition = schemeClass.scheme.usePosition;
        const finalRows = sorted.map((row, index) => ({
            ...row,
            position: usePosition ? index + 1 : null
        }));

        return {
            classId,
            subjectId,
            subjectName: subject.name,
            academicSessionId,
            rows: finalRows
        };
    }


    async getTeacherBroadsheet(input: {
        staffId: number;
        schoolId: number;
        classId?: number;
        academicSessionId?: number;
        termId?: number;
    }) {
        const { staffId, schoolId, classId, academicSessionId, termId } = input;

        // Get active/latest session if not provided
        let sessionId = academicSessionId;
        if (!sessionId) {
            const activeSession = await prisma.academicSession.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true }
            });

            if (!activeSession) {
                const latestSession = await prisma.academicSession.findFirst({
                    where: { schoolId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true }
                });
                if (!latestSession) throw new Error("No academic session found");
                sessionId = latestSession.id;
            } else {
                sessionId = activeSession.id;
            }
        }

        // Get all classes this teacher teaches if classId not provided
        let classIds: number[] = [];
        if (classId) {
            classIds = [classId];
        } else {
            const assignments = await prisma.teacherAssignment.findMany({
                where: { staffId },
                select: { classId: true },
                distinct: ["classId"]
            });
            classIds = assignments.map(a => a.classId!).filter(Boolean);
            if (classIds.length === 0) throw new Error("Teacher not assigned to any classes");
        }

        // Reuse the shared broadsheet logic from AssessmentService
        const assessmentService = new (await import("../AssessmentService")).AssessmentService();

        // Fetch broadsheets for all applicable classes
        const results = await Promise.all(
            classIds.map(async (cId) => {
                // Get only subjects this teacher is assigned to in this class
                const assignments = await prisma.teacherAssignment.findMany({
                    where: { staffId, classId: cId },
                    select: { subjectId: true }
                });

                const subjectIds = assignments
                    .map((a) => a.subjectId)
                    .filter((id): id is number => id !== null);

                if (subjectIds.length === 0) {
                    return null;
                }

                return assessmentService.computeBroadsheet({
                    classId: cId,
                    schoolId,
                    academicSessionId: sessionId,
                    subjectIds,
                    termId
                });
            })
        );

        return results.filter(Boolean);
    }

    async submitResults(input: {
        staffId: number;
        schoolId: number;
        classId: number;
        subjectId: number;
        termId?: number;
        academicSessionId: number;
    }) {
        const { staffId, schoolId, classId, subjectId, termId, academicSessionId } = input;

        // 1. Verify teacher is assigned to this class + subject
        await this.ensureTeacherCanTouchClass(staffId, classId, subjectId);

        // 2. Block if already submitted
        const existing = await prisma.resultSubmission.findFirst({
            where: { classId, subjectId, academicSessionId, staffId }
        });

        if (existing) {
            throw new Error("Results already submitted for this class and subject");
        }

        // 3. Block if already published
        const isPublished = await prisma.publishedResult.findUnique({
            where: {
                classId_subjectId_academicSessionId: {
                    classId, subjectId, academicSessionId
                }
            }
        });

        if (isPublished) {
            throw new Error("Results have already been published");
        }

        // 4. Create submission record
        const submission = await prisma.resultSubmission.create({
            data: { classId, subjectId, academicSessionId, staffId, termId: termId ?? null },
            select: {
                id: true,
                classId: true,
                subjectId: true,
                academicSessionId: true,
                status: true,
                termId: true,
                submittedAt: true
            }
        });

        return submission;
    }

    async getSubjectCAs(input: {
        staffId: number;
        schoolId: number;
        subjectId: number;
        classId: number;
    }) {
        const { staffId, schoolId, subjectId, classId } = input;

        // Confirm this teacher is actually assigned to this class + subject
        await this.ensureTeacherCanTouchClass(staffId, classId, subjectId);

        // Confirm subject belongs to this school
        const subject = await prisma.subject.findFirst({
            where: { id: subjectId, schoolId },
            select: { id: true, name: true }
        });
        if (!subject) throw new Error("Subject not found");

        // Confirm class belongs to this school
        const cls = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true, name: true }
        });
        if (!cls) throw new Error("Class not found");

        // Fetch all CAs for this class + subject combination
        const cas = await prisma.continuousAssessment.findMany({
            where: {
                classId,
                subjectId  // narrows to only this subject's CAs
            },
            select: {
                id: true,
                name: true,     // e.g. "CA1", "CA2", "CA3"
                maxScore: true
            },
            orderBy: { name: "asc" }
        });

        return {
            subject,
            class: cls,
            cas  // teacher uses these caIds when saving scores
        };
    }

    async getSubjectExams(input: {
        staffId: number;
        schoolId: number;
        subjectId: number;
        classId: number;
    }) {
        const { staffId, schoolId, subjectId, classId } = input;

        // Step 1: confirm teacher is allowed to touch this class+subject
        await this.ensureTeacherCanTouchClass(staffId, classId, subjectId);

        // Step 2: confirm subject + class belong to this school
        const subject = await prisma.subject.findFirst({
            where: { id: subjectId, schoolId },
            select: { id: true, name: true }
        });
        if (!subject) throw new Error("Subject not found");

        const cls = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true, name: true }
        });
        if (!cls) throw new Error("Class not found");

        // Step 3: fetch exams for this class+subject — teacher picks the examId from here
        const exams = await prisma.exam.findMany({
            where: { classId, subjectId },
            select: {
                id: true,
                name: true,      // e.g. "Midterm", "Final"
                maxScore: true
            },
            orderBy: { name: "asc" }
        });

        return { subject, class: cls, exams };
    }

    async getTeacherClasses(staffId: number) {
        const assignments = await prisma.teacherAssignment.findMany({
            where: { staffId },
            select: {
                class: {
                    select: { id: true, name: true, customName: true }
                }
            },
            distinct: ["classId"]
        });

        return assignments.map(a => a.class);
    }

    async getTeacherCampus(staffId: number) {
        const teacher = await prisma.staff.findUnique({
            where: { id: staffId },
            select: {
                campus: {
                    select: { id: true, name: true, address: true, phoneNumber: true, email: true }
                }
            }
        });

        return teacher?.campus ?? null;
    }

    async getTeacherClassGroups(staffId: number) {
        // Get all classes assigned to this teacher
        const assignments = await prisma.teacherAssignment.findMany({
            where: { staffId },
            select: { classId: true },
            distinct: ["classId"]
        });

        const classIds = assignments.map(a => a.classId).filter(Boolean) as number[];

        if (classIds.length === 0) return [];

        // Get all class groups for these classes
        const classGroups = await prisma.classGroup.findMany({
            where: { classId: { in: classIds } },
            select: {
                id: true,
                name: true,
                classId: true,
                class: { select: { name: true, customName: true } }
            },
            orderBy: { class: { name: "asc" } }
        });

        return classGroups.map(group => ({
            ...group,
            className: group.class.customName ?? group.class.name
        }));
    }

    async getActiveSession(schoolId: number) {
        const session = await prisma.academicSession.findFirst({
            where: { schoolId, isActive: true },
            select: { id: true, name: true, isActive: true, createdAt: true }
        });

        if (!session) {
            throw new Error("No active academic session found");
        }

        return session;
    }

    async getCAsByFilters(input: {
        staffId: number;
        schoolId: number;
        classId?: number;
        classGroupId?: number;
    }) {
        const { staffId, schoolId, classId, classGroupId } = input;

        // Determine which class(es) to query
        let resolvedClassId: number;

        if (classId) {
            resolvedClassId = classId;
        } else if (classGroupId) {
            // Get the class this group belongs to
            const classGroup = await prisma.classGroup.findUnique({
                where: { id: classGroupId },
                select: { classId: true }
            });
            if (!classGroup) throw new Error("ClassGroup not found");
            resolvedClassId = classGroup.classId;
        } else {
            throw new Error("Either classId or classGroupId must be provided");
        }

        // Verify the class belongs to this school
        const cls = await prisma.class.findFirst({
            where: { id: resolvedClassId, schoolId },
            select: { id: true }
        });
        if (!cls) throw new Error("Class not found in this school");

        // Fetch CAs without results first
        const cas = await prisma.continuousAssessment.findMany({
            where: {
                classId: resolvedClassId
            },
            select: {
                id: true,
                name: true,
                maxScore: true,
                classId: true,
                subjectId: true,
                class: { select: { id: true, name: true } },
                subject: { select: { id: true, name: true } }
            },
            orderBy: { name: "asc" }
        });

        // Fetch CA results with students only (filter null students at DB level)
        const caResults = await prisma.cAResult.findMany({
            where: {
                ca: { classId: resolvedClassId }
            },
            include: {
                student: {
                    select: {
                        id: true,
                        surname: true,
                        name: true,
                        registrationNumber: true
                    }
                }
            }
        });

        // Combine CAs with their results, sorted by student surname
        const formattedCas = cas.map(ca => {
            const results = caResults
                .filter(r => r.caId === ca.id && r.student)
                .sort((a, b) => (a.student!.surname || "").localeCompare(b.student!.surname || ""))
                .map(r => ({
                    score: r.score,
                    studentId: r.student!.id,
                    studentName: `${r.student!.surname} ${r.student!.name}`.trim(),
                    registrationNumber: r.student!.registrationNumber
                }));

            return {
                ...ca,
                caResults: results
            };
        });

        return formattedCas;
    }

    async getExamsByFilters(input: {
        staffId: number;
        schoolId: number;
        classId?: number;
        classGroupId?: number;
    }) {
        const { staffId, schoolId, classId, classGroupId } = input;

        let resolvedClassId: number;

        if (classId) {
            resolvedClassId = classId;
        } else if (classGroupId) {
            // Get the class this group belongs to
            const classGroup = await prisma.classGroup.findUnique({
                where: { id: classGroupId },
                select: { classId: true }
            });
            if (!classGroup) throw new Error("ClassGroup not found");
            resolvedClassId = classGroup.classId;
        } else {
            throw new Error("Either classId or classGroupId must be provided");
        }
        // Verify the class belongs to this school
        const cls = await prisma.class.findFirst({
            where: { id: resolvedClassId, schoolId },
            select: { id: true }
        });
        if (!cls) throw new Error("Class not found in this school");
        // Fetch exams for this class
        const exams = await prisma.exam.findMany({
            where: {
                classId: resolvedClassId
            },
            include: {
                class: { select: { id: true, name: true } },
                subject: { select: { id: true, name: true } },
                examResults: {
                    select: {
                        score: true,
                        student: {
                            select: {
                                id: true,
                                surname: true,
                                name: true,
                                registrationNumber: true
                            }
                        }
                    }
                }
            },
            orderBy: { name: "asc" }
        });

        // Format response with student names combined, filter out null students and sort by surname
        const formattedExams = exams.map(exam => ({
            ...exam,
            examResults: exam.examResults
                .filter(result => result.student !== null)
                .sort((a, b) => (a.student!.surname || "").localeCompare(b.student!.surname || ""))
                .map(result => ({
                    score: result.score,
                    studentId: result.student!.id,
                    studentName: `${result.student!.surname} ${result.student!.name}`.trim(),
                    registrationNumber: result.student!.registrationNumber
                }))
        }));

        return formattedExams;
    }

    async getTeacherStudents(input: {
        staffId: number;
        schoolId: number;
        classId?: number;
        classGroupId?: number;
        subjectId?: number;
        academicSessionId?: number;
    }) {
        const { staffId, schoolId, classId, classGroupId, subjectId, academicSessionId } = input;

        // Get active/latest session if not provided
        let sessionId = academicSessionId;
        if (!sessionId) {
            const activeSession = await prisma.academicSession.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true }
            });

            if (!activeSession) {
                const latestSession = await prisma.academicSession.findFirst({
                    where: { schoolId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true }
                });
                if (!latestSession) throw new Error("No academic session found");
                sessionId = latestSession.id;
            } else {
                sessionId = activeSession.id;
            }
        }

        // Determine which class(es) to query
        let resolvedClassIds: number[] = [];

        if (classId) {
            resolvedClassIds = [classId];
        } else if (classGroupId) {
            // Get the class this group belongs to
            const classGroup = await prisma.classGroup.findUnique({
                where: { id: classGroupId },
                select: { classId: true }
            });
            if (!classGroup) throw new Error("ClassGroup not found");
            resolvedClassIds = [classGroup.classId];
        } else {
            // Get all classes this teacher is assigned to
            const assignments = await prisma.teacherAssignment.findMany({
                where: {
                    staffId,
                    ...(subjectId && { subjectId })
                },
                select: { classId: true },
                distinct: ["classId"]
            });
            resolvedClassIds = assignments.map(a => a.classId).filter((id): id is number => id !== null);

            if (resolvedClassIds.length === 0) {
                throw new Error("Teacher not assigned to any classes");
            }
        }

        // Fetch students from those classes in the active session
        const students = await prisma.student.findMany({
            where: {
                schoolId,
                classId: { in: resolvedClassIds },
                academicSessionId: sessionId,
                ...(classGroupId && { classGroupId })
            },
            select: {
                id: true,
                name: true,
                surname: true,
                otherNames: true,
                registrationNumber: true,
                email: true,
                gender: true,
                classId: true,
                class: {
                    select: { id: true, name: true, customName: true }
                }
            },
            orderBy: [
                { class: { name: "asc" } },
                { surname: "asc" }
            ]
        });

        return {
            academicSessionId: sessionId,
            classIds: resolvedClassIds,
            total: students.length,
            students: students.map(s => ({
                id: s.id,
                name: s.name,
                surname: s.surname,
                otherNames: s.otherNames,
                registrationNumber: s.registrationNumber,
                email: s.email,
                gender: s.gender,
                classId: s.classId,
                className: s.class.customName ?? s.class.name
            }))
        };
    }

    async getTeacherStudentsWithScores(input: {
        staffId: number;
        schoolId: number;
        classId?: number;
        classGroupId?: number;
        subjectId?: number;
        academicSessionId?: number;
        termId?: number;
    }) {
        const { staffId, schoolId, classId, classGroupId, subjectId, academicSessionId, termId } = input;

        // Get active/latest session if not provided
        let sessionId = academicSessionId;
        if (!sessionId) {
            const activeSession = await prisma.academicSession.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true }
            });

            if (!activeSession) {
                const latestSession = await prisma.academicSession.findFirst({
                    where: { schoolId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true }
                });
                if (!latestSession) throw new Error("No academic session found");
                sessionId = latestSession.id;
            } else {
                sessionId = activeSession.id;
            }
        }

        // Get active term if not provided
        let resolvedTermId = termId;
        if (!resolvedTermId) {
            const activeTerm = await prisma.academicTerm.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true }
            });
            if (activeTerm) {
                resolvedTermId = activeTerm.id;
            }
        }

        // Determine which class(es) to query
        let resolvedClassIds: number[] = [];

        if (classId) {
            resolvedClassIds = [classId];
        } else if (classGroupId) {
            const classGroup = await prisma.classGroup.findUnique({
                where: { id: classGroupId },
                select: { classId: true }
            });
            if (!classGroup) throw new Error("ClassGroup not found");
            resolvedClassIds = [classGroup.classId];
        } else {
            const assignments = await prisma.teacherAssignment.findMany({
                where: {
                    staffId,
                    ...(subjectId && { subjectId })
                },
                select: { classId: true },
                distinct: ["classId"]
            });
            resolvedClassIds = assignments.map(a => a.classId).filter((id): id is number => id !== null);

            if (resolvedClassIds.length === 0) {
                throw new Error("Teacher not assigned to any classes");
            }
        }

        // Fetch teacher's assigned subjects for the resolved classes first
        const teacherSubjects = await prisma.teacherAssignment.findMany({
            where: {
                staffId,
                classId: { in: resolvedClassIds },
                subjectId: { not: null },
                ...(subjectId && { subjectId })
            },
            select: {
                subject: {
                    select: { id: true, name: true, code: true }
                }
            },
            distinct: ["subjectId"]
        });

        const distinctSubjects = Array.from(
            new Map(
                teacherSubjects
                    .filter(a => a.subject !== null)
                    .map(a => [a.subject!.id, a.subject!])
            ).values()
        );

        const teacherSubjectIds = distinctSubjects.map(s => s.id);

        // Fetch CAs for those classes and teacher's subjects only
        const cas = await prisma.continuousAssessment.findMany({
            where: {
                classId: { in: resolvedClassIds },
                subjectId: { in: teacherSubjectIds },
                ...(subjectId && { subjectId })
            },
            select: {
                id: true,
                name: true,
                maxScore: true,
                subjectId: true,
                subject: { select: { id: true, name: true } },
                caResults: {
                    where: { academicSessionId: sessionId, ...(resolvedTermId ? { termId: resolvedTermId } : {}) },
                    select: { studentId: true, score: true }
                }
            },
            orderBy: { name: "asc" }
        });

        // Fetch Exams for those classes and teacher's subjects only
        const exams = await prisma.exam.findMany({
            where: {
                classId: { in: resolvedClassIds },
                subjectId: { in: teacherSubjectIds },
                ...(subjectId && { subjectId })
            },
            select: {
                id: true,
                name: true,
                maxScore: true,
                subjectId: true,
                subject: { select: { id: true, name: true } },
                examResults: {
                    where: { academicSessionId: sessionId, ...(resolvedTermId ? { termId: resolvedTermId } : {}) },
                    select: { studentId: true, score: true }
                }
            },
            orderBy: { name: "asc" }
        });

        // Fetch students from those classes
        const students = await prisma.student.findMany({
            where: {
                schoolId,
                classId: { in: resolvedClassIds },
                academicSessionId: sessionId,
                ...(classGroupId && { classGroupId })
            },
            select: {
                id: true,
                name: true,
                surname: true,
                otherNames: true,
                registrationNumber: true,
                classId: true,
                class: {
                    select: { id: true, name: true, customName: true }
                }
            },
            orderBy: [
                { class: { name: "asc" } },
                { surname: "asc" }
            ]
        });

        // Build response with individual CA scores
        const studentsWithScores = students.map(student => {
            // Build CA scores array with individual scores
            const caScores = cas.map(ca => {
                const result = ca.caResults.find(r => r.studentId === student.id);
                return {
                    caId: ca.id,
                    caName: ca.name,
                    score: result?.score ?? null,
                    maxScore: ca.maxScore
                };
            });

            // Get exam score
            const firstExam = exams.length > 0 ? exams[0] : null;
            const examResult = firstExam?.examResults.find(r => r.studentId === student.id) ?? null;
            const examScore = firstExam ? {
                examId: firstExam.id,
                examName: firstExam.name,
                score: examResult?.score ?? null,
                maxScore: firstExam.maxScore
            } : null;

            // Calculate totals
            const caTotal = caScores.reduce((sum, ca) => sum + Number(ca.score ?? 0), 0);
            const examTotal = examScore ? Number(examScore.score ?? 0) : 0;
            const grandTotal = caTotal + examTotal;

            return {
                id: student.id,
                registrationNumber: student.registrationNumber,
                surname: student.surname,
                name: student.name,
                otherNames: student.otherNames,
                className: student.class.customName ?? student.class.name,
                caScores,
                examScore,
                caTotal,
                examTotal,
                grandTotal
            };
        });

        return {
            academicSessionId: sessionId,
            termId: resolvedTermId ?? null,
            classIds: resolvedClassIds,
            subjects: distinctSubjects.map(s => ({
                id: s.id,
                name: s.name,
                code: s.code
            })),
            cas: cas.map(ca => ({
                id: ca.id,
                name: ca.name,
                maxScore: ca.maxScore,
                subject: ca.subject ? { id: ca.subject.id, name: ca.subject.name } : null
            })),
            exams: exams.map(exam => ({
                id: exam.id,
                name: exam.name,
                maxScore: exam.maxScore,
                subject: exam.subject ? { id: exam.subject.id, name: exam.subject.name } : null
            })),
            students: studentsWithScores
        };
    }

    async getTeacherSubjects(staffId: number) {
        const assignments = await prisma.teacherAssignment.findMany({
            where: {
                staffId,
                subjectId: { not: null }
            },
            select: {
                subject: {
                    select: {
                        id: true,
                        name: true,
                        code: true
                    }
                },
                class: {
                    select: {
                        id: true,
                        name: true,
                        customName: true
                    }
                }
            },
            distinct: ["subjectId"]
        });

        return assignments
            .filter(a => a.subject !== null)
            .map(a => ({
                id: a.subject!.id,
                name: a.subject!.name,
                code: a.subject!.code,
                class: a.class
                    ? {
                        id: a.class.id,
                        name: a.class.customName ?? a.class.name
                    }
                    : null
            }));
    }

    async getTeacherDetails(staffId: number) {
        const teacher = await prisma.staff.findUnique({
            where: { id: staffId },
            select: {
                id: true,
                name: true,
                registrationNumber: true,
                email: true,
                phoneNumber: true,
                address: true,
                duty: true,
                dateEmployed: true,
                schoolId: true
            }
        });

        if (!teacher) {
            throw new Error("Teacher not found");
        }

        return teacher;
    }

}
