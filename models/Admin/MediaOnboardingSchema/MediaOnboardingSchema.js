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
      enum: [1, 2, 3, 4], // 1=1y 2=2Year 3=3Y 4=Custom
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
      enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=Quarterly 3=Half-Yearly 4=Yearly 5=2Y 6=Custom
      required: true,
    },
    customPaymentFrequency: {
      type: Number,
      min: 1,
      required: function () {
        return this.paymentFrequency === 6;
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
  amount: { type: Number, default: 0, min: 0 },
  isUtrEntry: { type: Boolean, default: false }, // ✅ ADDED
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
    amount: { type: Number, default: 0, min: 0 },
    isUtrEntry: { type: Boolean, default: false }, // ✅ ADDED
  },
  { _id: true },
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

const pendingMonthOwnerSchema = new mongoose.Schema(
  {
    landOwnerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    landOwnerName: { type: String, trim: true, default: "" },
    paymentCategory: { type: Number, enum: [1, 2, 3], default: 1 },
    cashAmount: { type: Number, default: undefined },
    cashEntry: { type: Boolean, default: undefined },
    onlineAmount: { type: Number, default: undefined },
    onlineEntry: { type: Boolean, default: undefined },
    pendingType: {
      type: String,
      enum: ["cashPending", "onlinePending", "cash+onlinePending"],
      default: null,
    },
  },
  { _id: false },
);

const pendingMonthSchema = new mongoose.Schema(
  {
    month: { type: String, trim: true }, // "May 2026"
    cycle: { type: Date, default: null },
    owners: [pendingMonthOwnerSchema],
  },
  { _id: false },
);
const gstOutstandingHistorySchema = new mongoose.Schema({
  dueMonth: {
    type: String, // Format: "MMM YYYY" e.g., "May 2026"
    required: true,
  },
  gstOutStandingAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  updatedAt: {
    type: Date,
    default: null,
  },
  updatedBy: {
    type: String,
    default: "",
  },
  paymentMode: {
    type: String,
    enum: ["Cash", "Online", "Cash+Online", null],
    default: null,
  },
  utrNumber: { type: String, trim: true, default: null },
  date: { type: Date, default: null },
  isPaid: { type: Boolean, default: false },
  // populated only when paymentMode === "Cash+Online"
  paymentBreakup: [
    {
      paymentMode: { type: String, enum: ["Cash", "Online"] },
      amount: { type: Number, default: 0 },
      utrNumber: { type: String, default: null },
      date: { type: Date, default: null },
    },
  ],
});
const rentalOutstandingHistorySchema = new mongoose.Schema({
  dueMonth: {
    type: String, // Format: "MMM YYYY" e.g., "June 2026"
    required: true,
  },
  baseRentOutstandingAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  paymentMode: {
    type: String,
    enum: ["Cash", "Online", "Cash+Online", null],
    default: null,
  },
  utrNumber: { type: String, trim: true, default: null },
  date: { type: Date, default: null },
  isPaid: { type: Boolean, default: false },
  paymentBreakup: [
    {
      paymentMode: { type: String, enum: ["Cash", "Online"] },
      amount: { type: Number, default: 0 },
      utrNumber: { type: String, default: null },
      date: { type: Date, default: null },
    },
  ],
  updatedAt: {
    type: Date,
    default: null,
  },
  updatedBy: {
    type: String,
    default: "",
  },
});
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
      default: 2,
    },
    numberOfLandOwners: {
      type: Number,
      min: 1,
    },
    siteBillMode: {
      // ← ADDED
      type: Number,
      enum: [1, 2], // 1 = single, 2 = seperate
      default: null,
    },
    landOwnerMasterIds: [
      // ← ADD THIS
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "LandOwnerMaster",
      },
    ],
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

      outStantStatus: {
        // ← ADDED
        type: Number,
        enum: [0, 1], // 0 no 1 yes
        default: 0,
      },
      gstOutstandingHistory: [gstOutstandingHistorySchema],
      rentalOutstandingHistory: [rentalOutstandingHistorySchema],
      totalRentalAmountWithGst: {
        type: Number,
        default: 0,
      },
      paymentFrequency: {
        type: Number,
        enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=Quarterly 3=Half-Yearly 4=Yearly 5=2Y 6=Custom
        required: true,
      },
      customPaymentFrequency: {
        type: Number,
        min: 1,
        required: function () {
          return this.paymentFrequency === 6;
        },
      },
      lastBillPaidDate: {
        type: Date,
        required: true,
      },
      previousBillGenerateDate: {
        type: Date,
      },
      nextBillingDate: {
        type: Date,
      },
      billingStartDate: { type: Date, default: null },
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
        landOwnerMasterId: {
          // ← ADD THIS
          type: mongoose.Schema.Types.ObjectId,
          ref: "LandOwnerMaster",
          default: null,
        },

        name: { type: String, trim: true },
        phone: { type: String, trim: true },
        bankName: { type: String, trim: true },
        ifsc: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        upiId: { type: String, trim: true },
        panNumber: { type: String, trim: true, uppercase: true },
        aadharCardNumber: { type: String, trim: true },

        paymentCategory: {
          type: Number,
          enum: [1, 2, 3], // 1 cash, 2 online 3 cash + online
          required: true,
        },
        eligibleMode: {
          // ← ADDED
          type: Number,
          enum: [1, 2], // 1 = Cash, 2 = Online
          default: null,
        },
        landOwnerBillMode: {
          // ← ADDED
          type: Number,
          enum: [1, 2], // 1 = single, 2 = seperate
          default: null,
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
        aadharCardImage: {
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
            tdsApplicable: { type: Number, enum: [0, 1], default: 0 },
            tdsPercentage: { type: Number, min: 0, max: 100, default: 0 },
            tdsAmount: { type: Number, min: 0, default: 0 },

            // ✅ NEW — GST is per-site now, same reasoning as TDS above.
            // gstAmount already existed; adding the applicable/percentage
            // flags so the UI can show "why" this site has a GST amount.
            gstApplicable: { type: Number, enum: [0, 1], default: 0 },
            gstPercentage: { type: Number, min: 0, default: 0 },
            gstAmount: { type: Number, default: 0, min: 0 },
            updatedAt: { type: Date, default: null },
          },
        ],
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
          enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=Quarterly 3=Half-Yearly 4=Yearly 5=2Y 6=Custom
          required: true,
        },
        customPaymentFrequency: {
          type: Number,
          min: 1,
          required: function () {
            return this.paymentFrequency === 6;
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
        enum: [1, 2, 3, 4], // 1=1y 2=2Year 3=3Y 4=Custom
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
    pendingMonths: [pendingMonthSchema],

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
    pastgstApplicableFlag: {
      type: Number,
      default: 0,
    },
    rentalDueHistory: [rentalDueHistoryYearSchema],
    verificationProgressHistory: [verificationProgressSchema],
    gstBalanceHistory: [gstBalanceSchema],
    createdAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 1 — Total Sq Ft
// ─────────────────────────────────────────────────────────────
MediaSchema.post("init", function (doc) {
  if (doc.rentalPayment) {
    doc._originalLastBillPaidDate = doc.rentalPayment.lastBillPaidDate;
  }
});

MediaSchema.pre("save", function () {
  this.totalSqFt = this.width * this.height;
});

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 3 — Next Billing Date
// ─────────────────────────────────────────────────────────────
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
//     // ✅ FIXED — for percentage-type owners, shareAmount is ALWAYS
//     // recalculated fresh from sharePercentage × totalRentalAmount on
//     // EVERY save, regardless of whatever value was previously stored
//     // or echoed back by the frontend. This prevents a stale
//     // shareAmount (computed under a DIFFERENT GST state) from
//     // silently carrying forward and dragging tdsAmount/gstAmount
//     // along with it, which is what made toggling GST on/off look
//     // like "everything changed" — really it was one stale field
//     // never being refreshed.
//     //
//     // Fixed-amount owners (typeShare === 2) still respect whatever
//     // shareAmount the frontend explicitly sends, since there's no
//     // formula to derive it from — it's a manually-entered value.
//     let resolvedShareAmount;

//     if (Number(owner.typeShare) === 1) {
//       const sharePercentage = Number(owner.sharePercentage || 0);
//       resolvedShareAmount = Math.round(
//         (totalRentalAmount * sharePercentage) / 100,
//       );
//     } else {
//       resolvedShareAmount = Number(owner.shareAmount || 0);
//     }

//     owner.shareAmount = resolvedShareAmount;
//   const paymentCategory = Number(owner.paymentCategory || 1);
//     let tdsBaseAmount = 0;

//     if (paymentCategory === 1) {
//       tdsBaseAmount = 0; // cash only — no TDS
//     } else if (paymentCategory === 2) {
//       tdsBaseAmount = resolvedShareAmount; // online only — full share
//     } else if (paymentCategory === 3) {
//       tdsBaseAmount = Number(owner.onlineAmount || 0); // split — ONLY online portion
//     }
//     // ── TDS — on this owner's own shareAmount (now always fresh) ──
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
//         ? Math.round((tdsBaseAmount * tdsPercentage) / 100)
//         : 0;
//     owner.tdsAmount = tdsAmount;

//     // ── GST base depends on WHICH GST source is active ──
//     let gstBaseAmount = 0;

//     if (rentalGstApplicable === 1) {
//       gstBaseAmount = resolvedShareAmount;
//     } else {
//       // const paymentCategory = Number(owner.paymentCategory || 1);
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

//   // rp.netPayable =
//   //   totalRentalAmount - totalTdsAcrossOwners + totalGstAcrossOwners;
// rp.netPayable =
//   totalRentalAmount + totalTdsAcrossOwners + totalGstAcrossOwners;
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
    rp.netPayable = totalRentalAmount + rp.gstAmount;
    return;
  }

  this.landOwners.forEach((owner) => {
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
    const paymentCategory = Number(owner.paymentCategory || 1);

    // ✅ FIXED — ensure onlineAmount and cashAmount are synced for
    // Online-only (2) and Cash-only (1) owners. For category 3, they
    // must be handled by the controller's scaling logic since the
    // split is manual.
    if (paymentCategory === 1) {
      owner.cashAmount = resolvedShareAmount;
      owner.onlineAmount = 0;
    } else if (paymentCategory === 2) {
      owner.cashAmount = 0;
      owner.onlineAmount = resolvedShareAmount;
    }

    let tdsBaseAmount = 0;

    if (paymentCategory === 1) {
      tdsBaseAmount = 0;
    } else if (paymentCategory === 2) {
      tdsBaseAmount = resolvedShareAmount;
    } else if (paymentCategory === 3) {
      tdsBaseAmount = Number(owner.onlineAmount || 0);
    }

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
        ? Math.round((tdsBaseAmount * tdsPercentage) / 100)
        : 0;
    owner.tdsAmount = tdsAmount;

    // ✅ FIXED — owner-level GST is now ENTIRELY independent of
    // rentalGstApplicable. When rentalPayment.gstApplicable is on,
    // GST is tracked ONLY at the rentalPayment level (rp.gstAmount,
    // already included in totalRentalAmountWithGst) — it no longer
    // forces every owner's gstApplicable to 1 or computes a
    // duplicate owner-level gstAmount on top of it.
    let gstBaseAmount = 0;
    const paymentCategoryForGst = Number(owner.paymentCategory || 1);

    if (paymentCategoryForGst === 1) {
      gstBaseAmount = 0;
    } else if (paymentCategoryForGst === 2) {
      gstBaseAmount = resolvedShareAmount;
    } else if (paymentCategoryForGst === 3) {
      gstBaseAmount = Number(owner.onlineAmount || 0);
    }

    const ownerGstApplicable = Number(owner.gstApplicable || 0);
    const ownerGstPct = Number(owner.gstPercentage || 0) || envGstPct;

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

  // ✅ FIXED — was choosing EITHER rp.gstAmount (rentalPayment-level GST)
  // OR totalGstAcrossOwners (landOwner-level GST), never both. Here
  // rentalPayment.gstApplicable is 0 (rp.gstAmount is correctly 0), but
  // the landOwner has gstApplicable:1 / gstAmount:9000 — that amount was
  // being dropped from netPayable entirely. Now both are summed:
  // rp.gstAmount is 0 when rentalGstApplicable isn't 1, so this simply
  // adds whatever GST actually exists on either side.
  const effectiveGstAmount = Number(rp.gstAmount || 0) + totalGstAcrossOwners;

  rp.netPayable = totalRentalAmount + effectiveGstAmount;

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
      gstApplicable: Number(owner.gstApplicable || 0), // ✅ CHANGED — always own flag
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
    const frequencyMap = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
    const monthsToAdd =
      Number(rp.paymentFrequency) === 6
        ? Number(rp.customPaymentFrequency) || 1
        : frequencyMap[Number(rp.paymentFrequency)] || 1;

    // ✅ NEW: Centralized Cyclic logic
    if (!rp.previousBillGenerateDate && rp.lastBillPaidDate) {
      const prevDate = new Date(rp.lastBillPaidDate);
      prevDate.setMonth(prevDate.getMonth() - monthsToAdd);

      // ✅ CLAMP — don't go before billingStartDate (onboarding anchor)
      const anchor = rp.billingStartDate || rp.lastBillPaidDate;
      if (prevDate < new Date(anchor)) {
        rp.previousBillGenerateDate = anchor;
      } else {
        rp.previousBillGenerateDate = prevDate;
      }
    } else if (
      !this.isNew &&
      this.isModified("rentalPayment.lastBillPaidDate") &&
      !this.isModified("rentalPayment.previousBillGenerateDate")
    ) {
      if (this._originalLastBillPaidDate) {
        const oldDate = new Date(this._originalLastBillPaidDate);
        const newDate = new Date(rp.lastBillPaidDate);
        const diffDays = Math.abs(newDate - oldDate) / (1000 * 60 * 60 * 24);

        // threshold to detect cycle jump vs manual tweak
        if (diffDays > 15) {
          rp.previousBillGenerateDate = oldDate;
        }
      }
    }

    // ✅ NEW: Auto-catchup logic for backdated entries
    const now = new Date();
    const currentMonthKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;

    let cursor = new Date(rp.lastBillPaidDate);
    let nextDate = new Date(cursor);
    nextDate.setMonth(nextDate.getMonth() + monthsToAdd);

    let safety = 0;
    while (safety < 240) {
      // If the NEXT billing date month has already started, advance.
      const nextMonthStarted =
        nextDate.getUTCFullYear() < now.getUTCFullYear() ||
        (nextDate.getUTCFullYear() === now.getUTCFullYear() &&
          nextDate.getUTCMonth() <= now.getUTCMonth());

      if (!nextMonthStarted) break;

      rp.previousBillGenerateDate = new Date(cursor);
      cursor = new Date(nextDate);
      nextDate = new Date(cursor);
      nextDate.setMonth(nextDate.getMonth() + monthsToAdd);

      rp.lastBillPaidDate = cursor;
      safety++;
    }

    rp.nextBillingDate = nextDate;

    // ✅ NEW: Sync rentalDue entry if lastBillPaidDate was manually tweaked
    if (!this.isNew && this.isModified("rentalPayment.lastBillPaidDate")) {
      const newLBP = new Date(rp.lastBillPaidDate);
      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      const dueMonthLabel = `${monthNames[newLBP.getMonth()]} ${newLBP.getFullYear()}`;

      const matchingDue = (this.rentalDue || []).find(
        (d) => d.dueMonth === dueMonthLabel,
      );
      if (matchingDue) {
        matchingDue.dueDate = newLBP;
      }
    }
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
MediaSchema.pre("save", function () {
  if (
    this.isNew &&
    this.rentalPayment &&
    !this.rentalPayment.billingStartDate
  ) {
    this.rentalPayment.billingStartDate = this.rentalPayment.lastBillPaidDate;
  }
});
// ✅ NEW — advances lastBillPaidDate/nextBillingDate for REAL, based on
// billingStartDate + paymentFrequency, whenever today's date has moved
// past what's currently stored. Run this on a schedule (see cron example
// below) — it's idempotent, safe to run as often as you like, and only
// writes when a real advance is due.
const CYCLE_MONTHS_BY_FREQUENCY = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };

function addMonthsUTC(date, months) {
  const d = new Date(date);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Handle month-end overflow (e.g., Jan 31 + 1 month -> March 3)
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0);
  }
  return d;
}

