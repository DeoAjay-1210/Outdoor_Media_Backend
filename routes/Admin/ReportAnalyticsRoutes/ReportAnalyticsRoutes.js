const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const C = require("../../../controllers/Admin/ReportAnalyticsController/ReportAnalyticsController");

// Read-only analytics. Role check (1-4) is enforced inside each handler.
router.post("/report-analytics/filters", protect, C.getFilterOptions);
router.post("/report-analytics/payments", protect, C.getPaymentAnalytics);
router.post("/report-analytics/media", protect, C.getMediaAnalytics);
router.post("/report-analytics/appraisal", protect, C.getAppraisalAnalytics);
router.post("/report-analytics/upcoming-bills", protect, C.getBillAnalytics);
router.post("/report-analytics/gst", protect, C.getGstAnalytics);
router.post("/report-analytics/tds", protect, C.getTdsAnalytics);
router.post("/report-analytics/agreements", protect, C.getAgreementAnalytics);
router.post("/report-analytics/tds-status", protect, C.getTdsStatusAnalytics);

module.exports = router;
