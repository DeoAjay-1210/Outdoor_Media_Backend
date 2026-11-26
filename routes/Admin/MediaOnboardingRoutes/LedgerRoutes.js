const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const {
  createLedgerEntry,
  listMediaByLedger,
  getLedgerHistory,
  saveLedgerPaymentInfo, // ✅ NEW
} = require("../../../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
const { errorResponse } = require("../../../utils/response");

// ✅ NEW — ledger-save only for the Accounts user (userType 5); Rental Executive /
// Rental Manager / CMD / Other / Admin → 403. Save logic unchanged.
const ACCOUNTS_USER_TYPE = 5;
const onlyAccounts = (req, res, next) => {
  if (Number(req.user?.userType) === ACCOUNTS_USER_TYPE) return next();
  return errorResponse(res, "Only Accounts user can save ledger entries", null, 403);
};



router.post("/ledger-save", protect, onlyAccounts, createLedgerEntry); // ✅ CHANGED — + Accounts only
router.post("/ledger-list",protect, listMediaByLedger);
router.post("/ledger-history",protect, getLedgerHistory);
router.post("/ledger-payment-info-save", protect, saveLedgerPaymentInfo); // ✅ NEW — payment details before UTR

module.exports = router;

