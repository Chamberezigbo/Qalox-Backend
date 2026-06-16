const express = require("express");
const auth = require("../middleware/authenticateSuperAdmin");
const authLogin = require("../middleware/authLogin");
const academicController = require("../controller/admin/setup");

const router = express.Router();

router.use(authLogin);

router.post("/class", auth.authenticateSuperAdmin, academicController.createClasses);
router.post(
  "/campus",
  auth.authenticateSuperAdmin,
  academicController.createCampuses
);

module.exports = router;
