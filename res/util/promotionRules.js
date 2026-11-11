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
 * A student's score in each subject for the session, on the same basis as the average:
 * all_terms is the mean of the subject's term totals, last_term is the final published term only.
 *
 * @param {Array<{ subjectId: number, termId: number | null, total: number }>} rows
 * @returns {Record<number, number>} subjectId -> score
 */
function sessionSubjectScores(rows, basis, termOrder) {
  const bySubject = new Map();
  for (const row of rows) {
    if (typeof row.total !== "number" || Number.isNaN(row.total)) continue;
    if (!bySubject.has(row.subjectId)) bySubject.set(row.subjectId, []);
    bySubject.get(row.subjectId).push({ termId: row.termId ?? 0, total: row.total });
  }
  const last = termOrder[termOrder.length - 1];
  const out = {};
  for (const [subjectId, entries] of bySubject) {
    const used = basis === "last_term" ? entries.filter((e) => e.termId === last) : entries;
    if (used.length > 0) out[subjectId] = round1(mean(used.map((e) => e.total)));
  }
  return out;
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


// ─── School-built promotion rules ─────────────────────────────────────────────
//
// A school can replace "average >= pass mark" with its own rule: a list of criteria
// joined by ALL or ANY. Rules are stored as JSON on the school's policy (and optionally
// on a class), so a school can combine whatever its own way of promoting needs:
//
//   { match: "all" | "any",
//     criteria: [
//       { type: "average",         min },                           average >= min
//       { type: "credits",         creditMark, minCredits },        at least N subjects at creditMark or more
//       { type: "subjects_passed", passMark,  minSubjects },        at least N subjects at passMark or more
//       { type: "core_subjects",   subjectIds, passMark, min|null },chosen subjects at passMark (all, or at least `min`)
//       { type: "max_failed",      passMark,  maxFailed } ] }       no more than N subjects below passMark

const CRITERION_TYPES = ["average", "credits", "subjects_passed", "core_subjects", "max_failed"];
const MAX_CRITERIA = 10;

const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isCount = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Checks a rule a school typed in. Returns the first problem in plain words, or null.
 * @param {object | null} rules null means "no custom rule"
 * @param {{ subjectIds?: Set<number> }} [context] the school's subjects, for core_subjects
 */
function validateRules(rules, { subjectIds } = {}) {
  if (rules === null || rules === undefined) return null;
  if (typeof rules !== "object" || Array.isArray(rules)) return "The promotion rule is not in the right format";
  if (!["all", "any"].includes(rules.match)) return 'Choose whether a student must meet "all" or "any" of the rules';
  if (!Array.isArray(rules.criteria) || rules.criteria.length === 0) return "Add at least one promotion rule";
  if (rules.criteria.length > MAX_CRITERIA) return `Use at most ${MAX_CRITERIA} rules`;

  for (const c of rules.criteria) {
    if (!c || !CRITERION_TYPES.includes(c.type)) return "One of the rules has an unknown type";
    if (c.type === "average" && !inRange(c.min, 0, 100)) return "The average must be a score from 0 to 100";
    if (c.type === "credits") {
      if (!inRange(c.creditMark, 0, 100)) return "The credit score must be from 0 to 100";
      if (!isCount(c.minCredits, 1, 50)) return "The number of credits must be a whole number from 1 to 50";
    }
    if (c.type === "subjects_passed") {
      if (!inRange(c.passMark, 0, 100)) return "The subject pass score must be from 0 to 100";
      if (!isCount(c.minSubjects, 1, 50)) return "The number of subjects must be a whole number from 1 to 50";
    }
    if (c.type === "core_subjects") {
      if (!inRange(c.passMark, 0, 100)) return "The pass score for core subjects must be from 0 to 100";
      if (!Array.isArray(c.subjectIds) || c.subjectIds.length === 0 || !c.subjectIds.every((id) => Number.isInteger(id))) {
        return "Choose at least one core subject";
      }
      if (new Set(c.subjectIds).size !== c.subjectIds.length) return "A core subject is chosen twice";
      if (subjectIds && !c.subjectIds.every((id) => subjectIds.has(id))) return "One of the core subjects does not belong to this school";
      if (c.min !== null && c.min !== undefined && !isCount(c.min, 1, c.subjectIds.length)) {
        return "The number of core subjects needed cannot be more than the subjects chosen";
      }
    }
    if (c.type === "max_failed") {
      if (!inRange(c.passMark, 0, 100)) return "The subject pass score must be from 0 to 100";
      if (!isCount(c.maxFailed, 0, 50)) return "The number of failed subjects must be a whole number from 0 to 50";
    }
  }
  return null;
}

/** Keeps only the known fields, so nothing else a client sent is stored. Call after validateRules. */
function normalizeRules(rules) {
  if (!rules) return null;
  return {
    match: rules.match,
    criteria: rules.criteria.map((c) => {
      switch (c.type) {
        case "average": return { type: "average", min: c.min };
        case "credits": return { type: "credits", creditMark: c.creditMark, minCredits: c.minCredits };
        case "subjects_passed": return { type: "subjects_passed", passMark: c.passMark, minSubjects: c.minSubjects };
        case "core_subjects":
          return { type: "core_subjects", subjectIds: c.subjectIds, passMark: c.passMark, min: c.min ?? null };
        default: return { type: "max_failed", passMark: c.passMark, maxFailed: c.maxFailed };
      }
    }),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const nameOf = (names, id) => (names && names[id]) || `Subject ${id}`;

/** One criterion as a sentence, for the rule summary. */
function describeCriterion(c, subjectNames) {
  switch (c.type) {
    case "average": return `an average of at least ${c.min}`;
    case "credits": return `at least ${plural(c.minCredits, "credit")} (a score of ${c.creditMark} or more)`;
    case "subjects_passed": return `at least ${plural(c.minSubjects, "subject")} passed (${c.passMark} or more)`;
    case "core_subjects": {
      const list = c.subjectIds.map((id) => nameOf(subjectNames, id)).join(", ");
      return c.min && c.min < c.subjectIds.length
        ? `at least ${c.min} of ${list} at ${c.passMark} or more`
        : `${list} each at ${c.passMark} or more`;
    }
    default: return `no more than ${plural(c.maxFailed, "failed subject")} (below ${c.passMark})`;
  }
}

/** "A student is promoted with: an average of at least 50 and at least 5 credits." */
function describeRules(rules, subjectNames) {
  if (!rules) return null;
  const parts = rules.criteria.map((c) => describeCriterion(c, subjectNames));
  const joiner = rules.match === "any" ? " or " : " and ";
  return `A student is promoted with ${parts.join(joiner)}.`;
}

/**
 * Applies a rule to one student.
 *
 * @param {object} rules a valid rule (see validateRules)
 * @param {{ average: number | null, subjectScores: Record<number, number>, subjectNames?: Record<number, string> }} student
 *        subjectScores: the student's score per subject for the session
 * @returns {{ passed: boolean, checks: Array<{ type: string, passed: boolean, label: string, detail: string }>, averageNearMiss: number | null }}
 *          averageNearMiss is the minimum average when "average" is the ONLY rule failed, else null (used for the trial outcome)
 */
function evaluateRules(rules, { average, subjectScores, subjectNames }) {
  const scores = Object.values(subjectScores ?? {}).filter((v) => typeof v === "number" && !Number.isNaN(v));

  const checks = rules.criteria.map((c) => {
    const label = describeCriterion(c, subjectNames);
    switch (c.type) {
      case "average": {
        const passed = average != null && average >= c.min;
        return { type: c.type, passed, label, detail: average == null ? "No average" : `Average ${average} (needs ${c.min})`, min: c.min };
      }
      case "credits": {
        const have = scores.filter((v) => v >= c.creditMark).length;
        return { type: c.type, passed: have >= c.minCredits, label, detail: `${plural(have, "credit")} (needs ${c.minCredits})` };
      }
      case "subjects_passed": {
        const have = scores.filter((v) => v >= c.passMark).length;
        return { type: c.type, passed: have >= c.minSubjects, label, detail: `${plural(have, "subject")} passed (needs ${c.minSubjects})` };
      }
      case "core_subjects": {
        const need = c.min ?? c.subjectIds.length;
        const missed = c.subjectIds.filter((id) => !(typeof subjectScores?.[id] === "number" && subjectScores[id] >= c.passMark));
        const have = c.subjectIds.length - missed.length;
        return {
          type: c.type,
          passed: have >= need,
          label,
          detail: missed.length === 0
            ? "All core subjects passed"
            : `Not passed: ${missed.map((id) => nameOf(subjectNames, id)).join(", ")}`,
        };
      }
      default: {
        const failed = scores.filter((v) => v < c.passMark).length;
        return { type: c.type, passed: failed <= c.maxFailed, label, detail: `${plural(failed, "failed subject")} (allows ${c.maxFailed})` };
      }
    }
  });

  const passed = rules.match === "any" ? checks.some((c) => c.passed) : checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);
  const averageNearMiss =
    !passed && failedChecks.length === 1 && failedChecks[0].type === "average" && average != null ? failedChecks[0].min : null;

  return { passed, checks: checks.map(({ min, ...rest }) => rest), averageNearMiss };
}

/**
 * The suggested outcome when the school has its own rule. Same outcomes and the same
 * "on trial" meaning as suggestOutcome; only the test for "meets the standard" changes.
 */
function suggestOutcomeByRules({ average, hasScores, evaluation, trialMargin, isFinalClass }) {
  if (!hasScores) {
    return { outcome: null, reason: "No published results for this student, so there is nothing to suggest from" };
  }
  if (evaluation.passed) {
    return isFinalClass
      ? { outcome: "graduated", reason: "Meets the school's promotion rule; this is the final class" }
      : { outcome: "promoted", reason: "Meets the school's promotion rule" };
  }
  if (!isFinalClass && trialMargin != null && evaluation.averageNearMiss != null && average >= evaluation.averageNearMiss - trialMargin) {
    return { outcome: "trial", reason: `Average ${average} is within ${trialMargin} of the required ${evaluation.averageNearMiss}; every other rule is met` };
  }
  const missed = evaluation.checks.filter((c) => !c.passed).map((c) => c.detail);
  return { outcome: "repeat", reason: `Does not meet the promotion rule: ${missed.join("; ")}` };
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

module.exports = {
  OUTCOMES, BASES, DEFAULT_POLICY, CRITERION_TYPES, sessionAverage, sessionSubjectScores, suggestOutcome,
  validateRules, normalizeRules, describeRules, evaluateRules, suggestOutcomeByRules, validateDecisions, classPromotionStatus };
