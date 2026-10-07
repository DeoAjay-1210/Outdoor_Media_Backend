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

const cmdNotificationSchema = new mongoose.Schema(
  {
    // 3 = CMD (same userType values as UserSchema)
    targetRole: { type: Number, enum: [3], default: 3 },

    // "normalApproval" = Executive / Manager approval notification
    // "reminder"       = Executive / Manager reminded CMD to approve a site
    notificationType: {
      type: String,
      enum: ["normalApproval", "reminder"],
      default: "normalApproval",
    },

    // site / cycle references
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "MediaOnboarding", required: true },
    mediaDetailId: { type: mongoose.Schema.Types.ObjectId, default: null }, // latest approved face
    mediaDetailIds: [{ type: mongoose.Schema.Types.ObjectId }], // every approved face of this site/month
    rentalDueId: { type: mongoose.Schema.Types.ObjectId, default: null },
    dueMonth: { type: String, trim: true, default: "" },

    // display data (snapshot at approval time)
    landOwnerName: { type: String, trim: true, default: "" },
    landOwnerMasterIds: [{ type: mongoose.Schema.Types.ObjectId }],
    siteName: { type: String, trim: true, default: "" },
    siteCode: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },

    // who approved this row (one row per role: 1 = Executive, 2 = Manager)
    approvedByRole: { type: Number, enum: [1, 2] }, // 1 = Rental Executive, 2 = Rental Manager
    approvedByUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedByName: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },

    // reminder rows only — one row per site per month; each new reminder
    // increments reminderCount and makes it unread again
    reminderCount: { type: Number, default: 0 },
    remarks: { type: String, trim: true, default: "" },
    lastRemindedBy: { type: String, trim: true, default: "" },
    lastRemindedByRole: { type: Number, enum: [1, 2, null], default: null },
    lastRemindedByUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastRemindedAt: { type: Date, default: null },

    readBy: { type: [readBySchema], default: [] },

    // "media:<mediaId>:<dueMonth>:role:<role>" — ONE notification per site
    // (mediaId) per month per approving role; every face of the site merges
    // into its role row, never duplicates.
    // "reminder:media:<mediaId>:<dueMonth>" — ONE reminder row per site per month
    dedupeKey: { type: String, required: true, unique: true },

    createdAt: { type: Date, default: nowIST },
    updatedAt: { type: Date, default: nowIST },
  },
  { timestamps: false },
);

cmdNotificationSchema.index({ targetRole: 1, updatedAt: -1 });
cmdNotificationSchema.index({ rentalDueId: 1 });
cmdNotificationSchema.index({ mediaId: 1, dueMonth: 1 });
cmdNotificationSchema.index({ notificationType: 1 });
cmdNotificationSchema.index({ "readBy.userId": 1 });

module.exports = mongoose.model("CmdNotification", cmdNotificationSchema);
