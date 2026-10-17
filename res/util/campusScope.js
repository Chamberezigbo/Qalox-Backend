const { AppError } = require("./AppError");
const { parsePermissions } = require("./permissions");

/**
 * Campus scope: which of a school's campuses an admin may work in.
 *
 * Head admins, and sub-admins marked "all campuses" (every sub-admin until a head
 * admin restricts them), are unrestricted: `req.campusIds` is null and nothing here
 * adds a filter, so a school with no campuses, or one, behaves exactly as it always
 * has. A restricted sub-admin has `req.campusIds`, the list of campus ids they were
 * assigned, set by attachSchoolId from the database on every request.
 *
 * A record with NO campus recorded is school-wide and in scope for everyone. A
 * student's campus is their own, else their class's.
 *
 * Out-of-scope ids answer 404, so a restricted admin cannot even confirm that a
 * record on another campus exists. A campus named outright (a filter, a form) that is
 * not theirs is a 403.
 */

/** Whether an admin is restricted, from their row. Only a sub-admin can be. */
const isRestrictedAdmin = (admin) => admin?.role === "sub_admin" && admin?.allCampuses === false;

/**
 * The campus ids for a restricted admin, or null when they are not restricted.
 * @param {object} client prisma or a transaction client
 * @param {{ id: number, role: string, allCampuses?: boolean }} admin
 * @returns {Promise<number[] | null>}
 */
async function loadCampusScope(client, admin, requiredKeys) {
  if (!isRestrictedAdmin(admin)) return null;
  const rows = await client.adminCampusAccess.findMany({
    where: { adminId: admin.id },
    select: { campusId: true, permissions: true },
  });
  return campusIdsFor(rows, admin.permissions, requiredKeys);
}

/**
 * The permissions a sub-admin holds on one campus: the campus's own list when it has
 * one, otherwise their global list (a row with no list inherits).
 * @param {{ permissions?: string | null }} row an AdminCampusAccess row
 * @param {string | null | undefined} globalPermissions Admin.permissions (JSON)
 */
const effectivePermissions = (row, globalPermissions) =>
  row && row.permissions != null ? parsePermissions(row.permissions) : parsePermissions(globalPermissions);

/**
 * Campus ids from access rows. With `requiredKeys`, only the campuses where the admin
 * holds at least one of those permissions, so a Bursar on one campus and a Secretary on
 * another each see only their own campus in the module they hold.
 */
function campusIdsFor(rows, globalPermissions, requiredKeys) {
  const keys = requiredKeys && requiredKeys.length > 0 ? requiredKeys : null;
  return rows
    .filter((row) => !keys || effectivePermissions(row, globalPermissions).some((k) => keys.includes(k)))
    .map((row) => row.campusId);
}

/**
 * Whether a restricted sub-admin holds one of the keys on any campus they were given.
 * With no campus rows at all (nothing assigned) their global permissions decide, as before.
 */
function holdsPermission(admin, rows, requiredKeys) {
  if (!rows || rows.length === 0) return parsePermissions(admin.permissions).some((k) => requiredKeys.includes(k));
  return rows.some((row) => effectivePermissions(row, admin.permissions).some((k) => requiredKeys.includes(k)));
}

const isRestricted = (req) => Array.isArray(req?.campusIds);

/** A campus id (or null = school-wide) the request's admin may work in. */
const inScope = (req, campusId) => !isRestricted(req) || campusId == null || req.campusIds.includes(campusId);

/** The campus ids as a prisma filter, or undefined for an unrestricted admin. */
const campusIn = (req) => (isRestricted(req) ? { in: req.campusIds } : undefined);

// ---------------------------------------------------------------------------
// Prisma `where` fragments. Each is `{}` for an unrestricted admin.
// ---------------------------------------------------------------------------

/** A model with its own nullable campusId: Class, Staff, Subject. School-wide (null) stays visible. */
const ownCampusWhere = (req) => (isRestricted(req) ? { OR: [{ campusId: null }, { campusId: { in: req.campusIds } }] } : {});

const classWhere = ownCampusWhere;
const staffWhere = ownCampusWhere;
const subjectWhere = ownCampusWhere;

/** A student's campus is their own, else their class's. */
const studentWhere = (req) =>
  isRestricted(req)
    ? {
        OR: [
          { campusId: { in: req.campusIds } },
          { campusId: null, class: { OR: [{ campusId: null }, { campusId: { in: req.campusIds } }] } },
        ],
      }
    : {};

/** ExamSchedule.campusId is required, so there is no school-wide case. */
const examScheduleWhere = (req) => (isRestricted(req) ? { campusId: { in: req.campusIds } } : {});

/** Everything reached through its class: results, fees, exams, schemes of work, submissions. */
const viaClass = (req) => (isRestricted(req) ? { class: classWhere(req) } : {});

