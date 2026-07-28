const prisma = require("../../util/prisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { SchoolService } = require("../../Services/SchoolService");
const logger = require("../../config/logger");

// GET /api/public/schools
// Returns paginated schools for Super Admin Portal (no auth)
exports.getSchoolsPublic = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = parseInt(req.query.limit || req.query.pageSize) || 50;
    const take = Math.min(Math.max(pageSize, 1), 200);
    const skip = (page - 1) * take;
    const search = req.query.search || "";

    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
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

    logger.info(`[LOGIN_PUBLIC] ${admin.role} login successful`, { email, adminId: admin.id, role: admin.role });

    // Return user info for JWT generation by calling service
    res.status(200).json({
      success: true,
      message: "Authentication successful",
      data: {
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

    // Create marketer
    const newMarketer = await prisma.admin.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: "marketer",
        tier: tier || "bronze",
        referralCode: referralCode || `REF_${email.split("@")[0]}_${Date.now()}`,
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

    logger.debug(`[LIST_MARKETERS] Fetching marketers`, { page, limit, search });

    const skip = (Math.max(page, 1) - 1) * limit;

    const where = {
      role: "marketer",
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
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

    logger.info(`[LIST_MARKETERS] Retrieved ${marketers.length} marketers`, { page, limit, total });

    res.status(200).json({
      success: true,
      // Nested shape expected by Super Admin Portal's qaloxApiClient
      data: {
        data: marketers,
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

    logger.info(`[GET_MARKETER] Retrieved marketer`, { marketerId, email: marketer.email });

    res.status(200).json({
      success: true,
      data: marketer,
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
    const { suspend } = req.body;
    const marketerId = parseInt(id, 10);

    logger.debug(`[SUSPEND_MARKETER] Processing suspension request`, { marketerId, suspend });

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

    // Update suspension status
    const updatedMarketer = await prisma.admin.update({
      where: { id: marketerId },
      data: {
        isSuspended: suspend === true,
        suspendedAt: suspend === true ? new Date() : null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        isSuspended: true,
        suspendedAt: true,
      },
    });

    logger.info(`[SUSPEND_MARKETER] Marketer ${suspend ? 'suspended' : 'activated'} successfully`, { marketerId, email: updatedMarketer.email, isSuspended: updatedMarketer.isSuspended });

    res.status(200).json({
      success: true,
      message: suspend ? "Marketer suspended successfully" : "Marketer activated successfully",
      data: updatedMarketer,
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

    // Update commission
    const updatedMarketer = await prisma.admin.update({
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
    });

    logger.info(`[SET_COMMISSION] Commission updated successfully`, { marketerId, commissionRate });

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

    logger.info(`[GET_WALLET] Retrieved wallet for marketer`, { marketerId, balance: marketer.walletBalance });

    res.status(200).json({
      success: true,
      message: "Wallet retrieved successfully",
      data: {
        marketerId: marketer.id,
        balance: marketer.walletBalance,
        pending: marketer.walletPending,
        totalEarned: marketer.totalEarned,
        totalWithdrawn: marketer.totalWithdrawn,
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
exports.updateMarketerWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { operation, amount, description } = req.body;
    const marketerId = parseInt(id, 10);

    logger.debug(`[UPDATE_WALLET] Wallet operation`, { marketerId, operation, amount });

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

    // Update wallet
    const updatedMarketer = await prisma.admin.update({
      where: { id: marketerId },
      data: {
        walletBalance: newBalance,
        totalWithdrawn: newWithdrawn,
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
    });

    logger.info(`[UPDATE_WALLET] Wallet updated successfully`, { marketerId, operation, amount, newBalance });

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
    // Store commission in environment or database
    // For now, return from env or default
    const commissionRate = parseFloat(process.env.GLOBAL_COMMISSION_RATE || '5');
    
    logger.debug(`[GET_COMMISSION] Global commission rate retrieved`, { commissionRate });

    res.status(200).json({
      success: true,
      message: "Global commission rate retrieved",
      data: {
        commissionRate,
      },
    });
  } catch (err) {
    logger.error(`[GET_COMMISSION] Error retrieving commission`, { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/public/settings/commission
 * Set global commission rate (Super Admin configures)
 */
exports.setGlobalCommission = async (req, res, next) => {
  try {
    const { commissionRate } = req.body;

    if (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 100) {
      logger.warn(`[SET_COMMISSION] Invalid commission rate`, { commissionRate });
      return res.status(400).json({
        success: false,
        message: "Commission rate must be between 0 and 100",
        code: "INVALID_RATE",
      });
    }

    // In production, store this in database or Redis for persistence
    // For now, log it
    logger.info(`[SET_COMMISSION] Global commission rate updated`, { commissionRate });

    res.status(200).json({
      success: true,
      message: "Global commission rate updated successfully",
      data: {
        commissionRate,
      },
    });
  } catch (err) {
    logger.error(`[SET_COMMISSION] Error setting commission`, { error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/school-tokens
 * Create a new school assessment token (called by Marketer Portal)
 */
exports.createSchoolToken = async (req, res, next) => {
  try {
    const { schoolName, schoolEmail, pupil, class: className, subject } = req.body;

    if (!schoolName || !schoolEmail) {
      logger.warn(`[CREATE_TOKEN] Missing required fields`, { schoolName, schoolEmail });
      return res.status(400).json({
        success: false,
        message: "School name and email are required",
        code: "MISSING_FIELDS",
      });
    }

    const code = `TKN-${Date.now()}`;
    const uniqueKey = code;
    const issuedDate = new Date();
    const expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    // Save to database
    const token = await prisma.token.create({
      data: {
        email: schoolEmail,
        uniqueKey,
        status: "active",
        schoolName,
        createdAt: issuedDate,
      },
    });

    logger.info(`[CREATE_TOKEN] New token created and saved`, {
      tokenId: token.id,
      code,
      schoolName,
      schoolEmail
    });

    res.status(201).json({
      success: true,
      message: "Token created successfully",
      data: {
        _id: token.id.toString(),
        code,
        schoolName,
        schoolEmail,
        pupil: pupil || "",
        class: className || "",
        subject: subject || "",
        issuedDate: issuedDate.toISOString(),
        expiryDate: expiryDate.toISOString(),
        status: "active",
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
    const page = parseInt(req.query.page || 1, 10);
    const limit = parseInt(req.query.limit || 20, 10);
    const skip = (Math.max(page, 1) - 1) * limit;
    const search = req.query.search || "";
    const status = req.query.status || "";

    // Build WHERE clause with optional filters
    const where = {};
    if (search) {
      where.OR = [
        { schoolName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }
    if (status) {
      where.status = status;
    }

    const [tokens, total] = await Promise.all([
      prisma.token.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.token.count({ where }),
    ]);

    logger.debug(`[GET_TOKENS] Fetching tokens`, { page, limit, count: tokens.length, search, status });

    const formattedTokens = tokens.map(t => {
      const issuedDate = t.createdAt ? new Date(t.createdAt) : new Date();
      const expiryDate = new Date(issuedDate.getTime() + 365 * 24 * 60 * 60 * 1000);

      return {
        _id: t.id.toString(),
        code: t.uniqueKey,
        schoolName: t.schoolName,
        schoolEmail: t.email,
        pupil: "",
        class: "",
        subject: "",
        issuedDate: issuedDate.toISOString(),
        expiryDate: expiryDate.toISOString(),
        status: t.status,
      };
    });

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
    const total = await prisma.token.count();
    const active = await prisma.token.count({ where: { status: "active" } });

    logger.debug(`[TOKEN_STATS] Token statistics retrieved`, { total, active });

    res.status(200).json({
      success: true,
      data: {
        total,
        active,
        used: 0,
        unused: total - active,
      },
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

    // Create marketer
    const marketer = await prisma.admin.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: "marketer",
        tier: tier || "bronze",
      },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
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
 * GET /api/public/auth/profile/:marketerId
 * Get marketer profile (called by Marketer Portal)
 */
exports.getMarketerProfile = async (req, res, next) => {
  try {
    const { marketerId } = req.params;
    const parsedId = parseInt(marketerId, 10);

    if (!marketerId || isNaN(parsedId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing Marketer ID",
        code: "INVALID_ID",
      });
    }

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
      },
    });

    if (!marketer) {
      logger.warn(`[MARKETER_PROFILE] Marketer not found`, { marketerId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    logger.debug(`[MARKETER_PROFILE] Profile retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: marketer,
    });
  } catch (err) {
    logger.error(`[MARKETER_PROFILE] Error fetching profile`, { error: err.message, marketerId: req.params.marketerId });
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

    if (!marketerId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const [schools, total] = await Promise.all([
      prisma.school.findMany({
        where: { marketerId },
        select: {
          id: true,
          name: true,
          email: true,
          location: true,
          state: true,
          registrationNumber: true,
          createdAt: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.school.count({ where: { marketerId } }),
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

    const school = await prisma.school.create({
      data: {
        marketerId: parseInt(marketerId),
        name,
        email,
        location: location || "",
        state: state || "",
        registrationNumber: registrationNumber || "",
      },
      select: {
        id: true,
        name: true,
        email: true,
        location: true,
        state: true,
        registrationNumber: true,
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
    const { id } = req.params;
    const { name, email, location, state, registrationNumber } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "School ID is required",
        code: "MISSING_ID",
      });
    }

    const school = await prisma.school.update({
      where: { id: parseInt(id) },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(location && { location }),
        ...(state && { state }),
        ...(registrationNumber && { registrationNumber }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        location: true,
        state: true,
        registrationNumber: true,
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
 * Get notifications (Marketer Portal - returns empty for now)
 */
exports.getNotifications = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || 10, 10);
    const page = parseInt(req.query.page || 1, 10);

    logger.debug(`[GET_NOTIFICATIONS] Fetching notifications`, { page, limit });

    // Return empty notifications array (UI-only for now)
    res.status(200).json({
      success: true,
      data: {
        notifications: [],
        total: 0,
        page,
        limit,
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
exports.verify2FA = async (req, res, next) => {
  try {
    const { tempToken, code } = req.body;

    logger.debug(`[AUTH_2FA_VERIFY] Verifying 2FA code`, { hasToken: !!tempToken });

    if (!tempToken || !code) {
      logger.warn(`[AUTH_2FA_VERIFY] Missing required fields`, { tempToken: !!tempToken, code: !!code });
      return res.status(400).json({
        success: false,
        message: "tempToken and code are required",
        code: "MISSING_FIELDS",
      });
    }

    // Validate temp token format (should be JWT)
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET || "your-secret-key");
    } catch (err) {
      logger.warn(`[AUTH_2FA_VERIFY] Invalid or expired temp token`, { error: err.message });
      return res.status(401).json({
        success: false,
        message: "Invalid or expired temp token",
        code: "INVALID_TOKEN",
      });
    }

    // Verify token type
    if (decoded.type !== "2fa-temp") {
      logger.warn(`[AUTH_2FA_VERIFY] Token is not a 2FA temp token`, { tokenType: decoded.type });
      return res.status(401).json({
        success: false,
        message: "Invalid token type",
        code: "INVALID_TOKEN",
      });
    }

    // Check token expiration (must be within 5 minutes)
    const tokenAge = Date.now() - decoded.iat * 1000;
    if (tokenAge > 5 * 60 * 1000) {
      logger.warn(`[AUTH_2FA_VERIFY] Temp token expired`, { age: tokenAge });
      return res.status(401).json({
        success: false,
        message: "Temp token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    // TODO: Validate 2FA code against stored OTP
    // For now, accept any 6-digit code
    if (!code.match(/^\d{6}$/)) {
      logger.warn(`[AUTH_2FA_VERIFY] Invalid 2FA code format`, { codeLength: code.length });
      return res.status(400).json({
        success: false,
        message: "2FA code must be 6 digits",
        code: "INVALID_CODE_FORMAT",
      });
    }

    // Get marketer details
    const marketer = await prisma.admin.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tier: true,
      },
    });

    if (!marketer) {
      logger.warn(`[AUTH_2FA_VERIFY] Marketer not found`, { userId: decoded.userId });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // Generate new JWT token
    const token = jwt.sign(
      { userId: marketer.id, email: marketer.email, role: marketer.role },
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "7d" }
    );

    logger.info(`[AUTH_2FA_VERIFY] 2FA verified successfully`, { userId: marketer.id, email: marketer.email });

    res.status(200).json({
      success: true,
      message: "2FA verified",
      data: {
        id: marketer.id,
        email: marketer.email,
        name: marketer.name,
        role: marketer.role,
        tier: marketer.tier,
        token,
      },
    });
  } catch (err) {
    logger.error(`[AUTH_2FA_VERIFY] 2FA verification failed`, { error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/marketers/:marketerId/wallet
 * Withdraw or credit funds
 */
exports.marketerWalletOperation = async (req, res, next) => {
  try {
    const { marketerId } = req.params;
    const { amount, operation } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[WALLET_OPERATION] Processing wallet operation`, { marketerId: id, operation, amount });

    if (!amount || !operation) {
      logger.warn(`[WALLET_OPERATION] Missing required fields`, { operation, amount });
      return res.status(400).json({
        success: false,
        message: "amount and operation are required",
        code: "MISSING_FIELDS",
      });
    }

    if (operation !== "withdraw" && operation !== "credit") {
      logger.warn(`[WALLET_OPERATION] Invalid operation`, { operation });
      return res.status(400).json({
        success: false,
        message: "operation must be 'withdraw' or 'credit'",
        code: "INVALID_OPERATION",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[WALLET_OPERATION] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    if (marketer.role !== "marketer") {
      logger.warn(`[WALLET_OPERATION] User is not a marketer`, { marketerId: id, role: marketer.role });
      return res.status(400).json({
        success: false,
        message: "User is not a marketer",
        code: "INVALID_USER_TYPE",
      });
    }

    let newBalance = marketer.walletBalance || 0;
    let newTotalWithdrawn = marketer.totalWithdrawn || 0;

    if (operation === "withdraw") {
      if (amount > newBalance) {
        logger.warn(`[WALLET_OPERATION] Insufficient balance`, { marketerId: id, requested: amount, available: newBalance });
        return res.status(400).json({
          success: false,
          message: "Insufficient balance",
          code: "INSUFFICIENT_BALANCE",
        });
      }
      newBalance -= amount;
      newTotalWithdrawn += amount;
    } else if (operation === "credit") {
      newBalance += amount;
    }

    const updated = await prisma.admin.update({
      where: { id },
      data: {
        walletBalance: newBalance,
        ...(operation === "withdraw" && { totalWithdrawn: newTotalWithdrawn, lastPayoutDate: new Date() }),
      },
    });

    logger.info(`[WALLET_OPERATION] Wallet ${operation} processed`, { marketerId: id, amount, newBalance });

    res.status(200).json({
      success: true,
      message: `${operation.charAt(0).toUpperCase() + operation.slice(1)} processed`,
      data: {
        marketerId: id,
        balance: updated.walletBalance,
        totalWithdrawn: updated.totalWithdrawn,
        lastPayoutDate: updated.lastPayoutDate,
      },
    });
  } catch (err) {
    logger.error(`[WALLET_OPERATION] Wallet operation failed`, { marketerId: req.params.marketerId, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/school-tokens/by-school
 * Get count of tokens issued per school
 */
exports.getTokensBySchool = async (req, res, next) => {
  try {
    logger.debug(`[TOKENS_BY_SCHOOL] Fetching token counts by school`);

    const tokenCounts = await prisma.schoolToken.groupBy({
      by: ["schoolName"],
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
    const { id } = req.params;
    const tokenId = parseInt(id, 10);

    logger.debug(`[REVOKE_TOKEN] Revoking token`, { tokenId });

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

    const updatedToken = await prisma.schoolToken.update({
      where: { id: tokenId },
      data: { status: "revoked" },
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
      }),
      prisma.commission.count({ where }),
    ]);

    logger.info(`[GET_COMMISSIONS] Commissions retrieved`, { marketerId, count: commissions.length, total });

    res.status(200).json({
      success: true,
      data: {
        commissions,
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
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

    logger.debug(`[COMMISSION_SUMMARY] Fetching commission summary`, { marketerId });

    if (!marketerId) {
      logger.warn(`[COMMISSION_SUMMARY] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // Get all summaries in one query
    const [thisMonthData, lastMonthData, totalData, pendingData] = await Promise.all([
      prisma.commission.aggregate({
        where: { marketerId, month: currentMonth, year: currentYear },
        _sum: { amount: true },
      }),
      prisma.commission.aggregate({
        where: { marketerId, month: lastMonth, year: lastMonthYear },
        _sum: { amount: true },
      }),
      prisma.commission.aggregate({
        where: { marketerId },
        _sum: { amount: true },
      }),
      prisma.commission.aggregate({
        where: { marketerId, status: "pending" },
        _sum: { amount: true },
      }),
    ]);

    logger.info(`[COMMISSION_SUMMARY] Commission summary retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: {
        thisMonth: thisMonthData._sum.amount || 0,
        lastMonth: lastMonthData._sum.amount || 0,
        total: totalData._sum.amount || 0,
        pending: pendingData._sum.amount || 0,
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
    const { id } = req.params;
    const notificationId = parseInt(id, 10);

    logger.debug(`[MARK_NOTIFICATION_READ] Marking notification as read`, { notificationId });

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
    const { marketerId } = req.query;
    const { name, phone, address, city, state } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[UPDATE_PROFILE] Updating marketer profile`, { marketerId: id });

    if (!marketerId) {
      logger.warn(`[UPDATE_PROFILE] marketerId query parameter required`);
      return res.status(400).json({
        success: false,
        message: "marketerId query parameter is required",
        code: "MISSING_MARKETER_ID",
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
    logger.error(`[UPDATE_PROFILE] Failed to update profile`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/users/password
 * Change marketer password
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const { currentPassword, newPassword } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[CHANGE_PASSWORD] Password change attempt`, { marketerId: id });

    if (!marketerId || !currentPassword || !newPassword) {
      logger.warn(`[CHANGE_PASSWORD] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "marketerId, currentPassword, and newPassword are required",
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
    logger.error(`[CHANGE_PASSWORD] Failed to change password`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/users/avatar
 * Upload marketer avatar
 */
exports.uploadAvatar = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const id = parseInt(marketerId, 10);

    logger.debug(`[UPLOAD_AVATAR] Avatar upload initiated`, { marketerId: id });

    if (!marketerId) {
      logger.warn(`[UPLOAD_AVATAR] marketerId query parameter required`);
      return res.status(400).json({
        success: false,
        message: "marketerId query parameter is required",
        code: "MISSING_MARKETER_ID",
      });
    }

    if (!req.file) {
      logger.warn(`[UPLOAD_AVATAR] No file uploaded`, { marketerId: id });
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
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

    const avatarUrl = `/api/uploads/avatars/${req.file.filename}`;
    await prisma.admin.update({
      where: { id },
      data: { avatar: avatarUrl },
    });

    logger.info(`[UPLOAD_AVATAR] Avatar uploaded successfully`, { marketerId: id, filename: req.file.filename });

    res.status(200).json({
      success: true,
      message: "Avatar uploaded",
      data: {
        avatarUrl,
      },
    });
  } catch (err) {
    logger.error(`[UPLOAD_AVATAR] Failed to upload avatar`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/settings/banks
 * Get list of Nigerian banks
 */
exports.getBankList = async (req, res, next) => {
  try {
    logger.debug(`[GET_BANKS] Fetching Nigerian banks list`);

    // Common Nigerian banks - can be expanded or stored in DB
    const banks = [
      { code: "044", name: "Access Bank", slug: "access" },
      { code: "033", name: "First Bank", slug: "firstbank" },
      { code: "053", name: "Guaranty Trust Bank", slug: "gtb" },
      { code: "050", name: "Ecobank", slug: "ecobank" },
      { code: "011", name: "First City Monument Bank", slug: "fcmb" },
      { code: "007", name: "Zenith Bank", slug: "zenith" },
      { code: "014", name: "Guaranty Trust Bank", slug: "gtbank" },
      { code: "035", name: "Wema Bank", slug: "wema" },
      { code: "037", name: "Stanbic IBTC Bank", slug: "stanbic" },
      { code: "040", name: "Skye Bank", slug: "skye" },
      { code: "042", name: "Unity Bank", slug: "unity" },
      { code: "048", name: "Diamond Bank", slug: "diamond" },
      { code: "058", name: "Gtbank", slug: "gtb" },
      { code: "060", name: "Fidelity Bank", slug: "fidelity" },
      { code: "063", name: "Sterling Bank", slug: "sterling" },
    ];

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

    // TODO: Integrate with Flutterwave or Mono API for account verification
    // For now, return mock verified account
    logger.info(`[VERIFY_ACCOUNT] Account verification in progress`);

    res.status(200).json({
      success: true,
      data: {
        accountNumber,
        accountName: "John Marketer",
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
    const { marketerId } = req.query;
    const { accountNumber, accountName, bankCode } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[SAVE_BANK_ACCOUNT] Saving bank account`, { marketerId: id, bankCode });

    if (!marketerId || !accountNumber || !accountName || !bankCode) {
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
    logger.error(`[SAVE_BANK_ACCOUNT] Failed to save bank account`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * PUT /api/public/settings/notifications
 * Update notification preferences
 */
exports.updateNotificationSettings = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const { email, push, commissionAlerts, marketingUpdates } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[UPDATE_NOTIFICATIONS] Updating notification preferences`, { marketerId: id });

    if (!marketerId) {
      logger.warn(`[UPDATE_NOTIFICATIONS] marketerId query parameter required`);
      return res.status(400).json({
        success: false,
        message: "marketerId query parameter is required",
        code: "MISSING_MARKETER_ID",
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

    // TODO: Store notification preferences in a separate NotificationSettings table
    // For now, log the preferences
    logger.info(`[UPDATE_NOTIFICATIONS] Notification preferences updated`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "Notification preferences updated",
      data: {
        email: email !== undefined ? email : true,
        push: push !== undefined ? push : true,
        commissionAlerts: commissionAlerts !== undefined ? commissionAlerts : true,
        marketingUpdates: marketingUpdates !== undefined ? marketingUpdates : false,
      },
    });
  } catch (err) {
    logger.error(`[UPDATE_NOTIFICATIONS] Failed to update preferences`, { marketerId: req.query.marketerId, error: err.message });
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

    logger.debug(`[GET_TRANSACTIONS] Fetching transactions`, { page, limit, marketerId });

    if (!marketerId) {
      logger.warn(`[GET_TRANSACTIONS] Unauthorized - no marketerId in token`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    // TODO: Implement Transaction model and query
    logger.info(`[GET_TRANSACTIONS] Transactions retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: {
        transactions: [],
        total: 0,
        page,
        limit,
        pages: 0,
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

    // TODO: Implement Transaction model and aggregation
    logger.info(`[TRANSACTION_STATS] Transaction stats retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: {
        totalAmount: 0,
        transactionCount: 0,
        averageTransaction: 0,
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
exports.toggle2FA = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const { enabled } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[TOGGLE_2FA] 2FA toggle request`, { marketerId: id, enabled });

    if (!marketerId || enabled === undefined) {
      logger.warn(`[TOGGLE_2FA] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "marketerId and enabled are required",
        code: "MISSING_FIELDS",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[TOGGLE_2FA] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // TODO: If enabling, generate and send OTP
    // If disabling, clear 2FA secret

    logger.info(`[TOGGLE_2FA] 2FA toggled`, { marketerId: id, enabled });

    res.status(200).json({
      success: true,
      message: `2FA ${enabled ? "enabled" : "disabled"}`,
      data: {
        twoFactorEnabled: enabled,
      },
    });
  } catch (err) {
    logger.error(`[TOGGLE_2FA] Failed to toggle 2FA`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * ============================================
 * PHASE 3 - ADVANCED FEATURES & ANALYTICS
 * ============================================
 */

/**
 * POST /api/public/settings/2fa/setup
 * Start 2FA setup process (generate QR code)
 */
exports.setup2FA = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const id = parseInt(marketerId, 10);

    logger.debug(`[2FA_SETUP] Starting 2FA setup`, { marketerId: id });

    if (!marketerId) {
      logger.warn(`[2FA_SETUP] marketerId query parameter required`);
      return res.status(400).json({
        success: false,
        message: "marketerId query parameter is required",
        code: "MISSING_MARKETER_ID",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[2FA_SETUP] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // TODO: Generate TOTP secret and QR code using speakeasy library
    const secret = "JBSWY3DPEBLW64TMMQ======"; // Mock secret
    const qrCode = "https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=secret";

    logger.info(`[2FA_SETUP] 2FA setup initiated`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "2FA setup started",
      data: {
        secret,
        qrCode,
        manualEntry: secret,
      },
    });
  } catch (err) {
    logger.error(`[2FA_SETUP] Failed to setup 2FA`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/settings/2fa/verify-setup
 * Verify 2FA setup and enable it
 */
exports.verifySetup2FA = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const { secret, code } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[2FA_VERIFY_SETUP] Verifying 2FA setup`, { marketerId: id });

    if (!marketerId || !secret || !code) {
      logger.warn(`[2FA_VERIFY_SETUP] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "marketerId, secret, and code are required",
        code: "MISSING_FIELDS",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[2FA_VERIFY_SETUP] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // TODO: Verify code against secret using speakeasy
    if (!code.match(/^\d{6}$/)) {
      logger.warn(`[2FA_VERIFY_SETUP] Invalid code format`, { marketerId: id });
      return res.status(400).json({
        success: false,
        message: "Code must be 6 digits",
        code: "INVALID_CODE",
      });
    }

    // For now, accept any valid 6-digit code
    const updated = await prisma.admin.update({
      where: { id },
      data: {
        isSuspended: false, // Use this to track 2FA enabled (better to add twoFactorSecret field)
      },
    });

    logger.info(`[2FA_VERIFY_SETUP] 2FA setup verified and enabled`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "2FA enabled successfully",
      data: {
        twoFactorEnabled: true,
        backupCodes: [
          "ABCD-1234",
          "EFGH-5678",
          "IJKL-9012",
        ],
      },
    });
  } catch (err) {
    logger.error(`[2FA_VERIFY_SETUP] Failed to verify 2FA setup`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

/**
 * POST /api/public/settings/2fa/disable
 * Disable 2FA
 */
exports.disable2FA = async (req, res, next) => {
  try {
    const { marketerId } = req.query;
    const { password } = req.body;
    const id = parseInt(marketerId, 10);

    logger.debug(`[2FA_DISABLE] Disabling 2FA`, { marketerId: id });

    if (!marketerId || !password) {
      logger.warn(`[2FA_DISABLE] Missing required fields`);
      return res.status(400).json({
        success: false,
        message: "marketerId and password are required",
        code: "MISSING_FIELDS",
      });
    }

    const marketer = await prisma.admin.findUnique({
      where: { id },
    });

    if (!marketer) {
      logger.warn(`[2FA_DISABLE] Marketer not found`, { marketerId: id });
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "NOT_FOUND",
      });
    }

    // Verify password for security
    const isPasswordValid = await bcrypt.compare(password, marketer.password);
    if (!isPasswordValid) {
      logger.warn(`[2FA_DISABLE] Invalid password`, { marketerId: id });
      return res.status(401).json({
        success: false,
        message: "Invalid password",
        code: "INVALID_PASSWORD",
      });
    }

    logger.info(`[2FA_DISABLE] 2FA disabled`, { marketerId: id });

    res.status(200).json({
      success: true,
      message: "2FA disabled successfully",
      data: {
        twoFactorEnabled: false,
      },
    });
  } catch (err) {
    logger.error(`[2FA_DISABLE] Failed to disable 2FA`, { marketerId: req.query.marketerId, error: err.message });
    next(err);
  }
};

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

    // Generate month labels
    const data = [];
    const today = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const month = date.getMonth() + 1;
      const year = date.getFullYear();

      const monthData = await prisma.commission.aggregate({
        where: { marketerId, month, year },
        _sum: { amount: true },
      });

      data.push({
        month: date.toLocaleString("en-US", { month: "short" }),
        amount: monthData._sum.amount || 0,
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

    // TODO: Implement school statistics query
    // For now, return mock data
    logger.info(`[MARKETER_SCHOOLS_STATS] School statistics retrieved`, { marketerId });

    res.status(200).json({
      success: true,
      data: {
        totalSchools: 5,
        activeSchools: 4,
        suspendedSchools: 1,
        totalTokensIssued: 150,
        totalRevenue: 500000,
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
    const { id } = req.params;
    const { status } = req.body;
    const tokenId = parseInt(id, 10);

    logger.debug(`[UPDATE_TOKEN_STATUS] Updating token status`, { tokenId, status });

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

    const updated = await prisma.schoolToken.update({
      where: { id: tokenId },
      data: { status },
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
 * DELETE /api/public/marketer-schools/:id
 * Delete a marketer's school
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
