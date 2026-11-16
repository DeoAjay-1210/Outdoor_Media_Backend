const express = require("express");
const router = express.Router();
const {
  createBillingDateRevertRequest,
  approveBillingDateRevertRequest,
  rejectBillingDateRevertRequest,
  getBillingDateRevertRequests,
  adminBillingDateRevert, // ✅ NEW
  getAdminBillingDateReverts, // ✅ NEW
} = require("../../../controllers/Admin/MediaOnboardingController/BillingDateRevertController");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");
const { errorResponse } = require("../../../utils/response");

// Create uploader for billing date revert proof images
const { upload, processFile } = createUploader("billingDateRevert");

// single "image" file; multer errors (wrong field, too large) → 400 JSON
const uploadRevertImage = (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) return errorResponse(res, err.message, null, 400);
    req.processFile = processFile;
    next();
  });
};

// Rental Executive (1) / Rental Manager (2) — raise a request (multipart)
router.post("/billing-date-revert/request", protect, uploadRevertImage, createBillingDateRevertRequest);

// CMD (3) — approve / reject
router.post("/billing-date-revert/approve", protect, approveBillingDateRevertRequest);
router.post("/billing-date-revert/reject", protect, rejectBillingDateRevertRequest);

// Rental Executive / Rental Manager / CMD — view
router.post("/billing-date-revert/list", protect, getBillingDateRevertRequests);
router.get("/billing-date-revert/list", protect, getBillingDateRevertRequests);

// ✅ NEW — Admin (6): single call, direct revert by mediaId (no CMD approval)
router.post("/billing-date-revert/admin", protect, adminBillingDateRevert);
// ✅ NEW — Admin (6): list of admin reverts (pageNumber, count, mediaId)
router.post("/billing-date-revert/admin/list", protect, getAdminBillingDateReverts);
router.get("/billing-date-revert/admin/list", protect, getAdminBillingDateReverts);

module.exports = router;
