/**
 * The "scope" of a result submission, compilation and approval.
 *
 * A class's results are reviewed and approved by class teachers. A class that has
 * groups (SS 1 A, SS 1 B) has a class teacher PER GROUP; the students who are in
 * no group, and every student of a class that has no groups, belong to the
 * class-level scope, whose class teacher is Class.staffId.
 *
 * A scope is a number: a class group's id, or UNGROUPED (0). 0 rather than NULL
 * because MySQL unique indexes treat every NULL as different, which would let the
 * same submission be recorded twice.
 */

const UNGROUPED = 0;

/** The value Student.classGroupId has for a scope. */
const groupValue = (scope) => (scope === UNGROUPED || scope == null ? null : scope);

/** A prisma `where` on Student that selects the scope's students. */
const studentScopeWhere = (scope) => ({ classGroupId: groupValue(scope) });

/** A student's scope. */
const scopeOfStudent = (student) => student?.classGroupId ?? UNGROUPED;

/** "SS 1 — Group A", or just the class name for the class-level scope. */
const scopeLabel = (className, groupName) => (groupName ? `${className} — ${groupName}` : className);

/** Reads a scope off a request: absent or invalid means the class-level scope. */
function parseScope(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : UNGROUPED;
}

/**
 * The scopes of a class that matter for results, with who their class teacher is
 * and how many students are in each.
 *
 * A class with no groups has exactly one scope. A class with groups has one per
 * group, plus the class-level scope only when some students are in no group.
 *
 * @param {object} client prisma or a transaction client
 * @param {{ schoolId: number, classId: number, sessionId: number }} input
 * @returns {Promise<Array<{ classGroupId: number, groupName: string | null, staffId: number | null, studentCount: number }>>}
 */
async function scopesOfClass(client, { schoolId, classId, sessionId }) {
  const [cls, groups, counts] = await Promise.all([
    client.class.findFirst({ where: { id: classId, schoolId }, select: { staffId: true } }),
    client.classGroup.findMany({ where: { classId }, select: { id: true, name: true, staffId: true }, orderBy: { name: "asc" } }),
    client.student.groupBy({
      by: ["classGroupId"],
      where: { schoolId, classId, academicSessionId: sessionId, status: "active" },
      _count: { _all: true },
    }),
  ]);
  if (!cls) return [];

  const countFor = (groupId) => counts.find((c) => (c.classGroupId ?? UNGROUPED) === groupId)?._count._all ?? 0;

  if (groups.length === 0) {
    const total = counts.reduce((sum, c) => sum + c._count._all, 0);
    return [{ classGroupId: UNGROUPED, groupName: null, staffId: cls.staffId, studentCount: total }];
  }

  const scopes = groups.map((g) => ({ classGroupId: g.id, groupName: g.name, staffId: g.staffId, studentCount: countFor(g.id) }));
  const ungrouped = countFor(UNGROUPED);
  if (ungrouped > 0) scopes.push({ classGroupId: UNGROUPED, groupName: null, staffId: cls.staffId, studentCount: ungrouped });
  return scopes;
}

/**
 * The class teacher of one scope, plus the group's name. Null teacher means
 * nobody has been made class teacher there yet. Throws nothing: a group that is not
 * in this class is reported as `valid: false` so callers can refuse it.
 */
async function classTeacherOfScope(client, { schoolId, classId, scope }) {
  const cls = await client.class.findFirst({
    where: { id: classId, schoolId },
    select: { id: true, name: true, customName: true, staffId: true, campusId: true },
  });
  if (!cls) return { valid: false, cls: null, staffId: null, groupName: null };

  if (scope === UNGROUPED) return { valid: true, cls, staffId: cls.staffId, groupName: null };

  const group = await client.classGroup.findFirst({
    where: { id: scope, classId },
    select: { id: true, name: true, staffId: true },
  });
  if (!group) return { valid: false, cls, staffId: null, groupName: null };
  return { valid: true, cls, staffId: group.staffId, groupName: group.name };
}

/**
 * Why a student cannot be moved out of their current group (or class) right now,
 * or null when they can.
 *
 * Once a group's results are with the admin (or approved) for the active term, the
 * students in it are what the admin is approving: moving one would put them in the
 * wrong approval, with scores and a position from the wrong group.
 *
 * @param {object} client prisma or a transaction client
 * @param {{ schoolId: number, classId: number, classGroupId: number | null }} student the student's CURRENT class and group
 */
async function groupChangeBlockedReason(client, { schoolId, classId, classGroupId }) {
  const term = await client.academicTerm.findFirst({
    where: { schoolId, isActive: true },
    select: { id: true, sessionId: true },
  });
  if (!term) return null;

  const compilation = await client.classCompilation.findUnique({
    where: {
      classId_academicSessionId_termId_classGroupId: {
        classId, academicSessionId: term.sessionId, termId: term.id, classGroupId: classGroupId ?? UNGROUPED,
      },
    },
    select: { status: true },
  });
  if (compilation && (compilation.status === "SUBMITTED" || compilation.status === "APPROVED")) {
    return "This student's class results have already been sent to the admin for this term, so they cannot be moved to another group or class until the admin returns them.";
  }
  return null;
}

module.exports = {
  groupChangeBlockedReason,
  UNGROUPED,
  groupValue,
  studentScopeWhere,
  scopeOfStudent,
  scopeLabel,
  parseScope,
  scopesOfClass,
  classTeacherOfScope,
};
