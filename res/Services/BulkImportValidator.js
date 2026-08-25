const prisma = require("../util/prisma");
const { baseColumns, emptyRow, GENDER_OPTIONS } = require("./bulkImport/columns");

/**
 * Validates extracted rows against the school's real data.
 *
 * Two guarantees this module exists to enforce, because the frontend is built
 * entirely on top of them:
 *
 *   1. `isValid` is ALWAYS `errors.length === 0`. Nothing else may set it.
 *   2. Every `errors[].field` / `warnings[].field` is a key that exists in the
 *      row's `data`, so the message can attach to a cell in the grid.
 *
 * Errors block the import. Warnings never do — they are things worth an admin's
 * attention that are not wrong (a missing guardian phone, a date read as
 * day-first, a student who looks like one already on file).
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class BulkImportValidator {
  /**
   * Loads everything validation needs to compare rows against — classes, class
   * groups, campuses, and the existing people a row might duplicate.
   *
   * Fetched once per validation pass rather than per row: 120 rows would
   * otherwise mean 120 round trips to check the same handful of class names.
   *
   * @param {Number} schoolId
   * @param {String} entity "students" | "staff"
   */
  static async loadReference(schoolId, entity) {
    if (entity === "staff") {
      const [campuses, staff] = await Promise.all([
        prisma.campus.findMany({ where: { schoolId }, select: { id: true, name: true } }),
        // Staff.email is unique across the whole table, not per school, so an
        // email taken by another school still blocks this import. Scoping this
        // lookup to the school would report "no duplicate" and then fail at
        // insert time with a raw Prisma error.
        prisma.staff.findMany({ where: { NOT: { email: null } }, select: { email: true } }),
      ]);

      return {
        entity,
        schoolId,
        classes: [],
        campuses,
        groupNames: [],
        existingStaffEmails: new Set(
          staff.map((s) => String(s.email || "").trim().toLowerCase()).filter(Boolean)
        ),
        existingStudentKeys: new Set(),
      };
    }

    const [classes, campuses, students] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId },
        select: { id: true, name: true, classGroups: { select: { id: true, name: true } } },
      }),
      prisma.campus.findMany({ where: { schoolId }, select: { id: true, name: true } }),
      // Students have no unique key, so a duplicate is a judgement call made on
      // name + date of birth. Scoped to this school and to three small columns,
      // so even a large school is a cheap read.
      prisma.student.findMany({
        where: { schoolId },
        select: { name: true, surname: true, dateOfBirth: true },
      }),
    ]);

    const groupNames = [
      ...new Set(classes.flatMap((c) => c.classGroups.map((g) => g.name))),
    ];

    return {
      entity,
      schoolId,
      classes,
      campuses,
      groupNames,
      existingStaffEmails: new Set(),
      existingStudentKeys: new Set(
        students.map((s) => studentKey(s.name, s.surname, s.dateOfBirth))
      ),
    };
  }

  /**
   * Validates a whole set of rows together.
   *
   * Done as a set, not row by row, because duplicate detection is inherently
   * cross-row: the second row carrying an email is only a duplicate because of
   * the first. Re-running this over the full set after an edit is also what
   * keeps a stale duplicate flag from surviving on a row the admin just fixed.
   *
   * @param {Array<{ recordId: String, rowNumber: Number, data: Object }>} rows
   * @param {Object} reference from loadReference()
   * @returns {Array<{ recordId, rowNumber, data, isValid, isDuplicate, errors, warnings }>}
   */
  static validateAll(rows, reference) {
    const { entity } = reference;

    // recordId of the FIRST row to claim each duplicate key. The first
    // occurrence is left clean and only later ones are flagged — otherwise a
    // file with one repeated pair would show both rows as problems and the
    // admin would have no way to tell which to keep.
    const firstSeen = new Map();

    return rows.map((row) => {
      const data = normalizeData(row.data, entity);
      const errors = [];
      const warnings = [];

      if (entity === "students") {
        validateStudent(data, reference, errors, warnings);
      } else {
        validateStaff(data, reference, errors, warnings);
      }

      const isDuplicate = applyDuplicateChecks({
        data,
        entity,
        reference,
        recordId: row.recordId,
        firstSeen,
        errors,
        warnings,
      });

      return {
        recordId: row.recordId,
        rowNumber: row.rowNumber,
        data,
        // The one place isValid is ever computed.
        isValid: errors.length === 0,
        isDuplicate,
        errors,
        warnings,
      };
    });
  }

  /** Counts for the client's summary strip. */
  static summarize(records) {
    return {
      total: records.length,
      valid: records.filter((r) => r.isValid).length,
      errors: records.filter((r) => !r.isValid).length,
      warnings: records.filter((r) => r.warnings.length > 0).length,
      duplicates: records.filter((r) => r.isDuplicate).length,
    };
  }
}

// --- helpers ------------------------------------------------------------

/** Duplicate identity for a student: name + date of birth, case/space-insensitive. */
function studentKey(firstName, lastName, dob) {
  const clean = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");
  return `${clean(firstName)}|${clean(lastName)}|${clean(dob)}`;
}

