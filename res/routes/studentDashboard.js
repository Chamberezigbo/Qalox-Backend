const express = require("express");

const router = express.Router();

const { StudentResultController } = require("../controller/student/StudentResultController");

const studentResultController = new StudentResultController();

const { StudentDashboardController } = require("../controller/student/StudentDashboardController");
const { StudentAssignmentController } = require("../controller/student/StudentAssignmentController");
const { StudentFeeController } = require("../controller/student/StudentFeeController");
const studentPracticeController = require("../controller/student/StudentPracticeController");
const { StudentExamController } = require("../controller/student/StudentExamController");
const { studentAuthMiddleware } = require("../middleware/studentMiddleware");
const studentTestController = require("../controller/student/StudentTestController");

const studentDashboardController = new StudentDashboardController();
const studentAssignmentController = new StudentAssignmentController();
const studentFeeController = new StudentFeeController();
const studentExamController = new StudentExamController();

// Protected — token required
router.get("/student/metrics", studentAuthMiddleware, studentDashboardController.getDashboard);
router.get("/student/sessions", studentAuthMiddleware, studentResultController.getSessions);
router.get("/student/results",  studentAuthMiddleware, studentResultController.getResults);
router.get("/student/report-card", studentAuthMiddleware, studentResultController.getReportCard);
router.get("/student/report-card.pdf", studentAuthMiddleware, studentResultController.getReportCardPdf);
router.get("/student/assignments", studentAuthMiddleware, studentAssignmentController.list);
router.get("/student/fees", studentAuthMiddleware, studentFeeController.getFees);
router.get("/student/bank-accounts", studentAuthMiddleware, studentFeeController.getBankAccounts);
router.post("/student/fees/:studentFeeId/declare", studentAuthMiddleware, studentFeeController.declarePayment);
router.get("/student/fee-collection", studentAuthMiddleware, studentFeeController.getFeeCollection);
router.post("/student/fees/:studentFeeId/pay-online", studentAuthMiddleware, studentFeeController.payOnline);
router.get("/student/fee-payments/:reference", studentAuthMiddleware, studentFeeController.getFeePayment);
router.get("/student/fees/:studentFeeId/receipt", studentAuthMiddleware, studentFeeController.getReceipt);
router.get("/student/exams/upcoming", studentAuthMiddleware, studentExamController.getUpcomingExams);

// Multiple-choice tests set by teachers for the student's class.
router.get("/student/tests", studentAuthMiddleware, studentTestController.list);
router.post("/student/tests/:testId/start", studentAuthMiddleware, studentTestController.start);
router.get("/student/tests/attempts/:attemptId", studentAuthMiddleware, studentTestController.getAttempt);
router.put("/student/tests/attempts/:attemptId/answer", studentAuthMiddleware, studentTestController.saveAnswer);
router.post("/student/tests/attempts/:attemptId/submit", studentAuthMiddleware, studentTestController.submit);

// Practice with past questions (BECE, WASSCE, WAEC, NECO, WAEC GCE, TVET): a bank shared by every school.
router.get("/student/practice/catalog", studentAuthMiddleware, studentPracticeController.catalog);
router.post("/student/practice/sessions", studentAuthMiddleware, studentPracticeController.start);
router.get("/student/practice/sessions/:id", studentAuthMiddleware, studentPracticeController.get);
router.put("/student/practice/sessions/:id/answer", studentAuthMiddleware, studentPracticeController.answer);
router.post("/student/practice/sessions/:id/submit", studentAuthMiddleware, studentPracticeController.submit);
router.get("/student/practice/history", studentAuthMiddleware, studentPracticeController.history);
router.get("/student/practice/progress", studentAuthMiddleware, studentPracticeController.progress);
router.post("/student/practice/questions/:id/report", studentAuthMiddleware, studentPracticeController.report);

module.exports = router;