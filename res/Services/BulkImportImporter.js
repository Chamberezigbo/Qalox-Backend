const prisma = require("../util/prisma");
const { generateUniqueIdentifier } = require("../Models/generateUniqueIdentifier");
const { getActivePlanForSchool } = require("../util/getActivePlanForSchool");

/**
 * Commits reviewed bulk-import rows into real Student / Staff records.
 *
 * Rows are created one at a time, not in a single transaction, on purpose: an
 * import of 120 rows where row 87 trips a unique constraint should still land
 * the other 119. The failed row comes back with the exact reason so the admin
 * can fix that one row instead of re-running everything.
 */

// generateUniqueIdentifier() draws a random 4-digit number, so across a big
// import a collision with an existing registration number is likely, not rare.
// Registration numbers are unique in the database, so a clash is retried rather
// than reported as a failure the admin can do nothing about.
const REGISTRATION_ATTEMPTS = 10;

/** True when a Prisma error is a unique-constraint violation on `field`. */
function isUniqueViolationOn(error, field) {
  if (!error || error.code !== "P2002") return false;
  const target = error.meta && error.meta.target;
  if (!target) return false;
  const fields = Array.isArray(target) ? target : [String(target)];
  return fields.some((name) => String(name).toLowerCase().includes(field.toLowerCase()));
}

/**
 * Creates a record, regenerating its registration number and retrying whenever
 * that is what collided.
 *
 * @param {Function} create takes a registration number, returns a create promise
 */
async function createWithRegistration(prefix, type, create) {
  let lastError;
  for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
    const registrationNumber = generateUniqueIdentifier(prefix, type);
    try {
      return await create(registrationNumber);
    } catch (error) {
      if (!isUniqueViolationOn(error, "registrationNumber")) throw error;
      lastError = error;
    }
  }
  throw new Error(
    "Could not allocate a unique registration number after several attempts. Try importing this row again."
  );
}

function findByName(list, name) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return null;
  return list.find((item) => item.name.trim().toLowerCase() === target) || null;
}

class BulkImportImporter {
  /**
   * @param {Object} params
   * @param {Number} params.schoolId
   * @param {String} params.entity  "students" | "staff"
   * @param {Array}  params.records validated records to create (already filtered to valid ones)
   * @returns {Promise<Array<{ recordId, rowNumber, ok, reason, data }>>}
   */
  static async importRecords({ schoolId, entity, records }) {
    if (entity === "students") return this.importStudents({ schoolId, records });
    return this.importStaff({ schoolId, records });
  }

