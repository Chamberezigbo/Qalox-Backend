const prisma = require("../../util/prisma");

// ✅ Create a new campus
exports.createCampus = async (req, res, next) => {
       try {
         const { name, address, phoneNumber, email } = req.body;
         const {schoolId} = req;
     
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
         const { name, address, phoneNumber, email } = req.body;
     
         const existing = await prisma.campus.findUnique({
           where: { id: Number(campusId) },
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
     
         res.status(200).json({
           success: true,
           total,
           page: Number(page),
           pages: Math.ceil(total / limit),
           campuses,
         });
       } catch (err) {
         next(err);
       }
};