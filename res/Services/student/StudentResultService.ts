import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getEnrolledClassId } = require("../../util/enrolledClass");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadSessionSummary, resumptionDateFor, orderTerms } = require("../../util/reportCardContext");

export class StudentResultService {

    // Populates the academic session dropdown
    async getSessions(schoolId: number) {
        return prisma.academicSession.findMany({
            where: { schoolId },
            select: { id: true, name: true, isActive: true },
            orderBy: { createdAt: "desc" }
        });
    }

    async getResults(studentId: number, schoolId: number, academicSessionId?: number, requestedTermId?: number) {
        // Get student info
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: { classId: true, school: { select: { id: true } } }
        });

        if (!student) throw new Error("Student not found");

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

        // The class they were in THAT session, not the one they are in now: after a
        // promotion the old session's results belong to the old class.
        const classId = await getEnrolledClassId(prisma, studentId, sessionId, student.classId);

        // One term at a time. With none named this used to merge every term in the
        // session — fine with a single term, but from Second Term each subject
        // would appear twice with both terms' scores added together. Default to
        // the term published most recently, so a student sees their latest results.
        let termId = requestedTermId;
        if (!termId) {
            const latest = await prisma.publishedResult.findFirst({
                where: { classId: classId, academicSessionId: sessionId, termId: { not: null } },
                orderBy: { publishedAt: "desc" },
                select: { termId: true }
            });
            termId = latest?.termId ?? undefined;
        }

        // Get published results for this student's class and session
        const publishedResults = await prisma.publishedResult.findMany({
            where: {
                classId: classId,
                academicSessionId: sessionId,
                ...(termId ? { termId } : {})
            },
            select: { subjectId: true }
        });

        const publishedSubjectIds = new Set(publishedResults.map(pr => pr.subjectId));

        // Get all subjects for the student's class
        const classSubjects = await prisma.classSubject.findMany({
            where: { classId: classId },
            select: { subject: { select: { id: true, name: true, code: true } } }
        });

        // For each PUBLISHED subject, get results and format them
        const results = await Promise.all(
            classSubjects
                .filter(cs => publishedSubjectIds.has(cs.subject.id))
                .map(async (cs, index) => {
                    const subjectId = cs.subject.id;

                    // Get all CA scores for this subject
                    const cas = await prisma.continuousAssessment.findMany({
                        where: { classId: classId, subjectId },
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

                    // Get exam score
                    const exams = await prisma.exam.findMany({
                        where: { classId: classId, subjectId },
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

                    const caScores = cas.map(ca => Number(ca.caResults[0]?.score ?? 0));
                    const caTotal = caScores.reduce((sum, score) => sum + score, 0);
                    const examTotal = exams.length > 0 ? Number(exams[0].examResults[0]?.score ?? 0) : 0;
                    const total = caTotal + examTotal;

                    // Get grade
                    const gradingScheme = await prisma.gradingScheme.findFirst({
                        where: { classes: { some: { classId: classId } } },
                        select: { grades: { orderBy: { minScore: "desc" } } }
                    });

                    const grade = gradingScheme?.grades.find(g => total >= g.minScore && total <= g.maxScore)?.grade ?? "N/A";

                    // Calculate class average and position for this subject
                    const allStudentsInClass = await prisma.student.findMany({
                        where: { classId: classId },
                        select: { id: true }
                    });

                    let classAverage = 0;
                    let position = 0;

                    if (allStudentsInClass.length > 0) {
                        const studentTotals = await Promise.all(
                            allStudentsInClass.map(async (s) => {
                                const sCAs = await prisma.continuousAssessment.findMany({
                                    where: { classId: classId, subjectId },
                                    select: {
                                        caResults: {
                                            where: { studentId: s.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                                            select: { score: true }
                                        }
                                    }
                                });

                                const sExams = await prisma.exam.findMany({
                                    where: { classId: classId, subjectId },
                                    select: {
                                        examResults: {
                                            where: { studentId: s.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                                            select: { score: true }
                                        }
                                    }
                                });

                                const sCATotal = sCAs.reduce((sum, ca) => sum + Number(ca.caResults[0]?.score ?? 0), 0);
                                const sExamTotal = sExams.length > 0 ? Number(sExams[0].examResults[0]?.score ?? 0) : 0;
                                return sCATotal + sExamTotal;
                            })
                        );

                        classAverage = studentTotals.reduce((sum, t) => sum + t, 0) / studentTotals.length;
                        position = studentTotals.filter(t => t > total).length + 1;
                    }

                    return {
                        sn: index + 1,
                        subject: cs.subject.name,
                        cas: caScores,
                        exam: examTotal,
                        total,
                        grade,
                        classAvg: parseFloat(classAverage.toFixed(2)),
                        position: position
                    };
                })
        );

        return results;
    }

    /**
     * What goes above a student's results table: the class and term the results
     * are for, and, on the session's closing term, the session average and where
     * they were promoted to. A separate call so the results array keeps its shape.
     */
    async getSummary(studentId: number, schoolId: number, academicSessionId?: number, requestedTermId?: number) {
        const student = await prisma.student.findFirst({
            where: { id: studentId, schoolId },
            select: { classId: true }
        });
        if (!student) throw new AppError("Student not found", 404);

        let sessionId = academicSessionId;
        if (!sessionId) {
            const session =
                (await prisma.academicSession.findFirst({ where: { schoolId, isActive: true }, select: { id: true } })) ??
                (await prisma.academicSession.findFirst({ where: { schoolId }, orderBy: { id: "desc" }, select: { id: true } }));
            if (!session) throw new AppError("No academic session found", 404);
            sessionId = session.id;
        }

        const classId: number = await getEnrolledClassId(prisma, studentId, sessionId, student.classId);
        const cls = await prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { name: true, customName: true }
        });

        const terms = orderTerms(
            await prisma.academicTerm.findMany({
                where: { schoolId, sessionId },
                select: { id: true, name: true, resumptionDate: true, createdAt: true }
            })
        );

        // Same default as the results list: the term published most recently.
        let termId = requestedTermId;
        if (!termId) {
            const latest = await prisma.publishedResult.findFirst({
                where: { classId, academicSessionId: sessionId, termId: { not: null } },
                orderBy: { publishedAt: "desc" },
                select: { termId: true }
            });
            termId = latest?.termId ?? undefined;
        }
        const term = terms.find((t: { id: number }) => t.id === termId) ?? null;

        const nextSession = await prisma.academicSession.findFirst({
            where: { schoolId, id: { gt: sessionId } },
            orderBy: { id: "asc" },
            select: { id: true }
        });
        const nextSessionTerms = nextSession
            ? await prisma.academicTerm.findMany({
                where: { sessionId: nextSession.id },
                select: { id: true, resumptionDate: true, createdAt: true }
            })
            : [];

        const sessionSummary = termId
            ? await loadSessionSummary(prisma, {
                schoolId,
                studentId,
                classId,
                sessionId,
                termId,
                sessionTerms: terms
            })
            : null;

        const fees = await prisma.studentFee.aggregate({
            where: { studentId, schoolId },
            _sum: { totalFee: true, amountPaid: true }
        });

        return {
            className: cls ? (cls.customName ? `${cls.name} — ${cls.customName}` : cls.name) : null,
            termId: term?.id ?? null,
            termName: term?.name ?? null,
            resumptionDate: resumptionDateFor(terms, term?.id ?? null, nextSessionTerms),
            sessionSummary,
            outstandingFees: Math.max(0, (fees._sum.totalFee ?? 0) - (fees._sum.amountPaid ?? 0))
        };
    }

}
