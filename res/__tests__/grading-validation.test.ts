import { GradingService } from "../Services/teacher/GradingService";

jest.mock("../util/prisma", () => ({ __esModule: true, default: {} }));

const validate = (grades: any[]) => (new GradingService() as any).validateGrades(grades);
const g = (grade: string, min: number, max: number) => ({ grade, min, max, remark: "" });

describe("GradingService.validateGrades", () => {
  it("accepts adjacent ranges", () => {
    expect(() => validate([g("F", 0, 39), g("A", 40, 100)])).not.toThrow();
  });

  it("names both clashing grades and their ranges", () => {
    expect(() => validate([g("D", 40, 49), g("E", 45, 60), g("F", 0, 39)])).toThrow(
      "Grading ranges must not overlap: D (40-49) and E (45-60)"
    );
  });

  it("still rejects a back-to-front range", () => {
    expect(() => validate([g("A", 90, 10)])).toThrow("Invalid range for grade A");
  });
});
