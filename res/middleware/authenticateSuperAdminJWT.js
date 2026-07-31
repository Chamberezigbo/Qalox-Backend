const jwt = require("jsonwebtoken");
const logger = require("../config/logger");

/**
 * Middleware to authenticate JWT token for the Super Admin Portal (platform operators).
 * Checks: Bearer token in Authorization header, valid JWT, platform_super_admin role.
 *
 * NOTE: "platform_super_admin" is distinct from the legacy "super_admin" role,
 * which means "school owner" elsewhere in this codebase. They previously
 * shared the same string, which meant any school owner could authenticate
 * against these platform-wide endpoints — this check now requires the
 * dedicated platform role.
 */
const authenticateSuperAdminJWT = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    logger.debug("[SUPER_ADMIN_JWT_AUTH] Validating token");

    if (!authHeader) {
      logger.warn("[SUPER_ADMIN_JWT_AUTH] Missing Authorization header");
      return res.status(401).json({
        success: false,
        message: "Authorization header is required",
        code: "MISSING_AUTH_HEADER",
      });
    }

    // Check for Bearer token
    if (!authHeader.startsWith("Bearer ")) {
      logger.warn("[SUPER_ADMIN_JWT_AUTH] Invalid Authorization header format");
      return res.status(401).json({
        success: false,
        message: "Authorization header must be in format: Bearer <token>",
        code: "INVALID_AUTH_HEADER",
      });
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      logger.warn("[SUPER_ADMIN_JWT_AUTH] Token verification failed", {
        error: jwtErr.message,
      });
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
        code: "INVALID_TOKEN",
      });
    }

    // Check for platform_super_admin role
    if (decoded.role !== "platform_super_admin") {
      logger.warn("[SUPER_ADMIN_JWT_AUTH] Insufficient permissions", {
        role: decoded.role,
      });
      return res.status(403).json({
        success: false,
        message: "Only super admins can access this resource",
        code: "FORBIDDEN",
      });
    }

    // Attach admin info to request
    req.admin = {
      id: decoded.id,
      role: decoded.role,
    };

    logger.debug("[SUPER_ADMIN_JWT_AUTH] Token validated", { adminId: decoded.id });
    next();
  } catch (err) {
    logger.error("[SUPER_ADMIN_JWT_AUTH] Authentication error", { error: err.message });
    res.status(500).json({
      success: false,
      message: "Authentication error",
      code: "AUTH_ERROR",
    });
  }
};

module.exports = authenticateSuperAdminJWT;
