// src/services/grading/GradingService.ts
import prisma from "../../util/prisma"
import { CreateGradingSchemeDTO, UpdateGradingSchemeDTO } from "../../dtos/grading.dto"

import { Prisma } from "@prisma/client";


export class GradingService {
    static createScheme(schoolId: number, body: any) {
        throw new Error("Method not implemented.");
    }

    private validateGrades(grades: CreateGradingSchemeDTO["grades"]) {
        const sorted = [...grades].sort((a, b) => a.min - b.min);

        for (let i = 0; i < sorted.length; i++) {
            const g = sorted[i];

            if (g.min > g.max) {
                throw new Error(`Invalid range for grade ${g.grade}`);
            }

            if (i > 0 && g.min <= sorted[i - 1].max) {
                throw new Error("Grading ranges must not overlap");
            }
        }
    }

    async createScheme(schoolId: number, data: CreateGradingSchemeDTO) {
        this.validateGrades(data.grades);

        return prisma.$transaction(async (tx: Prisma.TransactionClient) => {

            const classes = await tx.class.findMany({
                where: {
                    id: { in: data.classIds },
                    schoolId,
                    ...(data.campusId ? { campusId: data.campusId } : {})
                },
                select: { id: true }
            });

            if (classes.length !== data.classIds.length) {
                throw new Error("Invalid class selection for this school");
            }

            const existingAssignments = await tx.gradingSchemeClass.findMany({
                where: { classId: { in: data.classIds } }
            });

            if (existingAssignments.length > 0) {
                throw new Error("One or more classes already have a grading scheme assigned");
            }

            const scheme = await tx.gradingScheme.create({
                data: {
                    schoolId,
                    campusId: data.campusId ?? null,
                    name: data.name,
                    usePosition: data.usePosition
                }
            });

            await tx.gradingRule.createMany({
                data: data.grades.map(g => ({
                    schemeId: scheme.id,
                    minScore: g.min,
                    maxScore: g.max,
                    grade: g.grade,
                    remark: g.remark
                }))
            });

            await tx.gradingSchemeClass.createMany({
                data: data.classIds.map(classId => ({
                    schemeId: scheme.id,
                    classId
                }))
            });

            return {
                scheme,
                classIds: data.classIds,
                grades: data.grades.length
            }
        });
    }

