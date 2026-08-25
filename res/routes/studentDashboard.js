const express = require("express");

const router = express.Router();

const { StudentResultController } = require("../controller/student/StudentResultController");

const studentResultController = new StudentResultController();

const { StudentDashboardController } = require("../controller/student/StudentDashboardController");
const { StudentAssignmentController } = require("../controller/student/StudentAssignmentController");
const { StudentFeeController } = require("../controller/student/StudentFeeController");
const { StudentExamController } = require("../controller/student/StudentExamController");
const { studentAuthMiddleware } = require("../middleware/studentMiddleware");

const studentDashboardController = new StudentDashboardController();
const studentAssignmentController = new StudentAssignmentController();
const studentFeeController = new StudentFeeController();
const studentExamController = new StudentExamController();

// Protected — token required
router.get("/student/metrics", studentAuthMiddleware, studentDashboardController.getDashboard);
router.get("/student/sessions", studentAuthMiddleware, studentResultController.getSessions);
router.get("/student/results",  studentAuthMiddleware, studentResultController.getResults);
router.get("/student/assignments", studentAuthMiddleware, studentAssignmentController.list);
router.get("/student/fees", studentAuthMiddleware, studentFeeController.getFees);
router.post("/student/fees/:studentFeeId/pay", studentAuthMiddleware, studentFeeController.initiateFeePayment);
router.get("/student/exams/upcoming", studentAuthMiddleware, studentExamController.getUpcomingExams);

module.exports = router;