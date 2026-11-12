/**
 * School-week helpers for the attendance broadsheet (Monday to Friday).
 * Dates are plain "YYYY-MM-DD" strings handled in UTC, the same way attendance is stored
 * (a @db.Date column written from `${date}T00:00:00.000Z`), so a day never shifts.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const toIso = (d) => d.toISOString().slice(0, 10);

/** Parses "YYYY-MM-DD" into a UTC date, or null when it is not a real date. */
function parseIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || toIso(d) !== value ? null : d;
}

/** The Monday-to-Friday dates of the week that contains `date` (a Saturday or Sunday belongs to the week just ended). */
function weekDays(date) {
  const day = date.getUTCDay(); // 0 = Sunday
  const back = day === 0 ? 6 : day - 1;
  const monday = new Date(date.getTime() - back * 24 * 60 * 60 * 1000);
  return Array.from({ length: 5 }, (_, i) => toIso(new Date(monday.getTime() + i * 24 * 60 * 60 * 1000)));
}

/**
 * One student's week: the status on each day, and the totals. Attendance % counts late as
 * attended, over the days that were actually marked, matching the teacher's own broadsheet.
 */
function summarizeStudent(statuses) {
  const present = statuses.filter((s) => s === "present").length;
  const absent = statuses.filter((s) => s === "absent").length;
  const late = statuses.filter((s) => s === "late").length;
  const marked = present + absent + late;
  return { present, absent, late, pct: marked > 0 ? Math.round(((present + late) / marked) * 100) : 0 };
}

module.exports = { parseIsoDate, weekDays, summarizeStudent, toIso };
