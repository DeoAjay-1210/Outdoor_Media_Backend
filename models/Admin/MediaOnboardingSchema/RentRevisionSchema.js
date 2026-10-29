const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// ✅ NEW — Rent revision (POST /admin/rent-revision)
// Site rent changed from a past month (fromMonth) onwards. Approved by
// Rental Executive (1) → Rental Manager (2) → CMD (3); every approval is
// stored. Applied on CMD approval:
//   • bills already CMD approved (fromMonth onwards) → separate arrears bill
//   • pending bills (fromMonth onwards) → updated to the new rent
//   • site rent → new rent
// ─────────────────────────────────────────────────────────────
const revisionStepSchema = new mongoose.Schema(
  {
    role: { type: Number, enum: [1, 2, 3], required: true },
    roleName: { type: String, trim: true },
    // Skipped = CMD approved / rejected directly before this role
    status: { type: String, enum: ["Pending", "Approved", "Rejected", "Skipped"], default: "Pending" },
    by: { type: String, trim: true, default: "" },
    byUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    at: { type: Date, default: null },
    remark: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const RentRevisionSchema = new mongoose.Schema(
  {
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "Media", required: true, index: true },
    mediaCode: { type: String, trim: true, default: "" },
    mediaName: { type: String, trim: true, default: "" },
    fromMonth: { type: String, trim: true, required: true }, // "August 2026"
    fromDate: { type: Date, required: true }, // 1st of fromMonth (UTC)
    oldRent: { type: Number, required: true },
    newRent: { type: Number, required: true },
    difference: { type: Number, default: 0 },
    increaseAmount: { type: Number, default: 0 }, // newRent = oldRent + increaseAmount
    // 1 / null → from fromMonth onwards (site rent changes); 0 → only fromMonth
    applyToAllMonths: { type: Number, enum: [0, 1, null], default: null },
    invoice: { type: mongoose.Schema.Types.Mixed, default: null }, // PDF → mail gstInvoiceUrl
    reason: { type: String, trim: true, default: "" },

    status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending", index: true },
    currentPendingRole: { type: Number, enum: [1, 2, 3, null], default: 1 },
    approvalSteps: [revisionStepSchema],

    arrearsTotal: { type: Number, default: 0 },
    // ✅ NEW — POST /admin/rent-revision/update: every edit (old / new values,
    // approvals reset by that edit), oldest first
    editHistory: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    // ✅ NEW — earlier approvals replaced when the same role approved again
    approvalHistory: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    updatedBy: { type: String, trim: true, default: "" },

    requestedBy: { type: String, trim: true, default: "" },
    requestedByUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    requestedByRole: { type: Number, default: null },
    requestedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("RentRevision", RentRevisionSchema);
