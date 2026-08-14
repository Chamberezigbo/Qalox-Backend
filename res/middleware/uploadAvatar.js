const multer = require("multer");

/**
 * Upload config for marketer profile avatars.
 *
 * Separate from res/middleware/upload.js: that one accepts webp and gif, which
 * config/compress.js then rejects during sharp validation — the request would
 * pass multer and die as a 500 instead of a clean 415. Restricting the filter
 * here to exactly what processImage supports keeps rejection at the edge.
 *
 * memoryStorage because processImage takes a Buffer and writes the resized
 * result itself (see uploadAvatar in publicController).
 */
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB — enforced here, not trusted from the client
    files: 1,
  },
  fileFilter(req, file, cb) {
    const allowed = ["image/jpeg", "image/jpg", "image/png"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Avatar must be a JPEG or PNG image"));
    }
  },
});

/**
 * Wraps multer so its failures become meaningful HTTP responses rather than
 * reaching errorMiddleware as a plain Error and surfacing as a 500. Mirrors
 * res/middleware/uploadKyc.js so both upload paths report failures the same way.
 */
const uploadAvatarSingle = (fieldName) => {
  const handler = uploadAvatar.single(fieldName);

  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          message: tooBig ? "Avatar must be 2MB or smaller" : err.message,
          code: tooBig ? "FILE_TOO_LARGE" : "INVALID_UPLOAD",
        });
      }

      // fileFilter rejection (wrong mime type)
      return res.status(415).json({
        success: false,
        message: err.message || "Unsupported image format",
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
    });
  };
};

module.exports = { single: uploadAvatarSingle };
