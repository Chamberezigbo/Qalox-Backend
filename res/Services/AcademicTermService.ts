const prisma = require("../util/prisma");


export class AcademicTermService {

    async createTerm(input: { schoolId: number; sessionId: number; name: string; resumptionDate?: Date }) {
        const { schoolId, sessionId, name, resumptionDate } = input;

        // Confirm session belongs to this school
        const session = await prisma.academicSession.findFirst({
            where: { id: sessionId, schoolId },
            select: { id: true, name: true }
        });

        if (!session) throw new Error("Academic session not found");

        // Only allow First Term, Second Term, Third Term
        const allowed = ["First Term", "Second Term", "Third Term"];
        if (!allowed.includes(name)) {
            throw new Error("Term name must be one of: First Term, Second Term, Third Term");
        }

        const term = await prisma.academicTerm.create({
            data: { schoolId, sessionId, name, isActive: false, resumptionDate },
            select: { id: true, name: true, isActive: true, resumptionDate: true, session: { select: { id: true, name: true } } }
        });

        return term;
    }

    async activateTerm(input: { termId: number; schoolId: number }) {
        const { termId, schoolId } = input;

        // Find the term and confirm it belongs to this school
        const term = await prisma.academicTerm.findFirst({
            where: { id: termId, schoolId },
            select: { id: true, sessionId: true }
        });

        if (!term) throw new Error("Term not found");

        // Deactivate all terms for this school, then activate the selected one
        // Also activate the parent session and deactivate all other sessions
        await prisma.$transaction([
            // Deactivate all terms for this school
            prisma.academicTerm.updateMany({
                where: { schoolId },
                data: { isActive: false }
            }),
            // Deactivate all sessions for this school
            prisma.academicSession.updateMany({
                where: { schoolId },
                data: { isActive: false }
            }),
            // Activate this term
            prisma.academicTerm.update({
                where: { id: termId },
                data: { isActive: true }
            }),
            // Activate the parent session
            prisma.academicSession.update({
                where: { id: term.sessionId },
                data: { isActive: true }
            }),
        ]);

        const activated = await prisma.academicTerm.findUnique({
            where: { id: termId },
            select: {
                id: true,
                name: true,
                isActive: true,
                session: { select: { id: true, name: true, isActive: true } }
            }
        });

        return activated;
    }

    async getTerms(input: { schoolId: number; sessionId: number }) {
        const { schoolId, sessionId } = input;

        const session = await prisma.academicSession.findFirst({
            where: { id: sessionId, schoolId },
            select: { id: true, name: true }
        });

        if (!session) throw new Error("Academic session not found");

        const terms = await prisma.academicTerm.findMany({
            where: { schoolId, sessionId },
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true, isActive: true, createdAt: true }
        });

        return { session, terms };
    }

    async getActiveTerm(schoolId: number) {
        const activeSession = await prisma.academicSession.findFirst({
            where: { schoolId, isActive: true },
            select: {
                id: true,
                name: true,
                terms: {
                    where: { isActive: true },
                    select: { id: true, name: true }
                }
            }
        });

        if (!activeSession) return { activeSession: null, activeTerm: null };

        const activeTerm = activeSession.terms[0] ?? null;

        return {
            activeSession: { id: activeSession.id, name: activeSession.name },
            activeTerm
        };
    }

    async createSession(input: { schoolId: number; name: string }) {
        const { schoolId, name } = input;

        const session = await prisma.academicSession.create({
            data: { schoolId, name, isActive: false },
            select: { id: true, name: true, isActive: true }
        });

        return session;
    }

    async getSessions(schoolId: number) {
        return prisma.academicSession.findMany({
            where: { schoolId },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                name: true,
                isActive: true,
                terms: {
                    select: { id: true, name: true, isActive: true },
                    orderBy: { createdAt: "asc" }
                }
            }
        });
    }

    async updateTerm(input: { termId: number; schoolId: number; name?: string; resumptionDate?: Date }) {
        const { termId, schoolId, name, resumptionDate } = input;

        // Find the term and confirm it belongs to this school
        const term = await prisma.academicTerm.findFirst({
            where: { id: termId, schoolId },
            select: { id: true, name: true }
        });

        if (!term) throw new Error("Term not found");

        // Validate name if provided
        if (name) {
            const allowed = ["First Term", "Second Term", "Third Term"];
            if (!allowed.includes(name)) {
                throw new Error("Term name must be one of: First Term, Second Term, Third Term");
            }
        }

        // Update term with provided fields
        const updateData: any = {};
        if (name) updateData.name = name;
        if (resumptionDate) updateData.resumptionDate = resumptionDate;

        if (Object.keys(updateData).length === 0) {
            throw new Error("No fields to update");
        }

        const updated = await prisma.academicTerm.update({
            where: { id: termId },
            data: updateData,
            select: { id: true, name: true, isActive: true, resumptionDate: true, session: { select: { id: true, name: true } } }
        });

        return updated;
    }

}
