
// const mongoose = require("mongoose");

// // ─────────────────────────────────────────────────────────────
// // OWNER PAYMENT SCHEMA
// // ─────────────────────────────────────────────────────────────
// const ownerPaymentSchema = new mongoose.Schema(
//   {
//     ownerId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "MediaOnboarding.landOwners",
//     },
//     ownerName: {
//       type: String,
//       required: true,
//     },
//     // null for typeShare=2 owners (amount-based, no percentage)
//     percentage: {
//       type: Number,
//       default: null,
//       min: 0,
//       max: 100,
//     },
//     amount: {
//       type: Number,
//       required: true,
//       min: 0,
//     },
//     // paymentCategory: 1=Cash  2=Online  3=Cash+Online
//     paymentCategory: {
//       type: Number,
//       enum: [1, 2, 3],
//     },
//     // onlineMode: 1=Bank Transfer  2=UPI  3=Cheque
//     onlineMode: {
//       type: Number,
//       enum: [1, 2, 3],
//     },
//     cashAmount: {
//       type: Number,
//       min: 0,
//       default: 0,
//     },
//     onlineAmount: {
//       type: Number,
//       min: 0,
//       default: 0,
//     },
//   },
//   { _id: false },
// );
// const APPRAISAL_HISTORY_SCHEMA = new mongoose.Schema(
//   {
//     appraisalDate: {
//       type: Date,
//     },

//     type: {
//       type: Number, // 1=Percentage, 2=Fixed
//     },

//     percentage: {
//       type: Number,
//       default: 0,
//     },

//     fixedAmount: {
//       type: Number,
//       default: 0,
//     },

//     previousRent: {
//       type: Number,
//       default: 0,
//     },

//     appraisalAmount: {
//       type: Number,
//       default: 0,
//     },

//     newRent: {
//       type: Number,
//       default: 0,
//     },
//         updatedBy:   { type: String, default: null },  // from req.userName via token
//     updatedAt:   { type: Date,   default: null }, 
//   },
//   { _id: false }
// );
// // ─────────────────────────────────────────────────────────────
// // MAIN SCHEMA
// // ─────────────────────────────────────────────────────────────
// const MediaSchema = new mongoose.Schema(
//   {
//     mediaId: {
//       type: String,
//       unique: true,
//         sparse: true,
//     },
//     mediaCode: {
//       type: String,
//       required: true,
//     },
//     mediaName: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     mediaType: {
//       type: String,
//       required: true,
//     },
//     state: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     city: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     location: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     fullAddress: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     width: {
//       type: Number,
//       required: true,
//       min: 0,
//     },
//     height: {
//       type: Number,
//       required: true,
//       min: 0,
//     },
//     totalSqFt: {
//       type: Number,
//       min: 0,
//     },
//     status: {
//       type: Number,
//       enum: [1, 2, 3], // 1=Active 2=InActive 3=Hold
//       default: 1,
//     },
//     numberOfLandOwners: {
//       type: Number,
//       min: 1,
//     },

//     // ─────────────────────────────────────────────────────────
//     // RENTAL PAYMENT
//     // ─────────────────────────────────────────────────────────
//     rentalPayment: {
//       totalRentalAmount: {
//         type: Number,
//         required: true,
//         min: 0,
//       },

//       // gstApplicable: 0=No  1=Yes
//       gstApplicable: {
//         type: Number,
//         enum: [0, 1],
//         default: 0,
//       },
//       // gstType: 1=Inclusive  2=Exclusive
//       gstType: {
//         type: Number,
//         enum: [1, 2],
//       },
//       gstNumber: {
//         type: String,
//         trim: true,
//         uppercase: true,
//       },
//       gstPercentage: {
//         type: Number,
//         min: 0,
//         default: 0,
//       },
//       gstAmount: {
//         type: Number,
//         default: 0,
//       },
//       totalRentalAmountWithGst: {
//         type: Number,
//         default: 0,
//       },

//       paymentFrequency: {
//         type: Number,
//         enum: [1, 2, 3, 4, 5, 6], // 1=Monthly 2=2M 3=3M 4=6M 5=1Y 6=2Y
//         required: true,
//       },
//       lastBillPaidDate: {
//         type: Date,
//         required: true,
//       },
//       nextBillingDate: {
//         type: Date,
//       },
//       tdsApplicable: {
//         type: Number,
//         enum: [0, 1],
//         default: 0,
//       },
//       tdsPercentage: {
//         type: Number,
//         min: 0,
//         max: 100,
//         default: 0,
//       },
//       tdsAmount: {
//         type: Number,
//         default: 0,
//       },
//       netPayable: {
//         type: Number,
//         default: 0,
//       },
//       status: {
//         type: Number,
//         enum: [1, 2, 3], // 1=Active 2=Expire Zone 3=Expired
//         default: 1,
//       },
//       ownerPayments: [ownerPaymentSchema],
//     },

