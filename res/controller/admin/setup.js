const prisma = require("../../util/prisma");
const {
  classSchema,
  campusSchema,
} = require("../../schemas/setupSchema");


const { incrementAdminStep } = require("../../util/adminStep");

exports.createClasses = async (req, res, next) => {

  const adminId = req.user.id;

  const { school_id, classes } = req.body;

  if (!school_id || typeof school_id !== "number") {
    return res.status(400).json({ message: "A valid school_id is required." });
  }

  if (!Array.isArray(classes) || classes.length === 0) {
    return res
      .status(400)
      .json({ message: "Expected a non-empty array of classes." });
  }

  for (const classData of classes) {
    const { error } = classSchema.validate(classData);
    if (error) {
      return res.status(400).json({ message: error.details[0].message });
    }
  }

  try {
    // Step 1: Confirm school exists
    const existingSchool = await prisma.school.findUnique({
      where: { id: school_id },
    });

    if (!existingSchool) {
      return res
        .status(400)
        .json({ message: "Invalid school_id. No such school exists." });
    }

    // Step 2: Check if any class already assigned to the school
    const existingClasses = await prisma.class.findFirst({
      where: { schoolId: school_id },
    });

    if (existingClasses) {
      return res.status(400).json({
        message: "Classes have already been assigned to this school.",
      });
    }

    // Step 3: Fetch all campuses under this school
    const campuses = await prisma.campus.findMany({
      where: { schoolId: school_id },
      select: { id: true },
    });

    if (!campuses.length) {
      return res.status(400).json({
        message: "No campuses found for this school to assign classes to.",
      });
    }

    // Step 4: Prepare the classes to assign across campuses
    const classDataToInsert = [];

    for (const campus of campuses) {
      for (const classItem of classes) {
        classDataToInsert.push({
          schoolId: school_id,
          campusId: campus.id,
          name: classItem.name,
        });
      }
    }

    // Step 5: Bulk insert
    const result = await prisma.class.createMany({
      data: classDataToInsert,
    });

    // Fetch all classes for this school (across campuses)
    const savedClasses = await prisma.class.findMany({
      where: { schoolId: school_id },
    });

    const step = await incrementAdminStep(adminId);

    res.status(201).json({
      message: `${result.count} classes created successfully across campuses.`,
      count: result.count,
      data: { savedClasses },
      step,
    });
  } catch (error) {
    next(error);
  }
};

exports.createCampuses = async (req, res, next) => {
  const { school_id, campuses } = req.body;
  const adminId = req.user.id;

  if (!school_id || typeof school_id !== "number") {
    return res.status(400).json({ message: "A valid school_id is required." });
  }

  if (!Array.isArray(campuses) || campuses.length === 0) {
    return res
      .status(400)
      .json({ message: "Expected a non-empty array of campuses." });
  }

  try {
    const existingSchool = await prisma.school.findUnique({
      where: { id: school_id },
    });

    if (!existingSchool) {
      return res
        .status(400)
        .json({ message: "Invalid school_id. No such school exists." });
    }

    // 2. Check for duplicate names within the request
    const seenNames = new Set();
    for (const campus of campuses) {
      if (seenNames.has(campus.name.toLowerCase())) {
        return res.status(400).json({
          message: `Duplicate campus name '${campus.name}' found in request.`,
        });
      }
      seenNames.add(campus.name.toLowerCase());
    }

    // 3. Get existing campus names from DB for that school
    const existingCampusNames = await prisma.campus.findMany({
      where: { schoolId: school_id },
      select: { name: true },
    });

    const existingNamesSet = new Set(
      existingCampusNames.map((c) => c.name.toLowerCase())
    );

    // 4. Filter out campus names that already exist in the DB
    const filteredCampuses = campuses.filter(
      (c) => !existingNamesSet.has(c.name.toLowerCase())
    );

    if (filteredCampuses.length === 0) {
      return res.status(400).json({
        message: "All provided campus names already exist for this school.",
      });
    }

    const campusDataToInsert = [];

    for (const campus of filteredCampuses) {
      const { error } = campusSchema.validate(campus);
      if (error) {
        return res.status(400).json({ message: error.details[0].message });
      }

      campusDataToInsert.push({
        schoolId: school_id,
        name: campus.name,
        address: campus.address || null,
        phoneNumber: campus.phoneNumber || null,
        email: campus.email || null,
      });
    }

    // 6. Insert
    const result = await prisma.campus.createMany({
      data: campusDataToInsert,
    });

    // Fetch all campuses for this school
    const savedCampuses = await prisma.campus.findMany({
      where: { schoolId: school_id },
    });

    const step = await incrementAdminStep(adminId);

    res.status(201).json({
      message: `${result.count} campuses created successfully.`,
      count: result.count,
      date: { savedCampuses },
      step,
    });
  } catch (err) {
    next(err);
  }
};

