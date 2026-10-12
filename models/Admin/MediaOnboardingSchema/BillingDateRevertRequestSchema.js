const mongoose = require("mongoose");
const { nowIST } = require("../../../utils/updatedAt");

// ─────────────────────────────────────────────────────────────
// BILLING DATE REVERT REQUEST
// A Rental Executive (userType 1) / Rental Manager (userType 2) asks to
// move a site's billing dates back to a previous date. Nothing on the
// site changes until CMD (userType 3) approves; only then are
// rentalPayment.lastBillPaidDate / nextBillingDate / billingStartDate
// updated on the MediaOnboarding document.
//
// status: 1 = Pending  2 = Approved  3 = Rejected
// ─────────────────────────────────────────────────────────────
const REVERT_STATUS = { PENDING: 1, APPROVED: 2, REJECTED: 3 };
const REVERT_STATUS_LABEL = {
  [REVERT_STATUS.PENDING]: "Pending",
  [REVERT_STATUS.APPROVED]: "Approved",
  [REVERT_STATUS.REJECTED]: "Rejected",
};

const billingDatesSchema = new mongoose.Schema(
  {
    lastBillPaidDate: { type: Date, default: null },
    nextBillingDate: { type: Date, default: null },
    previousBillGenerateDate: { type: Date, default: null },
    billingStartDate: { type: Date, default: null },
  },
  { _id: false },
);

const actorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
    userName: { type: String, trim: true, default: "" },
    role: { type: Number, enum: [1, 2, 3, null], default: null }, // same as UserSchema.userType
    remark: { type: String, trim: true, default: "" },
    actionAt: { type: Date, default: null },
  },
  { _id: false },
);

const siteFaceSchema = new mongoose.Schema(
  {
    mediaDetailId: { type: mongoose.Schema.Types.ObjectId, default: null },
    mediaCode: { type: String, trim: true },
    mediaName: { type: String, trim: true },
    mediaType: { type: String, trim: true },
    state: { type: String, trim: true },
    city: { type: String, trim: true },
    district: { type: String, trim: true },
    location: { type: String, trim: true },
    status: { type: Number },
  },
  { _id: false },
);

const billingDateRevertRequestSchema = new mongoose.Schema(
  {
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "MediaOnboarding", required: true },

    // site snapshot at request time (display only)
    siteCode: { type: String, trim: true, default: "" },
    siteName: { type: String, trim: true, default: "" },
    landOwnerName: { type: String, trim: true, default: "" },
    siteDetails: { type: [siteFaceSchema], default: [] },

    // billing frequency at request time — re-checked on approval
    paymentFrequency: { type: Number, enum: [1, 2, 3, 4, 5, 6] },
    customPaymentFrequency: { type: Number, default: null },
    cycleMonths: { type: Number, default: 1 },

    // site's billing dates when the request was raised
    originalDates: { type: billingDatesSchema, default: () => ({}) },
    // dates asked for by the requester
    requestedDates: { type: billingDatesSchema, default: () => ({}) },
    // site's billing dates just before CMD approval was applied
    datesBeforeApproval: { type: billingDatesSchema, default: null },
    // site's billing dates actually saved after CMD approval
    appliedDates: { type: billingDatesSchema, default: null },
    // bills this approval removed (month on/before the new lastBillPaidDate):
    // moving back  → untouched bills an EARLIER revert auto-generated
    // moving forward → bills CMD had not fully approved
    removedBills: {
      type: [
        new mongoose.Schema(
          {
            rentalDueId: { type: mongoose.Schema.Types.ObjectId },
            mediaDetailId: { type: mongoose.Schema.Types.ObjectId, default: null },
            dueMonth: { type: String, trim: true },
            dueDate: { type: Date },
            netPayable: { type: Number, default: 0 },
            approvalStatus: { type: Number, default: null },
            bill: { type: mongoose.Schema.Types.Mixed, default: null }, // full copy of the removed bill
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    remark: { type: String, trim: true, required: true },
    image: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: null },
    },

    status: {
      type: Number,
      enum: Object.values(REVERT_STATUS),
      default: REVERT_STATUS.PENDING,
    },

    requestedBy: { type: actorSchema, default: () => ({}) },
    cmdAction: { type: actorSchema, default: null }, // CMD approve / reject

    notificationId: { type: mongoose.Schema.Types.ObjectId, ref: "CmdNotification", default: null },

    createdAt: { type: Date, default: nowIST },
    updatedAt: { type: Date, default: nowIST },
  },
  { timestamps: false },
);

// only ONE pending request per site at a time
billingDateRevertRequestSchema.index(
  { mediaId: 1 },
  { unique: true, partialFilterExpression: { status: REVERT_STATUS.PENDING }, name: "uniq_pending_per_media" },
);
billingDateRevertRequestSchema.index({ status: 1, createdAt: -1 });

const BillingDateRevertRequest = mongoose.model("BillingDateRevertRequest", billingDateRevertRequestSchema);

module.exports = BillingDateRevertRequest;
module.exports.REVERT_STATUS = REVERT_STATUS;
module.exports.REVERT_STATUS_LABEL = REVERT_STATUS_LABEL;
