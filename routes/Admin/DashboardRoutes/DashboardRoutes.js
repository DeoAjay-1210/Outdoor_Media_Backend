const express = require("express");
const router = express.Router();
const { getAdminDashboard } = require("../../../controllers/Admin/DashboardController/DashboardController");
const protect = require("../../../middleware/authMiddleware");

// POST /admin/dashboard - Fetch full dashboard analytics with filters
router.post("/dashboard", protect, getAdminDashboard);

// GET /admin/dashboard - Fetch full dashboard analytics with filters
router.get("/dashboard", protect, getAdminDashboard);

module.exports = router;
