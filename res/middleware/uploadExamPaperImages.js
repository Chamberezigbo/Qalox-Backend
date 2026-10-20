const multer = require("multer");

/**
 * Reference images a teacher attaches in the exam-paper chat (a Biology diagram, a map,
 * a graph) and images they put on a question by hand. Memory storage: each one is
 * resized and handed straight to R2, never written to local disk.
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5MB each
const MAX_FILES = 4;
const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) return cb(new Error("Attach JPEG, PNG or WebP images only"));
    return cb(null, true);
  },
});

const wrap = (handler) => (req, res, next) =>
  handler(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ success: false, message: "Each image must be under 5MB." });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ success: false, message: `Attach up to ${MAX_FILES} images at a time.` });
      }
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(415).json({ success: false, message: err.message || "Unsupported file type" });
  });

/** Up to MAX_FILES images in one field. */
const images = (fieldName) => wrap(uploader.array(fieldName, MAX_FILES));
/** One image. */
const single = (fieldName) => wrap(uploader.single(fieldName));

module.exports = { images, single, MAX_BYTES, MAX_FILES, ALLOWED };
