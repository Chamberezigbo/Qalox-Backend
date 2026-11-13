const crypto = require("crypto");
const QRCode = require("qrcode");
const prisma = require("../util/prisma");
const campusScope = require("../util/campusScope");
const secretBox = require("../util/secretBox");
const { createNotification } = require("../util/notify");
const qr = require("../util/staffQr");
const rules = require("../util/staffAttendanceRules");

class AttendanceError extends Error {
  constructor(message, status = 400, code = "STAFF_ATTENDANCE") {
    super(message);
    this.name = "AttendanceError";
    this.status = status;
    this.code = code;
  }
}

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const portalBase = () => (process.env.SCHOOL_PORTAL_URL || "").replace(/\/+$/, "");

// ── Settings & secret ───────────────────────────────────────────────────────

// Stored encrypted when the platform key exists; otherwise tagged so it is still readable.
const sealSecret = (s) => (secretBox.isConfigured() ? secretBox.encrypt(s) : `raw.${s}`);
const openSecret = (stored) => (stored.startsWith("raw.") ? stored.slice(4) : secretBox.decrypt(stored));

const getSettings = async (schoolId) => {
  let s = await prisma.staffAttendanceSetting.findUnique({ where: { schoolId } });
  if (!s) {
    try {
      s = await prisma.staffAttendanceSetting.create({ data: { schoolId, qrSecret: sealSecret(qr.newSecret()) } });
    } catch (e) {
      if (e.code !== "P2002") throw e;
      s = await prisma.staffAttendanceSetting.findUnique({ where: { schoolId } });
    }
  }
  return s;
};

const publicSettings = (s) => ({
  qrMode: s.qrMode, qrVersion: s.qrVersion, rotatedAt: s.rotatedAt,
  workStart: s.workStart, graceMinutes: s.graceMinutes, workEnd: s.workEnd, workDays: s.workDays,
  timezone: s.timezone, minStayMinutes: s.minStayMinutes, radiusMeters: s.radiusMeters,
  requireLocation: s.requireLocation, latitude: s.latitude, longitude: s.longitude,
});

const validTimezone = (tz) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

const logEvent = (data) =>
  prisma.staffAttendanceEvent.create({ data }).catch(() => null);

const updateSettings = async (schoolId, adminId, body) => {
  const s = await getSettings(schoolId);
  const data = {};
  const intIn = (key, min, max) => {
    if (body[key] === undefined) return;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw new AttendanceError(`${key} must be a whole number from ${min} to ${max}`);
    data[key] = n;
  };
  if (body.qrMode !== undefined) {
    if (!["live", "printed"].includes(body.qrMode)) throw new AttendanceError("qrMode must be live or printed");
    data.qrMode = body.qrMode;
  }
  for (const key of ["workStart", "workEnd"]) {
    if (body[key] !== undefined) {
      if (rules.hhmmToMinutes(body[key]) === null) throw new AttendanceError(`${key} must look like 07:30`);
      data[key] = body[key].padStart(5, "0");
    }
  }
  intIn("graceMinutes", 0, 180);
  intIn("minStayMinutes", 0, 720);
  intIn("radiusMeters", 30, 2000);
  if (body.workDays !== undefined) {
    const days = String(body.workDays).split(",").map((d) => d.trim()).filter(Boolean);
    if (!days.length || !days.every((d) => /^[0-6]$/.test(d))) throw new AttendanceError("workDays must be numbers 0 (Sunday) to 6 (Saturday)");
    data.workDays = [...new Set(days)].sort().join(",");
  }
  if (body.timezone !== undefined) {
    if (!validTimezone(body.timezone)) throw new AttendanceError("Unknown timezone");
    data.timezone = body.timezone;
  }
  if (body.requireLocation !== undefined) data.requireLocation = Boolean(body.requireLocation);
  const next = { ...s, ...data };
  if (rules.hhmmToMinutes(next.workEnd) <= rules.hhmmToMinutes(next.workStart)) {
    throw new AttendanceError("Closing time must be after opening time");
  }
  const saved = await prisma.staffAttendanceSetting.update({ where: { schoolId }, data });
  await logEvent({ schoolId, actorType: "admin", actorId: adminId, type: "settings", detail: data });
  return publicSettings(saved);
};

// ── Locations ───────────────────────────────────────────────────────────────

const siteFor = async (schoolId, campusId, settings) => {
  if (campusId) {
    const row = await prisma.staffSite.findUnique({ where: { schoolId_campusId: { schoolId, campusId } } });
    if (row) return { lat: row.latitude, lng: row.longitude, radius: row.radiusMeters ?? settings.radiusMeters };
  }
  if (settings.latitude != null && settings.longitude != null) {
    return { lat: settings.latitude, lng: settings.longitude, radius: settings.radiusMeters };
  }
  return null;
};

