const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const prisma = require("../../util/prisma");
const { logLoginEvent } = require("../../util/logLoginEvent");
const emailService = require("../../Services/EmailService");
const logger = require("../../config/logger");

const JWT_SECRET = process.env.JWT_SECRET;

exports.createAdmin = async (req, res, next) => {
  try {
    // For super_admin, ensure schoolId is not provided
    // campusId must be destructured here: createAdminSchema requires it for
    // school_admin, and line ~86 reads it. Without it that read is an
    // undeclared identifier and creating a school_admin throws ReferenceError.
    const { email, password, role, uniqueKey, schoolId, campusId, name } = req.body;
    if (role === "super_admin" && schoolId) {
      return res.status(400).json({
        message: "School ID should not be provided for super admin",
      });
    }

    if (role === "school_admin" && !schoolId) {
      return res.status(400).json({
        message: "School ID is required for school admin",
      });
    }

    // Check if email already in use//
    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(409).json({ message: "Email already exists" });
    }

    //for super admin,validate the uniqueKey
    let matchedSchoolToken = null;
    if (role == "super_admin") {
      if (!uniqueKey) {
        return res.status(400).json({
          message: "Unique key is required for super admin",
        });
      }

      const tokenRecord = await prisma.token.findUnique({
        where: { email },
      });

      if (tokenRecord) {
        // validate unique key and email match
        if (tokenRecord.uniqueKey !== uniqueKey || tokenRecord.email !== email) {
          return res.status(400).json({
            message:
              "Invalid unique key or Email does not match the token record.",
          });
        }

        // Check if token is still active (not already used)
        if (tokenRecord.status !== 'active') {
          return res.status(400).json({
            message:
              "Token is no longer active. It may have already been used.",
          });
        }

        // After successfully validation,update token status to'inactive'
        await prisma.token.update({
          where: { email },
          data: {
            status: "inactive",
          },
        });
      } else {
        // No legacy Token match — check whether this is a marketer-issued
        // SchoolToken instead (generated via the Marketer Portal, keyed by
        // code + schoolEmail rather than email + uniqueKey).
        matchedSchoolToken = await prisma.schoolToken.findUnique({
          where: { code: uniqueKey },
        });

        if (!matchedSchoolToken || matchedSchoolToken.schoolEmail !== email) {
          return res
            .status(404)
            .json({ message: "Token not found for the provided email" });
        }

        if (matchedSchoolToken.status !== "active") {
          return res.status(400).json({
            message:
              "Token is no longer active. It may have already been used.",
          });
        }

        await prisma.schoolToken.update({
          where: { id: matchedSchoolToken.id },
          data: { status: "used" },
        });
      }
    }

    //Hash password//
    const hashPassword = await bcrypt.hash(password, 12);

    // Create admin with dynamic steps assignment
    const adminData = {
      name,
      email,
      password: hashPassword,
      role,
      schoolId: role === "super_admin" ? null : schoolId,
      campusId: role === "super_admin" ? null : campusId,
      pendingSchoolTokenId: matchedSchoolToken ? matchedSchoolToken.id : null,
    };

    // Set steps only for super_admin
    if (role === "super_admin") {
      adminData.steps = 0;
    }


    const admin = await prisma.admin.create({
      data: adminData,
    });

    // Generate JWT token//
    const token = jwt.sign(
      { id: admin.id, role: admin.role }, // { id: admin.id, role: admin.role, schoolId: admin.schoolId },
      JWT_SECRET,
      { expiresIn: "1d" }
    );


    res.status(201).json({ message: "Admin created successfully", data: { token, admin } });
  } catch (error) {
    next(error);
  }
};

