/**
 * Public API Routes for Super Admin & Marketer Portal
 * These endpoints are called by other services to read shared data
 */

const express = require("express");
const { serviceAuth } = require("../middleware/serviceAuth");
const validate = require("../middleware/validator");
const prisma = require("../util/prisma");
const publicController = require("../controller/public/publicController");
const {
  suspendSchoolSchema,
  deleteSchoolSchema,
  createAdminSchema,
} = require("../schemas/publicAPISchemas");

const router = express.Router();

/**
 * GET /api/public/students?schoolId=1&page=1&limit=50
 * Returns students for Marketer Portal reports
 */
router.get("/students", serviceAuth, async (req, res, next) => {
  try {
    const schoolId = parseInt(req.query.schoolId);
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));

    if (!schoolId) {
      return res.status(400).json({
        success: false,
        message: "schoolId query parameter is required",
        code: "MISSING_SCHOOL_ID",
      });
    }

    const where = { schoolId };
    if (classId) where.classId = classId;

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        where,
        select: {
          id: true,
          registrationNumber: true,
          name: true,
          surname: true,
          email: true,
          gender: true,
          dateOfBirth: true,
          classId: true,
          academicSessionId: true,
          passportUrl: true,
          createdAt: true,
        },
        include: {
          class: { select: { id: true, name: true } },
          academicSession: { select: { id: true, name: true, isActive: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.student.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: students,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/results/published?classId=5&academicSessionId=1
 * Returns published results for school reports
 */
router.get("/results/published", serviceAuth, async (req, res, next) => {
  try {
    const classId = parseInt(req.query.classId);
    const academicSessionId = parseInt(req.query.academicSessionId);

    if (!classId || !academicSessionId) {
      return res.status(400).json({
        success: false,
        message: "classId and academicSessionId are required",
        code: "MISSING_PARAMETERS",
      });
    }

    // Get published results
    const publishedResult = await prisma.publishedResult.findFirst({
      where: { classId, academicSessionId },
      include: {
        publishedResultRows: {
          include: {
            student: {
              select: {
                id: true,
                registrationNumber: true,
                name: true,
                surname: true,
              },
            },
          },
        },
      },
    });

    if (!publishedResult) {
      return res.status(404).json({
        success: false,
        message: "No published results found for this class and session",
        code: "RESULTS_NOT_FOUND",
      });
    }

    // Format response
    const classData = await prisma.class.findUnique({
      where: { id: classId },
      select: { name: true },
    });

    const sessionData = await prisma.academicSession.findUnique({
      where: { id: academicSessionId },
      select: { name: true },
    });

    return res.status(200).json({
      success: true,
      message: "Published results retrieved",
      data: {
        classId,
        className: classData?.name,
        academicSessionId,
        sessionName: sessionData?.name,
        publishedAt: publishedResult.publishedAt,
        students: publishedResult.publishedResultRows.map((row) => ({
          studentId: row.student.id,
          registrationNumber: row.student.registrationNumber,
          name: `${row.student.name} ${row.student.surname}`,
          caTotal: row.caTotal,
          examScore: row.examScore,
          finalScore: row.finalScore,
          grade: row.grade,
          position: row.position,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/tokens/validate
 * Validate admin registration token
 */
router.post("/tokens/validate", serviceAuth, async (req, res, next) => {
  try {
    const { email, uniqueKey } = req.body;

    if (!email || !uniqueKey) {
      return res.status(400).json({
        success: false,
        message: "email and uniqueKey are required",
        code: "MISSING_PARAMETERS",
      });
    }

    const token = await prisma.token.findUnique({ where: { email } });

    if (!token) {
      return res.status(404).json({
        success: false,
        valid: false,
        message: "Token not found",
        code: "TOKEN_NOT_FOUND",
      });
    }

    if (token.uniqueKey !== uniqueKey) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    if (token.status !== "active") {
      return res.status(400).json({
        success: false,
        valid: false,
        message: "Token is not active",
        code: "TOKEN_INACTIVE",
      });
    }

    return res.status(200).json({
      success: true,
      valid: true,
      token: {
        id: token.id,
        email: token.email,
        uniqueKey: token.uniqueKey,
        status: token.status,
        schoolName: token.schoolName,
        createdAt: token.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/public/tokens/:uniqueKey/deactivate
 * Deactivate token after admin creation
 */
router.patch("/tokens/:uniqueKey/deactivate", serviceAuth, async (req, res, next) => {
  try {
    const { uniqueKey } = req.params;

    const token = await prisma.token.findUnique({ where: { uniqueKey } });

    if (!token) {
      return res.status(404).json({
        success: false,
        message: "Token not found",
        code: "TOKEN_NOT_FOUND",
      });
    }

    const updated = await prisma.token.update({
      where: { uniqueKey },
      data: { status: "inactive" },
    });

    return res.status(200).json({
      success: true,
      message: "Token deactivated",
      data: {
        id: updated.id,
        uniqueKey: updated.uniqueKey,
        status: updated.status,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * ============================================
 * NEW ENDPOINTS FOR SUPER ADMIN PORTAL
 * ============================================
 */

/**
 * GET /api/public/schools/:id
 * Retrieve single school with campuses (service-to-service)
 */
router.get("/schools/:id", serviceAuth, publicController.getSchoolById);

/**
 * PATCH /api/public/schools/:id/suspend
 * Suspend or reactivate a school (service-to-service)
 */
router.patch(
  "/schools/:id/suspend",
  serviceAuth,
  validate(suspendSchoolSchema),
  publicController.suspendSchool
);

/**
 * DELETE /api/public/schools/:id
 * Permanently delete a school with cascade deletion (service-to-service)
 */
router.delete(
  "/schools/:id",
  serviceAuth,
  validate(deleteSchoolSchema),
  publicController.deleteSchool
);

/**
 * POST /api/public/admins
 * Create an admin account (service-to-service, after token validation)
 */
router.post(
  "/admins",
  serviceAuth,
  validate(createAdminSchema),
  publicController.createAdmin
);

/**
 * ============================================
 * AUTHENTICATION ENDPOINTS
 * ============================================
 */

/**
 * POST /api/public/auth/login
 * Login for admins and marketers (returns user info for JWT generation)
 * Used by: Super Admin Portal, Marketer Portal
 */
router.post(
  "/auth/login",
  serviceAuth,
  publicController.loginPublic
);

/**
 * ============================================
 * MARKETER ENDPOINTS
 * ============================================
 */

/**
 * POST /api/public/marketers
 * Create a new marketer account (service-to-service)
 */
router.post(
  "/marketers",
  serviceAuth,
  publicController.createMarketer
);

/**
 * GET /api/public/marketers
 * List all marketers with pagination (service-to-service)
 */
router.get(
  "/marketers",
  serviceAuth,
  publicController.listMarketers
);

/**
 * GET /api/public/marketers/:id
 * Get marketer details (service-to-service)
 */
router.get(
  "/marketers/:id",
  serviceAuth,
  publicController.getMarketerById
);

/**
 * PATCH /api/public/marketers/:id
 * Update marketer details (service-to-service)
 */
router.patch(
  "/marketers/:id",
  serviceAuth,
  publicController.updateMarketer
);

/**
 * PATCH /api/public/marketers/:id/suspend
 * Suspend or activate a marketer (service-to-service)
 */
router.patch(
  "/marketers/:id/suspend",
  serviceAuth,
  publicController.suspendMarketer
);

/**
 * ============================================
 * COMMISSION & WALLET ENDPOINTS
 * ============================================
 */

/**
 * PATCH /api/public/marketers/:id/commission
 * Set marketer commission rate (Super Admin configures)
 */
router.patch(
  "/marketers/:id/commission",
  serviceAuth,
  publicController.setMarketerCommission
);

/**
 * GET /api/public/marketers/:id/wallet
 * Get marketer wallet and financial information
 */
router.get(
  "/marketers/:id/wallet",
  serviceAuth,
  publicController.getMarketerWallet
);

/**
 * PATCH /api/public/marketers/:id/wallet
 * Update wallet balance (credit, debit, payout operations)
 */
router.patch(
  "/marketers/:id/wallet",
  serviceAuth,
  publicController.updateMarketerWallet
);

module.exports = router;
