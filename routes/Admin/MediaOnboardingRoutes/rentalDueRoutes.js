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
// ✅ NEW — appraisal hold APIs (own controller)
const {
  setAppraisalHold,
  getAppraisalHoldRemarks,
} = require("../../../controllers/Admin/MediaOnboardingController/AppraisalHoldController");
// ✅ NEW — TDS hold API (own controller)
const { setTdsHold, getTdsHoldRemarks } = require("../../../controllers/Admin/MediaOnboardingController/TdsHoldController");
// ✅ NEW — rental due "Save as Draft" (own controller)
const { saveRentalDueDraft } = require("../../../controllers/Admin/MediaOnboardingController/RentalDueDraftController");
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

// ✅ NEW — Save as Draft: same body / files as /rental-due-save, stored as the
// bill's draft only (no approval, no status change, no notification / mail)
router.post(
  "/rental-due-save-draft",
  protect,
  upload.any(),
  (req, res, next) => {
    req.processFile = processFile;
    next();
  },
  saveRentalDueDraft,
);

// ✅ NEW — campaignName / reason / proofOfCampaign / invoice change history (body: mediaId, pageNumber, count)
router.post("/rental-due-history", protect, getRentalDueHistory);
router.post("/verify-agreement", protect, verifyAgreementDoc);
router.post("/gst-paid",protect, GstAmountPaid);
router.post("/revert-Agreement",protect, revertAgreementDocVerification);
router.post("/revert-Approval",protect, revertRentalApproval);
router.post("/overdue-history-list", protect, getOverDueHistoryList);
router.get("/overdue-remarks", protect, getOverDueRemarks);
// ✅ NEW — CMD only: hold / release this month's appraisal amount on one bill
// body: { mediaId, rentalDueId, appraisalHold: 1 | 0, remark }
router.post("/appraisal-hold", protect, setAppraisalHold);
// ✅ NEW — read only (any role): a site's appraisal holds + remarks
// ?mediaId=...&rentalDueId=... (rentalDueId optional)
router.get("/appraisal-hold-remarks", protect, getAppraisalHoldRemarks);
// ✅ NEW — CMD only: hold / release a landowner's TDS on a site
// body: { mediaId, landOwnerId, tdsHold: 1 | 0, remark } or { entries: [...] }
router.post("/tds-hold", protect, setTdsHold);
// ✅ NEW — read only (any role): a site's TDS holds + remarks (separate API)
// ?mediaId=...&landOwnerId=... (landOwnerId optional)
router.get("/tds-hold-remarks", protect, getTdsHoldRemarks);
router.post("/overdue-remark", protect, overDueRemark);
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