    async addClassesToScheme(schoolId: number, schemeId: number, classIds: number[]) {
        if (!Array.isArray(classIds) || classIds.length === 0) {
            throw new Error("classIds is required");
        }

        return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const scheme = await tx.gradingScheme.findFirst({
                where: { id: schemeId, schoolId },
                select: { id: true }
            });

            if (!scheme) throw new Error("Grading scheme not found for this school");

            const classes = await tx.class.findMany({
                where: { id: { in: classIds }, schoolId },
                select: { id: true }
            });

            if (classes.length !== classIds.length) {
                throw new Error("One or more classIds are invalid for this school");
            }

            const existing = await tx.gradingSchemeClass.findMany({
                where: { classId: { in: classIds } },
                select: { classId: true }
            });

            const taken = new Set(existing.map((x) => x.classId));
            const newClassIds = classIds.filter((id) => !taken.has(id));

            if (newClassIds.length === 0) {
                return { added: 0, skipped: classIds.length };
            }

            await tx.gradingSchemeClass.createMany({
                data: newClassIds.map((classId) => ({
                    schemeId,
                    classId
                }))
            });

            return { added: newClassIds.length, skipped: classIds.length - newClassIds.length };
        });
    }

    async updateScheme(schoolId: number, schemeId: number, data: UpdateGradingSchemeDTO) {
        // Validate grades if provided
        if (data.grades) {
            this.validateGrades(data.grades);
        }

        return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            // Check if scheme exists and belongs to this school
            const scheme = await tx.gradingScheme.findFirst({
                where: { id: schemeId, schoolId },
                select: { id: true }
            });

            if (!scheme) {
                throw new Error("Grading scheme not found for this school");
            }

            // Update scheme basic info
            const updateData: any = {};
            if (data.name !== undefined) updateData.name = data.name;
            if (data.usePosition !== undefined) updateData.usePosition = data.usePosition;
            if (data.campusId !== undefined) updateData.campusId = data.campusId;

            const updatedScheme = await tx.gradingScheme.update({
                where: { id: schemeId },
                data: updateData,
                select: {
                    id: true,
                    schoolId: true,
                    name: true,
                    usePosition: true,
                    campusId: true,
                    createdAt: true
                }
            });

            // Update grades if provided
            let gradesCount = 0;
            if (data.grades) {
                // Delete existing grades
                await tx.gradingRule.deleteMany({
                    where: { schemeId }
                });

                // Create new grades
                await tx.gradingRule.createMany({
                    data: data.grades.map(g => ({
                        schemeId,
                        minScore: g.min,
                        maxScore: g.max,
                        grade: g.grade,
                        remark: g.remark
                    }))
                });
                gradesCount = data.grades.length;
            } else {
                // Get existing grade count if not updating grades
                gradesCount = await tx.gradingRule.count({
                    where: { schemeId }
                });
            }

            // Handle class assignments if provided
            let classesUpdated = false;
            let addedClasses = 0;
            let removedClasses = 0;

            if (data.classIds !== undefined) {
                // Get current class assignments for this scheme
                const currentAssignments = await tx.gradingSchemeClass.findMany({
                    where: { schemeId },
                    select: { classId: true }
                });

                const currentClassIds = currentAssignments.map(a => a.classId);
                const newClassIds = data.classIds;

                // Find classes to add and remove
                const classesToAdd = newClassIds.filter(id => !currentClassIds.includes(id));
                const classesToRemove = currentClassIds.filter(id => !newClassIds.includes(id));

                // Validate classes being added don't already have other schemes
                if (classesToAdd.length > 0) {
                    const existingAssignments = await tx.gradingSchemeClass.findMany({
                        where: {
                            classId: { in: classesToAdd },
                            schemeId: { not: schemeId }
                        }
                    });

                    if (existingAssignments.length > 0) {
                        throw new Error("One or more classes already have a different grading scheme assigned");
                    }

                    // Add new classes
                    await tx.gradingSchemeClass.createMany({
                        data: classesToAdd.map(classId => ({
                            schemeId,
                            classId
                        }))
                    });
                    addedClasses = classesToAdd.length;
                }

                // Remove classes that are no longer selected
                if (classesToRemove.length > 0) {
                    const deleteResult = await tx.gradingSchemeClass.deleteMany({
                        where: {
                            schemeId,
                            classId: { in: classesToRemove }
                        }
                    });
                    removedClasses = deleteResult.count;
                }

                classesUpdated = classesToAdd.length > 0 || classesToRemove.length > 0;
            }

            return {
                scheme: updatedScheme,
                gradesUpdated: data.grades ? true : false,
                grades: gradesCount,
                classesUpdated,
                classesAdded: addedClasses,
                classesRemoved: removedClasses
            };
        });
    }

    async deleteRemarkRule(schoolId: number, ruleId: number) {
        const rule = await prisma.gradingRule.findFirst({
            where: {
                id: ruleId,
                scheme: { schoolId }
            },
            select: { id: true }
        });

        if (!rule) {
            throw new Error("Remark rule not found for this school");
        }

        await prisma.gradingRule.delete({
            where: { id: ruleId }
        });

        return { deleted: true, ruleId };
    }

    async getSchemesBySchool(schoolId: number) {
        const schemes = await prisma.gradingScheme.findMany({
            where: { schoolId },
            select: {
                id: true,
                schoolId: true,
                name: true,
                usePosition: true,
                campusId: true,
                createdAt: true,
                grades: {
                    select: {
                        id: true,
                        minScore: true,
                        maxScore: true,
                        grade: true,
                        remark: true
                    }
                },
                classes: {
                    select: {
                        classId: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return schemes;
    }

    async deleteScheme(schoolId: number, schemeId: number) {
        const scheme = await prisma.gradingScheme.findFirst({
            where: { id: schemeId, schoolId },
            include: {
                classes: {
                    select: { classId: true }
                }
            }
        });

        if (!scheme) {
            throw new Error("Grading scheme not found for this school");
        }

        // Prevent deletion if scheme is assigned to classes
        if (scheme.classes.length > 0) {
            throw new Error(`Cannot delete scheme that is assigned to ${scheme.classes.length} class(es). Unassign classes first.`);
        }

        return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            // Delete all rules for this scheme
            await tx.gradingRule.deleteMany({
                where: { schemeId }
            });

            // Delete the scheme itself
            await tx.gradingScheme.delete({
                where: { id: schemeId }
            });

            return { deleted: true, schemeId };
        });
    }
}

