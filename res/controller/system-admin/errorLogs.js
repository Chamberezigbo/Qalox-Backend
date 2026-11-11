const prisma = require("../../util/prisma");

/**
 * Read access to the saved server errors, for the platform owner only.
 *   GET /errors                      the bugs seen lately, grouped, most recent first
 *   GET /errors/by-ref/:ref          what happened to a request a user reported ("Ref: 1a2b3c4d")
 *   GET /errors/:fingerprint         every recent occurrence of one bug, with stack traces
 */

const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

exports.listGrouped = async (req, res, next) => {
  try {
    const days = clampInt(req.query.days, 7, 1, 90);
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const schoolId = req.query.schoolId === undefined ? null : Number(req.query.schoolId);
    if (schoolId !== null && !Number.isInteger(schoolId)) {
      return res.status(400).json({ success: false, message: "schoolId must be a whole number" });
    }
    const where = { occurredAt: { gte: since }, ...(schoolId !== null ? { schoolId } : {}) };

    const groups = await prisma.errorLog.groupBy({
      by: ["fingerprint"],
      where,
      _count: { _all: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: "desc" } },
      take: limit,
    });

    const latest = groups.length
      ? await prisma.errorLog.findMany({
          where: { ...where, fingerprint: { in: groups.map((g) => g.fingerprint) } },
          orderBy: { occurredAt: "desc" },
          distinct: ["fingerprint"],
          select: { fingerprint: true, name: true, message: true, route: true, method: true, source: true, statusCode: true },
        })
      : [];
    const byFingerprint = new Map(latest.map((l) => [l.fingerprint, l]));

    res.json({
      success: true,
      data: groups.map((g) => ({
        fingerprint: g.fingerprint,
        count: g._count._all,
        firstSeen: g._min.occurredAt,
        lastSeen: g._max.occurredAt,
        ...(byFingerprint.get(g.fingerprint) ?? {}),
      })),
    });
  } catch (error) {
    next(error);
  }
};

exports.byRef = async (req, res, next) => {
  try {
    const ref = String(req.params.ref || "").trim();
    if (!/^[A-Za-z0-9._-]{6,64}$/.test(ref)) {
      return res.status(400).json({ success: false, message: "Give the reference shown with the error" });
    }
    const rows = await prisma.errorLog.findMany({
      where: { requestId: { startsWith: ref } },
      orderBy: { occurredAt: "desc" },
      take: 20,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};

exports.occurrences = async (req, res, next) => {
  try {
    const fingerprint = String(req.params.fingerprint || "");
    if (!/^[0-9a-f]{40}$/.test(fingerprint)) {
      return res.status(400).json({ success: false, message: "Invalid error id" });
    }
    const rows = await prisma.errorLog.findMany({
      where: { fingerprint },
      orderBy: { occurredAt: "desc" },
      take: clampInt(req.query.limit, 25, 1, 100),
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};
