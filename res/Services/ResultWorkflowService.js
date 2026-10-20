const prisma = require("../util/prisma");
const logger = require("../config/logger");
const { AppError } = require("../util/AppError");
const { createNotification } = require("../util/notify");
const rules = require("../util/resultWorkflowRules");
const { automaticRemark, cleanRemark } = require("../util/remarkRules");
const { classDisplayName, usableCustomName } = require("../util/classLabel");
const {
  UNGROUPED,
  studentScopeWhere,
  scopeLabel,
  parseScope,
  scopesOfClass,
  classTeacherOfScope,
} = require("../util/resultScope");

/**
 * Subject Teacher -> Class Teacher -> Admin.
 *
 * A subject teacher submits a subject to the class's teacher (the submission
 * itself lives in TeacherService, which reuses the readiness rules it always
 * had). This service owns everything after that: the class teacher's review, the
 * class compilation they send to the admin, and the admin's decision.
 *
 * Every state change runs in a transaction that locks the row it changes
 * (SELECT ... FOR UPDATE), so a double click or two reviewers cannot apply the
 * same step twice, and every step is written to ResultWorkflowEvent, which is
 * never updated or deleted.
 *
 * Publishing is NOT reimplemented: approval calls AssessmentService.publishResults
 * for each accepted subject, so the frozen snapshot, positions, student
 * notifications and parent alerts are exactly what they were.
 */

const fail = (status, message, code, details) =>
  Object.assign(new AppError(message, status), { code, ...(details && { details }) });

const COMMENT_MIN = 3;
const COMMENT_MAX = 1000;

const cleanComment = (value, { required }) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && text.length < COMMENT_MIN) {
    throw fail(400, "Write a short comment explaining what needs correcting", "COMMENT_REQUIRED");
  }
  return text ? text.slice(0, COMMENT_MAX) : null;
};

/** The session and term a request is about: the one named, else the active term. */
async function resolveSessionTerm(client, schoolId, termId) {
  if (termId) {
    const term = await client.academicTerm.findFirst({
      where: { id: termId, schoolId },
      select: { id: true, name: true, sessionId: true },
    });
    if (!term) throw fail(404, "Term not found", "TERM_NOT_FOUND");
    return { termId: term.id, termName: term.name, sessionId: term.sessionId };
  }
  const active = await client.academicTerm.findFirst({
    where: { schoolId, isActive: true },
    select: { id: true, name: true, sessionId: true },
  });
  if (!active) throw fail(409, "There is no active term. Choose a term.", "NO_ACTIVE_TERM");
  return { termId: active.id, termName: active.name, sessionId: active.sessionId };
}

const recordEvent = (client, data) =>
  client.resultWorkflowEvent.create({ data: { comment: null, ...data } });

/**
 * The class, if this staff member is the class teacher of this scope (a class
 * group, or the class itself for students in no group). Anyone else is refused.
 */
async function assertClassTeacher(client, { schoolId, classId, staffId, classGroupId = UNGROUPED }) {
  const target = await classTeacherOfScope(client, { schoolId, classId, scope: classGroupId });
  if (!target.cls) throw fail(404, "Class not found", "CLASS_NOT_FOUND");
  if (!target.valid) throw fail(404, "That group is not in this class", "GROUP_NOT_FOUND");
  if (target.staffId !== staffId) {
    throw fail(403, "You are not the class teacher of this class", "NOT_CLASS_TEACHER");
  }
  return { ...target.cls, groupName: target.groupName, classGroupId };
}

const lockRow = async (tx, table, id) => {
  // Table names are constants below, never user input.
  const rows = await tx.$queryRawUnsafe(`SELECT status FROM ${table} WHERE id = ? FOR UPDATE`, id);
  return rows?.[0] ?? null;
};

// ---------------------------------------------------------------------------
// The state of one class for one term
// ---------------------------------------------------------------------------

/**
 * Everything the class teacher (and the admin) need to see: each subject's
 * state, who teaches it, which students are missing scores in the subjects that
 * count, and whether the class can be submitted.
 */
