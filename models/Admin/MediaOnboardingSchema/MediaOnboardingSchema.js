const mongoose = require("mongoose");
const {
  rentalDueEntrySchema,
  rentalDueHistoryYearSchema,
  verificationProgressSchema,
  gstBalanceSchema,
  agreementDocVerificationSchema,
} = require("./RentalDueModel");
const rentalAmountHistorySchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    updatedBy: { type: String },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);
// ─────────────────────────────────────────────────────────────
// OWNER PAYMENT SCHEMA
// ─────────────────────────────────────────────────────────────
const ownerPaymentSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MediaOnboarding.landOwners",
    },
    ownerName: {
      type: String,
      required: true,
    },
    percentage: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    // paymentCategory: 1=Cash  2=Online  3=Cash+Online
    paymentCategory: {
      type: Number,
      enum: [1, 2, 3],
    },
    // onlineMode: 1=Bank Transfer  2=UPI  3=Cheque
    onlineMode: {
      type: Number,
      enum: [1, 2, 3],
    },
    cashAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    onlineAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    gstApplicable: {
      type: Number,
      enum: [0, 1], // 0 no 1 yes
      default: 0,
    },
    gstPercentage: {
      type: Number,
      min: 0,
      default: 0,
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
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// APPRAISAL HISTORY SCHEMA
// ─────────────────────────────────────────────────────────────
const APPRAISAL_HISTORY_SCHEMA = new mongoose.Schema(
  {
    appraisalDate: { type: Date },
    type: { type: Number }, // 1=Percentage, 2=Fixed
    percentage: { type: Number, default: 0 },
    fixedAmount: { type: Number, default: 0 },
    previousRent: { type: Number, default: 0 },
    appraisalAmount: { type: Number, default: 0 },
    newRent: { type: Number, default: 0 },
    frequency: {
      type: Number,
      enum: [1, 2, 3, 4], // 1=6M 2=Yearly 3=2Y 4=Custom
    },
    customFrequencyMonths: {
      type: Number,
      default: 0,
    },
    updatedBy: { type: String },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// AGREEMENT HISTORY SCHEMA
// ─────────────────────────────────────────────────────────────
const agreementHistorySchema = new mongoose.Schema({
  startDate: { type: Date },
  endDate: { type: Date },
  reminderBeforeExpiry: {
    type: Number,
    enum: [10, 30, 60, 90], // 10 10days 30 30days 60 60days 90
  },
  advanceRent: {
    type: Number,
    default: 0,
  },
  status: {
    type: Number,
    enum: [1, 2, 3], // 1=Active  2=Expire soon  3=Expired
    default: 1,
  },
  agreementPDF: {
    originalName: { type: String },
    fileName: { type: String },
    filePath: { type: String },
    mimeType: { type: String },
    size: { type: Number },
    fileType: { type: String, enum: ["pdf"], default: "pdf" },
    uploadedAt: { type: Date, default: Date.now },
  },
  reason: { type: String, trim: true },
  rentalPayment: {
    totalRentalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paymentFrequency: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6, 7], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
      required: true,
    },
    customPaymentFrequency: {
      type: Number,
      min: 1,
      required: function () {
        return this.paymentFrequency === 7;
      },
    },
    // ← NEW: who changed totalRentalAmount in this agreement snapshot
    updatedBy: { type: String },
    updatedAt: { type: Date, default: null },
  },
  updatedBy: {
    type: String,
  },
  uploadedAt: { type: Date, default: Date.now }, // timestamp when this snapshot was pushed
});

const ledgerSchema = new mongoose.Schema({
  landOwnerId: { type: mongoose.Schema.Types.ObjectId, default: null }, // ✅ added
  landOwnerName: { type: String, trim: true, default: "" }, // ✅ added
  utrNumber: { type: String, trim: true },
  date: { type: Date, default: Date.now },
  status: {
    type: Number,
    enum: [0, 1], // 0=not Approve 1=Approve
    default: 0,
  },
  withGst: { type: Number, enum: [1, 2], default: null }, // 1 withGST 2. withOutGST
  month: {
    type: String,
    trim: true,
  },
  cycle: { type: Date, default: null },
  updatedBy: { type: String },
  updatedAt: { type: Date, default: null },
  rentalDueId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // ✅ ADDED — the fixed ledger slot (0/1/2) a withGst===2 entry
  // occupies in `media.ledger`. Only meaningful for withGst===2;
  // left null for withGst===1 entries (which live in
  // `media.withGst1Ledger` instead, identified by rentalDueId).
  index: { type: Number, default: null },
});

const ledgerHistoryEntrySchema = new mongoose.Schema(
  {
    landOwnerId: { type: mongoose.Schema.Types.ObjectId, default: null }, // ✅ added
    landOwnerName: { type: String, trim: true, default: "" }, // ✅ added
    mediaName: { type: String, trim: true },
    paymentFrequency: { type: Number, trim: true },
    netPayable: { type: Number, trim: true },
    nextBillingDate: { type: Date },
    lastBillPaidDate: { type: Date },
    utrNumber: { type: String, trim: true },
    withGst: { type: Number, enum: [1, 2], default: null }, // 1 withGST 2. withOutGST
    month: {
      type: String,
      trim: true,
    },
    rentalDueId: { type: mongoose.Schema.Types.ObjectId, default: null },
    cycle: { type: Date, default: null },
    date: { type: Date },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String },
    // ✅ ADDED — same reasoning as ledgerSchema.index above. Needed so
    // getLedgerHistory / listMediaByLedger can reliably dedupe
    // withGst===2 entries by slot when reading past months.
    index: { type: Number, default: null },
  },
  { _id: false },
);

