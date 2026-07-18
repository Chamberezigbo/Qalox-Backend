const Joi = require("joi");

// Schema for PATCH /api/public/schools/:id/suspend
const suspendSchoolSchema = Joi.object({
  suspend: Joi.boolean().required().messages({
    "any.required": "suspend field is required",
    "boolean.base": "suspend must be a boolean",
  }),
  reason: Joi.string().max(500).optional().messages({
    "string.max": "reason must not exceed 500 characters",
  }),
});

// Schema for DELETE /api/public/schools/:id
const deleteSchoolSchema = Joi.object({
  confirmDeletion: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      "any.required": "confirmDeletion is required",
      "any.only": "confirmDeletion must be true to confirm deletion",
    }),
  reason: Joi.string().max(500).optional().messages({
    "string.max": "reason must not exceed 500 characters",
  }),
});

// Schema for POST /api/public/admins
const createAdminSchema = Joi.object({
  email: Joi.string().email().required().messages({
    "any.required": "email is required",
    "string.email": "email must be a valid email address",
  }),
  password: Joi.string().min(6).required().messages({
    "any.required": "password is required",
    "string.min": "password must be at least 6 characters",
  }),
  name: Joi.string().min(2).max(255).required().messages({
    "any.required": "name is required",
    "string.min": "name must be at least 2 characters",
    "string.max": "name must not exceed 255 characters",
  }),
  role: Joi.string()
    .valid("super_admin", "school_admin")
    .required()
    .messages({
      "any.required": "role is required",
      "any.only": "role must be either super_admin or school_admin",
    }),
  schoolId: Joi.number().integer().positive().optional().messages({
    "number.base": "schoolId must be a number",
    "number.integer": "schoolId must be an integer",
    "number.positive": "schoolId must be positive",
  }),
  uniqueKey: Joi.string()
    .pattern(/^TKN-[A-F0-9]{6}$/)
    .required()
    .messages({
      "any.required": "uniqueKey is required",
      "string.pattern.base": "uniqueKey must be in format TKN-XXXXXX (6 uppercase hex characters)",
    }),
}).custom((value, helpers) => {
  // Validate role-schoolId combination
  if (value.role === "school_admin" && !value.schoolId) {
    return helpers.error("any.invalid", { message: "schoolId is required for school_admin role" });
  }
  if (value.role === "super_admin" && value.schoolId) {
    return helpers.error("any.invalid", { message: "schoolId must be null for super_admin role" });
  }
  return value;
});

module.exports = {
  suspendSchoolSchema,
  deleteSchoolSchema,
  createAdminSchema,
};
