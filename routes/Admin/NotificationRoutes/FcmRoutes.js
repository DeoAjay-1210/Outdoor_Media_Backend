const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const FcmController = require("../../../controllers/Admin/NotificationController/FcmController");

// FCM Token Management Routes
router.post("/fcm/token", protect, FcmController.saveFcmToken);
router.post("/fcm/remove-token", protect, FcmController.removeFcmToken);

module.exports = router;