async function loadClassState(client, { schoolId, cls, classGroupId = UNGROUPED, teacherStaffId, sessionId, termId }) {
  const classSubjects = await client.classSubject.findMany({
    where: { classId: cls.id },
    select: { subject: { select: { id: true, name: true } } },
  });
  const subjects = classSubjects.map((c) => c.subject).sort((a, b) => a.name.localeCompare(b.name));
  const subjectIds = subjects.map((s) => s.id);

  const [assignments, allSubmissions, students, compilation, schemes] = await Promise.all([
    client.teacherAssignment.findMany({
      where: { classId: cls.id, subjectId: { in: subjectIds } },
      select: { staffId: true, subjectId: true, staff: { select: { id: true, name: true } } },
    }),
    client.resultSubmission.findMany({
      where: { classId: cls.id, academicSessionId: sessionId, termId, subjectId: { in: subjectIds } },
      select: {
        id: true, subjectId: true, staffId: true, status: true, returnComment: true,
        submittedAt: true, reviewedAt: true, autoAccepted: true, classGroupId: true,
        staff: { select: { name: true } },
      },
    }),
    client.student.findMany({
      where: { schoolId, classId: cls.id, academicSessionId: sessionId, status: "active", ...studentScopeWhere(classGroupId) },
      select: { id: true, name: true, surname: true, otherNames: true, registrationNumber: true },
      orderBy: [{ surname: "asc" }, { name: "asc" }],
    }),
    client.classCompilation.findUnique({
      where: { classId_academicSessionId_termId_classGroupId: { classId: cls.id, academicSessionId: sessionId, termId, classGroupId } },
    }),
    client.gradingSchemeClass.count({ where: { classId: cls.id } }),
  ]);

  // This scope's submissions. A legacy submission from before class teachers
  // (PENDING, no group) was for the whole class, so it counts for every scope.
  const submissions = allSubmissions.filter(
    (sub) => sub.classGroupId === classGroupId || (sub.status === "PENDING" && sub.classGroupId === UNGROUPED)
  );

  // A subject is published for the scope when every one of its students has a
  // published row: a class's groups are approved one at a time.
  const studentIdList = students.map((st) => st.id);
  const publishedRows = studentIdList.length
    ? await client.publishedResultRow.findMany({
        where: { studentId: { in: studentIdList }, publishedResult: { classId: cls.id, academicSessionId: sessionId, termId } },
        select: { studentId: true, publishedResult: { select: { subjectId: true } } },
      })
    : [];
  const publishedBySubject = new Map();
  for (const row of publishedRows) {
    const set = publishedBySubject.get(row.publishedResult.subjectId) ?? new Set();
    set.add(row.studentId);
    publishedBySubject.set(row.publishedResult.subjectId, set);
  }
  const publishedIds = new Set(
    [...publishedBySubject.entries()].filter(([, set]) => set.size >= studentIdList.length).map(([id]) => id)
  );

  const subjectRows = subjects.map((subject) => {
    const mine = assignments.filter((a) => a.subjectId === subject.id);
    const picked = rules.pickSubmission(submissions.filter((s) => s.subjectId === subject.id));
    // The class teacher's own subject, unless another teacher's submission exists
    // for it, in which case that submission decides.
    const isOwn = mine.some((a) => a.staffId === teacherStaffId);
    const isPublished = publishedIds.has(subject.id);
    const state = rules.subjectState({ submission: picked, isOwn, published: isPublished });

    return {
      subjectId: subject.id,
      name: subject.name,
      state,
      teachers: [...new Map(mine.map((a) => [a.staff.id, a.staff.name])).values()],
      submissionId: picked?.id ?? null,
      status: picked?.status ?? null,
      submittedBy: picked?.staff?.name ?? null,
      submittedAt: picked?.submittedAt ?? null,
      returnComment: picked?.status === "RETURNED" ? picked.returnComment : null,
      autoAccepted: picked?.autoAccepted ?? false,
      actions: picked
        ? rules.reviewActions({
            status: picked.status,
            autoAccepted: picked.autoAccepted,
            compilationStatus: compilation?.status ?? null,
            published: isPublished,
          })
        : { accept: false, return: false, reason: null },
    };
  });

  // Who is missing a score in the subjects that will be in the class results.
  const counted = subjectRows.filter((s) => rules.isIncluded(s.state));
  const studentIds = students.map((s) => s.id);
  const incompleteStudents = [];

  if (counted.length > 0 && studentIds.length > 0) {
    const countedIds = counted.map((s) => s.subjectId);
    const [caScores, examScores] = await Promise.all([
      client.cAResult.findMany({
        where: { academicSessionId: sessionId, termId, studentId: { in: studentIds }, ca: { classId: cls.id, subjectId: { in: countedIds } } },
        select: { studentId: true, ca: { select: { subjectId: true } } },
      }),
      client.examResult.findMany({
        where: { academicSessionId: sessionId, termId, studentId: { in: studentIds }, exam: { classId: cls.id, subjectId: { in: countedIds } } },
        select: { studentId: true, exam: { select: { subjectId: true } } },
      }),
    ]);

    const scored = new Set();
    for (const r of caScores) scored.add(`${r.studentId}:${r.ca.subjectId}`);
    for (const r of examScores) scored.add(`${r.studentId}:${r.exam.subjectId}`);

    for (const student of students) {
      const missing = counted.filter((s) => !scored.has(`${student.id}:${s.subjectId}`)).map((s) => s.name);
      if (missing.length > 0) {
        incompleteStudents.push({
          studentId: student.id,
          name: `${student.surname} ${student.name}${student.otherNames ? " " + student.otherNames : ""}`.trim(),
          registrationNumber: student.registrationNumber,
          missingSubjects: missing,
        });
      }
    }
  }

  const readiness = rules.compilationReadiness({
    subjects: subjectRows,
    incompleteStudents,
    compilationStatus: compilation?.status ?? null,
    hasGradingScheme: schemes > 0,
  });

  return {
    subjects: subjectRows,
    classGroupId,
    studentCount: students.length,
    incompleteStudents,
    readiness,
    hasGradingScheme: schemes > 0,
    compilation: compilation
      ? {
          id: compilation.id,
          status: compilation.status,
          round: compilation.round,
          submittedAt: compilation.submittedAt,
          reviewedAt: compilation.reviewedAt,
          returnComment: compilation.status === "RETURNED" ? compilation.returnComment : null,
        }
      : null,
  };
}

