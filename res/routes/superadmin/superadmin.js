const express = require("express");
const {
  login,
  getProfile,
  generateToken,
  getTokens,
  register,
  updateProfile,
  changePassword,
  revokeToken,
  getDashboardStats,
  getSettings,
  updateSettings,
  getSchoolAdmins,
  suspendSchoolAdmin,
  resetSchoolAdminPassword,
  getMarketerStats,
  getLandingPageLeads,
  updateLandingPageLeadStatus,
} = require("../../controller/superadmin/SuperAdminController");
const {
  initializePayment,
  getBillingStats,
  getSubscriptions,
  updateSubscription,
  createBillingPlan,
  updateBillingPlan,
  startTrial,
} = require("../../controller/superadmin/BillingController");
const {
  createCoupon,
  getCoupons,
  deactivateCoupon,
} = require("../../controller/superadmin/CouponController");
const {
  getCommunications,
  sendCommunication,
  getCommunicationRecipients,
} = require("../../controller/superadmin/CommunicationsController");
const {
  getSystemNotifications,
  sendSystemNotification,
  cancelSystemNotification,
} = require("../../controller/superadmin/NotificationsController");
const {
  getAnalyticsStats,
  getSchoolActivities,
  getLoginRecords,
  getFeatureUsage,
} = require("../../controller/superadmin/AnalyticsController");
const authenticateSuperAdminJWT = require("../../middleware/authenticateSuperAdminJWT");
const validate = require("../../middleware/validator");
const {
  loginSchema,
  generateTokenSchema,
  registerSchema,
  updateProfileSchema,
  changePasswordSchema,
  updateSettingsSchema,
} = require("../../schemas/superAdminSchemas");

const router = express.Router();

// NOTE: This router is mounted at "/api" (not "/api/super-admin") to match
// the exact bare paths the Super Admin Portal frontend calls
// (e.g. superAdminApi baseURL = "http://localhost:3000/api", calls POST "/login").

// ============================================
// PHASE 1 - CRITICAL ENDPOINTS
// ============================================

// Login - No authentication required (public)
router.post("/login", validate(loginSchema), login);

// Get authenticated admin's profile - Requires super_admin JWT
router.get("/profile", authenticateSuperAdminJWT, getProfile);

// Generate new registration token - Requires super_admin JWT
router.post("/generate", authenticateSuperAdminJWT, validate(generateTokenSchema), generateToken);

// List all registration tokens (paginated) - Requires super_admin JWT
router.get("/tokens", authenticateSuperAdminJWT, getTokens);

// Landing page lead follow-up queue - Requires super_admin JWT
router.get("/leads", authenticateSuperAdminJWT, getLandingPageLeads);
router.patch("/leads/:id/status", authenticateSuperAdminJWT, updateLandingPageLeadStatus);

// ============================================
// PHASE 2 - HIGH PRIORITY ENDPOINTS
// ============================================

// Register new admin with token - No authentication required (public)
router.post("/register", validate(registerSchema), register);

// Update authenticated admin's profile - Requires super_admin JWT
router.patch("/profile", authenticateSuperAdminJWT, validate(updateProfileSchema), updateProfile);

// Change password - Requires super_admin JWT
router.patch("/change-password", authenticateSuperAdminJWT, validate(changePasswordSchema), changePassword);

// Revoke registration token - Requires super_admin JWT
router.delete("/tokens/:id", authenticateSuperAdminJWT, revokeToken);

// Dashboard statistics - Requires super_admin JWT
router.get("/stats", authenticateSuperAdminJWT, getDashboardStats);

// ============================================
// PHASE 3 - MEDIUM PRIORITY ENDPOINTS
// ============================================

// Get platform settings - Requires super_admin JWT
router.get("/settings", authenticateSuperAdminJWT, getSettings);

// Update platform settings - Requires super_admin JWT
router.patch("/settings", authenticateSuperAdminJWT, validate(updateSettingsSchema), updateSettings);

// Marketer-specific commission overrides - Requires super_admin JWT
router.post("/settings/marketer-commissions", authenticateSuperAdminJWT, async (req, res, next) => {
  const { updateMarketerCommission } = require("../../controller/public/publicController");
  return updateMarketerCommission(req, res, next);
});

