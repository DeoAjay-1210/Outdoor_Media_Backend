const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const C = require("../../../controllers/Admin/GmailController/GmailController");

// Gmail UTR integration. Mounted at /api/gmail in server.js.
router.get("/oauth/url", protect, C.getAuthUrl); // Rental Executive / Manager / CMD
router.get("/oauth/callback", C.oauthCallback); // Google redirect; protected by the signed `state`
router.get("/status", protect, C.connectionStatusApi); // Rental Executive / Manager / CMD; which Gmail account is connected
router.delete("/disconnect", protect, C.disconnectApi); // Rental Executive / Manager / CMD; deletes the stored login token
router.get("/test-utr", protect, C.testUtr); // CMD only; no database writes
router.get("/pending-utr-bills", protect, C.pendingUtrBills); // CMD only; read-only
router.post("/process-pending-utrs", protect, C.processPendingUtrsApi); // CMD only; dry run unless saving is enabled
router.get("/utr-corrections", protect, C.utrCorrectionsApi); // CMD only; read-only: is the stored UTR of a Bill Number corrected by a later reply?
router.get("/utr-tracker/export", protect, C.utrTrackerExport); // any logged-in role (token required); read-only: Excel of approved bills x landlord x payment part with UTR / status / error / reply format
router.post("/utr-errors/notify-chat", protect, C.notifyUtrErrorsChatApi); // ✅ NEW — CMD only; old wrong UTR replies → UTR error Google Chat space (dryRun by default)

module.exports = router;
