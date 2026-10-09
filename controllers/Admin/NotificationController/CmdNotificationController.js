const mongoose = require("mongoose");
const CmdNotification = require("../../../models/Admin/NotificationSchema/CmdNotificationSchema");
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

// userType values (same as UserSchema)
const USER_ROLE = { RENTAL_EXECUTIVE: 1, RENTAL_MANAGER: 2, CMD: 3 };
const APPROVER_ROLE_LABEL = {
  [USER_ROLE.RENTAL_EXECUTIVE]: "Rental Executive",
  [USER_ROLE.RENTAL_MANAGER]: "Rental Manager",
};

const toObjectId = (id) =>
  id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;

// unread for THIS CMD user
const unreadFilterFor = (userObjectId) => ({
  targetRole: USER_ROLE.CMD,
  "readBy.userId": { $ne: userObjectId },
});

// notificationType filters (rows created before the flag existed have no
// notificationType → treated as "normalApproval")
const NOTIFICATION_TYPE = {
  NORMAL_APPROVAL: "normalApproval",
  REMINDER: "reminder",
  BILLING_DATE_REVERT: "billingDateRevert",
};
const normalApprovalFilter = {
  notificationType: { $nin: [NOTIFICATION_TYPE.REMINDER, NOTIFICATION_TYPE.BILLING_DATE_REVERT] },
};
const reminderFilter = { notificationType: NOTIFICATION_TYPE.REMINDER };
const billingDateRevertFilter = { notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT };

// unread counts for THIS CMD user: overall + split by who approved
// (each site has one Executive row and one Manager row, counted separately)
// + split by notification type (normal approval vs reminder)
const getUnreadCounts = async (userObjectId) => {
  const unread = unreadFilterFor(userObjectId);
  const [
    overallCount,
    rentalExecutiveApprovalCount,
    rentalManagerApprovalCount,
    normalApprovalCount,
    reminderCount,
    billingDateRevertCount,
  ] = await Promise.all([
    CmdNotification.countDocuments(unread),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter, approvedByRole: USER_ROLE.RENTAL_EXECUTIVE }),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter, approvedByRole: USER_ROLE.RENTAL_MANAGER }),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter }),
    CmdNotification.countDocuments({ ...unread, ...reminderFilter }),
    CmdNotification.countDocuments({ ...unread, ...billingDateRevertFilter }),
  ]);
  return {
    overallCount,
    rentalExecutiveApprovalCount,
    rentalManagerApprovalCount,
    normalApprovalCount,
    reminderCount,
    billingDateRevertCount,
  };
};

