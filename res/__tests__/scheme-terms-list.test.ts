// A sub-admin allowed to upload schemes could not see which terms exist, because
// the full terms route is head-admin only. This read-only list is what the
// upload form's term picker uses.
const mockPrisma: any = { academicTerm: { findMany: jest.fn() } };
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../Services/SchemeOfWorkService", () => ({}));
jest.mock("../util/getAiCreditsAllowanceForSchool", () => ({ getAiCreditsStatusForSchool: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listTermsForSchemes } = require("../controller/admin/SchemeOfWorkController");

const term = (id: number, name: string, isActive: boolean, sessionActive: boolean) => ({
  id, name, isActive, createdAt: new Date(),
  session: { id: sessionActive ? 2 : 1, name: sessionActive ? "2026/2027" : "2025/2026", isActive: sessionActive },
});

describe("listTermsForSchemes", () => {
  it("lists only this school's terms, current term first, then the rest of the current session", async () => {
    mockPrisma.academicTerm.findMany.mockResolvedValue([
      term(1, "Third Term", false, false),
      term(2, "Second Term", false, true),
      term(3, "First Term", true, true),
    ]);
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await listTermsForSchemes({ schoolId: 7 }, res, jest.fn());

    expect(mockPrisma.academicTerm.findMany.mock.calls[0][0].where).toEqual({ schoolId: 7 });
    const names = res.json.mock.calls[0][0].data.map((t: any) => t.name);
    expect(names).toEqual(["First Term", "Second Term", "Third Term"]);
    expect(res.json.mock.calls[0][0].data[0]).toMatchObject({ isActive: true, sessionName: "2026/2027" });
  });
});

export {};