const setSite = async (schoolId, adminId, req, { campusId, latitude, longitude, radiusMeters }) => {
  const lat = Number(latitude), lng = Number(longitude);
  if (!rules.validCoords({ lat, lng })) throw new AttendanceError("Latitude/longitude are not valid");
  const radius = radiusMeters == null ? null : Number(radiusMeters);
  if (radius !== null && (!Number.isInteger(radius) || radius < 30 || radius > 2000)) throw new AttendanceError("Radius must be 30 to 2000 metres");
  if (campusId) {
    await assertCampus(schoolId, req, Number(campusId));
    await prisma.staffSite.upsert({
      where: { schoolId_campusId: { schoolId, campusId: Number(campusId) } },
      update: { latitude: lat, longitude: lng, radiusMeters: radius },
      create: { schoolId, campusId: Number(campusId), latitude: lat, longitude: lng, radiusMeters: radius },
    });
  } else {
    if (campusScope.isRestricted(req)) throw new AttendanceError("Only the school owner can set the main school location", 403);
    await getSettings(schoolId); // the settings row is created on first use
    await prisma.staffAttendanceSetting.update({ where: { schoolId }, data: { latitude: lat, longitude: lng } });
  }
  await logEvent({ schoolId, actorType: "admin", actorId: adminId, type: "site_set", detail: { campusId: campusId ?? null } });
  return { saved: true };
};

const assertCampus = async (schoolId, req, campusId) => {
  const campus = await prisma.campus.findFirst({ where: { id: campusId, schoolId }, select: { id: true } });
  if (!campus) throw new AttendanceError("Campus not found", 404);
  if (campusScope.isRestricted(req) && !req.campusIds.includes(campusId)) throw new AttendanceError("You do not manage that campus", 403);
};

const locations = async (schoolId, req) => {
  const settings = await getSettings(schoolId);
  const campuses = await prisma.campus.findMany({
    where: { schoolId, ...(campusScope.isRestricted(req) ? { id: { in: req.campusIds } } : {}) },
    select: { id: true, name: true },
  });
  const sites = await prisma.staffSite.findMany({ where: { schoolId } });
  const byCampus = new Map(sites.map((x) => [x.campusId, x]));
  return {
    school: campusScope.isRestricted(req) ? null : { latitude: settings.latitude, longitude: settings.longitude },
    campuses: campuses.map((c) => ({
      ...c, latitude: byCampus.get(c.id)?.latitude ?? null, longitude: byCampus.get(c.id)?.longitude ?? null,
      radiusMeters: byCampus.get(c.id)?.radiusMeters ?? null,
    })),
  };
};

// ── QR (admin side) ─────────────────────────────────────────────────────────

const siteIdForAdmin = async (schoolId, req, campusId) => {
  const id = campusId ? Number(campusId) : 0;
  if (id) await assertCampus(schoolId, req, id);
  else if (campusScope.isRestricted(req)) throw new AttendanceError("Choose a campus", 400);
  return id;
};

const currentQr = async (schoolId, req, campusId, { png = true } = {}) => {
  const s = await getSettings(schoolId);
  const site = await siteIdForAdmin(schoolId, req, campusId);
  const secret = openSecret(s.qrSecret);
  let token, expiresInSeconds = null;
  if (s.qrMode === "live") ({ token, expiresInSeconds } = qr.liveToken({ secret, version: s.qrVersion, site }));
  else token = qr.printedToken({ secret, version: s.qrVersion, site });
  const link = `${portalBase()}/staff/clock?t=${token}`;
  const image = png ? await QRCode.toDataURL(link, { margin: 2, width: 640, errorCorrectionLevel: "M" }) : undefined;
  return { mode: s.qrMode, token, link, image, expiresInSeconds, windowSeconds: qr.WINDOW_SECONDS, version: s.qrVersion };
};

const regenerate = async (schoolId, adminId) => {
  const s = await getSettings(schoolId);
  await prisma.staffAttendanceSetting.update({
    where: { schoolId },
    data: { qrSecret: sealSecret(qr.newSecret()), qrVersion: s.qrVersion + 1, rotatedAt: new Date(), rotatedById: adminId },
  });
  await logEvent({ schoolId, actorType: "admin", actorId: adminId, type: "qr_rotated", detail: { version: s.qrVersion + 1 } });
  return { qrVersion: s.qrVersion + 1 };
};

// ── Staff: clock in / out ───────────────────────────────────────────────────

const REASON_MESSAGES = {
  malformed: "That is not a valid school QR code.",
  bad_signature: "That QR code is not valid. If the school recently replaced its QR code, scan the new one.",
  expired: "That QR code has expired. Scan the code on the screen again.",
  revoked: "That QR code was replaced by the school. Ask for the new one.",
  wrong_mode: "That QR code type is no longer in use. Scan the current one.",
};

