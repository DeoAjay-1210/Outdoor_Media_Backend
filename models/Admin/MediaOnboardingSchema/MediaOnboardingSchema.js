const mongoose = require("mongoose");
const {
  rentalDueEntrySchema,
  rentalDueHistoryYearSchema,
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
    enum: [1, 2, 3], // 1=Active  2=Expire Zone  3=Expired
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
      enum: [1, 2, 3, 4, 5, 6],
      default: 1,
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

const ledgerSchema = new mongoose.Schema(
  {
    utrNumber: { type: String, trim: true },
    date: { type: Date, default: Date.now },
    status: {
      type: Number,
      enum: [0, 1], // 0=not Approve 1=Approve
      default: 0,
    },
    updatedBy: { type: String },
    updatedAt: { type: Date, default: null },
  },
  // { timestamps: true },
);

const ledgerHistoryEntrySchema = new mongoose.Schema(
  {
    mediaName: { type: String, trim: true },
    paymentFrequency: { type: Number, trim: true },
    netPayable: { type: Number, trim: true },
    nextBillingDate: {type: Date},
    utrNumber: { type: String, trim: true },
    date: { type: Date },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String },
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
        enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
        required: true,
      },
      lastBillPaidDate: {
        type: Date,
        required: true,
      },
      nextBillingDate: {
        type: Date,
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
        default: 0,
      },
      netPayable: {
        type: Number,
        default: 0,
      },
      status: {
        type: Number,
        enum: [1, 2, 3], // 1=Active 2=Expire Zone 3=Expired
        default: 1,
      },
      ownerPayments: [ownerPaymentSchema],
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
        enum: [1, 2, 3], // 1=Active 2=Expire Zone 3=Expired
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
        uploadedAt: { type: Date, default: Date.now },
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
          enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
          default: 1,
        },
        updatedBy: { type: String },
        updatedAt: { type: Date, default: null },
      },
    },

    // ─────────────────────────────────────────────────────────
    // AGREEMENT HISTORY  ← NEW
    // Every create, and every update where startDate or endDate changes,
    // pushes a snapshot here so you have a full audit trail.
    // ─────────────────────────────────────────────────────────
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
      uploadedAt: { type: Date, default: Date.now },
    },
    sideView: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: Date.now },
    },
    locationView: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: Date.now },
    },
    additionalImages: {
      originalName: { type: String },
      fileName: { type: String },
      filePath: { type: String },
      mimeType: { type: String },
      size: { type: Number },
      fileType: { type: String, enum: ["image"], default: "image" },
      uploadedAt: { type: Date, default: Date.now },
    },

    // ─────────────────────────────────────────────────────────
    // LEDGER  ← NEW
    // status: 0=In Progress 1=Approve (default) 2=Reject
    // Each pushed entry's _id is the "objectId" used by the list/filter API.
    // ─────────────────────────────────────────────────────────
    ledger: [ledgerSchema],

    // ─────────────────────────────────────────────────────────
    // LEDGER HISTORY  ← NEW
    // Auto-bucketed by year -> month. Whenever a ledger entry is
    // created, the same entry is also appended here under the
    // current year (e.g. "2026") and current month name (e.g. "June"),
    // auto-creating those buckets the first time they're needed.
    // ─────────────────────────────────────────────────────────
    ledgerHistory: [ledgerHistoryYearSchema],

    // ─────────────────────────────────────────────────────────
    // RENTAL DUE  ← NEW MODULE
    // Each entry represents one billing cycle's due record.
    // Tracks campaign, proof image, agreement doc verification,
    // 3-level approval chain, and who saved the entry.
    // ─────────────────────────────────────────────────────────
   agreementDocVerification: [agreementDocVerificationSchema],
    rentalDue: [rentalDueEntrySchema],

    // ─────────────────────────────────────────────────────────
    // RENTAL DUE HISTORY  ← NEW
    // Auto-bucketed Year → Month audit trail, mirroring ledgerHistory.
    // ─────────────────────────────────────────────────────────
    rentalDueHistory: [rentalDueHistoryYearSchema],
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
MediaSchema.pre("save", function () {
  const rp = this.rentalPayment;
  const totalRentalAmount = Number(rp.totalRentalAmount || 0);
  const rentalGstApplicable = Number(rp.gstApplicable || 0);

  // ── STEP A: TDS ───────────────────────────────────────────
  const tdsApplicable = Number(rp.tdsApplicable || 0);
  const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
  const tdsPercentage =
    tdsApplicable === 1
      ? envTdsPercent > 0
        ? envTdsPercent
        : Number(rp.tdsPercentage || 0)
      : 0;

  rp.tdsPercentage = tdsPercentage;

  const tdsAmount =
    tdsApplicable === 1 && tdsPercentage > 0
      ? parseFloat(((totalRentalAmount * tdsPercentage) / 100).toFixed(2))
      : 0;

  rp.tdsAmount = tdsAmount;

  const amountAfterTds = parseFloat((totalRentalAmount - tdsAmount).toFixed(2));

  // ── STEP B: GST (rental-level) ───────────────────────────
  let gstAmount = 0;
  let totalRentalAmountWithGst = totalRentalAmount;

  if (rentalGstApplicable === 1) {
    const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
    rp.gstPercentage = envGstPct;
    gstAmount = parseFloat(((totalRentalAmount * envGstPct) / 100).toFixed(2));
    totalRentalAmountWithGst = parseFloat(
      (amountAfterTds + gstAmount).toFixed(2),
    );
  } else {
    rp.gstPercentage = 0;
    gstAmount = 0;
    totalRentalAmountWithGst = amountAfterTds;
  }

  rp.gstAmount = gstAmount;
  rp.totalRentalAmountWithGst = totalRentalAmountWithGst;

  // ── STEP C: Net Payable ──────────────────────────────────
  let netPayable = parseFloat(totalRentalAmountWithGst.toFixed(2));
  rp.netPayable = netPayable;

  // ── STEP D: APPRAISAL OVERRIDE ───────────────────────────
  if (Number(this.appraisal?.applicable) === 1) {
    const nextAppraisalDate = this.appraisal?.nextAppraisalDate
      ? new Date(this.appraisal.nextAppraisalDate)
      : null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (nextAppraisalDate) {
      const appraisalDay = new Date(nextAppraisalDate);
      appraisalDay.setHours(0, 0, 0, 0);

      if (appraisalDay <= today) {
        const historyEntry = Array.isArray(this.appraisal.history)
          ? this.appraisal.history.find(
              (item) =>
                item.appraisalDate &&
                new Date(item.appraisalDate).setHours(0, 0, 0, 0) ===
                  appraisalDay.getTime(),
            )
          : null;

        if (historyEntry && Number(historyEntry.newRent) > 0) {
          netPayable = Number(historyEntry.newRent);
          rp.netPayable = netPayable;
        }
      }
    }
  }

  if (!this.landOwners || !this.landOwners.length) return;

  // ── STEP E: OWNER SHARE CALCULATION ──────────────────────
  const ownerSplitBaseAmount = netPayable;
  const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");

  this.landOwners.forEach((owner) => {
    if (Number(owner.typeShare) === 1) {
      const sharePercentage = Number(owner.sharePercentage || 0);
      owner.shareAmount = parseFloat(
        ((ownerSplitBaseAmount * sharePercentage) / 100).toFixed(2),
      );
    } else if (Number(owner.typeShare) === 2) {
      owner.sharePercentage = undefined;
      owner.shareAmount = parseFloat(Number(owner.shareAmount || 0).toFixed(2));
    }

    const ownerGstApplicable =
      rentalGstApplicable === 0 ? Number(owner.gstApplicable || 0) : 0;
    const paymentCategory = Number(owner.paymentCategory || 1);

    if (ownerGstApplicable === 1 && paymentCategory !== 1) {
      let onlinePortionForGst = 0;
      if (paymentCategory === 2) {
        onlinePortionForGst = Number(owner.shareAmount || 0);
      } else if (paymentCategory === 3) {
        onlinePortionForGst = Number(owner.onlineAmount || 0);
      }

      const ownerGstAmount = parseFloat(
        ((onlinePortionForGst * envGstPct) / 100).toFixed(2),
      );
      owner.gstPercentage = envGstPct;
      owner.gstAmount = ownerGstAmount;
      owner.totalAmountWithGst = parseFloat(
        (Number(owner.shareAmount || 0) + ownerGstAmount).toFixed(2),
      );
    } else {
      owner.gstPercentage = 0;
      owner.gstAmount = 0;
      owner.totalAmountWithGst = Number(owner.shareAmount || 0);
    }
  });

  // ── STEP F: OWNER PAYMENTS ───────────────────────────────
  rp.ownerPayments = this.landOwners.map((owner) => {
    const ownerAmount = Number(owner.shareAmount || 0);
    const paymentCategory = Number(owner.paymentCategory || 1);
    const ownerGstApplicable =
      rentalGstApplicable === 0 ? Number(owner.gstApplicable || 0) : 0;

    const payment = {
      ownerId: owner._id,
      ownerName: owner.name,
      percentage:
        Number(owner.typeShare) === 1
          ? Number(owner.sharePercentage || 0)
          : null,
      amount: ownerAmount,
      paymentCategory,
      gstApplicable: ownerGstApplicable,
      gstPercentage:
        ownerGstApplicable === 1 ? Number(owner.gstPercentage || 0) : 0,
      gstAmount: ownerGstApplicable === 1 ? Number(owner.gstAmount || 0) : 0,
      totalAmountWithGst:
        ownerGstApplicable === 1
          ? Number(owner.totalAmountWithGst || ownerAmount)
          : ownerAmount,
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

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 3 — Next Billing Date
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  const isNewDoc = this.isNew;
  const billingDateProvided = this.rentalPayment.nextBillingDate != null;

  if (isNewDoc && billingDateProvided) return;

  if (
    this.rentalPayment.lastBillPaidDate &&
    this.rentalPayment.paymentFrequency
  ) {
    const frequencyMap = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 12, 6: 24 };
    const monthsToAdd = frequencyMap[this.rentalPayment.paymentFrequency] || 1;
    const nextDate = new Date(this.rentalPayment.lastBillPaidDate);
    nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
    this.rentalPayment.nextBillingDate = nextDate;
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
