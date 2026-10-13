const prisma = require("../util/prisma");
const logger = require("../config/logger");
const { AppError } = require("../util/AppError");
const { effectivePassMark } = require("../util/classLadder");
const { syncStudentFeeInvoices } = require("../util/studentFeeSync");
const {
  BASES,
  DEFAULT_POLICY,
  sessionAverage,
  suggestOutcome,
  validateDecisions,
} = require("../util/promotionRules");

/**
 * End-of-session promotion for one class at a time.
 *
 *   preview  read-only: every student's average, suggested outcome and flags
 *   apply    writes the admin's decisions in ONE transaction, and records enough
 *            to put every student back (a PromotionRun with its items)
 *   undo     restores that record, if nothing has been built on top of it yet
 *
 * Nothing is applied from the preview alone: the admin reviews and confirms
 * every student, and may change any outcome.
 */

const ACTIVE = "active";

async function getPolicy(schoolId) {
  const row = await prisma.promotionPolicy.findUnique({ where: { schoolId } });
  return {
    basis: row?.basis ?? DEFAULT_POLICY.basis,
    // A saved null means the trial outcome was switched off; no row means the default.
    trialMargin: row ? row.trialMargin : DEFAULT_POLICY.trialMargin,
  };
}

async function savePolicy(schoolId, { basis, trialMargin }) {
  if (!BASES.includes(basis)) throw new AppError("basis must be all_terms or last_term", 400);
  if (trialMargin !== null && (!Number.isFinite(trialMargin) || trialMargin < 0 || trialMargin > 50)) {
    throw new AppError("The trial margin must be between 0 and 50, or off", 400);
  }

  await prisma.promotionPolicy.upsert({
    where: { schoolId },
    create: { schoolId, basis, trialMargin },
    update: { basis, trialMargin },
  });
  return getPolicy(schoolId);
}

/** The class, its session and who is in it: the common start of preview and apply. */
async function loadClassContext(client, { schoolId, classId, fromSessionId }) {
  const [cls, session] = await Promise.all([
    client.class.findFirst({
      where: { id: classId, schoolId },
      select: { id: true, name: true, customName: true, campusId: true, promotesToClassId: true, passMark: true },
    }),
    client.academicSession.findFirst({ where: { id: fromSessionId, schoolId }, select: { id: true, name: true } }),
  ]);
  if (!cls) throw new AppError("Class not found", 404);
  if (!session) throw new AppError("Session not found", 404);

  // Active students of this class who are still in the closing session. A student
  // already moved into the next session no longer matches, which is what makes
  // running this twice harmless.
  const students = await client.student.findMany({
    where: { schoolId, classId, academicSessionId: fromSessionId, status: ACTIVE },
    select: {
      id: true,
      name: true,
      surname: true,
      otherNames: true,
      registrationNumber: true,
      classGroupId: true,
      campusId: true,
      classGroup: { select: { name: true } },
    },
    orderBy: [{ surname: "asc" }, { name: "asc" }],
  });

  return { cls, session, students };
}

/**
 * Read-only review for one class.
 * @returns the class, policy, pass mark and one entry per student with a suggestion and flags
 */
