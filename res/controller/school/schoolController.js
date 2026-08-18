// controllers/schoolController.js
const processImage = require("../../config/compress");
const { processImageToBuffer } = require("../../config/compress");
const r2Service = require("../../Services/R2Service");
const { schoolMediaUrl } = require("../public/publicController");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

const { incrementAdminStep } = require("../../util/adminStep");

/**
 * Link a freshly created School back to the marketer who referred it.
 *
 * The chain is exact, not a guess:
 *   Admin.email  →  Token.uniqueKey  →  SchoolToken.code  →  SchoolToken.marketerId
 *
 * Registration validates a `Token` row by email, and a marketer-issued token
 * writes the same code into both `Token.uniqueKey` and `SchoolToken.code` (see
 * createSchoolToken). So if no SchoolToken carries that code, the school was
 * onboarded by the Super Admin Portal and there is no marketer to credit.
 *
 * Sets MarketerSchoolLead.schoolId, which is the join the payment webhook uses
 * to award commission. Without it every marketer earns nothing.
 *
 * Returns the lead id when attribution happened, otherwise null. Never throws —
 * a back-office attribution problem must not fail a school's onboarding.
 */
const attributeSchoolToMarketer = async (adminId, school) => {
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: { email: true },
    });
    if (!admin) return null;

    const registrationToken = await prisma.token.findUnique({
      where: { email: admin.email },
      select: { uniqueKey: true },
    });
    if (!registrationToken) return null;

    const schoolToken = await prisma.schoolToken.findUnique({
      where: { code: registrationToken.uniqueKey },
      select: { marketerId: true },
    });
    if (!schoolToken) return null; // Super Admin-issued token — nobody to credit

    // The marketer may already track this school as a manual lead
    // (POST /api/public/marketer-schools). Link that row rather than creating a
    // duplicate their dashboard would list twice.
    const existingLead = await prisma.marketerSchoolLead.findFirst({
      where: { marketerId: schoolToken.marketerId, schoolId: null, email: admin.email },
      select: { id: true },
    });

    const lead = existingLead
      ? await prisma.marketerSchoolLead.update({
          where: { id: existingLead.id },
          data: { schoolId: school.id, status: "active" },
        })
      : await prisma.marketerSchoolLead.create({
          data: {
            marketerId: schoolToken.marketerId,
            schoolId: school.id,
            name: school.name,
            email: admin.email,
            status: "active",
          },
        });

    logger.info("[ATTRIBUTE_SCHOOL] School attributed to marketer", {
      schoolId: school.id,
      marketerId: schoolToken.marketerId,
      leadId: lead.id,
      linkedExistingLead: Boolean(existingLead),
    });

    return lead.id;
  } catch (err) {
    // Loud, because a silent miss here means a marketer is never paid.
    logger.error("[ATTRIBUTE_SCHOOL] Failed to attribute school to marketer", {
      schoolId: school?.id,
      adminId,
      error: err.message,
    });
    return null;
  }
};

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
    // Process images in memory, then upload to R2 (private bucket) — the
    // stored value is `r2:<object key>`, never a public URL. schoolMediaUrl()
    // turns this into a fresh presigned GET URL whenever the school is read.
    const [processedLogo, processedStamp] = await Promise.all([
      processImageToBuffer(files.logoUrl[0].buffer),
      processImageToBuffer(files.stampUrl[0].buffer),
    ]);

    const logoKey = `logos/${finalPrefix}-logo.jpeg`;
    const stampKey = `stamps/${finalPrefix}-stamp.jpeg`;

    await Promise.all([
      r2Service.uploadObject({ buffer: processedLogo.buffer, key: logoKey, contentType: processedLogo.contentType }),
      r2Service.uploadObject({ buffer: processedStamp.buffer, key: stampKey, contentType: processedStamp.contentType }),
    ]);

    const newSchool = await prisma.school.create({
      data: {
        name,
        prefix: finalPrefix,
        logoUrl: `r2:${logoKey}`,
        stampUrl: `r2:${stampKey}`,
        email,
        phoneNumber,
        address,
      },
    });

    const updatedAdmin = await prisma.admin.update({
      where: { id: req.user.id },
      data: { schoolId: newSchool.id },
    });

    // Credit the referring marketer, if this school arrived via a marketer token.
    await attributeSchoolToMarketer(adminId, newSchool);

    await incrementAdminStep(adminId);

    const [logo, stamp] = await Promise.all([
      schoolMediaUrl(newSchool.logoUrl),
      schoolMediaUrl(newSchool.stampUrl),
    ]);

    return res.status(201).json({
      message: "School created successfully",
      school: { ...newSchool, logoUrl: logo, stampUrl: stamp },
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

    // No `mode: 'insensitive'` — the datasource is MySQL, for which Prisma does
    // not generate QueryMode, so passing it is a validation error at runtime
    // (this endpoint returned 500 for any ?search=). MySQL's default collation
    // is already case-insensitive.
    const where = search ? { name: { contains: search } } : {};

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

    const data = await Promise.all(
      schools.map(async (s) => ({
        ...s,
        logoUrl: await schoolMediaUrl(s.logoUrl),
        stampUrl: await schoolMediaUrl(s.stampUrl),
      }))
    );

    return res.status(200).json({
      success: true,
      data,
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
          select: { Student: true, Class: true },
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

    const [logo, stamp] = await Promise.all([
      schoolMediaUrl(school.logoUrl),
      schoolMediaUrl(school.stampUrl),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        ...school,
        logoUrl: logo,
        stampUrl: stamp,
        totalStudents: school._count.Student,
        totalClasses: school._count.Class,
        activeSession,
      },
    });
  } catch (error) {
    next(error);
  }
};
