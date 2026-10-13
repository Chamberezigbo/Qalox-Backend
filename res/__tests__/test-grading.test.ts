// These rules decide a student's score and deadline, so they are pinned exactly.
const { gradeAttempt, shuffleWithSeed, deadlineFor, availability } = require("../util/testGrading");

const q = (id: number, correctId: number, marks = 1) => ({
  id, marks,
  options: [1, 2, 3, 4].map((n) => ({ id: id * 10 + n, isCorrect: id * 10 + n === correctId })),
});
const questions = [q(1, 12), q(2, 23), q(3, 31, 2)];

describe("gradeAttempt", () => {
  it("awards each question's marks for a correct answer and totals the paper", () => {
    const r = gradeAttempt(questions, [
      { questionId: 1, selectedOptionId: 12 },
      { questionId: 2, selectedOptionId: 23 },
      { questionId: 3, selectedOptionId: 31 },
    ]);
    expect(r.score).toBe(4);
    expect(r.totalPossible).toBe(4);
  });

  it("scores zero for wrong, blank and missing answers, with no negative marking", () => {
    const r = gradeAttempt(questions, [
      { questionId: 1, selectedOptionId: 11 },
      { questionId: 2, selectedOptionId: null },
    ]);
    expect(r.score).toBe(0);
    expect(r.totalPossible).toBe(4);
    expect(r.perQuestion.get(3)).toEqual({ selectedOptionId: null, isCorrect: false, marksAwarded: 0 });
  });

  it("gives nothing for an option that belongs to a different question", () => {
    // 23 is question 2's correct option; it must not score on question 1.
    const r = gradeAttempt(questions, [{ questionId: 1, selectedOptionId: 23 }]);
    expect(r.score).toBe(0);
    expect(r.perQuestion.get(1)?.selectedOptionId).toBeNull();
  });

  it("weights by the question's marks", () => {
    const r = gradeAttempt(questions, [{ questionId: 3, selectedOptionId: 31 }]);
    expect(r.score).toBe(2);
  });
});

describe("shuffleWithSeed", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("is repeatable for the same seed", () => {
    expect(shuffleWithSeed(items, 42)).toEqual(shuffleWithSeed(items, 42));
  });

  it("differs between seeds, and keeps every item exactly once", () => {
    const a = shuffleWithSeed(items, 1);
    expect(a).not.toEqual(shuffleWithSeed(items, 2));
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });

  it("does not change the original", () => {
    const copy = [...items];
    shuffleWithSeed(items, 7);
    expect(items).toEqual(copy);
  });
});

describe("deadlineFor", () => {
  const start = new Date("2026-10-10T10:00:00Z");

  it("is the start plus the time allowed", () => {
    expect(deadlineFor(start, 30, null).toISOString()).toBe("2026-10-10T10:30:00.000Z");
  });

  it("never runs past the closing time", () => {
    expect(deadlineFor(start, 60, new Date("2026-10-10T10:20:00Z")).toISOString()).toBe("2026-10-10T10:20:00.000Z");
  });

  it("ignores a closing time that is later than the time allowed", () => {
    expect(deadlineFor(start, 30, new Date("2026-10-10T12:00:00Z")).toISOString()).toBe("2026-10-10T10:30:00.000Z");
  });
});

describe("availability", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  const test = (over: object = {}) => ({ status: "published", opensAt: null, closesAt: null, ...over });

  it("is open for a published test with no window", () => {
    expect(availability(test(), now)).toEqual({ open: true, reason: null });
  });

  it.each([
    [{ status: "draft" }, "TEST_NOT_AVAILABLE"],
    [{ status: "closed" }, "TEST_NOT_AVAILABLE"],
    [{ opensAt: new Date("2026-10-10T11:00:00Z") }, "TEST_NOT_OPEN"],
    [{ closesAt: new Date("2026-10-10T09:59:00Z") }, "TEST_CLOSED"],
    [{ closesAt: now }, "TEST_CLOSED"],
  ])("is closed for %j", (over, reason) => {
    expect(availability(test(over), now)).toEqual({ open: false, reason });
  });
});

export {};
