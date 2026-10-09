const { log } = require("winston");
const prisma = require("../../util/prisma");
const { response } = require("express");
const processImage = require("../../config/compress");


const { generateUniqueIdentifier } = require("../../Models/generateUniqueIdentifier");
const { academicSession } = require("../../util/prisma");
const { getActivePlanForSchool } = require("../../util/getActivePlanForSchool");
const { createNotification } = require("../../util/notify");
const { syncStudentFeeInvoices } = require("../../util/studentFeeSync");

exports.getStudentDetails = async (req, res, next) => {
  try {
    const { page = 1, campusId, name, gender, classId, classGroupId } = req.query;
    const take = 9;
    const skip = (page - 1) * take;

    if (!req.schoolId) {
      return res.status(400).json({ message: "School ID is required" });
    }

    const filter = { schoolId: req.schoolId };

    if (campusId) filter.campusId = parseInt(campusId);
    // Matches either name field — a search for "Daniel" should surface a
    // student named Daniel just as much as one whose surname is Daniel.
    if (name) {
      filter.OR = [
        { name: { contains: name } },
        { surname: { contains: name } },
      ];
    }
    if (gender) filter.gender = gender;
    if (classId) filter.classId = parseInt(classId);
    if (classGroupId) filter.classGroupId = parseInt(classGroupId);

    const students = await prisma.student.findMany({
      where: filter,
      take,
      skip,
      orderBy: { createdAt: "desc" },
      include: {
        class: {
          include: {
            classGroups: {
              select: { id: true, name: true }
            }
          }
        },
        campus: { select: { id: true, name: true } },
        academicSession: { select: { id: true, name: true, isActive: true } },
        classGroup: { select: { id: true, name: true } },
      },
    })

    const total = await prisma.student.count({ where: filter });

    res.status(200).json({
      students, meta: {
        total,
        page: parseInt(page),
        pageSize: take,
        totalPages: Math.ceil(total / take),
      },
    });

  } catch (error) {
    next(error);
  }
}

