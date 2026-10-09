require("dotenv").config();

const prisma = require("../res/util/prisma");

/**
 * One-off: give students who have no campus the campus of their class.
 *
 * Bulk import used to save a student with no campus whenever the spreadsheet row
 * named none, and opening such a student crashed the admin student view. The
 * importer now takes the campus from the class; this repairs the students
 * already saved without one.
 *
 * Only fills in a campus that is missing, and only from the student's own class.
 * It never changes a campus that is already set, and never touches a student
 * whose class has no campus either.
 *
 * Reports by default. Pass --apply to write.
 *
 *   node scripts/backfill-student-campus.js                  # report, change nothing
 *   node scripts/backfill-student-campus.js --school=43      # report one school
 *   node scripts/backfill-student-campus.js --apply          # write
 */

const APPLY = process.argv.includes("--apply");
const schoolArg = process.argv.find((arg) => arg.startsWith("--school="));
const schoolId = schoolArg ? Number(schoolArg.split("=")[1]) : null;

async function main() {
  console.log(APPLY ? "⚠️  APPLYING changes\n" : "🔍 Report only — nothing will be written\n");

  const students = await prisma.student.findMany({
    where: {
      campusId: null,
      class: { campusId: { not: null } },
      ...(schoolId && { schoolId }),
    },
    select: { id: true, schoolId: true, classId: true, class: { select: { name: true, campusId: true } } },
  });

  if (students.length === 0) {
    console.log("No students are missing a campus that their class could supply.");
    return;
  }

  // One update per class rather than per student: every student in a class gets
  // the same campus.
  const byClass = new Map();
  for (const student of students) {
    const entry = byClass.get(student.classId) ?? {
      schoolId: student.schoolId,
      className: student.class.name,
      campusId: student.class.campusId,
      count: 0,
    };
    entry.count += 1;
    byClass.set(student.classId, entry);
  }

  console.log(`${students.length} student(s) across ${byClass.size} class(es):\n`);
  for (const [classId, entry] of byClass) {
    console.log(
      `  school ${entry.schoolId} · class ${classId} (${entry.className}): ${entry.count} student(s) → campus ${entry.campusId}`
    );
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write these changes.");
    return;
  }

  let updated = 0;
  for (const [classId, entry] of byClass) {
    // campusId: null in the filter, so a campus set since the report is left alone.
    const { count } = await prisma.student.updateMany({
      where: { classId, campusId: null, ...(schoolId && { schoolId }) },
      data: { campusId: entry.campusId },
    });
    updated += count;
  }
  console.log(`\n✅ Updated ${updated} student(s).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("❌ Failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
