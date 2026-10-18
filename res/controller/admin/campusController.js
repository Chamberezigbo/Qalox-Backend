const prisma = require("../../util/prisma");
const campusScope = require("../../util/campusScope");
const r2Service = require("../../Services/R2Service");
const { processImageToBuffer, extractDominantColor } = require("../../config/compress");
const { schoolMediaUrl } = require("../public/publicController");

/** Stored media keys turned into links the browser can load. */
const withMediaUrls = async (campus) => ({
  ...campus,
  logoUrl: await schoolMediaUrl(campus.logoUrl),
  stampUrl: await schoolMediaUrl(campus.stampUrl),
});

// ✅ Create a new campus
exports.createCampus = async (req, res, next) => {
       try {
         const { name, address, phoneNumber, email } = req.body;
         const {schoolId} = req;

         // A new campus would belong to nobody a restricted admin can reach.
         if (campusScope.isRestricted(req)) {
           return res.status(403).json({ success: false, message: "Only the head admin can add a campus" });
         }
     
         // Check if campus with same name exists in same school
         const existing = await prisma.campus.findFirst({
           where: { schoolId, name },
         });
     
         if (existing) {
           return res.status(400).json({
             success: false,
             message: "A campus with this name already exists for this school",
           });
         }
     
         const campus = await prisma.campus.create({
           data: {
             schoolId,
             name,
             address,
             phoneNumber,
             email,
           },
         });
     
         res.status(201).json({
           success: true,
           message: "Campus created successfully",
           campus,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ Edit campus
exports.updateCampus = async (req, res, next) => {
       try {
         const { campusId } = req.params;
         const { name, address, phoneNumber, email, revenueTarget } = req.body;

         // This school's, and (for a restricted admin) one of theirs: otherwise not found.
         const existing = await prisma.campus.findFirst({
           where: {
             id: Number(campusId),
             schoolId: req.schoolId,
             ...(campusScope.isRestricted(req) ? { id: { in: req.campusIds.filter((id) => id === Number(campusId)) } } : {}),
           },
         });

         if (!existing) {
           return res.status(404).json({
             success: false,
             message: "Campus not found",
           });
         }

         const campus = await prisma.campus.update({
           where: { id: Number(campusId) },
           data: {
             ...(name && { name }),
             ...(address && { address }),
             ...(phoneNumber && { phoneNumber }),
             ...(email && { email }),
             ...(revenueTarget !== undefined && { revenueTarget: revenueTarget === null ? null : Number(revenueTarget) }),
           },
         });
     
         res.status(200).json({
           success: true,
           message: "Campus updated successfully",
           campus,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ View campuses (with filters + pagination)
exports.getCampuses = async (req, res, next) => {
       try {
         const { name, page = 1, limit = 10 } = req.query;
         const { schoolId } = req;
     
         const where = {
           ...(campusScope.isRestricted(req) && { id: { in: req.campusIds } }),
           ...(schoolId && { schoolId: Number(schoolId) }),
           ...(name && {
             name: { contains: name,}, // search by name
           }),
         };
     
         const campuses = await prisma.campus.findMany({
           where,
           skip: (page - 1) * limit,
           take: Number(limit),
           orderBy: { createdAt: "desc" },
           include: {
             school: { select: { id: true, name: true } },
             _count: {
               select: {
                 Class: true,
                 Staff: true,
                 Student: true,
               },
             },
           },
         });
     
         const total = await prisma.campus.count({ where });
         const withLinks = await Promise.all(campuses.map(withMediaUrls));
     
         res.status(200).json({
           success: true,
           total,
           page: Number(page),
           pages: Math.ceil(total / limit),
           campuses: withLinks,
         });
       } catch (err) {
         next(err);
       }
};

const ASSIGNABLE = {
  staff: (schoolId) => ({ model: prisma.staff, where: { schoolId, campusId: null } }),
  classes: (schoolId) => ({ model: prisma.class, where: { schoolId, campusId: null } }),
  subjects: (schoolId) => ({ model: prisma.subject, where: { schoolId, campusId: null } }),
  // A student takes their class's campus, so only those whose class has none need tagging.
  students: (schoolId) => ({ model: prisma.student, where: { schoolId, campusId: null, class: { campusId: null } } }),
};

// ✅ GET /campus/untagged — how many records belong to no campus yet (owner only).
exports.getUntaggedRecords = async (req, res, next) => {
  try {
    const counts = {};
    for (const [type, build] of Object.entries(ASSIGNABLE)) {
      const { model, where } = build(req.schoolId);
      counts[type] = await model.count({ where });
    }
    res.status(200).json({ success: true, data: counts });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ POST /campus/:campusId/assign-records (owner only)
 * Body: { types: ["staff","classes","subjects","students"] }
 * Tags every record of those types that has no campus with this campus, so a campus
 * sub-admin can see it. Records that already have a campus are never touched.
 */
exports.assignUntaggedRecords = async (req, res, next) => {
  try {
    const campus = await prisma.campus.findFirst({
      where: { id: Number(req.params.campusId), schoolId: req.schoolId },
      select: { id: true },
    });
    if (!campus) return res.status(404).json({ success: false, message: "Campus not found" });

    const types = Array.isArray(req.body?.types) ? req.body.types.filter((t) => t in ASSIGNABLE) : [];
    if (types.length === 0) {
      return res.status(400).json({ success: false, message: "Choose what to assign: staff, classes, subjects or students" });
    }

    const assigned = {};
    for (const type of types) {
      const { model, where } = ASSIGNABLE[type](req.schoolId);
      const { count } = await model.updateMany({ where, data: { campusId: campus.id } });
      assigned[type] = count;
    }
    res.status(200).json({ success: true, message: "Records assigned to the campus", data: assigned });
  } catch (err) {
    next(err);
  }
};


/**
 * ✅ PATCH /campus/:campusId/branding (multipart: logoUrl and/or stampUrl)
 * A campus's own logo and stamp, used on its report cards, receipts and emails. A
 * restricted sub-admin can change only their own campus's.
 */
exports.updateCampusBranding = async (req, res, next) => {
  try {
    const campusId = Number(req.params.campusId);
    campusScope.assertCampusAllowed(req, campusId);
    const campus = await prisma.campus.findFirst({
      where: { id: campusId, schoolId: req.schoolId },
      select: { id: true, logoUrl: true, stampUrl: true },
    });
    if (!campus) return res.status(404).json({ success: false, message: "Campus not found" });

    const files = req.files || {};
    const logoFile = files.logoUrl?.[0];
    const stampFile = files.stampUrl?.[0];
    if (!logoFile && !stampFile) {
      return res.status(400).json({ success: false, message: "Provide a new logo and/or stamp to upload" });
    }

    const school = await prisma.school.findUnique({ where: { id: req.schoolId }, select: { prefix: true } });
    const data = {};

    if (logoFile) {
      const [processed, brandColor] = await Promise.all([processImageToBuffer(logoFile.buffer), extractDominantColor(logoFile.buffer)]);
      const key = campus.logoUrl?.startsWith("r2:") ? campus.logoUrl.slice(3) : `logos/${school.prefix}-campus-${campus.id}-logo.jpeg`;
      await r2Service.uploadObject({ buffer: processed.buffer, key, contentType: processed.contentType });
      data.logoUrl = `r2:${key}`;
      data.brandColor = brandColor;
    }
    if (stampFile) {
      const processed = await processImageToBuffer(stampFile.buffer);
      const key = campus.stampUrl?.startsWith("r2:") ? campus.stampUrl.slice(3) : `stamps/${school.prefix}-campus-${campus.id}-stamp.jpeg`;
      await r2Service.uploadObject({ buffer: processed.buffer, key, contentType: processed.contentType });
      data.stampUrl = `r2:${key}`;
    }

    const updated = await prisma.campus.update({ where: { id: campus.id }, data });
    res.status(200).json({
      success: true,
      message: "Campus branding updated",
      data: { logoUrl: await schoolMediaUrl(updated.logoUrl), stampUrl: await schoolMediaUrl(updated.stampUrl), brandColor: updated.brandColor },
    });
  } catch (err) {
    next(err);
  }
};
