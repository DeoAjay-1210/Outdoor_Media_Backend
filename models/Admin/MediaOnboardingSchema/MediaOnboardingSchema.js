// models/Media.js
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
    // tdsAmount: {
    //   type: Number,
    //   default: 0,
    // },
    // netAmount: {
    //   type: Number,
    //   default: 0,
    // },
    // per-owner paymentMode (used if rentalPayment.paymentMode is absent)
    paymentMode: {
      type: Number,
      enum: [1, 2, 3, 4], // 1.Bank Transfer 2.UPI 3.Cheque 4.Cash
    },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────
const MediaSchema = new mongoose.Schema(
  {
    mediaId: {
      type: String,
      unique: true,
      sparse: false,
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
      enum: [1, 2, 3], // 1.Active 2.InActive 3.Hold
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
      paymentFrequency: {
        type: Number,
        enum: [1, 2, 3, 4, 5, 6], // 1.Monthly 2.2M 3.3M 4.6M 5.1Y 6.2Y
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
        enum: [0, 1], // 0.No 1.Yes
        default: 0,
      },
      // filled from .env TDS_PERCENTAGE at pre-save
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
        enum: [1, 2, 3], // 1.Active 2.Expire Zone 3.Expired
        default: 1,
      },
      ownerPayments: [ownerPaymentSchema],
    },
    // ─────────────────────────────────────────────────────────
    // LAND OWNERS
    // ─────────────────────────────────────────────────────────
    landOwners: [
      {
        name: {
          type: String,
          // required: true,
          trim: true,
        },
        phone: {
          type: String,
          // required: true,
          trim: true,
        },
        bankName: {
          type: String,
          // required: true,
          trim: true,
        },
        ifsc: {
          type: String,
          // required: true,
          trim: true,
        },
        accountNumber: {
          type: String,
          // required: true,
          trim: true,
        },
        upiId: {
          type: String,
          trim: true,
        },
        panNumber: {
          type: String,
          // required: true,
          trim: true,
          uppercase: true,
        },

        // per-owner paymentMode (used if rentalPayment.paymentMode is absent)
        paymentMode: {
          type: Number,
          enum: [1, 2, 3, 4], // 1.Bank Transfer 2.UPI 3.Cheque 4.Cash
        },

        // typeShare: 1=sharePercentage  2=shareAmount (fixed)
        typeShare: {
          type: Number,
          enum: [1, 2],
          required: true,
        },
        // required when typeShare=1
        sharePercentage: {
          type: Number,
          min: 0,
          max: 100,
        },
        // required when typeShare=2 (given directly, never converted to percentage)
        shareAmount: {
          type: Number,
          min: 0,
        },
      },
    ],
    // ─────────────────────────────────────────────────────────
    // AGREEMENT
    // ─────────────────────────────────────────────────────────
    agreement: {
      startDate: {
        type: Date,
        required: true,
      },
      endDate: {
        type: Date,
        required: true,
      },
      reminderBeforeExpiry: {
        type: Number,
        enum: [10, 30, 60, 90], // 10 - 10Days 30 - 30 Days 60 - 60 Days 90 - 90 Days
        required: true,
      },
      status: {
        type: Number,
        enum: [1, 2, 3], // 1 -> "Active", 2 -> "Expire Zone", 3 -> "Expired"
        default: 1,
      },
      agreementPDF: {
        originalName: { type: String },
        fileName: { type: String },
        filePath: { type: String },
        mimeType: { type: String },
        size: { type: Number },
        fileType: {
          type: String,
          enum: ["pdf"],
          default: "pdf",
        },
        uploadedAt: { type: Date, default: Date.now },
      },
    },

    // ─────────────────────────────────────────────────────────
    // APPRAISAL
    // ─────────────────────────────────────────────────────────
    appraisal: {
      applicable: {
        type: Number,
        enum: [0, 1], // 0.No 1.Yes
        default: 0,
      },
      type: {
        type: Number,
        enum: [1, 2], // 1.Percentage 2.Amount
      },
      percentage: {
        type: Number,
        min: 0,
        max: 100,
      },
      fixedAmount: {
        type: Number,
        min: 0,
      },
      frequency: {
        type: Number,
        enum: [1, 2, 3], // 1.6M 2.Yearly 3.2Y
      },
      nextAppraisalDate: {
        type: Date,
      },
      lastAppraisalDate: { type: Date, default: null },
      // NEW — calculated appraisal amount
      // type=1 → netPayable * percentage / 100
      // type=2 → netPayable + fixedAmount
      appraisalAmount: { type: Number, default: 0 },
      totalAppraisalAmount: { type: Number, default: 0 },
      history: [
        {
          appraisalDate: { type: Date },
          type: { type: Number, enum: [1, 2] },
          percentage: { type: Number },
          fixedAmount: { type: Number },
          appraisalAmount: { type: Number }, 
          totalAppraisalAmount : { type: Number }, 
        },
      ],
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
  {
    timestamps: true,
  },
);

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 1 — Total Sq Ft
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  this.totalSqFt = this.width * this.height;
});

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 2 — Owner Payments + TDS + shareAmount calculation
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  if (!this.landOwners?.length) return;

  const totalRental = this.rentalPayment.totalRentalAmount;
  const tdsApplicable = this.rentalPayment.tdsApplicable;

  // TDS % from .env, fallback to schema value, fallback to 0
  const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
  const tdsPercentage =
    tdsApplicable === 1
      ? envTdsPercent > 0
        ? envTdsPercent
        : this.rentalPayment.tdsPercentage || 0
      : 0;

  this.rentalPayment.tdsPercentage = tdsPercentage;

  // ✅ FIX: Compute netPayable FIRST, then use it for typeShare=1 percentage owners
  const totalTdsAmount =
    tdsApplicable === 1 && tdsPercentage > 0
      ? parseFloat(((totalRental * tdsPercentage) / 100).toFixed(2))
      : 0;

  const netPayable = parseFloat((totalRental - totalTdsAmount).toFixed(2));

  this.rentalPayment.tdsAmount = totalTdsAmount;
  this.rentalPayment.netPayable = netPayable;

  const globalPaymentMode = this.rentalPayment.paymentMode || null;

  // STEP 1 — Resolve shareAmount
  //   typeShare=1 → percentage of NET payable (after TDS)   ✅ FIXED
  //   typeShare=2 → shareAmount given directly, no conversion
  this.landOwners.forEach((owner) => {
    if (owner.typeShare === 1) {
      const pct = owner.sharePercentage || 0;
      owner.shareAmount = parseFloat(((netPayable * pct) / 100).toFixed(2)); // ✅ netPayable not totalRental
    } else if (owner.typeShare === 2) {
      owner.sharePercentage = undefined;
    }
  });

  // STEP 2 — Build ownerPayments
  this.rentalPayment.ownerPayments = this.landOwners.map((owner) => {
    const ownerAmount = owner.shareAmount || 0;

    return {
      ownerId: owner._id,
      ownerName: owner.name,
      percentage: owner.typeShare === 1 ? owner.sharePercentage || 0 : null,
      amount: ownerAmount,
      paymentMode: owner.paymentMode,
    };
  });
});
// ─────────────────────────────────────────────────────────────
// PRE-SAVE 3 — Next Billing Date
// ─────────────────────────────────────────────────────────────
// MediaSchema.pre("save", function () {
//   if (
//     this.rentalPayment.lastBillPaidDate &&
//     this.rentalPayment.paymentFrequency
//   ) {
//     const lastDate = new Date(this.rentalPayment.lastBillPaidDate);
//     const frequencyMap = {
//       1: 1,
//       2: 2,
//       3: 3,
//       4: 6,
//       5: 12,
//       6: 24,
//     };
//     const monthsToAdd = frequencyMap[this.rentalPayment.paymentFrequency] || 1;
//     const nextDate    = new Date(lastDate);
//     nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
//     this.rentalPayment.nextBillingDate = nextDate;
//   }
// });
MediaSchema.pre("save", function () {
  const isNewDoc = this.isNew;
  const billingDateProvided = this.rentalPayment.nextBillingDate != null;

  // CREATE + caller supplied nextBillingDate → keep it, skip auto-compute
  if (isNewDoc && billingDateProvided) return;

  // All other cases (UPDATE always, CREATE without nextBillingDate) → compute
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
//
// Reads RENTAL_EXPIRE_ZONE_DAYS from .env (fallback: 3)
//
// Logic (based on nextBillingDate):
//   daysUntilNextBill < 0               → 3 (Expired  — billing date passed, not yet paid)
//   daysUntilNextBill <= expireZoneDays → 2 (Expire Zone — payment due very soon)
//   daysUntilNextBill >  expireZoneDays → 1 (Active)
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
    this.rentalPayment.status = 3; // Expired
  } else if (daysUntilBill <= expireZoneDays) {
    this.rentalPayment.status = 2; // Expire Zone
  } else {
    this.rentalPayment.status = 1; // Active
  }
});


