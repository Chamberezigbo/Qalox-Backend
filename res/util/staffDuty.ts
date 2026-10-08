/**
 * A staff member's duty is free text in the database, but one value in it has
 * real meaning: "Teacher" is what lets someone into the teacher portal.
 *
 * Teacher login used to compare it with an exact `!== "Teacher"`, so "teacher"
 * or "Teacher " — a stray capital, a trailing space — silently locked a
 * teacher out. Meanwhile the assign-teacher list matched the same value through
 * MySQL, which compares case-insensitively, so such a person appeared in the
 * list of teachers they could not log in as. Everything that reads or writes a
 * duty now goes through here, so both sides agree on what counts as a teacher.
 *
 * Keep this list in step with STAFF_DUTIES in the admin frontend
 * (src/domain/admin-domain/staff/constants/staff-duties.ts).
 */
export const STAFF_DUTIES = [
  "Teacher",
  "Bursar",
  "Secretary",
  "Security",
  "Driver",
  "Cleaner",
  "ICT Officer",
  "Human Resources",
  "Manager",
] as const;

const TEACHER_DUTY = "Teacher";

/** Case-insensitive lookup of the duty as the list spells it. */
const knownDuty = (cleaned: string): string | undefined =>
  STAFF_DUTIES.find((duty) => duty.toLowerCase() === cleaned.toLowerCase());

/**
 * Tidies a duty before it is stored: trims, collapses repeated spaces, and
 * restores the standard spelling when it matches a known duty ("teacher" →
 * "Teacher"). Anything else is kept exactly as typed, since schools use roles
 * no list will anticipate (Provost, Librarian, …).
 *
 * @returns the cleaned duty, or null when nothing meaningful was given
 */
export function normalizeDuty(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;

  return knownDuty(cleaned) ?? cleaned;
}

/** Whether this duty grants teacher-portal access. */
export function isTeacherDuty(duty: unknown): boolean {
  return normalizeDuty(duty) === TEACHER_DUTY;
}
