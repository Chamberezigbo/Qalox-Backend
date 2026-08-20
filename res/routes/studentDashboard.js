const express = require("express");

const router = express.Router();

const { StudentResultController } = require("../controller/student/StudentResultController");

const studentResultController = new StudentResultController();

const { StudentDashboardController } = require("../controller/student/StudentDashboardController");
const { StudentAssignmentController } = require("../controller/student/StudentAssignmentController");
const { studentAuthMiddleware } = require("../middleware/studentMiddleware");

const studentDashboardController = new StudentDashboardController();
const studentAssignmentController = new StudentAssignmentController();

// Protected — token required
router.get("/student/metrics", studentAuthMiddleware, studentDashboardController.getDashboard);
router.get("/student/sessions", studentAuthMiddleware, studentResultController.getSessions);
router.get("/student/results",  studentAuthMiddleware, studentResultController.getResults);
router.get("/student/assignments", studentAuthMiddleware, studentAssignmentController.list);

module.exports = router;