//     // ─────────────────────────────────────────────────────────
//     // LAND OWNERS
//     // ─────────────────────────────────────────────────────────
//     landOwners: [
//       {
//         name: { type: String, trim: true },
//         phone: { type: String, trim: true },
//         bankName: { type: String, trim: true },
//         ifsc: { type: String, trim: true },
//         accountNumber: { type: String, trim: true },
//         upiId: { type: String, trim: true },
//         panNumber: { type: String, trim: true, uppercase: true },

//         // paymentCategory: 1=Cash  2=Online  3=Cash+Online
//         paymentCategory: {
//           type: Number,
//           enum: [1, 2, 3],
//           required: true,
//         },
//         // onlineMode: 1=Bank Transfer  2=UPI  3=Cheque
//         onlineMode: {
//           type: Number,
//           enum: [1, 2, 3],
//         },
//         cashAmount: {
//           type: Number,
//           min: 0,
//           default: 0,
//         },
//         onlineAmount: {
//           type: Number,
//           min: 0,
//           default: 0,
//         },

//         // typeShare: 1=sharePercentage  2=shareAmount (fixed)
//         typeShare: {
//           type: Number,
//           enum: [1, 2],
//         },
//         sharePercentage: {
//           type: Number,
//           min: 0,
//           max: 100,
//         },
//         shareAmount: {
//           type: Number,
//           min: 0,
//         },
//       },
//     ],

//     // ─────────────────────────────────────────────────────────
//     // AGREEMENT
//     // ─────────────────────────────────────────────────────────
//     agreement: {
//       startDate: { type: Date, required: true },
//       endDate: { type: Date, required: true },
//       reminderBeforeExpiry: {
//         type: Number,
//         enum: [10, 30, 60, 90],
//         required: true,
//       },
//       status: {
//         type: Number,
//         enum: [1, 2, 3], // 1=Active 2=Expire Zone 3=Expired
//         default: 1,
//       },
//       agreementPDF: {
//         originalName: { type: String },
//         fileName: { type: String },
//         filePath: { type: String },
//         mimeType: { type: String },
//         size: { type: Number },
//         fileType: { type: String, enum: ["pdf"], default: "pdf" },
//         uploadedAt: { type: Date, default: Date.now },
//       },
//     },

//     // ─────────────────────────────────────────────────────────
//     // APPRAISAL
//     // ─────────────────────────────────────────────────────────
//    appraisal: {
//   applicable: {
//     type: Number,
//     enum: [0, 1],
//     default: 0,
//   },

//   type: {
//     type: Number, // 1=Percentage, 2=Fixed
//   },

//   percentage: {
//     type: Number,
//     default: 0,
//   },

//   fixedAmount: {
//     type: Number,
//     default: 0,
//   },

//   frequency: {
//     type: Number,
//   },

//   customFrequencyMonths: {
//     type: Number,
//     default: 0,
//   },

//   currentRent: {
//     type: Number,
//     default: 0,
//   },

//   appraisalAmount: {
//     type: Number,
//     default: 0,
//   },

//   totalAppraisalAmount: {
//     type: Number,
//     default: 0,
//   },

//   lastAppraisalDate: Date,

//   nextAppraisalDate: Date,

//   history: [APPRAISAL_HISTORY_SCHEMA],
// },

//     // ─────────────────────────────────────────────────────────
//     // IMAGES
//     // ─────────────────────────────────────────────────────────
//     frontView: {
//       originalName: { type: String },
//       fileName: { type: String },
//       filePath: { type: String },
//       mimeType: { type: String },
//       size: { type: Number },
//       fileType: { type: String, enum: ["image"], default: "image" },
//       uploadedAt: { type: Date, default: Date.now },
//     },
//     sideView: {
//       originalName: { type: String },
//       fileName: { type: String },
//       filePath: { type: String },
//       mimeType: { type: String },
//       size: { type: Number },
//       fileType: { type: String, enum: ["image"], default: "image" },
//       uploadedAt: { type: Date, default: Date.now },
//     },
//     locationView: {
//       originalName: { type: String },
//       fileName: { type: String },
//       filePath: { type: String },
//       mimeType: { type: String },
//       size: { type: Number },
//       fileType: { type: String, enum: ["image"], default: "image" },
//       uploadedAt: { type: Date, default: Date.now },
//     },
//     additionalImages: {
//       originalName: { type: String },
//       fileName: { type: String },
//       filePath: { type: String },
//       mimeType: { type: String },
//       size: { type: Number },
//       fileType: { type: String, enum: ["image"], default: "image" },
//       uploadedAt: { type: Date, default: Date.now },
//     },
//   },
//   { timestamps: true },
// );

// // ─────────────────────────────────────────────────────────────
// // PRE-SAVE 1 — Total Sq Ft
// // ─────────────────────────────────────────────────────────────
// MediaSchema.pre("save", function () {
//   this.totalSqFt = this.width * this.height;
// });

