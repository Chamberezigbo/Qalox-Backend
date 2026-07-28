const express = require("express");
const { getSchoolsPublic, getAssessmentsPublic } = require("../controller/public/publicController");
const { getBillingPlans } = require("../controller/superadmin/SuperAdminController");

const router = express.Router();

// Public endpoints (no auth)
router.get("/schools", getSchoolsPublic);
router.get("/assessments", getAssessmentsPublic);

// GET /api/public/plans - List active billing plans (Super Admin Portal, no auth required)
router.get("/plans", getBillingPlans);

module.exports = router;