/**
 * Forces a row into the shape the contract promises: exactly the entity's
 * column keys, every value a trimmed string, nothing null, nothing nested.
 */
function normalizeData(data, entity) {
  const clean = emptyRow(entity);
  for (const key of Object.keys(clean)) {
    const value = data ? data[key] : "";
    if (value == null) {
      clean[key] = "";
    } else if (typeof value === "object") {
      // A nested object would break the flat-map guarantee; the contract has no
      // way to render it, so it is treated as no value at all.
      clean[key] = "";
    } else {
      clean[key] = String(value).trim();
    }
  }
  return clean;
}

/** Adds a "<Label> is required" error for every empty required column. */
function checkRequired(data, entity, errors) {
  for (const column of baseColumns(entity)) {
    if (column.required && !data[column.key]) {
      errors.push({ field: column.key, message: `${column.label} is required` });
    }
  }
}

function checkGender(data, errors, { required }) {
  if (!data.gender) {
    // A missing required gender is already reported by checkRequired.
    return;
  }
  const match = GENDER_OPTIONS.find((o) => o.toLowerCase() === data.gender.toLowerCase());
  if (!match) {
    errors.push({
      field: "gender",
      message: `"${data.gender}" is not a valid gender — use ${GENDER_OPTIONS.join(", ")}`,
    });
  } else {
    // Fold casing to the canonical option so the select renders it as selected.
    data.gender = match;
  }
}

function checkEmail(data, errors, key = "email") {
  if (data[key] && !EMAIL_PATTERN.test(data[key])) {
    errors.push({ field: key, message: `"${data[key]}" is not a valid email address` });
  }
}

function checkPhone(data, warnings, key) {
  if (!data[key]) return;
  const digits = data[key].replace(/\D/g, "");
  // Deliberately a warning: phone formats vary too much across countries to
  // reject a row over, and a bad number does not stop the record being created.
  if (digits.length < 7 || digits.length > 15) {
    warnings.push({
      field: key,
      message: `"${data[key]}" does not look like a complete phone number`,
    });
  }
}

function findByName(list, name) {
  const target = String(name).trim().toLowerCase();
  // MySQL's Prisma client has no case-insensitive filter (that is Postgres
  // only), so names are matched in JS — the same approach the existing bulk
  // student/staff upload endpoints use.
  return list.find((item) => item.name.trim().toLowerCase() === target);
}

