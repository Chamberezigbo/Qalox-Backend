/**
 * The rules of the result workflow: Subject Teacher -> Class Teacher -> Admin.
 *
 * Pure functions with no database access, so every transition and every status
 * shown to a user is pinned by a test. The services feed them real rows.
 *
 * A subject's submission moves through:
 *
 *   (none) --submit--> SUBMITTED --accept--> ACCEPTED --admin approves--> published
 *                         |                     |
 *                         +------ return ------+--> RETURNED --resubmit--> SUBMITTED
 *
 * PENDING and REJECTED are the legacy statuses of the old direct-to-admin flow.
 * They are still understood so nothing in flight is stranded.
 */

/** While a subject is in one of these, its scores cannot be edited. */
const LOCKING_STATUSES = ["PENDING", "SUBMITTED", "ACCEPTED"];

/** Statuses that count as "the class teacher has this subject" for a compilation. */
const INCLUDED_STATUSES = ["ACCEPTED", "PENDING"];

const COMPILATION = { SUBMITTED: "SUBMITTED", RETURNED: "RETURNED", APPROVED: "APPROVED" };

const isLocked = (status) => LOCKING_STATUSES.includes(status);

/**
 * Of several submissions for the same subject (a reassigned subject can have two
 * teachers' rows), the one that decides what the class teacher sees.
 */
const PRECEDENCE = ["ACCEPTED", "SUBMITTED", "PENDING", "RETURNED", "REJECTED"];
function pickSubmission(submissions) {
  let best = null;
  for (const s of submissions) {
    if (!best || PRECEDENCE.indexOf(s.status) < PRECEDENCE.indexOf(best.status)) best = s;
  }
  return best;
}

/**
 * What the class teacher sees for one subject.
 *
 * published        the admin has approved it
 * accepted         accepted by the class teacher (or a legacy pending row)
 * own              the class teacher's own subject: included automatically
 * submitted        with the class teacher, waiting for review
 * returned         sent back to the subject teacher
 * not_submitted    nothing from the subject teacher yet
 *
 * @param {object} input
 * @param {{ status: string } | null} input.submission the deciding submission row
 * @param {boolean} input.isOwn the class teacher teaches this subject in this class
 * @param {boolean} input.published a PublishedResult exists for the term
 */
function subjectState({ submission, isOwn, published }) {
  if (published) return "published";
  if (submission) {
    if (INCLUDED_STATUSES.includes(submission.status)) return "accepted";
    if (submission.status === "SUBMITTED") return "submitted";
    if (submission.status === "RETURNED") return "returned";
  }
  if (isOwn) return "own";
  return "not_submitted";
}

/** A subject counts toward the class compilation in these states. */
const isIncluded = (state) => state === "accepted" || state === "own" || state === "published";

/**
 * What the class teacher may do to a subject submission.
 *
 * Accept only what is waiting. Return what is waiting, or what was accepted as
 * long as the class has not gone to the admin (once it has, the admin returns the
 * whole class first). Nothing changes once the subject is published.
 *
 * @param {object} input
 * @param {string} input.status the submission's status
 * @param {boolean} input.autoAccepted it is the class teacher's own subject
 * @param {string | null} input.compilationStatus the class compilation's status, if any
 * @param {boolean} input.published
 * @returns {{ accept: boolean, return: boolean, reason: string | null }}
 */
function reviewActions({ status, autoAccepted = false, compilationStatus = null, published = false }) {
  if (published) return { accept: false, return: false, reason: "These results have been approved and published" };
  if (autoAccepted) return { accept: false, return: false, reason: "This is your own subject; it is included automatically" };

  const withAdmin = compilationStatus === COMPILATION.SUBMITTED || compilationStatus === COMPILATION.APPROVED;

  if (status === "SUBMITTED") {
    // A waiting subject can be reviewed even while the class is with the admin?
    // No: the class is frozen with the admin, so nothing is reviewed until it comes back.
    if (withAdmin) return { accept: false, return: false, reason: "The class results are with the admin" };
    return { accept: true, return: true, reason: null };
  }
  if (status === "ACCEPTED") {
    if (withAdmin) return { accept: false, return: false, reason: "The class results are with the admin" };
    return { accept: false, return: true, reason: null };
  }
  if (status === "RETURNED") return { accept: false, return: false, reason: "Already returned to the subject teacher" };
  return { accept: false, return: false, reason: "This submission is not waiting for review" };
}

/**
 * Whether the class teacher can submit the compilation, and what must be
 * acknowledged first. Missing subjects and incomplete students are reported, not
 * forbidden (the class teacher decides); having nothing at all is forbidden.
 *
 * @param {object} input
 * @param {Array<{ subjectId: number, name: string, state: string }>} input.subjects
 * @param {Array<{ studentId: number, name: string, missingSubjects: string[] }>} input.incompleteStudents
 * @param {string | null} input.compilationStatus
 * @param {boolean} [input.hasGradingScheme]
 * @returns {{ canSubmit: boolean, blocker: string | null, missingSubjects: object[], needsAcknowledgement: boolean }}
 */
function compilationReadiness({ subjects, incompleteStudents, compilationStatus, hasGradingScheme = true }) {
  if (compilationStatus === COMPILATION.SUBMITTED) {
    return { canSubmit: false, blocker: "The class results are already with the admin", missingSubjects: [], needsAcknowledgement: false };
  }
  if (compilationStatus === COMPILATION.APPROVED) {
    return { canSubmit: false, blocker: "These class results have been approved", missingSubjects: [], needsAcknowledgement: false };
  }

  // Publishing computes grades from the class's grading scheme and refuses without
  // one, so the admin could never approve this: say so now, to the right person.
  if (!hasGradingScheme) {
    return {
      canSubmit: false,
      blocker: "No grading scheme has been assigned to this class yet. Ask the admin to assign one.",
      missingSubjects: [],
      needsAcknowledgement: false,
    };
  }

  const included = subjects.filter((s) => isIncluded(s.state));
  const missingSubjects = subjects.filter((s) => !isIncluded(s.state)).map((s) => ({ subjectId: s.subjectId, name: s.name, state: s.state }));

  if (subjects.length === 0) {
    return { canSubmit: false, blocker: "This class has no subjects", missingSubjects, needsAcknowledgement: false };
  }
  if (included.length === 0) {
    return { canSubmit: false, blocker: "No subject has been accepted yet", missingSubjects, needsAcknowledgement: false };
  }

  return {
    canSubmit: true,
    blocker: null,
    missingSubjects,
    needsAcknowledgement: missingSubjects.length > 0 || incompleteStudents.length > 0,
  };
}

/** Whether the admin may approve or return this compilation. */
function adminCanReview(compilationStatus) {
  return compilationStatus === COMPILATION.SUBMITTED;
}

module.exports = {
  LOCKING_STATUSES,
  INCLUDED_STATUSES,
  COMPILATION,
  isLocked,
  pickSubmission,
  subjectState,
  isIncluded,
  reviewActions,
  compilationReadiness,
  adminCanReview,
};
