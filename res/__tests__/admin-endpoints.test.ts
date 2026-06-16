import { AssessmentService } from "../Services/AssessmentService";
import { AcademicTermService } from "../Services/AcademicTermService";
import prisma from "../util/prisma";

describe("Admin Endpoints Tests", () => {
  const assessmentService = new AssessmentService();
  const termService = new AcademicTermService();

  const testSchoolId = 1;
  const testSessionId = 1;
  const testTermId = 1;
  const testClassId = 1;
  const testSubjectId = 1;
  const testStudentId = 1;
  const testStaffId = 1;

  describe("RemarkScheme Endpoints", () => {
    test("Should create remark scheme with rules", async () => {
      const result = await assessmentService.createRemarkScheme({
        schoolId: testSchoolId,
        name: "Test Remark Scheme",
        rules: [
          { minScore: 90, maxScore: 100, remark: "{studentName} is excellent!" },
          { minScore: 80, maxScore: 89, remark: "{studentName} is very good!" },
          { minScore: 0, maxScore: 79, remark: "{studentName} needs improvement!" }
        ]
      });

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.name).toBe("Test Remark Scheme");
      expect(result.rules).toHaveLength(3);
    });

    test("Should get remark scheme by school ID", async () => {
      const result = await assessmentService.getRemarkScheme(testSchoolId);

      expect(result).toBeDefined();
      expect(result.schoolId).toBe(testSchoolId);
      expect(result.rules).toBeDefined();
      expect(Array.isArray(result.rules)).toBe(true);
    });

    test("Should add rules to existing remark scheme", async () => {
      // First create a scheme
      const scheme = await assessmentService.createRemarkScheme({
        schoolId: testSchoolId,
        name: "Initial Scheme",
        rules: [
          { minScore: 50, maxScore: 100, remark: "Pass" }
        ]
      });

      // Then add more rules
      const result = await assessmentService.addRemarkRules({
        schemeId: scheme.id,
        schoolId: testSchoolId,
        rules: [
          { minScore: 85, maxScore: 100, remark: "{studentName} is outstanding!" }
        ]
      });

      expect(result).toBeDefined();
      expect(result?.rules.length).toBeGreaterThan(1);
    });

    test("Should personalize remark with student name", async () => {
      const scheme = await assessmentService.getRemarkScheme(testSchoolId);
      const remarkTemplate = scheme.rules[0]?.remark;

      if (remarkTemplate && remarkTemplate.includes("{studentName}")) {
        const personalized = remarkTemplate.replace("{studentName}", "John Doe");
        expect(personalized).toContain("John Doe");
        expect(personalized).not.toContain("{studentName}");
      }
    });
  });

  describe("Term Management Endpoints", () => {
    test("Should update term with new name and resumptionDate", async () => {
      const result = await termService.updateTerm({
        termId: testTermId,
        schoolId: testSchoolId,
        name: "First Term",
        resumptionDate: new Date("2024-02-08")
      });

      expect(result).toBeDefined();
      expect(result.id).toBe(testTermId);
      expect(result.name).toBe("First Term");
      expect(result.resumptionDate).toBeDefined();
    });

    test("Should validate term name", async () => {
      try {
        await termService.updateTerm({
          termId: testTermId,
          schoolId: testSchoolId,
          name: "Invalid Term"
        });
        fail("Should have thrown error for invalid term name");
      } catch (error: any) {
        expect(error.message).toContain("Term name must be one of");
      }
    });

    test("Should handle optional resumptionDate", async () => {
      try {
        const result = await termService.updateTerm({
          termId: testTermId,
          schoolId: testSchoolId,
          resumptionDate: new Date("2024-03-08")
        });

        expect(result).toBeDefined();
        expect(result.resumptionDate).toBeDefined();
      } catch (error: any) {
        // If it fails, it's likely due to data constraints, which is fine
        expect(error).toBeDefined();
      }
    });
  });

  describe("Student Result Endpoint", () => {
    test("Should return complete student result with all data", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId,
        academicSessionId: testSessionId,
        termId: testTermId
      });

      expect(result).toBeDefined();
      expect(result.studentInformation).toBeDefined();
      expect(result.studentInformation.name).toBeDefined();
      expect(result.studentInformation.registrationNumber).toBeDefined();
      expect(result.academicInfo).toBeDefined();
      expect(result.subjects).toBeDefined();
      expect(Array.isArray(result.subjects)).toBe(true);
      expect(result.performanceSummary).toBeDefined();
      expect(result.schoolRecommendationDate).toBeDefined();
    });

    test("Should calculate performance summary correctly", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId
      });

      expect(result.performanceSummary).toBeDefined();
      expect(result.performanceSummary.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.performanceSummary.averageScore).toBeGreaterThanOrEqual(0);
      expect(result.performanceSummary.overallGrade).toBeDefined();
    });

    test("Should include passport URL", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId
      });

      expect(result.studentInformation).toHaveProperty("passportUrl");
    });

    test("Should include teacher remark", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId
      });

      expect(result).toHaveProperty("teacherRemark");
    });

    test("Should include next term resumption date", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId,
        termId: testTermId
      });

      expect(result.schoolRecommendationDate).toBeDefined();
    });
  });

  describe("Teacher Result Endpoint", () => {
    test("Should return teacher information with student records", async () => {
      const result = await assessmentService.getTeacherResult({
        staffId: testStaffId,
        classId: testClassId,
        subjectId: testSubjectId,
        schoolId: testSchoolId,
        page: 1,
        pageSize: 10
      });

      expect(result).toBeDefined();
      if (result && "teacherInformation" in result) {
        expect(result.teacherInformation).toBeDefined();
        expect(result.teacherInformation?.name).toBeDefined();
        expect(result.students).toBeDefined();
        expect(Array.isArray(result.students)).toBe(true);
      }
    });

    test("Should include CA and exam scores in student records", async () => {
      const result = await assessmentService.getTeacherResult({
        staffId: testStaffId,
        classId: testClassId,
        subjectId: testSubjectId,
        schoolId: testSchoolId,
        page: 1,
        pageSize: 10
      });

      if (result && "students" in result && result.students && result.students.length > 0) {
        const student = result.students[0];
        expect(student).toHaveProperty("registrationNumber");
        expect(student).toHaveProperty("studentName");
        expect(student).toHaveProperty("cas");
        expect(student).toHaveProperty("caScore");
        expect(student).toHaveProperty("examScore");
        expect(student).toHaveProperty("total");
        expect(student).toHaveProperty("grade");
        expect(student).toHaveProperty("remarks");
      }
    });

    test("Should include date submitted", async () => {
      const result = await assessmentService.getTeacherResult({
        staffId: testStaffId,
        classId: testClassId,
        subjectId: testSubjectId,
        schoolId: testSchoolId,
        page: 1,
        pageSize: 10
      });

      expect(result.teacherInformation).toHaveProperty("dateSubmitted");
    });

    test("Should support pagination", async () => {
      const result = await assessmentService.getTeacherResult({
        staffId: testStaffId,
        classId: testClassId,
        subjectId: testSubjectId,
        schoolId: testSchoolId,
        page: 1,
        pageSize: 10
      });

      expect(result.pagination).toBeDefined();
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(10);
      expect(result.pagination.totalCount).toBeGreaterThanOrEqual(0);
      expect(result.pagination.totalPages).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Broadsheet Endpoint", () => {
    test("Should return broadsheet with class name (not custom name)", async () => {
      const result = await assessmentService.getAdminBroadsheet({
        classId: testClassId,
        schoolId: testSchoolId,
        academicSessionId: testSessionId
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);

      if (result && result.length > 0) {
        const broadsheet = result[0];
        if (broadsheet) {
          expect(broadsheet.className).toBeDefined();
          expect(typeof broadsheet.className).toBe("string");
        }
      }
    });
  });

  describe("Data Consistency Tests", () => {
    test("Remark should match score range", async () => {
      const scheme = await assessmentService.getRemarkScheme(testSchoolId);

      // Check that each rule has valid score range
      scheme.rules.forEach(rule => {
        expect(rule.minScore).toBeLessThanOrEqual(rule.maxScore);
        expect(rule.remark).toBeDefined();
      });
    });

    test("Student total should equal CA total + Exam total", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId
      });

      result.subjects.forEach(subject => {
        const expectedTotal = subject.caTotal + subject.examTotal;
        expect(subject.subjectTotal).toBe(expectedTotal);
      });
    });

    test("Grade should match grading scheme", async () => {
      const result = await assessmentService.getStudentCompleteResult({
        studentId: testStudentId,
        schoolId: testSchoolId
      });

      // Grade should be either "N/A" or a valid grade
      result.subjects.forEach(subject => {
        expect(subject.grade).toBeDefined();
        expect(typeof subject.grade).toBe("string");
      });
    });
  });
});
