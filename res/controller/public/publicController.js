const prisma = require("../../util/prisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { SchoolService } = require("../../Services/SchoolService");
const logger = require("../../config/logger");
const { logLoginEvent } = require("../../util/logLoginEvent");
const emailService = require("../../Services/EmailService");
const twoFactorService = require("../../Services/TwoFactorService");
const twoFactorTempToken = require("../../util/twoFactorTempToken");
const processImage = require("../../config/compress");
const flutterwave = require("../../Services/FlutterwaveService");
const { generateUniqueReferralCode } = require("../../util/referralCode");
const { signDocumentUrl } = require("../../util/documentUrlSignature");

// The tiers the Super Admin Portal filters on. `tier` is a free-text VarChar in
// the schema (whose comment also mentions "platinum"), but nothing issues a
// platinum tier today and the portal has no filter for it — so this list is the
// contract, and anything outside it is a client mistake worth a 422. Add
// "platinum" here first if a platinum tier is ever introduced.
const MARKETER_TIERS = ["bronze", "silver", "gold"];

// ============================================
// MARKETER DOCUMENT HELPERS
// ============================================

// The portal's document vocabulary. The Marketer Portal's upload form still
// posts the older nin/drivers/voters names, so uploads accept both and
// normaliseDocumentType() folds them into these five before storage.
const MARKETER_DOCUMENT_TYPES = ["id_card", "passport", "utility_bill", "cac", "other"];

const LEGACY_DOCUMENT_TYPE_MAP = {
  nin: "id_card",
  drivers: "id_card",
  voters: "id_card",
  passport: "passport",
};

const normaliseDocumentType = (type) => {
  if (MARKETER_DOCUMENT_TYPES.includes(type)) return type;
  return LEGACY_DOCUMENT_TYPE_MAP[type] || null;
};

/**
 * Wire shape for one marketer document (§2.3 of the Super Admin contract).
 *
 * `url` points at the signed stream route, NOT at /api/uploads — that mount is
 * plain express.static with no middleware, so anything under it is
 * world-readable by URL forever. Returning a path relative to /api (no leading
 * slash) for every row keeps the form consistent, which is what the portal
 * normalises against.
 *
 * Two details the Super Admin Portal depends on:
 *
 *   1. The signature query string. The portal previews documents with
 *      <img src> / <iframe src> / target="_blank", none of which can carry an
 *      Authorization header — so the URL has to authorise itself.
 *
 *   2. The real file extension at the very END of the URL. The portal chooses
 *      its renderer with /\.(png|jpe?g|gif|webp)$/i and /\.pdf$/i — both
 *      anchored with $. That anchor is why the signature lives in the PATH and
 *      not in a query string: "file.jpg?exp=..&sig=.." does not end in ".jpg",
 *      so a query-string signature silently degrades every preview to
 *      "Cannot preview this file type". The extension is load-bearing.
 */
const serialiseMarketerDocument = (doc) => {
  // path.extname on the stored filename, which was built from the upload's
  // mime type — not from anything the client named. Falls back to no extension
  // rather than guessing if a legacy row has none.
  const ext = path.extname(doc.path || "");
  const { exp, sig } = signDocumentUrl(doc.marketerId, doc.id);

  return {
    id: doc.id,
    type: doc.type,
    url: `public/marketers/${doc.marketerId}/documents/${doc.id}/signed/${exp}/${sig}/file${ext}`,
    status: doc.status,
    rejectionReason: doc.rejectionReason || null,
    reviewedAt: doc.reviewedAt ? doc.reviewedAt.toISOString() : null,
    reviewedBy: doc.reviewedBy ?? null,
    uploadedAt: doc.uploadedAt.toISOString(),
  };
};

/**
 * Documents for a set of marketers, grouped by marketerId.
 *
 * One query for the whole page rather than one per row — the list is paginated
 * at 20/page, and a per-row lookup would be 20 extra round trips (the classic
 * N+1). Returns a Map so the caller's merge stays O(1) per row.
 */
const fetchDocumentsByMarketer = async (marketerIds) => {
  const grouped = new Map(marketerIds.map((id) => [id, []]));
  if (marketerIds.length === 0) return grouped;

  const docs = await prisma.marketerDocument.findMany({
    where: { marketerId: { in: marketerIds } },
    orderBy: { uploadedAt: "desc" },
  });

  for (const doc of docs) {
    grouped.get(doc.marketerId)?.push(serialiseMarketerDocument(doc));
  }

  return grouped;
};

/**
 * Is this the marketer's most recent upload?
 *
 * Reviewing a document mirrors its verdict onto the legacy verification*
 * columns on Admin, which still drive the Marketer Portal's profile screen and
 * the payout KYC gate in updateMarketerWallet. Only the latest document may do
 * that — rejecting an old ID card must not downgrade a marketer whose newer
 * one was already approved.
 *
 * Deliberately called BEFORE opening the transaction, not inside it: the
 * database is remote, and every extra round trip between BEGIN and COMMIT
 * counts against the transaction timeout.
 */
const isLatestMarketerDocument = async (marketerId, documentId) => {
  const latest = await prisma.marketerDocument.findFirst({
    where: { marketerId },
    orderBy: { uploadedAt: "desc" },
    select: { id: true },
  });

  return latest?.id === documentId;
};

// Prisma's default transaction timeout is 5s, which a remote MySQL can exceed
// on a multi-statement write. Matches the existing allowance in
// updateMarketerWallet rather than inventing a second number.
const TX_OPTIONS = { timeout: 20000 };

// GET /api/public/schools
// Returns paginated schools for Super Admin Portal (no auth)
exports.getSchoolsPublic = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = parseInt(req.query.limit || req.query.pageSize) || 50;
    const take = Math.min(Math.max(pageSize, 1), 200);
    const skip = (page - 1) * take;
    const search = req.query.search || "";

    // No `mode: "insensitive"` — MySQL's Prisma client doesn't generate
    // QueryMode, so passing it threw a validation error (500) on any ?search=.
    // MySQL's default collation is already case-insensitive.
    const where = search
      ? {
          OR: [
            { name: { contains: search } },
            { email: { contains: search } },
          ],
        }
      : {};

    const [schoolRows, total] = await Promise.all([
      prisma.school.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          logoUrl: true,
          stampUrl: true,
          isSuspended: true,
          createdAt: true,
          _count: { select: { campuses: true } },
          admins: {
            where: { role: "school_admin" },
            select: { name: true, email: true },
            take: 1,
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.school.count({ where }),
    ]);

    const schools = schoolRows.map((school) => ({
      id: school.id,
      name: school.name,
      logo: school.logoUrl,
      stamp: school.stampUrl,
      adminEmail: school.admins[0]?.email || school.email,
      adminName: school.admins[0]?.name || null,
      campusCount: school._count.campuses,
      dateRegistered: school.createdAt,
      status: school.isSuspended ? "suspended" : "active",
    }));

    res.status(200).json({
      success: true,
      // Legacy flat fields (kept for backward compatibility)
      count: schools.length,
      total,
      page,
      pageSize: take,
      schools,
      // Nested shape expected by Super Admin Portal's qaloxApiClient
      data: {
        data: schools,
        meta: { total, page, limit: take },
      },
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

// ============================================
// NEW ENDPOINTS FOR SUPER ADMIN PORTAL
// ============================================

const schoolService = new SchoolService();

// GET /api/public/schools/:id
// Retrieve single school with campuses (service-to-service)
exports.getSchoolById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const schoolId = parseInt(id, 10);

    logger.debug(`[GET_SCHOOL] Retrieving school`, { schoolId });

    if (isNaN(schoolId)) {
      logger.warn(`[GET_SCHOOL] Invalid school ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid school ID",
        code: "INVALID_REQUEST",
      });
    }

    const school = await schoolService.getSchoolWithCampuses(schoolId);
    logger.info(`[GET_SCHOOL] Successfully retrieved school`, { schoolId, campuses: school.campuses?.length || 0 });

    res.status(200).json({
      success: true,
      data: school,
    });
  } catch (err) {
    if (err.message === "School not found") {
      logger.warn(`[GET_SCHOOL] School not found`, { schoolId: req.params.id });
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "SCHOOL_NOT_FOUND",
      });
    }
    logger.error(`[GET_SCHOOL] Error retrieving school`, { error: err.message, schoolId: req.params.id });
    next(err);
  }
};

// PATCH /api/public/schools/:id/suspend
// Suspend or reactivate a school (service-to-service)
exports.suspendSchool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { suspend, reason } = req.body;
    const schoolId = parseInt(id, 10);

    logger.debug(`[SUSPEND_SCHOOL] Processing suspension request`, { schoolId, suspend, reason });

    if (isNaN(schoolId)) {
      logger.warn(`[SUSPEND_SCHOOL] Invalid school ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid school ID",
        code: "INVALID_REQUEST",
      });
    }

    let updatedSchool;

    if (suspend === true) {
      logger.info(`[SUSPEND_SCHOOL] Suspending school`, { schoolId, reason });
      updatedSchool = await schoolService.suspendSchool(schoolId, reason);
    } else if (suspend === false) {
      logger.info(`[SUSPEND_SCHOOL] Reactivating school`, { schoolId });
      updatedSchool = await schoolService.reactivateSchool(schoolId);
    } else {
      logger.warn(`[SUSPEND_SCHOOL] Invalid suspend value`, { suspend });
      return res.status(400).json({
        success: false,
        message: "Invalid request body",
        code: "INVALID_REQUEST",
      });
    }

    logger.info(`[SUSPEND_SCHOOL] School ${suspend ? 'suspended' : 'reactivated'} successfully`, { schoolId, isSuspended: updatedSchool.isSuspended });

    res.status(200).json({
      success: true,
      message: suspend ? "School suspended successfully" : "School reactivated successfully",
      data: {
        id: updatedSchool.id,
        name: updatedSchool.name,
        isSuspended: updatedSchool.isSuspended,
        suspendedAt: updatedSchool.suspendedAt,
        suspensionReason: updatedSchool.suspensionReason,
      },
    });
  } catch (err) {
    if (err.message === "School not found") {
      logger.warn(`[SUSPEND_SCHOOL] School not found`, { schoolId: req.params.id });
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "SCHOOL_NOT_FOUND",
      });
    }
    logger.error(`[SUSPEND_SCHOOL] Error suspending school`, { error: err.message, schoolId: req.params.id });
    next(err);
  }
};

// PATCH /api/public/schools/:id/sms-quota
// Set a school's per-term SMS broadcast quota (Super Admin Portal, service-to-service)
exports.updateSchoolSmsQuota = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { quotaPerTerm } = req.body;
    const schoolId = parseInt(id, 10);

    if (isNaN(schoolId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid school ID",
        code: "INVALID_REQUEST",
      });
    }

    if (typeof quotaPerTerm !== "number" || quotaPerTerm < 0) {
      return res.status(400).json({
        success: false,
        message: "quotaPerTerm must be a non-negative number",
        code: "INVALID_QUOTA",
      });
    }

    const school = await prisma.school.update({
      where: { id: schoolId },
      data: { smsQuotaPerTerm: quotaPerTerm },
      select: { id: true, name: true, smsQuotaPerTerm: true, smsUsedThisTerm: true },
    });

    logger.info(`[UPDATE_SMS_QUOTA] School SMS quota updated`, { schoolId, quotaPerTerm });

    res.status(200).json({
      success: true,
      message: "SMS quota updated successfully",
      data: school,
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "SCHOOL_NOT_FOUND",
      });
    }
    logger.error(`[UPDATE_SMS_QUOTA] Error updating quota`, { error: err.message, schoolId: req.params.id });
    next(err);
  }
};

