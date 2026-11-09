const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const C = require("../../../controllers/Admin/GmailController/GmailController");

// Gmail UTR integration (read-only). Mounted at /api/gmail in server.js.
router.get("/oauth/url", protect, C.getAuthUrl); // CMD only
router.get("/oauth/callback", C.oauthCallback); // Google redirect; protected by the signed `state`
router.get("/test-utr", protect, C.testUtr); // CMD only; no database writes

module.exports = router;