const FLAG_TEXT = {
  outside_area: "you appear to be outside the school area",
  no_location: "your location was not shared",
  poor_gps: "your phone could not get a clear location",
  new_device: "this is a new phone",
  after_hours: "it is after closing time",
};

const deviceHash = (schoolId, staffId, deviceId) => sha(`${schoolId}:${staffId}:${deviceId}`);

const clock = async (schoolId, staffId, { token, deviceId, location, ip }) => {
  const staff = await prisma.staff.findFirst({ where: { id: staffId, schoolId }, select: { id: true, name: true, campusId: true } });
  if (!staff) throw new AttendanceError("Staff not found", 404);
  if (typeof deviceId !== "string" || deviceId.length < 16 || deviceId.length > 80) throw new AttendanceError("This phone could not be identified. Reload the page and try again.");

  // Too many bad scans in a row: slow down guessing.
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const fails = await prisma.staffAttendanceEvent.count({ where: { schoolId, staffId, type: "failed_scan", occurredAt: { gte: since } } });
  if (fails >= 8) throw new AttendanceError("Too many failed attempts. Wait a few minutes and try again.", 429, "RATE_LIMITED");

  const settings = await getSettings(schoolId);
  const verdict = qr.verifyToken({ token, secret: openSecret(settings.qrSecret), version: settings.qrVersion, mode: settings.qrMode });
  const failScan = async (reason, message, status = 400) => {
    await logEvent({ schoolId, staffId, actorType: "staff", actorId: staffId, type: "failed_scan", detail: { reason } });
    throw new AttendanceError(message, status, "BAD_QR");
  };
  if (!verdict.ok) return failScan(verdict.reason, REASON_MESSAGES[verdict.reason] || "QR code rejected.");
  if (verdict.site !== (staff.campusId || 0)) return failScan("wrong_site", "That QR code belongs to a different campus.");

  // Device: the first phone is trusted; any other phone waits for the admin.
  const hash = deviceHash(schoolId, staffId, deviceId);
  let device = await prisma.staffDevice.findUnique({ where: { staffId_deviceHash: { staffId, deviceHash: hash } } });
  const flags = [];
  if (device?.status === "revoked") throw new AttendanceError("This phone has been blocked by the school. See the admin.", 403, "DEVICE_BLOCKED");
  if (!device) {
    const known = await prisma.staffDevice.count({ where: { staffId, status: "trusted" } });
    device = await prisma.staffDevice.create({ data: { schoolId, staffId, deviceHash: hash, status: known ? "pending" : "trusted" } });
    if (known) await logEvent({ schoolId, staffId, actorType: "staff", actorId: staffId, type: "device_pending" });
  } else {
    await prisma.staffDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  }
  if (device.status === "pending") flags.push("new_device");

  const site = await siteFor(schoolId, staff.campusId, settings);
  const loc = rules.locationVerdict({
    site, radius: site?.radius ?? settings.radiusMeters, requireLocation: settings.requireLocation,
    location: location && { lat: Number(location.lat), lng: Number(location.lng), accuracy: Number(location.accuracy) },
  });
  flags.push(...loc.flags);

  const now = new Date();
  const local = rules.localParts(now, settings.timezone);
  const stamp = { at: now.toISOString(), distance: loc.distance, accuracy: Number.isFinite(Number(location?.accuracy)) ? Math.round(Number(location.accuracy)) : null, device: hash.slice(0, 8), ip: ip || null, flags };

  const existing = await prisma.staffAttendance.findUnique({ where: { staffId_day: { staffId, day: local.day } } });

  // Sign out
  if (existing?.signInAt && !existing.signOutAt) {
    if (existing.status === "rejected") throw new AttendanceError("Today's sign-in was rejected. See the admin.", 409);
    const stayed = (now - existing.signInAt) / 60000;
    if (stayed < settings.minStayMinutes) {
      throw new AttendanceError(`You can sign out after ${settings.minStayMinutes} minutes at school. You signed in ${Math.floor(stayed)} minute(s) ago.`, 409, "TOO_SOON");
    }
    const outFlags = [...flags];
    if (local.minutes < rules.hhmmToMinutes(settings.workEnd)) stamp.leftEarlyBy = rules.hhmmToMinutes(settings.workEnd) - local.minutes;
    const hold = rules.holdsForReview(outFlags);
    const meta = { ...(existing.meta || {}), out: stamp };
    const updated = await prisma.staffAttendance.update({
      where: { id: existing.id },
      data: {
        signOutAt: now, signOutMethod: "qr", meta,
        status: hold && existing.status === "verified" ? "needs_review" : existing.status,
        flags: mergeFlags(existing.flags, outFlags),
      },
    });
    await logEvent({ schoolId, staffId, actorType: "staff", actorId: staffId, type: "sign_out", detail: { flags: outFlags, distance: loc.distance } });
    if (hold) await notifyAdmins(schoolId, staff, "sign-out");
    return reply("sign_out", updated, outFlags, settings);
  }
  if (existing?.signOutAt) throw new AttendanceError("You have already signed in and out today.", 409, "ALREADY_DONE");
  if (existing?.status === "rejected") throw new AttendanceError("Today's attendance was reviewed by the school. See the admin.", 409);

  // Sign in
  if (local.minutes >= rules.hhmmToMinutes(settings.workEnd)) flags.push("after_hours");
  const hold = rules.holdsForReview(flags);
  const data = {
    schoolId, staffId, campusId: staff.campusId, day: local.day, signInAt: now, signInMethod: "qr",
    status: hold ? "needs_review" : "verified", lateMinutes: rules.lateMinutes(settings, local.minutes),
    flags: mergeFlags(null, flags), meta: { in: { ...stamp, flags } },
  };
  let created;
  try {
    // A record may exist from an admin pre-entry with no sign-in; fill it rather than collide.
    created = existing
      ? await prisma.staffAttendance.update({ where: { id: existing.id }, data })
      : await prisma.staffAttendance.create({ data });
  } catch (e) {
    if (e.code === "P2002") throw new AttendanceError("Already signed in.", 409, "ALREADY_DONE");
    throw e;
  }
  await logEvent({ schoolId, staffId, actorType: "staff", actorId: staffId, type: "sign_in", detail: { flags, distance: loc.distance } });
  if (hold) await notifyAdmins(schoolId, staff, "sign-in");
  return reply("sign_in", created, flags, settings);
};

