import prisma from "../util/prisma";

export class AssessmentService {

    async createCATemplate(data: {
        schoolId: number;
        classId?: number;
        templates: { name: string; maxScore: number; isExam: boolean }[];
    }) {
        const { schoolId, classId, templates } = data;

        // 1. Verify school exists
        const school = await prisma.school.findUnique({
            where: { id: schoolId },
            select: { id: true }
        });

        if (!school) throw new Error("School not found");

        // 2. If classId provided, verify class belongs to this school
        if (classId) {
            const classRecord = await prisma.class.findFirst({
                where: { id: classId, schoolId },
                select: { id: true }
            });

            if (!classRecord) throw new Error("Class not found or does not belong to your school");
        }

        // 3. Validate that both CA and Exam templates are provided
        const hasCATemplates = templates.some((t) => !t.isExam);
        const hasExamTemplates = templates.some((t) => t.isExam);

        if (!hasCATemplates || !hasExamTemplates) {
            throw new Error(
                "Templates must include both CA templates (isExam: false) and Exam templates (isExam: true). " +
                `Received: ${hasCATemplates ? "CA templates ✓" : "No CA templates ✗"}, ${hasExamTemplates ? "Exam templates ✓" : "No Exam templates ✗"}`
            );
        }

        // 4. Get existing templates to compare changes
        const oldTemplates = await prisma.cATemplate.findMany({
            where: {
                schoolId,
                classId: classId ?? null
            }
        });

        // 5. Run in transaction for data consistency
        return prisma.$transaction(async (tx) => {
            // Delete existing templates for this school+class combo before replacing
            await tx.cATemplate.deleteMany({
                where: {
                    schoolId,
                    classId: classId ?? null
                }
            });

            // Create all new templates
            await tx.cATemplate.createMany({
                data: templates.map((t) => ({
                    schoolId,
                    classId: classId ?? null,
                    name: t.name,
                    maxScore: t.maxScore,
                    isExam: t.isExam
                }))
            });

            // Update existing CAs and Exams that match template names
            // This ensures when templates change, all created assessments update
            for (const newTemplate of templates) {
                const oldTemplate = oldTemplates.find((t) => t.name === newTemplate.name && t.isExam === newTemplate.isExam);

                // If maxScore changed, update all matching assessments in the school
                if (oldTemplate && oldTemplate.maxScore !== newTemplate.maxScore) {
                    if (newTemplate.isExam) {
                        // Update all exams with this name in this school
                        await tx.exam.updateMany({
                            where: {
                                name: newTemplate.name,
                                class: { schoolId }
                            },
                            data: { maxScore: newTemplate.maxScore }
                        });
                    } else {
                        // Update all CAs with this name in this school
                        await tx.continuousAssessment.updateMany({
                            where: {
                                name: newTemplate.name,
                                class: { schoolId }
                            },
                            data: { maxScore: newTemplate.maxScore }
                        });
                    }
                }
            }

            // Return what was saved
            const saved = await tx.cATemplate.findMany({
                where: { schoolId, classId: classId ?? null },
                select: { id: true, name: true, maxScore: true, isExam: true, classId: true }
            });

            return saved;
        });
    }

    async getCATemplates(schoolId: number, classId?: number) {
        // School-wide template (classId = null)
        const schoolWide = await prisma.cATemplate.findMany({
            where: { schoolId, classId: null },
            select: { id: true, name: true, maxScore: true, isExam: true }
        });

        // Class-specific template only if classId was provided

        let classSpecific: {
            classId: number;
            className: string;
            templates: { name: string; id: number; maxScore: number; isExam: boolean }[];
        } | null = null;


        if (classId) {
            const classRecord = await prisma.class.findFirst({
                where: { id: classId, schoolId },
                select: { id: true, name: true }
            });
            if (!classRecord) throw new Error("Class not found or does not belong to your school");

            const templates = await prisma.cATemplate.findMany({
                where: { schoolId, classId },
                select: { id: true, name: true, maxScore: true, isExam: true }
            });

            classSpecific = {
                classId,
                className: classRecord.name,
                templates  // empty array means class uses school-wide
            };
        }

        return { schoolWide, classSpecific };
    }


