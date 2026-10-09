// A cell holding two numbers ("0801… / 0809…") was stripped of everything but
// digits, gluing them into one 22-digit number that was saved as the guardian's
// phone. The two numbers are now kept apart, the review screen warns that only
// the first is stored, and the importer saves just that one.
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

/* eslint-disable @typescript-eslint/no-var-requires */
const { buildRow } = require("../Services/DataMappingService");
const BulkImportValidator = require("../Services/BulkImportValidator");
const { importStudents } = require("../Services/BulkImportImporter");
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const TWO = "08012345678 / 08098765432";

describe("a row with two guardian numbers in one cell", () => {
  it("keeps both numbers apart when the file is read", () => {
    const { data } = buildRow({ "Student Name": "Ada Obi", "Parent Phone": "08012345678, 08098765432" }, "students");
    expect(data.parentPhone).toBe(TWO);
  });

  it("warns on the review screen that only the first will be saved, without failing the row", () => {
    const [record] = BulkImportValidator.validateAll(
      [{ recordId: "r1", rowNumber: 2, data: { firstName: "Ada", lastName: "Obi", className: "SS 2", gender: "Female", parentPhone: TWO } }],
      { entity: "students", classes: [{ name: "SS 2", classGroups: [] }], campuses: [], sessions: [] }
    );
    const warning = record.warnings.find((w: any) => w.field === "parentPhone");
    expect(warning.message).toContain("2 numbers");
    expect(warning.message).toContain("08012345678");
    expect(record.errors.map((e: any) => e.field)).not.toContain("parentPhone");
  });

  it("saves only the first number", async () => {
    db.school.findUnique.mockResolvedValue({ prefix: "ABC" });
    db.academicSession.findFirst.mockResolvedValue({ id: 2 });
    db.class.findMany.mockResolvedValue([{ id: 12, name: "SS 2", campusId: 1, classGroups: [] }]);
    db.campus.findMany.mockResolvedValue([{ id: 1, name: "Main" }]);
    db.student.create.mockResolvedValue({ id: 99 });

    await importStudents({
      schoolId: 5,
      records: [{ id: 1, rowNumber: 2, data: { firstName: "Ada", lastName: "Obi", className: "SS 2", parentPhone: TWO } }],
    });

    expect(db.student.create.mock.calls[0][0].data.guardianNumber).toBe("08012345678");
  });
});
