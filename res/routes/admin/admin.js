const express = require("express");
const upload = require("../../middleware/upload");


const {
  createAdmin,
  loginAdmin,
  getSchoolAdmins,
  updateAdmin,
  deleteAdmin,
  checkHealth,
  getMySchool,
  getSchoolAssessments,
  getOverview,
} = require("../../controller/admin/admin");

const {
  getStudentDetails, createStudent,
  updateStudent, changeStudentClass,
  getSingleStudent,
} = require("../../controller/admin/StudentController");

const {
  createClass,
  getAllClasses,
  deleteClass,
  createClassGroup,
  getClassGroups,
  updateClass,
  updateClassGroup
} = require("../../controller/admin/ClassController");

const {
  createCampus,
  updateCampus,
  getCampuses,
} = require("../../controller/admin/campusController")

const {
  createStaff, updateStaff,
  getStaffDetails, assignTeacher,
  getAllStaff, deleteStaff,
  reassignTeacher
} = require("../../controller/admin/StaffController")

const {
  createSubject,
  getAllSubjects,
  editSubject,
  deleteSubject
} = require("../../controller/admin/SubjectController");

const { AcademicTermController } = require("../../controller/admin/AcademicTerm");
const termController = new AcademicTermController();



const {
  GradingController
} = require("../../controller/admin/GradingController");

const { AssessmentController } = require("../../controller/admin/AssessmentController");

const assessmentController = new AssessmentController();

const validate = require("../../middleware/validator");

const {
  createAdminSchema,
  loginSchema,
  updateAdminSchema,
  studentSchema,
  staffSchema,
  editStaffSchema,
  assignTeacherSchema,
  classSchema,
  classGroupSchema
} = require("../../schemas/adminSchemas");

const auth = require("../../middleware/authenticateSuperAdmin");

const router = express.Router();

router.post("/create", validate(createAdminSchema), createAdmin);
router.post("/login", validate(loginSchema), loginAdmin);

router.get("/school-admins", auth.authenticateSuperAdmin, auth.attachSchoolId, getSchoolAdmins);
router.put("/:id", validate(updateAdminSchema), updateAdmin);
router.delete("/:id", auth.authenticateSuperAdmin, deleteAdmin);
router.get("/", checkHealth);

// My school info for any authenticated admin
router.get("/my-school", auth.authenticateAdmin, getMySchool);

// Student routes
router.get("/students", auth.authenticateSuperAdmin, auth.attachSchoolId, getStudentDetails);
router.post("/student/create",
  upload.single("passport"),
  validate(studentSchema),
  auth.authenticateSuperAdmin,
  auth.attachSchoolId,
  createStudent
);
router.put("/student/:id",
  upload.single("passport"),
  auth.authenticateSuperAdmin,
  updateStudent
);

router.patch("/student/change-class", auth.authenticateSuperAdmin, changeStudentClass);
router.get("/student/:id", auth.authenticateSuperAdmin, getSingleStudent);
// Staff routes
router.post("/staff/create", validate(staffSchema), auth.authenticateSuperAdmin, auth.attachSchoolId, createStaff);
router.patch("/staff/:staffId", validate(editStaffSchema), auth.authenticateSuperAdmin, updateStaff);
router.get("/staff/:staffId", auth.authenticateSuperAdmin, getStaffDetails);
router.post('/staff/assign-teacher', validate(assignTeacherSchema), auth.authenticateSuperAdmin, assignTeacher);
router.get("/staff", auth.authenticateSuperAdmin, auth.attachSchoolId, getAllStaff);
router.delete("/staff/:staffId", auth.authenticateSuperAdmin, deleteStaff);
router.patch("/staff/reassign-teacher/:assignmentId", auth.authenticateSuperAdmin, auth.attachSchoolId, reassignTeacher);

