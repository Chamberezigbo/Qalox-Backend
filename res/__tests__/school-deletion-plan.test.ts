import { Prisma } from "@prisma/client";
import {
  DETACH_ON_SCHOOL_DELETE,
  NOT_SCHOOL_DATA,
  buildDeletionOrder,
  delegateName,
  deleteSchoolData,
  scopeWhere,
} from "../Services/schoolDeletionPlan";

/**
 * Deleting a school used to fail for every school that had ever been used: the
 * cascade was a hand-written list covering 23 of the 60 tables holding a
 * school's data, and with relationMode = "prisma" the client refuses to delete
 * a parent that still has children. These tests run against the real Prisma
 * schema, so a table added later without a path to deletion fails here rather
 * than in production on someone's school.
 */

const models = Prisma.dmmf.datamodel.models;
const order = buildDeletionOrder();

const hasScalar = (model: Prisma.DMMF.Model, name: string) =>
  model.fields.some((f) => f.kind === "scalar" && f.name === name);

describe("buildDeletionOrder — coverage", () => {
  it("includes every model that carries a schoolId, unless deliberately excluded", () => {
    const forgotten = models
      .filter((m) => m.name !== "School" && hasScalar(m, "schoolId"))
      .map((m) => m.name)
      .filter((name) => !(NOT_SCHOOL_DATA as readonly string[]).includes(name))
      .filter((name) => !order.includes(name));

    expect(forgotten).toEqual([]);
  });

  it("reaches models that only link to a school through a parent", () => {
    // None of these has a schoolId of its own.
    for (const name of ["StudentAnswer", "QuestionOption", "PublishedResultRow", "SchemeOfWorkFile", "BulkImportRecord"]) {
      expect(order).toContain(name);
    }
  });

  it("never includes the school itself, which is deleted last, separately", () => {
    expect(order).not.toContain("School");
  });

  it("never sweeps up marketer or platform-owned records", () => {
    for (const name of NOT_SCHOOL_DATA) {
      expect(order).not.toContain(name);
    }
  });

  it("detaches marketer commissions and leads instead of deleting them", () => {
    // They are the marketer's earnings history, not the school's data.
    expect([...DETACH_ON_SCHOOL_DELETE].sort()).toEqual(["Commission", "MarketerSchoolLead"]);
    for (const name of DETACH_ON_SCHOOL_DELETE) {
      expect(order).not.toContain(name);
    }
  });
});

