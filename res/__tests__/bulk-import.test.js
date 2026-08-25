// The validator imports the shared Prisma singleton at module load. Mocked so
// these tests exercise the import rules without touching a database.
jest.mock("../util/prisma", () => ({
  class: { findMany: jest.fn() },
  campus: { findMany: jest.fn() },
  student: { findMany: jest.fn(), count: jest.fn() },
  staff: { findMany: jest.fn() },
  school: { findUnique: jest.fn() },
  academicSession: { findFirst: jest.fn() },
  schoolSubscription: { findFirst: jest.fn() },
}));

const xlsx = require("xlsx");
const prisma = require("../util/prisma");
const DataMappingService = require("../Services/DataMappingService");
const DocumentExtractionService = require("../Services/DocumentExtractionService");
const BulkImportValidator = require("../Services/BulkImportValidator");
const BulkImportImporter = require("../Services/BulkImportImporter");
const { buildColumns, columnKeys, emptyRow } = require("../Services/bulkImport/columns");

/** A reference set standing in for one school's classes, campuses and people. */
function studentReference(overrides = {}) {
  return {
    entity: "students",
    schoolId: 1,
    classes: [
      { id: 1, name: "JSS 1", classGroups: [{ id: 10, name: "Gold" }, { id: 11, name: "Silver" }] },
      { id: 2, name: "JSS 2", classGroups: [] },
    ],
    campuses: [{ id: 5, name: "Main Campus" }],
    groupNames: ["Gold", "Silver"],
    existingStaffEmails: new Set(),
    existingStudentKeys: new Set(),
    ...overrides,
  };
}

function staffReference(overrides = {}) {
  return {
    entity: "staff",
    schoolId: 1,
    classes: [],
    campuses: [{ id: 5, name: "Main Campus" }],
    groupNames: [],
    existingStaffEmails: new Set(),
    existingStudentKeys: new Set(),
    ...overrides,
  };
}

/** A complete, valid student row — tests override just the field under test. */
function studentRow(overrides = {}) {
  return {
    recordId: "row_2",
    rowNumber: 2,
    data: {
      firstName: "Mary",
      lastName: "Doe",
      gender: "Female",
      dob: "2012-04-09",
      className: "JSS 1",
      groupName: "",
      campusName: "",
      guardianName: "Jane Doe",
      parentPhone: "08012345678",
      email: "",
      ...overrides,
    },
  };
}

function staffRow(overrides = {}) {
  return {
    recordId: "row_2",
    rowNumber: 2,
    data: {
      firstName: "Peter",
      lastName: "Obi",
      gender: "Male",
      email: "peter@school.com",
      duty: "Teacher",
      phone: "08012345678",
      address: "12 Lagos Road",
      nextOfKin: "Ada Obi",
      dateEmployed: "2023-09-01",
      campusName: "",
      ...overrides,
    },
  };
}

const fieldsOf = (issues) => issues.map((issue) => issue.field);

describe("bulk import — column contract", () => {
  it("gives every entity a flat all-string row template", () => {
    for (const entity of ["students", "staff"]) {
      const row = emptyRow(entity);
      expect(Object.keys(row)).toEqual(columnKeys(entity));
      expect(Object.values(row).every((v) => v === "")).toBe(true);
    }
  });

  it("fills class, group and campus dropdowns from the school's own data", () => {
    const columns = buildColumns("students", studentReference());
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]));

    expect(byKey.className.options).toEqual(["JSS 1", "JSS 2"]);
    expect(byKey.groupName.options).toEqual(["Gold", "Silver"]);
    expect(byKey.campusName.options).toEqual(["Main Campus"]);
    expect(byKey.gender.options).toEqual(["Male", "Female", "Other"]);
  });

  it("does not mutate the shared column definitions between calls", () => {
    buildColumns("students", studentReference());
    const fresh = buildColumns("students", {});
    expect(fresh.find((c) => c.key === "className").options).toEqual([]);
  });
});