exports.loginAdmin = async (req, res, next) => {
  const { email, password } = req.body;

  try {
    // Check if email exists//
    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) return res.status(401).json({ message: "Admin not found" });

    // Check if password is correct//
    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid)
      return res.status(401).json({ message: "Invalid password" });

    const firstLogin = !admin.hasLoggedIn;

    // If first time, flip the flag before issuing token (low contention; acceptable)
    if (firstLogin) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { hasLoggedIn: true }
      });
    }

    // Generate JWT token//
    const token = jwt.sign(
      { id: admin.id, role: admin.role }, // { id: admin.id, role: admin.role, schoolId: admin.schoolId },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    // Strip the bcrypt hash — `admin` is a bare findUnique with no `select`, so
    // it carries every column including `password`. Everything else on the
    // record (role, permissions, schoolId) is what the portals branch on.
    const { password: _password, ...safeAdmin } = admin;

    // Optionally re-fetch updated admin if you want hasLoggedIn true reflected immediately
    const responseAdmin = firstLogin
      ? { ...safeAdmin, hasLoggedIn: true }
      : safeAdmin;

    await logLoginEvent({ actorType: "admin", actorId: admin.id, schoolId: admin.schoolId, req });

    res.status(200).json({
      message: "Admin logged in successfully",
      data: { token, admin: responseAdmin, firstLogin },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/forgot-password
 * Body: { email }
 * Browser-facing counterpart to publicController.forgotPassword — that one
 * sits behind serviceAuth (x-service-key) for portal-to-portal calls, which
 * the school frontend can't hold without exposing it. Always responds with
 * the same generic message regardless of whether the email exists.
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

    const portalUrl = process.env.SCHOOL_PORTAL_URL || "http://localhost:8800";
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
 * POST /api/admin/reset-password
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

exports.getSchoolAdmins = async (req, res, next) => {
  // schoolId now comes from auth middleware (attachSchoolId)
  const schoolId = req.schoolId;
  if (!schoolId) {
    return res.status(403).json({ message: "Authenticated admin does not have a school assigned" });
  }
  try {
    const admins = await prisma.admin.findMany({
      where: { schoolId: parseInt(schoolId) },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, role: true, steps: true, createdAt: true }
    });
    res.status(200).json({ message: "Admins fetched successfully", count: admins.length, admins });
  } catch (error) {
    next(error);
  }
};

exports.updateAdmin = async (req, res, next) => {
  const { error } = updateAdminSchema.validate(req.body);

  if (error) return res.status(400).json({ message: error.details[0].message });

  const { id } = req.params;
  const { name, email, password, role, campusId } = req.body;

  try {
    // find admin to update
    const admin = await prisma.admin.findUnique({
      where: { id: parseInt(id) },
    });
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    // prepare data to update
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (password) updateData.password = password;
    if (role) updateData.role = role;
    if (campusId) updateData.campusId = campusId;
    if (steps) updateData.steps = steps;

    // update admin
    const updatedAdmin = await prisma.admin.update({
      where: { id: parseInt(id) },
      data: updateData,
    });
    res
      .status(200)
      .json({ message: "Admin updated successfully", updatedAdmin });
  } catch (error) {
    next(error);
  }
};

exports.deleteAdmin = async (req, res, next) => {
  const { id } = req.params;
  try {
    // Find and delete the admin
    const admin = await prisma.admin.findUnique({
      where: { id: parseInt(id) },
    });
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    await prisma.admin.delete({ where: { id: parseInt(id) } });
    res.status(200).json({ message: "Admin deleted successfully", admin });
  } catch (error) {
    next(error);
  }
};

exports.checkHealth = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      message: "This server is up and runing",
    });
  } catch (error) {
    next(error);
  }
};

// Return the authenticated admin's schoolId and basic school info
exports.getMySchool = async (req, res, next) => {
  try {
    const adminId = req.user.id; // set by authenticateAdmin middleware
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      include: {
        school: { select: { id: true, name: true, email: true, prefix: true } }
      }
    });
    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }
    if (!admin.schoolId || !admin.school) {
      return res.status(200).json({
        message: "No school assigned to this admin",
        data: { schoolId: null, school: null }
      });
    }
    return res.status(200).json({
      message: "School fetched successfully",
      data: { schoolId: admin.schoolId, school: admin.school }
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/assessments?page=1&pageSize=50
exports.getSchoolAssessments = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    if (!schoolId) {
      return res.status(400).json({ success: false, message: 'School not resolved from token' });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(parseInt(req.query.pageSize, 10) || 50, 100);
    const skip = (page - 1) * pageSize;

    // Only scope by school through class relation
    const where = {
      class: { is: { schoolId: Number(schoolId) } }
    };

    const [total, assessments] = await Promise.all([
      prisma.continuousAssessment.count({ where }),
      prisma.continuousAssessment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          classId: true,
          subjectId: true,
          name: true,
          maxScore: true,
          createdAt: true,
          class: {
            select: {
              id: true,
              name: true,
              campusId: true,
              campus: { select: { id: true, name: true } }
            }
          },
          subject: { select: { id: true, name: true, code: true } }
        }
      })
    ]);

    return res.json({
      success: true,
      total,
      page,
      pageSize,
      count: assessments.length,
      assessments
    });
  } catch (err) {
    next(err);
  }
};

exports.getOverview = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    if (!schoolId) return res.status(400).json({ message: "School ID required" });

    const sid = Number(schoolId);

    // Run all DB queries in parallel — much faster than sequential awaits
    const [
      totalStudents,
      boysCount,
      girlsCount,
      totalStaff,
      totalCampuses,
      recentExams,
      activeSession
    ] = await Promise.all([
      prisma.student.count({ where: { schoolId: sid } }),
      prisma.student.count({ where: { schoolId: sid, gender: "Male" } }),
      prisma.student.count({ where: { schoolId: sid, gender: "Female" } }),
      prisma.staff.count({ where: { schoolId: sid } }),
      prisma.campus.count({ where: { schoolId: sid } }),
      prisma.exam.findMany({
        where: { class: { schoolId: sid } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          name: true,
          createdAt: true,
          class: { select: { name: true, customName: true } },
          subject: { select: { name: true } }
        }
      }),
      prisma.academicSession.findFirst({
        where: { schoolId: sid, isActive: true },
        select: {
          id: true,
          name: true,
          terms: {
            where: { isActive: true },
            select: { id: true, name: true }
          }
        }
      })
    ]);

    // Compute gender percentages
    const totalGender = boysCount + girlsCount;
    const boysPercent = totalGender > 0 ? Math.round((boysCount / totalGender) * 100) : 0;
    const girlsPercent = totalGender > 0 ? 100 - boysPercent : 0;

    return res.status(200).json({
      success: true,
      data: {
        students: {
          total: totalStudents,
          boys: boysPercent,   // percentage
          girls: girlsPercent
        },
        staff: { total: totalStaff },
        campuses: { total: totalCampuses },
        bill: null,   // v2 — no billing model yet
        upcomingExams: recentExams,
        activeSession: activeSession
          ? { id: activeSession.id, name: activeSession.name }
          : null,
        activeTerm: activeSession?.terms[0] ?? null,
        noticeBoard: null  // v2
      }
    });
  } catch (error) {
    next(error);
  }
};
