const { columnKeys, emptyRow } = require("./bulkImport/columns");

/**
 * Turns whatever a school's file calls its columns into the canonical column
 * keys defined in bulkImport/columns.js, and normalises the cell values.
 *
 * School spreadsheets are wildly inconsistent ("Surname", "Last Name", "L/Name",
 * "Student Surname"), so matching is done on a normalised form of the header —
 * lowercased, punctuation stripped, spaces collapsed — against an alias table.
 */

// alias -> canonical column key. Written in normalised form (see normalizeHeader).
const HEADER_ALIASES = {
  // --- names -------------------------------------------------------------
  "first name": "firstName",
  firstname: "firstName",
  "given name": "firstName",
  "student first name": "firstName",
  "staff first name": "firstName",
  fname: "firstName",
  "f name": "firstName",

  "last name": "lastName",
  lastname: "lastName",
  surname: "lastName",
  "family name": "lastName",
  "student surname": "lastName",
  "staff surname": "lastName",
  lname: "lastName",
  "l name": "lastName",

  // A single combined name column is common; the row builder splits it.
  name: "fullName",
  "full name": "fullName",
  "student name": "fullName",
  "staff name": "fullName",
  "name of student": "fullName",
  "name of staff": "fullName",
  "names": "fullName",

  // --- shared ------------------------------------------------------------
  gender: "gender",
  sex: "gender",
  "m f": "gender",

  email: "email",
  "email address": "email",
  "e mail": "email",
  "student email": "email",
  "staff email": "email",

  campus: "campusName",
  "campus name": "campusName",
  branch: "campusName",
  site: "campusName",

  // --- student -----------------------------------------------------------
  dob: "dob",
  "d o b": "dob",
  "date of birth": "dob",
  birthdate: "dob",
  "birth date": "dob",
  born: "dob",

  class: "className",
  "class name": "className",
  classname: "className",
  grade: "className",
  level: "className",
  "current class": "className",

  group: "groupName",
  "group name": "groupName",
  "class group": "groupName",
  arm: "groupName",
  "class arm": "groupName",
  section: "groupName",
  stream: "groupName",

  "guardian name": "guardianName",
  guardian: "guardianName",
  "parent name": "guardianName",
  "name of guardian": "guardianName",
  "name of parent": "guardianName",
  "parent guardian name": "guardianName",
  "next of kin name": "guardianName",

  "parent phone": "parentPhone",
  "parent number": "parentPhone",
  "parent phone number": "parentPhone",
  "guardian phone": "parentPhone",
  "guardian number": "parentPhone",
  "guardian phone number": "parentPhone",
  "parent contact": "parentPhone",
  "guardian contact": "parentPhone",

  // --- staff -------------------------------------------------------------
  duty: "duty",
  role: "duty",
  position: "duty",
  designation: "duty",
  "job title": "duty",
  post: "duty",

  phone: "phone",
  "phone number": "phone",
  "mobile": "phone",
  "mobile number": "phone",
  "contact": "phone",
  "contact number": "phone",
  telephone: "phone",
  tel: "phone",

  address: "address",
  "home address": "address",
  "residential address": "address",

  "next of kin": "nextOfKin",
  nextofkin: "nextOfKin",
  nok: "nextOfKin",
  "kin": "nextOfKin",

  "date employed": "dateEmployed",
  "date of employment": "dateEmployed",
  "employment date": "dateEmployed",
  "hire date": "dateEmployed",
  "date hired": "dateEmployed",
  "date joined": "dateEmployed",
};

/**
 * "  Guardian's Phone-Number " -> "guardian phone number"
 *
 * The possessive is removed whole ('s, not just the apostrophe) so it collapses
 * onto the same alias as "Guardian Phone Number"; dropping only the apostrophe
 * would leave "guardians phone number" and miss. Remaining punctuation becomes a
 * space rather than being deleted, so "D.O.B" collapses to "d o b".
 */