/** The history of one scope's term, oldest first, with the people's names. */
async function loadHistory(client, { schoolId, classId, classGroupId = UNGROUPED, sessionId, termId }) {
  const events = await client.resultWorkflowEvent.findMany({
    where: { schoolId, classId, classGroupId, academicSessionId: sessionId, termId },
    orderBy: { id: "asc" },
  });
  const staffIds = [...new Set(events.filter((e) => e.actorType === "teacher").map((e) => e.actorId))];
  const adminIds = [...new Set(events.filter((e) => e.actorType === "admin").map((e) => e.actorId))];
  const subjectIds = [...new Set(events.map((e) => e.subjectId).filter((id) => id != null))];

  const [staff, admins, subjects] = await Promise.all([
    staffIds.length ? client.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [],
    adminIds.length ? client.admin.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [],
    subjectIds.length ? client.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }) : [],
  ]);
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const adminName = new Map(admins.map((a) => [a.id, a.name]));
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

  return events.map((e) => ({
    id: e.id,
    action: e.action,
    actor: (e.actorType === "admin" ? adminName : staffName).get(e.actorId) ?? "Unknown",
    actorType: e.actorType,
    subject: e.subjectId ? (subjectName.get(e.subjectId) ?? null) : null,
    comment: e.comment,
    createdAt: e.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Class teacher
// ---------------------------------------------------------------------------

/**
 * The scopes this teacher is the class teacher of: classes they are class teacher
 * of (for students in no group, or the whole class when it has no groups) and
 * groups they are class teacher of. Also what decides whether they see the screen.
 */
async function classesForClassTeacher({ schoolId, staffId }) {
  const [ownClasses, ownGroups] = await Promise.all([
    prisma.class.findMany({
      where: { schoolId, staffId },
      select: { id: true, name: true, customName: true },
      orderBy: [{ name: "asc" }],
    }),
    prisma.classGroup.findMany({
      where: { staffId, class: { schoolId } },
      select: { id: true, name: true, classId: true, class: { select: { id: true, name: true, customName: true } } },
      orderBy: [{ name: "asc" }],
    }),
  ]);

  const active = await prisma.academicSession.findFirst({ where: { schoolId, isActive: true }, select: { id: true } });
  const scopes = [];

  for (const cls of ownClasses) {
    // A class with groups only has a class-level scope when some students are in none.
    let show = true;
    if (active) {
      const all = await scopesOfClass(prisma, { schoolId, classId: cls.id, sessionId: active.id });
      const mine = all.find((sc) => sc.classGroupId === UNGROUPED);
      show = !!mine || all.length === 0;
    }
    if (show) {
      scopes.push({
        classId: cls.id, classGroupId: UNGROUPED, name: cls.name, customName: usableCustomName(cls.customName), groupName: null,
        label: scopeLabel(classDisplayName(cls.name, cls.customName), null),
      });
    }
  }
  for (const group of ownGroups) {
    const className = classDisplayName(group.class.name, group.class.customName);
    scopes.push({
      classId: group.classId, classGroupId: group.id, name: group.class.name, customName: usableCustomName(group.class.customName),
      groupName: group.name, label: scopeLabel(className, group.name),
    });
  }
  return scopes;
}

async function classOverview({ schoolId, staffId, classId, classGroupId = UNGROUPED, termId }) {
  const cls = await assertClassTeacher(prisma, { schoolId, classId, staffId, classGroupId });
  const { sessionId, termId: resolvedTermId, termName } = await resolveSessionTerm(prisma, schoolId, termId);

  const [state, history] = await Promise.all([
    loadClassState(prisma, { schoolId, cls, classGroupId, teacherStaffId: staffId, sessionId, termId: resolvedTermId }),
    loadHistory(prisma, { schoolId, classId, classGroupId, sessionId, termId: resolvedTermId }),
  ]);

  return {
    class: { id: cls.id, name: cls.name, customName: usableCustomName(cls.customName) },
    classGroupId,
    groupName: cls.groupName,
    label: scopeLabel(classDisplayName(cls.name, cls.customName), cls.groupName),
    academicSessionId: sessionId,
    termId: resolvedTermId,
    termName,
    ...state,
    history,
  };
}

/** Loads a submission and checks the caller is the class teacher of its scope. */
async function loadSubmissionForReview(client, { schoolId, staffId, submissionId }) {
  const submission = await client.resultSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, classId: true, subjectId: true, academicSessionId: true, termId: true,
      staffId: true, status: true, autoAccepted: true, classGroupId: true,
      class: { select: { id: true, schoolId: true, staffId: true, name: true } },
      subject: { select: { name: true } },
    },
  });
  if (!submission || submission.class.schoolId !== schoolId) {
    throw fail(404, "Submission not found", "SUBMISSION_NOT_FOUND");
  }
  const target = await classTeacherOfScope(client, { schoolId, classId: submission.classId, scope: submission.classGroupId });
  if (target.staffId !== staffId) {
    throw fail(403, "You are not the class teacher of this class", "NOT_CLASS_TEACHER");
  }
  return { ...submission, groupName: target.groupName };
}

/** Shared by accept and return: lock, re-check the rules against the locked row, write, record. */
async function reviewSubmission({ schoolId, staffId, submissionId, action, comment }) {
  const initial = await loadSubmissionForReview(prisma, { schoolId, staffId, submissionId });

  const outcome = await prisma.$transaction(
    async (tx) => {
      // The status and the class's compilation are read AFTER taking the lock.
      const locked = await lockRow(tx, "result_submissions", submissionId);
      if (!locked) throw fail(404, "Submission not found", "SUBMISSION_NOT_FOUND");

      const [compilation, scopeStudents] = await Promise.all([
        tx.classCompilation.findUnique({
          where: {
            classId_academicSessionId_termId_classGroupId: {
              classId: initial.classId, academicSessionId: initial.academicSessionId, termId: initial.termId,
              classGroupId: initial.classGroupId,
            },
          },
          select: { status: true },
        }),
        tx.student.findMany({
          where: {
            classId: initial.classId, academicSessionId: initial.academicSessionId, status: "active",
            ...studentScopeWhere(initial.classGroupId),
          },
          select: { id: true },
        }),
      ]);
      const publishedFor = scopeStudents.length
        ? await tx.publishedResultRow.count({
            where: {
              studentId: { in: scopeStudents.map((st) => st.id) },
              publishedResult: {
                classId: initial.classId, subjectId: initial.subjectId,
                academicSessionId: initial.academicSessionId, termId: initial.termId,
              },
            },
          })
        : 0;

      const allowed = rules.reviewActions({
        status: locked.status,
        autoAccepted: initial.autoAccepted,
        compilationStatus: compilation?.status ?? null,
        published: scopeStudents.length > 0 && publishedFor >= scopeStudents.length,
      });
      const permitted = action === "accept" ? allowed.accept : allowed.return;
      if (!permitted) throw fail(409, allowed.reason || "This submission cannot be changed now", "INVALID_TRANSITION");

      if (action === "accept") {
        await tx.resultSubmission.update({
          where: { id: submissionId },
          data: { status: "ACCEPTED", reviewedByStaffId: staffId, reviewedAt: new Date(), returnComment: null },
        });
      } else {
        await tx.resultSubmission.update({
          where: { id: submissionId },
          data: { status: "RETURNED", reviewedByStaffId: staffId, reviewedAt: new Date(), returnComment: comment },
        });
      }

      await recordEvent(tx, {
        schoolId, classId: initial.classId, classGroupId: initial.classGroupId, subjectId: initial.subjectId,
        academicSessionId: initial.academicSessionId, termId: initial.termId, submissionId,
        action: action === "accept" ? "ACCEPTED" : "RETURNED",
        actorType: "teacher", actorId: staffId, comment,
      });
      return { status: action === "accept" ? "ACCEPTED" : "RETURNED" };
    },
    { timeout: 20 * 1000 }
  );

  if (action === "return") {
    await createNotification({
      recipientType: "teacher", recipientId: initial.staffId, schoolId,
      title: "Results returned for correction",
      message: `Your ${initial.subject.name} results for ${scopeLabel(initial.class.name, initial.groupName)} were returned by the class teacher: ${comment}`,
      type: "result_returned", link: "/staff/compute-result",
    });
  }
  return { submissionId, ...outcome };
}

const acceptSubmission = async ({ schoolId, staffId, submissionId }) =>
  reviewSubmission({ schoolId, staffId, submissionId, action: "accept", comment: null });

const returnSubmission = async ({ schoolId, staffId, submissionId, comment }) =>
  reviewSubmission({ schoolId, staffId, submissionId, action: "return", comment: cleanComment(comment, { required: true }) });

