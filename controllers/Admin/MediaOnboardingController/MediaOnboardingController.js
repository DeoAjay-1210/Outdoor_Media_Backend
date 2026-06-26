// const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
// const { successResponse, errorResponse } = require("../../../utils/response");
// const path = require("path");
// const XLSX = require("xlsx");
 
// // ─────────────────────────────────────────────────────────────
// // PROCESS FILES HELPER
// // ─────────────────────────────────────────────────────────────
// const processUploadedFile = (uploadedFile) => {
//   if (uploadedFile) {
//     const { getFileUrl } = require("../../../middleware/dynamicFileUpload");
 
//     let fileType = "other";
//     if (uploadedFile.mimetype.startsWith("image/")) {
//       fileType = "image";
//     } else if (uploadedFile.mimetype === "application/pdf") {
//       fileType = "pdf";
//     }
 
//     return {
//       originalName: uploadedFile.originalname,
//       fileName: uploadedFile.filename || uploadedFile.key?.split("/").pop(),
//       filePath: getFileUrl(uploadedFile),
//       mimeType: uploadedFile.mimetype,
//       size: uploadedFile.size,
//       fileType,
//       uploadedAt: new Date(),
//     };
//   }
//   return null;
// };
 
// // ─────────────────────────────────────────────────────────────
// // IST DATE HELPER
// // ─────────────────────────────────────────────────────────────
// const getISTDate = () => {
//   const now = new Date();
//   const istOffset = 5.5 * 60 * 60 * 1000;
//   return new Date(now.getTime() + istOffset);
// };
 
// // ─────────────────────────────────────────────────────────────
// // VALIDATE OWNER PAYMENT CATEGORIES
// // ─────────────────────────────────────────────────────────────
// const validateOwnerPaymentCategories = (
//   landOwners,
//   netPayable,
//   rentalGstApplicable
// ) => {
//   for (const owner of landOwners) {
//     const cat = Number(owner.paymentCategory);
//     const ownerGstApplicable = Number(owner.gstApplicable || 0);
 
//     if (rentalGstApplicable === 1) {
//       if (cat !== 2) {
//         return {
//           valid: false,
//           message: `Owner "${owner.name}": When rental GST is applicable, paymentCategory must be 2 (Online) only.`,
//         };
//       }
//     } else {
//       if (cat === 1 && ownerGstApplicable === 1) {
//         return {
//           valid: false,
//           message: `Owner "${owner.name}": gstApplicable cannot be 1 when paymentCategory is 1 (Cash only).`,
//         };
//       }
 
//       if (cat === 2 || cat === 3) {
//         const onlineMode = Number(owner.onlineMode);
//         if (![1, 2, 3].includes(onlineMode)) {
//           return {
//             valid: false,
//             message: `Owner "${owner.name}": onlineMode is required and must be 1 (Bank Transfer), 2 (UPI), or 3 (Cheque)`,
//           };
//         }
//       }
 
//       if (cat === 3) {
//         const cashAmt = Number(owner.cashAmount) || 0;
//         const onlineAmt = Number(owner.onlineAmount) || 0;
 
//         if (cashAmt < 0 || onlineAmt < 0) {
//           return {
//             valid: false,
//             message: `Owner "${owner.name}": cashAmount and onlineAmount must be >= 0`,
//           };
//         }
 
//         let ownerShare = 0;
//         if (Number(owner.typeShare) === 1) {
//           ownerShare = parseFloat(
//             ((netPayable * (Number(owner.sharePercentage) || 0)) / 100).toFixed(2)
//           );
//         } else {
//           ownerShare = parseFloat((Number(owner.shareAmount) || 0).toFixed(2));
//         }
 
//         const splitTotal = parseFloat((cashAmt + onlineAmt).toFixed(2));
//         if (Math.abs(splitTotal - ownerShare) > 0.01) {
//           return {
//             valid: false,
//             message: `Owner "${owner.name}": cashAmount (${cashAmt}) + onlineAmount (${onlineAmt}) = ${splitTotal} does not match owner share amount ${ownerShare}.`,
//           };
//         }
 
//         if (ownerGstApplicable === 1 && onlineAmt <= 0) {
//           return {
//             valid: false,
//             message: `Owner "${owner.name}": gstApplicable is 1 but onlineAmount is 0.`,
//           };
//         }
//       }
//     }
 
//     if (![1, 2, 3].includes(cat)) {
//       return {
//         valid: false,
//         message: `Owner "${owner.name}": paymentCategory must be 1 (Cash), 2 (Online), or 3 (Cash+Online)`,
//       };
//     }
//   }
 
//   return { valid: true };
// };
 
// // ─────────────────────────────────────────────────────────────
// // VALIDATE LAND OWNER SHARES
// // ─────────────────────────────────────────────────────────────
// const validateLandOwnerShares = (
//   landOwners,
//   totalRentalAmount,
//   tdsApplicable,
//   tdsPercentage,
//   gstApplicable
// ) => {
//   const tdsAmount =
//     tdsApplicable === 1 && tdsPercentage > 0
//       ? parseFloat(((totalRentalAmount * tdsPercentage) / 100).toFixed(2))
//       : 0;
 
//   const amountAfterTds = parseFloat((totalRentalAmount - tdsAmount).toFixed(2));
 
//   let gstAmount = 0;
//   let totalWithGst = amountAfterTds;
 
//   if (gstApplicable === 1) {
//     const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
//     gstAmount = parseFloat(((totalRentalAmount * envGstPct) / 100).toFixed(2));
//     totalWithGst = parseFloat((amountAfterTds + gstAmount).toFixed(2));
//   }
 
//   const netPayable = parseFloat(totalWithGst.toFixed(2));
 
//   if (!landOwners || !landOwners.length) {
//     return { valid: false, message: "At least one land owner is required" };
//   }
 
//   let totalComputedAmount = 0;
//   let hasPercentageShare = false;
//   let hasFixedShare = false;
 
//   for (const owner of landOwners) {
//     const typeShare = Number(owner.typeShare);
 
//     if (!typeShare || (typeShare !== 1 && typeShare !== 2)) {
//       return {
//         valid: false,
//         message: `Owner "${owner.name || "Unknown"}": typeShare must be 1 (percentage) or 2 (fixed amount).`,
//       };
//     }
 
//     if (typeShare === 1) {
//       hasPercentageShare = true;
//       const sharePercentage = Number(owner.sharePercentage);
 
//       if (isNaN(sharePercentage) || sharePercentage < 0 || sharePercentage > 100) {
//         return {
//           valid: false,
//           message: `Owner "${owner.name || "Unknown"}": sharePercentage must be between 0 and 100.`,
//         };
//       }
 
//       totalComputedAmount += parseFloat(
//         ((netPayable * sharePercentage) / 100).toFixed(2)
//       );
//     } else if (typeShare === 2) {
//       hasFixedShare = true;
//       const shareAmount = Number(owner.shareAmount);
 
//       if (isNaN(shareAmount) || shareAmount < 0) {
//         return {
//           valid: false,
//           message: `Owner "${owner.name || "Unknown"}": shareAmount must be >= 0.`,
//         };
//       }
 
//       totalComputedAmount += parseFloat(shareAmount.toFixed(2));
//     }
//   }
 
//   if (hasPercentageShare && !hasFixedShare) {
//     let percentageSum = 0;
//     for (const owner of landOwners) {
//       if (Number(owner.typeShare) === 1) {
//         percentageSum += Number(owner.sharePercentage || 0);
//       }
//     }
 
//     if (Math.abs(percentageSum - 100) > 0.01) {
//       return {
//         valid: false,
//         message: `Total percentage shares (${percentageSum.toFixed(2)}%) must equal 100%.`,
//       };
//     }
//   }
 
//   const diff = Math.abs(totalComputedAmount - netPayable);
 
//   if (diff > 1) {
//     return {
//       valid: false,
//       message: `Total owner share (${totalComputedAmount.toFixed(2)}) does not match net payable amount (${netPayable.toFixed(2)}). Difference: ${diff.toFixed(2)}`,
//     };
//   }
 
//   return {
//     valid: true,
//     netPayable,
//     tdsAmount,
//     amountAfterTds,
//     gstAmount,
//     totalComputedAmount,
//   };
// };
 
// // ─────────────────────────────────────────────────────────────
// // VALIDATE GST
// // ─────────────────────────────────────────────────────────────
// const validateGst = (rentalPayment) => {
//   const gstApplicable = Number(rentalPayment?.gstApplicable) || 0;
 
//   if (gstApplicable === 1) {
//     if (!rentalPayment?.gstNumber || !rentalPayment.gstNumber.trim()) {
//       return {
//         valid: false,
//         message: "rentalPayment.gstNumber is required when gstApplicable is 1",
//       };
//     }
//   }
 
//   return { valid: true };
// };
 
// // ─────────────────────────────────────────────────────────────
// // COMPUTE AGREEMENT STATUS HELPER
// // (Mirrors PRE-SAVE 4 logic so history snapshots have correct status)
// // ─────────────────────────────────────────────────────────────
// const computeAgreementStatus = (startDate, endDate, reminderDays) => {
//   if (!startDate || !endDate) return 1;
//   const now = new Date();
//   const end = new Date(endDate);
//   const daysUntilExpiry = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
 
//   if (daysUntilExpiry < 0) return 3;
//   if (daysUntilExpiry <= reminderDays) return 2;
//   return 1;
// };
 
// const handleAgreementHistory = (mediaData, existingMedia) => {
//   const agreement = mediaData.agreement;
 
//   if (!agreement) return mediaData;
 
//   // Existing History
//   const existingHistory = existingMedia
//     ? (existingMedia.agreementHistory || []).map((h) =>
//         h.toObject ? h.toObject() : { ...h }
//       )
//     : [];
 
//   // Current Snapshot (this should only be used when creating new or updating existing)
//   const status = computeAgreementStatus(
//     agreement.startDate,
//     agreement.endDate,
//     agreement.reminderBeforeExpiry
//   );
 
//   const snapshot = {
//     startDate: agreement.startDate ? new Date(agreement.startDate) : undefined,
//     endDate: agreement.endDate ? new Date(agreement.endDate) : undefined,
//     reminderBeforeExpiry: agreement.reminderBeforeExpiry,
//     advanceRent: agreement.advanceRent || 0,
//     status,
//     agreementPDF: agreement.agreementPDF
//       ? { ...agreement.agreementPDF }
//       : undefined,
//     uploadedAt: getISTDate(),
//   };
 
//   // CREATE (new media - no existing agreement)
//   if (!existingMedia) {
//     existingHistory.push(snapshot);
//     mediaData.agreementHistory = existingHistory;
//     return mediaData;
//   }
 
//   // For existing media, we need to check if dates changed
//   const oldStart = existingMedia.agreement?.startDate
//     ? new Date(existingMedia.agreement.startDate).getTime()
//     : null;
 
//   const oldEnd = existingMedia.agreement?.endDate
//     ? new Date(existingMedia.agreement.endDate).getTime()
//     : null;
 
//   const newStart = agreement.startDate
//     ? new Date(agreement.startDate).getTime()
//     : null;
 
//   const newEnd = agreement.endDate
//     ? new Date(agreement.endDate).getTime()
//     : null;
 
//   const agreementDatesChanged = oldStart !== newStart || oldEnd !== newEnd;
 
//   // If dates changed, push OLD agreement to history, then update with NEW
//   if (agreementDatesChanged) {
//     if (existingMedia.agreement) {
//       const oldStatus = computeAgreementStatus(
//         existingMedia.agreement.startDate,
//         existingMedia.agreement.endDate,
//         existingMedia.agreement.reminderBeforeExpiry || 30
//       );
 
//       // Check for duplicate to avoid adding the same record twice
//       const isDuplicate = existingHistory.some(
//         (h) =>
//           new Date(h.startDate).getTime() ===
//             new Date(existingMedia.agreement.startDate).getTime() &&
//           new Date(h.endDate).getTime() ===
//             new Date(existingMedia.agreement.endDate).getTime() &&
//           h.advanceRent === (existingMedia.agreement.advanceRent || 0)
//       );
 
//       if (!isDuplicate) {
//         existingHistory.push({
//           startDate: new Date(existingMedia.agreement.startDate),
//           endDate: new Date(existingMedia.agreement.endDate),
//           reminderBeforeExpiry: existingMedia.agreement.reminderBeforeExpiry,
//           advanceRent: existingMedia.agreement.advanceRent || 0,
//           status: oldStatus,
//           agreementPDF: existingMedia.agreement.agreementPDF
//             ? { ...existingMedia.agreement.agreementPDF }
//             : undefined,
//           uploadedAt: getISTDate(),
//         });
//       }
//     }
 
//     mediaData.agreement = snapshot;
//   } else {
//     // DATE NOT CHANGED - Update Latest History Record
//     if (existingHistory.length > 0) {
//       const lastIndex = existingHistory.length - 1;
 