// If nextAppraisalDate was manually provided, it becomes the
// ANCHOR for the schedule (first occurrence), and future cycles
// continue from it at the given frequency. This way, once the
// manual date passes, it correctly moves into history.
//
// If NOT provided, anchor falls back to startDate + frequency.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// PRE-SAVE 6 — Appraisal Schedule (history + last + next + amount)
// ─────────────────────────────────────────────────────────────
const APPRAISAL_FREQUENCY_MONTHS_MAP = { 1: 6, 2: 12, 3: 24 };


// MediaSchema.pre("save", function () {
//   if (this.appraisal?.applicable !== 1) return;
//   if (!this.agreement?.startDate || !this.agreement?.endDate || !this.appraisal.frequency) return;

//   const months  = APPRAISAL_FREQUENCY_MONTHS_MAP[this.appraisal.frequency] || 12;
//   const endDate = new Date(this.agreement.endDate);
//   const now     = new Date();

//   const manualNextDate = this.appraisal.nextAppraisalDate
//     ? new Date(this.appraisal.nextAppraisalDate)
//     : null;

//   // ── appraisalAmount calculation ────────────────────────────
//   const netPayable = this.rentalPayment?.netPayable || 0;
//   let appraisalAmount = 0;

//   if (this.appraisal.type === 1) {
//     const pct = this.appraisal.percentage || 0;
//     appraisalAmount = parseFloat(((netPayable * pct) / 100).toFixed(2));
//     if (appraisalAmount === 0 && this.appraisal.fixedAmount) {
//       appraisalAmount = parseFloat((this.appraisal.fixedAmount).toFixed(2));
//     }
//   } else if (this.appraisal.type === 2) {
//     const fixedAmt = this.appraisal.fixedAmount || 0;
//     appraisalAmount = parseFloat((fixedAmt).toFixed(2));
//     if (appraisalAmount === 0 && this.appraisal.percentage) {
//       appraisalAmount = parseFloat(((netPayable * this.appraisal.percentage) / 100).toFixed(2));
//     }
//   }