const mergeFlags = (a, b) => [...new Set([...(a ? a.split(",") : []), ...b.filter((f) => f !== "no_site_set")])].join(",") || null;

const reply = (action, rec, flags, settings) => {
  const held = rules.holdsForReview(flags);
  const reasons = flags.filter((f) => FLAG_TEXT[f]).map((f) => FLAG_TEXT[f]);
  return {
    action,
    at: action === "sign_in" ? rec.signInAt : rec.signOutAt,
    status: rec.status,
    lateMinutes: rec.lateMinutes,
    needsReview: held,
    message: held
      ? `Recorded, but sent to the admin to confirm (${reasons.join("; ") || "needs a check"}).`
      : action === "sign_in" ? (rec.lateMinutes > 0 ? `Signed in. You are ${rec.lateMinutes} minute(s) late.` : "Signed in. Have a good day.") : "Signed out. See you tomorrow.",
  };
};

const notifyAdmins = async (schoolId, staff, what) => {
  try {
    const ids = await campusScope.adminIdsWhoCanSee(prisma, schoolId, staff.campusId);
    await Promise.all(ids.map((adminId) => createNotification({
      recipientType: "admin", recipientId: adminId, schoolId,
      title: "Staff attendance needs review", message: `${staff.name}'s ${what} needs your approval.`,
      type: "staff_attendance", link: "/admin/staff-attendance",
    })));
  } catch { /* a missed notification must not undo the sign-in */ }
};

const view = (rec) => rec && ({
  day: rec.day, signInAt: rec.signInAt, signOutAt: rec.signOutAt, status: rec.status,
  lateMinutes: rec.lateMinutes, signInMethod: rec.signInMethod, signOutMethod: rec.signOutMethod,
});

const today = async (schoolId, staffId) => {
  const settings = await getSettings(schoolId);
  const local = rules.localParts(new Date(), settings.timezone);
  const rec = await prisma.staffAttendance.findUnique({ where: { staffId_day: { staffId, day: local.day } } });
  return {
    day: local.day, record: view(rec), isWorkDay: rules.isWorkDay(settings, local.weekday),
    settings: { workStart: settings.workStart, workEnd: settings.workEnd, graceMinutes: settings.graceMinutes, minStayMinutes: settings.minStayMinutes, qrMode: settings.qrMode },
  };
};

const history = async (schoolId, staffId, month) => {
  const m = /^\d{4}-\d{2}$/.test(month || "") ? month : rules.localParts(new Date()).day.slice(0, 7);
  const rows = await prisma.staffAttendance.findMany({
    where: { schoolId, staffId, day: { startsWith: m } }, orderBy: { day: "desc" },
  });
  return { month: m, records: rows.map(view) };
};

// ── Admin: board, review, manual, reports ───────────────────────────────────

const staffInScope = (schoolId, req, extra = {}) =>
  campusScope.withScope({ schoolId, ...extra }, campusScope.staffWhere(req));

