const express = require("express");
const router = express.Router();
const { getAdminDashboard, getDashboardV2, getRentalDetailsV2, getLedgerMismatchV2, getActivityV2, getDrillV2 } = require("../../../controllers/Admin/DashboardController/DashboardController");
const protect = require("../../../middleware/authMiddleware");

// POST /admin/dashboard - Fetch full dashboard analytics with filters
router.post("/dashboard", protect, getAdminDashboard);

// GET /admin/dashboard - Fetch full dashboard analytics with filters
router.get("/dashboard", protect, getAdminDashboard);

// Dashboard v2
router.post("/dashboard/v2", protect, getDashboardV2);
router.post("/dashboard/rental-details", protect, getRentalDetailsV2);
router.post("/dashboard/ledger-mismatch", protect, getLedgerMismatchV2);
router.post("/dashboard/activity", protect, getActivityV2);
router.post("/dashboard/drill", protect, getDrillV2);

module.exports = router;
