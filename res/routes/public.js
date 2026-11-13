const express = require("express");
const { getSchoolsPublic, getAssessmentsPublic } = require("../controller/public/publicController");
const { getBillingPlans, createLandingPageLead } = require("../controller/superadmin/SuperAdminController");
const { serviceAuth } = require("../middleware/serviceAuth");

const router = express.Router();

// Authenticated: returns every school's name, email, suspension state and the
// school admin's name and email — the full customer list. This was previously
// mounted with no auth at all, which exposed it to anyone who knew the URL.
router.get("/schools", serviceAuth, getSchoolsPublic);
router.get("/assessments", serviceAuth, getAssessmentsPublic);

// GET /api/public/plans - List active billing plans (Super Admin Portal, no auth required)
router.get("/plans", getBillingPlans);

// POST /api/public/leads - Landing page "Book a Demo" form submission (no auth required)
router.post("/leads", createLandingPageLead);

// Gate-screen tablets for staff QR attendance (they authenticate with their own secret key).
const gateController = require("../controller/StaffAttendanceController").gate;
const gateHits = new Map();
const gateLimit = (req, res, next) => {
  const minute = Math.floor(Date.now() / 60000);
  const k = `${req.ip}:${minute}`;
  const n = (gateHits.get(k) || 0) + 1;
  gateHits.set(k, n);
  if (gateHits.size > 5000) for (const key of gateHits.keys()) if (!key.endsWith(`:${minute}`)) gateHits.delete(key);
  if (n > 40) return res.status(429).json({ success: false, message: "Too many requests" });
  next();
};
router.post("/gate/start", gateLimit, gateController.start);
router.post("/gate/token", gateLimit, gateController.token);

module.exports = router;
