const express = require("express");
const router = express.Router();
const authenticateSuperAdminJWT = require("../../middleware/authenticateSuperAdminJWT");
const errorLogs = require("../../controller/system-admin/errorLogs");

// Platform owner only: errors can name schools, users and internal code paths.
router.get("/errors", authenticateSuperAdminJWT, errorLogs.listGrouped);
router.get("/errors/by-ref/:ref", authenticateSuperAdminJWT, errorLogs.byRef);
router.get("/errors/:fingerprint", authenticateSuperAdminJWT, errorLogs.occurrences);

module.exports = router;