describe("DataMappingService", () => {
  it("maps the header spellings schools actually use", () => {
    const { data } = DataMappingService.buildRow(
      {
        "First Name": "John",
        Surname: "Doe",
        "D.O.B": "2010-01-01",
        "class name": "JSS 1",
        "Parent's Phone Number": "0800 000 0000",
        Sex: "M",
      },
      "students"
    );

    expect(data.firstName).toBe("John");
    expect(data.lastName).toBe("Doe");
    expect(data.dob).toBe("2010-01-01");
    expect(data.className).toBe("JSS 1");
    expect(data.parentPhone).toBe("08000000000");
    expect(data.gender).toBe("Male");
  });

  it("splits a single Name column into first and last name", () => {
    const { data } = DataMappingService.buildRow({ "Full Name": "Mary Jane Doe" }, "students");
    expect(data.firstName).toBe("Mary");
    expect(data.lastName).toBe("Doe");
  });

  it("prefers explicit first/last columns over a combined Name column", () => {
    const { data } = DataMappingService.buildRow(
      { Name: "Ignore Me", "First Name": "Mary", Surname: "Doe" },
      "students"
    );
    expect(data.firstName).toBe("Mary");
    expect(data.lastName).toBe("Doe");
  });

  it("always returns every column key as a string, never null or nested", () => {
    const { data } = DataMappingService.buildRow({ "First Name": null, Unknown: { a: 1 } }, "students");

    expect(Object.keys(data).sort()).toEqual(columnKeys("students").sort());
    expect(Object.values(data).every((v) => typeof v === "string")).toBe(true);
  });

  it("drops columns that mean nothing to us instead of inventing fields", () => {
    const { data } = DataMappingService.buildRow({ "Favourite Colour": "Blue" }, "students");
    expect(data).not.toHaveProperty("Favourite Colour");
  });

  describe("date normalisation", () => {
    it.each([
      ["2012-04-09", "2012-04-09"],
      ["09/04/2012", "2012-04-09"], // day-first
      ["25/12/2011", "2011-12-25"], // unambiguously day-first
      ["9 Apr 2012", "2012-04-09"],
      ["Apr 9, 2012", "2012-04-09"],
      ["09-04-2012", "2012-04-09"],
    ])("reads %s as %s", (input, expected) => {
      expect(DataMappingService.normalizeDate(input).value).toBe(expected);
    });

    it("flags slash dates that could be read either way round", () => {
      expect(DataMappingService.normalizeDate("09/04/2012").ambiguous).toBe(true);
      expect(DataMappingService.normalizeDate("25/12/2011").ambiguous).toBe(false);
    });

    it("rejects impossible dates rather than rolling them over", () => {
      // Date(2010, 1, 31) would silently become 3 March without the check.
      expect(DataMappingService.normalizeDate("31/02/2010").value).toBe("");
      expect(DataMappingService.normalizeDate("not a date").value).toBe("");
    });

    it("keeps the raw text on the row when a date cannot be parsed", () => {
      const { data } = DataMappingService.buildRow({ DOB: "sometime in 2010" }, "students");
      expect(data.dob).toBe("sometime in 2010");
    });
  });

  it("leaves an unrecognised gender untouched so the admin sees their own value", () => {
    expect(DataMappingService.normalizeGender("Femle")).toBe("Femle");
    expect(DataMappingService.normalizeGender("f")).toBe("Female");
    expect(DataMappingService.normalizeGender("MALE")).toBe("Male");
  });
});

