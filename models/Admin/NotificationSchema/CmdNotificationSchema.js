const mongoose = require("mongoose");
const { nowIST } = require("../../../utils/updatedAt");

// ─────────────────────────────────────────────────────────────
// CMD NOTIFICATION
// One record per site-wise rental-due approval done by a
// Rental Executive (userType 1) or Rental Manager (userType 2).
// Targeted at the CMD role (userType 3); read/unread is tracked
// per CMD user in readBy[] so multiple CMD users each get their
// own unread count.
// ─────────────────────────────────────────────────────────────
const readBySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
    readAt: { type: Date, default: nowIST },
  },
  { _id: false },
);

// one item per approving role (latest approval of that role)
const approvalSchema = new mongoose.Schema(
  {
    role: { type: Number, enum: [1, 2] }, // 1 = Rental Executive, 2 = Rental Manager
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    userName: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },
  },
  { _id: false },
);

const cmdNotificationSchema = new mongoose.Schema(
  {
    // 3 = CMD (same userType values as UserSchema)
    targetRole: { type: Number, enum: [3], default: 3 },

    // site / cycle references
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "MediaOnboarding", required: true },
    mediaDetailId: { type: mongoose.Schema.Types.ObjectId, default: null },
    rentalDueId: { type: mongoose.Schema.Types.ObjectId, default: null },
    dueMonth: { type: String, trim: true, default: "" },

    // display data (snapshot at approval time)
    landOwnerName: { type: String, trim: true, default: "" },
    landOwnerMasterIds: [{ type: mongoose.Schema.Types.ObjectId }],
    siteName: { type: String, trim: true, default: "" },
    siteCode: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },

    // latest approval (Executive first, then updated when Manager approves)
    approvedByRole: { type: Number, enum: [1, 2] }, // 1 = Rental Executive, 2 = Rental Manager
    approvedByUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedByName: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },

    // every role's approval for this site/cycle
    approvals: { type: [approvalSchema], default: [] },

    readBy: { type: [readBySchema], default: [] },

    // "rentalDue:<rentalDueId>" — ONE notification per site-wise rental due
    // (Executive + Manager approvals update the same record, never duplicate)
    dedupeKey: { type: String, required: true, unique: true },

    createdAt: { type: Date, default: nowIST },
    updatedAt: { type: Date, default: nowIST },
  },
  { timestamps: false },
);

cmdNotificationSchema.index({ targetRole: 1, updatedAt: -1 });
cmdNotificationSchema.index({ rentalDueId: 1 });
cmdNotificationSchema.index({ "readBy.userId": 1 });

module.exports = mongoose.model("CmdNotification", cmdNotificationSchema);
