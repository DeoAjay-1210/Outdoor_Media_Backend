const express = require("express");
const router = express.Router();
const {
  getCmdNotifications,
  getCmdNotificationCount,
  markCmdNotificationRead,
  markAllCmdNotificationsRead,
  sendCmdReminder,
} = require("../../../controllers/Admin/NotificationController/CmdNotificationController");
const protect = require("../../../middleware/authMiddleware");

// CMD (userType 3) only — site-wise approval notifications from
// Rental Executive / Rental Manager approvals
router.post("/cmd-notifications", protect, getCmdNotifications);
router.get("/cmd-notifications", protect, getCmdNotifications);
router.get("/cmd-notifications/count", protect, getCmdNotificationCount);
router.post("/cmd-notifications/read", protect, markCmdNotificationRead);
router.post("/cmd-notifications/read-all", protect, markAllCmdNotificationsRead);

// Rental Executive (1) / Rental Manager (2) — remind CMD to approve a site
router.post("/cmd-notifications/reminder", protect, sendCmdReminder);

module.exports = router;