// // ─────────────────────────────────────────────────────────────
// // PRE-SAVE 2 — GST + TDS + netPayable + Owner Payments
// //
// // KEY FIX: netPayable is always computed first (even with no landOwners).
// // Previously the early return `if (!this.landOwners?.length) return`
// // was at the TOP, so netPayable was never set when no tax applies.
// //
// // GST LOGIC:
// //   gstApplicable=0  → no GST; base = totalRentalAmount
// //   gstApplicable=1, gstType=1 (Inclusive) → base = totalRentalAmount (GST embedded)
// //   gstApplicable=1, gstType=2 (Exclusive) → base = totalRentalAmount + gstAmount
// //
// // TDS LOGIC (on GST-adjusted base):
// //   netPayable = base - (base * tdsPercentage / 100)
// //
// // When no GST and no TDS: netPayable = totalRentalAmount
// // ─────────────────────────────────────────────────────────────
// MediaSchema.pre("save", function () {
//   const rp = this.rentalPayment;

//   const totalRentalAmount = Number(rp.totalRentalAmount || 0);

//   // ── STEP A: GST ──────────────────────────────────────────
//   const gstApplicable = Number(rp.gstApplicable || 0);

//   let gstAmount = 0;

//   if (gstApplicable === 1) {
//     const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");

//     rp.gstPercentage = envGstPct;

//     gstAmount = parseFloat(
//       ((totalRentalAmount * envGstPct) / 100).toFixed(2)
//     );
//   } else {
//     rp.gstPercentage = 0;
//   }

//   rp.gstAmount = gstAmount;

//   // Keep original rental amount unchanged
//   rp.totalRentalAmountWithGst = totalRentalAmount + gstAmount;

//   // ── STEP B: TDS ──────────────────────────────────────────
//   const tdsApplicable = Number(rp.tdsApplicable || 0);

//   const envTdsPercent = parseFloat(
//     process.env.TDS_PERCENTAGE || "0"
//   );

//   const tdsPercentage =
//     tdsApplicable === 1
//       ? envTdsPercent > 0
//         ? envTdsPercent
//         : Number(rp.tdsPercentage || 0)
//       : 0;

//   rp.tdsPercentage = tdsPercentage;

//   const tdsAmount =
//     tdsApplicable === 1 && tdsPercentage > 0
//       ? parseFloat(
//           ((totalRentalAmount * tdsPercentage) / 100).toFixed(2)
//         )
//       : 0;

//   rp.tdsAmount = tdsAmount;

//   // Net payable for company records only
//   rp.netPayable = parseFloat(
//     (totalRentalAmount + gstAmount - tdsAmount).toFixed(2)
//   );

//   // ── NO LAND OWNERS ───────────────────────────────────────
//   if (!this.landOwners || !this.landOwners.length) {
//     return;
//   }

//   // ── STEP C: OWNER SHARE CALCULATION ──────────────────────
//   // IMPORTANT:
//   // Owner share should be calculated ONLY from rental amount
//   // GST should NOT be included
//   const ownerSplitBaseAmount = totalRentalAmount;

//   this.landOwners.forEach((owner) => {
//     if (Number(owner.typeShare) === 1) {
//       const sharePercentage =
//         Number(owner.sharePercentage || 0);

//       owner.shareAmount = parseFloat(
//         (
//           (ownerSplitBaseAmount * sharePercentage) /
//           100
//         ).toFixed(2)
//       );
//     } else if (Number(owner.typeShare) === 2) {
//       owner.sharePercentage = undefined;

//       owner.shareAmount = parseFloat(
//         (Number(owner.shareAmount || 0)).toFixed(2)
//       );
//     }
//   });

//   // ── STEP D: OWNER PAYMENTS ───────────────────────────────
//   rp.ownerPayments = this.landOwners.map((owner) => {
//     const ownerAmount = Number(owner.shareAmount || 0);

//     const paymentCategory = Number(
//       owner.paymentCategory || 1
//     );

//     const payment = {
//       ownerId: owner._id,
//       ownerName: owner.name,
//       percentage:
//         Number(owner.typeShare) === 1
//           ? Number(owner.sharePercentage || 0)
//           : null,
//       amount: ownerAmount,
//       paymentCategory,
//     };

//     // Cash Only
//     if (paymentCategory === 1) {
//       payment.cashAmount = ownerAmount;
//       payment.onlineAmount = 0;
//     }

//     // Online Only
//     else if (paymentCategory === 2) {
//       payment.onlineMode = owner.onlineMode;
//       payment.cashAmount = 0;
//       payment.onlineAmount = ownerAmount;
//     }

//     // Cash + Online
//     else if (paymentCategory === 3) {
//       payment.onlineMode = owner.onlineMode;
//       payment.cashAmount = Number(owner.cashAmount || 0);
//       payment.onlineAmount = Number(owner.onlineAmount || 0);
//     }

//     return payment;
//   });
// });

// // ─────────────────────────────────────────────────────────────
// // PRE-SAVE 3 — Next Billing Date
// // ─────────────────────────────────────────────────────────────
// MediaSchema.pre("save", function () {
//   const isNewDoc = this.isNew;
//   const billingDateProvided = this.rentalPayment.nextBillingDate != null;

//   // CREATE + caller supplied nextBillingDate → keep it, skip auto-compute
//   if (isNewDoc && billingDateProvided) return;

