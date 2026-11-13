/** Pure rules for staff attendance: distance, local time, lateness, and the trust verdict. */

const EARTH_M = 6371000;
const MAX_ACCURACY_ALLOWANCE = 100; // GPS error we forgive, in metres
const POOR_ACCURACY = 200; // worse than this and the fix proves nothing

const toRad = (d) => (d * Math.PI) / 180;

const haversineMeters = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
};

const validCoords = (c) =>
  c && Number.isFinite(c.lat) && Number.isFinite(c.lng) && Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180;

/** { day:'YYYY-MM-DD', minutes:minutes since local midnight, weekday:0-6 } in the school's timezone. */
const localParts = (date, timezone = "Africa/Lagos") => {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday };
};

const hhmmToMinutes = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
};

const isWorkDay = (settings, weekday) => String(settings.workDays || "").split(",").map(Number).includes(weekday);

/** Minutes late past start + grace (0 when on time). */
const lateMinutes = (settings, localMinutes) => {
  const start = hhmmToMinutes(settings.workStart);
  if (start === null) return 0;
  const limit = start + (settings.graceMinutes ?? 0);
  return localMinutes > limit ? localMinutes - start : 0;
};

/**
 * Where was the phone relative to the school?
 * Returns { flags:[], distance:number|null }. Flags: no_location, poor_gps, outside_area.
 * The allowance for GPS error is capped so a deliberately terrible fix cannot widen the gate.
 */
const locationVerdict = ({ site, radius, location, requireLocation }) => {
  if (!requireLocation) return { flags: [], distance: null };
  if (!site) return { flags: ["no_site_set"], distance: null };
  if (!validCoords(location)) return { flags: ["no_location"], distance: null };
  const distance = Math.round(haversineMeters(site, location));
  const accuracy = Number.isFinite(location.accuracy) ? Math.max(0, location.accuracy) : POOR_ACCURACY;
  if (accuracy > POOR_ACCURACY) return { flags: ["poor_gps"], distance };
  const allowance = Math.min(accuracy, MAX_ACCURACY_ALLOWANCE);
  return distance > radius + allowance ? { flags: ["outside_area"], distance } : { flags: [], distance };
};

/** A "no_site_set" flag is the school's gap, not the staff member's, so it does not hold anyone back. */
const holdsForReview = (flags) => flags.some((f) => f !== "no_site_set");

/** Board status of one staff member for the day. */
const boardStatus = (rec, { isWorkDayToday, pastStart }) => {
  if (!rec) return isWorkDayToday && pastStart ? "absent" : "not_in_yet";
  if (rec.status === "rejected") return "rejected";
  if (rec.status === "needs_review") return "needs_review";
  if (rec.signOutAt) return "signed_out";
  return rec.lateMinutes > 0 ? "late" : "present";
};

module.exports = {
  haversineMeters, validCoords, localParts, hhmmToMinutes, isWorkDay, lateMinutes,
  locationVerdict, holdsForReview, boardStatus, POOR_ACCURACY, MAX_ACCURACY_ALLOWANCE,
};
