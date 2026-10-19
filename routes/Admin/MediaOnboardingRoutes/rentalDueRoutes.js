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
  revertRentalApproval,
  getOverDueHistoryList,
  overDueRemark,
  getOverDueRemarks,
  editOverdueRemark,
  deleteOverdueRemark,
  undoDeleteOverdueRemark,
  pinOverdueRemark,
  markOverdueRemarkRead,
  getMessageInfo,
  getEditHistory
} = require("../../../controllers/Admin/MediaOnboardingController/RentalDueNew2Controller");
const { getRentalDueHistory } = require("../../../controllers/Admin/MediaOnboardingController/RentalDueHistoryController");
// Middleware
// const  authenticate  = require("../../../middleware/authMiddleware");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");
// Create uploader for rental due campaign proofs and invoices
const { upload, processFile } = createUploader("rentalDueProofs", {
  proofOfCampaign: "rentalDueProofs",
  invoice: "invoice",
});
const overdueRemarksUploader = createUploader("overdueRemarks");


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

// ✅ NEW — campaignName / reason / proofOfCampaign / invoice change history (body: mediaId, pageNumber, count)
router.post("/rental-due-history", protect, getRentalDueHistory);
router.post("/verify-agreement", protect, verifyAgreementDoc);
router.post("/gst-paid",protect, GstAmountPaid);
router.post("/revert-Agreement",protect, revertAgreementDocVerification);
router.post("/revert-Approval",protect, revertRentalApproval);
router.post("/overdue-history-list", protect, getOverDueHistoryList);
router.get("/overdue-remarks", protect, getOverDueRemarks);
router.post("/overdue-remark", protect, overdueRemarksUploader.upload.any(), overDueRemark);

// ✅ CHAT ENHANCEMENT ENDPOINTS
router.put("/overdue-remark/edit", protect, editOverdueRemark);
router.post("/overdue-remark/delete", protect, deleteOverdueRemark);
router.post("/overdue-remark/undo-delete", protect, undoDeleteOverdueRemark);
router.post("/overdue-remark/pin", protect, pinOverdueRemark);
router.post("/overdue-remark/read-receipt", protect, markOverdueRemarkRead);
router.get("/overdue-remark/message-info", protect, getMessageInfo);
router.get("/overdue-remark/edit-history", protect, getEditHistory);

module.exports = router;
