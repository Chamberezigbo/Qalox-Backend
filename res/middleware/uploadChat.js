const multer = require("multer");

/**
 * Upload config for one photo or document attached to a chat message (a homework photo, a PDF).
 * memoryStorage: parsed once and handed straight to R2, never written to local disk.
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const uploadChat = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("Attach a JPEG, PNG, PDF or Word document"));
    }
    return cb(null, true);
  },
});

/** Wraps multer so its failures come back as the { success, message } shape the rest of the API uses. */
const single = (fieldName) => {
  const handler = uploadChat.single(fieldName);

  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          message: tooBig ? "That file is larger than 5MB. Try a smaller one." : err.message,
        });
      }

      return res.status(415).json({ success: false, message: err.message || "Unsupported file type" });
    });
  };
};

module.exports = { single, MAX_BYTES };
