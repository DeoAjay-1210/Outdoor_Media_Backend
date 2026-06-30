const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// APPROVAL STEP SCHEMA
// Tracks each individual role's approval action
// ─────────────────────────────────────────────────────────────
const approvalStepSchema = new mongoose.Schema(
  {
    role: {
      type: Number,
      enum: [1, 2, 3], // 1=Staff  2=TeamLead  3=Owner
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    userName: { type: String, trim: true },
    approvedAt: { type: Date, default: null },
    // 1=Pending  2=Approved  3=Skipped (Owner skipped lower roles)
    status: {
      type: Number,
      enum: [1, 2, 3],
      default: 1,
    },
    remarks: { type: String, trim: true },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// AGREEMENT DOC VERIFICATION SCHEMA
// Snapshot of the agreement PDF verified before saving rental due
// ─────────────────────────────────────────────────────────────
const agreementDocVerificationSchema = new mongoose.Schema(
  {
    // Whether the agreement doc was verified before this rental due entry was saved
    isVerified: {
      type: Boolean,
      default: false,
    },
    verifiedBy: { type: String, trim: true }, // userName who verified
    verifiedByRole: {
      type: Number,
      enum: [1, 2, 3], // 1=Staff  2=TeamLead  3=Owner
    },
    verifiedAt: { type: Date, default: null },
    // Snapshot of the agreement PDF at time of verification
    agreementPDF: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["pdf"], default: "pdf" },
      uploadedAt: { type: Date, default: null },
    },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// PROOF OF CAMPAIGN IMAGE SCHEMA
// ─────────────────────────────────────────────────────────────
const proofOfCampaignSchema = new mongoose.Schema(
  {
    originalName: { type: String },
    fileName: { type: String },
    filePath: { type: String },
    mimeType: { type: String },
    size: { type: Number },
    fileType: { type: String, enum: ["image"], default: "image" },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// RENTAL DUE ENTRY SCHEMA
// One entry per billing cycle / due date
// ─────────────────────────────────────────────────────────────
const rentalDueEntrySchema = new mongoose.Schema(
  {
    // ── Billing Info ──────────────────────────────────────────
    dueMonth: { type: String, trim: true }, // e.g. "June 2026"
    dueDate: { type: Date, required: true }, // actual due date

    // Amount snapshotted from rentalPayment.netPayable at time of entry creation
    netPayable: { type: Number, default: 0, min: 0 },

    // Snapshot of payment frequency at time of entry
    paymentFrequency: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
    },

    // ── Campaign ──────────────────────────────────────────────
    campaignName: { type: String, trim: true },
    proofOfCampaign: proofOfCampaignSchema,

    // ── Agreement Doc Verification ────────────────────────────
    agreementDocVerification: agreementDocVerificationSchema,

    // ── Who Saved This Entry ──────────────────────────────────
    // Identifies which role created this due entry
    savedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId },
      userName: { type: String, trim: true },
      role: {
        type: Number,
        enum: [1, 2, 3], // 1=Staff  2=TeamLead  3=Owner
      },
      savedAt: { type: Date, default: Date.now },
    },

    // ── Approval Chain ────────────────────────────────────────
    // approvalFlow controls which roles are REQUIRED in this entry's chain.
    // Owner can grant Team Lead permission to approve (skipping Staff requirement).
    // Owner can also approve directly (skipping Staff + Team Lead).
    //
    // Flow modes:
    //  1 = Full flow:        Staff → TeamLead → Owner
    //  2 = Skip Staff:       TeamLead → Owner  (owner granted TL permission)
    //  3 = Owner Only:       Owner directly
    approvalFlow: {
      type: Number,
      enum: [1, 2, 3],
      default: 1,
    },

    // Individual step records — one per role in the chain
    approvalSteps: [approvalStepSchema],

    // Overall approval status of this due entry:
    // 1=Pending  2=PartiallyApproved  3=Approved  4=Overdue
    approvalStatus: {
      type: Number,
      enum: [1, 2, 3, 4],
      default: 1,
    },

    // Which step is currently pending (role number: 1/2/3)
    currentPendingRole: {
      type: Number,
      enum: [1, 2, 3],
      default: 1,
    },
    agreementDocVerified: {
      type: Boolean,
      default: false,
    },
    // ── Overall Status ────────────────────────────────────────
    // 1=Pending  2=PartiallyApproved  3=Approved  4=Overdue
    status: {
      type: Number,
      enum: [1, 2, 3, 4],
      default: 1,
    },

    remarks: { type: String, trim: true },
    updatedBy: { type: String, trim: true },
    updatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────────────────────
// RENTAL DUE HISTORY SCHEMA
// Year → Month bucketing (mirrors ledgerHistory pattern)
// ─────────────────────────────────────────────────────────────
const rentalDueHistoryEntrySchema = new mongoose.Schema(
  {
    rentalDueId: { type: mongoose.Schema.Types.ObjectId }, // ref to rentalDue[]._id
    siteName: { type: String, trim: true },
    campaignName: { type: String, trim: true },
    dueDate: { type: Date },
    netPayable: { type: Number },
    approvalStatus: { type: Number, enum: [1, 2, 3, 4] },
    savedBy: { type: String, trim: true },
    savedByRole: { type: Number, enum: [1, 2, 3] },
    updatedAt: { type: Date },
    updatedBy: { type: String, trim: true },
  },
  { _id: false },
);

const rentalDueHistoryMonthSchema = new mongoose.Schema(
  {
    month: { type: String }, // e.g. "June"
    entries: [rentalDueHistoryEntrySchema],
  },
  { _id: false },
);

const rentalDueHistoryYearSchema = new mongoose.Schema(
  {
    year: { type: String }, // e.g. "2026"
    months: [rentalDueHistoryMonthSchema],
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// EXPORTS — attach these to your MediaSchema
// ─────────────────────────────────────────────────────────────
module.exports = {
  rentalDueEntrySchema,
  rentalDueHistoryYearSchema,
};