describe("DocumentExtractionService", () => {
  const sheetBuffer = (rows) => {
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), "Sheet1");
    return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  };

  it("extracts rows from a spreadsheet", async () => {
    const buffer = sheetBuffer([
      ["First Name", "Surname", "Gender", "DOB", "Class"],
      ["John", "Smith", "M", "2010-01-01", "JSS 1"],
    ]);

    const rows = await DocumentExtractionService.extract({
      buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: "students.xlsx",
      entity: "students",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].rowNumber).toBe(2);
    expect(DataMappingService.buildRow(rows[0].raw, "students").data.firstName).toBe("John");
  });

  it("finds the header row under title rows, and numbers rows as the file does", async () => {
    const buffer = sheetBuffer([
      ["ECOLEX MODEL COLLEGE"], // title
      [], // spacer
      ["First Name", "Surname", "Class"], // real header, sheet row 3
      ["Mary", "Doe", "JSS 1"], // sheet row 4
    ]);

    const rows = await DocumentExtractionService.extract({
      buffer,
      mimeType: "application/vnd.ms-excel",
      fileName: "students.xls",
      entity: "students",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].rowNumber).toBe(4);
  });

  it("skips blank spacer rows", async () => {
    const buffer = sheetBuffer([
      ["First Name", "Surname", "Class"],
      ["Mary", "Doe", "JSS 1"],
      ["", "", ""],
      ["John", "Smith", "JSS 2"],
    ]);

    const rows = await DocumentExtractionService.extract({
      buffer,
      mimeType: "text/csv",
      fileName: "students.csv",
      entity: "students",
    });

    expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it("explains itself when the headings cannot be recognised", async () => {
    const buffer = sheetBuffer([
      ["Col A", "Col B"],
      ["x", "y"],
    ]);

    await expect(
      DocumentExtractionService.extract({
        buffer,
        mimeType: "text/csv",
        fileName: "mystery.csv",
        entity: "students",
      })
    ).rejects.toThrow(/column headings .* could not be recognised/i);
  });

  it("rejects file types it cannot read", async () => {
    await expect(
      DocumentExtractionService.extract({
        buffer: Buffer.from("hello"),
        mimeType: "application/zip",
        fileName: "students.zip",
        entity: "students",
      })
    ).rejects.toThrow(/not supported/i);
  });

  it("builds a matrix from whitespace-aligned OCR text", () => {
    const matrix = DocumentExtractionService.matrixFromText(
      "First Name   Surname   Class\nMary         Doe       JSS 1"
    );
    expect(matrix[0]).toEqual(["First Name", "Surname", "Class"]);
    expect(matrix[1]).toEqual(["Mary", "Doe", "JSS 1"]);
  });
});

