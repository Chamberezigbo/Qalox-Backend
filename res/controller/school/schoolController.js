// controllers/schoolController.js
const processImage = require("../../config/compress");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

const { incrementAdminStep } = require("../../util/adminStep");

// Normalize to 4 uppercase alphanumeric chars
const normalizePrefix = (value) =>
  (value || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);

/** Generate from school name (first letters) then random fallback */
const generatePrefixFromName = (name) => {
  if (!name) return "SCHL";
  const parts = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const initials = parts.map((p) => p[0]).join("").slice(0, 4);
  if (initials.length === 4) return initials;
  const base = (initials + parts.join("")).slice(0, 4);
  return base.padEnd(4, "X"); // pad if too short
};

const ensureUniquePrefix = async (base) => {
  let candidate = normalizePrefix(base);
  if (candidate.length < 4) {
    candidate = (candidate + "XXXX").slice(0, 4);
  }

  // If exists, try random variations
  const exists = await prisma.school.findFirst({
    where: { prefix: candidate },
    select: { id: true },
  });
  if (!exists) return candidate;

  for (let i = 0; i < 25; i++) {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
    candidate = randomSuffix; // purely numeric 4-digit fallback
    const taken = await prisma.school.findFirst({
      where: { prefix: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new Error("Unable to generate unique prefix after multiple attempts.");
};

exports.setupSchool = async (req, res, next) => {
  const adminId = req.user.id;
  
  const { name, prefix, email, phoneNumber, address } = req.body;

  try {
    // Ensure school name uniqueness
    const existingSchool = await prisma.school.findUnique({ where: { name } });
    if (existingSchool) {
      return res.status(409).json({ message: "School already exists" }); // ✅ Already has return
    }

    const files = req.files;
    if (!files || !files.logoUrl || !files.stampUrl) {
      return res // ✅ Already has return
        .status(400)
        .json({ message: "Please upload both logo and stamp" });
    }

    // Decide prefix
    let finalPrefix;
    if (prefix) {
      const normalized = normalizePrefix(prefix);
      if (normalized.length !== 4) {
        return res // ✅ Already has return
          .status(400)
          .json({ message: "Provided prefix must resolve to 4 characters." });
      }
      const taken = await prisma.school.findFirst({
        where: { prefix: normalized },
        select: { id: true },
      });
      if (taken) {
        return res.status(409).json({ message: "Prefix already exists." }); // ✅ Already has return
      }
      finalPrefix = normalized;
    } else {
      const derived = generatePrefixFromName(name);
      finalPrefix = await ensureUniquePrefix(derived);
    }
     // Process images with finalPrefix
    const processedLogoUrl = await processImage(
      files.logoUrl[0].buffer,
      "logos",
      `${finalPrefix}-logo.jpeg`
    );
    const processedStampUrl = await processImage(
      files.stampUrl[0].buffer,
      "stamps",
      `${finalPrefix}-stamp.jpeg`
    );

    const newSchool = await prisma.school.create({
      data: {
        name,
        prefix: finalPrefix,
        logoUrl: processedLogoUrl,
        stampUrl: processedStampUrl,
        email,
        phoneNumber,
        address,
      },
    });

    const updatedAdmin = await prisma.admin.update({
      where: { id: req.user.id },
      data: { schoolId: newSchool.id },
    });

    // If this admin signed up by redeeming a marketer-issued SchoolToken,
    // attribute the newly created school back to that marketer so future
    // payments generate real commission for them. Failure here shouldn't
    // block school creation — it's logged and can be reconciled manually.
    if (updatedAdmin.pendingSchoolTokenId) {
      try {
        const schoolToken = await prisma.schoolToken.findUnique({
          where: { id: updatedAdmin.pendingSchoolTokenId },
        });

        if (schoolToken) {
          const existingLead = await prisma.marketerSchoolLead.findFirst({
            where: { marketerId: schoolToken.marketerId, email: schoolToken.schoolEmail, schoolId: null },
          });

          if (existingLead) {
            await prisma.marketerSchoolLead.update({
              where: { id: existingLead.id },
              data: { schoolId: newSchool.id, status: "active" },
            });
          } else {
            await prisma.marketerSchoolLead.create({
              data: {
                marketerId: schoolToken.marketerId,
                schoolId: newSchool.id,
                name: newSchool.name,
                email: schoolToken.schoolEmail,
                status: "active",
              },
            });
          }
        }

        await prisma.admin.update({
          where: { id: req.user.id },
          data: { pendingSchoolTokenId: null },
        });
      } catch (attributionErr) {
        logger.error("[SETUP_SCHOOL] Failed to attribute school to marketer", {
          schoolId: newSchool.id,
          pendingSchoolTokenId: updatedAdmin.pendingSchoolTokenId,
          error: attributionErr.message,
        });
      }
    }

    await incrementAdminStep(adminId);

    return res.status(201).json({ 
      message: "School created successfully",
      school: newSchool,
    });
  } catch (error) {
    next(error);
  }

};

/**
 * List all schools (for Super Admin & Marketer Portal)
 * GET /api/schools?page=1&limit=20&search=school_name
 */
exports.listSchools = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const search = req.query.search || '';

    const where = search
      ? { name: { contains: search } } // MySQL's default collation is already case-insensitive; `mode` is Postgres-only
      : {};

    const [schools, total] = await Promise.all([
      prisma.school.findMany({
        where,
        select: {
          id: true,
          name: true,
          prefix: true,
          email: true,
          phoneNumber: true,
          address: true,
          logoUrl: true,
          stampUrl: true,
          createdAt: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.school.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: schools,
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
};

/**
 * Get single school details
 * GET /api/schools/:id
 */
exports.getSchool = async (req, res, next) => {
  try {
    const { id } = req.params;

    const school = await prisma.school.findUnique({
      where: { id: parseInt(id) },
      include: {
        campuses: {
          select: { id: true, name: true },
        },
        _count: {
          select: { students: true, classes: true },
        },
      },
    });

    if (!school) {
      return res.status(404).json({
        success: false,
        message: 'School not found',
        code: 'SCHOOL_NOT_FOUND',
      });
    }

    // Get active session
    const activeSession = await prisma.academicSession.findFirst({
      where: { schoolId: parseInt(id), isActive: true },
      select: { id: true, name: true, isActive: true },
    });

    return res.status(200).json({
      success: true,
      data: {
        ...school,
        totalStudents: school._count.students,
        totalClasses: school._count.classes,
        activeSession,
      },
    });
  } catch (error) {
    next(error);
  }
};
