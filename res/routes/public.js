const express = require("express");
const { getSchoolsPublic, getAssessmentsPublic } = require("../controller/public/publicController");

const router = express.Router();

// Public endpoints (no auth)
router.get("/schools", getSchoolsPublic);
router.get("/assessments", getAssessmentsPublic);

module.exports = router;
