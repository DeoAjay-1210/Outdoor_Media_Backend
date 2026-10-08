const express = require("express");
const router = express.Router();
const { downloadRentalOOHExcel } = require("../../../controllers/Admin/MediaOnboardingController/RentalOOHExcelController");
const { downloadApprovedSitesExcel } = require("../../../controllers/Admin/MediaOnboardingController/ApprovedSitesExcelController");
const protect = require("../../../middleware/authMiddleware");

// GET /admin/rental-ooh/download-excel?fromMonth=08-2026&toMonth=10-2027
router.get("/rental-ooh/download-excel", protect, downloadRentalOOHExcel);

// GET /admin/rental-ooh/download-approved-sites-excel?fromDate=2026-09-01&toDate=2026-10-07&role=3
// role: 1=Rental Executive  2=Rental Manager  3=CMD
router.get("/rental-ooh/download-approved-sites-excel", protect, downloadApprovedSitesExcel);

module.exports = router;