//       existingHistory[lastIndex] = {
//         ...existingHistory[lastIndex],
//         reminderBeforeExpiry: agreement.reminderBeforeExpiry,
//         advanceRent: agreement.advanceRent || 0,
//         status,
//         agreementPDF: agreement.agreementPDF
//           ? { ...agreement.agreementPDF }
//           : existingHistory[lastIndex].agreementPDF,
//         uploadedAt: getISTDate(),
//       };
//     } else {
//       // Safety fallback
//       existingHistory.push(snapshot);
//     }
//   }
 
//   mediaData.agreementHistory = existingHistory;
 
//   return mediaData;
// };
 
// // ─────────────────────────────────────────────────────────────
// // VALIDATE APPRAISAL FREQUENCY
// // ─────────────────────────────────────────────────────────────
// const APPRAISAL_FREQUENCY_MONTHS = { 1: 6, 2: 12, 3: 24 };
// const APPRAISAL_FREQUENCY_LABEL = {
//   1: "6 Months",
//   2: "Yearly (12 Months)",
//   3: "2 Years (24 Months)",
//   4: "Custom",
// };
 
// const validateAppraisalFrequency = (agreement, appraisal) => {
//   if (Number(appraisal?.applicable) !== 1) return { valid: true };
 
//   const startDate = agreement?.startDate ? new Date(agreement.startDate) : null;
//   const endDate = agreement?.endDate ? new Date(agreement.endDate) : null;
//   const frequency = Number(appraisal?.frequency);
 
//   if (!startDate || !endDate) {
//     return {
//       valid: false,
//       message:
//         "agreement.startDate and agreement.endDate are required when appraisal.applicable is 1",
//     };
//   }
 
//   if (![1, 2, 3, 4].includes(frequency)) {
//     return {
//       valid: false,
//       message:
//         "appraisal.frequency must be 1 (6 Months), 2 (Yearly), 3 (2 Years), or 4 (Custom)",
//     };
//   }
 
//   let months;
//   if (frequency === 4) {
//     months = Number(appraisal?.customFrequencyMonths);
//     if (!months || months < 1 || !Number.isInteger(months)) {
//       return {
//         valid: false,
//         message:
//           "appraisal.customFrequencyMonths is required and must be a positive integer when frequency is 4 (Custom)",
//       };
//     }
//   } else {
//     months = APPRAISAL_FREQUENCY_MONTHS[frequency];
//   }
 
//   const candidateDate = new Date(startDate);
//   candidateDate.setMonth(candidateDate.getMonth() + months);
 
//   if (candidateDate >= endDate) {
//     const label = APPRAISAL_FREQUENCY_LABEL[frequency];
//     const freqDisplay = frequency === 4 ? `Custom (${months} months)` : label;
//     return {
//       valid: false,
//       message: `Appraisal frequency "${freqDisplay}" is not applicable. The next appraisal (${candidateDate.toLocaleDateString(
//         "en-GB"
//       )}) would fall on or after the agreement end date (${endDate.toLocaleDateString(
//         "en-GB"
//       )}).`,
//     };
//   }
 
//   return { valid: true };
// };
 
// // ─────────────────────────────────────────────────────────────
// // HANDLE APPRAISAL LOGIC
// // (Builds the compounded history[] cycles — past + future — untouched)
// // ─────────────────────────────────────────────────────────────
// const APPRAISAL_FREQUENCY_MONTHS_MAP = { 1: 6, 2: 12, 3: 24 };
 
// const handleAppraisalLogic = async (mediaData, existingMedia, userName) => {
//   const appraisal = mediaData.appraisal;
//   const agreement = mediaData.agreement || existingMedia?.agreement;
 
//   if (!appraisal || Number(appraisal.applicable) !== 1) return mediaData;
//   if (!agreement?.startDate || !agreement?.endDate) return mediaData;
 
//   const agreementStartDate = new Date(agreement.startDate);
//   const agreementEndDate = new Date(agreement.endDate);
 
//   if (appraisal.nextAppraisalDate) {
//     const nextDate = new Date(appraisal.nextAppraisalDate);
//     if (nextDate > agreementEndDate) {
//       throw new Error("Next appraisal date cannot be greater than agreement end date");
//     }
//   }
 
//   let months = 0;
//   if (Number(appraisal.frequency) === 4) {
//     months = Number(appraisal.customFrequencyMonths || 0);
//     if (months <= 0) throw new Error("Custom frequency months must be greater than 0");
//   } else {
//     months = APPRAISAL_FREQUENCY_MONTHS_MAP[Number(appraisal.frequency)] || 12;
//   }
 
//   if (!Array.isArray(appraisal.history)) appraisal.history = [];
 
//   const netPayable = Number(mediaData.rentalPayment?.totalRentalAmount || 0);
//   const isNew = !existingMedia;
 
//   // ── CREATE flow ───────────────────────────────────────────────────────
//   if (isNew) {
//     appraisal.currentRent = netPayable;
 
//     if (!appraisal.nextAppraisalDate) {
//       const firstDate = new Date(agreementStartDate);
//       firstDate.setMonth(firstDate.getMonth() + months);
//       if (firstDate <= agreementEndDate) appraisal.nextAppraisalDate = firstDate;
//     }
 
//     if (appraisal.nextAppraisalDate) {
//       const baseRent = netPayable;
//       let initialAppraisalAmount = 0;
 
//       if (Number(appraisal.type) === 1) {
//         initialAppraisalAmount = (baseRent * Number(appraisal.percentage || 0)) / 100;
//       } else if (Number(appraisal.type) === 2) {
//         initialAppraisalAmount = Number(appraisal.fixedAmount || 0);
//       }
//       initialAppraisalAmount = Math.round(initialAppraisalAmount);
 
//       const newRent = Math.round(baseRent + initialAppraisalAmount);
 
//       const dateExists = appraisal.history.some(
//         (item) =>
//           item.appraisalDate &&
//           new Date(item.appraisalDate).getTime() ===
//             new Date(appraisal.nextAppraisalDate).getTime()
//       );
 
//       if (!dateExists) {
//         appraisal.history.push({
//           appraisalDate: new Date(appraisal.nextAppraisalDate),
//           type: appraisal.type,
//           percentage: appraisal.percentage || 0,
//           fixedAmount: appraisal.fixedAmount || 0,
//           previousRent: baseRent,
//           appraisalAmount: initialAppraisalAmount,
//           newRent,
//           updatedBy: userName,
//           updatedAt: getISTDate(),
//         });
//       }
 
//       appraisal.appraisalAmount = initialAppraisalAmount;
//       appraisal.totalAppraisalAmount = Math.round(baseRent + initialAppraisalAmount);
//     }
 
//     mediaData.appraisal = appraisal;
//     return mediaData;
//   }
 
//   // ── UPDATE flow ───────────────────────────────────────────────────────
//   const oldAppraisal = existingMedia.appraisal
//     ? JSON.parse(JSON.stringify(existingMedia.appraisal))
//     : {};
 
//   if (!Array.isArray(oldAppraisal.history)) oldAppraisal.history = [];
 
//   appraisal.history =
//     oldAppraisal.history.length > 0
//       ? oldAppraisal.history.map((h) => ({ ...h }))
//       : [];
 
//   appraisal.currentRent =
//     oldAppraisal.currentRent && oldAppraisal.currentRent > 0
//       ? oldAppraisal.currentRent
//       : netPayable;
 
//   if (oldAppraisal.lastAppraisalDate) {
//     appraisal.lastAppraisalDate = oldAppraisal.lastAppraisalDate;
//   }
 
//   let fixedAmountChanged = false;
//   let percentageChanged = false; // ← NEW
//   let nextDateChanged = false;
//   let typeChanged = false;
 
//   if (Number(appraisal.type) !== Number(oldAppraisal.type)) {
//     typeChanged = true;
//   }
 
//   if (Number(appraisal.type) === 2) {
//     const oldFixed = Number(oldAppraisal.fixedAmount || 0);
//     const newFixed = Number(appraisal.fixedAmount || 0);
//     if (oldFixed !== newFixed) fixedAmountChanged = true;
//   }
 
//   // ← NEW: detect percentage change (e.g. 10% → 8%) when type is Percentage
//   if (Number(appraisal.type) === 1) {
//     const oldPct = Number(oldAppraisal.percentage || 0);
//     const newPct = Number(appraisal.percentage || 0);
//     if (oldPct !== newPct) percentageChanged = true;
//   }
 
//   // ── Determine the OLD scheduled appraisal date ─────────────────────────
//   // recomputeAppraisalSummary may have set oldAppraisal.nextAppraisalDate to
//   // null once all scheduled cycles were in the past. The history array is the
//   // only field it never corrupts, so fall back to the LAST history entry's
//   // date as the true "last scheduled" date for change detection.
//   const lastOldHistEntry =
//     oldAppraisal.history && oldAppraisal.history.length
//       ? oldAppraisal.history[oldAppraisal.history.length - 1]
//       : null;
 
//   const oldScheduledRaw =
//     oldAppraisal.nextAppraisalDate || lastOldHistEntry?.appraisalDate || null;
 
//   if (oldScheduledRaw && appraisal.nextAppraisalDate) {
//     const oldNextDate = new Date(oldScheduledRaw);
//     const newNextDate = new Date(appraisal.nextAppraisalDate);
//     if (oldNextDate.getTime() !== newNextDate.getTime()) nextDateChanged = true;
//   }
 
//   // ── Type / fixed amount / percentage changed, date unchanged ──────────
//   // if ((fixedAmountChanged || typeChanged || percentageChanged) && !nextDateChanged) {
//   //   if (appraisal.history.length > 0) {
//   //     const lastIndex = appraisal.history.length - 1;
//   //     const lastEntry = appraisal.history[lastIndex];
//   //     const previousRent = Number(lastEntry.previousRent || 0);
 
//   //     let newAppraisalAmount = 0;
//   //     if (Number(appraisal.type) === 1) {
//   //       newAppraisalAmount = Math.round(
//   //         (previousRent * Number(appraisal.percentage || 0)) / 100
//   //       );
//   //     } else if (Number(appraisal.type) === 2) {
//   //       newAppraisalAmount = Number(appraisal.fixedAmount || 0);
//   //     }
 
//   //     const newRent = Math.round(previousRent + newAppraisalAmount);
 
//   //     appraisal.history[lastIndex] = {
//   //       ...lastEntry,
//   //       type: appraisal.type,
//   //       percentage: appraisal.percentage || 0,
//   //       fixedAmount: Number(appraisal.fixedAmount || 0),
//   //       appraisalAmount: newAppraisalAmount,
//   //       newRent,
//   //       updatedBy: userName,
//   //       updatedAt: getISTDate(),
//   //     };
 
//   //     appraisal.currentRent = newRent;
//   //     appraisal.appraisalAmount = newAppraisalAmount;
 
//   //     if (oldAppraisal.nextAppraisalDate) {
//   //       appraisal.nextAppraisalDate = oldAppraisal.nextAppraisalDate;
//   //     }
 
//   //     const totalAppraisal = appraisal.history.reduce(
//   //       (sum, entry) => sum + Number(entry.appraisalAmount || 0),
//   //       0
//   //     );
//   //     const baseRent = Number(appraisal.history[0]?.previousRent || netPayable);
//   //     appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);
 
//   //     mediaData.appraisal = appraisal;
//   //     return mediaData;
//   //   }
//   // }
//  if ((fixedAmountChanged || typeChanged || percentageChanged) && !nextDateChanged) {
//   if (appraisal.history.length > 0) {
//     const lastIndex = appraisal.history.length - 1;
//     const lastEntry = appraisal.history[lastIndex];
//     const previousRent = Number(lastEntry.previousRent || 0);

//     let newAppraisalAmount = 0;
//     if (Number(appraisal.type) === 1) {
//       newAppraisalAmount = Math.round(
//         (previousRent * Number(appraisal.percentage || 0)) / 100
//       );
//     } else if (Number(appraisal.type) === 2) {
//       newAppraisalAmount = Number(appraisal.fixedAmount || 0);
//     }

//     const newRent = Math.round(previousRent + newAppraisalAmount);

//     appraisal.history[lastIndex] = {
//       ...lastEntry,
//       type: appraisal.type,
//       percentage: appraisal.percentage || 0,
//       fixedAmount: Number(appraisal.fixedAmount || 0),
//       appraisalAmount: newAppraisalAmount,
//       newRent,
//       updatedBy: userName,
//       updatedAt: getISTDate(),
//     };

//     // ✅ FIX: Don't blindly set currentRent to the updated entry's newRent.
//     // Only update currentRent if this last entry is a PAST (applied) cycle.
//     const today = new Date();
//     today.setHours(0, 0, 0, 0);
//     const entryDate = new Date(lastEntry.appraisalDate);
//     entryDate.setHours(0, 0, 0, 0);

//     if (entryDate < today) {
//       // Past cycle — currentRent should reflect the new calculation
//       appraisal.currentRent = newRent;
//     } else {
//       // Future/upcoming cycle — currentRent stays at what it was before this entry
//       appraisal.currentRent = previousRent;
//     }

