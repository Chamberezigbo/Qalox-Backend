const Joi = require("joi");

const classSchema = Joi.object({
  name: Joi.string().max(255).required(),
});

const campusSchema = Joi.object({
  name: Joi.string().max(255).required(),
  address: Joi.string().optional(),
  phoneNumber: Joi.string().max(50).optional(),
  email: Joi.string().email().max(255).optional(),
});


module.exports = {
  classSchema,
  campusSchema,
};
