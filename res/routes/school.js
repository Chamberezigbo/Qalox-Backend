const express = require("express");
const multer = require("multer");

const upload = require("../middleware/upload");
const auth = require("../middleware/authenticateSuperAdmin");
const validate = require("../middleware/validator");
const { schoolValidationSchema } = require("../schemas/index");

const { setupSchool } = require("../controller/school/schoolController");

const router = express.Router();

router.post(
  "/setup",
  upload.fields([{ name: "logoUrl" }, { name: "stampUrl" }]),
  validate(schoolValidationSchema),
  auth.authenticateSuperAdmin,
  setupSchool
);

// Error handling middleware for multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: err.message });
  } else if (err) {
    return res.status(400).json({ message: err.message });
  }
  next();
});

module.exports = router;
