const prisma = require("../util/prisma");
const logger = require("../config/logger");

const RETENTION_DAYS = parseInt(process.env.BULK_IMPORT_RETENTION_DAYS, 10) || 30;

/**
 * Deletes finished bulk-import jobs (and their records, via Prisma's
 * emulated cascade) once nothing about them has been touched in a while.
 * This is pure staging data — a confirmed job's rows are already real
 * Student/Staff records elsewhere, and a failed job's error is only useful
 * for as long as the admin might still be looking at it — so once idle,
 * there is nothing left worth keeping.
 *
 * Never touches a "processing" job (an import in flight), and checks BOTH
 * the job's own updatedAt and its records' updatedAt: an admin can spend
 * days fixing individual rows of a "completed but not yet confirmed" import
 * without the job row itself changing, so the job's own timestamp alone
 * isn't safe to decide staleness from.
 */
async function cleanupStaleBulkImports() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const candidates = await prisma.bulkImportJob.findMany({
    where: {
      status: { in: ["completed", "failed"] },
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      records: { select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
    },
  });

  const stale = candidates.filter((job) => !job.records[0] || job.records[0].updatedAt < cutoff);

  let deleted = 0;
  for (const job of stale) {
    try {
      await prisma.bulkImportJob.delete({ where: { id: job.id } });
      deleted++;
    } catch (err) {
      logger.warn("[BULK_IMPORT_CLEANUP] Failed to delete job, will retry next run", {
        jobId: job.id,
        error: err.message,
      });
    }
  }

  logger.info("[BULK_IMPORT_CLEANUP] Run complete", {
    retentionDays: RETENTION_DAYS,
    found: stale.length,
    deleted,
  });
}

module.exports = { cleanupStaleBulkImports, RETENTION_DAYS };