//   if (this.rentalPayment.lastBillPaidDate && this.rentalPayment.paymentFrequency) {
//     const frequencyMap = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 12, 6: 24 };
//     const monthsToAdd = frequencyMap[this.rentalPayment.paymentFrequency] || 1;
//     const nextDate = new Date(this.rentalPayment.lastBillPaidDate);
//     nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
//     this.rentalPayment.nextBillingDate = nextDate;
//   }
// });

// // ─────────────────────────────────────────────────────────────
// // PRE-SAVE 4 — Agreement Status
// // ─────────────────────────────────────────────────────────────
// MediaSchema.pre("save", function () {
//   if (this.agreement?.startDate && this.agreement?.endDate) {
//     const now = new Date();
//     const endDate = new Date(this.agreement.endDate);
//     const daysUntilExpiry = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
//     const reminderDays = this.agreement.reminderBeforeExpiry || 30;

//     if (daysUntilExpiry < 0) {
//       this.agreement.status = 3; // Expired
//     } else if (daysUntilExpiry <= reminderDays) {
//       this.agreement.status = 2; // Expire Zone
//     } else {
//       this.agreement.status = 1; // Active
//     }
//   }
// });

// // ─────────────────────────────────────────────────────────────
// // PRE-SAVE 5 — Rental Payment Status
// // ─────────────────────────────────────────────────────────────
// MediaSchema.pre("save", function () {
//   const nextBillingDate = this.rentalPayment.nextBillingDate;

//   if (!nextBillingDate) {
//     this.rentalPayment.status = 1;
//     return;
//   }

//   const expireZoneDays = parseInt(process.env.RENTAL_EXPIRE_ZONE_DAYS || "3", 10);
//   const now = new Date();
//   const billingDate = new Date(nextBillingDate);
//   const daysUntilBill = Math.ceil((billingDate - now) / (1000 * 60 * 60 * 24));

//   if (daysUntilBill < 0) {
//     this.rentalPayment.status = 3; // Expired
//   } else if (daysUntilBill <= expireZoneDays) {
//     this.rentalPayment.status = 2; // Expire Zone
//   } else {
//     this.rentalPayment.status = 1; // Active
//   }
// });

// // ─────────────────────────────────────────────────────────────
// // PRE-SAVE 6 — Appraisal Schedule
// // ─────────────────────────────────────────────────────────────
// const APPRAISAL_FREQUENCY_MONTHS_MAP = {
//   1: 6,   // Half Yearly
//   2: 12,  // Yearly
//   3: 24,  // Once in 2 Years
// };

// MediaSchema.pre("save", async function () {
//   if (this.appraisal?.applicable !== 1) return;

//   if (
//     !this.agreement?.startDate ||
//     !this.agreement?.endDate
//   ) {
//     return;
//   }

//   const agreementStartDate = new Date(
//     this.agreement.startDate
//   );

//   const agreementEndDate = new Date(
//     this.agreement.endDate
//   );

//   // ===============================
//   // VALIDATE NEXT DATE
//   // ===============================

//   if (this.appraisal.nextAppraisalDate) {
//     const nextDate = new Date(
//       this.appraisal.nextAppraisalDate
//     );

//     if (nextDate > agreementEndDate) {
//       throw new Error(
//         "Next appraisal date cannot be greater than agreement end date"
//       );
//     }
//   }

//   // ===============================
//   // FREQUENCY
//   // ===============================

//   let months = 0;

//   if (Number(this.appraisal.frequency) === 4) {
//     months = Number(
//       this.appraisal.customFrequencyMonths || 0
//     );

//     if (months <= 0) {
//       throw new Error(
//         "Custom frequency months must be greater than 0"
//       );
//     }
//   } else {
//     months =
//       APPRAISAL_FREQUENCY_MONTHS_MAP[
//         Number(this.appraisal.frequency)
//       ] || 12;
//   }

//   // ===============================
//   // INIT HISTORY
//   // ===============================

//   if (!Array.isArray(this.appraisal.history)) {
//     this.appraisal.history = [];
//   }

//   // ===============================
//   // FETCH OLD DOC
//   // ===============================

//   let oldDoc = null;

//   if (!this.isNew) {
//     oldDoc = await this.constructor
//       .findById(this._id)
//       .lean();
//   }

//   // ===============================
//   // INITIAL CURRENT RENT
//   // ===============================

//   const netPayable = Number(
//     this.rentalPayment?.netPayable || 0
//   );

//   // For new document, set current rent from netPayable
//   if (this.isNew) {
//     this.appraisal.currentRent = netPayable;
//   } else if (
//     !this.appraisal.currentRent ||
//     this.appraisal.currentRent <= 0
//   ) {
//     this.appraisal.currentRent = netPayable;
//   }

// if (
//   oldDoc &&
//   oldDoc.appraisal?.nextAppraisalDate &&
//   this.appraisal?.nextAppraisalDate
// ) {
//   const oldNextDate = new Date(oldDoc.appraisal.nextAppraisalDate);
//   const newNextDate = new Date(this.appraisal.nextAppraisalDate);

//   if (oldNextDate.getTime() !== newNextDate.getTime()) {

