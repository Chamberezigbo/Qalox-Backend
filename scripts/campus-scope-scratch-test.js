/**
 * Campus-restricted sub-admins against a REAL (scratch) MySQL. Refuses to run unless
 * DATABASE_URL is the scratch container on localhost:3307.
 *
 *   export DATABASE_URL="mysql://root:scratch@127.0.0.1:3307/qalox_scratch"
 *   npx prisma db push --skip-generate
 *   node scripts/campus-scope-scratch-test.js
 */
require("ts-node/register/transpile-only");
const assert = require("assert");

if (!/@(127\.0\.0\.1|localhost):3307\//.test(process.env.DATABASE_URL || "")) {
  console.error("Refusing to run: DATABASE_URL must point at the scratch database on localhost:3307.");
  process.exit(1);
}

const prisma = require("../res/util/prisma");
const scope = require("../res/util/campusScope");
const students = require("../res/controller/admin/StudentController");
const staffC = require("../res/controller/admin/StaffController");
const classesC = require("../res/controller/admin/ClassController");
const subjectsC = require("../res/controller/admin/SubjectController");
const fees = require("../res/controller/admin/FeeManagementController");
const campusesC = require("../res/controller/admin/campusController");
const { AssessmentController } = require("../res/controller/admin/AssessmentController");

const log = (m) => console.log(`  ✓ ${m}`);
const call = async (handler, req) => {
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let error;
  await handler({ query: {}, params: {}, body: {}, ...req }, res, (e) => { error = e; });
  return { status: error ? (error.statusCode ?? 500) : res.code, body: res.body, error };
};

async function seedSchool(tag, campusCount) {
  const school = await prisma.school.create({ data: { name: `CS ${tag} ${Date.now()}`, prefix: "CS" } });
  const schoolId = school.id;
  const session = await prisma.academicSession.create({ data: { schoolId, name: "2026/2027", isActive: true } });
  const campuses = [];
  for (let i = 0; i < campusCount; i++) campuses.push(await prisma.campus.create({ data: { schoolId, name: `Campus ${i + 1}` } }));
  const spots = campuses.length ? campuses.map((c) => c.id) : [null];
  const data = { schoolId, session, campuses, per: [] };
  let n = 0;
  for (const campusId of [...spots, ...(campuses.length ? [null] : [])]) {
    const cls = await prisma.class.create({ data: { schoolId, campusId, name: `Class ${campusId ?? "none"}` } });
    const subject = await prisma.subject.create({ data: { schoolId, campusId, name: `Sub ${campusId ?? "none"}` } });
    const staff = await prisma.staff.create({ data: { schoolId, campusId, name: `Staff ${campusId ?? "none"}`, duty: "teacher", registrationNumber: `S${tag}${++n}${Date.now()}` } });
    const student = await prisma.student.create({
      data: { schoolId, campusId, classId: cls.id, name: `Stu${campusId ?? "none"}`, surname: "T", otherNames: "", academicSessionId: session.id, registrationNumber: `R${tag}${n}${Date.now()}` },
    });
    const structure = await prisma.feeStructure.create({ data: { schoolId, classId: cls.id, term: "First", session: "2026/2027" } });
    const fee = await prisma.studentFee.create({ data: { schoolId, studentId: student.id, feeStructureId: structure.id, totalFee: 1000, amountPaid: 200, status: "partial" } });
    data.per.push({ campusId, cls, subject, staff, student, fee });
  }
  return data;
}

