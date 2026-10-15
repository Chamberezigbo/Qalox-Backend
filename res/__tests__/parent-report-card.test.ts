// A parent may only see the report card of their own child, and it is built for
// that child's school, not anything the request names.
const mockPrisma: any = { student: { findFirst: jest.fn() } };
jest.mock("../util/prisma", () => mockPrisma);
const getReportCard = jest.fn().mockResolvedValue({ subjects: [] });
const getSessions = jest.fn().mockResolvedValue([]);
jest.mock("../Services/student/StudentResultService", () => ({
  StudentResultService: jest.fn().mockImplementation(() => ({ getReportCard, getSessions })),
}));
jest.mock("../controller/public/publicController", () => ({ schoolMediaUrl: jest.fn() }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { ParentService } = require("../Services/ParentService");

describe("parent report card", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds the card for the child's own school", async () => {
    mockPrisma.student.findFirst.mockResolvedValue({ id: 5, schoolId: 7, parentId: 2 });
    await new ParentService().getChildReportCard(2, 5, 3, 9);

    expect(mockPrisma.student.findFirst).toHaveBeenCalledWith({ where: { id: 5, parentId: 2 } });
    expect(getReportCard).toHaveBeenCalledWith(5, 7, 3, 9);
  });

  it("refuses a child who is not theirs, and builds nothing", async () => {
    mockPrisma.student.findFirst.mockResolvedValue(null);

    await expect(new ParentService().getChildReportCard(2, 99)).rejects.toMatchObject({ statusCode: 404 });
    await expect(new ParentService().getChildReportCardSessions(2, 99)).rejects.toMatchObject({ statusCode: 404 });
    expect(getReportCard).not.toHaveBeenCalled();
    expect(getSessions).not.toHaveBeenCalled();
  });

  it("lists the sessions of the child's school", async () => {
    mockPrisma.student.findFirst.mockResolvedValue({ id: 5, schoolId: 7, parentId: 2 });
    await new ParentService().getChildReportCardSessions(2, 5);
    expect(getSessions).toHaveBeenCalledWith(7);
  });
});

export {};