/**
 * The class teacher sends their group's (or class's) compiled results to the admin.
 *
 * Their own subjects are written as accepted (locking them) now, so the scores
 * the admin approves are the scores that were compiled. Missing subjects and
 * students without scores do not block, but must be acknowledged, and are kept
 * on the compilation for the admin to see.
 */
async function submitCompilation({ schoolId, staffId, classId, classGroupId = UNGROUPED, termId, acknowledgeMissing }) {
  const cls = await assertClassTeacher(prisma, { schoolId, classId, staffId, classGroupId });
  const { sessionId, termId: resolvedTermId } = await resolveSessionTerm(prisma, schoolId, termId);

  const result = await prisma.$transaction(
    async (tx) => {
      // Lock the compilation if there is one; a first submission is serialised by its unique key.
      const existing = await tx.classCompilation.findUnique({
        where: { classId_academicSessionId_termId_classGroupId: { classId, academicSessionId: sessionId, termId: resolvedTermId, classGroupId } },
        select: { id: true, round: true },
      });
      if (existing) await lockRow(tx, "class_compilations", existing.id);

      const state = await loadClassState(tx, { schoolId, cls, classGroupId, teacherStaffId: staffId, sessionId, termId: resolvedTermId });
      if (!state.readiness.canSubmit) {
        throw fail(409, state.readiness.blocker, "CANNOT_SUBMIT_COMPILATION");
      }
      if (state.readiness.needsAcknowledgement && acknowledgeMissing !== true) {
        throw fail(409, "Some subjects or students are incomplete. Confirm that you want to submit anyway.", "COMPILATION_INCOMPLETE", {
          missingSubjects: state.readiness.missingSubjects,
          incompleteStudents: state.incompleteStudents,
        });
      }

      // The class teacher's own subjects: accepted by the system, which locks them.
      const own = state.subjects.filter((s) => s.state === "own");
      for (const subject of own) {
        const row = await tx.resultSubmission.upsert({
          where: {
            classId_subjectId_academicSessionId_termId_staffId_classGroupId: {
              classId, subjectId: subject.subjectId, academicSessionId: sessionId, termId: resolvedTermId, staffId, classGroupId,
            },
          },
          create: {
            classId, subjectId: subject.subjectId, academicSessionId: sessionId, termId: resolvedTermId, staffId, classGroupId,
            status: "ACCEPTED", autoAccepted: true, reviewedByStaffId: staffId, reviewedAt: new Date(),
          },
          update: { status: "ACCEPTED", autoAccepted: true, reviewedByStaffId: staffId, reviewedAt: new Date(), returnComment: null },
          select: { id: true },
        });
        await recordEvent(tx, {
          schoolId, classId, classGroupId, subjectId: subject.subjectId, academicSessionId: sessionId, termId: resolvedTermId,
          submissionId: row.id, action: "AUTO_ACCEPTED", actorType: "teacher", actorId: staffId,
        });
      }

      const missingJson = JSON.stringify({
        subjects: state.readiness.missingSubjects.map((s) => s.name),
        students: state.incompleteStudents.map((s) => ({ name: s.name, missing: s.missingSubjects })),
      });

      let compilation;
      if (existing) {
        compilation = await tx.classCompilation.update({
          where: { id: existing.id },
          data: {
            status: rules.COMPILATION.SUBMITTED, round: existing.round + 1, submittedAt: new Date(),
            submittedByStaffId: staffId, returnComment: null, reviewedAt: null, reviewedByAdminId: null, missingJson,
          },
        });
      } else {
        try {
          compilation = await tx.classCompilation.create({
            data: {
              schoolId, classId, classGroupId, academicSessionId: sessionId, termId: resolvedTermId,
              submittedByStaffId: staffId, status: rules.COMPILATION.SUBMITTED, missingJson,
            },
          });
        } catch (error) {
          if (error?.code === "P2002") throw fail(409, "The class results were just submitted.", "ALREADY_SUBMITTED");
          throw error;
        }
      }

      await recordEvent(tx, {
        schoolId, classId, classGroupId, academicSessionId: sessionId, termId: resolvedTermId, compilationId: compilation.id,
        action: compilation.round > 1 ? "COMPILATION_RESUBMITTED" : "COMPILATION_SUBMITTED",
        actorType: "teacher", actorId: staffId,
      });

      return { compilationId: compilation.id, round: compilation.round, includedOwn: own.length };
    },
    { timeout: 30 * 1000 }
  );

  // Tell the school's head admins. Best effort: the submission has happened.
  const admins = await prisma.admin.findMany({
    where: { schoolId, role: { in: ["school_admin", "super_admin"] } },
    select: { id: true },
  });
  for (const admin of admins) {
    await createNotification({
      recipientType: "admin", recipientId: admin.id, schoolId,
      title: "Class results submitted",
      message: `${scopeLabel(cls.name, cls.groupName)} results are ready for your approval.`,
      type: "class_results_submitted", link: "/admin/generate-result",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function listCompilations({ schoolId, status, campusId, classId, termId, classScope = {} }) {
  const where = { schoolId };
  if (status) where.status = status;
  if (classId) where.classId = classId;
  if (termId) where.termId = termId;
  const scoped = Object.keys(classScope).length > 0;
  if (campusId || scoped) {
    // `classScope` is a campus-restricted admin's reach: classes outside it are never listed.
    const inCampus = await prisma.class.findMany({
      where: { schoolId, ...(campusId ? { campusId } : {}), ...classScope },
      select: { id: true },
    });
    where.classId = { in: inCampus.map((c) => c.id) };
    if (classId) where.classId = { in: inCampus.map((c) => c.id).filter((id) => id === classId) };
  }

  const rows = await prisma.classCompilation.findMany({ where, orderBy: { submittedAt: "desc" }, take: 100 });
  if (rows.length === 0) return [];

  const classIds = [...new Set(rows.map((r) => r.classId))];
  const groupIds = [...new Set(rows.map((r) => r.classGroupId).filter((g) => g > 0))];
  const [classes, groups, terms, staff, submissions] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true, customName: true, staffId: true, campus: { select: { name: true } }, staff: { select: { name: true } } },
    }),
    groupIds.length
      ? prisma.classGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true, staffId: true } })
      : [],
    prisma.academicTerm.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.termId))] } },
      select: { id: true, name: true, session: { select: { name: true } } },
    }),
    prisma.staff.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.submittedByStaffId))] } }, select: { id: true, name: true } }),
    prisma.resultSubmission.findMany({
      where: { classId: { in: classIds }, status: { in: ["ACCEPTED", "PENDING"] } },
      select: { classId: true, termId: true, subjectId: true, classGroupId: true },
    }),
  ]);
  const classBy = new Map(classes.map((c) => [c.id, c]));
  const groupBy = new Map(groups.map((g) => [g.id, g]));
  const termBy = new Map(terms.map((t) => [t.id, t]));
  const staffBy = new Map(staff.map((s) => [s.id, s.name]));
  const teacherNames = new Map();
  const groupTeacherIds = groups.map((g) => g.staffId).filter((id) => id);
  if (groupTeacherIds.length) {
    for (const t of await prisma.staff.findMany({ where: { id: { in: groupTeacherIds } }, select: { id: true, name: true } })) {
      teacherNames.set(t.id, t.name);
    }
  }

  return rows.map((r) => {
    const cls = classBy.get(r.classId);
    const group = r.classGroupId ? groupBy.get(r.classGroupId) : null;
    const term = termBy.get(r.termId);
    let missing = { subjects: [], students: [] };
    try {
      missing = r.missingJson ? JSON.parse(r.missingJson) : missing;
    } catch {
      /* stored by us; a bad value just means nothing to show */
    }
    return {
      id: r.id,
      class: cls ? { id: cls.id, name: cls.name, customName: cls.customName, campus: cls.campus?.name ?? null } : null,
      classGroupId: r.classGroupId,
      groupName: group?.name ?? null,
      classTeacher: group ? (teacherNames.get(group.staffId) ?? null) : (cls?.staff?.name ?? null),
      submittedBy: staffBy.get(r.submittedByStaffId) ?? null,
      term: term ? { id: term.id, name: term.name, session: term.session.name } : null,
      status: r.status,
      round: r.round,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      returnComment: r.returnComment,
      subjectCount: new Set(
        submissions
          .filter((s) => s.classId === r.classId && s.termId === r.termId && (s.classGroupId === r.classGroupId || s.classGroupId === UNGROUPED))
          .map((s) => s.subjectId)
      ).size,
      hasMissing: (missing.subjects?.length ?? 0) > 0 || (missing.students?.length ?? 0) > 0,
    };
  });
}

