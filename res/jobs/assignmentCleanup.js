const prisma = require("../util/prisma");
const logger = require("../config/logger");
const r2Service = require("../Services/R2Service");

const RETENTION_DAYS = parseInt(process.env.ASSIGNMENT_RETENTION_DAYS, 10) || 90;

/**
 * Deletes assignments (and their R2 attachment, if any) once they're old
 * enough that nobody realistically still needs them — a teacher's "board"
 * only ever needs to show recent/upcoming work, not a permanent archive, and
 * attachments are the real storage cost here, not the row itself.
 *
 * Order matters per assignment: the R2 object is deleted BEFORE the DB row.
 * If the R2 delete fails, the row is left alone and retried on the next run
 * — a dangling R2 object with no DB reference left to find it is a much
 * worse, permanent leak than a row that's simply a day late being cleaned up.
 */
async function cleanupExpiredAssignments() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const expired = await prisma.assignment.findMany({
    where: { dueDate: { lt: cutoff } },
    select: { id: true, attachmentUrl: true },
  });

  let deleted = 0;
  let skipped = 0;

  for (const assignment of expired) {
    try {
      if (assignment.attachmentUrl?.startsWith("r2:")) {
        await r2Service.deleteObject(assignment.attachmentUrl.slice(3));
      }
      await prisma.assignment.delete({ where: { id: assignment.id } });
      deleted++;
    } catch (err) {
      skipped++;
      logger.warn("[ASSIGNMENT_CLEANUP] Failed to clean up assignment, will retry next run", {
        assignmentId: assignment.id,
        error: err.message,
      });
    }
  }

  logger.info("[ASSIGNMENT_CLEANUP] Run complete", {
    retentionDays: RETENTION_DAYS,
    found: expired.length,
    deleted,
    skipped,
  });
}

module.exports = { cleanupExpiredAssignments, RETENTION_DAYS };
