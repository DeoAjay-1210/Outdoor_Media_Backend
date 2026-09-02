const express = require("express");
const router = express.Router();
const { downloadRentalOOHExcel } = require("../../../controllers/Admin/MediaOnboardingController/RentalOOHExcelController");
const protect = require("../../../middleware/authMiddleware");

// GET /admin/rental-ooh/download-excel?fromMonth=08-2026&toMonth=10-2027
router.get("/rental-ooh/download-excel", protect, downloadRentalOOHExcel);

module.exports = router;