const ledgerHistoryMonthSchema = new mongoose.Schema(
  {
    month: { type: String }, // e.g. "June"
    entries: [ledgerHistoryEntrySchema],
  },
  { _id: false },
);

const ledgerHistoryYearSchema = new mongoose.Schema(
  {
    year: { type: String }, // e.g. "2026"
    months: [ledgerHistoryMonthSchema],
  },
  { _id: false },
);
// ─────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────
const MediaSchema = new mongoose.Schema(
  {
    // mediaId: {
    //   type: String,
    //   unique: true,
    //   sparse: true,
    // },
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
    location: {
      type: String,
      required: true,
      trim: true,
    },
    // fullAddress: {
    //   type: String,
    //   required: true,
    //   trim: true,
    // },
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
    status: {
      type: Number,
      enum: [1, 2, 3], // 1=Active 2=InActive 3=Hold
      default: 1,
    },
    numberOfLandOwners: {
      type: Number,
      min: 1,
    },

    // ─────────────────────────────────────────────────────────
    // RENTAL PAYMENT
    // ─────────────────────────────────────────────────────────
    rentalPayment: {
      totalRentalAmount: {
        type: Number,
        required: true,
        min: 0,
      },
      rentalAmountHistory: [rentalAmountHistorySchema],
      gstApplicable: {
        type: Number,
        enum: [0, 1],
        default: 0,
      },
      gstNumber: {
        type: String,
        trim: true,
        uppercase: true,
      },
      gstPercentage: {
        type: Number,
        min: 0,
        default: 0,
      },
      gstAmount: {
        type: Number,
        default: 0,
      },
      totalRentalAmountWithGst: {
        type: Number,
        default: 0,
      },
      paymentFrequency: {
        type: Number,
        enum: [1, 2, 3, 4, 5, 6, 7], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
        required: true,
      },
      customPaymentFrequency: {
        type: Number,
        min: 1,
        required: function () {
          return this.paymentFrequency === 7;
        },
      },
      lastBillPaidDate: {
        type: Date,
        required: true,
      },
      nextBillingDate: {
        type: Date,
      },
      // tdsApplicable: {
      //   type: Number,
      //   enum: [0, 1],
      //   default: 0,
      // },
      // tdsPercentage: {
      //   type: Number,
      //   min: 0,
      //   max: 100,
      //   default: 0,
      // },
      // tdsAmount: {
      //   type: Number,
      //   default: 0,
      // },
      netPayable: {
        type: Number,
        default: 0,
      },
      // ✅ NEW — running total of GST amounts collected across cycles where
      // withGst === 1 (client billed base-only, GST held separately). This
      // represents GST owed to the government that hasn't been remitted yet.
      // Reduce this manually (via a separate "settle GST" action/endpoint)
      // once the amount is actually paid to the government.
      balanceGstAmount: { type: Number, default: 0, min: 0 },
      status: {
        type: Number,
        enum: [1, 2, 3], // 1=Active 2=Expire soon 3=Expired
        default: 1,
      },
      // ownerPayments: [ownerPaymentSchema],
    },

    // ─────────────────────────────────────────────────────────
    // LAND OWNERS
    // ─────────────────────────────────────────────────────────
    landOwners: [
      {
        name: { type: String, trim: true },
        phone: { type: String, trim: true },
        bankName: { type: String, trim: true },
        ifsc: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        upiId: { type: String, trim: true },
        panNumber: { type: String, trim: true, uppercase: true },
        paymentCategory: {
          type: Number,
          enum: [1, 2, 3], // 1 cash, 2 online 3 cash + online
          required: true,
        },
        typeShare: {
          type: Number,
          enum: [1, 2], // 1.percentage 2.amount
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
          enum: [1, 2, 3], // 1=Bank Transfer  2=UPI  3=Cheque
        },
        panCardImage: {
          originalName: { type: String },
          fileName: { type: String },
          filePath: { type: String },
          mimeType: { type: String },
          size: { type: Number },
          fileType: { type: String, enum: ["image"], default: "image" },
          uploadedAt: { type: Date, default: null },
        },
        bankPassbook: {
          originalName: { type: String },
          fileName: { type: String },
          filePath: { type: String },
          mimeType: { type: String },
          size: { type: Number },
          fileType: { type: String, enum: ["image"], default: "image" },
          uploadedAt: { type: Date, default: null },
        },
        cancelCheckLeaf: {
          originalName: { type: String },
          fileName: { type: String },
          filePath: { type: String },
          mimeType: { type: String },
          size: { type: Number },
          fileType: { type: String, enum: ["image"], default: "image" },
          uploadedAt: { type: Date, default: null },
        },
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
          enum: [0, 1], // 0 no  1 yes
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
      },
    ],

    // ─────────────────────────────────────────────────────────
    // AGREEMENT
    // ─────────────────────────────────────────────────────────
    agreement: {
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
      reminderBeforeExpiry: {
        type: Number,
        enum: [10, 30, 60, 90],
        required: true,
      },
      advanceRent: {
        type: Number,
        default: 0,
      },
      status: {
        type: Number,
        enum: [1, 2, 3], // 1=Active 2=Expire Soon 3=Expired
        default: 1,
      },
      reason: { type: String, trim: true },
      agreementPDF: {
        originalName: { type: String },
        fileName: { type: String },
        filePath: { type: String },
        mimeType: { type: String },
        size: { type: Number },
        fileType: { type: String, enum: ["pdf"], default: "pdf" },
        uploadedAt: { type: Date, default: null },
      },
      updatedBy: {
        type: String,
      },
      uploadedAt: { type: Date, default: Date.now },
      rentalPayment: {
        totalRentalAmount: {
          type: Number,
          default: 0,
          min: 0,
        },
        paymentFrequency: {
          type: Number,
          enum: [1, 2, 3, 4, 5, 6, 7], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
          required: true,
        },
        customPaymentFrequency: {
          type: Number,
          min: 1,
          required: function () {
            return this.paymentFrequency === 7;
          },
        },
        updatedBy: { type: String },
        updatedAt: { type: Date, default: null },
      },
    },

    agreementHistory: [agreementHistorySchema],

    // ─────────────────────────────────────────────────────────
    // APPRAISAL
    // ─────────────────────────────────────────────────────────
    appraisal: {
      applicable: {
        type: Number,
        enum: [0, 1], // 0 no 1 yes
        default: 0,
      },
      type: {
        type: Number,
        enum: [1, 2], // 1=Percentage, 2=Fixed
      },
      percentage: {
        type: Number,
        default: 0,
      },
      fixedAmount: {
        type: Number,
        default: 0,
      },
      frequency: {
        type: Number,
        enum: [1, 2, 3, 4], // 1=6M 2=Yearly 3=2Y 4=Custom
      },
      customFrequencyMonths: {
        type: Number,
        default: 0,
      },
      currentRent: {
        type: Number,
        default: 0,
      },
      appraisalAmount: {
        type: Number,
        default: 0,
      },
      totalAppraisalAmount: {
        type: Number,
        default: 0,
      },
      lastAppraisalDate: Date,
      nextAppraisalDate: Date,
      history: [APPRAISAL_HISTORY_SCHEMA],
    },

    // ─────────────────────────────────────────────────────────
    // IMAGES
    // ─────────────────────────────────────────────────────────
    frontView: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: null },
    },
    sideView: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: null },
    },
    locationView: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: null },
    },
    additionalImages: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: null },
    },

    ledger: [ledgerSchema],
    withGst1Ledger: [ledgerSchema],
    ledgerHistory: [ledgerHistoryYearSchema],

    agreementDocVerification: [agreementDocVerificationSchema],
    rentalDue: [rentalDueEntrySchema],
    rentalStatus: {
      type: Number,
      enum: [0, 1, 2, 3], // 0=null 1=staff Approve 2= Team Lead Approve 3=Owner Approve
      default: 0,
    },
    gstApplicableFlag: {
      type: Number,
      enum: [0, 1, 2], // 0 = not set yet (default) | 1 = rentalPayment.gstApplicable is authoritative | 2 = landOwners[].gstApplicable is authoritative
      default: 0,
    },
    rentalDueHistory: [rentalDueHistoryYearSchema],
    verificationProgressHistory: [verificationProgressSchema],
    gstBalanceHistory: [gstBalanceSchema],
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 1 — Total Sq Ft
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  this.totalSqFt = this.width * this.height;
});

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 2 — Rental Payment Calculations + Owner Shares
// ─────────────────────────────────────────────────────────────

