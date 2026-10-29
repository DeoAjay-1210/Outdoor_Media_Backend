const { getMessaging } = require("../config/firebase");
const mongoose = require("mongoose");
const User = require("../models/Admin/UserSchema/UserSchema");

const toObjectId = (id) =>
  id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;

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
 * Format sender title cleanly without duplicating role names (e.g. "Rental Manager Manager")
 */
function formatSenderTitle(roleLbl, name) {
  if (!name) return roleLbl;
  const lName = name.trim().toLowerCase();
  const lRole = roleLbl.trim().toLowerCase();
  if (lName === lRole || (lRole.includes('manager') && lName === 'manager') || (lRole.includes('executive') && lName === 'executive')) {
    return roleLbl;
  }
  if (lName.includes(lRole) || lRole.includes(lName)) {
    return roleLbl.length >= name.length ? roleLbl : name;
  }
  return `${roleLbl} ${name}`;
}

/**
 * ✅ NEW — .env switch for Firebase push notifications:
 *   FIREBASE_PUSH_NOTIFICATION=on   → sent (also 1 / true / yes)
 *   FIREBASE_PUSH_NOTIFICATION=off  → NOT sent (also 0 / false / no)
 * Not set → on (same as before). Read on every send, so a restart after
 * editing .env is enough.
 */