    async assignSubjectsToClass(data: {
        classId: number;
        subjectIds: number[];
        schoolId: number;
        adminId: number;
    }) {
        const { classId, subjectIds, schoolId, adminId } = data;

        // 1. Verify class belongs to this school
        const classRecord = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true }
        });

        if (!classRecord) throw new Error("Class not found or does not belong to your school");

        // 2. Verify all subjects belong to this school
        const subjects = await prisma.subject.findMany({
            where: { id: { in: subjectIds }, schoolId },
            select: { id: true }
        });

        if (subjects.length !== subjectIds.length) {
            throw new Error("One or more subjects not found or do not belong to your school");
        }

        // 3. Find which subjects are already assigned to this class — skip them
        const existing = await prisma.classSubject.findMany({
            where: { classId, subjectId: { in: subjectIds } },
            select: { subjectId: true }
        });

        const alreadyAssigned = new Set(existing.map((e) => e.subjectId));
        const newSubjectIds = subjectIds.filter((id) => !alreadyAssigned.has(id));

        if (newSubjectIds.length === 0) {
            return { assigned: 0, skipped: subjectIds.length, casCreated: 0, examsCreated: 0 };
        }

        // 4. Find the CA template — class-specific first, fall back to school-wide
        let templates = await prisma.cATemplate.findMany({
            where: { schoolId, classId }  // class-specific
        });

        if (templates.length === 0) {
            templates = await prisma.cATemplate.findMany({
                where: { schoolId, classId: null }  // school-wide fallback
            });
        }

        if (templates.length === 0) {
            throw new Error(
                "No templates found. Please define CA and Exam templates for this school before assigning subjects."
            );
        }

        // 5. Separate CAs from Exams and validate both exist
        const caTemplates = templates.filter((t) => !t.isExam);
        const examTemplates = templates.filter((t) => t.isExam);

        if (caTemplates.length === 0 || examTemplates.length === 0) {
            throw new Error(
                `Templates incomplete. Both CA and Exam templates are required before assigning subjects. ` +
                `Found: ${caTemplates.length} CA template(s), ${examTemplates.length} exam template(s). ` +
                `Please create complete templates with both CAs and Exams.`
            );
        }

        // 6. Run everything in a transaction — all or nothing
        return prisma.$transaction(async (tx) => {
            let totalCAs = 0;
            let totalExams = 0;

            for (const subjectId of newSubjectIds) {

                // Create ClassSubject link
                await tx.classSubject.create({
                    data: { classId, subjectId }
                });

                // Auto-generate CAs for this subject using template
                if (caTemplates.length > 0) {
                    await tx.continuousAssessment.createMany({
                        data: caTemplates.map((t) => ({
                            classId,
                            subjectId,
                            name: t.name,
                            maxScore: t.maxScore,
                            createdByAdminId: adminId
                        }))
                    });
                    totalCAs += caTemplates.length;
                }

                // Auto-generate Exams for this subject using template
                if (examTemplates.length > 0) {
                    await tx.exam.createMany({
                        data: examTemplates.map((t) => ({
                            classId,
                            subjectId,
                            name: t.name,
                            maxScore: t.maxScore,
                            createdByAdminId: adminId
                        }))
                    });
                    totalExams += examTemplates.length;
                }
            }

            return {
                assigned: newSubjectIds.length,
                skipped: alreadyAssigned.size,
                casCreated: totalCAs,
                examsCreated: totalExams
            };
        });
    }

    async getClassSubjects(classId: number, schoolId: number) {

        // Verify class belongs to this school
        const classRecord = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true, name: true }
        });

        if (!classRecord) throw new Error("Class not found or does not belong to your school");

        // Fetch all subjects linked to this class
        const classSubjects = await prisma.classSubject.findMany({
            where: { classId },
            select: {
                id: true,
                subject: {
                    select: { id: true, name: true, code: true }
                }
            }
        });

        return {
            classId,
            className: classRecord.name,
            subjects: classSubjects.map((cs) => cs.subject)
        };
    }

    async deleteSubjectFromClass(classId: number, subjectId: number, schoolId: number) {
        // 1. Verify class belongs to this school
        const classRecord = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true }
        });

        if (!classRecord) throw new Error("Class not found or does not belong to your school");

        // 2. Verify subject exists and belongs to this school
        const subject = await prisma.subject.findFirst({
            where: { id: subjectId, schoolId },
            select: { id: true }
        });

        if (!subject) throw new Error("Subject not found or does not belong to your school");

        // 3. Run in transaction to cascade delete
        return prisma.$transaction(async (tx) => {
            // Delete CA Results for this class+subject
            const casToDelete = await tx.continuousAssessment.findMany({
                where: { classId, subjectId },
                select: { id: true }
            });

            const caIds = casToDelete.map((ca) => ca.id);
            if (caIds.length > 0) {
                await tx.cAResult.deleteMany({
                    where: { caId: { in: caIds } }
                });
            }

            // Delete Exam Results for this class+subject
            const examsToDelete = await tx.exam.findMany({
                where: { classId, subjectId },
                select: { id: true }
            });

            const examIds = examsToDelete.map((exam) => exam.id);
            if (examIds.length > 0) {
                await tx.examResult.deleteMany({
                    where: { examId: { in: examIds } }
                });
            }

            // Delete CAs
            const casDeleted = await tx.continuousAssessment.deleteMany({
                where: { classId, subjectId }
            });

            // Delete Exams
            const examsDeleted = await tx.exam.deleteMany({
                where: { classId, subjectId }
            });

            // Delete ClassSubject link
            await tx.classSubject.deleteMany({
                where: { classId, subjectId }
            });

            return {
                success: true,
                deleted: {
                    caResults: caIds.length,
                    cas: casDeleted.count,
                    examResults: examIds.length,
                    exams: examsDeleted.count
                }
            };
        });
    }

    async computeBroadsheet(input: {
        classId: number;
        schoolId: number;
        academicSessionId: number;
        subjectIds: number[];  // admin passes all, teacher passes only theirs
        classGroupId?: number;
        termId?: number;
    }) {
        const { classId, schoolId, academicSessionId, subjectIds, classGroupId, termId } = input;

        // 1. Get students in this class for this session
        const students = await prisma.student.findMany({
            where: { classId, schoolId, academicSessionId, ...(classGroupId ? { classGroupId } : {}) },
            select: {
                id: true,
                surname: true,
                name: true,
                otherNames: true,
                registrationNumber: true
            }
        });

        // 2. Get grading scheme for this class
        const schemeClass = await prisma.gradingSchemeClass.findUnique({
            where: { classId },
            include: { scheme: { include: { grades: true } } }
        });

        if (!schemeClass) throw new Error("No grading scheme assigned to this class");

        const rules = [...schemeClass.scheme.grades].sort((a, b) => b.minScore - a.minScore);

        // 3. Get all subjects with their CAs and Exams
        const subjects = await prisma.subject.findMany({
            where: { id: { in: subjectIds } },
            select: {
                id: true,
                name: true,
                continuousAssessments: {
                    where: { classId },
                    select: {
                        id: true,
                        caResults: {
                            where: { academicSessionId, ...(termId ? { termId } : {}) },
                            select: { studentId: true, score: true }
                        }
                    }
                },
                exams: {
                    where: { classId },
                    select: {
                        id: true,
                        examResults: {
                            where: { academicSessionId, ...(termId ? { termId } : {}) },
                            select: { studentId: true, score: true }
                        }
                    }
                }
            }
        });

        // 4. Build rows — one row per student
        const rows = students.map((student) => {
            let grandTotal = 0;

            // For each subject compute caTotal + examTotal + grade
            const scores: Record<string, {
                caTotal: number;
                examTotal: number;
                subjectTotal: number;
                grade: string | null;
                remark: string | null;
            }> = {};

            for (const subject of subjects) {
                const caTotal = subject.continuousAssessments.reduce((acc, ca) => {
                    const result = ca.caResults.find((r) => r.studentId === student.id);
                    return acc + Number(result?.score ?? 0);
                }, 0);

                const examTotal = subject.exams.reduce((acc, exam) => {
                    const result = exam.examResults.find((r) => r.studentId === student.id);
                    return acc + Number(result?.score ?? 0);
                }, 0);

                const subjectTotal = caTotal + examTotal;
                const matched = rules.find((r) => subjectTotal >= r.minScore && subjectTotal <= r.maxScore);

                grandTotal += subjectTotal;

                scores[subject.name] = {
                    caTotal,
                    examTotal,
                    subjectTotal,
                    grade: matched?.grade ?? null,
                    remark: matched?.remark ?? null
                };
            }

            return {
                studentId: student.id,
                studentName: `${student.surname} ${student.name} ${student.otherNames ?? ""}`.trim(),
                registrationNumber: student.registrationNumber,
                scores,       // keyed by subject name
                grandTotal
            };
        });

        // 5. Add position — sort by grandTotal descending
        const usePosition = schemeClass.scheme.usePosition;

        const sorted = [...rows].sort((a, b) => b.grandTotal - a.grandTotal);

        const finalRows = sorted.map((row, index) => ({
            ...row,
            position: usePosition ? index + 1 : null
        }));

        return {
            classId,
            academicSessionId,
            subjects: subjects.map((s) => s.name),
            usePosition,
            rows: finalRows
        };
    }

    async getAdminBroadsheet(input: {
        classId?: number;
        schoolId: number;
        academicSessionId?: number;
        classGroupId?: number;
        termId?: number;
    }) {
        const { classId, schoolId, academicSessionId, classGroupId, termId } = input;

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

        // Get all classes if classId not provided
        let classIds: number[] = [];
        if (classId) {
            classIds = [classId];
        } else {
            const classes = await prisma.class.findMany({
                where: { schoolId },
                select: { id: true }
            });
            classIds = classes.map(c => c.id);
            if (classIds.length === 0) throw new Error("No classes found for this school");
        }

        // Fetch broadsheets for all applicable classes
        const results = await Promise.all(
            classIds.map(async (cId) => {
                const classRecord = await prisma.class.findFirst({
                    where: { id: cId, schoolId },
                    select: {
                        id: true,
                        name: true,
                        customName: true,
                        staff: { select: { name: true } }
                    }
                });

                if (!classRecord) return null;

                // Get ALL subjects assigned to this class
                const classSubjects = await prisma.classSubject.findMany({
                    where: { classId: cId },
                    select: { subjectId: true }
                });

                if (classSubjects.length === 0) return null;

                const subjectIds = classSubjects.map((cs) => cs.subjectId);

                const broadsheet = await this.computeBroadsheet({
                    classId: cId,
                    schoolId,
                    academicSessionId: sessionId,
                    subjectIds,
                    classGroupId,
                    termId
                });

                return {
                    ...broadsheet,
                    className: classRecord.name,
                    classTeacher: classRecord.staff?.name ?? null,
                    sessionName: (await prisma.academicSession.findUnique({
                        where: { id: sessionId },
                        select: { name: true }
                    }))?.name ?? null
                };
            })
        );

        return results.filter(Boolean);
    }

    async publishResults(input: {
        classId: number;
        subjectId: number;
        academicSessionId: number;
        schoolId: number;
        adminId: number;
        termId?: number;
    }) {
        const { classId, subjectId, academicSessionId, schoolId, termId, adminId } = input;

        // 1. Verify class and subject belong to this school
        const classRecord = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true }
        });
        if (!classRecord) throw new Error("Class not found or does not belong to your school");

        const subject = await prisma.subject.findFirst({
            where: { id: subjectId, schoolId },
            select: { id: true }
        });
        if (!subject) throw new Error("Subject not found or does not belong to your school");

        // 2. Get the current active term for this academic session
        let resolvedTermId = termId;
        if (!resolvedTermId) {
            const activeTerm = await prisma.academicTerm.findFirst({
                where: { sessionId: academicSessionId, isActive: true },
                select: { id: true }
            });
            if (activeTerm) {
                resolvedTermId = activeTerm.id;
            }
        }

        // 3. Block re-publication — results already published for this class/subject/session
        const alreadyPublished = await prisma.publishedResult.findUnique({
            where: { classId_subjectId_academicSessionId: { classId, subjectId, academicSessionId } }
        });
        if (alreadyPublished) {
            throw new Error("Results for this class and subject have already been published");
        }

        // 4. Compute live results using existing broadsheet logic
        const computed = await this.computeBroadsheet({
            classId,
            schoolId,
            academicSessionId,
            subjectIds: [subjectId]
        });

        // 5. Save snapshot in a transaction
        return prisma.$transaction(async (tx) => {

            // Create the publication record
            const publication = await tx.publishedResult.create({
                data: {
                    classId,
                    subjectId,
                    academicSessionId,
                    termId: resolvedTermId ?? null,
                    publishedByAdminId: adminId
                }
            });

            // Save each student's row as a frozen snapshot
            await tx.publishedResultRow.createMany({
                data: computed.rows.map((row) => {
                    const subjectScores = Object.values(row.scores)[0]; // only one subject

                    return {
                        publishedResultId: publication.id,
                        studentId: row.studentId,
                        caTotal: subjectScores.caTotal,
                        examTotal: subjectScores.examTotal,
                        total: subjectScores.subjectTotal,
                        grade: subjectScores.grade,
                        position: row.position
                    };
                })
            });

            // Delete the submission after publishing (it's been approved)
            await tx.resultSubmission.deleteMany({
                where: {
                    classId,
                    subjectId,
                    academicSessionId,
                    status: "PENDING"
                }
            });

            return {
                publicationId: publication.id,
                classId,
                subjectId,
                academicSessionId,
                publishedAt: publication.publishedAt,
                totalStudents: computed.rows.length
            };
        });
    }

    async unpublishResults(publishedResultId: number, schoolId: number) {
        const publishedResult = await prisma.publishedResult.findFirst({
            where: {
                id: publishedResultId,
                class: { schoolId }
            },
            select: {
                id: true,
                classId: true,
                subjectId: true,
                academicSessionId: true,
                class: { select: { name: true } },
                subject: { select: { name: true } },
                academicSession: { select: { name: true } }
            }
        });

        if (!publishedResult) {
            throw new Error("Published result not found or does not belong to your school");
        }

        return prisma.$transaction(async (tx) => {
            await tx.publishedResultRow.deleteMany({
                where: { publishedResultId }
            });

            await tx.publishedResult.delete({
                where: { id: publishedResultId }
            });

            return {
                unpublished: true,
                message: `Results for ${publishedResult.class.name} - ${publishedResult.subject.name} have been unpublished`,
                data: {
                    classId: publishedResult.classId,
                    subjectId: publishedResult.subjectId,
                    academicSessionId: publishedResult.academicSessionId
                }
            };
        });
    }

    // Admin gets all pending submissions for their school
    async getPendingSubmissions(input: {
        schoolId: number;
        campusId?: number;
        classId?: number;
        academicSessionId?: number;
        termId?: number;
        subjectId?: number;
    }) {
        const { schoolId, campusId, classId, academicSessionId, termId, subjectId } = input;

        return prisma.resultSubmission.findMany({
            where: {
                status: "PENDING",
                class: {
                    schoolId,
                    ...(campusId && { campusId })
                },
                ...(classId && { classId }),
                ...(academicSessionId && { academicSessionId }),
                ...(termId && { termId }),
                ...(subjectId && { subjectId })
            },
            select: {
                id: true,
                status: true,
                submittedAt: true,
                class: {
                    select: {
                        id: true,
                        name: true,
                        campus: { select: { id: true, name: true } }
                    }
                },
                subject: { select: { id: true, name: true } },
                academicSession: { select: { id: true, name: true } },
                term: { select: { id: true, name: true } },
                staff: { select: { id: true, name: true } }
            },
            orderBy: { submittedAt: "desc" }
        });
    }

    async getRejectedResults(input: {
        schoolId: number;
        campusId?: number;
        classId?: number;
        academicSessionId?: number;
        termId?: number;
        subjectId?: number;
    }) {
        const { schoolId, campusId, classId, academicSessionId, termId, subjectId } = input;

        return prisma.resultSubmission.findMany({
            where: {
                status: "REJECTED",
                class: {
                    schoolId,
                    ...(campusId && { campusId })
                },
                ...(classId && { classId }),
                ...(academicSessionId && { academicSessionId }),
                ...(termId && { termId }),
                ...(subjectId && { subjectId })
            },
            select: {
                id: true,
                status: true,
                submittedAt: true,
                class: {
                    select: {
                        id: true,
                        name: true,
                        campus: { select: { id: true, name: true } }
                    }
                },
                subject: { select: { id: true, name: true } },
                academicSession: { select: { id: true, name: true } },
                term: { select: { id: true, name: true } },
                staff: { select: { id: true, name: true } }
            },
            orderBy: { submittedAt: "desc" }
        });
    }

    async getPublishedResults(input: {
        schoolId: number;
        campusId?: number;
        classId?: number;
        academicSessionId?: number;
        termId?: number;
        subjectId?: number;
    }) {
        const { schoolId, campusId, classId, academicSessionId, termId, subjectId } = input;

        return prisma.publishedResult.findMany({
            where: {
                class: {
                    schoolId,
                    ...(campusId && { campusId })
                },
                ...(classId && { classId }),
                ...(academicSessionId && { academicSessionId }),
                ...(termId && { termId }),
                ...(subjectId && { subjectId })
            },
            select: {
                id: true,
                publishedAt: true,
                class: {
                    select: {
                        id: true,
                        name: true,
                        campus: { select: { id: true, name: true } }
                    }
                },
                subject: { select: { id: true, name: true } },
                academicSession: { select: { id: true, name: true } },
                term: { select: { id: true, name: true } },
                admin: { select: { id: true, name: true } }
            },
            orderBy: { publishedAt: "desc" }
        });
    }

    // Admin rejects a submission — unlocks scores for teacher
    async rejectSubmission(submissionId: number, schoolId: number) {
        const submission = await prisma.resultSubmission.findFirst({
            where: { id: submissionId, class: { schoolId } },
            select: { id: true, status: true }
        });

        if (!submission) throw new Error("Submission not found");

        if (submission.status !== "PENDING") {
            throw new Error("Only pending submissions can be rejected");
        }

        // Delete the submission — this unlocks scores for the teacher
        await prisma.resultSubmission.delete({ where: { id: submissionId } });

        return { rejected: true, submissionId };
    }

    // Admin restores a rejected submission back to PENDING
    async restoreRejectedSubmission(submissionId: number, schoolId: number) {
        const submission = await prisma.resultSubmission.findFirst({
            where: { id: submissionId, class: { schoolId } },
            select: {
                id: true,
                status: true,
                classId: true,
                subjectId: true,
                academicSessionId: true,
                staffId: true,
                submittedAt: true
            }
        });

        if (!submission) throw new Error("Submission not found");

        if (submission.status !== "REJECTED") {
            throw new Error("Only rejected submissions can be restored");
        }

        // Restore to PENDING status
        const restored = await prisma.resultSubmission.update({
            where: { id: submissionId },
            data: { status: "PENDING" },
            select: {
                id: true,
                status: true,
                submittedAt: true,
                class: { select: { id: true, name: true } },
                subject: { select: { id: true, name: true } },
                academicSession: { select: { id: true, name: true } },
                staff: { select: { id: true, name: true } }
            }
        });

        return {
            restored: true,
            message: "Submission restored to PENDING. Teacher can now resubmit.",
            data: restored
        };
    }

    async getStudentResult(input: {
        studentId?: number;
        classId?: number;
        schoolId: number;
        academicSessionId?: number;
        termId?: number;
        page: number;
        pageSize: number;
    }) {
        const { studentId, classId, schoolId, academicSessionId, termId, page, pageSize } = input;

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

        // Build filter for students
        const studentFilter: any = { schoolId, academicSessionId: sessionId };
        if (studentId) studentFilter.id = studentId;
        if (classId) studentFilter.classId = classId;

        // Get paginated students
        const [students, totalCount] = await Promise.all([
            prisma.student.findMany({
                where: studentFilter,
                select: { id: true, name: true, surname: true, classId: true, registrationNumber: true },
                skip: (page - 1) * pageSize,
                take: pageSize,
                orderBy: { surname: "asc" }
            }),
            prisma.student.count({ where: studentFilter })
        ]);

        // Fetch results for each student
        const results = await Promise.all(
            students.map(async (student) => {
                // Get class subjects
                const classSubjects = await prisma.classSubject.findMany({
                    where: { classId: student.classId },
                    select: { subjectId: true }
                });
                const subjectIds = classSubjects.map(cs => cs.subjectId);

                // Get CAs and Exams for each subject
                const subjectScores = await Promise.all(
                    subjectIds.map(async (sId) => {
                        const subject = await prisma.subject.findUnique({
                            where: { id: sId },
                            select: { name: true }
                        });

                        const cas = await prisma.continuousAssessment.findMany({
                            where: { classId: student.classId, subjectId: sId },
                            include: {
                                caResults: {
                                    where: { studentId: student.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) }
                                }
                            }
                        });

                        const exams = await prisma.exam.findMany({
                            where: { classId: student.classId, subjectId: sId },
                            include: {
                                examResults: {
                                    where: { studentId: student.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) }
                                }
                            }
                        });

                        const caTotal = cas.reduce((acc, ca) =>
                            acc + Number(ca.caResults[0]?.score ?? 0), 0);
                        const examTotal = exams.reduce((acc, exam) =>
                            acc + Number(exam.examResults[0]?.score ?? 0), 0);

                        return {
                            subjectName: subject?.name,
                            caTotal,
                            examTotal
                        };
                    })
                );

                const grandTotal = subjectScores.reduce((acc, s) => acc + s.caTotal + s.examTotal, 0);

                return {
                    studentId: student.id,
                    studentName: `${student.surname} ${student.name}`,
                    registrationNumber: student.registrationNumber,
                    subjects: subjectScores,
                    grandTotal
                };
            })
        );

        const totalPages = Math.ceil(totalCount / pageSize);

        return {
            pagination: {
                page,
                pageSize,
                totalCount,
                totalPages
            },
            data: results
        };
    }


    async getTeacherResult(input: {
        staffId?: number;
        classId?: number;
        subjectId?: number;
        schoolId: number;
        academicSessionId?: number;
        page: number;
        pageSize: number;
        termId?: number;
    }) {
        const { staffId, classId, subjectId, schoolId, academicSessionId, page, pageSize, termId } = input;

        // Resolve academic session
        let sessionId = academicSessionId;
        if (!sessionId) {
            const activeSession = await prisma.academicSession.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true, name: true }
            });

            if (!activeSession) {
                const latestSession = await prisma.academicSession.findFirst({
                    where: { schoolId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, name: true }
                });
                if (!latestSession) throw new Error("No academic session found");
                sessionId = latestSession.id;
            } else {
                sessionId = activeSession.id;
            }
        }

        // Resolve term
        let resolvedTermId = termId;
        if (!resolvedTermId) {
            const activeTerm = await prisma.academicTerm.findFirst({
                where: { sessionId, isActive: true },
                select: { id: true, name: true }
            });
            resolvedTermId = activeTerm?.id;
        }

        // Get teacher with assignment if specific class/subject provided
        if (staffId && classId && subjectId) {
            const teacher = await prisma.staff.findUnique({
                where: { id: staffId },
                select: {
                    id: true,
                    name: true,
                    registrationNumber: true,
                    gender: true
                }
            });

            if (!teacher) throw new Error("Teacher not found");

            // Get class and subject info
            const classRecord = await prisma.class.findFirst({
                where: { id: classId, schoolId },
                select: { id: true, name: true, campus: { select: { name: true } } }
            });

            const subject = await prisma.subject.findUnique({
                where: { id: subjectId },
                select: { id: true, name: true, code: true }
            });

            const session = await prisma.academicSession.findUnique({
                where: { id: sessionId },
                select: { id: true, name: true }
            });

            const term = resolvedTermId ? await prisma.academicTerm.findUnique({
                where: { id: resolvedTermId },
                select: { id: true, name: true }
            }) : null;

            // Get all students in the class with their scores
            const classStudents = await prisma.student.findMany({
                where: { classId },
                select: { id: true, registrationNumber: true, name: true, surname: true }
            });

            // Get CA and Exam scores for each student
            const students = await Promise.all(
                classStudents.map(async (student) => {
                    const cas = await prisma.continuousAssessment.findMany({
                        where: { classId, subjectId },
                        select: {
                            id: true,
                            name: true,
                            maxScore: true,
                            caResults: {
                                where: { studentId: student.id, academicSessionId: sessionId, ...(resolvedTermId ? { termId: resolvedTermId } : {}) },
                                select: { score: true }
                            }
                        },
                        orderBy: { name: "asc" }
                    });

                    const exams = await prisma.exam.findMany({
                        where: { classId, subjectId },
                        select: {
                            id: true,
                            name: true,
                            maxScore: true,
                            examResults: {
                                where: { studentId: student.id, academicSessionId: sessionId, ...(resolvedTermId ? { termId: resolvedTermId } : {}) },
                                select: { score: true }
                            }
                        },
                        orderBy: { name: "asc" }
                    });

                    const caTotal = cas.reduce((sum, ca) => sum + Number(ca.caResults[0]?.score ?? 0), 0);
                    const examTotal = exams.reduce((sum, exam) => sum + Number(exam.examResults[0]?.score ?? 0), 0);
                    const total = caTotal + examTotal;

                    // Get grade
                    const gradingScheme = await prisma.gradingScheme.findFirst({
                        where: {
                            classes: { some: { classId } }
                        },
                        select: {
                            grades: { orderBy: { minScore: "desc" } }
                        }
                    });

                    const grade = gradingScheme?.grades.find(g => total >= g.minScore && total <= g.maxScore);

                    // Get remark scheme remark
                    const remarkScheme = await prisma.remarkScheme.findUnique({
                        where: { schoolId },
                        select: { rules: { orderBy: { minScore: "desc" } } }
                    });

                    return {
                        registrationNumber: student.registrationNumber,
                        studentName: `${student.surname} ${student.name}`,
                        cas: cas.map((ca, idx) => ({
                            name: ca.name,
                            score: ca.caResults[0]?.score ?? null
                        })),
                        caScore: caTotal,
                        examScore: exams.length > 0 ? exams[0].examResults[0]?.score ?? null : null,
                        total,
                        grade: grade?.grade ?? "N/A",
                        remarks: grade?.remark || ""
                    };
                })
            );

            // Get date submitted (latest result submission)
            const latestSubmission = await prisma.resultSubmission.findFirst({
                where: {
                    classId,
                    subjectId,
                    staffId,
                    academicSessionId: sessionId
                },
                select: { submittedAt: true },
                orderBy: { submittedAt: "desc" }
            });

            return {
                teacherInformation: {
                    name: teacher.name,
                    registrationNumber: teacher.registrationNumber,
                    gender: teacher.gender,
                    subject: subject?.name,
                    subjectCode: subject?.code,
                    class: classRecord?.name,
                    campus: classRecord?.campus?.name ?? "N/A",
                    session: session?.name,
                    academicYear: session?.name,
                    term: term?.name,
                    dateSubmitted: latestSubmission?.submittedAt ? latestSubmission.submittedAt.toISOString().split('T')[0] : null
                },
                students: students.slice((page - 1) * pageSize, page * pageSize),
                pagination: {
                    page,
                    pageSize,
                    totalCount: students.length,
                    totalPages: Math.ceil(students.length / pageSize)
                }
            };
        }

        // If no specific assignment, list all teacher assignments
        const teacher = staffId ? await prisma.staff.findUnique({
            where: { id: staffId },
            select: { id: true, name: true, registrationNumber: true, gender: true }
        }) : null;

        const teacherFilter: any = { schoolId };
        if (staffId) teacherFilter.id = staffId;

        const [teachers, totalCount] = await Promise.all([
            prisma.staff.findMany({
                where: teacherFilter,
                select: { id: true, name: true, registrationNumber: true, gender: true },
                skip: (page - 1) * pageSize,
                take: pageSize,
                orderBy: { name: "asc" }
            }),
            prisma.staff.count({ where: teacherFilter })
        ]);

        const results = await Promise.all(
            teachers.map(async (t) => {
                const assignments = await prisma.teacherAssignment.findMany({
                    where: { staffId: t.id },
                    include: {
                        class: { select: { id: true, name: true } },
                        subject: { select: { id: true, name: true } }
                    },
                    distinct: ["classId", "subjectId"]
                });

                return {
                    staffId: t.id,
                    staffName: t.name,
                    registrationNumber: t.registrationNumber,
                    gender: t.gender,
                    assignments: assignments.map(a => ({
                        classId: a.classId,
                        className: a.class?.name,
                        subjectId: a.subjectId,
                        subjectName: a.subject?.name
                    }))
                };
            })
        );

        return {
            pagination: {
                page,
                pageSize,
                totalCount,
                totalPages: Math.ceil(totalCount / pageSize)
            },
            data: results
        };
    }


    async scheduleExam(input: { examId: number; schoolId: number; scheduledDate: Date }) {
        const { examId, schoolId, scheduledDate } = input;

        const exam = await prisma.exam.findFirst({
            where: { id: examId, class: { schoolId } },
            select: { id: true }
        });

        if (!exam) throw new Error("Exam not found or does not belong to your school");

        return prisma.exam.update({
            where: { id: examId },
            data: { scheduledDate },
            select: { id: true, name: true, scheduledDate: true, class: { select: { name: true } } }
        });
    }

    async createRemarkScheme(input: {
        schoolId: number;
        name: string;
        rules: Array<{ minScore: number; maxScore: number; remark: string }>;
    }) {
        const { schoolId, name, rules } = input;

        const scheme = await prisma.remarkScheme.upsert({
            where: { schoolId },
            create: {
                schoolId,
                name,
                rules: {
                    create: rules.map(r => ({
                        minScore: r.minScore,
                        maxScore: r.maxScore,
                        remark: r.remark
                    }))
                }
            },
            update: {
                name,
                rules: {
                    deleteMany: {},
                    create: rules.map(r => ({
                        minScore: r.minScore,
                        maxScore: r.maxScore,
                        remark: r.remark
                    }))
                }
            },
            include: { rules: true }
        });

        return scheme;
    }

    async addRemarkRules(input: {
        schemeId: number;
        schoolId: number;
        rules: Array<{ minScore: number; maxScore: number; remark: string }>;
    }) {
        const { schemeId, schoolId, rules } = input;

        const scheme = await prisma.remarkScheme.findFirst({
            where: { id: schemeId, schoolId }
        });

        if (!scheme) {
            throw new Error("Remark scheme not found or does not belong to your school");
        }

        const createdRules = await prisma.remarkRule.createMany({
            data: rules.map(r => ({
                schemeId,
                minScore: r.minScore,
                maxScore: r.maxScore,
                remark: r.remark
            }))
        });

        const updatedScheme = await prisma.remarkScheme.findUnique({
            where: { id: schemeId },
            include: { rules: { orderBy: { minScore: "desc" } } }
        });

        return updatedScheme;
    }

    async getRemarkScheme(schoolId: number) {
        const scheme = await prisma.remarkScheme.findUnique({
            where: { schoolId },
            include: { rules: { orderBy: { minScore: "desc" } } }
        });

        if (!scheme) {
            throw new Error("No remark scheme found for this school");
        }

        return scheme;
    }

    async getStudentCompleteResult(input: {
        studentId: number;
        schoolId: number;
        academicSessionId?: number;
        termId?: number;
    }) {
        const { studentId, schoolId, academicSessionId, termId } = input;

        // Resolve academic session
        let sessionId = academicSessionId;
        if (!sessionId) {
            const activeSession = await prisma.academicSession.findFirst({
                where: { schoolId, isActive: true },
                select: { id: true, name: true }
            });
            if (!activeSession) {
                const latestSession = await prisma.academicSession.findFirst({
                    where: { schoolId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, name: true }
                });
                if (!latestSession) throw new Error("No academic session found");
                sessionId = latestSession.id;
            } else {
                sessionId = activeSession.id;
            }
        }

        // Fetch student details
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: {
                id: true,
                name: true,
                surname: true,
                otherNames: true,
                registrationNumber: true,
                dateOfBirth: true,
                gender: true,
                passportUrl: true,
                classId: true,
                class: { select: { id: true, name: true, customName: true, campus: { select: { name: true } } } },
                academicSessionId: true
            }
        });

        if (!student) throw new Error("Student not found");

        // Fetch class subjects
        const classSubjects = await prisma.classSubject.findMany({
            where: { classId: student.classId },
            select: {
                subject: { select: { id: true, name: true, code: true } }
            }
        });

        // Get grading scheme for the class
        const gradingScheme = await prisma.gradingScheme.findFirst({
            where: {
                classes: { some: { classId: student.classId } }
            },
            select: {
                grades: { orderBy: { minScore: "desc" } }
            }
        });

        // Fetch results for each subject
        const subjects = await Promise.all(
            classSubjects.map(async (cs) => {
                const subject = cs.subject;
                const cas = await prisma.continuousAssessment.findMany({
                    where: { classId: student.classId, subjectId: subject.id },
                    select: {
                        id: true,
                        name: true,
                        maxScore: true,
                        caResults: {
                            where: { studentId, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                            select: { score: true }
                        }
                    },
                    orderBy: { name: "asc" }
                });

                const exams = await prisma.exam.findMany({
                    where: { classId: student.classId, subjectId: subject.id },
                    select: {
                        id: true,
                        name: true,
                        maxScore: true,
                        examResults: {
                            where: { studentId, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                            select: { score: true }
                        }
                    },
                    orderBy: { name: "asc" }
                });

                const caTotal = cas.reduce((sum, ca) => sum + Number(ca.caResults[0]?.score ?? 0), 0);
                const examTotal = exams.reduce((sum, exam) => sum + Number(exam.examResults[0]?.score ?? 0), 0);
                const subjectTotal = caTotal + examTotal;

                const grade = gradingScheme?.grades.find(g => subjectTotal >= g.minScore && subjectTotal <= g.maxScore);

                return {
                    id: subject.id,
                    name: subject.name,
                    code: subject.code,
                    cas: cas.map(ca => ({
                        id: ca.id,
                        name: ca.name,
                        maxScore: ca.maxScore,
                        score: ca.caResults[0]?.score ?? null
                    })),
                    exam: exams.length > 0 ? {
                        id: exams[0].id,
                        name: exams[0].name,
                        maxScore: exams[0].maxScore,
                        score: exams[0].examResults[0]?.score ?? null
                    } : null,
                    caTotal,
                    examTotal,
                    subjectTotal,
                    grade: grade?.grade ?? "N/A",
                    remark: grade?.remark ?? ""
                };
            })
        );

        // Calculate performance summary
        const totalScore = subjects.reduce((sum, s) => sum + s.subjectTotal, 0);
        const averageScore = subjects.length > 0 ? Math.round(totalScore / subjects.length) : 0;
        const overallGrade = gradingScheme?.grades.find(g => averageScore >= g.minScore && averageScore <= g.maxScore);

        // Get class position - rank students by total score
        const classStudents = await prisma.student.findMany({
            where: { classId: student.classId, academicSessionId: sessionId },
            select: { id: true }
        });

        // Calculate scores for all students in class to determine position
        const classStudentScores = await Promise.all(
            classStudents.map(async (cs) => {
                const csSubjects = await prisma.classSubject.findMany({
                    where: { classId: student.classId },
                    select: { subject: { select: { id: true } } }
                });

                let csTotal = 0;
                for (const subj of csSubjects) {
                    const cas = await prisma.continuousAssessment.findMany({
                        where: { classId: student.classId, subjectId: subj.subject.id },
                        select: {
                            caResults: {
                                where: { studentId: cs.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                                select: { score: true }
                            }
                        }
                    });
                    const exams = await prisma.exam.findMany({
                        where: { classId: student.classId, subjectId: subj.subject.id },
                        select: {
                            examResults: {
                                where: { studentId: cs.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                                select: { score: true }
                            }
                        }
                    });

                    const caTotal = cas.reduce((sum, ca) => sum + Number(ca.caResults[0]?.score ?? 0), 0);
                    const examTotal = exams.reduce((sum, exam) => sum + Number(exam.examResults[0]?.score ?? 0), 0);
                    csTotal += caTotal + examTotal;
                }

                return { studentId: cs.id, score: csTotal };
            })
        );

        // Sort by score descending and find position
        const sortedByScore = classStudentScores.sort((a, b) => b.score - a.score);
        const classPosition = sortedByScore.findIndex(s => s.studentId === studentId) + 1;

        // Fetch remark based on average score using RemarkScheme
        const remarkScheme = await prisma.remarkScheme.findUnique({
            where: { schoolId },
            select: { rules: { orderBy: { minScore: "desc" } } }
        });

        const remarkTemplate = remarkScheme?.rules.find(r => averageScore >= r.minScore && averageScore <= r.maxScore)?.remark ?? "";

        // Personalize remark with student name
        const studentDisplayName = `${student.surname} ${student.name}`;
        const personalizedRemark = remarkTemplate ? remarkTemplate.replace('{studentName}', studentDisplayName) : "";

        // Get session and term names
        const session = await prisma.academicSession.findUnique({
            where: { id: sessionId },
            select: { id: true, name: true }
        });

        // Fetch all terms in session to find current and next term
        const allTerms = await prisma.academicTerm.findMany({
            where: { sessionId },
            select: { id: true, name: true, resumptionDate: true },
            orderBy: { createdAt: 'asc' }
        });

        const currentTermIndex = termId
            ? allTerms.findIndex(t => t.id === termId)
            : allTerms.findIndex(t => t.id === sessionId); // fallback if termId not resolved yet

        const currentTerm = termId ? allTerms.find(t => t.id === termId) : null;
        const nextTerm = currentTermIndex >= 0 && currentTermIndex < allTerms.length - 1
            ? allTerms[currentTermIndex + 1]
            : null;

        // Determine school recommendation date from next term or fallback to current date
        const schoolRecommendationDate = nextTerm?.resumptionDate
            ? nextTerm.resumptionDate.toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];

        return {
            studentInformation: {
                id: student.id,
                name: student.name,
                surname: student.surname,
                otherNames: student.otherNames,
                registrationNumber: student.registrationNumber,
                className: student.class.name,
                classId: student.classId,
                campus: student.class.campus?.name ?? "N/A",
                dateOfBirth: student.dateOfBirth,
                gender: student.gender,
                passportUrl: student.passportUrl
            },
            academicInfo: {
                academicSessionId: sessionId,
                academicSessionName: session?.name,
                termId: currentTerm?.id ?? null,
                termName: currentTerm?.name ?? null
            },
            subjects,
            performanceSummary: {
                totalScore,
                averageScore,
                classPosition: `${classPosition}`,
                overallGrade: overallGrade?.grade ?? "N/A",
                sessionLength: allTerms.length
            },
            teacherRemark: personalizedRemark,
            schoolRecommendationDate
        };
    }


}