// MediaSchema.pre("save", function () {
//   const rp = this.rentalPayment;
//   const totalRentalAmount = Number(rp.totalRentalAmount || 0);
//   const rentalGstApplicable = Number(rp.gstApplicable || 0);

//   // ── STEP A: GST (rental-level) ──
//   let gstAmount = 0;
//   let totalRentalAmountWithGst = totalRentalAmount;

//   if (rentalGstApplicable === 1) {
//     const envGstPct = Math.floor(process.env.GST_PERCENTAGE || "18");
//     rp.gstPercentage = envGstPct;
//     gstAmount = Math.floor(((totalRentalAmount * envGstPct) / 100).toFixed(2));
//     totalRentalAmountWithGst = Math.floor(
//       (totalRentalAmount + gstAmount).toFixed(2),
//     );
//   } else {
//     rp.gstPercentage = 0;
//     gstAmount = 0;
//     totalRentalAmountWithGst = totalRentalAmount;
//   }

//   rp.gstAmount = gstAmount;
//   rp.totalRentalAmountWithGst = totalRentalAmountWithGst;

//   // ── STEP B: Net Payable (the pool split among owners — includes GST) ──
//   let netPayable = Math.floor(totalRentalAmountWithGst.toFixed(2));
//   rp.netPayable = netPayable;

//   // ── STEP C: APPRAISAL OVERRIDE (unchanged) ──
//   if (Number(this.appraisal?.applicable) === 1) {
//     const nextAppraisalDate = this.appraisal?.nextAppraisalDate
//       ? new Date(this.appraisal.nextAppraisalDate)
//       : null;

//     const today = new Date();
//     today.setHours(0, 0, 0, 0);

