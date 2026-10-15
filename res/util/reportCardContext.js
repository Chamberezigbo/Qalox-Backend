const { sessionAverage } = require("./promotionRules");

/**
 * Rules and lookups behind the extra lines on a report card: when the school
 * resumes, whether this is the session's closing term, and where the student
 * went next. The pure functions take plain data so every rule is pinned by a
 * test; the loaders do the reads.
 */

const OUTCOME_LABELS = {
  promoted: "Promoted",
  trial: "Promoted on trial",
  repeat: "To repeat",
  graduated: "Graduated",
};

/** Terms in the order they happen. createdAt can tie, so id breaks it. */
function orderTerms(terms) {
  return [...terms].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return diff !== 0 ? diff : a.id - b.id;
  });
}

/** A date column as YYYY-MM-DD, or null. Never falls back to today. */
function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

/**
 * The date the school resumes after the term being viewed.
 *
 * The next term of the same session if there is one; for the session's last
 * term, the first term of the next session. A missing date is null so the card
 * shows a dash. It used to be today's date, which read as a real resumption
 * date on every last-term report card.
 *
 * @param {Array<{ id: number, createdAt: Date, resumptionDate: Date | null }>} sessionTerms
 * @param {number | null} currentTermId
 * @param {Array<{ id: number, createdAt: Date, resumptionDate: Date | null }>} nextSessionTerms
 */
function resumptionDateFor(sessionTerms, currentTermId, nextSessionTerms = []) {
  const ordered = orderTerms(sessionTerms);
  const index = currentTermId ? ordered.findIndex((t) => t.id === currentTermId) : -1;
  if (index < 0) return null;

  if (index < ordered.length - 1) return dateOnly(ordered[index + 1].resumptionDate);

  const nextFirst = orderTerms(nextSessionTerms)[0];
  return nextFirst ? dateOnly(nextFirst.resumptionDate) : null;
}

/**
 * Whether the term being viewed is the last one this class has published for the
 * session. "Last" means the last with results, not a term still to come.
 */
function isLastPublishedTerm(sessionTerms, publishedTermIds, currentTermId) {
  if (!currentTermId) return false;
  const published = new Set(publishedTermIds);
  const order = orderTerms(sessionTerms).filter((t) => published.has(t.id));
  return order.length > 0 && order[order.length - 1].id === currentTermId;
}

/** "Promoted to SS 1", "To repeat JSS 2", "Graduated". Null when there is no outcome. */
function promotionLabel(outcome, toClassName) {
  const base = OUTCOME_LABELS[outcome];
  if (!base) return null;
  if (outcome === "graduated") return base;
  return toClassName ? `${base} to ${toClassName}` : base;
}

const className = (c) => (c.customName ? `${c.name} — ${c.customName}` : c.name);

/**
 * What the report card says about the session as a whole. Null unless this is the
 * closing term, so a First Term card never claims an outcome.
 *
 * @returns {Promise<null | { sessionAverage: number | null, termsWithResults: number, promotion: null | { outcome: string, toClassName: string | null, label: string } }>}
 */
async function loadSessionSummary(client, { schoolId, studentId, classId, sessionId, termId, sessionTerms }) {
  const published = await client.publishedResult.findMany({
    where: { classId, academicSessionId: sessionId, termId: { not: null } },
    select: { termId: true },
    distinct: ["termId"],
  });
  const publishedTermIds = published.map((p) => p.termId);
  if (!isLastPublishedTerm(sessionTerms, publishedTermIds, termId)) return null;

  const rows = await client.publishedResultRow.findMany({
    where: { studentId, publishedResult: { academicSessionId: sessionId, classId } },
    select: { total: true, publishedResult: { select: { termId: true } } },
  });
  const termOrder = orderTerms(sessionTerms)
    .filter((t) => publishedTermIds.includes(t.id))
    .map((t) => t.id);
  const { average, termsWithResults } = sessionAverage(
    rows.map((r) => ({ termId: r.publishedResult.termId, total: r.total })),
    "all_terms",
    termOrder
  );

  // The run that moved this student out of THIS session. An undone run leaves
  // nothing to show, and no run means no claim is made at all.
  const item = await client.promotionRunItem.findFirst({
    where: { studentId, fromSessionId: sessionId, run: { undoneAt: null, schoolId } },
    orderBy: { runId: "desc" },
    select: { outcome: true, toClassId: true },
  });

  let promotion = null;
  if (item) {
    let toClassName = null;
    if (item.toClassId) {
      const target = await client.class.findFirst({
        where: { id: item.toClassId, schoolId },
        select: { name: true, customName: true },
      });
      toClassName = target ? className(target) : null;
    }
    promotion = {
      outcome: item.outcome,
      toClassName,
      label: promotionLabel(item.outcome, toClassName),
    };
  }

  return { sessionAverage: average, termsWithResults, promotion };
}

/**
 * Everyone who was in `classId` during `sessionId`, which is who a class
 * position is ranked among. After a promotion the classmates have moved on, so
 * Student.classId is no longer the answer: the enrollment history is. Students
 * with no history row for the session fall back to their current class.
 */
async function classmateIdsForSession(client, { classId, sessionId }) {
  const enrolled = await client.studentEnrollment.findMany({
    where: { classId, academicSessionId: sessionId },
    select: { studentId: true },
  });
  const legacy = await client.student.findMany({
    where: {
      classId,
      academicSessionId: sessionId,
      enrollments: { none: { academicSessionId: sessionId } },
    },
    select: { id: true },
  });
  return [...new Set([...enrolled.map((e) => e.studentId), ...legacy.map((s) => s.id)])];
}

module.exports = {
  orderTerms,
  resumptionDateFor,
  isLastPublishedTerm,
  promotionLabel,
  loadSessionSummary,
  classmateIdsForSession,
};
