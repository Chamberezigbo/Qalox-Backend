// The student's report card must be built for the logged-in student only.
const getReportCard = jest.fn().mockResolvedValue({ subjects: [] });
jest.mock("../Services/student/StudentResultService", () => ({
  StudentResultService: jest.fn().mockImplementation(() => ({ getReportCard, getSessions: jest.fn() })),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { StudentResultController } = require("../controller/student/StudentResultController");

describe("student report card endpoint", () => {
  beforeEach(() => getReportCard.mockClear());

  it("uses the student and school from the token, never from the request", async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await new StudentResultController().getReportCard(
      { studentId: 5, schoolId: 7, query: { academicSessionId: "3", termId: "9", studentId: "999", schoolId: "888" } },
      res,
      jest.fn()
    );

    expect(getReportCard).toHaveBeenCalledWith(5, 7, 3, 9);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("passes undefined when no session or term is named", async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await new StudentResultController().getReportCard({ studentId: 5, schoolId: 7, query: {} }, res, jest.fn());
    expect(getReportCard).toHaveBeenCalledWith(5, 7, undefined, undefined);
  });
});

export {};
