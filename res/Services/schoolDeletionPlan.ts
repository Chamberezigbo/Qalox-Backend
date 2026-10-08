import { Prisma } from "@prisma/client";

/**
 * Works out, from the Prisma schema itself, everything that belongs to a
 * school and the order it has to be deleted in.
 *
 * This replaced a hand-written list of `deleteMany` calls that had quietly
 * fallen out of date: it covered 23 of the 60 tables that hold a school's
 * data. With `relationMode = "prisma"` there are no database foreign keys, so
 * the client itself refuses to delete a parent row that still has children —
 * and one forgotten table (a subscription, an assignment, a lesson note) made
 * the final `school.delete` fail, which is why Super Admin could not delete any
 * school that had ever been used. A list written by hand goes stale again the
 * next time a model is added; a list derived from the schema cannot.
 */

type Where = Record<string, unknown>;
type Model = Prisma.DMMF.Model;

/**
 * Marketer commissions and leads reference a school through an optional
 * `schoolId`, but they are the marketer's earnings history, not the school's
 * data. Deleting them would erase what a marketer is owed, so they are
 * detached (schoolId set to null) and kept.
 */
export const DETACH_ON_SCHOOL_DELETE = ["Commission", "MarketerSchoolLead"] as const;

/**
 * Platform- and marketer-owned records that must never be swept up by a
 * school's deletion. None of them hold a school's data; they are excluded
 * outright so a relation that happens to run through an Admin row can never
 * pull one in.
 */
export const NOT_SCHOOL_DATA = [
  ...DETACH_ON_SCHOOL_DELETE,
  "WalletTransaction",
  "PayoutRequest",
  "MarketerDocument",
  "SchoolToken",
  "Notification",
  "PlatformCommunication",
  "SystemNotification",
] as const;

const excluded = new Set<string>(NOT_SCHOOL_DATA);

const allModels = (): readonly Model[] => Prisma.dmmf.datamodel.models;

/** Prisma exposes each model on the client under its name with a lowercase first letter. */
export const delegateName = (modelName: string): string =>
  modelName.charAt(0).toLowerCase() + modelName.slice(1);

/** Many-to-one relations: the ones that carry a foreign key on this model. */
const parentRelations = (model: Model) =>
  model.fields.filter((f) => f.kind === "object" && f.relationFromFields && f.relationFromFields.length > 0);

/**
 * The `where` that selects one model's rows belonging to a school, or null when
 * the model has no path to a school.
 *
 *  - a model with its own `schoolId` is scoped by it directly;
 *  - otherwise it is scoped through whichever of its parents are themselves
 *    scoped, so a StudentAnswer is found via its attempt, its test, then the
 *    test's schoolId.
 */
export function scopeWhere(
  modelName: string,
  schoolId: number,
  models: readonly Model[] = allModels(),
  visiting: Set<string> = new Set()
): Where | null {
  if (excluded.has(modelName)) return null;
  if (modelName === "School") return { id: schoolId };

  const model = models.find((m) => m.name === modelName);
  if (!model) return null;

  if (model.fields.some((f) => f.kind === "scalar" && f.name === "schoolId")) {
    return { schoolId };
  }

  // Guards a cycle between models; the schema has none today.
  if (visiting.has(modelName)) return null;
  const nextVisiting = new Set(visiting).add(modelName);

  const clauses: Where[] = [];
  for (const relation of parentRelations(model)) {
    const parentWhere = scopeWhere(relation.type, schoolId, models, nextVisiting);
    if (parentWhere) clauses.push({ [relation.name]: parentWhere });
  }

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

/**
 * Every model that holds school data, ordered so each one is deleted before the
 * models it points at — children first, the school itself last.
 */
export function buildDeletionOrder(models: readonly Model[] = allModels()): string[] {
  // Any schoolId works here: this only asks whether a path to a school exists.
  const scoped = models.filter((m) => m.name !== "School" && scopeWhere(m.name, 0, models) !== null);
  const scopedNames = new Set(scoped.map((m) => m.name));

  // dependents[X] = scoped models holding a foreign key to X, which must go first.
  const dependents = new Map<string, Set<string>>();
  for (const model of scoped) {
    for (const relation of parentRelations(model)) {
      if (relation.type !== model.name && scopedNames.has(relation.type)) {
        if (!dependents.has(relation.type)) dependents.set(relation.type, new Set());
        dependents.get(relation.type)!.add(model.name);
      }
    }
  }

  const ordered: string[] = [];
  const remaining = new Set(scopedNames);

  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) =>
      [...(dependents.get(name) ?? [])].every((child) => !remaining.has(child))
    );

    if (ready.length === 0) {
      throw new Error(
        `Cannot order school deletion — a dependency cycle remains between: ${[...remaining].join(", ")}`
      );
    }

    // Sorted only so the order is stable from run to run.
    ready.sort().forEach((name) => {
      ordered.push(name);
      remaining.delete(name);
    });
  }

  return ordered;
}

