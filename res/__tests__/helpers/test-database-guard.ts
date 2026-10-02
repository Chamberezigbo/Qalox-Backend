/**
 * Guard for tests that write to or delete from a real database.
 *
 * Why this exists: grading-endpoints.test.ts calls
 * `prisma.gradingSchemeClass.deleteMany()` in beforeAll, unmocked. Run with
 * production credentials in .env, it silently deletes real grading-scheme
 * assignments and breaks result computation for those classes. That never
 * fired only because the production database happened to be unreachable from
 * a developer laptop — an accident, not a safeguard, and one that disappeared
 * the moment a connection timeout was raised.
 *
 * So destructive tests are opt-in: they run only when ALLOW_DESTRUCTIVE_TESTS
 * is explicitly set AND the connection string doesn't look like production.
 * Both conditions matter — the env var alone would still let someone wipe
 * production by setting it with the wrong .env loaded.
 */

/** Hosts that are never acceptable for a destructive test run. */
const PRODUCTION_HOST_MARKERS = [
  "rlwy.net", // Railway's public TCP proxy
  "railway.internal", // Railway's private network
  "amazonaws.com",
  "azure.com",
  "digitalocean.com",
  "planetscale.com",
];

/** Names that positively identify a throwaway database. */
const TEST_DATABASE_MARKERS = ["test", "_test", "staging", "local", "dev"];

export interface GuardResult {
  allowed: boolean;
  reason: string;
}

/**
 * @param databaseUrl defaults to process.env.DATABASE_URL
 * @param optIn defaults to process.env.ALLOW_DESTRUCTIVE_TESTS
 */
export function checkDestructiveTestsAllowed(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  optIn: string | undefined = process.env.ALLOW_DESTRUCTIVE_TESTS
): GuardResult {
  if (optIn !== "true") {
    return {
      allowed: false,
      reason:
        "ALLOW_DESTRUCTIVE_TESTS is not set to \"true\". These tests delete real rows, so they are opt-in.",
    };
  }

  if (!databaseUrl) {
    return { allowed: false, reason: "DATABASE_URL is not set." };
  }

  const lower = databaseUrl.toLowerCase();

  const productionMarker = PRODUCTION_HOST_MARKERS.find((marker) => lower.includes(marker));
  if (productionMarker) {
    return {
      allowed: false,
      reason: `DATABASE_URL points at what looks like a hosted/production database ("${productionMarker}"). Refusing to run destructive tests against it.`,
    };
  }

  // The database name is the last path segment, before any query string.
  const dbName = lower.split("?")[0].split("/").pop() ?? "";
  const looksLikeTestDb = TEST_DATABASE_MARKERS.some((marker) => dbName.includes(marker));
  if (!looksLikeTestDb) {
    return {
      allowed: false,
      reason: `Database name "${dbName}" doesn't look like a test database (expected it to contain one of: ${TEST_DATABASE_MARKERS.join(", ")}).`,
    };
  }

  return { allowed: true, reason: `Running against test database "${dbName}".` };
}

/**
 * Returns jest's `describe` when destructive tests are allowed, and
 * `describe.skip` otherwise — with a loud explanation on the console.
 *
 * Skipping rather than failing is deliberate: a missing test database is a
 * setup condition, not a code defect, and a suite that can never pass trains
 * people to ignore red. The console warning is what stops a skip from being
 * mistaken for a pass.
 */
export function describeIfDestructiveAllowed(suiteName: string): jest.Describe {
  const { allowed, reason } = checkDestructiveTestsAllowed();

  if (!allowed) {
    // eslint-disable-next-line no-console
    console.warn(
      [
        "",
        "=".repeat(72),
        `SKIPPED (destructive): ${suiteName}`,
        `  ${reason}`,
        "",
        "  These tests delete real grading-scheme assignments. To run them,",
        "  point DATABASE_URL at a throwaway database whose name contains",
        '  "test", then set ALLOW_DESTRUCTIVE_TESTS=true.',
        "=".repeat(72),
        "",
      ].join("\n")
    );
    return describe.skip;
  }

  return describe;
}
