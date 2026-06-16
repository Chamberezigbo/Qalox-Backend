const prisma = require("../../util/prisma");

// GET /api/public/schools
// Returns all schools with only id, name, email (no auth)
exports.getSchoolsPublic = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || 1, 10);
    const pageSize = parseInt(req.query.pageSize || 50, 10);
    const take = Math.min(Math.max(pageSize, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;

    const [schools, total] = await Promise.all([
      prisma.school.findMany({
        select: { id: true, name: true, email: true },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.school.count(),
    ]);

    res.status(200).json({
      success: true,
      count: schools.length,
      total,
      page: Math.max(page, 1),
      pageSize: take,
      schools,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/public/assessments
// Returns all Continuous Assessments (no auth)
exports.getAssessmentsPublic = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || 1, 10);
    const pageSize = parseInt(req.query.pageSize || 50, 10);
    const take = Math.min(Math.max(pageSize, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;

    const [items, total] = await Promise.all([
      prisma.continuousAssessment.findMany({
        select: {
          id: true,
          classId: true,
          subjectId: true,
          name: true,
          maxScore: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.continuousAssessment.count(),
    ]);

    res.status(200).json({
      success: true,
      count: items.length,
      total,
      page: Math.max(page, 1),
      pageSize: take,
      assessments: items,
    });
  } catch (err) {
    next(err);
  }
};
