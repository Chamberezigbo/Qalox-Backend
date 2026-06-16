const express = require("express");
const router = express.Router();

const {
  generateToken,
} = require("../../controller/system-admin/generateToken");
const validate = require("../../middleware/validator");
const { tokenSchema } = require("../../schemas/index");

router.post("/generate", validate(tokenSchema), generateToken);

module.exports = router;