describe("BulkImportValidator — the contract the frontend relies on", () => {
  it("keeps isValid exactly equal to errors.length === 0", () => {
    const records = BulkImportValidator.validateAll(
      [
        studentRow(),
        studentRow({ gender: "Femle" }),
        studentRow({ firstName: "" }),
        studentRow({ className: "JSS 9" }),
      ].map((row, index) => ({ ...row, recordId: `row_${index + 2}`, rowNumber: index + 2 })),
      studentReference()
    );

    for (const record of records) {
      expect(record.isValid).toBe(record.errors.length === 0);
    }
    expect(records[0].isValid).toBe(true);
    expect(records.slice(1).every((r) => !r.isValid)).toBe(true);
  });

  it("only ever points errors and warnings at keys that exist in data", () => {
    const records = BulkImportValidator.validateAll(
      [
        studentRow({ gender: "Femle", className: "Nope", groupName: "Bronze", email: "bad", dob: "x" }),
        studentRow({ firstName: "", lastName: "", guardianName: "", parentPhone: "" }),
      ].map((row, index) => ({ ...row, recordId: `row_${index + 2}`, rowNumber: index + 2 })),
      studentReference()
    );

    for (const record of records) {
      const keys = Object.keys(record.data);
      for (const issue of [...record.errors, ...record.warnings]) {
        expect(keys).toContain(issue.field);
        expect(typeof issue.message).toBe("string");
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("returns data as a flat string map with no nulls", () => {
    const [record] = BulkImportValidator.validateAll(
      [{ recordId: "row_2", rowNumber: 2, data: { firstName: "Mary", gender: null, extra: { a: 1 } } }],
      studentReference()
    );

    expect(Object.keys(record.data).sort()).toEqual(columnKeys("students").sort());
    expect(Object.values(record.data).every((v) => typeof v === "string")).toBe(true);
  });
});

describe("BulkImportValidator — student rules", () => {
  const validate = (overrides, reference = studentReference()) =>
    BulkImportValidator.validateAll([studentRow(overrides)], reference)[0];

  it("accepts a complete row", () => {
    const record = validate({});
    expect(record.errors).toEqual([]);
    expect(record.isValid).toBe(true);
  });

  it("requires only first name, last name and class", () => {
    const record = validate({ firstName: "", lastName: "", gender: "", dob: "", className: "" });
    expect(fieldsOf(record.errors)).toEqual(
      expect.arrayContaining(["firstName", "lastName", "className"])
    );
    // Gender and date of birth are optional so schools whose registers lay
    // these out differently — or leave them out entirely — can still import.
    expect(fieldsOf(record.errors)).not.toEqual(expect.arrayContaining(["gender", "dob"]));
  });

  it("accepts a row with no gender or date of birth", () => {
    const record = validate({ gender: "", dob: "" });
    expect(record.errors).toEqual([]);
    expect(record.isValid).toBe(true);
  });

  it("rejects a gender outside the allowed options", () => {
    const record = validate({ gender: "Femle" });
    expect(record.errors).toContainEqual(
      expect.objectContaining({ field: "gender", message: expect.stringContaining("Femle") })
    );
  });

  it("folds a correctly spelled gender to the canonical casing", () => {
    expect(validate({ gender: "female" }).data.gender).toBe("Female");
  });

  it("rejects a class the school does not have", () => {
    const record = validate({ className: "JSS 9" });
    expect(record.errors).toContainEqual(
      expect.objectContaining({ field: "className", message: expect.stringContaining("JSS 9") })
    );
  });

  it("snaps a matched class to the school's own spelling", () => {
    expect(validate({ className: "jss 1" }).data.className).toBe("JSS 1");
  });

  it("rejects a group that belongs to a different class", () => {
    const record = validate({ className: "JSS 2", groupName: "Gold" });
    expect(fieldsOf(record.errors)).toContain("groupName");
  });

  it("accepts a group that belongs to the row's class", () => {
    expect(validate({ groupName: "Gold" }).errors).toEqual([]);
  });

  it("rejects an unparseable date of birth", () => {
    expect(fieldsOf(validate({ dob: "sometime in 2010" }).errors)).toContain("dob");
  });

  it("warns rather than blocks on an unusual age", () => {
    const record = validate({ dob: "1975-01-01" });
    expect(record.isValid).toBe(true);
    expect(fieldsOf(record.warnings)).toContain("dob");
  });

  it("warns when there is no way to contact the student's home", () => {
    const record = validate({ guardianName: "", parentPhone: "" });
    expect(record.isValid).toBe(true);
    expect(fieldsOf(record.warnings)).toContain("parentPhone");
  });

  it("warns, but does not block, on a student already on file", () => {
    const reference = studentReference({
      existingStudentKeys: new Set([BulkImportValidator.studentKey("Mary", "Doe", "2012-04-09")]),
    });
    const record = validate({}, reference);

    expect(record.isDuplicate).toBe(true);
    expect(record.isValid).toBe(true); // duplicates never block a student import
  });

  it("flags the second of two identical rows, leaving the first clean", () => {
    const records = BulkImportValidator.validateAll(
      [
        { ...studentRow(), recordId: "row_2", rowNumber: 2 },
        { ...studentRow(), recordId: "row_3", rowNumber: 3 },
      ],
      studentReference()
    );

    expect(records[0].isDuplicate).toBe(false);
    expect(records[1].isDuplicate).toBe(true);
  });
});

describe("BulkImportValidator — staff rules", () => {
  const validate = (overrides, reference = staffReference()) =>
    BulkImportValidator.validateAll([staffRow(overrides)], reference)[0];

  it("accepts a complete row", () => {
    expect(validate({}).errors).toEqual([]);
  });

  it("requires only first name, last name and duty", () => {
    const record = validate({ firstName: "", lastName: "", email: "", duty: "" });
    expect(fieldsOf(record.errors)).toEqual(
      expect.arrayContaining(["firstName", "lastName", "duty"])
    );
    // Email is optional — staff log in with their registration number, not
    // email, so a blank one doesn't lock anyone out of anything.
    expect(fieldsOf(record.errors)).not.toContain("email");
  });

  it("accepts a row with no email", () => {
    const record = validate({ email: "" });
    expect(record.errors).toEqual([]);
    expect(record.isValid).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(fieldsOf(validate({ email: "peter@school" }).errors)).toContain("email");
  });

  it("BLOCKS a staff email already in the database", () => {
    // Staff.email is unique in the database, so this row cannot be inserted —
    // treating it as a warning would let the admin confirm a doomed import.
    const record = validate({}, staffReference({ existingStaffEmails: new Set(["peter@school.com"]) }));

    expect(record.isDuplicate).toBe(true);
    expect(record.isValid).toBe(false);
    expect(fieldsOf(record.errors)).toContain("email");
  });

  it("blocks the second row reusing an email from earlier in the same file", () => {
    const records = BulkImportValidator.validateAll(
      [
        { ...staffRow(), recordId: "row_2", rowNumber: 2 },
        { ...staffRow(), recordId: "row_3", rowNumber: 3 },
      ],
      staffReference()
    );

    expect(records[0].isValid).toBe(true);
    expect(records[1].isValid).toBe(false);
    expect(records[1].isDuplicate).toBe(true);
  });

  it("warns, without blocking, on a phone number that looks incomplete", () => {
    const record = validate({ phone: "123" });
    expect(record.isValid).toBe(true);
    expect(fieldsOf(record.warnings)).toContain("phone");
  });
});

describe("BulkImportValidator — summary and reference loading", () => {
  it("counts rows the way the summary strip reports them", () => {
    const records = [
      { isValid: true, isDuplicate: false, warnings: [] },
      { isValid: true, isDuplicate: true, warnings: [{ field: "firstName", message: "dupe" }] },
      { isValid: false, isDuplicate: false, warnings: [] },
    ];

    expect(BulkImportValidator.summarize(records)).toEqual({
      total: 3,
      valid: 2,
      errors: 1,
      warnings: 1,
      duplicates: 1,
    });
  });

  it("checks staff emails across the whole table, not just this school", async () => {
    prisma.campus.findMany.mockResolvedValue([]);
    prisma.staff.findMany.mockResolvedValue([{ email: "Taken@School.com" }]);

    const reference = await BulkImportValidator.loadReference(1, "staff");

    // Scoping to schoolId would miss the clash and fail at insert time instead.
    expect(prisma.staff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { NOT: { email: null } } })
    );
    expect(reference.existingStaffEmails.has("taken@school.com")).toBe(true);
  });
});

describe("stray whitespace in stored names", () => {
  // Some class and campus names in the database carry trailing spaces. Left
  // untrimmed they make a cell value flip between the padded and unpadded form
  // on every revalidation, and make the select render as nothing selected.
  const padded = () =>
    studentReference({
      classes: [{ id: 1, name: "JSS 1 ", classGroups: [{ id: 10, name: " Gold" }] }],
      campuses: [{ id: 5, name: "Great Campus " }],
      groupNames: [" Gold"],
    });

  it("writes trimmed names back into the row", () => {
    const [record] = BulkImportValidator.validateAll(
      [studentRow({ className: "JSS 1", groupName: "Gold", campusName: "Great Campus" })],
      padded()
    );

    expect(record.errors).toEqual([]);
    expect(record.data.className).toBe("JSS 1");
    expect(record.data.groupName).toBe("Gold");
    expect(record.data.campusName).toBe("Great Campus");
  });

  it("offers trimmed dropdown options, so they match the cell values", () => {
    const columns = buildColumns("students", padded());
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]));

    expect(byKey.className.options).toEqual(["JSS 1"]);
    expect(byKey.campusName.options).toEqual(["Great Campus"]);
    expect(byKey.groupName.options).toEqual(["Gold"]);
  });

  it("settles after one pass instead of flip-flopping on revalidation", () => {
    const reference = padded();
    const first = BulkImportValidator.validateAll([studentRow({ campusName: "Great Campus" })], reference)[0];
    const second = BulkImportValidator.validateAll(
      [{ recordId: "row_2", rowNumber: 2, data: first.data }],
      reference
    )[0];

    expect(second.data).toEqual(first.data);
  });
});

