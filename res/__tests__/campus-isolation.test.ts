// Campus isolation: records with no campus belong to the owner, new records of a
// restricted admin always get one of their campuses, a campus has its own CA template
// and its own branding that falls back to the school's.
/* eslint-disable @typescript-eslint/no-var-requires */
const mockPrisma: any = {
  school: { findUnique: jest.fn() },
  campus: { findFirst: jest.fn(), count: jest.fn() },
  staff: { count: jest.fn(), updateMany: jest.fn() },
  class: { count: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  subject: { count: jest.fn(), updateMany: jest.fn() },
  student: { count: jest.fn(), updateMany: jest.fn() },
  cATemplate: { findMany: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../Services/R2Service", () => ({ uploadObject: jest.fn() }));
jest.mock("../config/compress", () => ({ processImageToBuffer: jest.fn(), extractDominantColor: jest.fn() }));
jest.mock("../controller/public/publicController", () => ({ schoolMediaUrl: jest.fn(async (k: string) => k) }));

const scope = require("../util/campusScope");
const { resolveBranding, effectiveCampusId } = require("../util/campusBranding");
const campusC = require("../controller/admin/campusController");
const { AssessmentService } = require("../Services/AssessmentService");

const restricted = (ids: number[]) => ({ schoolId: 7, campusIds: ids });
const owner = () => ({ schoolId: 7, campusIds: null, body: {}, params: {} });

beforeEach(() => jest.resetAllMocks());

describe("campusForNewRecord", () => {
  it("gives a restricted admin the campus they named, if it is theirs", () => {
    expect(scope.campusForNewRecord(restricted([1, 2]), 2)).toBe(2);
    expect(() => scope.campusForNewRecord(restricted([1, 2]), 3)).toThrow(/access/);
  });

  it("defaults to their only campus, and asks when they have several", () => {
    expect(scope.campusForNewRecord(restricted([5]), undefined)).toBe(5);
    expect(() => scope.campusForNewRecord(restricted([1, 2]), undefined)).toThrow(/Choose/);
  });

  it("leaves the owner's choice alone, including none", () => {
    expect(scope.campusForNewRecord(owner(), undefined)).toBeNull();
    expect(scope.campusForNewRecord(owner(), "4")).toBe(4);
  });
});

describe("owner tool for untagged records", () => {
  const call = async (handler: any, req: any) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, res, jest.fn());
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };

  it("counts what has no campus", async () => {
    mockPrisma.staff.count.mockResolvedValue(3);
    mockPrisma.class.count.mockResolvedValue(2);
    mockPrisma.subject.count.mockResolvedValue(0);
    mockPrisma.student.count.mockResolvedValue(5);
    const { body } = await call(campusC.getUntaggedRecords, owner());
    expect(body.data).toEqual({ staff: 3, classes: 2, subjects: 0, students: 5 });
  });

  it("tags only records that have no campus, in this school", async () => {
    mockPrisma.campus.findFirst.mockResolvedValue({ id: 4 });
    mockPrisma.staff.updateMany.mockResolvedValue({ count: 3 });
    const { body } = await call(campusC.assignUntaggedRecords, { ...owner(), params: { campusId: "4" }, body: { types: ["staff"] } });
    expect(mockPrisma.staff.updateMany).toHaveBeenCalledWith({ where: { schoolId: 7, campusId: null }, data: { campusId: 4 } });
    expect(body.data).toEqual({ staff: 3 });
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a campus of another school", async () => {
    mockPrisma.campus.findFirst.mockResolvedValue(null);
    const { status } = await call(campusC.assignUntaggedRecords, { ...owner(), params: { campusId: "4" }, body: { types: ["staff"] } });
    expect(status).toBe(404);
  });
});

describe("campus branding", () => {
  const school = { name: "Oak School", logoUrl: "school-logo", stampUrl: "school-stamp", brandColor: "#111111" };

  it("uses the school's own when there is no campus", async () => {
    mockPrisma.school.findUnique.mockResolvedValue(school);
    expect(await resolveBranding(mockPrisma, { schoolId: 7, campusId: null })).toMatchObject({ name: "Oak School", logoUrl: "school-logo" });
  });

  it("uses the campus's logo, stamp and name when the school has several campuses", async () => {
    mockPrisma.school.findUnique.mockResolvedValue(school);
    mockPrisma.campus.findFirst.mockResolvedValue({ name: "Oak North", logoUrl: "north-logo", stampUrl: null, brandColor: null });
    mockPrisma.campus.count.mockResolvedValue(3);
    expect(await resolveBranding(mockPrisma, { schoolId: 7, campusId: 2 })).toEqual({
      name: "Oak North", logoUrl: "north-logo", stampUrl: "school-stamp", brandColor: "#111111", campusName: "Oak North",
    });
  });

  it("keeps the school's name when it has a single campus", async () => {
    mockPrisma.school.findUnique.mockResolvedValue(school);
    mockPrisma.campus.findFirst.mockResolvedValue({ name: "Main", logoUrl: null, stampUrl: null, brandColor: null });
    mockPrisma.campus.count.mockResolvedValue(1);
    expect((await resolveBranding(mockPrisma, { schoolId: 7, campusId: 2 })).name).toBe("Oak School");
  });

  it("works out a student's campus as their own, else their class's", () => {
    expect(effectiveCampusId({ campusId: 3, class: { campusId: 4 } })).toBe(3);
    expect(effectiveCampusId({ campusId: null, class: { campusId: 4 } })).toBe(4);
    expect(effectiveCampusId({ campusId: null, class: { campusId: null } })).toBeNull();
  });
});

describe("CA templates per campus", () => {
  const service = new AssessmentService();

  it("gives a campus only its own template, and no school-wide one for a restricted admin", async () => {
    mockPrisma.cATemplate.findMany.mockResolvedValue([{ id: 1, name: "CA1", maxScore: 20, isExam: false }]);
    const out = await service.getCATemplates(7, undefined, { campusId: 2, includeSchoolWide: false });
    expect(out.schoolWide).toEqual([]);
    expect(out.campus).toHaveLength(1);
    expect(mockPrisma.cATemplate.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.cATemplate.findMany.mock.calls[0][0].where).toEqual({ schoolId: 7, classId: null, campusId: 2 });
  });

  it("gives the owner the school-wide template, as before", async () => {
    mockPrisma.cATemplate.findMany.mockResolvedValue([]);
    await service.getCATemplates(7, undefined, {});
    expect(mockPrisma.cATemplate.findMany.mock.calls[0][0].where).toEqual({ schoolId: 7, classId: null, campusId: null });
  });
});

export {};
