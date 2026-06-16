const prisma = require("../../util/prisma");

// ✅ Create a new subject
exports.createSubject = async (req, res, next) => {
       try {
         const { campusId, name, code } = req.body;

         const {schoolId} = req;
     
         if (!schoolId || !name) {
           return res.status(400).json({
             success: false,
             message: "schoolId and name are required",
           });
         }
     
         // Check for existing subject with same name in same school/campus
         const existing = await prisma.subject.findFirst({
           where: {
             schoolId,
             campusId,
             name: { equals: name},
           },
         });
     
         if (existing) {
           return res.status(400).json({
             success: false,
             message: "A subject with this name already exists for this school/campus",
           });
         }
     
         // Create subject
         const subject = await prisma.subject.create({
           data: {
             schoolId,
             campusId,
             name,
             code,
           },
         });
     
         res.status(201).json({
           success: true,
           message: "Subject created successfully",
           subject,
         });
       } catch (err) {
         next(err);
       }
};


// ✅ View All Subjects (with optional filters)
exports.getAllSubjects = async (req, res, next) => {
  try {
    const { campusId, name } = req.query;

  // schoolId from auth middleware
  const schoolId = req.schoolId;

    const filters = {};
    if (schoolId) filters.schoolId = parseInt(schoolId);
    if (campusId) filters.campusId = parseInt(campusId);
    if (name) filters.name = { contains: name};

    const subjects = await prisma.subject.findMany({
      where: filters,
      orderBy: { createdAt: "desc" },
      include: {
        campus: {
          select: { id: true, name: true },
        },
      },
    });

    res.json({ success: true, count: subjects.length, subjects });
  } catch (err) {
    next(err);
  }
};

// ✅ Edit Subject
exports.editSubject = async (req, res, next) => {
       try {
         const { subjectId } = req.params;
         const { name, code, campusId } = req.body;
     
         const subject = await prisma.subject.findUnique({ where: { id: parseInt(subjectId) } });
         if (!subject) {
           return res.status(404).json({ success: false, message: "Subject not found" });
         }
     
         // Check duplicate name within same school/campus if name is changing
         if (name && name.toLowerCase() !== subject.name.toLowerCase()) {
           const duplicate = await prisma.subject.findFirst({
             where: {
               schoolId: subject.schoolId,
               campusId: campusId ?? subject.campusId,
               name: { equals: name,},
               NOT: { id: subject.id },
             },
           });
     
           if (duplicate) {
             return res.status(400).json({ success: false, message: "Another subject with this name exists" });
           }
         }
     
         const updated = await prisma.subject.update({
           where: { id: subject.id },
           data: { name, code, campusId },
         });
     
         res.json({ success: true, message: "Subject updated successfully", subject: updated });
       } catch (err) {
         next(err);
       }
};
     
// ✅ Delete Subject
exports.deleteSubject = async (req, res, next) => {
       try {
         const { subjectId } = req.params;
     
         const subject = await prisma.subject.findUnique({ where: { id: parseInt(subjectId) } });
         if (!subject) {
           return res.status(404).json({ success: false, message: "Subject not found" });
         }
     
         // Delete related teacher assignments first (to avoid foreign key issues)
         await prisma.teacherAssignment.deleteMany({ where: { subjectId: subject.id } });
     
         await prisma.subject.delete({ where: { id: subject.id } });
     
         res.json({ success: true, message: "Subject deleted successfully" });
       } catch (err) {
         next(err);
       }
};