// middleware/validate.js

const Joi = require("joi");
const { AppError } = require("../util/AppError");

const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      const errors = error.details.map((detail) => detail.message);
       return next(new AppError(`Validation error: ${errors.join(", ")}`, 400));
    }

    next();
  };
};

module.exports = validate;
