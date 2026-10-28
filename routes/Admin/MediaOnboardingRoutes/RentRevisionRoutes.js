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
router.post("/rent-revision/approve", protect, approveRentRevision);
router.get("/rent-revision-list", protect, getRentRevisionList);
router.post("/rent-revision-list", protect, getRentRevisionList);

module.exports = router;