//   this.appraisal.appraisalAmount     = appraisalAmount;
//   this.appraisal.totalAppraisalAmount = parseFloat((netPayable + appraisalAmount).toFixed(2));

//   // ── HISTORY: only append, never recompute past entries ────
//   // If nextAppraisalDate has passed → it becomes a new history entry
//   // ── HISTORY: only append, never recompute past entries ────
// if (manualNextDate && manualNextDate <= now) {

//   // ✅ FIX: initialize history array if it doesn't exist
//   if (!this.appraisal.history) {
//     this.appraisal.history = [];
//   }

//   const existingDates = this.appraisal.history.map(
//     (h) => new Date(h.appraisalDate).toISOString()
//   );

//   const newEntryDate = manualNextDate.toISOString();

//   if (!existingDates.includes(newEntryDate)) {
//     this.appraisal.history.push({
//       appraisalDate       : manualNextDate,
//       type                : this.appraisal.type,
//       percentage          : this.appraisal.percentage,
//       fixedAmount         : this.appraisal.fixedAmount,
//       appraisalAmount     : appraisalAmount,
//       totalAppraisalAmount: this.appraisal.totalAppraisalAmount,
//     });
//   }

//   this.appraisal.lastAppraisalDate = manualNextDate;

//   const next = new Date(manualNextDate);
//   next.setMonth(next.getMonth() + months);
//   this.appraisal.nextAppraisalDate = next < endDate ? next : null;

// } else if (!manualNextDate) {
//   // ✅ FIX: initialize history array here too
//   if (!this.appraisal.history) {
//     this.appraisal.history = [];
//   }

//   const startDate = new Date(this.agreement.startDate);
//   const first = new Date(startDate);
//   first.setMonth(first.getMonth() + months);
//   this.appraisal.nextAppraisalDate = first < endDate ? first : null;
// }
//   // else: manualNextDate is still in the future → leave everything untouched
// });

