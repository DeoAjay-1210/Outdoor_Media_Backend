const express = require("express");
const router = express.Router();
const { getAppVersion } = require("../../../controllers/Admin/AppUpdateController/AppUpdateController");

// Custom APK update — public (release metadata only, no user data)
router.get("/app-update/version", getAppVersion);

module.exports = router;
