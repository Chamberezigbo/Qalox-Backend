const ExamScheduleService = require("../../Services/ExamScheduleService");

exports.createExamSchedule = async (req, res, next) => {
  try {
    const schedule = await ExamScheduleService.createSchedule(req.schoolId, req.user.id, req.body);
    res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
};

exports.updateExamSchedule = async (req, res, next) => {
  try {
    const schedule = await ExamScheduleService.updateScheduleHeader(req.schoolId, req.params.id, req.body);
    res.status(200).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
};

exports.getExamSchedule = async (req, res, next) => {
  try {
    const schedule = await ExamScheduleService.getSchedule(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
};

exports.listExamSchedules = async (req, res, next) => {
  try {
    const schedules = await ExamScheduleService.listSchedules(req.schoolId, req.query);
    res.status(200).json({ success: true, data: schedules });
  } catch (err) {
    next(err);
  }
};

exports.deleteExamSchedule = async (req, res, next) => {
  try {
    const result = await ExamScheduleService.deleteSchedule(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

exports.replaceEntries = async (req, res, next) => {
  try {
    const entries = await ExamScheduleService.replaceEntries(req.schoolId, req.params.id, req.body.entries);
    res.status(200).json({ success: true, data: { entries } });
  } catch (err) {
    next(err);
  }
};

exports.updateEntry = async (req, res, next) => {
  try {
    const entry = await ExamScheduleService.updateEntry(req.schoolId, req.params.id, req.params.entryId, req.body);
    res.status(200).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
};

exports.deleteEntry = async (req, res, next) => {
  try {
    const result = await ExamScheduleService.deleteEntry(req.schoolId, req.params.id, req.params.entryId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

exports.autoGenerate = async (req, res, next) => {
  try {
    // Confirms the schedule exists and belongs to this school (so a stray id
    // can't be used to probe unrelated data) — the algorithm itself is a pure
    // function over the request body and never touches the database.
    await ExamScheduleService.getSchedule(req.schoolId, req.params.id);
    const entries = ExamScheduleService.autoGenerate(req.body);
    res.status(200).json({ success: true, data: { entries } });
  } catch (err) {
    next(err);
  }
};

exports.publishExamSchedule = async (req, res, next) => {
  try {
    const result = await ExamScheduleService.publish(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};