const assertStaff = async (schoolId, req, staffId) => {
  const s = await prisma.staff.findFirst({ where: staffInScope(schoolId, req, { id: Number(staffId) }), select: { id: true, name: true, campusId: true } });
  if (!s) throw new AttendanceError("Staff member not found", 404);
  return s;
};

const board = async (schoolId, req, dayParam) => {
  const settings = await getSettings(schoolId);
  const nowLocal = rules.localParts(new Date(), settings.timezone);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam || "") ? dayParam : nowLocal.day;
  if (day > nowLocal.day) throw new AttendanceError("That day has not happened yet");
  const isToday = day === nowLocal.day;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const workDay = rules.isWorkDay(settings, weekday);
  const pastStart = !isToday || nowLocal.minutes > (rules.hhmmToMinutes(settings.workStart) + settings.graceMinutes);

  const [staff, records, pendingDevices] = await Promise.all([
    prisma.staff.findMany({ where: staffInScope(schoolId, req), select: { id: true, name: true, duty: true, campusId: true, registrationNumber: true }, orderBy: { name: "asc" } }),
    prisma.staffAttendance.findMany({ where: { schoolId, day } }),
    prisma.staffDevice.groupBy({ by: ["staffId"], where: { schoolId, status: "pending" }, _count: true }),
  ]);
  const byStaff = new Map(records.map((r) => [r.staffId, r]));
  const pending = new Set(pendingDevices.map((d) => d.staffId));
  const rows = staff.map((s) => {
    const rec = byStaff.get(s.id);
    return {
      ...s, status: rules.boardStatus(rec, { isWorkDayToday: workDay, pastStart }),
      recordId: rec?.id ?? null, signInAt: rec?.signInAt ?? null, signOutAt: rec?.signOutAt ?? null,
      lateMinutes: rec?.lateMinutes ?? 0, method: rec?.signInMethod ?? null, flags: rec?.flags ?? null,
      manualReason: rec?.manualReason ?? null, hasPendingDevice: pending.has(s.id),
    };
  });
  const count = (k) => rows.filter((r) => r.status === k).length;
  return {
    day, isWorkDay: workDay,
    summary: { total: rows.length, present: count("present"), late: count("late"), signedOut: count("signed_out"), absent: count("absent"), needsReview: count("needs_review"), notInYet: count("not_in_yet") },
    rows,
  };
};

const reviewQueue = async (schoolId, req) => {
  const scoped = await prisma.staff.findMany({ where: staffInScope(schoolId, req), select: { id: true, name: true, campusId: true, duty: true } });
  const ids = scoped.map((s) => s.id);
  const staffById = new Map(scoped.map((s) => [s.id, s]));
  const [records, devices] = await Promise.all([
    prisma.staffAttendance.findMany({ where: { schoolId, status: "needs_review", staffId: { in: ids } }, orderBy: { day: "desc" }, take: 200 }),
    prisma.staffDevice.findMany({ where: { schoolId, status: "pending", staffId: { in: ids } }, orderBy: { firstSeenAt: "desc" }, take: 200 }),
  ]);
  return {
    records: records.map((r) => ({ id: r.id, staff: staffById.get(r.staffId), day: r.day, signInAt: r.signInAt, signOutAt: r.signOutAt, flags: r.flags, meta: r.meta })),
    devices: devices.map((d) => ({ id: d.id, staff: staffById.get(d.staffId), firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt })),
  };
};

const decide = async (schoolId, adminId, req, recordId, decision, note) => {
  if (!["approved", "rejected"].includes(decision)) throw new AttendanceError("Invalid decision");
  const rec = await prisma.staffAttendance.findFirst({ where: { id: Number(recordId), schoolId } });
  if (!rec) throw new AttendanceError("Record not found", 404);
  await assertStaff(schoolId, req, rec.staffId);
  if (rec.status !== "needs_review") throw new AttendanceError("Only records waiting for review can be decided", 409);
  if (decision === "rejected" && !String(note || "").trim()) throw new AttendanceError("Give a short reason when rejecting");
  const updated = await prisma.staffAttendance.update({
    where: { id: rec.id },
    data: { status: decision, reviewedById: adminId, reviewedAt: new Date(), reviewNote: note ? String(note).slice(0, 255) : null },
  });
  await logEvent({ schoolId, staffId: rec.staffId, actorType: "admin", actorId: adminId, type: decision === "approved" ? "approve" : "reject", detail: { recordId: rec.id, note: note || null } });
  await createNotification({
    recipientType: "teacher", recipientId: rec.staffId, schoolId,
    title: decision === "approved" ? "Attendance approved" : "Attendance rejected",
    message: decision === "approved" ? `Your attendance for ${rec.day} was approved.` : `Your attendance for ${rec.day} was rejected: ${note}`,
    type: "staff_attendance", link: "/staff/clock",
  });
  return { id: updated.id, status: updated.status };
};

