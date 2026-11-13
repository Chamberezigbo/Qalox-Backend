const bank = require("../../Services/PracticeBankService");
const { PracticeError } = require("../../util/practiceError");

/** The platform owner's tools for the practice question bank. */

const handle = (fn, status = 200) => async (req, res, next) => {
  try {
    res.status(status).json({ success: true, data: await fn(req) });
  } catch (error) {
    if (error instanceof PracticeError) return res.status(error.status).json({ success: false, message: error.message, code: error.code });
    // The AI service explains itself (busy, rate limited): pass that on rather than a bare 500.
    if (error.code === "AI_RATE_LIMITED" || error.code === "AI_BUSY") return res.status(503).json({ success: false, message: error.message, code: error.code });
    next(error);
  }
};

exports.importQuestions = handle((req) => bank.importQuestions({ items: req.body?.items, csv: req.body?.csv, defaults: req.body?.defaults }), 201);
exports.generate = handle((req) => bank.generate({ exam: req.body?.exam, subject: req.body?.subject, topic: req.body?.topic, count: req.body?.count, difficulty: req.body?.difficulty }), 201);
exports.topics = handle((req) => bank.suggestTopics({ exam: req.body?.exam, subject: req.body?.subject, max: req.body?.max }));
exports.list = handle((req) =>
  bank.listQuestions({
    status: req.query.status, exam: req.query.exam, subject: req.query.subject, reported: req.query.reported === "1",
    limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0,
  }),
);
exports.update = handle((req) => bank.updateQuestion(Number(req.params.id), req.body ?? {}));
exports.stats = handle(() => bank.stats());
