const prisma = require("../util/prisma");
const logger = require("../config/logger");
const GeminiTextService = require("./GeminiTextService");
const AiCreditService = require("./AiCreditService");

/**
 * Runs AI generation jobs in the background, so a request that takes 10-30
 * seconds doesn't hold an HTTP connection open. Mirrors BulkImportWorker: the
 * controller creates the job row, hands off via setImmediate, and the client
 * polls the job by id.
 *
 * This worker owns the money side of a generation. Credits were already
 * reserved when the job was created — against the worst case, because the real
 * cost isn't knowable until Gemini answers. So every path out of here has to
 * settle that reservation: true it up on success, refund it in full on
 * failure. A job that ends without settling silently overcharges the school.
 */

const STAGES = {
  READING: "Reading scheme of work",
  DRAFTING: "Drafting lesson note",
  FORMATTING: "Formatting",
};

/**
 * Progress ticks are cosmetic — a lost one must never abort a job that is
 * otherwise fine, which is why this swallows its own errors.
 */
async function setProgress(jobId, progress, stage) {
  try {
    await prisma.aiGenerationJob.update({
      where: { id: jobId },
      data: { progress, stage, status: "processing" },
    });
  } catch (error) {
    logger.warn("[AI_WORKER] Failed to write progress", { jobId, error: error.message });
  }
}

/**
 * @param {{ jobId: string }} input
 */
async function processJob({ jobId }) {
  const job = await prisma.aiGenerationJob.findUnique({
    where: { id: jobId },
    include: {
      schemeOfWork: { select: { extractedText: true, extractedTextStatus: true } },
      class: { select: { name: true, customName: true } },
      subject: { select: { name: true } },
    },
  });

  if (!job) {
    logger.error("[AI_WORKER] Job vanished before it could run", { jobId });
    return;
  }

  try {
    await setProgress(jobId, 10, STAGES.READING);

    if (job.schemeOfWork?.extractedTextStatus !== "ready") {
      throw new Error(
        "The scheme of work for this class and subject has no readable text. Re-upload it as a PDF or clearer photos."
      );
    }

    const params = JSON.parse(job.inputParamsJson || "{}");
    const className = job.class?.customName
      ? `${job.class.name} — ${job.class.customName}`
      : job.class?.name || "";

    await setProgress(jobId, 35, STAGES.DRAFTING);

    const { parsed, usage } = await GeminiTextService.generateLessonNote({
      schemeText: job.schemeOfWork.extractedText,
      className,
      subjectName: job.subject?.name || "",
      topic: params.topic,
      weekRange: params.weekRange,
      duration: params.duration,
    });

    await setProgress(jobId, 80, STAGES.FORMATTING);

    // Written as a draft, never published. The teacher reviews and approves it
    // — the same generate-then-confirm flow the exam timetable builder uses.
    const lessonNote = await prisma.lessonNote.create({
      data: {
        schoolId: job.schoolId,
        classId: job.classId,
        subjectId: job.subjectId,
        academicTermId: job.academicTermId,
        staffId: job.staffId,
        schemeOfWorkId: job.schemeOfWorkId,
        generationJobId: job.id,
        title: parsed.title,
        topic: params.topic || null,
        objectivesJson: JSON.stringify(parsed.objectives),
        content: parsed.content,
        status: "draft",
        source: "ai_generated",
      },
    });

    const { charged } = await AiCreditService.trueUpCredits(job.schoolId, job.creditsReserved, usage);

    await prisma.aiGenerationJob.update({
      where: { id: jobId },
      data: {
        status: "done",
        progress: 100,
        stage: "Done",
        actualInputTokens: usage.inputTokens,
        actualOutputTokens: usage.outputTokens,
        creditsCharged: charged,
        resultLessonNoteId: lessonNote.id,
        completedAt: new Date(),
      },
    });

    logger.info("[AI_WORKER] Lesson note generated", {
      jobId,
      lessonNoteId: lessonNote.id,
      reserved: job.creditsReserved,
      charged,
    });
  } catch (error) {
    // Nothing usable came back, so the school keeps its credits. Refunding
    // before marking the job failed means a crash between the two leaves the
    // refund done rather than the charge standing.
    await AiCreditService.refundCredits(job.schoolId, job.creditsReserved).catch((refundError) =>
      logger.error("[AI_WORKER] Refund failed — school may be over-charged", {
        jobId,
        schoolId: job.schoolId,
        reserved: job.creditsReserved,
        error: refundError.message,
      })
    );

    await prisma.aiGenerationJob
      .update({
        where: { id: jobId },
        data: {
          status: "failed",
          stage: "Failed",
          errorMessage: error.message,
          creditsCharged: 0,
          completedAt: new Date(),
        },
      })
      .catch((updateError) =>
        logger.error("[AI_WORKER] Could not mark job failed", { jobId, error: updateError.message })
      );

    logger.warn("[AI_WORKER] Generation failed, credits refunded", {
      jobId,
      error: error.message,
    });
  }
}

module.exports = { processJob, STAGES };
