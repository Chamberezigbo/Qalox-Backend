/**
 * Public API Routes for Super Admin & Marketer Portal
 * These endpoints are called by other services to read shared data
 */

const express = require("express");
const { serviceAuth, requirePlatformSuperAdmin } = require("../middleware/serviceAuth");
const { signedDocumentAccess } = require("../middleware/signedDocumentAccess");
const { single: uploadKycSingle } = require("../middleware/uploadKyc");
const { single: uploadAvatarSingle } = require("../middleware/uploadAvatar");
const payoutRequestController = require("../controller/public/payoutRequestController");
const twoFactorController = require("../controller/public/twoFactorController");
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

const { getRecipientStats, sendSuperAdminNotification } = require("../controller/superadmin/NotificationsController");

router.get(
  "/super-admin/notifications/recipient-stats",
  serviceAuth,
  requirePlatformSuperAdmin,
  getRecipientStats
);

router.post(
  "/super-admin/notifications",
  serviceAuth,
  requirePlatformSuperAdmin,
  sendSuperAdminNotification
);


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
  requirePlatformSuperAdmin,
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
  requirePlatformSuperAdmin,
  publicController.updateSchoolSmsQuota
);

/**
 * DELETE /api/public/schools/:id
 * Permanently delete a school with cascade deletion (service-to-service)
 */
