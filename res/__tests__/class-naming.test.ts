const { splitClassName, groupNamingSystems, planRename } = require("../util/classNaming");

describe("splitClassName", () => {
  it.each([
    ["Primary 1", "Primary", 1],
    ["JSS2", "JSS", 2],
    ["Grade-3", "Grade", 3],
    ["Nursery  12", "Nursery", 12],
  ])("%s", (name, prefix, level) => {
    expect(splitClassName(name)).toEqual({ prefix, level });
  });
  it.each(["Creche", "7", "Primary 1A", ""])("ignores %p", (name) => {
    expect(splitClassName(name)).toBeNull();
  });
});

describe("groupNamingSystems", () => {
  it("groups by the text before the number, with the level range", () => {
    const groups = groupNamingSystems([
      { id: 1, name: "Nursery 1" }, { id: 2, name: "Nursery 2" },
      { id: 3, name: "Grade 1" }, { id: 4, name: "Grade 3" }, { id: 5, name: "Grade 3" }, { id: 6, name: "Creche" },
    ]);
    expect(groups).toEqual([
      { prefix: "Nursery", classCount: 2, levels: [1, 2], minLevel: 1, maxLevel: 2 },
      { prefix: "Grade", classCount: 3, levels: [1, 3], minLevel: 1, maxLevel: 3 },
    ]);
  });
});

describe("planRename", () => {
  const classes = [
    { id: 1, name: "Primary 1", campusId: 1 },
    { id: 2, name: "Primary 2", campusId: 1 },
    { id: 3, name: "Primary 1", campusId: 2 },
    { id: 4, name: "JSS 1", campusId: 1 },
  ];
  const all = [1, 2, 3, 4];

  it("renames every class in the system and nothing else", () => {
    const { changes, conflicts } = planRename(classes, all, "Primary", "Grade");
    expect(changes.map((c) => c.to)).toEqual(["Grade 1", "Grade 2", "Grade 1"]);
    expect(conflicts).toEqual([]);
  });

  it("only touches classes the admin may edit", () => {
    const { changes } = planRename(classes, [3], "Primary", "Grade");
    expect(changes).toEqual([{ id: 3, from: "Primary 1", to: "Grade 1" }]);
  });

  it("reports a clash with an existing class in the same campus only", () => {
    const withGrade = [...classes, { id: 9, name: "Grade 1", campusId: 1 }];
    const { conflicts } = planRename(withGrade, all.concat(9), "Primary", "Grade");
    expect(conflicts).toEqual([{ id: 1, to: "Grade 1" }]);
  });

  it("tidies spacing in the new name", () => {
    const { changes } = planRename(classes, all, "Primary", "  Lower   Basic ");
    expect(changes[0].to).toBe("Lower Basic 1");
  });
});
