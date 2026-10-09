const prisma = require("../util/prisma");
const logger = require("../config/logger");
const AiCreditService = require("../Services/AiCreditService");

/** A generation takes well under a minute; this long without progress means the process that owned it is gone. */
const STRANDED_AFTER_MINUTES = 15;

/**
 * Fails AI generation jobs that were abandoned by a restart, and gives the
 * school its credits back.
 *
 * Jobs run in the web process (setImmediate), so a deploy or crash mid-run
 * leaves the row "queued" or "processing" for ever. That costs twice: the
 * credits stay reserved, and the one-job-at-a-time check then refuses every
 * further generation from that teacher.
 *
 * The job is claimed with a conditional update before anything is refunded, so
 * a job that finishes at the same moment, or a second run of this sweeper, can
 * never refund a reservation that was already settled.
 */
async function failStrandedAiJobs() {
  const cutoff = new Date(Date.now() - STRANDED_AFTER_MINUTES * 60 * 1000);

  const stranded = await prisma.aiGenerationJob.findMany({
    where: { status: { in: ["queued", "processing"] }, updatedAt: { lt: cutoff } },
    select: { id: true, schoolId: true, creditsReserved: true, inputParamsJson: true },
  });

  let recovered = 0;
  for (const job of stranded) {
    try {
      const { count } = await prisma.aiGenerationJob.updateMany({
        where: { id: job.id, status: { in: ["queued", "processing"] }, updatedAt: { lt: cutoff } },
        data: {
          status: "failed",
          stage: "Failed",
          errorMessage: "This generation was interrupted. Your credits were returned — please try again.",
          creditsCharged: 0,
          completedAt: new Date(),
        },
      });
      if (count === 0) continue; // finished, or claimed by another run, since we looked

      await AiCreditService.refundCredits(job.schoolId, job.creditsReserved);

      let chatId = null;
      try {
        chatId = JSON.parse(job.inputParamsJson || "{}").chatId || null;
      } catch {
        // Not a chat job.
      }
      if (chatId) {
        await prisma.lessonNoteChat.updateMany({ where: { id: chatId, status: "generating" }, data: { status: "open" } });
      }
      recovered++;
    } catch (error) {
      logger.warn("[AI_JOB_RECOVERY] Could not recover job, will retry next run", { jobId: job.id, error: error.message });
    }
  }

  if (stranded.length > 0) {
    logger.info("[AI_JOB_RECOVERY] Run complete", { found: stranded.length, recovered });
  }
}

module.exports = { failStrandedAiJobs, STRANDED_AFTER_MINUTES };
