const express = require("express");
const { handleFlutterwaveWebhook } = require("../controller/webhookController");

const router = express.Router();

// No auth middleware — authenticity is verified via the flutterwave-signature
// header (HMAC of req.rawBody) inside the controller itself.
router.post("/flutterwave", handleFlutterwaveWebhook);

module.exports = router;
