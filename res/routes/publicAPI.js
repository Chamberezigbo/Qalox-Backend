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
        include: {
          class: { select: { id: true, name: true } },
          academicSession: { select: { id: true, name: true } },
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
        rows: {
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
        students: publishedResult.rows.map((row) => ({
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
 * PATCH /api/public/schools/:id/sms-quota
 * Set a school's per-term SMS broadcast quota (Super Admin Portal, service-to-service)
 */
router.patch(
  "/schools/:id/sms-quota",
  serviceAuth,
  publicController.updateSchoolSmsQuota
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
 * PATCH /api/public/marketers/:id/status
 * Alias of /marketers/:id/suspend — Super Admin Portal's qaloxApiClient
 * calls this path (toggleMarketerStatus) instead of /suspend
 */
router.patch(
  "/marketers/:id/status",
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

/**
 * ============================================
 * GLOBAL SETTINGS ENDPOINTS
 * ============================================
 */

/**
 * GET /api/public/settings/commission
 * Get global commission rate (Super Admin reads)
 */
router.get(
  "/settings/commission",
  serviceAuth,
  publicController.getGlobalCommission
);

/**
 * PATCH /api/public/settings/commission
 * Set global commission rate (Super Admin configures)
 */
router.patch(
  "/settings/commission",
  serviceAuth,
  publicController.setGlobalCommission
);

/**
 * ============================================
 * SCHOOL ASSESSMENT TOKEN ENDPOINTS
 * ============================================
 */

/**
 * POST /api/public/school-tokens
 * Create a new school assessment token (Marketer Portal)
 */
router.post(
  "/school-tokens",
  serviceAuth,
  publicController.createSchoolToken
);

/**
 * GET /api/public/school-tokens
 * List school assessment tokens (Marketer Portal)
 */
router.get(
  "/school-tokens",
  serviceAuth,
  publicController.getSchoolTokens
);

/**
 * GET /api/public/school-tokens/stats
 * Get token statistics (Marketer Portal)
 */
router.get(
  "/school-tokens/stats",
  serviceAuth,
  publicController.getSchoolTokenStats
);

/**
 * ============================================
 * MARKETER PORTAL AUTH ENDPOINTS
 * ============================================
 */

/**
 * POST /api/public/auth/signup
 * Marketer signup (Marketer Portal)
 */
router.post(
  "/auth/signup",
  serviceAuth,
  publicController.marketerSignup
);

/**
 * GET /api/public/auth/profile/:marketerId
 * Get marketer profile (Marketer Portal)
 */
router.get(
  "/auth/profile/:marketerId",
  serviceAuth,
  publicController.getMarketerProfile
);

/**
 * ============================================
 * MARKETER PORTAL SCHOOL MANAGEMENT ENDPOINTS
 * ============================================
 */

/**
 * GET /api/public/marketer-schools?marketerId=1&page=1&limit=20
 * Get schools for a marketer (Marketer Portal)
 */
router.get(
  "/marketer-schools",
  serviceAuth,
  publicController.getMarketerSchools
);

/**
 * POST /api/public/marketer-schools
 * Create a school for a marketer (Marketer Portal)
 */
router.post(
  "/marketer-schools",
  serviceAuth,
  publicController.createMarketerSchool
);

/**
 * PUT /api/public/marketer-schools/:id
 * Update a school (Marketer Portal)
 */
router.put(
  "/marketer-schools/:id",
  serviceAuth,
  publicController.updateMarketerSchool
);

/**
 * ============================================
 * NOTIFICATIONS ENDPOINTS
 * ============================================
 */

/**
 * GET /api/public/notifications
 * Get notifications (Marketer Portal)
 */
router.get(
  "/notifications",
  serviceAuth,
  publicController.getNotifications
);

/**
 * ============================================
 * PHASE 1 - ADDITIONAL MARKETER PORTAL ENDPOINTS
 * ============================================
 */

/**
 * POST /api/public/auth/2fa/verify
 * Verify 2FA code during login
 */
router.post(
  "/auth/2fa/verify",
  serviceAuth,
  publicController.verify2FA
);

/**
 * POST /api/public/marketers/:marketerId/wallet
 * Withdraw or credit funds (withdraw operation)
 */
router.post(
  "/marketers/:marketerId/wallet",
  serviceAuth,
  publicController.marketerWalletOperation
);

/**
 * GET /api/public/school-tokens/by-school
 * Get count of tokens issued per school
 */
router.get(
  "/school-tokens/by-school",
  serviceAuth,
  publicController.getTokensBySchool
);

/**
 * PATCH /api/public/school-tokens/:id/revoke
 * Deactivate/revoke a token
 */
router.patch(
  "/school-tokens/:id/revoke",
  serviceAuth,
  publicController.revokeSchoolToken
);

/**
 * GET /api/public/commissions
 * Get commissions for a marketer
 */
router.get(
  "/commissions",
  serviceAuth,
  publicController.getCommissions
);

/**
 * GET /api/public/commissions/summary
 * Get commission summary (total, pending, monthly)
 */
router.get(
  "/commissions/summary",
  serviceAuth,
  publicController.getCommissionSummary
);

/**
 * PUT /api/public/notifications/:id/read
 * Mark a single notification as read
 */
router.put(
  "/notifications/:id/read",
  serviceAuth,
  publicController.markNotificationRead
);

/**
 * PUT /api/public/notifications/read-all
 * Mark all notifications as read
 */
router.put(
  "/notifications/read-all",
  serviceAuth,
  publicController.markAllNotificationsRead
);

/**
 * ============================================
 * PHASE 2 - USER PROFILE & SETTINGS ENDPOINTS
 * ============================================
 */

/**
 * PUT /api/public/users/profile
 * Update marketer profile information
 */
router.put(
  "/users/profile",
  serviceAuth,
  publicController.updateMarketerProfile
);

/**
 * PUT /api/public/users/password
 * Change marketer password
 */
router.put(
  "/users/password",
  serviceAuth,
  publicController.changePassword
);

/**
 * POST /api/public/users/avatar
 * Upload marketer avatar
 */
router.post(
  "/users/avatar",
  serviceAuth,
  publicController.uploadAvatar
);

/**
 * GET /api/public/settings/banks
 * Get list of Nigerian banks
 */
router.get(
  "/settings/banks",
  serviceAuth,
  publicController.getBankList
);

/**
 * GET /api/public/settings/verify-account
 * Verify bank account
 */
router.get(
  "/settings/verify-account",
  serviceAuth,
  publicController.verifyBankAccount
);

/**
 * PUT /api/public/settings/bank-account
 * Save marketer bank account details
 */
router.put(
  "/settings/bank-account",
  serviceAuth,
  publicController.saveBankAccount
);

/**
 * PUT /api/public/settings/notifications
 * Update notification preferences
 */
router.put(
  "/settings/notifications",
  serviceAuth,
  publicController.updateNotificationSettings
);

/**
 * GET /api/public/transactions
 * Get transaction history
 */
router.get(
  "/transactions",
  serviceAuth,
  publicController.getTransactions
);

/**
 * GET /api/public/transactions/stats
 * Get transaction statistics
 */
router.get(
  "/transactions/stats",
  serviceAuth,
  publicController.getTransactionStats
);

/**
 * POST /api/public/settings/2fa/toggle
 * Enable or disable 2FA
 */
router.post(
  "/settings/2fa/toggle",
  serviceAuth,
  publicController.toggle2FA
);

/**
 * ============================================
 * PHASE 3 - ADVANCED FEATURES & ANALYTICS
 * ============================================
 */

/**
 * POST /api/public/settings/2fa/setup
 * Start 2FA setup process
 */
router.post(
  "/settings/2fa/setup",
  serviceAuth,
  publicController.setup2FA
);

/**
 * POST /api/public/settings/2fa/verify-setup
 * Verify 2FA setup and enable it
 */
router.post(
  "/settings/2fa/verify-setup",
  serviceAuth,
  publicController.verifySetup2FA
);

/**
 * POST /api/public/settings/2fa/disable
 * Disable 2FA
 */
router.post(
  "/settings/2fa/disable",
  serviceAuth,
  publicController.disable2FA
);

/**
 * GET /api/public/commissions/monthly-chart
 * Get monthly commission data for chart
 */
router.get(
  "/commissions/monthly-chart",
  serviceAuth,
  publicController.getMonthlyCommissionChart
);

/**
 * GET /api/public/marketer-schools/stats
 * Get statistics about marketer's schools
 */
router.get(
  "/marketer-schools/stats",
  serviceAuth,
  publicController.getMarketerSchoolsStats
);

/**
 * GET /api/public/dashboard/summary
 * Get dashboard summary for marketer
 */
router.get(
  "/dashboard/summary",
  serviceAuth,
  publicController.getDashboardSummary
);

/**
 * GET /api/public/dashboard/recent-activity
 * Get recent activity for marketer
 */
router.get(
  "/dashboard/recent-activity",
  serviceAuth,
  publicController.getRecentActivity
);

/**
 * PATCH /api/public/school-tokens/:id/status
 * Update school token status
 */
router.patch(
  "/school-tokens/:id/status",
  serviceAuth,
  publicController.updateTokenStatus
);

/**
 * DELETE /api/public/marketer-schools/:id
 * Delete a marketer's school
 */
router.delete(
  "/marketer-schools/:id",
  serviceAuth,
  publicController.deleteMarketerSchool
);

/**
 * GET /api/public/marketer/:marketerId/earnings
 * Get marketer earnings overview
 */
router.get(
  "/marketer/:marketerId/earnings",
  serviceAuth,
  publicController.getMarketerEarnings
);

module.exports = router;
