const mongoose = require("mongoose");
const CmdNotification = require("../../../models/Admin/NotificationSchema/CmdNotificationSchema");
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const OverDueHistory = require("../../../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");
const {
  sendOverdueRemarkPushNotification,
  sendApprovalPushNotification,
  sendReminderPushNotification,
} = require("../../../utils/fcmService");

// userType values (same as UserSchema)
const USER_ROLE = { RENTAL_EXECUTIVE: 1, RENTAL_MANAGER: 2, CMD: 3 };
const APPROVER_ROLE_LABEL = {
  [USER_ROLE.RENTAL_EXECUTIVE]: "Rental Executive",
  [USER_ROLE.RENTAL_MANAGER]: "Rental Manager",
};

// every role that sends / receives notifications
const ROLE_LABEL = { ...APPROVER_ROLE_LABEL, [USER_ROLE.CMD]: "CMD" };
const REVERT_STATUS_LABEL = { 1: "Pending", 2: "Approved", 3: "Rejected" };

// rental approval → who is notified:
// Executive approved → Manager | Manager approved → CMD | CMD approved → Executive + Manager
const APPROVAL_NOTIFY_TARGETS = {
  [USER_ROLE.RENTAL_EXECUTIVE]: [USER_ROLE.RENTAL_MANAGER],
  [USER_ROLE.RENTAL_MANAGER]: [USER_ROLE.CMD],
  [USER_ROLE.CMD]: [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.RENTAL_MANAGER],
};

// rows created before targetRole existed belong to CMD
const targetRoleFilter = (role) =>
  Number(role) === USER_ROLE.CMD ? { targetRole: { $in: [USER_ROLE.CMD, null] } } : { targetRole: Number(role) };

const toObjectId = (id) =>
  id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;

// unread for THIS user (rows sent to their role)
const unreadFilterFor = (role, userObjectId) => ({
  ...targetRoleFilter(role),
  "readBy.userId": { $ne: userObjectId },
});

// notificationType filters (rows created before the flag existed have no
// notificationType → treated as "normalApproval")
const NOTIFICATION_TYPE = {
  NORMAL_APPROVAL: "normalApproval",
  REMINDER: "reminder",
  BILLING_DATE_REVERT: "billingDateRevert",
  OVERDUE_REMARK: "overdueRemark",
};
const normalApprovalFilter = {
  notificationType: {
    $nin: [NOTIFICATION_TYPE.REMINDER, NOTIFICATION_TYPE.BILLING_DATE_REVERT, NOTIFICATION_TYPE.OVERDUE_REMARK],
  },
};
const reminderFilter = { notificationType: NOTIFICATION_TYPE.REMINDER };
const billingDateRevertFilter = { notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT };
const overdueRemarkFilter = { notificationType: NOTIFICATION_TYPE.OVERDUE_REMARK };

// overdue remark → who is notified:
// Executive's remark → Manager + CMD | Manager's remark → Executive + CMD
// | CMD's remark → Executive + Manager
const OVERDUE_REMARK_NOTIFY_TARGETS = {
  [USER_ROLE.RENTAL_EXECUTIVE]: [USER_ROLE.RENTAL_MANAGER, USER_ROLE.CMD],
  [USER_ROLE.RENTAL_MANAGER]: [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.CMD], // ✅ NEW
  [USER_ROLE.CMD]: [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.RENTAL_MANAGER], // ✅ NEW
};

// ✅ NEW — reading an overdueRemark notification marks that site + month's
// remarks (added up to now) as read for the reader's ROLE, so
// GET /admin/overdue-remarks shows isRead per role. Remarks saved before read
// tracking existed have no readByRoles and already count as read. Never throws.
async function markOverdueRemarksReadForRole(notificationRows, role) {
  try {
    const now = nowIST();
    for (const n of notificationRows || []) {
      if (!n?.mediaId) continue;
      const sameBill = [];
      if (n.dueMonth) sameBill.push({ dueMonth: n.dueMonth });
      if (n.rentalDueId) sameBill.push({ rentalDueId: n.rentalDueId });
      if (sameBill.length === 0) continue;
      await OverDueHistory.updateMany(
        { mediaId: n.mediaId, $or: sameBill },
        { $addToSet: { "overDueRemarks.$[r].readByRoles": Number(role) } },
        { arrayFilters: [{ "r.readByRoles": { $exists: true }, "r.addedAt": { $lte: now } }] },
      );
    }
  } catch (err) {
    console.error("[CmdNotification] overdue remark read sync failed:", err.message);
  }
}

// unread counts for THIS CMD user: overall + split by who approved
// (each site has one Executive row and one Manager row, counted separately)
// + split by notification type (normal approval vs reminder)
const getUnreadCounts = async (role, userObjectId) => {
  const unread = unreadFilterFor(role, userObjectId);
  const [
    overallCount,
    rentalExecutiveApprovalCount,
    rentalManagerApprovalCount,
    cmdApprovalCount,
    normalApprovalCount,
    reminderCount,
    billingDateRevertCount,
    overdueRemarkCount,
  ] = await Promise.all([
    CmdNotification.countDocuments(unread),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter, approvedByRole: USER_ROLE.RENTAL_EXECUTIVE }),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter, approvedByRole: USER_ROLE.RENTAL_MANAGER }),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter, approvedByRole: USER_ROLE.CMD }),
    CmdNotification.countDocuments({ ...unread, ...normalApprovalFilter }),
    CmdNotification.countDocuments({ ...unread, ...reminderFilter }),
    CmdNotification.countDocuments({ ...unread, ...billingDateRevertFilter }),
    CmdNotification.countDocuments({ ...unread, ...overdueRemarkFilter }),
  ]);
  return {
    overallCount,
    rentalExecutiveApprovalCount,
    rentalManagerApprovalCount,
    cmdApprovalCount,
    normalApprovalCount,
    reminderCount,
    billingDateRevertCount,
    overdueRemarkCount,
  };
};

