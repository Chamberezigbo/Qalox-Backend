// The suggestion rules for end-of-session promotion. The admin has the last word
// on every student, so these only have to be predictable and explainable.
const { sessionAverage, suggestOutcome, validateDecisions } = require("../util/promotionRules");

describe("sessionAverage", () => {
  const rows = [
    { termId: 1, total: 60 }, { termId: 1, total: 80 },   // term 1 average 70
    { termId: 2, total: 40 }, { termId: 2, total: 50 },   // term 2 average 45
  ];

  it("all_terms: the mean of each term's average, so a term with more subjects does not outweigh another", () => {
    expect(sessionAverage(rows, "all_terms", [1, 2])).toEqual({ average: 57.5, termsWithResults: 2 });
    const uneven = [...rows, { termId: 2, total: 50 }, { termId: 2, total: 50 }];
    // term 1 averages 70, term 2 averages (40+50+50+50)/4 = 47.5, so (70 + 47.5) / 2 = 58.75
    expect(sessionAverage(uneven, "all_terms", [1, 2]).average).toBe(58.8);
  });

  it("last_term: only the final published term", () => {
    expect(sessionAverage(rows, "last_term", [1, 2])).toEqual({ average: 45, termsWithResults: 2 });
  });

  it("last_term: a student with no results in the final term has no average, not a borrowed one", () => {
    expect(sessionAverage([{ termId: 1, total: 80 }], "last_term", [1, 2]).average).toBeNull();
  });

  it("is null, not zero, for a student with nothing published", () => {
    expect(sessionAverage([], "all_terms", [1])).toEqual({ average: null, termsWithResults: 0 });
  });

  it("judges a student who missed a term on the terms they have", () => {
    expect(sessionAverage([{ termId: 1, total: 62 }], "all_terms", [1, 2])).toEqual({ average: 62, termsWithResults: 1 });
  });

  it("ignores rows that are not numbers", () => {
    expect(sessionAverage([{ termId: 1, total: 60 }, { termId: 1, total: NaN }], "all_terms", [1]).average).toBe(60);
  });
});

describe("suggestOutcome", () => {
  const base = { passMark: 40, trialMargin: 5, isFinalClass: false };

  it("promotes at or above the pass mark", () => {
    expect(suggestOutcome({ ...base, average: 40 }).outcome).toBe("promoted");
    expect(suggestOutcome({ ...base, average: 72 }).outcome).toBe("promoted");
  });

  it("puts a student just short of the mark on trial", () => {
    expect(suggestOutcome({ ...base, average: 36 }).outcome).toBe("trial");
    expect(suggestOutcome({ ...base, average: 35 }).outcome).toBe("trial");
  });

  it("repeats a student further below", () => {
    expect(suggestOutcome({ ...base, average: 34.9 }).outcome).toBe("repeat");
  });

  it("has no trial outcome when the margin is off", () => {
    expect(suggestOutcome({ ...base, trialMargin: null, average: 38 }).outcome).toBe("repeat");
  });

  it("graduates a pass in the final class, and repeats a miss rather than putting them on trial", () => {
    const final = { ...base, isFinalClass: true };
    expect(suggestOutcome({ ...final, average: 60 }).outcome).toBe("graduated");
    expect(suggestOutcome({ ...final, average: 38 }).outcome).toBe("repeat");
  });

  it("suggests nothing without an average, and says why", () => {
    const result = suggestOutcome({ ...base, average: null });
    expect(result.outcome).toBeNull();
    expect(result.reason).toContain("No published results");
  });

  it("always explains itself", () => {
    expect(suggestOutcome({ ...base, average: 50 }).reason).toContain("50");
  });
});

describe("validateDecisions", () => {
  const cls = { id: 1, promotesToClassId: 2 };
  const ok = {
    cls,
    sameCampusClassIds: new Set([1, 2, 3]),
    expectedStudentIds: [10, 11],
  };

  it("accepts a full set of valid decisions", () => {
    expect(validateDecisions({ ...ok, decisions: [{ studentId: 10, outcome: "promoted" }, { studentId: 11, outcome: "repeat" }] })).toBeNull();
  });

  it("requires a decision for every student in the class", () => {
    expect(validateDecisions({ ...ok, decisions: [{ studentId: 10, outcome: "promoted" }] })).toContain("still need a decision");
  });

  it("refuses a student who is not in the class", () => {
    const decisions = [{ studentId: 10, outcome: "repeat" }, { studentId: 11, outcome: "repeat" }, { studentId: 99, outcome: "repeat" }];
    expect(validateDecisions({ ...ok, decisions })).toContain("not in this class");
  });

  it("refuses graduating from a class that has a next class", () => {
    const decisions = [{ studentId: 10, outcome: "graduated" }, { studentId: 11, outcome: "repeat" }];
    expect(validateDecisions({ ...ok, decisions })).toContain("final class");
  });

  it("refuses promoting from a class with no next class set, unless a target is given", () => {
    const noNext = { ...ok, cls: { id: 1, promotesToClassId: null } };
    const bare = [{ studentId: 10, outcome: "promoted" }, { studentId: 11, outcome: "repeat" }];
    expect(validateDecisions({ ...noNext, decisions: bare })).toContain("no next class");
    const withTarget = [{ studentId: 10, outcome: "promoted", toClassId: 3 }, { studentId: 11, outcome: "repeat" }];
    expect(validateDecisions({ ...noNext, decisions: withTarget })).toBeNull();
  });

  it("refuses a target class in another campus, and a repeated student, and an unknown outcome", () => {
    const far = [{ studentId: 10, outcome: "promoted", toClassId: 50 }, { studentId: 11, outcome: "repeat" }];
    expect(validateDecisions({ ...ok, decisions: far })).toContain("same campus");
    const twice = [{ studentId: 10, outcome: "repeat" }, { studentId: 10, outcome: "repeat" }, { studentId: 11, outcome: "repeat" }];
    expect(validateDecisions({ ...ok, decisions: twice })).toContain("more than once");
    expect(validateDecisions({ ...ok, decisions: [{ studentId: 10, outcome: "expelled" }] })).toContain("not a valid outcome");
  });
});

describe("classPromotionStatus", () => {
  const { classPromotionStatus } = require("../util/promotionRules");
  const base = { studentsLeft: 12, publishedTerms: 2, hasRun: false, hasNextClassSet: true, nextClassFound: true };

  it.each([
    [{}, "ready"],
    [{ studentsLeft: 0, hasRun: true }, "done"],
    [{ studentsLeft: 0, hasRun: false }, "no_students"],
    [{ hasRun: true }, "partly_done"],
    [{ publishedTerms: 0 }, "no_results"],
    [{ nextClassFound: false }, "needs_next_class"],
    // A final class has no next class and is still reviewable (its students graduate).
    [{ hasNextClassSet: false, nextClassFound: false }, "ready"],
  ])("%j is %s", (over, expected) => {
    expect(classPromotionStatus({ ...base, ...over })).toBe(expected);
  });

  it("a missing next class outranks a missing result, because it blocks applying", () => {
    expect(classPromotionStatus({ ...base, publishedTerms: 0, nextClassFound: false })).toBe("needs_next_class");
  });
});

export {};