//     if (nextAppraisalDate) {
//       const appraisalDay = new Date(nextAppraisalDate);
//       appraisalDay.setHours(0, 0, 0, 0);

//       if (appraisalDay <= today) {
//         const historyEntry = Array.isArray(this.appraisal.history)
//           ? this.appraisal.history.find(
//               (item) =>
//                 item.appraisalDate &&
//                 new Date(item.appraisalDate).setHours(0, 0, 0, 0) ===
//                   appraisalDay.getTime(),
//             )
//           : null;

//         if (historyEntry && Number(historyEntry.newRent) > 0) {
//           netPayable = Number(historyEntry.newRent);
//           rp.netPayable = netPayable;
//         }
//       }
//     }
//   }

//   if (!this.landOwners || !this.landOwners.length) return;

//   // ── STEP D: OWNER SHARE + TDS (per-owner) + GST CALCULATION ──
//   const ownerSplitBaseAmount = netPayable; // includes GST — used for shareAmount
//   const envGstPct = Math.floor(process.env.GST_PERCENTAGE || "18");
//   const envTdsPercent = Math.floor(process.env.TDS_PERCENTAGE || "0");

//   this.landOwners.forEach((owner) => {
//     // ── Share amount (of netPayable, includes GST — UNCHANGED) ──
//     if (Number(owner.typeShare) === 1) {
//       const sharePercentage = Number(owner.sharePercentage || 0);
//       owner.shareAmount = Math.floor(
//         ((ownerSplitBaseAmount * sharePercentage) / 100).toFixed(2),
//       );
//     } else if (Number(owner.typeShare) === 2) {
//       owner.sharePercentage = undefined;
//       owner.shareAmount = Math.floor(Number(owner.shareAmount || 0).toFixed(2));
//     }

//     // ✅ FIXED — TDS base is this owner's share of totalRentalAmount
//     // (the PURE rental figure, WITHOUT GST), never netPayable/shareAmount
//     // (which include GST). Computed using the SAME proportion (percentage
//     // or fixed-amount ratio) that determined shareAmount, just applied
//     // against totalRentalAmount instead of netPayable.
//     let ownerTdsBaseAmount = 0;

//     if (Number(owner.typeShare) === 1) {
//       const sharePercentage = Number(owner.sharePercentage || 0);
//       ownerTdsBaseAmount = Math.floor(
//         ((totalRentalAmount * sharePercentage) / 100).toFixed(2),
//       );
//     } else if (Number(owner.typeShare) === 2) {
//       // Fixed-amount owners: derive their proportional share of the
//       // RENTAL-ONLY amount using the same ratio their shareAmount
//       // represents out of the full (GST-inclusive) netPayable pool.
//       const ratio =
//         netPayable > 0 ? Number(owner.shareAmount || 0) / netPayable : 0;
//       ownerTdsBaseAmount = Math.floor((totalRentalAmount * ratio).toFixed(2));
//     }

//     const tdsApplicable = Number(owner.tdsApplicable || 0);
//     const tdsPercentage =
//       tdsApplicable === 1
//         ? envTdsPercent > 0
//           ? envTdsPercent
//           : Number(owner.tdsPercentage || 0)
//         : 0;

//     owner.tdsPercentage = tdsPercentage;

//     const tdsAmount =
//       tdsApplicable === 1 && tdsPercentage > 0
//         ? Math.floor(((ownerTdsBaseAmount * tdsPercentage) / 100).toFixed(2))
//         : 0;

//     owner.tdsAmount = tdsAmount;

//     // Post-TDS amount — deduct TDS from the owner's FULL shareAmount
//     // (GST-inclusive), since TDS is still withheld from what's actually
//     // paid out, even though it's CALCULATED on the rental-only portion.
//     const ownerAmountAfterTds = Math.floor(
//       (Number(owner.shareAmount || 0) - tdsAmount).toFixed(2),
//     );

//     // ── Owner-level GST (unchanged logic) ──
//     const ownerGstApplicable =
//       rentalGstApplicable === 0 ? Number(owner.gstApplicable || 0) : 0;
//     const paymentCategory = Number(owner.paymentCategory || 1);

//     if (ownerGstApplicable === 1 && paymentCategory !== 1) {
//       let onlinePortionForGst = 0;
//       if (paymentCategory === 2) {
//         onlinePortionForGst = Number(owner.shareAmount || 0);
//       } else if (paymentCategory === 3) {
//         onlinePortionForGst = Number(owner.onlineAmount || 0);
//       }

//       const ownerGstAmount = Math.floor(
//         ((onlinePortionForGst * envGstPct) / 100).toFixed(2),
//       );
//       owner.gstPercentage = envGstPct;
//       owner.gstAmount = ownerGstAmount;
//       owner.totalAmountWithGst = Math.floor(
//         (ownerAmountAfterTds + ownerGstAmount).toFixed(2),
//       );
//     } else {
//       owner.gstPercentage = 0;
//       owner.gstAmount = 0;
//       owner.totalAmountWithGst = ownerAmountAfterTds;
//     }

//     owner.netPayableToOwner = owner.totalAmountWithGst;
//   });