//     // Always start from old doc's history
//     const existingHistory = Array.isArray(oldDoc.appraisal?.history)
//       ? oldDoc.appraisal.history.map(h => ({ ...h }))
//       : [];

//     const appraisalDate = new Date(oldDoc.appraisal.nextAppraisalDate);

//     // ── FIX: Check if this date already has a history entry ──
//     const existingEntryForDate = existingHistory.find(
//       (item) =>
//         item.appraisalDate &&
//         new Date(item.appraisalDate).getTime() === appraisalDate.getTime()
//     );

//     if (existingEntryForDate) {
//       // ── Entry already exists for this date — DO NOT duplicate, just preserve ──
//       // Only update currentRent to that entry's newRent for continuity
//       this.appraisal.history = existingHistory;
//       this.appraisal.lastAppraisalDate = appraisalDate;
//       this.appraisal.currentRent = Number(existingEntryForDate.newRent);

//     } else {
//       // ── No entry for this date yet — calculate and add ──

//       // Get previousRent: rent BEFORE the old nextAppraisalDate appraisal
//       // Look at last history entry's newRent, or fall back to oldDoc currentRent
//       let previousRent = 0;

//       if (existingHistory.length > 0) {
//         // previousRent = newRent of the most recent history entry
//         const lastEntry = existingHistory[existingHistory.length - 1];
//         previousRent = Number(lastEntry.newRent || 0);
//       }

//       // Fallback: if no history, use oldDoc's netPayable as base rent
//       if (!previousRent || previousRent <= 0) {
//         previousRent = Number(oldDoc.rentalPayment?.netPayable || 0);
//       }

//       let appraisalAmount = 0;
//       if (Number(oldDoc.appraisal?.type) === 1) {
//         appraisalAmount =
//           (previousRent * Number(oldDoc.appraisal?.percentage || 0)) / 100;
//       } else if (Number(oldDoc.appraisal?.type) === 2) {
//         appraisalAmount = Number(oldDoc.appraisal?.fixedAmount || 0);
//       }

//       appraisalAmount = Math.round(appraisalAmount);
//       const newRent = Math.round(previousRent + appraisalAmount);

//       // Remove any duplicate for safety
//       const filteredHistory = existingHistory.filter(
//         (item) =>
//           !item.appraisalDate ||
//           new Date(item.appraisalDate).getTime() !== appraisalDate.getTime()
//       );

//       // Push new entry
//       filteredHistory.push({
//         appraisalDate,
//         type:            oldDoc.appraisal.type,
//         percentage:      oldDoc.appraisal.percentage || 0,
//         fixedAmount:     oldDoc.appraisal.fixedAmount || 0,
//         previousRent,
//         appraisalAmount,
//         newRent,
//         updatedBy: this._updatedBy || null,
//         updatedAt: new Date(),
//       });

//       this.appraisal.history     = filteredHistory;
//       this.appraisal.lastAppraisalDate = appraisalDate;
//       this.appraisal.currentRent = newRent;
//     }
//   }
// }
//   // =====================================
//   // CALCULATE NEXT APPRAISAL AMOUNTS
//   // (Using current rent and current type)
//   // =====================================

//   let nextAppraisalAmount = 0;

//   if (Number(this.appraisal.type) === 1) {
//     nextAppraisalAmount =
//       (Number(this.appraisal.currentRent) *
//         Number(
//           this.appraisal.percentage || 0
//         )) /
//       100;
//   } else if (
//     Number(this.appraisal.type) === 2
//   ) {
//     nextAppraisalAmount = Number(
//       this.appraisal.fixedAmount || 0
//     );
//   }

//   nextAppraisalAmount = Math.round(
//     nextAppraisalAmount
//   );

//   this.appraisal.appraisalAmount = nextAppraisalAmount;

//   this.appraisal.totalAppraisalAmount = Math.round(
//     Number(this.appraisal.currentRent) +
//       nextAppraisalAmount
//   );

//   // ===============================
//   // FIRST DATE - NEW DOCUMENT
//   // ===============================

//   if (this.isNew && !this.appraisal.nextAppraisalDate) {
//     const firstDate = new Date(
//       agreementStartDate
//     );

//     firstDate.setMonth(
//       firstDate.getMonth() + months
//     );

//     if (firstDate <= agreementEndDate) {
//       this.appraisal.nextAppraisalDate = firstDate;
//     }
//   }

//   // ===============================
//   // ADD INITIAL HISTORY ENTRY FOR NEW DOCUMENT
//   // ===============================

//   if (this.isNew && this.appraisal.nextAppraisalDate) {
//   const currentRent = Number(this.appraisal.currentRent || 0);

//   let initialAppraisalAmount = 0;
//   if (Number(this.appraisal.type) === 1) {
//     initialAppraisalAmount = (currentRent * Number(this.appraisal.percentage || 0)) / 100;
//   } else if (Number(this.appraisal.type) === 2) {
//     initialAppraisalAmount = Number(this.appraisal.fixedAmount || 0);
//   }

//   initialAppraisalAmount = Math.round(initialAppraisalAmount);
//   const newRent = Math.round(currentRent + initialAppraisalAmount);

