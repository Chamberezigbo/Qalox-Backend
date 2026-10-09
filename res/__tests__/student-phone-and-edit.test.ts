jest.mock("../util/prisma", () => ({}));
const { normalizePhone, firstPhone } = require("../Services/DataMappingService");
const { buildStudentUpdate } = require("../util/studentUpdate");

describe("normalizePhone — two numbers in one cell", () => {
  it.each([
    ["08012345678 / 08098765432", "08012345678 / 08098765432"],
    ["08012345678, 08098765432", "08012345678 / 08098765432"],
    ["08012345678; 08098765432", "08012345678 / 08098765432"],
    ["08012345678 and 08098765432", "08012345678 / 08098765432"],
    ["08012345678 & 08098765432", "08012345678 / 08098765432"],
    ["08012345678\n08098765432", "08012345678 / 08098765432"],
    ["0801 234 5678 / +234 809 876 5432", "08012345678 / +2348098765432"],
  ])("keeps both numbers apart: %j", (cell, expected) => {
    expect(normalizePhone(cell)).toBe(expected);
  });

  it("never glues two numbers into one", () => {
    expect(normalizePhone("08012345678 / 08098765432")).not.toBe("0801234567808098765432");
  });

  it.each([
    ["0801 234 5678", "08012345678"],
    ["0801-234-5678", "08012345678"],
    ["+234 801 234 5678", "+2348012345678"],
    ["0801,234,5678", "08012345678"], // commas inside ONE number
    ["", ""],
  ])("still cleans a single number: %j", (cell, expected) => {
    expect(normalizePhone(cell)).toBe(expected);
  });

  it("firstPhone gives the one number to store", () => {
    expect(firstPhone("08012345678 / 08098765432")).toBe("08012345678");
    expect(firstPhone("08012345678")).toBe("08012345678");
    expect(firstPhone("")).toBe("");
    expect(firstPhone(undefined)).toBe("");
  });
});

describe("buildStudentUpdate", () => {
  it("turns the blank fields the edit form always sends into nulls, not invalid values", () => {
    const { data, ids, error } = buildStudentUpdate({
      name: "Ada", surname: "Obi", otherNames: "", gender: "Female", email: "", guardianEmail: "",
      guardianNumber: "08012345678", guardianName: "", lifestyle: "", campusId: "", classId: "11",
    });

    expect(error).toBeUndefined();
    expect(data).toMatchObject({ email: null, guardianEmail: null, guardianName: null, lifestyle: null, otherNames: "" });
    expect(data.guardianNumber).toBe("08012345678");
    // A blank campus is "not chosen", never an empty string handed to the database.
    expect(ids).toEqual({ classId: 11 });
  });

  it("only passes known fields, so a request cannot reach schoolId or the registration number", () => {
    const { data } = buildStudentUpdate({ name: "Ada", schoolId: 99, registrationNumber: "X", parentId: 5, id: 1 });
    expect(Object.keys(data)).toEqual(["name"]);
  });

  it("refuses a blank name or surname", () => {
    expect(buildStudentUpdate({ name: "  " }).error).toContain("First name");
    expect(buildStudentUpdate({ surname: "" }).error).toContain("Surname");
  });

  it("leaves fields that were not sent alone", () => {
    expect(buildStudentUpdate({ guardianNumber: "0801" }).data).toEqual({ guardianNumber: "0801" });
  });

  it("rejects an id that is not a number", () => {
    expect(buildStudentUpdate({ classId: "abc" }).error).toContain("classId");
  });
});
