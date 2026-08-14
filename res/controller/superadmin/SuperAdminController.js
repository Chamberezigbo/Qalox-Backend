const prisma = require("../../util/prisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const logger = require("../../config/logger");
const crypto = require("crypto");
const { logLoginEvent } = require("../../util/logLoginEvent");
const { parsePlanFeatures } = require("../../util/planFeatures");

// Helper: Generate TKN-XXXXXX registration token
// (matches the format already used by res/controller/system-admin/generateToken.js
// since both write to the same `Token` table)
const generateRegistrationToken = () => {
  const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `TKN-${randomPart}`;
};

// Helper: Calculate token expiration date (30 days from now)
const calculateTokenExpiration = () => {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date;
};

// Helper: Create JWT token for the platform super admin (Super Admin Portal)
const createJWT = (adminId) => {
  return jwt.sign(
    { id: adminId, role: "platform_super_admin" },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );
};

/**
 * POST /api/super-admin/login
 * Authenticate super admin user
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    logger.debug("[SUPER_ADMIN_LOGIN] Attempting login", { email });

    // Validate input
    if (!email || !password) {
      logger.warn("[SUPER_ADMIN_LOGIN] Missing email or password", { email });
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
        code: "MISSING_CREDENTIALS",
      });
    }

    // Find super admin user
    const admin = await prisma.admin.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        role: true,
        hasLoggedIn: true,
        createdAt: true,
      },
    });

    // Check if admin exists and is platform_super_admin
    if (!admin || admin.role !== "platform_super_admin") {
      logger.warn("[SUPER_ADMIN_LOGIN] Invalid credentials or not platform_super_admin", { email });
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    // Compare password
    const passwordMatch = await bcrypt.compare(password, admin.password);
    if (!passwordMatch) {
      logger.warn("[SUPER_ADMIN_LOGIN] Password mismatch", { email });
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    // Update hasLoggedIn if first time
    if (!admin.hasLoggedIn) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { hasLoggedIn: true },
      });
    }

    // Create JWT token
    const token = createJWT(admin.id);

    await logLoginEvent({ actorType: "admin", actorId: admin.id, req });

    logger.info("[SUPER_ADMIN_LOGIN] Login successful", { adminId: admin.id, email });

    res.status(200).json({
      success: true,
      message: "Authentication successful",
      data: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        token,
        firstLogin: !admin.hasLoggedIn,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_LOGIN] Login failed", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/super-admin/profile
 * Get authenticated super admin's profile
 */
exports.getProfile = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;

    logger.debug("[SUPER_ADMIN_PROFILE] Fetching profile", { adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_PROFILE] Unauthorized - no admin ID");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        hasLoggedIn: true,
      },
    });

    if (!admin) {
      logger.warn("[SUPER_ADMIN_PROFILE] Admin not found", { adminId });
      return res.status(404).json({
        success: false,
        message: "Admin not found",
        code: "NOT_FOUND",
      });
    }

    logger.info("[SUPER_ADMIN_PROFILE] Profile retrieved", { adminId });

    res.status(200).json({
      success: true,
      data: admin,
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_PROFILE] Failed to fetch profile", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/super-admin/tokens/generate
 * Generate new registration token (TKN-XXXXXX format)
 */
exports.generateToken = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { email, schoolName } = req.body;

    logger.debug("[SUPER_ADMIN_GENERATE_TOKEN] Generating registration token", {
      email,
      schoolName,
    });

    // Validate input
    if (!email) {
      logger.warn("[SUPER_ADMIN_GENERATE_TOKEN] Missing email");
      return res.status(400).json({
        success: false,
        message: "Email is required",
        code: "MISSING_EMAIL",
      });
    }

    // Check if email already has a token (shared `Token` table used by the
    // real school-onboarding flow — see res/controller/system-admin/generateToken.js)
    const existingToken = await prisma.token.findUnique({
      where: { email },
    });

    if (existingToken && existingToken.status === "active") {
      logger.warn("[SUPER_ADMIN_GENERATE_TOKEN] Active token already exists", { email });
      return res.status(409).json({
        success: false,
        message: "Active token already exists for this email",
        code: "TOKEN_EXISTS",
      });
    }

    // Generate new token
    const uniqueKey = generateRegistrationToken();
    const expiresAt = calculateTokenExpiration();

    const newToken = await prisma.token.create({
      data: {
        email,
        uniqueKey,
        status: "active",
        schoolName: schoolName || "",
        expiresAt,
      },
    });

    logger.info("[SUPER_ADMIN_GENERATE_TOKEN] Token generated successfully", {
      email,
      uniqueKey,
      expiresAt,
    });

    res.status(201).json({
      success: true,
      message: "Registration token generated successfully",
      data: {
        id: newToken.id,
        email: newToken.email,
        token: newToken.uniqueKey,
        generatedFor: newToken.email,
        status: newToken.status,
        schoolName: newToken.schoolName,
        expiresAt: newToken.expiresAt,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_GENERATE_TOKEN] Failed to generate token", {
      error: err.message,
    });
    next(err);
  }
};

