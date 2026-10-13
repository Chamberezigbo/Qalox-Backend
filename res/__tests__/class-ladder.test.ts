// Class names are free text, so the ladder is suggested from them and confirmed
// by the admin. These pin the suggestion rules, the pass-mark defaults and the
// checks that stop a bad ladder being saved.
const { parseClassName, effectivePassMark, suggestLadder, validateLadder } = require("../util/classLadder");

describe("parseClassName", () => {
  it.each([
    ["JSS1", "JSS", 1], ["JSS 2", "JSS", 2], ["jss3", "JSS", 3], ["J.S.S. 2", "JSS", 2],
    ["SSS1", "SS", 1], ["SS 2", "SS", 2], ["S.S.S 3", "SS", 3],
    ["Primary 4", "PRIMARY", 4], ["Basic 5", "PRIMARY", 5], ["Pry 6", "PRIMARY", 6],
  ])("reads %j", (name, stage, level) => {
    expect(parseClassName(name)).toEqual({ stage, level });
  });

  it.each(["SS SS1", "Reception", "JSS4", "SS0", "Nursery 1", "", null])("cannot read %j", (name) => {
    expect(parseClassName(name)).toBeNull();
  });
});

describe("effectivePassMark", () => {
  it("uses the class's own mark first", () => {
    expect(effectivePassMark({ name: "SS 1", passMark: 45 })).toBe(45);
  });
  it("defaults JSS to 40 and SS to 50", () => {
    expect(effectivePassMark({ name: "JSS2", passMark: null })).toBe(40);
    expect(effectivePassMark({ name: "SSS2", passMark: null })).toBe(50);
  });
  it("falls back to 40 for a name it cannot read, and respects an explicit 0", () => {
    expect(effectivePassMark({ name: "Reception", passMark: null })).toBe(40);
    expect(effectivePassMark({ name: "SS 1", passMark: 0 })).toBe(0);
  });
});

describe("suggestLadder", () => {
  const c = (id: number, name: string, campusId: number | null = 1) => ({ id, name, campusId });

  it("moves each class up, crosses JSS to SS, and graduates the last SS class", () => {
    const result = suggestLadder([c(1, "JSS1"), c(2, "JSS 2"), c(3, "JSS3"), c(4, "SSS1"), c(5, "SSS2"), c(6, "SSS3")]);
    expect(result.get(1).nextClassId).toBe(2);
    expect(result.get(2).nextClassId).toBe(3);
    expect(result.get(3).nextClassId).toBe(4);
    expect(result.get(5).nextClassId).toBe(6);
    expect(result.get(6).nextClassId).toBeNull();
  });

  it("never links classes across campuses", () => {
    const result = suggestLadder([c(1, "JSS3", 1), c(2, "SS 1", 2)]);
    expect(result.has(1)).toBe(false);
  });

  it("makes no suggestion for a class it cannot read, or whose next class does not exist", () => {
    const result = suggestLadder([c(1, "Reception"), c(2, "JSS1")]);
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(false);
  });

  it("does not call a class final just because its next class is missing", () => {
    const result = suggestLadder([c(1, "JSS3")]);
    expect(result.has(1)).toBe(false);
  });
});

describe("validateLadder", () => {
  const classes = [
    { id: 1, name: "JSS1", campusId: 1, promotesToClassId: null },
    { id: 2, name: "JSS2", campusId: 1, promotesToClassId: null },
    { id: 3, name: "SS1", campusId: 2, promotesToClassId: null },
  ];

  it("accepts a clean chain, and a class that graduates", () => {
    expect(validateLadder(classes, [{ classId: 1, promotesToClassId: 2 }, { classId: 2, promotesToClassId: null }])).toBeNull();
  });

  it("refuses a class moving up to itself", () => {
    expect(validateLadder(classes, [{ classId: 1, promotesToClassId: 1 }])).toContain("itself");
  });

  it("refuses a class in another campus", () => {
    expect(validateLadder(classes, [{ classId: 2, promotesToClassId: 3 }])).toContain("different campuses");
  });

  it("refuses a loop, including one closed by an existing link", () => {
    const withLink = classes.map((cl) => (cl.id === 2 ? { ...cl, promotesToClassId: 1 } : cl));
    expect(validateLadder(withLink, [{ classId: 1, promotesToClassId: 2 }])).toContain("lead back");
  });

  it("refuses a class from outside the school", () => {
    expect(validateLadder(classes, [{ classId: 1, promotesToClassId: 99 }])).toContain("not found");
  });
});

export {};
