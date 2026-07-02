// routes/rentalDue.routes.js
const express = require("express");
const router = express.Router();

// Controllers
// const ctrl = require("../../../controllers/Admin/MediaOnboardingController/RentalDueController");
const {
  getRentalDueListWithStats,
  verifyAgreementDoc,
  saveRentalDue
} = require("../../../controllers/Admin/MediaOnboardingController/RentalDueController");
// Middleware
// const  authenticate  = require("../../../middleware/authMiddleware");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");
// Create uploader for rental due campaign proofs
const { upload, processFile } = createUploader("rentalDueProofs", {
  proofOfCampaign: "proofOfCampaign",
});


// STATS
// GET /rental-due/stats
// Returns: totalSites, dueThisMonth, overDue, pendingApproval breakdown
// Accessible by: all roles (1, 2, 3)
// ─────────────────────────────────────────────────────────────
router.post("/rental-due-list", protect, getRentalDueListWithStats);


// router.post(
//   "/rental-due-save",protect,
//   upload.single("proofOfCampaign"),
//   (req, res, next) => {
//     req.processFile = processFile;
//     next();
//   },
//   ctrl.saveRentalDue,
// );
router.post(
  "/rental-due-save", protect,
  upload.fields([{ name: "proofOfCampaign", maxCount: 1 }]),
  (req, res, next) => {
    req.processFile = processFile;
    next();
  },
  saveRentalDue,
);

router.post("/verify-agreement", protect, verifyAgreementDoc);




module.exports = router;
