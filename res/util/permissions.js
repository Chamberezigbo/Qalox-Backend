/**
 * Sub-admin permission keys.
 *
 * Head admins (role=super_admin or role=school_admin) always have full access
 * regardless of this list — it only restricts role=sub_admin accounts.
 *
 * This list mirrors the actual admin sidebar modules 1:1 (see the school-admin
 * frontend's sub-admin creation form) so a granted permission maps directly to
 * a section of the dashboard. "Sub-Admin" management itself is intentionally
 * excluded — it's head-admin-only and never delegable.
 */
const PERMISSIONS = {
  OVERVIEW_VIEW: "overview.view",
  STUDENTS_MANAGE: "students.manage",
  STAFF_MANAGE: "staff.manage",
  CLASSES_MANAGE: "classes.manage",
  SUBJECTS_MANAGE: "subjects.manage",
  CAMPUSES_MANAGE: "campuses.manage",
  RESULTS_MANAGE: "results.manage",
  RESULTS_GENERATE: "results.generate",
  CA_TEMPLATE_MANAGE: "ca_template.manage",
  FEES_MANAGE: "fees.manage",
  SMS_BROADCAST_SEND: "sms_broadcast.send",
  ANALYTICS_VIEW: "analytics.view",
  EXAMS_MANAGE: "exams.manage",
};

// Human-readable labels, matching the frontend's sidebar module names exactly.
const PERMISSION_LABELS = {
  [PERMISSIONS.OVERVIEW_VIEW]: "Overview",
  [PERMISSIONS.STUDENTS_MANAGE]: "Manage Students",
  [PERMISSIONS.STAFF_MANAGE]: "Manage Staff",
  [PERMISSIONS.CLASSES_MANAGE]: "Manage Classes",
  [PERMISSIONS.SUBJECTS_MANAGE]: "Manage Subject",
  [PERMISSIONS.CAMPUSES_MANAGE]: "Campuses",
  [PERMISSIONS.RESULTS_MANAGE]: "Manage Result",
  [PERMISSIONS.RESULTS_GENERATE]: "Generate Result",
  [PERMISSIONS.CA_TEMPLATE_MANAGE]: "CA Template",
  [PERMISSIONS.FEES_MANAGE]: "Fee Management",
  [PERMISSIONS.SMS_BROADCAST_SEND]: "Broadcast Notices",
  [PERMISSIONS.ANALYTICS_VIEW]: "Campus Analytics",
  [PERMISSIONS.EXAMS_MANAGE]: "Manage Exams",
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// Sub-admin type presets — informational defaults a head admin can start from
// when creating a sub-admin; the actual granted set is whatever is stored on
// the `permissions` field, not derived from `subAdminType` at request time.
const SUB_ADMIN_TYPES = ["hr", "secretary", "bursar", "other"];

const SUB_ADMIN_TYPE_DEFAULTS = {
  hr: [PERMISSIONS.STAFF_MANAGE],
  secretary: [PERMISSIONS.STUDENTS_MANAGE, PERMISSIONS.CLASSES_MANAGE],
  bursar: [PERMISSIONS.FEES_MANAGE],
  other: [],
};

const isValidPermission = (key) => ALL_PERMISSIONS.includes(key);

const parsePermissions = (permissionsJson) => {
  if (!permissionsJson) return [];
  try {
    const parsed = JSON.parse(permissionsJson);
    return Array.isArray(parsed) ? parsed.filter(isValidPermission) : [];
  } catch {
    return [];
  }
};

module.exports = {
  PERMISSIONS,
  PERMISSION_LABELS,
  ALL_PERMISSIONS,
  SUB_ADMIN_TYPES,
  SUB_ADMIN_TYPE_DEFAULTS,
  isValidPermission,
  parsePermissions,
};
