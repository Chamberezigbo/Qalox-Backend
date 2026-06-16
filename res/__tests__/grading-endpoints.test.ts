import { GradingService } from "../Services/teacher/GradingService";
import prisma from "../util/prisma";

describe("Grading Endpoints Tests", () => {
  const gradingService = new GradingService();
  const testSchoolId = 1;
  const testCampusId = 1;

  let validClassIds: number[] = [];
  let schemeCounter = 0; // To avoid name conflicts

  beforeAll(async () => {
    // Fetch valid class IDs from database for this school
    const classes = await prisma.class.findMany({
      where: { schoolId: testSchoolId },
      select: { id: true },
      take: 50
    });
    validClassIds = classes.map(c => c.id);

    if (validClassIds.length < 10) {
      console.warn(`Warning: Only ${validClassIds.length} classes available. Some tests may be skipped.`);
    }

    // Clean up any existing grading scheme assignments for test classes
    // This ensures tests can reuse classes from previous test runs
    await prisma.gradingSchemeClass.deleteMany({
      where: {
        classId: { in: validClassIds }
      }
    });
  });

  // Helper to get next available class ID (ensuring we don't reuse)
  const getNextClassIds = (count: number): number[] => {
    const startIdx = schemeCounter * count;
    const endIdx = startIdx + count;
    if (endIdx > validClassIds.length) {
      return []; // Not enough classes
    }
    const result = validClassIds.slice(startIdx, endIdx);
    schemeCounter++;
    return result;
  };

  describe("POST /admin/grading/create - Create Grading Scheme", () => {
    test("Should create grading scheme with single class", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) {
        console.warn("Skipping test: Not enough valid classes");
        return;
      }

      const result = await gradingService.createScheme(testSchoolId, {
        name: `Single Class Grading ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" },
          { min: 50, max: 69, grade: "B", remark: "Good" },
          { min: 0, max: 49, grade: "C", remark: "Needs Improvement" }
        ]
      });

      expect(result).toBeDefined();
      expect(result.scheme).toBeDefined();
      expect(result.scheme.schoolId).toBe(testSchoolId);
      expect(result.classIds).toHaveLength(1);
      expect(result.grades).toBe(3);
    });

    test("Should create grading scheme with multiple classes", async () => {
      const classIds = getNextClassIds(3);
      if (classIds.length < 3) {
        console.warn("Skipping test: Not enough valid classes");
        return;
      }

      const result = await gradingService.createScheme(testSchoolId, {
        name: `Multiple Classes Grading ${Date.now()}`,
        usePosition: false,
        classIds,
        grades: [
          { min: 80, max: 100, grade: "A+", remark: "Outstanding" },
          { min: 60, max: 79, grade: "B", remark: "Satisfactory" },
          { min: 0, max: 59, grade: "C", remark: "Unsatisfactory" }
        ]
      });

      expect(result).toBeDefined();
      expect(result.scheme.usePosition).toBe(false);
      expect(result.classIds).toHaveLength(3);
      expect(result.grades).toBe(3);
    });

    test("Should validate grade ranges do not overlap", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      try {
        await gradingService.createScheme(testSchoolId, {
          name: `Overlapping Grades ${Date.now()}`,
          usePosition: true,
          classIds,
          grades: [
            { min: 70, max: 100, grade: "A", remark: "Excellent" },
            { min: 60, max: 80, grade: "B", remark: "Good" } // Overlaps with A
          ]
        });
        fail("Should have thrown overlapping error");
      } catch (error: any) {
        expect(error.message).toContain("overlap");
      }
    });

    test("Should validate min <= max for each grade", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      try {
        await gradingService.createScheme(testSchoolId, {
          name: `Invalid Range ${Date.now()}`,
          usePosition: true,
          classIds,
          grades: [
            { min: 100, max: 50, grade: "A", remark: "Invalid" } // min > max
          ]
        });
        fail("Should have thrown range error");
      } catch (error: any) {
        expect(error.message).toContain("Invalid range");
      }
    });

    test("Should fail if class doesn't belong to school", async () => {
      try {
        await gradingService.createScheme(999, {
          name: `Wrong School ${Date.now()}`,
          usePosition: true,
          classIds: [99999],
          grades: [
            { min: 70, max: 100, grade: "A", remark: "Excellent" }
          ]
        });
        fail("Should have thrown error for invalid school");
      } catch (error: any) {
        expect(error.message).toContain("Invalid class selection");
      }
    });

    test("Should fail if class already has a grading scheme", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      // First, create a scheme
      await gradingService.createScheme(testSchoolId, {
        name: `First Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Try to assign the same class to another scheme
      try {
        await gradingService.createScheme(testSchoolId, {
          name: `Second Scheme ${Date.now()}`,
          usePosition: false,
          classIds, // Same class
          grades: [
            { min: 70, max: 100, grade: "A", remark: "Excellent" }
          ]
        });
        fail("Should have thrown error for duplicate class assignment");
      } catch (error: any) {
        expect(error.message).toContain("already have a grading scheme");
      }
    });

    test("Should create scheme with campusId if provided", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const result = await gradingService.createScheme(testSchoolId, {
        name: `Campus-Specific ${Date.now()}`,
        usePosition: true,
        campusId: testCampusId,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      expect(result.scheme.campusId).toBe(testCampusId);
    });
  });

  describe("GET /admin/grading - Get All Grading Schemes", () => {
    test("Should return all schemes for school", async () => {
      const schemes = await gradingService.getSchemesBySchool(testSchoolId);
      expect(Array.isArray(schemes)).toBe(true);
    });

    test("Should include full scheme details", async () => {
      const schemes = await gradingService.getSchemesBySchool(testSchoolId);

      if (schemes.length > 0) {
        const scheme = schemes[0];
        expect(scheme.id).toBeDefined();
        expect(scheme.name).toBeDefined();
        expect(scheme.usePosition).toBeDefined();
        expect(scheme.grades).toBeDefined();
        expect(Array.isArray(scheme.grades)).toBe(true);
        expect(scheme.classes).toBeDefined();
        expect(Array.isArray(scheme.classes)).toBe(true);
      }
    });

    test("Should return schemes sorted by creation date (newest first)", async () => {
      const schemes = await gradingService.getSchemesBySchool(testSchoolId);

      if (schemes.length > 1) {
        for (let i = 0; i < schemes.length - 1; i++) {
          const createdAt1 = new Date(schemes[i].createdAt).getTime();
          const createdAt2 = new Date(schemes[i + 1].createdAt).getTime();
          expect(createdAt1).toBeGreaterThanOrEqual(createdAt2);
        }
      }
    });

    test("Should include correct grade structure in response", async () => {
      const schemes = await gradingService.getSchemesBySchool(testSchoolId);

      if (schemes.length > 0 && schemes[0].grades.length > 0) {
        const grade = schemes[0].grades[0];
        expect(grade.id).toBeDefined();
        expect(grade.minScore).toBeDefined();
        expect(grade.maxScore).toBeDefined();
        expect(grade.grade).toBeDefined();
        expect(grade.remark).toBeDefined();
      }
    });

    test("Should include correct class structure in response", async () => {
      const schemes = await gradingService.getSchemesBySchool(testSchoolId);

      if (schemes.length > 0 && schemes[0].classes.length > 0) {
        const classAssignment = schemes[0].classes[0];
        expect(classAssignment.classId).toBeDefined();
        expect(typeof classAssignment.classId).toBe("number");
      }
    });
  });

  describe("POST /admin/grading/:schemeId/classes - Add Classes to Scheme", () => {
    test("Should add single class to existing scheme", async () => {
      const classIds = getNextClassIds(2); // Need 2 classes
      if (classIds.length < 2) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Add Classes Scheme ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.addClassesToScheme(testSchoolId, scheme.scheme.id, [classIds[1]]);
      expect(result.added).toBe(1);
      expect(result.skipped).toBe(0);
    });

    test("Should add multiple classes to existing scheme", async () => {
      const classIds = getNextClassIds(4); // Need 4 classes
      if (classIds.length < 4) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Multi-Add Scheme ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.addClassesToScheme(
        testSchoolId,
        scheme.scheme.id,
        [classIds[1], classIds[2], classIds[3]]
      );

      expect(result.added).toBe(3);
      expect(result.skipped).toBe(0);
    });

    test("Should fail if scheme not found for school", async () => {
      try {
        const classIds = getNextClassIds(1);
        if (classIds.length === 0) return;

        await gradingService.addClassesToScheme(testSchoolId, 9999, classIds);
        fail("Should have thrown error for non-existent scheme");
      } catch (error: any) {
        expect(error.message).toContain("Grading scheme not found");
      }
    });

    test("Should require at least one classId", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Empty Classes Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      try {
        await gradingService.addClassesToScheme(testSchoolId, scheme.scheme.id, []);
        fail("Should have thrown error for empty classIds");
      } catch (error: any) {
        expect(error.message).toContain("classIds is required");
      }
    });
  });

  describe("DELETE /admin/grading/:schemeId - Delete Grading Scheme", () => {
    test("Should delete scheme when no classes are assigned", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Deletable Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Remove all class assignments before deletion
      await prisma.gradingSchemeClass.deleteMany({
        where: { schemeId: scheme.scheme.id }
      });

      const result = await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);
      expect(result.deleted).toBe(true);
      expect(result.schemeId).toBe(scheme.scheme.id);
    });

    test("Should delete all rules when deleting scheme", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Rules Delete Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" },
          { min: 50, max: 69, grade: "B", remark: "Good" }
        ]
      });

      // Remove class assignment
      await prisma.gradingSchemeClass.deleteMany({
        where: { schemeId: scheme.scheme.id }
      });

      await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);

      // Verify rules are deleted
      const remainingRules = await prisma.gradingRule.findMany({
        where: { schemeId: scheme.scheme.id }
      });

      expect(remainingRules).toHaveLength(0);
    });

    test("Should prevent deletion if scheme is assigned to classes", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Protected Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Try to delete without removing class assignment
      try {
        await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);
        fail("Should have thrown error for scheme assigned to classes");
      } catch (error: any) {
        expect(error.message).toContain("Cannot delete scheme that is assigned");
      }
    });

    test("Should fail if scheme not found for school", async () => {
      try {
        await gradingService.deleteScheme(testSchoolId, 9999);
        fail("Should have thrown error for non-existent scheme");
      } catch (error: any) {
        expect(error.message).toContain("Grading scheme not found");
      }
    });

    test("Should successfully delete after unassigning all classes", async () => {
      const classIds = getNextClassIds(3);
      if (classIds.length < 3) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Eventually Deletable ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Remove all class assignments
      await prisma.gradingSchemeClass.deleteMany({
        where: { schemeId: scheme.scheme.id }
      });

      const result = await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);
      expect(result.deleted).toBe(true);

      // Verify scheme is deleted
      const deletedScheme = await prisma.gradingScheme.findUnique({
        where: { id: scheme.scheme.id }
      });

      expect(deletedScheme).toBeNull();
    });
  });

  describe("DELETE /admin/grading/remark/:ruleId - Delete Remark Rule", () => {
    test("Should delete a single remark rule", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Delete Rule Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" },
          { min: 50, max: 69, grade: "B", remark: "Good" }
        ]
      });

      const rules = await prisma.gradingRule.findMany({
        where: { schemeId: scheme.scheme.id }
      });

      expect(rules.length).toBeGreaterThan(0);

      const result = await gradingService.deleteRemarkRule(testSchoolId, rules[0].id);
      expect(result.deleted).toBe(true);
      expect(result.ruleId).toBe(rules[0].id);
    });

    test("Should verify rule is deleted after deleteRemarkRule", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Verify Delete Scheme ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" },
          { min: 0, max: 69, grade: "B", remark: "Good" }
        ]
      });

      const rules = await prisma.gradingRule.findMany({
        where: { schemeId: scheme.scheme.id }
      });

      const ruleToDelete = rules[0];
      await gradingService.deleteRemarkRule(testSchoolId, ruleToDelete.id);

      const deletedRule = await prisma.gradingRule.findUnique({
        where: { id: ruleToDelete.id }
      });

      expect(deletedRule).toBeNull();
    });

    test("Should fail if rule doesn't exist for school", async () => {
      try {
        await gradingService.deleteRemarkRule(testSchoolId, 9999);
        fail("Should have thrown error for non-existent rule");
      } catch (error: any) {
        expect(error.message).toContain("Remark rule not found");
      }
    });
  });

  describe("PUT /admin/grading/:schemeId - Update Grading Scheme", () => {
    test("Should update scheme name only", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Original Name ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        name: "Updated Scheme Name"
      });

      expect(result.scheme.name).toBe("Updated Scheme Name");
      expect(result.scheme.usePosition).toBe(true);
      expect(result.gradesUpdated).toBe(false);
    });

    test("Should update usePosition flag only", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Position Test ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        usePosition: false
      });

      expect(result.scheme.usePosition).toBe(false);
      expect(result.scheme.name).toBe(`Position Test ${Date.now()}`);
      expect(result.gradesUpdated).toBe(false);
    });

    test("Should update grades completely", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Grades Update Test ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" },
          { min: 50, max: 69, grade: "B", remark: "Good" }
        ]
      });

      const newGrades = [
        { min: 80, max: 100, grade: "A+", remark: "Outstanding" },
        { min: 70, max: 79, grade: "A", remark: "Excellent" },
        { min: 60, max: 69, grade: "B", remark: "Good" }
      ];

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        grades: newGrades
      });

      expect(result.gradesUpdated).toBe(true);
      expect(result.grades).toBe(3);

      // Verify grades were actually updated in DB
      const updatedScheme = await prisma.gradingScheme.findUnique({
        where: { id: scheme.scheme.id },
        include: { grades: true }
      });

      expect(updatedScheme?.grades).toHaveLength(3);
      expect(updatedScheme?.grades[0].grade).toBe("A+");
    });

    test("Should update name and usePosition together", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Multi Update ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        name: "New Name",
        usePosition: false
      });

      expect(result.scheme.name).toBe("New Name");
      expect(result.scheme.usePosition).toBe(false);
      expect(result.gradesUpdated).toBe(false);
    });

    test("Should update all fields together", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Full Update ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const newGrades = [
        { min: 80, max: 100, grade: "A+", remark: "Outstanding" },
        { min: 60, max: 79, grade: "A", remark: "Excellent" }
      ];

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        name: "Fully Updated",
        usePosition: false,
        grades: newGrades
      });

      expect(result.scheme.name).toBe("Fully Updated");
      expect(result.scheme.usePosition).toBe(false);
      expect(result.gradesUpdated).toBe(true);
      expect(result.grades).toBe(2);
    });

    test("Should validate grade ranges do not overlap on update", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Overlap Validation ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      try {
        await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
          grades: [
            { min: 70, max: 100, grade: "A", remark: "Excellent" },
            { min: 60, max: 80, grade: "B", remark: "Good" } // Overlaps
          ]
        });
        fail("Should have thrown overlapping error");
      } catch (error: any) {
        expect(error.message).toContain("overlap");
      }
    });

    test("Should validate min <= max on grade update", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Range Validation ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      try {
        await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
          grades: [
            { min: 100, max: 50, grade: "A", remark: "Invalid" } // min > max
          ]
        });
        fail("Should have thrown range error");
      } catch (error: any) {
        expect(error.message).toContain("Invalid range");
      }
    });

    test("Should fail if scheme not found", async () => {
      try {
        await gradingService.updateScheme(testSchoolId, 9999, {
          name: "Non-existent"
        });
        fail("Should have thrown error for non-existent scheme");
      } catch (error: any) {
        expect(error.message).toContain("Grading scheme not found");
      }
    });

    test("Should fail if scheme not found for wrong school", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Wrong School Test ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      try {
        await gradingService.updateScheme(999, scheme.scheme.id, {
          name: "Should Fail"
        });
        fail("Should have thrown error for wrong school");
      } catch (error: any) {
        expect(error.message).toContain("Grading scheme not found");
      }
    });

    test("Should include campusId in update response", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Campus Response ${Date.now()}`,
        usePosition: true,
        campusId: testCampusId,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        name: "Updated with Campus"
      });

      expect(result.scheme.campusId).toBe(testCampusId);
      expect(result.scheme.schoolId).toBe(testSchoolId);
    });

    test("Should update campusId", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Update Campus ${Date.now()}`,
        usePosition: true,
        campusId: testCampusId,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const newCampusId = testCampusId === 1 ? 2 : 1;
      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        campusId: newCampusId
      });

      expect(result.scheme.campusId).toBe(newCampusId);
    });

    test("Should set campusId to null if provided as null", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Null Campus ${Date.now()}`,
        usePosition: true,
        campusId: testCampusId,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        campusId: null
      });

      expect(result.scheme.campusId).toBeNull();
    });

    test("Should preserve class assignments when updating", async () => {
      const classIds = getNextClassIds(2);
      if (classIds.length < 2) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Preserve Classes ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Add another class
      await gradingService.addClassesToScheme(testSchoolId, scheme.scheme.id, [classIds[1]]);

      // Update the scheme
      await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        name: "Updated"
      });

      // Verify classes are still assigned
      const schemeClasses = await prisma.gradingSchemeClass.findMany({
        where: { schemeId: scheme.scheme.id }
      });

      expect(schemeClasses).toHaveLength(2);
    });

    test("Should handle empty update (no fields specified)", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Empty Update ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {});

      expect(result.scheme.id).toBe(scheme.scheme.id);
      expect(result.gradesUpdated).toBe(false);
    });

    test("Should add classes to scheme via update", async () => {
      const classIds = getNextClassIds(3);
      if (classIds.length < 3) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Add Via Update ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        classIds: [classIds[0], classIds[1], classIds[2]]
      });

      expect(result.classesUpdated).toBe(true);
      expect(result.classesAdded).toBe(2);
      expect(result.classesRemoved).toBe(0);

      // Verify in database
      const schemeClasses = await prisma.gradingSchemeClass.findMany({
        where: { schemeId: scheme.scheme.id }
      });
      expect(schemeClasses).toHaveLength(3);
    });

    test("Should remove classes from scheme via update", async () => {
      const classIds = getNextClassIds(3);
      if (classIds.length < 3) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Remove Via Update ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0], classIds[1], classIds[2]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        classIds: [classIds[0]]
      });

      expect(result.classesUpdated).toBe(true);
      expect(result.classesAdded).toBe(0);
      expect(result.classesRemoved).toBe(2);

      // Verify in database
      const schemeClasses = await prisma.gradingSchemeClass.findMany({
        where: { schemeId: scheme.scheme.id }
      });
      expect(schemeClasses).toHaveLength(1);
      expect(schemeClasses[0].classId).toBe(classIds[0]);
    });

    test("Should both add and remove classes via update", async () => {
      const classIds = getNextClassIds(4);
      if (classIds.length < 4) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Mixed Update ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0], classIds[1]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Replace classIds[1] with classIds[2] and classIds[3]
      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        classIds: [classIds[0], classIds[2], classIds[3]]
      });

      expect(result.classesUpdated).toBe(true);
      expect(result.classesAdded).toBe(2);
      expect(result.classesRemoved).toBe(1);

      // Verify in database
      const schemeClasses = await prisma.gradingSchemeClass.findMany({
        where: { schemeId: scheme.scheme.id },
        select: { classId: true }
      });
      expect(schemeClasses).toHaveLength(3);
      const assignedClassIds = schemeClasses.map(c => c.classId);
      expect(assignedClassIds).toContain(classIds[0]);
      expect(assignedClassIds).toContain(classIds[2]);
      expect(assignedClassIds).toContain(classIds[3]);
    });

    test("Should prevent assigning classes that have other schemes via update", async () => {
      const classIds = getNextClassIds(4);
      if (classIds.length < 4) return;

      // Create first scheme with classIds[0]
      const scheme1 = await gradingService.createScheme(testSchoolId, {
        name: `Scheme 1 ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Create second scheme with classIds[1]
      const scheme2 = await gradingService.createScheme(testSchoolId, {
        name: `Scheme 2 ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[1]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Try to add classIds[1] (which belongs to scheme2) to scheme1
      try {
        await gradingService.updateScheme(testSchoolId, scheme1.scheme.id, {
          classIds: [classIds[0], classIds[1]]
        });
        fail("Should have thrown error for class already assigned to another scheme");
      } catch (error: any) {
        expect(error.message).toContain("already have a different grading scheme");
      }
    });

    test("Should unassign all classes and then allow scheme deletion", async () => {
      const classIds = getNextClassIds(2);
      if (classIds.length < 2) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Deletable Via Update ${Date.now()}`,
        usePosition: true,
        classIds: [classIds[0], classIds[1]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Remove all classes via update
      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        classIds: []
      });

      expect(result.classesUpdated).toBe(true);
      expect(result.classesRemoved).toBe(2);

      // Now scheme should be deletable
      const deleteResult = await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);
      expect(deleteResult.deleted).toBe(true);
    });

    test("Should update campusId along with classIds", async () => {
      const classIds = getNextClassIds(2);
      if (classIds.length < 2) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Campus and Classes ${Date.now()}`,
        usePosition: true,
        campusId: testCampusId,
        classIds: [classIds[0]],
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      const newCampusId = testCampusId === 1 ? 2 : 1;
      const result = await gradingService.updateScheme(testSchoolId, scheme.scheme.id, {
        campusId: newCampusId,
        classIds: [classIds[0], classIds[1]]
      });

      expect(result.scheme.campusId).toBe(newCampusId);
      expect(result.classesUpdated).toBe(true);
      expect(result.classesAdded).toBe(1);
    });
  });

  describe("Data Integrity Tests", () => {
    test("Should maintain referential integrity when deleting scheme", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Integrity Test ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      await prisma.gradingSchemeClass.deleteMany({
        where: { schemeId: scheme.scheme.id }
      });

      await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);

      // Verify no orphaned records
      const orphanedRules = await prisma.gradingRule.findMany({
        where: { schemeId: scheme.scheme.id }
      });

      expect(orphanedRules).toHaveLength(0);
    });

    test("Should handle transaction rollback on schema deletion error", async () => {
      const classIds = getNextClassIds(1);
      if (classIds.length === 0) return;

      const scheme = await gradingService.createScheme(testSchoolId, {
        name: `Rollback Test ${Date.now()}`,
        usePosition: true,
        classIds,
        grades: [
          { min: 70, max: 100, grade: "A", remark: "Excellent" }
        ]
      });

      // Try to delete with classes still assigned (should fail)
      try {
        await gradingService.deleteScheme(testSchoolId, scheme.scheme.id);
        fail("Should have thrown error");
      } catch (error: any) {
        expect(error.message).toContain("Cannot delete scheme");
      }

      // Verify scheme still exists
      const stillExists = await prisma.gradingScheme.findUnique({
        where: { id: scheme.scheme.id }
      });

      expect(stillExists).toBeDefined();
      expect(stillExists?.id).toBe(scheme.scheme.id);
    });
  });
});
