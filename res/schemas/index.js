// schemas/index.js
const Joi = require("joi");

exports.tokenSchema = Joi.object({
  email: Joi.string().email().required(),
  schoolName: Joi.string().required(),
});

exports.schoolValidationSchema = Joi.object({
  name: Joi.string().max(255).required(),
  prefix: Joi.string()
    .pattern(/^[A-Z0-9]{4}$/)
    .uppercase()
    .messages({
      "string.pattern.base": "Prefix must be exactly 4 uppercase alphanumeric characters (A-Z, 0-9).",
      "string.uppercase": "Prefix must be uppercase.",
      "string.length": "Prefix must be exactly 4 characters.",
    })
    .optional(),
  email: Joi.string().email().required(),
  phoneNumber: Joi.string().max(50).optional(),
  address: Joi.string().optional(),
});
