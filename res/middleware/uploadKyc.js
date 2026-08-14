const multer = require("multer");

/**
 * Upload config for KYC verification documents.
 *
 * Separate from res/middleware/upload.js because that one is images-only
 * (it feeds sharp, which cannot process a PDF) and KYC accepts PDFs too.
 *
 * memoryStorage keeps the file in a Buffer so the handler decides where it
 * lands — these must NOT go into res/uploads, which app.ts serves statically.
 */
const uploadKyc = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB — enforced here, not trusted from the client
    files: 1,
  },
  fileFilter(req, file, cb) {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Document must be a JPEG, PNG or PDF"));
    }
  },
});

/**
 * Wraps the multer middleware so its failures become meaningful HTTP responses.
 * Left unwrapped, an oversized file or a .exe rename reaches errorMiddleware as
 * a plain Error and is reported as a 500 — which reads to the client as "the
 * server broke" rather than "your file was rejected".
 */
const uploadKycSingle = (fieldName) => {
  const handler = uploadKyc.single(fieldName); // capture multer's own middleware

  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          message: tooBig ? "Document must be 5MB or smaller" : err.message,
          code: tooBig ? "FILE_TOO_LARGE" : "INVALID_UPLOAD",
        });
      }

      // fileFilter rejection (wrong mime type)
      return res.status(415).json({
        success: false,
        message: err.message || "Unsupported document format",
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
    });
  };
};

module.exports = { single: uploadKycSingle };
