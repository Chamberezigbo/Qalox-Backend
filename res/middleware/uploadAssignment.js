const multer = require("multer");

/**
 * Upload config for assignment attachments (equations, diagrams, a scanned
 * worksheet — anything a teacher can't reasonably type into a plain text
 * box). Separate from res/middleware/upload.js (images only, feeds sharp)
 * and uploadKyc.js (writes to local disk, which this deliberately avoids —
 * see AssignmentService.ts) because this one uploads straight to R2.
 *
 * memoryStorage: the file is parsed once, immediately, and handed to R2 —
 * never written to local disk.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB — matches the bulk-import upload limit

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const uploadAssignment = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("Attachment must be a JPEG, PNG, PDF, or Word document"));
    }
    return cb(null, true);
  },
});

/**
 * Wraps multer so its own failures come back as proper HTTP responses with
 * the { success, message } shape the rest of the API uses, instead of an
 * oversized/wrong-type file reaching errorMiddleware as a plain Error and
 * reading to the teacher as "the server broke".
 */
const single = (fieldName) => {
  const handler = uploadAssignment.single(fieldName);

  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          message: tooBig
            ? "That attachment is larger than 10MB. Try a smaller file."
            : err.message,
        });
      }

      // fileFilter rejection — the message is already teacher-readable.
      return res.status(415).json({
        success: false,
        message: err.message || "Unsupported file type",
      });
    });
  };
};

module.exports = { single, MAX_BYTES };
