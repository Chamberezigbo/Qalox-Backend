// A hand-written class teacher remark replaces the automatic one; blank falls back.
/* eslint-disable @typescript-eslint/no-var-requires */
const { automaticRemark, effectiveRemark, cleanRemark, MAX_REMARK } = require("../util/remarkRules");

const rules = [
  { minScore: 70, maxScore: 100, remark: "{studentName} is excellent" },
  { minScore: 50, maxScore: 69, remark: "{studentName} is fair" },
  { minScore: 0, maxScore: 49, remark: "Must try harder" },
];

describe("automaticRemark", () => {
  it("picks the rule whose range holds the average, naming the student", () => {
    expect(automaticRemark(rules, 85, "Ada Obi")).toBe("Ada Obi is excellent");
    expect(automaticRemark(rules, 50, "Ada Obi")).toBe("Ada Obi is fair");
    expect(automaticRemark(rules, 10, "Ada Obi")).toBe("Must try harder");
  });

  it("is empty when nothing matches or there is no scheme", () => {
    expect(automaticRemark(rules, 101, "Ada")).toBe("");
    expect(automaticRemark([], 50, "Ada")).toBe("");
  });
});

describe("effectiveRemark", () => {
  it("uses the hand-written remark, trimmed, over the automatic one", () => {
    expect(effectiveRemark("  Well done  ", "auto")).toBe("Well done");
  });
  it("falls back to the automatic remark when blank or absent", () => {
    for (const blank of ["", "   ", null, undefined]) expect(effectiveRemark(blank, "auto")).toBe("auto");
  });
});

describe("cleanRemark", () => {
  it("trims, and turns blank into null so it clears the remark", () => {
    expect(cleanRemark("  hello ")).toBe("hello");
    for (const blank of ["", "  ", null, undefined]) expect(cleanRemark(blank)).toBeNull();
  });
  it("refuses one that is too long instead of cutting it off", () => {
    expect(cleanRemark("x".repeat(MAX_REMARK))).toHaveLength(MAX_REMARK);
    expect(() => cleanRemark("x".repeat(MAX_REMARK + 1))).toThrow(/at most 500/);
  });
});

export {};