router.delete(
  "/schools/:id",
  serviceAuth,
  requirePlatformSuperAdmin,
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
  requirePlatformSuperAdmin,
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
 * POST /api/public/auth/forgot-password
 * Sends a password reset link by email if the address has an account.
 */
router.post(
  "/auth/forgot-password",
  serviceAuth,
  publicController.forgotPassword
);

/**
 * POST /api/public/auth/reset-password
 * Consumes the token from the forgot-password email to set a new password.
 */
router.post(
  "/auth/reset-password",
  serviceAuth,
  publicController.resetPassword
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
  requirePlatformSuperAdmin,
  publicController.createMarketer
);

/**
 * GET /api/public/marketers
 * List all marketers with pagination (service-to-service)
 */
router.get(
  "/marketers",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.listMarketers
);

/**
 * GET /api/public/marketers/documents/pending?page=&limit=
 * Verification queue — pending documents across all marketers, newest first.
 *
 * Registered above the /marketers/:id block on purpose. It doesn't actually
 * collide today (Express matches on segment count, and no :id route has
 * "documents/pending" as its tail), but the ordering here is the same defensive
 * habit as /marketers/me/wallet below: literal paths before parameterised ones.
 */
router.get(
  "/marketers/documents/pending",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.getPendingMarketerDocuments
);

/**
 * GET /api/public/marketers/:id
 * Get marketer details (service-to-service)
 */
router.get(
  "/marketers/:id",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.getMarketerById
);

/**
 * Streams a marketer document — what the `url` field on every document object
 * resolves to. The files sit outside res/uploads precisely so that reaching
 * them requires passing this gate.
 *
 * Two shapes, one handler:
 *
 *   .../documents/:documentId/signed/:exp/:sig/file.jpg   (what the API mints)
 *   .../documents/:documentId/file                        (header auth)
 *
 * signedDocumentAccess, not serviceAuth: the portal renders documents with
 * <img src> / <iframe src> / target="_blank", none of which can send an
 * Authorization header. A valid short-lived signature authorises those; header
 * auth still works for API clients. See res/middleware/signedDocumentAccess.js.
 *
 * The signature sits in the PATH rather than a query string so the URL ends in
 * the real file extension — the portal picks its renderer with regexes anchored
 * by $, and "file.jpg?exp=..&sig=.." fails them. The .:ext variants are
 * separate registrations because the extension is optional: every minted URL
 * has one, hand-written curl calls do not.
 */
router.get(
  [
    "/marketers/:id/documents/:documentId/signed/:exp/:sig/file",
    "/marketers/:id/documents/:documentId/signed/:exp/:sig/file.:ext",
    "/marketers/:id/documents/:documentId/file",
    "/marketers/:id/documents/:documentId/file.:ext",
  ],
  signedDocumentAccess,
  publicController.getMarketerDocumentFile
);

/**
 * PATCH /api/public/marketers/:id/documents/:documentId
 * Approve or reject one marketer document.
 */
router.patch(
  "/marketers/:id/documents/:documentId",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.reviewMarketerDocument
);

/**
 * PATCH /api/public/marketers/:id
 * Update marketer details (service-to-service)
 */
router.patch(
  "/marketers/:id",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.updateMarketer
);

/**
 * PATCH /api/public/marketers/:id/suspend
 * Suspend or activate a marketer (service-to-service)
 */
router.patch(
  "/marketers/:id/suspend",
  serviceAuth,
  requirePlatformSuperAdmin,
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
  requirePlatformSuperAdmin,
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
  requirePlatformSuperAdmin,
  publicController.setMarketerCommission
);

/**
 * GET /api/public/marketers/me/wallet
 * Marketer reads their own wallet; identity comes from the Bearer token.
 *
 * MUST stay registered above /marketers/:id/wallet — Express matches in
 * registration order, so the :id route would otherwise capture this path with
 * id="me" and reject it via requirePlatformSuperAdmin.
 */
router.get(
  "/marketers/me/wallet",
  serviceAuth,
  publicController.getMyWallet
);

/**
 * GET /api/public/marketers/:id/wallet
 * Get marketer wallet and financial information (Super Admin only)
 */
router.get(
  "/marketers/:id/wallet",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.getMarketerWallet
);

/**
 * PATCH /api/public/marketers/:id/wallet
 * Update wallet balance (credit, debit, payout operations)
 */
router.patch(
  "/marketers/:id/wallet",
  serviceAuth,
  requirePlatformSuperAdmin,
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
  requirePlatformSuperAdmin,
  publicController.setGlobalCommission
);

/**
 * POST /api/public/settings/marketer-commissions
 * Set a marketer's custom commission override rates
 */
router.post(
  "/settings/marketer-commissions",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.updateMarketerCommission
);

/**
 * GET /api/public/settings/marketer-commissions/:marketerId
 * Fetch a marketer's custom commission override rates
 */
router.get(
  "/settings/marketer-commissions/:marketerId",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.getMarketerCommission
);

/**
 * DELETE /api/public/settings/marketer-commissions/:marketerId
 * Clear a marketer's custom commission override rates
 */
router.delete(
  "/settings/marketer-commissions/:marketerId",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.deleteMarketerCommission
);

/**
 * GET /api/public/marketer/commission-rates
 * Get the authenticated marketer's commission rates (Marketer Portal)
 * Shows: custom rates, legacy rate, effective rates, platform defaults
 */
router.get(
  "/marketer/commission-rates",
  serviceAuth,
  publicController.getMarketerCommissionRates
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
  "/auth/profile",
  serviceAuth,
  publicController.getMarketerProfile
);

/**
 * GET /api/public/auth/profile/:marketerId
 * Legacy form. Kept for the Marketer Portal's cached-id flow; the id must
 * match the caller's token or the request is rejected with 403.
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
  twoFactorController.verify2FA
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
 * Upload marketer avatar (multipart/form-data, field "avatar").
 *
 * The upload middleware is required: without it req.file is always undefined
 * and this endpoint could only ever answer 400 NO_FILE.
 */
router.post(
  "/users/avatar",
  serviceAuth,
  uploadAvatarSingle("avatar"),
  publicController.uploadAvatar
);

/**
 * ============================================
 * MARKETER PAYOUT REQUESTS
 * ============================================
 *
 * The /marketers/me/* paths are registered here rather than being folded into
 * /marketers/:id — "me" resolves from the token, and the :id routes are Super
 * Admin-only, so a marketer hitting them would get a 403 instead of their own
 * data.
 */

/**
 * POST /api/public/marketers/me/payout-request
 * Marketer raises a withdrawal request. Bearer required.
 */
router.post(
  "/marketers/me/payout-request",
  serviceAuth,
  payoutRequestController.createPayoutRequest
);

/**
 * GET /api/public/marketers/me/payout-requests
 * Marketer lists their own requests. Bearer required.
 */
router.get(
  "/marketers/me/payout-requests",
  serviceAuth,
  payoutRequestController.getMyPayoutRequests
);

/**
 * GET /api/public/payout-requests
 * Super Admin lists all requests across marketers.
 */
router.get(
  "/payout-requests",
  serviceAuth,
  requirePlatformSuperAdmin,
  payoutRequestController.getAllPayoutRequests
);

/**
 * PATCH /api/public/payout-requests/:id
 * Super Admin approves (pays out) or rejects a request.
 */
router.patch(
  "/payout-requests/:id",
  serviceAuth,
  requirePlatformSuperAdmin,
  payoutRequestController.reviewPayoutRequest
);

/**
 * POST /api/public/users/verification-document
 * Marketer uploads a KYC document (multipart/form-data: document, documentType).
 * Bearer required — the handler rejects a service-key-only call.
 */
router.post(
  "/users/verification-document",
  serviceAuth,
  uploadKycSingle("document"),
  publicController.uploadVerificationDocument
);

/**
 * GET /api/public/marketers/:id/verification-document
 * Streams the stored KYC document. Super Admin only.
 */
router.get(
  "/marketers/:id/verification-document",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.getVerificationDocument
);

/**
 * PATCH /api/public/marketers/:id/verification
 * Super Admin approves or rejects a marketer's KYC submission.
 */
router.patch(
  "/marketers/:id/verification",
  serviceAuth,
  requirePlatformSuperAdmin,
  publicController.reviewVerification
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
 * POST /api/public/settings/2fa/toggle — REMOVED
 *
 * Superseded by the three-step flow below (setup → verify-setup → disable),
 * which is what the Marketer Portal actually calls. It also took ?marketerId
 * from the query string, so it let any caller flip another marketer's 2FA flag
 * with no proof of identity. Nothing calls it; the controller is retained only
 * as history and is marked deprecated.
 */

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
  twoFactorController.setup2FA
);

/**
 * POST /api/public/settings/2fa/verify-setup   { code }
 * Verify the enrolment code, enable 2FA, return one-time recovery codes.
 */
router.post(
  "/settings/2fa/verify-setup",
  serviceAuth,
  twoFactorController.verifySetup2FA
);

/**
 * POST /api/public/settings/2fa/disable   { password }
 * Password re-authentication required, so a hijacked session cannot strip 2FA.
 */
router.post(
  "/settings/2fa/disable",
  serviceAuth,
  twoFactorController.disable2FA
);

/**
 * POST /api/public/settings/2fa/recovery-codes/regenerate   { password }
 * Issues a fresh set and invalidates the previous one.
 */
router.post(
  "/settings/2fa/recovery-codes/regenerate",
  serviceAuth,
  twoFactorController.regenerateRecoveryCodes
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
 * DELETE /api/public/marketer-schools/:id — REMOVED (unsafe, was broken)
 *
 * Pulled deliberately. publicController.deleteMarketerSchool operated on the
 * `School` tenant table, not `MarketerSchoolLead`, and had no ownership check:
 * a marketer passing a *lead* id suspended an unrelated *live school*, and any
 * marketer could suspend any school by guessing a sequential integer id.
 *
 * The Marketer Portal has no wired delete button, so nothing depends on it.
 * Do not re-mount without rewriting the controller against MarketerSchoolLead
 * plus a marketerId ownership guard. Suspending a real school is a Super Admin
 * action and already exists at PATCH /api/public/schools/:id/suspend.
 */

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
