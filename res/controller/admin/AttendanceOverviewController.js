const prisma = require("../../util/prisma");
const campusScope = require("../../util/campusScope");
const { parseIsoDate, weekDays, summarizeStudent } = require("../../util/attendanceWeek");

/**
 * Read-only view of the attendance each teacher keeps, for admins.
 *   GET /attendance/teachers     teachers who take attendance, with their classes
 *   GET /attendance/broadsheet   one teacher's class for one week (Monday to Friday)
 * A teacher takes attendance for the classes they are assigned to (see AttendanceService), so
 * that is the list shown here. A campus sub-admin only sees their own campuses' teachers and classes.
 */

const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

exports.listTeachers = async (req, res, next) => {
  try {
    const assignments = await prisma.teacherAssignment.findMany({
      where: {
        classId: { not: null },
        staff: campusScope.withScope({ schoolId: req.schoolId }, campusScope.staffWhere(req)),
        ...(campusScope.isRestricted(req) ? { class: campusScope.classWhere(req) } : {}),
      },
      select: {
        staff: { select: { id: true, name: true, registrationNumber: true } },
        class: { select: { id: true, name: true, customName: true, campusId: true } },
      },
    });

    const byTeacher = new Map();
    for (const a of assignments) {
      if (!a.class || !a.staff) continue;
      const entry = byTeacher.get(a.staff.id) ?? { ...a.staff, classes: new Map() };
      entry.classes.set(a.class.id, a.class);
      byTeacher.set(a.staff.id, entry);
    }

    const data = [...byTeacher.values()]
      .map((t) => ({ ...t, classes: [...t.classes.values()].sort((x, y) => x.name.localeCompare(y.name)) }))
      .sort((x, y) => x.name.localeCompare(y.name));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.broadsheet = async (req, res, next) => {
  try {
    const staffId = Number(req.query.staffId);
    const classId = Number(req.query.classId);
    const groupId = req.query.groupId ? Number(req.query.groupId) : null;
    if (!Number.isInteger(staffId) || !Number.isInteger(classId)) return bad(res, "staffId and classId are required");

    const anchor = req.query.weekStart ? parseIsoDate(String(req.query.weekStart)) : new Date();
    if (!anchor) return bad(res, "weekStart must be a date like 2026-11-09");
    const days = weekDays(anchor);

    // The class and teacher must be this admin's to see, and the teacher must actually take attendance for it.
    const [cls, teacher, assignment] = await Promise.all([
      prisma.class.findFirst({
        where: campusScope.withScope({ id: classId, schoolId: req.schoolId }, campusScope.classWhere(req)),
        select: { id: true, name: true, customName: true },
      }),
      prisma.staff.findFirst({
        where: campusScope.withScope({ id: staffId, schoolId: req.schoolId }, campusScope.staffWhere(req)),
        select: { id: true, name: true, registrationNumber: true },
      }),
      prisma.teacherAssignment.findFirst({ where: { staffId, classId }, select: { id: true } }),
    ]);
    if (!cls || !teacher) return bad(res, "Teacher or class not found", 404);
    if (!assignment) return bad(res, `${teacher.name} does not take attendance for ${cls.name}`, 404);

    if (groupId !== null) {
      const group = await prisma.classGroup.findFirst({ where: { id: groupId, classId }, select: { id: true } });
      if (!group) return bad(res, "That group does not belong to the selected class", 404);
    }

    const [students, records] = await Promise.all([
      prisma.student.findMany({
        where: { schoolId: req.schoolId, classId, status: "active", ...(groupId !== null ? { classGroupId: groupId } : {}) },
        select: { id: true, name: true, surname: true, otherNames: true, registrationNumber: true },
        orderBy: { surname: "asc" },
      }),
      prisma.attendance.findMany({
        where: { classId, date: { gte: new Date(`${days[0]}T00:00:00.000Z`), lte: new Date(`${days[4]}T00:00:00.000Z`) } },
        select: { studentId: true, date: true, status: true, markedByStaff: { select: { name: true } } },
      }),
    ]);

    const statusOf = new Map(records.map((r) => [`${r.studentId}|${r.date.toISOString().slice(0, 10)}`, r.status]));

    // Per day: was attendance taken, and by whom (the teacher, or someone else covering).
    const daySummary = days.map((date) => {
      const rows = records.filter((r) => r.date.toISOString().slice(0, 10) === date);
      return {
        date,
        taken: rows.length > 0,
        markedBy: [...new Set(rows.map((r) => r.markedByStaff?.name).filter(Boolean))],
      };
    });

    const rows = students.map((s) => {
      const statuses = days.map((d) => statusOf.get(`${s.id}|${d}`) ?? null);
      return { ...s, days: statuses, ...summarizeStudent(statuses) };
    });

    const present = rows.reduce((a, r) => a + r.present, 0);
    const absent = rows.reduce((a, r) => a + r.absent, 0);
    const late = rows.reduce((a, r) => a + r.late, 0);
    const marked = present + absent + late;

    res.json({
      success: true,
      data: {
        teacher,
        class: cls,
        week: { start: days[0], end: days[4], days },
        daySummary,
        students: rows,
        totals: { present, absent, late, classRate: marked > 0 ? Math.round(((present + late) / marked) * 100) : 0, daysTaken: daySummary.filter((d) => d.taken).length },
      },
    });
  } catch (error) {
    next(error);
  }
};
