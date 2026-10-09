/**
 * Turns an edit-student request body into the fields that may be written.
 *
 * The edit form sends every field, blank ones as "". Passed to Prisma as they
 * came, a blank campusId (a student bulk-uploaded without a campus) is an
 * invalid Int and the whole save was refused with an error that blamed nothing
 * the admin had typed. Blank optional text is stored as null instead, and ids are
 * only used when they were actually chosen.
 *
 * Only the fields listed here are ever written, so a request cannot reach into
 * schoolId, registrationNumber, parentId and the like.
 */

/** Optional text columns: blank becomes null. */
const NULLABLE_TEXT = ["gender", "dateOfBirth", "guardianName", "guardianNumber", "guardianEmail", "lifestyle", "email"];

/** Columns that must keep a value. */
const REQUIRED_TEXT = ["name", "surname"];

const text = (value) => (typeof value === "string" ? value.trim() : value);

const toId = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : NaN;
};

/**
 * @param {object} body the request body, minus the session name
 * @returns {{ data: object, ids: { campusId?: number, classId?: number, classGroupId?: number }, error?: string }}
 */
function buildStudentUpdate(body) {
  const data = {};

  for (const key of REQUIRED_TEXT) {
    if (body[key] === undefined) continue;
    const value = text(body[key]);
    if (!value) return { data, ids: {}, error: `${key === "name" ? "First name" : "Surname"} cannot be blank` };
    data[key] = value;
  }

  // otherNames is NOT NULL in the database, so blank means "", never null.
  if (body.otherNames !== undefined) data.otherNames = text(body.otherNames) || "";

  for (const key of NULLABLE_TEXT) {
    if (body[key] === undefined) continue;
    data[key] = text(body[key]) || null;
  }

  const ids = {};
  for (const key of ["campusId", "classId", "classGroupId"]) {
    const id = toId(body[key]);
    if (Number.isNaN(id)) return { data, ids, error: `${key} must be a number` };
    if (id !== undefined) ids[key] = id;
  }

  return { data, ids };
}

module.exports = { buildStudentUpdate, NULLABLE_TEXT, REQUIRED_TEXT };