//   const dateExists = this.appraisal.history.some(
//     (item) =>
//       item.appraisalDate &&
//       new Date(item.appraisalDate).getTime() ===
//         new Date(this.appraisal.nextAppraisalDate).getTime()
//   );

//   if (!dateExists) {
//     this.appraisal.history.push({
//       appraisalDate:   new Date(this.appraisal.nextAppraisalDate),
//       type:            this.appraisal.type,
//       percentage:      this.appraisal.percentage || 0,
//       fixedAmount:     this.appraisal.fixedAmount || 0,
//       previousRent:    currentRent,
//       appraisalAmount: initialAppraisalAmount,
//       newRent,
//       updatedBy: this._updatedBy || null,  // ← from token
//       updatedAt: new Date(),               // ← current timestamp
//     });
//   }

//   this.appraisal.currentRent          = newRent;
//   this.appraisal.appraisalAmount      = initialAppraisalAmount;
//   this.appraisal.totalAppraisalAmount = Math.round(currentRent + initialAppraisalAmount);
// }
// });
// module.exports = mongoose.model("MediaOnboarding", MediaSchema);






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
    updatedBy: { type: String, default: null }, // from req.userName via token
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
      // gstType: 1=Inclusive  2=Exclusive
      gstType: {
        type: Number,
        enum: [1, 2],
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
        // NOTE: When gstApplicable=1, only paymentCategory=2 (Online) is allowed
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
// PRE-SAVE 2 — GST + TDS + netPayable + Owner Payments
//
// KEY RULES:
//   1. netPayable = totalRentalAmount + gstAmount - tdsAmount
//   2. Owner share split is based on netPayable (NOT totalRentalAmount)
//      - typeShare=1 (percentage): ownerShare = netPayable * sharePercentage / 100
//      - typeShare=2 (fixed):      ownerShare = shareAmount (as entered)
//   3. When gstApplicable=1, owner paymentCategory MUST be 2 (Online only)
//      This is enforced in the controller validator; pre-save trusts the data
//      is already validated.
//
// GST LOGIC:
//   gstApplicable=0  → no GST; gstAmount = 0
//   gstApplicable=1  → gstAmount = totalRentalAmount * gstPercentage / 100
//                      (Inclusive or Exclusive — gstAmount is always added on
//                       top for netPayable purposes; Inclusive vs Exclusive only
//                       affects invoicing display, not what the owner receives)
//
// TDS LOGIC (on totalRentalAmount + gstAmount):
//   tdsBase    = totalRentalAmount + gstAmount  (GST-inclusive amount)
//   tdsAmount  = tdsBase * tdsPercentage / 100
//   netPayable = tdsBase - tdsAmount
//
// Example: totalRentalAmount=50,000 | GST 18% → gstAmount=9,000
//          tdsBase = 59,000 | TDS 10% → tdsAmount=5,900
//          netPayable = 59,000 - 5,900 = 53,100
//
// ─────────────────────────────────────────────────────────────
MediaSchema.pre("save", function () {
  const rp = this.rentalPayment;

  const totalRentalAmount = Number(rp.totalRentalAmount || 0);

  // ── STEP A: GST ──────────────────────────────────────────
  const gstApplicable = Number(rp.gstApplicable || 0);

  let gstAmount = 0;

  if (gstApplicable === 1) {
    const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");

    rp.gstPercentage = envGstPct;

    gstAmount = parseFloat(
      ((totalRentalAmount * envGstPct) / 100).toFixed(2)
    );
  } else {
    rp.gstPercentage = 0;
  }

  rp.gstAmount = gstAmount;

  // totalRentalAmountWithGst = base + GST
  // TDS is calculated on this GST-inclusive amount
  const totalRentalAmountWithGst = parseFloat(
    (totalRentalAmount + gstAmount).toFixed(2)
  );
  rp.totalRentalAmountWithGst = totalRentalAmountWithGst;

  // ── STEP B: TDS (on totalRentalAmount + GST) ─────────────
  // TDS base = 50,000 + 9,000 = 59,000
  // TDS 10%  = 5,900
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
      ? parseFloat(
          ((totalRentalAmountWithGst * tdsPercentage) / 100).toFixed(2)
        )
      : 0;

  rp.tdsAmount = tdsAmount;

  // ── netPayable = (totalRentalAmount + GST) - TDS ─────────
  // 50,000 + 9,000 - 5,900 = 53,100
  // This is the actual amount split among landowners.
  const netPayable = parseFloat(
    (totalRentalAmountWithGst - tdsAmount).toFixed(2)
  );

  rp.netPayable = netPayable;

  // ── NO LAND OWNERS ───────────────────────────────────────
  if (!this.landOwners || !this.landOwners.length) {
    return;
  }

  // ── STEP C: OWNER SHARE CALCULATION ──────────────────────
  // CHANGE: Split is now based on netPayable (totalRentalAmount + GST - TDS)
  // so owners receive the correct amount including GST.
  //
  //   typeShare=1 (percentage) → shareAmount = netPayable * sharePercentage / 100
  //   typeShare=2 (fixed)      → shareAmount kept as-is (validated in controller)
  const ownerSplitBaseAmount = netPayable; // ← KEY CHANGE: was totalRentalAmount

  this.landOwners.forEach((owner) => {
    if (Number(owner.typeShare) === 1) {
      const sharePercentage = Number(owner.sharePercentage || 0);

      owner.shareAmount = parseFloat(
        ((ownerSplitBaseAmount * sharePercentage) / 100).toFixed(2)
      );
    } else if (Number(owner.typeShare) === 2) {
      owner.sharePercentage = undefined;

      owner.shareAmount = parseFloat(
        Number(owner.shareAmount || 0).toFixed(2)
      );
    }
  });

  // ── STEP D: OWNER PAYMENTS ───────────────────────────────
  // When gstApplicable=1, paymentCategory is guaranteed to be 2 (Online)
  // by controller validation, so cash paths below won't be hit in that case.
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
    };

    // Cash Only
    if (paymentCategory === 1) {
      payment.cashAmount = ownerAmount;
      payment.onlineAmount = 0;
    }

    // Online Only
    else if (paymentCategory === 2) {
      payment.onlineMode = owner.onlineMode;
      payment.cashAmount = 0;
      payment.onlineAmount = ownerAmount;
    }

    // Cash + Online
    else if (paymentCategory === 3) {
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

  // CREATE + caller supplied nextBillingDate → keep it, skip auto-compute
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
      this.agreement.status = 3; // Expired
    } else if (daysUntilExpiry <= reminderDays) {
      this.agreement.status = 2; // Expire Zone
    } else {
      this.agreement.status = 1; // Active
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
    this.rentalPayment.status = 3; // Expired
  } else if (daysUntilBill <= expireZoneDays) {
    this.rentalPayment.status = 2; // Expire Zone
  } else {
    this.rentalPayment.status = 1; // Active
  }
});