const ensureCmd = (req, res) => {
  if (Number(req.user?.userType) !== USER_ROLE.CMD) {
    errorResponse(res, "Only CMD can access notifications", null, 403);
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────
// INTERNAL — called from RentalDueNew2Controller after a successful,
// already-saved Rental Executive / Rental Manager approval.
// Never throws: a notification failure must not affect the approval.
// ─────────────────────────────────────────────────────────────
async function createRentalApprovalNotification({ media, entry, userType, userId, userName }) {
  try {
    const role = Number(userType);
    if (!media || !entry || !APPROVER_ROLE_LABEL[role]) return null;

    const step = (entry.approvalSteps || []).find((s) => s.role === role && s.status === 2);
    if (!step) return null; // this role did not approve — nothing to notify
    const approvedAt = step.approvedAt ? new Date(step.approvedAt) : nowIST();

    const owners = media.landOwners || [];
    const landOwnerName = owners.map((o) => o.name).filter(Boolean).join(", ");
    const landOwnerMasterIds = owners.map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean);

    const roleLabel = APPROVER_ROLE_LABEL[role];
    const dueMonth = entry.dueMonth || "";
    const message = `${roleLabel} ${userName || ""} approved rental due${dueMonth ? ` for ${dueMonth}` : ""}`
      .replace(/\s+/g, " ")
      .trim();

    // site-wise (mediaId): faces covered by this notification. A site-level
    // rental due (no mediaDetailId) covers every active face of the site.
    const details = media.mediaDetails || [];
    const activeFaceIds = details.filter((d) => Number(d.status) === 1).map((d) => String(d._id));
    const entryFaceIds = entry.mediaDetailId ? [String(entry.mediaDetailId)] : activeFaceIds;
    const buildSiteLabels = (faceIdList) => {
      const faces = details.filter((d) => faceIdList.includes(String(d._id)));
      return {
        mediaDetailIds: faceIdList.map(toObjectId).filter(Boolean),
        siteName: faces.map((d) => d.mediaName).filter(Boolean).join(", ") || media.mediaName || "",
        siteCode: faces.map((d) => d.mediaCode).filter(Boolean).join(" / ") || media.mediaCode || "",
      };
    };

    // ONE notification per site (mediaId) per month PER ROLE: the Rental
    // Executive's and the Rental Manager's approvals are two separate rows;
    // every face of the site merges into its role's row, never duplicates.
    const dedupeKey = `media:${String(media._id)}:${dueMonth}:role:${role}`;
    const latestFields = {
      mediaId: media._id,
      mediaDetailId: toObjectId(entry.mediaDetailId),
      rentalDueId: entry._id,
      dueMonth,
      landOwnerName,
      landOwnerMasterIds,
      message,
      approvedByRole: role,
      approvedByUserId: toObjectId(userId),
      approvedByName: userName || "",
      approvedAt,
    };

    const existing = await CmdNotification.findOne({ mediaId: media._id, dueMonth, approvedByRole: role })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (existing) {
      const knownFaceIds = (existing.mediaDetailIds || []).map(String);
      if (knownFaceIds.length === 0 && existing.mediaDetailId) knownFaceIds.push(String(existing.mediaDetailId));
      const hasNewFace = entryFaceIds.some((id) => !knownFaceIds.includes(id));
      const isNewerApproval =
        !existing.approvedAt || approvedAt.getTime() > new Date(existing.approvedAt).getTime();

      // same (or an older) approval for a face already covered → already
      // notified, keep read status
      if (!isNewerApproval && !hasNewFace) return existing.dedupeKey;

      // keep one record per site/month/role: drop any older duplicates first
      await CmdNotification.deleteMany({
        mediaId: media._id,
        dueMonth,
        approvedByRole: role,
        _id: { $ne: existing._id },
      });

      const mergedFaceIds = [...new Set([...knownFaceIds, ...entryFaceIds])];
      await CmdNotification.updateOne(
        { _id: existing._id },
        {
          $set: {
            // a newer approval becomes the latest; an older one for a new face
            // only adds that face to the site
            ...(isNewerApproval ? latestFields : {}),
            ...buildSiteLabels(mergedFaceIds),
            readBy: [], // new approval on this site → unread again for CMD
            dedupeKey,
            updatedAt: nowIST(),
          },
        },
      );
      return dedupeKey;
    }

    const now = nowIST();
    await CmdNotification.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          targetRole: USER_ROLE.CMD,
          notificationType: NOTIFICATION_TYPE.NORMAL_APPROVAL,
          ...latestFields,
          ...buildSiteLabels(entryFaceIds),
          readBy: [],
          dedupeKey,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return dedupeKey;
  } catch (err) {
    // E11000 = same approval processed concurrently — already notified
    if (err?.code !== 11000) {
      console.error("[CmdNotification] create failed:", err.message);
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL — called from BillingDateRevertController after a revert
// request is saved. ONE row per request (dedupeKey). Never throws: a
// notification failure must not affect the saved request.
// ─────────────────────────────────────────────────────────────
async function createBillingDateRevertNotification({ request }) {
  try {
    if (!request?._id) return null;
    const role = Number(request.requestedBy?.role);
    const roleLabel = APPROVER_ROLE_LABEL[role] || "";
    const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");
    const message =
      `${roleLabel} ${request.requestedBy?.userName || ""} requested billing date revert` +
      ` (${fmt(request.originalDates?.lastBillPaidDate)} → ${fmt(request.requestedDates?.lastBillPaidDate)})`;
    const now = nowIST();
    const dedupeKey = `billingDateRevert:${String(request._id)}`;

    const doc = await CmdNotification.findOneAndUpdate(
      { dedupeKey },
      {
        $setOnInsert: {
          targetRole: USER_ROLE.CMD,
          notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT,
          mediaId: request.mediaId,
          mediaDetailIds: (request.siteDetails || []).map((f) => toObjectId(f.mediaDetailId)).filter(Boolean),
          dueMonth: "",
          landOwnerName: request.landOwnerName || "",
          siteName: request.siteName || "",
          siteCode: request.siteCode || "",
          message: message.replace(/\s+/g, " ").trim(),
          remarks: request.remark || "",
          billingDateRevertRequestId: request._id,
          revertStatus: request.status,
          currentLastBillPaidDate: request.originalDates?.lastBillPaidDate || null,
          currentNextBillingDate: request.originalDates?.nextBillingDate || null,
          requestedLastBillPaidDate: request.requestedDates?.lastBillPaidDate || null,
          requestedNextBillingDate: request.requestedDates?.nextBillingDate || null,
          requestedBy: request.requestedBy?.userName || "",
          requestedByRole: APPROVER_ROLE_LABEL[role] ? role : null,
          requestedByUserId: toObjectId(request.requestedBy?.userId),
          requestedAt: request.createdAt || now,
          imagePath: request.image?.filePath || "",
          readBy: [],
          dedupeKey,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    ).lean();
    return doc?._id || null;
  } catch (err) {
    if (err?.code !== 11000) {
      console.error("[CmdNotification] billing date revert create failed:", err.message);
    }
    return null;
  }
}

// Keeps the notification row's revertStatus in sync with the request.
// Never throws.
async function updateBillingDateRevertNotificationStatus(requestId, revertStatus) {
  try {
    await CmdNotification.updateOne(
      { dedupeKey: `billingDateRevert:${String(requestId)}` },
      { $set: { revertStatus, updatedAt: nowIST() } },
    );
  } catch (err) {
    console.error("[CmdNotification] billing date revert status update failed:", err.message);
  }
}

const formatNotification = (n, userObjectId) => ({
  notificationId: n._id,
  notificationType: n.notificationType || NOTIFICATION_TYPE.NORMAL_APPROVAL,
  // reminder rows only
  ...(n.notificationType === NOTIFICATION_TYPE.REMINDER
    ? {
        reminderCount: n.reminderCount || 0,
        remarks: n.remarks || "",
        lastRemindedBy: n.lastRemindedBy || "",
        lastRemindedByRole: n.lastRemindedByRole ?? null,
        lastRemindedAt: n.lastRemindedAt || null,
      }
    : {}),
  landOwnerMasterId: (n.landOwnerMasterIds || [])[0] || null, // first / single landowner
  landOwnerMasterIds: n.landOwnerMasterIds || [], // all landowners of the site
  landOwnerName: n.landOwnerName,
  siteName: n.siteName,
  siteCode: n.siteCode,
  message: n.message,
  dueMonth: n.dueMonth,
  // approval rows only (not applicable to reminders / billing date reverts)
  ...(n.notificationType !== NOTIFICATION_TYPE.REMINDER &&
  n.notificationType !== NOTIFICATION_TYPE.BILLING_DATE_REVERT
    ? { approvedByRole: n.approvedByRole, approvedByName: n.approvedByName, approvedAt: n.approvedAt }
    : {}),
  // billing date revert rows only
  ...(n.notificationType === NOTIFICATION_TYPE.BILLING_DATE_REVERT
    ? {
        billingDateRevertRequestId: n.billingDateRevertRequestId,
        revertStatus: n.revertStatus,
        currentLastBillPaidDate: n.currentLastBillPaidDate,
        currentNextBillingDate: n.currentNextBillingDate,
        requestedLastBillPaidDate: n.requestedLastBillPaidDate,
        requestedNextBillingDate: n.requestedNextBillingDate,
        remarks: n.remarks || "",
        imagePath: n.imagePath || "",
        requestedBy: n.requestedBy || "",
        requestedByRole: n.requestedByRole ?? null,
        requestedAt: n.requestedAt || null,
      }
    : {}),
  mediaId: n.mediaId,
  mediaDetailId: n.mediaDetailId,
  mediaDetailIds: n.mediaDetailIds && n.mediaDetailIds.length ? n.mediaDetailIds : (n.mediaDetailId ? [n.mediaDetailId] : []),
  rentalDueId: n.rentalDueId,
  isRead: (n.readBy || []).some((r) => String(r.userId) === String(userObjectId)),
  createdAt: n.createdAt,
  updatedAt: n.updatedAt || n.createdAt,
});

// ─────────────────────────────────────────────────────────────
// POST/GET /admin/cmd-notifications
// body/query: pageNumber, count, isRead (true/false — optional filter),
//             notificationType ("normalApproval" | "reminder" — optional filter)
// ─────────────────────────────────────────────────────────────
const getCmdNotifications = async (req, res) => {
  try {
    if (!ensureCmd(req, res)) return;
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const userObjectId = toObjectId(req.user.userId);

    const pageNumber = Math.max(parseInt(params.pageNumber) || 1, 1);
    const count = Math.max(parseInt(params.count) || 10, 1);

    const filter = { targetRole: USER_ROLE.CMD };
    if (params.isRead === true || params.isRead === "true") {
      filter["readBy.userId"] = userObjectId;
    } else if (params.isRead === false || params.isRead === "false") {
      filter["readBy.userId"] = { $ne: userObjectId };
    }
    // optional: "normalApproval" | "reminder" | "billingDateRevert"
    if (params.notificationType === NOTIFICATION_TYPE.REMINDER) {
      Object.assign(filter, reminderFilter);
    } else if (params.notificationType === NOTIFICATION_TYPE.NORMAL_APPROVAL) {
      Object.assign(filter, normalApprovalFilter);
    } else if (params.notificationType === NOTIFICATION_TYPE.BILLING_DATE_REVERT) {
      Object.assign(filter, billingDateRevertFilter);
    }

    const [totalCount, counts, rows] = await Promise.all([
      CmdNotification.countDocuments(filter),
      getUnreadCounts(userObjectId),
      CmdNotification.find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((pageNumber - 1) * count)
        .limit(count)
        .lean(),
    ]);

    return successResponse(res, "CMD notifications fetched successfully", {
      ...counts,
      pagination: {
        pageNumber,
        count,
        totalCount,
        totalPages: Math.ceil(totalCount / count),
      },
      notifications: rows.map((n) => formatNotification(n, userObjectId)),
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /admin/cmd-notifications/count — unread count for the bell badge
// ─────────────────────────────────────────────────────────────
const getCmdNotificationCount = async (req, res) => {
  try {
    if (!ensureCmd(req, res)) return;
    const counts = await getUnreadCounts(toObjectId(req.user.userId));
    return successResponse(res, "CMD notification count fetched successfully", counts);
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /admin/cmd-notifications/read
// body: { notificationId } or { notificationIds: [] }
// ─────────────────────────────────────────────────────────────
const markCmdNotificationRead = async (req, res) => {
  try {
    if (!ensureCmd(req, res)) return;
    const { notificationId, notificationIds } = req.body || {};
    const ids = (Array.isArray(notificationIds) ? notificationIds : [notificationId])
      .map(toObjectId)
      .filter(Boolean);
    if (ids.length === 0) {
      return errorResponse(res, "A valid notificationId or notificationIds[] is required", null, 400);
    }

    const userObjectId = toObjectId(req.user.userId);
    const result = await CmdNotification.updateMany(
      { _id: { $in: ids }, ...unreadFilterFor(userObjectId) },
      { $push: { readBy: { userId: userObjectId, readAt: nowIST() } } },
    );
    const counts = await getUnreadCounts(userObjectId);

    return successResponse(res, "Notification(s) marked as read", {
      updatedCount: result.modifiedCount || 0,
      ...counts,
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /admin/cmd-notifications/read-all
// ─────────────────────────────────────────────────────────────
const markAllCmdNotificationsRead = async (req, res) => {
  try {
    if (!ensureCmd(req, res)) return;
    const userObjectId = toObjectId(req.user.userId);
    const result = await CmdNotification.updateMany(
      unreadFilterFor(userObjectId),
      { $push: { readBy: { userId: userObjectId, readAt: nowIST() } } },
    );
    return successResponse(res, "All notifications marked as read", {
      updatedCount: result.modifiedCount || 0,
      overallCount: 0,
      rentalExecutiveApprovalCount: 0,
      rentalManagerApprovalCount: 0,
      normalApprovalCount: 0,
      reminderCount: 0,
      billingDateRevertCount: 0,
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// One site: create / bump the CMD reminder row(s) for every month of this
// site already approved by the Rental Executive (now waiting on Rental Manager)
// or by the Manager (now waiting on CMD), not yet fully approved (or only `dueMonth` when given).
// Returns a per-site result object (never throws for a business failure).
// ─────────────────────────────────────────────────────────────
async function remindCmdForSite(rawMediaId, { dueMonth, remarksText, role, userName, userId }) {
  const mediaIdStr = typeof rawMediaId === "string" ? rawMediaId.trim() : String(rawMediaId || "");
  const mediaObjectId = toObjectId(mediaIdStr);
  if (!mediaObjectId) {
    return { mediaId: mediaIdStr, success: false, message: "A valid mediaId is required" };
  }

  const media = await MediaOnboarding.findById(mediaObjectId).lean();
  if (!media) {
    return { mediaId: mediaIdStr, success: false, message: "Media not found" };
  }

  const requestedMonth = typeof dueMonth === "string" ? dueMonth.trim().toLowerCase() : "";
  const remindableDues = (media.rentalDue || []).filter(
    (d) =>
      Number(d.approvalStatus) !== 3 &&
      // ✅ Executive approved → waiting on Manager (2), or Manager approved → waiting on CMD (3)
      [USER_ROLE.RENTAL_MANAGER, USER_ROLE.CMD].includes(Number(d.currentPendingRole)) &&
      (!requestedMonth || String(d.dueMonth || "").trim().toLowerCase() === requestedMonth),
  );

  // site-wise labels for the faces involved (site-level due → all active faces)
  const details = media.mediaDetails || [];
  const activeFaces = details.filter((d) => Number(d.status) === 1);
  const activeFaceIds = activeFaces.map((d) => String(d._id));

  if (remindableDues.length === 0) {
    return {
      mediaId: media._id,
      siteCode: activeFaces.map((d) => d.mediaCode).filter(Boolean).join(" / "),
      success: false,
      message: "No rental due approved by Rental Executive / Manager and pending approval for this site",
    };
  }

  const owners = media.landOwners || [];
  const landOwnerName = owners.map((o) => o.name).filter(Boolean).join(", ");
  const landOwnerMasterIds = owners.map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean);
  const roleLabel = APPROVER_ROLE_LABEL[role];

  // one reminder row per month waiting on CMD
  const byMonth = new Map();
  remindableDues.forEach((d) => {
    const month = d.dueMonth || "";
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(d);
  });

  const reminders = [];
  for (const [month, dues] of byMonth) {
    const faceIds = [
      ...new Set(dues.flatMap((d) => (d.mediaDetailId ? [String(d.mediaDetailId)] : activeFaceIds))),
    ];
    const faces = details.filter((d) => faceIds.includes(String(d._id)));
    const now = nowIST();
    const dedupeKey = `reminder:media:${String(media._id)}:${month}`;

    const doc = await CmdNotification.findOneAndUpdate(
      { dedupeKey },
      {
        $set: {
          mediaDetailId: toObjectId(dues[dues.length - 1].mediaDetailId),
          mediaDetailIds: faceIds.map(toObjectId).filter(Boolean),
          rentalDueId: dues[dues.length - 1]._id,
          landOwnerName,
          landOwnerMasterIds,
          siteName: faces.map((d) => d.mediaName).filter(Boolean).join(", ") || media.mediaName || "",
          siteCode: faces.map((d) => d.mediaCode).filter(Boolean).join(" / ") || media.mediaCode || "",
          message: `Reminder: ${roleLabel} ${userName} requested approval${month ? ` for ${month}` : ""}`
            .replace(/\s+/g, " ")
            .trim(),
          ...(remarksText ? { remarks: remarksText } : {}), // keep the previous note when none is sent
          lastRemindedBy: userName,
          lastRemindedByRole: role,
          lastRemindedByUserId: toObjectId(userId),
          lastRemindedAt: now,
          readBy: [], // new reminder → unread again for CMD
          updatedAt: now,
        },
        $inc: { reminderCount: 1 },
        $setOnInsert: {
          targetRole: USER_ROLE.CMD,
          notificationType: NOTIFICATION_TYPE.REMINDER,
          mediaId: media._id,
          dueMonth: month,
          dedupeKey,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    ).lean();

    reminders.push({
      notificationId: doc._id,
      notificationType: doc.notificationType,
      mediaId: doc.mediaId,
      siteCode: doc.siteCode,
      dueMonth: doc.dueMonth,
      reminderCount: doc.reminderCount,
      lastRemindedBy: doc.lastRemindedBy,
      lastRemindedByRole: doc.lastRemindedByRole,
      lastRemindedAt: doc.lastRemindedAt,
    });
  }

  // latest month first; full list in reminders[] when several months were reminded
  reminders.sort((a, b) => new Date(`1 ${b.dueMonth}`) - new Date(`1 ${a.dueMonth}`));
  return { success: true, message: "Reminder sent to CMD", ...reminders[0], reminders };
}

// ─────────────────────────────────────────────────────────────
// POST /admin/cmd-notifications/reminder
// Rental Executive / Rental Manager reminds CMD to approve site(s).
// body: { mediaId: [ids] (a single id string is also accepted),
//         dueMonth? (e.g. "October 2026"), remarks? }
// Only rental dues approved by the Executive (waiting on Manager) or the Manager (waiting on CMD), not yet fully approved, can be reminded. One reminder row per
// site per month: each new reminder increments reminderCount and makes it
// unread again for CMD. Each site is processed independently.
// ─────────────────────────────────────────────────────────────
const sendCmdReminder = async (req, res) => {
  try {
    const role = Number(req.user?.userType);
    if (!APPROVER_ROLE_LABEL[role]) {
      return errorResponse(res, "Only Rental Executive / Rental Manager can send reminders", null, 403);
    }

    const { mediaId, dueMonth, remarks } = req.body || {};
    const rawIds = Array.isArray(mediaId) ? mediaId : mediaId ? [mediaId] : [];
    // de-duplicate, keep request order
    const mediaIds = [
      ...new Set(rawIds.map((id) => (typeof id === "string" ? id.trim() : String(id || ""))).filter(Boolean)),
    ];
    if (mediaIds.length === 0) {
      return errorResponse(res, "mediaId must be a non-empty array of valid ids", null, 400);
    }

    const options = {
      dueMonth,
      remarksText: typeof remarks === "string" ? remarks.trim() : "",
      role,
      userName: req.user?.userName || "",
      userId: req.user?.userId,
    };

    const results = [];
    for (const id of mediaIds) {
      results.push(await remindCmdForSite(id, options));
    }

    const successCount = results.filter((r) => r.success).length;
    const summary = {
      totalSites: results.length,
      successCount,
      failedCount: results.length - successCount,
      results,
    };

    if (successCount === 0) {
      return errorResponse(
        res,
        "No reminder sent — none of the sites has a rental due approved by Rental Executive / Manager and pending approval",
        summary,
        400,
      );
    }
    return successResponse(res, `Reminder sent to CMD for ${successCount} of ${results.length} site(s)`, summary);
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

module.exports = {
  createRentalApprovalNotification,
  createBillingDateRevertNotification,
  updateBillingDateRevertNotificationStatus,
  sendCmdReminder,
  getCmdNotifications,
  getCmdNotificationCount,
  markCmdNotificationRead,
  markAllCmdNotificationsRead,
};
