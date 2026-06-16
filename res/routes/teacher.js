const express = require("express");

const { TeacherAuthController } = require("../controller/auth/TeacherAuthController");
const { TeacherOverviewController } = require("../controller/teacher/TeacherOverviewController");
const { TeacherController } = require("../controller/teacher/TeacherController");
const { teacherAuthMiddleware } = require("../middleware/teacherMiddleware");


const router = express.Router();

const teacherAuthController = new TeacherAuthController();
const teacherOverviewController = new TeacherOverviewController();
const teacherController = new TeacherController();

router.post("/login", teacherAuthController.login);
router.get("/overview", teacherAuthMiddleware, teacherOverviewController.getOverview);

// Get students assigned to teacher
router.get("/my-students", teacherAuthMiddleware, teacherController.getStudentsForGrading);

// new: write/edit scores
router.post("/scores/ca", teacherAuthMiddleware, teacherController.upsertCAScores);
router.post("/scores/exam", teacherAuthMiddleware, teacherController.upsertExamScores);

// new: computed result sheet
router.get("/results", teacherAuthMiddleware, teacherController.getComputedResults);

// NOTE: Grading scheme creation/management has been moved to admin-only endpoints (POST /admin/grading/create)
// Teachers can view results using existing schemes but cannot create/modify grading schemes
router.get("/subjects/:subjectId/cas", teacherAuthMiddleware, teacherController.getSubjectCAs);
router.get("/subjects/:subjectId/exams", teacherAuthMiddleware, teacherController.getSubjectExams);


// Broadsheet
router.get("/broadsheet", teacherAuthMiddleware, teacherController.getTeacherBroadsheet);

// Teacher submits results for admin review (locks scores)
router.post("/results/submit", teacherAuthMiddleware, teacherController.submitResults);

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

router.get("/ca", teacherAuthMiddleware, teacherController.getCAs);
router.get("/exam", teacherAuthMiddleware, teacherController.getExams);


module.exports = router;
