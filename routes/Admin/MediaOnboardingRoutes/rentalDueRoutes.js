// routes/rentalDue.routes.js
const express = require("express");
const router = express.Router();

// Controllers
// const ctrl = require("../../../controllers/Admin/MediaOnboardingController/RentalDueController");
const {
  getRentalDueListWithStats,
  verifyAgreementDoc,
  saveRentalDue,
  GstAmountPaid,
  revertAgreementDocVerification,
  revertRentalApproval
} = require("../../../controllers/Admin/MediaOnboardingController/RentalDueNew2Controller");
// Middleware
// const  authenticate  = require("../../../middleware/authMiddleware");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");
// Create uploader for rental due campaign proofs and invoices
const { upload, processFile } = createUploader("rentalDueProofs", {
  proofOfCampaign: "rentalDueProofs",
  invoice: "invoice",
});


// STATS
// GET /rental-due/stats
// Returns: totalSites, dueThisMonth, overDue, pendingApproval breakdown
// Accessible by: all roles (1, 2, 3)
// ─────────────────────────────────────────────────────────────
router.post("/rental-due-list", protect, getRentalDueListWithStats);

router.post(
  "/rental-due-save", protect,
   upload.any(),
  (req, res, next) => {
    req.processFile = processFile;
    next();
  },
  saveRentalDue,
);

router.post("/verify-agreement", protect, verifyAgreementDoc);
router.post("/gst-paid",protect, GstAmountPaid);
router.post("/revert-Agreement",protect, revertAgreementDocVerification);
router.post("/revert-Approval",protect, revertRentalApproval);




module.exports = router;
