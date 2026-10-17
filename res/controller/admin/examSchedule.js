const ExamScheduleService = require("../../Services/ExamScheduleService");
const prisma = require("../../util/prisma");
const campusScope = require("../../util/campusScope");
const { AppError } = require("../../util/AppError");

/** The schedule, if it is this school's and on one of the admin's campuses; otherwise 404. */
async function guardSchedule(req) {
  const found = await prisma.examSchedule.findFirst({
    where: campusScope.withScope({ id: Number(req.params.id), schoolId: req.schoolId }, campusScope.examScheduleWhere(req)),
    select: { id: true },
  });
  if (!found) throw new AppError("Exam schedule not found", 404);
}

exports.createExamSchedule = async (req, res, next) => {
  try {
    campusScope.assertCampusAllowed(req, req.body.campusId);
    const schedule = await ExamScheduleService.createSchedule(req.schoolId, req.user.id, req.body);
    res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
};

exports.updateExamSchedule = async (req, res, next) => {
  try {
    await guardSchedule(req);
    campusScope.assertCampusAllowed(req, req.body.campusId);
    const schedule = await ExamScheduleService.updateScheduleHeader(req.schoolId, req.params.id, req.body);
    res.status(200).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
};

exports.getExamSchedule = async (req, res, next) => {
  try {
    await guardSchedule(req);
    const schedule = await ExamScheduleService.getSchedule(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
};

exports.listExamSchedules = async (req, res, next) => {
  try {
    campusScope.assertCampusAllowed(req, req.query.campusId);
    let schedules = await ExamScheduleService.listSchedules(req.schoolId, req.query);
    // A restricted admin sees only their campuses' schedules (a schedule always has a campus).
    if (campusScope.isRestricted(req)) schedules = schedules.filter((sch) => req.campusIds.includes(sch.campusId));
    res.status(200).json({ success: true, data: schedules });
  } catch (err) {
    next(err);
  }
};

exports.deleteExamSchedule = async (req, res, next) => {
  try {
    await guardSchedule(req);
    const result = await ExamScheduleService.deleteSchedule(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

exports.replaceEntries = async (req, res, next) => {
  try {
    await guardSchedule(req);
    // Every class named has to be one the admin can reach.
    const classIds = [...new Set((req.body.entries || []).map((e) => Number(e.classId)).filter(Boolean))];
    if (classIds.length && campusScope.isRestricted(req)) {
      const reachable = await prisma.class.count({
        where: campusScope.withScope({ id: { in: classIds }, schoolId: req.schoolId }, campusScope.classWhere(req)),
      });
      if (reachable !== classIds.length) throw new AppError("Class not found", 404);
    }
    const entries = await ExamScheduleService.replaceEntries(req.schoolId, req.params.id, req.body.entries);
    res.status(200).json({ success: true, data: { entries } });
  } catch (err) {
    next(err);
  }
};

exports.updateEntry = async (req, res, next) => {
  try {
    await guardSchedule(req);
    const entry = await ExamScheduleService.updateEntry(req.schoolId, req.params.id, req.params.entryId, req.body);
    res.status(200).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
};

exports.deleteEntry = async (req, res, next) => {
  try {
    await guardSchedule(req);
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
    await guardSchedule(req);
    await ExamScheduleService.getSchedule(req.schoolId, req.params.id);
    const entries = ExamScheduleService.autoGenerate(req.body);
    res.status(200).json({ success: true, data: { entries } });
  } catch (err) {
    next(err);
  }
};

exports.publishExamSchedule = async (req, res, next) => {
  try {
    await guardSchedule(req);
    const result = await ExamScheduleService.publish(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

exports.unpublishExamSchedule = async (req, res, next) => {
  try {
    await guardSchedule(req);
    const result = await ExamScheduleService.unpublish(req.schoolId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};
