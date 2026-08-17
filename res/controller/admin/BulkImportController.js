const crypto = require("crypto");
const prisma = require("../../util/prisma");
const BulkImportWorker = require("../../Services/BulkImportWorker");
const BulkImportImporter = require("../../Services/BulkImportImporter");
const DataMappingService = require("../../Services/DataMappingService");
const { buildColumns, columnKeys, ENTITIES } = require("../../Services/bulkImport/columns");
const store = require("../../Services/bulkImport/store");
const BulkImportValidator = require("../../Services/BulkImportValidator");
const { PERMISSIONS } = require("../../util/permissions");
const { parsePermissions } = require("../../util/permissions");

/**
 * Bulk import of students and staff.
 *
 * The frontend holds no validation rules of its own — it renders exactly what
 * these endpoints return — so three shapes are contractual and must not drift:
 *
 *   - `data` is a flat string -> string map. Never null, never nested; a value
 *     the source file did not have is "".
 *   - every `errors[].field` and `warnings[].field` is a key of `data`, so the
 *     message can be attached to a cell.
 *   - `isValid` is exactly `errors.length === 0`. The import button depends on
 *     it, so nothing may set it independently.
 *
 * Jobs live in the database, not in memory, so a completed job stays readable
 * long after upload (admins spend minutes fixing rows before confirming) and
 * survives a restart or a second server instance.
 */

/** "imp_" + 24 hex chars. Opaque, unguessable, and not a row count. */
function newImportId() {
  return `imp_${crypto.randomBytes(12).toString("hex")}`;
}

/** Accepts "students"/"student"/"staff", case-insensitively. */
function normalizeEntity(raw) {
  const value = String(raw == null ? "" : raw).trim().toLowerCase();
  if (value === "student" || value === "students") return "students";
  if (value === "staff" || value === "staffs") return "staff";
  return null;
}

/**
 * Entity-specific permission gate.
 *
 * Not a route-level `requirePermission()` because which permission applies is
 * only known once the entity is read — from the multipart body on upload, and
 * from the stored job on every later call.
 */
function permissionError(req, entity) {
  const { role, permissions } = req.user || {};
  if (role === "super_admin" || role === "school_admin") return null;

  const needed = entity === "students" ? PERMISSIONS.STUDENTS_MANAGE : PERMISSIONS.STAFF_MANAGE;
  if (role === "sub_admin" && parsePermissions(permissions).includes(needed)) return null;

  return `You do not have permission to import ${entity}`;
}

/**
 * Loads a job and confirms it belongs to the caller's school.
 *
 * A job from another school is reported as "not found" rather than "forbidden":
 * a 403 would confirm that an import with that id exists.
 */
async function loadJob(req, res) {
  const job = await prisma.bulkImportJob.findUnique({ where: { id: req.params.importId } });

  if (!job || job.schoolId !== req.schoolId) {
    res.status(404).json({ success: false, message: "Import not found" });
    return null;
  }

  const denied = permissionError(req, job.entity);
  if (denied) {
    res.status(403).json({ success: false, message: denied });
    return null;
  }

  return job;
}

// ---------------------------------------------------------------------------
// 1. POST /api/admin/bulk-import/upload
// ---------------------------------------------------------------------------

/**
 * Accepts the file and returns immediately.
 *
 * Extraction (OCR in particular) can take tens of seconds, far longer than a
 * browser will hold a request open, so the job row is created synchronously and
 * the work is handed to the worker. The client polls for the outcome.
 */
