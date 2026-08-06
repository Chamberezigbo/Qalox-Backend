const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

/**
 * GET /api/analytics/stats
 * Built on LoginEvent, which is written going forward only — there is no
 * historical login data to backfill, so these numbers only reflect activity
 * from the day LoginEvent shipped.
 */
exports.getAnalyticsStats = async (req, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 7);

    const [totalLoginsToday, totalLoginsThisWeek, bySchool] = await Promise.all([
      prisma.loginEvent.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.loginEvent.count({ where: { createdAt: { gte: startOfWeek } } }),
      prisma.loginEvent.groupBy({
        by: ["schoolId"],
        where: { schoolId: { not: null }, createdAt: { gte: startOfWeek } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 1,
      }),
    ]);

    let mostActiveSchool = "—";
    if (bySchool.length > 0) {
      const school = await prisma.school.findUnique({ where: { id: bySchool[0].schoolId }, select: { name: true } });
      mostActiveSchool = school?.name || "—";
    }

    const loginsByDay = [];
    for (let i = 6; i >= 0; i--) {
      const start = new Date();
      start.setDate(start.getDate() - i);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      const count = await prisma.loginEvent.count({ where: { createdAt: { gte: start, lt: end } } });
      loginsByDay.push({ date: start.toISOString().slice(0, 10), count });
    }

    // Engagement/low-engagement figures depend on per-school activity computed below;
    // reuse getSchoolActivities' logic at a smaller scale for the summary card.
    const schoolsWithLogins = await prisma.loginEvent.groupBy({
      by: ["schoolId"],
      where: { schoolId: { not: null } },
      _count: { id: true },
    });
    const engagementScores = schoolsWithLogins.map((s) => Math.min(100, s._count.id * 5));
    const avgEngagementScore = engagementScores.length > 0
      ? Math.round(engagementScores.reduce((a, b) => a + b, 0) / engagementScores.length)
      : 0;
    const lowEngagementCount = engagementScores.filter((s) => s < 30).length;

    res.json({
      success: true,
      data: { totalLoginsToday, totalLoginsThisWeek, avgEngagementScore, mostActiveSchool, lowEngagementCount, loginsByDay },
    });
  } catch (err) {
    logger.error("[ANALYTICS] Failed to fetch stats", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/analytics/schools
 */
exports.getSchoolActivities = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const { search } = req.query;

    const where = search ? { name: { contains: search } } : {};
    const [schools, total] = await Promise.all([
      prisma.school.findMany({
        where,
        select: {
          id: true,
          name: true,
          billingPlan: { select: { name: true } },
          admins: { take: 1, select: { name: true } },
        },
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.school.count({ where }),
    ]);

    const data = await Promise.all(
      schools.map(async (school) => {
        const [totalLogins, lastEvent, activeTeachers, activeStudents] = await Promise.all([
          prisma.loginEvent.count({ where: { schoolId: school.id } }),
          prisma.loginEvent.findFirst({ where: { schoolId: school.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
          prisma.staff.count({ where: { schoolId: school.id } }),
          prisma.student.count({ where: { schoolId: school.id } }),
        ]);

        return {
          schoolId: school.id,
          schoolName: school.name,
          adminName: school.admins[0]?.name || "",
          plan: school.billingPlan?.name || "—",
          totalLogins,
          lastLogin: lastEvent?.createdAt || null,
          activeTeachers,
          activeStudents,
          engagementScore: Math.min(100, totalLogins * 5),
        };
      })
    );

    res.json({ success: true, data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error("[ANALYTICS] Failed to fetch school activities", { error: err.message });
    next(err);
  }
};

const resolveActorDisplay = async (actorType, actorId) => {
  switch (actorType) {
    case "admin":
    case "marketer": {
      const admin = await prisma.admin.findUnique({ where: { id: actorId }, select: { name: true, email: true } });
      return { name: admin?.name || "Unknown", email: admin?.email || "" };
    }
    case "teacher": {
      const staff = await prisma.staff.findUnique({ where: { id: actorId }, select: { name: true, email: true } });
      return { name: staff?.name || "Unknown", email: staff?.email || "" };
    }
    case "student": {
      const student = await prisma.student.findUnique({ where: { id: actorId }, select: { name: true, surname: true } });
      return { name: student ? `${student.name} ${student.surname}` : "Unknown", email: "" };
    }
    case "parent": {
      const parent = await prisma.parent.findUnique({ where: { id: actorId }, select: { name: true, email: true } });
      return { name: parent?.name || "Unknown", email: parent?.email || "" };
    }
    default:
      return { name: "Unknown", email: "" };
  }
};

/**
 * GET /api/analytics/logins
 */
exports.getLoginRecords = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));

    const [events, total] = await Promise.all([
      prisma.loginEvent.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { school: { select: { name: true } } },
      }),
      prisma.loginEvent.count(),
    ]);

    const data = await Promise.all(
      events.map(async (e) => {
        const actor = await resolveActorDisplay(e.actorType, e.actorId);
        return {
          id: e.id,
          schoolId: e.schoolId,
          schoolName: e.school?.name || "—",
          adminName: actor.name,
          adminEmail: actor.email,
          loginAt: e.createdAt,
          ipAddress: e.ip || "",
          device: e.userAgent || "",
          location: "", // no IP-geolocation lookup wired up
        };
      })
    );

    res.json({ success: true, data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error("[ANALYTICS] Failed to fetch login records", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/analytics/features
 * No per-feature usage tracking exists in this codebase yet — returns an
 * honest empty list rather than fabricated adoption numbers. Building this
 * for real needs a product decision on what counts as a trackable
 * feature-usage event.
 */
exports.getFeatureUsage = async (req, res, next) => {
  try {
    res.json({ success: true, data: [] });
  } catch (err) {
    next(err);
  }
};
