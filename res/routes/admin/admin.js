const express = require("express");
const upload = require("../../middleware/upload");


const {
  createAdmin,
  loginAdmin,
  forgotPassword,
  resetPassword,
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
  getSingleStudent, bulkCreateStudents,
} = require("../../controller/admin/StudentController");

const {
  uploadDocument,
  getImportStatus,
  updateRecord,
  confirmImport,
  downloadFailedRecords,
} = require("../../controller/admin/BulkImportController");

const uploadBulkImport = require("../../middleware/uploadBulkImport");

const {
  upsertFeeStructure,
  getFeeStructures,
  getStudentFees,
  getDebtSummary,
  recordPayment,
  getReceipt,
  sendFeeReminders,
  getBanks,
  resolveBankAccount,
  createBankAccount,
  getBankAccounts,
  updateBankAccount,
  deleteBankAccount,
  listPendingPayments,
  approvePayment,
  rejectPayment,
  sendReceiptEmail,
} = require("../../controller/admin/FeeManagementController");

const {
  getSmsQuota,
  createBroadcast,
  getBroadcasts,
} = require("../../controller/admin/NoticeController");

const {
  getCampusAnalytics,
} = require("../../controller/admin/AnalyticsController");

const {
  getAvailablePermissions,
  createSubAdmin,
  getSubAdmins,
  updateSubAdmin,
  deleteSubAdmin,
} = require("../../controller/admin/SubAdminController");

const { PERMISSIONS } = require("../../util/permissions");

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
  reassignTeacher, bulkCreateStaff
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

const { AdminParentController } = require("../../controller/admin/AdminParentController");
const adminParentController = new AdminParentController();

const examScheduleController = require("../../controller/admin/examSchedule");
const {
  examScheduleHeaderSchema,
  examScheduleHeaderUpdateSchema,
  replaceEntriesSchema,
  updateEntrySchema,
  autoGenerateSchema,
} = require("../../schemas/examScheduleSchema");

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
const notificationController = require("../../controller/NotificationController");

const router = express.Router();

router.post("/create", validate(createAdminSchema), createAdmin);
router.post("/login", validate(loginSchema), loginAdmin);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

router.get("/school-admins", auth.authenticateSuperAdmin, auth.attachSchoolId, getSchoolAdmins);
router.put("/:id", validate(updateAdminSchema), updateAdmin);
router.delete("/:id", auth.authenticateSuperAdmin, deleteAdmin);
router.get("/", checkHealth);

// My school info for any authenticated admin
router.get("/my-school", auth.authenticateAdmin, getMySchool);

// Notification bell — admin/sub-admin
router.get("/notifications", auth.authenticateSchoolLevelAdmin, notificationController.admin.list);
router.patch("/notifications/:id/read", auth.authenticateSchoolLevelAdmin, notificationController.admin.markRead);
router.patch("/notifications/read-all", auth.authenticateSchoolLevelAdmin, notificationController.admin.markAllRead);

// Student routes — sub-admins need PERMISSIONS.STUDENTS_MANAGE; head admins always pass
router.get("/students", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STUDENTS_MANAGE), auth.attachSchoolId, getStudentDetails);
router.post("/student/create",
  upload.single("passport"),
  validate(studentSchema),
  auth.authenticateSchoolLevelAdmin,
  auth.requirePermission(PERMISSIONS.STUDENTS_MANAGE),
  auth.attachSchoolId,
  createStudent
);
router.put("/student/:id",
  upload.single("passport"),
  auth.authenticateSchoolLevelAdmin,
  auth.requirePermission(PERMISSIONS.STUDENTS_MANAGE),
  updateStudent
);

router.patch("/student/change-class", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STUDENTS_MANAGE), changeStudentClass);
router.get("/student/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STUDENTS_MANAGE), getSingleStudent);
router.post("/students/bulk-upload", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STUDENTS_MANAGE), auth.attachSchoolId, bulkCreateStudents);

