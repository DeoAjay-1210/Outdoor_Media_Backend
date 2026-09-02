const mongoose = require("mongoose");

const overDueHistorySchema = new mongoose.Schema(
  {
    mediaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MediaOnboarding",
      required: true,
    },
    mediaName: { type: String, trim: true },
    mediaCode: { type: String, trim: true },
    previousBillDate: { type: Date },
    currentBillDate: { type: Date },
    nextBillDate: { type: Date },
    overDueAmount: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    isGstApplicable: { type: Boolean, default: false },
    approvedDate: { type: Date, default: Date.now },
    removedDate: { type: Date, default: Date.now },
    dueMonth: { type: String, trim: true },
    dueDate: { type: Date },
    rentalDueId: { type: mongoose.Schema.Types.ObjectId },
    withGst: { type: Number, default: 0 },
    ledgerEntryDate: { type: Date, default: null },
    gstEntryDate: { type: Date, default: null },
    status: { type: Number },
    updatedBy: { type: String },
    createdAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

module.exports = mongoose.model("OverDueHistory", overDueHistorySchema);