router.get("/settings/marketer-commissions/:marketerId", authenticateSuperAdminJWT, async (req, res, next) => {
  const { getMarketerCommission } = require("../../controller/public/publicController");
  return getMarketerCommission(req, res, next);
});

router.delete("/settings/marketer-commissions/:marketerId", authenticateSuperAdminJWT, async (req, res, next) => {
  const { deleteMarketerCommission } = require("../../controller/public/publicController");
  return deleteMarketerCommission(req, res, next);
});

// View a marketer's commission rates (what they see + breakdown) - Super Admin only
router.get("/settings/marketer-commissions/:marketerId/rates", authenticateSuperAdminJWT, async (req, res, next) => {
  const { getMarketerCommissionRates } = require("../../controller/public/publicController");
  // Temporarily set marketer id for the handler to read
  const marketerId = req.params.marketerId;
  req.user = req.user || {};
  req.user.id = Number(marketerId);
  return getMarketerCommissionRates(req, res, next);
});

// ============================================
// PHASE 4 - SCHOOL ADMIN MANAGEMENT
// ============================================

// List school admins (paginated, search/status filter) - Requires super_admin JWT
router.get("/admins", authenticateSuperAdminJWT, getSchoolAdmins);

// Suspend/reactivate a school admin - Requires super_admin JWT
router.patch("/admins/:id/suspend", authenticateSuperAdminJWT, suspendSchoolAdmin);

// Reset a school admin's password - Requires super_admin JWT
router.post("/admins/:id/reset", authenticateSuperAdminJWT, resetSchoolAdminPassword);

// ============================================
// PHASE 4 - MARKETER PLATFORM STATS
// ============================================

// Get platform-wide marketer statistics - Requires super_admin JWT
router.get("/marketers/stats", authenticateSuperAdminJWT, getMarketerStats);

// ============================================
// BILLING (Flutterwave)
// ============================================

// Initialize a school's subscription payment (bank transfer) - Requires super_admin JWT
router.post("/billing/initialize-payment", authenticateSuperAdminJWT, initializePayment);

router.get("/billing/stats", authenticateSuperAdminJWT, getBillingStats);
router.get("/billing/subscriptions", authenticateSuperAdminJWT, getSubscriptions);
router.patch("/billing/subscriptions/:id", authenticateSuperAdminJWT, updateSubscription);
router.post("/billing/plans", authenticateSuperAdminJWT, createBillingPlan);
router.patch("/billing/plans/:id", authenticateSuperAdminJWT, updateBillingPlan);
router.post("/billing/schools/:schoolId/start-trial", authenticateSuperAdminJWT, startTrial);
router.post("/billing/coupons", authenticateSuperAdminJWT, createCoupon);
router.get("/billing/coupons", authenticateSuperAdminJWT, getCoupons);
router.patch("/billing/coupons/:id/deactivate", authenticateSuperAdminJWT, deactivateCoupon);

// ============================================
// COMMUNICATIONS
// ============================================
router.get("/communications", authenticateSuperAdminJWT, getCommunications);
router.get("/communications/recipients", authenticateSuperAdminJWT, getCommunicationRecipients);
router.post("/communications", authenticateSuperAdminJWT, sendCommunication);

// ============================================
// SYSTEM NOTIFICATIONS
// ============================================
router.get("/notifications", authenticateSuperAdminJWT, getSystemNotifications);
router.post("/notifications", authenticateSuperAdminJWT, sendSystemNotification);
router.delete("/notifications/:id", authenticateSuperAdminJWT, cancelSystemNotification);

// ============================================
// ANALYTICS
// ============================================
router.get("/analytics/stats", authenticateSuperAdminJWT, getAnalyticsStats);
router.get("/analytics/schools", authenticateSuperAdminJWT, getSchoolActivities);
router.get("/analytics/logins", authenticateSuperAdminJWT, getLoginRecords);
router.get("/analytics/features", authenticateSuperAdminJWT, getFeatureUsage);

module.exports = router;