//   // ── STEP E: OWNER PAYMENTS (unchanged) ──
//   rp.ownerPayments = this.landOwners.map((owner) => {
//     const ownerAmount = Number(owner.shareAmount || 0);
//     const paymentCategory = Number(owner.paymentCategory || 1);
//     const ownerGstApplicable =
//       rentalGstApplicable === 0 ? Number(owner.gstApplicable || 0) : 0;

//     const payment = {
//       ownerId: owner._id,
//       ownerName: owner.name,
//       percentage:
//         Number(owner.typeShare) === 1
//           ? Number(owner.sharePercentage || 0)
//           : null,
//       amount: ownerAmount,
//       paymentCategory,
//       tdsApplicable: Number(owner.tdsApplicable || 0),
//       tdsPercentage: Number(owner.tdsPercentage || 0),
//       tdsAmount: Number(owner.tdsAmount || 0),
//       gstApplicable: ownerGstApplicable,
//       gstPercentage:
//         ownerGstApplicable === 1 ? Number(owner.gstPercentage || 0) : 0,
//       gstAmount: ownerGstApplicable === 1 ? Number(owner.gstAmount || 0) : 0,
//       totalAmountWithGst:
//         ownerGstApplicable === 1
//           ? Number(owner.totalAmountWithGst || ownerAmount)
//           : ownerAmount,
//       netPayableToOwner: Number(owner.netPayableToOwner || 0),
//     };

//     if (paymentCategory === 1) {
//       payment.cashAmount = ownerAmount;
//       payment.onlineAmount = 0;
//     } else if (paymentCategory === 2) {
//       payment.onlineMode = owner.onlineMode;
//       payment.cashAmount = 0;
//       payment.onlineAmount = ownerAmount;
//     } else if (paymentCategory === 3) {
//       payment.onlineMode = owner.onlineMode;
//       payment.cashAmount = Number(owner.cashAmount || 0);
//       payment.onlineAmount = Number(owner.onlineAmount || 0);
//     }

//     return payment;
//   });
// });
MediaSchema.pre("save", function () {
  const rp = this.rentalPayment;
  const totalRentalAmount = Number(rp.totalRentalAmount || 0);
  const rentalGstApplicable = Number(rp.gstApplicable || 0);
  const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
  const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");

  rp.gstPercentage = rentalGstApplicable === 1 ? envGstPct : 0;
  rp.gstAmount =
    rentalGstApplicable === 1
      ? Math.round((totalRentalAmount * envGstPct) / 100)
      : 0;
  rp.totalRentalAmountWithGst = totalRentalAmount + rp.gstAmount;

  if (!this.landOwners || !this.landOwners.length) {
    rp.netPayable = totalRentalAmount;
    return;
  }

  this.landOwners.forEach((owner) => {
    // ── shareAmount: respect frontend value; fall back to
    // sharePercentage-derived amount ONLY if not sent at all ──
    const ownerShareFromFrontend = Number(owner.shareAmount || 0);
    let resolvedShareAmount = ownerShareFromFrontend;
    if (!resolvedShareAmount && Number(owner.typeShare) === 1) {
      const sharePercentage = Number(owner.sharePercentage || 0);
      resolvedShareAmount = Math.round(
        (totalRentalAmount * sharePercentage) / 100,
      );
    }
    owner.shareAmount = resolvedShareAmount;

    // ── TDS — on this owner's own shareAmount ──
    const tdsApplicable = Number(owner.tdsApplicable || 0);
    const tdsPercentage =
      tdsApplicable === 1
        ? envTdsPercent > 0
          ? envTdsPercent
          : Number(owner.tdsPercentage || 0)
        : 0;
    owner.tdsPercentage = tdsPercentage;

    const tdsAmount =
      tdsApplicable === 1 && tdsPercentage > 0
        ? Math.round((resolvedShareAmount * tdsPercentage) / 100)
        : 0;
    owner.tdsAmount = tdsAmount;

    // ── GST base depends on WHICH GST source is active ──
    let gstBaseAmount = 0;

    if (rentalGstApplicable === 1) {
      gstBaseAmount = resolvedShareAmount;
    } else {
      const paymentCategory = Number(owner.paymentCategory || 1);
      if (paymentCategory === 1) {
        gstBaseAmount = 0;
      } else if (paymentCategory === 2) {
        gstBaseAmount = resolvedShareAmount;
      } else if (paymentCategory === 3) {
        gstBaseAmount = Number(owner.onlineAmount || 0);
      }
    }

    const ownerGstApplicable =
      rentalGstApplicable === 1 ? 1 : Number(owner.gstApplicable || 0);
    const ownerGstPct =
      rentalGstApplicable === 1
        ? envGstPct
        : Number(owner.gstPercentage || 0) || envGstPct;

    const ownerGstAmount =
      ownerGstApplicable === 1 && gstBaseAmount > 0
        ? Math.round((gstBaseAmount * ownerGstPct) / 100)
        : 0;

    owner.gstPercentage =
      ownerGstApplicable === 1 && gstBaseAmount > 0 ? ownerGstPct : 0;
    owner.gstAmount = ownerGstAmount;

    owner.totalAmountWithGst = resolvedShareAmount + ownerGstAmount;
    owner.netPayableToOwner = owner.totalAmountWithGst;
    owner.netPayable = owner.totalAmountWithGst;
  });

  const totalTdsAcrossOwners = this.landOwners.reduce(
    (sum, owner) => sum + Number(owner.tdsAmount || 0),
    0,
  );
  const totalGstAcrossOwners = this.landOwners.reduce(
    (sum, owner) => sum + Number(owner.gstAmount || 0),
    0,
  );

  rp.netPayable =
    totalRentalAmount - totalTdsAcrossOwners + totalGstAcrossOwners;

  rp.ownerPayments = this.landOwners.map((owner) => {
    const ownerAmount = Number(owner.shareAmount || 0);
    const paymentCategory = Number(owner.paymentCategory || 1);

    const payment = {
      ownerId: owner._id,
      ownerName: owner.name,
      percentage:
        Number(owner.typeShare) === 1
          ? Number(owner.sharePercentage || 0)
          : null,
      amount: ownerAmount,
      paymentCategory,
      tdsApplicable: Number(owner.tdsApplicable || 0),
      tdsPercentage: Number(owner.tdsPercentage || 0),
      tdsAmount: Number(owner.tdsAmount || 0),
      gstApplicable:
        rentalGstApplicable === 1 ? 1 : Number(owner.gstApplicable || 0),
      gstPercentage: Number(owner.gstPercentage || 0),
      gstAmount: Number(owner.gstAmount || 0),
      totalAmountWithGst: Number(owner.totalAmountWithGst || ownerAmount),
      netPayableToOwner: Number(owner.netPayableToOwner || 0),
      netPayable: Number(owner.netPayableToOwner || 0),
    };

    if (paymentCategory === 1) {
      payment.cashAmount = ownerAmount;
      payment.onlineAmount = 0;
    } else if (paymentCategory === 2) {
      payment.onlineMode = owner.onlineMode;
      payment.cashAmount = 0;
      payment.onlineAmount = ownerAmount;
    } else if (paymentCategory === 3) {
      payment.onlineMode = owner.onlineMode;
      payment.cashAmount = Number(owner.cashAmount || 0);
      payment.onlineAmount = Number(owner.onlineAmount || 0);
    }

    return payment;
  });
});
// MediaSchema.pre("save", function () {
//   const rp = this.rentalPayment;
//   const totalRentalAmount = Number(rp.totalRentalAmount || 0);
//   const rentalGstApplicable = Number(rp.gstApplicable || 0);