//     appraisal.appraisalAmount = newAppraisalAmount;

//     if (oldAppraisal.nextAppraisalDate) {
//       appraisal.nextAppraisalDate = oldAppraisal.nextAppraisalDate;
//     }

//     const totalAppraisal = appraisal.history.reduce(
//       (sum, entry) => sum + Number(entry.appraisalAmount || 0),
//       0
//     );
//     const baseRent = Number(appraisal.history[0]?.previousRent || netPayable);
//     appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);

//     mediaData.appraisal = appraisal;
//     return mediaData;
//   }
// }
//   if (nextDateChanged) {
//     const oldNextDate = new Date(oldScheduledRaw);
//     const newNextDate = new Date(appraisal.nextAppraisalDate);
//     let updatedHistory = oldAppraisal.history.map((h) => ({ ...h }));
 
//     // NOTE: a date change ADDS a new cycle with the new amount; existing
//     // history entries stay frozen with the amount they were created with.
//     // (Amount edits to the pending cycle happen only on a same-date update,
//     // handled in the !nextDateChanged branch above.) We deliberately do NOT
//     // retroactively rewrite the last entry here.
 
//     const oldNextDateEntryIndex = updatedHistory.findIndex(
//       (item) =>
//         item.appraisalDate &&
//         new Date(item.appraisalDate).getTime() === oldNextDate.getTime()
//     );
 
//     let currentRentValue = 0;
 
//     if (oldNextDateEntryIndex !== -1) {
//       const oldEntry = updatedHistory[oldNextDateEntryIndex];
//       if (oldNextDate < newNextDate) {
//         currentRentValue = Number(oldEntry.newRent || 0);
//       } else {
//         updatedHistory.splice(oldNextDateEntryIndex, 1);
//         currentRentValue =
//           updatedHistory.length > 0
//             ? Number(updatedHistory[updatedHistory.length - 1].newRent || 0)
//             : Number(oldAppraisal.currentRent || netPayable);
//       }
//     } else {
//       currentRentValue =
//         updatedHistory.length > 0
//           ? Number(updatedHistory[updatedHistory.length - 1].newRent || 0)
//           : Number(oldAppraisal.currentRent || netPayable);
//     }
 
//     const newNextDateExists = updatedHistory.some(
//       (item) =>
//         item.appraisalDate &&
//         new Date(item.appraisalDate).getTime() === newNextDate.getTime()
//     );
 
//     if (!newNextDateExists && oldNextDate < newNextDate) {
//       let previousRent = currentRentValue;
 
//       if (updatedHistory.length > 0) {
//         const lastEntry = updatedHistory[updatedHistory.length - 1];
//         previousRent = Number(lastEntry.newRent || currentRentValue);
//       }
 
//       let appraisalAmount = 0;
//       if (Number(appraisal.type) === 1) {
//         appraisalAmount = (previousRent * Number(appraisal.percentage || 0)) / 100;
//       } else if (Number(appraisal.type) === 2) {
//         appraisalAmount = Number(appraisal.fixedAmount || 0);
//       }
//       appraisalAmount = Math.round(appraisalAmount);
 
//       const newRent = Math.round(previousRent + appraisalAmount);
 
//       updatedHistory.push({
//         appraisalDate: newNextDate,
//         type: appraisal.type,
//         percentage: appraisal.percentage || 0,
//         fixedAmount: appraisal.fixedAmount || 0,
//         previousRent,
//         appraisalAmount,
//         newRent,
//         updatedBy: userName,
//         updatedAt: getISTDate(),
//       });
 
//       currentRentValue = newRent;
//     }
 
//     appraisal.history = updatedHistory;
//     appraisal.lastAppraisalDate = oldNextDate;
//     appraisal.currentRent = currentRentValue;
 
//     if (updatedHistory.length > 0) {
//       const lastEntry = updatedHistory[updatedHistory.length - 1];
//       appraisal.appraisalAmount = Number(lastEntry.appraisalAmount || 0);
 
//       const totalAppraisal = updatedHistory.reduce(
//         (sum, entry) => sum + Number(entry.appraisalAmount || 0),
//         0
//       );
//       const baseRent = updatedHistory[0]?.previousRent
//         ? Number(updatedHistory[0].previousRent)
//         : netPayable;
//       appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);
//     }
 
//     mediaData.appraisal = appraisal;
//     return mediaData;
//   }
 
//   // No appraisal-relevant change — keep old values
//   mediaData.appraisal = {
//     ...appraisal,
//     history: oldAppraisal.history,
//     currentRent: oldAppraisal.currentRent || appraisal.currentRent,
//     lastAppraisalDate:
//       oldAppraisal.lastAppraisalDate || appraisal.lastAppraisalDate,
//     appraisalAmount: oldAppraisal.appraisalAmount || appraisal.appraisalAmount,
//     totalAppraisalAmount:
//       oldAppraisal.totalAppraisalAmount || appraisal.totalAppraisalAmount,
//     nextAppraisalDate:
//       oldAppraisal.nextAppraisalDate || appraisal.nextAppraisalDate,
//   };
 
//   return mediaData;
// };
 

// const recomputeAppraisalSummary = (appraisal, fallbackBaseRent = 0) => {
//   if (
//     !appraisal ||
//     !Array.isArray(appraisal.history) ||
//     !appraisal.history.length
//   ) {
//     return appraisal;
//   }
 
//   const today = new Date();
//   today.setHours(0, 0, 0, 0);
//   const startOfDay = (d) => new Date(d).setHours(0, 0, 0, 0);
 
//   const sorted = appraisal.history
//     .filter((h) => h.appraisalDate)
//     .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));
 
//   if (!sorted.length) return appraisal;
 
//   const baseRent = Number(sorted[0].previousRent ?? fallbackBaseRent ?? 0);
 
//   // An appraisal dated D takes effect the day AFTER D — so on date D itself it
//   // is still "upcoming/pending", and only becomes "applied" once today > D.
//   //   applied  => appraisalDate STRICTLY before today
//   //   upcoming => appraisalDate today or later (includes the same-day cycle)
//   const applied = sorted.filter(
//     (h) => startOfDay(h.appraisalDate) < today.getTime()
//   );
//   const upcoming = sorted.filter(
//     (h) => startOfDay(h.appraisalDate) >= today.getTime()
//   );
 
//   // currentRent + lastAppraisalDate => only cycles that have actually passed
//   if (applied.length) {
//     const last = applied[applied.length - 1];
//     appraisal.currentRent = Number(last.newRent || baseRent);
//     appraisal.lastAppraisalDate = new Date(last.appraisalDate);
//   } else {
//     appraisal.currentRent = baseRent;
//     appraisal.lastAppraisalDate = null;
//   }
 
//   // nextAppraisalDate + pending increment => the soonest future cycle
//   if (upcoming.length) {
//     const next = upcoming[0];
//     appraisal.nextAppraisalDate = new Date(next.appraisalDate);
//     appraisal.appraisalAmount = Number(next.appraisalAmount || 0);
//     appraisal.totalAppraisalAmount = Math.round(
//       Number(appraisal.currentRent || 0) + Number(next.appraisalAmount || 0)
//     );
//   } else {
//     appraisal.nextAppraisalDate = null;
//     appraisal.appraisalAmount = 0;
//     appraisal.totalAppraisalAmount = Math.round(
//       Number(appraisal.currentRent || 0)
//     );
//   }
 
//   return appraisal;
// };
 
// // ─────────────────────────────────────────────────────────────
// // MEDIA ONBOARDING
// // ─────────────────────────────────────────────────────────────
// const mediaOnboarding = async (req, res) => {
//   try {
//     const { id } = req.body;
//     const mediaData = req.body;
//     const userName = req.user?.userName || "Admin";
 
//     // ── Parse JSON strings from FormData ─────────────────────
//     const jsonFields = ["landOwners", "rentalPayment", "agreement", "appraisal"];
//     jsonFields.forEach((field) => {
//       if (mediaData[field] && typeof mediaData[field] === "string") {
//         try {
//           mediaData[field] = JSON.parse(mediaData[field]);
//         } catch {
//           // leave as-is if parse fails
//         }
//       }
//     });
 
//     // ── Convert rentalPayment numeric values ──────────────────
//     if (mediaData.rentalPayment) {
//       if (mediaData.rentalPayment.totalRentalAmount !== undefined)
//         mediaData.rentalPayment.totalRentalAmount = Number(
//           mediaData.rentalPayment.totalRentalAmount
//         );
//       if (mediaData.rentalPayment.paymentFrequency)
//         mediaData.rentalPayment.paymentFrequency = Number(
//           mediaData.rentalPayment.paymentFrequency
//         );
//       if (mediaData.rentalPayment.tdsApplicable !== undefined)
//         mediaData.rentalPayment.tdsApplicable = Number(
//           mediaData.rentalPayment.tdsApplicable
//         );
//       if (mediaData.rentalPayment.gstApplicable !== undefined)
//         mediaData.rentalPayment.gstApplicable = Number(
//           mediaData.rentalPayment.gstApplicable
//         );
//     }
 
//     // ── Convert landOwners ────────────────────────────────────
//     if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
//       const hasValue = (v) => v !== undefined && v !== null && v !== "";
//       mediaData.landOwners = mediaData.landOwners.map((owner) => ({
//         ...owner,
//         typeShare: hasValue(owner.typeShare) ? Number(owner.typeShare) : undefined,
//         sharePercentage: hasValue(owner.sharePercentage)
//           ? Number(owner.sharePercentage)
//           : undefined,
//         shareAmount: hasValue(owner.shareAmount)
//           ? Number(owner.shareAmount)
//           : undefined,
//         paymentCategory: hasValue(owner.paymentCategory)
//           ? Number(owner.paymentCategory)
//           : undefined,
//         onlineMode: hasValue(owner.onlineMode) ? Number(owner.onlineMode) : undefined,
//         cashAmount: hasValue(owner.cashAmount) ? Number(owner.cashAmount) : 0,
//         onlineAmount: hasValue(owner.onlineAmount) ? Number(owner.onlineAmount) : 0,
//         gstApplicable: hasValue(owner.gstApplicable)
//           ? Number(owner.gstApplicable)
//           : 0,
//       }));
//     }
 
//     // ── Auto-assign single owner full share ───────────────────
//     if (mediaData.landOwners?.length === 1) {
//       const owner = mediaData.landOwners[0];
//       if (!owner.typeShare) {
//         owner.typeShare = 1;
//         owner.sharePercentage = 100;
//       }
//     }
 
//     // ── Convert agreement ─────────────────────────────────────
//     if (mediaData.agreement) {
//       if (mediaData.agreement.startDate)
//         mediaData.agreement.startDate = new Date(mediaData.agreement.startDate);
//       if (mediaData.agreement.endDate)
//         mediaData.agreement.endDate = new Date(mediaData.agreement.endDate);
//       if (mediaData.agreement.reminderBeforeExpiry)
//         mediaData.agreement.reminderBeforeExpiry = Number(
//           mediaData.agreement.reminderBeforeExpiry
//         );
//     }
 
//     // ── Convert rentalPayment dates ───────────────────────────
//     if (mediaData.rentalPayment?.lastBillPaidDate)
//       mediaData.rentalPayment.lastBillPaidDate = new Date(
//         mediaData.rentalPayment.lastBillPaidDate
//       );
 
//     // ── Convert appraisal ─────────────────────────────────────
//     if (mediaData.appraisal) {
//       if (mediaData.appraisal.applicable !== undefined)
//         mediaData.appraisal.applicable = Number(mediaData.appraisal.applicable);
//       if (mediaData.appraisal.type)
//         mediaData.appraisal.type = Number(mediaData.appraisal.type);
//       if (mediaData.appraisal.percentage)
//         mediaData.appraisal.percentage = Number(mediaData.appraisal.percentage);
//       if (mediaData.appraisal.fixedAmount)
//         mediaData.appraisal.fixedAmount = Number(mediaData.appraisal.fixedAmount);
//       if (mediaData.appraisal.frequency)
//         mediaData.appraisal.frequency = Number(mediaData.appraisal.frequency);
//       if (mediaData.appraisal.customFrequencyMonths)
//         mediaData.appraisal.customFrequencyMonths = Number(
//           mediaData.appraisal.customFrequencyMonths
//         );
//       if (mediaData.appraisal.nextAppraisalDate)
//         mediaData.appraisal.nextAppraisalDate = new Date(
//           mediaData.appraisal.nextAppraisalDate
//         );
//     }
 
//     // ── Convert other numeric fields ──────────────────────────
//     if (mediaData.width) mediaData.width = Number(mediaData.width);
//     if (mediaData.height) mediaData.height = Number(mediaData.height);
//     if (mediaData.status) mediaData.status = Number(mediaData.status);
//     if (mediaData.numberOfLandOwners)
//       mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);
 
//     // ── VALIDATION: GST ───────────────────────────────────────
//     if (mediaData.rentalPayment) {
//       const gstCheck = validateGst(mediaData.rentalPayment);
//       if (!gstCheck.valid) return errorResponse(res, gstCheck.message, null, 400);
//     }
 