async function loadCompilation(client, { schoolId, id, classScope = {} }) {
  const compilation = await client.classCompilation.findFirst({ where: { id, schoolId } });
  if (!compilation) throw fail(404, "Class submission not found", "NOT_FOUND");
  // A class outside the admin's campuses reads exactly like one that does not exist.
  if (Object.keys(classScope).length > 0) {
    const reachable = await client.class.count({ where: { id: compilation.classId, schoolId, ...classScope } });
    if (!reachable) throw fail(404, "Class submission not found", "NOT_FOUND");
  }
  return compilation;
}

async function getCompilation({ schoolId, id, classScope }) {
  const compilation = await loadCompilation(prisma, { schoolId, id, classScope });
  const classGroupId = compilation.classGroupId;
  const target = await classTeacherOfScope(prisma, { schoolId, classId: compilation.classId, scope: classGroupId });
  const cls = target.cls;
  if (!cls) throw fail(404, "Class not found", "CLASS_NOT_FOUND");
  const [campus, teacher] = await Promise.all([
    cls.campusId ? prisma.campus.findFirst({ where: { id: cls.campusId }, select: { name: true } }) : null,
    target.staffId ? prisma.staff.findFirst({ where: { id: target.staffId }, select: { name: true } }) : null,
  ]);

  const state = await loadClassState(prisma, {
    schoolId, cls, classGroupId, teacherStaffId: target.staffId,
    sessionId: compilation.academicSessionId, termId: compilation.termId,
  });
  const history = await loadHistory(prisma, {
    schoolId, classId: compilation.classId, classGroupId, sessionId: compilation.academicSessionId, termId: compilation.termId,
  });

  // The class as the admin will approve it: only the subjects that are in it.
  const countedIds = state.subjects.filter((s) => rules.isIncluded(s.state)).map((s) => s.subjectId);
  let broadsheet = null;
  if (countedIds.length > 0) {
    const { AssessmentService } = require("./AssessmentService");
    broadsheet = await new AssessmentService().computeBroadsheet({
      classId: compilation.classId, schoolId, academicSessionId: compilation.academicSessionId,
      subjectIds: countedIds, termId: compilation.termId, classGroupId: classGroupId === UNGROUPED ? null : classGroupId,
    });
  }

  let missing = { subjects: [], students: [] };
  try {
    missing = compilation.missingJson ? JSON.parse(compilation.missingJson) : missing;
  } catch {
    /* see listCompilations */
  }

  // The group's students with the remarks written so far, for the principal's remark.
  const scopeStudentRows = await prisma.student.findMany({
    where: {
      schoolId, classId: compilation.classId, academicSessionId: compilation.academicSessionId,
      status: "active", ...studentScopeWhere(classGroupId),
    },
    select: { id: true, name: true, surname: true, otherNames: true },
    orderBy: [{ surname: "asc" }, { name: "asc" }],
  });
  const savedRemarks = scopeStudentRows.length
    ? await prisma.studentTermRemark.findMany({
        where: {
          schoolId, academicSessionId: compilation.academicSessionId, termId: compilation.termId,
          studentId: { in: scopeStudentRows.map((st) => st.id) },
        },
        select: { studentId: true, classTeacherRemark: true, principalRemark: true },
      })
    : [];
  const remarkBy = new Map(savedRemarks.map((r) => [r.studentId, r]));

  return {
    id: compilation.id,
    students: scopeStudentRows.map((st) => ({
      studentId: st.id,
      name: displayName(st),
      classTeacherRemark: remarkBy.get(st.id)?.classTeacherRemark ?? "",
      principalRemark: remarkBy.get(st.id)?.principalRemark ?? "",
    })),
    class: { id: cls.id, name: cls.name, customName: cls.customName, campus: campus?.name ?? null },
    classGroupId,
    groupName: target.groupName,
    classTeacher: teacher?.name ?? null,
    status: compilation.status,
    round: compilation.round,
    submittedAt: compilation.submittedAt,
    reviewedAt: compilation.reviewedAt,
    returnComment: compilation.returnComment,
    academicSessionId: compilation.academicSessionId,
    termId: compilation.termId,
    subjects: state.subjects.map((s) => ({
      subjectId: s.subjectId, name: s.name, state: s.state, teachers: s.teachers, autoAccepted: s.autoAccepted,
    })),
    missing,
    hasGradingScheme: state.hasGradingScheme,
    broadsheet,
    history,
  };
}

