/**
 * The remark text for a student.
 *
 * The school's score-range scheme gives an automatic remark from the average. A
 * remark the class teacher wrote by hand replaces it; blank falls back to it.
 * Remarks are text on the report card and never feed a calculation.
 */

const MAX_REMARK = 500;

/**
 * The automatic remark: the first rule (highest range first) whose range holds
 * the average, with {studentName} replaced. Empty when nothing matches.
 *
 * @param {Array<{ minScore: number, maxScore: number, remark: string }>} rules ordered by minScore descending
 * @param {number} average
 * @param {string} studentName the name to put where the template says {studentName}
 */
function automaticRemark(rules, average, studentName) {
  const template = rules.find((r) => average >= r.minScore && average <= r.maxScore)?.remark ?? "";
  return template ? template.replace("{studentName}", studentName) : "";
}

/** What the report card shows as the class teacher's remark. */
function effectiveRemark(handWritten, automatic) {
  const text = typeof handWritten === "string" ? handWritten.trim() : "";
  return text || automatic;
}

/**
 * Cleans a remark that was typed in: trimmed, and null when blank (which clears it).
 * Throws a message-bearing Error when it is too long, so nothing is cut off silently.
 */
function cleanRemark(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text.length > MAX_REMARK) throw new Error(`A remark can be at most ${MAX_REMARK} characters`);
  return text || null;
}

module.exports = { MAX_REMARK, automaticRemark, effectiveRemark, cleanRemark };
