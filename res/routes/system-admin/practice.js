const express = require("express");
const router = express.Router();
const authenticateSuperAdminJWT = require("../../middleware/authenticateSuperAdminJWT");
const practice = require("../../controller/system-admin/practiceBank");

// The practice bank belongs to the platform, so only the platform owner manages it.
router.post("/practice/import", authenticateSuperAdminJWT, practice.importQuestions);
router.post("/practice/generate", authenticateSuperAdminJWT, practice.generate);
router.post("/practice/topics", authenticateSuperAdminJWT, practice.topics);
router.get("/practice/questions", authenticateSuperAdminJWT, practice.list);
router.patch("/practice/questions/:id", authenticateSuperAdminJWT, practice.update);
router.get("/practice/stats", authenticateSuperAdminJWT, practice.stats);

module.exports = router;