//     // ── VALIDATION: Land owner shares ─────────────────────────
//     if (mediaData.landOwners?.length && mediaData.rentalPayment?.totalRentalAmount) {
//       const tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable) || 0;
//       const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
//       const tdsPercentage =
//         tdsApplicable === 1
//           ? envTdsPercent > 0
//             ? envTdsPercent
//             : Number(mediaData.rentalPayment.tdsPercentage || 0)
//           : 0;
//       const rentalGstApplicable = Number(mediaData.rentalPayment.gstApplicable) || 0;
 
//       const shareCheck = validateLandOwnerShares(
//         mediaData.landOwners,
//         Number(mediaData.rentalPayment.totalRentalAmount),
//         tdsApplicable,
//         tdsPercentage,
//         rentalGstApplicable
//       );
//       if (!shareCheck.valid) return errorResponse(res, shareCheck.message, null, 400);
 
//       const pmCatCheck = validateOwnerPaymentCategories(
//         mediaData.landOwners,
//         shareCheck.netPayable,
//         rentalGstApplicable
//       );
//       if (!pmCatCheck.valid) return errorResponse(res, pmCatCheck.message, null, 400);
//     }
 
//     // ── VALIDATION: Appraisal frequency ──────────────────────
//     if (mediaData.appraisal && mediaData.agreement) {
//       const appraisalCheck = validateAppraisalFrequency(
//         mediaData.agreement,
//         mediaData.appraisal
//       );
//       if (!appraisalCheck.valid)
//         return errorResponse(res, appraisalCheck.message, null, 400);
//     }
 
//     // ── File Uploads ──────────────────────────────────────────
//     const uploadedAgreementPDF = req.files?.agreementPDF?.[0];
//     if (uploadedAgreementPDF) {
//       if (!mediaData.agreement) mediaData.agreement = {};
//       mediaData.agreement.agreementPDF = req.processFile(uploadedAgreementPDF);
//     }
//     if (req.files?.frontView?.[0])
//       mediaData.frontView = req.processFile(req.files.frontView[0]);
//     if (req.files?.sideView?.[0])
//       mediaData.sideView = req.processFile(req.files.sideView[0]);
//     if (req.files?.locationView?.[0])
//       mediaData.locationView = req.processFile(req.files.locationView[0]);
//     if (req.files?.additionalImages?.[0])
//       mediaData.additionalImages = req.processFile(req.files.additionalImages[0]);
 
//     // ── Create or Update ──────────────────────────────────────
//     let media;
//     let isNew = false;
 
//     if (id) {
//       // ── UPDATE ──────────────────────────────────────────────
//       media = await MediaOnboarding.findById(id);
//       if (!media) return errorResponse(res, "Media not found with this ID", null, 404);
 
//       delete mediaData.id;
 
//       await handleAppraisalLogic(mediaData, media, userName);
 
//       // Date-based summary: only cycles whose date has passed count toward
//       // currentRent/lastAppraisalDate; soonest future cycle is the pending next.
//       if (Number(mediaData.appraisal?.applicable) === 1) {
//         recomputeAppraisalSummary(
//           mediaData.appraisal,
//           Number(mediaData.rentalPayment?.totalRentalAmount || 0)
//         );
//       }
 
//       handleAgreementHistory(mediaData, media);
 
//       Object.keys(mediaData).forEach((key) => {
//         if (!["_id", "__v", "createdAt", "mediaId"].includes(key)) {
//           media[key] = mediaData[key];
//         }
//       });
 
//       await media.save();
//       media = await MediaOnboarding.findById(media._id).lean();
//     } else {
//       // ── CREATE ──────────────────────────────────────────────
//       await handleAppraisalLogic(mediaData, null, userName);
 
//       // Date-based summary: on create, if nextAppraisalDate is in the future
//       // (which it normally is), currentRent stays at base and lastAppraisalDate
//       // stays null until that date actually arrives.
//       if (Number(mediaData.appraisal?.applicable) === 1) {
//         recomputeAppraisalSummary(
//           mediaData.appraisal,
//           Number(mediaData.rentalPayment?.totalRentalAmount || 0)
//         );
//       }
 
//       handleAgreementHistory(mediaData, null);
 
//       media = new MediaOnboarding(mediaData);
//       await media.save();
//       media = await MediaOnboarding.findById(media._id).lean();
//       isNew = true;
//     }
 
//     const message = isNew
//       ? "Media created successfully"
//       : "Media updated successfully";
//     return successResponse(res, message, media, isNew ? 201 : 200);
//   } catch (error) {
//     return errorResponse(res, error.message, null, 400);
//   }
// };






const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const path = require("path");
const XLSX = require("xlsx");
 
// ─────────────────────────────────────────────────────────────
// PROCESS FILES HELPER
// ─────────────────────────────────────────────────────────────
const processUploadedFile = (uploadedFile) => {
  if (uploadedFile) {
    const { getFileUrl } = require("../../../middleware/dynamicFileUpload");
 
    let fileType = "other";
    if (uploadedFile.mimetype.startsWith("image/")) {
      fileType = "image";
    } else if (uploadedFile.mimetype === "application/pdf") {
      fileType = "pdf";
    }
 
    return {
      originalName: uploadedFile.originalname,
      fileName: uploadedFile.filename || uploadedFile.key?.split("/").pop(),
      filePath: getFileUrl(uploadedFile),
      mimeType: uploadedFile.mimetype,
      size: uploadedFile.size,
      fileType,
      uploadedAt: new Date(),
    };
  }
  return null;
};
 
// ─────────────────────────────────────────────────────────────
// IST DATE HELPER
// ─────────────────────────────────────────────────────────────
const getISTDate = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset);
};
 
// ─────────────────────────────────────────────────────────────
// VALIDATE OWNER PAYMENT CATEGORIES
// ─────────────────────────────────────────────────────────────
const validateOwnerPaymentCategories = (
  landOwners,
  netPayable,
  rentalGstApplicable
) => {
  for (const owner of landOwners) {
    const cat = Number(owner.paymentCategory);
    const ownerGstApplicable = Number(owner.gstApplicable || 0);
 
    if (rentalGstApplicable === 1) {
      if (cat !== 2) {
        return {
          valid: false,
          message: `Owner "${owner.name}": When rental GST is applicable, paymentCategory must be 2 (Online) only.`,
        };
      }
    } else {
      if (cat === 1 && ownerGstApplicable === 1) {
        return {
          valid: false,
          message: `Owner "${owner.name}": gstApplicable cannot be 1 when paymentCategory is 1 (Cash only).`,
        };
      }
 
      if (cat === 2 || cat === 3) {
        const onlineMode = Number(owner.onlineMode);
        if (![1, 2, 3].includes(onlineMode)) {
          return {
            valid: false,
            message: `Owner "${owner.name}": onlineMode is required and must be 1 (Bank Transfer), 2 (UPI), or 3 (Cheque)`,
          };
        }
      }
 
      if (cat === 3) {
        const cashAmt = Number(owner.cashAmount) || 0;
        const onlineAmt = Number(owner.onlineAmount) || 0;
 
        if (cashAmt < 0 || onlineAmt < 0) {
          return {
            valid: false,
            message: `Owner "${owner.name}": cashAmount and onlineAmount must be >= 0`,
          };
        }
 
        let ownerShare = 0;
        if (Number(owner.typeShare) === 1) {
          ownerShare = parseFloat(
            ((netPayable * (Number(owner.sharePercentage) || 0)) / 100).toFixed(2)
          );
        } else {
          ownerShare = parseFloat((Number(owner.shareAmount) || 0).toFixed(2));
        }
 
        const splitTotal = parseFloat((cashAmt + onlineAmt).toFixed(2));
        if (Math.abs(splitTotal - ownerShare) > 0.01) {
          return {
            valid: false,
            message: `Owner "${owner.name}": cashAmount (${cashAmt}) + onlineAmount (${onlineAmt}) = ${splitTotal} does not match owner share amount ${ownerShare}.`,
          };
        }
 
        if (ownerGstApplicable === 1 && onlineAmt <= 0) {
          return {
            valid: false,
            message: `Owner "${owner.name}": gstApplicable is 1 but onlineAmount is 0.`,
          };
        }
      }
    }
 
    if (![1, 2, 3].includes(cat)) {
      return {
        valid: false,
        message: `Owner "${owner.name}": paymentCategory must be 1 (Cash), 2 (Online), or 3 (Cash+Online)`,
      };
    }
  }
 
  return { valid: true };
};
 
// ─────────────────────────────────────────────────────────────
// VALIDATE LAND OWNER SHARES
// ─────────────────────────────────────────────────────────────
const validateLandOwnerShares = (
  landOwners,
  totalRentalAmount,
  tdsApplicable,
  tdsPercentage,
  gstApplicable
) => {
  const tdsAmount =
    tdsApplicable === 1 && tdsPercentage > 0
      ? parseFloat(((totalRentalAmount * tdsPercentage) / 100).toFixed(2))
      : 0;
 
  const amountAfterTds = parseFloat((totalRentalAmount - tdsAmount).toFixed(2));
 
  let gstAmount = 0;
  let totalWithGst = amountAfterTds;
 
  if (gstApplicable === 1) {
    const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
    gstAmount = parseFloat(((totalRentalAmount * envGstPct) / 100).toFixed(2));
    totalWithGst = parseFloat((amountAfterTds + gstAmount).toFixed(2));
  }
 
  const netPayable = parseFloat(totalWithGst.toFixed(2));
 
  if (!landOwners || !landOwners.length) {
    return { valid: false, message: "At least one land owner is required" };
  }
 
  let totalComputedAmount = 0;
  let hasPercentageShare = false;
  let hasFixedShare = false;
 
  for (const owner of landOwners) {
    const typeShare = Number(owner.typeShare);
 
    if (!typeShare || (typeShare !== 1 && typeShare !== 2)) {
      return {
        valid: false,
        message: `Owner "${owner.name || "Unknown"}": typeShare must be 1 (percentage) or 2 (fixed amount).`,
      };
    }
 
    if (typeShare === 1) {
      hasPercentageShare = true;
      const sharePercentage = Number(owner.sharePercentage);
 
      if (isNaN(sharePercentage) || sharePercentage < 0 || sharePercentage > 100) {
        return {
          valid: false,
          message: `Owner "${owner.name || "Unknown"}": sharePercentage must be between 0 and 100.`,
        };
      }
 
      totalComputedAmount += parseFloat(
        ((netPayable * sharePercentage) / 100).toFixed(2)
      );
    } else if (typeShare === 2) {
      hasFixedShare = true;
      const shareAmount = Number(owner.shareAmount);
 
      if (isNaN(shareAmount) || shareAmount < 0) {
        return {
          valid: false,
          message: `Owner "${owner.name || "Unknown"}": shareAmount must be >= 0.`,
        };
      }
 
      totalComputedAmount += parseFloat(shareAmount.toFixed(2));
    }
  }
 
  if (hasPercentageShare && !hasFixedShare) {
    let percentageSum = 0;
    for (const owner of landOwners) {
      if (Number(owner.typeShare) === 1) {
        percentageSum += Number(owner.sharePercentage || 0);
      }
    }
 
    if (Math.abs(percentageSum - 100) > 0.01) {
      return {
        valid: false,
        message: `Total percentage shares (${percentageSum.toFixed(2)}%) must equal 100%.`,
      };
    }
  }
 
  const diff = Math.abs(totalComputedAmount - netPayable);
 
  if (diff > 1) {
    return {
      valid: false,
      message: `Total owner share (${totalComputedAmount.toFixed(2)}) does not match net payable amount (${netPayable.toFixed(2)}). Difference: ${diff.toFixed(2)}`,
    };
  }
 
  return {
    valid: true,
    netPayable,
    tdsAmount,
    amountAfterTds,
    gstAmount,
    totalComputedAmount,
  };
};
 
// ─────────────────────────────────────────────────────────────
// VALIDATE GST
// ─────────────────────────────────────────────────────────────
const validateGst = (rentalPayment) => {
  const gstApplicable = Number(rentalPayment?.gstApplicable) || 0;
 
  if (gstApplicable === 1) {
    if (!rentalPayment?.gstNumber || !rentalPayment.gstNumber.trim()) {
      return {
        valid: false,
        message: "rentalPayment.gstNumber is required when gstApplicable is 1",
      };
    }
  }
 
  return { valid: true };
};
 
// ─────────────────────────────────────────────────────────────
// COMPUTE AGREEMENT STATUS HELPER
// ─────────────────────────────────────────────────────────────
const computeAgreementStatus = (startDate, endDate, reminderDays) => {
  if (!startDate || !endDate) return 1;
  const now = new Date();
  const end = new Date(endDate);
  const daysUntilExpiry = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
 
  if (daysUntilExpiry < 0) return 3;
  if (daysUntilExpiry <= reminderDays) return 2;
  return 1;
};
 
