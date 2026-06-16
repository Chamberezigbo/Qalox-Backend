// controllers/schoolController.js
const processImage = require("../../config/compress");
const prisma = require("../../util/prisma");

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

    await prisma.admin.update({
      where: { id: req.user.id },
      data: { schoolId: newSchool.id },
    });

    await incrementAdminStep(adminId);

    return res.status(201).json({ 
      message: "School created successfully",
      school: newSchool,
    });
  } catch (error) {
    next(error);
  }

};
