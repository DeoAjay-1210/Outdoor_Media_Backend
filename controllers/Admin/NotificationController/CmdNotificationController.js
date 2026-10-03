const mongoose = require("mongoose");
const CmdNotification = require("../../../models/Admin/NotificationSchema/CmdNotificationSchema");
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

    // site-wise: the face this rental due belongs to, else the site's active faces
    const details = media.mediaDetails || [];
    const face = entry.mediaDetailId
      ? details.find((d) => String(d._id) === String(entry.mediaDetailId))
      : null;
    const faces = face ? [face] : details.filter((d) => Number(d.status) === 1);
    const siteName = faces.map((d) => d.mediaName).filter(Boolean).join(", ") || media.mediaName || "";
    const siteCode = faces.map((d) => d.mediaCode).filter(Boolean).join(" / ") || media.mediaCode || "";

    const owners = media.landOwners || [];
    const landOwnerName = owners.map((o) => o.name).filter(Boolean).join(", ");
    const landOwnerMasterIds = owners.map((o) => toObjectId(o.landOwnerMasterId)).filter(Boolean);

    const roleLabel = APPROVER_ROLE_LABEL[role];
    const message = `${roleLabel} ${userName || ""} approved rental due${entry.dueMonth ? ` for ${entry.dueMonth}` : ""} — ${siteName} (${siteCode})`
      .replace(/\s+/g, " ")
      .trim();

    // ONE notification per site-wise rental due: the Manager's approval
    // updates the Executive's notification instead of adding a second one.
    const dedupeKey = `rentalDue:${String(entry._id)}`;
    const approvalItem = {
      role,
      userId: toObjectId(userId),
      userName: userName || "",
      approvedAt,
    };
    const latestFields = {
      mediaId: media._id,
      mediaDetailId: toObjectId(entry.mediaDetailId),
      dueMonth: entry.dueMonth || "",
      landOwnerName,
      landOwnerMasterIds,
      siteName,
      siteCode,
      message,
      approvedByRole: role,
      approvedByUserId: approvalItem.userId,
      approvedByName: approvalItem.userName,
      approvedAt,
    };

    const existing = await CmdNotification.findOne({ rentalDueId: entry._id })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (existing) {
      // same approval processed again → already notified, keep read status
      const alreadyNotified = (existing.approvals || []).some(
        (a) => a.role === role && new Date(a.approvedAt).getTime() === approvedAt.getTime(),
      );
      if (alreadyNotified) return existing.dedupeKey;

      // keep one record per site: drop any older duplicates first
      await CmdNotification.deleteMany({ rentalDueId: entry._id, _id: { $ne: existing._id } });

      await CmdNotification.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...latestFields,
            approvals: [...(existing.approvals || []).filter((a) => a.role !== role), approvalItem],
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
          rentalDueId: entry._id,
          ...latestFields,
          approvals: [approvalItem],
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

const formatNotification = (n, userObjectId) => ({
  notificationId: n._id,
  landOwnerName: n.landOwnerName,
  siteName: n.siteName,
  siteCode: n.siteCode,
  message: n.message,
  dueMonth: n.dueMonth,
  approvedByRole: n.approvedByRole,
  approvedByName: n.approvedByName,
  approvedAt: n.approvedAt,
  mediaId: n.mediaId,
  mediaDetailId: n.mediaDetailId,
  rentalDueId: n.rentalDueId,
  approvals: (n.approvals || []).map((a) => ({
    role: a.role,
    roleName: APPROVER_ROLE_LABEL[a.role] || "",
    userName: a.userName,
    approvedAt: a.approvedAt,
  })),
  isRead: (n.readBy || []).some((r) => String(r.userId) === String(userObjectId)),
  createdAt: n.createdAt,
  updatedAt: n.updatedAt || n.createdAt,
});

// ─────────────────────────────────────────────────────────────
// POST/GET /admin/cmd-notifications
// body/query: pageNumber, count, isRead (true/false — optional filter)
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

    const [totalCount, overallCount, rows] = await Promise.all([
      CmdNotification.countDocuments(filter),
      CmdNotification.countDocuments(unreadFilterFor(userObjectId)),
      CmdNotification.find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((pageNumber - 1) * count)
        .limit(count)
        .lean(),
    ]);

    return successResponse(res, "CMD notifications fetched successfully", {
      overallCount,
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
    const overallCount = await CmdNotification.countDocuments(
      unreadFilterFor(toObjectId(req.user.userId)),
    );
    return successResponse(res, "CMD notification count fetched successfully", { overallCount });
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
    const overallCount = await CmdNotification.countDocuments(unreadFilterFor(userObjectId));

    return successResponse(res, "Notification(s) marked as read", {
      updatedCount: result.modifiedCount || 0,
      overallCount,
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
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

module.exports = {
  createRentalApprovalNotification,
  getCmdNotifications,
  getCmdNotificationCount,
  markCmdNotificationRead,
  markAllCmdNotificationsRead,
};
