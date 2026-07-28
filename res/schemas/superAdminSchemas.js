const Joi = require("joi");

// POST /api/super-admin/login
const loginSchema = Joi.object({
  email: Joi.string()
    .email()
    .required()
    .messages({
      "string.email": "Email must be a valid email address",
      "any.required": "Email is required",
    }),
  password: Joi.string()
    .min(8)
    .required()
    .messages({
      "string.min": "Password must be at least 8 characters",
      "any.required": "Password is required",
    }),
});

// POST /api/super-admin/tokens/generate
const generateTokenSchema = Joi.object({
  email: Joi.string()
    .email()
    .required()
    .messages({
      "string.email": "Email must be a valid email address",
      "any.required": "Email is required",
    }),
  schoolName: Joi.string()
    .max(255)
    .optional()
    .messages({
      "string.max": "School name must not exceed 255 characters",
    }),
});

// POST /api/super-admin/register
const registerSchema = Joi.object({
  token: Joi.string()
    .pattern(/^TKN-[A-Z0-9]+$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid token format",
      "any.required": "Token is required",
    }),
  email: Joi.string()
    .email()
    .required()
    .messages({
      "string.email": "Email must be a valid email address",
      "any.required": "Email is required",
    }),
  password: Joi.string()
    .min(8)
    .required()
    .messages({
      "string.min": "Password must be at least 8 characters",
      "any.required": "Password is required",
    }),
  name: Joi.string()
    .max(255)
    .required()
    .messages({
      "string.max": "Name must not exceed 255 characters",
      "any.required": "Name is required",
    }),
});

// PATCH /api/super-admin/profile
const updateProfileSchema = Joi.object({
  name: Joi.string()
    .max(255)
    .optional()
    .messages({
      "string.max": "Name must not exceed 255 characters",
    }),
  email: Joi.string()
    .email()
    .optional()
    .messages({
      "string.email": "Email must be a valid email address",
    }),
}).min(1);

// PATCH /api/super-admin/change-password
const changePasswordSchema = Joi.object({
  currentPassword: Joi.string()
    .required()
    .messages({
      "any.required": "Current password is required",
    }),
  newPassword: Joi.string()
    .min(8)
    .required()
    .messages({
      "string.min": "New password must be at least 8 characters",
      "any.required": "New password is required",
    }),
});

// PATCH /api/super-admin/settings
const updateSettingsSchema = Joi.object({
  commissionRate: Joi.number()
    .min(0)
    .max(100)
    .optional()
    .messages({
      "number.min": "Commission rate must be between 0 and 100",
      "number.max": "Commission rate must be between 0 and 100",
    }),
  platformName: Joi.string()
    .max(255)
    .optional()
    .messages({
      "string.max": "Platform name must not exceed 255 characters",
    }),
  supportEmail: Joi.string()
    .email()
    .optional()
    .messages({
      "string.email": "Support email must be a valid email address",
    }),
  maxTokensPerSchool: Joi.number()
    .integer()
    .min(1)
    .optional()
    .messages({
      "number.min": "Max tokens per school must be at least 1",
    }),
  tokenExpirationDays: Joi.number()
    .integer()
    .min(1)
    .optional()
    .messages({
      "number.min": "Token expiration days must be at least 1",
    }),
}).min(1);

module.exports = {
  loginSchema,
  generateTokenSchema,
  registerSchema,
  updateProfileSchema,
  changePasswordSchema,
  updateSettingsSchema,
};
