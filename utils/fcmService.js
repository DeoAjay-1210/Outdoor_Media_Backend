const { getMessaging } = require("../config/firebase");
const User = require("../models/Admin/UserSchema/UserSchema");

/**
 * Remove invalid/unregistered FCM tokens from User schema
 */
async function cleanInvalidTokens(tokensToRemove) {
  if (!tokensToRemove || tokensToRemove.length === 0) return;
  try {
    await User.updateMany(
      { "fcmTokens.token": { $in: tokensToRemove } },
      { $pull: { fcmTokens: { token: { $in: tokensToRemove } } } }
    );
    console.log(`🧹 [FCM] Cleaned ${tokensToRemove.length} stale/invalid token(s).`);
  } catch (err) {
    console.error("❌ [FCM] Error cleaning invalid tokens:", err.message);
  }
}

/**
 * Send Multicast Push Notification to specific target user roles
 */
async function sendPushNotificationToRoles({
  targetRoles = [],
  excludeUserId = null,
  title = "Overdue Remark in Chat",
  body = "A new remark was added.",
  data = {},
}) {
  const messaging = getMessaging();
  if (!messaging) {
    console.warn("⚠️ [FCM] Messaging service not initialized. Skipping push notification.");
    return { success: false, reason: "Firebase not initialized" };
  }

  try {
    const query = {
      userType: { $in: targetRoles },
      "fcmTokens.0": { $exists: true },
    };

    if (excludeUserId) {
      query._id = { $ne: excludeUserId };
    }

    const users = await User.find(query, "fcmTokens _id userName userType").lean();

    const tokenList = [];
    users.forEach((u) => {
      if (Array.isArray(u.fcmTokens)) {
        u.fcmTokens.forEach((t) => {
          if (t && t.token) {
            tokenList.push(t.token);
          }
        });
      }
    });

    // Deduplicate tokens to ensure each unique device/token receives notification exactly once
    const uniqueTokens = Array.from(new Set(tokenList));

    if (uniqueTokens.length === 0) {
      return { success: true, deliveredCount: 0, reason: "No active FCM tokens found for target roles" };
    }

    // Convert data values to strings as required by FCM
    const stringifiedData = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value !== undefined && value !== null) {
        stringifiedData[key] = String(value);
      }
    }

    const messagePayload = {
      tokens: uniqueTokens,
      notification: {
        title: title || "Overdue Remark in Chat",
        body: body || "A remark added by another user requires your attention.",
      },
      data: stringifiedData,
      android: {
        priority: "high",
        notification: {
          sound: "default",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
          },
        },
      },
      webpush: {
        headers: {
          Urgency: "high",
        },
        notification: {
          title: title || "Overdue Remark in Chat",
          body: body || "A remark added by another user requires your attention.",
          icon: "/assets/images/favicon.png",
        },
      },
    };

    const response = await messaging.sendEachForMulticast(messagePayload);

    const invalidTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const errorCode = resp.error?.code;
        if (
          errorCode === "messaging/invalid-registration-token" ||
          errorCode === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(uniqueTokens[idx]);
        }
      }
    });

    if (invalidTokens.length > 0) {
      cleanInvalidTokens(invalidTokens);
    }

    console.log(
      `📱 [FCM] Push sent: ${response.successCount} succeeded, ${response.failureCount} failed out of ${uniqueTokens.length} devices.`
    );

    return {
      success: true,
      deliveredCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error("❌ [FCM] Error sending multicast push notification:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Overdue Remark Notification Helper
 */
async function sendOverdueRemarkPushNotification({
  media,
  dueMonth,
  rentalDueId,
  mediaDetailId,
  remark,
  senderName,
  senderRoleName,
  senderUserId,
  targetRoles,
  siteCode,
  siteName,
  remarkId,
}) {
  const shortRemark =
    remark && remark.length > 80 ? `${remark.substring(0, 80)}...` : remark || "Attachment added";

  const title = `Overdue Remark in Chat (${siteCode || "Site"})`;
  const body = `${senderRoleName || "User"} ${senderName || ""}: "${shortRemark}"`;

  const payloadData = {
    notificationType: "overdueRemark",
    chatId: String(media?._id || ""),
    mediaId: String(media?._id || ""),
    rentalDueId: String(rentalDueId || ""),
    mediaDetailId: String(mediaDetailId || ""),
    remarkId: String(remarkId || ""),
    dueMonth: String(dueMonth || ""),
    siteCode: String(siteCode || ""),
    siteName: String(siteName || ""),
  };

  return sendPushNotificationToRoles({
    targetRoles: targetRoles || [1, 2, 3],
    excludeUserId: senderUserId,
    title,
    body,
    data: payloadData,
  });
}

/**
 * Rental Approval Push Notification Helper
 */
async function sendApprovalPushNotification({
  media,
  entry,
  userType,
  userId,
  userName,
  targetRole,
  siteCode,
  siteName,
  dueMonth,
}) {
  const roleLabel = Number(userType) === 3 ? "CMD" : (Number(userType) === 2 ? "Rental Manager" : "Rental Executive");
  const title = `Rental Approval (${siteCode || "Site"})`;
  const body = `${roleLabel} ${userName || ""} approved rental due${dueMonth ? ` for ${dueMonth}` : ""}`
    .replace(/\s+/g, " ")
    .trim();

  const payloadData = {
    notificationType: "normalApproval",
    mediaId: String(media?._id || ""),
    rentalDueId: String(entry?._id || ""),
    mediaDetailId: String(entry?.mediaDetailId || ""),
    dueMonth: String(dueMonth || ""),
    siteCode: String(siteCode || ""),
    siteName: String(siteName || ""),
  };

  return sendPushNotificationToRoles({
    targetRoles: [Number(targetRole)],
    excludeUserId: userId,
    title,
    body,
    data: payloadData,
  });
}

/**
 * Approval Reminder Push Notification Helper
 */
async function sendReminderPushNotification({
  media,
  dueMonth,
  rentalDueId,
  mediaDetailId,
  role,
  userName,
  userId,
  siteCode,
  siteName,
}) {
  const roleLabel = Number(role) === 2 ? "Rental Manager" : "Rental Executive";
  const title = `Approval Reminder (${siteCode || "Site"})`;
  const body = `Reminder: ${roleLabel} ${userName || ""} requested approval${dueMonth ? ` for ${dueMonth}` : ""}`
    .replace(/\s+/g, " ")
    .trim();

  const payloadData = {
    notificationType: "reminder",
    mediaId: String(media?._id || ""),
    rentalDueId: String(rentalDueId || ""),
    mediaDetailId: String(mediaDetailId || ""),
    dueMonth: String(dueMonth || ""),
    siteCode: String(siteCode || ""),
    siteName: String(siteName || ""),
  };

  return sendPushNotificationToRoles({
    targetRoles: [3], // CMD role
    excludeUserId: userId,
    title,
    body,
    data: payloadData,
  });
}

module.exports = {
  sendPushNotificationToRoles,
  sendOverdueRemarkPushNotification,
  sendApprovalPushNotification,
  sendReminderPushNotification,
  cleanInvalidTokens,
};
