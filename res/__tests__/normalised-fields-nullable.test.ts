import fs from "fs";
import path from "path";

/**
 * Controllers normalise a blank form field to `null` before writing it, so the
 * database holds one representation of "not provided". That is only safe when
 * the column is actually nullable.
 *
 * It was not, once. `Student.otherNames` is `String` (NOT NULL), and a commit
 * that added blank-to-null normalisation included it by mistake. Prisma
 * rejected the null, then re-reported the failure against a different input
 * variant and complained that the `academicSession` relation was missing —
 * naming a field that had nothing to do with it. Student registration was
 * broken in production for anyone who left Other Names empty, and the error
 * message sent the search in the wrong direction entirely.
 *
 * So rather than pin that single field, this derives the normalised set from
 * the controller source and checks each one against the schema. A new
 * normaliser over a NOT NULL column fails here instead of in production.
 */

const repoRoot = path.resolve(__dirname, "../..");

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const schema = readSource("prisma/schema.prisma");

/** The body of one `model X { ... }` block. */
function modelBlock(modelName: string): string {
  const match = new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`).exec(schema);
  if (!match) throw new Error(`No model ${modelName} in schema.prisma`);
  return match[0];
}

/** True when the field is declared optional, i.e. its type carries a `?`. */
function isNullable(modelName: string, field: string): boolean {
  const line = new RegExp(`^\\s*${field}\\s+\\S+.*$`, "m").exec(modelBlock(modelName));
  if (!line) throw new Error(`No field ${field} on model ${modelName}`);
  return /^\s*\w+\s+\w+\?/.test(line[0]);
}

/**
 * Finds `const normalizedFoo = foo?.trim() || null;` and returns the source
 * field name — the convention is consistent across these controllers, so new
 * normalisers are picked up without touching this test.
 */
function fieldsNormalisedToNull(source: string): string[] {
  return [...source.matchAll(/const\s+normalized\w+\s*=\s*(\w+)\?\.trim\(\)\s*\|\|\s*null/g)].map(
    (m) => m[1]
  );
}

describe("blank-to-null normalisation only targets nullable columns", () => {
  const cases: Array<[string, string, string]> = [
    ["Student", "res/controller/admin/StudentController.js", "student"],
    ["Staff", "res/controller/admin/StaffController.js", "staff"],
  ];

  for (const [model, controllerPath] of cases) {
    it(`${model}: every field normalised to null is nullable in the schema`, () => {
      const fields = fieldsNormalisedToNull(readSource(controllerPath));

      // A rewrite that drops the convention should fail loudly rather than
      // quietly asserting nothing.
      expect(fields.length).toBeGreaterThan(0);

      const wrong = fields.filter((field) => !isNullable(model, field));
      expect(wrong).toEqual([]);
    });
  }
});

describe("Student.otherNames — the field that broke registration", () => {
  it("is still NOT NULL in the schema", () => {
    // If this ever becomes optional the controller should switch back to null,
    // and the guard below can go.
    expect(isNullable("Student", "otherNames")).toBe(false);
  });

  it("is normalised to an empty string, never null", () => {
    const source = readSource("res/controller/admin/StudentController.js");
    expect(source).toMatch(/const normalizedOtherNames = otherNames\?\.trim\(\) \|\| ""/);
    expect(fieldsNormalisedToNull(source)).not.toContain("otherNames");
  });

  it("matches what the bulk importer writes, so the column holds one blank value", () => {
    // Two representations of "not provided" in one column is the thing to
    // avoid; the importer got here first, so it sets the convention.
    expect(readSource("res/Services/BulkImportImporter.js")).toMatch(/otherNames:\s*""/);
  });
});