async function previewClass({ schoolId, classId, fromSessionId }) {
  const { cls, session, students } = await loadClassContext(prisma, { schoolId, classId, fromSessionId });
  const policy = await getPolicy(schoolId);
  const passMark = effectivePassMark(cls);
  const isFinalClass = cls.promotesToClassId == null;
  const ids = students.map((s) => s.id);

  const [rows, terms, fees, sameCampusClasses] = await Promise.all([
    ids.length
      ? prisma.publishedResultRow.findMany({
          where: { studentId: { in: ids }, publishedResult: { academicSessionId: fromSessionId } },
          select: { studentId: true, total: true, publishedResult: { select: { termId: true } } },
        })
      : [],
    prisma.academicTerm.findMany({
      where: { schoolId, sessionId: fromSessionId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
    ids.length
      ? prisma.studentFee.groupBy({
          by: ["studentId"],
          where: { studentId: { in: ids } },
          _sum: { totalFee: true, amountPaid: true },
        })
      : [],
    prisma.class.findMany({
      where: { schoolId, campusId: cls.campusId },
      select: { id: true, name: true, customName: true },
      orderBy: { id: "asc" },
    }),
  ]);

  // Terms that actually have published results, oldest first: "the last term"
  // means the last one the class has results for, not a term still to come.
  const publishedTermIds = new Set(rows.map((r) => r.publishedResult.termId).filter((t) => t != null));
  const termOrder = terms.filter((t) => publishedTermIds.has(t.id)).map((t) => t.id);

  const rowsByStudent = new Map();
  for (const row of rows) {
    if (!rowsByStudent.has(row.studentId)) rowsByStudent.set(row.studentId, []);
    rowsByStudent.get(row.studentId).push({ termId: row.publishedResult.termId, total: row.total });
  }

  const owedByStudent = new Map(
    fees.map((f) => [f.studentId, Math.max(0, (f._sum.totalFee ?? 0) - (f._sum.amountPaid ?? 0))])
  );

  const items = students.map((student) => {
    const { average, termsWithResults } = sessionAverage(
      rowsByStudent.get(student.id) ?? [],
      policy.basis,
      termOrder
    );
    const suggestion = suggestOutcome({ average, passMark, trialMargin: policy.trialMargin, isFinalClass });

    return {
      studentId: student.id,
      name: `${student.surname} ${student.name}${student.otherNames ? " " + student.otherNames : ""}`.trim(),
      registrationNumber: student.registrationNumber,
      groupName: student.classGroup?.name ?? null,
      average,
      suggestedOutcome: suggestion.outcome,
      reason: suggestion.reason,
      // Fewer terms of results than the class has published: worth a look.
      incompleteResults: termOrder.length > 0 && termsWithResults < termOrder.length,
      noResults: average === null,
      amountOwed: owedByStudent.get(student.id) ?? 0,
    };
  });

  const nextClass = cls.promotesToClassId
    ? sameCampusClasses.find((c) => c.id === cls.promotesToClassId) ?? null
    : null;

  return {
    class: { id: cls.id, name: cls.name, customName: cls.customName, campusId: cls.campusId },
    fromSession: session,
    policy,
    passMark,
    isFinalClass,
    nextClass,
    // Where an admin may send a student instead: same campus, never the class itself.
    targetOptions: sameCampusClasses.filter((c) => c.id !== cls.id),
    termsPublished: termOrder.length,
    students: items,
    needsLadder: !isFinalClass && !nextClass,
  };
}

/**
 * Applies the admin's decisions for one class.
 *
 * All or nothing: every student is moved inside one transaction, and each update
 * is guarded on the student still being where the preview saw them, so a change
 * made in another tab cannot be silently overwritten.
 *
 * @param {object} input
 * @param {Array<{ studentId: number, outcome: string, toClassId?: number, toGroupId?: number, reason?: string, average?: number }>} input.decisions
 */
async function applyPromotion({ schoolId, adminId, classId, fromSessionId, toSessionId, decisions }) {
  if (!Number.isInteger(toSessionId) || toSessionId === fromSessionId) {
    throw new AppError("Choose a different session to move students into", 400);
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new AppError("There are no decisions to apply", 400);
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const { cls, students } = await loadClassContext(tx, { schoolId, classId, fromSessionId });

      const toSession = await tx.academicSession.findFirst({
        where: { id: toSessionId, schoolId },
        select: { id: true, name: true },
      });
      if (!toSession) throw new AppError("The session to move into was not found", 404);

      const classes = await tx.class.findMany({
        where: { schoolId },
        select: { id: true, name: true, campusId: true, classGroups: { select: { id: true } } },
      });
      const classById = new Map(classes.map((c) => [c.id, c]));
      const sameCampusClassIds = new Set(
        classes.filter((c) => (c.campusId ?? null) === (cls.campusId ?? null)).map((c) => c.id)
      );

      const problem = validateDecisions({
        cls,
        decisions,
        sameCampusClassIds,
        expectedStudentIds: students.map((s) => s.id),
      });
      if (problem) throw new AppError(problem, 400);

      const studentById = new Map(students.map((s) => [s.id, s]));
      const items = [];

      for (const d of decisions) {
        const student = studentById.get(d.studentId);
        let data;
        let toClass = null;
        let toGroupId = null;

        if (d.outcome === "promoted" || d.outcome === "trial") {
          toClass = classById.get(d.toClassId ?? cls.promotesToClassId);
          // A group belongs to a class, so one is only kept when it is the target's own.
          toGroupId = d.toGroupId && toClass.classGroups.some((g) => g.id === d.toGroupId) ? d.toGroupId : null;
          data = {
            classId: toClass.id,
            classGroupId: toGroupId,
            ...(toClass.campusId != null && { campusId: toClass.campusId }),
            academicSessionId: toSessionId,
          };
        } else if (d.outcome === "repeat") {
          data = { academicSessionId: toSessionId };
        } else {
          // Graduated: leaves the active lists. They stay in the closing session
          // because they are not part of the next one.
          data = { status: "graduated" };
        }

        // Guarded on where the student was seen: a student moved in the meantime
        // matches nothing, and the whole promotion is refused rather than half done.
        const { count } = await tx.student.updateMany({
          where: { id: student.id, schoolId, classId, academicSessionId: fromSessionId, status: ACTIVE },
          data,
        });
        if (count !== 1) {
          throw new AppError(
            `${student.surname} ${student.name} was changed by someone else while you were reviewing. Reload and try again.`,
            409
          );
        }

        if (d.outcome !== "graduated") {
          const enrolledClassId = d.outcome === "repeat" ? classId : toClass.id;
          const fields = {
            schoolId,
            classId: enrolledClassId,
            classGroupId: d.outcome === "repeat" ? student.classGroupId : toGroupId,
            campusId: toClass?.campusId ?? student.campusId ?? null,
          };
          await tx.studentEnrollment.upsert({
            where: { studentId_academicSessionId: { studentId: student.id, academicSessionId: toSessionId } },
            create: { studentId: student.id, academicSessionId: toSessionId, ...fields },
            update: fields,
          });
        }

        items.push({
          studentId: student.id,
          outcome: d.outcome,
          average: typeof d.average === "number" ? d.average : null,
          overrideReason: typeof d.reason === "string" && d.reason.trim() ? d.reason.trim().slice(0, 255) : null,
          fromClassId: classId,
          fromGroupId: student.classGroupId ?? null,
          fromCampusId: student.campusId ?? null,
          fromSessionId,
          fromStatus: ACTIVE,
          toClassId: d.outcome === "graduated" ? null : d.outcome === "repeat" ? classId : toClass.id,
          toGroupId: d.outcome === "repeat" ? student.classGroupId ?? null : toGroupId,
          toCampusId: toClass?.campusId ?? student.campusId ?? null,
        });
      }

      const run = await tx.promotionRun.create({
        data: {
          schoolId,
          classId,
          fromSessionId,
          toSessionId,
          createdByAdminId: adminId ?? null,
          studentCount: items.length,
        },
      });
      await tx.promotionRunItem.createMany({ data: items.map((i) => ({ ...i, runId: run.id })) });

      return { run, items, toSessionName: toSession.name };
    },
    { timeout: 60 * 1000, maxWait: 10 * 1000 }
  );

  // After the commit, per student, because fee invoicing never throws and must not
  // be able to undo the promotion it rides along with. The NEW session's fees are
  // billed: it may not be the active session yet.
  const moving = result.items.filter((i) => i.outcome !== "graduated");
  if (moving.length > 0) {
    const ids = moving.map((i) => i.studentId);
    const before = await prisma.studentFee.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    const knownBefore = new Set(before.map((f) => f.id));

    for (const item of moving) {
      await syncStudentFeeInvoices(
        prisma,
        { id: item.studentId, schoolId, classId: item.toClassId },
        { sessionName: result.toSessionName }
      );
    }

    // Exactly the invoices this promotion raised, kept so undo removes those and
    // nothing else (a date filter cannot tell them from the student's own).
    const after = await prisma.studentFee.findMany({
      where: { studentId: { in: ids }, id: { notIn: [...knownBefore] } },
      select: { id: true, studentId: true },
    });
    const createdByStudent = new Map();
    for (const fee of after) {
      if (!createdByStudent.has(fee.studentId)) createdByStudent.set(fee.studentId, []);
      createdByStudent.get(fee.studentId).push(fee.id);
    }
    for (const [studentId, feeIds] of createdByStudent) {
      await prisma.promotionRunItem.updateMany({
        where: { runId: result.run.id, studentId },
        data: { createdFeeIdsJson: JSON.stringify(feeIds) },
      });
    }
  }

  const counts = result.items.reduce((acc, i) => ({ ...acc, [i.outcome]: (acc[i.outcome] ?? 0) + 1 }), {});
  logger.info("[PROMOTION] Applied", { schoolId, runId: result.run.id, classId, fromSessionId, toSessionId, counts, adminId });

  return { runId: result.run.id, studentCount: result.items.length, counts };
}

/**
 * Puts a whole run back as it was, if nothing has been built on top of it.
 * Refused when scores have been entered in the new session for these students,
 * or when a student has been moved again since, because undoing would then
 * either lose that work or contradict it.
 */
async function undoRun({ schoolId, runId }) {
  const outcome = await prisma.$transaction(
    async (tx) => {
      const run = await tx.promotionRun.findFirst({
        where: { id: runId, schoolId },
        include: { items: true },
      });
      if (!run) throw new AppError("Promotion not found", 404);
      if (run.undoneAt) throw new AppError("This promotion has already been undone", 409);

      const ids = run.items.map((i) => i.studentId);

      const [caRows, examRows, students] = await Promise.all([
        tx.cAResult.count({ where: { studentId: { in: ids }, academicSessionId: run.toSessionId } }),
        tx.examResult.count({ where: { studentId: { in: ids }, academicSessionId: run.toSessionId } }),
        tx.student.findMany({
          where: { id: { in: ids }, schoolId },
          select: { id: true, classId: true, academicSessionId: true, status: true, name: true, surname: true },
        }),
      ]);

      if (caRows + examRows > 0) {
        throw new AppError(
          `Scores have already been entered in the new session for these students (${caRows + examRows} records). Undo would delete that work, so it is not allowed.`,
          409
        );
      }

      const current = new Map(students.map((s) => [s.id, s]));
      for (const item of run.items) {
        const s = current.get(item.studentId);
        if (!s) throw new AppError("A student in this promotion no longer exists", 409);

        const stillThere =
          item.outcome === "graduated"
            ? s.status === "graduated"
            : s.academicSessionId === run.toSessionId && s.classId === item.toClassId;
        if (!stillThere) {
          throw new AppError(
            `${s.surname} ${s.name} has been moved since this promotion, so it cannot be undone cleanly.`,
            409
          );
        }
      }

      for (const item of run.items) {
        await tx.student.updateMany({
          where: { id: item.studentId, schoolId },
          data: {
            classId: item.fromClassId,
            classGroupId: item.fromGroupId,
            campusId: item.fromCampusId,
            academicSessionId: item.fromSessionId,
            status: item.fromStatus,
          },
        });
      }

      const moved = run.items.filter((i) => i.outcome !== "graduated");
      if (moved.length > 0) {
        await tx.studentEnrollment.deleteMany({
          where: { studentId: { in: moved.map((i) => i.studentId) }, academicSessionId: run.toSessionId },
        });

        // The invoices this promotion raised, and only those, and only while no
        // payment has touched them. Anything paid against is left for the bursar.
        const created = moved.flatMap((item) => {
          try {
            return JSON.parse(item.createdFeeIdsJson || "[]");
          } catch {
            return [];
          }
        });
        if (created.length > 0) {
          await tx.studentFee.deleteMany({
            where: { id: { in: created }, amountPaid: 0, payments: { none: {} } },
          });
        }
      }

      await tx.promotionRun.update({ where: { id: run.id }, data: { undoneAt: new Date() } });
      return { restored: run.items.length };
    },
    { timeout: 60 * 1000, maxWait: 10 * 1000 }
  );

  logger.info("[PROMOTION] Undone", { schoolId, runId, restored: outcome.restored });
  return { runId, ...outcome };
}

async function listRuns(schoolId) {
  const runs = await prisma.promotionRun.findMany({
    where: { schoolId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { items: { select: { outcome: true } } },
  });

  const classIds = [...new Set(runs.map((r) => r.classId))];
  const sessionIds = [...new Set(runs.flatMap((r) => [r.fromSessionId, r.toSessionId]))];
  const [classes, sessions] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds }, schoolId }, select: { id: true, name: true } }),
    prisma.academicSession.findMany({ where: { id: { in: sessionIds }, schoolId }, select: { id: true, name: true } }),
  ]);
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const sessionName = new Map(sessions.map((s) => [s.id, s.name]));

  return runs.map((r) => ({
    id: r.id,
    className: className.get(r.classId) ?? `Class ${r.classId}`,
    fromSession: sessionName.get(r.fromSessionId) ?? "",
    toSession: sessionName.get(r.toSessionId) ?? "",
    createdAt: r.createdAt,
    undoneAt: r.undoneAt,
    studentCount: r.studentCount,
    counts: r.items.reduce((acc, i) => ({ ...acc, [i.outcome]: (acc[i.outcome] ?? 0) + 1 }), {}),
  }));
}

module.exports = { getPolicy, savePolicy, previewClass, applyPromotion, undoRun, listRuns };
