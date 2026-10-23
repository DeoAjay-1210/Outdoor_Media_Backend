const mongoose = require("mongoose");

const overDueHistorySchema = new mongoose.Schema(
  {
    mediaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MediaOnboarding",
      required: true,
    },
    mediaDetails: [
      {
        mediaCode: { type: String, trim: true },
        mediaName: { type: String, trim: true },
        mediaType: { type: String, trim: true },
        city: { type: String, trim: true },
        location: { type: String, trim: true },
      },
    ],
    landOwners: [
      {
        landOwnerMasterId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "LandOwnerMaster",
          default: null,
        },
        name: { type: String, trim: true },
        landOwnerName: { type: String, trim: true },
        phone: { type: String, trim: true },
        panNumber: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        bankName: { type: String, trim: true },
        ifsc: { type: String, trim: true },
        paymentCategory: { type: Number },
        sharePercentage: { type: Number },
        shareAmount: { type: Number },
        gstApplicable: { type: Number },
        gstAmount: { type: Number },
      },
    ],
    previousBillDate: { type: Date },
    currentBillDate: { type: Date },
    nextBillDate: { type: Date },
    overDueAmount: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    isGstApplicable: { type: Boolean, default: false },
    approvedDate: { type: Date, default: Date.now },
    removedDate: { type: Date, default: Date.now },
    staffApprovedAt: { type: Date, default: null },
    staffApprovedBy: { type: String, trim: true, default: null },
    teamLeadApprovedAt: { type: Date, default: null },
    teamLeadApprovedBy: { type: String, trim: true, default: null },
    ownerApprovedAt: { type: Date, default: null },
    ownerApprovedBy: { type: String, trim: true, default: null },
    OverdueByStaff: { type: String, trim: true, default: "-" },
    OverdueByTeamLead: { type: String, trim: true, default: "-" },
    OverdueByCMD: { type: String, trim: true, default: "-" },
    approvalOverdueBy: { type: String, trim: true, default: "-" },
    dueMonth: { type: String, trim: true },
    dueDate: { type: Date },
    rentalDueId: { type: mongoose.Schema.Types.ObjectId },
    withGst: { type: Number, default: 0 },
    ledgerEntryDate: { type: Date, default: null },
    gstEntryDate: { type: Date, default: null },
    status: { type: Number },
    remarks: { type: String, trim: true, default: "" },
    overDueRemarks: [
      {
        mediaDetailId: { type: mongoose.Schema.Types.ObjectId, default: null },
        landOwnerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        remarks: { type: String, trim: true },
        addedBy: { type: String, trim: true },
        addedByUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
        addedAt: { type: Date, default: Date.now },
        userType: { type: Number, default: null },
        role: { type: Number, default: null },
        readByRoles: { type: [Number], default: undefined },

        // Reply Reference
        replyTo: {
          messageId: { type: String, default: null },
          remarks: { type: String, default: "" },
          addedBy: { type: String, default: "" },
        },

        // Edit History & Restrictions
        isEdited: { type: Boolean, default: false },
        editedAt: { type: Date, default: null },
        editedAtIst: { type: Boolean, default: undefined }, // ✅ NEW — true = editedAt saved in IST (same as addedAt)
        editedBy: { type: String, default: "" },
        originalRemarks: { type: String, default: "" },
        editHistory: [
          {
            previousRemarks: { type: String },
            updatedRemarks: { type: String },
            editedBy: { type: String },
            editedAt: { type: Date, default: Date.now },
            istTime: { type: Boolean, default: undefined }, // ✅ NEW — true = editedAt saved in IST (same as addedAt)
          },
        ],

        // Deletion & Reversion
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date, default: null },
        deletedBy: { type: String, default: "" },
        undoUntil: { type: Date, default: null },

        // Pinning
        isPinned: { type: Boolean, default: false },
        pinnedAt: { type: Date, default: null },
        pinnedBy: { type: String, default: "" },
        pinExpiresAt: { type: Date, default: null },

        // Delivery & Read Receipts
        deliveredTo: [
          {
            userId: { type: String },
            userName: { type: String },
            deliveredAt: { type: Date, default: Date.now },
            userType: { type: Number, default: null }, // ✅ NEW — reader's role (from the token)
            istTime: { type: Boolean, default: undefined }, // ✅ NEW — true = deliveredAt saved in IST (same as addedAt)
          },
        ],
        readBy: [
          {
            userId: { type: String },
            userName: { type: String },
            readAt: { type: Date, default: Date.now },
            userType: { type: Number, default: null }, // ✅ NEW — reader's role (from the token)
            istTime: { type: Boolean, default: undefined }, // ✅ NEW — true = readAt saved in IST (same as addedAt)
          },
        ],

        // Attachments
        attachments: [
          {
            fileUrl: { type: String },
            fileName: { type: String },
            fileType: { type: String },
            fileSize: { type: Number, default: 0 },
            mimeType: { type: String },
            caption: { type: String, default: "" },
          },
        ],

        // Voice Message
        voiceMessage: {
          audioUrl: { type: String, default: null },
          duration: { type: Number, default: 0 },
          mimeType: { type: String, default: "" },
        },
      },
    ],
    fcmNotifiedAt: { type: Date, default: null },
    updatedBy: { type: String },
    createdAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

module.exports = mongoose.model("OverDueHistory", overDueHistorySchema);
