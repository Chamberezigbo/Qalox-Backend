const crypto = require("crypto");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const AiCreditService = require("../../Services/AiCreditService");
const AiGenerationWorker = require("../../Services/AiGenerationWorker");
const GeminiTextService = require("../../Services/GeminiTextService");
const { getAiCreditsStatusForSchool } = require("../../util/getAiCreditsAllowanceForSchool");

/**
 * AI lesson notes for teachers, grounded in the school's Scheme of Work.
 *
 * Generation is asynchronous: the request reserves credits, creates a job and
 * returns immediately, and the client polls. A 20-second Gemini call behind a
 * synchronous request would sit on a connection and time out on most proxies.
 */

/** A teacher may only generate for a class+subject they actually teach. */
async function assertTeaches(staffId, classId, subjectId) {
  const taught = await prisma.teacherAssignment.findFirst({
    where: { staffId, classId, subjectId },
  });
  if (!taught) {
    const error = new Error("You do not teach this subject in this class");
    error.statusCode = 403;
    throw error;
  }
}

/** Independent of the credit balance — a backstop against a loop or a stuck client. */
const MAX_JOBS_PER_TEACHER_PER_DAY = 20;

/**
 * POST /api/teacher/lesson-notes/generate
 * Body: { classId, subjectId, topic?, weekRange?, duration? }
 */
