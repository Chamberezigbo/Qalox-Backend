const prisma = require("../../util/prisma");
const bcrypt = require("bcryptjs");
const { SchoolService } = require("../../Services/SchoolService");
const logger = require("../../config/logger");

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
      data: marketers,
      meta: {
        page: Math.max(page, 1),
        limit,
        total,
        totalPages: Math.ceil(total / limit),
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
