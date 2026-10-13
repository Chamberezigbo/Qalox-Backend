/**
 * What a teacher sees of how a class did on a test. Pure functions: the service
 * fetches the rows, these decide what they mean.
 */

const round1 = (n) => Math.round(n * 10) / 10;

const percentage = (score, total) => (total > 0 ? round1((score / total) * 100) : null);

/**
 * One row per student in the class, plus anyone outside it who has an attempt
 * (a student who was withdrawn after taking it keeps their score on record).
 *
 * A student's mark is their BEST finished attempt: that is what a retake is for,
 * and it means a second go can only help them.
 *
 * @param {Array<{ id: number, name: string, surname: string, registrationNumber: string }>} students
 * @param {Array<{ id: number, studentId: number, status: string, score: number | null, totalPossible: number | null, submittedAt: Date | null, attemptNumber: number }>} attempts
 */
function buildRows(students, attempts) {
  const byStudent = new Map();
  for (const attempt of attempts) {
    if (!byStudent.has(attempt.studentId)) byStudent.set(attempt.studentId, []);
    byStudent.get(attempt.studentId).push(attempt);
  }

  return students.map((student) => {
    const mine = byStudent.get(student.id) ?? [];
    const finished = mine.filter((a) => a.status !== "in_progress" && a.score !== null);
    const best = finished.reduce((top, a) => (top === null || a.score > top.score ? a : top), null);
    const latest = [...finished].sort((a, b) => b.attemptNumber - a.attemptNumber)[0] ?? null;

    let status = "not_started";
    if (finished.length > 0) status = "submitted";
    else if (mine.some((a) => a.status === "in_progress")) status = "in_progress";

    return {
      studentId: student.id,
      name: `${student.surname} ${student.name}`.trim(),
      registrationNumber: student.registrationNumber,
      status,
      attemptsUsed: mine.length,
      bestAttemptId: best?.id ?? null,
      score: best ? best.score : null,
      totalPossible: best ? best.totalPossible : null,
      percentage: best ? percentage(best.score, best.totalPossible) : null,
      submittedAt: latest?.submittedAt ?? null,
      autoSubmitted: best ? best.status === "auto_submitted" : false,
    };
  });
}

/** Class-level figures. Averages are over students who finished, not the whole class. */
function summarize(rows) {
  const submitted = rows.filter((r) => r.status === "submitted");
  const percentages = submitted.map((r) => r.percentage).filter((p) => p !== null);

  return {
    classSize: rows.length,
    submitted: submitted.length,
    inProgress: rows.filter((r) => r.status === "in_progress").length,
    notStarted: rows.filter((r) => r.status === "not_started").length,
    average: percentages.length ? round1(percentages.reduce((a, b) => a + b, 0) / percentages.length) : null,
    highest: percentages.length ? Math.max(...percentages) : null,
    lowest: percentages.length ? Math.min(...percentages) : null,
  };
}

/**
 * Which questions the class found hard, from each student's best attempt.
 *
 * @param {Array<{ id: number, text: string, order: number }>} questions
 * @param {Array<{ questionId: number, isCorrect: boolean | null, selectedOptionId: number | null }>} answers
 *   the answers of each student's best attempt only
 * @param {number} takers how many students those attempts belong to
 */
function questionStats(questions, answers, takers) {
  const byQuestion = new Map();
  for (const a of answers) {
    if (!byQuestion.has(a.questionId)) byQuestion.set(a.questionId, []);
    byQuestion.get(a.questionId).push(a);
  }

  return questions.map((q) => {
    const given = byQuestion.get(q.id) ?? [];
    const answered = given.filter((a) => a.selectedOptionId !== null).length;
    const correct = given.filter((a) => a.isCorrect === true).length;
    return {
      questionId: q.id,
      number: q.order,
      text: q.text,
      answered,
      // Unanswered counts against the question, as it does against the student.
      skipped: Math.max(0, takers - answered),
      correct,
      correctPercent: takers > 0 ? round1((correct / takers) * 100) : null,
    };
  });
}

module.exports = { buildRows, summarize, questionStats, percentage };
