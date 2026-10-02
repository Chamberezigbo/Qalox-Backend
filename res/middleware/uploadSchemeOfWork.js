const multer = require("multer");

/**
 * Upload config for Scheme of Work documents. An admin supplies either one
 * PDF, or several photos of a physical scheme booklet (one per page) — hence
 * `array` rather than the `single` other upload middlewares use.
 *
 * Why the page cap matters beyond file size: each photo costs a Gemini Vision
 * call to read (see SchemeOfWorkService), so an uncapped upload is an uncapped
 * bill. A PDF is read with pdf-parse and costs nothing.
 *
 * memoryStorage: files are parsed once, immediately, and handed to R2 — never
 * written to local disk (same reasoning as uploadAssignment.js).
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per file — matches the other upload limits
const MAX_FILES = 10; // pages of a photographed scheme

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const uploadSchemeOfWork = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: MAX_FILES,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("A scheme of work must be a PDF, or JPEG/PNG/WebP photos of each page"));
    }
    return cb(null, true);
  },
});

/**
 * Wraps multer so its own failures come back as proper HTTP responses with
 * the { success, message } shape the rest of the API uses, instead of an
 * oversized/wrong-type file reaching errorMiddleware as a plain Error.
 */
const array = (fieldName) => {
  const handler = uploadSchemeOfWork.array(fieldName, MAX_FILES);

  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            success: false,
            message: "Each file must be under 10MB. Try a smaller file or a lower-resolution photo.",
          });
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            success: false,
            message: `Upload one PDF, or up to ${MAX_FILES} page photos at a time.`,
          });
        }
        return res.status(400).json({ success: false, message: err.message });
      }

      // fileFilter rejection — the message is already admin-readable.
      return res.status(415).json({
        success: false,
        message: err.message || "Unsupported file type",
      });
    });
  };
};

module.exports = { array, MAX_BYTES, MAX_FILES, ALLOWED_MIME_TYPES };
