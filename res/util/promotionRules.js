/**
 * The rules that decide each student's end-of-session outcome.
 *
 * Pure functions with no database access, so every rule can be pinned by a test.
 * PromotionService feeds them real data; the admin always has the last word on
 * every student, so these only produce the SUGGESTION.
 */

const OUTCOMES = ["promoted", "trial", "repeat", "graduated"];
const BASES = ["all_terms", "last_term"];

const DEFAULT_POLICY = { basis: "all_terms", trialMargin: 5 };

const round1 = (n) => Math.round(n * 10) / 10;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * A student's average for the session from their published subject totals.
 *
 * all_terms: the mean of each term's average, over the terms they have results
 * in, so a student with a missing term is judged on the terms they have rather
 * than being dragged down by a zero. Whether a term is missing is reported
 * separately (see `termsWithResults`) so the admin can see it.
 *
 * last_term: only the final term the class has published.
 *
 * Only subjects the student was scored in count; unscored subjects are not zeros.
 *
 * @param {Array<{ termId: number | null, total: number }>} rows the student's published rows for the session
 * @param {"all_terms" | "last_term"} basis
 * @param {number[]} termOrder term ids the class has published, oldest first
 * @returns {{ average: number | null, termsWithResults: number }}
 */
function sessionAverage(rows, basis, termOrder) {
  const byTerm = new Map();
  for (const row of rows) {
    if (typeof row.total !== "number" || Number.isNaN(row.total)) continue;
    const key = row.termId ?? 0;
    if (!byTerm.has(key)) byTerm.set(key, []);
    byTerm.get(key).push(row.total);
  }

  if (byTerm.size === 0) return { average: null, termsWithResults: 0 };

  if (basis === "last_term") {
    const last = termOrder[termOrder.length - 1];
    const totals = byTerm.get(last);
    return { average: totals ? round1(mean(totals)) : null, termsWithResults: byTerm.size };
  }

  const termAverages = [...byTerm.values()].map(mean);
  return { average: round1(mean(termAverages)), termsWithResults: byTerm.size };
}

/**
 * The suggested outcome for one student.
 *
 * @param {object} input
 * @param {number | null} input.average
 * @param {number} input.passMark
 * @param {number | null} input.trialMargin
 * @param {boolean} input.isFinalClass the class has no next class
 * @returns {{ outcome: string | null, reason: string }} outcome is null when there is nothing to base one on
 */
function suggestOutcome({ average, passMark, trialMargin, isFinalClass }) {
  if (average === null || average === undefined) {
    return { outcome: null, reason: "No published results for this student, so there is nothing to suggest from" };
  }

  if (average >= passMark) {
    return isFinalClass
      ? { outcome: "graduated", reason: `Average ${average} meets the pass mark of ${passMark}; this is the final class` }
      : { outcome: "promoted", reason: `Average ${average} meets the pass mark of ${passMark}` };
  }

  // "On trial" is for a student just short of the mark who moves up. In the
  // final class there is nowhere to move up to, so a miss is a repeat.
  if (!isFinalClass && trialMargin != null && average >= passMark - trialMargin) {
    return {
      outcome: "trial",
      reason: `Average ${average} is within ${trialMargin} of the pass mark of ${passMark}`,
    };
  }

  return { outcome: "repeat", reason: `Average ${average} is below the pass mark of ${passMark}` };
}

/**
 * Checks the outcomes an admin chose against the class, before anything is written.
 *
 * @param {object} input
 * @param {{ id: number, promotesToClassId: number | null }} input.cls the class being promoted
 * @param {Array<{ studentId: number, outcome: string, toClassId?: number | null }>} input.decisions
 * @param {Set<number>} input.sameCampusClassIds classes in the same campus that may be targets
 * @param {number[]} input.expectedStudentIds everyone in the class who needs a decision
 * @returns {string | null} the first problem, or null
 */
function validateDecisions({ cls, decisions, sameCampusClassIds, expectedStudentIds }) {
  const seen = new Set();
  for (const d of decisions) {
    if (!OUTCOMES.includes(d.outcome)) return `"${d.outcome}" is not a valid outcome`;
    if (seen.has(d.studentId)) return `Student ${d.studentId} appears more than once`;
    seen.add(d.studentId);

    if (d.outcome === "graduated" && cls.promotesToClassId != null) {
      return "Only students in a final class can graduate. Choose where this class moves up to, or promote them.";
    }

    if (d.outcome === "promoted" || d.outcome === "trial") {
      const target = d.toClassId ?? cls.promotesToClassId;
      if (target == null) return "This class has no next class set. Set it in Promotion Setup, or graduate the student.";
      if (!sameCampusClassIds.has(target)) return "A student can only move up to a class in the same campus";
    }
  }

  const expected = new Set(expectedStudentIds);
  const missing = expectedStudentIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return `${missing.length} student${missing.length === 1 ? "" : "s"} in this class still need a decision`;
  }
  const strangers = decisions.filter((d) => !expected.has(d.studentId));
  if (strangers.length > 0) return "Some students are not in this class for the closing session";

  return null;
}

/**
 * Where a class stands in the school-wide promotion overview.
 *
 *   done             nobody is left to move and a promotion was applied
 *   no_students      nobody is in it for this session
 *   needs_next_class a next class is set but cannot be found (Promotion Setup)
 *   no_results       students are waiting but no results were published, so
 *                    there is no suggestion to start from (still reviewable)
 *   partly_done      a promotion was applied, but students are still waiting
 *   ready            students are waiting and there is something to review
 *
 * @param {object} input
 * @param {number} input.studentsLeft active students still in the closing session
 * @param {number} input.publishedTerms terms with published results for the class
 * @param {boolean} input.hasRun a promotion for this class and session is applied (not undone)
 * @param {boolean} input.hasNextClassSet the class names a next class
 * @param {boolean} input.nextClassFound that class exists in the same campus
 */
function classPromotionStatus({ studentsLeft, publishedTerms, hasRun, hasNextClassSet, nextClassFound }) {
  if (studentsLeft === 0) return hasRun ? "done" : "no_students";
  if (hasNextClassSet && !nextClassFound) return "needs_next_class";
  if (hasRun) return "partly_done";
  if (publishedTerms === 0) return "no_results";
  return "ready";
}

module.exports = { OUTCOMES, BASES, DEFAULT_POLICY, sessionAverage, suggestOutcome, validateDecisions, classPromotionStatus };
