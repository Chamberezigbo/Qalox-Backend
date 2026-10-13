// What a teacher is told about how a class did must be exactly right: best
// attempt counts, unfinished students are not averaged in, and a question's
// difficulty counts a skipped answer as a miss.
const { buildRows, summarize, questionStats } = require("../util/testResults");

const student = (id: number, name: string) => ({ id, name, surname: "T", registrationNumber: `R${id}` });
const attempt = (over: object) => ({
  id: 1, studentId: 1, status: "submitted", score: 5, totalPossible: 10, submittedAt: new Date("2026-10-10T10:00:00Z"), attemptNumber: 1, ...over,
});

describe("buildRows", () => {
  const students = [student(1, "Ada"), student(2, "Bola"), student(3, "Chi")];

  it("lists every student in the class, including those who have not started", () => {
    const rows = buildRows(students, [attempt({ studentId: 1 })]);
    expect(rows.map((r: any) => r.status)).toEqual(["submitted", "not_started", "not_started"]);
    expect(rows[1].score).toBeNull();
  });

  it("uses the best finished attempt, but reports the latest submission time", () => {
    const rows = buildRows([student(1, "Ada")], [
      attempt({ id: 10, attemptNumber: 1, score: 8, submittedAt: new Date("2026-10-10T09:00:00Z") }),
      attempt({ id: 11, attemptNumber: 2, score: 3, submittedAt: new Date("2026-10-11T09:00:00Z") }),
    ]);
    expect(rows[0].score).toBe(8);
    expect(rows[0].bestAttemptId).toBe(10);
    expect(rows[0].attemptsUsed).toBe(2);
    expect(rows[0].submittedAt).toEqual(new Date("2026-10-11T09:00:00Z"));
  });

  it("marks a student with only an unfinished attempt as in progress, with no score", () => {
    const rows = buildRows([student(1, "Ada")], [attempt({ status: "in_progress", score: null, totalPossible: null })]);
    expect(rows[0].status).toBe("in_progress");
    expect(rows[0].score).toBeNull();
  });

  it("flags a score that came from running out of time", () => {
    const rows = buildRows([student(1, "Ada")], [attempt({ status: "auto_submitted" })]);
    expect(rows[0].autoSubmitted).toBe(true);
    expect(rows[0].status).toBe("submitted");
  });

  it("computes the percentage, and none for an empty paper", () => {
    expect(buildRows([student(1, "Ada")], [attempt({ score: 7, totalPossible: 8 })])[0].percentage).toBe(87.5);
    expect(buildRows([student(1, "Ada")], [attempt({ score: 0, totalPossible: 0 })])[0].percentage).toBeNull();
  });
});

describe("summarize", () => {
  it("averages only the students who finished", () => {
    const rows = buildRows(
      [student(1, "A"), student(2, "B"), student(3, "C"), student(4, "D")],
      [
        attempt({ id: 1, studentId: 1, score: 10, totalPossible: 10 }),
        attempt({ id: 2, studentId: 2, score: 5, totalPossible: 10 }),
        attempt({ id: 3, studentId: 3, status: "in_progress", score: null, totalPossible: null }),
      ]
    );
    expect(summarize(rows)).toEqual({
      classSize: 4, submitted: 2, inProgress: 1, notStarted: 1, average: 75, highest: 100, lowest: 50,
    });
  });

  it("has no figures, rather than zeros, when nobody has finished", () => {
    const s = summarize(buildRows([student(1, "A")], []));
    expect(s.average).toBeNull();
    expect(s.highest).toBeNull();
  });
});

describe("questionStats", () => {
  const questions = [{ id: 1, text: "Q1", order: 1 }, { id: 2, text: "Q2", order: 2 }];

  it("counts a skipped question as a miss against the number of students who took it", () => {
    const stats = questionStats(
      questions,
      [
        { questionId: 1, isCorrect: true, selectedOptionId: 11 },
        { questionId: 1, isCorrect: false, selectedOptionId: 12 },
        { questionId: 2, isCorrect: true, selectedOptionId: 21 },
      ],
      4
    );
    expect(stats[0]).toMatchObject({ answered: 2, correct: 1, skipped: 2, correctPercent: 25 });
    expect(stats[1]).toMatchObject({ answered: 1, correct: 1, skipped: 3, correctPercent: 25 });
  });

  it("has no percentage when nobody took the test", () => {
    expect(questionStats(questions, [], 0)[0].correctPercent).toBeNull();
  });
});

export {};
