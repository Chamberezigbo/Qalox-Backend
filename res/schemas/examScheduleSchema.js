const Joi = require("joi");

const SCHEDULING_METHODS = ["same_schedule", "default_with_overrides", "auto", "fully_custom"];

const examScheduleHeaderSchema = Joi.object({
  campusId: Joi.number().integer().positive().required(),
  academicSessionId: Joi.number().integer().positive().required(),
  examType: Joi.string().max(80).required(),
  name: Joi.string().max(120).required(),
  description: Joi.string().max(300).allow("").optional(),
  schedulingMethod: Joi.string().valid(...SCHEDULING_METHODS).required(),
});

const examScheduleHeaderUpdateSchema = Joi.object({
  campusId: Joi.number().integer().positive().optional(),
  academicSessionId: Joi.number().integer().positive().optional(),
  examType: Joi.string().max(80).optional(),
  name: Joi.string().max(120).optional(),
  description: Joi.string().max(300).allow("").optional(),
  schedulingMethod: Joi.string().valid(...SCHEDULING_METHODS).optional(),
}).min(1);

const timeOfDaySchema = Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).message('"startTime" must be in HH:mm format');

const examScheduleEntrySchema = Joi.object({
  classId: Joi.number().integer().positive().required(),
  subjectId: Joi.number().integer().positive().required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('"date" must be in YYYY-MM-DD format').required(),
  startTime: timeOfDaySchema.required(),
  durationMinutes: Joi.number().integer().min(1).max(600).required(),
});

const replaceEntriesSchema = Joi.object({
  entries: Joi.array().items(examScheduleEntrySchema).min(1).required(),
});

const updateEntrySchema = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('"date" must be in YYYY-MM-DD format').optional(),
  startTime: timeOfDaySchema.optional(),
  durationMinutes: Joi.number().integer().min(1).max(600).optional(),
}).min(1);

const autoGenerateSchema = Joi.object({
  classSubjectPairs: Joi.array().items(
    Joi.object({
      classId: Joi.number().integer().positive().required(),
      subjectId: Joi.number().integer().positive().required(),
    })
  ).min(1).required(),
  firstExamDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('"firstExamDate" must be in YYYY-MM-DD format').required(),
  defaultStartTime: timeOfDaySchema.required(),
  durationMinutes: Joi.number().integer().min(1).max(600).required(),
  breakMinutes: Joi.number().integer().min(0).max(240).required(),
  examsPerDay: Joi.number().integer().positive().optional(),
});

module.exports = {
  SCHEDULING_METHODS,
  examScheduleHeaderSchema,
  examScheduleHeaderUpdateSchema,
  replaceEntriesSchema,
  updateEntrySchema,
  autoGenerateSchema,
};
