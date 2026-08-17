const prisma = require("../util/prisma");
const DocumentExtractionService = require("./DocumentExtractionService");
const DataMappingService = require("./DataMappingService");
const BulkImportValidator = require("./BulkImportValidator");
const { buildColumns } = require("./bulkImport/columns");
const { toDbFields, summaryOf } = require("./bulkImport/store");

/**
 * Runs extraction and validation after the upload response has already been
 * sent, driving the job from `processing` to `completed` or `failed`.
 *
 * Progress is written to the job row rather than held in memory because the
 * client polls GET /bulk-import/:importId on a different request — and possibly
 * a different server instance — from the one running this.
 */

// OCR on a large photo, or a 1000-row sheet, is slow but bounded. Above this
// the request stops being an import and starts being a data migration, and the
// per-row inserts at confirm time would run past any sensible request timeout.
const MAX_ROWS = 1000;

class BulkImportWorker {
  /**
   * @param {Object} params
   * @param {String} params.jobId
   * @param {Buffer} params.buffer    file contents (multer memory storage)
   * @param {String} params.mimeType
   * @param {String} params.fileName
   * @param {Number} params.schoolId
   * @param {String} params.entity    "students" | "staff"
   */
  static async processJob({ jobId, buffer, mimeType, fileName, schoolId, entity }) {
    const setProgress = async (progress, stage) => {
      try {
        await prisma.bulkImportJob.update({
          where: { id: jobId },
          data: { progress, stage },
        });
      } catch (error) {
        // A lost progress tick is cosmetic — never let it abort the import.
      }
    };

    try {
      await setProgress(10, "Reading the file");

      const extracted = await DocumentExtractionService.extract({
        buffer,
        mimeType,
        fileName,
        entity,
        onProgress: setProgress,
      });

      if (extracted.length > MAX_ROWS) {
        throw new Error(
          `This file has ${extracted.length} rows. A single import is limited to ${MAX_ROWS} — split the file and upload it in parts.`
        );
      }

      await setProgress(65, "Mapping columns");

      // Extraction hands back raw source rows; mapping turns them into the flat
      // canonical shape and reports anything the admin should double-check
      // (currently: dates that could be read either day-first or month-first).
      const mapped = [];
      const extraWarnings = new Map();

      for (const { rowNumber, raw } of extracted) {
        const { data, meta } = DataMappingService.buildRow(raw, entity);
        if (DataMappingService.isBlankRow(data)) continue;

        const recordId = `row_${rowNumber}`;
        mapped.push({ recordId, rowNumber, data });

        if (meta.ambiguousDates.length > 0) {
          extraWarnings.set(
            recordId,
            meta.ambiguousDates.map((field) => ({
              field,
              message:
                "This date was read as day/month/year — check it is the right way round",
            }))
          );
        }
      }

      if (mapped.length === 0) {
        throw new Error(
          "No usable rows were found in this file — every row under the headings was empty."
        );
      }

      await setProgress(75, "Validating information");

      const reference = await BulkImportValidator.loadReference(schoolId, entity);
      const validated = BulkImportValidator.validateAll(mapped, reference);

      // Mapping-time warnings are merged in after validation, and also stored in
      // their own column — validation rebuilds the warnings array from scratch
      // every time a row is revalidated, and cannot rederive these from the
      // already-normalised value.
      for (const record of validated) {
        const extra = extraWarnings.get(record.recordId);
        if (extra) record.warnings.push(...extra);
      }

      await setProgress(90, "Checking for duplicates");

      const summary = summaryOf(validated);
      const columns = buildColumns(entity, reference);

      await prisma.$transaction([
        // Clearing first makes a retry of the same job id idempotent rather than
        // doubling every row.
        prisma.bulkImportRecord.deleteMany({ where: { jobId } }),
        prisma.bulkImportRecord.createMany({
          data: validated.map((record) => ({
            jobId,
            recordId: record.recordId,
            rowNumber: record.rowNumber,
            ...toDbFields(record),
            sourceWarningsJson: JSON.stringify(extraWarnings.get(record.recordId) || []),
          })),
        }),
        prisma.bulkImportJob.update({
          where: { id: jobId },
          data: {
            status: "completed",
            progress: 100,
            stage: "Ready for review",
            errorMessage: null,
            columnsJson: JSON.stringify(columns),
            summaryJson: JSON.stringify(summary),
            completedAt: new Date(),
          },
        }),
      ]);
    } catch (error) {
      // Extraction failures are written as-is: they are authored as admin-facing
      // instructions. Anything else gets a generic message, since a stack trace
      // or a Prisma error string tells an admin nothing useful.
      const readable =
        error && typeof error.message === "string" && error.message.length < 400
          ? error.message
          : "This file could not be processed. Try uploading it again, or use an Excel or CSV file.";

      console.error(`Bulk import job ${jobId} failed:`, error);

      await prisma.bulkImportJob
        .update({
          where: { id: jobId },
          data: {
            status: "failed",
            stage: "Failed",
            errorMessage: readable,
            completedAt: new Date(),
          },
        })
        .catch((updateError) => {
          console.error(`Could not mark bulk import job ${jobId} as failed:`, updateError);
        });
    }
  }
}

module.exports = BulkImportWorker;
module.exports.MAX_ROWS = MAX_ROWS;
