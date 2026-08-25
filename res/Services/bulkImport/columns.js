/**
 * Column definitions for the bulk-import grid.
 *
 * This is the single source of truth shared by three consumers:
 *   1. the frontend, which renders one editable cell per column;
 *   2. the validator, which knows a field is required from `required` here;
 *   3. the importer, which maps a column key onto the real create-record field.
 *
 * `key` deliberately matches the names the existing create-student /
 * create-staff flows use conceptually, so a corrected row drops straight into
 * that logic. Registration/admission numbers are NOT columns — they are
 * generated server-side at import time.
 */

const GENDER_OPTIONS = ["Male", "Female", "Other"];

const STUDENT_COLUMNS = [
  { key: "firstName", label: "First Name", required: true, type: "text" },
  { key: "lastName", label: "Last Name", required: true, type: "text" },
  { key: "gender", label: "Gender", required: false, type: "select", options: GENDER_OPTIONS },
  { key: "dob", label: "Date of Birth", required: false, type: "date" },
  { key: "className", label: "Class", required: true, type: "select", options: [] },
  { key: "groupName", label: "Class Group", required: false, type: "select", options: [] },
  { key: "campusName", label: "Campus", required: false, type: "select", options: [] },
  { key: "guardianName", label: "Guardian Name", required: false, type: "text" },
  { key: "parentPhone", label: "Parent Phone", required: false, type: "tel" },
  { key: "email", label: "Email", required: false, type: "email" },
];

const STAFF_COLUMNS = [
  { key: "firstName", label: "First Name", required: true, type: "text" },
  { key: "lastName", label: "Last Name", required: true, type: "text" },
  { key: "gender", label: "Gender", required: false, type: "select", options: GENDER_OPTIONS },
  { key: "email", label: "Email", required: false, type: "email" },
  { key: "duty", label: "Duty / Role", required: true, type: "text" },
  { key: "phone", label: "Phone", required: false, type: "tel" },
  { key: "address", label: "Address", required: false, type: "text" },
  { key: "nextOfKin", label: "Next of Kin", required: false, type: "text" },
  { key: "dateEmployed", label: "Date Employed", required: false, type: "date" },
  { key: "campusName", label: "Campus", required: false, type: "select", options: [] },
];

const ENTITIES = ["students", "staff"];

/** The bare definitions, before school-specific dropdown options are filled in. */
function baseColumns(entity) {
  return entity === "students" ? STUDENT_COLUMNS : STAFF_COLUMNS;
}

/** Just the keys — used to reject unknown fields in a PATCH body. */
function columnKeys(entity) {
  return baseColumns(entity).map((c) => c.key);
}

/**
 * Fills the `options` of the school-specific dropdowns (class, group, campus)
 * from the reference data the validator already loaded. Returned as a deep-ish
 * copy so the module-level constants are never mutated — they are shared across
 * every request in the process.
 *
 * @param {String} entity "students" | "staff"
 * @param {Object} reference { classes, campuses, groupNames } from BulkImportValidator
 */
function buildColumns(entity, reference = {}) {
  // Trimmed to match what the validator writes back into a cell — some stored
  // class and campus names carry stray whitespace ("Great Campus "), and an
  // option that differs from the cell value by a space would render the select
  // as having nothing selected.
  const trimmed = (list) => [...new Set((list || []).map((c) => String(c.name).trim()))];

  const classNames = trimmed(reference.classes);
  const campusNames = trimmed(reference.campuses);
  const groupNames = [...new Set((reference.groupNames || []).map((n) => String(n).trim()))];

  return baseColumns(entity).map((column) => {
    const copy = { ...column };
    if (column.key === "className") copy.options = classNames;
    if (column.key === "campusName") copy.options = campusNames;
    if (column.key === "groupName") copy.options = groupNames;
    return copy;
  });
}

/**
 * A blank row: every column key present, every value "".
 *
 * The frontend contract says `data` is a flat string->string map with no nulls
 * and no missing keys, so every row is built on top of this rather than from
 * whatever the source file happened to contain.
 */
function emptyRow(entity) {
  const row = {};
  for (const key of columnKeys(entity)) row[key] = "";
  return row;
}

module.exports = {
  ENTITIES,
  GENDER_OPTIONS,
  baseColumns,
  buildColumns,
  columnKeys,
  emptyRow,
};