// Class routes
router.post("/classes/create", validate(classSchema), auth.authenticateSuperAdmin, auth.attachSchoolId, createClass);
router.get("/classes", auth.authenticateSuperAdmin, auth.attachSchoolId, getAllClasses);
router.delete("/classes/:classId", auth.authenticateSuperAdmin, deleteClass);
router.post("/class-groups/create", validate(classGroupSchema), auth.authenticateSuperAdmin, auth.attachSchoolId, createClassGroup);
router.get("/class-groups", auth.authenticateSuperAdmin, auth.attachSchoolId, getClassGroups);
router.patch("/class/update/:classId", auth.authenticateSuperAdmin, updateClass);
router.patch("/class-group/update/:groupId", auth.authenticateSuperAdmin, updateClassGroup);

// Campus routes
router.post("/campus/create", auth.authenticateSuperAdmin, auth.attachSchoolId, createCampus);
router.patch("/campus/update/:campusId", auth.authenticateSuperAdmin, updateCampus);
router.get("/campuses", auth.authenticateSuperAdmin, auth.attachSchoolId, getCampuses);

// Subject routes
router.post("/subject/create", auth.authenticateSuperAdmin, auth.attachSchoolId, createSubject);
router.get("/subjects", auth.authenticateSuperAdmin, auth.attachSchoolId, getAllSubjects);
router.put("/subject/:subjectId", auth.authenticateSuperAdmin, auth.attachSchoolId, editSubject);
router.delete("/subject/:subjectId", auth.authenticateSuperAdmin, deleteSubject);


// List all CA for the authenticated admin’s school
// Optional filters: classId, subjectId, campusId, name; pagination: page, pageSize
router.get('/assessments', auth.authenticateAdmin, auth.attachSchoolId, getSchoolAssessments);

router.get("/ca-template", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getCATemplates);

// Grading routes using ts and oop concept
const gradingController = new GradingController();

router.post('/grading/create', auth.authenticateSuperAdmin, auth.attachSchoolId, gradingController.create);

router.put('/grading/:schemeId', auth.authenticateSuperAdmin, auth.attachSchoolId, gradingController.update);

router.get('/grading', auth.authenticateSuperAdmin, auth.attachSchoolId, gradingController.getSchemes);

router.post(
  "/grading/:schemeId/classes",
  auth.authenticateSuperAdmin,
  auth.attachSchoolId,
  gradingController.addApplicableClasses
);

router.delete(
  "/grading/:schemeId",
  auth.authenticateSuperAdmin,
  auth.attachSchoolId,
  gradingController.deleteScheme
);

// Remark scheme routes
router.post("/remark-scheme/create", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.createRemarkScheme);
router.post("/remark-scheme/:schemeId/rules", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.addRemarkRules);
router.get("/remark-scheme", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getRemarkScheme);

router.delete(
  "/grading/remark/:ruleId",
  auth.authenticateSuperAdmin,
  auth.attachSchoolId,
  gradingController.deleteRemark
);

// School-wide template (no classId — applies to all classes):
router.post("/ca-template", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.createCATemplate);
router.post("/class-subject/assign", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.assignSubjectsToClass);
router.get("/class-subject/:classId", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getClassSubjects);
router.delete("/class-subject/:classId/:subjectId", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.deleteSubjectFromClass);

// broadsheet
router.get("/broadsheet", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getAdminBroadsheet);


router.post("/results/publish", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.publishResults);
router.get("/results", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getResultsByStatus);
router.get("/results/submissions", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getPendingSubmissions);
router.get("/results/rejected", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getRejectedResults);
router.delete("/results/submissions/:submissionId/reject", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.rejectSubmission);
router.put("/results/rejected/:submissionId/restore", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.restoreRejectedSubmission);
router.delete("/results/published/:publishedResultId/unpublish", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.unpublishResults);

router.get("/result/student", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getStudentResult);
router.get("/result/teacher", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getTeacherResult);
router.get("/result/student/:studentId", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.getStudentCompleteResult);

// Academic term routes
router.post("/term", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.createTerm);
router.put("/term/:id", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.updateTerm);
router.patch("/term/:id/activate", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.activateTerm);
router.get("/terms", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.getTerms);
router.get("/active-term", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.getActiveTerm);
router.get("/overview", auth.authenticateSuperAdmin, auth.attachSchoolId, getOverview);

router.post("/session", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.createSession);
router.get("/sessions", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.getSessions);
router.patch("/exam/:examId/schedule", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.scheduleExam);




module.exports = router;