// DELETE /api/public/schools/:id
// Permanently delete a school with cascade deletion (service-to-service)
exports.deleteSchool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { confirmDeletion, reason } = req.body;
    const schoolId = parseInt(id, 10);

    logger.debug(`[DELETE_SCHOOL] Deletion request initiated`, { schoolId, reason });

    if (isNaN(schoolId)) {
      logger.warn(`[DELETE_SCHOOL] Invalid school ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid school ID",
        code: "INVALID_REQUEST",
      });
    }

    // Safety check: confirmDeletion must be explicitly true
    if (confirmDeletion !== true) {
      logger.warn(`[DELETE_SCHOOL] Deletion not confirmed`, { schoolId, confirmDeletion });
      return res.status(400).json({
        success: false,
        message: "Deletion requires confirmDeletion: true",
        code: "DELETION_NOT_CONFIRMED",
      });
    }

    logger.info(`[DELETE_SCHOOL] Starting cascade deletion`, { schoolId, reason });
    const result = await schoolService.deleteSchoolCascade(schoolId, reason);

    logger.info(`[DELETE_SCHOOL] School deleted successfully`, { schoolId, deletedAt: result.deletedAt });

    res.status(200).json({
      success: true,
      message: "School deleted successfully",
      data: result,
    });
  } catch (err) {
    if (err.message === "School not found") {
      logger.warn(`[DELETE_SCHOOL] School not found`, { schoolId: req.params.id });
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "SCHOOL_NOT_FOUND",
      });
    }
    logger.error(`[DELETE_SCHOOL] Error deleting school`, { error: err.message, schoolId: req.params.id });
    next(err);
  }
};

// POST /api/public/admins
// Create an admin account (service-to-service, after token validation)
exports.createAdmin = async (req, res, next) => {
  try {
    const { email, password, name, role, schoolId, uniqueKey } = req.body;

    logger.debug(`[CREATE_ADMIN] Admin creation request`, { email, role, schoolId });

    // Validate email uniqueness
    const existingAdmin = await prisma.admin.findUnique({
      where: { email },
    });

    if (existingAdmin) {
      logger.warn(`[CREATE_ADMIN] Email already registered`, { email });
      return res.status(400).json({
        success: false,
        message: "Email already registered",
        code: "EMAIL_EXISTS",
      });
    }

    // Validate token is active
    const token = await prisma.token.findUnique({
      where: { uniqueKey },
    });

    if (!token || token.status !== "active") {
      logger.warn(`[CREATE_ADMIN] Token invalid or inactive`, { email, uniqueKey, tokenStatus: token?.status });
      return res.status(409).json({
        success: false,
        message: "Token has already been used or is inactive",
        code: "TOKEN_INVALID",
      });
    }

    logger.debug(`[CREATE_ADMIN] Token validated`, { email, uniqueKey });

    // Validate role and schoolId combination
    if (role === "school_admin" && !schoolId) {
      logger.warn(`[CREATE_ADMIN] school_admin missing schoolId`, { email });
      return res.status(400).json({
        success: false,
        message: "school_admin role requires schoolId",
        code: "INVALID_ROLE_CONFIG",
      });
    }

    if (role === "super_admin" && schoolId) {
      logger.warn(`[CREATE_ADMIN] super_admin cannot have schoolId`, { email, schoolId });
      return res.status(400).json({
        success: false,
        message: "super_admin role must have schoolId as null",
        code: "INVALID_ROLE_CONFIG",
      });
    }

    // If school_admin, verify school exists
    if (role === "school_admin" && schoolId) {
      const school = await prisma.school.findUnique({
        where: { id: parseInt(schoolId, 10) },
      });

      if (!school) {
        logger.warn(`[CREATE_ADMIN] School not found for school_admin`, { email, schoolId });
        return res.status(404).json({
          success: false,
          message: "School not found",
          code: "SCHOOL_NOT_FOUND",
        });
      }

      logger.debug(`[CREATE_ADMIN] School verified`, { email, schoolId });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    logger.debug(`[CREATE_ADMIN] Password hashed`, { email });

    // Create admin
    const newAdmin = await prisma.admin.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role,
        schoolId: role === "school_admin" ? parseInt(schoolId, 10) : null,
        hasLoggedIn: false,
      },
    });

    logger.info(`[CREATE_ADMIN] Admin created successfully`, { adminId: newAdmin.id, email, role, schoolId: newAdmin.schoolId });

    res.status(201).json({
      success: true,
      message: "Admin created successfully",
      data: {
        id: newAdmin.id,
        email: newAdmin.email,
        name: newAdmin.name,
        role: newAdmin.role,
        schoolId: newAdmin.schoolId,
        createdAt: newAdmin.createdAt,
        hasLoggedIn: newAdmin.hasLoggedIn,
      },
    });
  } catch (err) {
    logger.error(`[CREATE_ADMIN] Error creating admin`, { error: err.message, email: req.body.email });
    next(err);
  }
};

// ============================================
// MARKETER ENDPOINTS
// ============================================

// POST /api/public/auth/login
// Login for both admins and marketers (returns basic info, no JWT)
// Service-to-service endpoint - JWT issued by calling service
exports.loginPublic = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    logger.debug(`[LOGIN_PUBLIC] Login attempt`, { email });

    if (!email || !password) {
      logger.warn(`[LOGIN_PUBLIC] Missing credentials`, { email });
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
        code: "MISSING_CREDENTIALS",
      });
    }

    // Find admin by email (could be super_admin, school_admin, or marketer)
    const admin = await prisma.admin.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        role: true,
        tier: true,
        referralCode: true,
        isEmailVerified: true,
        isSuspended: true,
        // Required for the 2FA branch below. Without these the flag reads as
        // undefined and every account silently logs in without a challenge.
        twoFactorEnabled: true,
        twoFactorLockedUntil: true,
      },
    });

    if (!admin) {
      logger.warn(`[LOGIN_PUBLIC] User not found`, { email });
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    // Check if marketer is suspended
    if (admin.role === "marketer" && admin.isSuspended) {
      logger.warn(`[LOGIN_PUBLIC] Marketer account suspended`, { email, adminId: admin.id });
      return res.status(403).json({
        success: false,
        message: "This account has been suspended",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      logger.warn(`[LOGIN_PUBLIC] Invalid password`, { email });
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    // 2FA challenge. The password was correct, but no session token is issued
    // until the second factor is verified — the caller gets a temp token that
    // is only accepted by POST /auth/2fa/verify.
    if (admin.twoFactorEnabled) {
      if (twoFactorService.isLockedOut(admin)) {
        return res.status(429).json({
          success: false,
          message: "Too many failed two-factor attempts. Try again later.",
          code: "TWO_FACTOR_LOCKED",
          data: { retryAfterSeconds: twoFactorService.lockoutSecondsRemaining(admin) },
        });
      }

      const { token: tempToken, jti } = twoFactorTempToken.issue(admin.id);
      await prisma.admin.update({
        where: { id: admin.id },
        data: { twoFactorTempTokenId: jti },
      });

      logger.info(`[LOGIN_PUBLIC] Password OK, 2FA challenge issued`, { adminId: admin.id });

      return res.status(200).json({
        success: true,
        message: "Two-factor authentication required",
        data: { requiresTwoFactor: true, tempToken },
      });
    }

    logger.info(`[LOGIN_PUBLIC] ${admin.role} login successful`, { email, adminId: admin.id, role: admin.role });

    // Issue a real session token directly (this endpoint used to just return
    // user data on the assumption that a middleman backend would mint its own
    // token after calling it — that middleman no longer exists, so this is
    // now the actual source of truth for marketer/admin auth tokens).
    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role },
      process.env.JWT_SECRET || "secret",
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    await logLoginEvent({ actorType: admin.role === "marketer" ? "marketer" : "admin", actorId: admin.id, req });

    res.status(200).json({
      success: true,
      message: "Authentication successful",
      data: {
        token,
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        tier: admin.tier,
        referralCode: admin.referralCode,
        isEmailVerified: admin.isEmailVerified,
      },
    });
  } catch (err) {
    logger.error(`[LOGIN_PUBLIC] Error during login`, { error: err.message, email: req.body?.email });
    next(err);
  }
};

/**
 * POST /api/public/auth/forgot-password
 * Body: { email }
 * Always responds with the same generic message regardless of whether the
 * email exists — this avoids leaking which emails have accounts. The raw
 * reset token is only ever sent by email, never returned in the response;
 * only its SHA-256 hash is persisted, so a database leak alone can't be
 * used to reset an account.
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required", code: "MISSING_EMAIL" });
    }

    const genericResponse = {
      success: true,
      message: "If an account exists for that email, a password reset link has been sent.",
    };

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      logger.debug(`[FORGOT_PASSWORD] No account for email`, { email });
      return res.status(200).json(genericResponse);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    const resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.admin.update({
      where: { id: admin.id },
      data: { resetPasswordToken: hashedToken, resetPasswordExpires },
    });

    const portalUrl = admin.role === "marketer"
      ? (process.env.MARKETER_PORTAL_URL || "http://localhost:9990")
      : (process.env.SUPER_ADMIN_PORTAL_URL || "http://localhost:9991");
    const resetLink = `${portalUrl}/reset-password?token=${rawToken}`;

    try {
      await emailService.sendEmail({
        to: admin.email,
        subject: "Reset your Qalox password",
        html: `<p>Hi ${admin.name},</p><p>We received a request to reset your password. This link expires in 1 hour:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
      });
      logger.info(`[FORGOT_PASSWORD] Reset email sent`, { email, adminId: admin.id });
    } catch (emailErr) {
      logger.error(`[FORGOT_PASSWORD] Failed to send reset email`, { email, error: emailErr.message });
    }

    res.status(200).json(genericResponse);
  } catch (err) {
    logger.error(`[FORGOT_PASSWORD] Error`, { error: err.message, email: req.body?.email });
    next(err);
  }
};

