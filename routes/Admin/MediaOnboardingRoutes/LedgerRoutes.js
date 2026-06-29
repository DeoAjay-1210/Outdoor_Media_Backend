const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const {
  createLedgerEntry,
  listMediaByLedger,
  getLedgerHistory,
} = require("../../../controllers/Admin/MediaOnboardingController/LedgerController");



router.post("/ledger-save",protect, createLedgerEntry);
router.post("/ledger-list",protect, listMediaByLedger);
router.get("/ledger-history",protect, getLedgerHistory);

module.exports = router;