exports.createStudent = async (req, res, next) => {
  try {
    const {
      name,
      campusId: rawCampusId,
      classId: rawClassId,
      groupId, // ✅ Accept groupId from request body
      surname,
      otherNames,
      gender,
      dateOfBirth,
      guardianName,
      guardianNumber,
      guardianEmail,
      lifestyle,
      session,
      email,
    } = req.body;

    const schoolId = req.schoolId;

    // An empty string means "left blank" for these optional fields — store
    // null rather than "" so it matches every other "not provided" case.
    //
    // otherNames is the exception: the column is `String` (NOT NULL), so a null
    // here is rejected by Prisma. It then re-reports the failure against its
    // checked input variant, which demands the `academicSession` relation
    // instead of accepting academicSessionId — producing "Argument
    // `academicSession` is missing" and pointing at completely the wrong field.
    // Blank stays "" to match what BulkImportImporter already writes, so the
    // column holds one representation of "not provided" rather than two.
    const normalizedOtherNames = otherNames?.trim() || "";
    const normalizedGuardianName = guardianName?.trim() || null;
    const normalizedGuardianNumber = guardianNumber?.trim() || null;
    const normalizedGuardianEmail = guardianEmail?.trim() || null;
    const normalizedLifestyle = lifestyle?.trim() || null;
    const normalizedEmail = email?.trim() || null;

    // Convert string IDs to integers (HTTP always sends strings)
    const campusId = rawCampusId ? parseInt(rawCampusId) : null;
    const classId = rawClassId ? parseInt(rawClassId) : null;

    if (!classId) {
      return res.status(400).json({ message: "Class ID is required" });
    }

    // Get the school prefix
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { prefix: true },
    });
    if (!school) {
      return res.status(404).json({ message: "School not found" });
    }

    // Enforce the school's plan cap on student count. Schools with no
    // active plan yet (predating this feature) are not blocked.
    const plan = await getActivePlanForSchool(schoolId);
    if (plan && plan.maxStudents != null) {
      const studentCount = await prisma.student.count({ where: { schoolId } });
      if (studentCount >= plan.maxStudents) {
        return res.status(403).json({
          message: `Your plan (${plan.name}) allows up to ${plan.maxStudents} students. Upgrade your plan to add more.`,
          code: "STUDENT_LIMIT_REACHED",
        });
      }
    }

    const uniqueId = generateUniqueIdentifier(school.prefix, "STD");

    // Upload passport if provided
    let passportUrl = null;
    if (req.file) {
      passportUrl = await processImage(
        req.file.buffer,
        "passports",
        `${uniqueId}-passport.jpeg`
      );
    }


    // 1️⃣ Validate class existence
    const classExist = await prisma.class.findUnique({
      where: { id: classId },
      include: { classGroups: true },
    });
    if (!classExist) {
      return res.status(404).json({ message: "Class not found" });
    }

    // 2️⃣ Validate group if provided
    let groupData = {};
    if (groupId) {
      const groupExist = await prisma.classGroup.findUnique({
        where: { id: parseInt(groupId) },
      });
      if (!groupExist) {
        return res.status(404).json({ message: "Class group not found" });
      }
      if (groupExist.classId !== classExist.id) {
        return res.status(400).json({
          message: "This group does not belong to the specified class",
        });
      }

      groupData = { classGroupId: parseInt(groupId) };
    }

    // Add this before prisma.student.create(...)
    const trimmedSession = typeof session === "string" ? session.trim() : "";

    let resolvedAcademicSession = null;

    if (trimmedSession) {
      resolvedAcademicSession = await prisma.academicSession.upsert({
        where: {
          schoolId_name: {
            schoolId,
            name: trimmedSession,
          },
        },
        update: {},
        create: {
          schoolId,
          name: trimmedSession,
          isActive: false,
        },
        select: {
          id: true,
          name: true,
          isActive: true,
        },
      });
    } else {
      resolvedAcademicSession = await prisma.academicSession.findFirst({
        where: {
          schoolId,
          isActive: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          id: true,
          name: true,
          isActive: true,
        },
      });
    }

    if (!resolvedAcademicSession) {
      return res.status(400).json({
        message:
          "No academic session provided and no active academic session found for this school",
      });
    }

    // 3️⃣ Create student
    const createdStudent = await prisma.student.create({
      data: {
        name,
        schoolId,
        campusId,
        classId,
        surname,
        otherNames: normalizedOtherNames,
        gender,
        dateOfBirth,
        guardianName: normalizedGuardianName,
        guardianNumber: normalizedGuardianNumber,
        guardianEmail: normalizedGuardianEmail,
        lifestyle: normalizedLifestyle,
        academicSessionId: resolvedAcademicSession.id,
        // session,
        email: normalizedEmail,
        registrationNumber: uniqueId,
        passportUrl,
        ...groupData, // ✅ Attach group if provided
      },
      include: {
        class: { include: { classGroups: true } },
        classGroup: true, // ✅ Return group data if exists
        academicSession: { select: { id: true, name: true, isActive: true } }
      },
    });

    // Notify the school's admins — fire-and-forget, never blocks the response.
    prisma.admin.findMany({
      where: { schoolId, role: { in: ["school_admin", "sub_admin", "super_admin"] } },
      select: { id: true },
    }).then((admins) => {
      admins.forEach((a) =>
        createNotification({
          recipientType: "admin",
          recipientId: a.id,
          schoolId,
          title: "New student enrolled",
          message: `${createdStudent.name} ${createdStudent.surname} was enrolled in ${createdStudent.class?.name || "a class"}.`,
          type: "new_student",
        })
      );
    });

    // If this class already has a fee structure, invoice this student for it
    // now — it was only ever backfilled for students who existed at the time
    // the structure was created.
    await syncStudentFeeInvoices(prisma, { id: createdStudent.id, schoolId, classId });

    res.status(201).json({
      success: true,
      message: `Student created successfully${groupId ? " and added to group" : ""}`,
      student: createdStudent,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * POST /api/admin/students/bulk-upload
 * Create many students from parsed CSV rows in one request.
 * Each row is processed independently — a bad row doesn't block the rest.
 *
 * Body: { session?: string, rows: [{ name, surname, otherNames?, gender,
 *   dateOfBirth, className, campusName?, groupName?, guardianName?,
 *   guardianNumber?, lifestyle?, email? }] }
 */
exports.bulkCreateStudents = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { session, rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "rows must be a non-empty array",
        code: "MISSING_ROWS",
      });
    }

    if (rows.length > 500) {
      return res.status(400).json({
        success: false,
        message: "A single bulk upload is limited to 500 rows",
        code: "TOO_MANY_ROWS",
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { prefix: true },
    });
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }

    // Enforce the school's plan cap on student count for the whole batch —
    // reject upfront rather than partially succeeding past the limit.
    const plan = await getActivePlanForSchool(schoolId);
    if (plan && plan.maxStudents != null) {
      const studentCount = await prisma.student.count({ where: { schoolId } });
      const remaining = plan.maxStudents - studentCount;
      if (remaining < rows.length) {
        return res.status(403).json({
          success: false,
          message: `Your plan (${plan.name}) allows up to ${plan.maxStudents} students. You have ${Math.max(remaining, 0)} slot(s) left, but this upload has ${rows.length} row(s). Upgrade your plan or reduce the batch size.`,
          code: "STUDENT_LIMIT_REACHED",
        });
      }
    }

    // Resolve academic session once for the whole batch
    const trimmedSession = typeof session === "string" ? session.trim() : "";
    let resolvedSession;
    if (trimmedSession) {
      resolvedSession = await prisma.academicSession.upsert({
        where: { schoolId_name: { schoolId, name: trimmedSession } },
        update: {},
        create: { schoolId, name: trimmedSession, isActive: false },
        select: { id: true },
      });
    } else {
      resolvedSession = await prisma.academicSession.findFirst({
        where: { schoolId, isActive: true },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
    }

    if (!resolvedSession) {
      return res.status(400).json({
        success: false,
        message: "No academic session provided and no active academic session found for this school",
        code: "MISSING_SESSION",
      });
    }

    // Pre-fetch classes/campuses once — MySQL's Prisma client doesn't support
    // `mode: "insensitive"` (that's Postgres-only), so we match case-insensitively in JS
    const [allClasses, allCampuses] = await Promise.all([
      prisma.class.findMany({ where: { schoolId }, include: { classGroups: true } }),
      prisma.campus.findMany({ where: { schoolId } }),
    ]);
    const findClassByName = (n) => allClasses.find((c) => c.name.trim().toLowerCase() === n.trim().toLowerCase());
    const findCampusByName = (n) => allCampuses.find((c) => c.name.trim().toLowerCase() === n.trim().toLowerCase());

    const results = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 1;

      try {
        const { name, surname, otherNames, gender, dateOfBirth, className, campusName, groupName, guardianName, guardianNumber, guardianEmail, lifestyle, email } = row;

        if (!name || !surname || !gender || !dateOfBirth || !className) {
          results.push({ row: rowNumber, success: false, error: "Missing required field(s): name, surname, gender, dateOfBirth, className" });
          failureCount++;
          continue;
        }

        const classRecord = findClassByName(className);
        if (!classRecord) {
          results.push({ row: rowNumber, success: false, error: `Class "${className}" not found` });
          failureCount++;
          continue;
        }

        // Resolve optional campus by name
        let campusId = null;
        if (campusName) {
          const campusRecord = findCampusByName(campusName);
          if (!campusRecord) {
            results.push({ row: rowNumber, success: false, error: `Campus "${campusName}" not found` });
            failureCount++;
            continue;
          }
          campusId = campusRecord.id;
        }

        // Resolve optional class group by name (must belong to the resolved class)
        let groupId = null;
        if (groupName) {
          const group = classRecord.classGroups.find(
            (g) => g.name.trim().toLowerCase() === groupName.trim().toLowerCase()
          );
          if (!group) {
            results.push({ row: rowNumber, success: false, error: `Group "${groupName}" not found in class "${className}"` });
            failureCount++;
            continue;
          }
          groupId = group.id;
        }

        const uniqueId = generateUniqueIdentifier(school.prefix, "STD");

        const created = await prisma.student.create({
          data: {
            name,
            surname,
            otherNames: otherNames || "",
            gender,
            dateOfBirth,
            schoolId,
            campusId,
            classId: classRecord.id,
            classGroupId: groupId,
            guardianName,
            guardianNumber,
            guardianEmail,
            lifestyle,
            email,
            academicSessionId: resolvedSession.id,
            registrationNumber: uniqueId,
          },
          select: { id: true, name: true, surname: true, registrationNumber: true },
        });

        // Same reasoning as the single-create path: this class may already
        // have a fee structure this student needs invoicing against.
        await syncStudentFeeInvoices(prisma, { id: created.id, schoolId, classId: classRecord.id });

        results.push({ row: rowNumber, success: true, student: created });
        successCount++;
      } catch (rowError) {
        results.push({ row: rowNumber, success: false, error: rowError.message });
        failureCount++;
      }
    }

    res.status(200).json({
      success: true,
      message: `Bulk upload complete: ${successCount} created, ${failureCount} failed`,
      data: { successCount, failureCount, results },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateStudent = async (req, res, next) => {
  try {
    const { id } = req.params;
    // Pull session out separately so it doesn't get passed raw to Prisma
    const { session, ...data } = req.body;

    const studentExist = await prisma.student.findUnique({
      where: { id: parseInt(id) },
      include: {
        campus: { select: { id: true, name: true } }
      },
    });

    if (!studentExist) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Upload new passport if provided
    if (req.file) {
      data.passportUrl = await processImage(
        req.file.buffer,
        "passports",
        `${studentExist.registrationNumber}-passport.jpeg`
      );
    }

    // Resolve session name → academicSessionId if provided
    let resolvedSessionId = undefined;
    if (session) {
      const trimmed = session.trim();
      const resolved = await prisma.academicSession.upsert({
        where: { schoolId_name: { schoolId: studentExist.schoolId, name: trimmed } },
        update: {},
        create: { schoolId: studentExist.schoolId, name: trimmed, isActive: false },
        select: { id: true },
      });
      resolvedSessionId = resolved.id;
    }

    // Parse any Int fields that come in as strings from the request body
    const updateData = {
      ...data,
      ...(data.campusId && { campusId: parseInt(data.campusId) }),
      ...(data.classId && { classId: parseInt(data.classId) }),
      ...(data.classGroupId && { classGroupId: parseInt(data.classGroupId) }),
      ...(resolvedSessionId && { academicSessionId: resolvedSessionId }),
    };

    const updatedStudent = await prisma.student.update({
      where: { id: parseInt(id) },
      data: updateData,
      include: {
        academicSession: { select: { id: true, name: true, isActive: true } },
      },
    });

    res.status(200).json({
      success: true,
      message: "Student updated successfully",
      student: updatedStudent,
    });
  } catch (error) {
    next(error);
  }
};


exports.getSingleStudent = async (req, res, next) => {
  try {
    const { id } = req.params;

    const studentExist = await prisma.student.findUnique({
      where: { id: parseInt(id), },
      include: {
        campus:
        {
          select:
            { id: true, name: true }
        },
        academicSession: {
          select:
            { id: true, name: true, isActive: true }
        },
        classGroup: {
          select:
            { id: true, name: true }
        },
      }
    });

    if (!studentExist) {
      return res.status(404).json({ message: "Student not found" });
    }

    res.status(200).json({
      success: true,
      message: "Student updated successfully",
      data: studentExist,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/admin/student/change-class
 * Body: { studentIds: number[], classId, groupId?, campusId? }
 *
 * Moves students into one class. Everything is looked up within the admin's
 * own school: this used to find students, the class and the group by bare id,
 * so an admin could move another school's students, or move their own into
 * another school's class, just by knowing the ids.
 *
 * The batch is all or nothing. It used to commit student by student and then
 * report an error for the ones that failed, leaving a half-moved class and no
 * clear way to know which half.
 */
exports.changeStudentClass = async (req, res, next) => {
  try {
    const schoolId = req.schoolId;
    const { studentIds, classId, groupId, campusId } = req.body;

    const targetClassId = parseInt(classId, 10);
    if (!targetClassId) {
      return res.status(400).json({ success: false, message: "Class ID is required" });
    }

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ success: false, message: "At least one student ID is required" });
    }

    const ids = [...new Set(studentIds.map((id) => parseInt(id, 10)))];
    if (ids.some(Number.isNaN)) {
      return res.status(400).json({ success: false, message: "Student IDs must be numbers" });
    }

    // 1️⃣ The class, looked up within this school so another school's class
    // reads as simply not found.
    const classExist = await prisma.class.findFirst({
      where: { id: targetClassId, schoolId },
      select: { id: true, name: true, campusId: true },
    });
    if (!classExist) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    // 2️⃣ Campus. A class belongs to one campus, so a student moved into it
    // belongs there too — taken from the class unless a campus is named, and
    // refused if the one named is not the class's own.
    let targetCampusId = classExist.campusId ?? undefined;
    if (campusId) {
      const campusExist = await prisma.campus.findFirst({
        where: { id: parseInt(campusId, 10), schoolId },
        select: { id: true },
      });
      if (!campusExist) {
        return res.status(404).json({ success: false, message: "Campus not found" });
      }
      if (classExist.campusId && campusExist.id !== classExist.campusId) {
        return res.status(400).json({
          success: false,
          message: "This class belongs to a different campus",
        });
      }
      targetCampusId = campusExist.id;
    }

    // 3️⃣ Group, which must belong to the class being moved into.
    let targetGroupId = null;
    if (groupId) {
      const groupExist = await prisma.classGroup.findFirst({
        where: { id: parseInt(groupId, 10), classId: classExist.id },
        select: { id: true },
      });
      if (!groupExist) {
        return res.status(404).json({
          success: false,
          message: "Class group not found in the specified class",
        });
      }
      targetGroupId = groupExist.id;
    }

    // 4️⃣ The students, within this school. Any id that is not found here — gone,
    // or belonging to another school — stops the whole batch before anything
    // is changed.
    const students = await prisma.student.findMany({
      where: { id: { in: ids }, schoolId },
      select: { id: true, classId: true },
    });
    const foundIds = new Set(students.map((student) => student.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some students could not be updated. No changes were made.",
        errors: missing.map((id) => ({ studentId: id, message: `Student with ID ${id} not found` })),
      });
    }

    // 5️⃣ Apply, in one transaction and two statements rather than one per student.
    //
    // A group belongs to a class, so a student leaving their class cannot keep
    // it — it is cleared, or replaced by the group chosen in the new class. This
    // used to leave the old class's group in place whenever none was given, which
    // then showed the student under a group that is not in their class.
    // A student already in the target class keeps their group unless a new one
    // is chosen: that is how an admin changes only the group.
    const moving = students.filter((s) => s.classId !== classExist.id).map((s) => s.id);
    const staying = students.filter((s) => s.classId === classExist.id).map((s) => s.id);
    const base = { classId: classExist.id, ...(targetCampusId && { campusId: targetCampusId }) };

    await prisma.$transaction(
      async (tx) => {
        if (moving.length > 0) {
          await tx.student.updateMany({
            where: { id: { in: moving }, schoolId },
            data: { ...base, classGroupId: targetGroupId },
          });
        }
        if (staying.length > 0) {
          await tx.student.updateMany({
            where: { id: { in: staying }, schoolId },
            data: { ...base, ...(targetGroupId && { classGroupId: targetGroupId }) },
          });
        }
      },
      { timeout: 30000 }
    );

    // The new class may already have a fee structure these students were never
    // invoiced against. After the commit, and per student, because it never
    // throws and must not be able to undo the move it rides along with.
    for (const studentId of moving) {
      await syncStudentFeeInvoices(prisma, { id: studentId, schoolId, classId: classExist.id });
    }

    const updatedStudents = await prisma.student.findMany({
      where: { id: { in: ids }, schoolId },
      include: {
        class: { include: { classGroups: true, campus: true } },
        campus: true,
      },
    });

    res.status(200).json({
      success: true,
      message: `Students moved to class ${classExist.name}${targetGroupId ? " and added to group" : ""
        }${campusId ? " in the selected campus" : ""} successfully`,
      students: updatedStudents,
    });
  } catch (error) {
    next(error);
  }
};