const handleAgreementHistory = (mediaData, existingMedia) => {
  const agreement = mediaData.agreement;
 
  if (!agreement) return mediaData;
 
  const existingHistory = existingMedia
    ? (existingMedia.agreementHistory || []).map((h) =>
        h.toObject ? h.toObject() : { ...h }
      )
    : [];
 
  const status = computeAgreementStatus(
    agreement.startDate,
    agreement.endDate,
    agreement.reminderBeforeExpiry
  );
 
  const snapshot = {
    startDate: agreement.startDate ? new Date(agreement.startDate) : undefined,
    endDate: agreement.endDate ? new Date(agreement.endDate) : undefined,
    reminderBeforeExpiry: agreement.reminderBeforeExpiry,
    advanceRent: agreement.advanceRent || 0,
    status,
    agreementPDF: agreement.agreementPDF
      ? { ...agreement.agreementPDF }
      : undefined,
    uploadedAt: getISTDate(),
  };
 
  if (!existingMedia) {
    existingHistory.push(snapshot);
    mediaData.agreementHistory = existingHistory;
    return mediaData;
  }
 
  const oldStart = existingMedia.agreement?.startDate
    ? new Date(existingMedia.agreement.startDate).getTime()
    : null;
 
  const oldEnd = existingMedia.agreement?.endDate
    ? new Date(existingMedia.agreement.endDate).getTime()
    : null;
 
  const newStart = agreement.startDate
    ? new Date(agreement.startDate).getTime()
    : null;
 
  const newEnd = agreement.endDate
    ? new Date(agreement.endDate).getTime()
    : null;
 
  const agreementDatesChanged = oldStart !== newStart || oldEnd !== newEnd;
 
  if (agreementDatesChanged) {
    if (existingMedia.agreement) {
      const oldStatus = computeAgreementStatus(
        existingMedia.agreement.startDate,
        existingMedia.agreement.endDate,
        existingMedia.agreement.reminderBeforeExpiry || 30
      );
 
      const isDuplicate = existingHistory.some(
        (h) =>
          new Date(h.startDate).getTime() ===
            new Date(existingMedia.agreement.startDate).getTime() &&
          new Date(h.endDate).getTime() ===
            new Date(existingMedia.agreement.endDate).getTime() &&
          h.advanceRent === (existingMedia.agreement.advanceRent || 0)
      );
 
      if (!isDuplicate) {
        existingHistory.push({
          startDate: new Date(existingMedia.agreement.startDate),
          endDate: new Date(existingMedia.agreement.endDate),
          reminderBeforeExpiry: existingMedia.agreement.reminderBeforeExpiry,
          advanceRent: existingMedia.agreement.advanceRent || 0,
          status: oldStatus,
          agreementPDF: existingMedia.agreement.agreementPDF
            ? { ...existingMedia.agreement.agreementPDF }
            : undefined,
          uploadedAt: getISTDate(),
        });
      }
    }
 
    mediaData.agreement = snapshot;
  } else {
    if (existingHistory.length > 0) {
      const lastIndex = existingHistory.length - 1;
 
      existingHistory[lastIndex] = {
        ...existingHistory[lastIndex],
        reminderBeforeExpiry: agreement.reminderBeforeExpiry,
        advanceRent: agreement.advanceRent || 0,
        status,
        agreementPDF: agreement.agreementPDF
          ? { ...agreement.agreementPDF }
          : existingHistory[lastIndex].agreementPDF,
        uploadedAt: getISTDate(),
      };
    } else {
      existingHistory.push(snapshot);
    }
  }
 
  mediaData.agreementHistory = existingHistory;
 
  return mediaData;
};
 
// ─────────────────────────────────────────────────────────────
// VALIDATE APPRAISAL FREQUENCY
// ─────────────────────────────────────────────────────────────
const APPRAISAL_FREQUENCY_MONTHS = { 1: 6, 2: 12, 3: 24 };
const APPRAISAL_FREQUENCY_LABEL = {
  1: "6 Months",
  2: "Yearly (12 Months)",
  3: "2 Years (24 Months)",
  4: "Custom",
};
 
const validateAppraisalFrequency = (agreement, appraisal) => {
  if (Number(appraisal?.applicable) !== 1) return { valid: true };
 
  const startDate = agreement?.startDate ? new Date(agreement.startDate) : null;
  const endDate = agreement?.endDate ? new Date(agreement.endDate) : null;
  const frequency = Number(appraisal?.frequency);
 
  if (!startDate || !endDate) {
    return {
      valid: false,
      message:
        "agreement.startDate and agreement.endDate are required when appraisal.applicable is 1",
    };
  }
 
  if (![1, 2, 3, 4].includes(frequency)) {
    return {
      valid: false,
      message:
        "appraisal.frequency must be 1 (6 Months), 2 (Yearly), 3 (2 Years), or 4 (Custom)",
    };
  }
 
  let months;
  if (frequency === 4) {
    months = Number(appraisal?.customFrequencyMonths);
    if (!months || months < 1 || !Number.isInteger(months)) {
      return {
        valid: false,
        message:
          "appraisal.customFrequencyMonths is required and must be a positive integer when frequency is 4 (Custom)",
      };
    }
  } else {
    months = APPRAISAL_FREQUENCY_MONTHS[frequency];
  }
 
  const candidateDate = new Date(startDate);
  candidateDate.setMonth(candidateDate.getMonth() + months);
 
  if (candidateDate >= endDate) {
    const label = APPRAISAL_FREQUENCY_LABEL[frequency];
    const freqDisplay = frequency === 4 ? `Custom (${months} months)` : label;
    return {
      valid: false,
      message: `Appraisal frequency "${freqDisplay}" is not applicable. The next appraisal (${candidateDate.toLocaleDateString(
        "en-GB"
      )}) would fall on or after the agreement end date (${endDate.toLocaleDateString(
        "en-GB"
      )}).`,
    };
  }
 
  return { valid: true };
};
 
// ─────────────────────────────────────────────────────────────
// HANDLE APPRAISAL LOGIC
// ─────────────────────────────────────────────────────────────
const APPRAISAL_FREQUENCY_MONTHS_MAP = { 1: 6, 2: 12, 3: 24 };
 
const handleAppraisalLogic = async (mediaData, existingMedia, userName) => {
  const appraisal = mediaData.appraisal;
  const agreement = mediaData.agreement || existingMedia?.agreement;
 
  if (!appraisal || Number(appraisal.applicable) !== 1) return mediaData;
  if (!agreement?.startDate || !agreement?.endDate) return mediaData;
 
  const agreementStartDate = new Date(agreement.startDate);
  const agreementEndDate = new Date(agreement.endDate);

  // ── Normalize today to midnight IST ──────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (appraisal.nextAppraisalDate) {
    const nextDate = new Date(appraisal.nextAppraisalDate);
    nextDate.setHours(0, 0, 0, 0);

    if (nextDate > agreementEndDate) {
      throw new Error("Next appraisal date cannot be greater than agreement end date");
    }

    // ── FIX 1: In UPDATE flow, block if nextAppraisalDate is strictly past ──
    // if (existingMedia) {
    //   if (nextDate < today) {
    //     throw new Error(
    //       `Next appraisal date (${nextDate.toLocaleDateString("en-GB")}) is a past date and cannot be updated.`
    //     );
    //   }
    // }
    // ── FIX 1: In UPDATE flow, block ONLY if the user is changing the date
// to a past date. If they're just updating type/amount and the existing
// nextAppraisalDate happens to be past, we allow it (handled separately).
if (existingMedia) {
  const oldNextRaw =
    existingMedia.appraisal?.nextAppraisalDate ||
    (existingMedia.appraisal?.history?.length
      ? existingMedia.appraisal.history[existingMedia.appraisal.history.length - 1]?.appraisalDate
      : null);

  const oldNextNormalized = oldNextRaw
    ? new Date(new Date(oldNextRaw).setHours(0, 0, 0, 0))
    : null;

  const isDateBeingChanged =
    !oldNextNormalized || oldNextNormalized.getTime() !== nextDate.getTime();

  if (isDateBeingChanged && nextDate < today) {
    throw new Error(
      `Next appraisal date (${nextDate.toLocaleDateString("en-GB")}) is a past date and cannot be updated.`
    );
  }
}
  }

  let months = 0;
  if (Number(appraisal.frequency) === 4) {
    months = Number(appraisal.customFrequencyMonths || 0);
    if (months <= 0) throw new Error("Custom frequency months must be greater than 0");
  } else {
    months = APPRAISAL_FREQUENCY_MONTHS_MAP[Number(appraisal.frequency)] || 12;
  }
 
  if (!Array.isArray(appraisal.history)) appraisal.history = [];
 
  const netPayable = Number(mediaData.rentalPayment?.totalRentalAmount || 0);
  const isNew = !existingMedia;
 
  // ── CREATE flow ───────────────────────────────────────────────────────
  if (isNew) {
    appraisal.currentRent = netPayable;
 
    if (!appraisal.nextAppraisalDate) {
      const firstDate = new Date(agreementStartDate);
      firstDate.setMonth(firstDate.getMonth() + months);
      if (firstDate <= agreementEndDate) appraisal.nextAppraisalDate = firstDate;
    }
 
    if (appraisal.nextAppraisalDate) {
      const baseRent = netPayable;
      let initialAppraisalAmount = 0;
 
      if (Number(appraisal.type) === 1) {
        initialAppraisalAmount = (baseRent * Number(appraisal.percentage || 0)) / 100;
      } else if (Number(appraisal.type) === 2) {
        initialAppraisalAmount = Number(appraisal.fixedAmount || 0);
      }
      initialAppraisalAmount = Math.round(initialAppraisalAmount);
 
      const newRent = Math.round(baseRent + initialAppraisalAmount);
 
      const dateExists = appraisal.history.some(
        (item) =>
          item.appraisalDate &&
          new Date(item.appraisalDate).getTime() ===
            new Date(appraisal.nextAppraisalDate).getTime()
      );
 
      if (!dateExists) {
        appraisal.history.push({
          appraisalDate: new Date(appraisal.nextAppraisalDate),
          type: appraisal.type,
          percentage: appraisal.percentage || 0,
          fixedAmount: appraisal.fixedAmount || 0,
          previousRent: baseRent,
          appraisalAmount: initialAppraisalAmount,
          newRent,
          updatedBy: userName,
          updatedAt: getISTDate(),
        });
      }
 
      appraisal.appraisalAmount = initialAppraisalAmount;
      appraisal.totalAppraisalAmount = Math.round(baseRent + initialAppraisalAmount);
    }
 
    mediaData.appraisal = appraisal;
    return mediaData;
  }
 
  // ── UPDATE flow ───────────────────────────────────────────────────────
  const oldAppraisal = existingMedia.appraisal
    ? JSON.parse(JSON.stringify(existingMedia.appraisal))
    : {};
 
  if (!Array.isArray(oldAppraisal.history)) oldAppraisal.history = [];
 
  appraisal.history =
    oldAppraisal.history.length > 0
      ? oldAppraisal.history.map((h) => ({ ...h }))
      : [];
 
  appraisal.currentRent =
    oldAppraisal.currentRent && oldAppraisal.currentRent > 0
      ? oldAppraisal.currentRent
      : netPayable;
 
  if (oldAppraisal.lastAppraisalDate) {
    appraisal.lastAppraisalDate = oldAppraisal.lastAppraisalDate;
  }
 
  let fixedAmountChanged = false;
  let percentageChanged = false;
  let nextDateChanged = false;
  let typeChanged = false;
 
  if (Number(appraisal.type) !== Number(oldAppraisal.type)) {
    typeChanged = true;
  }
 
  if (Number(appraisal.type) === 2) {
    const oldFixed = Number(oldAppraisal.fixedAmount || 0);
    const newFixed = Number(appraisal.fixedAmount || 0);
    if (oldFixed !== newFixed) fixedAmountChanged = true;
  }
 
  if (Number(appraisal.type) === 1) {
    const oldPct = Number(oldAppraisal.percentage || 0);
    const newPct = Number(appraisal.percentage || 0);
    if (oldPct !== newPct) percentageChanged = true;
  }
 
  const lastOldHistEntry =
    oldAppraisal.history && oldAppraisal.history.length
      ? oldAppraisal.history[oldAppraisal.history.length - 1]
      : null;
 
  const oldScheduledRaw =
    oldAppraisal.nextAppraisalDate || lastOldHistEntry?.appraisalDate || null;
 
  // if (oldScheduledRaw && appraisal.nextAppraisalDate) {
  //   const oldNextDate = new Date(oldScheduledRaw);
  //   oldNextDate.setHours(0, 0, 0, 0);
  //   const newNextDate = new Date(appraisal.nextAppraisalDate);
  //   newNextDate.setHours(0, 0, 0, 0);
  //   if (oldNextDate.getTime() !== newNextDate.getTime()) nextDateChanged = true;
  // }
 if (appraisal.nextAppraisalDate) {
  // Always compare against the LAST history entry's date (normalized to midnight),
  // not the stored nextAppraisalDate which can be stale/have wrong time offsets.
  const lastHistDate = lastOldHistEntry?.appraisalDate
    ? new Date(new Date(lastOldHistEntry.appraisalDate).setHours(0, 0, 0, 0))
    : null;

  const newNextDate = new Date(new Date(appraisal.nextAppraisalDate).setHours(0, 0, 0, 0));

  if (lastHistDate) {
    // Date changed only if it differs from the last history entry's date
    if (lastHistDate.getTime() !== newNextDate.getTime()) nextDateChanged = true;
  } else if (oldScheduledRaw) {
    const oldNextDate = new Date(new Date(oldScheduledRaw).setHours(0, 0, 0, 0));
    if (oldNextDate.getTime() !== newNextDate.getTime()) nextDateChanged = true;
  }
}
  // ── Type / fixed amount / percentage changed, date unchanged ──────────
  // if ((fixedAmountChanged || typeChanged || percentageChanged) && !nextDateChanged) {
  //   if (appraisal.history.length > 0) {
  //     const lastIndex = appraisal.history.length - 1;
  //     const lastEntry = appraisal.history[lastIndex];

  //     // ── FIX 1 (reinforced): Block if the history entry being edited is past ──
  //     // This guards the case where nextAppraisalDate was not sent in request
  //     // but the existing last history entry is already past.
  //     const entryDate = new Date(lastEntry.appraisalDate);
  //     entryDate.setHours(0, 0, 0, 0);

  //     if (entryDate < today) {
  //       throw new Error(
  //         `Appraisal date (${entryDate.toLocaleDateString("en-GB")}) is a past date and cannot be updated.`
  //       );
  //     }

  //     // ── FIX 2: Today or future — allow type/amount changes ────────────
  //     const previousRent = Number(lastEntry.previousRent || 0);

  //     let newAppraisalAmount = 0;
  //     if (Number(appraisal.type) === 1) {
  //       newAppraisalAmount = Math.round(
  //         (previousRent * Number(appraisal.percentage || 0)) / 100
  //       );
  //     } else if (Number(appraisal.type) === 2) {
  //       newAppraisalAmount = Number(appraisal.fixedAmount || 0);
  //     }

  //     const newRent = Math.round(previousRent + newAppraisalAmount);

  //     appraisal.history[lastIndex] = {
  //       ...lastEntry,
  //       type: appraisal.type,
  //       percentage: appraisal.percentage || 0,
  //       fixedAmount: Number(appraisal.fixedAmount || 0),
  //       appraisalAmount: newAppraisalAmount,
  //       newRent,
  //       updatedBy: userName,
  //       updatedAt: getISTDate(),
  //     };

  //     // currentRent stays at previousRent when entry is today or future
  //     // (not yet applied — will apply when the date actually arrives)
  //     appraisal.currentRent = previousRent;

  //     appraisal.appraisalAmount = newAppraisalAmount;

  //     if (oldAppraisal.nextAppraisalDate) {
  //       appraisal.nextAppraisalDate = oldAppraisal.nextAppraisalDate;
  //     }

  //     const totalAppraisal = appraisal.history.reduce(
  //       (sum, entry) => sum + Number(entry.appraisalAmount || 0),
  //       0
  //     );
  //     const baseRent = Number(appraisal.history[0]?.previousRent || netPayable);
  //     appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);

  //     mediaData.appraisal = appraisal;
  //     return mediaData;
  //   }
  // }
