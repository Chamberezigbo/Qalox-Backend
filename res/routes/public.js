const express = require("express");
const { getSchoolsPublic, getAssessmentsPublic } = require("../controller/public/publicController");
const { getBillingPlans } = require("../controller/superadmin/SuperAdminController");
const { serviceAuth } = require("../middleware/serviceAuth");

const router = express.Router();

// Authenticated: returns every school's name, email, suspension state and the
// school admin's name and email — the full customer list. This was previously
// mounted with no auth at all, which exposed it to anyone who knew the URL.
router.get("/schools", serviceAuth, getSchoolsPublic);
router.get("/assessments", serviceAuth, getAssessmentsPublic);

// GET /api/public/plans - List active billing plans (Super Admin Portal, no auth required)
router.get("/plans", getBillingPlans);

module.exports = router;