  /**
   * Checks anything that should stop the WHOLE import before a single row is
   * written — currently just the plan's student cap. Returning half an import
   * and a "you hit your limit" error would leave the admin unsure which rows
   * landed.
   *
   * @returns {Promise<{ message: String, status: Number } | null>}
   */
  static async checkPreconditions({ schoolId, entity, count }) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { prefix: true },
    });
    if (!school) return { status: 404, message: "School not found" };

    if (entity === "students") {
      // Every imported student is filed under the school's active session, and
      // there is no session column in the import. Without one, every single row
      // would fail for the same reason — one clear message beats 120 identical
      // per-row failures the admin cannot act on individually.
      const session = await prisma.academicSession.findFirst({
        where: { schoolId, isActive: true },
        select: { id: true },
      });
      if (!session) {
        return {
          status: 400,
          message:
            "Your school has no active academic session, so students cannot be imported. Set one up first, then confirm this import again.",
        };
      }

      const plan = await getActivePlanForSchool(schoolId);
      if (plan && plan.maxStudents != null) {
        const existing = await prisma.student.count({ where: { schoolId } });
        const remaining = plan.maxStudents - existing;
        if (remaining < count) {
          return {
            status: 403,
            message: `Your plan (${plan.name}) allows up to ${plan.maxStudents} students. You have ${Math.max(
              remaining,
              0
            )} slot(s) left but this import would add ${count}. Upgrade your plan or remove some rows before importing.`,
          };
        }
      }
    }

    return null;
  }

  static async importStudents({ schoolId, records }) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { prefix: true },
    });

    // checkPreconditions() has already refused the whole import if there is no
    // active session; this is the defensive re-read for a direct caller.
    const session = await prisma.academicSession.findFirst({
      where: { schoolId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!session) {
      const reason =
        "Your school has no active academic session, so students cannot be imported. Set one up first.";
      return records.map((record) => ({
        recordId: record.id,
        rowNumber: record.rowNumber,
        ok: false,
        reason,
        data: record.data,
      }));
    }

    // Resolved once for the batch — the same handful of class and campus names
    // repeat across every row.
    const [classes, campuses] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId },
        select: { id: true, name: true, classGroups: { select: { id: true, name: true } } },
      }),
      prisma.campus.findMany({ where: { schoolId }, select: { id: true, name: true } }),
    ]);

    const results = [];

    for (const record of records) {
      const data = record.data;
      try {
        const classRecord = findByName(classes, data.className);
        if (!classRecord) {
          throw new Error(`There is no class called "${data.className}" in your school`);
        }

        let campusId = null;
        if (data.campusName) {
          const campus = findByName(campuses, data.campusName);
          if (!campus) {
            throw new Error(`There is no campus called "${data.campusName}" in your school`);
          }
          campusId = campus.id;
        }

        let classGroupId = null;
        if (data.groupName) {
          const group = findByName(classRecord.classGroups, data.groupName);
          if (!group) {
            throw new Error(`Class "${classRecord.name}" has no group called "${data.groupName}"`);
          }
          classGroupId = group.id;
        }

        await createWithRegistration(school.prefix, "STD", (registrationNumber) =>
          prisma.student.create({
            data: {
              schoolId,
              campusId,
              classId: classRecord.id,
              classGroupId,
              name: data.firstName,
              surname: data.lastName,
              otherNames: "", // not an import column; the column is non-nullable
              gender: data.gender || null,
              dateOfBirth: data.dob || null,
              guardianName: data.guardianName || null,
              guardianNumber: data.parentPhone || null,
              email: data.email || null,
              academicSessionId: session.id,
              registrationNumber,
            },
            select: { id: true },
          })
        );

        results.push({ recordId: record.id, rowNumber: record.rowNumber, ok: true, data });
      } catch (error) {
        results.push({
          recordId: record.id,
          rowNumber: record.rowNumber,
          ok: false,
          reason: readableReason(error),
          data,
        });
      }
    }

    return results;
  }

  static async importStaff({ schoolId, records }) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { prefix: true },
    });

    const campuses = await prisma.campus.findMany({
      where: { schoolId },
      select: { id: true, name: true },
    });

    const results = [];

    for (const record of records) {
      const data = record.data;
      try {
        let campusId = null;
        if (data.campusName) {
          const campus = findByName(campuses, data.campusName);
          if (!campus) {
            throw new Error(`There is no campus called "${data.campusName}" in your school`);
          }
          campusId = campus.id;
        }

        await createWithRegistration(school.prefix, "STA", (registrationNumber) =>
          prisma.staff.create({
            data: {
              schoolId,
              campusId,
              // Staff store one combined name; the import splits it in two so the
              // grid can validate each half, then joins it back here.
              name: `${data.firstName} ${data.lastName}`.trim(),
              email: data.email || null,
              gender: data.gender || null,
              phoneNumber: data.phone || null,
              address: data.address || null,
              duty: data.duty || null,
              nextOfKin: data.nextOfKin || null,
              // Parsed as UTC midnight, not local. `new Date("2023-09-01T00:00:00")`
              // is local midnight, which is stored as the 31st of August for any
              // timezone ahead of UTC — the date would come back a day early.
              dateEmployed: data.dateEmployed ? new Date(`${data.dateEmployed}T00:00:00.000Z`) : null,
              registrationNumber,
            },
            select: { id: true },
          })
        );

        results.push({ recordId: record.id, rowNumber: record.rowNumber, ok: true, data });
      } catch (error) {
        results.push({
          recordId: record.id,
          rowNumber: record.rowNumber,
          ok: false,
          reason: readableReason(error),
          data,
        });
      }
    }

    return results;
  }
}

/**
 * The `reason` is shown to the admin verbatim, so a raw Prisma message
 * ("Unique constraint failed on the fields: (`email`)") is translated into
 * something that names what to fix.
 */
function readableReason(error) {
  if (isUniqueViolationOn(error, "email")) {
    return "A record with this email already exists";
  }
  if (error && error.code === "P2002") {
    return "This record clashes with one that already exists";
  }
  if (error && error.code === "P2003") {
    return "This row references a class or campus that no longer exists";
  }
  const message = error && error.message ? String(error.message) : "";
  if (message && message.length < 300 && !message.includes("\n")) return message;
  return "This row could not be saved. Check its values and try again.";
}

module.exports = BulkImportImporter;
module.exports.readableReason = readableReason;
module.exports.isUniqueViolationOn = isUniqueViolationOn;