// Rental Executive (1) / Rental Manager (2) / CMD (3) — each sees only the
// rows sent to their own role. Returns the role, or null after a 403.
const ensureNotificationUser = (req, res) => {
  const role = Number(req.user?.userType);
  if (!ROLE_LABEL[role]) {
    errorResponse(res, "You are not allowed to access notifications", null, 403);
    return null;
  }
  return role;
};

// ─────────────────────────────────────────────────────────────
// INTERNAL — called from RentalDueNew2Controller after a successful,
// already-saved Rental Executive / Rental Manager approval.
// Never throws: a notification failure must not affect the approval.
// ─────────────────────────────────────────────────────────────
async function createRentalApprovalNotification({ media, entry, userType, userId, userName }) {
  let lastKey = null;
  for (const targetRole of APPROVAL_NOTIFY_TARGETS[Number(userType)] || []) {
    const key = await createRentalApprovalNotificationFor({ media, entry, userType, userId, userName, targetRole });
    if (key) lastKey = key;
  }
  return lastKey;
}

// one approval notification row for ONE receiver role. Never throws.
async function createRentalApprovalNotificationFor({ media, entry, userType, userId, userName, targetRole }) {
  try {
    const role = Number(userType);
    if (!media || !entry || !ROLE_LABEL[role]) return null;

    const step = (entry.approvalSteps || []).find((s) => s.role === role && s.status === 2);
    if (!step) return null; // this role did not approve — nothing to notify
    const approvedAt = step.approvedAt ? new Date(step.approvedAt) : nowIST();

    const owners = media.landOwners || [];
    const landOwnerName = owners.map((o) => o.name).filter(Boolean).join(", ");
    const landOwnerMasterIds = owners.map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean);

    const roleLabel = ROLE_LABEL[role];
    const dueMonth = entry.dueMonth || "";
    const byName = role === USER_ROLE.CMD ? "" : userName || "";
    const message = `${roleLabel} ${byName} approved rental due${dueMonth ? ` for ${dueMonth}` : ""}`
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
    // CMD rows keep the original key; Executive / Manager rows add ":to:<role>"
    const dedupeKey =
      `media:${String(media._id)}:${dueMonth}:role:${role}` +
      (Number(targetRole) === USER_ROLE.CMD ? "" : `:to:${targetRole}`);
    const sameTarget = { ...targetRoleFilter(targetRole), ...normalApprovalFilter };
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

    const existing = await CmdNotification.findOne({ mediaId: media._id, dueMonth, approvedByRole: role, ...sameTarget })
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
        ...sameTarget,
        _id: { $ne: existing._id },
      });

      const mergedFaceIds = [...new Set([...knownFaceIds, ...entryFaceIds])];
      const siteLabelsExisting = buildSiteLabels(mergedFaceIds);
      await CmdNotification.updateOne(
        { _id: existing._id },
        {
          $set: {
            // a newer approval becomes the latest; an older one for a new face
            // only adds that face to the site
            ...(isNewerApproval ? latestFields : {}),
            ...siteLabelsExisting,
            readBy: [], // new approval on this site → unread again for the receiver
            dedupeKey,
            updatedAt: nowIST(),
          },
        },
      );
      sendApprovalPushNotification({
        media,
        entry,
        userType,
        userId,
        userName,
        targetRole,
        siteCode: siteLabelsExisting.siteCode,
        siteName: siteLabelsExisting.siteName,
        dueMonth,
      }).catch((fcmErr) => {
        console.error("[CmdNotification] Approval FCM push error:", fcmErr?.message || fcmErr);
      });
      return dedupeKey;
    }

    const now = nowIST();
    const siteLabelsNew = buildSiteLabels(entryFaceIds);
    await CmdNotification.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          targetRole: Number(targetRole),
          notificationType: NOTIFICATION_TYPE.NORMAL_APPROVAL,
          ...latestFields,
          ...siteLabelsNew,
          readBy: [],
          dedupeKey,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    sendApprovalPushNotification({
      media,
      entry,
      userType,
      userId,
      userName,
      targetRole,
      siteCode: siteLabelsNew.siteCode,
      siteName: siteLabelsNew.siteName,
      dueMonth,
    }).catch((fcmErr) => {
      console.error("[CmdNotification] Approval FCM push error:", fcmErr?.message || fcmErr);
    });
    return dedupeKey;
  } catch (err) {
    // E11000 = same approval processed concurrently — already notified
    if (err?.code !== 11000) {
      console.error("[CmdNotification] create failed:", err.message);
    }
    return null;
  }
}

// billing date change → who is notified:
// Executive requested → Manager + CMD | Manager requested → Executive + CMD
// CMD approved / rejected → Executive + Manager
const otherRequesterRole = (role) =>
  Number(role) === USER_ROLE.RENTAL_EXECUTIVE
    ? USER_ROLE.RENTAL_MANAGER
    : Number(role) === USER_ROLE.RENTAL_MANAGER
      ? USER_ROLE.RENTAL_EXECUTIVE
      : null;

const fmtRevertDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

// request snapshot shared by every billingDateRevert row of one request
// landowner master ids of a site (the revert request stores names only)
async function siteLandOwnerIds(mediaId) {
  try {
    const media = await MediaOnboarding.findById(mediaId).select("landOwners.landOwnerMasterId").lean();
    return (media?.landOwners || []).map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean);
  } catch {
    return [];
  }
}

