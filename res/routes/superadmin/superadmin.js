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
const { getCommunications, sendCommunication } = require("../../controller/superadmin/CommunicationsController");
const { getSystemNotifications, sendSystemNotification } = require("../../controller/superadmin/NotificationsController");
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

// ============================================
// COMMUNICATIONS
// ============================================
router.get("/communications", authenticateSuperAdminJWT, getCommunications);
router.post("/communications", authenticateSuperAdminJWT, sendCommunication);

// ============================================
// SYSTEM NOTIFICATIONS
// ============================================
router.get("/notifications", authenticateSuperAdminJWT, getSystemNotifications);
router.post("/notifications", authenticateSuperAdminJWT, sendSystemNotification);

// ============================================
// ANALYTICS
// ============================================
router.get("/analytics/stats", authenticateSuperAdminJWT, getAnalyticsStats);
router.get("/analytics/schools", authenticateSuperAdminJWT, getSchoolActivities);
router.get("/analytics/logins", authenticateSuperAdminJWT, getLoginRecords);
router.get("/analytics/features", authenticateSuperAdminJWT, getFeatureUsage);

module.exports = router;
