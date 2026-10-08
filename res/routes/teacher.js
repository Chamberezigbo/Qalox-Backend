const express = require("express");

const { TeacherAuthController } = require("../controller/auth/TeacherAuthController");
const { TeacherOverviewController } = require("../controller/teacher/TeacherOverviewController");
const { TeacherController } = require("../controller/teacher/TeacherController");
const { AttendanceController } = require("../controller/teacher/AttendanceController");
const { TeacherAnalyticsController } = require("../controller/teacher/TeacherAnalyticsController");
const { AssignmentController } = require("../controller/teacher/AssignmentController");
const { ExamTimetableController } = require("../controller/teacher/ExamTimetableController");
const { teacherAuthMiddleware } = require("../middleware/teacherMiddleware");
const uploadAssignment = require("../middleware/uploadAssignment");
const uploadSchemeOfWork = require("../middleware/uploadSchemeOfWork");
const notificationController = require("../controller/NotificationController");


const router = express.Router();

const teacherAuthController = new TeacherAuthController();
const teacherOverviewController = new TeacherOverviewController();
const teacherController = new TeacherController();
const attendanceController = new AttendanceController();
const teacherAnalyticsController = new TeacherAnalyticsController();
const assignmentController = new AssignmentController();
const lessonNoteController = require("../controller/teacher/LessonNoteController");
const teacherSchemeOfWorkController = require("../controller/teacher/SchemeOfWorkController");
const examTimetableController = new ExamTimetableController();

router.post("/login", teacherAuthController.login);
router.get("/overview", teacherAuthMiddleware, teacherOverviewController.getOverview);
router.get("/exams/upcoming", teacherAuthMiddleware, examTimetableController.getUpcomingExams);

// Notification bell
router.get("/notifications", teacherAuthMiddleware, notificationController.teacher.list);
router.patch("/notifications/:id/read", teacherAuthMiddleware, notificationController.teacher.markRead);
router.patch("/notifications/read-all", teacherAuthMiddleware, notificationController.teacher.markAllRead);

// Get students assigned to teacher
router.get("/my-students", teacherAuthMiddleware, teacherController.getStudentsForGrading);

// new: write/edit scores
router.post("/scores/ca", teacherAuthMiddleware, teacherController.upsertCAScores);
router.post("/scores/exam", teacherAuthMiddleware, teacherController.upsertExamScores);

// new: computed result sheet
router.get("/results", teacherAuthMiddleware, teacherController.getComputedResults);

// NOTE: Grading scheme creation/management has been moved to admin-only endpoints (POST /admin/grading/create)
// Teachers can view results using existing schemes but cannot create/modify grading schemes
// Subjects this teacher teaches in one class. Declared before the
// /subjects/:subjectId/* routes; Express matches the exact path first either
// way, but keeping them together makes the pair obvious.
router.get("/subjects", teacherAuthMiddleware, teacherController.getSubjectsForClass);
router.get("/subjects/:subjectId/cas", teacherAuthMiddleware, teacherController.getSubjectCAs);
router.get("/subjects/:subjectId/exams", teacherAuthMiddleware, teacherController.getSubjectExams);


// Broadsheet
router.get("/broadsheet", teacherAuthMiddleware, teacherController.getTeacherBroadsheet);

// Teacher submits results for admin review (locks scores)
router.post("/results/submit", teacherAuthMiddleware, teacherController.submitResults);
// Every subject the teacher is assigned in one class, in a single request.
router.post("/results/submit-all", teacherAuthMiddleware, teacherController.submitAllResults);

router.get("/active-term", teacherAuthMiddleware, teacherController.getActiveTerm);

// New teacher data endpoints
router.get("/classes", teacherAuthMiddleware, teacherController.getMyClasses);
router.get("/campuses", teacherAuthMiddleware, teacherController.getMyCampus);
router.get("/class-groups", teacherAuthMiddleware, teacherController.getMyClassGroups);
router.get("/sessions", teacherAuthMiddleware, teacherController.getActiveSession);
router.get("/students", teacherAuthMiddleware, teacherController.getStudents);
router.get("/students-with-scores", teacherAuthMiddleware, teacherController.getStudentsWithScores);
router.get("/my-subjects", teacherAuthMiddleware, teacherController.getTeacherSubjects);
router.get("/profile", teacherAuthMiddleware, teacherController.getTeacherDetails);
router.get("/school/branding", teacherAuthMiddleware, teacherController.getSchoolBranding);

// Assignment Board
router.post("/assignments", teacherAuthMiddleware, uploadAssignment.single("attachment"), assignmentController.create);
router.get("/assignments", teacherAuthMiddleware, assignmentController.list);
router.patch("/assignments/:id", teacherAuthMiddleware, uploadAssignment.single("attachment"), assignmentController.update);
router.delete("/assignments/:id", teacherAuthMiddleware, assignmentController.remove);

// AI Lesson Notes. Generation is async — /generate returns a jobId the client
// polls, because a Gemini call takes far longer than a request should hold open.
// Scheme of Work — teachers upload for classes they teach; admins still have
// their own school-wide routes under /api/admin/scheme-of-work. Accepts one
// PDF or up to 10 page photos per upload (see uploadSchemeOfWork).
router.post("/scheme-of-work", teacherAuthMiddleware, uploadSchemeOfWork.array("files"), teacherSchemeOfWorkController.uploadSchemeOfWork);
router.get("/scheme-of-work", teacherAuthMiddleware, teacherSchemeOfWorkController.listSchemesOfWork);
router.get("/scheme-of-work/:id", teacherAuthMiddleware, teacherSchemeOfWorkController.getSchemeOfWork);
router.delete("/scheme-of-work/:id", teacherAuthMiddleware, teacherSchemeOfWorkController.deleteSchemeOfWork);

router.post("/lesson-notes/generate", teacherAuthMiddleware, lessonNoteController.generateLessonNote);
router.get("/lesson-notes/generate/:jobId", teacherAuthMiddleware, lessonNoteController.getGenerationStatus);
router.get("/lesson-notes", teacherAuthMiddleware, lessonNoteController.listLessonNotes);
router.get("/lesson-notes/:id", teacherAuthMiddleware, lessonNoteController.getLessonNote);
router.patch("/lesson-notes/:id", teacherAuthMiddleware, lessonNoteController.updateLessonNote);
router.delete("/lesson-notes/:id", teacherAuthMiddleware, lessonNoteController.deleteLessonNote);
router.get("/ai/credits", teacherAuthMiddleware, lessonNoteController.getAiCredits);

router.get("/ca", teacherAuthMiddleware, teacherController.getCAs);
router.get("/exam", teacherAuthMiddleware, teacherController.getExams);

// Attendance
router.post("/attendance/mark", teacherAuthMiddleware, attendanceController.markAttendance);
router.get("/attendance", teacherAuthMiddleware, attendanceController.getAttendance);
router.get("/attendance/report", teacherAuthMiddleware, attendanceController.getAttendanceReport);

// Performance Analytics
router.get("/analytics/overview", teacherAuthMiddleware, teacherAnalyticsController.getOverview);
router.get("/analytics/best-students", teacherAuthMiddleware, teacherAnalyticsController.getBestStudents);
router.get("/analytics/weak-students", teacherAuthMiddleware, teacherAnalyticsController.getWeakStudents);
router.get("/analytics/subject-failure-rates", teacherAuthMiddleware, teacherAnalyticsController.getSubjectFailureRates);


module.exports = router;
