
const mongoose = require("mongoose");

const fileObjectSchema = {
  originalName: { type: String },
  fileName: { type: String },
  filePath: { type: String },
  mimeType: { type: String },
  size: { type: Number },
  fileType: { type: String, enum: ["image"], default: "image" },
  uploadedAt: { type: Date, default: null },
};

// ─────────────────────────────────────────────────────────────
// LAND OWNER MASTER SCHEMA
// Same field names, same types, same validation rules as
// MediaSchema.landOwners[] (see MediaOnboardingSchema.js).
// DO NOT rename fields here — every field must match the embedded
// landOwners subdocument 1:1 so sync logic can copy values directly
// without any mapping layer.
// ─────────────────────────────────────────────────────────────
const LandOwnerMasterSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    bankName: { type: String, trim: true },
    ifsc: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    upiId: { type: String, trim: true },
    panNumber: { type: String, trim: true, uppercase: true },

    // ✅ NEW — Aadhaar support
    aadharCardNumber: { type: String, trim: true },
    aadharCardImage: fileObjectSchema,

    paymentCategory: {
      type: Number,
      enum: [1, 2, 3], // 1 cash, 2 online, 3 cash+online
    },
     eligibleMode: {                    // ← ADDED
      type: Number,
      enum: [1, 2], // 1 = Cash, 2 = Online
      default: null,
    },
      landOwnerBillMode: {                    // ← ADDED
      type: Number,
      enum: [1, 2], // 1 = single, 2 = seperate
      default: null,
    },
      agreementBillMode: {
          type: Number,
          enum: [1, 2], // 1 = single, 2 = seperate
          default: null,
        },
    typeShare: {
      type: Number,
      enum: [1, 2], // 1 percentage, 2 amount
    },
    sharePercentage: {
      type: Number,
      min: 0,
      max: 100,
    },
    shareAmount: {
      type: Number,
      min: 0,
    },
    onlineMode: {
      type: Number,
      enum: [1, 2, 3], // 1 Bank Transfer, 2 UPI, 3 Cheque
    },
    panCardImage: fileObjectSchema,
    bankPassbook: fileObjectSchema,
    cancelCheckLeaf: fileObjectSchema,
    onlineAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    cashAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    tdsApplicable: {
      type: Number,
      enum: [0, 1],
      default: 0,
    },
    tdsPercentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    tdsAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    gstApplicable: {
      type: Number,
      enum: [0, 1],
      default: 0,
    },
    gstPercentage: {
      type: Number,
      min: 0,
      default: 0,
    },
    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
    },
    gstAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    totalAmountWithGst: {
      type: Number,
      min: 0,
      default: 0,
    },
    netPayableToOwner: {
      type: Number,
      min: 0,
      default: 0,
    },
    netPayable: { type: Number, min: 0, default: 0 },

    // ─────────────────────────────────────────────────────────
    // MASTER-ONLY FIELDS (not present on embedded landOwners)
    // ─────────────────────────────────────────────────────────
    // isDeleted: { type: Boolean, default: false },
    // deletedAt: { type: Date, default: null },

    // running count of Media docs currently linking this owner.
    // maintained by landOwnerMasterController sync functions only —
    // never set directly from a client payload.
    linkedMediaCount: { type: Number, default: 0, min: 0 },

    // ✅ NEW — ONE landowner can be attached to MANY Media
    // properties, each with its OWN paymentCategory/amounts (e.g.
    // Site A = Cash only, Site B = Online only, Site C = Cash+Online).
    // One entry per linked Media property, upserted (by mediaId) every
    // time that property's owner data is saved from the Media side.
    // This is what powers "which site, which landowner, how many
    // sites, cash or online per site" reporting.
    linkedSites: [
      {
        mediaId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "MediaOnboarding",
        },
        mediaCode: { type: String, trim: true },
        mediaName: { type: String, trim: true },
         siteBillMode: {
          // ← ADDED
          type: Number,
          enum: [1, 2], // 1 = single, 2 = seperate
          default: null,
        },
        // 1=Cash  2=Online  3=Cash+Online — SAME meaning as
        // MediaSchema.landOwners[].paymentCategory, but scoped to
        // just this one site, independent of every other site.
        paymentCategory: { type: Number, enum: [1, 2, 3] },
        shareAmount: { type: Number, default: 0, min: 0 },
        cashAmount: { type: Number, default: 0, min: 0 },
        onlineAmount: { type: Number, default: 0, min: 0 },
          // gstAmount: { type: Number, default: 0, min: 0 },              // ← ADDED, needed to sum totalGstAmount
          tdsApplicable: { type: Number, enum: [0, 1], default: 0 },
    tdsPercentage: { type: Number, min: 0, max: 100, default: 0 },
    tdsAmount: { type: Number, min: 0, default: 0 },

    // ✅ NEW — GST is per-site now, same reasoning as TDS above.
    // gstAmount already existed; adding the applicable/percentage
    // flags so the UI can show "why" this site has a GST amount.
    gstApplicable: { type: Number, enum: [0, 1], default: 0 },
    gstPercentage: { type: Number, min: 0, default: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
          netPayableToOwner: { type: Number, default: 0, min: 0 }, 
        updatedAt: { type: Date, default: null },
      },
    ],
    totalShareAmount: { type: Number, default: 0, min: 0 },
    totalGstAmount: { type: Number, default: 0, min: 0 },
    totalNetPayableToOwner: { type: Number, default: 0, min: 0 },
    // ✅ IST-based audit fields — set manually in the controller via
    // nowIST() (same helper/pattern as mediaOnboardingController.js),
    // NOT mongoose's built-in { timestamps: true } (which stores UTC).
    updatedBy: { type: String, trim: true, default: null },
    updatedAt: { type: Date, default: null },
  },
  {
    // createdAt still auto-managed by mongoose (UTC, set once on
    // insert — fine as a pure record-creation marker). updatedAt is
    // NOT auto-managed here since we set it manually (IST) above.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

LandOwnerMasterSchema.index({ name: 1 });
LandOwnerMasterSchema.index({ phone: 1 });
LandOwnerMasterSchema.index({ panNumber: 1 });
LandOwnerMasterSchema.index({ aadharCardNumber: 1 });

module.exports = mongoose.model("LandOwnerMaster", LandOwnerMasterSchema);