exports.generateLessonNote = async (req, res, next) => {
  try {
    const staffId = req.staffId;
    const schoolId = req.schoolId;
    const { classId, subjectId, topic, weekRange, duration } = req.body;

    if (!classId || !subjectId) {
      return res.status(400).json({
        success: false,
        message: "classId and subjectId are required",
        code: "INVALID_REQUEST",
      });
    }

    await assertTeaches(staffId, Number(classId), Number(subjectId));

    // One in-flight job per teacher: without this, a double-click reserves
    // credits twice for the same intent.
    const inFlight = await prisma.aiGenerationJob.findFirst({
      where: { staffId, status: { in: ["queued", "processing"] } },
      select: { id: true },
    });
    if (inFlight) {
      return res.status(409).json({
        success: false,
        message: "You already have a generation running. Wait for it to finish before starting another.",
        code: "GENERATION_IN_PROGRESS",
        data: { jobId: inFlight.id },
      });
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await prisma.aiGenerationJob.count({
      where: { staffId, createdAt: { gte: since } },
    });
    if (todayCount >= MAX_JOBS_PER_TEACHER_PER_DAY) {
      return res.status(429).json({
        success: false,
        message: `You've reached the daily limit of ${MAX_JOBS_PER_TEACHER_PER_DAY} generations. Try again tomorrow.`,
        code: "DAILY_LIMIT_REACHED",
      });
    }

    const activeTerm = await prisma.academicTerm.findFirst({
      where: { schoolId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!activeTerm) {
      return res.status(400).json({
        success: false,
        message: "No active term is set for your school.",
        code: "NO_ACTIVE_TERM",
      });
    }

    // Grounding is required: without a scheme of work there is nothing to
    // generate from, and an ungrounded prompt produces generic filler.
    const scheme = await prisma.schemeOfWork.findFirst({
      where: {
        schoolId,
        classId: Number(classId),
        subjectId: Number(subjectId),
        academicTermId: activeTerm.id,
        status: "active",
      },
      select: { id: true, extractedText: true, extractedTextStatus: true },
    });

    if (!scheme) {
      return res.status(404).json({
        success: false,
        message:
          "No scheme of work has been uploaded for this class and subject this term. Ask your admin to upload one first.",
        code: "SCHEME_OF_WORK_NOT_FOUND",
      });
    }
    if (scheme.extractedTextStatus !== "ready") {
      return res.status(400).json({
        success: false,
        message:
          "The scheme of work for this class and subject couldn't be read. Ask your admin to re-upload it as a PDF or clearer photos.",
        code: "SCHEME_OF_WORK_UNREADABLE",
      });
    }

    // Reserve against the worst case: the excerpt actually being sent, plus
    // the hard output ceiling. Real usage comes back smaller and is refunded.
    const excerpt = GeminiTextService.buildContextExcerpt(scheme.extractedText, topic);
    const estimatedInputTokens = AiCreditService.estimateTokensFromText(excerpt) + 400; // + prompt scaffold
    const estimatedOutputTokens = GeminiTextService.LESSON_NOTE_MAX_OUTPUT_TOKENS;
    const credits = AiCreditService.creditsForTokens({
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
    });

    // Throws (402/403-ish) before any job exists if the school can't afford it.
    const { reserved } = await AiCreditService.reserveCredits(schoolId, credits);

    const job = await prisma.aiGenerationJob.create({
      data: {
        id: `aig_${crypto.randomBytes(12).toString("hex")}`,
        schoolId,
        staffId,
        jobType: "lesson_note",
        schemeOfWorkId: scheme.id,
        classId: Number(classId),
        subjectId: Number(subjectId),
        academicTermId: activeTerm.id,
        inputParamsJson: JSON.stringify({ topic, weekRange, duration }),
        status: "queued",
        estimatedInputTokens,
        estimatedOutputTokens,
        creditsReserved: reserved,
      },
    });

    setImmediate(() => {
      AiGenerationWorker.processJob({ jobId: job.id }).catch((error) => {
        logger.error("[LESSON_NOTE] Worker crashed", { jobId: job.id, error: error.message });
      });
    });

    return res.status(202).json({
      success: true,
      message: "Generation started",
      data: { jobId: job.id, creditsReserved: reserved },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    logger.error("[LESSON_NOTE] Generation request failed", { error: err.message });
    next(err);
  }
};

/** GET /api/teacher/lesson-notes/generate/:jobId — polled while generating. */
exports.getGenerationStatus = async (req, res, next) => {
  try {
    const job = await prisma.aiGenerationJob.findFirst({
      where: { id: req.params.jobId, staffId: req.staffId },
      select: {
        id: true,
        status: true,
        stage: true,
        progress: true,
        errorMessage: true,
        creditsCharged: true,
        resultLessonNoteId: true,
      },
    });

    if (!job) {
      return res.status(404).json({ success: false, message: "Generation not found" });
    }

    return res.status(200).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
};

/** GET /api/teacher/lesson-notes */
exports.listLessonNotes = async (req, res, next) => {
  try {
    const notes = await prisma.lessonNote.findMany({
      where: { staffId: req.staffId },
      include: {
        class: { select: { id: true, name: true, customName: true } },
        subject: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // content can be long and no list view renders it.
    return res.status(200).json({
      success: true,
      data: notes.map(({ content, ...rest }) => ({ ...rest, hasContent: Boolean(content?.trim()) })),
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/teacher/lesson-notes/:id */
exports.getLessonNote = async (req, res, next) => {
  try {
    const note = await prisma.lessonNote.findFirst({
      where: { id: Number(req.params.id), staffId: req.staffId },
      include: {
        class: { select: { id: true, name: true, customName: true } },
        subject: { select: { id: true, name: true } },
      },
    });

    if (!note) return res.status(404).json({ success: false, message: "Lesson note not found" });
    return res.status(200).json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/teacher/lesson-notes/:id
 * Edits and/or approves. Editing AI output marks it as teacher-edited, so the
 * difference between untouched AI text and reviewed text stays visible.
 */
exports.updateLessonNote = async (req, res, next) => {
  try {
    const { title, content, objectives, status } = req.body;

    const existing = await prisma.lessonNote.findFirst({
      where: { id: Number(req.params.id), staffId: req.staffId },
      select: { id: true, source: true },
    });
    if (!existing) return res.status(404).json({ success: false, message: "Lesson note not found" });

    if (status && !["draft", "final"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be draft or final" });
    }

    const contentChanged = content !== undefined;
    const note = await prisma.lessonNote.update({
      where: { id: existing.id },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(objectives !== undefined && { objectivesJson: JSON.stringify(objectives) }),
        ...(status !== undefined && { status }),
        ...(contentChanged &&
          existing.source === "ai_generated" && { source: "ai_generated_edited" }),
      },
    });

    return res.status(200).json({ success: true, message: "Lesson note updated", data: note });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/teacher/lesson-notes/:id */
exports.deleteLessonNote = async (req, res, next) => {
  try {
    const existing = await prisma.lessonNote.findFirst({
      where: { id: Number(req.params.id), staffId: req.staffId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, message: "Lesson note not found" });

    await prisma.lessonNote.delete({ where: { id: existing.id } });
    return res.status(200).json({ success: true, message: "Lesson note deleted" });
  } catch (err) {
    next(err);
  }
};

/** GET /api/teacher/ai/credits — powers the meter before a teacher spends. */
exports.getAiCredits = async (req, res, next) => {
  try {
    const status = await getAiCreditsStatusForSchool(req.schoolId);
    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
};
