
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// ROLE / FLOW CONSTANTS
// ─────────────────────────────────────────────────────────────
const ROLE = { STAFF: 1, TEAM_LEAD: 2, OWNER: 3 };

const ROLE_LABEL = {
  [ROLE.STAFF]: "Staff",
  [ROLE.TEAM_LEAD]: "Team Lead",
  [ROLE.OWNER]: "Owner",
};

// role number -> key used on the lightweight "current cycle" flag object
const ROLE_FLAG_KEY = {
  [ROLE.STAFF]: "staff",
  [ROLE.TEAM_LEAD]: "teamLead",
  [ROLE.OWNER]: "owner",
};

// approvalFlow → ordered chain of roles that must approve, in order.
//  1 = Full flow:   Staff → TeamLead → Owner
//  2 = Skip Staff:  TeamLead → Owner   (owner-granted TL permission)
//  3 = Owner Only:  Owner directly
const FLOW_CHAIN = {
  1: [ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER],
  2: [ROLE.TEAM_LEAD, ROLE.OWNER],
  3: [ROLE.OWNER],
};

const approvalStepSchema = new mongoose.Schema(
  {
    role: { type: Number, enum: [1, 2, 3], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId },
    userName: { type: String, trim: true },
    approvedAt: { type: Date, default: null },
    // 1=Pending  2=Approved  3=Skipped (Owner skipped lower roles)
    status: { type: Number, enum: [1, 2, 3], default: 1 },
    docVerified: { type: Boolean, default: false },
    remarks: { type: String, trim: true },
  },
  { _id: false },
);

// ── PERMANENT HISTORY ───────────────────────────────────────
// One immutable record every time a role verifies the agreement doc for a
// given cycle. Never mutated or reset — this is the audit trail.
const agreementDocVerificationSchema = new mongoose.Schema(
  {
    isVerified: { type: Boolean, default: false },
    verifiedBy: { type: String, trim: true },
    verifiedByRole: { type: Number, enum: [1, 2, 3] },
    verifiedAt: { type: Date, default: null },
    rentalDueId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // which billing cycle this snapshot belongs to, so the history stays
    // readable on its own without joining back to rentalDueEntries
    dueMonth: { type: String, trim: true },
    dueDate: { type: Date, default: null },
    agreementPDF: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["pdf"], default: "pdf" },
      uploadedAt: { type: Date, default: null },
    },
     cycle: { type: Date, default: null },            // ✅ added — this was missing, causing the whole bug
    cycleStartDate: { type: Date, default: null }, 
    updatedBy: { type: String, trim: true },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

// ── LIVE / CURRENT-CYCLE FLAGS ──────────────────────────────
// Quick-access flags for whichever billing cycle is currently open.
// Reset to false/false/false the moment a cycle closes (Owner's final
// approval), at the same time the closing snapshot is pushed to history.
const agreementDocVerifiedSchema = new mongoose.Schema(
  {
    staff: { type: Boolean, default: false },
    teamLead: { type: Boolean, default: false },
    owner: { type: Boolean, default: false },
    
  },
  { _id: false },
);

const rentalDueEntrySchema = new mongoose.Schema(
  {
    // ── Billing Info ──────────────────────────────────────────
    dueMonth: { type: String, trim: true }, // e.g. "June 2026"
    dueDate: { type: Date, required: true }, // actual due date

    netPayable: { type: Number, default: 0, min: 0 },
 withGst: { type: Number, enum: [1, 2], default: null }, // 1 withoutGST 2. withGST

    // ✅ NEW — snapshot of the GST amount for THIS cycle (only relevant
    // when withGst === 1). Stored on the entry itself so the historical
    // record stays accurate even if rentalPayment.gstAmount changes later.
    gstAmount: { type: Number, default: 0, min: 0 },

    // ✅ NEW — snapshot of the base (pre-GST) amount actually billed to
    // the client this cycle.
    baseAmount: { type: Number, default: 0, min: 0 },
    paymentFrequency: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
    },
ownerApprovalDate: { type: Date, default: null },
    // ── Campaign ──────────────────────────────────────────────
    campaignName: { type: String, trim: true },
    proofOfCampaign: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: Date.now },
    },

    // ── Who Saved This Entry ──────────────────────────────────
    savedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId },
      userName: { type: String, trim: true },
      role: { type: Number, enum: [1, 2, 3] },
      savedAt: { type: Date, default: Date.now },
    },

    // ── Approval Chain ────────────────────────────────────────
    approvalFlow: { type: Number, enum: [1, 2, 3], default: 1 },
    approvalSteps: [approvalStepSchema],

    // 1=Pending  2=PartiallyApproved  3=Approved  4=Overdue
    approvalStatus: { type: Number, enum: [1, 2, 3, 4], default: 1 },
    currentPendingRole: { type: Number, enum: [1, 2, 3], default: 1 },
    agreementDocVerified: { type: Boolean, default: false },

    // 1=Pending  2=PartiallyApproved  3=Approved  4=Overdue
    status: { type: Number, enum: [1, 2, 3, 4], default: 1 },

    remarks: { type: String, trim: true },
    updatedBy: { type: String, trim: true },
    updatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────────────────────
// RENTAL DUE HISTORY (Year → Month bucketing, unchanged)
// ─────────────────────────────────────────────────────────────
const rentalDueHistoryEntrySchema = new mongoose.Schema(
  {
    rentalDueId: { type: mongoose.Schema.Types.ObjectId },
    siteName: { type: String, trim: true },
    campaignName: { type: String, trim: true },
    dueDate: { type: Date },
    netPayable: { type: Number },
    approvalStatus: { type: Number, enum: [1, 2, 3, 4] },
    savedBy: { type: String, trim: true },
    savedByRole: { type: Number, enum: [1, 2, 3] },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, trim: true },
  },
  { _id: false },
);

const rentalDueHistoryMonthSchema = new mongoose.Schema(
  { month: { type: String }, entries: [rentalDueHistoryEntrySchema] },
  { _id: false },
);

const rentalDueHistoryYearSchema = new mongoose.Schema(
  { year: { type: String }, months: [rentalDueHistoryMonthSchema] },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// EXPORTS — attach these to your MediaSchema, e.g.:
//
//   agreementDocVerified: { type: agreementDocVerifiedSchema, default: () => ({}) },
//   agreementDocVerificationHistory: [agreementDocVerificationSchema],
  rentalDueEntries: [rentalDueEntrySchema],
//   rentalStatus: { type: Number, enum: [0, 1, 2, 3], default: 0 },
//   rentalDueHistory: [rentalDueHistoryYearSchema],
// ─────────────────────────────────────────────────────────────
module.exports = {
  ROLE,
  ROLE_LABEL,
  ROLE_FLAG_KEY,
  FLOW_CHAIN,
  approvalStepSchema,
  agreementDocVerificationSchema,
  agreementDocVerifiedSchema,
  rentalDueEntrySchema,
  rentalDueHistoryYearSchema,
};