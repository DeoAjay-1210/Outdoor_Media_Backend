const cron = require("node-cron");
const OverDueHistory = require("../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const MediaOnboarding = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { sendPushNotificationToRoles } = require("./fcmService");
const { nowIST } = require("./updatedAt");

/**
 * Scan Overdue History records and send push notifications for un-notified overdue items
 */
async function runOverduePushNotificationScheduler() {
  try {
    const now = nowIST();
    console.log(`⏰ [OverdueScheduler] Running overdue checks at ${now.toISOString()}`);

    // Find overdue records where due date has passed or remarks exist, and FCM push notification hasn't been sent in the last 24h
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const overdueRecords = await OverDueHistory.find({
      $or: [
        { fcmNotifiedAt: { $exists: false } },
        { fcmNotifiedAt: null },
        { fcmNotifiedAt: { $lt: twentyFourHoursAgo } },
      ],
      "overDueRemarks.0": { $exists: true },
    })
      .limit(50)
      .lean();

    if (overdueRecords.length === 0) {
      console.log("⏰ [OverdueScheduler] No pending overdue items require notification.");
      return { processed: 0 };
    }

    let notifiedCount = 0;

    for (const record of overdueRecords) {
      if (!record.overDueRemarks || record.overDueRemarks.length === 0) continue;

      const latestRemark = record.overDueRemarks[record.overDueRemarks.length - 1];
      if (!latestRemark || latestRemark.isDeleted) continue;

      const media = await MediaOnboarding.findById(record.mediaId).lean();
      const siteCode = media?.mediaCode || "SITE";
      const siteName = media?.mediaName || "Site";

      const senderRole = Number(latestRemark.role || latestRemark.userType || 1);
      const targetRoles = [1, 2, 3].filter((r) => r !== senderRole);

      const title = `Overdue Remark Reminder (${siteCode})`;
      const body = `Pending overdue remark for ${siteName}: "${latestRemark.remarks || "Attachment"}"`;

      const result = await sendPushNotificationToRoles({
        targetRoles,
        excludeUserId: latestRemark.addedByUserId,
        title,
        body,
        data: {
          notificationType: "overdueRemark",
          mediaId: String(record.mediaId || ""),
          rentalDueId: String(record.rentalDueId || ""),
          remarkId: String(latestRemark._id || ""),
          dueMonth: String(record.dueMonth || ""),
          siteCode,
          siteName,
        },
      });

      if (result.success) {
        await OverDueHistory.updateOne(
          { _id: record._id },
          { $set: { fcmNotifiedAt: now } }
        );
        notifiedCount++;
      }
    }

    console.log(`⏰ [OverdueScheduler] Processed ${notifiedCount} overdue notification(s).`);
    return { processed: notifiedCount };
  } catch (err) {
    console.error("❌ [OverdueScheduler] Error during scheduled check:", err.message);
    return { error: err.message };
  }
}

/**
 * Start CRON schedule for overdue notifications (Runs daily at 09:00 AM IST or configurable via env)
 */
function startOverdueScheduler() {
  const cronSchedule = process.env.OVERDUE_NOTIFICATION_CRON || "0 9 * * *";
  cron.schedule(cronSchedule, async () => {
    await runOverduePushNotificationScheduler();
  });
  console.log(`✅ [OverdueScheduler] Scheduled with pattern: "${cronSchedule}"`);
}

module.exports = {
  runOverduePushNotificationScheduler,
  startOverdueScheduler,
};
