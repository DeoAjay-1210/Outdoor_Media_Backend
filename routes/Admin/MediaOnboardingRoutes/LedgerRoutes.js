const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const {
  createLedgerEntry,
  listMediaByLedger,
  getLedgerHistory,
  saveLedgerPaymentInfo, // ✅ NEW
} = require("../../../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");



router.post("/ledger-save",protect, createLedgerEntry);
router.post("/ledger-list",protect, listMediaByLedger);
router.post("/ledger-history",protect, getLedgerHistory);
router.post("/ledger-payment-info-save", protect, saveLedgerPaymentInfo); // ✅ NEW — payment details before UTR

module.exports = router;

