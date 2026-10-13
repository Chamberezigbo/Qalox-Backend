// A model's output is not trusted: a malformed question would mark a student
// against a broken answer. These pin what is dropped and what blocks publishing.
const { normalizeGeneratedQuestions, validateQuestionInput, publishProblems } = require("../util/testQuestions");

const good = (over: object = {}) => ({
  text: "Which gas do plants take in for photosynthesis?",
  options: ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"],
  correctIndex: 1,
  explanation: "Plants absorb CO2.",
  ...over,
});

describe("normalizeGeneratedQuestions", () => {
  it("keeps a good question and marks exactly the right option correct", () => {
    const [q] = normalizeGeneratedQuestions([good()]);
    expect(q.options.map((o: any) => o.isCorrect)).toEqual([false, true, false, false]);
    expect(q.explanation).toBe("Plants absorb CO2.");
  });

  it("drops what cannot be marked fairly", () => {
    const result = normalizeGeneratedQuestions([
      good({ options: ["A", "B", "C"] }),                          // three options
      good({ text: "Same options?", options: ["A", "a", "C", "D"] }), // duplicate option
      good({ text: "Index off the end?", correctIndex: 4 }),
      good({ text: "Negative index?", correctIndex: -1 }),
      good({ text: "   " }),
      good({ text: "Fractional?", correctIndex: 1.5 }),
      good({ text: "Fine question?" }),
    ]);
    expect(result.map((q: any) => q.text)).toEqual(["Fine question?"]);
  });

  it("drops a repeated question, ignoring case and spacing", () => {
    const result = normalizeGeneratedQuestions([good(), good({ text: "  which GAS do plants take in for photosynthesis?  " })]);
    expect(result).toHaveLength(1);
  });

  it("tolerates garbage", () => {
    expect(normalizeGeneratedQuestions(null)).toEqual([]);
    expect(normalizeGeneratedQuestions("x")).toEqual([]);
    expect(normalizeGeneratedQuestions([null, 3, {}])).toEqual([]);
  });
});

describe("validateQuestionInput", () => {
  const ok = { text: "Q?", options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }] };

  it("accepts a valid question, two to six options", () => {
    expect(validateQuestionInput(ok)).toBeNull();
  });

  it.each([
    [{ ...ok, text: " " }, "blank"],
    [{ ...ok, options: [ok.options[0]] }, "between 2 and 6"],
    [{ ...ok, options: [{ text: "a", isCorrect: true }, { text: "A", isCorrect: false }] }, "same"],
    [{ ...ok, options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }] }, "exactly one"],
    [{ ...ok, options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }] }, "exactly one"],
    [{ ...ok, options: [{ text: "a", isCorrect: true }, { text: "", isCorrect: false }] }, "some text"],
  ])("refuses %# (%s)", (input, fragment) => {
    expect(validateQuestionInput(input)).toContain(fragment);
  });
});

describe("publishProblems", () => {
  const q = { text: "Q?", options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }] };

  it("is empty for a sound test", () => {
    expect(publishProblems({ questions: [q], durationMinutes: 30 })).toEqual([]);
  });

  it("needs questions and names the broken one by number", () => {
    expect(publishProblems({ questions: [], durationMinutes: 30 })).toContain("Add at least one question");
    const broken = { ...q, options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }] };
    expect(publishProblems({ questions: [q, broken], durationMinutes: 30 })[0]).toMatch(/^Question 2:/);
  });

  it("checks the duration and the opening window", () => {
    expect(publishProblems({ questions: [q], durationMinutes: 0 })).toContain("The duration must be between 1 and 300 minutes");
    const problems = publishProblems({
      questions: [q], durationMinutes: 30, opensAt: new Date("2026-10-10T10:00:00Z"), closesAt: new Date("2026-10-10T09:00:00Z"),
    });
    expect(problems).toContain("The closing time must be after the opening time");
  });
});

export {};