//   // ── STEP A: GST (rental-level) ──
//   let gstAmount = 0;
//   let totalRentalAmountWithGst = totalRentalAmount;

//   if (rentalGstApplicable === 1) {
//     const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
//     rp.gstPercentage = envGstPct;
//     gstAmount = Math.round((totalRentalAmount * envGstPct) / 100);
//     totalRentalAmountWithGst = totalRentalAmount + gstAmount;
//   } else {
//     rp.gstPercentage = 0;
//     gstAmount = 0;
//     totalRentalAmountWithGst = totalRentalAmount;
//   }

//   rp.gstAmount = gstAmount;
//   rp.totalRentalAmountWithGst = totalRentalAmountWithGst;

//   // ── STEP B: Net Payable pool (GST-inclusive) — used ONLY as the
//   // SPLIT BASE for owner shares, not the final displayed value. ──
//   let netPayable = Math.round(totalRentalAmountWithGst);

//   // ── STEP C: APPRAISAL OVERRIDE ──
//   if (Number(this.appraisal?.applicable) === 1) {
//     const nextAppraisalDate = this.appraisal?.nextAppraisalDate
//       ? new Date(this.appraisal.nextAppraisalDate)
//       : null;

//     const today = new Date();
//     today.setHours(0, 0, 0, 0);

//     if (nextAppraisalDate) {
//       const appraisalDay = new Date(nextAppraisalDate);
//       appraisalDay.setHours(0, 0, 0, 0);

//       if (appraisalDay <= today) {
//         const historyEntry = Array.isArray(this.appraisal.history)
//           ? this.appraisal.history.find(
//               (item) =>
//                 item.appraisalDate &&
//                 new Date(item.appraisalDate).setHours(0, 0, 0, 0) ===
//                   appraisalDay.getTime(),
//             )
//           : null;

//         if (historyEntry && Number(historyEntry.newRent) > 0) {
//           netPayable = Number(historyEntry.newRent);
//         }
//       }
//     }
//   }

//   if (!this.landOwners || !this.landOwners.length) {
//     // No owners — nothing to split, netPayable is simply the pool itself.
//     rp.netPayable = netPayable;
//     return;
//   }

//   // ── STEP D: OWNER SHARE + TDS (on netPayable, GST-inclusive) + OWNER GST ──
//   const ownerSplitBaseAmount = netPayable;
//   const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
//   const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");

// //   this.landOwners.forEach((owner) => {
// //   // ── STEP 1: Owner's share of the BASE totalRentalAmount ──
// //   let ownerBaseShare = 0;

// //   if (Number(owner.typeShare) === 1) {
// //     const sharePercentage = Number(owner.sharePercentage || 0);
// //     ownerBaseShare = Math.round((totalRentalAmount * sharePercentage) / 100);
// //   } else if (Number(owner.typeShare) === 2) {
// //     const ratio =
// //       netPayable > 0 ? Number(owner.shareAmount || 0) / netPayable : 0;
// //     ownerBaseShare = Math.round(totalRentalAmount * ratio);
// //   }

