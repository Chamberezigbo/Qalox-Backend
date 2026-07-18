class SchoolService {
  private prisma: any;

  constructor() {
    this.prisma = require("../util/prisma");
  }

  /**
   * Get school details with all associated campuses
   */
  async getSchoolWithCampuses(schoolId: number) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        campuses: {
          select: {
            id: true,
            name: true,
            address: true,
            phoneNumber: true,
            email: true,
          },
        },
      },
    });

    if (!school) {
      throw new Error("School not found");
    }

    return school;
  }

  /**
   * Suspend a school (mark as isSuspended = true)
   */
  async suspendSchool(
    schoolId: number,
    reason?: string
  ) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error("School not found");
    }

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: {
        isSuspended: true,
        suspendedAt: new Date(),
        suspensionReason: reason || null,
        updatedAt: new Date(),
      },
    });

    return updated;
  }

  /**
   * Reactivate a school (mark as isSuspended = false)
   */
  async reactivateSchool(schoolId: number) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error("School not found");
    }

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: {
        isSuspended: false,
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: new Date(),
      },
    });

    return updated;
  }

  /**
   * Permanently delete school and all related data (cascade delete)
   * CRITICAL: Must delete in correct order due to foreign keys
   */
  async deleteSchoolCascade(schoolId: number, reason?: string) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error("School not found");
    }

    // Use transaction to ensure atomic deletion
    await this.prisma.$transaction(async (tx) => {
      // Step 1: Delete all result-related data
      // Get all classes in this school first
      const classes = await tx.class.findMany({
        where: { schoolId },
        select: { id: true },
      });
      const classIds = classes.map((c) => c.id);

      if (classIds.length > 0) {
        // Delete PublishedResultRows (child of PublishedResult)
        await tx.publishedResultRow.deleteMany({
          where: {
            publishedResult: {
              classId: { in: classIds },
            },
          },
        });

        // Delete PublishedResults
        await tx.publishedResult.deleteMany({
          where: { classId: { in: classIds } },
        });

        // Delete ResultSubmissions
        await tx.resultSubmission.deleteMany({
          where: { classId: { in: classIds } },
        });

        // Delete ExamResults and CAResults (student scores)
        const students = await tx.student.findMany({
          where: { schoolId },
          select: { id: true },
        });
        const studentIds = students.map((s) => s.id);

        if (studentIds.length > 0) {
          await tx.examResult.deleteMany({
            where: { studentId: { in: studentIds } },
          });

          await tx.cAResult.deleteMany({
            where: { studentId: { in: studentIds } },
          });
        }

        // Delete Exams and ContinuousAssessments
        await tx.exam.deleteMany({
          where: { classId: { in: classIds } },
        });

        await tx.continuousAssessment.deleteMany({
          where: { classId: { in: classIds } },
        });
      }

      // Step 2: Delete academic structures
      const sessions = await tx.academicSession.findMany({
        where: { schoolId },
        select: { id: true },
      });
      const sessionIds = sessions.map((s) => s.id);

      if (sessionIds.length > 0) {
        await tx.academicTerm.deleteMany({
          where: { sessionId: { in: sessionIds } },
        });

        await tx.academicSession.deleteMany({
          where: { schoolId },
        });
      }

      // Step 3: Delete ClassSubjects and CATemplates
      if (classIds.length > 0) {
        await tx.classSubject.deleteMany({
          where: { classId: { in: classIds } },
        });

        await tx.cATemplate.deleteMany({
          where: { classId: { in: classIds } },
        });
      }

      // School-level templates
      await tx.cATemplate.deleteMany({
        where: { schoolId },
      });

      // Step 4: Delete grading structures
      const schemes = await tx.gradingScheme.findMany({
        where: { schoolId },
        select: { id: true },
      });
      const schemeIds = schemes.map((s) => s.id);

      if (schemeIds.length > 0) {
        await tx.gradingRule.deleteMany({
          where: { schemeId: { in: schemeIds } },
        });

        await tx.gradingScheme.deleteMany({
          where: { schoolId },
        });
      }

      // Delete GradingSchemeClasses
      if (classIds.length > 0) {
        await tx.gradingSchemeClass.deleteMany({
          where: { classId: { in: classIds } },
        });
      }

      // Delete RemarkScheme
      await tx.remarkScheme.deleteMany({
        where: { schoolId },
      });

      // Step 5: Delete teacher assignments and subjects
      await tx.teacherAssignment.deleteMany({
        where: {
          staff: {
            schoolId,
          },
        },
      });

      await tx.subject.deleteMany({
        where: { schoolId },
      });

      // Step 6: Delete users (students, staff, admins)
      await tx.student.deleteMany({
        where: { schoolId },
      });

      await tx.staff.deleteMany({
        where: { schoolId },
      });

      await tx.admin.deleteMany({
        where: { schoolId },
      });

      // Step 7: Delete classes and class groups
      if (classIds.length > 0) {
        await tx.classGroup.deleteMany({
          where: { classId: { in: classIds } },
        });

        await tx.class.deleteMany({
          where: { schoolId },
        });
      }

      // Step 8: Delete campuses
      await tx.campus.deleteMany({
        where: { schoolId },
      });

      // Step 9: Finally, delete the school itself
      await tx.school.delete({
        where: { id: schoolId },
      });
    });

    return {
      id: school.id,
      name: school.name,
      deletedAt: new Date(),
      deletionReason: reason || null,
    };
  }
}

module.exports = { SchoolService };