MediaSchema.statics.syncBillingCycles = async function (asOfDate = new Date()) {
  const activeSites = await this.find({
    status: 1,
    "rentalPayment.billingStartDate": { $ne: null },
  }).select("rentalPayment mediaName landOwners updatedAt");

  let updatedCount = 0;
  const debugLog = [];

  // ✅ FIXED — compare by CALENDAR MONTH, not exact date. Previously
  // required the exact billing day (e.g. the 12th) to have passed before
  // advancing, so "August 7" didn't count as August yet. Everywhere else
  // in the system (getAllDueCycles, List/History) treats a new calendar
  // month as the new cycle immediately on the 1st — this now matches
  // that, while still PRESERVING the original day-of-month for the
  // resulting stored date (still the 12th, just in the right month).
  const asOfMonthKey = `${asOfDate.getUTCFullYear()}-${asOfDate.getUTCMonth()}`;

  for (const media of activeSites) {
    const {
      billingStartDate,
      paymentFrequency,
      customPaymentFrequency,
      lastBillPaidDate,
    } = media.rentalPayment || {};

    if (!billingStartDate || !lastBillPaidDate) {
      debugLog.push({
        mediaName: media.mediaName,
        skipped: "missing billingStartDate or lastBillPaidDate",
      });
      continue;
    }

    const cycleMonths =
      paymentFrequency === 6
        ? Number(customPaymentFrequency) || 1
        : CYCLE_MONTHS_BY_FREQUENCY[paymentFrequency] || 1;

    let cursor = new Date(lastBillPaidDate);
    let previousCursor = new Date(lastBillPaidDate);
    let advanced = false;
    let guard = 0;

    while (guard < 240) {
      const nextCycle = addMonthsUTC(cursor, cycleMonths);
      const nextCycleMonthKey = `${nextCycle.getUTCFullYear()}-${nextCycle.getUTCMonth()}`;
      // ✅ CHANGED — advance if the NEXT cycle's month has already
      // started (its month <= asOfDate's month), not requiring the exact
      // day to have passed.
      const nextCycleMonthStarted =
        nextCycle.getUTCFullYear() < asOfDate.getUTCFullYear() ||
        (nextCycle.getUTCFullYear() === asOfDate.getUTCFullYear() &&
          nextCycle.getUTCMonth() <= asOfDate.getUTCMonth());
      if (!nextCycleMonthStarted) break;
      previousCursor = new Date(cursor);
      cursor = nextCycle;
      advanced = true;
      guard++;
    }

    if (advanced) {
      media.rentalPayment.previousBillGenerateDate = previousCursor;
      media.rentalPayment.lastBillPaidDate = cursor;
      media.rentalPayment.nextBillingDate = addMonthsUTC(cursor, cycleMonths);
      await media.save({ timestamps: false });
      updatedCount++;
      debugLog.push({ mediaName: media.mediaName, advancedTo: cursor });
    } else {
      debugLog.push({
        mediaName: media.mediaName,
        notAdvanced: true,
        lastBillPaidDate,
        nextCycleWouldBe: addMonthsUTC(new Date(lastBillPaidDate), cycleMonths),
      });
    }
  }

  return {
    checked: activeSites.length,
    updated: updatedCount,
    asOfDateUsed: asOfDate,
    debugLog,
  };
};
module.exports = mongoose.model("MediaOnboarding", MediaSchema);
