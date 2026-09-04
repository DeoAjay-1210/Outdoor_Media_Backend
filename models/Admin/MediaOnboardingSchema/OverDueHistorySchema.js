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