/** Local "YYYY-MM-DD" + "HH:MM" in a timezone to a real instant. */
const localToDate = (day, hhmm, timezone) => {
  const [y, m, d] = day.split("-").map(Number);
  const mins = rules.hhmmToMinutes(hhmm);
  const guess = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  const seen = rules.localParts(new Date(guess), timezone);
  const seenMs = Date.UTC(...seen.day.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))), Math.floor(seen.minutes / 60), seen.minutes % 60);
  return new Date(guess - (seenMs - guess));
};

const manual = async (schoolId, adminId, req, { staffId, day, signIn, signOut, reason }) => {
  const staff = await assertStaff(schoolId, req, staffId);
  const settings = await getSettings(schoolId);
  const nowLocal = rules.localParts(new Date(), settings.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || day > nowLocal.day) throw new AttendanceError("Pick today or an earlier day");
  if (!String(reason || "").trim()) throw new AttendanceError("A reason is required (for example: no smartphone)");
  if (!signIn && !signOut) throw new AttendanceError("Enter a sign-in time, a sign-out time, or both");
  for (const t of [signIn, signOut].filter(Boolean)) if (rules.hhmmToMinutes(t) === null) throw new AttendanceError("Times must look like 07:45");
  const inAt = signIn ? localToDate(day, signIn, settings.timezone) : null;
  const outAt = signOut ? localToDate(day, signOut, settings.timezone) : null;
  if (inAt && outAt && outAt <= inAt) throw new AttendanceError("Sign-out must be after sign-in");
  if ((inAt && inAt > new Date()) || (outAt && outAt > new Date())) throw new AttendanceError("That time is in the future");

  const existing = await prisma.staffAttendance.findUnique({ where: { staffId_day: { staffId: staff.id, day } } });
  const effectiveIn = inAt ?? existing?.signInAt ?? null;
  const late = effectiveIn ? rules.lateMinutes(settings, rules.localParts(effectiveIn, settings.timezone).minutes) : 0;
  const data = {
    ...(inAt ? { signInAt: inAt, signInMethod: "manual" } : {}),
    ...(outAt ? { signOutAt: outAt, signOutMethod: "manual" } : {}),
    lateMinutes: late, status: "verified", manualReason: String(reason).slice(0, 255), enteredById: adminId, reviewNote: null,
  };
  const rec = existing
    ? await prisma.staffAttendance.update({ where: { id: existing.id }, data })
    : await prisma.staffAttendance.create({ data: { schoolId, staffId: staff.id, campusId: staff.campusId, day, ...data } });
  await logEvent({ schoolId, staffId: staff.id, actorType: "admin", actorId: adminId, type: "manual", detail: { day, signIn: signIn || null, signOut: signOut || null, reason, previous: existing ? view(existing) : null } });
  return view(rec);
};

const removeRecord = async (schoolId, adminId, req, recordId, reason) => {
  const rec = await prisma.staffAttendance.findFirst({ where: { id: Number(recordId), schoolId } });
  if (!rec) throw new AttendanceError("Record not found", 404);
  await assertStaff(schoolId, req, rec.staffId);
  if (!String(reason || "").trim()) throw new AttendanceError("A reason is required");
  await prisma.staffAttendance.delete({ where: { id: rec.id } });
  await logEvent({ schoolId, staffId: rec.staffId, actorType: "admin", actorId: adminId, type: "record_removed", detail: { day: rec.day, reason, was: view(rec) } });
  return { removed: true };
};

const MAX_RANGE_DAYS = 93;
const eachDay = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

