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
  paymentMode: { type: String, enum: ["Cash", "Online"], default: null }, // ✅ NEW
  utrNumber: { type: String, trim: true },
  date: { type: Date, default: null },
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
    paymentMode: { type: String, enum: ["Cash", "Online"], default: null },
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
// ✅ NEW — TDS balance history, same shape as gstBalanceHistory
const tdsBalanceSchema = new mongoose.Schema(
  {
    dueMonth: { type: String, trim: true },
    cycle: { type: Date, default: null },
    tdsAmount: { type: Number, default: 0, min: 0 },
    isUtrEntry: { type: Boolean, default: false },
    paidAmount: { type: Number, default: 0 },
    paidAt: { type: Date, default: null },
    paidBy: { type: String, trim: true },
    createdAt: { type: Date, default: null },
    createdBy: { type: String, trim: true },
    landOwnerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    landOwnerName: { type: String, trim: true, default: "" },
    utrNumber: { type: String, trim: true, default: "" },
    date: { type: Date, default: null },
  },
  { _id: true },
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
    tdsBalanceHistory: [tdsBalanceSchema],

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


// MediaSchema.pre("save", function () {
//   const rp = this.rentalPayment;
//   const totalRentalAmount = Number(rp.totalRentalAmount || 0);
//   const rentalGstApplicable = Number(rp.gstApplicable || 0);
//   const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
//   const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");

//   rp.gstPercentage = rentalGstApplicable === 1 ? envGstPct : 0;
//   rp.gstAmount =
//     rentalGstApplicable === 1
//       ? Math.round((totalRentalAmount * envGstPct) / 100)
//       : 0;
//   rp.totalRentalAmountWithGst = totalRentalAmount + rp.gstAmount;

//   if (!this.landOwners || !this.landOwners.length) {
//     rp.netPayable = totalRentalAmount;
//     return;
//   }

//   this.landOwners.forEach((owner) => {
//     // ── shareAmount: respect frontend value; fall back to
//     // sharePercentage-derived amount ONLY if not sent at all ──
//     const ownerShareFromFrontend = Number(owner.shareAmount || 0);
//     let resolvedShareAmount = ownerShareFromFrontend;
//     if (!resolvedShareAmount && Number(owner.typeShare) === 1) {
//       const sharePercentage = Number(owner.sharePercentage || 0);
//       resolvedShareAmount = Math.round(
//         (totalRentalAmount * sharePercentage) / 100,
//       );
//     }
//     owner.shareAmount = resolvedShareAmount;

//     // ── TDS — on this owner's own shareAmount ──
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
//         ? Math.round((resolvedShareAmount * tdsPercentage) / 100)
//         : 0;
//     owner.tdsAmount = tdsAmount;

//     // ── GST base depends on WHICH GST source is active ──
//     let gstBaseAmount = 0;

//     if (rentalGstApplicable === 1) {
//       gstBaseAmount = resolvedShareAmount;
//     } else {
//       const paymentCategory = Number(owner.paymentCategory || 1);
//       if (paymentCategory === 1) {
//         gstBaseAmount = 0;
//       } else if (paymentCategory === 2) {
//         gstBaseAmount = resolvedShareAmount;
//       } else if (paymentCategory === 3) {
//         gstBaseAmount = Number(owner.onlineAmount || 0);
//       }
//     }

//     const ownerGstApplicable =
//       rentalGstApplicable === 1 ? 1 : Number(owner.gstApplicable || 0);
//     const ownerGstPct =
//       rentalGstApplicable === 1
//         ? envGstPct
//         : Number(owner.gstPercentage || 0) || envGstPct;

//     const ownerGstAmount =
//       ownerGstApplicable === 1 && gstBaseAmount > 0
//         ? Math.round((gstBaseAmount * ownerGstPct) / 100)
//         : 0;

//     owner.gstPercentage =
//       ownerGstApplicable === 1 && gstBaseAmount > 0 ? ownerGstPct : 0;
//     owner.gstAmount = ownerGstAmount;

//     owner.totalAmountWithGst = resolvedShareAmount + ownerGstAmount;
//     owner.netPayableToOwner = owner.totalAmountWithGst;
//     owner.netPayable = owner.totalAmountWithGst;
//   });

//   const totalTdsAcrossOwners = this.landOwners.reduce(
//     (sum, owner) => sum + Number(owner.tdsAmount || 0),
//     0,
//   );
//   const totalGstAcrossOwners = this.landOwners.reduce(
//     (sum, owner) => sum + Number(owner.gstAmount || 0),
//     0,
//   );

//   rp.netPayable =
//     totalRentalAmount - totalTdsAcrossOwners + totalGstAcrossOwners;

//   rp.ownerPayments = this.landOwners.map((owner) => {
//     const ownerAmount = Number(owner.shareAmount || 0);
//     const paymentCategory = Number(owner.paymentCategory || 1);

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
//       gstApplicable:
//         rentalGstApplicable === 1 ? 1 : Number(owner.gstApplicable || 0),
//       gstPercentage: Number(owner.gstPercentage || 0),
//       gstAmount: Number(owner.gstAmount || 0),
//       totalAmountWithGst: Number(owner.totalAmountWithGst || ownerAmount),
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
    // ✅ FIXED — for percentage-type owners, shareAmount is ALWAYS
    // recalculated fresh from sharePercentage × totalRentalAmount on
    // EVERY save, regardless of whatever value was previously stored
    // or echoed back by the frontend. This prevents a stale
    // shareAmount (computed under a DIFFERENT GST state) from
    // silently carrying forward and dragging tdsAmount/gstAmount
    // along with it, which is what made toggling GST on/off look
    // like "everything changed" — really it was one stale field
    // never being refreshed.
    //
    // Fixed-amount owners (typeShare === 2) still respect whatever
    // shareAmount the frontend explicitly sends, since there's no
    // formula to derive it from — it's a manually-entered value.
    let resolvedShareAmount;

    if (Number(owner.typeShare) === 1) {
      const sharePercentage = Number(owner.sharePercentage || 0);
      resolvedShareAmount = Math.round(
        (totalRentalAmount * sharePercentage) / 100,
      );
    } else {
      resolvedShareAmount = Number(owner.shareAmount || 0);
    }

    owner.shareAmount = resolvedShareAmount;

    // ── TDS — on this owner's own shareAmount (now always fresh) ──
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
