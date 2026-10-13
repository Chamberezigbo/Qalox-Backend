const service = require("../../Services/student/StudentTestService");

/** A student's tests. All state and rules are in StudentTestService. */

const handle = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error instanceof service.StudentTestError) {
      return res.status(error.status).json({ success: false, message: error.message, code: error.code });
    }
    next(error);
  }
};

exports.list = handle((req) => service.listForStudent(req.studentId, req.schoolId));
exports.start = handle((req) => service.startAttempt(req.studentId, req.schoolId, req.params.testId));
exports.getAttempt = handle((req) => service.getAttempt(req.studentId, req.schoolId, req.params.attemptId));
exports.saveAnswer = handle((req) =>
  service.saveAnswer(req.studentId, req.schoolId, req.params.attemptId, {
    questionId: req.body?.questionId,
    optionId: req.body?.optionId,
  })
);
exports.submit = handle((req) => service.submitAttempt(req.studentId, req.schoolId, req.params.attemptId));
