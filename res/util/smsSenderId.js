/**
 * Derives an SMS sender ID from the school's own name instead of its
 * internal registration-number prefix (e.g. "DSCS") — an acronym parents
 * don't recognize reads as unfamiliar/spam-like, while the school's actual
 * name is what they'd expect to see show up as the sender.
 *
 * BulkSMSNigeria enforces an 11-character sender ID limit (see
 * BulkSmsService.js), so a long first word is truncated to fit rather than
 * rejected outright.
 *
 * @param {{ name?: string|null, prefix?: string|null }} school
 * @returns {string}
 */
function smsSenderIdFromSchoolName(school) {
  const firstWord = String(school?.name || "").trim().split(/\s+/)[0] || "";
  // SMS gateways typically restrict sender IDs to alphanumeric characters —
  // strip anything else (a possessive apostrophe in "Daniel's", say) rather
  // than risk a provider-side rejection over a character BulkSMSNigeria's
  // own length check would never have caught.
  const cleaned = firstWord.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned) return cleaned.slice(0, 11);
  return school?.prefix || "SCHOOL";
}

module.exports = { smsSenderIdFromSchoolName };
