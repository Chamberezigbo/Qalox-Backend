const prisma = require('../../util/prisma');
const { classTeacherProblem } = require('../../util/classTeacher');
const { createNotification } = require('../../util/notify');
const campusScope = require('../../util/campusScope');

// ✅ Create a new class
exports.createClass = async (req, res, next) => {
       try {
     
         const { name, campusId, customName, department } = req.body;
         const schoolId = req.schoolId; // ✅ from middleware auth

         // A restricted admin creates classes only in their own campuses; a class with no
         // campus would belong to nobody they can reach.
         if (campusScope.isRestricted(req) && (campusId == null || campusId === '')) {
           return res.status(403).json({ success: false, message: "Choose one of your campuses for this class" });
         }
         campusScope.assertCampusAllowed(req, campusId);
         if (campusId != null && campusId !== '') {
           const campus = await prisma.campus.findFirst({ where: { id: Number(campusId), schoolId }, select: { id: true } });
           if (!campus) return res.status(404).json({ success: false, message: "Campus not found" });
         }

         // The class teacher is optional at creation; when given it must be a real teacher.
         const staffId = req.body.staffId ? Number(req.body.staffId) : null;
         if (staffId) {
           const problem = await classTeacherProblem(prisma, { schoolId, staffId, campusId: campusId ?? null });
           if (problem) return res.status(400).json({ success: false, message: problem });
         }

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
             department: department ? department : null,
             staffId,
           },
         });

         if (staffId) {
           await createNotification({
             recipientType: 'teacher', recipientId: staffId, schoolId,
             title: 'You are a class teacher',
             message: `You are now the class teacher of ${newClass.name}. Subject teachers will submit their results to you.`,
             type: 'class_teacher', link: '/staff/class-results',
           });
         }
     
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
    campusScope.assertCampusAllowed(req, campusId);

    const classes = await prisma.class.findMany({
      where: campusScope.withScope({
        schoolId,
        ...(campusId && { campusId: Number(campusId) }),
        ...(name && { name: { contains: name,} }),
      }, campusScope.classWhere(req)),
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
         // Within the admin's own school: another school's class reads as not found.
         const existingClass = await prisma.class.findFirst({
           where: campusScope.withScope({ id: Number(classId), schoolId: req.schoolId }, campusScope.classWhere(req)),
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
     
         // A class that past sessions' students were in keeps its history; deleting
         // it would orphan their records. Students who have moved up still count.
         const pastEnrollments = await prisma.studentEnrollment.count({
           where: { classId: Number(classId) },
         });
         if (pastEnrollments > 0) {
           return res.status(400).json({
             success: false,
             message:
               "Cannot delete a class that has had students in it. Its history is kept for their past results.",
           });
         }

         // No class should be left pointing at a class that no longer exists.
         await prisma.class.updateMany({
           where: { schoolId: req.schoolId, promotesToClassId: Number(classId) },
           data: { promotesToClassId: null },
         });

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
     
         // ✅ Ensure the class exists, and is this school's
         const existingClass = await prisma.class.findFirst({
           where: campusScope.withScope({ id: Number(classId), schoolId: req.schoolId }, campusScope.classWhere(req)),
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
     
         // The group's class teacher is optional; when given it must be a real teacher
         // of this school (and of the class's campus).
         const groupTeacherId = req.body.staffId ? Number(req.body.staffId) : null;
         if (groupTeacherId) {
           const problem = await classTeacherProblem(prisma, {
             schoolId: req.schoolId, staffId: groupTeacherId, campusId: existingClass.campusId ?? null,
           });
           if (problem) return res.status(400).json({ success: false, message: problem });
         }

         const newGroup = await prisma.classGroup.create({
           data: {
             classId: Number(classId),
             name,
             staffId: groupTeacherId,
           },
         });

         if (groupTeacherId) {
           await createNotification({
             recipientType: 'teacher', recipientId: groupTeacherId, schoolId: req.schoolId,
             title: 'You are a class teacher',
             message: `You are now the class teacher of ${existingClass.name} — ${name}. Subject teachers will submit their results to you.`,
             type: 'class_teacher', link: '/staff/class-results',
           });
         }
     
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
     
         const where = { ...filters, class: campusScope.withScope({ schoolId: schoolId }, campusScope.classWhere(req)) };

         // ✅ Get total count (for pagination metadata)
         const totalCount = await prisma.classGroup.count({ where });

         // ✅ Fetch groups with pagination
         const groups = await prisma.classGroup.findMany({
           where,
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
     
         // The class teacher's name for each group that has one.
         const teacherIds = [...new Set(groups.map((g) => g.staffId).filter(Boolean))];
         const teachers = teacherIds.length
           ? await prisma.staff.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } })
           : [];
         const teacherBy = new Map(teachers.map((t) => [t.id, t]));
         const groupsWithTeacher = groups.map((g) => ({ ...g, staff: g.staffId ? (teacherBy.get(g.staffId) ?? null) : null }));

         res.status(200).json({
           success: true,
           message: "Class groups retrieved successfully",
           pagination: {
             total: totalCount,
             page: Number(page),
             perPage: Number(limit),
             totalPages: Math.ceil(totalCount / limit),
           },
           groups: groupsWithTeacher,
         });
       } catch (err) {
         next(err);
       }
};

// ✅ Edit Class
exports.updateClass = async (req, res, next) => {
       try {
         const { classId } = req.params;
         const { name, campusId, customName, department } = req.body;

         // Ensure class exists
         const existingClass = await prisma.class.findFirst({
           where: campusScope.withScope({ id: Number(classId), schoolId: req.schoolId }, campusScope.classWhere(req)),
         });

         if (!existingClass) {
           return res.status(404).json({
             success: false,
             message: "Class not found",
           });
         }

         // Moving a class to another campus: the campus is this school's, and (for a
         // restricted admin) one of theirs.
         if (campusId) {
           campusScope.assertCampusAllowed(req, campusId);
           const campus = await prisma.campus.findFirst({ where: { id: Number(campusId), schoolId: req.schoolId }, select: { id: true } });
           if (!campus) return res.status(404).json({ success: false, message: "Campus not found" });
         }

         // staffId: absent leaves the class teacher alone, null removes them, a
         // number assigns one (checked: a teacher of this school and campus).
         let staffUpdate = {};
         let newTeacherId = null;
         if (req.body.staffId === null || req.body.staffId === '') {
           staffUpdate = { staffId: null };
         } else if (req.body.staffId !== undefined) {
           newTeacherId = Number(req.body.staffId);
           if (!Number.isInteger(newTeacherId) || newTeacherId < 1) {
             return res.status(400).json({ success: false, message: 'Invalid class teacher' });
           }
           const problem = await classTeacherProblem(prisma, {
             schoolId: req.schoolId, staffId: newTeacherId,
             campusId: campusId ?? existingClass.campusId ?? null,
           });
           if (problem) return res.status(400).json({ success: false, message: problem });
           staffUpdate = { staffId: newTeacherId };
         }

         // Update class
         const updatedClass = await prisma.class.update({
           where: { id: Number(classId) },
           data: {
             ...(name && { name }),
             ...(campusId && { campusId }),
             ...(customName && { customName: customName }),
             ...(department !== undefined && { department: department || null }),
             ...staffUpdate,
           },
         });

         if (newTeacherId && newTeacherId !== existingClass.staffId) {
           await createNotification({
             recipientType: 'teacher', recipientId: newTeacherId, schoolId: req.schoolId,
             title: 'You are a class teacher',
             message: `You are now the class teacher of ${updatedClass.name}. Subject teachers will submit their results to you.`,
             type: 'class_teacher', link: '/staff/class-results',
           });
         }
     
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
     
         // Ensure group exists, in this school's class
         const existingGroup = await prisma.classGroup.findFirst({
           where: { id: Number(groupId), class: campusScope.withScope({ schoolId: req.schoolId }, campusScope.classWhere(req)) },
           include: { class: { select: { schoolId: true, name: true, campusId: true } } },
         });
     
         if (!existingGroup) {
           return res.status(404).json({
             success: false,
             message: "Class group not found",
           });
         }
     
         // Optional: Ensure class exists if classId is being updated
         if (classId) {
           const classExists = await prisma.class.findFirst({
             where: campusScope.withScope({ id: Number(classId), schoolId: req.schoolId }, campusScope.classWhere(req)),
           });
           if (!classExists) {
             return res.status(400).json({
               success: false,
               message: "Invalid classId. Class does not exist.",
             });
           }
         }
     
         // staffId: absent leaves the group's class teacher alone, null removes them, a
         // number assigns one (a teacher of this school and of the class's campus).
         let staffUpdate = {};
         let newTeacherId = null;
         if (req.body.staffId === null || req.body.staffId === '') {
           staffUpdate = { staffId: null };
         } else if (req.body.staffId !== undefined) {
           newTeacherId = Number(req.body.staffId);
           if (!Number.isInteger(newTeacherId) || newTeacherId < 1) {
             return res.status(400).json({ success: false, message: 'Invalid class teacher' });
           }
           const problem = await classTeacherProblem(prisma, {
             schoolId: req.schoolId, staffId: newTeacherId, campusId: existingGroup.class.campusId ?? null,
           });
           if (problem) return res.status(400).json({ success: false, message: problem });
           staffUpdate = { staffId: newTeacherId };
         }

         // Update class group
         const updatedGroup = await prisma.classGroup.update({
           where: { id: Number(groupId) },
           data: {
             ...(name && { name }),
             ...(classId && { classId: Number(classId) }),
             ...staffUpdate,
           },
           include: {
             class: { select: { id: true, name: true } },
           },
         });
     
         if (newTeacherId && newTeacherId !== existingGroup.staffId) {
           await createNotification({
             recipientType: 'teacher', recipientId: newTeacherId, schoolId: req.schoolId,
             title: 'You are a class teacher',
             message: `You are now the class teacher of ${existingGroup.class.name} — ${updatedGroup.name}. Subject teachers will submit their results to you.`,
             type: 'class_teacher', link: '/staff/class-results',
           });
         }

         res.status(200).json({
           success: true,
           message: "Class group updated successfully",
           group: updatedGroup,
         });
       } catch (err) {
         next(err);
       }
};
     
     