// ─────────────────────────────────────────────────────────────
// PRE-SAVE 6 — Appraisal Schedule
// ─────────────────────────────────────────────────────────────
const APPRAISAL_FREQUENCY_MONTHS_MAP = {
  1: 6,  // Half Yearly
  2: 12, // Yearly
  3: 24, // Once in 2 Years
};

MediaSchema.pre("save", async function () {
  if (this.appraisal?.applicable !== 1) return;

  if (!this.agreement?.startDate || !this.agreement?.endDate) return;

  const agreementStartDate = new Date(this.agreement.startDate);
  const agreementEndDate = new Date(this.agreement.endDate);

  // ===============================
  // VALIDATE NEXT DATE
  // ===============================

  if (this.appraisal.nextAppraisalDate) {
    const nextDate = new Date(this.appraisal.nextAppraisalDate);
    if (nextDate > agreementEndDate) {
      throw new Error("Next appraisal date cannot be greater than agreement end date");
    }
  }

  // ===============================
  // FREQUENCY
  // ===============================

  let months = 0;

  if (Number(this.appraisal.frequency) === 4) {
    months = Number(this.appraisal.customFrequencyMonths || 0);
    if (months <= 0) {
      throw new Error("Custom frequency months must be greater than 0");
    }
  } else {
    months = APPRAISAL_FREQUENCY_MONTHS_MAP[Number(this.appraisal.frequency)] || 12;
  }

  // ===============================
  // INIT HISTORY
  // ===============================

  if (!Array.isArray(this.appraisal.history)) {
    this.appraisal.history = [];
  }

  // ===============================
  // FETCH OLD DOC
  // ===============================

  let oldDoc = null;

  if (!this.isNew) {
    oldDoc = await this.constructor.findById(this._id).lean();
  }

  // ===============================
  // INITIAL CURRENT RENT
  // ===============================

  const netPayable = Number(this.rentalPayment?.netPayable || 0);

  if (this.isNew) {
    this.appraisal.currentRent = netPayable;
  } else if (!this.appraisal.currentRent || this.appraisal.currentRent <= 0) {
    this.appraisal.currentRent = netPayable;
  }

  // ===============================
  // HANDLE NEXT DATE CHANGE → LOG HISTORY
  // ===============================

  if (
    oldDoc &&
    oldDoc.appraisal?.nextAppraisalDate &&
    this.appraisal?.nextAppraisalDate
  ) {
    const oldNextDate = new Date(oldDoc.appraisal.nextAppraisalDate);
    const newNextDate = new Date(this.appraisal.nextAppraisalDate);

    if (oldNextDate.getTime() !== newNextDate.getTime()) {
      // Always start from old doc's persisted history
      const existingHistory = Array.isArray(oldDoc.appraisal?.history)
        ? oldDoc.appraisal.history.map((h) => ({ ...h }))
        : [];

      const appraisalDate = new Date(oldDoc.appraisal.nextAppraisalDate);

      // Check if this date already has a history entry
      const existingEntryForDate = existingHistory.find(
        (item) =>
          item.appraisalDate &&
          new Date(item.appraisalDate).getTime() === appraisalDate.getTime()
      );

      if (existingEntryForDate) {
        // Entry already exists — preserve and do not duplicate
        this.appraisal.history = existingHistory;
        this.appraisal.lastAppraisalDate = appraisalDate;
        this.appraisal.currentRent = Number(existingEntryForDate.newRent);
      } else {
        // No entry for this date — calculate and add

        // ── FIX: Derive previousRent from last history entry OR oldDoc.currentRent ──
        // oldDoc.currentRent is the source of truth after previous saves
        let previousRent = 0;

        if (existingHistory.length > 0) {
          const lastEntry = existingHistory[existingHistory.length - 1];
          previousRent = Number(lastEntry.newRent || 0);
        }

        // ── FIX: Fall back to oldDoc.appraisal.currentRent (not netPayable) ──
        if (!previousRent || previousRent <= 0) {
          previousRent = Number(
            oldDoc.appraisal?.currentRent ||
            oldDoc.rentalPayment?.netPayable ||
            0
          );
        }

        let appraisalAmount = 0;
        if (Number(oldDoc.appraisal?.type) === 1) {
          appraisalAmount =
            (previousRent * Number(oldDoc.appraisal?.percentage || 0)) / 100;
        } else if (Number(oldDoc.appraisal?.type) === 2) {
          appraisalAmount = Number(oldDoc.appraisal?.fixedAmount || 0);
        }

        appraisalAmount = Math.round(appraisalAmount);
        const newRent = Math.round(previousRent + appraisalAmount);

        // Filter out any stale entry for this date (safety) then push
        const filteredHistory = existingHistory.filter(
          (item) =>
            !item.appraisalDate ||
            new Date(item.appraisalDate).getTime() !== appraisalDate.getTime()
        );

        filteredHistory.push({
          appraisalDate,
          type: oldDoc.appraisal.type,
          percentage: oldDoc.appraisal.percentage || 0,
          fixedAmount: oldDoc.appraisal.fixedAmount || 0,
          previousRent,
          appraisalAmount,
          newRent,
          updatedBy: this._updatedBy || null,
          updatedAt: new Date(),
        });

        this.appraisal.history = filteredHistory;
        this.appraisal.lastAppraisalDate = appraisalDate;
        this.appraisal.currentRent = newRent;
      }
    } else {
      // ── FIX: Date unchanged — restore history from oldDoc to prevent history loss ──
      // Without this, partial updates (e.g. changing fixedAmount only) would wipe history
      if (Array.isArray(oldDoc.appraisal?.history) && oldDoc.appraisal.history.length > 0) {
        const incomingHistoryLength = this.appraisal.history?.length || 0;
        if (incomingHistoryLength < oldDoc.appraisal.history.length) {
          this.appraisal.history = oldDoc.appraisal.history.map((h) => ({ ...h }));
        }
      }
    }
  }

  // =====================================
  // CALCULATE NEXT APPRAISAL AMOUNTS
  // =====================================

  let nextAppraisalAmount = 0;

  if (Number(this.appraisal.type) === 1) {
    nextAppraisalAmount =
      (Number(this.appraisal.currentRent) * Number(this.appraisal.percentage || 0)) / 100;
  } else if (Number(this.appraisal.type) === 2) {
    nextAppraisalAmount = Number(this.appraisal.fixedAmount || 0);
  }

  nextAppraisalAmount = Math.round(nextAppraisalAmount);
  this.appraisal.appraisalAmount = nextAppraisalAmount;
  this.appraisal.totalAppraisalAmount = Math.round(
    Number(this.appraisal.currentRent) + nextAppraisalAmount
  );

  // ===============================
  // FIRST DATE — NEW DOCUMENT
  // ===============================

  if (this.isNew && !this.appraisal.nextAppraisalDate) {
    const firstDate = new Date(agreementStartDate);
    firstDate.setMonth(firstDate.getMonth() + months);

    if (firstDate <= agreementEndDate) {
      this.appraisal.nextAppraisalDate = firstDate;
    }
  }

  // ===============================
  // ADD INITIAL HISTORY ENTRY — NEW DOCUMENT
  // ===============================

  if (this.isNew && this.appraisal.nextAppraisalDate) {
    // ── FIX: Use netPayable as base (currentRent was set to netPayable above for isNew) ──
    const baseRent = Number(this.rentalPayment?.netPayable || 0);

    let initialAppraisalAmount = 0;
    if (Number(this.appraisal.type) === 1) {
      initialAppraisalAmount =
        (baseRent * Number(this.appraisal.percentage || 0)) / 100;
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
        previousRent: baseRent,       // ← always netPayable on creation
        appraisalAmount: initialAppraisalAmount,
        newRent,
        updatedBy: this._updatedBy || null,
        updatedAt: new Date(),
      });
    }

    // ── FIX: currentRent stays as netPayable on new doc ──
    // It should only advance to newRent after the NEXT date change
    // Uncomment below ONLY if you want currentRent = newRent immediately on creation:
    // this.appraisal.currentRent = newRent;

    this.appraisal.appraisalAmount = initialAppraisalAmount;
    this.appraisal.totalAppraisalAmount = Math.round(baseRent + initialAppraisalAmount);
  }
});

module.exports = mongoose.model("MediaOnboarding", MediaSchema);