// //   // ── STEP 2: TDS — computed on the owner's FULL base share ──
// //   const tdsApplicable = Number(owner.tdsApplicable || 0);
// //   const tdsPercentage =
// //     tdsApplicable === 1
// //       ? envTdsPercent > 0
// //         ? envTdsPercent
// //         : Number(owner.tdsPercentage || 0)
// //       : 0;

// //   owner.tdsPercentage = tdsPercentage;

// //   const tdsAmount =
// //     tdsApplicable === 1 && tdsPercentage > 0
// //       ? Math.round((ownerBaseShare * tdsPercentage) / 100)
// //       : 0;

// //   owner.tdsAmount = tdsAmount;

// //   // ── STEP 3: GST — base depends on paymentCategory ──
// //   const paymentCategory = Number(owner.paymentCategory || 1);
// //   const ownerGstApplicable =
// //     rentalGstApplicable === 1 ? 1 : Number(owner.gstApplicable || 0);
// //   const ownerGstPct =
// //     rentalGstApplicable === 1
// //       ? envGstPct
// //       : Number(owner.gstPercentage || 0) || envGstPct;

// //   let gstBaseAmount = 0;

// //   if (paymentCategory === 1) {
// //     // Cash only — no GST at all (matches earlier rule: GST doesn't
// //     // apply to pure cash payments)
// //     gstBaseAmount = 0;
// //   } else if (paymentCategory === 2) {
// //     // Online only — GST on the FULL base share
// //     gstBaseAmount = ownerBaseShare;
// //   } else if (paymentCategory === 3) {
// //     // ✅ Cash + Online split — GST ONLY on the online portion, not the
// //     // combined cash+online total. e.g. cash 30K + online 20K -> GST
// //     // calculated only on 20K, not on 50K.
// //     gstBaseAmount = Number(owner.onlineAmount || 0);
// //   }

// //   const ownerGstAmount =
// //     ownerGstApplicable === 1 && gstBaseAmount > 0
// //       ? Math.round((gstBaseAmount * ownerGstPct) / 100)
// //       : 0;

// //   owner.gstPercentage = ownerGstApplicable === 1 && gstBaseAmount > 0 ? ownerGstPct : 0;
// //   owner.gstAmount = ownerGstAmount;

// //   // ── STEP 4: Final shareAmount = base − TDS + GST ──
// //   owner.shareAmount = ownerBaseShare - tdsAmount + ownerGstAmount;
// //   owner.totalAmountWithGst = owner.shareAmount;
// //   owner.netPayableToOwner = owner.shareAmount;
// //   owner.netPayable = owner.shareAmount;
// // });

//   // ✅ NEW — rentalPayment.netPayable is now the SUM of what all owners
//   // actually receive (post-TDS, post-owner-GST), not the raw
//   // pre-deduction pool.
//   // rp.netPayable = this.landOwners.reduce(
//   //   (sum, owner) => sum + Number(owner.netPayableToOwner || 0),
//   //   0,
//   // );
// this.landOwners.forEach((owner) => {
//   // ── shareAmount NEVER recalculated — exactly what frontend sent ──
//   const ownerShareFromFrontend = Number(owner.shareAmount || 0);
//   owner.shareAmount = ownerShareFromFrontend;

//   // ── TDS — calculated on THIS owner's OWN shareAmount, stored as its
//   // own field. Never subtracted from shareAmount itself. ──
//   const tdsApplicable = Number(owner.tdsApplicable || 0);
//   const tdsPercentage =
//     tdsApplicable === 1
//       ? envTdsPercent > 0
//         ? envTdsPercent
//         : Number(owner.tdsPercentage || 0)
//       : 0;

//   owner.tdsPercentage = tdsPercentage;

//   const tdsAmount =
//     tdsApplicable === 1 && tdsPercentage > 0
//       ? Math.round((ownerShareFromFrontend * tdsPercentage) / 100)
//       : 0;

//   owner.tdsAmount = tdsAmount; // ✅ stored per owner, never touches shareAmount

//   // ── GST (unchanged logic from before, still informational) ──
//   const paymentCategory = Number(owner.paymentCategory || 1);
//   const ownerGstApplicable =
//     rentalGstApplicable === 1 ? 1 : Number(owner.gstApplicable || 0);
//   const ownerGstPct =
//     rentalGstApplicable === 1
//       ? envGstPct
//       : Number(owner.gstPercentage || 0) || envGstPct;

//   let gstBaseAmount = 0;
//   if (paymentCategory === 1) {
//     gstBaseAmount = 0;
//   } else if (paymentCategory === 2) {
//     gstBaseAmount = ownerShareFromFrontend;
//   } else if (paymentCategory === 3) {
//     gstBaseAmount = Number(owner.onlineAmount || 0);
//   }

//   const ownerGstAmount =
//     ownerGstApplicable === 1 && gstBaseAmount > 0
//       ? Math.round((gstBaseAmount * ownerGstPct) / 100)
//       : 0;

//   owner.gstPercentage =
//     ownerGstApplicable === 1 && gstBaseAmount > 0 ? ownerGstPct : 0;
//   owner.gstAmount = ownerGstAmount;

//   owner.totalAmountWithGst = ownerShareFromFrontend + ownerGstAmount;
//   owner.netPayableToOwner = owner.totalAmountWithGst;
//   owner.netPayable = owner.totalAmountWithGst;
// });

