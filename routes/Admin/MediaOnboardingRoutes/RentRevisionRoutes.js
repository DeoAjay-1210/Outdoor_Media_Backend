// ✅ NEW — rent revision (rent changed from a past month, arrears paid separately)
const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
// invoice PDF (form-data key "invoice") → same "invoice" folder as rental due invoices
const { upload, processFile } = createUploader("rentalDueProofs", { invoice: "invoice" });
const {
  createRentRevision,
  approveRentRevision,
  getRentRevisionList,
  revertCancelRevision, // ✅ NEW
} = require("../../../controllers/Admin/MediaOnboardingController/RentRevisionController");

router.post(
  "/rent-revision",
  protect,
  upload.any(),
  (req, res, next) => {
    req.processFile = processFile;
    next();
  },
  createRentRevision,
);
// ✅ CHANGED — optional invoice PDF (form-data key "invoice"); raw JSON still works
router.post(
  "/rent-revision/approve",
  protect,
  upload.any(),
  (req, res, next) => {
    req.processFile = processFile;
    next();
  },
  approveRentRevision,
);
// ✅ NEW — CANCEL revert: { revisionId, reason } → bills back to CMD approved
router.post("/rent-revision/cancel-revert", protect, revertCancelRevision);
router.get("/rent-revision-list", protect, getRentRevisionList);
router.post("/rent-revision-list", protect, getRentRevisionList);

module.exports = router;