/**
 * Approve one group's (or class's) results: publish every accepted subject for
 * its students through the existing publish step. Idempotent and safe to retry;
 * it is only marked approved once every subject is published.
 */
async function approveCompilation({ schoolId, adminId, id, classScope }) {
  const compilation = await loadCompilation(prisma, { schoolId, id, classScope });
  if (!rules.adminCanReview(compilation.status)) {
    throw fail(409, `These class results are ${compilation.status.toLowerCase()}, not waiting for approval.`, "INVALID_TRANSITION");
  }
  const scope = compilation.classGroupId;

  const { AssessmentService } = require("./AssessmentService");
  const assessment = new AssessmentService();

  const accepted = await prisma.resultSubmission.findMany({
    where: {
      classId: compilation.classId, academicSessionId: compilation.academicSessionId,
      termId: compilation.termId, status: { in: ["ACCEPTED", "PENDING"] },
      OR: [{ classGroupId: scope }, { status: "PENDING", classGroupId: UNGROUPED }],
    },
    select: { id: true, subjectId: true, staffId: true, subject: { select: { name: true } } },
  });
  const subjects = [...new Map(accepted.map((a) => [a.subjectId, a.subject.name])).entries()];
  if (subjects.length === 0) throw fail(409, "There are no accepted subjects to publish.", "NOTHING_TO_PUBLISH");

  const scopeStudents = await prisma.student.findMany({
    where: {
      classId: compilation.classId, academicSessionId: compilation.academicSessionId, status: "active",
      ...studentScopeWhere(scope),
    },
    select: { id: true },
  });

  const published = [];
  const skipped = [];
  const failed = [];
  for (const [subjectId, name] of subjects) {
    const have = scopeStudents.length
      ? await prisma.publishedResultRow.count({
          where: {
            studentId: { in: scopeStudents.map((st) => st.id) },
            publishedResult: { classId: compilation.classId, subjectId, academicSessionId: compilation.academicSessionId, termId: compilation.termId },
          },
        })
      : 0;
    if (scopeStudents.length > 0 && have >= scopeStudents.length) {
      skipped.push(name);
      continue;
    }
    try {
      await assessment.publishResults({
        classId: compilation.classId, subjectId, academicSessionId: compilation.academicSessionId,
        termId: compilation.termId, schoolId, adminId, scope,
      });
      published.push(name);
    } catch (error) {
      // A concurrent approval can publish it between our check and our call.
      if (/already been published/i.test(error?.message || "")) skipped.push(name);
      else {
        failed.push({ subject: name, message: error?.message || "Could not publish" });
        logger.warn("[RESULT_WORKFLOW] Publishing a subject failed", { id, subjectId, error: error?.message });
      }
    }
  }

  if (failed.length > 0) {
    return { approved: false, published, skipped, failed };
  }

  const flipped = await prisma.$transaction(async (tx) => {
    const locked = await lockRow(tx, "class_compilations", id);
    if (!locked || locked.status !== rules.COMPILATION.SUBMITTED) return false;
    await tx.classCompilation.update({
      where: { id },
      data: { status: rules.COMPILATION.APPROVED, reviewedByAdminId: adminId, reviewedAt: new Date(), returnComment: null },
    });
    await recordEvent(tx, {
      schoolId, classId: compilation.classId, classGroupId: scope, academicSessionId: compilation.academicSessionId,
      termId: compilation.termId, compilationId: id, action: "APPROVED", actorType: "admin", actorId: adminId,
    });
    return true;
  });

  if (flipped) {
    const target = await classTeacherOfScope(prisma, { schoolId, classId: compilation.classId, scope });
    const recipients = new Set([compilation.submittedByStaffId, ...accepted.map((a) => a.staffId)]);
    for (const staffId of recipients) {
      await createNotification({
        recipientType: "teacher", recipientId: staffId, schoolId,
        title: "Class results approved",
        message: `${scopeLabel(target.cls?.name ?? "The class", target.groupName)} results were approved and published.`,
        type: "class_results_approved", link: "/staff/class-results",
      });
    }
  }

  return { approved: true, published, skipped, failed: [] };
}

async function returnCompilation({ schoolId, adminId, id, comment, classScope }) {
  const text = cleanComment(comment, { required: true });
  const compilation = await loadCompilation(prisma, { schoolId, id, classScope });
  const scope = compilation.classGroupId;

  await prisma.$transaction(async (tx) => {
    const locked = await lockRow(tx, "class_compilations", id);
    if (!locked || !rules.adminCanReview(locked.status)) {
      throw fail(409, "These class results are not waiting for approval.", "INVALID_TRANSITION");
    }
    await tx.classCompilation.update({
      where: { id },
      data: { status: rules.COMPILATION.RETURNED, reviewedByAdminId: adminId, reviewedAt: new Date(), returnComment: text },
    });
    // The class teacher's own subjects were locked for them at submit; reopen
    // them so they can correct and resubmit. Other teachers' accepted subjects
    // stay locked until the class teacher returns them individually.
    await tx.resultSubmission.deleteMany({
      where: {
        classId: compilation.classId, academicSessionId: compilation.academicSessionId,
        termId: compilation.termId, autoAccepted: true, classGroupId: scope,
      },
    });
    await recordEvent(tx, {
      schoolId, classId: compilation.classId, classGroupId: scope, academicSessionId: compilation.academicSessionId,
      termId: compilation.termId, compilationId: id, action: "ADMIN_RETURNED", actorType: "admin", actorId: adminId, comment: text,
    });
  });

  const target = await classTeacherOfScope(prisma, { schoolId, classId: compilation.classId, scope });
  await createNotification({
    recipientType: "teacher", recipientId: compilation.submittedByStaffId, schoolId,
    title: "Class results returned",
    message: `${scopeLabel(target.cls?.name ?? "Your class", target.groupName)} results were returned by the admin: ${text}`,
    type: "class_results_returned", link: "/staff/class-results",
  });
  return { id, status: rules.COMPILATION.RETURNED };
}