/**
 * POST /api/public/auth/reset-password
 * Body: { token, newPassword }
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Token and newPassword are required",
        code: "MISSING_FIELDS",
      });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
        code: "WEAK_PASSWORD",
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const admin = await prisma.admin.findFirst({
      where: { resetPasswordToken: hashedToken, resetPasswordExpires: { gt: new Date() } },
    });

    if (!admin) {
      logger.warn(`[RESET_PASSWORD] Invalid or expired token`);
      return res.status(400).json({
        success: false,
        message: "This reset link is invalid or has expired",
        code: "INVALID_OR_EXPIRED_TOKEN",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.admin.update({
      where: { id: admin.id },
      data: { password: hashedPassword, resetPasswordToken: null, resetPasswordExpires: null },
    });

    logger.info(`[RESET_PASSWORD] Password reset successfully`, { adminId: admin.id });
    res.status(200).json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    logger.error(`[RESET_PASSWORD] Error`, { error: err.message });
    next(err);
  }
};

// POST /api/public/marketers
// Create a new marketer account (service-to-service)
exports.createMarketer = async (req, res, next) => {
  try {
    const { email, password, name, tier, referralCode, uniqueKey } = req.body;

    logger.debug(`[CREATE_MARKETER] Marketer creation request`, { email, tier });

    // Validate email uniqueness
    const existingMarketer = await prisma.admin.findUnique({
      where: { email },
    });

    if (existingMarketer) {
      logger.warn(`[CREATE_MARKETER] Email already registered`, { email });
      return res.status(400).json({
        success: false,
        message: "Email already registered",
        code: "EMAIL_EXISTS",
      });
    }

    // Validate token if provided
    if (uniqueKey) {
      const token = await prisma.token.findUnique({
        where: { uniqueKey },
      });

      if (!token || token.status !== "active") {
        logger.warn(`[CREATE_MARKETER] Token invalid or inactive`, { email, uniqueKey });
        return res.status(409).json({
          success: false,
          message: "Token has already been used or is inactive",
          code: "TOKEN_INVALID",
        });
      }

      logger.debug(`[CREATE_MARKETER] Token validated`, { email, uniqueKey });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    logger.debug(`[CREATE_MARKETER] Password hashed`, { email });

    // Create marketer. A caller-supplied referralCode still wins (Super Admin
    // may be migrating a code from elsewhere); otherwise generate the QAL-XXXXXX
    // form. The old `REF_prisca_1723459200` fallback is gone — it leaked the
    // email local-part and the signup timestamp into a code marketers hand out.
    const newMarketer = await prisma.admin.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: "marketer",
        tier: tier || "bronze",
        referralCode: referralCode || (await generateUniqueReferralCode(prisma)),
        isEmailVerified: false,
        isSuspended: false,
      },
    });

    // Deactivate token if used
    if (uniqueKey) {
      await prisma.token.update({
        where: { uniqueKey },
        data: { status: "inactive" },
      });
    }

    logger.info(`[CREATE_MARKETER] Marketer created successfully`, { marketerId: newMarketer.id, email, tier: newMarketer.tier });

    res.status(201).json({
      success: true,
      message: "Marketer account created successfully",
      data: {
        id: newMarketer.id,
        email: newMarketer.email,
        name: newMarketer.name,
        tier: newMarketer.tier,
        referralCode: newMarketer.referralCode,
        createdAt: newMarketer.createdAt,
      },
    });
  } catch (err) {
    logger.error(`[CREATE_MARKETER] Error creating marketer`, { error: err.message, email: req.body.email });
    next(err);
  }
};

// GET /api/public/marketers
// List all marketers (service-to-service)
exports.listMarketers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || 1, 10);
    const limit = parseInt(req.query.limit || 20, 10);
    const search = req.query.search || "";
    const tier = req.query.tier;

    logger.debug(`[LIST_MARKETERS] Fetching marketers`, { page, limit, search, tier });

    // An unrecognised tier is rejected rather than dropped. A filter that
    // silently returns everything looks to the operator like "there are no
    // gold marketers yet" when it actually means "the filter did nothing".
    if (tier !== undefined && !MARKETER_TIERS.includes(tier)) {
      logger.warn(`[LIST_MARKETERS] Unknown tier filter`, { tier });
      return res.status(422).json({
        success: false,
        message: `tier must be one of: ${MARKETER_TIERS.join(", ")}`,
        code: "INVALID_TIER",
        data: null,
      });
    }

    const skip = (Math.max(page, 1) - 1) * limit;

    // No `mode: "insensitive"` — see getSchoolsPublic; it 500s on MySQL.
    const where = {
      role: "marketer",
      ...(tier && { tier }),
      ...(search && {
        OR: [
          { name: { contains: search } },
          { email: { contains: search } },
        ],
      }),
    };

    const [marketers, total] = await Promise.all([
      prisma.admin.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          tier: true,
          referralCode: true,
          isEmailVerified: true,
          isSuspended: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.admin.count({ where }),
    ]);

    const marketerIds = marketers.map((m) => m.id);

    // Three grouped queries for the whole page, not three per row. groupBy
    // returns one row per marketer that has any matching record; marketers
    // with none are simply absent, which is why the lookups below default to 0
    // rather than assuming every id is present.
    const [tokenCounts, schoolCounts, documentsByMarketer] = await Promise.all([
      marketerIds.length
        ? prisma.schoolToken.groupBy({
            by: ["marketerId"],
            where: { marketerId: { in: marketerIds } },
            _count: { _all: true },
          })
        : [],
      marketerIds.length
        ? prisma.marketerSchoolLead.groupBy({
            by: ["marketerId"],
            // A lead only counts as "registered" once it converted into a real
            // School tenant — schoolId is set at that point and not before.
            where: { marketerId: { in: marketerIds }, schoolId: { not: null } },
            _count: { _all: true },
          })
        : [],
      fetchDocumentsByMarketer(marketerIds),
    ]);

    const tokensByMarketer = new Map(tokenCounts.map((r) => [r.marketerId, r._count._all]));
    const schoolsByMarketer = new Map(schoolCounts.map((r) => [r.marketerId, r._count._all]));

    const rows = marketers.map((marketer) => ({
      ...marketer,
      // isActive is derived, not stored. isSuspended stays in the payload —
      // other portals already read it and renaming it would break them.
      isActive: !marketer.isSuspended,
      documents: documentsByMarketer.get(marketer.id) || [],
      tokensGenerated: tokensByMarketer.get(marketer.id) || 0,
      schoolsRegistered: schoolsByMarketer.get(marketer.id) || 0,
    }));

    logger.info(`[LIST_MARKETERS] Retrieved ${rows.length} marketers`, { page, limit, total, tier });

    res.status(200).json({
      success: true,
      // Nested shape expected by Super Admin Portal's qaloxApiClient
      data: {
        data: rows,
        meta: {
          page: Math.max(page, 1),
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    logger.error(`[LIST_MARKETERS] Error fetching marketers`, { error: err.message });
    next(err);
  }
};

// GET /api/public/marketers/:id
// Get marketer details (service-to-service)
exports.getMarketerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const marketerId = parseInt(id, 10);

    logger.debug(`[GET_MARKETER] Fetching marketer details`, { marketerId });

    if (isNaN(marketerId)) {
      logger.warn(`[GET_MARKETER] Invalid marketer ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        referralCode: true,
        phone: true,
        address: true,
        city: true,
        state: true,
        bankName: true,
        bankAccountNumber: true,
        bankAccountName: true,
        isEmailVerified: true,
        isSuspended: true,
        createdAt: true,
      },
    });

    if (!marketer) {
      logger.warn(`[GET_MARKETER] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    // Same derived fields the list returns, so a row and its detail view never
    // disagree. Counts are cheap here — one marketer, not a page of them.
    const [documents, tokensGenerated, schoolsRegistered] = await Promise.all([
      prisma.marketerDocument.findMany({
        where: { marketerId },
        orderBy: { uploadedAt: "desc" },
      }),
      prisma.schoolToken.count({ where: { marketerId } }),
      prisma.marketerSchoolLead.count({ where: { marketerId, schoolId: { not: null } } }),
    ]);

    logger.info(`[GET_MARKETER] Retrieved marketer`, { marketerId, email: marketer.email });

    res.status(200).json({
      success: true,
      data: {
        ...marketer,
        isActive: !marketer.isSuspended,
        documents: documents.map(serialiseMarketerDocument),
        tokensGenerated,
        schoolsRegistered,
      },
    });
  } catch (err) {
    logger.error(`[GET_MARKETER] Error fetching marketer`, { error: err.message, marketerId: req.params.id });
    next(err);
  }
};

// PATCH /api/public/marketers/:id
// Update marketer details (service-to-service)
exports.updateMarketer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const marketerId = parseInt(id, 10);
    const { tier, phone, address, city, state, bankName, bankAccountNumber, bankAccountName } = req.body;

    logger.debug(`[UPDATE_MARKETER] Updating marketer`, { marketerId });

    if (isNaN(marketerId)) {
      logger.warn(`[UPDATE_MARKETER] Invalid marketer ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    // Check if marketer exists
    const existingMarketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
    });

    if (!existingMarketer) {
      logger.warn(`[UPDATE_MARKETER] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    // Update marketer
    const updatedMarketer = await prisma.admin.update({
      where: { id: marketerId },
      data: {
        ...(tier && { tier }),
        ...(phone && { phone }),
        ...(address && { address }),
        ...(city && { city }),
        ...(state && { state }),
        ...(bankName && { bankName }),
        ...(bankAccountNumber && { bankAccountNumber }),
        ...(bankAccountName && { bankAccountName }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        referralCode: true,
        phone: true,
        address: true,
        city: true,
        state: true,
        bankName: true,
        bankAccountNumber: true,
        bankAccountName: true,
        isEmailVerified: true,
        isSuspended: true,
        createdAt: true,
      },
    });

    logger.info(`[UPDATE_MARKETER] Marketer updated successfully`, { marketerId, email: updatedMarketer.email });

    res.status(200).json({
      success: true,
      message: "Marketer updated successfully",
      data: updatedMarketer,
    });
  } catch (err) {
    logger.error(`[UPDATE_MARKETER] Error updating marketer`, { error: err.message, marketerId: req.params.id });
    next(err);
  }
};

// PATCH /api/public/marketers/:id/suspend
// Suspend or activate a marketer (service-to-service)
exports.suspendMarketer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { suspend, reason } = req.body;
    const marketerId = parseInt(id, 10);
    // Actor comes from the verified Bearer token only. Never from the body —
    // a client-supplied "actorId" would let a caller sign someone else's name
    // to a suspension. Null when the caller authenticated by service key
    // alone, which is honest: that key identifies an app, not a person.
    const actorId = req.user?.id ?? null;

    logger.debug(`[SUSPEND_MARKETER] Processing suspension request`, { marketerId, suspend, actorId });

    if (isNaN(marketerId)) {
      logger.warn(`[SUSPEND_MARKETER] Invalid marketer ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    // Check if marketer exists
    const existingMarketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
    });

    if (!existingMarketer) {
      logger.warn(`[SUSPEND_MARKETER] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    const suspending = suspend === true;

    // Update suspension status and append the audit row together — a
    // suspension that isn't recorded is worse than one that fails outright.
    const [updatedMarketer] = await prisma.$transaction([
      prisma.admin.update({
        where: { id: marketerId },
        data: {
          isSuspended: suspending,
          suspendedAt: suspending ? new Date() : null,
          // Reactivating clears the reason: it describes the current
          // suspension, and a stale one reads as if they're still suspended.
          suspensionReason: suspending ? (reason || null) : null,
          suspendedBy: suspending ? actorId : null,
        },
        select: {
          id: true,
          name: true,
          email: true,
          tier: true,
          isSuspended: true,
          suspendedAt: true,
          suspensionReason: true,
          suspendedBy: true,
        },
      }),
      prisma.securityEvent.create({
        data: {
          adminId: marketerId,
          event: suspending ? "marketer_suspended" : "marketer_reactivated",
          // VarChar(255) — slice so a long reason truncates instead of
          // throwing and rolling back the suspension itself.
          detail: `by admin ${actorId ?? "service-key"}${reason ? `: ${reason}` : ""}`.slice(0, 255),
          ipAddress: req.ip || null,
          userAgent: req.headers["user-agent"] || null,
        },
      }),
    ], TX_OPTIONS);

    logger.info(`[SUSPEND_MARKETER] Marketer ${suspending ? 'suspended' : 'activated'} successfully`, { marketerId, email: updatedMarketer.email, isSuspended: updatedMarketer.isSuspended, actorId });

    res.status(200).json({
      success: true,
      message: suspending ? "Marketer suspended successfully" : "Marketer activated successfully",
      data: { ...updatedMarketer, isActive: !updatedMarketer.isSuspended },
    });
  } catch (err) {
    logger.error(`[SUSPEND_MARKETER] Error suspending marketer`, { error: err.message, marketerId: req.params.id });
    next(err);
  }
};

// ============================================
// COMMISSION & WALLET ENDPOINTS
// ============================================

// PATCH /api/public/marketers/:id/commission
// Set marketer commission rate (Super Admin only)
exports.setMarketerCommission = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { commissionRate, commissionStructure } = req.body;
    const marketerId = parseInt(id, 10);

    logger.debug(`[SET_COMMISSION] Setting commission for marketer`, { marketerId, commissionRate, commissionStructure });

    if (isNaN(marketerId)) {
      logger.warn(`[SET_COMMISSION] Invalid marketer ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    if (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 100) {
      logger.warn(`[SET_COMMISSION] Invalid commission rate`, { commissionRate });
      return res.status(400).json({
        success: false,
        message: "Commission rate must be between 0 and 100",
        code: "INVALID_RATE",
      });
    }

    // Check if marketer exists
    const existingMarketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
    });

    if (!existingMarketer) {
      logger.warn(`[SET_COMMISSION] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    const actorId = req.user?.id ?? null;
    const previousRate = existingMarketer.commissionRate ?? 0;

    // Update commission, and record who changed it and from what. Rate changes
    // move real money, so the before-value belongs in the trail — "set to 8%"
    // is only meaningful next to what it was.
    const [updatedMarketer] = await prisma.$transaction([
      prisma.admin.update({
        where: { id: marketerId },
        data: {
          commissionRate,
          commissionStructure: commissionStructure || "flat",
        },
        select: {
          id: true,
          email: true,
          name: true,
          tier: true,
          commissionRate: true,
          commissionStructure: true,
        },
      }),
      prisma.securityEvent.create({
        data: {
          adminId: marketerId,
          event: "marketer_commission_changed",
          detail: `by admin ${actorId ?? "service-key"}: ${previousRate}% -> ${commissionRate}%`.slice(0, 255),
          ipAddress: req.ip || null,
          userAgent: req.headers["user-agent"] || null,
        },
      }),
    ], TX_OPTIONS);

    logger.info(`[SET_COMMISSION] Commission updated successfully`, { marketerId, commissionRate, previousRate, actorId });

    res.status(200).json({
      success: true,
      message: "Commission rate updated successfully",
      data: updatedMarketer,
    });
  } catch (err) {
    logger.error(`[SET_COMMISSION] Error setting commission`, { error: err.message, marketerId: req.params.id });
    next(err);
  }
};

// GET /api/public/marketers/:id/wallet
// Get marketer wallet information (Super Admin, Marketer Portal)
exports.getMarketerWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const marketerId = parseInt(id, 10);

    logger.debug(`[GET_WALLET] Fetching wallet for marketer`, { marketerId });

    if (isNaN(marketerId)) {
      logger.warn(`[GET_WALLET] Invalid marketer ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    // Check if marketer exists
    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
        walletBalance: true,
        walletPending: true,
        totalEarned: true,
        totalWithdrawn: true,
        transactionCount: true,
        lastPayoutDate: true,
        commissionRate: true,
      },
    });

    if (!marketer) {
      logger.warn(`[GET_WALLET] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthCredits = await prisma.walletTransaction.aggregate({
      where: { marketerId, type: "credit", createdAt: { gte: monthStart } },
      _sum: { amount: true },
    });

    logger.info(`[GET_WALLET] Retrieved wallet for marketer`, { marketerId, balance: marketer.walletBalance });

    res.status(200).json({
      success: true,
      message: "Wallet retrieved successfully",
      data: {
        marketerId: marketer.id,
        balance: marketer.walletBalance,
        pendingBalance: marketer.walletPending,
        totalEarned: marketer.totalEarned,
        totalWithdrawn: marketer.totalWithdrawn,
        thisMonthEarned: thisMonthCredits._sum.amount || 0,
        transactionCount: marketer.transactionCount,
        lastPayoutDate: marketer.lastPayoutDate,
        commissionRate: marketer.commissionRate,
      },
    });
  } catch (err) {
    logger.error(`[GET_WALLET] Error fetching wallet`, { error: err.message, marketerId: req.params.id });
    next(err);
  }
};

// PATCH /api/public/marketers/:id/wallet
// Update marketer wallet balance (for payout/credit operations)
/**
 * GET /api/public/marketers/me/wallet
 *
 * Marketer reads their OWN wallet. Identity comes from the Bearer token, so no
 * client-supplied id is involved and there is nothing to authorize against.
 *
 * Exists because GET /marketers/:id/wallet is gated by requirePlatformSuperAdmin
 * and therefore 403s for a marketer even on their own id — leaving the Marketer
 * Portal with no way to read its own balance. Same response shape as that
 * endpoint so the two stay interchangeable.
 */
exports.getMyWallet = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    logger.debug(`[GET_MY_WALLET] Fetching own wallet`, { marketerId });

    if (!marketerId) {
      logger.warn(`[GET_MY_WALLET] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: {
        id: true,
        walletBalance: true,
        walletPending: true,
        totalEarned: true,
        totalWithdrawn: true,
        transactionCount: true,
        lastPayoutDate: true,
        commissionRate: true,
      },
    });

    if (!marketer) {
      logger.warn(`[GET_MY_WALLET] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthCredits = await prisma.walletTransaction.aggregate({
      where: { marketerId, type: "credit", createdAt: { gte: monthStart } },
      _sum: { amount: true },
    });

    logger.info(`[GET_MY_WALLET] Wallet retrieved`, { marketerId, balance: marketer.walletBalance });

    res.status(200).json({
      success: true,
      message: "Wallet retrieved successfully",
      data: {
        marketerId: marketer.id,
        balance: marketer.walletBalance,
        pendingBalance: marketer.walletPending,
        totalEarned: marketer.totalEarned,
        totalWithdrawn: marketer.totalWithdrawn,
        thisMonthEarned: thisMonthCredits._sum.amount || 0,
        transactionCount: marketer.transactionCount,
        lastPayoutDate: marketer.lastPayoutDate,
        commissionRate: marketer.commissionRate,
      },
    });
  } catch (err) {
    logger.error(`[GET_MY_WALLET] Error fetching wallet`, { error: err.message });
    next(err);
  }
};