async function main() {
  console.log("Two-campus school");
  const s = await seedSchool("two", 2);
  const [c1, c2, none] = s.per;
  const A = { schoolId: s.schoolId, campusIds: [c1.campusId], user: { id: 1 } };
  const B = { schoolId: s.schoolId, campusIds: [c2.campusId], user: { id: 2 } };
  const C = { schoolId: s.schoolId, campusIds: [c1.campusId, c2.campusId], user: { id: 3 } };
  const D = { schoolId: s.schoolId, campusIds: null, user: { id: 4 } };

  // Students
  const names = async (req) => (await call(students.getStudentDetails, { ...req, query: {} })).body.data.map((x) => x.name).sort();
  const listA = (await call(students.getStudentDetails, A)).body;
  const stuNames = (r) => (r.data || r.students || []).map((x) => x.name).sort();
  assert.deepStrictEqual(stuNames(listA), [c1.student.name]);
  assert.deepStrictEqual(stuNames((await call(students.getStudentDetails, B)).body), [c2.student.name]);
  assert.strictEqual(stuNames((await call(students.getStudentDetails, C)).body).length, 2);
  assert.strictEqual(stuNames((await call(students.getStudentDetails, D)).body).length, 3);
  log("student lists: A, B, C and head admin each see the right set (untagged records are the owner's only)");

  assert.strictEqual((await call(students.getStudentDetails, { ...A, query: { campusId: String(c2.campusId) } })).status, 403);
  log("naming another campus is refused (403)");

  assert.strictEqual((await call(students.getSingleStudent, { ...A, params: { id: String(c2.student.id) } })).status, 404);
  assert.strictEqual((await call(students.getSingleStudent, { ...A, params: { id: String(c1.student.id) } })).status, 200);
  assert.strictEqual((await call(students.deleteStudent, { ...A, params: { id: String(c2.student.id) }, body: { confirmDeletion: true } })).status, 404);
  assert.ok(await prisma.student.findUnique({ where: { id: c2.student.id } }));
  log("fetching/deleting another campus's student is 404 and changes nothing");

  // Staff / classes / subjects
  const staffNames = async (req) => (await call(staffC.getAllStaff, req)).body.staff.map((x) => x.name).sort();
  assert.deepStrictEqual(await staffNames(A), [c1.staff.name]);
  assert.strictEqual((await call(staffC.getStaffDetails, { ...A, params: { staffId: String(c2.staff.id) } })).status, 404);
  assert.strictEqual((await call(staffC.deleteStaff, { ...A, params: { staffId: String(c2.staff.id) } })).status, 404);
  assert.ok(await prisma.staff.findUnique({ where: { id: c2.staff.id } }));
  assert.strictEqual((await call(classesC.getAllClasses, A)).body.classes.length, 1);
  assert.strictEqual((await call(classesC.getAllClasses, D)).body.classes.length, 3);
  assert.strictEqual((await call(subjectsC.getAllSubjects, B)).body.subjects.length, 1);
  assert.strictEqual((await call(classesC.createClass, { ...A, body: { name: "X", campusId: c2.campusId } })).status, 403);
  assert.strictEqual((await call(subjectsC.deleteSubject, { ...A, params: { subjectId: String(c2.subject.id) } })).status, 404);
  log("staff, classes, subjects: scoped lists, 404 on other campus, no creating elsewhere");

  // Fees
  const debt = async (req) => (await call(fees.getDebtSummary, req)).body.data;
  assert.strictEqual((await debt(A)).totalExpected, 1000); // campus 1 only
  assert.strictEqual((await debt(D)).totalExpected, 3000);
  assert.strictEqual((await call(fees.getStudentFees, A)).body.meta.total, 1);
  assert.strictEqual((await call(fees.getReceipt, { ...A, params: { studentFeeId: String(c2.fee.id) } })).status, 404);
  assert.strictEqual((await call(fees.recordPayment, { ...A, body: { studentFeeId: c2.fee.id, amount: 50, paymentMethod: "Cash" } })).status, 404);
  assert.strictEqual((await prisma.studentFee.findUnique({ where: { id: c2.fee.id } })).amountPaid, 200);
  log("fees: totals/pagination limited; other campus's receipt and payment refused, balance untouched");

  // Results guards
  const ac = new AssessmentController();
  assert.strictEqual((await call(ac.getClassSubjects, { ...A, params: { classId: String(c2.cls.id) } })).status, 404);
  assert.strictEqual((await call(ac.getStudentCompleteResult, { ...A, params: { studentId: String(c2.student.id) } })).status, 404);
  log("results: another campus's class and report card are 404");

  // Campuses
  const camps = (await call(campusesC.getCampuses, A)).body.campuses;
  assert.deepStrictEqual(camps.map((c) => c.id), [c1.campusId]);
  assert.strictEqual((await call(campusesC.updateCampus, { ...A, params: { campusId: String(c2.campusId) }, body: { name: "Hack" } })).status, 404);
  assert.strictEqual((await call(campusesC.createCampus, { ...A, body: { name: "New" } })).status, 403);
  log("campus list/edit/create scoped");

  // Assignment takes effect on the next request (scope is read from DB)
  const admin = await prisma.admin.create({ data: { email: `sub${Date.now()}@x.com`, password: "x", role: "sub_admin", schoolId: s.schoolId, name: "Sub", allCampuses: false } });
  await prisma.adminCampusAccess.create({ data: { adminId: admin.id, campusId: c1.campusId } });
  assert.deepStrictEqual(await scope.loadCampusScope(prisma, admin), [c1.campusId]);
  await prisma.adminCampusAccess.deleteMany({ where: { adminId: admin.id } });
  assert.deepStrictEqual(await scope.loadCampusScope(prisma, admin), []);
  assert.deepStrictEqual(await scope.loadCampusScope(prisma, { ...admin, allCampuses: true }), null);
  log("scope is read from the database, so removing a campus cuts access immediately");

  // Different role on each campus: Bursar on campus 1, Secretary on campus 2.
  const { requirePermission, attachSchoolId } = require("../res/middleware/authenticateSuperAdmin");
  const mixed = await prisma.admin.create({
    data: { email: `mix${Date.now()}@x.com`, password: "x", role: "sub_admin", schoolId: s.schoolId, name: "Mixed", allCampuses: false, permissions: JSON.stringify([]) },
  });
  await prisma.adminCampusAccess.createMany({
    data: [
      { adminId: mixed.id, campusId: c1.campusId, permissions: JSON.stringify(["fees.manage"]) },
      { adminId: mixed.id, campusId: c2.campusId, permissions: JSON.stringify(["students.manage"]) },
    ],
  });
  const through = async (key) => {
    const req = { user: { ...mixed, campusAccess: await prisma.adminCampusAccess.findMany({ where: { adminId: mixed.id } }) } };
    let err;
    requirePermission(key)(req, {}, (e) => { err = e; });
    if (err) return { status: err.statusCode };
    await attachSchoolId(req, {}, (e) => { err = e; });
    return { req };
  };
  const feesReq = (await through("fees.manage")).req;
  assert.deepStrictEqual(feesReq.campusIds, [c1.campusId]);
  assert.strictEqual((await call(fees.getDebtSummary, feesReq)).body.data.totalExpected, 1000);
  assert.strictEqual((await call(fees.getReceipt, { ...feesReq, params: { studentFeeId: String(c2.fee.id) } })).status, 404);
  const stuReq = (await through("students.manage")).req;
  assert.deepStrictEqual(stuReq.campusIds, [c2.campusId]);
  assert.deepStrictEqual(stuNames((await call(students.getStudentDetails, stuReq)).body), [c2.student.name]);
  assert.strictEqual((await call(students.getSingleStudent, { ...stuReq, params: { id: String(c1.student.id) } })).status, 404);
  assert.strictEqual((await through("classes.manage")).status, 403);
  log("mixed roles: Bursar on campus 1 and Secretary on campus 2 each see only their campus, per module");

  // Untagged records: owner sees them, campus sub-admin does not, until the owner assigns them.
  assert.strictEqual((await call(staffC.getStaffDetails, { ...A, params: { staffId: String(none.staff.id) } })).status, 404);
  assert.strictEqual((await call(staffC.getStaffDetails, { ...D, params: { staffId: String(none.staff.id) } })).status, 200);
  const campusCtl = require("../res/controller/admin/campusController");
  const counts = (await call(campusCtl.getUntaggedRecords, D)).body.data;
  assert.deepStrictEqual(counts, { staff: 1, classes: 1, subjects: 1, students: 1 });
  await call(campusCtl.assignUntaggedRecords, { ...D, params: { campusId: String(c2.campusId) }, body: { types: ["staff", "classes", "subjects", "students"] } });
  assert.strictEqual((await call(staffC.getStaffDetails, { ...B, params: { staffId: String(none.staff.id) } })).status, 200);
  assert.strictEqual((await call(staffC.getStaffDetails, { ...A, params: { staffId: String(none.staff.id) } })).status, 404);
  assert.deepStrictEqual((await call(campusCtl.getUntaggedRecords, D)).body.data, { staff: 0, classes: 0, subjects: 0, students: 0 });
  log("untagged records: hidden from campus sub-admins, owner assigns them to a campus, then only that campus sees them");

  // A restricted admin's new staff member always lands in one of their campuses.
  const made = await call(staffC.createStaff, { ...A, body: { name: "New Teacher", duty: "Teacher", email: `nt${Date.now()}@x.com` } });
  assert.strictEqual(made.status, 201);
  assert.strictEqual((await prisma.staff.findFirst({ where: { name: "New Teacher", schoolId: s.schoolId } })).campusId, c1.campusId);
  log("a restricted admin's new staff member is tagged to their campus");

  // CA templates per campus
  const ac2 = new AssessmentController();
  const tpl = [{ name: "CA1", maxScore: 20, isExam: false }, { name: "Exam", maxScore: 60, isExam: true }];
  assert.strictEqual((await call(ac2.createCATemplate, { ...D, schoolId: s.schoolId, body: { templates: tpl } })).status, 201); // owner: school-wide
  const aTpl = await call(ac2.createCATemplate, { ...A, schoolId: s.schoolId, body: { templates: [{ name: "CA1", maxScore: 10, isExam: false }, { name: "Exam", maxScore: 70, isExam: true }] } });
  assert.strictEqual(aTpl.status, 201);
  const aGet = (await call(ac2.getCATemplates, { ...A, schoolId: s.schoolId })).body.data;
  assert.deepStrictEqual(aGet.schoolWide, []);
  assert.deepStrictEqual(aGet.campus.map((t) => t.maxScore).sort(), [10, 70]);
  const bGet = (await call(ac2.getCATemplates, { ...B, schoolId: s.schoolId })).body.data;
  assert.deepStrictEqual(bGet.campus, []);
  assert.strictEqual((await call(ac2.getCATemplates, { ...D, schoolId: s.schoolId })).body.data.schoolWide.length, 2);
  log("CA setup: each campus sees and edits only its own template; the school-wide one is the owner's");

  // Campus branding falls back to the school's, and uses the campus's own when set
  const { resolveBranding } = require("../res/util/campusBranding");
  await prisma.school.update({ where: { id: s.schoolId }, data: { logoUrl: "r2:school-logo", stampUrl: "r2:school-stamp" } });
  await prisma.campus.update({ where: { id: c1.campusId }, data: { logoUrl: "r2:c1-logo" } });
  const b1 = await resolveBranding(prisma, { schoolId: s.schoolId, campusId: c1.campusId });
  const b2 = await resolveBranding(prisma, { schoolId: s.schoolId, campusId: c2.campusId });
  assert.strictEqual(b1.logoUrl, "r2:c1-logo");
  assert.strictEqual(b1.stampUrl, "r2:school-stamp");
  assert.strictEqual(b2.logoUrl, "r2:school-logo");
  assert.strictEqual(b1.name, c1.campusName ?? "Campus 1");
  assert.strictEqual((await call(campusCtl.updateCampusBranding, { ...A, params: { campusId: String(c2.campusId) }, files: {} })).status, 403);
  log("campus branding: own logo/name when set, school's otherwise; another campus's branding is off limits");

  console.log("School with no campuses");
  const z = await seedSchool("zero", 0);
  const all = { schoolId: z.schoolId, campusIds: null, user: { id: 5 } };
  assert.strictEqual((await call(students.getStudentDetails, all)).body.data?.length ?? (await call(students.getStudentDetails, all)).body.students.length, 1);
  assert.strictEqual((await call(classesC.getAllClasses, all)).body.classes.length, 1);
  assert.strictEqual((await debt(all)).totalExpected, 1000);
  log("unchanged for a school with no campuses");

  console.log("School with one campus");
  const o = await seedSchool("one", 1);
  const oneAll = { schoolId: o.schoolId, campusIds: null, user: { id: 6 } };
  assert.strictEqual((await call(classesC.getAllClasses, oneAll)).body.classes.length, 2);
  assert.strictEqual((await debt(oneAll)).totalExpected, 2000);
  log("unchanged for a one-campus school");

  console.log("\nAll campus-scope checks passed.");
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