/** Stored-file columns, collected before deletion because the rows are gone afterwards. */
const FILE_COLUMNS: Array<{ model: string; column: string }> = [
  { model: "School", column: "logoUrl" },
  { model: "School", column: "stampUrl" },
  { model: "Student", column: "passportUrl" },
  { model: "Assignment", column: "attachmentUrl" },
  { model: "SchemeOfWorkFile", column: "fileUrl" },
];

/**
 * R2 object keys belonging to the school. Values are stored as "r2:<key>";
 * anything else (an older URL, a null) is skipped rather than guessed at.
 */
export async function collectFileKeys(client: any, schoolId: number): Promise<string[]> {
  const keys = new Set<string>();

  for (const { model, column } of FILE_COLUMNS) {
    const where = scopeWhere(model, schoolId);
    if (!where) continue;

    // Nulls are skipped below rather than filtered in the query: some of these
    // columns are required, and Prisma rejects `NOT: { col: null }` on a column
    // that cannot be null.
    const rows: Array<Record<string, string | null>> = await client[delegateName(model)].findMany({
      where,
      select: { [column]: true },
    });

    for (const row of rows) {
      const value = row[column];
      if (typeof value === "string" && value.startsWith("r2:")) keys.add(value.slice(3));
    }
  }

  return [...keys];
}

/**
 * Counts what a deletion would remove, without removing anything. Uses exactly
 * the same filters the deletion does, so it doubles as a check that every one of
 * them is valid against the live database.
 */
export async function previewSchoolDeletion(client: any, schoolId: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const modelName of buildDeletionOrder()) {
    const where = scopeWhere(modelName, schoolId);
    if (!where) continue;
    const count = await client[delegateName(modelName)].count({ where });
    if (count > 0) counts[modelName] = count;
  }

  return counts;
}

/**
 * Deletes everything belonging to a school, then the school. Runs against a
 * transaction client, so a failure part-way leaves nothing deleted.
 *
 * @returns how many rows were removed from each model
 */
export async function deleteSchoolData(tx: any, schoolId: number): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};

  // Parents have no link to a school — a parent belongs to its children — so
  // they are remembered now and revisited once the students are gone.
  const studentRows: Array<{ parentId: number | null }> = await tx.student.findMany({
    where: { schoolId },
    select: { parentId: true },
  });
  const parentIds = [
    ...new Set(studentRows.map((s) => s.parentId).filter((id): id is number => typeof id === "number")),
  ];

  // Marketer earnings outlive the school they came from.
  for (const modelName of DETACH_ON_SCHOOL_DELETE) {
    await tx[delegateName(modelName)].updateMany({ where: { schoolId }, data: { schoolId: null } });
  }

  for (const modelName of buildDeletionOrder()) {
    const where = scopeWhere(modelName, schoolId);
    if (!where) continue;
    const { count } = await tx[delegateName(modelName)].deleteMany({ where });
    if (count > 0) removed[modelName] = count;
  }

  // A parent can have children in more than one school, so only those left
  // with no students at all are removed.
  if (parentIds.length > 0) {
    const orphans: Array<{ id: number }> = await tx.parent.findMany({
      where: { id: { in: parentIds }, children: { none: {} } },
      select: { id: true },
    });
    const orphanIds = orphans.map((p) => p.id);

    if (orphanIds.length > 0) {
      await tx.parentAlert.deleteMany({ where: { parentId: { in: orphanIds } } });
      const { count } = await tx.parent.deleteMany({ where: { id: { in: orphanIds } } });
      if (count > 0) removed.Parent = count;
    }
  }

  await tx.school.delete({ where: { id: schoolId } });
  removed.School = 1;

  return removed;
}
