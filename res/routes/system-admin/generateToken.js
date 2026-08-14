const express = require("express");
const router = express.Router();

const {
  generateToken,
} = require("../../controller/system-admin/generateToken");
const validate = require("../../middleware/validator");
const { tokenSchema } = require("../../schemas/index");
const authenticateSuperAdminJWT = require("../../middleware/authenticateSuperAdminJWT");

// Registration tokens are what allow a super_admin account to be created for a
// school (see POST /api/admin/create), so minting one is a privileged action.
// This route previously had no auth at all. It duplicates POST /api/generate —
// prefer that one; this path is kept for existing callers.
router.post("/generate", authenticateSuperAdminJWT, validate(tokenSchema), generateToken);

module.exports = router;