function isPushNotificationEnabled() {
  const v = String(process.env.FIREBASE_PUSH_NOTIFICATION ?? "on").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
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
  // ✅ NEW — switched off in .env → nothing is sent (every push goes through here)
  if (!isPushNotificationEnabled()) {
    return { success: false, reason: "Push notifications are turned off (FIREBASE_PUSH_NOTIFICATION=off)" };
  }
  const messaging = getMessaging();
  if (!messaging) {
    console.warn("⚠️ [FCM] Messaging service not initialized. Skipping push notification.");
    return { success: false, reason: "Firebase not initialized" };
  }

  try {
    const numericTargetRoles = (targetRoles || []).map(Number).filter((r) => !isNaN(r));
    const query = {
      userType: { $in: numericTargetRoles },
      "fcmTokens.0": { $exists: true },
    };

    if (excludeUserId) {
      const objId = toObjectId(excludeUserId);
      if (objId) {
        query._id = { $ne: objId };
      }
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
      console.log(`📱 [FCM] No active FCM tokens found for target roles: ${JSON.stringify(numericTargetRoles)}`);
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
          icon: "/favicon.png",
          data: stringifiedData,
        },
        data: stringifiedData,
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

function buildClickUrl({
  landOwnerMasterId,
  mediaId,
  dueMonth,
  siteCode,
  siteName,
  rentalDueId,
  remarkId,
  notificationType,
}) {
  const query = new URLSearchParams();
  if (landOwnerMasterId) query.append("landOwnerMasterId", landOwnerMasterId);
  if (mediaId) query.append("mediaId", mediaId);
  if (dueMonth) query.append("dueMonth", dueMonth);
  if (siteCode) {
    query.append("mediaCode", siteCode);
    query.append("search", siteCode);
  }
  const isApprovalOrReminder = notificationType === "normalApproval" || notificationType === "reminder";
  if (isApprovalOrReminder) {
    query.append("openApproval", "1");
  } else {
    query.append("openChat", "1");
  }
  if (rentalDueId) query.append("rentalDueId", rentalDueId);
  if (remarkId) query.append("remarkId", remarkId);
  if (siteName) query.append("siteName", siteName);

  return `/rental-master?${query.toString()}`;
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

  const resolvedMediaCode = (siteCode && siteCode !== "SITE" ? siteCode : null) ||
                            media?.mediaCode ||
                            media?.mediaDetails?.[0]?.mediaCode ||
                            media?._id?.toString() ||
                            "SITE";

  const resolvedMediaName = (siteName && siteName !== "Site" ? siteName : null) ||
                            media?.mediaName ||
                            media?.mediaDetails?.[0]?.mediaName ||
                            "Site";

  const title = `Overdue Remark in Chat (${resolvedMediaCode})`;
  const senderFormatted = formatSenderTitle(senderRoleName || "User", senderName);
  const body = `${senderFormatted}: "${shortRemark}"`;

  const landOwnerMasterId = String(
    media?.landOwners?.[0]?.landOwnerMasterId ||
    media?.landOwners?.[0]?._id ||
    ""
  );

  const rawPayload = {
    notificationType: "overdueRemark",
    chatId: String(media?._id || ""),
    mediaId: String(media?._id || ""),
    rentalDueId: String(rentalDueId || ""),
    mediaDetailId: String(mediaDetailId || ""),
    remarkId: String(remarkId || ""),
    dueMonth: String(dueMonth || ""),
    siteCode: String(resolvedMediaCode),
    siteName: String(resolvedMediaName),
    mediaName: String(resolvedMediaName),
    mediaCode: String(resolvedMediaCode),
    landOwnerMasterId: landOwnerMasterId,
    landlordId: landOwnerMasterId,
  };

  const clickUrl = buildClickUrl(rawPayload);

  const payloadData = {
    ...rawPayload,
    clickUrl,
    url: clickUrl,
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

  const resolvedMediaCode = (siteCode && siteCode !== "SITE" ? siteCode : null) ||
                            media?.mediaCode ||
                            media?.mediaDetails?.[0]?.mediaCode ||
                            media?._id?.toString() ||
                            "SITE";

  const resolvedMediaName = (siteName && siteName !== "Site" ? siteName : null) ||
                            media?.mediaName ||
                            media?.mediaDetails?.[0]?.mediaName ||
                            "Site";

  const title = `Rental Approval (${resolvedMediaCode})`;
  const senderFormatted = formatSenderTitle(roleLabel, userName);
  const body = `${senderFormatted} approved rental due${dueMonth ? ` for ${dueMonth}` : ""}`
    .replace(/\s+/g, " ")
    .trim();

  const landOwnerMasterId = String(
    media?.landOwners?.[0]?.landOwnerMasterId ||
    media?.landOwners?.[0]?._id ||
    ""
  );

  const rawPayload = {
    notificationType: "normalApproval",
    mediaId: String(media?._id || ""),
    rentalDueId: String(entry?._id || ""),
    mediaDetailId: String(entry?.mediaDetailId || ""),
    dueMonth: String(dueMonth || ""),
    siteCode: String(resolvedMediaCode),
    siteName: String(resolvedMediaName),
    mediaName: String(resolvedMediaName),
    mediaCode: String(resolvedMediaCode),
    landOwnerMasterId: landOwnerMasterId,
    landlordId: landOwnerMasterId,
  };

  const clickUrl = buildClickUrl(rawPayload);

  const payloadData = {
    ...rawPayload,
    clickUrl,
    url: clickUrl,
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

  const resolvedMediaCode = (siteCode && siteCode !== "SITE" ? siteCode : null) ||
                            media?.mediaCode ||
                            media?.mediaDetails?.[0]?.mediaCode ||
                            media?._id?.toString() ||
                            "SITE";

  const resolvedMediaName = (siteName && siteName !== "Site" ? siteName : null) ||
                            media?.mediaName ||
                            media?.mediaDetails?.[0]?.mediaName ||
                            "Site";

  const title = `Approval Reminder (${resolvedMediaCode})`;
  const senderFormatted = formatSenderTitle(roleLabel, userName);
  const body = `Reminder: ${senderFormatted} requested approval${dueMonth ? ` for ${dueMonth}` : ""}`
    .replace(/\s+/g, " ")
    .trim();

  const landOwnerMasterId = String(
    media?.landOwners?.[0]?.landOwnerMasterId ||
    media?.landOwners?.[0]?._id ||
    ""
  );

  const rawPayload = {
    notificationType: "reminder",
    mediaId: String(media?._id || ""),
    rentalDueId: String(rentalDueId || ""),
    mediaDetailId: String(mediaDetailId || ""),
    dueMonth: String(dueMonth || ""),
    siteCode: String(resolvedMediaCode),
    siteName: String(resolvedMediaName),
    mediaName: String(resolvedMediaName),
    mediaCode: String(resolvedMediaCode),
    landOwnerMasterId: landOwnerMasterId,
    landlordId: landOwnerMasterId,
  };

  const clickUrl = buildClickUrl(rawPayload);

  const payloadData = {
    ...rawPayload,
    clickUrl,
    url: clickUrl,
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
