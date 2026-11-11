const prisma = require("../../util/prisma");
const campusScope = require("../../util/campusScope");
const { groupNamingSystems, planRename, cleanPrefix, buildName } = require("../../util/classNaming");

const MAX_PREFIX = 60;
const MAX_LEVELS = 30;

// The naming systems in use, read from the class names this admin can see.
exports.list = async (req, res, next) => {
  try {
    const classes = await prisma.class.findMany({
      where: campusScope.withScope({ schoolId: req.schoolId }, campusScope.classWhere(req)),
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    res.json({ success: true, data: groupNamingSystems(classes) });
  } catch (error) {
    next(error);
  }
};

// Renames a naming system ("Primary" -> "Grade") on every class in it. With
// `preview: true` it only reports what would change.
exports.rename = async (req, res, next) => {
  try {
    const from = cleanPrefix(req.body.from);
    const to = cleanPrefix(req.body.to);
    if (!from || !to) return res.status(400).json({ success: false, message: "Give the current name and the new name" });
    if (to.length > MAX_PREFIX) return res.status(400).json({ success: false, message: `The new name must be ${MAX_PREFIX} characters or fewer` });
    if (/\d$/.test(to)) {
      return res.status(400).json({ success: false, message: "The name should not end with a number: the class number is added automatically (Grade -> Grade 1)" });
    }
    if (from === to) return res.status(400).json({ success: false, message: "The new name is the same as the current one" });

    const [everyClass, editable] = await Promise.all([
      prisma.class.findMany({ where: { schoolId: req.schoolId }, select: { id: true, name: true, campusId: true } }),
      prisma.class.findMany({
        where: campusScope.withScope({ schoolId: req.schoolId }, campusScope.classWhere(req)),
        select: { id: true },
      }),
    ]);

    const { changes, conflicts } = planRename(everyClass, editable.map((c) => c.id), from, to);
    if (changes.length === 0) return res.status(404).json({ success: false, message: `No classes are named "${from} <number>"` });
    if (conflicts.length > 0) {
      const names = [...new Set(conflicts.map((c) => c.to))].slice(0, 5).join(", ");
      return res.status(409).json({ success: false, message: `These names are already used by other classes: ${names}`, conflicts });
    }

    if (req.body.preview) return res.json({ success: true, data: { preview: true, changes } });

    await prisma.$transaction(changes.map((c) => prisma.class.update({ where: { id: c.id }, data: { name: c.to } })));
    res.json({ success: true, message: `${changes.length} class(es) renamed`, data: { preview: false, changes } });
  } catch (error) {
    next(error);
  }
};

// Adds a new naming system: "Grade" levels 1 to 6 creates Grade 1 ... Grade 6 (skipping any that exist).
exports.addSystem = async (req, res, next) => {
  try {
    const prefix = cleanPrefix(req.body.name);
    const start = Number(req.body.start);
    const end = Number(req.body.end);
    const campusId = req.body.campusId === undefined || req.body.campusId === "" ? null : Number(req.body.campusId);

    if (!prefix || prefix.length > MAX_PREFIX || /\d$/.test(prefix)) {
      return res.status(400).json({ success: false, message: "Give a name without a number at the end, e.g. Grade" });
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start + 1 > MAX_LEVELS) {
      return res.status(400).json({ success: false, message: `Levels must be whole numbers, from 1, with the end not below the start (at most ${MAX_LEVELS} classes)` });
    }
    if (campusScope.isRestricted(req) && campusId == null) {
      return res.status(403).json({ success: false, message: "Choose one of your campuses" });
    }
    campusScope.assertCampusAllowed(req, campusId);
    if (campusId != null) {
      const campus = await prisma.campus.findFirst({ where: { id: campusId, schoolId: req.schoolId }, select: { id: true } });
      if (!campus) return res.status(404).json({ success: false, message: "Campus not found" });
    }

    const wanted = [];
    for (let level = start; level <= end; level++) wanted.push(buildName(prefix, level));
    const existing = await prisma.class.findMany({
      where: { schoolId: req.schoolId, campusId, name: { in: wanted } },
      select: { name: true },
    });
    const have = new Set(existing.map((c) => c.name));
    const toCreate = wanted.filter((n) => !have.has(n));
    if (toCreate.length === 0) return res.status(409).json({ success: false, message: "All of these classes already exist" });

    await prisma.class.createMany({ data: toCreate.map((name) => ({ schoolId: req.schoolId, campusId, name })) });
    res.status(201).json({ success: true, message: `${toCreate.length} class(es) created`, data: { created: toCreate, skipped: [...have] } });
  } catch (error) {
    next(error);
  }
};
