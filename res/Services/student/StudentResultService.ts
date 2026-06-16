import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";

export class StudentResultService {

    // Populates the academic session dropdown
    async getSessions(schoolId: number) {
        return prisma.academicSession.findMany({
            where: { schoolId },
            select: { id: true, name: true, isActive: true },
            orderBy: { createdAt: "desc" }
        });
    }

    async getResults(studentId: number, schoolId: number, academicSessionId?: number, termId?: number) {
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

        // Get published results for this student's class and session
        const publishedResults = await prisma.publishedResult.findMany({
            where: {
                classId: student.classId,
                academicSessionId: sessionId,
                ...(termId ? { termId } : {})
            },
            select: { subjectId: true }
        });

        const publishedSubjectIds = new Set(publishedResults.map(pr => pr.subjectId));

        // Get all subjects for the student's class
        const classSubjects = await prisma.classSubject.findMany({
            where: { classId: student.classId },
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
                        where: { classId: student.classId, subjectId },
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
                        where: { classId: student.classId, subjectId },
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
                        where: { classes: { some: { classId: student.classId } } },
                        select: { grades: { orderBy: { minScore: "desc" } } }
                    });

                    const grade = gradingScheme?.grades.find(g => total >= g.minScore && total <= g.maxScore)?.grade ?? "N/A";

                    // Calculate class average and position for this subject
                    const allStudentsInClass = await prisma.student.findMany({
                        where: { classId: student.classId },
                        select: { id: true }
                    });

                    let classAverage = 0;
                    let position = 0;

                    if (allStudentsInClass.length > 0) {
                        const studentTotals = await Promise.all(
                            allStudentsInClass.map(async (s) => {
                                const sCAs = await prisma.continuousAssessment.findMany({
                                    where: { classId: student.classId, subjectId },
                                    select: {
                                        caResults: {
                                            where: { studentId: s.id, academicSessionId: sessionId, ...(termId ? { termId } : {}) },
                                            select: { score: true }
                                        }
                                    }
                                });

                                const sExams = await prisma.exam.findMany({
                                    where: { classId: student.classId, subjectId },
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

}