describe("buildDeletionOrder — ordering", () => {
  it("deletes every model before any model it points at", () => {
    const position = new Map(order.map((name, i) => [name, i]));
    const violations: string[] = [];

    for (const model of models) {
      if (!position.has(model.name)) continue;
      for (const field of model.fields) {
        const isForeignKey = field.kind === "object" && (field.relationFromFields?.length ?? 0) > 0;
        if (!isForeignKey || !position.has(field.type) || field.type === model.name) continue;
        // `model` holds the key, so it has to go first.
        if (position.get(model.name)! > position.get(field.type)!) {
          violations.push(`${model.name} must be deleted before ${field.type}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("deletes students before the classes they sit in, and the admin only after the uploads it made", () => {
    const at = (name: string) => order.indexOf(name);
    expect(at("Student")).toBeLessThan(at("Class"));
    expect(at("SchemeOfWork")).toBeLessThan(at("Admin"));
    expect(at("LessonNote")).toBeLessThan(at("Staff"));
    expect(at("SchoolSubscription")).toBeGreaterThanOrEqual(0);
  });

  it("covers the tables the old cascade forgot", () => {
    // A school with a plan has a subscription, which alone was enough to make
    // the old cascade fail.
    for (const name of [
      "SchoolSubscription",
      "SchoolPayment",
      "Assignment",
      "Attendance",
      "FeeStructure",
      "StudentFee",
      "LessonNote",
      "SchemeOfWork",
      "AiGenerationJob",
      "Test",
      "LoginEvent",
    ]) {
      expect(order).toContain(name);
    }
  });
});

describe("scopeWhere", () => {
  it("scopes a model that has its own schoolId directly", () => {
    expect(scopeWhere("Student", 7)).toEqual({ schoolId: 7 });
  });

  it("scopes a model with no schoolId through its parent chain", () => {
    expect(scopeWhere("QuestionOption", 7)).toEqual({
      question: { test: { schoolId: 7 } },
    });
  });

  it("matches a row reachable by more than one route through any of them", () => {
    // A StudentAnswer hangs off its attempt, its question and its chosen
    // option; each route leads to the same school, so any one is enough.
    const where = scopeWhere("StudentAnswer", 7) as { OR: Array<Record<string, unknown>> };

    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR.map((clause) => Object.keys(clause)[0]).sort()).toEqual(
      ["attempt", "question", "selectedOption"]
    );
  });

  it("returns null for platform and marketer records", () => {
    for (const name of NOT_SCHOOL_DATA) {
      expect(scopeWhere(name, 7)).toBeNull();
    }
  });

  it("returns null for a model with no path to a school at all", () => {
    expect(scopeWhere("BillingPlan", 7)).toBeNull();
    expect(scopeWhere("Coupon", 7)).toBeNull();
  });
});

describe("deleteSchoolData", () => {
  /** A transaction double that records every call, in order. */
  function fakeTx(options: { students?: Array<{ parentId: number | null }>; orphanParents?: number[] } = {}) {
    const calls: string[] = [];

    const delegate = (name: string) => ({
      deleteMany: jest.fn(async () => {
        calls.push(`deleteMany:${name}`);
        return { count: 1 };
      }),
      updateMany: jest.fn(async () => {
        calls.push(`updateMany:${name}`);
        return { count: 1 };
      }),
      delete: jest.fn(async () => {
        calls.push(`delete:${name}`);
        return {};
      }),
      findMany: jest.fn(async () => {
        calls.push(`findMany:${name}`);
        if (name === "student") return options.students ?? [];
        if (name === "parent") return (options.orphanParents ?? []).map((id) => ({ id }));
        return [];
      }),
    });

    const tx: any = new Proxy({}, { get: (target: any, name: string) => (target[name] ??= delegate(name)) });
    return { tx, calls };
  }

  it("deletes the school last", async () => {
    const { tx, calls } = fakeTx();

    const removed = await deleteSchoolData(tx, 7);

    expect(calls[calls.length - 1]).toBe("delete:school");
    expect(removed.School).toBe(1);
  });

  it("detaches marketer commissions before deleting anything", async () => {
    const { tx, calls } = fakeTx();

    await deleteSchoolData(tx, 7);

    const firstDelete = calls.findIndex((c) => c.startsWith("deleteMany:"));
    for (const name of DETACH_ON_SCHOOL_DELETE) {
      const detach = calls.indexOf(`updateMany:${delegateName(name)}`);
      expect(detach).toBeGreaterThanOrEqual(0);
      expect(detach).toBeLessThan(firstDelete);
      // And never deleted outright.
      expect(calls).not.toContain(`deleteMany:${delegateName(name)}`);
    }
  });

  it("issues one delete per model in the planned order", async () => {
    const { tx, calls } = fakeTx();

    await deleteSchoolData(tx, 7);

    const deletes = calls.filter((c) => c.startsWith("deleteMany:")).map((c) => c.replace("deleteMany:", ""));
    const planned = order.map(delegateName);
    expect(deletes.filter((d) => planned.includes(d))).toEqual(planned);
  });

  it("removes a parent whose children were all in this school", async () => {
    const { tx, calls } = fakeTx({ students: [{ parentId: 11 }, { parentId: 11 }], orphanParents: [11] });

    const removed = await deleteSchoolData(tx, 7);

    expect(calls).toContain("deleteMany:parentAlert");
    expect(calls).toContain("deleteMany:parent");
    expect(removed.Parent).toBe(1);
  });

  it("keeps a parent who still has children in another school", async () => {
    // The orphan query finds none: this parent's other child is still enrolled.
    const { tx, calls } = fakeTx({ students: [{ parentId: 11 }], orphanParents: [] });

    const removed = await deleteSchoolData(tx, 7);

    expect(calls).not.toContain("deleteMany:parent");
    expect(removed.Parent).toBeUndefined();
  });

  it("does not look for parents when the school had no students with one", async () => {
    const { tx, calls } = fakeTx({ students: [{ parentId: null }] });

    await deleteSchoolData(tx, 7);

    expect(calls).not.toContain("findMany:parent");
  });
});
