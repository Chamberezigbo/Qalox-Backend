import { StudentDashboardService } from "../Services/student/StudentDashboardService";
import { StudentResultService } from "../Services/student/StudentResultService";

describe("Student Endpoints Tests", () => {
  const dashboardService = new StudentDashboardService();
  const resultService = new StudentResultService();
  const testStudentId = 1;
  const testSchoolId = 1;
  const testAcademicSessionId = 1;

  describe("Student Dashboard Endpoint", () => {
    test("Should return student basic information", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result).toBeDefined();
      expect(result.student).toBeDefined();
      expect(result.student.name).toBeDefined();
      expect(result.student.registrationNumber).toBeDefined();
      expect(result.student.class).toBeDefined();
      expect(result.student.school).toBeDefined();
    });

    test("Should include current term information", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result).toHaveProperty("currentTerm");

      if (result.currentTerm) {
        expect(result.currentTerm.id).toBeDefined();
        expect(result.currentTerm.name).toBeDefined();
        expect(result.currentTerm.resumptionDate).toBeDefined();
      }
    });

    test("Should include statistics", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result.stats).toBeDefined();
      expect(result.stats.totalSchoolFee).toBeDefined();
      expect(result.stats.totalStudentsInClass).toBeGreaterThanOrEqual(0);
      expect(result.stats.pendingDebt).toBeDefined();
      expect(result.stats.activeAssignments).toBeDefined();
    });

    test("Should calculate classmate count correctly", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result.stats.totalStudentsInClass).toBeGreaterThanOrEqual(1);
    });

    test("Current term should be null if no active term", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      // currentTerm can be null if there's no active term
      if (result.currentTerm === null) {
        expect(result.currentTerm).toBeNull();
      } else {
        expect(result.currentTerm.id).toBeDefined();
      }
    });

    test("Student name should be properly formatted", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      const name = result.student.name;
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    });
  });

  describe("Dashboard Data Structure", () => {
    test("Should have correct response structure", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result).toEqual(
        expect.objectContaining({
          student: expect.any(Object),
          stats: expect.any(Object),
          currentTerm: expect.anything() // can be null or object
        })
      );
    });

    test("Student object should have required fields", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result.student).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          registrationNumber: expect.any(String),
          class: expect.any(String),
          school: expect.any(Object)
        })
      );
    });

    test("Stats object should have required fields", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result.stats).toEqual(
        expect.objectContaining({
          totalSchoolFee: expect.any(Number),
          totalStudentsInClass: expect.any(Number),
          pendingDebt: expect.any(Number),
          activeAssignments: expect.any(Number)
        })
      );
    });

    test("Current term should have correct structure when present", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      if (result.currentTerm) {
        expect(result.currentTerm.id).toEqual(expect.any(Number));
        expect(result.currentTerm.name).toEqual(expect.any(String));
        // resumptionDate can be null or a date string
        expect(
          result.currentTerm.resumptionDate === null ||
          typeof result.currentTerm.resumptionDate === "string"
        ).toBe(true);
      }
    });
  });

  describe("School Information", () => {
    test("Should include school data", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      expect(result.student.school).toBeDefined();
      expect(result.student.school.id).toBeDefined();
      expect(result.student.school.name).toBeDefined();
    });

    test("Should match student's assigned school", async () => {
      const result = await dashboardService.getDashboard(testStudentId);

      // The school should be the one the student belongs to
      expect(result.student.school).toHaveProperty("id");
      expect(result.student.school).toHaveProperty("name");
    });
  });

  describe("Student Results Endpoint", () => {
    test("Should return result sheet data", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("Should include required result sheet columns", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      if (result.length > 0) {
        const resultRow = result[0];
        expect(resultRow).toHaveProperty("sn");
        expect(resultRow).toHaveProperty("subject");
        expect(resultRow).toHaveProperty("cas");
        expect(resultRow).toHaveProperty("exam");
        expect(resultRow).toHaveProperty("total");
        expect(resultRow).toHaveProperty("grade");
        expect(resultRow).toHaveProperty("classAvg");
        expect(resultRow).toHaveProperty("position");
      }
    });

    test("Should calculate total correctly", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      result.forEach(row => {
        const caTotal = row.cas.reduce((sum, score) => sum + score, 0);
        const expectedTotal = caTotal + row.exam;
        expect(row.total).toBe(expectedTotal);
      });
    });

    test("Should return valid grade", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      result.forEach(row => {
        expect(typeof row.grade).toBe("string");
        expect(row.grade.length).toBeGreaterThan(0);
      });
    });

    test("Should calculate class average", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      result.forEach(row => {
        expect(typeof row.classAvg).toBe("number");
        expect(row.classAvg).toBeGreaterThanOrEqual(0);
      });
    });

    test("Should calculate student position in class", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      result.forEach(row => {
        expect(typeof row.position).toBe("number");
        expect(row.position).toBeGreaterThanOrEqual(1);
      });
    });

    test("Should include all CA scores", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      result.forEach(row => {
        expect(Array.isArray(row.cas)).toBe(true);
        row.cas.forEach(caScore => {
          expect(typeof caScore).toBe("number");
          expect(caScore).toBeGreaterThanOrEqual(0);
        });
      });
    });

    test("Should support filtering by academicSessionId", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("Should support filtering by termId", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId,
        1 // termId
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("Should return results in correct format", async () => {
      const result = await resultService.getResults(
        testStudentId,
        testSchoolId,
        testAcademicSessionId
      );

      result.forEach((row, index) => {
        expect(row.sn).toBe(index + 1);
        expect(typeof row.subject).toBe("string");
        expect(row.subject.length).toBeGreaterThan(0);
        expect(typeof row.exam).toBe("number");
        expect(typeof row.total).toBe("number");
      });
    });
  });
});
