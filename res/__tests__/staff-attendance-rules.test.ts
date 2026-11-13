const qr = require("../util/staffQr");
const rules = require("../util/staffAttendanceRules");

describe("staff QR tokens", () => {
  const secret = qr.newSecret();
  const now = 1_700_000_000_000;

  it("accepts a live token in its window and the one after", () => {
    const { token } = qr.liveToken({ secret, version: 1, site: 3, nowMs: now });
    expect(qr.verifyToken({ token, secret, version: 1, mode: "live", nowMs: now })).toMatchObject({ ok: true, site: 3 });
    expect(qr.verifyToken({ token, secret, version: 1, mode: "live", nowMs: now + 15_000 }).ok).toBe(true);
  });
  it("expires a live token after about a minute (a screenshot is useless)", () => {
    const { token } = qr.liveToken({ secret, version: 1, site: 0, nowMs: now });
    expect(qr.verifyToken({ token, secret, version: 1, mode: "live", nowMs: now + 95_000 })).toEqual({ ok: false, reason: "expired" });
  });
  it("rejects other secrets, old versions, tampered sites and the wrong mode", () => {
    const { token } = qr.liveToken({ secret, version: 1, site: 1, nowMs: now });
    expect(qr.verifyToken({ token, secret: qr.newSecret(), version: 1, mode: "live", nowMs: now }).reason).toBe("bad_signature");
    expect(qr.verifyToken({ token, secret, version: 2, mode: "live", nowMs: now }).reason).toBe("revoked");
    expect(qr.verifyToken({ token: token.replace("v1.1.", "v1.2."), secret, version: 1, mode: "live", nowMs: now }).reason).toBe("bad_signature");
    expect(qr.verifyToken({ token, secret, version: 1, mode: "printed", nowMs: now }).reason).toBe("wrong_mode");
  });
  it("printed tokens last until the version changes", () => {
    const token = qr.printedToken({ secret, version: 4, site: 2 });
    expect(qr.verifyToken({ token, secret, version: 4, mode: "printed", nowMs: now + 9e9 })).toMatchObject({ ok: true, site: 2 });
    expect(qr.verifyToken({ token, secret, version: 5, mode: "printed" }).reason).toBe("revoked");
    expect(qr.verifyToken({ token, secret, version: 4, mode: "live" }).reason).toBe("wrong_mode");
  });
  it("rejects garbage", () => {
    for (const t of ["", "x", "v1.2", null, "p1.0.zzz", "a".repeat(200)]) {
      expect(qr.verifyToken({ token: t, secret, version: 1, mode: "live" }).ok).toBe(false);
    }
  });
});

describe("location verdict", () => {
  const site = { lat: 6.5244, lng: 3.3792 };
  const base = { site, radius: 150, requireLocation: true };
  it("passes near the school and flags far away", () => {
    expect(rules.locationVerdict({ ...base, location: { lat: 6.5250, lng: 3.3792, accuracy: 15 } }).flags).toEqual([]);
    expect(rules.locationVerdict({ ...base, location: { lat: 6.60, lng: 3.38, accuracy: 15 } }).flags).toEqual(["outside_area"]);
  });
  it("caps the GPS-accuracy allowance so a bad fix cannot widen the gate", () => {
    // ~330 m away with a claimed accuracy of 190 m: allowance is capped at 100 m, so still outside 150+100.
    const v = rules.locationVerdict({ ...base, location: { lat: 6.5274, lng: 3.3792, accuracy: 190 } });
    expect(v.flags).toEqual(["outside_area"]);
  });
  it("flags missing or very poor locations, and ignores them when not required", () => {
    expect(rules.locationVerdict({ ...base, location: undefined }).flags).toEqual(["no_location"]);
    expect(rules.locationVerdict({ ...base, location: { lat: 6.5244, lng: 3.3792, accuracy: 900 } }).flags).toEqual(["poor_gps"]);
    expect(rules.locationVerdict({ ...base, requireLocation: false, location: undefined }).flags).toEqual([]);
  });
  it("does not hold staff back when the school has not set its location yet", () => {
    const v = rules.locationVerdict({ ...base, site: null, location: { lat: 1, lng: 1, accuracy: 5 } });
    expect(rules.holdsForReview(v.flags)).toBe(false);
  });
});

describe("time rules", () => {
  it("reads local day and minutes in Lagos (UTC+1)", () => {
    expect(rules.localParts(new Date("2026-11-13T22:30:00Z"), "Africa/Lagos")).toMatchObject({ day: "2026-11-13", minutes: 23 * 60 + 30 });
    expect(rules.localParts(new Date("2026-11-13T23:30:00Z"), "Africa/Lagos").day).toBe("2026-11-14");
  });
  it("counts lateness only after the grace period", () => {
    const s = { workStart: "07:30", graceMinutes: 15 };
    expect(rules.lateMinutes(s, 7 * 60 + 45)).toBe(0);
    expect(rules.lateMinutes(s, 8 * 60)).toBe(30);
  });
  it("derives the board status", () => {
    const ctx = { isWorkDayToday: true, pastStart: true };
    expect(rules.boardStatus(undefined, ctx)).toBe("absent");
    expect(rules.boardStatus(undefined, { ...ctx, pastStart: false })).toBe("not_in_yet");
    expect(rules.boardStatus({ status: "needs_review" }, ctx)).toBe("needs_review");
    expect(rules.boardStatus({ status: "verified", lateMinutes: 10 }, ctx)).toBe("late");
    expect(rules.boardStatus({ status: "verified", lateMinutes: 0, signOutAt: new Date() }, ctx)).toBe("signed_out");
  });
});
export {};
