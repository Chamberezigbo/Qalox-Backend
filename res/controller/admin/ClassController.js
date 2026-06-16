const prisma = require('../../util/prisma');

// ✅ Create a new class
exports.createClass = async (req, res, next) => {
       try {
     
         const { name, campusId, customName, } = req.body;
         const schoolId = req.schoolId; // ✅ from middleware auth
     
         // Check for duplicate class name for same school + campus
         const existingClass = await prisma.class.findFirst({
           where: { schoolId, name, campusId: campusId ?? null },
         });
     
         if (existingClass) {
           return res.status(409).json({
             success: false,
             message: "Class with this name already exists for this school/campus.",
           });
         }
     
         const newClass = await prisma.class.create({
           data: {
             name,
             campusId: campusId ?? null,
             schoolId,
             // Save custom class name if provided
             customName: customName ? customName : null,
           },
         });
     
         return res.status(201).json({
           success: true,
           message: "Class created successfully",
           class: newClass,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ Get all classes with optional filters
exports.getAllClasses = async (req, res, next) => {
  try {
    const { campusId, name } = req.query;
    const schoolId = req.schoolId;

    const classes = await prisma.class.findMany({
      where: {
        schoolId,
        ...(campusId && { campusId: Number(campusId) }),
        ...(name && { name: { contains: name,} }),
      },
      include: {
        campus: {
          select: {
            id: true,
            name: true,
          },
        },
        staff: true,
        students: true,
        classGroups: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    res.status(200).json({
      success: true,
      count: classes.length,
      classes,
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteClass = async (req, res, next) => {
       try {
         const { classId } = req.params;
     
         // Ensure class exists
         const existingClass = await prisma.class.findUnique({
           where: { id: Number(classId) },
           include: { students: true, assignments: true },
         });
     
         if (!existingClass) {
           return res.status(404).json({ success: false, message: "Class not found" });
         }
     
         if (existingClass.students.length > 0) {
           return res.status(400).json({
             success: false,
             message: "Cannot delete class with enrolled students.",
           });
         }
     
         // Remove teacher assignments first
         await prisma.teacherAssignment.deleteMany({
           where: { classId: Number(classId) },
         });
     
         // Delete the class
         await prisma.class.delete({
           where: { id: Number(classId) },
         });
     
         res.status(200).json({
           success: true,
           message: "Class deleted successfully",
         });
       } catch (err) {
         next(err);
       }
};

// ✅ Create a new class group
exports.createClassGroup = async (req, res, next) => {
       try {
     
         const { classId, name } = req.body;
     
         // ✅ Ensure the class exists
         const existingClass = await prisma.class.findUnique({
           where: { id: Number(classId) },
         });
     
         if (!existingClass) {
           return res.status(404).json({
             success: false,
             message: "Class not found",
           });
         }
     
         // ✅ Check if group name already exists in this class
         const existingGroup = await prisma.classGroup.findFirst({
           where: {
             classId: Number(classId),
             name: name,
           },
         });
     
         if (existingGroup) {
           return res.status(409).json({
             success: false,
             message: "Group with this name already exists in this class",
           });
         }
     
         const newGroup = await prisma.classGroup.create({
           data: {
             classId: Number(classId),
             name,
           },
         });
     
         res.status(201).json({
           success: true,
           message: "Class group created successfully",
           group: newGroup,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ View all class groups with optional filtering & pagination
exports.getClassGroups = async (req, res, next) => {
       try {
         const { page = 1, limit = 10, classId } = req.query;
         const schoolId = req.schoolId;
     
         // ✅ Build filter dynamically
         const filters = {};
         if (classId) filters.classId = Number(classId);
     
         // ✅ Get total count (for pagination metadata)
         const totalCount = await prisma.classGroup.count({ where: filters });
     
         // ✅ Fetch groups with pagination
         const groups = await prisma.classGroup.findMany({
           where: {
            ...filters, class: {
              schoolId:schoolId
            }

           },
           skip: (page - 1) * limit,
           take: Number(limit),
           orderBy: { createdAt: "desc" },
           include: {
             class: {
               select: {
                 id: true,
                 name: true,
               },
             },
           },
         });
     
         res.status(200).json({
           success: true,
           message: "Class groups retrieved successfully",
           pagination: {
             total: totalCount,
             page: Number(page),
             perPage: Number(limit),
             totalPages: Math.ceil(totalCount / limit),
           },
           groups,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ Edit Class
exports.updateClass = async (req, res, next) => {
       try {
         const { classId } = req.params;
         const { name, campusId, customName, } = req.body;
     
         // Ensure class exists
         const existingClass = await prisma.class.findUnique({
           where: { id: Number(classId) },
         });
     
         if (!existingClass) {
           return res.status(404).json({
             success: false,
             message: "Class not found",
           });
         }
     
         // Update class
         const updatedClass = await prisma.class.update({
           where: { id: Number(classId) },
           data: {
             ...(name && { name }),
             ...(campusId && { campusId }),
             ...(customName && { customName: customName }),
           },
         });
     
         res.status(200).json({
           success: true,
           message: "Class updated successfully",
           class: updatedClass,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ Edit Class Group
exports.updateClassGroup = async (req, res, next) => {
       try {
         const { groupId } = req.params;
         const { name, classId } = req.body;
     
         // Ensure group exists
         const existingGroup = await prisma.classGroup.findUnique({
           where: { id: Number(groupId) },
         });
     
         if (!existingGroup) {
           return res.status(404).json({
             success: false,
             message: "Class group not found",
           });
         }
     
         // Optional: Ensure class exists if classId is being updated
         if (classId) {
           const classExists = await prisma.class.findUnique({
             where: { id: Number(classId) },
           });
           if (!classExists) {
             return res.status(400).json({
               success: false,
               message: "Invalid classId. Class does not exist.",
             });
           }
         }
     
         // Update class group
         const updatedGroup = await prisma.classGroup.update({
           where: { id: Number(groupId) },
           data: {
             ...(name && { name }),
             ...(classId && { classId: Number(classId) }),
           },
           include: {
             class: { select: { id: true, name: true } },
           },
         });
     
         res.status(200).json({
           success: true,
           message: "Class group updated successfully",
           group: updatedGroup,
         });
       } catch (err) {
         next(err);
       }
};
     
     