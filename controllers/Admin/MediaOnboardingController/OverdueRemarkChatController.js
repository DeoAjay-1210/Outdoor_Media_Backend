// ─────────────────────────────────────────────────────────────
// Overdue remark chat — moved from RentalDueNew2Controller (same code).
// Routes: /admin/overdue-remark/edit | delete | undo-delete | pin |
//         read-receipt | message-info | edit-history
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const OverDueHistory = require("../../../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { nowIST } = require("../../../utils/updatedAt");

// ✅ NEW — response only: editedAt saved earlier in UTC gets +5:30 so it
// matches addedAt (IST). Entries saved in IST are flagged and left as they are.
const EDIT_IST_MS = 330 * 60000;
function istRemarkEditTimes(remark) {
  if (!remark) return remark;
  const shift = (d) => (d ? new Date(new Date(d).getTime() + EDIT_IST_MS) : d);
  if (remark.editedAt && !remark.editedAtIst) remark.editedAt = shift(remark.editedAt);
  delete remark.editedAtIst;
  if (Array.isArray(remark.editHistory)) {
    remark.editHistory = remark.editHistory.map((h) => {
      const { istTime, ...rest } = h || {};
      return istTime ? rest : { ...rest, editedAt: shift(rest.editedAt) };
    });
  }
  return remark;
}

// ─────────────────────────────────────────────────────────────
// CHAT ENHANCEMENTS: EDIT, DELETE, UNDO, PIN, READ RECEIPTS, MSG INFO, EDIT HISTORY
// ─────────────────────────────────────────────────────────────

exports.editOverdueRemark = async (req, res) => {
  try {
    const { remarkId, newRemarks } = req.body;
    const userName = req.user?.userName || "User";
    const userType = Number(req.user?.userType);

    if (!remarkId || !newRemarks || !newRemarks.trim()) {
      return res.status(400).json({ success: false, message: "Remark ID and new remarks are required" });
    }

    const record = await OverDueHistory.findOne({ "overDueRemarks._id": remarkId });
    if (!record) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    const remark = record.overDueRemarks.id(remarkId);
    if (!remark) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    // Check ownership unless CMD
    if (remark.addedBy !== userName && userType !== 3) {
      return res.status(403).json({ success: false, message: "You can only edit your own messages" });
    }

    // Check 2-hour window (7200000 ms)
    const addedAtMs = new Date(remark.addedAt).getTime();
    if (Date.now() - addedAtMs > 2 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, message: "Editing window expired (2 hours max)" });
    }

    remark.originalRemarks = remark.originalRemarks || remark.remarks;
    remark.editHistory.push({
      previousRemarks: remark.remarks,
      updatedRemarks: newRemarks.trim(),
      editedBy: userName,
      editedAt: nowIST(), // ✅ CHANGED — IST, same as addedAt
      istTime: true,
    });

    remark.remarks = newRemarks.trim();
    remark.isEdited = true;
    remark.editedAt = nowIST(); // ✅ CHANGED — IST, same as addedAt
    remark.editedAtIst = true;
    remark.editedBy = userName;

    await record.save();

    return res.status(200).json({
      success: true,
      message: "Remark edited successfully",
      data: istRemarkEditTimes(remark.toObject()),
    });
  } catch (err) {
    console.error("editOverdueRemark error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.deleteOverdueRemark = async (req, res) => {
  try {
    const { remarkId } = req.body;
    const userName = req.user?.userName || "User";
    const userType = Number(req.user?.userType);

    if (!remarkId) {
      return res.status(400).json({ success: false, message: "Remark ID is required" });
    }

    const record = await OverDueHistory.findOne({ "overDueRemarks._id": remarkId });
    if (!record) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    const remark = record.overDueRemarks.id(remarkId);
    if (!remark) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    if (remark.addedBy !== userName && userType !== 3) {
      return res.status(403).json({ success: false, message: "You can only delete your own messages" });
    }

    remark.isDeleted = true;
    remark.deletedAt = new Date();
    remark.deletedBy = userName;
    remark.undoUntil = new Date(Date.now() + 15000); // 15 seconds undo window

    await record.save();

    return res.status(200).json({
      success: true,
      message: "Remark deleted successfully",
      data: { remarkId, undoUntil: remark.undoUntil },
    });
  } catch (err) {
    console.error("deleteOverdueRemark error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.undoDeleteOverdueRemark = async (req, res) => {
  try {
    const { remarkId } = req.body;
    if (!remarkId) {
      return res.status(400).json({ success: false, message: "Remark ID is required" });
    }

    const record = await OverDueHistory.findOne({ "overDueRemarks._id": remarkId });
    if (!record) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    const remark = record.overDueRemarks.id(remarkId);
    if (!remark || !remark.isDeleted) {
      return res.status(400).json({ success: false, message: "Message is not deleted" });
    }

    if (remark.undoUntil && new Date(remark.undoUntil).getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: "Undo window has expired" });
    }

    remark.isDeleted = false;
    remark.deletedAt = null;
    remark.deletedBy = "";
    remark.undoUntil = null;

    await record.save();

    return res.status(200).json({
      success: true,
      message: "Message restored successfully",
      data: remark,
    });
  } catch (err) {
    console.error("undoDeleteOverdueRemark error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.pinOverdueRemark = async (req, res) => {
  try {
    const { remarkId, duration } = req.body; // '24h', '7d', '30d', 'unpin'
    const userName = req.user?.userName || "User";

    if (!remarkId) {
      return res.status(400).json({ success: false, message: "Remark ID is required" });
    }

    const record = await OverDueHistory.findOne({ "overDueRemarks._id": remarkId });
    if (!record) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    const remark = record.overDueRemarks.id(remarkId);
    if (!remark) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    if (duration === "unpin") {
      remark.isPinned = false;
      remark.pinExpiresAt = null;
      remark.pinnedBy = "";
    } else {
      let durationMs = 24 * 60 * 60 * 1000;
      if (duration === "7d") durationMs = 7 * 24 * 60 * 60 * 1000;
      if (duration === "30d") durationMs = 30 * 24 * 60 * 60 * 1000;

      // Unpin any previously pinned remarks for this record
      record.overDueRemarks.forEach((r) => {
        if (r._id.toString() !== String(remarkId)) r.isPinned = false;
      });

      remark.isPinned = true;
      remark.pinnedAt = new Date();
      remark.pinnedBy = userName;
      remark.pinExpiresAt = new Date(Date.now() + durationMs);
    }

    await record.save();

    return res.status(200).json({
      success: true,
      message: duration === "unpin" ? "Unpinned successfully" : "Pinned successfully",
      data: remark,
    });
  } catch (err) {
    console.error("pinOverdueRemark error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ✅ NEW — overdue remark receivers: Rental Executive (1), Rental Manager (2)
// and CMD (3), except the sender's own role and the sender.
// Sender role unknown (older remarks) → any other user, as before.
const OVERDUE_REMARK_ROLES = [1, 2, 3];
function isOverdueRemarkRecipient(remark, userId, userType) {
  if (userId && remark?.addedByUserId && String(remark.addedByUserId) === String(userId)) return false;
  const senderRole = Number(remark?.role || remark?.userType || 0);
  if (!senderRole) return true;
  return OVERDUE_REMARK_ROLES.includes(Number(userType)) && Number(userType) !== senderRole;
}

// ✅ NEW — every user of the receiving roles → deliveredTo entries.
// Sender role unknown → [] (older behaviour: delivered when read).
async function overdueRemarkReceivers(senderRole, senderUserId, at) {
  const role = Number(senderRole || 0);
  if (!OVERDUE_REMARK_ROLES.includes(role)) return [];
  const UserModel = require("../../../models/Admin/UserSchema/UserSchema");
  const users = await UserModel.find(
    { userType: { $in: OVERDUE_REMARK_ROLES.filter((r) => r !== role) } },
    "userName userType",
  ).lean();
  return users
    .filter((u) => !senderUserId || String(u._id) !== String(senderUserId))
    .map((u) => ({ userId: String(u._id), userName: u.userName || "", deliveredAt: at || nowIST(), userType: Number(u.userType), istTime: true }));
}

exports.markOverdueRemarkRead = async (req, res) => {
  try {
    const { remarkId, mediaId } = req.body;
    const userId = String(req.user?._id || req.user?.userId || req.user?.id || "");
    const userName = req.user?.userName || "User";
    const userType = Number(req.user?.userType);

    const query = {};
    if (remarkId) query["overDueRemarks._id"] = remarkId;
    else if (mediaId) query.mediaId = mediaId;

    const records = await OverDueHistory.find(query);
    let updatedCount = 0;

    for (const record of records) {
      let changed = false;
      record.overDueRemarks.forEach((r) => {
        if (!remarkId || r._id.toString() === String(remarkId)) {
          // ✅ NEW — token based: a remark is delivered only to the OTHER roles
          // (RE → RM + CMD, RM → RE + CMD, CMD → RE + RM). The sender's own role
          // (and the sender) are not added to deliveredTo / readBy.
          const isRecipient = isOverdueRemarkRecipient(r, userId, userType);
          if (isRecipient && userId && !r.deliveredTo.some((d) => d.userId === userId)) {
            r.deliveredTo.push({ userId, userName, deliveredAt: nowIST(), userType: userType || null, istTime: true });
            changed = true;
          }
          if (isRecipient && userId && !r.readBy.some((rd) => rd.userId === userId)) {
            r.readBy.push({ userId, userName, readAt: nowIST(), userType: userType || null, istTime: true });
            changed = true;
          }
          if (userType && (!Array.isArray(r.readByRoles) || !r.readByRoles.includes(userType))) {
            r.readByRoles = r.readByRoles || [];
            r.readByRoles.push(userType);
            changed = true;
          }
          updatedCount++;
        }
      });
      if (changed) await record.save();
    }

    return res.status(200).json({
      success: true,
      message: "Read status updated",
      data: { updatedCount },
    });
  } catch (err) {
    console.error("markOverdueRemarkRead error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getMessageInfo = async (req, res) => {
  try {
    const remarkId = req.query.remarkId || req.body?.remarkId;
    if (!remarkId) {
      return res.status(400).json({ success: false, message: "Remark ID is required" });
    }

    const record = await OverDueHistory.findOne({ "overDueRemarks._id": remarkId }).lean();
    if (!record) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    const remark = record.overDueRemarks.find((r) => r._id.toString() === String(remarkId));
    if (!remark) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }
    istRemarkEditTimes(remark); // ✅ NEW — editedAt in IST, same as addedAt

    // ✅ NEW — only the receiving roles show (RE → RM + CMD, RM → RE + CMD,
    // CMD → RE + RM). Older entries saved without a role get it from Users.
    const delivered = remark.deliveredTo || [];
    const read = remark.readBy || [];
    const missingIds = [...delivered, ...read]
      .filter((d) => d && !d.userType && mongoose.Types.ObjectId.isValid(String(d.userId || "")))
      .map((d) => String(d.userId));
    const roleById = new Map();
    if (missingIds.length) {
      const UserModel = require("../../../models/Admin/UserSchema/UserSchema");
      const users = await UserModel.find({ _id: { $in: [...new Set(missingIds)] } }, "userType").lean();
      users.forEach((u) => roleById.set(String(u._id), Number(u.userType)));
    }
    const receivers = (list) =>
      list.filter((d) => isOverdueRemarkRecipient(remark, d?.userId, Number(d?.userType || roleById.get(String(d?.userId)) || 0)));
    remark.deliveredTo = receivers(delivered);
    remark.readBy = receivers(read);
    // ✅ NEW — delivered to every user of the receiving roles (also older
    // remarks): stored delivery time kept, otherwise the remark's send time
    const allReceivers = await overdueRemarkReceivers(remark.role || remark.userType, remark.addedByUserId, remark.addedAt);
    if (allReceivers.length) {
      const stored = new Map(remark.deliveredTo.map((d) => [String(d.userId), d]));
      remark.deliveredTo = allReceivers
        .filter((u) => u.userName !== remark.addedBy || stored.has(u.userId))
        .map((u) => ({ ...u, ...(stored.get(u.userId) || {}), userType: u.userType }));
    }
    // ✅ NEW — same IST time as addedAt: entries saved earlier in UTC get +5:30
    // (response only — stored data is not changed)
    const IST_MS = 330 * 60000;
    const sentAt = remark.addedAt ? new Date(remark.addedAt).getTime() : null;
    const toIst = (list, key) =>
      list.map((d) => {
        const { istTime, ...rest } = d || {};
        const t = rest[key] ? new Date(rest[key]).getTime() : null;
        if (istTime || t === null || t === sentAt) return rest;
        return { ...rest, [key]: new Date(t + IST_MS) };
      });
    remark.deliveredTo = toIst(remark.deliveredTo, "deliveredAt");
    remark.readBy = toIst(remark.readBy, "readAt");

    return res.status(200).json({
      success: true,
      message: "Message info fetched",
      data: {
        remarkId: remark._id,
        remarks: remark.remarks,
        addedBy: remark.addedBy,
        addedAt: remark.addedAt,
        deliveredTo: remark.deliveredTo || [],
        readBy: remark.readBy || [],
        isEdited: remark.isEdited || false,
        editedAt: remark.editedAt || null,
        isPinned: remark.isPinned || false,
        pinExpiresAt: remark.pinExpiresAt || null,
        attachments: remark.attachments || [],
        voiceMessage: remark.voiceMessage || null,
      },
    });
  } catch (err) {
    console.error("getMessageInfo error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getEditHistory = async (req, res) => {
  try {
    const userType = Number(req.user?.userType);
    if (userType !== 3) {
      return res.status(403).json({ success: false, message: "Access denied. CMD permission required." });
    }

    const remarkId = req.query.remarkId || req.body?.remarkId;
    if (!remarkId) {
      return res.status(400).json({ success: false, message: "Remark ID is required" });
    }

    const record = await OverDueHistory.findOne({ "overDueRemarks._id": remarkId }).lean();
    if (!record) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }

    const remark = record.overDueRemarks.find((r) => r._id.toString() === String(remarkId));
    if (!remark) {
      return res.status(404).json({ success: false, message: "Remark not found" });
    }
    istRemarkEditTimes(remark); // ✅ NEW — editedAt in IST, same as addedAt

    return res.status(200).json({
      success: true,
      message: "Edit history fetched",
      data: {
        remarkId: remark._id,
        currentRemarks: remark.remarks,
        originalRemarks: remark.originalRemarks || remark.remarks,
        editedBy: remark.editedBy,
        editedAt: remark.editedAt,
        editHistory: remark.editHistory || [],
      },
    });
  } catch (err) {
    console.error("getEditHistory error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.overdueRemarkReceivers = overdueRemarkReceivers; // used by RentalDueNew2Controller (add remark)
exports.istRemarkEditTimes = istRemarkEditTimes; // used by RentalDueNew2Controller (remarks list)
