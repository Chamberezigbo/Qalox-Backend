import { checkDestructiveTestsAllowed } from "./helpers/test-database-guard";

/**
 * The guard decides whether a suite is allowed to delete real rows, so a
 * false "allowed" is a data-loss bug. These cases pin the refusals down —
 * especially the real production URL that prompted the guard in the first place.
 */

const PROD_URL = "mysql://root:secret@hayabusa.proxy.rlwy.net:48402/railway?connect_timeout=60";
const TEST_URL = "mysql://root:secret@localhost:3306/qalox_test";

describe("checkDestructiveTestsAllowed", () => {
  it("refuses when the opt-in is absent", () => {
    const r = checkDestructiveTestsAllowed(TEST_URL, undefined);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/ALLOW_DESTRUCTIVE_TESTS/);
  });

  it("refuses when the opt-in is anything other than exactly \"true\"", () => {
    for (const value of ["1", "yes", "TRUE", "", "false"]) {
      expect(checkDestructiveTestsAllowed(TEST_URL, value).allowed).toBe(false);
    }
  });

  it("refuses the real Railway production URL even with the opt-in set", () => {
    const r = checkDestructiveTestsAllowed(PROD_URL, "true");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/rlwy\.net/);
  });

  it("refuses Railway's internal host too", () => {
    const r = checkDestructiveTestsAllowed(
      "mysql://root:secret@mysql.railway.internal:3306/railway",
      "true"
    );
    expect(r.allowed).toBe(false);
  });

  it("refuses a local database whose name doesn't look like a test database", () => {
    const r = checkDestructiveTestsAllowed("mysql://root:secret@localhost:3306/railway", "true");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/doesn't look like a test database/);
  });

  it("refuses when DATABASE_URL is missing", () => {
    expect(checkDestructiveTestsAllowed(undefined, "true").allowed).toBe(false);
  });

  it("allows a clearly-named local test database with the opt-in set", () => {
    const r = checkDestructiveTestsAllowed(TEST_URL, "true");
    expect(r.allowed).toBe(true);
  });

  it("ignores a query string when reading the database name", () => {
    const r = checkDestructiveTestsAllowed(
      "mysql://root:secret@localhost:3306/qalox_test?connect_timeout=60",
      "true"
    );
    expect(r.allowed).toBe(true);
  });
});
