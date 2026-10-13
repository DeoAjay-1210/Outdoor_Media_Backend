const mongoose = require("mongoose");
const { nowIST } = require("../../../utils/updatedAt");

// ─────────────────────────────────────────────────────────────
// RENTAL DUE CHANGE HISTORY
// One record per saveRentalDue save that changed campaignName, reason,
// proofOfCampaign or invoice of a rental due bill. Kept in its own
// collection — the MediaOnboarding document is never touched by it.
// ─────────────────────────────────────────────────────────────
const changeSchema = new mongoose.Schema(
  {
    fieldName: {
      type: String,
      enum: ["campaignName", "reason", "proofOfCampaign", "invoice"],
      required: true,
    },
    // text fields → the text; files → the file name
    oldValue: { type: String, default: null },
    newValue: { type: String, default: null },
    // files only — full links, kept for reference
    oldFilePath: { type: String, default: null },
    newFilePath: { type: String, default: null },
  },
  { _id: false },
);

const rentalDueChangeHistorySchema = new mongoose.Schema(
  {
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "MediaOnboarding", required: true },
    rentalDueId: { type: mongoose.Schema.Types.ObjectId, required: true },
    mediaDetailId: { type: mongoose.Schema.Types.ObjectId, default: null },
    dueMonth: { type: String, trim: true, default: "" },
    dueDate: { type: Date, default: null },
    changes: { type: [changeSchema], default: [] },
    updatedBy: { type: String, trim: true, default: "" },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByRole: { type: Number, enum: [1, 2, 3, null], default: null }, // 1=Rental Executive 2=Rental Manager 3=CMD
    createdAt: { type: Date, default: nowIST },
  },
  { timestamps: false },
);

rentalDueChangeHistorySchema.index({ mediaId: 1, dueDate: -1, createdAt: 1 });
rentalDueChangeHistorySchema.index({ rentalDueId: 1, createdAt: 1 });

module.exports = mongoose.model("RentalDueChangeHistory", rentalDueChangeHistorySchema);