exports.updateMarketerWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { operation, amount, description } = req.body;
    const marketerId = parseInt(id, 10);
    const actorId = req.user?.id ?? null;

    logger.debug(`[UPDATE_WALLET] Wallet operation`, { marketerId, operation, amount, actorId });

    if (isNaN(marketerId)) {
      logger.warn(`[UPDATE_WALLET] Invalid marketer ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    if (!['credit', 'debit', 'payout'].includes(operation)) {
      logger.warn(`[UPDATE_WALLET] Invalid operation`, { operation });
      return res.status(400).json({
        success: false,
        message: "Operation must be 'credit', 'debit', or 'payout'",
        code: "INVALID_OPERATION",
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      logger.warn(`[UPDATE_WALLET] Invalid amount`, { amount });
      return res.status(400).json({
        success: false,
        message: "Amount must be a positive number",
        code: "INVALID_AMOUNT",
      });
    }

    // Get current marketer
    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
    });

    if (!marketer) {
      logger.warn(`[UPDATE_WALLET] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    // Money may only leave the platform to a KYC-approved marketer. Credits and
    // internal debits are unaffected — this gates the payout operation only.
    if (operation === "payout" && marketer.verificationStatus !== "approved") {
      logger.warn(`[UPDATE_WALLET] Payout blocked, KYC not approved`, {
        marketerId,
        verificationStatus: marketer.verificationStatus,
      });
      return res.status(403).json({
        success: false,
        message: "Marketer identity verification must be approved before a payout can be made",
        code: "VERIFICATION_REQUIRED",
        details: { verificationStatus: marketer.verificationStatus || "pending" },
      });
    }

    // Calculate new balances
    let newBalance = marketer.walletBalance || 0;
    let newWithdrawn = marketer.totalWithdrawn || 0;

    if (operation === 'credit') {
      newBalance += amount;
    } else if (operation === 'debit') {
      if (newBalance < amount) {
        logger.warn(`[UPDATE_WALLET] Insufficient balance`, { marketerId, balance: newBalance, amount });
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance",
          code: "INSUFFICIENT_BALANCE",
        });
      }
      newBalance -= amount;
    } else if (operation === 'payout') {
      if (newBalance < amount) {
        logger.warn(`[UPDATE_WALLET] Insufficient balance for payout`, { marketerId, balance: newBalance, amount });
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance for payout",
          code: "INSUFFICIENT_BALANCE",
        });
      }
      newBalance -= amount;
      newWithdrawn += amount;
    }

    // Update wallet + record the transaction atomically
    const [updatedMarketer] = await prisma.$transaction([
      prisma.admin.update({
        where: { id: marketerId },
        data: {
          walletBalance: newBalance,
          totalWithdrawn: newWithdrawn,
          transactionCount: { increment: 1 },
          lastPayoutDate: operation === 'payout' ? new Date() : marketer.lastPayoutDate,
        },
        select: {
          id: true,
          email: true,
          name: true,
          walletBalance: true,
          totalWithdrawn: true,
          lastPayoutDate: true,
        },
      }),
      prisma.walletTransaction.create({
        data: {
          marketerId,
          type: operation,
          amount,
          description: description || null,
          balanceAfter: newBalance,
          // Who moved the money. `description` is client-supplied text and so
          // can claim anything; this comes from the verified token.
          performedByAdminId: actorId,
        },
      }),
    ], { timeout: 20000 });

    logger.info(`[UPDATE_WALLET] Wallet updated successfully`, { marketerId, operation, amount, newBalance, actorId });

    res.status(200).json({
      success: true,
      message: `Wallet ${operation} successful`,
      data: {
        marketerId: updatedMarketer.id,
        balance: updatedMarketer.walletBalance,
        totalWithdrawn: updatedMarketer.totalWithdrawn,
        lastPayoutDate: updatedMarketer.lastPayoutDate,
      },
    });
  } catch (err) {
    logger.error(`[UPDATE_WALLET] Error updating wallet`, { error: err.message, marketerId: req.params.id });
    next(err);
  }
};

/**
 * GET /api/public/settings/commission
 * Get global commission rate (Super Admin configures)
 */