exports.uploadDocument = async (req, res, next) => {
  try {
    const entity = normalizeEntity(req.body.entity || req.body.entityType);

    if (!entity) {
      return res.status(400).json({
        success: false,
        message: `"entity" must be one of: ${ENTITIES.join(", ")}`,
      });
    }

    const denied = permissionError(req, entity);
    if (denied) {
      return res.status(403).json({ success: false, message: denied });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No file was uploaded. Attach a file in the \"file\" field.",
      });
    }

    const job = await prisma.bulkImportJob.create({
      data: {
        id: newImportId(),
        schoolId: req.schoolId,
        adminId: req.user.id,
        entity,
        status: "processing",
        progress: 5,
        stage: "Queued",
        fileName: req.file.originalname || "upload",
        fileSize: req.file.size || req.file.buffer.length,
        mimeType: req.file.mimetype || "",
        allowWarnings: true,
      },
    });

    // Deliberately not awaited: the response goes out first, and the worker
    // records its own outcome on the job row. A rejection here would otherwise
    // become an unhandled rejection long after the request has ended.
    setImmediate(() => {
      BulkImportWorker.processJob({
        jobId: job.id,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        fileName: req.file.originalname,
        schoolId: req.schoolId,
        entity,
      }).catch((error) => {
        console.error(`Bulk import worker crashed for job ${job.id}:`, error);
      });
    });

    return res.status(202).json({
      success: true,
      message: "File received — extracting records",
      data: { importId: job.id, status: "processing" },
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 2. GET /api/admin/bulk-import/:importId
// ---------------------------------------------------------------------------

/**
 * Polled every few seconds while processing, then once more for the full
 * result. The processing and failed responses stay deliberately small — there
 * is nothing to render yet beyond the progress bar.
 */
exports.getImportStatus = async (req, res, next) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return undefined;

    if (job.status === "processing") {
      return res.status(200).json({
        success: true,
        message: job.stage,
        data: {
          importId: job.id,
          status: "processing",
          progress: job.progress,
          stage: job.stage,
        },
      });
    }

    if (job.status === "failed") {
      return res.status(200).json({
        success: true,
        message: "Import failed",
        data: {
          importId: job.id,
          status: "failed",
          errorMessage:
            job.errorMessage || "This file could not be processed. Try uploading it again.",
        },
      });
    }

    const records = await store.listRecords(job.id);

    // The stored column definitions carry the dropdown options captured at
    // upload time; falling back to freshly built ones keeps an older job
    // readable if that column was never written.
    let columns = store.parseJson(job.columnsJson, null);
    if (!columns) {
      const reference = await BulkImportValidator.loadReference(job.schoolId, job.entity);
      columns = buildColumns(job.entity, reference);
    }

    return res.status(200).json({
      success: true,
      message: "Import ready for review",
      data: {
        importId: job.id,
        status: "completed",
        entity: job.entity,
        fileName: job.fileName,
        allowWarnings: job.allowWarnings,
        columns,
        records,
        // Recomputed from the records actually being returned, so the counts can
        // never disagree with the rows on screen.
        summary: store.summaryOf(records),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 3. PATCH /api/admin/bulk-import/:importId/records/:recordId
// ---------------------------------------------------------------------------

/**
 * Applies an admin's cell edits to one row and returns that row in full.
 *
 * The whole row is re-validated, not just the edited fields: a corrected class
 * name can clear an error on the group column, and a fixed email can clear the
 * duplicate error it caused on a different row.
 */
exports.updateRecord = async (req, res, next) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return undefined;

    if (job.status !== "completed") {
      return res.status(409).json({
        success: false,
        message:
          job.status === "processing"
            ? "This import is still being processed."
            : "This import failed and cannot be edited.",
      });
    }

    if (job.confirmedAt) {
      return res.status(409).json({
        success: false,
        message: "This import has already been completed and can no longer be edited.",
      });
    }

    const record = await prisma.bulkImportRecord.findUnique({
      where: { jobId_recordId: { jobId: job.id, recordId: req.params.recordId } },
    });
    if (!record) {
      return res.status(404).json({ success: false, message: "Record not found in this import" });
    }

    const patch = req.body;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return res.status(400).json({
        success: false,
        message: "Send an object of the fields to change, for example { \"gender\": \"Female\" }",
      });
    }

    const allowed = columnKeys(job.entity);
    const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Unknown field(s): ${unknown.join(", ")}. Editable fields are: ${allowed.join(", ")}`,
      });
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const data = store.parseJson(record.dataJson, {});
    for (const [key, value] of Object.entries(patch)) {
      if (value != null && typeof value === "object") {
        return res.status(400).json({
          success: false,
          message: `"${key}" must be a text value, not an object or list`,
        });
      }
      // Typed-in values go through the same normalisers as extracted ones, so
      // "12/04/2012" typed by hand becomes the same ISO date the file produced —
      // otherwise the row would fail validation for a formatting reason the
      // admin cannot see.
      data[key] = normalizeEditedValue(key, value);
    }

    // A warning raised while reading the file ("this date was read day-first")
    // is answered the moment the admin sets that field themselves, so it is
    // dropped for the edited fields only — warnings on fields they have not
    // looked at yet survive.
    const edited = new Set(Object.keys(patch));
    const sourceWarnings = store
      .parseJson(record.sourceWarningsJson, [])
      .filter((warning) => !edited.has(warning.field));

    await prisma.bulkImportRecord.update({
      where: { id: record.id },
      data: {
        dataJson: JSON.stringify(data),
        sourceWarningsJson: JSON.stringify(sourceWarnings),
      },
    });

    const { records } = await store.revalidateJob(job);
    const updated = records.find((r) => r.id === record.recordId);

    return res.status(200).json({
      success: true,
      message: "Record updated",
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/** Mirrors the extraction-time normalisation for a hand-typed value. */
function normalizeEditedValue(key, value) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return "";

  if (key === "gender") return DataMappingService.normalizeGender(text);
  if (key === "dob" || key === "dateEmployed") {
    const parsed = DataMappingService.normalizeDate(text);
    return parsed.value || text; // unparseable text is kept so the error can quote it
  }
  if (key === "parentPhone" || key === "phone") return DataMappingService.normalizePhone(text);
  if (key === "email") return text.toLowerCase();
  return text;
}

// ---------------------------------------------------------------------------
// 4. POST /api/admin/bulk-import/:importId/confirm
// ---------------------------------------------------------------------------

/**
 * Commits the reviewed rows.
 *
 * Everything is re-validated first rather than trusting what was stored at
 * upload time — an admin may have spent twenty minutes on this screen, and a
 * class could have been renamed or deleted in the meantime.
 */
exports.confirmImport = async (req, res, next) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return undefined;

    if (job.status !== "completed") {
      return res.status(409).json({
        success: false,
        message:
          job.status === "processing"
            ? "This import is still being processed."
            : "This import failed and cannot be confirmed.",
      });
    }

    if (job.confirmedAt) {
      return res.status(409).json({
        success: false,
        message: "This import has already been completed.",
      });
    }

    const { records, summary } = await store.revalidateJob(job);

    if (records.length === 0) {
      return res.status(400).json({ success: false, message: "This import has no rows." });
    }

    // Warnings never block on their own; they only block until acknowledged, and
    // only when the job was created with allowWarnings.
    const acknowledged = req.body && req.body.acknowledgeWarnings === true;
    if (summary.warnings > 0 && !acknowledged) {
      if (!job.allowWarnings) {
        return res.status(400).json({
          success: false,
          message: `${summary.warnings} row(s) have warnings that must be fixed before this import can proceed.`,
        });
      }
      return res.status(400).json({
        success: false,
        message: `${summary.warnings} row(s) have warnings. Review them, then confirm again with acknowledgeWarnings set to true.`,
      });
    }

    const valid = records.filter((record) => record.isValid);
    const skipped = records.filter((record) => !record.isValid);

    if (valid.length === 0) {
      return res.status(400).json({
        success: false,
        message: `None of the ${records.length} row(s) can be imported yet — every row still has an error to fix.`,
      });
    }

    // Whole-import blockers (the plan's student cap) are checked before any row
    // is written, so the admin is never left guessing which half landed.
    const blocker = await BulkImportImporter.checkPreconditions({
      schoolId: job.schoolId,
      entity: job.entity,
      count: valid.length,
    });
    if (blocker) {
      return res.status(blocker.status).json({ success: false, message: blocker.message });
    }

    const results = await BulkImportImporter.importRecords({
      schoolId: job.schoolId,
      entity: job.entity,
      records: valid,
    });

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    const now = new Date();
    await prisma.$transaction([
      ...succeeded.map((result) =>
        prisma.bulkImportRecord.updateMany({
          where: { jobId: job.id, recordId: result.recordId },
          data: { importedAt: now, failureReason: null },
        })
      ),
      ...failed.map((result) =>
        prisma.bulkImportRecord.updateMany({
          where: { jobId: job.id, recordId: result.recordId },
          data: { importedAt: null, failureReason: result.reason },
        })
      ),
      prisma.bulkImportJob.update({
        where: { id: job.id },
        data: { confirmedAt: now, stage: "Imported" },
      }),
    ]);

    const failures = [
      // Rows that were never attempted because they still had errors. Their
      // reason is the validation message itself, so the admin sees the same
      // text here as on the row they left unfixed.
      ...skipped.map((record) => ({
        recordId: record.id,
        rowNumber: record.rowNumber,
        reason: record.errors.map((e) => e.message).join("; ") || "Row has unresolved errors",
        data: record.data,
      })),
      // Rows that were attempted and rejected by the database.
      ...failed.map((result) => ({
        recordId: result.recordId,
        rowNumber: result.rowNumber,
        reason: result.reason,
        data: result.data,
      })),
    ].sort((a, b) => a.rowNumber - b.rowNumber);

    const payload = {
      totalProcessed: records.length,
      successCount: succeeded.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      failures,
    };

    if (failures.length > 0) {
      // An authenticated endpoint, not a public file: these rows are full
      // student and staff records, and a link under the statically served
      // uploads directory would expose them to anyone holding the URL.
      payload.failedRecordsDownloadUrl = `/api/admin/bulk-import/${job.id}/failures.csv`;
    }

    return res.status(200).json({
      success: true,
      message: `Imported ${succeeded.length} of ${records.length} row(s)`,
      data: payload,
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Supporting: GET /api/admin/bulk-import/:importId/failures.csv
// ---------------------------------------------------------------------------

/** RFC 4180 quoting — commas, quotes and newlines inside a value. */
function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The rows that did not make it, as a CSV the admin can fix and re-upload.
 * Served through the API (and so behind the bearer token) rather than as a
 * static file, because every row is personal data.
 */
exports.downloadFailedRecords = async (req, res, next) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return undefined;

    const rows = await prisma.bulkImportRecord.findMany({
      where: { jobId: job.id, importedAt: null },
      orderBy: { rowNumber: "asc" },
    });

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "There are no failed rows for this import.",
      });
    }

    const columns = store.parseJson(job.columnsJson, buildColumns(job.entity));
    const headers = ["Row", ...columns.map((c) => c.label), "Reason"];

    const lines = [headers.map(csvCell).join(",")];
    for (const row of rows) {
      const data = store.parseJson(row.dataJson, {});
      const errors = store.parseJson(row.errorsJson, []);
      const reason =
        row.failureReason || errors.map((e) => e.message).join("; ") || "Not imported";
      lines.push(
        [row.rowNumber, ...columns.map((c) => data[c.key] || ""), reason].map(csvCell).join(",")
      );
    }

    const fileName = `failed-rows-${job.id}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    // BOM so Excel opens the file as UTF-8 instead of mangling accented names.
    return res.status(200).send(`﻿${lines.join("\r\n")}`);
  } catch (error) {
    next(error);
  }
};
