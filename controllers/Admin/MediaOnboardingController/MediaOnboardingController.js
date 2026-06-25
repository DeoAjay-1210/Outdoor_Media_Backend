const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const path = require("path");
const XLSX = require("xlsx");
// At the top of mediaOnboarding controller (or as a util)

// ─────────────────────────────────────────────────────────────
// GENERATE MEDIA ID
// ─────────────────────────────────────────────────────────────
async function generateAdminMediaId() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const prefix = `${year}${month}${day}`;

  const lastMedia = await MediaOnboarding.findOne({
    mediaId: { $regex: `^${prefix}MED#` },
  })
    .sort({ mediaId: -1 })
    .limit(1);

  let nextNumber = 1;

  if (lastMedia) {
    const match = lastMedia.mediaId.match(/#(\d+)$/);
    if (match) {
      nextNumber = parseInt(match[1]) + 1;
    }
  }

  let mediaId = `${prefix}MED#${nextNumber}`;
  let exists = await MediaOnboarding.findOne({ mediaId });

  while (exists) {
    nextNumber++;
    mediaId = `${prefix}MED#${nextNumber}`;
    exists = await MediaOnboarding.findOne({ mediaId });
  }

  return mediaId;
}

// ─────────────────────────────────────────────────────────────
// VALIDATE OWNER PAYMENT CATEGORIES
//
// Rules:
//  • rentalPayment.gstApplicable=1  → every owner MUST be paymentCategory=2 (Online)
//                                     per-owner gstApplicable field is ignored
//  • rentalPayment.gstApplicable=0  → any paymentCategory (1/2/3) allowed per owner
//      - owner.gstApplicable=1 only valid for cat=2 or cat=3 (online involved)
//      - cat=1 (cash only): owner.gstApplicable must be 0 or absent
//      - cat=3 (cash+online): cash+online must still sum to owner's netPayable share
//        (GST is on top and does NOT affect the share-sum validation)
// ─────────────────────────────────────────────────────────────
const validateOwnerPaymentCategories = (
  landOwners,
  netPayable,
  rentalGstApplicable
) => {
  const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");

  for (const owner of landOwners) {
    const cat = Number(owner.paymentCategory);
    const ownerGstApplicable = Number(owner.gstApplicable || 0);

    // ── RULE 1: rental-level GST → only online allowed ────
    if (rentalGstApplicable === 1) {
      if (cat !== 2) {
        return {
          valid: false,
          message: `Owner "${owner.name}": When rental GST is applicable, paymentCategory must be 2 (Online) only. Cash (1) and Cash+Online (3) are not allowed.`,
        };
      }
      // per-owner gstApplicable is irrelevant when rental GST is on
      // no further per-owner GST checks needed
    } else {
      // rentalGstApplicable === 0: per-owner rules apply

      // ── RULE 2: cat=1 (cash) cannot have owner GST ──────
      if (cat === 1 && ownerGstApplicable === 1) {
        return {
          valid: false,
          message: `Owner "${owner.name}": gstApplicable cannot be 1 when paymentCategory is 1 (Cash only). GST is only applicable for Online or Cash+Online payments.`,
        };
      }

      // ── RULE 3: online involved → onlineMode required ───
      if (cat === 2 || cat === 3) {
        const onlineMode = Number(owner.onlineMode);
        if (![1, 2, 3].includes(onlineMode)) {
          return {
            valid: false,
            message: `Owner "${owner.name}": onlineMode is required and must be 1 (Bank Transfer), 2 (UPI), or 3 (Cheque)`,
          };
        }
      }

      // ── RULE 4: cat=3 cash+online split validation ──────
      if (cat === 3) {
        const cashAmt = Number(owner.cashAmount) || 0;
        const onlineAmt = Number(owner.onlineAmount) || 0;

        if (cashAmt < 0 || onlineAmt < 0) {
          return {
            valid: false,
            message: `Owner "${owner.name}": cashAmount and onlineAmount must be >= 0`,
          };
        }

        // Compute this owner's share from netPayable
        let ownerShare = 0;
        if (Number(owner.typeShare) === 1) {
          ownerShare = parseFloat(
            ((netPayable * (Number(owner.sharePercentage) || 0)) / 100).toFixed(2)
          );
        } else {
          ownerShare = parseFloat((Number(owner.shareAmount) || 0).toFixed(2));
        }

        const splitTotal = parseFloat((cashAmt + onlineAmt).toFixed(2));
        const tolerance = 0.01;

        // The cash+online split must equal the owner's BASE share (before GST).
        // GST is added on top of the online portion and does NOT change the
        // required split total.
        if (Math.abs(splitTotal - ownerShare) > tolerance) {
          return {
            valid: false,
            message: `Owner "${owner.name}": cashAmount (${cashAmt}) + onlineAmount (${onlineAmt}) = ${splitTotal} does not match owner share amount ${ownerShare}. Note: GST (if applicable) is added on top of the online portion and is not included in this split.`,
          };
        }

        // ── RULE 5: cat=3 with owner GST → warn about GST on online only ──
        // (informational, not a hard error — just ensure onlineAmt is set)
        if (ownerGstApplicable === 1 && onlineAmt <= 0) {
          return {
            valid: false,
            message: `Owner "${owner.name}": gstApplicable is 1 but onlineAmount is 0. GST applies to the online portion; please provide a valid onlineAmount.`,
          };
        }
      }

      // ── RULE 6: cat=2, owner GST on full amount ──────────
      // No additional split check needed for pure online — the entire
      // shareAmount is the online amount. GST is computed on top by the schema.
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
//
// The share-sum check always uses netPayable as the target total.
// Per-owner GST (when rentalPayment.gstApplicable=0) is ON TOP of
// the owner's share and is NOT included in the netPayable sum check.
// ─────────────────────────────────────────────────────────────
const validateLandOwnerShares = (
  landOwners,
  totalRentalAmount,
  tdsApplicable,
  tdsPercentage,
  gstApplicable
) => {
  // Step 1 — TDS
  const tdsAmount =
    tdsApplicable === 1 && tdsPercentage > 0
      ? parseFloat(((totalRentalAmount * tdsPercentage) / 100).toFixed(2))
      : 0;

  // Step 2 — Amount after TDS
  const amountAfterTds = parseFloat((totalRentalAmount - tdsAmount).toFixed(2));

  // Step 3 — Rental-level GST
  let gstAmount = 0;
  let totalWithGst = amountAfterTds;

  if (gstApplicable === 1) {
    const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
    gstAmount = parseFloat(((totalRentalAmount * envGstPct) / 100).toFixed(2));
    totalWithGst = parseFloat((amountAfterTds + gstAmount).toFixed(2));
  }

  // Step 4 — Net Payable
  const netPayable = parseFloat(totalWithGst.toFixed(2));

  // Step 5 — At least one owner
  if (!landOwners || !landOwners.length) {
    return { valid: false, message: "At least one land owner is required" };
  }

  // Step 6 — Sum owner shares (base amounts only, NOT including per-owner GST)
  let totalComputedAmount = 0;
  let hasPercentageShare = false;
  let hasFixedShare = false;

  for (const owner of landOwners) {
    const typeShare = Number(owner.typeShare);

    if (!typeShare || (typeShare !== 1 && typeShare !== 2)) {
      return {
        valid: false,
        message: `Owner "${owner.name || "Unknown"}": typeShare must be 1 (percentage) or 2 (fixed amount). Current value: ${typeShare}`,
      };
    }

    if (typeShare === 1) {
      hasPercentageShare = true;
      const sharePercentage = Number(owner.sharePercentage);

      if (isNaN(sharePercentage) || sharePercentage < 0 || sharePercentage > 100) {
        return {
          valid: false,
          message: `Owner "${owner.name || "Unknown"}": sharePercentage must be between 0 and 100 when typeShare is 1. Current: ${sharePercentage}`,
        };
      }

      const shareAmount = parseFloat(((netPayable * sharePercentage) / 100).toFixed(2));
      totalComputedAmount += shareAmount;
    } else if (typeShare === 2) {
      hasFixedShare = true;
      const shareAmount = Number(owner.shareAmount);

      if (isNaN(shareAmount) || shareAmount < 0) {
        return {
          valid: false,
          message: `Owner "${owner.name || "Unknown"}": shareAmount must be >= 0 when typeShare is 2. Current: ${shareAmount}`,
        };
      }

      totalComputedAmount += parseFloat(shareAmount.toFixed(2));
    }
  }

  // Step 7 — All percentage shares must sum to 100%
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
        message: `Total percentage shares (${percentageSum.toFixed(2)}%) must equal 100% when all owners use percentage shares`,
      };
    }
  }

  // Step 8 — Total owner shares must equal netPayable (tolerance 1 rupee)
  // Note: per-owner GST is intentionally excluded from this check because
  // it is added ON TOP of the owner's share, not deducted from netPayable.
  const diff = Math.abs(totalComputedAmount - netPayable);

  if (diff > 1) {
    let calculationDetails = `${totalRentalAmount}`;
    if (tdsAmount > 0) {
      calculationDetails += ` - TDS ${tdsAmount} = ${amountAfterTds}`;
    }
    if (gstAmount > 0) {
      calculationDetails += ` + GST ${gstAmount}`;
    }
    calculationDetails += ` = ${netPayable}`;

    return {
      valid: false,
      message: `Total owner share (${totalComputedAmount.toFixed(2)}) does not match net payable amount (${netPayable.toFixed(2)}). Calculation: ${calculationDetails}. Difference: ${diff.toFixed(2)}`,
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
  if (Number(appraisal?.applicable) !== 1) {
    return { valid: true };
  }

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
      message: `Appraisal frequency "${freqDisplay}" is not applicable for this agreement. Agreement runs from ${startDate.toLocaleDateString("en-GB")} to ${endDate.toLocaleDateString("en-GB")}, but the next appraisal (${candidateDate.toLocaleDateString("en-GB")}) would fall on or after the agreement end date. Choose a shorter appraisal frequency or extend the agreement.`,
    };
  }

  return { valid: true };
};