/**
 * Called by unpublish: the class has to be corrected and resubmitted, so every
 * group's compilation for the term goes back to its class teacher, and the
 * unpublished subject, where it was a class teacher's own, is reopened for editing.
 */
async function reopenAfterUnpublish(tx, { schoolId, classId, sessionId, termId, subjectId, adminId }) {
  if (!termId) return;

  await tx.resultSubmission.deleteMany({
    where: { classId, subjectId, academicSessionId: sessionId, termId, autoAccepted: true },
  });

  const compilations = await tx.classCompilation.findMany({
    where: { classId, academicSessionId: sessionId, termId },
  });
  for (const compilation of compilations) {
    if (compilation.status !== rules.COMPILATION.RETURNED) {
      await tx.classCompilation.update({
        where: { id: compilation.id },
        data: { status: rules.COMPILATION.RETURNED, returnComment: "Results for a subject were unpublished. Please correct and resubmit." },
      });
    }
    await recordEvent(tx, {
      schoolId, classId, classGroupId: compilation.classGroupId, subjectId, academicSessionId: sessionId, termId,
      compilationId: compilation.id, action: "UNPUBLISHED", actorType: "admin", actorId: adminId,
    });
  }
  if (compilations.length === 0) {
    await recordEvent(tx, {
      schoolId, classId, subjectId, academicSessionId: sessionId, termId,
      action: "UNPUBLISHED", actorType: "admin", actorId: adminId,
    });
  }
}

/**
 * Groups and classes with students whose results nobody can receive yet: subject
 * teachers there cannot submit until the admin assigns a class teacher.
 */
