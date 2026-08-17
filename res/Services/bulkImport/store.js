const prisma = require("../../util/prisma");
const BulkImportValidator = require("../BulkImportValidator");

/**
 * Reading and writing bulk-import records.
 *
 * Rows are stored with their JSON columns serialised, so every read has to go
 * back through here rather than handing a Prisma row to the client directly —
 * this module is what guarantees the response shape the frontend is built on.
 */

/** Safe JSON parse: a corrupt column must not take the whole job down. */
function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed == null ? fallback : parsed;
  } catch (error) {
    return fallback;
  }
}

/**
 * The record shape the frontend consumes. `isValid` is recomputed from `errors`
 * on the way out as well as on the way in — if the two ever disagreed, the
 * import button would unlock on a row that cannot be imported.
 */
function toApiRecord(row) {
  const errors = parseJson(row.errorsJson, []);
  const warnings = parseJson(row.warningsJson, []);
  return {
    id: row.recordId,
    rowNumber: row.rowNumber,
    data: parseJson(row.dataJson, {}),
    isValid: errors.length === 0,
    isDuplicate: Boolean(row.isDuplicate),
    errors,
    warnings,
  };
}

/** Turns a validated record into the columns the table stores. */
function toDbFields(record) {
  return {
    dataJson: JSON.stringify(record.data),
    isValid: record.errors.length === 0,
    isDuplicate: Boolean(record.isDuplicate),
    errorsJson: JSON.stringify(record.errors),
    warningsJson: JSON.stringify(record.warnings),
  };
}

/** All of a job's rows, in the order they appeared in the source file. */
async function listRecords(jobId) {
  const rows = await prisma.bulkImportRecord.findMany({
    where: { jobId },
    orderBy: { rowNumber: "asc" },
  });
  return rows.map(toApiRecord);
}

function summaryOf(records) {
  return BulkImportValidator.summarize(records);
}

/**
 * Re-validates every row of a job and persists whatever changed.
 *
 * The whole set is revalidated after a single-row edit on purpose: duplicate
 * detection is cross-row, so fixing a repeated email on row 9 has to clear the
 * duplicate error that row 9 caused on row 14. Validating only the edited row
 * would leave that stale error blocking the import forever.
 *
 * Only rows whose validation actually changed are written, so the common case
 * (one cell corrected) is one or two UPDATEs, not a rewrite of all 120 rows.
 *
 * @returns {Promise<{ records: Array, summary: Object }>}
 */
async function revalidateJob(job) {
  const stored = await prisma.bulkImportRecord.findMany({
    where: { jobId: job.id },
    orderBy: { rowNumber: "asc" },
  });

  const reference = await BulkImportValidator.loadReference(job.schoolId, job.entity);

  const validated = BulkImportValidator.validateAll(
    stored.map((row) => ({
      recordId: row.recordId,
      rowNumber: row.rowNumber,
      data: parseJson(row.dataJson, {}),
    })),
    reference
  );

  const byRecordId = new Map(stored.map((row) => [row.recordId, row]));
  const writes = [];

  for (const record of validated) {
    const previous = byRecordId.get(record.recordId);
    if (!previous) continue;

    // Re-attach the warnings raised while reading the file. Validation works
    // from the normalised value and cannot rederive them, so without this they
    // would disappear from every row in the job the first time any one row is
    // edited.
    const sourceWarnings = parseJson(previous.sourceWarningsJson, []);
    if (sourceWarnings.length > 0) record.warnings.push(...sourceWarnings);

    const next = toDbFields(record);
    const unchanged =
      previous.dataJson === next.dataJson &&
      previous.errorsJson === next.errorsJson &&
      previous.warningsJson === next.warningsJson &&
      previous.isValid === next.isValid &&
      previous.isDuplicate === next.isDuplicate;

    if (!unchanged) {
      writes.push(
        prisma.bulkImportRecord.update({ where: { id: previous.id }, data: next })
      );
    }
  }

  const summary = summaryOf(validated);

  writes.push(
    prisma.bulkImportJob.update({
      where: { id: job.id },
      data: { summaryJson: JSON.stringify(summary) },
    })
  );

  await prisma.$transaction(writes);

  const records = validated.map((record) => ({
    id: record.recordId,
    rowNumber: record.rowNumber,
    data: record.data,
    isValid: record.errors.length === 0,
    isDuplicate: record.isDuplicate,
    errors: record.errors,
    warnings: record.warnings,
  }));

  return { records, summary };
}

module.exports = {
  parseJson,
  toApiRecord,
  toDbFields,
  listRecords,
  revalidateJob,
  summaryOf,
};