// Helper: translate DB status ('active'/'inactive'/'used') + expiry into the
// 'unused' | 'used' | 'expired' vocabulary the Super Admin Portal frontend expects
const toFrontendTokenStatus = (dbToken) => {
  if (dbToken.status === "inactive" || dbToken.status === "used") return "used";
  if (dbToken.expiresAt && new Date() > new Date(dbToken.expiresAt)) return "expired";
  return "unused";
};

/**
 * GET /api/tokens
 * List all registration tokens (paginated)
 */
exports.getTokens = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const statusFilter = req.query.status; // Frontend vocabulary: unused, used, expired

    logger.debug("[SUPER_ADMIN_GET_TOKENS] Fetching tokens", { page, limit, statusFilter });

    // Fetch all, filter/paginate on the mapped frontend status
    // (DB status vocabulary doesn't line up 1:1, so this can't be pushed into the WHERE clause)
    const allTokens = await prisma.token.findMany({
      select: {
        id: true,
        email: true,
        uniqueKey: true,
        status: true,
        schoolName: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const mapped = allTokens.map((t) => ({
      id: t.id,
      token: t.uniqueKey,
      generatedFor: t.email,
      generatedAt: t.createdAt,
      expiresAt: t.expiresAt,
      status: toFrontendTokenStatus(t),
    }));

    const filtered = statusFilter ? mapped.filter((t) => t.status === statusFilter) : mapped;
    const total = filtered.length;
    const tokens = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    logger.info("[SUPER_ADMIN_GET_TOKENS] Tokens retrieved", { count: tokens.length, total });

    res.status(200).json({
      success: true,
      data: {
        data: tokens,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_GET_TOKENS] Failed to fetch tokens", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/super-admin/register
 * Create new admin using registration token
 */
exports.register = async (req, res, next) => {
  try {
    const { token, email, password, name } = req.body;

    logger.debug("[SUPER_ADMIN_REGISTER] Registering new admin", { email, token });

    // Find and validate token (shared `Token` table used by the real
    // school-onboarding flow — see res/controller/system-admin/generateToken.js)
    const registrationToken = await prisma.token.findUnique({
      where: { uniqueKey: token },
    });

    if (!registrationToken) {
      logger.warn("[SUPER_ADMIN_REGISTER] Invalid token", { token });
      return res.status(404).json({
        success: false,
        message: "Registration token not found",
        code: "INVALID_TOKEN",
      });
    }

    // Check if token is active
    if (registrationToken.status !== "active") {
      logger.warn("[SUPER_ADMIN_REGISTER] Token not active", { token, status: registrationToken.status });
      return res.status(400).json({
        success: false,
        message: "Registration token is not active or has already been used",
        code: "TOKEN_INACTIVE",
      });
    }

    // Check if token is expired
    if (registrationToken.expiresAt && new Date() > registrationToken.expiresAt) {
      logger.warn("[SUPER_ADMIN_REGISTER] Token expired", { token });
      await prisma.token.update({
        where: { id: registrationToken.id },
        data: { status: "inactive" },
      });
      return res.status(400).json({
        success: false,
        message: "Registration token has expired",
        code: "TOKEN_EXPIRED",
      });
    }

    // Check if email matches token email
    if (email !== registrationToken.email) {
      logger.warn("[SUPER_ADMIN_REGISTER] Email mismatch", { token, providedEmail: email, tokenEmail: registrationToken.email });
      return res.status(400).json({
        success: false,
        message: "Email does not match registration token",
        code: "EMAIL_MISMATCH",
      });
    }

    // Check if admin already exists
    const existingAdmin = await prisma.admin.findUnique({
      where: { email },
    });

    if (existingAdmin) {
      logger.warn("[SUPER_ADMIN_REGISTER] Email already in use", { email });
      return res.status(409).json({
        success: false,
        message: "Email already registered",
        code: "EMAIL_EXISTS",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new admin in transaction
    const newAdmin = await prisma.$transaction(async (tx) => {
      // Create admin
      const admin = await tx.admin.create({
        data: {
          email,
          name,
          password: hashedPassword,
          role: "platform_super_admin",
          hasLoggedIn: false,
        },
      });

      // Mark token as used
      await tx.token.update({
        where: { id: registrationToken.id },
        data: {
          status: "used",
          usedAt: new Date(),
          usedBy: admin.id,
        },
      });

      return admin;
    });

    logger.info("[SUPER_ADMIN_REGISTER] New admin registered successfully", {
      adminId: newAdmin.id,
      email: newAdmin.email,
    });

    res.status(201).json({
      success: true,
      message: "Registration successful. Please login with your credentials.",
      data: {
        id: newAdmin.id,
        email: newAdmin.email,
        name: newAdmin.name,
        role: newAdmin.role,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_REGISTER] Registration failed", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/super-admin/profile
 * Update authenticated admin's profile
 */
exports.updateProfile = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { name, email } = req.body;

    logger.debug("[SUPER_ADMIN_UPDATE_PROFILE] Updating profile", { adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_UPDATE_PROFILE] Unauthorized");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Check if email already exists (if changing email)
    if (email) {
      const existingAdmin = await prisma.admin.findUnique({
        where: { email },
      });

      if (existingAdmin && existingAdmin.id !== adminId) {
        logger.warn("[SUPER_ADMIN_UPDATE_PROFILE] Email already in use", { email });
        return res.status(409).json({
          success: false,
          message: "Email already in use",
          code: "EMAIL_EXISTS",
        });
      }
    }

    // Update profile
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;

    const updatedAdmin = await prisma.admin.update({
      where: { id: adminId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    logger.info("[SUPER_ADMIN_UPDATE_PROFILE] Profile updated successfully", { adminId });

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedAdmin,
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_UPDATE_PROFILE] Failed to update profile", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/super-admin/change-password
 * Change admin password
 */
exports.changePassword = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { currentPassword, newPassword } = req.body;

    logger.debug("[SUPER_ADMIN_CHANGE_PASSWORD] Changing password", { adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_CHANGE_PASSWORD] Unauthorized");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Get admin with password
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: { id: true, password: true, email: true },
    });

    if (!admin) {
      logger.warn("[SUPER_ADMIN_CHANGE_PASSWORD] Admin not found", { adminId });
      return res.status(404).json({
        success: false,
        message: "Admin not found",
        code: "NOT_FOUND",
      });
    }

    // Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, admin.password);
    if (!passwordMatch) {
      logger.warn("[SUPER_ADMIN_CHANGE_PASSWORD] Current password incorrect", { adminId });
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
        code: "INVALID_PASSWORD",
      });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await prisma.admin.update({
      where: { id: adminId },
      data: { password: hashedNewPassword },
    });

    logger.info("[SUPER_ADMIN_CHANGE_PASSWORD] Password changed successfully", { adminId });

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_CHANGE_PASSWORD] Failed to change password", { error: err.message });
    next(err);
  }
};

/**
 * DELETE /api/super-admin/tokens/:id
 * Revoke/deactivate registration token
 */
exports.revokeToken = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { id } = req.params;
    const tokenId = parseInt(id, 10);

    logger.debug("[SUPER_ADMIN_REVOKE_TOKEN] Revoking token", { tokenId, adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_REVOKE_TOKEN] Unauthorized");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    if (isNaN(tokenId)) {
      logger.warn("[SUPER_ADMIN_REVOKE_TOKEN] Invalid token ID", { id });
      return res.status(400).json({
        success: false,
        message: "Invalid token ID",
        code: "INVALID_TOKEN_ID",
      });
    }

    // Find token
    const token = await prisma.token.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      logger.warn("[SUPER_ADMIN_REVOKE_TOKEN] Token not found", { tokenId });
      return res.status(404).json({
        success: false,
        message: "Token not found",
        code: "NOT_FOUND",
      });
    }

    // Update token status to inactive
    const updatedToken = await prisma.token.update({
      where: { id: tokenId },
      data: { status: "inactive" },
      select: {
        id: true,
        email: true,
        uniqueKey: true,
        status: true,
      },
    });

    logger.info("[SUPER_ADMIN_REVOKE_TOKEN] Token revoked successfully", { tokenId });

    res.status(200).json({
      success: true,
      message: "Token revoked successfully",
      data: updatedToken,
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_REVOKE_TOKEN] Failed to revoke token", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/super-admin/stats
 * Dashboard statistics
 */
exports.getDashboardStats = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;

    logger.debug("[SUPER_ADMIN_STATS] Fetching dashboard statistics", { adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_STATS] Unauthorized");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Get statistics (flat shape matches the Super Admin Portal's DashboardStats type)
    const [totalSchools, activeAdmins, tokensTotal, tokensUsed] = await Promise.all([
      prisma.school.count(),
      prisma.admin.count({ where: { role: "school_admin", isSuspended: false } }),
      prisma.token.count(),
      prisma.token.count({ where: { status: { in: ["used", "inactive"] } } }),
    ]);

    logger.info("[SUPER_ADMIN_STATS] Statistics retrieved", {
      totalSchools,
      activeAdmins,
      tokensTotal,
      tokensUsed,
    });

    res.status(200).json({
      success: true,
      data: {
        totalSchools,
        activeAdmins,
        tokensGenerated: tokensTotal,
        tokensUsed,
        tokensTotal,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_STATS] Failed to fetch statistics", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/super-admin/settings
 * Retrieve platform-wide settings
 */
exports.getSettings = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;

    logger.debug("[SUPER_ADMIN_GET_SETTINGS] Fetching platform settings", { adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_GET_SETTINGS] Unauthorized");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Get or create default settings
    let settings = await prisma.platformSettings.findFirst();

    if (!settings) {
      logger.info("[SUPER_ADMIN_GET_SETTINGS] Creating default settings");
      settings = await prisma.platformSettings.create({
        data: {},
      });
    }

    logger.info("[SUPER_ADMIN_GET_SETTINGS] Settings retrieved", { settingsId: settings.id });

    res.status(200).json({
      success: true,
      data: {
        id: settings.id,
        commissionRate: settings.commissionRate,
        firstPaymentCommissionRate: settings.firstPaymentCommissionRate,
        renewalCommissionRate: settings.renewalCommissionRate,
        platformName: settings.platformName,
        supportEmail: settings.supportEmail,
        maxTokensPerSchool: settings.maxTokensPerSchool,
        tokenExpirationDays: settings.tokenExpirationDays,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_GET_SETTINGS] Failed to fetch settings", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/super-admin/settings
 * Update platform-wide settings
 */
exports.updateSettings = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const { commissionRate, firstPaymentCommissionRate, renewalCommissionRate, platformName, supportEmail, maxTokensPerSchool, tokenExpirationDays } = req.body;

    logger.debug("[SUPER_ADMIN_UPDATE_SETTINGS] Updating platform settings", { adminId });

    if (!adminId) {
      logger.warn("[SUPER_ADMIN_UPDATE_SETTINGS] Unauthorized");
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Get or create default settings
    let settings = await prisma.platformSettings.findFirst();

    if (!settings) {
      logger.info("[SUPER_ADMIN_UPDATE_SETTINGS] Creating default settings");
      settings = await prisma.platformSettings.create({
        data: {},
      });
    }

    // Build update data
    const updateData = {};
    if (commissionRate !== undefined) updateData.commissionRate = commissionRate;
    if (firstPaymentCommissionRate !== undefined) updateData.firstPaymentCommissionRate = firstPaymentCommissionRate;
    if (renewalCommissionRate !== undefined) updateData.renewalCommissionRate = renewalCommissionRate;
    if (platformName !== undefined) updateData.platformName = platformName;
    if (supportEmail !== undefined) updateData.supportEmail = supportEmail;
    if (maxTokensPerSchool !== undefined) updateData.maxTokensPerSchool = maxTokensPerSchool;
    if (tokenExpirationDays !== undefined) updateData.tokenExpirationDays = tokenExpirationDays;

    // Update settings
    const updatedSettings = await prisma.platformSettings.update({
      where: { id: settings.id },
      data: updateData,
    });

    logger.info("[SUPER_ADMIN_UPDATE_SETTINGS] Settings updated successfully", { settingsId: settings.id });

    res.status(200).json({
      success: true,
      message: "Platform settings updated successfully",
      data: {
        id: updatedSettings.id,
        commissionRate: updatedSettings.commissionRate,
        firstPaymentCommissionRate: updatedSettings.firstPaymentCommissionRate,
        renewalCommissionRate: updatedSettings.renewalCommissionRate,
        platformName: updatedSettings.platformName,
        supportEmail: updatedSettings.supportEmail,
        maxTokensPerSchool: updatedSettings.maxTokensPerSchool,
        tokenExpirationDays: updatedSettings.tokenExpirationDays,
        updatedAt: updatedSettings.updatedAt,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_UPDATE_SETTINGS] Failed to update settings", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/super-admin/plans
 * List all active billing plans (public - no auth required)
 */
exports.getBillingPlans = async (req, res, next) => {
  try {
    logger.debug("[SUPER_ADMIN_GET_PLANS] Fetching billing plans");

    // Get all active plans
    const plans = await prisma.billingPlan.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        monthlyPrice: true,
        annualPrice: true,
        features: true,
        highlighted: true,
        createdAt: true,
      },
      orderBy: [
        { highlighted: "desc" }, // Show highlighted plans first
        { monthlyPrice: "asc" },  // Then order by price
      ],
    });

    // Parse features JSON for each plan. parsePlanFeatures is used instead of a
    // bare JSON.parse so a single malformed row can't 500 the whole endpoint —
    // this feeds the Marketer Portal's read-only pricing page.
    const parsedPlans = plans.map((plan) => ({
      ...plan,
      features: parsePlanFeatures(plan.features),
    }));

    logger.info("[SUPER_ADMIN_GET_PLANS] Plans retrieved", { count: parsedPlans.length });

    res.status(200).json({
      success: true,
      data: {
        plans: parsedPlans,
        total: parsedPlans.length,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_GET_PLANS] Failed to fetch plans", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admins
 * List school admins (paginated, filterable by search/status)
 */
exports.getSchoolAdmins = async (req, res, next) => {
  try {
    const adminId = req.admin?.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const search = req.query.search || "";
    const status = req.query.status; // 'active' | 'suspended'

    logger.debug("[SUPER_ADMIN_GET_ADMINS] Fetching school admins", { page, limit, search, status, adminId });

    // No `mode: "insensitive"` — MySQL's Prisma client doesn't generate
    // QueryMode, so passing it threw a validation error (500) on any ?search=.
    // MySQL's default collation is already case-insensitive.
    const where = {
      role: "school_admin",
      ...(search && {
        OR: [
          { name: { contains: search } },
          { email: { contains: search } },
        ],
      }),
      ...(status === "active" && { isSuspended: false }),
      ...(status === "suspended" && { isSuspended: true }),
    };

    const [admins, total] = await Promise.all([
      prisma.admin.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isSuspended: true,
          createdAt: true,
          school: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.admin.count({ where }),
    ]);

    const formattedAdmins = admins.map((admin) => ({
      id: admin.id,
      name: admin.name,
      email: admin.email,
      phone: admin.phone,
      school: admin.school?.name || null,
      schoolId: admin.school?.id || null,
      role: admin.role,
      dateCreated: admin.createdAt,
      status: admin.isSuspended ? "suspended" : "active",
    }));

    logger.info("[SUPER_ADMIN_GET_ADMINS] Retrieved school admins", { count: formattedAdmins.length, total });

    res.status(200).json({
      success: true,
      data: {
        data: formattedAdmins,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_GET_ADMINS] Failed to fetch school admins", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/admins/:id/suspend
 * Suspend or reactivate a school admin
 */
exports.suspendSchoolAdmin = async (req, res, next) => {
  try {
    const { id } = req.params;
    const adminId = parseInt(id, 10);

    logger.debug("[SUPER_ADMIN_SUSPEND_ADMIN] Toggling school admin suspension", { adminId });

    if (isNaN(adminId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid admin ID",
        code: "INVALID_REQUEST",
      });
    }

    const admin = await prisma.admin.findUnique({ where: { id: adminId } });

    if (!admin || admin.role !== "school_admin") {
      logger.warn("[SUPER_ADMIN_SUSPEND_ADMIN] School admin not found", { adminId });
      return res.status(404).json({
        success: false,
        message: "School admin not found",
        code: "NOT_FOUND",
      });
    }

    const nextSuspended = !admin.isSuspended;

    const updated = await prisma.admin.update({
      where: { id: adminId },
      data: {
        isSuspended: nextSuspended,
        suspendedAt: nextSuspended ? new Date() : null,
      },
      select: { id: true, name: true, email: true, isSuspended: true },
    });

    logger.info("[SUPER_ADMIN_SUSPEND_ADMIN] School admin suspension toggled", { adminId, suspended: nextSuspended });

    res.status(200).json({
      success: true,
      message: nextSuspended ? "Admin suspended successfully" : "Admin reactivated successfully",
      data: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        status: updated.isSuspended ? "suspended" : "active",
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_SUSPEND_ADMIN] Failed to toggle suspension", { error: err.message });
    next(err);
  }
};

/**
 * POST /api/admins/:id/reset
 * Reset a school admin's password (generates a new temporary password)
 *
 * NOTE: No email/SMS delivery is configured yet — the temporary password
 * is returned directly in the response so it can be relayed manually.
 */
exports.resetSchoolAdminPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const adminId = parseInt(id, 10);

    logger.debug("[SUPER_ADMIN_RESET_PASSWORD] Resetting school admin password", { adminId });

    if (isNaN(adminId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid admin ID",
        code: "INVALID_REQUEST",
      });
    }

    const admin = await prisma.admin.findUnique({ where: { id: adminId } });

    if (!admin || admin.role !== "school_admin") {
      logger.warn("[SUPER_ADMIN_RESET_PASSWORD] School admin not found", { adminId });
      return res.status(404).json({
        success: false,
        message: "School admin not found",
        code: "NOT_FOUND",
      });
    }

    // Generate temporary password (12 hex chars)
    const tempPassword = crypto.randomBytes(6).toString("hex");
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    await prisma.admin.update({
      where: { id: adminId },
      data: { password: hashedPassword },
    });

    logger.info("[SUPER_ADMIN_RESET_PASSWORD] Password reset successfully", { adminId });

    res.status(200).json({
      success: true,
      message: "Password reset successfully. Temporary password returned below — no email delivery is configured yet.",
      data: {
        id: admin.id,
        email: admin.email,
        temporaryPassword: tempPassword,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_RESET_PASSWORD] Failed to reset password", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/marketers/stats
 * Platform-wide marketer statistics
 */
exports.getMarketerStats = async (req, res, next) => {
  try {
    logger.debug("[SUPER_ADMIN_MARKETER_STATS] Fetching marketer statistics");

    const [totalMarketers, bronzeCount, silverCount, goldCount, pendingVerifications, totalTokensGenerated] =
      await Promise.all([
        prisma.admin.count({ where: { role: "marketer" } }),
        prisma.admin.count({ where: { role: "marketer", tier: "bronze" } }),
        prisma.admin.count({ where: { role: "marketer", tier: "silver" } }),
        prisma.admin.count({ where: { role: "marketer", tier: "gold" } }),
        // Documents awaiting review — NOT unverified emails, which is what this
        // counted before. The portal renders it on a "Pending Verifications"
        // stat card next to a queue the operator can actually work through, so
        // it has to be the same number as that queue's length.
        prisma.marketerDocument.count({ where: { status: "pending" } }),
        prisma.schoolToken.count(),
      ]);

    logger.info("[SUPER_ADMIN_MARKETER_STATS] Statistics retrieved", { totalMarketers });

    res.status(200).json({
      success: true,
      data: {
        totalMarketers,
        byTier: { bronze: bronzeCount, silver: silverCount, gold: goldCount },
        pendingVerifications,
        totalTokensGenerated,
      },
    });
  } catch (err) {
    logger.error("[SUPER_ADMIN_MARKETER_STATS] Failed to fetch marketer statistics", { error: err.message });
    next(err);
  }
};