if (fixedAmountChanged || typeChanged || percentageChanged) {
  // Find the history entry matching the incoming nextAppraisalDate (by day).
  // If found and it is today-or-future, update it in-place.
  // If not found, fall through to nextDateChanged branch to add a new entry.
  const incomingDate = new Date(appraisal.nextAppraisalDate);
  incomingDate.setHours(0, 0, 0, 0);

  const targetIndex = appraisal.history.findIndex((h) => {
    if (!h.appraisalDate) return false;
    const d = new Date(h.appraisalDate);
    d.setHours(0, 0, 0, 0);
    return d.getTime() === incomingDate.getTime();
  });

  if (targetIndex !== -1) {
    const targetEntry = appraisal.history[targetIndex];
    const entryDate = new Date(targetEntry.appraisalDate);
    entryDate.setHours(0, 0, 0, 0);

    // Only allow editing today-or-future entries
    if (entryDate < today) {
      throw new Error(
        `Appraisal date (${entryDate.toLocaleDateString("en-GB")}) is a past date and cannot be updated.`
      );
    }

    const previousRent = Number(targetEntry.previousRent || 0);

    let newAppraisalAmount = 0;
    if (Number(appraisal.type) === 1) {
      newAppraisalAmount = Math.round(
        (previousRent * Number(appraisal.percentage || 0)) / 100
      );
    } else if (Number(appraisal.type) === 2) {
      newAppraisalAmount = Number(appraisal.fixedAmount || 0);
    }

    const newRent = Math.round(previousRent + newAppraisalAmount);

    appraisal.history[targetIndex] = {
      ...targetEntry,
      type: appraisal.type,
      percentage: appraisal.percentage || 0,
      fixedAmount: Number(appraisal.fixedAmount || 0),
      appraisalAmount: newAppraisalAmount,
      newRent,
      updatedBy: userName,
      updatedAt: getISTDate(),
    };

    // currentRent stays at previousRent (entry not yet applied)
    appraisal.currentRent = previousRent;
    appraisal.appraisalAmount = newAppraisalAmount;
    appraisal.nextAppraisalDate = new Date(targetEntry.appraisalDate); // keep original timestamp

    const totalAppraisal = appraisal.history.reduce(
      (sum, entry) => sum + Number(entry.appraisalAmount || 0),
      0
    );
    const baseRent = Number(appraisal.history[0]?.previousRent || netPayable);
    appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);

    mediaData.appraisal = appraisal;
    return mediaData;
  }

  // No matching entry found — fall through to nextDateChanged to add new entry
}
  if (nextDateChanged) {
    const oldNextDate = new Date(oldScheduledRaw);
    const newNextDate = new Date(appraisal.nextAppraisalDate);
    let updatedHistory = oldAppraisal.history.map((h) => ({ ...h }));
 
    const oldNextDateEntryIndex = updatedHistory.findIndex(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).setHours(0,0,0,0) === oldNextDate.setHours(0,0,0,0)
    );
 
    let currentRentValue = 0;
 
    if (oldNextDateEntryIndex !== -1) {
      const oldEntry = updatedHistory[oldNextDateEntryIndex];
      if (oldNextDate < newNextDate) {
        currentRentValue = Number(oldEntry.newRent || 0);
      } else {
        updatedHistory.splice(oldNextDateEntryIndex, 1);
        currentRentValue =
          updatedHistory.length > 0
            ? Number(updatedHistory[updatedHistory.length - 1].newRent || 0)
            : Number(oldAppraisal.currentRent || netPayable);
      }
    } else {
      currentRentValue =
        updatedHistory.length > 0
          ? Number(updatedHistory[updatedHistory.length - 1].newRent || 0)
          : Number(oldAppraisal.currentRent || netPayable);
    }
 
    const newNextDateExists = updatedHistory.some(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).setHours(0,0,0,0) === newNextDate.setHours(0,0,0,0)
    );
 
    if (!newNextDateExists && oldNextDate < newNextDate) {
      let previousRent = currentRentValue;
 
      if (updatedHistory.length > 0) {
        const lastEntry = updatedHistory[updatedHistory.length - 1];
        previousRent = Number(lastEntry.newRent || currentRentValue);
      }
 
      let appraisalAmount = 0;
      if (Number(appraisal.type) === 1) {
        appraisalAmount = (previousRent * Number(appraisal.percentage || 0)) / 100;
      } else if (Number(appraisal.type) === 2) {
        appraisalAmount = Number(appraisal.fixedAmount || 0);
      }
      appraisalAmount = Math.round(appraisalAmount);
 
      const newRent = Math.round(previousRent + appraisalAmount);
 
      updatedHistory.push({
        appraisalDate: newNextDate,
        type: appraisal.type,
        percentage: appraisal.percentage || 0,
        fixedAmount: appraisal.fixedAmount || 0,
        previousRent,
        appraisalAmount,
        newRent,
        updatedBy: userName,
        updatedAt: getISTDate(),
      });
 
      currentRentValue = newRent;
    }
 
    appraisal.history = updatedHistory;
    appraisal.lastAppraisalDate = oldNextDate;
    appraisal.currentRent = currentRentValue;
 
    if (updatedHistory.length > 0) {
      const lastEntry = updatedHistory[updatedHistory.length - 1];
      appraisal.appraisalAmount = Number(lastEntry.appraisalAmount || 0);
 
      const totalAppraisal = updatedHistory.reduce(
        (sum, entry) => sum + Number(entry.appraisalAmount || 0),
        0
      );
      const baseRent = updatedHistory[0]?.previousRent
        ? Number(updatedHistory[0].previousRent)
        : netPayable;
      appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);
    }
 
    mediaData.appraisal = appraisal;
    return mediaData;
  }
 
  // No appraisal-relevant change — keep old values
  mediaData.appraisal = {
    ...appraisal,
    history: oldAppraisal.history,
    currentRent: oldAppraisal.currentRent || appraisal.currentRent,
    lastAppraisalDate:
      oldAppraisal.lastAppraisalDate || appraisal.lastAppraisalDate,
    appraisalAmount: oldAppraisal.appraisalAmount || appraisal.appraisalAmount,
    totalAppraisalAmount:
      oldAppraisal.totalAppraisalAmount || appraisal.totalAppraisalAmount,
    nextAppraisalDate:
      oldAppraisal.nextAppraisalDate || appraisal.nextAppraisalDate,
  };
 
  return mediaData;
};
 

// ─────────────────────────────────────────────────────────────
// RECOMPUTE APPRAISAL SUMMARY
// ─────────────────────────────────────────────────────────────
// FIX 3: Response fields (currentRent, appraisalAmount, totalAppraisalAmount,
// lastAppraisalDate, nextAppraisalDate) are computed purely from the history
// array split by today's date:
//   applied  = appraisalDate strictly BEFORE today  → drives currentRent
//   upcoming = appraisalDate today or later          → drives nextAppraisalDate
//
// This means a future-dated entry's type/amount does NOT bleed into the
// "current" summary fields shown in the response.
// ─────────────────────────────────────────────────────────────
// const recomputeAppraisalSummary = (appraisal, fallbackBaseRent = 0) => {
//   if (
//     !appraisal ||
//     !Array.isArray(appraisal.history) ||
//     !appraisal.history.length
//   ) {
//     return appraisal;
//   }
 
//   const today = new Date();
//   today.setHours(0, 0, 0, 0);
//   const startOfDay = (d) => new Date(d).setHours(0, 0, 0, 0);
 
//   const sorted = appraisal.history
//     .filter((h) => h.appraisalDate)
//     .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));
 
//   if (!sorted.length) return appraisal;
 
//   const baseRent = Number(sorted[0].previousRent ?? fallbackBaseRent ?? 0);
 
//   // strictly before today = applied; today or later = upcoming
//   const applied = sorted.filter(
//     (h) => startOfDay(h.appraisalDate) < today.getTime()
//   );
//   const upcoming = sorted.filter(
//     (h) => startOfDay(h.appraisalDate) >= today.getTime()
//   );
 
//   // ── currentRent + lastAppraisalDate: only from applied cycles ──────────
//   if (applied.length) {
//     const last = applied[applied.length - 1];
//     appraisal.currentRent = Number(last.newRent || baseRent);
//     appraisal.lastAppraisalDate = new Date(last.appraisalDate);
//   } else {
//     appraisal.currentRent = baseRent;
//     appraisal.lastAppraisalDate = null;
//   }
 
//   // ── FIX 3: nextAppraisalDate + pending fields from UPCOMING cycle only ──
//   // The upcoming entry may have a different type/amount than what the applied
//   // cycles used — we show those values as-is for the pending entry, but they
//   // do NOT affect currentRent (which only reflects past applied cycles).
//   if (upcoming.length) {
//     const next = upcoming[0];
//     appraisal.nextAppraisalDate = new Date(next.appraisalDate);
//     // appraisalAmount = the increment that WILL be applied on nextAppraisalDate
//     appraisal.appraisalAmount = Number(next.appraisalAmount || 0);
//     // totalAppraisalAmount = what rent will become after next appraisal
//     appraisal.totalAppraisalAmount = Math.round(
//       Number(appraisal.currentRent || 0) + Number(next.appraisalAmount || 0)
//     );
//   } else {
//     // All cycles applied — no pending next date
//     appraisal.nextAppraisalDate = null;
//     appraisal.appraisalAmount = 0;
//     appraisal.totalAppraisalAmount = Math.round(Number(appraisal.currentRent || 0));
//   }
 
