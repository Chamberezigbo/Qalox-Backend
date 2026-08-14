/**
 * BillingPlan.features is a JSON array stored in a MySQL Text column
 * (`features String @db.Text`), so it must be parsed before it reaches a client.
 *
 * Parse defensively. createBillingPlan / updateBillingPlan both JSON.stringify
 * on the way in, so well-formed rows are the norm — but a plan seeded by a
 * migration, a fixture, or manual SQL can hold a bare string. An unguarded
 * JSON.parse turns one such row into a 500 for the *entire* plans endpoint,
 * taking down the whole pricing page rather than degrading one card.
 *
 * Always returns an array, so callers can render it directly.
 *
 * @param {string|null|undefined} raw the stored `features` column value
 * @returns {Array} parsed features, or a best-effort single-item array
 */
const parsePlanFeatures = (raw) => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    // A stored `"text"` parses to a string, not an array — normalise it so the
    // client's contract ("features is always an array") holds.
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (err) {
    // Not JSON at all. Treat the raw value as a single feature.
    return [raw];
  }
};

module.exports = { parsePlanFeatures };