MediaSchema.pre("save", function () {
  if (this.appraisal?.applicable !== 1) return;
  if (!this.agreement?.startDate || !this.agreement?.endDate || !this.appraisal.frequency) return;

  const months  = APPRAISAL_FREQUENCY_MONTHS_MAP[this.appraisal.frequency] || 12;
  const endDate = new Date(this.agreement.endDate);
  const now     = new Date();

  const manualNextDate = this.appraisal.nextAppraisalDate
    ? new Date(this.appraisal.nextAppraisalDate)
    : null;

  // ── appraisalAmount calculation ────────────────────────────
  const netPayable = this.rentalPayment?.netPayable || 0;
  let appraisalAmount = 0;

  if (this.appraisal.type === 1) {
    const pct = this.appraisal.percentage || 0;
    appraisalAmount = parseFloat(((netPayable * pct) / 100).toFixed(2));
    if (appraisalAmount === 0 && this.appraisal.fixedAmount) {
      appraisalAmount = parseFloat((this.appraisal.fixedAmount).toFixed(2));
    }
  } else if (this.appraisal.type === 2) {
    const fixedAmt = this.appraisal.fixedAmount || 0;
    appraisalAmount = parseFloat((fixedAmt).toFixed(2));
    if (appraisalAmount === 0 && this.appraisal.percentage) {
      appraisalAmount = parseFloat(((netPayable * this.appraisal.percentage) / 100).toFixed(2));
    }
  }

  this.appraisal.appraisalAmount      = appraisalAmount;
  this.appraisal.totalAppraisalAmount = parseFloat((netPayable + appraisalAmount).toFixed(2));

  // ── Ensure history array exists ────────────────────────────
  if (!this.appraisal.history) {
    this.appraisal.history = [];
  }

  const existingDates = this.appraisal.history.map(
    (h) => new Date(h.appraisalDate).toISOString()
  );

  if (manualNextDate && manualNextDate <= now) {
    // ── Date has PASSED → archive it into history ──────────────
    const newEntryDate = manualNextDate.toISOString();

    if (!existingDates.includes(newEntryDate)) {
      this.appraisal.history.push({
        appraisalDate        : manualNextDate,
        type                 : this.appraisal.type,
        percentage           : this.appraisal.percentage,
        fixedAmount          : this.appraisal.fixedAmount,
        appraisalAmount      : appraisalAmount,
        totalAppraisalAmount : this.appraisal.totalAppraisalAmount,
      });
    }

    this.appraisal.lastAppraisalDate = manualNextDate;

    // Auto-advance nextAppraisalDate by frequency
    const next = new Date(manualNextDate);
    next.setMonth(next.getMonth() + months);
    this.appraisal.nextAppraisalDate = next < endDate ? next : null;

  } else if (manualNextDate && manualNextDate > now) {
    // ── Date is FUTURE → check if nextAppraisalDate was manually changed ──
    // If changed, archive the OLD nextAppraisalDate into history immediately
    if (this.isModified("appraisal.nextAppraisalDate")) {
      // Get the OLD value from the original document before this update
      const oldNextDate = this._doc?.appraisal?.nextAppraisalDate
        ? new Date(this._doc.appraisal.nextAppraisalDate)
        : null;

      // Only archive old date if it existed and is not already in history
      if (oldNextDate) {
        const oldEntryDate = oldNextDate.toISOString();
        if (!existingDates.includes(oldEntryDate)) {
          this.appraisal.history.push({
            appraisalDate        : oldNextDate,
            type                 : this.appraisal.type,
            percentage           : this.appraisal.percentage,
            fixedAmount          : this.appraisal.fixedAmount,
            appraisalAmount      : appraisalAmount,
            totalAppraisalAmount : this.appraisal.totalAppraisalAmount,
          });
        }
        this.appraisal.lastAppraisalDate = oldNextDate;
      }
    }
    // New future date stays as-is

  } else {
    // ── No date provided → derive first date from agreement startDate ──
    const startDate = new Date(this.agreement.startDate);
    const first = new Date(startDate);
    first.setMonth(first.getMonth() + months);
    this.appraisal.nextAppraisalDate = first < endDate ? first : null;
  }
});
module.exports = mongoose.model("MediaOnboarding", MediaSchema);