function normalizeHeader(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[‘’'`]s\b/gi, "") // possessive: Parent's -> Parent
    .replace(/[‘’'`"]/g, "") // any other quote characters
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Maps one header cell to a column key, or null when it means nothing to us.
 * Falls back to an exact match on the canonical key itself so a file exported
 * from our own template ("parentPhone") is understood too.
 */
function matchHeader(rawHeader, entity) {
  const normalized = normalizeHeader(rawHeader);
  if (!normalized) return null;

  const valid = new Set([...columnKeys(entity), "fullName"]);

  const alias = HEADER_ALIASES[normalized];
  if (alias && valid.has(alias)) return alias;

  // Our own key names, e.g. a header literally reading "parentPhone".
  const collapsed = normalized.replace(/ /g, "");
  for (const key of valid) {
    if (key.toLowerCase() === collapsed) return key;
  }

  return null;
}

/**
 * Maps a whole header row. Returns an array positionally aligned with the input
 * (null where a column is unrecognised) plus how many were recognised — the
 * count is what header-row detection scores candidate rows on.
 */
function mapHeaderRow(headerCells, entity) {
  const keys = headerCells.map((cell) => matchHeader(cell, entity));
  const seen = new Set();

  // Two columns claiming the same key (e.g. "Phone" and "Mobile") would have the
  // second silently overwrite the first, so only the first one keeps the key.
  const deduped = keys.map((key) => {
    if (!key) return null;
    if (seen.has(key)) return null;
    seen.add(key);
    return key;
  });

  return { keys: deduped, matchCount: seen.size };
}

/** Cells arrive as strings, numbers, or Date objects (from cellDates). */
function stringifyCell(value) {
  if (value == null) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return toIsoDate(value);
  }
  return String(value).trim();
}

function toIsoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  // Local getters, not toISOString(): a date-only value parsed at local midnight
  // shifts to the previous day in UTC for anywhere east of Greenwich.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parses the date formats that actually turn up in school records.
 *
 * @returns {{ value: String, ambiguous: Boolean }}
 *   `value` is YYYY-MM-DD, or "" when nothing could be parsed (the caller keeps
 *   the raw text so the admin can see what was in the file). `ambiguous` is true
 *   for slash dates where both parts are <= 12 — those are read day-first, and
 *   the caller warns so the admin can check rather than silently trusting it.
 */
function normalizeDate(raw) {
  const text = stringifyCell(raw);
  if (!text) return { value: "", ambiguous: false };

  // Already ISO.
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return build(+iso[1], +iso[2], +iso[3], false);

  // Day/month/year with any common separator.
  const slash = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (slash) {
    let [, a, b, y] = slash;
    a = +a; b = +b; y = +y;
    if (y < 100) y += y > 50 ? 1900 : 2000; // "98" -> 1998, "10" -> 2010
    // Day-first unless the first part can only be a month.
    const dayFirst = a > 12 || b <= 12;
    const day = dayFirst ? a : b;
    const month = dayFirst ? b : a;
    return build(y, month, day, a <= 12 && b <= 12);
  }

  // "12 Jan 2010" / "Jan 12, 2010" / "12 January 2010"
  const words = text.match(/^(\d{1,2})\s+([a-zA-Z]{3,})\.?,?\s+(\d{4})$/);
  if (words) {
    const month = MONTHS[words[2].slice(0, 3).toLowerCase()];
    if (month) return build(+words[3], month, +words[1], false);
  }
  const wordsFirst = text.match(/^([a-zA-Z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (wordsFirst) {
    const month = MONTHS[wordsFirst[1].slice(0, 3).toLowerCase()];
    if (month) return build(+wordsFirst[3], month, +wordsFirst[2], false);
  }

  // A bare Excel serial that slipped through as a number (days since 1899-12-30).
  if (/^\d{5}$/.test(text)) {
    const serial = +text;
    if (serial > 0 && serial < 60000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return { value: toIsoDate(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())), ambiguous: false };
    }
  }

  return { value: "", ambiguous: false };

  function build(year, month, day, ambiguous) {
    // Reject impossible dates rather than letting Date roll them over —
    // 31/02/2010 would otherwise silently become 3 March.
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return { value: "", ambiguous: false };
    }
    return { value: toIsoDate(date), ambiguous };
  }
}

/**
 * Canonicalises a gender cell. An unrecognised value is returned UNCHANGED so
 * the admin sees exactly what was in their file ("Femle") next to the error,
 * instead of a blank cell they cannot connect to anything.
 */
function normalizeGender(raw) {
  const text = stringifyCell(raw);
  const key = text.toLowerCase().replace(/[^a-z]/g, "");
  if (["m", "male", "boy", "man"].includes(key)) return "Male";
  if (["f", "female", "girl", "woman"].includes(key)) return "Female";
  if (["o", "other", "others"].includes(key)) return "Other";
  return text;
}

/** Keeps digits and a single leading +; spreadsheets love "0801 234 5678". */
function normalizePhone(raw) {
  const text = stringifyCell(raw);
  if (!text) return "";
  const plus = text.trim().startsWith("+") ? "+" : "";
  const digits = text.replace(/\D/g, "");
  return digits ? plus + digits : text;
}

/** Splits "Mary Jane Doe" into a first and last name, keeping the middle out. */
function splitFullName(raw) {
  const parts = stringifyCell(raw).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/**
 * Builds one canonical row from a raw source row.
 *
 * Always returns every column key with a string value (missing -> ""), which is
 * the flat-map guarantee the frontend depends on.
 *
 * @param {Object} rawRow   { [sourceHeader]: value }
 * @param {String} entity   "students" | "staff"
 * @returns {{ data: Object, meta: { ambiguousDates: String[] } }}
 */
function buildRow(rawRow, entity) {
  const data = emptyRow(entity);
  const meta = { ambiguousDates: [] };

  // Collect by canonical key first so a "Full Name" column can be split only
  // when no explicit first/last columns were present.
  const collected = {};
  for (const [header, value] of Object.entries(rawRow || {})) {
    const key = matchHeader(header, entity);
    if (!key) continue;
    if (collected[key] === undefined || collected[key] === "") {
      collected[key] = stringifyCell(value);
    }
  }

  if (collected.fullName && !collected.firstName && !collected.lastName) {
    const split = splitFullName(collected.fullName);
    collected.firstName = split.firstName;
    collected.lastName = split.lastName;
  }
  delete collected.fullName;

  for (const [key, value] of Object.entries(collected)) {
    if (!(key in data)) continue;

    if (key === "gender") {
      data[key] = normalizeGender(value);
    } else if (key === "dob" || key === "dateEmployed") {
      const parsed = normalizeDate(value);
      // Unparseable dates keep the raw text so the error message has something
      // to point at and the admin can see what needs fixing.
      data[key] = parsed.value || stringifyCell(value);
      if (parsed.ambiguous) meta.ambiguousDates.push(key);
    } else if (key === "parentPhone" || key === "phone") {
      data[key] = normalizePhone(value);
    } else if (key === "email") {
      data[key] = stringifyCell(value).toLowerCase();
    } else {
      data[key] = stringifyCell(value);
    }
  }

  return { data, meta };
}

/** True when a row carries no usable content — blank spacer rows are dropped. */
function isBlankRow(data) {
  return Object.values(data).every((value) => !String(value).trim());
}

module.exports = {
  HEADER_ALIASES,
  normalizeHeader,
  matchHeader,
  mapHeaderRow,
  buildRow,
  isBlankRow,
  normalizeDate,
  normalizeGender,
  normalizePhone,
  splitFullName,
  stringifyCell,
};
