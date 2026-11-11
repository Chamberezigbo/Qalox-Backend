const {
  validateRules, normalizeRules, describeRules, evaluateRules, suggestOutcomeByRules, sessionSubjectScores,
} = require("../util/promotionRules");

const names = { 1: "English", 2: "Mathematics", 3: "Biology" };
const run = (rules: any, average: number | null, subjectScores: Record<number, number>, extra: any = {}) => {
  const evaluation = evaluateRules(rules, { average, subjectScores, subjectNames: names });
  return {
    evaluation,
    suggestion: suggestOutcomeByRules({
      average, hasScores: Object.keys(subjectScores).length > 0, evaluation, trialMargin: 5, isFinalClass: false, ...extra,
    }),
  };
};

describe("credits rule", () => {
  const rules = { match: "all", criteria: [{ type: "credits", creditMark: 50, minCredits: 3 }] };
  it("promotes with enough credits", () => {
    expect(run(rules, 60, { 1: 70, 2: 55, 3: 50, 4: 20 }).suggestion.outcome).toBe("promoted");
  });
  it("repeats with too few and says how many", () => {
    const r = run(rules, 60, { 1: 70, 2: 55, 3: 49 });
    expect(r.suggestion.outcome).toBe("repeat");
    expect(r.suggestion.reason).toContain("2 credits (needs 3)");
  });
});

describe("core subjects", () => {
  const rules = { match: "all", criteria: [{ type: "core_subjects", subjectIds: [1, 2], passMark: 50, min: null }] };
  it("needs each chosen subject", () => {
    expect(run(rules, 80, { 1: 90, 2: 49 }).suggestion.outcome).toBe("repeat");
    expect(run(rules, 80, { 1: 90, 2: 50 }).suggestion.outcome).toBe("promoted");
  });
  it("names the subject that was missed, and counts a missing score as not passed", () => {
    expect(run(rules, 80, { 1: 90 }).evaluation.checks[0].detail).toBe("Not passed: Mathematics");
  });
  it("can need only some of the chosen subjects", () => {
    const some = { match: "all", criteria: [{ type: "core_subjects", subjectIds: [1, 2, 3], passMark: 50, min: 2 }] };
    expect(run(some, 70, { 1: 60, 2: 60, 3: 10 }).suggestion.outcome).toBe("promoted");
  });
});

describe("combining rules", () => {
  const criteria = [
    { type: "average", min: 50 },
    { type: "credits", creditMark: 50, minCredits: 5 },
  ];
  it("all: needs both", () => {
    expect(run({ match: "all", criteria }, 60, { 1: 60, 2: 60 }).suggestion.outcome).toBe("repeat");
  });
  it("any: either is enough", () => {
    expect(run({ match: "any", criteria }, 60, { 1: 60, 2: 60 }).suggestion.outcome).toBe("promoted");
  });
});

describe("subjects passed and max failed", () => {
  it("counts subjects passed", () => {
    const rules = { match: "all", criteria: [{ type: "subjects_passed", passMark: 40, minSubjects: 2 }] };
    expect(run(rules, 40, { 1: 40, 2: 39, 3: 41 }).suggestion.outcome).toBe("promoted");
  });
  it("limits failed subjects", () => {
    const rules = { match: "all", criteria: [{ type: "max_failed", passMark: 40, maxFailed: 1 }] };
    expect(run(rules, 40, { 1: 10, 2: 39, 3: 90 }).suggestion.outcome).toBe("repeat");
    expect(run(rules, 40, { 1: 10, 2: 41, 3: 90 }).suggestion.outcome).toBe("promoted");
  });
});

describe("trial and final class", () => {
  const rules = { match: "all", criteria: [{ type: "average", min: 50 }] };
  it("trial when only the average is short and within the margin", () => {
    expect(run(rules, 46, { 1: 46 }).suggestion.outcome).toBe("trial");
    expect(run(rules, 44, { 1: 44 }).suggestion.outcome).toBe("repeat");
  });
  it("no trial when another rule is also missed", () => {
    const both = { match: "all", criteria: [{ type: "average", min: 50 }, { type: "credits", creditMark: 50, minCredits: 3 }] };
    expect(run(both, 48, { 1: 48 }).suggestion.outcome).toBe("repeat");
  });
  it("graduates in the final class, and never gives trial there", () => {
    expect(run(rules, 60, { 1: 60 }, { isFinalClass: true }).suggestion.outcome).toBe("graduated");
    expect(run(rules, 46, { 1: 46 }, { isFinalClass: true }).suggestion.outcome).toBe("repeat");
  });
  it("suggests nothing without results", () => {
    expect(run(rules, null, {}).suggestion.outcome).toBeNull();
  });
});

describe("sessionSubjectScores", () => {
  const rows = [
    { subjectId: 1, termId: 1, total: 40 }, { subjectId: 1, termId: 2, total: 60 },
    { subjectId: 2, termId: 2, total: 70 },
  ];
  it("averages a subject over its terms, or takes the last term", () => {
    expect(sessionSubjectScores(rows, "all_terms", [1, 2])).toEqual({ 1: 50, 2: 70 });
    expect(sessionSubjectScores(rows, "last_term", [1, 2])).toEqual({ 1: 60, 2: 70 });
  });
});

describe("validateRules", () => {
  const ok = { match: "all", criteria: [{ type: "average", min: 50 }] };
  const subjects = new Set([1, 2]);
  it("accepts no rule and a good rule", () => {
    expect(validateRules(null)).toBeNull();
    expect(validateRules(ok)).toBeNull();
  });
  it.each([
    [{ match: "some", criteria: ok.criteria }, "all"],
    [{ match: "all", criteria: [] }, "at least one"],
    [{ match: "all", criteria: [{ type: "average", min: 120 }] }, "0 to 100"],
    [{ match: "all", criteria: [{ type: "credits", creditMark: 50, minCredits: 0 }] }, "number of credits"],
    [{ match: "all", criteria: [{ type: "nope" }] }, "unknown type"],
    [{ match: "all", criteria: [{ type: "core_subjects", subjectIds: [], passMark: 50 }] }, "at least one core"],
    [{ match: "all", criteria: [{ type: "core_subjects", subjectIds: [9], passMark: 50 }] }, "does not belong"],
    [{ match: "all", criteria: [{ type: "core_subjects", subjectIds: [1], passMark: 50, min: 2 }] }, "cannot be more"],
  ])("rejects a bad rule", (rules, text) => {
    expect(validateRules(rules, { subjectIds: subjects })).toContain(text);
  });
  it("keeps only known fields", () => {
    const messy = { match: "all", evil: 1, criteria: [{ type: "average", min: 50, extra: "x" }] };
    expect(normalizeRules(messy)).toEqual({ match: "all", criteria: [{ type: "average", min: 50 }] });
  });
});

describe("describeRules", () => {
  it("reads as a sentence", () => {
    const rules = { match: "all", criteria: [
      { type: "average", min: 50 },
      { type: "credits", creditMark: 50, minCredits: 5 },
      { type: "core_subjects", subjectIds: [1, 2], passMark: 50, min: null },
    ] };
    expect(describeRules(rules, names)).toBe(
      "A student is promoted with an average of at least 50 and at least 5 credits (a score of 50 or more) and English, Mathematics each at 50 or more.",
    );
  });
});
