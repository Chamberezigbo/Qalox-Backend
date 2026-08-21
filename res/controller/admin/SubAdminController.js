const prisma = require("../../util/prisma");
const bcrypt = require("bcryptjs");
const logger = require("../../config/logger");
const { getActivePlanForSchool } = require("../../util/getActivePlanForSchool");
const {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  SUB_ADMIN_TYPES,
  isValidPermission,
  parsePermissions,
} = require("../../util/permissions");

const formatSubAdmin = (admin) => ({
  id: admin.id,
  name: admin.name,
  email: admin.email,
  phone: admin.phone,
  subAdminType: admin.subAdminType,
  subAdminLabel: admin.subAdminLabel,
  permissions: parsePermissions(admin.permissions),
  isSuspended: admin.isSuspended,
  createdAt: admin.createdAt,
});

/**
 * GET /api/admin/permissions
 * List all available permission keys (with human labels) and sub-admin types
 */
exports.getAvailablePermissions = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        permissions: ALL_PERMISSIONS.map((key) => ({ key, label: PERMISSION_LABELS[key] })),
        subAdminTypes: SUB_ADMIN_TYPES,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/admin/sub-admins/create
 * Create a sub-admin (HR, Secretary, Bursar, Other) scoped to the caller's school
 */
exports.createSubAdmin = async (req, res, next) => {
  try {
    const creatorId = req.user.id;
    const schoolId = req.schoolId;
    const { name, email, password, phone, subAdminType, subAdminLabel, permissions } = req.body;

    logger.debug("[CREATE_SUB_ADMIN] Creating sub-admin", { schoolId, email, subAdminType });

    if (!name || !email || !password || !subAdminType) {
      return res.status(400).json({
        success: false,
        message: "name, email, password, and subAdminType are required",
        code: "MISSING_FIELDS",
      });
    }

    if (!SUB_ADMIN_TYPES.includes(subAdminType)) {
      return res.status(400).json({
        success: false,
        message: `subAdminType must be one of: ${SUB_ADMIN_TYPES.join(", ")}`,
        code: "INVALID_SUB_ADMIN_TYPE",
      });
    }

    if (subAdminType === "other" && !subAdminLabel) {
      return res.status(400).json({
        success: false,
        message: "subAdminLabel is required when subAdminType is 'other'",
        code: "MISSING_SUB_ADMIN_LABEL",
      });
    }

    const requestedPermissions = Array.isArray(permissions) ? permissions : [];
    const invalidPermissions = requestedPermissions.filter((p) => !isValidPermission(p));
    if (invalidPermissions.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid permission key(s): ${invalidPermissions.join(", ")}`,
        code: "INVALID_PERMISSIONS",
      });
    }

    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: "Email already in use",
        code: "EMAIL_EXISTS",
      });
    }

    // Enforce the school's plan cap on sub-admin count. Schools with no
    // active plan yet (predating this feature) are not blocked.
    const plan = await getActivePlanForSchool(schoolId);
    if (plan && plan.maxSubAdmins != null) {
      const subAdminCount = await prisma.admin.count({ where: { schoolId, role: "sub_admin" } });
      if (subAdminCount >= plan.maxSubAdmins) {
        return res.status(403).json({
          success: false,
          message: `Your plan (${plan.name}) allows up to ${plan.maxSubAdmins} sub-admin(s). Upgrade your plan to add more.`,
          code: "SUB_ADMIN_LIMIT_REACHED",
        });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const subAdmin = await prisma.admin.create({
      data: {
        name,
        email,
        password: hashedPassword,
        phone: phone || null,
        role: "sub_admin",
        schoolId,
        subAdminType,
        subAdminLabel: subAdminType === "other" ? subAdminLabel : null,
        permissions: JSON.stringify(requestedPermissions),
        createdByAdminId: creatorId,
      },
    });

    logger.info("[CREATE_SUB_ADMIN] Sub-admin created", { subAdminId: subAdmin.id, schoolId });

    res.status(201).json({
      success: true,
      message: "Sub-admin created successfully",
      data: formatSubAdmin(subAdmin),
    });
  } catch (err) {
    logger.error("[CREATE_SUB_ADMIN] Failed to create sub-admin", { error: err.message });
    next(err);
  }
};

/**
 * GET /api/admin/sub-admins
 * List sub-admins for the caller's school
 */
exports.getSubAdmins = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;

    const subAdmins = await prisma.admin.findMany({
      where: { schoolId, role: "sub_admin" },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({
      success: true,
      data: subAdmins.map(formatSubAdmin),
    });
  } catch (err) {
    logger.error("[GET_SUB_ADMINS] Failed to fetch sub-admins", { error: err.message });
    next(err);
  }
};

/**
 * PATCH /api/admin/sub-admins/:id
 * Update a sub-admin's details and/or permissions (must belong to caller's school)
 */
exports.updateSubAdmin = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const subAdminId = parseInt(req.params.id, 10);
    const { name, phone, subAdminType, subAdminLabel, permissions, isSuspended, password } = req.body;

    if (isNaN(subAdminId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sub-admin ID",
        code: "INVALID_REQUEST",
      });
    }

    const existing = await prisma.admin.findFirst({
      where: { id: subAdminId, schoolId, role: "sub_admin" },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Sub-admin not found",
        code: "NOT_FOUND",
      });
    }

    const updateData = {};
    if (name) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;
    if (typeof isSuspended === "boolean") updateData.isSuspended = isSuspended;

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters",
          code: "INVALID_PASSWORD",
        });
      }
      updateData.password = await bcrypt.hash(password, 12);
    }

    if (subAdminType) {
      if (!SUB_ADMIN_TYPES.includes(subAdminType)) {
        return res.status(400).json({
          success: false,
          message: `subAdminType must be one of: ${SUB_ADMIN_TYPES.join(", ")}`,
          code: "INVALID_SUB_ADMIN_TYPE",
        });
      }
      updateData.subAdminType = subAdminType;
      updateData.subAdminLabel = subAdminType === "other" ? (subAdminLabel || existing.subAdminLabel) : null;
    }

    if (Array.isArray(permissions)) {
      const invalidPermissions = permissions.filter((p) => !isValidPermission(p));
      if (invalidPermissions.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid permission key(s): ${invalidPermissions.join(", ")}`,
          code: "INVALID_PERMISSIONS",
        });
      }
      updateData.permissions = JSON.stringify(permissions);
    }

    const updated = await prisma.admin.update({
      where: { id: subAdminId },
      data: updateData,
    });

    logger.info("[UPDATE_SUB_ADMIN] Sub-admin updated", { subAdminId });

    res.status(200).json({
      success: true,
      message: "Sub-admin updated successfully",
      data: formatSubAdmin(updated),
    });
  } catch (err) {
    logger.error("[UPDATE_SUB_ADMIN] Failed to update sub-admin", { error: err.message });
    next(err);
  }
};

/**
 * DELETE /api/admin/sub-admins/:id
 * Remove a sub-admin (must belong to caller's school)
 */
exports.deleteSubAdmin = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const subAdminId = parseInt(req.params.id, 10);

    if (isNaN(subAdminId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sub-admin ID",
        code: "INVALID_REQUEST",
      });
    }

    const existing = await prisma.admin.findFirst({
      where: { id: subAdminId, schoolId, role: "sub_admin" },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Sub-admin not found",
        code: "NOT_FOUND",
      });
    }

    await prisma.admin.delete({ where: { id: subAdminId } });

    logger.info("[DELETE_SUB_ADMIN] Sub-admin deleted", { subAdminId });

    res.status(200).json({
      success: true,
      message: "Sub-admin deleted successfully",
    });
  } catch (err) {
    logger.error("[DELETE_SUB_ADMIN] Failed to delete sub-admin", { error: err.message });
    next(err);
  }
};
