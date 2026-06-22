// models/MediaUpload.js
// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY BULK-UPLOAD SCHEMA
// Used ONLY for importing inventory from Excel.
// After upload, records can be enriched via the full MediaOnboarding schema.
// Schema name intentionally kept different from "MediaOnboarding" so there
// is NO conflict. Once fields are filled in, migrate to MediaOnboarding.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require("mongoose");

const MediaSchema = new mongoose.Schema(
  {
    // ── From Excel ────────────────────────────────────────────
    mediaCode: {
      type: String,
      required: true,
    },
    mediaName: {
      type: String,
      required: true,
      trim: true,
    },
    mediaType: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    fullAddress: {
      type: String,
      required: true,
      trim: true,
    },
    width: {
      type: Number,
      required: true,
      min: 0,
    },
    height: {
      type: Number,
      required: true,
      min: 0,
    },
    totalSqFt: {
      type: Number,
      min: 0,
    },

    // ── Status flags ──────────────────────────────────────────
    status: {
      type: Number,
      enum: [1, 2, 3], // 1.Active 2.InActive 3.Hold
      default: 1,
    },

    // ── Fields to be filled later (not required here) ─────────
    location: {
      type: String,
      trim: true,
      default: null,
    },
    numberOfLandOwners: {
      type: Number,
      min: 1,
      default: null,
    },

    // Minimal rental payment — no required sub-fields at upload time
    rentalPayment: {
      totalRentalAmount: { type: Number, default: 0 },
      paymentFrequency: {
        type: Number,
        enum: [1, 2, 3, 4, 5, 6],
        default: null,
      },
      lastBillPaidDate: { type: Date, default: null },
      nextBillingDate:  { type: Date, default: null },
      tdsApplicable:    { type: Number, enum: [0, 1], default: 0 },
      tdsPercentage:    { type: Number, default: 0 },
      tdsAmount:        { type: Number, default: 0 },
      netPayable:       { type: Number, default: 0 },
      status:           { type: Number, enum: [1, 2, 3], default: 1 },
      ownerPayments:    { type: Array, default: [] },
    },

    landOwners: { type: Array, default: [] },

    // Minimal agreement — no required sub-fields at upload time
    agreement: {
      startDate:             { type: Date, default: null },
      endDate:               { type: Date, default: null },
      reminderBeforeExpiry:  { type: Number, default: null },
      status:                { type: Number, enum: [1, 2, 3], default: 1 },
    },

    appraisal: {
      applicable: { type: Number, enum: [0, 1], default: 0 },
    },

    // Track whether record has been fully onboarded
    isOnboarded: {
      type: Boolean,
      default: false,
    },

    // Row number from Excel for traceability
    excelRowNumber: {
      type: Number,
    },
  },
  {
    timestamps: true,
   // separate collection — won't touch MediaOnboarding
  },
);

// Auto-compute totalSqFt
MediaSchema.pre("save", function () {
  if (this.width && this.height) {
    this.totalSqFt = this.width * this.height;
  }
});

module.exports = mongoose.model("MediaOnboarding", MediaSchema);