// // ✅ NEW — netPayable (overall pool) = totalRentalAmount MINUS the
// // SUM of every owner's tdsAmount. This is where TDS actually reduces
// // a number — the overall pool, never the individual shareAmount.
// const totalTdsAcrossOwners = this.landOwners.reduce(
//   (sum, owner) => sum + Number(owner.tdsAmount || 0),
//   0,
// );

// rp.netPayable = totalRentalAmount - totalTdsAcrossOwners;
//   // ── STEP E: OWNER PAYMENTS SNAPSHOT ──
//   rp.ownerPayments = this.landOwners.map((owner) => {
//     const ownerAmount = Number(owner.shareAmount || 0);
//     const paymentCategory = Number(owner.paymentCategory || 1);
//     const ownerGstApplicable =
//       rentalGstApplicable === 0 ? Number(owner.gstApplicable || 0) : 0;

//     const payment = {
//       ownerId: owner._id,
//       ownerName: owner.name,
//       percentage:
//         Number(owner.typeShare) === 1
//           ? Number(owner.sharePercentage || 0)
//           : null,
//       amount: ownerAmount,
//       paymentCategory,
//       tdsApplicable: Number(owner.tdsApplicable || 0),
//       tdsPercentage: Number(owner.tdsPercentage || 0),
//       tdsAmount: Number(owner.tdsAmount || 0),
//       gstApplicable: ownerGstApplicable,
//       gstPercentage:
//         ownerGstApplicable === 1 ? Number(owner.gstPercentage || 0) : 0,
//       gstAmount: ownerGstApplicable === 1 ? Number(owner.gstAmount || 0) : 0,
//       totalAmountWithGst:
//         ownerGstApplicable === 1
//           ? Number(owner.totalAmountWithGst || ownerAmount)
//           : ownerAmount,
//       netPayableToOwner: Number(owner.netPayableToOwner || 0),
//       netPayable: Number(owner.netPayableToOwner || 0),
//     };

//     if (paymentCategory === 1) {
//       payment.cashAmount = ownerAmount;
//       payment.onlineAmount = 0;
//     } else if (paymentCategory === 2) {
//       payment.onlineMode = owner.onlineMode;
//       payment.cashAmount = 0;
//       payment.onlineAmount = ownerAmount;
//     } else if (paymentCategory === 3) {
//       payment.onlineMode = owner.onlineMode;
//       payment.cashAmount = Number(owner.cashAmount || 0);
//       payment.onlineAmount = Number(owner.onlineAmount || 0);
//     }

//     return payment;
//   });
// });
// ─────────────────────────────────────────────────────────────
// PRE-SAVE 3 — Next Billing Date
// ─────────────────────────────────────────────────────────────

MediaSchema.pre("save", function () {
  const rp = this.rentalPayment;
  if (!rp) return;

  // ✅ FIXED — removed `if (!this.isNew) return;`. The old version only
  // ever calculated nextBillingDate on CREATE, never on UPDATE — so
  // entering lastBillPaidDate for the first time via an update request
  // silently never generated nextBillingDate.

  // Still respect an explicitly-provided nextBillingDate on CREATE (so
  // we don't override a value the frontend deliberately sent for a
  // brand-new document).
  const isNewDoc = this.isNew;
  const billingDateProvided = rp.nextBillingDate != null;
  if (isNewDoc && billingDateProvided) return;

  if (rp.lastBillPaidDate && rp.paymentFrequency) {
    const frequencyMap = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 12, 6: 24 };
    const monthsToAdd =
      Number(rp.paymentFrequency) === 7
        ? Number(rp.customPaymentFrequency) || 1
        : frequencyMap[Number(rp.paymentFrequency)] || 1;

    const nextDate = new Date(rp.lastBillPaidDate);
    nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
    rp.nextBillingDate = nextDate;
  }
});
// ─────────────────────────────────────────────────────────────
// PRE-SAVE 4 — Agreement Status
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  if (this.agreement?.startDate && this.agreement?.endDate) {
    const now = new Date();
    const endDate = new Date(this.agreement.endDate);
    const daysUntilExpiry = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
    const reminderDays = this.agreement.reminderBeforeExpiry || 30;

    if (daysUntilExpiry < 0) {
      this.agreement.status = 3;
    } else if (daysUntilExpiry <= reminderDays) {
      this.agreement.status = 2;
    } else {
      this.agreement.status = 1;
    }
  }
});

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 5 — Rental Payment Status
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  const nextBillingDate = this.rentalPayment.nextBillingDate;

  if (!nextBillingDate) {
    this.rentalPayment.status = 1;
    return;
  }

  const expireZoneDays = parseInt(
    process.env.RENTAL_EXPIRE_ZONE_DAYS || "3",
    10,
  );
  const now = new Date();
  const billingDate = new Date(nextBillingDate);
  const daysUntilBill = Math.ceil((billingDate - now) / (1000 * 60 * 60 * 24));

  if (daysUntilBill < 0) {
    this.rentalPayment.status = 3;
  } else if (daysUntilBill <= expireZoneDays) {
    this.rentalPayment.status = 2;
  } else {
    this.rentalPayment.status = 1;
  }
});

module.exports = mongoose.model("MediaOnboarding", MediaSchema);