/** Strips everything but letters/digits and lowercases — "SS 1" and "SS1" collapse to the same string. */
function normalizeForMatch(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Classic Levenshtein edit distance between two strings. */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) table[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(
        table[i - 1][j] + 1, // deletion
        table[i][j - 1] + 1, // insertion
        table[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return table[rows - 1][cols - 1];
}

// Below this similarity, "closest" isn't close enough to be worth suggesting
// — a genuinely unrelated class shouldn't come back as a "did you mean".
const SUGGESTION_MIN_SIMILARITY = 0.5;

/**
 * The single closest name in `list` to `name`, when it's close enough to be
 * worth suggesting — a "did you mean" for a name that's right there in the
 * school's records but doesn't exactly match what the file/photo said (a
 * stray space, punctuation, or one misread character). Never auto-applied:
 * this only ever informs an error message the admin clicks to accept or
 * ignores in favour of picking something else from the dropdown themselves.
 */
function closestMatch(name, list) {
  const target = normalizeForMatch(name);
  if (!target || list.length === 0) return null;

  let best = null;
  let bestSimilarity = 0;
  for (const item of list) {
    const candidate = normalizeForMatch(item.name);
    if (!candidate) continue;
    const distance = editDistance(target, candidate);
    const similarity = 1 - distance / Math.max(target.length, candidate.length);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = item;
    }
  }

  return bestSimilarity >= SUGGESTION_MIN_SIMILARITY ? best : null;
}

/**
 * The stored name, trimmed, for writing back into the row.
 *
 * Trimmed because some class and campus names in the database carry stray
 * whitespace ("Great Campus "). Copying that in verbatim would make the cell
 * value flip between the padded and unpadded form on every revalidation, since
 * rows are trimmed on the way in — a diff that never settles.
 */
function canonicalName(match) {
  return match.name.trim();
}

function validateStudent(data, reference, errors, warnings) {
  checkRequired(data, "students", errors);
  checkGender(data, errors, { required: true });
  checkEmail(data, errors);
  checkPhone(data, warnings, "parentPhone");

  // --- date of birth ---
  if (data.dob) {
    if (!ISO_DATE_PATTERN.test(data.dob)) {
      errors.push({
        field: "dob",
        message: `"${data.dob}" is not a date we can read — use a format like 2012-04-09 or 09/04/2012`,
      });
    } else {
      const birth = new Date(`${data.dob}T00:00:00`);
      const ageYears = (Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (ageYears < 0) {
        errors.push({ field: "dob", message: "Date of birth is in the future" });
      } else if (ageYears < 2 || ageYears > 30) {
        warnings.push({
          field: "dob",
          message: `This date of birth makes the student ${Math.floor(ageYears)} years old — check it is correct`,
        });
      }
    }
  }

  // --- class, group, campus: must exist in this school ---
  let matchedClass = null;
  if (data.className) {
    matchedClass = findByName(reference.classes, data.className);
    if (!matchedClass) {
      const suggestion = closestMatch(data.className, reference.classes);
      errors.push({
        field: "className",
        message: `There is no class called "${data.className}" in your school`,
        suggestion: suggestion ? canonicalName(suggestion) : undefined,
      });
    } else {
      data.className = canonicalName(matchedClass); // snap to the stored spelling
    }
  }

  if (data.groupName) {
    if (!matchedClass) {
      // Without a valid class there is nothing to check the group against; the
      // class error is the one the admin needs to fix first.
      warnings.push({
        field: "groupName",
        message: "The class group can only be checked once the class is valid",
      });
    } else {
      const group = findByName(matchedClass.classGroups, data.groupName);
      if (!group) {
        const suggestion = closestMatch(data.groupName, matchedClass.classGroups);
        errors.push({
          field: "groupName",
          message: `Class "${matchedClass.name}" has no group called "${data.groupName}"`,
          suggestion: suggestion ? canonicalName(suggestion) : undefined,
        });
      } else {
        data.groupName = canonicalName(group);
      }
    }
  }

  if (data.campusName) {
    const campus = findByName(reference.campuses, data.campusName);
    if (!campus) {
      const suggestion = closestMatch(data.campusName, reference.campuses);
      errors.push({
        field: "campusName",
        message: `There is no campus called "${data.campusName}" in your school`,
        suggestion: suggestion ? canonicalName(suggestion) : undefined,
      });
    } else {
      data.campusName = canonicalName(campus);
    }
  }

  // A student with no contact at all can still be imported, but nobody can be
  // reached about them — worth flagging without blocking.
  if (!data.guardianName && !data.parentPhone) {
    warnings.push({
      field: "parentPhone",
      message: "No guardian name or phone number — you will not be able to contact this student's home",
    });
  }
}

function validateStaff(data, reference, errors, warnings) {
  checkRequired(data, "staff", errors);
  checkGender(data, errors, { required: false });
  checkEmail(data, errors);
  checkPhone(data, warnings, "phone");

  if (data.dateEmployed) {
    if (!ISO_DATE_PATTERN.test(data.dateEmployed)) {
      errors.push({
        field: "dateEmployed",
        message: `"${data.dateEmployed}" is not a date we can read — use a format like 2023-09-01 or 01/09/2023`,
      });
    } else if (new Date(`${data.dateEmployed}T00:00:00`).getTime() > Date.now()) {
      warnings.push({ field: "dateEmployed", message: "Date employed is in the future" });
    }
  }

  if (data.campusName) {
    const campus = findByName(reference.campuses, data.campusName);
    if (!campus) {
      const suggestion = closestMatch(data.campusName, reference.campuses);
      errors.push({
        field: "campusName",
        message: `There is no campus called "${data.campusName}" in your school`,
        suggestion: suggestion ? canonicalName(suggestion) : undefined,
      });
    } else {
      data.campusName = canonicalName(campus);
    }
  }
}

/**
 * Flags duplicates against both the database and the rest of the file.
 *
 * Staff duplicates are ERRORS: `Staff.email` is unique in the database, so a
 * repeat cannot be inserted — calling it a warning would let the admin confirm
 * an import that is guaranteed to fail on that row.
 *
 * Student duplicates are WARNINGS: two children in one school genuinely can
 * share a name and a birthday, so the admin, not the server, decides.
 */
function applyDuplicateChecks({ data, entity, reference, recordId, firstSeen, errors, warnings }) {
  if (entity === "staff") {
    const email = data.email.toLowerCase();
    if (!email) return false;

    if (reference.existingStaffEmails.has(email)) {
      errors.push({
        field: "email",
        message: `A staff member with the email "${data.email}" already exists`,
      });
      return true;
    }

    const key = `email:${email}`;
    const owner = firstSeen.get(key);
    if (owner && owner !== recordId) {
      errors.push({
        field: "email",
        message: `The email "${data.email}" is used more than once in this file`,
      });
      return true;
    }
    firstSeen.set(key, recordId);
    return false;
  }

  // Students: only a complete name + date of birth is specific enough to call
  // a duplicate. A partial row is left alone — its missing fields are already
  // errors, and guessing at a match on half a name creates noise.
  if (!data.firstName || !data.lastName || !data.dob) return false;

  const key = studentKey(data.firstName, data.lastName, data.dob);

  if (reference.existingStudentKeys.has(key)) {
    warnings.push({
      field: "firstName",
      message: `${data.firstName} ${data.lastName} (born ${data.dob}) is already on file — importing will create a second record`,
    });
    return true;
  }

  const owner = firstSeen.get(key);
  if (owner && owner !== recordId) {
    warnings.push({
      field: "firstName",
      message: `${data.firstName} ${data.lastName} (born ${data.dob}) appears more than once in this file`,
    });
    return true;
  }
  firstSeen.set(key, recordId);
  return false;
}

module.exports = BulkImportValidator;
module.exports.studentKey = studentKey;
module.exports.normalizeData = normalizeData;