//   return appraisal;
// };
 const recomputeAppraisalSummary = (appraisal, fallbackBaseRent = 0) => {
  if (
    !appraisal ||
    !Array.isArray(appraisal.history) ||
    !appraisal.history.length
  ) {
    return appraisal;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfDay = (d) => new Date(new Date(d).setHours(0, 0, 0, 0)).getTime();

  const sorted = appraisal.history
    .filter((h) => h.appraisalDate)
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  if (!sorted.length) return appraisal;

  const baseRent = Number(sorted[0].previousRent ?? fallbackBaseRent ?? 0);

  const applied  = sorted.filter((h) => startOfDay(h.appraisalDate) < today.getTime());
  const upcoming = sorted.filter((h) => startOfDay(h.appraisalDate) >= today.getTime());

  // ── Fields driven by APPLIED (past) cycles only ──────────────────────
  if (applied.length) {
    const last = applied[applied.length - 1];
    appraisal.currentRent        = Number(last.newRent || baseRent);
    appraisal.lastAppraisalDate  = new Date(last.appraisalDate);

    // type / percentage / fixedAmount reflect the LAST APPLIED cycle
    appraisal.type               = last.type;
    appraisal.percentage         = last.percentage || 0;
    appraisal.fixedAmount        = last.fixedAmount || 0;
  } else {
    appraisal.currentRent        = baseRent;
    appraisal.lastAppraisalDate  = null;

    // No applied cycle yet — keep whatever the user sent (initial values)
  }

  // ── Fields driven by UPCOMING (today or future) cycle ────────────────
  if (upcoming.length) {
    const next = upcoming[0];
    appraisal.nextAppraisalDate      = new Date(next.appraisalDate);
    appraisal.appraisalAmount        = Number(next.appraisalAmount || 0);
    appraisal.totalAppraisalAmount   = Math.round(
      Number(appraisal.currentRent || 0) + Number(next.appraisalAmount || 0)
    );
  } else {
    appraisal.nextAppraisalDate      = null;
    appraisal.appraisalAmount        = 0;
    appraisal.totalAppraisalAmount   = Math.round(Number(appraisal.currentRent || 0));
  }

  return appraisal;
};
// ─────────────────────────────────────────────────────────────
// MEDIA ONBOARDING
// ─────────────────────────────────────────────────────────────
const mediaOnboarding = async (req, res) => {
  try {
    const { id } = req.body;
    const mediaData = req.body;
    const userName = req.user?.userName || "Admin";
 
    // ── Parse JSON strings from FormData ─────────────────────
    const jsonFields = ["landOwners", "rentalPayment", "agreement", "appraisal"];
    jsonFields.forEach((field) => {
      if (mediaData[field] && typeof mediaData[field] === "string") {
        try {
          mediaData[field] = JSON.parse(mediaData[field]);
        } catch {
          // leave as-is if parse fails
        }
      }
    });
 
    // ── Convert rentalPayment numeric values ──────────────────
    if (mediaData.rentalPayment) {
      if (mediaData.rentalPayment.totalRentalAmount !== undefined)
        mediaData.rentalPayment.totalRentalAmount = Number(
          mediaData.rentalPayment.totalRentalAmount
        );
      if (mediaData.rentalPayment.paymentFrequency)
        mediaData.rentalPayment.paymentFrequency = Number(
          mediaData.rentalPayment.paymentFrequency
        );
      if (mediaData.rentalPayment.tdsApplicable !== undefined)
        mediaData.rentalPayment.tdsApplicable = Number(
          mediaData.rentalPayment.tdsApplicable
        );
      if (mediaData.rentalPayment.gstApplicable !== undefined)
        mediaData.rentalPayment.gstApplicable = Number(
          mediaData.rentalPayment.gstApplicable
        );
    }
 
    // ── Convert landOwners ────────────────────────────────────
    if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
      const hasValue = (v) => v !== undefined && v !== null && v !== "";
      mediaData.landOwners = mediaData.landOwners.map((owner) => ({
        ...owner,
        typeShare: hasValue(owner.typeShare) ? Number(owner.typeShare) : undefined,
        sharePercentage: hasValue(owner.sharePercentage)
          ? Number(owner.sharePercentage)
          : undefined,
        shareAmount: hasValue(owner.shareAmount)
          ? Number(owner.shareAmount)
          : undefined,
        paymentCategory: hasValue(owner.paymentCategory)
          ? Number(owner.paymentCategory)
          : undefined,
        onlineMode: hasValue(owner.onlineMode) ? Number(owner.onlineMode) : undefined,
        cashAmount: hasValue(owner.cashAmount) ? Number(owner.cashAmount) : 0,
        onlineAmount: hasValue(owner.onlineAmount) ? Number(owner.onlineAmount) : 0,
        gstApplicable: hasValue(owner.gstApplicable)
          ? Number(owner.gstApplicable)
          : 0,
      }));
    }
 
    // ── Auto-assign single owner full share ───────────────────
    if (mediaData.landOwners?.length === 1) {
      const owner = mediaData.landOwners[0];
      if (!owner.typeShare) {
        owner.typeShare = 1;
        owner.sharePercentage = 100;
      }
    }
 
    // ── Convert agreement ─────────────────────────────────────
    if (mediaData.agreement) {
      if (mediaData.agreement.startDate)
        mediaData.agreement.startDate = new Date(mediaData.agreement.startDate);
      if (mediaData.agreement.endDate)
        mediaData.agreement.endDate = new Date(mediaData.agreement.endDate);
      if (mediaData.agreement.reminderBeforeExpiry)
        mediaData.agreement.reminderBeforeExpiry = Number(
          mediaData.agreement.reminderBeforeExpiry
        );
    }
 
    // ── Convert rentalPayment dates ───────────────────────────
    if (mediaData.rentalPayment?.lastBillPaidDate)
      mediaData.rentalPayment.lastBillPaidDate = new Date(
        mediaData.rentalPayment.lastBillPaidDate
      );
 
    // ── Convert appraisal ─────────────────────────────────────
    if (mediaData.appraisal) {
      if (mediaData.appraisal.applicable !== undefined)
        mediaData.appraisal.applicable = Number(mediaData.appraisal.applicable);
      if (mediaData.appraisal.type)
        mediaData.appraisal.type = Number(mediaData.appraisal.type);
      if (mediaData.appraisal.percentage)
        mediaData.appraisal.percentage = Number(mediaData.appraisal.percentage);
      if (mediaData.appraisal.fixedAmount)
        mediaData.appraisal.fixedAmount = Number(mediaData.appraisal.fixedAmount);
      if (mediaData.appraisal.frequency)
        mediaData.appraisal.frequency = Number(mediaData.appraisal.frequency);
      if (mediaData.appraisal.customFrequencyMonths)
        mediaData.appraisal.customFrequencyMonths = Number(
          mediaData.appraisal.customFrequencyMonths
        );
      if (mediaData.appraisal.nextAppraisalDate)
        mediaData.appraisal.nextAppraisalDate = new Date(
          mediaData.appraisal.nextAppraisalDate
        );
    }
 
    // ── Convert other numeric fields ──────────────────────────
    if (mediaData.width) mediaData.width = Number(mediaData.width);
    if (mediaData.height) mediaData.height = Number(mediaData.height);
    if (mediaData.status) mediaData.status = Number(mediaData.status);
    if (mediaData.numberOfLandOwners)
      mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);
 
    // ── VALIDATION: GST ───────────────────────────────────────
    if (mediaData.rentalPayment) {
      const gstCheck = validateGst(mediaData.rentalPayment);
      if (!gstCheck.valid) return errorResponse(res, gstCheck.message, null, 400);
    }
 
    // ── VALIDATION: Land owner shares ─────────────────────────
    if (mediaData.landOwners?.length && mediaData.rentalPayment?.totalRentalAmount) {
      const tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable) || 0;
      const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
      const tdsPercentage =
        tdsApplicable === 1
          ? envTdsPercent > 0
            ? envTdsPercent
            : Number(mediaData.rentalPayment.tdsPercentage || 0)
          : 0;
      const rentalGstApplicable = Number(mediaData.rentalPayment.gstApplicable) || 0;
 
      const shareCheck = validateLandOwnerShares(
        mediaData.landOwners,
        Number(mediaData.rentalPayment.totalRentalAmount),
        tdsApplicable,
        tdsPercentage,
        rentalGstApplicable
      );
      if (!shareCheck.valid) return errorResponse(res, shareCheck.message, null, 400);
 
      const pmCatCheck = validateOwnerPaymentCategories(
        mediaData.landOwners,
        shareCheck.netPayable,
        rentalGstApplicable
      );
      if (!pmCatCheck.valid) return errorResponse(res, pmCatCheck.message, null, 400);
    }
 
    // ── VALIDATION: Appraisal frequency ──────────────────────
    if (mediaData.appraisal && mediaData.agreement) {
      const appraisalCheck = validateAppraisalFrequency(
        mediaData.agreement,
        mediaData.appraisal
      );
      if (!appraisalCheck.valid)
        return errorResponse(res, appraisalCheck.message, null, 400);
    }
 
    // ── File Uploads ──────────────────────────────────────────
    const uploadedAgreementPDF = req.files?.agreementPDF?.[0];
    if (uploadedAgreementPDF) {
      if (!mediaData.agreement) mediaData.agreement = {};
      mediaData.agreement.agreementPDF = req.processFile(uploadedAgreementPDF);
    }
    if (req.files?.frontView?.[0])
      mediaData.frontView = req.processFile(req.files.frontView[0]);
    if (req.files?.sideView?.[0])
      mediaData.sideView = req.processFile(req.files.sideView[0]);
    if (req.files?.locationView?.[0])
      mediaData.locationView = req.processFile(req.files.locationView[0]);
    if (req.files?.additionalImages?.[0])
      mediaData.additionalImages = req.processFile(req.files.additionalImages[0]);
 
    // ── Create or Update ──────────────────────────────────────
    let media;
    let isNew = false;
 
    if (id) {
      // ── UPDATE ──────────────────────────────────────────────
      media = await MediaOnboarding.findById(id);
      if (!media) return errorResponse(res, "Media not found with this ID", null, 404);
 
      delete mediaData.id;
 
      await handleAppraisalLogic(mediaData, media, userName);
 
      if (Number(mediaData.appraisal?.applicable) === 1) {
        recomputeAppraisalSummary(
          mediaData.appraisal,
          Number(mediaData.rentalPayment?.totalRentalAmount || 0)
        );
      }
 
      handleAgreementHistory(mediaData, media);
 
      Object.keys(mediaData).forEach((key) => {
        if (!["_id", "__v", "createdAt", "mediaId"].includes(key)) {
          media[key] = mediaData[key];
        }
      });
 
      await media.save();
      media = await MediaOnboarding.findById(media._id).lean();
    } else {
      // ── CREATE ──────────────────────────────────────────────
      await handleAppraisalLogic(mediaData, null, userName);
 
      if (Number(mediaData.appraisal?.applicable) === 1) {
        recomputeAppraisalSummary(
          mediaData.appraisal,
          Number(mediaData.rentalPayment?.totalRentalAmount || 0)
        );
      }
 
      handleAgreementHistory(mediaData, null);
 
      media = new MediaOnboarding(mediaData);
      await media.save();
      media = await MediaOnboarding.findById(media._id).lean();
      isNew = true;
    }
 
    const message = isNew
      ? "Media created successfully"
      : "Media updated successfully";
    return successResponse(res, message, media, isNew ? 201 : 200);
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};