// Bulk import (students + staff). No requirePermission() here: which permission
// applies depends on the entity being imported, which is only known from the
// request body (upload) or the stored job (everything else), so the controller
// gates each call itself. Auth still runs first — the controller needs req.user.
//
// Auth runs BEFORE multer on the upload route, so an unauthenticated caller
// cannot make the server buffer a 10MB file in memory before being rejected.
// Auth only reads the Authorization header, so it does not need the parsed body.
router.post("/bulk-import/upload", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, uploadBulkImport.single("file"), uploadDocument);
router.get("/bulk-import/:importId", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, getImportStatus);
router.get("/bulk-import/:importId/failures.csv", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, downloadFailedRecords);
router.patch("/bulk-import/:importId/records/:recordId", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, updateRecord);
router.post("/bulk-import/:importId/confirm", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, confirmImport);

// Sub-admin management routes — head admins only (super_admin/school_admin), not delegable via permissions
router.get("/permissions", auth.authenticateSuperAdmin, getAvailablePermissions);
router.post("/sub-admins/create", auth.authenticateSuperAdmin, auth.attachSchoolId, createSubAdmin);
router.get("/sub-admins", auth.authenticateSuperAdmin, auth.attachSchoolId, getSubAdmins);
router.patch("/sub-admins/:id", auth.authenticateSuperAdmin, auth.attachSchoolId, updateSubAdmin);
router.delete("/sub-admins/:id", auth.authenticateSuperAdmin, auth.attachSchoolId, deleteSubAdmin);

// Staff routes — sub-admins need PERMISSIONS.STAFF_MANAGE; head admins always pass
router.post("/staff/create", validate(staffSchema), auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), auth.attachSchoolId, createStaff);
router.patch("/staff/:staffId", validate(editStaffSchema), auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), updateStaff);
router.get("/staff/:staffId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), getStaffDetails);
router.post('/staff/assign-teacher', validate(assignTeacherSchema), auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), assignTeacher);
router.get("/staff", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), auth.attachSchoolId, getAllStaff);
router.delete("/staff/:staffId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), deleteStaff);
router.patch("/staff/reassign-teacher/:assignmentId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), auth.attachSchoolId, reassignTeacher);
router.post("/staff/bulk-upload", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.STAFF_MANAGE), auth.attachSchoolId, bulkCreateStaff);

// Fee management routes — sub-admins need PERMISSIONS.FEES_MANAGE; head admins always pass
router.post("/fees/structure", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, upsertFeeStructure);
router.get("/fees/structure", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, getFeeStructures);
router.get("/fees/students", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, getStudentFees);
router.get("/fees/debt-summary", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, getDebtSummary);
router.post("/fees/payments", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, recordPayment);
router.get("/fees/receipts/:studentFeeId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, getReceipt);
router.post("/fees/reminders/send-email", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, sendFeeReminders);
router.get("/fees/banks", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, getBanks);
router.get("/fees/resolve-account", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, resolveBankAccount);
router.post("/fees/bank-accounts", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, createBankAccount);
router.get("/fees/bank-accounts", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, getBankAccounts);
router.patch("/fees/bank-accounts/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, updateBankAccount);
router.delete("/fees/bank-accounts/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, deleteBankAccount);
router.get("/fees/payments/pending", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, listPendingPayments);
router.post("/fees/payments/:id/approve", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, approvePayment);
router.post("/fees/payments/:id/reject", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, rejectPayment);
router.post("/fees/receipts/:studentFeeId/send-email", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.FEES_MANAGE), auth.attachSchoolId, sendReceiptEmail);

// Notices / SMS broadcast routes — sub-admins need PERMISSIONS.SMS_BROADCAST_SEND; head admins always pass
router.get("/sms/quota", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SMS_BROADCAST_SEND), auth.attachSchoolId, getSmsQuota);
router.post("/broadcasts", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SMS_BROADCAST_SEND), auth.attachSchoolId, createBroadcast);
router.get("/broadcasts", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SMS_BROADCAST_SEND), auth.attachSchoolId, getBroadcasts);

