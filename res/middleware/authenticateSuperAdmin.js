const jwt = require("jsonwebtoken");
const prisma = require("../util/prisma");
const { AppError } = require("../util/AppError");

// Environment variables for JWT
const JWT_SECRET = process.env.JWT_SECRET;

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
    next();
  } catch (err) {
    return next(new AppError("Unauthorized: Invalid token", 401));
  }
};

// middleware to authenticate and authorize super admin
const authenticateSuperAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return next(new AppError("Unauthorized: Missing token", 401));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== "super_admin") {
      return next(new AppError("Unauthorized: Only super_admins can access this route", 401));
    }
    req.user = decoded;
    next();
  } catch (error) {
    return next(new AppError("Unauthorized: Invalid token", 401));
  }
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
  attachSchoolId
};
