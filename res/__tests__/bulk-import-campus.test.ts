// A student imported from a spreadsheet row that named no campus was saved with
// none at all, and opening that student then crashed the admin's student view.
// A school's classes are created once per campus, so a class name can also exist
// in several campuses, and taking the first match put students in whichever
// campus's class happened to come first. The importer now resolves the class and
// the campus together.
jest.mock("../util/prisma", () => ({
  school: { findUnique: jest.fn() },
  academicSession: { findFirst: jest.fn() },
  class: { findMany: jest.fn() },
  campus: { findMany: jest.fn() },
  student: { create: jest.fn() },
}));
jest.mock("../util/studentFeeSync", () => ({ syncStudentFeeInvoices: jest.fn() }));
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn() }));
jest.mock("../Models/generateUniqueIdentifier", () => ({
  generateUniqueIdentifier: jest.fn().mockReturnValue("ABC-0001-STD"),
}));

import prisma from "../util/prisma";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BulkImportImporter = require("../Services/BulkImportImporter");
const { resolveClassAndCampus, importStudents } = BulkImportImporter as {
  resolveClassAndCampus: (classes: any[], campuses: any[], data: any) => { classRecord: any; campusId: number | null };
  importStudents: (input: any) => Promise<any[]>;
};

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const MAIN = { id: 1, name: "Main Campus" };
const NORTH = { id: 2, name: "North Campus" };
const campuses = [MAIN, NORTH];

const ss1Main = { id: 10, name: "SS 1", campusId: 1, classGroups: [] };
const ss1North = { id: 11, name: "SS 1", campusId: 2, classGroups: [] };
const ss2Main = { id: 12, name: "SS 2", campusId: 1, classGroups: [] };

describe("resolveClassAndCampus", () => {
  it("gives a student the campus of their class when the row names none", () => {
    const result = resolveClassAndCampus([ss2Main], campuses, { className: "SS 2" });

    expect(result.classRecord.id).toBe(12);
    expect(result.campusId).toBe(1);
  });

  it("picks the class inside the campus the row names, when the name repeats", () => {
    const result = resolveClassAndCampus([ss1Main, ss1North], campuses, { className: "SS 1", campusName: "North Campus" });

    expect(result.classRecord.id).toBe(11);
    expect(result.campusId).toBe(2);
  });

  it("refuses a class name that exists in several campuses when the row says which", () => {
    // Guessing would put children in the wrong campus.
    expect(() => resolveClassAndCampus([ss1Main, ss1North], campuses, { className: "SS 1" })).toThrow(
      /more than one campus/i
    );
  });

  it("refuses a class that is not in the campus the row names", () => {
    expect(() => resolveClassAndCampus([ss2Main], campuses, { className: "SS 2", campusName: "North Campus" })).toThrow(
      'There is no class called "SS 2" in campus "North Campus"'
    );
  });

  it("matches names regardless of case and stray spaces", () => {
    const result = resolveClassAndCampus([ss2Main], campuses, { className: "  ss 2 " });

    expect(result.classRecord.id).toBe(12);
  });

  it("accepts a class with no campus of its own when a campus is named", () => {
    const schoolWide = { id: 13, name: "SS 3", campusId: null, classGroups: [] };

    const result = resolveClassAndCampus([schoolWide], campuses, { className: "SS 3", campusName: "Main Campus" });

    expect(result.classRecord.id).toBe(13);
    expect(result.campusId).toBe(1);
  });

  it("leaves the campus empty only when neither the row nor the class has one", () => {
    const schoolWide = { id: 13, name: "SS 3", campusId: null, classGroups: [] };

    expect(resolveClassAndCampus([schoolWide], campuses, { className: "SS 3" }).campusId).toBeNull();
  });

  it("rejects an unknown campus and an unknown class", () => {
    expect(() => resolveClassAndCampus([ss2Main], campuses, { className: "SS 2", campusName: "Moon" })).toThrow(
      'There is no campus called "Moon" in your school'
    );
    expect(() => resolveClassAndCampus([ss2Main], campuses, { className: "JSS 9" })).toThrow(
      'There is no class called "JSS 9" in your school'
    );
  });
});

describe("importStudents — the campus a created student carries", () => {
  const record = (data: Record<string, unknown>) => ({
    id: 1,
    rowNumber: 2,
    data: { firstName: "Ada", lastName: "Obi", className: "SS 2", ...data },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    db.school.findUnique.mockResolvedValue({ prefix: "ABC" });
    db.academicSession.findFirst.mockResolvedValue({ id: 2 });
    db.class.findMany.mockResolvedValue([ss1Main, ss1North, ss2Main]);
    db.campus.findMany.mockResolvedValue(campuses);
    db.student.create.mockResolvedValue({ id: 99 });
  });

  it("saves a student whose row has no campus with their class's campus", async () => {
    const [result] = await importStudents({ schoolId: 5, records: [record({})] });

    expect(result.ok).toBe(true);
    expect(db.student.create.mock.calls[0][0].data).toMatchObject({ classId: 12, campusId: 1 });
  });

  it("saves a student in the class of the campus the row names", async () => {
    await importStudents({ schoolId: 5, records: [record({ className: "SS 1", campusName: "North Campus" })] });

    expect(db.student.create.mock.calls[0][0].data).toMatchObject({ classId: 11, campusId: 2 });
  });

  it("fails just the ambiguous row, and still imports the rest", async () => {
    const results = await importStudents({
      schoolId: 5,
      records: [record({ className: "SS 1" }), { ...record({}), id: 2, rowNumber: 3 }],
    });

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].reason).toMatch(/more than one campus/i);
    expect(results[1]).toMatchObject({ ok: true });
    expect(db.student.create).toHaveBeenCalledTimes(1);
  });
});