exports.getGlobalCommission = async (req, res, next) => {
  try {
    let settings = await prisma.platformSettings.findFirst();
    if (!settings) settings = await prisma.platformSettings.create({ data: {} });

    logger.debug(`[GET_COMMISSION] Global commission rates retrieved`, { settingsId: settings.id });

    res.status(200).json({
      success: true,
      message: "Global commission rates retrieved",
      data: {
        commissionRate: settings.commissionRate,
        firstPaymentCommissionRate: settings.firstPaymentCommissionRate,
        renewalCommissionRate: settings.renewalCommissionRate,
      },
    });
  } catch (err) {
    logger.error(`[GET_COMMISSION] Error retrieving commission`, { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/public/settings/commission
 * Set global commission rate(s) — persisted on PlatformSettings, the single
 * source of truth for platform-default marketer commission rates. An
 * individual marketer's Admin.commissionRate, when set, overrides these.
 */
exports.setGlobalCommission = async (req, res, next) => {
  try {
    const { commissionRate, firstPaymentCommissionRate, renewalCommissionRate } = req.body;

    for (const [key, value] of Object.entries({ commissionRate, firstPaymentCommissionRate, renewalCommissionRate })) {
      if (value !== undefined && (typeof value !== 'number' || value < 0 || value > 100)) {
        logger.warn(`[SET_COMMISSION] Invalid commission rate`, { key, value });
        return res.status(400).json({
          success: false,
          message: `${key} must be a number between 0 and 100`,
          code: "INVALID_RATE",
        });
      }
    }

    let settings = await prisma.platformSettings.findFirst();
    if (!settings) settings = await prisma.platformSettings.create({ data: {} });

    const updateData = {};
    if (commissionRate !== undefined) updateData.commissionRate = commissionRate;
    if (firstPaymentCommissionRate !== undefined) updateData.firstPaymentCommissionRate = firstPaymentCommissionRate;
    if (renewalCommissionRate !== undefined) updateData.renewalCommissionRate = renewalCommissionRate;

    const updated = await prisma.platformSettings.update({ where: { id: settings.id }, data: updateData });

    logger.info(`[SET_COMMISSION] Global commission rates updated`, { settingsId: updated.id });

    res.status(200).json({
      success: true,
      message: "Global commission rates updated successfully",
      data: {
        commissionRate: updated.commissionRate,
        firstPaymentCommissionRate: updated.firstPaymentCommissionRate,
        renewalCommissionRate: updated.renewalCommissionRate,
      },
    });
  } catch (err) {
    logger.error(`[SET_COMMISSION] Error setting commission`, { error: err.message });
    next(err);
  }
};

// Same format as the Super Admin Portal (res/controller/system-admin/generateToken.js
// and res/controller/superadmin/SuperAdminController.js) so both portals mint
// identical, interchangeable school registration codes.
const generateRegistrationToken = () => {
  const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `TKN-${randomHex}`;
};

/**
 * POST /api/public/school-tokens
 * Create a new school assessment token (called by Marketer Portal)
 *
 * Writes two rows: `SchoolToken` (powers the marketer dashboard) and `Token`
 * (what POST /api/admin/create validates against). Before this, marketer tokens
 * only ever landed in `SchoolToken`, so a school handed one could never actually
 * register — registration reads `Token` exclusively.
 */
exports.createSchoolToken = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;
    const { schoolName, schoolEmail } = req.body;

    if (!marketerId) {
      logger.warn(`[CREATE_TOKEN] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (!schoolName || !schoolEmail) {
      logger.warn(`[CREATE_TOKEN] Missing required fields`, { schoolName, schoolEmail });
      return res.status(400).json({
        success: false,
        message: "School name and email are required",
        code: "MISSING_FIELDS",
      });
    }

    // Token.email is @unique — a duplicate row throws P2002, so guard first and
    // mirror the Super Admin 409 exactly.
    const existingToken = await prisma.token.findUnique({
      where: { email: schoolEmail },
    });

    if (existingToken && existingToken.status === "active") {
      logger.warn(`[CREATE_TOKEN] Active registration token already exists`, { schoolEmail });
      return res.status(409).json({
        success: false,
        message: "An active registration token already exists for this school email",
        code: "TOKEN_EXISTS",
      });
    }

    const code = generateRegistrationToken();
    const issuedDate = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30); // 30 days, same as Super Admin

    // Both rows or neither — a partial write would leave the marketer dashboard
    // showing a token that registration can't honour (or vice versa).
    const token = await prisma.$transaction(async (tx) => {
      const schoolToken = await tx.schoolToken.create({
        data: {
          marketerId,
          code,
          schoolName,
          schoolEmail,
          status: "active",
          issuedDate,
          expiryDate,
        },
      });

      // upsert, not create — lets a school whose earlier token was spent or
      // expired be issued a fresh one against the same email.
      await tx.token.upsert({
        where: { email: schoolEmail },
        update: {
          uniqueKey: code,
          schoolName,
          status: "active",
          expiresAt: expiryDate,
          usedAt: null,
          usedBy: null,
        },
        create: {
          email: schoolEmail,
          uniqueKey: code,
          schoolName,
          status: "active",
          expiresAt: expiryDate,
        },
      });

      // Surface the school in the marketer's list straight away. Issuing a
      // token is the only path that puts a school there — the portal has no
      // "Add School" UI, so POST /marketer-schools is never called — and
      // without this the dashboard reads empty until a school finishes
      // onboarding. schoolId stays null until it converts; the attribution
      // step in setupSchool fills it in and unlocks commission.
      //
      // findFirst + branch rather than upsert: MarketerSchoolLead has no
      // unique constraint on (marketerId, email), only on schoolId.
      const existingLead = await tx.marketerSchoolLead.findFirst({
        where: { marketerId, email: schoolEmail },
        select: { id: true },
      });

      if (existingLead) {
        // Leave `name` alone — the marketer may have edited it deliberately.
        await tx.marketerSchoolLead.update({
          where: { id: existingLead.id },
          data: { tokensIssued: { increment: 1 } },
        });
      } else {
        await tx.marketerSchoolLead.create({
          data: {
            marketerId,
            name: schoolName,
            email: schoolEmail,
            status: "active",
            tokensIssued: 1,
          },
        });
      }

      return schoolToken;
    }, {
      // Four to five sequential round-trips (schoolToken, token upsert, lead
      // lookup, lead write) against a database reached over a remote proxy.
      // Prisma's 5s interactive-transaction default is not enough headroom —
      // the payout flow aborted at 5106ms doing strictly less work.
      timeout: 20000,
      maxWait: 10000,
    });

    logger.info(`[CREATE_TOKEN] New token created and saved`, {
      tokenId: token.id,
      code,
      schoolName,
      schoolEmail,
      marketerId,
    });

    res.status(201).json({
      success: true,
      message: "Token created successfully",
      data: {
        id: token.id,
        code: token.code,
        schoolName: token.schoolName,
        schoolEmail: token.schoolEmail,
        issuedDate: token.issuedDate.toISOString(),
        expiryDate: token.expiryDate.toISOString(),
        status: token.status,
      },
    });
  } catch (err) {
    logger.error(`[CREATE_TOKEN] Error creating token`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/school-tokens
 * List school assessment tokens (called by Marketer Portal)
 */
exports.getSchoolTokens = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    if (!marketerId) {
      logger.warn(`[GET_TOKENS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const page = parseInt(req.query.page || 1, 10);
    const limit = parseInt(req.query.limit || 20, 10);
    const skip = (Math.max(page, 1) - 1) * limit;
    const search = req.query.search || "";
    const status = req.query.status || "";

    // Build WHERE clause with optional filters, always scoped to this marketer
    const where = { marketerId };
    if (search) {
      where.OR = [
        { schoolName: { contains: search } },
        { schoolEmail: { contains: search } },
      ];
    }
    if (status) {
      where.status = status;
    }

    const [tokens, total] = await Promise.all([
      prisma.schoolToken.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.schoolToken.count({ where }),
    ]);

    logger.debug(`[GET_TOKENS] Fetching tokens`, { marketerId, page, limit, count: tokens.length, search, status });

    const formattedTokens = tokens.map(t => ({
      id: t.id,
      code: t.code,
      schoolName: t.schoolName,
      schoolEmail: t.schoolEmail,
      issuedDate: t.issuedDate.toISOString(),
      expiryDate: t.expiryDate.toISOString(),
      status: t.status,
    }));

    res.status(200).json({
      success: true,
      data: {
        tokens: formattedTokens,
        total,
        page: Math.max(page, 1),
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`[GET_TOKENS] Error fetching tokens`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/school-tokens/stats
 * Get token statistics (called by Marketer Portal)
 */
exports.getSchoolTokenStats = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    if (!marketerId) {
      logger.warn(`[TOKEN_STATS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const [total, active, used, expired, revoked] = await Promise.all([
      prisma.schoolToken.count({ where: { marketerId } }),
      prisma.schoolToken.count({ where: { marketerId, status: "active" } }),
      prisma.schoolToken.count({ where: { marketerId, status: "used" } }),
      prisma.schoolToken.count({ where: { marketerId, status: "expired" } }),
      prisma.schoolToken.count({ where: { marketerId, status: "revoked" } }),
    ]);

    logger.debug(`[TOKEN_STATS] Token statistics retrieved`, { marketerId, total, active });

    res.status(200).json({
      success: true,
      data: { total, active, used, expired, revoked },
    });
  } catch (err) {
    logger.error(`[TOKEN_STATS] Error fetching stats`, { error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/auth/signup
 * Marketer signup endpoint (called by Marketer Portal)
 */
exports.marketerSignup = async (req, res, next) => {
  try {
    const { email, password, name, tier } = req.body;

    if (!email || !password || !name) {
      logger.warn(`[MARKETER_SIGNUP] Missing required fields`, { email, name });
      return res.status(400).json({
        success: false,
        message: "Email, password, and name are required",
        code: "MISSING_FIELDS",
      });
    }

    // Check if marketer already exists
    const existing = await prisma.admin.findUnique({ where: { email } });
    if (existing) {
      logger.warn(`[MARKETER_SIGNUP] Email already registered`, { email });
      return res.status(409).json({
        success: false,
        message: "Email already registered",
        code: "EMAIL_EXISTS",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create marketer. This is the route the Marketer Portal actually signs up
    // through, and it never set referralCode — which is why every existing row
    // has NULL and the Super Admin table's Referral Code column was blank.
    const marketer = await prisma.admin.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: "marketer",
        tier: tier || "bronze",
        referralCode: await generateUniqueReferralCode(prisma),
      },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
        referralCode: true,
      },
    });

    // Generate JWT token
    const token = jwt.sign(
      { id: marketer.id, email: marketer.email, role: "marketer" },
      process.env.JWT_SECRET || "secret",
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    logger.info(`[MARKETER_SIGNUP] New marketer registered`, { email, marketerId: marketer.id });

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      data: {
        marketer,
        token,
      },
    });
  } catch (err) {
    logger.error(`[MARKETER_SIGNUP] Error creating account`, { error: err.message, email: req.body?.email });
    next(err);
  }
};

/**
 * GET /api/public/auth/profile            <- preferred: derives the marketer from the token
 * GET /api/public/auth/profile/:marketerId <- legacy: kept for the Marketer Portal's
 *                                             cached-id flow, but only for your own id
 *
 * Identity always comes from the verified Bearer token. When the legacy
 * :marketerId param is supplied it is treated as an assertion to check, not as
 * a selector — a mismatch is 403 rather than someone else's profile.
 */
exports.getMarketerProfile = async (req, res, next) => {
  try {
    const authenticatedId = req.user?.id || req.marketer?.id;
    const { marketerId } = req.params;

    if (!authenticatedId) {
      logger.warn(`[MARKETER_PROFILE] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (marketerId && parseInt(marketerId, 10) !== authenticatedId) {
      logger.warn(`[MARKETER_PROFILE] Cross-marketer profile read blocked`, {
        requested: marketerId,
        caller: authenticatedId,
      });
      return res.status(403).json({
        success: false,
        message: "Forbidden",
        code: "FORBIDDEN",
      });
    }

    const parsedId = authenticatedId;

    const marketer = await prisma.admin.findUnique({
      where: { id: parsedId },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
        walletBalance: true,
        totalWithdrawn: true,
        lastPayoutDate: true,
        createdAt: true,
        // Self-service endpoint — the caller is always the marketer themselves
        // (enforced above), so their own contact and bank details are safe here.
        referralCode: true,
        avatar: true,
        phone: true,
        address: true,
        city: true,
        state: true,
        bankName: true,
        bankAccountNumber: true,
        bankAccountName: true,
        isEmailVerified: true,
        isSuspended: true,
        verificationStatus: true,
        verificationDocumentType: true,
        verificationSubmittedAt: true,
        verificationRejectionReason: true,
        role: true,
        twoFactorEnabled: true,
        notificationPreferences: true,
      },
    });

    if (!marketer) {
      logger.warn(`[MARKETER_PROFILE] Marketer not found`, { marketerId: parsedId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    logger.debug(`[MARKETER_PROFILE] Profile retrieved`, { marketerId: parsedId });

    // Stored as a JSON string (Text column); hand the client an object, and
    // fall back to defaults for marketers who have never saved preferences.
    let notificationPreferences = {
      email: true,
      push: true,
      commissionAlerts: true,
      marketingUpdates: false,
    };
    if (marketer.notificationPreferences) {
      try {
        notificationPreferences = JSON.parse(marketer.notificationPreferences);
      } catch (parseErr) {
        logger.warn(`[MARKETER_PROFILE] Corrupt notificationPreferences, serving defaults`, {
          marketerId: parsedId,
        });
      }
    }

    res.status(200).json({
      success: true,
      data: { ...marketer, notificationPreferences },
    });
  } catch (err) {
    logger.error(`[MARKETER_PROFILE] Error fetching profile`, { error: err.message, marketerId: req.user?.id });
    next(err);
  }
};

/**
 * GET /api/public/marketer-schools
 * Get schools for a marketer (called by Marketer Portal)
 */
exports.getMarketerSchools = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const search = req.query.search || "";

    if (!marketerId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Always scoped to this marketer; search narrows within their own leads.
    // No `mode: "insensitive"` — this is MySQL, where Prisma does not generate
    // QueryMode. The default collation is already case-insensitive.
    const where = { marketerId };
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
        { contactPerson: { contains: search } },
      ];
    }

    const [schools, total] = await Promise.all([
      prisma.marketerSchoolLead.findMany({
        where,
        select: {
          id: true,
          // Null until the school completes onboarding. Non-null means this
          // lead has converted into a real School tenant, which is what makes
          // it eligible for commission.
          schoolId: true,
          name: true,
          email: true,
          location: true,
          state: true,
          registrationNumber: true,
          type: true,
          contactPerson: true,
          phone: true,
          tokensIssued: true,
          totalRevenue: true,
          totalCommission: true,
          status: true,
          createdAt: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.marketerSchoolLead.count({ where }),
    ]);

    logger.debug(`[MARKETER_SCHOOLS] Schools retrieved`, { marketerId, count: schools.length });

    res.status(200).json({
      success: true,
      data: {
        schools,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`[MARKETER_SCHOOLS] Error fetching schools`, { error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/marketer-schools
 * Create a school for a marketer (called by Marketer Portal)
 */
exports.createMarketerSchool = async (req, res, next) => {
  try {
    const { marketerId, name, email, location, state, registrationNumber } = req.body;

    if (!marketerId || !name || !email) {
      logger.warn(`[CREATE_SCHOOL] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "Marketer ID, name, and email are required",
        code: "MISSING_FIELDS",
      });
    }

    const school = await prisma.marketerSchoolLead.create({
      data: {
        marketerId: parseInt(marketerId),
        name,
        email,
        location: location || null,
        state: state || null,
        registrationNumber: registrationNumber || null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        location: true,
        state: true,
        registrationNumber: true,
        type: true,
        contactPerson: true,
        phone: true,
        tokensIssued: true,
        totalRevenue: true,
        totalCommission: true,
        status: true,
        createdAt: true,
      },
    });

    logger.info(`[CREATE_SCHOOL] School created`, { schoolId: school.id, marketerId, name });

    res.status(201).json({
      success: true,
      message: "School created successfully",
      data: school,
    });
  } catch (err) {
    logger.error(`[CREATE_SCHOOL] Error creating school`, { error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/marketer-schools/:id
 * Update a school (called by Marketer Portal)
 */
exports.updateMarketerSchool = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;
    const { id } = req.params;
    const { name, email, location, state, registrationNumber, type, contactPerson, phone, status } = req.body;

    if (!marketerId) {
      logger.warn(`[UPDATE_SCHOOL] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "School ID is required",
        code: "MISSING_ID",
      });
    }

    // Ownership check. Lead ids are sequential integers, so without this any
    // signed-in marketer could edit another marketer's lead by guessing an id.
    // Mirrors the guard already in revokeSchoolToken.
    const existing = await prisma.marketerSchoolLead.findUnique({
      where: { id: parseInt(id) },
      select: { marketerId: true },
    });

    if (!existing) {
      logger.warn(`[UPDATE_SCHOOL] School not found`, { schoolId: id });
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "NOT_FOUND",
      });
    }

    if (existing.marketerId !== marketerId) {
      logger.warn(`[UPDATE_SCHOOL] Forbidden - lead belongs to another marketer`, { schoolId: id, marketerId, ownerId: existing.marketerId });
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this school",
        code: "FORBIDDEN",
      });
    }

    const school = await prisma.marketerSchoolLead.update({
      where: { id: parseInt(id) },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(location && { location }),
        ...(state && { state }),
        ...(registrationNumber && { registrationNumber }),
        ...(type && { type }),
        ...(contactPerson && { contactPerson }),
        ...(phone && { phone }),
        ...(status && { status }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        location: true,
        state: true,
        registrationNumber: true,
        type: true,
        contactPerson: true,
        phone: true,
        tokensIssued: true,
        totalRevenue: true,
        totalCommission: true,
        status: true,
        createdAt: true,
      },
    });

    logger.info(`[UPDATE_SCHOOL] School updated`, { schoolId: id });

    res.status(200).json({
      success: true,
      message: "School updated successfully",
      data: school,
    });
  } catch (err) {
    if (err.code === "P2025") {
      logger.warn(`[UPDATE_SCHOOL] School not found`, { schoolId: req.params.id });
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "NOT_FOUND",
      });
    }
    logger.error(`[UPDATE_SCHOOL] Error updating school`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/notifications
 * List the authenticated marketer's notifications.
 * Query: ?page&limit&unreadOnly=true
 */
exports.getNotifications = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 10));
    // ?unreadOnly=true narrows the list; unreadCount below is always the full
    // unread total so a badge stays correct regardless of this filter.
    const unreadOnly = req.query.unreadOnly === "true";

    logger.debug(`[GET_NOTIFICATIONS] Fetching notifications`, { marketerId, page, limit, unreadOnly });

    if (!marketerId) {
      logger.warn(`[GET_NOTIFICATIONS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const where = { marketerId };
    if (unreadOnly) where.isRead = false;

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { marketerId, isRead: false } }),
    ]);

    logger.info(`[GET_NOTIFICATIONS] Notifications retrieved`, { marketerId, count: notifications.length, unreadCount });

    res.status(200).json({
      success: true,
      data: {
        notifications,
        total,
        unreadCount,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`[GET_NOTIFICATIONS] Error fetching notifications`, { error: err.message });
    next(err);
  }
};

/**
 * ============================================
 * PHASE 1 & 2 - MARKETER PORTAL ENDPOINTS
 * ============================================
 */

/**
 * POST /api/public/auth/2fa/verify
 * Verify 2FA code during login
 *
 * Note: tempToken should be a JWT that contains:
 * - userId: marketer ID
 * - email: marketer email
 * - type: '2fa-temp'
 * - createdAt: timestamp (expires in 5 minutes)
 */

/**
 * GET /api/public/school-tokens/by-school
 * Get count of tokens issued per school
 */
exports.getTokensBySchool = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    if (!marketerId) {
      logger.warn(`[TOKENS_BY_SCHOOL] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    logger.debug(`[TOKENS_BY_SCHOOL] Fetching token counts by school`, { marketerId });

    const tokenCounts = await prisma.schoolToken.groupBy({
      by: ["schoolName"],
      where: { marketerId },
      _count: {
        id: true,
      },
      orderBy: {
        _count: {
          id: "desc",
        },
      },
    });

    const data = tokenCounts.map((group) => ({
      school: group.schoolName,
      tokens: group._count.id,
    }));

    logger.info(`[TOKENS_BY_SCHOOL] Token counts retrieved`, { schoolCount: data.length });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    logger.error(`[TOKENS_BY_SCHOOL] Failed to fetch token counts`, { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/public/school-tokens/:id/revoke
 * Deactivate/revoke a token
 */
exports.revokeSchoolToken = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;
    const { id } = req.params;
    const tokenId = parseInt(id, 10);

    logger.debug(`[REVOKE_TOKEN] Revoking token`, { tokenId, marketerId });

    if (!marketerId) {
      logger.warn(`[REVOKE_TOKEN] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (isNaN(tokenId)) {
      logger.warn(`[REVOKE_TOKEN] Invalid token ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid token ID",
        code: "INVALID_ID",
      });
    }

    const token = await prisma.schoolToken.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      logger.warn(`[REVOKE_TOKEN] Token not found`, { tokenId });
      return res.status(404).json({
        success: false,
        message: "Token not found",
        code: "NOT_FOUND",
      });
    }

    if (token.marketerId !== marketerId) {
      logger.warn(`[REVOKE_TOKEN] Forbidden - token belongs to another marketer`, { tokenId, marketerId, ownerId: token.marketerId });
      return res.status(403).json({
        success: false,
        message: "You do not have permission to revoke this token",
        code: "FORBIDDEN",
      });
    }

    // Revoke both rows. Marketer tokens now register schools via the `Token`
    // table, so revoking only the SchoolToken row would leave a live
    // registration code behind. updateMany (not update) so tokens issued before
    // the dual-write existed don't throw on a missing `Token` row.
    const updatedToken = await prisma.$transaction(async (tx) => {
      const schoolToken = await tx.schoolToken.update({
        where: { id: tokenId },
        data: { status: "revoked" },
      });

      await tx.token.updateMany({
        where: { uniqueKey: token.code },
        data: { status: "inactive" },
      });

      return schoolToken;
    });

    logger.info(`[REVOKE_TOKEN] Token revoked successfully`, { tokenId });

    res.status(200).json({
      success: true,
      message: "Token revoked",
      data: {
        id: updatedToken.id,
        status: updatedToken.status,
      },
    });
  } catch (err) {
    logger.error(`[REVOKE_TOKEN] Failed to revoke token`, { tokenId: req.params.id, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/commissions
 * Get commissions for a marketer with pagination
 */
exports.getCommissions = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;

    logger.debug(`[GET_COMMISSIONS] Fetching commissions`, { page, limit, marketerId });

    if (!marketerId) {
      logger.warn(`[GET_COMMISSIONS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const where = { marketerId };
    if (startDate && endDate) {
      where.createdAt = {
        gte: startDate,
        lte: endDate,
      };
    }

    const [commissions, total] = await Promise.all([
      prisma.commission.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        // Joined so the client doesn't have to resolve schoolId -> name per row.
        include: { school: { select: { name: true } } },
      }),
      prisma.commission.count({ where }),
    ]);

    // Flatten the relation into schoolName and drop the nested object, keeping
    // rows flat. schoolName is null for legacy rows that have no schoolId.
    const formattedCommissions = commissions.map(({ school, ...commission }) => ({
      ...commission,
      schoolName: school?.name ?? null,
    }));

    logger.info(`[GET_COMMISSIONS] Commissions retrieved`, { marketerId, count: commissions.length, total });

    res.status(200).json({
      success: true,
      data: {
        commissions: formattedCommissions,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`[GET_COMMISSIONS] Failed to fetch commissions`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/commissions/summary
 * Get commission summary (total, pending, monthly)
 */
exports.getCommissionSummary = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;

    logger.debug(`[COMMISSION_SUMMARY] Fetching commission summary`, { marketerId });

    if (!marketerId) {
      logger.warn(`[COMMISSION_SUMMARY] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const [totalData, paidData, pendingData, bySchoolGroups] = await Promise.all([
      prisma.commission.aggregate({
        where: { marketerId },
        _sum: { amount: true },
      }),
      prisma.commission.aggregate({
        where: { marketerId, status: "paid" },
        _sum: { amount: true },
      }),
      prisma.commission.aggregate({
        where: { marketerId, status: "pending" },
        _sum: { amount: true },
      }),
      // schoolId is only populated on commissions created after this field was
      // added — older rows (schoolId: null) are excluded from the breakdown
      // since there's no reliable way to attribute them to a specific school.
      prisma.commission.groupBy({
        by: ["schoolId"],
        where: { marketerId, schoolId: { not: null } },
        _sum: { amount: true },
        orderBy: { _sum: { amount: "desc" } },
      }),
    ]);

    const schools = await prisma.school.findMany({
      where: { id: { in: bySchoolGroups.map((g) => g.schoolId) } },
      select: { id: true, name: true },
    });
    const schoolNameById = new Map(schools.map((s) => [s.id, s.name]));

    const bySchool = bySchoolGroups.map((g) => ({
      _id: String(g.schoolId),
      schoolName: schoolNameById.get(g.schoolId) || "Unknown school",
      totalCommission: g._sum.amount || 0,
    }));

    logger.info(`[COMMISSION_SUMMARY] Commission summary retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalCommission: totalData._sum.amount || 0,
          paidCommission: paidData._sum.amount || 0,
          pendingCommission: pendingData._sum.amount || 0,
        },
        bySchool,
      },
    });
  } catch (err) {
    logger.error(`[COMMISSION_SUMMARY] Failed to fetch commission summary`, { error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/notifications/:id/read
 * Mark a single notification as read
 */
exports.markNotificationRead = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;
    const { id } = req.params;
    const notificationId = parseInt(id, 10);

    logger.debug(`[MARK_NOTIFICATION_READ] Marking notification as read`, { notificationId, marketerId });

    if (!marketerId) {
      logger.warn(`[MARK_NOTIFICATION_READ] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (isNaN(notificationId)) {
      logger.warn(`[MARK_NOTIFICATION_READ] Invalid notification ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid notification ID",
        code: "INVALID_ID",
      });
    }

    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      logger.warn(`[MARK_NOTIFICATION_READ] Notification not found`, { notificationId });
      return res.status(404).json({
        success: false,
        message: "Notification not found",
        code: "NOT_FOUND",
      });
    }

    // Ownership check — a marketer must not be able to read-mark another
    // marketer's notifications.
    if (notification.marketerId !== marketerId) {
      logger.warn(`[MARK_NOTIFICATION_READ] Forbidden - notification belongs to another marketer`, { notificationId, marketerId, ownerId: notification.marketerId });
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this notification",
        code: "FORBIDDEN",
      });
    }

    await prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });

    logger.info(`[MARK_NOTIFICATION_READ] Notification marked as read`, { notificationId });

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (err) {
    logger.error(`[MARK_NOTIFICATION_READ] Failed to mark notification as read`, { notificationId: req.params.id, error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/notifications/read-all
 * Mark all notifications as read
 */
exports.markAllNotificationsRead = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;

    logger.debug(`[MARK_ALL_NOTIFICATIONS_READ] Marking all notifications as read`, { marketerId });

    if (!marketerId) {
      logger.warn(`[MARK_ALL_NOTIFICATIONS_READ] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const result = await prisma.notification.updateMany({
      where: { marketerId, isRead: false },
      data: { isRead: true },
    });

    logger.info(`[MARK_ALL_NOTIFICATIONS_READ] All notifications marked as read`, { marketerId, count: result.count });

    res.status(200).json({
      success: true,
      message: "All notifications marked as read",
      data: {
        count: result.count,
      },
    });
  } catch (err) {
    logger.error(`[MARK_ALL_NOTIFICATIONS_READ] Failed to mark all notifications as read`, { error: err.message });
    next(err);
  }
};

/**
 * ============================================
 * PHASE 2 - USER PROFILE & SETTINGS ENDPOINTS
 * ============================================
 */

/**
 * PUT /api/public/users/profile
 * Update marketer profile information
 */
exports.updateMarketerProfile = async (req, res, next) => {
  try {
    // Identity comes from the verified Bearer token, never from the client.
    const id = req.user?.id || req.marketer?.id;
    const { name, phone, address, city, state } = req.body;

    logger.debug(`[UPDATE_PROFILE] Updating marketer profile`, { marketerId: id });

    if (!id) {
      logger.warn(`[UPDATE_PROFILE] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[UPDATE_PROFILE] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    const updated = await prisma.admin.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(address && { address }),
        ...(city && { city }),
        ...(state && { state }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        city: true,
        state: true,
      },
    });

    logger.info(`[UPDATE_PROFILE] Profile updated successfully`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "Profile updated",
      data: updated,
    });
  } catch (err) {
    logger.error(`[UPDATE_PROFILE] Failed to update profile`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/users/password
 * Change marketer password
 */
exports.changePassword = async (req, res, next) => {
  try {
    // Identity comes from the verified Bearer token, never from the client.
    const id = req.user?.id || req.marketer?.id;
    const { currentPassword, newPassword } = req.body;

    logger.debug(`[CHANGE_PASSWORD] Password change attempt`, { marketerId: id });

    if (!id) {
      logger.warn(`[CHANGE_PASSWORD] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (!currentPassword || !newPassword) {
      logger.warn(`[CHANGE_PASSWORD] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "currentPassword and newPassword are required",
        code: "MISSING_FIELDS",
      });
    }

    if (newPassword.length < 8) {
      logger.warn(`[CHANGE_PASSWORD] Password too short`, { marketerId: id });
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
        code: "WEAK_PASSWORD",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[CHANGE_PASSWORD] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, marketer.password);
    if (!isPasswordValid) {
      logger.warn(`[CHANGE_PASSWORD] Invalid current password`, { marketerId: id });
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
        code: "INVALID_PASSWORD",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.admin.update({
      where: { id },
      data: { password: hashedPassword },
    });

    logger.info(`[CHANGE_PASSWORD] Password changed successfully`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (err) {
    logger.error(`[CHANGE_PASSWORD] Failed to change password`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/users/avatar
 * Upload marketer avatar
 */
exports.uploadAvatar = async (req, res, next) => {
  try {
    // Identity comes from the verified Bearer token. This previously read
    // ?marketerId from the query string, which let any caller overwrite another
    // marketer's avatar.
    const id = req.user?.id || req.marketer?.id;

    logger.debug(`[UPLOAD_AVATAR] Avatar upload initiated`, { marketerId: id });

    if (!id) {
      logger.warn(`[UPLOAD_AVATAR] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Reaching this with no file means the multipart field name was wrong —
    // uploadAvatarSingle("avatar") already rejects oversized and non-image
    // uploads with 413/415 before the handler runs.
    if (!req.file) {
      logger.warn(`[UPLOAD_AVATAR] No file uploaded`, { marketerId: id });
      return res.status(400).json({
        success: false,
        message: "No file uploaded — send the image in the 'avatar' field",
        code: "NO_FILE",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[UPLOAD_AVATAR] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // processImage validates, resizes and writes the file, matching how school
    // logos and stamps are handled. It returns "/uploads/<folder>/<file>";
    // app.ts serves that directory at /api/uploads, hence the prefix.
    // Date.now() keeps the filename unique so a replaced avatar isn't served
    // from cache under the old URL.
    const storedPath = await processImage(
      req.file.buffer,
      "avatars",
      `avatar-${id}-${Date.now()}.jpeg`
    );
    const avatarUrl = `/api${storedPath}`;

    await prisma.admin.update({
      where: { id },
      data: { avatar: avatarUrl },
    });

    logger.info(`[UPLOAD_AVATAR] Avatar uploaded successfully`, { marketerId: id, avatarUrl });

    res.status(200).json({
      success: true,
      message: "Avatar uploaded",
      data: {
        avatarUrl,
      },
    });
  } catch (err) {
    logger.error(`[UPLOAD_AVATAR] Failed to upload avatar`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/settings/banks
 * Get list of Nigerian banks
 */
/**
 * Offline fallback, used only when the Flutterwave bank list is unreachable.
 *
 * These are NIP codes, which is what a transfer is actually routed on. The
 * list this replaced carried wrong codes for several banks (Zenith as 007
 * rather than 057, GTBank as 053/014 rather than 058), listed GTBank three
 * times, and still offered Skye and Diamond — both long since absorbed into
 * Polaris and Access. Selecting one of those would have stored a code that
 * routes a payout to the wrong institution or fails outright.
 *
 * Deliberately limited to long-established commercial banks whose codes are
 * stable. The live API is authoritative; this only keeps the dropdown usable
 * during an outage.
 */
const FALLBACK_NG_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "063", name: "Access Bank (Diamond)" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "033", name: "United Bank for Africa" },
  { code: "215", name: "Unity Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

exports.getBankList = async (req, res, next) => {
  try {
    logger.debug(`[GET_BANKS] Fetching Nigerian banks list`);

    let banks;
    try {
      banks = await flutterwave.listBanks();
    } catch (flwErr) {
      // Degrade to the offline list rather than failing — an unreachable
      // Flutterwave should not stop a marketer from opening the settings page.
      logger.warn(`[GET_BANKS] Flutterwave unavailable, serving fallback list`, { error: flwErr.message });
      banks = FALLBACK_NG_BANKS;
    }

    logger.info(`[GET_BANKS] Banks list retrieved`, { count: banks.length });

    res.status(200).json({
      success: true,
      data: banks,
    });
  } catch (err) {
    logger.error(`[GET_BANKS] Failed to fetch banks`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/settings/verify-account
 * Verify bank account (integration with Flutterwave/Mono)
 */
exports.verifyBankAccount = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.query;

    logger.debug(`[VERIFY_ACCOUNT] Verifying bank account`, { bankCode });

    if (!accountNumber || !bankCode) {
      logger.warn(`[VERIFY_ACCOUNT] Missing accountNumber or bankCode`);
      return res.status(400).json({
        success: false,
        message: "accountNumber and bankCode are required",
        code: "MISSING_FIELDS",
      });
    }

    // Resolved against Flutterwave. This previously returned a hardcoded
    // { accountName: "John Marketer", verified: true } for ANY input, so the
    // green tick shown before a payout meant nothing.
    //
    // Fails CLOSED: if resolution errors we report verified:false rather than
    // assuming success. This gates where a marketer's money is sent, so an
    // unverifiable account must never look verified.
    let resolved;
    try {
      resolved = await flutterwave.resolveAccount({ accountNumber, bankCode });
    } catch (flwErr) {
      logger.warn(`[VERIFY_ACCOUNT] Could not resolve account`, { bankCode, error: flwErr.message });

      // Flutterwave's sandbox resolves only its own fixed test accounts
      // (0690000031 / 0690000032 at bank 044). Every real account fails there
      // no matter how valid it is. Telling the marketer to "check the account
      // number" in that case is simply wrong advice, so report it as what it
      // is: the provider being in test mode.
      if (String(process.env.FLW_SECRET_KEY || "").includes("TEST")) {
        return res.status(503).json({
          success: false,
          message:
            "Bank verification is unavailable while Flutterwave is in test mode. " +
            "The sandbox only resolves its own test accounts (0690000031 or 0690000032 at bank 044). " +
            "A live FLW_SECRET_KEY is required to verify real accounts.",
          code: "PROVIDER_TEST_MODE",
          data: { accountNumber, bankCode, verified: false, providerMessage: flwErr.message },
        });
      }

      return res.status(422).json({
        success: false,
        message: "Could not verify this account. Check the account number and bank, then try again.",
        code: "ACCOUNT_VERIFICATION_FAILED",
        data: { accountNumber, bankCode, verified: false, providerMessage: flwErr.message },
      });
    }

    if (!resolved.accountName) {
      logger.warn(`[VERIFY_ACCOUNT] Resolution returned no account name`, { bankCode });
      return res.status(422).json({
        success: false,
        message: "Could not verify this account. Check the account number and bank, then try again.",
        code: "ACCOUNT_VERIFICATION_FAILED",
        data: { accountNumber, bankCode, verified: false },
      });
    }

    logger.info(`[VERIFY_ACCOUNT] Account verified`, { bankCode });

    res.status(200).json({
      success: true,
      data: {
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
        bankCode,
        verified: true,
      },
    });
  } catch (err) {
    logger.error(`[VERIFY_ACCOUNT] Failed to verify account`, { error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/settings/bank-account
 * Save marketer bank account details
 */
exports.saveBankAccount = async (req, res, next) => {
  try {
    // Identity comes from the verified Bearer token, never from the client.
    // A caller authenticated only by x-service-key has no user identity and
    // must not be able to rewrite a marketer's payout destination.
    const id = req.user?.id || req.marketer?.id;
    // `bankCode` is canonical (it is the NIP code transfers route on), but the
    // Marketer Portal historically sent the same value as `bankName`. Accept
    // either so a client on the older shape isn't hard-blocked by a 400.
    const { accountNumber, accountName } = req.body;
    const bankCode = req.body.bankCode || req.body.bankName;

    logger.debug(`[SAVE_BANK_ACCOUNT] Saving bank account`, { marketerId: id, bankCode });

    if (!id) {
      logger.warn(`[SAVE_BANK_ACCOUNT] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (!accountNumber || !accountName || !bankCode) {
      logger.warn(`[SAVE_BANK_ACCOUNT] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        code: "MISSING_FIELDS",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[SAVE_BANK_ACCOUNT] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    const updated = await prisma.admin.update({
      where: { id },
      data: {
        bankAccountNumber: accountNumber,
        bankAccountName: accountName,
        bankName: bankCode,
      },
      select: {
        id: true,
        bankAccountNumber: true,
        bankAccountName: true,
        bankName: true,
      },
    });

    logger.info(`[SAVE_BANK_ACCOUNT] Bank account saved`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "Bank account updated",
      data: {
        accountNumber: updated.bankAccountNumber,
        accountName: updated.bankAccountName,
        bankCode: updated.bankName,
      },
    });
  } catch (err) {
    logger.error(`[SAVE_BANK_ACCOUNT] Failed to save bank account`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/settings/notifications
 * Update notification preferences
 */
exports.updateNotificationSettings = async (req, res, next) => {
  try {
    // Identity comes from the verified Bearer token, never from the client.
    const id = req.user?.id || req.marketer?.id;
    const { email, push, commissionAlerts, marketingUpdates } = req.body;

    logger.debug(`[UPDATE_NOTIFICATIONS] Updating notification preferences`, { marketerId: id });

    if (!id) {
      logger.warn(`[UPDATE_NOTIFICATIONS] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[UPDATE_NOTIFICATIONS] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // Merge over whatever is already stored so a partial PUT does not silently
    // reset the toggles the client did not send. Parse defensively — a corrupt
    // value would otherwise 500 this endpoint, and getMarketerProfile already
    // tolerates the same corruption rather than failing.
    let existing = {};
    if (marketer.notificationPreferences) {
      try {
        existing = JSON.parse(marketer.notificationPreferences);
      } catch (parseErr) {
        logger.warn(`[UPDATE_NOTIFICATIONS] Corrupt notificationPreferences, merging onto defaults`, { marketerId: id });
      }
    }

    const preferences = {
      email: email !== undefined ? !!email : (existing.email ?? true),
      push: push !== undefined ? !!push : (existing.push ?? true),
      commissionAlerts:
        commissionAlerts !== undefined ? !!commissionAlerts : (existing.commissionAlerts ?? true),
      marketingUpdates:
        marketingUpdates !== undefined ? !!marketingUpdates : (existing.marketingUpdates ?? false),
    };

    await prisma.admin.update({
      where: { id },
      data: { notificationPreferences: JSON.stringify(preferences) },
    });

    logger.info(`[UPDATE_NOTIFICATIONS] Notification preferences updated`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "Notification preferences updated",
      data: preferences,
    });
  } catch (err) {
    logger.error(`[UPDATE_NOTIFICATIONS] Failed to update preferences`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/transactions
 * Get transaction history for authenticated marketer
 */
exports.getTransactions = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;
    const type = req.query.type || "";
    const search = req.query.search || "";

    logger.debug(`[GET_TRANSACTIONS] Fetching transactions`, { page, limit, marketerId, type, search });

    if (!marketerId) {
      logger.warn(`[GET_TRANSACTIONS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const where = { marketerId };
    if (type) where.type = type;
    if (search) where.description = { contains: search };

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.walletTransaction.count({ where }),
    ]);

    logger.info(`[GET_TRANSACTIONS] Transactions retrieved`, { marketerId, count: transactions.length });

    res.status(200).json({
      success: true,
      data: {
        transactions,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`[GET_TRANSACTIONS] Failed to fetch transactions`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/transactions/stats
 * Get transaction statistics for authenticated marketer
 */
exports.getTransactionStats = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;

    logger.debug(`[TRANSACTION_STATS] Fetching transaction stats`, { marketerId });

    if (!marketerId) {
      logger.warn(`[TRANSACTION_STATS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Split by direction. Every amount is stored positive, so a single SUM over
    // all rows adds withdrawals to earnings and reads as a meaningless total.
    const [creditAgg, debitAgg, payoutAgg, transactionCount] = await Promise.all([
      prisma.walletTransaction.aggregate({
        where: { marketerId, type: "credit" },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { marketerId, type: "debit" },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { marketerId, type: "payout" },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.count({ where: { marketerId } }),
    ]);

    const totalCredits = creditAgg._sum.amount || 0;
    // debit and payout are both money leaving the wallet.
    const totalDebits = (debitAgg._sum.amount || 0) + (payoutAgg._sum.amount || 0);
    // Gross turnover — kept only so existing clients don't break. Prefer
    // netAmount / totalCredits / totalDebits; this figure is not spendable.
    const totalAmount = totalCredits + totalDebits;

    logger.info(`[TRANSACTION_STATS] Transaction stats retrieved`, { marketerId, transactionCount });

    res.status(200).json({
      success: true,
      data: {
        totalCredits,
        totalDebits,
        netAmount: totalCredits - totalDebits,
        totalAmount,
        transactionCount,
        averageTransaction: transactionCount > 0 ? totalAmount / transactionCount : 0,
      },
    });
  } catch (err) {
    logger.error(`[TRANSACTION_STATS] Failed to fetch stats`, { error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/settings/2fa/toggle
 * Enable or disable 2FA
 */
/**
 * @deprecated UNMOUNTED — route removed from res/routes/publicAPI.js.
 *
 * Superseded by setup2FA / verifySetup2FA / disable2FA. It read ?marketerId
 * from the query string with no ownership check, so any caller could flip
 * another marketer's 2FA flag. Do not re-mount; use the three-step flow.
 */

/**
 * ============================================
 * PHASE 3 - ADVANCED FEATURES & ANALYTICS
 * ============================================
 */

/**
 * POST /api/public/settings/2fa/setup
 * Start 2FA setup process (generate QR code)
 */

/**
 * POST /api/public/settings/2fa/verify-setup
 * Verify 2FA setup and enable it
 */

/**
 * POST /api/public/settings/2fa/disable
 * Disable 2FA
 */

/**
 * GET /api/public/commissions/monthly-chart
 * Get monthly commission data for chart
 */
exports.getMonthlyCommissionChart = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;
    const months = parseInt(req.query.months) || 12; // Default to 12 months

    logger.debug(`[COMMISSION_CHART] Fetching monthly commission data`, { marketerId, months });

    if (!marketerId) {
      logger.warn(`[COMMISSION_CHART] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // One grouped query, then fill the buckets in memory. This used to run
    // `months` sequential aggregates (12 round-trips per page load).
    const groups = await prisma.commission.groupBy({
      by: ["year", "month"],
      where: { marketerId },
      _sum: { amount: true },
    });

    const sumByPeriod = new Map(
      groups.map((g) => [`${g.year}-${g.month}`, g._sum.amount || 0])
    );

    // Oldest -> newest so it plots left-to-right on the x-axis as-is.
    const data = [];
    const today = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const month = date.getMonth() + 1;
      const year = date.getFullYear();
      const shortMonth = date.toLocaleString("en-US", { month: "short" });

      data.push({
        // `month` kept as the bare short name for backwards compatibility.
        month: shortMonth,
        // `label` is the unambiguous one — plot this. Without a year, a window
        // longer than 12 months produces duplicate x-axis keys.
        label: `${shortMonth} ${String(year).slice(-2)}`,
        year,
        monthNumber: month,
        commission: sumByPeriod.get(`${year}-${month}`) || 0,
      });
    }

    logger.info(`[COMMISSION_CHART] Monthly commission data retrieved`, { marketerId, dataPoints: data.length });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    logger.error(`[COMMISSION_CHART] Failed to fetch chart data`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/marketer-schools/stats
 * Get statistics about marketer's schools
 */
exports.getMarketerSchoolsStats = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;

    logger.debug(`[MARKETER_SCHOOLS_STATS] Fetching school statistics`, { marketerId });

    if (!marketerId) {
      logger.warn(`[MARKETER_SCHOOLS_STATS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const [totalSchools, activeSchools, aggregates] = await Promise.all([
      prisma.marketerSchoolLead.count({ where: { marketerId } }),
      prisma.marketerSchoolLead.count({ where: { marketerId, status: "active" } }),
      prisma.marketerSchoolLead.aggregate({
        where: { marketerId },
        _sum: { tokensIssued: true, totalRevenue: true },
      }),
    ]);

    logger.info(`[MARKETER_SCHOOLS_STATS] School statistics retrieved`, { marketerId, totalSchools });

    res.status(200).json({
      success: true,
      data: {
        totalSchools,
        activeSchools,
        suspendedSchools: totalSchools - activeSchools,
        totalTokensIssued: aggregates._sum.tokensIssued || 0,
        totalRevenue: aggregates._sum.totalRevenue || 0,
      },
    });
  } catch (err) {
    logger.error(`[MARKETER_SCHOOLS_STATS] Failed to fetch statistics`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/dashboard/summary
 * Get dashboard summary for marketer
 */
exports.getDashboardSummary = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;

    logger.debug(`[DASHBOARD_SUMMARY] Fetching dashboard summary`, { marketerId });

    if (!marketerId) {
      logger.warn(`[DASHBOARD_SUMMARY] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id: marketerId },
      select: {
        walletBalance: true,
        walletPending: true,
        totalEarned: true,
        totalWithdrawn: true,
      },
    });

    if (!marketer) {
      logger.warn(`[DASHBOARD_SUMMARY] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    logger.info(`[DASHBOARD_SUMMARY] Dashboard summary retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: {
        walletBalance: marketer.walletBalance || 0,
        pendingBalance: marketer.walletPending || 0,
        totalEarned: marketer.totalEarned || 0,
        totalWithdrawn: marketer.totalWithdrawn || 0,
      },
    });
  } catch (err) {
    logger.error(`[DASHBOARD_SUMMARY] Failed to fetch summary`, { error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/dashboard/recent-activity
 * Get recent activity for marketer
 */
exports.getRecentActivity = async (req, res, next) => {
  try {
    // Extract marketerId from JWT token, not query params
    const marketerId = req.user?.id || req.marketer?.id;
    const limit = parseInt(req.query.limit) || 10;

    logger.debug(`[RECENT_ACTIVITY] Fetching recent activity`, { marketerId, limit });

    if (!marketerId) {
      logger.warn(`[RECENT_ACTIVITY] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Get recent commissions and notifications
    const [recentCommissions, recentNotifications] = await Promise.all([
      prisma.commission.findMany({
        where: { marketerId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          amount: true,
          status: true,
          createdAt: true,
        },
      }),
      prisma.notification.findMany({
        where: { marketerId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          message: true,
          createdAt: true,
        },
      }),
    ]);

    const activity = [
      ...recentCommissions.map((c) => ({
        type: "commission",
        description: `Commission of ₦${c.amount} ${c.status}`,
        timestamp: c.createdAt,
      })),
      ...recentNotifications.map((n) => ({
        type: "notification",
        description: n.message,
        timestamp: n.createdAt,
      })),
    ].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);

    logger.info(`[RECENT_ACTIVITY] Recent activity retrieved`, { marketerId, activityCount: activity.length });

    res.status(200).json({
      success: true,
      data: activity,
    });
  } catch (err) {
    logger.error(`[RECENT_ACTIVITY] Failed to fetch activity`, { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/public/school-tokens/:id/status
 * Update school token status
 */
exports.updateTokenStatus = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;
    const { id } = req.params;
    const { status } = req.body;
    const tokenId = parseInt(id, 10);

    logger.debug(`[UPDATE_TOKEN_STATUS] Updating token status`, { tokenId, status, marketerId });

    if (!marketerId) {
      logger.warn(`[UPDATE_TOKEN_STATUS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (isNaN(tokenId)) {
      logger.warn(`[UPDATE_TOKEN_STATUS] Invalid token ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid token ID",
        code: "INVALID_ID",
      });
    }

    if (!status) {
      logger.warn(`[UPDATE_TOKEN_STATUS] Status is required`);
      return res.status(400).json({
        success: false,
        message: "Status is required",
        code: "MISSING_FIELD",
      });
    }

    const validStatuses = ["active", "used", "revoked", "expired"];
    if (!validStatuses.includes(status)) {
      logger.warn(`[UPDATE_TOKEN_STATUS] Invalid status`, { status });
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${validStatuses.join(", ")}`,
        code: "INVALID_STATUS",
      });
    }

    const token = await prisma.schoolToken.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      logger.warn(`[UPDATE_TOKEN_STATUS] Token not found`, { tokenId });
      return res.status(404).json({
        success: false,
        message: "Token not found",
        code: "NOT_FOUND",
      });
    }

    // Ownership check — matches revokeSchoolToken. This endpoint can retire a
    // live registration code, so it must not be reachable across marketers.
    if (token.marketerId !== marketerId) {
      logger.warn(`[UPDATE_TOKEN_STATUS] Forbidden - token belongs to another marketer`, { tokenId, marketerId, ownerId: token.marketerId });
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this token",
        code: "FORBIDDEN",
      });
    }

    // Keep the `Token` row in step. SchoolToken's vocabulary is
    // active|used|revoked|expired; `Token` only knows active|inactive, so
    // anything other than "active" retires the registration code.
    const updated = await prisma.$transaction(async (tx) => {
      const schoolToken = await tx.schoolToken.update({
        where: { id: tokenId },
        data: { status },
      });

      await tx.token.updateMany({
        where: { uniqueKey: token.code },
        data: { status: status === "active" ? "active" : "inactive" },
      });

      return schoolToken;
    });

    logger.info(`[UPDATE_TOKEN_STATUS] Token status updated`, { tokenId, newStatus: status });

    res.status(200).json({
      success: true,
      message: "Token status updated",
      data: {
        id: updated.id,
        status: updated.status,
      },
    });
  } catch (err) {
    logger.error(`[UPDATE_TOKEN_STATUS] Failed to update token status`, { tokenId: req.params.id, error: err.message });
    next(err);
  }
};

/**
 * ⚠️ UNSAFE — UNMOUNTED. Do not re-mount without rewriting.
 *
 * Was DELETE /api/public/marketer-schools/:id. Two defects:
 *   1. Wrong table — it suspends a `School` tenant, but the Marketer Portal
 *      sends a `MarketerSchoolLead` id, so it hits an unrelated live school.
 *   2. No ownership check — any marketer could suspend any school by id.
 *
 * Route removed in res/routes/publicAPI.js. Kept here only so the history is
 * legible; rewrite against MarketerSchoolLead with a marketerId guard before
 * mounting anything like it.
 */
exports.deleteMarketerSchool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const schoolId = parseInt(id, 10);

    logger.debug(`[DELETE_SCHOOL] Deleting marketer school`, { schoolId });

    if (isNaN(schoolId)) {
      logger.warn(`[DELETE_SCHOOL] Invalid school ID`, { id });
      return res.status(400).json({
        success: false,
        message: "Invalid school ID",
        code: "INVALID_ID",
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      logger.warn(`[DELETE_SCHOOL] School not found`, { schoolId });
      return res.status(404).json({
        success: false,
        message: "School not found",
        code: "NOT_FOUND",
      });
    }

    // TODO: Implement soft delete or cascade delete
    // For now, just update status
    await prisma.school.update({
      where: { id: schoolId },
      data: { isSuspended: true },
    });

    logger.info(`[DELETE_SCHOOL] School marked as suspended`, { schoolId });

    res.status(200).json({
      success: true,
      message: "School deleted successfully",
      data: {
        id: schoolId,
        status: "deleted",
      },
    });
  } catch (err) {
    logger.error(`[DELETE_SCHOOL] Failed to delete school`, { schoolId: req.params.id, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/marketer/:marketerId/earnings
 * Get marketer earnings overview
 */
exports.getMarketerEarnings = async (req, res, next) => {
  try {
    const { marketerId } = req.params;
    const id = parseInt(marketerId, 10);

    logger.debug(`[GET_EARNINGS] Fetching earnings`, { marketerId: id });

    if (isNaN(id)) {
      logger.warn(`[GET_EARNINGS] Invalid marketer ID`, { marketerId });
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_ID",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
      select: {
        id: true,
        walletBalance: true,
        walletPending: true,
        totalEarned: true,
        totalWithdrawn: true,
        commissionRate: true,
        lastPayoutDate: true,
      },
    });

    if (!marketer) {
      logger.warn(`[GET_EARNINGS] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // Calculate pending payout
    const pendingAmount = (marketer.walletBalance || 0) + (marketer.walletPending || 0);

    logger.info(`[GET_EARNINGS] Earnings retrieved`, { marketerId: id });

    res.status(200).json({
      success: true,
      data: {
        marketerId: marketer.id,
        availableBalance: marketer.walletBalance || 0,
        pendingBalance: marketer.walletPending || 0,
        totalPendingPayout: pendingAmount,
        totalEarned: marketer.totalEarned || 0,
        totalWithdrawn: marketer.totalWithdrawn || 0,
        commissionRate: marketer.commissionRate || 0,
        lastPayoutDate: marketer.lastPayoutDate,
      },
    });
  } catch (err) {
    logger.error(`[GET_EARNINGS] Failed to fetch earnings`, { marketerId: req.params.marketerId, error: err.message });
    next(err);
  }
};

/**
 * ============================================
 * MARKETER KYC VERIFICATION
 * ============================================
 */

// KYC documents deliberately live OUTSIDE res/uploads, which app.ts serves
// statically at /api/uploads. Anything under that folder is readable by anyone
// who can guess the filename — unacceptable for government ID documents.
const KYC_DIR = path.join(__dirname, "..", "..", "uploads-private", "kyc");

const KYC_DOCUMENT_TYPES = ["nin", "passport", "drivers", "voters"];

const KYC_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

/**
 * POST /api/public/users/verification-document
 * Marketer uploads a KYC document. Bearer token required — a service key alone
 * carries no user identity and must not be able to attach a document to an
 * arbitrary account.
 */
exports.uploadVerificationDocument = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    if (!marketerId) {
      logger.warn(`[KYC_UPLOAD] No authenticated marketer on request`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const { documentType } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "A document file is required",
        code: "MISSING_DOCUMENT",
      });
    }

    // Accepts both vocabularies: the Marketer Portal's form still posts
    // nin/drivers/voters, the Super Admin Portal speaks id_card/passport/
    // utility_bill/cac/other. Storage always uses the latter.
    const normalisedType = normaliseDocumentType(documentType);

    if (!normalisedType) {
      return res.status(400).json({
        success: false,
        message: `documentType must be one of: ${[...MARKETER_DOCUMENT_TYPES, ...KYC_DOCUMENT_TYPES].join(", ")}`,
        code: "INVALID_DOCUMENT_TYPE",
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: { id: true, verificationDocumentPath: true },
    });

    if (!marketer) {
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    // 24 random bytes — the filename must not be guessable or enumerable, since
    // it is the only thing standing between a leaked path and someone's ID.
    const ext = KYC_EXTENSIONS[req.file.mimetype] || ".bin";
    const filename = `kyc_${crypto.randomBytes(24).toString("hex")}${ext}`;

    await fsp.mkdir(KYC_DIR, { recursive: true });
    await fsp.writeFile(path.join(KYC_DIR, filename), req.file.buffer);

    // Re-uploading replaces the previous document OF THE SAME TYPE. Marketers
    // may now hold several documents at once (an ID card and a utility bill,
    // say), so a new upload must not wipe an unrelated one — but re-submitting
    // a rejected ID card should still supersede it rather than pile up.
    const superseded = await prisma.marketerDocument.findFirst({
      where: { marketerId, type: normalisedType },
      orderBy: { uploadedAt: "desc" },
    });

    const [document] = await prisma.$transaction([
      prisma.marketerDocument.create({
        data: {
          marketerId,
          type: normalisedType,
          path: filename,
          status: "pending",
        },
      }),
      ...(superseded ? [prisma.marketerDocument.delete({ where: { id: superseded.id } })] : []),
      // The legacy columns still drive the Marketer Portal's profile screen and
      // the payout gate in updateMarketerWallet, so keep mirroring the latest
      // upload onto them.
      prisma.admin.update({
        where: { id: marketerId },
        data: {
          verificationDocumentPath: filename,
          verificationDocumentType: documentType,
          verificationStatus: "pending",
          verificationSubmittedAt: new Date(),
          verificationReviewedAt: null,
          verificationRejectionReason: null,
        },
      }),
    ], TX_OPTIONS);

    // Unlink only after the transaction committed. Deleting the file first
    // would leave a committed row pointing at nothing if the write rolled back.
    if (superseded) {
      await fsp.unlink(path.join(KYC_DIR, path.basename(superseded.path))).catch(() => {});
    }

    logger.info(`[KYC_UPLOAD] Document stored`, { marketerId, documentType: normalisedType, documentId: document.id });

    return res.status(201).json({
      success: true,
      message: "Verification document uploaded",
      data: {
        verificationStatus: "pending",
        document: serialiseMarketerDocument(document),
      },
    });
  } catch (err) {
    logger.error(`[KYC_UPLOAD] Failed`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/marketers/:id/verification-document
 * Streams a marketer's KYC document. Super Admin only — this is the ONLY way
 * the file is reachable; it is not served statically.
 */
exports.getVerificationDocument = async (req, res, next) => {
  try {
    const marketerId = parseInt(req.params.id, 10);

    if (isNaN(marketerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: { verificationDocumentPath: true, verificationDocumentType: true },
    });

    if (!marketer?.verificationDocumentPath) {
      return res.status(404).json({
        success: false,
        message: "No verification document on file",
        code: "DOCUMENT_NOT_FOUND",
      });
    }

    // basename() guards against a stored value ever containing traversal
    // segments — the path must resolve inside KYC_DIR and nowhere else.
    const filePath = path.join(KYC_DIR, path.basename(marketer.verificationDocumentPath));

    if (!fs.existsSync(filePath)) {
      logger.error(`[KYC_FETCH] Record exists but file is missing`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Document file is missing from storage",
        code: "DOCUMENT_FILE_MISSING",
      });
    }

    logger.info(`[KYC_FETCH] Document served`, { marketerId, by: req.user?.id });
    return res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/public/marketers/:id/verification
 * Super Admin approves or rejects a submitted document. Without this the
 * status could never leave 'pending' and the gate below would block everyone.
 */
exports.reviewVerification = async (req, res, next) => {
  try {
    const marketerId = parseInt(req.params.id, 10);
    const { status, rejectionReason } = req.body;

    if (isNaN(marketerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid marketer ID",
        code: "INVALID_REQUEST",
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be 'approved' or 'rejected'",
        code: "INVALID_STATUS",
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: { id: true },
    });

    if (!marketer) {
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    const reviewedAt = new Date();
    const reason = status === "rejected" ? (rejectionReason || null) : null;
    const actorId = req.user?.id ?? null;

    // Marketer-level review. Also stamps the marketer's most recent document so
    // the per-document queue in §2.4 doesn't keep showing an item the operator
    // has already decided on from the older screen.
    const latest = await prisma.marketerDocument.findFirst({
      where: { marketerId },
      orderBy: { uploadedAt: "desc" },
      select: { id: true },
    });

    const [updated] = await prisma.$transaction([
      prisma.admin.update({
        where: { id: marketerId },
        data: {
          verificationStatus: status,
          verificationReviewedAt: reviewedAt,
          verificationRejectionReason: reason,
        },
        select: {
          id: true,
          verificationStatus: true,
          verificationReviewedAt: true,
          verificationRejectionReason: true,
        },
      }),
      ...(latest
        ? [
            prisma.marketerDocument.update({
              where: { id: latest.id },
              data: { status, rejectionReason: reason, reviewedAt, reviewedBy: actorId },
            }),
          ]
        : []),
    ], TX_OPTIONS);

    logger.info(`[KYC_REVIEW] Verification ${status}`, { marketerId, by: actorId, documentId: latest?.id ?? null });

    return res.status(200).json({
      success: true,
      message: `Verification ${status}`,
      data: updated,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/public/marketers/documents/pending?page=&limit=
 * The verification queue: every pending document across all marketers, newest
 * first, each carrying enough marketer context to render a review screen
 * without a second call per row.
 */
exports.getPendingMarketerDocuments = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || 1, 10) || 1, 1);
    const limit = parseInt(req.query.limit || 20, 10) || 20;
    const skip = (page - 1) * limit;

    const where = { status: "pending" };

    // `include` on the relation, not a second query per document — the join is
    // what keeps this one round trip regardless of page size.
    const [documents, total] = await Promise.all([
      prisma.marketerDocument.findMany({
        where,
        include: {
          marketer: { select: { id: true, name: true, email: true, tier: true } },
        },
        orderBy: { uploadedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.marketerDocument.count({ where }),
    ]);

    logger.info(`[KYC_QUEUE] Retrieved ${documents.length} pending documents`, { page, limit, total });

    return res.status(200).json({
      success: true,
      message: "Pending verification documents retrieved",
      data: {
        data: documents.map((doc) => {
          // Drop status/rejectionReason/reviewedAt from the queue shape — every
          // row here is pending by definition, so they'd be constant noise.
          const { status, rejectionReason, reviewedAt, reviewedBy, ...rest } =
            serialiseMarketerDocument(doc);

          return { ...rest, status, marketer: doc.marketer };
        }),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    logger.error(`[KYC_QUEUE] Failed to fetch pending documents`, { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/public/marketers/:id/documents/:documentId
 * Super Admin approves or rejects one document.
 */
exports.reviewMarketerDocument = async (req, res, next) => {
  try {
    const marketerId = parseInt(req.params.id, 10);
    const documentId = parseInt(req.params.documentId, 10);
    const { status, rejectionReason } = req.body;
    const actorId = req.user?.id ?? null;

    if (isNaN(marketerId) || isNaN(documentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid marketer or document ID",
        code: "INVALID_REQUEST",
        data: null,
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(422).json({
        success: false,
        message: "status must be 'approved' or 'rejected'",
        code: "INVALID_STATUS",
        data: null,
      });
    }

    // A rejection the marketer can't act on is a dead end — they'd see
    // "rejected" with no idea what to fix. trim() so whitespace doesn't pass.
    if (status === "rejected" && !String(rejectionReason || "").trim()) {
      return res.status(422).json({
        success: false,
        message: "rejectionReason is required when status is 'rejected'",
        code: "MISSING_REJECTION_REASON",
        data: null,
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: { id: true },
    });

    if (!marketer) {
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
        data: null,
      });
    }

    // Scoped by marketerId as well as id: without it, a super admin could pass
    // any marketer in the path and still review a document belonging to
    // someone else, and the audit trail would name the wrong person.
    const document = await prisma.marketerDocument.findFirst({
      where: { id: documentId, marketerId },
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found for this marketer",
        code: "DOCUMENT_NOT_FOUND",
        data: null,
      });
    }

    if (document.status === status) {
      return res.status(409).json({
        success: false,
        message: `Document is already ${status}`,
        code: "ALREADY_REVIEWED",
        data: serialiseMarketerDocument(document),
      });
    }

    const reviewedAt = new Date();
    const reason = status === "rejected" ? String(rejectionReason).trim() : null;

    // Resolved before the transaction opens — see isLatestMarketerDocument.
    const isLatest = await isLatestMarketerDocument(marketerId, documentId);

    // Batched array form, not the interactive callback form: Prisma sends the
    // whole batch in one round trip, so the write can't time out midway on a
    // remote database the way a callback with sequential awaits can.
    const [updated] = await prisma.$transaction(
      [
        prisma.marketerDocument.update({
          where: { id: documentId },
          data: { status, rejectionReason: reason, reviewedAt, reviewedBy: actorId },
        }),
        ...(isLatest
          ? [
              prisma.admin.update({
                where: { id: marketerId },
                data: {
                  verificationStatus: status,
                  verificationReviewedAt: reviewedAt,
                  verificationRejectionReason: reason,
                },
              }),
            ]
          : []),
        prisma.securityEvent.create({
          data: {
            adminId: marketerId,
            event: `marketer_document_${status}`,
            detail: `document ${documentId} by admin ${actorId ?? "service-key"}`.slice(0, 255),
            ipAddress: req.ip || null,
            userAgent: req.headers["user-agent"] || null,
          },
        }),
      ],
      TX_OPTIONS
    );

    logger.info(`[KYC_DOC_REVIEW] Document ${status}`, { marketerId, documentId, by: actorId });

    return res.status(200).json({
      success: true,
      message: `Document ${status}`,
      data: serialiseMarketerDocument(updated),
    });
  } catch (err) {
    logger.error(`[KYC_DOC_REVIEW] Failed`, { error: err.message, documentId: req.params.documentId });
    next(err);
  }
};

/**
 * GET /api/public/marketers/:id/documents/:documentId/file
 * Streams one document. This is the target of the `url` field on every
 * document object, and the ONLY way the bytes are reachable — the files are
 * not under the statically-served res/uploads folder.
 */
exports.getMarketerDocumentFile = async (req, res, next) => {
  try {
    const marketerId = parseInt(req.params.id, 10);
    const documentId = parseInt(req.params.documentId, 10);

    if (isNaN(marketerId) || isNaN(documentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid marketer or document ID",
        code: "INVALID_REQUEST",
        data: null,
      });
    }

    const document = await prisma.marketerDocument.findFirst({
      where: { id: documentId, marketerId },
      select: { path: true },
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found for this marketer",
        code: "DOCUMENT_NOT_FOUND",
        data: null,
      });
    }

    // basename() guards against a stored value ever containing traversal
    // segments — the path must resolve inside KYC_DIR and nowhere else.
    const filePath = path.join(KYC_DIR, path.basename(document.path));

    if (!fs.existsSync(filePath)) {
      logger.error(`[KYC_DOC_FETCH] Record exists but file is missing`, { marketerId, documentId });
      return res.status(404).json({
        success: false,
        message: "Document file is missing from storage",
        code: "DOCUMENT_FILE_MISSING",
        data: null,
      });
    }

    logger.info(`[KYC_DOC_FETCH] Document served`, { marketerId, documentId, by: req.user?.id });
    return res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
};