// Analytics routes — sub-admins need PERMISSIONS.ANALYTICS_VIEW; head admins always pass
router.get("/analytics/campuses", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.ANALYTICS_VIEW), auth.attachSchoolId, getCampusAnalytics);

// Class routes — sub-admins need PERMISSIONS.CLASSES_MANAGE; head admins always pass
router.post("/classes/create", validate(classSchema), auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), auth.attachSchoolId, createClass);
router.get("/classes", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), auth.attachSchoolId, getAllClasses);
router.delete("/classes/:classId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), deleteClass);
router.post("/class-groups/create", validate(classGroupSchema), auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), auth.attachSchoolId, createClassGroup);
router.get("/class-groups", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), auth.attachSchoolId, getClassGroups);
router.patch("/class/update/:classId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), updateClass);
router.patch("/class-group/update/:groupId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CLASSES_MANAGE), updateClassGroup);

// Campus routes — sub-admins need PERMISSIONS.CAMPUSES_MANAGE; head admins always pass
router.post("/campus/create", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CAMPUSES_MANAGE), auth.attachSchoolId, createCampus);
router.patch("/campus/update/:campusId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CAMPUSES_MANAGE), updateCampus);
router.get("/campuses", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CAMPUSES_MANAGE), auth.attachSchoolId, getCampuses);

// Subject routes — sub-admins need PERMISSIONS.SUBJECTS_MANAGE; head admins always pass
router.post("/subject/create", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), auth.attachSchoolId, createSubject);
router.get("/subjects", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), auth.attachSchoolId, getAllSubjects);
router.put("/subject/:subjectId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), auth.attachSchoolId, editSubject);
router.delete("/subject/:subjectId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), deleteSubject);


// List all CA for the authenticated admin’s school
// Optional filters: classId, subjectId, campusId, name; pagination: page, pageSize
router.get('/assessments', auth.authenticateAdmin, auth.attachSchoolId, getSchoolAssessments);

// CA Template routes — sub-admins need PERMISSIONS.CA_TEMPLATE_MANAGE; head admins always pass
router.get("/ca-template", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CA_TEMPLATE_MANAGE), auth.attachSchoolId, assessmentController.getCATemplates);

// Grading & remark-scheme routes: intentionally head-admin-only (no permission
// key exists for these — a school's grading scheme is a single source of truth
// used by both TeacherService.computeClassResults and AssessmentService, so it
// isn't delegable to sub-admins the way other modules are).
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
router.post("/ca-template", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.CA_TEMPLATE_MANAGE), auth.attachSchoolId, assessmentController.createCATemplate);
router.post("/class-subject/assign", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), auth.attachSchoolId, assessmentController.assignSubjectsToClass);
router.get("/class-subject/:classId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), auth.attachSchoolId, assessmentController.getClassSubjects);
router.delete("/class-subject/:classId/:subjectId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.SUBJECTS_MANAGE), auth.attachSchoolId, assessmentController.deleteSubjectFromClass);

// broadsheet + publishing — sub-admins need PERMISSIONS.RESULTS_GENERATE (the "Generate Result" page)
router.get("/broadsheet", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_GENERATE), auth.attachSchoolId, assessmentController.getAdminBroadsheet);
router.post("/results/publish", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_GENERATE), auth.attachSchoolId, assessmentController.publishResults);

// Reviewing/managing already-computed results — sub-admins need PERMISSIONS.RESULTS_MANAGE (the "Manage Result" page)
router.get("/results", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.getResultsByStatus);
router.get("/results/submissions", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.getPendingSubmissions);
router.get("/results/rejected", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.getRejectedResults);
router.delete("/results/submissions/:submissionId/reject", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.rejectSubmission);
router.put("/results/rejected/:submissionId/restore", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.restoreRejectedSubmission);
router.delete("/results/published/:publishedResultId/unpublish", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.unpublishResults);

