

const mongoose = require("mongoose");

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
    // null for typeShare=2 owners (amount-based, no percentage)
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
    // Per-owner GST (only when rentalPayment.gstApplicable=0 and owner paymentCategory=2 or 3)
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

const APPRAISAL_HISTORY_SCHEMA = new mongoose.Schema(
  {
    appraisalDate: {
      type: Date,
    },
    type: {
      type: Number, // 1=Percentage, 2=Fixed
    },
    percentage: {
      type: Number,
      default: 0,
    },
    fixedAmount: {
      type: Number,
      default: 0,
    },
    previousRent: {
      type: Number,
      default: 0,
    },
    appraisalAmount: {
      type: Number,
      default: 0,
    },
    newRent: {
      type: Number,
      default: 0,
    },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────
const MediaSchema = new mongoose.Schema(
  {
    mediaId: {
      type: String,
      unique: true,
      sparse: true,
    },
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
      // gstApplicable: 0=No  1=Yes
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

        // paymentCategory: 1=Cash  2=Online  3=Cash+Online
        // NOTE: When rentalPayment.gstApplicable=1, only paymentCategory=2 (Online) is allowed
        paymentCategory: {
          type: Number,
          enum: [1, 2, 3],
          required: true,
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

        // typeShare: 1=sharePercentage  2=shareAmount (fixed)
        typeShare: {
          type: Number,
          enum: [1, 2],
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

        // ── Per-owner GST ──────────────────────────────────────
        // Only applicable when rentalPayment.gstApplicable=0
        // and owner paymentCategory=2 (Online) or 3 (Cash+Online)
        // When set to 1, GST is added ON TOP of this owner's share
        // (not deducted from netPayable split).
        // Case 1 (cash only, cat=1)         → gstApplicable irrelevant, no GST
        // Case 2 (cash+online, cat=3, gst=1)→ GST added on top of onlineAmount only
        // Case 3 (cash only, cat=1)          → netPayable-based split
        // Case 4 (online only, cat=2, gst=1) → GST added on top; not netPayable-based split
        // Case 5 (rentalPayment gst=1)       → always online (cat=2), no per-owner GST field used
        // Case 6 (rentalPayment gst=0, any cat) → per-owner gstApplicable respected
        // Case 7 (rentalPayment gst=0, online, gst=1) → GST on top; not netPayable-based split
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
      status: {
        type: Number,
        enum: [1, 2, 3], // 1=Active 2=Expire Zone 3=Expired
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
    },

    // ─────────────────────────────────────────────────────────
    // APPRAISAL
    // ─────────────────────────────────────────────────────────
    appraisal: {
      applicable: {
        type: Number,
        enum: [0, 1],
        default: 0,
      },
      type: {
        type: Number, // 1=Percentage, 2=Fixed
        enum: [1, 2],
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
    totalRentalAmountWithGst = parseFloat((amountAfterTds + gstAmount).toFixed(2));
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

  // ── STEP D: APPRAISAL OVERRIDE ────────────────────────────
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
                  appraisalDay.getTime()
            )
          : null;

        if (historyEntry && Number(historyEntry.newRent) > 0) {
          netPayable = Number(historyEntry.newRent);
          rp.netPayable = netPayable;
        }
      }
    }
  }

  // ── NO LAND OWNERS ───────────────────────────────────────
  if (!this.landOwners || !this.landOwners.length) return;

  // ── STEP E: OWNER SHARE CALCULATION ──────────────────────
  // netPayable is the base for percentage-based splits.
  // When rentalPayment.gstApplicable=0 and a specific owner has
  // gstApplicable=1 (on their online portion), their GST is added
  // ON TOP of their share and is NOT deducted from the netPayable pool.

  const ownerSplitBaseAmount = netPayable;
  const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");

  this.landOwners.forEach((owner) => {
    // ── Compute base shareAmount ──────────────────────────
    if (Number(owner.typeShare) === 1) {
      const sharePercentage = Number(owner.sharePercentage || 0);
      owner.shareAmount = parseFloat(
        ((ownerSplitBaseAmount * sharePercentage) / 100).toFixed(2)
      );
    } else if (Number(owner.typeShare) === 2) {
      owner.sharePercentage = undefined;
      owner.shareAmount = parseFloat(Number(owner.shareAmount || 0).toFixed(2));
    }

    // ── Per-owner GST (only when rentalPayment.gstApplicable=0) ──
    // GST is applicable on the online portion only (cat=2 or cat=3).
    // For cat=1 (cash only), per-owner gstApplicable is irrelevant.
    const ownerGstApplicable =
      rentalGstApplicable === 0 ? Number(owner.gstApplicable || 0) : 0;

    const paymentCategory = Number(owner.paymentCategory || 1);

    if (ownerGstApplicable === 1 && paymentCategory !== 1) {
      // GST applies to the online portion of this owner's payment.
      // For cat=2: entire shareAmount is online → GST on shareAmount.
      // For cat=3: only onlineAmount portion carries GST.
      let onlinePortionForGst = 0;

      if (paymentCategory === 2) {
        // All online
        onlinePortionForGst = Number(owner.shareAmount || 0);
      } else if (paymentCategory === 3) {
        // Mixed — GST on the online portion only
        onlinePortionForGst = Number(owner.onlineAmount || 0);
      }

      const ownerGstAmount = parseFloat(
        ((onlinePortionForGst * envGstPct) / 100).toFixed(2)
      );
      owner.gstPercentage = envGstPct;
      owner.gstAmount = ownerGstAmount;
      owner.totalAmountWithGst = parseFloat(
        (Number(owner.shareAmount || 0) + ownerGstAmount).toFixed(2)
      );
    } else {
      // No per-owner GST
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
      gstPercentage: ownerGstApplicable === 1 ? Number(owner.gstPercentage || 0) : 0,
      gstAmount: ownerGstApplicable === 1 ? Number(owner.gstAmount || 0) : 0,
      totalAmountWithGst:
        ownerGstApplicable === 1
          ? Number(owner.totalAmountWithGst || ownerAmount)
          : ownerAmount,
    };

    if (paymentCategory === 1) {
      // Cash only — no GST regardless
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

  if (this.rentalPayment.lastBillPaidDate && this.rentalPayment.paymentFrequency) {
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

  const expireZoneDays = parseInt(process.env.RENTAL_EXPIRE_ZONE_DAYS || "3", 10);
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

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 6 — Appraisal Schedule
// ─────────────────────────────────────────────────────────────
const APPRAISAL_FREQUENCY_MONTHS_MAP = {
  1: 6,
  2: 12,
  3: 24,
};

MediaSchema.pre("save", async function () {
  if (this.appraisal?.applicable !== 1) return;

  if (!this.agreement?.startDate || !this.agreement?.endDate) return;

  const agreementStartDate = new Date(this.agreement.startDate);
  const agreementEndDate = new Date(this.agreement.endDate);

  if (this.appraisal.nextAppraisalDate) {
    const nextDate = new Date(this.appraisal.nextAppraisalDate);
    if (nextDate > agreementEndDate) {
      throw new Error("Next appraisal date cannot be greater than agreement end date");
    }
  }

  let months = 0;

  if (Number(this.appraisal.frequency) === 4) {
    months = Number(this.appraisal.customFrequencyMonths || 0);
    if (months <= 0) {
      throw new Error("Custom frequency months must be greater than 0");
    }
  } else {
    months = APPRAISAL_FREQUENCY_MONTHS_MAP[Number(this.appraisal.frequency)] || 12;
  }

  if (!Array.isArray(this.appraisal.history)) {
    this.appraisal.history = [];
  }

  let oldDoc = null;
  if (!this.isNew) {
    oldDoc = await this.constructor.findById(this._id).lean();
  }

  const netPayable = Number(this.rentalPayment?.totalRentalAmount || 0);

  // Initialize currentRent for new documents
  if (this.isNew) {
    this.appraisal.currentRent = netPayable;
  } else if (!this.appraisal.currentRent || this.appraisal.currentRent <= 0) {
    this.appraisal.currentRent = netPayable;
  }

  // On update, restore history and currentRent from oldDoc
  if (!this.isNew && oldDoc) {
    if (Array.isArray(oldDoc.appraisal?.history) && oldDoc.appraisal.history.length > 0) {
      this.appraisal.history = oldDoc.appraisal.history.map((h) => ({ ...h }));
    }
    if (oldDoc.appraisal?.currentRent && oldDoc.appraisal.currentRent > 0) {
      this.appraisal.currentRent = oldDoc.appraisal.currentRent;
    }
    if (oldDoc.appraisal?.lastAppraisalDate) {
      this.appraisal.lastAppraisalDate = oldDoc.appraisal.lastAppraisalDate;
    }
  }

  // Check what changed
  let fixedAmountChanged = false;
  let nextDateChanged = false;
  let previousAppraisalAmount = 0;

  if (!this.isNew && oldDoc) {
    // Get the last appraisal amount from history
    if (Array.isArray(this.appraisal.history) && this.appraisal.history.length > 0) {
      const lastEntry = this.appraisal.history[this.appraisal.history.length - 1];
      previousAppraisalAmount = Number(lastEntry.appraisalAmount || 0);
    }

    // Check if fixedAmount changed (for type 2)
    if (Number(this.appraisal.type) === 2) {
      const oldFixedAmount = Number(oldDoc.appraisal?.fixedAmount || 0);
      const newFixedAmount = Number(this.appraisal.fixedAmount || 0);
      if (oldFixedAmount !== newFixedAmount) {
        fixedAmountChanged = true;
      }
    }
    
    // Check if nextAppraisalDate changed
    if (oldDoc.appraisal?.nextAppraisalDate && this.appraisal?.nextAppraisalDate) {
      const oldNextDate = new Date(oldDoc.appraisal.nextAppraisalDate);
      const newNextDate = new Date(this.appraisal.nextAppraisalDate);
      if (oldNextDate.getTime() !== newNextDate.getTime()) {
        nextDateChanged = true;
      }
    }
  }

  // Handle fixedAmount change only (same date) - UPDATE existing entry
  if (fixedAmountChanged && !nextDateChanged) {
    if (Array.isArray(this.appraisal.history) && this.appraisal.history.length > 0) {
      const lastIndex = this.appraisal.history.length - 1;
      const lastEntry = this.appraisal.history[lastIndex];
      
      const previousRent = Number(lastEntry.previousRent || 0);
      const newAppraisalAmount = Number(this.appraisal.fixedAmount || 0);
      const newRent = Math.round(previousRent + newAppraisalAmount);
      
      this.appraisal.history[lastIndex] = {
        ...lastEntry,
        fixedAmount: Number(this.appraisal.fixedAmount || 0),
        appraisalAmount: newAppraisalAmount,
        newRent: newRent,
        updatedBy: this._updatedBy || null,
        updatedAt: new Date(),
      };
      
      this.appraisal.currentRent = newRent;
      this.appraisal.appraisalAmount = newAppraisalAmount;
      
      if (oldDoc?.appraisal?.nextAppraisalDate) {
        this.appraisal.nextAppraisalDate = oldDoc.appraisal.nextAppraisalDate;
      }
      
      // Update totalAppraisalAmount
      const totalAppraisal = this.appraisal.history.reduce((sum, entry) => {
        return sum + Number(entry.appraisalAmount || 0);
      }, 0);
      const baseRent = Number(this.appraisal.history[0]?.previousRent || netPayable);
      this.appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);
      
      return;
    }
  }

  // Handle nextAppraisalDate change
  if (nextDateChanged && oldDoc) {
    const oldNextDate = new Date(oldDoc.appraisal.nextAppraisalDate);
    const newNextDate = new Date(this.appraisal.nextAppraisalDate);

    // Get existing history from oldDoc
    let updatedHistory = Array.isArray(oldDoc.appraisal?.history)
      ? oldDoc.appraisal.history.map((h) => ({ ...h }))
      : [];

    // If fixedAmount also changed, update the last entry in history
    if (fixedAmountChanged && updatedHistory.length > 0) {
      const lastIndex = updatedHistory.length - 1;
      const lastEntry = updatedHistory[lastIndex];
      
      const previousRent = Number(lastEntry.previousRent || 0);
      const newAppraisalAmount = Number(this.appraisal.fixedAmount || 0);
      const newRent = Math.round(previousRent + newAppraisalAmount);
      
      updatedHistory[lastIndex] = {
        ...lastEntry,
        fixedAmount: Number(this.appraisal.fixedAmount || 0),
        appraisalAmount: newAppraisalAmount,
        newRent: newRent,
        updatedBy: this._updatedBy || null,
        updatedAt: new Date(),
      };
    }

    // Get the entry that corresponds to the old nextAppraisalDate
    const oldNextDateEntryIndex = updatedHistory.findIndex(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).getTime() === oldNextDate.getTime()
    );

    // If there's an entry for the old next date, update or remove it based on new date
    let currentRentValue = 0;
    
    if (oldNextDateEntryIndex !== -1) {
      // Get the entry at old date
      const oldEntry = updatedHistory[oldNextDateEntryIndex];
      
      // Check if we should keep this entry or not
      // We keep it only if it's before the new date
      if (oldNextDate < newNextDate) {
        // Keep the entry as is (it's before the new date)
        currentRentValue = Number(oldEntry.newRent || 0);
      } else {
        // If old date is after new date, we need to remove this entry
        updatedHistory.splice(oldNextDateEntryIndex, 1);
        // Recalculate currentRent from the last remaining entry
        if (updatedHistory.length > 0) {
          const lastEntry = updatedHistory[updatedHistory.length - 1];
          currentRentValue = Number(lastEntry.newRent || 0);
        } else {
          currentRentValue = Number(oldDoc.appraisal?.currentRent || netPayable);
        }
      }
    } else {
      // No entry for old date, get current rent from last entry
      if (updatedHistory.length > 0) {
        const lastEntry = updatedHistory[updatedHistory.length - 1];
        currentRentValue = Number(lastEntry.newRent || 0);
      } else {
        currentRentValue = Number(oldDoc.appraisal?.currentRent || netPayable);
      }
    }

    // Now, only add new entry if the new date doesn't already exist and it's after the old date
    const newNextDateExists = updatedHistory.some(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).getTime() === newNextDate.getTime()
    );

    if (!newNextDateExists && oldNextDate < newNextDate) {
      // Get previous rent from the last entry in history
      let previousRent = currentRentValue;
      let latestAppraisalAmount = 0;
      
      if (updatedHistory.length > 0) {
        const lastEntry = updatedHistory[updatedHistory.length - 1];
        latestAppraisalAmount = Number(lastEntry.appraisalAmount || 0);
        previousRent = Number(lastEntry.newRent || currentRentValue);
      }

      // Calculate appraisal amount
      let appraisalAmount = 0;
      if (Number(this.appraisal.type) === 1) {
        appraisalAmount = (latestAppraisalAmount * Number(this.appraisal.percentage || 0)) / 100;
      } else if (Number(this.appraisal.type) === 2) {
        appraisalAmount = Number(this.appraisal.fixedAmount || 0);
      }
      appraisalAmount = Math.round(appraisalAmount);
      
      const newRent = Math.round(previousRent + appraisalAmount);

      updatedHistory.push({
        appraisalDate: newNextDate,
        type: this.appraisal.type,
        percentage: this.appraisal.percentage || 0,
        fixedAmount: this.appraisal.fixedAmount || 0,
        previousRent: previousRent,
        previousAppraisalAmount: latestAppraisalAmount,
        appraisalAmount: appraisalAmount,
        newRent: newRent,
        updatedBy: this._updatedBy || null,
        updatedAt: new Date(),
      });
      
      currentRentValue = newRent;
    }

    // Update the document with the new history
    this.appraisal.history = updatedHistory;
    this.appraisal.lastAppraisalDate = oldNextDate;
    this.appraisal.currentRent = currentRentValue;
    
    // Update appraisal amount and total
    if (updatedHistory.length > 0) {
      const lastEntry = updatedHistory[updatedHistory.length - 1];
      this.appraisal.appraisalAmount = Number(lastEntry.appraisalAmount || 0);
      
      // Calculate total appraisal amount
      const totalAppraisal = updatedHistory.reduce((sum, entry) => {
        return sum + Number(entry.appraisalAmount || 0);
      }, 0);
      
      // Get the base rent from the first entry or use netPayable
      const baseRent = updatedHistory.length > 0 && updatedHistory[0].previousRent 
        ? Number(updatedHistory[0].previousRent) 
        : netPayable;
      
      this.appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);
    }
    
    return;
  }

  // Handle new document
  if (this.isNew && !this.appraisal.nextAppraisalDate) {
    const firstDate = new Date(agreementStartDate);
    firstDate.setMonth(firstDate.getMonth() + months);

    if (firstDate <= agreementEndDate) {
      this.appraisal.nextAppraisalDate = firstDate;
    }
  }

  if (this.isNew && this.appraisal.nextAppraisalDate) {
    const baseRent = Number(this.rentalPayment?.totalRentalAmount || 0);

    let initialAppraisalAmount = 0;
    if (Number(this.appraisal.type) === 1) {
      initialAppraisalAmount = (baseRent * Number(this.appraisal.percentage || 0)) / 100;
    } else if (Number(this.appraisal.type) === 2) {
      initialAppraisalAmount = Number(this.appraisal.fixedAmount || 0);
    }

    initialAppraisalAmount = Math.round(initialAppraisalAmount);
    const newRent = Math.round(baseRent + initialAppraisalAmount);

    const dateExists = this.appraisal.history.some(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).getTime() ===
          new Date(this.appraisal.nextAppraisalDate).getTime()
    );

    if (!dateExists) {
      this.appraisal.history.push({
        appraisalDate: new Date(this.appraisal.nextAppraisalDate),
        type: this.appraisal.type,
        percentage: this.appraisal.percentage || 0,
        fixedAmount: this.appraisal.fixedAmount || 0,
        previousRent: baseRent,
        previousAppraisalAmount: 0,
        appraisalAmount: initialAppraisalAmount,
        newRent,
        updatedBy: this._updatedBy || null,
        updatedAt: new Date(),
      });
    }

    this.appraisal.appraisalAmount = initialAppraisalAmount;
    this.appraisal.totalAppraisalAmount = Math.round(baseRent + initialAppraisalAmount);
  }
});
module.exports = mongoose.model("MediaOnboarding", MediaSchema);