const revertRequestFields = (request) => {
  const role = Number(request.requestedBy?.role);
  return {
    mediaId: request.mediaId,
    mediaDetailIds: (request.siteDetails || []).map((f) => toObjectId(f.mediaDetailId)).filter(Boolean),
    landOwnerName: request.landOwnerName || "",
    siteName: request.siteName || "",
    siteCode: request.siteCode || "",
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
    imagePath: request.image?.filePath || "",
  };
};

const revertRequestMessage = (request, verb) => {
  const role = Number(request.requestedBy?.role);
  return (
    `${APPROVER_ROLE_LABEL[role] || ""} ${request.requestedBy?.userName || ""} ${verb}` +
    ` (${fmtRevertDate(request.originalDates?.lastBillPaidDate)} → ${fmtRevertDate(request.requestedDates?.lastBillPaidDate)})`
  )
    .replace(/\s+/g, " ")
    .trim();
};

// "billingDateRevert:<id>" = CMD row (original key), "billingDateRevert:<id>:to:<role>" = Executive / Manager row
const revertRequestKey = (requestId, targetRole) =>
  `billingDateRevert:${String(requestId)}` + (Number(targetRole) === USER_ROLE.CMD ? "" : `:to:${targetRole}`);

// Executive / Manager copy of the request row: only the OTHER requester role
// gets it; a copy for the role that now raised it is removed (edit by the
// other role). Never throws.
async function syncRevertRequesterCopy(request, message) {
  try {
    const targetRole = otherRequesterRole(request.requestedBy?.role);
    const keepKey = targetRole ? revertRequestKey(request._id, targetRole) : null;
    await CmdNotification.deleteMany({
      billingDateRevertRequestId: request._id,
      dedupeKey: {
        $regex: `^billingDateRevert:${String(request._id)}:to:`,
        ...(keepKey ? { $ne: keepKey } : {}),
      },
    });
    if (!targetRole) return;
    const now = nowIST();
    await CmdNotification.updateOne(
      { dedupeKey: keepKey },
      {
        $set: {
          ...revertRequestFields(request),
          landOwnerMasterIds: await siteLandOwnerIds(request.mediaId),
          message,
          requestedAt: request.updatedAt || request.createdAt || now,
          readBy: [], // new / updated request → unread again
          updatedAt: now,
        },
        $setOnInsert: {
          targetRole,
          notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT,
          dueMonth: "",
          dedupeKey: keepKey,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) {
      console.error("[CmdNotification] billing date revert requester copy failed:", err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL — called from BillingDateRevertController after a revert
// request is saved. ONE CMD row per request (dedupeKey) + one row for the
// other requester role. Returns the CMD row id. Never throws: a notification
// failure must not affect the saved request.
// ─────────────────────────────────────────────────────────────
async function createBillingDateRevertNotification({ request }) {
  try {
    if (!request?._id) return null;
    const message = revertRequestMessage(request, "requested billing date revert");
    const now = nowIST();
    const dedupeKey = revertRequestKey(request._id, USER_ROLE.CMD);

    const doc = await CmdNotification.findOneAndUpdate(
      { dedupeKey },
      {
        $setOnInsert: {
          targetRole: USER_ROLE.CMD,
          notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT,
          dueMonth: "",
          ...revertRequestFields(request),
          landOwnerMasterIds: await siteLandOwnerIds(request.mediaId),
          message,
          requestedAt: request.createdAt || now,
          readBy: [],
          dedupeKey,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    ).lean();
    await syncRevertRequesterCopy(request, message);
    return doc?._id || null;
  } catch (err) {
    if (err?.code !== 11000) {
      console.error("[CmdNotification] billing date revert create failed:", err.message);
    }
    return null;
  }
}

// ✅ NEW — a pending request was edited (new dates): refresh the SAME
// notification rows with the latest request and make them unread again, so
// each receiver sees one notification for the one request. Never throws.
async function refreshBillingDateRevertNotification({ request }) {
  try {
    if (!request?._id) return null;
    const message = revertRequestMessage(request, "updated billing date revert request");
    const result = await CmdNotification.updateOne(
      { dedupeKey: revertRequestKey(request._id, USER_ROLE.CMD) },
      {
        $set: {
          ...revertRequestFields(request),
          landOwnerMasterIds: await siteLandOwnerIds(request.mediaId),
          message,
          requestedAt: request.updatedAt || nowIST(),
          readBy: [], // updated request → unread again for CMD
          updatedAt: nowIST(),
        },
      },
    );
    // no row yet (e.g. deleted by the notification clean-up) → create it
    if (!result.matchedCount) return createBillingDateRevertNotification({ request });
    await syncRevertRequesterCopy(request, message);
    return true;
  } catch (err) {
    console.error("[CmdNotification] billing date revert refresh failed:", err.message);
    return null;
  }
}

// ✅ NEW — the CMD's OWN copy of a revert request (decided requests are
// removed from the CMD's notifications; Executive / Manager rows are kept)
const isDecidedRevertStatus = (status) => [2, 3].includes(Number(status)); // 2 Approved, 3 Rejected
const cmdRevertRequestRowFilter = (requestId) => ({
  $or: [
    { dedupeKey: revertRequestKey(requestId, USER_ROLE.CMD) },
    {
      billingDateRevertRequestId: toObjectId(requestId),
      notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT,
      ...targetRoleFilter(USER_ROLE.CMD),
    },
  ],
});

// Keeps every row of the request in sync with its status; with `request`
// (CMD approve / reject) it also notifies the Executive and the Manager.
// Never throws.
async function updateBillingDateRevertNotificationStatus(requestId, revertStatus, request = null) {
  try {
    await CmdNotification.updateMany(
      { billingDateRevertRequestId: toObjectId(requestId), notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT },
      { $set: { revertStatus } },
    );
    // rows created before billingDateRevertRequestId was stored
    await CmdNotification.updateOne(
      { dedupeKey: revertRequestKey(requestId, USER_ROLE.CMD) },
      { $set: { revertStatus, updatedAt: nowIST() } },
    );
    // ✅ NEW — CMD approved / rejected: the request no longer shows in the
    // CMD's own notifications; only the Executive and Manager are notified
    if (isDecidedRevertStatus(revertStatus)) {
      await CmdNotification.deleteMany(cmdRevertRequestRowFilter(requestId));
    }
  } catch (err) {
    console.error("[CmdNotification] billing date revert status update failed:", err.message);
  }
  if (request?._id) await createBillingDateRevertDecisionNotification({ request, revertStatus });
}

// CMD approved / rejected → one row each for the Executive and the Manager.
// Never throws.
async function createBillingDateRevertDecisionNotification({ request, revertStatus }) {
  try {
    const status = Number(revertStatus || request.status);
    const verb = status === 2 ? "approved" : "rejected";
    const dates = request.appliedDates?.lastBillPaidDate || request.requestedDates?.lastBillPaidDate;
    const site = [request.siteName, request.siteCode ? `(${request.siteCode})` : ""].filter(Boolean).join(" ");
    const message = `CMD ${verb} billing date change${site ? ` for ${site}` : ""}: ${fmtRevertDate(dates)}`;
    const now = nowIST();

    for (const targetRole of [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.RENTAL_MANAGER]) {
      const dedupeKey = `billingDateRevertDecision:${String(request._id)}:to:${targetRole}`;
      await CmdNotification.updateOne(
        { dedupeKey },
        {
          $set: {
            ...revertRequestFields(request),
          landOwnerMasterIds: await siteLandOwnerIds(request.mediaId),
            revertStatus: status,
            message,
            requestedAt: request.updatedAt || request.createdAt || null,
            cmdActionBy: request.cmdAction?.userName || "CMD",
            cmdActionByUserId: toObjectId(request.cmdAction?.userId),
            cmdRemark: request.cmdAction?.remark || "",
            cmdActionAt: request.cmdAction?.actionAt || now,
            readBy: [],
            updatedAt: now,
          },
          $setOnInsert: {
            targetRole,
            notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT,
            dueMonth: "",
            dedupeKey,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    }
  } catch (err) {
    if (err?.code !== 11000) {
      console.error("[CmdNotification] billing date revert decision notify failed:", err.message);
    }
  }
}

const isRevertDecisionRow = (n) => String(n.dedupeKey || "").startsWith("billingDateRevertDecision:");

// who sent this notification (common for every type)
const senderOf = (n) => {
  if (n.notificationType === NOTIFICATION_TYPE.REMINDER) {
    return { fromRole: n.lastRemindedByRole ?? null, fromName: n.lastRemindedBy || "" };
  }
  if (n.notificationType === NOTIFICATION_TYPE.OVERDUE_REMARK) {
    return { fromRole: n.remarkedByRole ?? null, fromName: n.remarkedBy || "" };
  }
  if (n.notificationType === NOTIFICATION_TYPE.BILLING_DATE_REVERT) {
    return isRevertDecisionRow(n)
      ? { fromRole: USER_ROLE.CMD, fromName: n.cmdActionBy || "CMD" }
      : { fromRole: n.requestedByRole ?? null, fromName: n.requestedBy || "" };
  }
  return { fromRole: n.approvedByRole ?? null, fromName: n.approvedByName || "" };
};

const formatNotification = (n, userObjectId) => ({
  notificationId: n._id,
  notificationType: n.notificationType || NOTIFICATION_TYPE.NORMAL_APPROVAL,
  ...senderOf(n),
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
  // overdue remark rows only (read only)
  ...(n.notificationType === NOTIFICATION_TYPE.OVERDUE_REMARK
    ? {
        remarks: n.remarks || "",
        remarkCount: n.remarkCount || 0,
        remarkedBy: n.remarkedBy || "",
        remarkedByRole: n.remarkedByRole ?? null,
        remarkedAt: n.remarkedAt || null,
        remarkId: n.remarkId || "",
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
  n.notificationType !== NOTIFICATION_TYPE.BILLING_DATE_REVERT &&
  n.notificationType !== NOTIFICATION_TYPE.OVERDUE_REMARK
    ? { approvedByRole: n.approvedByRole, approvedByName: n.approvedByName, approvedAt: n.approvedAt }
    : {}),
  // billing date revert rows only
  ...(n.notificationType === NOTIFICATION_TYPE.BILLING_DATE_REVERT
    ? {
        billingDateRevertRequestId: n.billingDateRevertRequestId,
        revertStatus: n.revertStatus,
        revertStatusLabel: REVERT_STATUS_LABEL[n.revertStatus] || "",
        currentLastBillPaidDate: n.currentLastBillPaidDate,
        currentNextBillingDate: n.currentNextBillingDate,
        requestedLastBillPaidDate: n.requestedLastBillPaidDate,
        requestedNextBillingDate: n.requestedNextBillingDate,
        remarks: n.remarks || "",
        imagePath: n.imagePath || "",
        requestedBy: n.requestedBy || "",
        requestedByRole: n.requestedByRole ?? null,
        requestedAt: n.requestedAt || null,
        cmdActionBy: n.cmdActionBy || null,
        cmdRemark: n.cmdRemark || "",
        cmdActionAt: n.cmdActionAt || null,
        // ✅ NEW — status filter values: 1 Pending, 2 Approved by CMD, 3 Rejected by CMD
        status: Number(n.revertStatus) || 1,
        statusLabel: REVERT_FILTER_STATUS_LABEL[Number(n.revertStatus) || 1] || "",
        rejectReason: Number(n.revertStatus) === 3 ? n.cmdRemark || "" : "",
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

// rows saved without landowner master ids (older billing date revert rows) →
// read them from the site for the response
async function withLandOwnerIds(rows) {
  const missing = [...new Set(rows.filter((n) => !(n.landOwnerMasterIds || []).length && n.mediaId).map((n) => String(n.mediaId)))];
  if (!missing.length) return rows;
  const sites = await MediaOnboarding.find({ _id: { $in: missing.map(toObjectId) } })
    .select("landOwners.landOwnerMasterId")
    .lean();
  const idsBySite = new Map(
    sites.map((m) => [String(m._id), (m.landOwners || []).map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean)]),
  );
  return rows.map((n) =>
    (n.landOwnerMasterIds || []).length ? n : { ...n, landOwnerMasterIds: idsBySite.get(String(n.mediaId)) || [] },
  );
}

// ✅ NEW — short names accepted for notificationType
const NOTIFICATION_TYPE_ALIAS = {
  approval: NOTIFICATION_TYPE.NORMAL_APPROVAL,
  remark: NOTIFICATION_TYPE.OVERDUE_REMARK,
};

// optional notificationType filter: "normalApproval" | "reminder" | "billingDateRevert"
// | "overdueRemark" (also "approval" / "remark")
const typeFilterFor = (rawType) => {
  const notificationType = NOTIFICATION_TYPE_ALIAS[rawType] || rawType;
  if (notificationType === NOTIFICATION_TYPE.REMINDER) return reminderFilter;
  if (notificationType === NOTIFICATION_TYPE.NORMAL_APPROVAL) return normalApprovalFilter;
  if (notificationType === NOTIFICATION_TYPE.BILLING_DATE_REVERT) return billingDateRevertFilter;
  if (notificationType === NOTIFICATION_TYPE.OVERDUE_REMARK) return overdueRemarkFilter;
  return {};
};

// ✅ NEW — notification tabs (`filter`). The role comes from the login token.
//   everyone : read, unread, remarks
//   CMD      : approvals, reminders, pending (billing date change waiting on CMD)
//   RE / RM  : approved, rejected (billing date change decided by CMD)
const COMMON_FILTER_TABS = ["read", "unread", "remarks"];
const FILTER_TABS_BY_ROLE = {
  [USER_ROLE.CMD]: [...COMMON_FILTER_TABS, "approvals", "reminders", "pending"],
  [USER_ROLE.RENTAL_EXECUTIVE]: [...COMMON_FILTER_TABS, "approved", "rejected"],
  [USER_ROLE.RENTAL_MANAGER]: [...COMMON_FILTER_TABS, "approved", "rejected"],
};
// Mongo condition for one tab (read / unread depend on the logged-in user)
const filterTabCondition = (tab, userObjectId) => {
  switch (tab) {
    case "read": return { "readBy.userId": userObjectId };
    case "unread": return { "readBy.userId": { $ne: userObjectId } };
    case "remarks": return overdueRemarkFilter;
    case "approvals": return normalApprovalFilter;
    case "reminders": return reminderFilter;
    case "pending": return revertStatusFilterFor(1);
    case "approved": return revertStatusFilterFor(2);
    case "rejected": return revertStatusFilterFor(3);
    default: return null;
  }
};

// ✅ NEW — billing date change (last bill date revert) status filter
// 1 = Pending (request rows, not yet decided)
// 2 = Approved by CMD / 3 = Rejected by CMD (the CMD decision rows only —
//     one per request, no duplicate request copies)
const REVERT_FILTER_STATUS_LABEL = { 1: "Pending", 2: "Approved by CMD", 3: "Rejected by CMD" };
const revertStatusFilterFor = (status) =>
  Number(status) === 1
    ? {
        ...billingDateRevertFilter,
        revertStatus: { $in: [1, null] },
        dedupeKey: { $not: /^billingDateRevertDecision:/ },
      }
    : {
        ...billingDateRevertFilter,
        revertStatus: Number(status),
        dedupeKey: { $regex: "^billingDateRevertDecision:" },
      };

// ─────────────────────────────────────────────────────────────
// POST/GET /admin/cmd-notifications
// Role: Rental Executive (1) / Rental Manager (2) / CMD (3) — rows sent to
// the logged-in role only.
// body/query: pageNumber, count, isRead (true/false — optional filter),
//             notificationType ("normalApproval" | "reminder" | "billingDateRevert" — optional),
//             fromRole (1 | 2 | 3 — optional: who sent it),
//             status (1 Pending | 2 Approved by CMD | 3 Rejected by CMD —
//                     optional: billing date change notifications only)
// ─────────────────────────────────────────────────────────────
const getCmdNotifications = async (req, res) => {
  try {
    const role = ensureNotificationUser(req, res);
    if (!role) return;
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const userObjectId = toObjectId(req.user.userId);

    // ✅ NEW — optional billing date change status filter
    const hasStatus = params.status !== undefined && params.status !== null && params.status !== "";
    const status = hasStatus ? Number(params.status) : null;
    if (hasStatus && !REVERT_FILTER_STATUS_LABEL[status]) {
      return errorResponse(res, "status must be 1 (Pending), 2 (Approved by CMD) or 3 (Rejected by CMD)", null, 400);
    }

    // ✅ NEW — optional tab filter, allowed per role (role from the token)
    const allowedTabs = FILTER_TABS_BY_ROLE[role] || COMMON_FILTER_TABS;
    const tab = params.filter !== undefined && params.filter !== null ? String(params.filter).trim().toLowerCase() : "";
    if (tab && !allowedTabs.includes(tab)) {
      const known = Object.values(FILTER_TABS_BY_ROLE).some((tabs) => tabs.includes(tab));
      return errorResponse(
        res,
        known
          ? `filter "${tab}" is not available for ${ROLE_LABEL[role]}. Allowed: ${allowedTabs.join(", ")}`
          : `Unknown filter "${tab}". Allowed: ${allowedTabs.join(", ")}`,
        null,
        400,
      );
    }

    const pageNumber = Math.max(parseInt(params.pageNumber) || 1, 1);
    const count = Math.max(parseInt(params.count) || 10, 1);

    const filter = { ...targetRoleFilter(role), ...typeFilterFor(params.notificationType) };
    if (params.isRead === true || params.isRead === "true") {
      filter["readBy.userId"] = userObjectId;
    } else if (params.isRead === false || params.isRead === "false") {
      filter["readBy.userId"] = { $ne: userObjectId };
    }
    // optional: who sent it (approvals → approvedByRole, reminders →
    // lastRemindedByRole, bill date change → requestedByRole / CMD decision)
    const fromRole = Number(params.fromRole);
    if (ROLE_LABEL[fromRole]) {
      filter.$or =
        fromRole === USER_ROLE.CMD
          ? [
              { approvedByRole: fromRole },
              { dedupeKey: { $regex: "^billingDateRevertDecision:" } },
              { ...overdueRemarkFilter, remarkedByRole: fromRole }, // ✅ NEW — CMD's remarks
            ]
          : [
              { ...normalApprovalFilter, approvedByRole: fromRole },
              { ...reminderFilter, lastRemindedByRole: fromRole },
              { ...overdueRemarkFilter, remarkedByRole: fromRole },
              { ...billingDateRevertFilter, requestedByRole: fromRole, dedupeKey: { $not: /^billingDateRevertDecision:/ } },
            ];
    }
    // ✅ NEW — status → billing date change rows of that status only
    // ($and, so it combines with notificationType / fromRole / isRead)
    if (hasStatus) {
      filter.$and = [...(filter.$and || []), revertStatusFilterFor(status)];
    }
    // ✅ NEW — tab filter; the read / unread tabs decide read state themselves
    if (tab) {
      if (tab === "read" || tab === "unread") delete filter["readBy.userId"];
      filter.$and = [...(filter.$and || []), filterTabCondition(tab, userObjectId)];
    }

    // ✅ NEW — per-status totals (read + unread) for the logged-in role
    const roleOnly = targetRoleFilter(role);
    const statusCountsPromise = Promise.all(
      [1, 2, 3].map((s) => CmdNotification.countDocuments({ ...roleOnly, ...revertStatusFilterFor(s) })),
    );

    // ✅ NEW — total / read / unread per type (approvals, overdue remarks) for
    // the logged-in user, independent of the list filters
    const unreadOnly = unreadFilterFor(role, userObjectId);
    const typeCountPromise = Promise.all(
      [normalApprovalFilter, overdueRemarkFilter].flatMap((typeFilter) => [
        CmdNotification.countDocuments({ ...roleOnly, ...typeFilter }),
        CmdNotification.countDocuments({ ...unreadOnly, ...typeFilter }),
      ]),
    ).then(([approvalTotal, approvalUnread, remarkTotal, remarkUnread]) => ({
      normalApproval: { totalCount: approvalTotal, readCount: approvalTotal - approvalUnread, unreadCount: approvalUnread },
      overdueRemark: { totalCount: remarkTotal, readCount: remarkTotal - remarkUnread, unreadCount: remarkUnread },
    }));

    // ✅ NEW — per-tab badge counts for the logged-in role / user
    const filterCountPromise = Promise.all(
      allowedTabs.map(async (t) => {
        const cond = filterTabCondition(t, userObjectId);
        const totalTab = await CmdNotification.countDocuments({ ...roleOnly, ...cond });
        const unreadTab =
          t === "read" ? 0
          : t === "unread" ? totalTab
          : await CmdNotification.countDocuments({ ...unreadOnly, ...cond });
        return [t, { totalCount: totalTab, unreadCount: unreadTab }];
      }),
    ).then(Object.fromEntries);

    const [totalCount, counts, rows, [pendingCount, approvedCount, rejectedCount], notificationTypeCount, filterCount] = await Promise.all([
      CmdNotification.countDocuments(filter),
      getUnreadCounts(role, userObjectId),
      CmdNotification.find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((pageNumber - 1) * count)
        .limit(count)
        .lean(),
      statusCountsPromise,
      typeCountPromise,
      filterCountPromise,
    ]);
    // ✅ CHANGED — pagination.totalCount = ALL notifications of this role (never
    // changes with filter / isRead / notificationType / status / fromRole).
    // filteredCount = rows matching the request; totalPages follows it.
    const filteredCount = totalCount;
    const allCount = (filterCount.read?.totalCount || 0) + (filterCount.unread?.totalCount || 0);

    return successResponse(res, "Notifications fetched successfully", {
      ...counts,
      billingDateRevertStatusCount: { pendingCount, approvedCount, rejectedCount }, // ✅ NEW
      notificationTypeCount, // ✅ NEW — { normalApproval, overdueRemark }: total / read / unread
      filterCount, // ✅ NEW — per tab of this role: { totalCount, unreadCount }
      pagination: {
        pageNumber,
        count,
        totalCount: allCount,
        filteredCount,
        totalPages: Math.ceil(filteredCount / count),
      },
      notifications: (await withLandOwnerIds(rows)).map((n) => formatNotification(n, userObjectId)),
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /admin/cmd-notifications/count — unread count for the bell badge
// Role: Rental Executive / Rental Manager / CMD
// ─────────────────────────────────────────────────────────────
const getCmdNotificationCount = async (req, res) => {
  try {
    const role = ensureNotificationUser(req, res);
    if (!role) return;
    const counts = await getUnreadCounts(role, toObjectId(req.user.userId));
    return successResponse(res, "Notification count fetched successfully", counts);
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /admin/cmd-notifications/read
// Role: Rental Executive / Rental Manager / CMD — read for the logged-in user only
// body: { notificationId } or { notificationIds: [] }
// (billing date revert list: { requestId } / { requestIds: [] } still supported)
// ─────────────────────────────────────────────────────────────
const markCmdNotificationRead = async (req, res) => {
  try {
    const body = { ...(req.query || {}), ...(req.body || {}) };
    if (body.requestId !== undefined || body.requestIds !== undefined) {
      // lazy require: avoids a circular import
      const { markBillingDateRevertRead } = require("../MediaOnboardingController/BillingDateRevertController");
      return markBillingDateRevertRead(req, res);
    }

    const role = ensureNotificationUser(req, res);
    if (!role) return;
    const { notificationId, notificationIds } = body;
    const ids = (Array.isArray(notificationIds) ? notificationIds : [notificationIds || notificationId])
      .map(toObjectId)
      .filter(Boolean);
    if (ids.length === 0) {
      return errorResponse(res, "A valid notificationId or notificationIds[] is required", null, 400);
    }

    const userObjectId = toObjectId(req.user.userId);
    const result = await CmdNotification.updateMany(
      { _id: { $in: ids }, ...unreadFilterFor(role, userObjectId) },
      { $push: { readBy: { userId: userObjectId, readAt: nowIST() } } },
    );
    // ✅ NEW — remark notifications → that site + month's remarks read for this role
    const remarkRows = await CmdNotification.find({ _id: { $in: ids }, ...targetRoleFilter(role), ...overdueRemarkFilter })
      .select("mediaId dueMonth rentalDueId")
      .lean();
    await markOverdueRemarksReadForRole(remarkRows, role);
    const counts = await getUnreadCounts(role, userObjectId);

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
// Role: Rental Executive / Rental Manager / CMD
// body (optional): { notificationType } — only that type
// ─────────────────────────────────────────────────────────────
const markAllCmdNotificationsRead = async (req, res) => {
  try {
    const role = ensureNotificationUser(req, res);
    if (!role) return;
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const userObjectId = toObjectId(req.user.userId);
    // ✅ NEW — unread remark notifications covered by this read-all (no type, or
    // the remark type) → their remarks become read for this role
    const type = NOTIFICATION_TYPE_ALIAS[params.notificationType] || params.notificationType;
    const coversRemarks = !type || type === NOTIFICATION_TYPE.OVERDUE_REMARK;
    const remarkRows = coversRemarks
      ? await CmdNotification.find({ ...unreadFilterFor(role, userObjectId), ...overdueRemarkFilter })
          .select("mediaId dueMonth rentalDueId")
          .lean()
      : [];
    const result = await CmdNotification.updateMany(
      { ...unreadFilterFor(role, userObjectId), ...typeFilterFor(params.notificationType) },
      { $push: { readBy: { userId: userObjectId, readAt: nowIST() } } },
    );
    await markOverdueRemarksReadForRole(remarkRows, role);
    const counts = await getUnreadCounts(role, userObjectId);
    return successResponse(res, "All notifications marked as read", {
      updatedCount: result.modifiedCount || 0,
      ...counts,
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

    sendReminderPushNotification({
      media,
      dueMonth: month,
      rentalDueId: dues[dues.length - 1]._id,
      mediaDetailId: dues[dues.length - 1].mediaDetailId,
      role,
      userName,
      userId,
      siteCode: doc.siteCode,
      siteName: doc.siteName,
    }).catch((fcmErr) => {
      console.error("[CmdNotification] Reminder FCM push error:", fcmErr?.message || fcmErr);
    });

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

// ─────────────────────────────────────────────────────────────
// INTERNAL — called from RentalDueNew2Controller after an overdue remark is
// saved. Executive's remark → Manager + CMD, Manager's remark → Executive +
// CMD (read only); see OVERDUE_REMARK_NOTIFY_TARGETS.
// ONE row per site per month per receiver: a new remark updates it,
// increments remarkCount and makes it unread again. Never throws.
async function createOverdueRemarkNotification({ media, dueMonth, rentalDueId, mediaDetailId, remark, userType, userId, userName, attachments = [], replyTo = null }) {
  try {
    const role = Number(userType);
    const targets = OVERDUE_REMARK_NOTIFY_TARGETS[role] || [];
    if (!media?._id || targets.length === 0) return null;

    const month = dueMonth || "";
    const details = media.mediaDetails || [];
    const activeFaces = details.filter((d) => Number(d.status) === 1);
    const faces = mediaDetailId
      ? details.filter((d) => String(d._id) === String(mediaDetailId))
      : activeFaces.length
        ? activeFaces
        : details;
    const owners = media.landOwners || [];

    let displayRemark = remark || "";
    if (replyTo && (replyTo.addedBy || replyTo.remarks)) {
      const replySender = replyTo.addedBy || "User";
      const replyText = replyTo.remarks || "Attachment";
      displayRemark = `[Replying to ${replySender}: "${replyText}"] ${displayRemark}`.trim();
    }

    if (Array.isArray(attachments) && attachments.length > 0) {
      const attLabels = attachments.map((a) => {
        if (!a) return "";
        if (a.audioUrl || a.mimeType?.startsWith("audio/") || a.fileName?.includes("voice")) {
          return "Voice Message"; // ✅ CHANGED — no icon
        }
        if (a.fileType === "image" || a.mimeType?.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif)$/i.test(a.fileName || "")) {
          return `🖼 ${a.fileName || "Image"}`;
        }
        if (a.fileType === "pdf" || a.mimeType === "application/pdf" || /\.pdf$/i.test(a.fileName || "")) {
          return `📄 ${a.fileName || "PDF"}`;
        }
        return `📁 ${a.fileName || "Document"}`;
      }).filter(Boolean);

      if (attLabels.length > 0) {
        displayRemark = displayRemark ? `${displayRemark} (${attLabels.join(", ")})` : attLabels.join(", ");
      }
    }

    const message = `${ROLE_LABEL[role]} ${userName || ""} added an overdue remark${month ? ` for ${month}` : ""}`
      .replace(/\s+/g, " ")
      .trim();
    const now = nowIST();

    const isCombined = faces.length > 1 || details.length > 1;
    let siteCode = "";
    if (isCombined) {
      siteCode = "Combined Sites";
    } else if (faces.length === 1 && faces[0].mediaCode) {
      siteCode = faces[0].mediaCode;
    } else {
      siteCode = media.mediaCode || "SITE";
    }

    const siteName = isCombined
      ? "Combined Sites"
      : (faces.map((d) => d.mediaName).filter(Boolean).join(", ") || media.mediaName || "Site");

    const latestHistory = await OverDueHistory.findOne({
      mediaId: media._id,
      ...(month ? { dueMonth: month } : {}),
    }).sort({ updatedAt: -1 });

    let remarkId = "";
    if (latestHistory && Array.isArray(latestHistory.overDueRemarks) && latestHistory.overDueRemarks.length > 0) {
      const latestRemark = latestHistory.overDueRemarks[latestHistory.overDueRemarks.length - 1];
      remarkId = latestRemark?._id ? String(latestRemark._id) : "";
      latestHistory.fcmNotifiedAt = now;
      await latestHistory.save();
    }

    for (const targetRole of targets) {
      const dedupeKey = `overdueRemark:media:${String(media._id)}:${month}:to:${targetRole}`;
      await CmdNotification.updateOne(
        { dedupeKey },
        {
          $set: {
            mediaDetailId: toObjectId(mediaDetailId),
            mediaDetailIds: faces.map((d) => toObjectId(d._id)).filter(Boolean),
            rentalDueId: toObjectId(rentalDueId),
            landOwnerName: owners.map((o) => o.name).filter(Boolean).join(", "),
            landOwnerMasterIds: owners.map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean),
            siteName: siteName,
            siteCode: siteCode,
            message,
            remarks: displayRemark || "Overdue remark updated",
            remarkedBy: userName || "",
            remarkedByRole: role,
            remarkedByUserId: toObjectId(userId),
            remarkedAt: now,
            remarkId: remarkId || "",
            readBy: [], // new remark → unread again
            updatedAt: now,
          },
          $inc: { remarkCount: 1 },
          $setOnInsert: {
            targetRole,
            notificationType: NOTIFICATION_TYPE.OVERDUE_REMARK,
            mediaId: media._id,
            dueMonth: month,
            dedupeKey,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    }

    // Trigger FCM push notification to target roles (excluding author)
    sendOverdueRemarkPushNotification({
      media,
      dueMonth: month,
      rentalDueId,
      mediaDetailId,
      remark: displayRemark,
      senderName: userName,
      senderRoleName: ROLE_LABEL[role] || "User",
      senderUserId: userId,
      targetRoles: targets,
      siteCode,
      siteName,
      remarkId,
    }).catch((fcmErr) => {
      console.error("[CmdNotification] FCM push error:", fcmErr?.message || fcmErr);
    });

    return true;
  } catch (err) {
    if (err?.code !== 11000) {
      console.error("[CmdNotification] overdue remark notify failed:", err.message);
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// AUTO DELETE — Rental Executive / Rental Manager / CMD notifications that were
// READ more than CMD_NOTIFICATION_READ_RETENTION_MINUTES (default 1440 = 1 day; set in .env)
// ago are deleted. UNREAD notifications (readBy empty — including rows made unread
// again by a new approval / reminder / remark) are never deleted.
// Run hourly from server.js. Only notification rows are removed — rental dues,
// approvals and billing date revert requests are never touched.
// ─────────────────────────────────────────────────────────────
async function purgeOldCmdNotifications() {
  const minutes = parseFloat(process.env.CMD_NOTIFICATION_READ_RETENTION_MINUTES || "1440") || 1440;
  // readAt is stored with nowIST(), so compare on the same clock
  const cutoff = new Date(nowIST().getTime() - minutes * 60 * 1000);
  const result = await CmdNotification.deleteMany({
    targetRole: { $in: [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.RENTAL_MANAGER, USER_ROLE.CMD, null] },
    "readBy.0": { $exists: true }, // read at least once
    readBy: { $not: { $elemMatch: { readAt: { $gte: cutoff } } } }, // every read is older than the cutoff
  });
  // ✅ NEW — CMD's own copies of revert requests the CMD already approved /
  // rejected (rows from before that removal existed); read or unread
  const decided = await CmdNotification.deleteMany({
    notificationType: NOTIFICATION_TYPE.BILLING_DATE_REVERT,
    ...targetRoleFilter(USER_ROLE.CMD),
    revertStatus: { $in: [2, 3] },
  });
  return { deleted: (result.deletedCount || 0) + (decided.deletedCount || 0) };
}

module.exports = {
  purgeOldCmdNotifications,
  createRentalApprovalNotification,
  createOverdueRemarkNotification,
  createBillingDateRevertNotification,
  refreshBillingDateRevertNotification,
  updateBillingDateRevertNotificationStatus,
  sendCmdReminder,
  getCmdNotifications,
  getCmdNotificationCount,
  markCmdNotificationRead,
  markAllCmdNotificationsRead,
};