router.get("/result/student", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.getStudentResult);
router.get("/result/teacher", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.getTeacherResult);
router.get("/result/student/:studentId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.RESULTS_MANAGE), auth.attachSchoolId, assessmentController.getStudentCompleteResult);

// Academic term / session / exam-schedule routes: intentionally head-admin-only
// (no permission key exists — these back the "Session Setup" and "Exams"
// sidebar items, which are hidden from sub-admins on the frontend for the
// same reason).
router.post("/term", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.createTerm);
router.put("/term/:id", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.updateTerm);
router.patch("/term/:id/activate", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.activateTerm);
router.get("/terms", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.getTerms);
router.get("/active-term", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.getActiveTerm);

// Overview — every admin type's landing page after login, so it's open to any
// authenticated school-level admin (head or sub-admin) rather than gated behind
// a specific permission; the data itself is aggregate counts only (no financial
// or individually-identifying data), so there's nothing here to restrict.
router.get("/overview", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, getOverview);

router.post("/session", auth.authenticateSuperAdmin, auth.attachSchoolId, termController.createSession);
// Read-only, no sensitive data (session names only) — open to any school-level
// admin so a sub-admin with EXAMS_MANAGE can populate the exam-schedule
// wizard's session dropdown, matching the /overview precedent above.
router.get("/sessions", auth.authenticateSchoolLevelAdmin, auth.attachSchoolId, termController.getSessions);
router.patch("/exam/:examId/schedule", auth.authenticateSuperAdmin, auth.attachSchoolId, assessmentController.scheduleExam);

// Exam scheduling wizard — bulk-schedule exams across classes/subjects with
// a real date/time/duration, separate from the CA-template-driven Exam model
// above. See ExamScheduleService for the model split rationale.
router.post("/exam-schedules", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, validate(examScheduleHeaderSchema), examScheduleController.createExamSchedule);
router.get("/exam-schedules", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, examScheduleController.listExamSchedules);
router.get("/exam-schedules/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, examScheduleController.getExamSchedule);
router.patch("/exam-schedules/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, validate(examScheduleHeaderUpdateSchema), examScheduleController.updateExamSchedule);
router.delete("/exam-schedules/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, examScheduleController.deleteExamSchedule);
router.post("/exam-schedules/:id/entries", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, validate(replaceEntriesSchema), examScheduleController.replaceEntries);
router.patch("/exam-schedules/:id/entries/:entryId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, validate(updateEntrySchema), examScheduleController.updateEntry);
router.delete("/exam-schedules/:id/entries/:entryId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, examScheduleController.deleteEntry);
router.post("/exam-schedules/:id/auto-generate", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, validate(autoGenerateSchema), examScheduleController.autoGenerate);
router.post("/exam-schedules/:id/publish", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, examScheduleController.publishExamSchedule);
router.post("/exam-schedules/:id/unpublish", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.EXAMS_MANAGE), auth.attachSchoolId, examScheduleController.unpublishExamSchedule);

// Parent credentials — creates (or links an existing) real Parent account to
// a student, replacing what was previously a frontend-only mock.
router.post("/parents", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.PARENTS_MANAGE), auth.attachSchoolId, adminParentController.create);
router.get("/parents", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.PARENTS_MANAGE), auth.attachSchoolId, adminParentController.list);
router.patch("/parents/:id", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.PARENTS_MANAGE), auth.attachSchoolId, adminParentController.update);
router.patch("/parents/:id/reset-password", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.PARENTS_MANAGE), auth.attachSchoolId, adminParentController.resetPassword);
router.post("/parents/:id/children", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.PARENTS_MANAGE), auth.attachSchoolId, adminParentController.linkChildren);
router.delete("/parents/:id/children/:studentId", auth.authenticateSchoolLevelAdmin, auth.requirePermission(PERMISSIONS.PARENTS_MANAGE), auth.attachSchoolId, adminParentController.unlinkChild);




module.exports = router;
