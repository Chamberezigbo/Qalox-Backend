const express = require("express");

const { ParentAuthController } = require("../controller/auth/ParentAuthController");
const { ParentController } = require("../controller/ParentController");
const { parentAuthMiddleware } = require("../middleware/parentMiddleware");

const router = express.Router();

const parentAuthController = new ParentAuthController();
const parentController = new ParentController();

router.post("/signup", parentAuthController.signup);
router.post("/login", parentAuthController.login);
router.post("/link-child", parentAuthMiddleware, parentAuthController.linkChild);

router.get("/children", parentAuthMiddleware, parentController.getChildren);
router.get("/children/:studentId/results", parentAuthMiddleware, parentController.getChildResults);
router.get("/children/:studentId/attendance", parentAuthMiddleware, parentController.getChildAttendance);
router.get("/children/:studentId/fees", parentAuthMiddleware, parentController.getChildFees);
router.post("/children/:studentId/fees/:studentFeeId/pay", parentAuthMiddleware, parentController.initiateFeePayment);

router.get("/alerts", parentAuthMiddleware, parentController.getAlerts);
router.patch("/alerts/:alertId/read", parentAuthMiddleware, parentController.markAlertRead);

module.exports = router;