async function classesWithoutClassTeacher({ schoolId, classScope = {} }) {
  const [classes, active] = await Promise.all([
    prisma.class.findMany({
      where: { schoolId, ...classScope },
      select: { id: true, name: true, customName: true, campus: { select: { name: true } } },
      orderBy: [{ name: "asc" }],
    }),
    prisma.academicSession.findFirst({ where: { schoolId, isActive: true }, select: { id: true } }),
  ]);

  const out = [];
  for (const c of classes) {
    // Without an active session there is no student list to read, so fall back to the class-level check.
    const scopes = active
      ? await scopesOfClass(prisma, { schoolId, classId: c.id, sessionId: active.id })
      : [{ classGroupId: UNGROUPED, groupName: null, staffId: (await prisma.class.findFirst({ where: { id: c.id }, select: { staffId: true } }))?.staffId ?? null }];
    for (const sc of scopes) {
      if (!sc.staffId) {
        out.push({
          id: c.id,
          classGroupId: sc.classGroupId,
          name: c.name,
          customName: c.customName,
          groupName: sc.groupName,
          campus: c.campus?.name ?? null,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

const displayName = (st) => `${st.surname} ${st.name}${st.otherNames ? " " + st.otherNames : ""}`.trim();

/** A remark can only be edited while the group's results are not with the admin or approved. */
const remarksEditable = (compilationStatus) => compilationStatus !== rules.COMPILATION.SUBMITTED && compilationStatus !== rules.COMPILATION.APPROVED;

/**
 * Each student's remarks in this group for the term, with the automatic remark
 * they would get from their average, so the class teacher sees what a blank means.
 */
async function listRemarks({ schoolId, staffId, classId, classGroupId = UNGROUPED, termId }) {
  const cls = await assertClassTeacher(prisma, { schoolId, classId, staffId, classGroupId });
  const { sessionId, termId: resolvedTermId } = await resolveSessionTerm(prisma, schoolId, termId);

  const [students, compilation, saved, scheme, state] = await Promise.all([
    prisma.student.findMany({
      where: { schoolId, classId, academicSessionId: sessionId, status: "active", ...studentScopeWhere(classGroupId) },
      select: { id: true, name: true, surname: true, otherNames: true, registrationNumber: true },
      orderBy: [{ surname: "asc" }, { name: "asc" }],
    }),
    prisma.classCompilation.findUnique({
      where: { classId_academicSessionId_termId_classGroupId: { classId, academicSessionId: sessionId, termId: resolvedTermId, classGroupId } },
      select: { status: true },
    }),
    prisma.studentTermRemark.findMany({
      where: { schoolId, academicSessionId: sessionId, termId: resolvedTermId },
      select: { studentId: true, classTeacherRemark: true, principalRemark: true },
    }),
    prisma.remarkScheme.findUnique({ where: { schoolId }, select: { rules: { orderBy: { minScore: "desc" } } } }),
    loadClassState(prisma, { schoolId, cls, classGroupId, teacherStaffId: staffId, sessionId, termId: resolvedTermId }),
  ]);

  // The average each student would get on their card: total over the subjects that count.
  const counted = state.subjects.filter((s) => rules.isIncluded(s.state)).map((s) => s.subjectId);
  const average = new Map();
  if (counted.length > 0 && students.length > 0) {
    const { AssessmentService } = require("./AssessmentService");
    const sheet = await new AssessmentService().computeBroadsheet({
      classId, schoolId, academicSessionId: sessionId, subjectIds: counted, termId: resolvedTermId,
      classGroupId: classGroupId === UNGROUPED ? null : classGroupId,
    });
    for (const row of sheet.rows) average.set(row.studentId, Math.round(row.grandTotal / counted.length));
  }

  const savedBy = new Map(saved.map((r) => [r.studentId, r]));
  const status = compilation?.status ?? null;

  return {
    editable: remarksEditable(status),
    reason: remarksEditable(status) ? null : "The class results are with the admin, so remarks are locked.",
    termId: resolvedTermId,
    students: students.map((st) => {
      const mine = savedBy.get(st.id);
      return {
        studentId: st.id,
        name: displayName(st),
        registrationNumber: st.registrationNumber,
        classTeacherRemark: mine?.classTeacherRemark ?? "",
        principalRemark: mine?.principalRemark ?? "",
        automaticRemark: average.has(st.id) ? automaticRemark(scheme?.rules ?? [], average.get(st.id), `${st.surname} ${st.name}`) : "",
      };
    }),
  };
}

/**
 * Saves the class teacher's remarks for students in their own group. Blank clears
 * a remark (the automatic one is used again). Refused once the group's results are
 * with the admin, and for any student outside the group.
 */
async function saveRemarks({ schoolId, staffId, classId, classGroupId = UNGROUPED, termId, remarks }) {
  await assertClassTeacher(prisma, { schoolId, classId, staffId, classGroupId });
  const { sessionId, termId: resolvedTermId } = await resolveSessionTerm(prisma, schoolId, termId);
  if (!Array.isArray(remarks) || remarks.length === 0) throw fail(400, "There are no remarks to save", "NOTHING_TO_SAVE");

  let cleaned;
  try {
    cleaned = remarks.map((r) => ({ studentId: Number(r.studentId), text: cleanRemark(r.remark) }));
  } catch (error) {
    throw fail(400, error.message, "REMARK_TOO_LONG");
  }
  if (cleaned.some((r) => !Number.isInteger(r.studentId))) throw fail(400, "Every remark needs a student", "INVALID_REQUEST");

  await prisma.$transaction(async (tx) => {
    const compilation = await tx.classCompilation.findUnique({
      where: { classId_academicSessionId_termId_classGroupId: { classId, academicSessionId: sessionId, termId: resolvedTermId, classGroupId } },
      select: { id: true, status: true },
    });
    if (compilation) await lockRow(tx, "class_compilations", compilation.id);
    const current = compilation ? (await tx.classCompilation.findUnique({ where: { id: compilation.id }, select: { status: true } })).status : null;
    if (!remarksEditable(current)) {
      throw fail(409, "The class results are with the admin, so remarks are locked.", "REMARKS_LOCKED");
    }

    const inScope = await tx.student.findMany({
      where: {
        schoolId, classId, academicSessionId: sessionId, status: "active", ...studentScopeWhere(classGroupId),
        id: { in: cleaned.map((r) => r.studentId) },
      },
      select: { id: true },
    });
    const allowed = new Set(inScope.map((st) => st.id));
    const outside = cleaned.filter((r) => !allowed.has(r.studentId));
    if (outside.length > 0) {
      throw fail(403, "Some of these students are not in your group", "NOT_YOUR_STUDENT");
    }

    for (const r of cleaned) {
      await tx.studentTermRemark.upsert({
        where: { studentId_academicSessionId_termId: { studentId: r.studentId, academicSessionId: sessionId, termId: resolvedTermId } },
        create: { schoolId, studentId: r.studentId, academicSessionId: sessionId, termId: resolvedTermId, classTeacherRemark: r.text, classTeacherStaffId: staffId },
        update: { classTeacherRemark: r.text, classTeacherStaffId: staffId },
      });
    }
  });
  return { saved: cleaned.length };
}

/**
 * The principal's remark, written by the admin. It can be set at any time, since the
 * admin is the one approving, and it never touches the class teacher's own remark.
 */
async function savePrincipalRemarks({ schoolId, adminId, termId, remarks, studentScope = {} }) {
  const { sessionId, termId: resolvedTermId } = await resolveSessionTerm(prisma, schoolId, termId);
  if (!Array.isArray(remarks) || remarks.length === 0) throw fail(400, "There are no remarks to save", "NOTHING_TO_SAVE");

  let cleaned;
  try {
    cleaned = remarks.map((r) => ({ studentId: Number(r.studentId), text: cleanRemark(r.remark) }));
  } catch (error) {
    throw fail(400, error.message, "REMARK_TOO_LONG");
  }
  if (cleaned.some((r) => !Number.isInteger(r.studentId))) throw fail(400, "Every remark needs a student", "INVALID_REQUEST");

  // Only this school's students.
  const owned = await prisma.student.findMany({
    where: { schoolId, id: { in: cleaned.map((r) => r.studentId) }, ...studentScope },
    select: { id: true },
  });
  if (owned.length !== new Set(cleaned.map((r) => r.studentId)).size) {
    throw fail(404, "Some students were not found", "STUDENT_NOT_FOUND");
  }

  await prisma.$transaction(async (tx) => {
    for (const r of cleaned) {
      await tx.studentTermRemark.upsert({
        where: { studentId_academicSessionId_termId: { studentId: r.studentId, academicSessionId: sessionId, termId: resolvedTermId } },
        create: { schoolId, studentId: r.studentId, academicSessionId: sessionId, termId: resolvedTermId, principalRemark: r.text, principalAdminId: adminId },
        update: { principalRemark: r.text, principalAdminId: adminId },
      });
    }
  });
  return { saved: cleaned.length };
}

// ---------------------------------------------------------------------------
// Whole-class report cards (for printing)
// ---------------------------------------------------------------------------

/**
 * The report cards of one scope's students, for the given subjects.
 *
 * The class is ranked ONCE (from the broadsheet) and the totals handed to each
 * card, because ranking everyone again for every card would make a class of fifty
 * take minutes. Cards are built a few at a time.
 */
async function classReportCards({ schoolId, classId, classGroupId = UNGROUPED, sessionId, termId, subjectIds }) {
  const { AssessmentService } = require("./AssessmentService");
  const assessment = new AssessmentService();

  const students = await prisma.student.findMany({
    where: { schoolId, classId, academicSessionId: sessionId, status: "active", ...studentScopeWhere(classGroupId) },
    select: { id: true },
    orderBy: [{ surname: "asc" }, { name: "asc" }],
  });
  if (students.length === 0 || subjectIds.length === 0) return [];

  const sheet = await assessment.computeBroadsheet({
    classId, schoolId, academicSessionId: sessionId, subjectIds, termId,
    classGroupId: classGroupId === UNGROUPED ? null : classGroupId,
  });
  const classScores = sheet.rows.map((r) => ({ studentId: r.studentId, score: r.grandTotal }));

  const cards = [];
  for (let i = 0; i < students.length; i += 5) {
    const chunk = students.slice(i, i + 5);
    const built = await Promise.all(
      chunk.map((st) =>
        assessment.getStudentCompleteResult({
          studentId: st.id, schoolId, academicSessionId: sessionId, termId, subjectIds, expectClassId: classId, classScores,
        })
      )
    );
    cards.push(...built);
  }
  return cards;
}

module.exports = {
  classReportCards,
  listRemarks,
  saveRemarks,
  savePrincipalRemarks,
  resolveSessionTerm,
  recordEvent,
  loadClassState,
  classesForClassTeacher,
  classOverview,
  acceptSubmission,
  returnSubmission,
  submitCompilation,
  listCompilations,
  getCompilation,
  approveCompilation,
  returnCompilation,
  reopenAfterUnpublish,
  classesWithoutClassTeacher,
  parseScope,
};