// ─────────────────────────────────────────────────────────────
// PROCESS FILES HELPER
// ─────────────────────────────────────────────────────────────
const processUploadedFile = (uploadedFile, documentData, req) => {
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

  return documentData || null;
};
const APPRAISAL_FREQUENCY_MONTHS_MAP = {
  1: 6,
  2: 12,
  3: 24,
};

const getISTDate = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset);
};

const handleAppraisalLogic = async (mediaData, existingMedia, userName) => {
  const appraisal = mediaData.appraisal;
  const agreement = mediaData.agreement || existingMedia?.agreement;

  if (!appraisal || Number(appraisal.applicable) !== 1) return mediaData;
  if (!agreement?.startDate || !agreement?.endDate) return mediaData;

  const agreementStartDate = new Date(agreement.startDate);
  const agreementEndDate = new Date(agreement.endDate);

  // Validate nextAppraisalDate
  if (appraisal.nextAppraisalDate) {
    const nextDate = new Date(appraisal.nextAppraisalDate);
    if (nextDate > agreementEndDate) {
      throw new Error("Next appraisal date cannot be greater than agreement end date");
    }
  }

  // Resolve frequency months
  let months = 0;
  if (Number(appraisal.frequency) === 4) {
    months = Number(appraisal.customFrequencyMonths || 0);
    if (months <= 0) {
      throw new Error("Custom frequency months must be greater than 0");
    }
  } else {
    months = APPRAISAL_FREQUENCY_MONTHS_MAP[Number(appraisal.frequency)] || 12;
  }

  if (!Array.isArray(appraisal.history)) {
    appraisal.history = [];
  }

  const netPayable = Number(mediaData.rentalPayment?.totalRentalAmount || 0);
  const isNew = !existingMedia;

  // ── CREATE flow ──────────────────────────────────────────────────────────────
  if (isNew) {
    appraisal.currentRent = netPayable;

    // Auto-set nextAppraisalDate if not provided
    if (!appraisal.nextAppraisalDate) {
      const firstDate = new Date(agreementStartDate);
      firstDate.setMonth(firstDate.getMonth() + months);
      if (firstDate <= agreementEndDate) {
        appraisal.nextAppraisalDate = firstDate;
      }
    }

    if (appraisal.nextAppraisalDate) {
      const baseRent = netPayable;

      let initialAppraisalAmount = 0;
      if (Number(appraisal.type) === 1) {
        initialAppraisalAmount =
          (baseRent * Number(appraisal.percentage || 0)) / 100;
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
          previousAppraisalAmount: 0,
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

  // ── UPDATE flow ──────────────────────────────────────────────────────────────
  const oldAppraisal = existingMedia.appraisal
    ? JSON.parse(JSON.stringify(existingMedia.appraisal))
    : {};

  if (!Array.isArray(oldAppraisal.history)) oldAppraisal.history = [];

  // Restore fields from old doc
  if (oldAppraisal.history.length > 0) {
    appraisal.history = oldAppraisal.history.map((h) => ({ ...h }));
  } else {
    appraisal.history = [];
  }

  if (oldAppraisal.currentRent && oldAppraisal.currentRent > 0) {
    appraisal.currentRent = oldAppraisal.currentRent;
  } else {
    appraisal.currentRent = netPayable;
  }

  if (oldAppraisal.lastAppraisalDate) {
    appraisal.lastAppraisalDate = oldAppraisal.lastAppraisalDate;
  }

  // Detect changes
  let fixedAmountChanged = false;
  let nextDateChanged = false;

  if (Number(appraisal.type) === 2) {
    const oldFixed = Number(oldAppraisal.fixedAmount || 0);
    const newFixed = Number(appraisal.fixedAmount || 0);
    if (oldFixed !== newFixed) fixedAmountChanged = true;
  }

  if (oldAppraisal.nextAppraisalDate && appraisal.nextAppraisalDate) {
    const oldNextDate = new Date(oldAppraisal.nextAppraisalDate);
    const newNextDate = new Date(appraisal.nextAppraisalDate);
    if (oldNextDate.getTime() !== newNextDate.getTime()) nextDateChanged = true;
  }

  // ── Case 1: Only fixedAmount changed (same date) → update last history entry
  if (fixedAmountChanged && !nextDateChanged) {
    if (appraisal.history.length > 0) {
      const lastIndex = appraisal.history.length - 1;
      const lastEntry = appraisal.history[lastIndex];

      const previousRent = Number(lastEntry.previousRent || 0);
      const newAppraisalAmount = Number(appraisal.fixedAmount || 0);
      const newRent = Math.round(previousRent + newAppraisalAmount);

      appraisal.history[lastIndex] = {
        ...lastEntry,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        appraisalAmount: newAppraisalAmount,
        newRent,
        updatedBy: userName,
        updatedAt: getISTDate(),
      };

      appraisal.currentRent = newRent;
      appraisal.appraisalAmount = newAppraisalAmount;

      if (oldAppraisal.nextAppraisalDate) {
        appraisal.nextAppraisalDate = oldAppraisal.nextAppraisalDate;
      }

      const totalAppraisal = appraisal.history.reduce(
        (sum, entry) => sum + Number(entry.appraisalAmount || 0),
        0
      );
      const baseRent = Number(appraisal.history[0]?.previousRent || netPayable);
      appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);

      mediaData.appraisal = appraisal;
      return mediaData;
    }
  }

  // ── Case 2: nextAppraisalDate changed
  if (nextDateChanged) {
    const oldNextDate = new Date(oldAppraisal.nextAppraisalDate);
    const newNextDate = new Date(appraisal.nextAppraisalDate);

    let updatedHistory = oldAppraisal.history.map((h) => ({ ...h }));

    // If fixedAmount also changed, update last history entry first
    if (fixedAmountChanged && updatedHistory.length > 0) {
      const lastIndex = updatedHistory.length - 1;
      const lastEntry = updatedHistory[lastIndex];

      const previousRent = Number(lastEntry.previousRent || 0);
      const newAppraisalAmount = Number(appraisal.fixedAmount || 0);
      const newRent = Math.round(previousRent + newAppraisalAmount);

      updatedHistory[lastIndex] = {
        ...lastEntry,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        appraisalAmount: newAppraisalAmount,
        newRent,
        updatedBy: userName,
        updatedAt: getISTDate(),
      };
    }

    // Find and handle old next date entry
    const oldNextDateEntryIndex = updatedHistory.findIndex(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).getTime() === oldNextDate.getTime()
    );

    let currentRentValue = 0;

    if (oldNextDateEntryIndex !== -1) {
      const oldEntry = updatedHistory[oldNextDateEntryIndex];

      if (oldNextDate < newNextDate) {
        // Keep entry, it's before the new date
        currentRentValue = Number(oldEntry.newRent || 0);
      } else {
        // Remove entry, old date is after new date
        updatedHistory.splice(oldNextDateEntryIndex, 1);
        if (updatedHistory.length > 0) {
          currentRentValue = Number(
            updatedHistory[updatedHistory.length - 1].newRent || 0
          );
        } else {
          currentRentValue = Number(oldAppraisal.currentRent || netPayable);
        }
      }
    } else {
      if (updatedHistory.length > 0) {
        currentRentValue = Number(
          updatedHistory[updatedHistory.length - 1].newRent || 0
        );
      } else {
        currentRentValue = Number(oldAppraisal.currentRent || netPayable);
      }
    }

    // Add new entry only if new date doesn't exist and is after old date
    const newNextDateExists = updatedHistory.some(
      (item) =>
        item.appraisalDate &&
        new Date(item.appraisalDate).getTime() === newNextDate.getTime()
    );

    if (!newNextDateExists && oldNextDate < newNextDate) {
      let previousRent = currentRentValue;
      let latestAppraisalAmount = 0;

      if (updatedHistory.length > 0) {
        const lastEntry = updatedHistory[updatedHistory.length - 1];
        latestAppraisalAmount = Number(lastEntry.appraisalAmount || 0);
        previousRent = Number(lastEntry.newRent || currentRentValue);
      }

      let appraisalAmount = 0;
      if (Number(appraisal.type) === 1) {
        appraisalAmount =
          (latestAppraisalAmount * Number(appraisal.percentage || 0)) / 100;
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
        previousAppraisalAmount: latestAppraisalAmount,
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
      const baseRent =
        updatedHistory[0]?.previousRent
          ? Number(updatedHistory[0].previousRent)
          : netPayable;

      appraisal.totalAppraisalAmount = Math.round(baseRent + totalAppraisal);
    }

    mediaData.appraisal = appraisal;
    return mediaData;
  }

  // ── No appraisal-relevant change on update — keep old values
  // ── No appraisal-relevant change on update — keep old values
mediaData.appraisal = {
  ...appraisal,
  history: oldAppraisal.history,
  currentRent: oldAppraisal.currentRent || appraisal.currentRent,
  lastAppraisalDate: oldAppraisal.lastAppraisalDate || appraisal.lastAppraisalDate,
  appraisalAmount: oldAppraisal.appraisalAmount || appraisal.appraisalAmount,         // ✅ add this
  totalAppraisalAmount: oldAppraisal.totalAppraisalAmount || appraisal.totalAppraisalAmount, // ✅ add this
  nextAppraisalDate: oldAppraisal.nextAppraisalDate || appraisal.nextAppraisalDate,   // ✅ add this
};

return mediaData;
};

// ─────────────────────────────────────────────────────────────
// MEDIA ONBOARDING — CREATE / UPDATE
// ─────────────────────────────────────────────────────────────
// const mediaOnboarding = async (req, res) => {
//   try {
//     const { id } = req.body;
//     const mediaData = req.body;
//     const userName = req.user?.userName || "Admin";
//     // ── Parse JSON strings from FormData ──────────────────
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

//     // ── Convert rentalPayment numeric values ───────────────
//     if (mediaData.rentalPayment) {
//       if (mediaData.rentalPayment.totalRentalAmount !== undefined) {
//         mediaData.rentalPayment.totalRentalAmount = Number(
//           mediaData.rentalPayment.totalRentalAmount
//         );
//       }
//       if (mediaData.rentalPayment.paymentFrequency) {
//         mediaData.rentalPayment.paymentFrequency = Number(
//           mediaData.rentalPayment.paymentFrequency
//         );
//       }
//       if (mediaData.rentalPayment.tdsApplicable !== undefined) {
//         mediaData.rentalPayment.tdsApplicable = Number(
//           mediaData.rentalPayment.tdsApplicable
//         );
//       }
//       if (mediaData.rentalPayment.gstApplicable !== undefined) {
//         mediaData.rentalPayment.gstApplicable = Number(
//           mediaData.rentalPayment.gstApplicable
//         );
//       }
//     }

//     // ── Convert landOwners ─────────────────────────────────
//     if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
//       const hasValue = (v) => v !== undefined && v !== null && v !== "";

//       mediaData.landOwners = mediaData.landOwners.map((owner) => {
//         const converted = {
//           ...owner,
//           typeShare: hasValue(owner.typeShare) ? Number(owner.typeShare) : undefined,
//         };

//         converted.sharePercentage = hasValue(owner.sharePercentage)
//           ? Number(owner.sharePercentage)
//           : undefined;

//         converted.shareAmount = hasValue(owner.shareAmount)
//           ? Number(owner.shareAmount)
//           : undefined;

//         converted.paymentCategory = hasValue(owner.paymentCategory)
//           ? Number(owner.paymentCategory)
//           : undefined;

//         converted.onlineMode = hasValue(owner.onlineMode)
//           ? Number(owner.onlineMode)
//           : undefined;

//         converted.cashAmount = hasValue(owner.cashAmount)
//           ? Number(owner.cashAmount)
//           : 0;

//         converted.onlineAmount = hasValue(owner.onlineAmount)
//           ? Number(owner.onlineAmount)
//           : 0;

//         // Per-owner GST fields (only relevant when rentalPayment.gstApplicable=0)
//         converted.gstApplicable = hasValue(owner.gstApplicable)
//           ? Number(owner.gstApplicable)
//           : 0;

//         return converted;
//       });
//     }

//     // ── Auto-assign single owner full share ────────────────
//     if (mediaData.landOwners?.length === 1) {
//       const owner = mediaData.landOwners[0];
//       if (!owner.typeShare) {
//         owner.typeShare = 1;
//         owner.sharePercentage = 100;
//       }
//     }

//     // ── Convert agreement ──────────────────────────────────
//     if (mediaData.agreement) {
//       if (mediaData.agreement.startDate) {
//         mediaData.agreement.startDate = new Date(mediaData.agreement.startDate);
//       }
//       if (mediaData.agreement.endDate) {
//         mediaData.agreement.endDate = new Date(mediaData.agreement.endDate);
//       }
//       if (mediaData.agreement.reminderBeforeExpiry) {
//         mediaData.agreement.reminderBeforeExpiry = Number(
//           mediaData.agreement.reminderBeforeExpiry
//         );
//       }
//     }

//     // ── Convert rentalPayment dates ────────────────────────
//     if (mediaData.rentalPayment?.lastBillPaidDate) {
//       mediaData.rentalPayment.lastBillPaidDate = new Date(
//         mediaData.rentalPayment.lastBillPaidDate
//       );
//     }

//     // ── Convert appraisal ──────────────────────────────────
//     if (mediaData.appraisal) {
//       if (mediaData.appraisal.applicable !== undefined) {
//         mediaData.appraisal.applicable = Number(mediaData.appraisal.applicable);
//       }
//       if (mediaData.appraisal.type) {
//         mediaData.appraisal.type = Number(mediaData.appraisal.type);
//       }
//       if (mediaData.appraisal.percentage) {
//         mediaData.appraisal.percentage = Number(mediaData.appraisal.percentage);
//       }
//       if (mediaData.appraisal.fixedAmount) {
//         mediaData.appraisal.fixedAmount = Number(mediaData.appraisal.fixedAmount);
//       }
//       if (mediaData.appraisal.frequency) {
//         mediaData.appraisal.frequency = Number(mediaData.appraisal.frequency);
//       }
//       if (mediaData.appraisal.customFrequencyMonths) {
//         mediaData.appraisal.customFrequencyMonths = Number(
//           mediaData.appraisal.customFrequencyMonths
//         );
//       }
//       if (mediaData.appraisal.nextAppraisalDate) {
//         mediaData.appraisal.nextAppraisalDate = new Date(
//           mediaData.appraisal.nextAppraisalDate
//         );
//       }
//     }

//     // ── Convert other numeric fields ───────────────────────
//     if (mediaData.width) mediaData.width = Number(mediaData.width);
//     if (mediaData.height) mediaData.height = Number(mediaData.height);
//     if (mediaData.status) mediaData.status = Number(mediaData.status);
//     if (mediaData.numberOfLandOwners) {
//       mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);
//     }

//     // ── VALIDATION: GST ────────────────────────────────────
//     if (mediaData.rentalPayment) {
//       const gstCheck = validateGst(mediaData.rentalPayment);
//       if (!gstCheck.valid) {
//         return errorResponse(res, gstCheck.message, null, 400);
//       }
//     }

//     // ── VALIDATION: Land owner shares ─────────────────────
//     if (
//       mediaData.landOwners?.length &&
//       mediaData.rentalPayment?.totalRentalAmount
//     ) {
//       const tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable) || 0;
//       const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
//       const tdsPercentage =
//         tdsApplicable === 1
//           ? envTdsPercent > 0
//             ? envTdsPercent
//             : Number(mediaData.rentalPayment.tdsPercentage || 0)
//           : 0;

//       const rentalGstApplicable =
//         Number(mediaData.rentalPayment.gstApplicable) || 0;

//       const shareCheck = validateLandOwnerShares(
//         mediaData.landOwners,
//         Number(mediaData.rentalPayment.totalRentalAmount),
//         tdsApplicable,
//         tdsPercentage,
//         rentalGstApplicable
//       );

//       if (!shareCheck.valid) {
//         return errorResponse(res, shareCheck.message, null, 400);
//       }

//       // ── VALIDATION: Payment category per owner ─────────────
//       const pmCatCheck = validateOwnerPaymentCategories(
//         mediaData.landOwners,
//         shareCheck.netPayable,
//         rentalGstApplicable
//       );
//       if (!pmCatCheck.valid) {
//         return errorResponse(res, pmCatCheck.message, null, 400);
//       }
//     }

//     // ── VALIDATION: Appraisal frequency ───────────────────
//     if (mediaData.appraisal && mediaData.agreement) {
//       const appraisalCheck = validateAppraisalFrequency(
//         mediaData.agreement,
//         mediaData.appraisal
//       );
//       if (!appraisalCheck.valid) {
//         return errorResponse(res, appraisalCheck.message, null, 400);
//       }
//     }

//     // ── File Uploads ───────────────────────────────────────
//     const uploadedAgreementPDF = req.files?.agreementPDF?.[0];
//     if (uploadedAgreementPDF) {
//       if (!mediaData.agreement) mediaData.agreement = {};
//       mediaData.agreement.agreementPDF = req.processFile(uploadedAgreementPDF);
//     }

//     const uploadedFrontView = req.files?.frontView?.[0];
//     if (uploadedFrontView) {
//       mediaData.frontView = req.processFile(uploadedFrontView);
//     }

//     const uploadedSideView = req.files?.sideView?.[0];
//     if (uploadedSideView) {
//       mediaData.sideView = req.processFile(uploadedSideView);
//     }

//     const uploadedLocationView = req.files?.locationView?.[0];
//     if (uploadedLocationView) {
//       mediaData.locationView = req.processFile(uploadedLocationView);
//     }

//     const uploadedAdditionalView = req.files?.additionalImages?.[0];
//     if (uploadedAdditionalView) {
//       mediaData.additionalImages = req.processFile(uploadedAdditionalView);
//     }

//     // ── Create or Update ───────────────────────────────────
//     let media;
//     let isNew = false;

//     if (id) {
//       media = await MediaOnboarding.findById(id);

//       if (!media) {
//         return errorResponse(res, "Media not found with this ID", null, 404);
//       }

//       delete mediaData.id;

//       // ── Appraisal history logic ────────────────────────
//       if (mediaData.appraisal) {
//         const oldAppraisal = media.appraisal
//           ? JSON.parse(JSON.stringify(media.appraisal))
//           : {};

//         if (!Array.isArray(oldAppraisal.history)) {
//           oldAppraisal.history = [];
//         }

//         const oldDate = oldAppraisal.nextAppraisalDate
//           ? new Date(oldAppraisal.nextAppraisalDate)
//           : null;

//         const newDate = mediaData.appraisal.nextAppraisalDate
//           ? new Date(mediaData.appraisal.nextAppraisalDate)
//           : null;

//         if (oldDate && newDate && oldDate.getTime() !== newDate.getTime()) {
//           oldAppraisal.history.push({
//             appraisalDate: oldAppraisal.nextAppraisalDate,
//             type: oldAppraisal.type || null,
//             percentage: oldAppraisal.percentage || 0,
//             fixedAmount: oldAppraisal.fixedAmount || 0,
//             appraisalAmount: oldAppraisal.appraisalAmount || 0,
//             updatedBy: req.user.userName || "Admin",
//             updatedAt: getISTDate(),
//             totalAppraisalAmount: oldAppraisal.totalAppraisalAmount || 0,
//           });

//           oldAppraisal.lastAppraisalDate = oldAppraisal.nextAppraisalDate;
//         }
// console.log(oldAppraisal)
//         media.appraisal = {
//           ...oldAppraisal,
//           ...mediaData.appraisal,
//           history: oldAppraisal.history,
//         };
//       }

//       // ── Other fields ──────────────────────────────────
//       Object.keys(mediaData).forEach((key) => {
//         if (!["_id", "__v", "createdAt", "mediaId", "appraisal"].includes(key)) {
//           media[key] = mediaData[key];
//         }
//       });

//       await media.save();
//       media = await MediaOnboarding.findById(media._id).lean();
//     } else {
//       // CREATE
//       delete mediaData.id;
//       mediaData.mediaId = await generateAdminMediaId();
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
const mediaOnboarding = async (req, res) => {
  try {
    const { id } = req.body;
    const mediaData = req.body;
    const userName = req.user?.userName || "Admin";

    // ── Parse JSON strings from FormData ──────────────────
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

    // ── Convert rentalPayment numeric values ───────────────
    if (mediaData.rentalPayment) {
      if (mediaData.rentalPayment.totalRentalAmount !== undefined)
        mediaData.rentalPayment.totalRentalAmount = Number(mediaData.rentalPayment.totalRentalAmount);
      if (mediaData.rentalPayment.paymentFrequency)
        mediaData.rentalPayment.paymentFrequency = Number(mediaData.rentalPayment.paymentFrequency);
      if (mediaData.rentalPayment.tdsApplicable !== undefined)
        mediaData.rentalPayment.tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable);
      if (mediaData.rentalPayment.gstApplicable !== undefined)
        mediaData.rentalPayment.gstApplicable = Number(mediaData.rentalPayment.gstApplicable);
    }

    // ── Convert landOwners ─────────────────────────────────
    if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
      const hasValue = (v) => v !== undefined && v !== null && v !== "";
      mediaData.landOwners = mediaData.landOwners.map((owner) => ({
        ...owner,
        typeShare: hasValue(owner.typeShare) ? Number(owner.typeShare) : undefined,
        sharePercentage: hasValue(owner.sharePercentage) ? Number(owner.sharePercentage) : undefined,
        shareAmount: hasValue(owner.shareAmount) ? Number(owner.shareAmount) : undefined,
        paymentCategory: hasValue(owner.paymentCategory) ? Number(owner.paymentCategory) : undefined,
        onlineMode: hasValue(owner.onlineMode) ? Number(owner.onlineMode) : undefined,
        cashAmount: hasValue(owner.cashAmount) ? Number(owner.cashAmount) : 0,
        onlineAmount: hasValue(owner.onlineAmount) ? Number(owner.onlineAmount) : 0,
        gstApplicable: hasValue(owner.gstApplicable) ? Number(owner.gstApplicable) : 0,
      }));
    }

    // ── Auto-assign single owner full share ────────────────
    if (mediaData.landOwners?.length === 1) {
      const owner = mediaData.landOwners[0];
      if (!owner.typeShare) {
        owner.typeShare = 1;
        owner.sharePercentage = 100;
      }
    }

    // ── Convert agreement ──────────────────────────────────
    if (mediaData.agreement) {
      if (mediaData.agreement.startDate)
        mediaData.agreement.startDate = new Date(mediaData.agreement.startDate);
      if (mediaData.agreement.endDate)
        mediaData.agreement.endDate = new Date(mediaData.agreement.endDate);
      if (mediaData.agreement.reminderBeforeExpiry)
        mediaData.agreement.reminderBeforeExpiry = Number(mediaData.agreement.reminderBeforeExpiry);
    }

    // ── Convert rentalPayment dates ────────────────────────
    if (mediaData.rentalPayment?.lastBillPaidDate)
      mediaData.rentalPayment.lastBillPaidDate = new Date(mediaData.rentalPayment.lastBillPaidDate);

    // ── Convert appraisal ──────────────────────────────────
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
        mediaData.appraisal.customFrequencyMonths = Number(mediaData.appraisal.customFrequencyMonths);
      if (mediaData.appraisal.nextAppraisalDate)
        mediaData.appraisal.nextAppraisalDate = new Date(mediaData.appraisal.nextAppraisalDate);
    }

    // ── Convert other numeric fields ───────────────────────
    if (mediaData.width) mediaData.width = Number(mediaData.width);
    if (mediaData.height) mediaData.height = Number(mediaData.height);
    if (mediaData.status) mediaData.status = Number(mediaData.status);
    if (mediaData.numberOfLandOwners)
      mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);

    // ── VALIDATION: GST ────────────────────────────────────
    if (mediaData.rentalPayment) {
      const gstCheck = validateGst(mediaData.rentalPayment);
      if (!gstCheck.valid) return errorResponse(res, gstCheck.message, null, 400);
    }

    // ── VALIDATION: Land owner shares ─────────────────────
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

    // ── VALIDATION: Appraisal frequency ───────────────────
    if (mediaData.appraisal && mediaData.agreement) {
      const appraisalCheck = validateAppraisalFrequency(mediaData.agreement, mediaData.appraisal);
      if (!appraisalCheck.valid) return errorResponse(res, appraisalCheck.message, null, 400);
    }

    // ── File Uploads ───────────────────────────────────────
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

    // ── Create or Update ───────────────────────────────────
    let media;
    let isNew = false;

    if (id) {
      // ── UPDATE ─────────────────────────────────────────
      media = await MediaOnboarding.findById(id);
      if (!media) return errorResponse(res, "Media not found with this ID", null, 404);

      delete mediaData.id;

      // Run appraisal logic in controller
      await handleAppraisalLogic(mediaData, media, userName);

      // Apply all other fields
      Object.keys(mediaData).forEach((key) => {
        if (!["_id", "__v", "createdAt", "mediaId"].includes(key)) {
          media[key] = mediaData[key];
        }
      });

      await media.save();
      media = await MediaOnboarding.findById(media._id).lean();

    } else {
      // ── CREATE ─────────────────────────────────────────
      delete mediaData.id;
      mediaData.mediaId = await generateAdminMediaId();

      // Run appraisal logic in controller
      await handleAppraisalLogic(mediaData, null, userName);

      media = new MediaOnboarding(mediaData);
      await media.save();
      media = await MediaOnboarding.findById(media._id).lean();
      isNew = true;
    }

    const message = isNew ? "Media created successfully" : "Media updated successfully";
    return successResponse(res, message, media, isNew ? 201 : 200);

  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};
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
module.exports = { mediaOnboarding, mediaList, uploadExcel };