// Update Agreement
const updateAgreement = async (req, res) => {
 
  try {
    const {id}  = req.body;
    const userName = req.user?.userName || "Admin";

    if (!id) {
      return errorResponse(res, "Media ID is required in request body", null, 400);
    }

    const media = await MediaOnboarding.findById(id);

    if (!media) {
      return errorResponse(res, "Media not found with this ID", null, 404);
    }

    let agreementData = req.body;

    if (agreementData.agreement && typeof agreementData.agreement === "string") {
      try {
        agreementData = JSON.parse(agreementData.agreement);
      } catch (error) {
        return errorResponse(res, "Invalid agreement JSON format", null, 400);
      }
    }

    delete agreementData.id;

    const incoming = agreementData.startDate 
      ? agreementData 
      : agreementData.agreement || {};

    if (!incoming.startDate || !incoming.endDate) {
      return errorResponse(res, "startDate and endDate are required", null, 400);
    }

    // PDF Upload
    const uploadedAgreementPDF = req.files?.agreementPDF?.[0];
    if (uploadedAgreementPDF) {
      incoming.agreementPDF = req.processFile(uploadedAgreementPDF);
    } else if (media.agreement?.agreementPDF) {
      incoming.agreementPDF = media.agreement.agreementPDF.toObject
        ? media.agreement.agreementPDF.toObject()
        : { ...media.agreement.agreementPDF };
    }

    // Build new agreement
    const newAgreement = {
      startDate: new Date(incoming.startDate),
      endDate: new Date(incoming.endDate),
      reminderBeforeExpiry: incoming.reminderBeforeExpiry !== undefined
        ? Number(incoming.reminderBeforeExpiry)
        : media.agreement?.reminderBeforeExpiry || 30,
      advanceRent: incoming.advanceRent !== undefined
        ? Number(incoming.advanceRent)
        : media.agreement?.advanceRent || 0,
      agreementPDF: incoming.agreementPDF,
    };

    // Validation
    if (newAgreement.startDate >= newAgreement.endDate) {
      return errorResponse(res, "Start date must be before end date", null, 400);
    }

    const validReminderValues = [10, 30, 60, 90];
    if (!validReminderValues.includes(newAgreement.reminderBeforeExpiry)) {
      return errorResponse(
        res,
        `reminderBeforeExpiry must be one of: ${validReminderValues.join(", ")}`,
        null,
        400
      );
    }

    // ─────────────────────────────────────────────
    // Check if dates changed
    // ─────────────────────────────────────────────
    const currentAgreement = media.agreement;
    let datesChanged = false;

    if (currentAgreement) {
      const oldStart = new Date(currentAgreement.startDate).getTime();
      const oldEnd = new Date(currentAgreement.endDate).getTime();
      const newStart = newAgreement.startDate.getTime();
      const newEnd = newAgreement.endDate.getTime();
      
      datesChanged = oldStart !== newStart || oldEnd !== newEnd;
    }

    // ─────────────────────────────────────────────
    // Get existing history
    // ─────────────────────────────────────────────
    let existingHistory = (media.agreementHistory || [])
      .map((h) => (h.toObject ? h.toObject() : { ...h }));

    // ─────────────────────────────────────────────
    // Handle history based on whether dates changed
    // ─────────────────────────────────────────────
    if (datesChanged) {
      // DATES CHANGED: Push OLD agreement to history, then add NEW agreement as new entry
      
      // Add OLD agreement to history
      if (currentAgreement) {
        const currentStatus = computeAgreementStatus(
          currentAgreement.startDate,
          currentAgreement.endDate,
          currentAgreement.reminderBeforeExpiry || 30
        );

        const isDuplicate = existingHistory.some(h => 
          new Date(h.startDate).getTime() === new Date(currentAgreement.startDate).getTime() &&
          new Date(h.endDate).getTime() === new Date(currentAgreement.endDate).getTime() &&
          h.advanceRent === (currentAgreement.advanceRent || 0) &&
          h.reminderBeforeExpiry === (currentAgreement.reminderBeforeExpiry || 30)
        );

        if (!isDuplicate) {
          existingHistory.push({
            startDate: new Date(currentAgreement.startDate),
            endDate: new Date(currentAgreement.endDate),
            reminderBeforeExpiry: currentAgreement.reminderBeforeExpiry,
            advanceRent: currentAgreement.advanceRent || 0,
            status: currentStatus,
            agreementPDF: currentAgreement.agreementPDF
              ? {
                  ...(currentAgreement.agreementPDF.toObject
                    ? currentAgreement.agreementPDF.toObject()
                    : currentAgreement.agreementPDF),
                }
              : undefined,
            updatedBy: userName,
            uploadedAt: getISTDate(),
          });
        }
      }

      // Add NEW agreement as new entry in history
      const newStatus = computeAgreementStatus(
        newAgreement.startDate,
        newAgreement.endDate,
        newAgreement.reminderBeforeExpiry
      );

      existingHistory.push({
        startDate: new Date(newAgreement.startDate),
        endDate: new Date(newAgreement.endDate),
        reminderBeforeExpiry: newAgreement.reminderBeforeExpiry,
        advanceRent: newAgreement.advanceRent || 0,
        status: newStatus,
        agreementPDF: newAgreement.agreementPDF
          ? {
              ...(newAgreement.agreementPDF.toObject
                ? newAgreement.agreementPDF.toObject()
                : newAgreement.agreementPDF),
            }
          : undefined,
        updatedBy: userName,
        uploadedAt: getISTDate(),
      });

    } else {
      // DATES NOT CHANGED: Update the latest history entry
      if (existingHistory.length > 0) {
        const lastIndex = existingHistory.length - 1;
        
        // Update the latest entry with new values
        existingHistory[lastIndex] = {
          ...existingHistory[lastIndex],
          reminderBeforeExpiry: newAgreement.reminderBeforeExpiry,
          advanceRent: newAgreement.advanceRent || 0,
          agreementPDF: newAgreement.agreementPDF
            ? {
                ...(newAgreement.agreementPDF.toObject
                  ? newAgreement.agreementPDF.toObject()
                  : newAgreement.agreementPDF),
              }
            : existingHistory[lastIndex].agreementPDF,
          updatedBy: userName,
          uploadedAt: getISTDate(),
        };
      } else {
        // Safety fallback: if no history exists, create one
        const newStatus = computeAgreementStatus(
          newAgreement.startDate,
          newAgreement.endDate,
          newAgreement.reminderBeforeExpiry
        );
        
        existingHistory.push({
          startDate: new Date(newAgreement.startDate),
          endDate: new Date(newAgreement.endDate),
          reminderBeforeExpiry: newAgreement.reminderBeforeExpiry,
          advanceRent: newAgreement.advanceRent || 0,
          status: newStatus,
          agreementPDF: newAgreement.agreementPDF
            ? {
                ...(newAgreement.agreementPDF.toObject
                  ? newAgreement.agreementPDF.toObject()
                  : newAgreement.agreementPDF),
              }
            : undefined,
          updatedBy: userName,
          uploadedAt: getISTDate(),
        });
      }
    }

    // ─────────────────────────────────────────────
    // Update current agreement with new data
    // ─────────────────────────────────────────────
    const status = computeAgreementStatus(
      newAgreement.startDate,
      newAgreement.endDate,
      newAgreement.reminderBeforeExpiry
    );

    media.agreement = {
      ...newAgreement,
      status,
    };
    media.agreementHistory = existingHistory;
    media.updatedAt = getISTDate();

    await media.save();

    const saved = await MediaOnboarding.findById(media._id)
      .select("agreement agreementHistory")
      .lean();

    return successResponse(
      res,
      datesChanged
        ? "Agreement updated successfully and previous agreement moved to history"
        : "Agreement updated successfully",
      saved,
      200
    );
  } catch (error) {
    console.error("Error updating agreement:", error);
    return errorResponse(res, error.message || "Failed to update agreement", null, 500);
  }
};
// Media List
const mediaList = async (req, res) => {
  try {
    const {
      pageNumber = 1,
      count = 10,
      mediaType,
      city,
      status,
      search,
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    // ===============================
    // SEARCH FILTER
    // ===============================

    let searchFilter = {};

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.trim(), "i");
      searchFilter = {
        $or: [
          { mediaId: searchRegex },
          { mediaCode: searchRegex },
          { mediaName: searchRegex },
          { mediaType: searchRegex },
          { state: searchRegex },
          { city: searchRegex },
          { location: searchRegex },
          { fullAddress: searchRegex },

          // Land Owner fields
          { "landOwners.name": searchRegex },
          { "landOwners.phone": searchRegex },
          { "landOwners.panNumber": searchRegex },
          { "landOwners.bankName": searchRegex },
          { "landOwners.accountNumber": searchRegex },
          { "landOwners.ifsc": searchRegex },

          // GST
          { "rentalPayment.gstNumber": searchRegex },
        ],
      };
    }

    // ===============================
    // COMBINED FILTER
    // ===============================

    const filter = {};
    if (city) filter.city = Array.isArray(city) ? { $in: city } : city;
    if (mediaType) {
      filter.mediaType = Array.isArray(mediaType)
        ? { $in: mediaType }
        : mediaType;
    }
    if (status) {
      filter.status = Array.isArray(status) ? { $in: status } : status;
    }

    // Merge search + dropdown filters
    const combinedFilter =
      Object.keys(searchFilter).length > 0
        ? {
            $and: [
              searchFilter,
              ...(Object.keys(filter).length > 0 ? [filter] : []),
            ],
          }
        : filter;

    // ===============================
    // QUERY
    // ===============================

    const totalCount = await MediaOnboarding.countDocuments(combinedFilter);

    const mediaListData = await MediaOnboarding.find(combinedFilter)
      .sort({ createdAt: -1 })
      .skip((pageNumbers - 1) * pageSize)
      .limit(pageSize)
      .lean();

    // ===============================
    // FILTER OPTIONS (always from full collection)
    // ===============================

    const allData = await MediaOnboarding.find(
      {},
      "city mediaType status",
    ).lean();

    const cityFilter = [...new Set(allData.map((item) => item.city))].filter(
      Boolean,
    );
    const mediaTypeFilter = [
      ...new Set(allData.map((item) => item.mediaType)),
    ].filter(Boolean);
    const statusFilter = [
      ...new Set(allData.map((item) => item.status)),
    ].filter(Boolean);

    return successResponse(
      res,
      "Media list fetched successfully",
      {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        cityFilter,
        mediaTypeFilter,
        statusFilter,
        mediaList: mediaListData,
      },
      200,
    );
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};
// Particular Get
const getMediaById = async (req, res) => {
  try {
    const { mediaId } = req.query; // Using query parameter

    // Validate ID
    if (!mediaId) {
      return errorResponse(res, "Media ID is required", null, 400);
    }

    // Find media by ID
    const mediaData = await MediaOnboarding.findById(mediaId).lean();

    // Check if media exists
    if (!mediaData) {
      return errorResponse(res, "Media not found", null, 404);
    }

    // Return success response with media data
    return successResponse(
      res,
      "Media details fetched successfully",
      {
        media: mediaData
      },
      200
    );
  } catch (error) {
    // Handle invalid ObjectId format
    if (error.name === 'CastError' && error.kind === 'ObjectId') {
      return errorResponse(res, "Invalid media ID format", null, 400);
    }
    return errorResponse(res, error.message, null, 400);
  }
};

// Excel Upload
const COLUMN_MAP = {
  State: "state",
  City: "city",
  "Media Name": "mediaType", // e.g. Hoarding, Unipole, Wall Graphics
  "Media Code": "mediaCode",
  " Full address": "fullAddress",
  "Full address": "fullAddress",
  Width: "width",
  Hight: "height", // note: typo in Excel kept as-is
  Height: "height",
};
const uploadExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded." });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (!rows.length) {
      return res
        .status(400)
        .json({ success: false, message: "Excel sheet is empty." });
    }

    const results = { inserted: 0, skipped: 0, errors: [] };
    const bulkOps = [];

    // ── Generate starting mediaId counter ONCE before the loop ──
    const today = new Date();
    const prefix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

    const lastMedia = await MediaOnboarding.findOne({
      mediaId: { $regex: `^${prefix}MED#` },
    })
      .sort({ mediaId: -1 })
      .limit(1);

    let nextNumber = 1;
    if (lastMedia) {
      const match = lastMedia.mediaId.match(/#(\d+)$/);
      if (match) nextNumber = parseInt(match[1]) + 1;
    }
    // ────────────────────────────────────────────────────────────

    for (const [index, row] of rows.entries()) {
      const excelRow = index + 2;

      const mapped = {};
      for (const [excelCol, schemaField] of Object.entries(COLUMN_MAP)) {
        if (row[excelCol] !== undefined && row[excelCol] !== null) {
          mapped[schemaField] = row[excelCol];
        }
      }

      mapped.mediaName = mapped.mediaCode || `Media-${excelRow}`;

      const missing = [];
      if (!mapped.mediaCode) missing.push("Media Code");
      if (!mapped.state) missing.push("State");
      if (!mapped.city) missing.push("City");
      if (!mapped.fullAddress) missing.push("Full address");
      if (!mapped.width) missing.push("Width");
      if (!mapped.height) missing.push("Height (Hight)");
      if (!mapped.mediaType) missing.push("Media Name (type)");

      if (missing.length) {
        results.errors.push({
          row: excelRow,
          reason: `Missing: ${missing.join(", ")}`,
        });
        results.skipped++;
        continue;
      }

      mapped.width = parseFloat(mapped.width);
      mapped.height = parseFloat(mapped.height);
      mapped.totalSqFt = parseFloat((mapped.width * mapped.height).toFixed(2));
      mapped.excelRowNumber = excelRow;

      // ── Assign unique mediaId from in-memory counter ──
      mapped.mediaId = `${prefix}MED#${nextNumber}`;
      nextNumber++; // increment for next row
      // ─────────────────────────────────────────────────

      bulkOps.push({
        updateOne: {
          filter: { mediaCode: mapped.mediaCode },
          update: { $setOnInsert: mapped },
          upsert: true,
        },
      });
    }

    if (bulkOps.length) {
      const bulkResult = await MediaOnboarding.bulkWrite(bulkOps, {
        ordered: false,
      });
      results.inserted = bulkResult.upsertedCount;
      results.skipped += bulkResult.matchedCount;
    }

    return res.status(200).json({
      success: true,
      message: `Upload complete. Inserted: ${results.inserted}, Skipped (duplicate/error): ${results.skipped}`,
      details: results,
    });
  } catch (err) {
    console.error("Excel upload error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
module.exports = { mediaOnboarding, mediaList, uploadExcel,updateAgreement,getMediaById };
