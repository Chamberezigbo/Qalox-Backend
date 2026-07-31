const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

const MONTHS_BACK = 6;

const monthKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const monthLabel = (date) => new Date(date).toLocaleString("en-US", { month: "short" });

const lastNMonthKeys = (n) => {
  const keys = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push({ key: monthKey(d), label: monthLabel(d) });
  }
  return keys;
};

/**
 * Build a Map<classId, failGradeName | null> by resolving each class's
 * assigned GradingScheme and taking the lowest-scoring tier as "fail".
 * Classes with no scheme assigned resolve to null (excluded from pass-rate math).
 */
const resolveFailGradeByClass = async (classIds) => {
  if (classIds.length === 0) return new Map();

  const links = await prisma.gradingSchemeClass.findMany({
    where: { classId: { in: classIds } },
    select: {
      classId: true,
      scheme: {
        select: {
          grades: { select: { grade: true, minScore: true }, orderBy: { minScore: "asc" } },
        },
      },
    },
  });

  const map = new Map();
  links.forEach((link) => {
    const failGrade = link.scheme?.grades?.[0]?.grade ?? null;
    map.set(link.classId, failGrade);
  });
  return map;
};

/**
 * Compute pass rate (0-100) for a set of PublishedResultRows, given the
 * classId each row belongs to and the fail-grade map. Rows whose class has
 * no grading scheme assigned are excluded (can't classify pass/fail).
 */
const computePassRate = (rows, classIdByRowId, failGradeByClass) => {
  let countable = 0;
  let passed = 0;
  rows.forEach((row) => {
    const classId = classIdByRowId.get(row.id);
    const failGrade = failGradeByClass.get(classId);
    if (failGrade === undefined || failGrade === null) return; // no scheme — can't classify
    countable++;
    if (row.grade !== failGrade) passed++;
  });
  if (countable === 0) return null;
  return Math.round((passed / countable) * 100);
};

/**
 * GET /api/admin/analytics/campuses
 * Per-campus analytics: pass rate, revenue trend, enrollment growth,
 * outstanding fees, and department breakdown (where classes are tagged).
 */
exports.getCampusAnalytics = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;

    const [campuses, classes, students, resultRows, studentFees, payments] = await Promise.all([
      prisma.campus.findMany({ where: { schoolId } }),
      prisma.class.findMany({ where: { schoolId }, select: { id: true, campusId: true, department: true } }),
      prisma.student.findMany({ where: { schoolId }, select: { id: true, campusId: true, classId: true, createdAt: true } }),
      prisma.publishedResultRow.findMany({
        where: { publishedResult: { class: { schoolId } } },
        select: { id: true, grade: true, publishedResult: { select: { classId: true } } },
      }),
      prisma.studentFee.findMany({
        where: { schoolId },
        select: { id: true, totalFee: true, amountPaid: true, student: { select: { campusId: true, classId: true } } },
      }),
      prisma.payment.findMany({
        where: { studentFee: { schoolId } },
        select: {
          amount: true,
          paymentDate: true,
          studentFee: { select: { student: { select: { campusId: true, classId: true } } } },
        },
      }),
    ]);

    const classIdByRowId = new Map(resultRows.map((r) => [r.id, r.publishedResult.classId]));
    const failGradeByClass = await resolveFailGradeByClass(classes.map((c) => c.id));
    const classById = new Map(classes.map((c) => [c.id, c]));
    const months = lastNMonthKeys(MONTHS_BACK);

    // A student's own campusId is often left unset (e.g. single-campus schools
    // rarely bother tagging it) — fall back to their class's campusId, which is
    // set explicitly when the class itself was created.
    const effectiveCampusId = (campusId, classId) => campusId ?? classById.get(classId)?.campusId ?? null;

    const data = campuses.map((campus) => {
      const campusClasses = classes.filter((c) => c.campusId === campus.id);
      const campusClassIds = new Set(campusClasses.map((c) => c.id));
      const campusStudents = students.filter((s) => effectiveCampusId(s.campusId, s.classId) === campus.id);
      const campusResultRows = resultRows.filter((r) => campusClassIds.has(r.publishedResult.classId));
      const campusStudentFees = studentFees.filter(
        (sf) => effectiveCampusId(sf.student.campusId, sf.student.classId) === campus.id
      );
      const campusPayments = payments.filter(
        (p) => effectiveCampusId(p.studentFee.student.campusId, p.studentFee.student.classId) === campus.id
      );

      const passRate = computePassRate(campusResultRows, classIdByRowId, failGradeByClass) ?? 0;

      const totalRevenue = campusPayments.reduce((sum, p) => sum + p.amount, 0);
      const outstandingFees = campusStudentFees.reduce(
        (sum, sf) => sum + Math.max(sf.totalFee - sf.amountPaid, 0),
        0
      );

      // Department breakdown — group this campus's classes by department,
      // then attribute students to a department via their own classId
      const deptGroups = new Map(); // department -> { classIds: Set, students: number }
      campusClasses.forEach((c) => {
        const dept = c.department || "Unspecified";
        if (!deptGroups.has(dept)) deptGroups.set(dept, { classIds: new Set(), students: 0 });
        deptGroups.get(dept).classIds.add(c.id);
      });
      campusStudents.forEach((s) => {
        const cls = classById.get(s.classId);
        if (!cls) return;
        const dept = cls.department || "Unspecified";
        const group = deptGroups.get(dept);
        if (group) group.students++;
      });

      const departments = Array.from(deptGroups.entries()).map(([name, group]) => {
        const deptRows = campusResultRows.filter((r) => group.classIds.has(classIdByRowId.get(r.id)));
        const deptPassRate = computePassRate(deptRows, classIdByRowId, failGradeByClass) ?? 0;
        return { name, passRate: deptPassRate, students: group.students, classIds: group.classIds };
      });

      const bestDeptCandidate = departments
        .filter((d) => d.name !== "Unspecified" && d.students > 0)
        .sort((a, b) => b.passRate - a.passRate)[0];

      // Monthly revenue (last 6 months)
      const monthlyRevenue = months.map(({ key, label }) => ({
        month: label,
        amount: campusPayments
          .filter((p) => monthKey(p.paymentDate) === key)
          .reduce((sum, p) => sum + p.amount, 0),
      }));

      // Enrollment growth (cumulative student count, last 6 months).
      // "YYYY-MM" string comparison works correctly here since both sides are
      // zero-padded and share the same format.
      const enrollmentGrowth = months.map(({ key, label }) => ({
        month: label,
        students: campusStudents.filter((s) => monthKey(s.createdAt) <= key).length,
      }));

      return {
        id: campus.id,
        name: campus.name,
        location: campus.address || "",
        totalStudents: campusStudents.length,
        passRate,
        outstandingFees,
        totalRevenue,
        revenueTarget: campus.revenueTarget ?? 0,
        bestDepartment: bestDeptCandidate?.name ?? "Unspecified",
        departments: departments.map((d) => ({ name: d.name, passRate: d.passRate, students: d.students })),
        monthlyRevenue,
        enrollmentGrowth,
      };
    });

    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error("[GET_CAMPUS_ANALYTICS] Failed", { error: err.message });
    next(err);
  }
};
