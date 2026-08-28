const jwt = require("jsonwebtoken");
const prisma = require("../util/prisma");
const { AppError } = require("../util/AppError");
const { getSchoolLockStatus } = require("../util/getSchoolLockStatus");

// Environment variables for JWT
const JWT_SECRET = process.env.JWT_SECRET;

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

// The /billing/* routes are how a locked school pays or redeems a coupon to
// unlock itself, so they must stay reachable even while locked.
const isLockAllowlisted = (req) => req.path.startsWith("/billing");

// Shared by every school-tenant admin auth path below: once the 48h grace
// period has passed with no active/trial plan, every mutating request except
// the billing self-service routes gets rejected — the dashboard stays
// visible (GETs pass) but nothing can be changed until the school pays or
// redeems a coupon.
const enforcePaymentLock = async (req, res, next, schoolId) => {
  if (SAFE_METHODS.includes(req.method) || isLockAllowlisted(req)) {
    return next();
  }
  const { locked, graceEndsAt } = await getSchoolLockStatus(schoolId);
  if (locked) {
    return res.status(402).json({
      success: false,
      message: "Your school's free period has ended. Select a plan or redeem a coupon to continue.",
      code: "PAYMENT_REQUIRED",
      lockedSince: graceEndsAt,
    });
  }
  next();
};

// Generic authentication for any admin (super_admin or school_admin)
const authenticateAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return next(new AppError("Unauthorized: Missing token", 401));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Ensure the admin exists and is still active in DB
    const admin = await prisma.admin.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, schoolId: true }
    });
    if (!admin) {
      return next(new AppError("Unauthorized: Admin not found", 401));
    }
    req.user = admin; // Attach full admin basics
    if (!admin.schoolId) return next();
    return enforcePaymentLock(req, res, next, admin.schoolId);
  } catch (err) {
    return next(new AppError("Unauthorized: Invalid token", 401));
  }
};

// Middleware to authenticate and authorize a school's head admin.
// NOTE: "super_admin" here is the legacy per-school owner role (unrelated to
// the platform-wide "platform_super_admin" used by the Super Admin Portal).
// "school_admin" is accepted with full parity so it's a fully functional
// head-admin role going forward, not just a dormant enum value.
const authenticateSuperAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return next(new AppError("Unauthorized: Missing token", 401));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!["super_admin", "school_admin"].includes(decoded.role)) {
      return next(new AppError("Unauthorized: Only school head admins can access this route", 401));
    }
    req.user = decoded;
    next();
  } catch (error) {
    return next(new AppError("Unauthorized: Invalid token", 401));
  }
};

// Middleware to authenticate any school-level admin, including sub-admins.
// Attaches full admin record (id, role, schoolId, permissions) to req.user.
// Use with `requirePermission(key)` to gate specific routes for sub-admins;
// head admins (super_admin/school_admin) always pass regardless of `key`.
const authenticateSchoolLevelAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return next(new AppError("Unauthorized: Missing token", 401));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!["super_admin", "school_admin", "sub_admin"].includes(decoded.role)) {
      return next(new AppError("Unauthorized: Only school-level admins can access this route", 401));
    }

    const admin = await prisma.admin.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, schoolId: true, permissions: true, isSuspended: true },
    });

    if (!admin) {
      return next(new AppError("Unauthorized: Admin not found", 401));
    }

    if (admin.isSuspended) {
      return next(new AppError("Unauthorized: Account is suspended", 401));
    }

    req.user = admin;
    if (!admin.schoolId) return next();
    return enforcePaymentLock(req, res, next, admin.schoolId);
  } catch (error) {
    return next(new AppError("Unauthorized: Invalid token", 401));
  }
};

// Middleware factory: gates a route behind a permission key for sub-admins.
// Head admins (super_admin/school_admin) always pass. Must run after
// authenticateSchoolLevelAdmin.
const requirePermission = (permissionKey) => (req, res, next) => {
  const { role, permissions } = req.user || {};

  if (role === "super_admin" || role === "school_admin") {
    return next();
  }

  if (role === "sub_admin") {
    const { parsePermissions } = require("../util/permissions");
    const granted = parsePermissions(permissions);
    if (granted.includes(permissionKey)) {
      return next();
    }
    return next(new AppError(`Unauthorized: Missing permission "${permissionKey}"`, 403));
  }

  return next(new AppError("Unauthorized", 403));
};

// Middleware to attach schoolId for school_admin (or super_admin with school, if ever assigned)
const attachSchoolId = async (req, res, next) => {
  try {
    const adminId = req.user.id;

    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: { schoolId: true, role: true }
    });

    if (!admin) {
      return next(new AppError("Unauthorized: Admin not found", 401));
    }

    if (!admin.schoolId) {
      return next(new AppError("Unauthorized: School ID not found for this admin", 401));
    }
    req.schoolId = admin.schoolId;
    next();
  } catch (e) {
    next(e);
  }
};

module.exports = {
  authenticateAdmin,
  authenticateSuperAdmin,
  authenticateSchoolLevelAdmin,
  requirePermission,
  attachSchoolId
};
