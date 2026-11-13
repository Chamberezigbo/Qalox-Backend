const svc = require("../Services/StaffAttendanceService");

const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req, res);
    if (data !== undefined) res.json({ success: true, data });
  } catch (err) {
    if (err instanceof svc.AttendanceError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    }
    next(err);
  }
};

const adminId = (req) => req.user.id;

exports.staff = {
  today: wrap((req) => svc.today(req.schoolId, req.staffId)),
  history: wrap((req) => svc.history(req.schoolId, req.staffId, req.query.month)),
  clock: wrap((req) =>
    svc.clock(req.schoolId, req.staffId, {
      token: req.body?.token, deviceId: req.body?.deviceId, location: req.body?.location, ip: req.ip,
    })
  ),
};

exports.admin = {
  board: wrap((req) => svc.board(req.schoolId, req, req.query.day)),
  review: wrap((req) => svc.reviewQueue(req.schoolId, req)),
  decide: wrap((req) => svc.decide(req.schoolId, adminId(req), req, req.params.id, req.body?.decision, req.body?.note)),
  manual: wrap((req) => svc.manual(req.schoolId, adminId(req), req, req.body || {})),
  removeRecord: wrap((req) => svc.removeRecord(req.schoolId, adminId(req), req, req.params.id, req.body?.reason)),
  report: wrap(async (req, res) => {
    const data = await svc.report(req.schoolId, req, req.query);
    if (req.query.format === "csv") {
      const settings = await svc.getSettings(req.schoolId);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="staff-attendance-${data.from}-to-${data.to}.csv"`);
      res.send(svc.reportCsv(data, settings.timezone));
      return undefined;
    }
    return data;
  }),
  settings: wrap(async (req) => svc.publicSettings(await svc.getSettings(req.schoolId))),
  updateSettings: wrap((req) => svc.updateSettings(req.schoolId, adminId(req), req.body || {})),
  locations: wrap((req) => svc.locations(req.schoolId, req)),
  setSite: wrap((req) => svc.setSite(req.schoolId, adminId(req), req, req.body || {})),
  qr: wrap((req) => svc.currentQr(req.schoolId, req, req.query.campusId)),
  regenerate: wrap((req) => svc.regenerate(req.schoolId, adminId(req))),
  decideDevice: wrap((req) => svc.decideDevice(req.schoolId, adminId(req), req, req.params.id, req.body?.decision)),
  resetDevices: wrap((req) => svc.resetDevices(req.schoolId, adminId(req), req, req.params.staffId)),
  events: wrap((req) => svc.events(req.schoolId, req, req.query)),
  gateList: wrap((req) => svc.gateList(req.schoolId, req)),
  gatePair: wrap((req) => svc.gatePair(req.schoolId, adminId(req), req, req.body || {})),
  gateRevoke: wrap((req) => svc.gateRevoke(req.schoolId, adminId(req), req, req.params.id)),
};

// Public: the gate tablet identifies itself with its own secret key, never an admin login.
exports.gate = {
  start: wrap((req) => svc.gateStart(req.body?.key)),
  token: wrap((req) => svc.gateToken(req.body?.key)),
};
