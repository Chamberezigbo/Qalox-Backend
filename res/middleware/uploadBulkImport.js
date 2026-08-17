const multer = require("multer");
const path = require("path");

/**
 * Upload config for bulk-import files.
 *
 * Separate from res/middleware/upload.js (images only, 5MB, feeds sharp) and
 * from uploadKyc.js (5MB, no spreadsheets) because this one has to accept the
 * whole spreadsheet/document/photo range at 10MB.
 *
 * memoryStorage: the file is parsed once, immediately, and never needs to
 * outlive the request — writing it to disk would leave a directory of student
 * records nobody cleans up.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".csv", ".pdf", ".png", ".jpg", ".jpeg"]);

// Browsers and operating systems disagree wildly about what a .csv or .xls is
// (text/plain, application/vnd.ms-excel, application/octet-stream...), so the
// extension is the real gate and the mime type is only a secondary signal.
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/octet-stream",
]);

const uploadBulkImport = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES, // enforced here, never trusted from the client
    files: 1,
  },
  fileFilter(req, file, cb) {
    const extension = path.extname(file.originalname || "").toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return cb(
        new Error(
          "Unsupported file type. Upload an Excel (.xlsx, .xls), CSV, PDF, PNG or JPG file."
        )
      );
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Files of type "${file.mimetype}" cannot be imported.`));
    }

    return cb(null, true);
  },
});

/**
 * Wraps multer so its own failures come back as proper HTTP responses with the
 * { success, message } shape the rest of the API uses. Unwrapped, an oversized
 * file reaches the error middleware as a plain Error and is reported as a 500 —
 * which reads to the admin as "the server broke" rather than "your file is too
 * big".
 */
const single = (fieldName) => {
  const handler = uploadBulkImport.single(fieldName);

  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          message: tooBig
            ? "That file is larger than 10MB. Split it into smaller files and upload them one at a time."
            : err.message,
        });
      }

      // fileFilter rejection — the message is already admin-readable.
      return res.status(415).json({
        success: false,
        message: err.message || "Unsupported file type",
      });
    });
  };
};

module.exports = { single, MAX_BYTES, ALLOWED_EXTENSIONS };