const report = async (schoolId, req, { from, to, staffId }) => {
  const settings = await getSettings(schoolId);
  const today = rules.localParts(new Date(), settings.timezone).day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) throw new AttendanceError("from and to dates are required (YYYY-MM-DD)");
  if (to > today) to = today;
  if (from > to) throw new AttendanceError("Start date is after the end date");
  const days = eachDay(from, to);
  if (days.length > MAX_RANGE_DAYS) throw new AttendanceError(`Pick a range of at most ${MAX_RANGE_DAYS} days`);
  const workDays = days.filter((d) => rules.isWorkDay(settings, new Date(`${d}T12:00:00Z`).getUTCDay()));

  const staff = await prisma.staff.findMany({
    where: staffInScope(schoolId, req, staffId ? { id: Number(staffId) } : {}),
    select: { id: true, name: true, duty: true, registrationNumber: true, dateEmployed: true }, orderBy: { name: "asc" },
  });
  const records = await prisma.staffAttendance.findMany({
    where: { schoolId, staffId: { in: staff.map((s) => s.id) }, day: { gte: from, lte: to } }, orderBy: { day: "asc" },
  });
  const per = new Map(staff.map((s) => [s.id, []]));
  for (const r of records) per.get(r.staffId)?.push(r);

  const rows = staff.map((s) => {
    const recs = per.get(s.id);
    const counted = recs.filter((r) => r.signInAt && r.status !== "rejected" && r.status !== "needs_review");
    const countedDays = new Set(counted.map((r) => r.day));
    const expected = workDays.filter((d) => !s.dateEmployed || d >= s.dateEmployed.toISOString().slice(0, 10));
    const minutes = counted.filter((r) => r.signOutAt).map((r) => Math.round((r.signOutAt - r.signInAt) / 60000));
    return {
      staffId: s.id, name: s.name, duty: s.duty, registrationNumber: s.registrationNumber,
      daysPresent: counted.length, daysLate: counted.filter((r) => r.lateMinutes > 0).length,
      lateMinutesTotal: counted.reduce((n, r) => n + r.lateMinutes, 0),
      daysAbsent: expected.filter((d) => !countedDays.has(d) && !recs.some((r) => r.day === d && r.status === "needs_review")).length,
      awaitingReview: recs.filter((r) => r.status === "needs_review").length,
      rejected: recs.filter((r) => r.status === "rejected").length,
      manualEntries: recs.filter((r) => r.signInMethod === "manual" || r.signOutMethod === "manual").length,
      averageMinutesAtSchool: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
      daily: recs.map((r) => ({ day: r.day, signInAt: r.signInAt, signOutAt: r.signOutAt, status: r.status, lateMinutes: r.lateMinutes, method: r.signInMethod, manualReason: r.manualReason })),
    };
  });
  return { from, to, workDays: workDays.length, rows };
};

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
const reportCsv = (data, timezone) => {
  const t = (d) => (d ? rules.localParts(new Date(d), timezone) : null);
  const hm = (d) => { const p = t(d); return p ? `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}` : ""; };
  const lines = [["Date", "Staff", "Reg. No.", "Sign in", "Sign out", "Late (min)", "Status", "Method", "Reason"].map(csvCell).join(",")];
  for (const r of data.rows) for (const d of r.daily) {
    lines.push([d.day, r.name, r.registrationNumber, hm(d.signInAt), hm(d.signOutAt), d.lateMinutes, d.status, d.method, d.manualReason].map(csvCell).join(","));
  }
  return lines.join("\n");
};

// ── Devices & audit ─────────────────────────────────────────────────────────

const decideDevice = async (schoolId, adminId, req, deviceId, decision) => {
  const dev = await prisma.staffDevice.findFirst({ where: { id: Number(deviceId), schoolId } });
  if (!dev) throw new AttendanceError("Device not found", 404);
  await assertStaff(schoolId, req, dev.staffId);
  if (!["trusted", "revoked"].includes(decision)) throw new AttendanceError("Invalid decision");
  await prisma.staffDevice.update({ where: { id: dev.id }, data: { status: decision } });
  await logEvent({ schoolId, staffId: dev.staffId, actorType: "admin", actorId: adminId, type: decision === "trusted" ? "device_approved" : "device_revoked" });
  return { id: dev.id, status: decision };
};

/** Forget a staff member's phones (new phone, lost phone): the next one they use is trusted afresh. */
const resetDevices = async (schoolId, adminId, req, staffId) => {
  const staff = await assertStaff(schoolId, req, staffId);
  const { count } = await prisma.staffDevice.deleteMany({ where: { schoolId, staffId: staff.id } });
  await logEvent({ schoolId, staffId: staff.id, actorType: "admin", actorId: adminId, type: "devices_reset", detail: { removed: count } });
  return { removed: count };
};

const events = async (schoolId, req, { limit = 100, staffId } = {}) => {
  const scoped = await prisma.staff.findMany({ where: staffInScope(schoolId, req), select: { id: true, name: true } });
  const names = new Map(scoped.map((s) => [s.id, s.name]));
  const rows = await prisma.staffAttendanceEvent.findMany({
    where: { schoolId, ...(staffId ? { staffId: Number(staffId) } : {}), OR: [{ staffId: { in: scoped.map((s) => s.id) } }, ...(campusScope.isRestricted(req) ? [] : [{ staffId: null }])] },
    orderBy: { occurredAt: "desc" }, take: Math.min(Number(limit) || 100, 300),
  });
  return rows.map((e) => ({ id: e.id, type: e.type, actorType: e.actorType, staffName: names.get(e.staffId) ?? null, detail: e.detail, occurredAt: e.occurredAt }));
};

// ── Gate screens ────────────────────────────────────────────────────────────
// A tablet at the gate generates its own secret key, shows a 6-digit code, and an admin enters that code
// while logged in. After that the tablet alone can ask for the current live QR; no admin login stays on it.