describe("BulkImportImporter — whole-import preconditions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.school.findUnique.mockResolvedValue({ prefix: "ABC" });
    prisma.schoolSubscription.findFirst.mockResolvedValue(null); // no plan cap
    prisma.student.count.mockResolvedValue(0);
  });

  it("refuses the whole student import when there is no active session", async () => {
    prisma.academicSession.findFirst.mockResolvedValue(null);

    const blocker = await BulkImportImporter.checkPreconditions({
      schoolId: 1,
      entity: "students",
      count: 3,
    });

    // One clear message, rather than the same failure repeated on every row.
    expect(blocker).toMatchObject({ status: 400 });
    expect(blocker.message).toMatch(/no active academic session/i);
  });

  it("lets a student import through when a session is active", async () => {
    prisma.academicSession.findFirst.mockResolvedValue({ id: 2 });

    await expect(
      BulkImportImporter.checkPreconditions({ schoolId: 1, entity: "students", count: 3 })
    ).resolves.toBeNull();
  });

  it("does not require a session for staff", async () => {
    prisma.academicSession.findFirst.mockResolvedValue(null);

    await expect(
      BulkImportImporter.checkPreconditions({ schoolId: 1, entity: "staff", count: 3 })
    ).resolves.toBeNull();
    expect(prisma.academicSession.findFirst).not.toHaveBeenCalled();
  });

  it("refuses an import that would run past the plan's student cap", async () => {
    prisma.academicSession.findFirst.mockResolvedValue({ id: 2 });
    prisma.schoolSubscription.findFirst.mockResolvedValue({
      id: 1,
      status: "active",
      billingPlan: { name: "Starter", maxStudents: 100 },
    });
    prisma.student.count.mockResolvedValue(98);

    const blocker = await BulkImportImporter.checkPreconditions({
      schoolId: 1,
      entity: "students",
      count: 5,
    });

    expect(blocker).toMatchObject({ status: 403 });
    expect(blocker.message).toMatch(/2 slot\(s\) left/);
  });

  it("reports a missing school rather than importing into nothing", async () => {
    prisma.school.findUnique.mockResolvedValue(null);

    await expect(
      BulkImportImporter.checkPreconditions({ schoolId: 999, entity: "staff", count: 1 })
    ).resolves.toMatchObject({ status: 404 });
  });
});

describe("BulkImportImporter", () => {
  it("recognises a unique-constraint clash on a named field", () => {
    const error = { code: "P2002", meta: { target: ["email"] } };
    expect(BulkImportImporter.isUniqueViolationOn(error, "email")).toBe(true);
    expect(BulkImportImporter.isUniqueViolationOn(error, "registrationNumber")).toBe(false);
  });

  it("turns database errors into reasons an admin can act on", () => {
    expect(BulkImportImporter.readableReason({ code: "P2002", meta: { target: ["email"] } })).toMatch(
      /email already exists/i
    );
    // A stack-trace-shaped message is replaced rather than shown verbatim.
    expect(BulkImportImporter.readableReason(new Error("x\n  at foo (bar.js:1)"))).toMatch(
      /could not be saved/i
    );
  });
});
