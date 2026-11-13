const service = require("../../Services/student/PracticeService");

/** Past-question practice for a signed-in student. All rules are in PracticeService. */

const handle = (fn, successStatus = 200) => async (req, res, next) => {
  try {
    res.status(successStatus).json({ success: true, data: await fn(req) });
  } catch (error) {
    if (error instanceof service.PracticeError) {
      return res.status(error.status).json({ success: false, message: error.message, code: error.code, ...(error.reveal ? { data: error.reveal } : {}) });
    }
    next(error);
  }
};

exports.catalog = handle(() => service.catalog());
exports.start = handle(
  (req) => service.startSession({
    studentId: req.studentId, schoolId: req.schoolId,
    exam: req.body?.exam, subject: req.body?.subject, mode: req.body?.mode, count: req.body?.count,
    year: req.body?.year, topic: req.body?.topic, retryFromSessionId: req.body?.retryFromSessionId,
  }),
  201,
);
exports.get = handle((req) => service.getSession(req.studentId, req.params.id));
exports.answer = handle((req) => service.saveAnswer(req.studentId, req.params.id, { questionId: req.body?.questionId, optionId: req.body?.optionId }));
exports.submit = handle((req) => service.submit(req.studentId, req.params.id));
exports.history = handle((req) => service.history(req.studentId));
exports.progress = handle((req) => service.progress(req.studentId));
exports.report = handle((req) => service.report(req.studentId, req.params.id, req.body?.reason), 201);