/** Everything reached through its student: fees, payments, scores. */
const viaStudent = (req) => (isRestricted(req) ? { student: studentWhere(req) } : {});

/** `where` and the scope together; just `where` when there is no scope to add. */
const withScope = (where, scope) => (scope && Object.keys(scope).length > 0 ? { AND: [where, scope] } : where);

// ---------------------------------------------------------------------------
// Checks. They throw, so a controller's own catch hands them to the error middleware.
// ---------------------------------------------------------------------------

const notFound = (what) => new AppError(`${what} not found`, 404);

/**
 * A campus named by the client (a filter or a form field). A restricted admin may
 * name only their own; nothing named widens their scope.
 */
function assertCampusAllowed(req, campusId) {
  if (campusId == null || campusId === "") return;
  if (!isRestricted(req)) return;
  if (!req.campusIds.includes(Number(campusId))) {
    throw new AppError("You do not have access to that campus", 403);
  }
}

/**
 * Of an optional campus filter from the client, the campus to filter by: refused
 * if it is not theirs, passed through otherwise. The scope's own filter is added
 * separately (withScope), so omitting it never shows more than their campuses.
 */
function resolveCampusParam(req, requested) {
  if (requested === undefined || requested === null || requested === "") return undefined;
  const id = Number(requested);
  assertCampusAllowed(req, id);
  return id;
}

/** The class, if it is this school's and in scope; otherwise 404. */
async function assertClassInScope(req, classId, client) {
  const found = await client.class.findFirst({
    where: withScope({ id: Number(classId), schoolId: req.schoolId }, classWhere(req)),
    select: { id: true, campusId: true },
  });
  if (!found) throw notFound("Class");
  return found;
}

/** The student, if it is this school's and in scope; otherwise 404. */
async function assertStudentInScope(req, studentId, client) {
  const found = await client.student.findFirst({
    where: withScope({ id: Number(studentId), schoolId: req.schoolId }, studentWhere(req)),
    select: { id: true, campusId: true, classId: true },
  });
  if (!found) throw notFound("Student");
  return found;
}

/** The staff member, if they are this school's and in scope; otherwise 404. */
async function assertStaffInScope(req, staffId, client) {
  const found = await client.staff.findFirst({
    where: withScope({ id: Number(staffId), schoolId: req.schoolId }, staffWhere(req)),
    select: { id: true, campusId: true },
  });
  if (!found) throw notFound("Staff member");
  return found;
}

/** The subject, if it is this school's and in scope; otherwise 404. */
async function assertSubjectInScope(req, subjectId, client) {
  const found = await client.subject.findFirst({
    where: withScope({ id: Number(subjectId), schoolId: req.schoolId }, subjectWhere(req)),
    select: { id: true, campusId: true },
  });
  if (!found) throw notFound("Subject");
  return found;
}

/**
 * Ids of the school's campuses a restricted admin can work in, as a Set; null for
 * an unrestricted admin. For code that tests many rows (bulk import, analytics).
 */
const allowedCampusSet = (req) => (isRestricted(req) ? new Set(req.campusIds) : null);

/**
 * Ids of the admins who should hear about something on a campus: every head admin,
 * and a sub-admin who has all campuses or this one. A null campus (school-wide) is
 * for everyone. Used to fan a notification out without telling a sub-admin about a
 * campus they cannot see.
 *
 * @param {object} client prisma or a transaction client
 * @param {number} schoolId
 * @param {number | null | undefined} campusId
 * @param {string[]} [roles]
 * @returns {Promise<number[]>}
 */
async function adminIdsWhoCanSee(client, schoolId, campusId, roles = ["school_admin", "sub_admin", "super_admin"]) {
  const admins = await client.admin.findMany({
    where: { schoolId, role: { in: roles } },
    select: { id: true, role: true, allCampuses: true },
  });
  const restricted = admins.filter(isRestrictedAdmin);
  if (campusId == null || restricted.length === 0) return admins.map((a) => a.id);

  const access = await client.adminCampusAccess.findMany({
    where: { campusId, adminId: { in: restricted.map((a) => a.id) } },
    select: { adminId: true },
  });
  const allowed = new Set(access.map((a) => a.adminId));
  return admins.filter((a) => !isRestrictedAdmin(a) || allowed.has(a.id)).map((a) => a.id);
}

module.exports = {
  effectivePermissions,
  campusIdsFor,
  holdsPermission,
  adminIdsWhoCanSee,
  isRestrictedAdmin,
  loadCampusScope,
  isRestricted,
  inScope,
  campusIn,
  classWhere,
  staffWhere,
  subjectWhere,
  studentWhere,
  examScheduleWhere,
  viaClass,
  viaStudent,
  withScope,
  assertCampusAllowed,
  resolveCampusParam,
  assertClassInScope,
  assertStudentInScope,
  assertStaffInScope,
  assertSubjectInScope,
  allowedCampusSet,
};
