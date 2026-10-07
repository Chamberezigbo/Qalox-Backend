const Joi = require("joi");

exports.createAdminSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  name: Joi.string().required(),
  role: Joi.string().valid("super_admin", "school_admin").required(),
  schoolId: Joi.number().optional(),
  campusId: Joi.when("role", {
    is: "school_admin",
    then: Joi.number().required(),
    otherwise: Joi.forbidden(),
  }),
  uniqueKey: Joi.when("role", {
    is: "super_admin",
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
});

exports.updateAdminSchema = Joi.object({
  name: Joi.string().max(255).optional(),
  email: Joi.string().email().optional(),
  password: Joi.string().min(6).optional(),
  role: Joi.string().valid("super_admin", "school_admin").optional(),
  campusId: Joi.number().optional(),
  steps: Joi.number().optional(),
});

exports.loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

exports.studentSchema = Joi.object({
  surname: Joi.string().max(100).required(),
  name: Joi.string().max(100).required(),
  otherNames: Joi.string().max(255).allow("").optional(),
  gender: Joi.string().valid("Male", "Female", "Other").required(),
  dateOfBirth: Joi.date().iso().required(),
  guardianName: Joi.string().max(255).allow("").optional(),
  guardianNumber: Joi.string().pattern(/^[0-9+\-\s]{7,20}$/).allow("").optional(), // allows phone numbers
  guardianEmail: Joi.string().email().max(255).allow("").optional(),
  lifestyle: Joi.string().max(255).allow("").optional(),
  session: Joi.string().max(50).required(),

  // Associations
  // schoolId: Joi.number().integer().required(),
  campusId: Joi.number().integer().optional(),
  classId: Joi.number().integer().required(),
  groupId: Joi.number().integer().optional(),

  // Optional contact info
  email: Joi.string().email().max(255).allow("").optional(),
  // phoneNumber: Joi.string().pattern(/^[0-9+\-\s]{7,20}$/).optional(),
});

// Only name and duty are genuinely required. A school often registers a staff
// member before it has their email, start date, next of kin or salary — and
// none of those are needed to use the system, since staff sign in with their
// registration number rather than an email address.
//
// Every optional field below carries .allow("", null): the form posts "" for
// anything left untouched, and Joi's .optional() alone rejects an empty string.
// Joi.date() and Joi.number() reject "" too, which is why dateEmployed and
// payroll need it as much as the string fields do.
exports.staffSchema = Joi.object({
  // Basic info
  name: Joi.string().max(100).required(),
  email: Joi.string().email().max(255).allow("", null).optional(),
  gender: Joi.string().valid("Male", "Female", "Other").allow("", null).optional(),
  phoneNumber: Joi.string().pattern(/^[0-9+\-\s]{7,20}$/).allow("", null).optional(),
  address: Joi.string().max(255).allow("", null).optional(),

  // Job-related info
  duty: Joi.string().max(255).required(),
  nextOfKin: Joi.string().max(255).allow("", null).optional(),
  dateEmployed: Joi.date().iso().allow("", null).optional(),
  payroll: Joi.number().precision(2).allow("", null).optional(), // decimal salary

  // Associations
  campusId: Joi.number().integer().allow(null).optional(),
  // schoolId will come from middleware, so no need to pass here
});

// Same empty-string treatment as staffSchema — editing a staff member and
// clearing a field they no longer have must be allowed, not rejected.
exports.editStaffSchema = Joi.object({
  // Basic info
  name: Joi.string().max(100).optional(),
  email: Joi.string().email().max(255).allow("", null).optional(),
  gender: Joi.string().valid("Male", "Female", "Other").allow("", null).optional(),
  phoneNumber: Joi.string().pattern(/^[0-9+\-\s]{7,20}$/).allow("", null).optional(),
  address: Joi.string().max(255).allow("", null).optional(),

  // Job-related info
  duty: Joi.string().max(255).optional(),
  nextOfKin: Joi.string().max(255).allow("", null).optional(),
  dateEmployed: Joi.date().iso().allow("", null).optional(),
  payroll: Joi.number().precision(2).allow("", null).optional(), // decimal salary

  // Associations
  campusId: Joi.number().integer().allow(null).optional(),
  // schoolId will come from middleware, so no need to pass here
});

exports.assignTeacherSchema = Joi.object({
  staffId: Joi.number().integer().required(),
  classId: Joi.number().integer().required(),
  subjectId: Joi.number().integer().required(),
});

// ✅ Validation schema for creating/updating classes
exports.classSchema = Joi.object({
  name: Joi.string().max(100).required(),
  campusId: Joi.number().integer().optional(), // optional since not all schools have campuses
  customName: Joi.string().max(255).allow("").optional(), // custom class name (if school uses custom naming)
  staffId: Joi.number().integer().optional(), // optional, assign class teacher at creation
  department: Joi.string().max(100).allow("").optional(), // e.g. Sciences, Arts, Commercial, Social Sciences
});

// ✅ Validation schema for class groups
exports.classGroupSchema = Joi.object({
  classId: Joi.number().integer().required(),
  name: Joi.string().max(100).required(), // e.g., "JS1A", "SS2B"
});