const gateStart = async (key) => {
  if (typeof key !== "string" || key.length < 32 || key.length > 100) throw new AttendanceError("Invalid screen key");
  const keyHash = sha(key);
  let screen = await prisma.gateScreen.findUnique({ where: { keyHash } });
  if (!screen) {
    const pairCode = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    // schoolId 0 until an admin claims it.
    screen = await prisma.gateScreen.create({ data: { schoolId: 0, name: "Gate screen", keyHash, pairCode } });
  }
  if (screen.status === "pending" && screen.openedAt < new Date(Date.now() - 30 * 60 * 1000)) {
    screen = await prisma.gateScreen.update({ where: { id: screen.id }, data: { pairCode: String(crypto.randomInt(0, 1000000)).padStart(6, "0"), openedAt: new Date() } });
  }
  return { status: screen.status, pairCode: screen.status === "pending" ? screen.pairCode : null };
};

const gatePair = async (schoolId, adminId, req, { code, name, campusId }) => {
  if (!/^\d{6}$/.test(String(code || ""))) throw new AttendanceError("Enter the 6-digit code shown on the screen");
  const cid = await siteIdForAdmin(schoolId, req, campusId);
  const screen = await prisma.gateScreen.findFirst({ where: { pairCode: String(code), status: "pending", schoolId: 0, openedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } } });
  if (!screen) throw new AttendanceError("That code was not found or has expired. Check the screen for a new one.", 404);
  const updated = await prisma.gateScreen.update({
    where: { id: screen.id },
    data: { schoolId, campusId: cid || null, name: String(name || "Gate screen").slice(0, 100), status: "active", pairCode: null, pairedById: adminId },
  });
  await logEvent({ schoolId, actorType: "admin", actorId: adminId, type: "gate_paired", detail: { screenId: updated.id, campusId: cid || null } });
  return { id: updated.id, name: updated.name };
};

const gateToken = async (key) => {
  if (typeof key !== "string" || key.length < 32 || key.length > 100) throw new AttendanceError("Invalid screen key", 401);
  const screen = await prisma.gateScreen.findUnique({ where: { keyHash: sha(key) } });
  if (!screen) throw new AttendanceError("Unknown screen", 401, "GATE_UNKNOWN");
  if (screen.status === "revoked") throw new AttendanceError("This screen was removed by the school.", 403, "GATE_REVOKED");
  if (screen.status === "pending") throw new AttendanceError("Waiting to be connected", 409, "GATE_PENDING");
  const settings = await getSettings(screen.schoolId);
  if (settings.qrMode !== "live") throw new AttendanceError("The school is using a printed QR code, so the gate screen is off.", 409, "GATE_PRINTED_MODE");
  await prisma.gateScreen.update({ where: { id: screen.id }, data: { lastSeenAt: new Date() } });
  const { token, expiresInSeconds } = qr.liveToken({ secret: openSecret(settings.qrSecret), version: settings.qrVersion, site: screen.campusId || 0 });
  const school = await prisma.school.findUnique({ where: { id: screen.schoolId }, select: { name: true } });
  const link = `${portalBase()}/staff/clock?t=${token}`;
  const image = await QRCode.toDataURL(link, { margin: 2, width: 720, errorCorrectionLevel: "M" });
  const local = rules.localParts(new Date(), settings.timezone);
  return { image, expiresInSeconds, windowSeconds: qr.WINDOW_SECONDS, schoolName: school?.name || "", screenName: screen.name, localMinutes: local.minutes, timezone: settings.timezone };
};

const gateList = async (schoolId, req) => {
  const rows = await prisma.gateScreen.findMany({
    where: { schoolId, status: { not: "revoked" }, ...(campusScope.isRestricted(req) ? { campusId: { in: req.campusIds } } : {}) },
    select: { id: true, name: true, campusId: true, status: true, lastSeenAt: true }, orderBy: { id: "asc" },
  });
  return rows;
};

const gateRevoke = async (schoolId, adminId, req, id) => {
  const screen = await prisma.gateScreen.findFirst({ where: { id: Number(id), schoolId } });
  if (!screen) throw new AttendanceError("Screen not found", 404);
  if (campusScope.isRestricted(req) && !req.campusIds.includes(screen.campusId)) throw new AttendanceError("You do not manage that screen", 403);
  await prisma.gateScreen.update({ where: { id: screen.id }, data: { status: "revoked" } });
  await logEvent({ schoolId, actorType: "admin", actorId: adminId, type: "gate_revoked", detail: { screenId: screen.id } });
  return { revoked: true };
};

module.exports = {
  AttendanceError, getSettings, publicSettings, updateSettings, setSite, locations, currentQr, regenerate,
  clock, today, history, board, reviewQueue, decide, manual, removeRecord, report, reportCsv,
  decideDevice, resetDevices, events, gateStart, gatePair, gateToken, gateList, gateRevoke, localToDate,
};
