
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const path = require("path");
const XLSX = require("xlsx");
const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema"); // ✅ ADDED

const mongoose = require("mongoose");
const {
  syncOrLinkMediaOwnerToMaster,
  correctLinkedSiteAmounts,
} = require("../landOwnerMasterController/landOwnerMasterController");

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
      uploadedAt: nowIST(),
    };
  }
  return null;
};

// ─────────────────────────────────────────────────────────────
// VALIDATE OWNER PAYMENT CATEGORIES
// ─────────────────────────────────────────────────────────────
const validateOwnerPaymentCategories = (
  landOwners,
  netPayable,
  rentalGstApplicable,
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
          ownerShare = Math.floor(
            ((netPayable * (Number(owner.sharePercentage) || 0)) / 100).toFixed(
              2,
            ),
          );
        } else {
          ownerShare = Math.floor((Number(owner.shareAmount) || 0).toFixed(2));
        }

        const splitTotal = Math.floor((cashAmt + onlineAmt).toFixed(2));
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

const validateLandOwnerShares = (
  landOwners,
  totalRentalAmount,
  gstApplicable, // ✅ tdsApplicable/tdsPercentage params REMOVED
) => {
  // ✅ No TDS deduction here anymore — the pool owners split is just
  // totalRentalAmount (+ GST if applicable). TDS is validated separately,
  // per owner, further down.
  let gstAmount = 0;
  let totalWithGst = totalRentalAmount;

  if (gstApplicable === 1) {
    const envGstPct = Math.floor(process.env.GST_PERCENTAGE || "18");
    gstAmount = Math.floor(((totalRentalAmount * envGstPct) / 100).toFixed(2));
    totalWithGst = Math.floor((totalRentalAmount + gstAmount).toFixed(2));
  }

  const netPayable = Math.floor(totalWithGst.toFixed(2));

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

      if (
        isNaN(sharePercentage) ||
        sharePercentage < 0 ||
        sharePercentage > 100
      ) {
        return {
          valid: false,
          message: `Owner "${owner.name || "Unknown"}": sharePercentage must be between 0 and 100.`,
        };
      }

      totalComputedAmount += Math.floor(
        ((netPayable * sharePercentage) / 100).toFixed(2),
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

      totalComputedAmount += Math.floor(shareAmount.toFixed(2));
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
      message: `Net payable amount (${netPayable.toFixed(2)}). Difference: ${diff.toFixed(2)}`,
    };
  }

  return {
    valid: true,
    netPayable,
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

const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

const toDateOnly = (input) => {
  const d = new Date(input);
  // Use UTC date parts to construct a UTC date. This prevents the date from
  // shifting when constructive a midnight-UTC object, regardless of the
  // server's local time zone.
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
};

const dayKey = (input) => toDateOnly(input).getTime();
const todayKey = () => dayKey(nowIST());
const sameDay = (a, b) => dayKey(a) === dayKey(b);
const isFutureDate = (date) => dayKey(date) > todayKey();

const dateString = (date) => {
  const d = toDateOnly(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const processGstOutstandingHistory = (rentalPayment, userName) => {
  if (!rentalPayment) return rentalPayment;

  // If outStandingStatus is 1, manage history
  if (rentalPayment.outStantStatus === 1) {
    // ✅ Check if history is provided in request AND has items
    if (
      rentalPayment.gstOutstandingHistory &&
      Array.isArray(rentalPayment.gstOutstandingHistory) &&
      rentalPayment.gstOutstandingHistory.length > 0
    ) {
      // Process each entry - keep existing data
      rentalPayment.gstOutstandingHistory = rentalPayment.gstOutstandingHistory.map(
        (item) => ({
          dueMonth: item.dueMonth,
          gstOutStandingAmount: item.gstOutStandingAmount || 0,
          // ✅ Keep existing _id, updatedAt, updatedBy if they exist
          _id: item._id || new mongoose.Types.ObjectId(),
          updatedBy: userName,
          updatedAt: nowIST(),
        }),
      );

      // Remove duplicates (keep latest)
      const uniqueHistory = [];
      const seenMonths = new Set();
      for (const item of rentalPayment.gstOutstandingHistory) {
        if (!seenMonths.has(item.dueMonth)) {
          seenMonths.add(item.dueMonth);
          uniqueHistory.push(item);
        }
      }
      rentalPayment.gstOutstandingHistory = uniqueHistory;

      // Calculate total
      rentalPayment.gstOutStandingAmount = rentalPayment.gstOutstandingHistory.reduce(
        (sum, item) => sum + (item.gstOutStandingAmount || 0),
        0,
      );
    }
    // ✅ If history array is empty in request, keep it empty (user intentionally cleared it)
    else if (
      rentalPayment.gstOutstandingHistory &&
      Array.isArray(rentalPayment.gstOutstandingHistory) &&
      rentalPayment.gstOutstandingHistory.length === 0
    ) {
      rentalPayment.gstOutStandingAmount = 0;
    }
    // ✅ Auto-generate only if history field is MISSING (undefined) in request AND we have a lastBillPaidDate
    else if (rentalPayment.lastBillPaidDate) {
      // Auto-generate from lastBillPaidDate
      const lastBillDate = new Date(rentalPayment.lastBillPaidDate);
      const currentDate = nowIST();

      const monthsDiff =
        (currentDate.getFullYear() - lastBillDate.getFullYear()) * 12 +
        (currentDate.getMonth() - lastBillDate.getMonth());

      // Start from i=1 to skip the month of lastBillPaidDate, as it's already paid.
      // This ensures "cannot create against" the paid month.
      if (monthsDiff >= 1) {
        const gstAmount =
          rentalPayment.gstAmount ||
          (rentalPayment.totalRentalAmount * rentalPayment.gstPercentage) / 100;

        rentalPayment.gstOutstandingHistory = [];
        for (let i = 1; i <= monthsDiff; i++) {
          const date = new Date(lastBillDate);
          date.setMonth(date.getMonth() + i);
          const dueMonth =
            date.toLocaleString("default", { month: "short" }) +
            " " +
            date.getFullYear();

          rentalPayment.gstOutstandingHistory.push({
            dueMonth: dueMonth,
            gstOutStandingAmount: gstAmount,
            updatedBy: userName,
            updatedAt: nowIST(),
          });
        }

        rentalPayment.gstOutStandingAmount = rentalPayment.gstOutstandingHistory.reduce(
          (sum, item) => sum + item.gstOutStandingAmount,
          0,
        );
      } else {
        rentalPayment.gstOutstandingHistory = [];
        rentalPayment.gstOutStandingAmount = 0;
      }
    }
  } else {
    // If outStandingStatus is 0, clear everything
    rentalPayment.gstOutstandingHistory = [];
    rentalPayment.gstOutStandingAmount = 0;
  }

  return rentalPayment;
};
const APPRAISAL_FREQUENCY_MONTHS = { 1: 12, 2: 24, 3: 36 };
const APPRAISAL_FREQUENCY_LABEL = {
  1: "1 Year",
  2: "2 Years",
  3: "3 Years",
  4: "Custom",
};
const APPRAISAL_FREQUENCY_MONTHS_MAP = { 1: 12, 2: 24, 3: 36 };

const handleRentalAmountHistory = (mediaData, existingMedia, userName) => {
  const incomingAmount = Number(
    mediaData.rentalPayment?.totalRentalAmount ?? 0,
  );

  if (!mediaData.rentalPayment) {
    return { currentBaseRent: incomingAmount, rentActuallyChanged: false };
  }

  // Carry forward existing history (deep-copy safely without losing Date objects).
  let history = existingMedia
    ? (existingMedia.rentalPayment?.rentalAmountHistory || []).map((h) =>
        h.toObject ? h.toObject() : { ...h },
      )
    : [];

  const isNew = !existingMedia;
  let rentActuallyChanged = false;

  if (isNew) {
    history = [
      { amount: incomingAmount, updatedBy: userName, updatedAt: nowIST() },
    ];
    rentActuallyChanged = true; // first-ever entry counts as a "change"
  } else {
    const oldAmount = Number(
      existingMedia.rentalPayment?.totalRentalAmount ?? 0,
    );

    if (incomingAmount !== oldAmount) {
      // Genuinely different amount → record it.
      history.push({
        amount: incomingAmount,
        updatedBy: userName,
        updatedAt: nowIST(),
      });
      rentActuallyChanged = true;
    }
    // Same amount → no new entry, rentActuallyChanged stays false.
  }

  history.sort((a, b) => b.updatedAt - a.updatedAt);
  mediaData.rentalPayment.rentalAmountHistory = history;
  return { currentBaseRent: incomingAmount, rentActuallyChanged };
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
        "appraisal.frequency must be 1 (Year), 2 (Years), 3 (3 Years), or 4 (Custom)",
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

  // candidateDate is still computed in case you want to use/display it,
  // but it no longer blocks validation even if it falls on/after endDate.
  const candidateDate = new Date(startDate);
  candidateDate.setMonth(candidateDate.getMonth() + months);

  return { valid: true };
};
const computeAppraisalAmount = (entry, previousRent) => {
  if (Number(entry.type) === 1) {
    return Math.floor((previousRent * Number(entry.percentage || 0)) / 100);
  }
  if (Number(entry.type) === 2) {
    return Math.floor(Number(entry.fixedAmount || 0));
  }
  return 0;
};

const cascadeHistory = (
  history,
  baseRent,
  netPayable,
  rentActuallyChanged = false,
) => {
  const today = todayKey();
  const sorted = history
    .filter((h) => h.appraisalDate)
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  let prev = Number(baseRent || 0);
  let manualRebaseDone = false;

  for (const entry of sorted) {
    const entryDateKey = dayKey(entry.appraisalDate);

    // ✅ Re-baseline from today onwards if the rent was manually changed.
    // This ensures that if a user updates rent to 60,000, future appraisals
    // start from 60,000 rather than the old schedule's base.
    if (rentActuallyChanged && !manualRebaseDone && entryDateKey >= today) {
      prev = Number(netPayable ?? prev);
      manualRebaseDone = true;
    }

    entry.previousRent = prev;

    // ✅ FIXED — Only apply bump if it's a current/future entry and NOT an anchor.
    // "Yesterday don't apply, today it will apply"
    if (entry.isAnchorEntry || entryDateKey < today) {
      entry.appraisalAmount = 0;
    } else {
      entry.appraisalAmount = computeAppraisalAmount(entry, prev);
    }

    entry.newRent = Math.floor(prev + entry.appraisalAmount);
    prev = entry.newRent;
  }
  return sorted;
};

const scaleLandOwnersForRentChange = (landOwners, oldAmount, newAmount) => {
  if (!Array.isArray(landOwners) || !landOwners.length) return;
  if (!oldAmount || oldAmount <= 0 || !newAmount || newAmount <= 0) return;

  const ratio = newAmount / oldAmount;
  if (!isFinite(ratio) || ratio <= 0) return;

  landOwners.forEach((owner) => {
    const cat = Number(owner.paymentCategory);

    // Scale fixed-amount shares proportionally
    if (Number(owner.typeShare) === 2) {
      owner.shareAmount = Math.floor(Number(owner.shareAmount || 0) * ratio);
    }

    if (cat === 1) {
      // Cash only
      owner.cashAmount = Math.floor(Number(owner.cashAmount || 0) * ratio);
      owner.onlineAmount = 0;
    } else if (cat === 2) {
      // Online only
      owner.onlineAmount = Math.floor(Number(owner.onlineAmount || 0) * ratio);
      owner.cashAmount = 0;
    } else if (cat === 3) {
      // Cash + Online split: scale both components
      owner.cashAmount = Math.floor(Number(owner.cashAmount || 0) * ratio);
      owner.onlineAmount = Math.floor(Number(owner.onlineAmount || 0) * ratio);
    }
  });
};

const buildAppraisalScheduleFromAnchor = ({
  anchorDate,
  frequency,
  customFrequencyMonths,
  type,
  percentage,
  fixedAmount,
  baseRent,
  userName,
}) => {
  const base = Number(baseRent || 0);

  const seedEntry = {
    appraisalDate: toDateOnly(anchorDate),
    type,
    percentage: percentage || 0,
    fixedAmount: Number(fixedAmount || 0),
    frequency: Number(frequency),
    customFrequencyMonths: Number(customFrequencyMonths || 0),
    previousRent: base,
    appraisalAmount: 0,
    newRent: base,
    isAnchorEntry: true, // ✅ marks this as a checkpoint entry — stays flat
    updatedBy: userName,
    updatedAt: nowIST(),
  };

  let history = [seedEntry];
  history = autoScheduleFutureAppraisalEntries(history, userName);

  if (
    history[0] &&
    dayKey(history[0].appraisalDate) === dayKey(seedEntry.appraisalDate)
  ) {
    history[0].previousRent = base;
    history[0].appraisalAmount = 0;
    history[0].newRent = base;
    history[0].isAnchorEntry = true;
  }

  return history;
};
const backfillHistoricalAppraisalEntries = (
  history,
  agreementStartDate,
  userName,
) => {
  if (!Array.isArray(history) || !history.length || !agreementStartDate)
    return history;

  const start = toDateOnly(agreementStartDate);
  history.sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  let earliestDate = new Date(history[0].appraisalDate);
  if (dayKey(earliestDate) <= dayKey(start)) return history;

  const monthsToSub = getFrequencyMonths(
    history[0].frequency,
    history[0].customFrequencyMonths,
  );
  if (monthsToSub <= 0) return history;

  let current = new Date(earliestDate);
  let safety = 0;

  while (safety < 60) {
    safety++;
    current.setMonth(current.getMonth() - monthsToSub);
    if (dayKey(current) < dayKey(start)) break;

    const backEntry = {
      appraisalDate: toDateOnly(current),
      type: history[0].type,
      percentage: history[0].percentage,
      fixedAmount: history[0].fixedAmount,
      frequency: history[0].frequency,
      customFrequencyMonths: history[0].customFrequencyMonths,
      previousRent: 0,
      appraisalAmount: 0,
      newRent: 0,
      updatedBy: userName,
      updatedAt: nowIST(),
    };
    history.unshift(backEntry);
  }

  // Ensure an anchor entry exists at the agreement start date if missing
  if (dayKey(history[0].appraisalDate) > dayKey(start)) {
    history.unshift({
      appraisalDate: start,
      type: history[0].type,
      percentage: history[0].percentage,
      fixedAmount: history[0].fixedAmount,
      frequency: history[0].frequency,
      customFrequencyMonths: history[0].customFrequencyMonths,
      previousRent: 0,
      appraisalAmount: 0,
      newRent: 0,
      isAnchorEntry: true,
      updatedBy: userName,
      updatedAt: nowIST(),
    });
  }

  return history;
};

const handleAppraisalLogic = async (
  mediaData,
  existingMedia,
  userName,
  currentBaseRent,
  rentActuallyChanged,
) => {
  const appraisal = mediaData.appraisal;
  const agreement = mediaData.agreement || existingMedia?.agreement;

  if (!appraisal || Number(appraisal.applicable) !== 1) return mediaData;
  if (!agreement?.startDate || !agreement?.endDate) return mediaData;

  const today = todayKey();

  const agreementStartDate = new Date(agreement.startDate);
  const agreementEndDate = new Date(agreement.endDate);

  let months = 0;
  if (Number(appraisal.frequency) === 4) {
    months = Number(appraisal.customFrequencyMonths || 0);
    if (months <= 0) {
      throw new Error("Custom frequency months must be greater than 0");
    }
  } else {
    months = APPRAISAL_FREQUENCY_MONTHS_MAP[Number(appraisal.frequency)] || 12;
  }

  const netPayable = Number(
    currentBaseRent ?? mediaData.rentalPayment?.totalRentalAmount ?? 0,
  );
  const isNew = !existingMedia;

  let nextDate = null;
  if (appraisal.nextAppraisalDate) {
    nextDate = toDateOnly(appraisal.nextAppraisalDate);
    appraisal.nextAppraisalDate = nextDate;
  }

  // ── CREATE flow ───────────────────────────────────────────────────────────
  if (isNew) {
    const manualLastAppraisalDate = appraisal.lastAppraisalDate
      ? toDateOnly(appraisal.lastAppraisalDate)
      : null;

    if (!nextDate && !manualLastAppraisalDate) {
      const firstDate = new Date(agreementStartDate);
      firstDate.setMonth(firstDate.getMonth() + months);
      nextDate = toDateOnly(firstDate);
      appraisal.nextAppraisalDate = nextDate;
    }

    const seedDate = manualLastAppraisalDate || nextDate;

    // ✅ Only treat this as a flat "anchor checkpoint" when lastAppraisalDate
    // was explicitly given. When it wasn't (only nextAppraisalDate / computed
    // firstDate), this seed IS the actual first appraisal event and must be
    // bumped by the percentage/fixedAmount — not left flat.
    const isAnchorSeed = !!manualLastAppraisalDate;

    appraisal.history = [];
    if (seedDate) {
      const seedEntry = {
        appraisalDate: seedDate,
        type: appraisal.type,
        percentage: appraisal.percentage || 0,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        frequency: Number(appraisal.frequency),
        customFrequencyMonths: Number(appraisal.customFrequencyMonths || 0),
        previousRent: netPayable,
        appraisalAmount: 0,
        newRent: netPayable,
        isAnchorEntry: isAnchorSeed,
        updatedBy: userName,
        updatedAt: nowIST(),
      };

      if (!isAnchorSeed) {
        // ✅ NEW — no lastAppraisalDate given, so nextAppraisalDate is a
        // real, due appraisal event. We apply the bump if it's today or in the future.
        if (dayKey(seedDate) >= today) {
          seedEntry.appraisalAmount = computeAppraisalAmount(
            seedEntry,
            netPayable,
          );
        } else {
          seedEntry.appraisalAmount = 0;
        }
        seedEntry.newRent = Math.floor(netPayable + seedEntry.appraisalAmount);
      }

      appraisal.history.push(seedEntry);

      appraisal.history = autoScheduleFutureAppraisalEntries(
        appraisal.history,
        userName,
      );

      // ✅ Only backfill to agreement start date if NO manual last appraisal date was provided.
      // If the user provides a lastAppraisalDate during onboarding, we treat that as the
      // definitive starting point for the appraisal history.
      if (!manualLastAppraisalDate) {
        appraisal.history = backfillHistoricalAppraisalEntries(
          appraisal.history,
          agreement.startDate,
          userName,
        );
      }

      appraisal.history = cascadeHistory(
        appraisal.history,
        netPayable,
        netPayable,
        true,
      );

      const lastEntry = appraisal.history[appraisal.history.length - 1];
      if (lastEntry)
        appraisal.nextAppraisalDate = new Date(lastEntry.appraisalDate);
    }

    if (manualLastAppraisalDate) {
      appraisal.lastAppraisalDate = manualLastAppraisalDate;
    }
    mediaData.appraisal = appraisal;
    return mediaData;
  }

  // ── UPDATE flow ───────────────────────────────────────────────────────────
  const oldAppraisal = existingMedia.appraisal
    ? JSON.parse(JSON.stringify(existingMedia.appraisal))
    : {};

  const oldRent = Number(existingMedia?.rentalPayment?.totalRentalAmount ?? 0);

  let history = (
    Array.isArray(oldAppraisal.history) ? oldAppraisal.history : []
  )
    .filter((h) => h.appraisalDate)
    .map((h) => ({ ...h }))
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  // ✅ FIXED — The seed baseline for recalculating history must be the
  // previousRent of the FIRST entry in history, not the current total rent.
  // Using the current rent (which already includes applied appraisals)
  // would cause the baseline to shift forward every time we save,
  // leading to "double bumps" where 10% is added on top of 10% repeatedly.
  const seedBaseRent =
    history.length > 0 ? Number(history[0].previousRent || 0) : netPayable;

  let isNewFutureEntry = false;

  const existingLastAppraisalDate = existingMedia.appraisal?.lastAppraisalDate
    ? toDateOnly(existingMedia.appraisal.lastAppraisalDate)
    : null;

  const incomingLastAppraisalDate = appraisal.lastAppraisalDate
    ? toDateOnly(appraisal.lastAppraisalDate)
    : null;

  const anchorDateChanged =
    incomingLastAppraisalDate &&
    (!existingLastAppraisalDate ||
      dayKey(incomingLastAppraisalDate) !== dayKey(existingLastAppraisalDate));

  const configChanged =
    Number(appraisal.frequency) !==
      Number(existingMedia.appraisal?.frequency) ||
    Number(appraisal.customFrequencyMonths || 0) !==
      Number(existingMedia.appraisal?.customFrequencyMonths || 0) ||
    Number(appraisal.type) !== Number(existingMedia.appraisal?.type) ||
    Number(appraisal.percentage || 0) !==
      Number(existingMedia.appraisal?.percentage || 0) ||
    Number(appraisal.fixedAmount || 0) !==
      Number(existingMedia.appraisal?.fixedAmount || 0);

  const manualLastAppraisalDateUpdate =
    incomingLastAppraisalDate && (anchorDateChanged || configChanged)
      ? incomingLastAppraisalDate
      : null;

  if (manualLastAppraisalDateUpdate) {
    const anchorKey = dayKey(manualLastAppraisalDateUpdate);
    // ✅ PRESERVE existing history entries that occurred BEFORE the new anchor date
    // This ensures that 2024, 2025, etc. dates do not change when the user
    // updates the lastAppraisalDate to a later date like 2026-05-15.
    const preserved = history.filter(
      (h) => dayKey(h.appraisalDate) < anchorKey,
    );

    // If we have preserved entries, the base rent for the new anchor is the last preserved newRent.
    const newBaseRentForAnchor =
      preserved.length > 0
        ? Number(preserved[preserved.length - 1].newRent || 0)
        : seedBaseRent;

    const newSchedule = buildAppraisalScheduleFromAnchor({
      anchorDate: manualLastAppraisalDateUpdate,
      frequency: appraisal.frequency,
      customFrequencyMonths: appraisal.customFrequencyMonths,
      type: appraisal.type,
      percentage: appraisal.percentage,
      fixedAmount: appraisal.fixedAmount,
      baseRent: newBaseRentForAnchor,
      userName,
    });

    history = [...preserved, ...newSchedule];
  } else if (nextDate) {
    const nextDay = dayKey(nextDate);
    const existingIdx = history.findIndex(
      (h) => dayKey(h.appraisalDate) === nextDay,
    );

    let appliedEntry = null;

    if (existingIdx !== -1) {
      const previousFrequency = Number(history[existingIdx].frequency);
      const previousCustomMonths = Number(
        history[existingIdx].customFrequencyMonths || 0,
      );

      history[existingIdx] = {
        ...history[existingIdx],
        type: appraisal.type,
        percentage: appraisal.percentage || 0,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        frequency: Number(appraisal.frequency),
        customFrequencyMonths: Number(appraisal.customFrequencyMonths || 0),
        updatedBy: userName,
        updatedAt: nowIST(),
      };

      const e = history[existingIdx];
      const isFutureEntry = dayKey(e.appraisalDate) >= today;

      if (rentActuallyChanged && isFutureEntry) {
        e.previousRent = netPayable;
      }

      // ✅ skip bump computation if this entry is an anchor checkpoint
      if (!e.isAnchorEntry) {
        // ✅ Only bump if it's a future entry
        if (isFutureEntry) {
          e.appraisalAmount = computeAppraisalAmount(e, e.previousRent);
        } else {
          e.appraisalAmount = 0;
        }
        e.newRent = Math.floor(e.previousRent + e.appraisalAmount);
      } else {
        e.appraisalAmount = 0;
        e.newRent = e.previousRent;
      }

      const frequencyChanged =
        e.frequency !== previousFrequency ||
        (e.frequency === 4 && e.customFrequencyMonths !== previousCustomMonths);

      if (frequencyChanged) {
        history = history.slice(0, existingIdx + 1);
      } else {
        let prev = e.newRent;
        for (let i = existingIdx + 1; i < history.length; i++) {
          if (dayKey(history[i].appraisalDate) >= today) {
            history[i].previousRent = prev;
            history[i].appraisalAmount = computeAppraisalAmount(
              history[i],
              prev,
            );
            history[i].newRent = Math.floor(prev + history[i].appraisalAmount);
            prev = history[i].newRent;
          }
        }
      }

      appliedEntry = e;
    } else {
      if (history.length > 0) {
        let latestIdx = 0;
        for (let i = 1; i < history.length; i++) {
          if (
            new Date(history[i].appraisalDate) >
            new Date(history[latestIdx].appraisalDate)
          ) {
            latestIdx = i;
          }
        }

        const movedEntry = history[latestIdx];
        movedEntry.appraisalDate = nextDate;
        movedEntry.type = appraisal.type;
        movedEntry.percentage = appraisal.percentage || 0;
        movedEntry.fixedAmount = Number(appraisal.fixedAmount || 0);
        movedEntry.frequency = Number(appraisal.frequency);
        movedEntry.customFrequencyMonths = Number(
          appraisal.customFrequencyMonths || 0,
        );
        movedEntry.isAnchorEntry = false; // ✅ moved entry is a real appraisal event
        movedEntry.updatedBy = userName;
        movedEntry.updatedAt = nowIST();

        if (nextDay >= today) isNewFutureEntry = true;

        history.sort(
          (a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate),
        );

        appliedEntry = history.find((h) => dayKey(h.appraisalDate) === nextDay);
      } else {
        // ✅ no existing history at all — nextDate is the first, real
        // appraisal event (no anchor exists), so compute the bump directly
        history.push({
          appraisalDate: nextDate,
          type: appraisal.type,
          percentage: appraisal.percentage || 0,
          fixedAmount: Number(appraisal.fixedAmount || 0),
          frequency: Number(appraisal.frequency),
          customFrequencyMonths: Number(appraisal.customFrequencyMonths || 0),
          previousRent: seedBaseRent,
          appraisalAmount: 0,
          newRent: 0,
          isAnchorEntry: false,
          updatedBy: userName,
          updatedAt: nowIST(),
        });

        appliedEntry = history[0];
      }
    }

    if (appliedEntry && dayKey(appliedEntry.appraisalDate) <= today) {
      const hasLaterEntry = history.some(
        (h) => dayKey(h.appraisalDate) > dayKey(appliedEntry.appraisalDate),
      );

      if (!hasLaterEntry) {
        history = autoScheduleFutureAppraisalEntries(history, userName);
      }
    }
  }

  // ✅ Only backfill if NO anchor date exists (neither incoming nor existing).
  // If the user has established an anchor (e.g. 2025), we respect it as the
  // official start of the appraisal schedule and don't backfill to 2024.
  const effectiveAnchorDate =
    incomingLastAppraisalDate || existingLastAppraisalDate;

  if (!effectiveAnchorDate) {
    history = backfillHistoricalAppraisalEntries(
      history,
      agreement.startDate,
      userName,
    );
  }

  // ✅ Use centralized cascade logic to ensure all rents are correct
  // and past appraisal amounts are forced to 0.
  appraisal.history = cascadeHistory(
    history,
    seedBaseRent,
    netPayable,
    rentActuallyChanged,
  );

  // Set the frequency metadata based on the current/first entry
  const currentEntryForMeta = history
    .filter((h) => dayKey(h.appraisalDate) <= today)
    .sort((a, b) => new Date(b.appraisalDate) - new Date(a.appraisalDate))[0];

  if (currentEntryForMeta) {
    appraisal.frequency = currentEntryForMeta.frequency;
    appraisal.customFrequencyMonths =
      currentEntryForMeta.customFrequencyMonths || 0;
  } else if (history.length > 0) {
    const firstEntry = history[0];
    appraisal.frequency = firstEntry.frequency;
    appraisal.customFrequencyMonths = firstEntry.customFrequencyMonths || 0;
  }

  return mediaData;
};

const recomputeAppraisalSummary = (appraisal, fallbackBaseRent = 0) => {
  if (!appraisal) return appraisal;
  if (Number(appraisal.applicable) !== 1) {
    appraisal.currentRent = Number(fallbackBaseRent || 0);
    appraisal.appraisalAmount = 0;
    appraisal.totalAppraisalAmount = Number(fallbackBaseRent || 0);

    return appraisal;
  }
  const today = todayKey();

  if (!Array.isArray(appraisal.history) || !appraisal.history.length) {
    const pendingDate = appraisal.nextAppraisalDate
      ? toDateOnly(appraisal.nextAppraisalDate)
      : null;

    appraisal.lastAppraisalDate =
      pendingDate && dayKey(pendingDate) <= today ? pendingDate : null;

    return appraisal;
  }

  const sorted = appraisal.history
    .filter((h) => h.appraisalDate)
    .map((h) => ({ ...h, dateKey: dayKey(h.appraisalDate) }))
    .sort((a, b) => a.dateKey - b.dateKey);

  if (!sorted.length) {
    const pendingDate = appraisal.nextAppraisalDate
      ? toDateOnly(appraisal.nextAppraisalDate)
      : null;

    appraisal.lastAppraisalDate =
      pendingDate && dayKey(pendingDate) <= today ? pendingDate : null;

    return appraisal;
  }

  const baseRent = Number(sorted[0].previousRent ?? fallbackBaseRent ?? 0);

  const dueEntries = sorted.filter((h) => h.dateKey <= today);
  const futureEntries = sorted.filter((h) => h.dateKey > today);

  appraisal.lastAppraisalDate =
    dueEntries.length > 0
      ? new Date(dueEntries[dueEntries.length - 1].appraisalDate)
      : null;

  const currentEntry =
    dueEntries.length > 0 ? dueEntries[dueEntries.length - 1] : null;

  appraisal.currentRent = currentEntry
    ? Number(currentEntry.newRent || currentEntry.previousRent || baseRent)
    : baseRent;

  const nextEntry = futureEntries.length > 0 ? futureEntries[0] : null;

  appraisal.nextAppraisalDate = nextEntry
    ? new Date(nextEntry.appraisalDate)
    : null;

  // ✅ FIXED — type/percentage/fixedAmount still show the UPCOMING
  // schedule's config (nextEntry preferred, falls back to
  // currentEntry) — this is just display metadata about the
  // appraisal rule, not the amount itself.
  const configEntry = nextEntry || currentEntry;
  if (configEntry) {
    appraisal.type = configEntry.type;
    appraisal.percentage = configEntry.percentage || 0;
    appraisal.fixedAmount = configEntry.fixedAmount || 0;
  }

  // ✅ FIXED — appraisalAmount/totalAppraisalAmount now ALWAYS come
  // from currentEntry (the currently ACTIVE/applied appraisal), never
  // from nextEntry. This is what was wrong before — a future entry's
  // amount (e.g. August's 54000) was leaking into the CURRENT display
  // even though that bump hasn't happened yet.
  if (currentEntry) {
    appraisal.appraisalAmount = Number(currentEntry.appraisalAmount || 0);
    appraisal.totalAppraisalAmount = Math.floor(
      Number(currentEntry.newRent || appraisal.currentRent || 0),
    );
  } else {
    appraisal.appraisalAmount = 0;
    appraisal.totalAppraisalAmount = Math.floor(
      Number(appraisal.currentRent || 0),
    );
  }

  return appraisal;
};

const getFrequencyMonths = (frequency, customMonths) => {
  // const EXTRA_BUFFER_MONTHS = 1; // every frequency gets +1 month added

  if (Number(frequency) === 4) {
    return Number(customMonths || 0) || 1;
    //  + EXTRA_BUFFER_MONTHS;
  }
  return (
    APPRAISAL_FREQUENCY_MONTHS_MAP[Number(frequency)] || 12
    // + EXTRA_BUFFER_MONTHS
  );
};
const autoScheduleFutureAppraisalEntries = (history, userName) => {
  if (!Array.isArray(history) || !history.length) return history;

  const today = todayKey();
  let safety = 0;

  while (safety < 60) {
    safety++;

    const sorted = [...history].sort(
      (a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate),
    );
    const lastEntry = sorted[sorted.length - 1];

    if (dayKey(lastEntry.appraisalDate) > today) break; // already future — stop

    const monthsToAdd = getFrequencyMonths(
      lastEntry.frequency,
      lastEntry.customFrequencyMonths,
    );

    const nextDate = new Date(lastEntry.appraisalDate);
    nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
    const nextDateOnly = toDateOnly(nextDate);

    const autoEntry = {
      appraisalDate: nextDateOnly,
      type: lastEntry.type,
      percentage: lastEntry.percentage || 0,
      fixedAmount: lastEntry.fixedAmount || 0,
      frequency: lastEntry.frequency,
      customFrequencyMonths: lastEntry.customFrequencyMonths || 0,
      previousRent: lastEntry.newRent || 0,
      appraisalAmount: 0,
      newRent: 0,
      updatedBy: userName,
      updatedAt: nowIST(),
    };

    if (dayKey(nextDateOnly) >= today) {
      autoEntry.appraisalAmount = computeAppraisalAmount(
        autoEntry,
        autoEntry.previousRent,
      );
    } else {
      autoEntry.appraisalAmount = 0;
    }
    autoEntry.newRent = Math.floor(
      autoEntry.previousRent + autoEntry.appraisalAmount,
    );

    history.push(autoEntry);
  }

  history.sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));
  return history;
};
const buildNextAppraisalEntry = (appliedEntry, userName) => {
  const monthsToAdd = getFrequencyMonths(
    appliedEntry.frequency,
    appliedEntry.customFrequencyMonths,
  );

  const nextDate = new Date(appliedEntry.appraisalDate);
  nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
  const nextDateOnly = toDateOnly(nextDate);

  const nextEntry = {
    appraisalDate: nextDateOnly,
    type: appliedEntry.type,
    percentage: appliedEntry.percentage || 0,
    fixedAmount: appliedEntry.fixedAmount || 0,
    frequency: appliedEntry.frequency,
    customFrequencyMonths: appliedEntry.customFrequencyMonths || 0,
    previousRent: appliedEntry.newRent || 0,
    appraisalAmount: 0,
    newRent: 0,
    updatedBy: userName,
    updatedAt: nowIST(),
  };

  nextEntry.appraisalAmount = computeAppraisalAmount(
    nextEntry,
    nextEntry.previousRent,
  );
  nextEntry.newRent = Math.floor(
    nextEntry.previousRent + nextEntry.appraisalAmount,
  );

  return nextEntry;
};
// ✅ NEW — REVERT rent (and every landOwner's share) back to the
// pre-appraisal base amount the instant appraisal.applicable flips
// from 1 -> 0 in THIS request. Without this, turning appraisal off
// left totalRentalAmount — and every landOwner's shareAmount — stuck
// at the last applied appraisal bump forever, since nothing else in
// this file undoes an appraisal once applied; applyAppraisalRentIfDuent
// only ever pushes rent UP when applicable === 1, it never runs (and
// never reverts anything) once applicable === 0.
const revertAppraisalRentIfTurnedOff = (mediaData, existingMedia) => {
  if (!existingMedia) return false;

  const wasApplicable = Number(existingMedia.appraisal?.applicable) === 1;
  const isNowApplicable = Number(mediaData.appraisal?.applicable) === 1;
  const wasHeld = Number(existingMedia.appraisal?.appraisalHold) === 1;
  const isNowHeld = Number(mediaData.appraisal?.appraisalHold) === 1;

  const wasEffectivelyActive = wasApplicable && !wasHeld;
  const isNowEffectivelyActive = isNowApplicable && !isNowHeld;
  // Only fires on the exact 1 -> 0 transition, in THIS request.
  if (!wasApplicable || isNowApplicable) return false;

  const history = Array.isArray(existingMedia.appraisal?.history)
    ? existingMedia.appraisal.history
    : [];

  const today = todayKey();

  // Same "currently active entry" lookup applyAppraisalRentIfDuent uses —
  // the latest entry whose appraisalDate has actually arrived.
  const dueEntries = history
    .filter((h) => h.appraisalDate && dayKey(h.appraisalDate) <= today)
    .sort((a, b) => new Date(b.appraisalDate) - new Date(a.appraisalDate));

  // previousRent on that entry IS the base rent from before this
  // appraisal bump was applied — exactly what we revert back to.
  const baseRent =
    dueEntries.length > 0
      ? Number(dueEntries[0].previousRent || 0)
      : Number(
          history[0]?.previousRent ??
            existingMedia.rentalPayment?.totalRentalAmount ??
            0,
        );

  if (!baseRent) return false;

  if (!mediaData.rentalPayment) mediaData.rentalPayment = {};
  mediaData.rentalPayment.totalRentalAmount = baseRent;

  return true;
};
// This is for Appraisal Amout based TotalRentalAmount Calculation
const applyAppraisalRentIfDuent = (
  mediaData,
  existingMedia,
  userName,
  rentActuallyChanged,
) => {
  const appraisal = mediaData.appraisal;
  if (!appraisal || Number(appraisal.applicable) !== 1) return false;

  if (Number(appraisal.appraisalHold) === 1) return false;
  if (!Array.isArray(appraisal.history) || !appraisal.history.length)
    return false;

  const today = todayKey();

  // Latest entry whose appraisalDate has actually arrived (today or past).
  const dueEntries = appraisal.history
    .filter((h) => h.appraisalDate && dayKey(h.appraisalDate) <= today)
    .sort((a, b) => new Date(b.appraisalDate) - new Date(a.appraisalDate));

  if (!dueEntries.length) return false;

  const latestDueEntry = dueEntries[0];
  const appraisedRent = Number(latestDueEntry.newRent || 0);
  if (!appraisedRent) return false;

  const currentTotalRentalAmount = Number(
    mediaData.rentalPayment?.totalRentalAmount ??
      existingMedia?.rentalPayment?.totalRentalAmount ??
      0,
  );

  // Already applied (or already matches) — nothing to do this time.
  if (appraisedRent === currentTotalRentalAmount) return false;

  if (!mediaData.rentalPayment) mediaData.rentalPayment = {};
  mediaData.rentalPayment.totalRentalAmount = appraisedRent;
  const landOwnersForScale = Array.isArray(mediaData.landOwners)
    ? mediaData.landOwners
    : existingMedia?.landOwners
      ? JSON.parse(JSON.stringify(existingMedia.landOwners))
      : [];

  if (currentTotalRentalAmount > 0) {
    scaleLandOwnersForRentChange(
      landOwnersForScale,
      currentTotalRentalAmount,
      appraisedRent,
    );
    mediaData.landOwners = landOwnersForScale;
  }
  // Track this exactly like a manual rent change, in the SAME history array.
  let history = Array.isArray(mediaData.rentalPayment.rentalAmountHistory)
    ? mediaData.rentalPayment.rentalAmountHistory
    : existingMedia
      ? (existingMedia.rentalPayment?.rentalAmountHistory || []).map((h) =>
          h.toObject ? h.toObject() : { ...h },
        )
      : [];

  history.push({
    amount: appraisedRent,
    updatedBy: `${userName} (Appraisal applied - ${dateString(latestDueEntry.appraisalDate)})`,
    updatedAt: nowIST(),
  });

  history.sort((a, b) => b.updatedAt - a.updatedAt);
  mediaData.rentalPayment.rentalAmountHistory = history;
  return true;
};
const applyOwnerApprovalBillingShift = (mediaData, media, userName) => {
  const isOwnerApprovalNow =
    mediaData.rentalStatus !== undefined &&
    Number(mediaData.rentalStatus) === 3 &&
    Number(media.rentalStatus) !== 3;

  if (!isOwnerApprovalNow) return false;

  const existingNextBillingDate = media.rentalPayment?.nextBillingDate;
  if (!existingNextBillingDate) return false;

  const paymentFrequency = Number(
    mediaData.rentalPayment?.paymentFrequency ??
      media.rentalPayment?.paymentFrequency ??
      1,
  );
  const customPaymentFrequency = Number(
    mediaData.rentalPayment?.customPaymentFrequency ??
      media.rentalPayment?.customPaymentFrequency ??
      0,
  );

  if (!mediaData.rentalPayment) mediaData.rentalPayment = {};

  const frequencyMap = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
  const monthsToAdd =
    paymentFrequency === 6
      ? customPaymentFrequency || 1
      : frequencyMap[paymentFrequency] || 1;

  // The cycle that was just approved becomes the new "last paid" date.
  const newLastBillPaidDate = toDateOnly(existingNextBillingDate);

  // Roll forward one cycle from there.
  const nextDate = new Date(newLastBillPaidDate);
  nextDate.setMonth(nextDate.getMonth() + monthsToAdd);
  const newNextBillingDate = toDateOnly(nextDate);

  mediaData.rentalPayment.lastBillPaidDate = newLastBillPaidDate;
  mediaData.rentalPayment.nextBillingDate = newNextBillingDate;

  return true;
};
const handleAgreementHistory = (mediaData, existingMedia, userName) => {
  if (!mediaData.agreement) return;

  const incoming = mediaData.agreement;
  const existing = existingMedia?.agreement;

  const isNew = !existingMedia;

  // Detect whether totalRentalAmount inside agreement.rentalPayment changed.
  const incomingRentAmt = Number(
    incoming.rentalPayment?.totalRentalAmount ?? 0,
  );
  const existingRentAmt = Number(
    existing?.rentalPayment?.totalRentalAmount ?? 0,
  );
  const agreementRentChanged = isNew || incomingRentAmt !== existingRentAmt;

  // Step 4: stamp updatedAt/updatedBy on agreement.rentalPayment when amount changes.
  if (agreementRentChanged) {
    if (!incoming.rentalPayment) incoming.rentalPayment = {};
    incoming.rentalPayment.updatedBy = userName;
    incoming.rentalPayment.updatedAt = nowIST();
  } else if (existing?.rentalPayment?.updatedAt) {
    // Carry forward the existing stamp if nothing changed.
    if (!incoming.rentalPayment) incoming.rentalPayment = {};
    incoming.rentalPayment.updatedBy =
      incoming.rentalPayment.updatedBy ?? existing.rentalPayment.updatedBy;
    incoming.rentalPayment.updatedAt =
      incoming.rentalPayment.updatedAt ?? existing.rentalPayment.updatedAt;
  }

  // Decide whether to push an agreement history snapshot.
  const startChanged =
    isNew ||
    !existing?.startDate ||
    dayKey(incoming.startDate) !== dayKey(existing.startDate);
  const endChanged =
    isNew ||
    !existing?.endDate ||
    dayKey(incoming.endDate) !== dayKey(existing.endDate);

  if (!isNew && !startChanged && !endChanged) return;

  const snapshot = {
    startDate: incoming.startDate,
    endDate: incoming.endDate,
    reminderBeforeExpiry: incoming.reminderBeforeExpiry,
    advanceRent: incoming.advanceRent ?? 0,
    status: incoming.status ?? 1,
    agreementPDF: incoming.agreementPDF,
    reason: incoming.reason,
    rentalPayment: {
      totalRentalAmount: incomingRentAmt,
      paymentFrequency: incoming.rentalPayment?.paymentFrequency ?? 1,
      customPaymentFrequency:
        Number(incoming.rentalPayment?.paymentFrequency) === 6
          ? (incoming.rentalPayment?.customPaymentFrequency ?? null)
          : null,
      // Step 4: include who changed the rental amount in the history snapshot too.
      updatedBy: incoming.rentalPayment?.updatedBy ?? userName,
      updatedAt: incoming.rentalPayment?.updatedAt ?? nowIST(),
    },
    updatedBy: userName,
    uploadedAt: nowIST(),
  };

  if (!mediaData.agreementHistory) {
    mediaData.agreementHistory = existingMedia?.agreementHistory
      ? JSON.parse(JSON.stringify(existingMedia.agreementHistory))
      : [];
  }

  mediaData.agreementHistory.push(snapshot);
};

const computeAgreementStatus = (startDate, endDate, reminderDays) => {
  if (!startDate || !endDate) return 1;
  const daysUntilExpiry = Math.floor(
    (dayKey(endDate) - todayKey()) / (1000 * 60 * 60 * 24),
  );
  if (daysUntilExpiry < 0) return 3;
  if (daysUntilExpiry <= reminderDays) return 2;
  return 1;
};
// This is for rental GST & Landowner Based GST Applicable New Flag Added Function
const detectInitialGstApplicableFlag = (mediaData) => {
  const rentalGstApplicable =
    Number(mediaData.rentalPayment?.gstApplicable) === 1;

  const anyOwnerGstApplicable = Array.isArray(mediaData.landOwners)
    ? mediaData.landOwners.some((o) => Number(o.gstApplicable) === 1)
    : false;

  return rentalGstApplicable || anyOwnerGstApplicable ? 2 : 0;
};
// This is for Media Onboarding Save
const mediaOnboarding = async (req, res) => {
  try {
    const { id } = req.body;
    const mediaData = req.body;
    const userName = req.user?.userName || "Admin";

    const jsonFields = [
      "landOwners",
      "rentalPayment",
      "agreement",
      "appraisal",
       "gstOutstandingHistory", 
    ];
    jsonFields.forEach((field) => {
      if (mediaData[field] && typeof mediaData[field] === "string") {
        try {
          mediaData[field] = JSON.parse(mediaData[field]);
        } catch {
          /* leave as-is */
        }
      }
    });
if (
  mediaData.rentalPayment &&
  typeof mediaData.rentalPayment.gstOutstandingHistory === "string"
) {
  try {
    mediaData.rentalPayment.gstOutstandingHistory = JSON.parse(
      mediaData.rentalPayment.gstOutstandingHistory,
    );
  } catch {
    mediaData.rentalPayment.gstOutstandingHistory = [];
  }
}
if (Array.isArray(mediaData.rentalPayment?.gstOutstandingHistory)) {
  mediaData.rentalPayment.gstOutstandingHistory =
    mediaData.rentalPayment.gstOutstandingHistory.map((item) => ({
      ...item,
      gstOutStandingAmount: Number(item?.gstOutStandingAmount || 0),
    }));
}
    if (mediaData.rentalPayment) {
      if (mediaData.rentalPayment.totalRentalAmount !== undefined)
        mediaData.rentalPayment.totalRentalAmount = Number(
          mediaData.rentalPayment.totalRentalAmount,
        );
      if (mediaData.rentalPayment.paymentFrequency)
        mediaData.rentalPayment.paymentFrequency = Number(
          mediaData.rentalPayment.paymentFrequency,
        );
      if (mediaData.rentalPayment.customPaymentFrequency !== undefined)
        mediaData.rentalPayment.customPaymentFrequency = Number(
          mediaData.rentalPayment.customPaymentFrequency,
        );
      // if (mediaData.rentalPayment.tdsApplicable !== undefined)
      //   mediaData.rentalPayment.tdsApplicable = Number(
      //     mediaData.rentalPayment.tdsApplicable,
      //   );
      if (mediaData.rentalPayment.gstApplicable !== undefined)
        mediaData.rentalPayment.gstApplicable = Number(
          mediaData.rentalPayment.gstApplicable,
        );
          if (mediaData.rentalPayment.outStantStatus !== undefined)
    mediaData.rentalPayment.outStantStatus = Number(
      mediaData.rentalPayment.outStantStatus,
    );
    }

    const getFileByFieldName = (fieldName) => {
      if (!req.files) return null;
      const file = req.files.find((f) => f.fieldname === fieldName);
      return file || null;
    };
    // req.files is now a flat array of { fieldname, ... }
    const files = req.files || [];

    // matches "landOwners[3][bankPassbook]" -> index "3"
    const parseLandOwnerFile = (fieldname) => {
      const match = fieldname.match(
        /^landOwners\[(\d+)\]\[(bankPassbook|cancelCheckLeaf|panCardImage|aadharCardImage|pancardImage|AAdharCardImage|cancelcheck leaf)\]$/,
      );
      return match ? { index: Number(match[1]), key: match[2] } : null;
    };

    const findOtherFile = (fieldName) =>
      files.find((f) => f.fieldname === fieldName);
    const OWNER_FILE_FIELDS = [
      "bankPassbook",
      "cancelCheckLeaf",
      "panCardImage",
      "aadharCardImage",
    ];
    const FILE_OBJECT_FIELDS = [
      "frontView",
      "sideView",
      "locationView",
      "additionalImages",
    ];
    if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
      const hasValue = (v) => v !== undefined && v !== null && v !== "";
      const ownerFileMap = {};
      files.forEach((f) => {
        const parsed = parseLandOwnerFile(f.fieldname);
        if (parsed) {
          ownerFileMap[parsed.index] = ownerFileMap[parsed.index] || {};
          ownerFileMap[parsed.index][parsed.key] = f;
        }
      });
       const resolveOwnerImageValue = (fieldValue) => {
        if (typeof fieldValue !== "string") return null;
        const urlValue = fieldValue.trim();
        if (!urlValue.startsWith("http")) return null;
        return {
          originalName: urlValue.split("/").pop(),
          fileName: urlValue.split("/").pop(),
          filePath: urlValue,
          mimeType: null,
          size: null,
          fileType: "image",
          uploadedAt: nowIST(),
        };
      };

      mediaData.landOwners = mediaData.landOwners.map((owner, index) => {
        const ownerFiles = ownerFileMap[index] || {};

        // ✅ FIXED — binary file first, URL string fallback second, for
        // each of the 4 owner image fields. Supports alternate names from frontend.
        if (ownerFiles.bankPassbook) {
          owner.bankPassbook = req.processFile(ownerFiles.bankPassbook);
        } else {
          const urlObj = resolveOwnerImageValue(owner.bankPassbook);
          if (urlObj) owner.bankPassbook = urlObj;
        }

        const cancelCheckFile = ownerFiles.cancelCheckLeaf || ownerFiles["cancelcheck leaf"];
        const cancelCheckInput = owner.cancelCheckLeaf || owner["cancelcheck leaf"];
        if (cancelCheckFile) {
          owner.cancelCheckLeaf = req.processFile(cancelCheckFile);
        } else {
          const urlObj = resolveOwnerImageValue(cancelCheckInput);
          if (urlObj) owner.cancelCheckLeaf = urlObj;
        }

        const panFile = ownerFiles.panCardImage || ownerFiles.pancardImage;
        const panInput = owner.panCardImage || owner.pancardImage;
        if (panFile) {
          owner.panCardImage = req.processFile(panFile);
        } else {
          const urlObj = resolveOwnerImageValue(panInput);
          if (urlObj) owner.panCardImage = urlObj;
        }

        const aadharFile = ownerFiles.aadharCardImage || ownerFiles.AAdharCardImage;
        const aadharInput = owner.aadharCardImage || owner.AAdharCardImage;
        if (aadharFile) {
          owner.aadharCardImage = req.processFile(aadharFile);
        } else {
          const urlObj = resolveOwnerImageValue(aadharInput);
          if (urlObj) owner.aadharCardImage = urlObj;
        }

        // Cleanup alternate names to avoid cluttering DB
        delete owner.pancardImage;
        delete owner.AAdharCardImage;
        delete owner["cancelcheck leaf"];
        // const OWNER_FILE_FIELDS = [
        //   "bankPassbook",
        //   "cancelCheckLeaf",
        //   "panCardImage",
        // ];
        // OWNER_FILE_FIELDS.forEach((field) => {
        //   if (owner[field] !== undefined && typeof owner[field] === "string") {
        //     delete owner[field];
        //   }
        // });
        return {
          ...owner,
          typeShare: hasValue(owner.typeShare)
            ? Number(owner.typeShare)
            : undefined,
          sharePercentage: hasValue(owner.sharePercentage)
            ? Number(owner.sharePercentage)
            : undefined,
          shareAmount: hasValue(owner.shareAmount)
            ? Number(owner.shareAmount)
            : undefined,
          paymentCategory: hasValue(owner.paymentCategory)
            ? Number(owner.paymentCategory)
            : undefined,
          onlineMode: hasValue(owner.onlineMode)
            ? Number(owner.onlineMode)
            : undefined,
          cashAmount: hasValue(owner.cashAmount)
            ? Number(owner.cashAmount)
            : undefined,
          onlineAmount: hasValue(owner.onlineAmount)
            ? Number(owner.onlineAmount)
            : undefined,
          tdsApplicable: hasValue(owner.tdsApplicable)
            ? Number(owner.tdsApplicable)
            : undefined,
          tdsPercentage: hasValue(owner.tdsPercentage)
            ? Number(owner.tdsPercentage)
            : undefined,
          tdsAmount: hasValue(owner.tdsAmount) ? Number(owner.tdsAmount) : undefined,
          gstApplicable: hasValue(owner.gstApplicable)
            ? Number(owner.gstApplicable)
            : undefined,
          gstPercentage: hasValue(owner.gstPercentage)
            ? Number(owner.gstPercentage)
            : undefined,
          gstAmount: hasValue(owner.gstAmount) ? Number(owner.gstAmount) : undefined,
          totalAmountWithGst: hasValue(owner.totalAmountWithGst)
            ? Number(owner.totalAmountWithGst)
            : undefined,
        };
      });
    }
    if (mediaData.landOwners?.length === 1) {
      const owner = mediaData.landOwners[0];
      if (!owner.typeShare) {
        owner.typeShare = 1;
        owner.sharePercentage = 100;
      }
    }

    if (mediaData.agreement) {
      if (mediaData.agreement.startDate) {
        mediaData.agreement.startDate = toDateOnly(
          mediaData.agreement.startDate,
        );
      }
      if (mediaData.agreement.endDate) {
        mediaData.agreement.endDate = toDateOnly(mediaData.agreement.endDate);
      }
      if (mediaData.agreement.reminderBeforeExpiry)
        mediaData.agreement.reminderBeforeExpiry = Number(
          mediaData.agreement.reminderBeforeExpiry,
        );
      if (mediaData.rentalPayment) {
        mediaData.agreement.rentalPayment = {
          totalRentalAmount: mediaData.rentalPayment.totalRentalAmount || 0,
          paymentFrequency: mediaData.rentalPayment.paymentFrequency || 1,
          customPaymentFrequency:
            mediaData.rentalPayment.customPaymentFrequency || 0,
        };
      }
      mediaData.agreement.updatedBy = userName;
    }

    if (mediaData.rentalPayment?.lastBillPaidDate) {
      mediaData.rentalPayment.lastBillPaidDate = toDateOnly(
        mediaData.rentalPayment.lastBillPaidDate,
      );
    }
    if (mediaData.rentalPayment?.nextBillingDate) {
      mediaData.rentalPayment.nextBillingDate = toDateOnly(
        mediaData.rentalPayment.nextBillingDate,
      );
    }
    if (mediaData.rentalPayment?.billingStartDate) {
      mediaData.rentalPayment.billingStartDate = toDateOnly(
        mediaData.rentalPayment.billingStartDate,
      );
    }

    if (mediaData.appraisal) {
      if (mediaData.appraisal.applicable !== undefined)
        mediaData.appraisal.applicable = Number(mediaData.appraisal.applicable);
      if (mediaData.appraisal.type)
        mediaData.appraisal.type = Number(mediaData.appraisal.type);
      if (mediaData.appraisal.percentage)
        mediaData.appraisal.percentage = Number(mediaData.appraisal.percentage);
      if (mediaData.appraisal.fixedAmount)
        mediaData.appraisal.fixedAmount = Number(
          mediaData.appraisal.fixedAmount,
        );
      if (mediaData.appraisal.frequency)
        mediaData.appraisal.frequency = Number(mediaData.appraisal.frequency);
      if (mediaData.appraisal.customFrequencyMonths)
        mediaData.appraisal.customFrequencyMonths = Number(
          mediaData.appraisal.customFrequencyMonths,
        );
      if (mediaData.appraisal.nextAppraisalDate) {
        mediaData.appraisal.nextAppraisalDate = toDateOnly(
          mediaData.appraisal.nextAppraisalDate,
        );
      }
      if (mediaData.appraisal.lastAppraisalDate) {
        mediaData.appraisal.lastAppraisalDate = toDateOnly(
          mediaData.appraisal.lastAppraisalDate,
        );
      }
    }

    if (mediaData.width) mediaData.width = Number(mediaData.width);
    if (mediaData.height) mediaData.height = Number(mediaData.height);
    if (mediaData.status) mediaData.status = Number(mediaData.status);
    if (mediaData.numberOfLandOwners)
      mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);
    if (mediaData.siteBillMode)
      mediaData.siteBillMode = Number(mediaData.siteBillMode);
    let existingMediaForValidation = null;
    if (id) {
      existingMediaForValidation = await MediaOnboarding.findById(id);
      if (!existingMediaForValidation) {
        return errorResponse(res, "Media not found with this ID", null, 404);
      }
      if (existingMediaForValidation.appraisal) {
        const existingAppraisalPlain = JSON.parse(
          JSON.stringify(existingMediaForValidation.appraisal),
        );

        mediaData.appraisal = {
          ...existingAppraisalPlain,
          ...(mediaData.appraisal || {}),
          // history is backend-computed — never take it from the
          // request payload here. Let handleAppraisalLogic (below)
          // recompute it fresh from the existing history it reads via
          // existingMedia.appraisal.history internally.
          history: existingAppraisalPlain.history || [],
        };
      }
    }
    // ✅ NEW — restore missing financial/profile fields for existing
    // owners from the database BEFORE scaling and validation. Without
    // this, partial updates (e.g. only changing the owner's phone)
    // would wipe out onlineAmount/cashAmount/GST/TDS fields since they
    // default to undefined in the map() above.
    if (existingMediaForValidation && Array.isArray(mediaData.landOwners)) {
      mediaData.landOwners.forEach((owner, idx) => {
        const existing = existingMediaForValidation.landOwners?.[idx];
        if (!existing) return;

        const FIELDS_TO_RESTORE = [
          "typeShare",
          "sharePercentage",
          "shareAmount",
          "paymentCategory",
          "onlineMode",
          "cashAmount",
          "onlineAmount",
          "tdsApplicable",
          "tdsPercentage",
          "tdsAmount",
          "gstApplicable",
          "gstPercentage",
          "gstAmount",
          "totalAmountWithGst",
          "phone",
          "bankName",
          "ifsc",
          "accountNumber",
          "upiId",
          "panNumber",
          "aadharCardNumber",
          "eligibleMode",
          "landOwnerBillMode",
        ];

        FIELDS_TO_RESTORE.forEach((field) => {
          if (owner[field] === undefined && existing[field] !== undefined) {
            owner[field] = existing[field];
          }
        });

        // Special handling for file objects — restore if missing, null,
        // empty string, or an unconverted URL string.
        OWNER_FILE_FIELDS.forEach((field) => {
          const val = owner[field];
          if (
            val === undefined ||
            val === null ||
            val === "" ||
            typeof val === "string"
          ) {
            if (existing[field]) {
              owner[field] = existing[field];
            }
          }
        });

        // Preserve _id too for validation/matching
        if (!owner._id && existing._id) {
          owner._id = existing._id;
        }
      });
    }

    if (id) {
      revertAppraisalRentIfTurnedOff(mediaData, existingMediaForValidation);
    }
    // ✅ NEW — auto-rescale landOwners proportionally BEFORE validation,
    // whenever totalRentalAmount changed on update. This fixes the bug
    // where a rent-amount edit (manual OR via appraisal) combined with
    // STALE landOwner split figures (still matching the OLD amount)
    // was correctly rejected by validateLandOwnerShares/
    // validateOwnerPaymentCategories — since nothing rescaled the
    // owners' cashAmount/onlineAmount/fixed shareAmount until AFTER
    // validation already ran (inside applyAppraisalRentIfDuent, which
    // only fires for appraisal-triggered changes, and only runs post-
    // validation). Now this happens up front, for ANY totalRentalAmount
    // change (manual or appraisal-triggered), so validation always sees
    // figures that are already proportionally consistent.
    if (
      existingMediaForValidation &&
      mediaData.rentalPayment?.totalRentalAmount !== undefined &&
      Array.isArray(mediaData.landOwners) &&
      mediaData.landOwners.length > 0
    ) {
      const oldAmount = Number(
        existingMediaForValidation.rentalPayment?.totalRentalAmount || 0,
      );
      const newAmount = Number(mediaData.rentalPayment.totalRentalAmount);

      if (oldAmount > 0 && oldAmount !== newAmount) {
        scaleLandOwnersForRentChange(
          mediaData.landOwners,
          oldAmount,
          newAmount,
        );
      }
    }

    if (mediaData.rentalPayment) {
      const gstCheck = validateGst(mediaData.rentalPayment);
      if (!gstCheck.valid)
        return errorResponse(res, gstCheck.message, null, 400);
    }
 if (mediaData.rentalPayment) {
      mediaData.rentalPayment = processGstOutstandingHistory(
        mediaData.rentalPayment,
        userName
      );
    }
    // if (
    //   mediaData.landOwners?.length &&
    //   mediaData.rentalPayment?.totalRentalAmount
    // ) {
    //   const tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable) || 0;
    //   const envTdsPercent = Math.floor(process.env.TDS_PERCENTAGE || "0");
    //   const tdsPercentage =
    //     tdsApplicable === 1
    //       ? envTdsPercent > 0
    //         ? envTdsPercent
    //         : Number(mediaData.rentalPayment.tdsPercentage || 0)
    //       : 0;
    //   const rentalGstApplicable =
    //     Number(mediaData.rentalPayment.gstApplicable) || 0;

    //   const shareCheck = validateLandOwnerShares(
    //     mediaData.landOwners,
    //     Number(mediaData.rentalPayment.totalRentalAmount),
    //     tdsApplicable,
    //     tdsPercentage,
    //     rentalGstApplicable,
    //   );
    //   if (!shareCheck.valid)
    //     return errorResponse(res, shareCheck.message, null, 400);

    //   const pmCatCheck = validateOwnerPaymentCategories(
    //     mediaData.landOwners,
    //     shareCheck.netPayable,
    //     rentalGstApplicable,
    //   );
    //   if (!pmCatCheck.valid)
    //     return errorResponse(res, pmCatCheck.message, null, 400);
    // }
    if (
      mediaData.landOwners?.length &&
      mediaData.rentalPayment?.totalRentalAmount
    ) {
      const rentalGstApplicable =
        Number(mediaData.rentalPayment.gstApplicable) || 0;

      // ✅ FIXED — no more tdsApplicable/tdsPercentage passed in; TDS is
      // validated per-owner inside validateLandOwnerShares now.
      const shareCheck = validateLandOwnerShares(
        mediaData.landOwners,
        Number(mediaData.rentalPayment.totalRentalAmount),
        rentalGstApplicable,
      );
      if (!shareCheck.valid)
        return errorResponse(res, shareCheck.message, null, 400);

      const pmCatCheck = validateOwnerPaymentCategories(
        mediaData.landOwners,
        shareCheck.netPayable,
        rentalGstApplicable,
      );
      if (!pmCatCheck.valid)
        return errorResponse(res, pmCatCheck.message, null, 400);
    }
    if (mediaData.appraisal && mediaData.agreement) {
      const appraisalCheck = validateAppraisalFrequency(
        mediaData.agreement,
        mediaData.appraisal,
      );
      if (!appraisalCheck.valid)
        return errorResponse(res, appraisalCheck.message, null, 400);
    }

    // const uploadedAgreementPDF = req.files?.agreementPDF?.[0];
    // if (uploadedAgreementPDF) {
    //   if (!mediaData.agreement) mediaData.agreement = {};
    //   mediaData.agreement.agreementPDF = req.processFile(uploadedAgreementPDF);
    // }
    // if (req.files?.frontView?.[0])
    //   mediaData.frontView = req.processFile(req.files.frontView[0]);
    // if (req.files?.sideView?.[0])
    //   mediaData.sideView = req.processFile(req.files.sideView[0]);
    // if (req.files?.locationView?.[0])
    //   mediaData.locationView = req.processFile(req.files.locationView[0]);
    // if (req.files?.additionalImages?.[0])
    //   mediaData.additionalImages = req.processFile(
    //     req.files.additionalImages[0],
    //   );
    const uploadedAgreementPDF = findOtherFile("agreement[agreementPDF]");
    if (uploadedAgreementPDF) {
      if (!mediaData.agreement) mediaData.agreement = {};
      mediaData.agreement.agreementPDF = req.processFile(uploadedAgreementPDF);
    }

    const frontViewFile = findOtherFile("frontView");
    if (frontViewFile) mediaData.frontView = req.processFile(frontViewFile);

    const sideViewFile = findOtherFile("sideView");
    if (sideViewFile) mediaData.sideView = req.processFile(sideViewFile);

    const locationViewFile = findOtherFile("locationView");
    if (locationViewFile)
      mediaData.locationView = req.processFile(locationViewFile);
    const additionalImagesFile = findOtherFile("additionalImages");
    if (additionalImagesFile)
      mediaData.additionalImages = req.processFile(additionalImagesFile);
    // const FILE_OBJECT_FIELDS = [
    //   "frontView",
    //   "sideView",
    //   "locationView",
    //   "additionalImages",
    // ];
    FILE_OBJECT_FIELDS.forEach((field) => {
      if (
        mediaData[field] !== undefined &&
        typeof mediaData[field] === "string"
      ) {
        const urlValue = mediaData[field].trim();
        if (urlValue.startsWith("http")) {
          mediaData[field] = {
            originalName: urlValue.split("/").pop(),
            fileName: urlValue.split("/").pop(),
            filePath: urlValue,
            mimeType: null,
            size: null,
            fileType: "image",
            uploadedAt: nowIST(),
          };
        } else {
          delete mediaData[field];
        }
      }
    });

    // Same problem can occur for agreement.agreementPDF since `agreement` is
    // replaced wholesale — guard it too.
    // if (
    //   mediaData.agreement &&
    //   typeof mediaData.agreement.agreementPDF === "string"
    // ) {
    //   delete mediaData.agreement.agreementPDF;
    // }
    let media;
    let isNew = false;

    if (id) {
      // ── UPDATE ──────────────────────────────────────────────────────────
      // media = await MediaOnboarding.findById(id);
      // if (!media)
      //   return errorResponse(res, "Media not found with this ID", null, 404);
      media = existingMediaForValidation;
      delete mediaData.id;

      if (mediaData.agreement) {
        const pdf = mediaData.agreement.agreementPDF;

        // Case 1: already a proper file object (fresh upload via
        // findOtherFile/processFile earlier, or the frontend echoed
        // back the previously-saved object) — keep as-is.
        const isValidFileObject =
          pdf && typeof pdf === "object" && (pdf.fileName || pdf.filePath);

        // Case 2: frontend sent a URL string instead of a binary
        // upload (e.g. re-selecting the already-uploaded doc).
        const isUrlString =
          typeof pdf === "string" && /^https?:\/\/.+/i.test(pdf.trim());

        if (isValidFileObject) {
          // keep as-is
        } else if (isUrlString) {
          const trimmedUrl = pdf.trim();
          const urlFileName = trimmedUrl.split("/").pop() || "agreement.pdf";

          mediaData.agreement.agreementPDF = {
            originalName: urlFileName,
            fileName: urlFileName,
            filePath: trimmedUrl,
            mimeType: "application/pdf",
            size: media.agreement?.agreementPDF?.size || 0,
            fileType: "pdf",
            uploadedAt:
              media.agreement?.agreementPDF?.filePath === trimmedUrl
                ? media.agreement?.agreementPDF?.uploadedAt || nowIST()
                : nowIST(),
          };
        } else if (media.agreement?.agreementPDF) {
          // Case 3: nothing new sent, but an existing DB value exists
          // — preserve it.
          mediaData.agreement.agreementPDF = media.agreement.agreementPDF;
        } else {
          // Case 4: nothing new sent AND no existing DB value either.
          // DELETE the key entirely instead of assigning `undefined`
          // to it — assigning explicit `undefined` as a key value
          // causes Mongoose to attempt casting it against the
          // agreementPDF sub-schema on save, throwing a CastError.
          // Deleting leaves the key simply absent, which Mongoose
          // handles cleanly.
          delete mediaData.agreement.agreementPDF;
        }
      }
      // if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
      //   mediaData.landOwners.forEach((owner, idx) => {
      //     const existingOwner = media.landOwners?.[idx];
      //     OWNER_FILE_FIELDS.forEach((field) => {
      //       if (typeof owner[field] === "string") {
      //         owner[field] = existingOwner ? existingOwner[field] : undefined;
      //       }
      //     });
      //   });
      // }
      if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
        mediaData.landOwners.forEach((owner, idx) => {
          const existingOwner = media.landOwners?.[idx];

          // ✅ NEW — preserve the EXISTING owner's real _id, matched by
          // array position, whenever the frontend doesn't send a valid
          // matching _id (or sends none at all). Without this, Mongoose
          // silently generates a BRAND-NEW _id for the owner subdocument on
          // every update — permanently orphaning every ledger/GST/TDS
          // record that was already tied to the owner's original _id.
          if (existingOwner) {
            const sentIdMatchesExisting =
              owner._id && String(owner._id) === String(existingOwner._id);

            if (!sentIdMatchesExisting) {
              owner._id = existingOwner._id;
            }
          }
        });
      }
      // ✅ ADDED — Media → LandOwnerMaster sync. For any owner that's
      // already linked (has landOwnerMasterId), push this property's
      // edits (name, amounts, GST/TDS, etc.) into the linked Master
      // record. Owners without a landOwnerMasterId are skipped.
      if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
        const mediaInfo = {
          mediaId: media._id,
          mediaCode: mediaData.mediaCode || media.mediaCode,
          mediaName: mediaData.mediaName || media.mediaName,
          siteBillMode: mediaData.siteBillMode || media.siteBillMode,
        };

        for (const owner of mediaData.landOwners) {
          const linkedMaster = await syncOrLinkMediaOwnerToMaster(
            owner,
            userName,
            null,
            mediaInfo,
          );

          // ✅ ADDED — pull this owner's OTHER sites from the Master's
          // linkedSites (which sync just upserted THIS site into),
          // filtering THIS site out, and denormalize onto the Media
          // doc's embedded owner for display.
          if (linkedMaster && Array.isArray(linkedMaster.linkedSites)) {
            // const otherSites = linkedMaster.linkedSites.filter(
            //   (site) => String(site.mediaId) !== String(mediaInfo.mediaId),
            // );
            const otherSites = linkedMaster.linkedSites;
            // ✅ CHANGED — full field parity with LandOwnerMaster.linkedSites
            owner.linkedSites = otherSites.map((site) => ({
              mediaId: site.mediaId,
              mediaCode: site.mediaCode,
              mediaName: site.mediaName,
              siteBillMode: site.siteBillMode,
              paymentCategory: site.paymentCategory,
              shareAmount: site.shareAmount,
              cashAmount: site.cashAmount,
              onlineAmount: site.onlineAmount,
              updatedAt: site.updatedAt,
            }));
            owner.linkedMediaCount = otherSites.length;
          } else {
            owner.linkedSites = [];
            owner.linkedMediaCount = 0;
          }
        }

        mediaData.landOwnerMasterIds = mediaData.landOwners
          .map((o) => o.landOwnerMasterId)
          .filter(Boolean);
      }

      // Step 1 & 2: track totalRentalAmount change; get the effective base rent.
      const { currentBaseRent, rentActuallyChanged } =
        handleRentalAmountHistory(mediaData, media, userName);
      mediaData.gstApplicableFlag = detectInitialGstApplicableFlag(mediaData);
      // Step 3: pass both so appraisal logic knows whether to rebase future entries.
      await handleAppraisalLogic(
        mediaData,
        media,
        userName,
        currentBaseRent,
        rentActuallyChanged,
      );

      if (mediaData.appraisal) {
        recomputeAppraisalSummary(mediaData.appraisal, currentBaseRent);
      }

      // Step 4: handle agreement history with updatedBy/updatedAt on rentalPayment.
      applyAppraisalRentIfDuent(mediaData, media, userName, rentActuallyChanged);

      applyOwnerApprovalBillingShift(mediaData, media, userName);
      if (mediaData.rentalPayment && mediaData.agreement) {
        const pf = mediaData.rentalPayment.paymentFrequency || 1;
         const existingHistory = mediaData.rentalPayment.gstOutstandingHistory || [];
        mediaData.agreement.rentalPayment = {
          totalRentalAmount: mediaData.rentalPayment.totalRentalAmount || 0,
          paymentFrequency: pf,
          // Only set customPaymentFrequency when frequency is actually Custom (6).
          // Leaving it undefined otherwise avoids tripping the schema's `min: 1`
          // validator, since `required` only applies when paymentFrequency === 6.
          ...(pf === 6 && mediaData.rentalPayment.customPaymentFrequency
            ? {
                customPaymentFrequency: Number(
                  mediaData.rentalPayment.customPaymentFrequency,
                ),
              }
            : {}),
             gstOutstandingHistory: existingHistory,
        };
      }
      handleAgreementHistory(mediaData, media, userName);

      // ✅ FIXED — manage billingStartDate (the cycle-walking anchor).
      // If the user manually edits lastBillPaidDate in the property
      // settings (incoming !== existing), we treat it as a manual
      // anchor shift and update billingStartDate to match. Otherwise,
      // we preserve the existing billingStartDate to ensure cycle
      // stability (e.g. keeping the 31st as the anchor even after a
      // Feb 28th automatic bill update).
      if (!mediaData.rentalPayment) mediaData.rentalPayment = {};

      const incomingLBP = mediaData.rentalPayment?.lastBillPaidDate;
      const existingLBP = media.rentalPayment?.lastBillPaidDate
        ? toDateOnly(media.rentalPayment.lastBillPaidDate).getTime()
        : null;
      const existingBSD = media.rentalPayment?.billingStartDate
        ? toDateOnly(media.rentalPayment.billingStartDate)
        : null;

      if (incomingLBP) {
        const incomingTime = toDateOnly(incomingLBP).getTime();

        if (incomingTime !== existingLBP) {
          // Manual change detected — update anchor to follow the user's shift.
          mediaData.rentalPayment.billingStartDate = toDateOnly(incomingLBP);
        } else if (existingBSD) {
          // No manual change — preserve the stable anchor.
          mediaData.rentalPayment.billingStartDate = existingBSD;
        }
      } else if (existingBSD) {
        mediaData.rentalPayment.billingStartDate = existingBSD;
      }

      Object.keys(mediaData).forEach((key) => {
        if (!["_id", "__v", "createdAt", "updatedAt", "mediaId"].includes(key)) {
          media[key] = mediaData[key];
        }
      });
      media.updatedAt = nowIST();
      await media.save({ timestamps: false });
      await MediaOnboarding.syncBillingCycles();
      media = await MediaOnboarding.findById(media._id).lean();
      if (media.landOwners && Array.isArray(media.landOwners)) {
        for (const savedOwner of media.landOwners) {
          if (savedOwner.landOwnerMasterId) {
            await correctLinkedSiteAmounts(
              savedOwner.landOwnerMasterId,
              media._id,
              savedOwner,
              null,
            );
          }
        }
      }
    } else {
      // ── CREATE ──────────────────────────────────────────────────────────
      isNew = true;
       if (
      mediaData.agreement &&
      typeof mediaData.agreement.agreementPDF === "string"
    ) {
      const urlValue = mediaData.agreement.agreementPDF.trim();
      if (urlValue.startsWith("http")) {
        mediaData.agreement.agreementPDF = {
          originalName: urlValue.split("/").pop(),
          fileName: urlValue.split("/").pop(),
          filePath: urlValue,
          mimeType: null,
          size: null,
          fileType: "pdf",
          uploadedAt: nowIST(),
        };
      } else {
        delete mediaData.agreement.agreementPDF;
      }
    }
      if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
        mediaData.landOwners.forEach((owner) => {
          OWNER_FILE_FIELDS.forEach((field) => {
            if (typeof owner[field] === "string") delete owner[field];
          });
        });
      }
      // ✅ ADDED — same Media → LandOwnerMaster sync as the update
      // branch, in case a brand-new Media property is created with
      // an owner already picked from the landowner list (has a
      // landOwnerMasterId attached).
      if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
        const generatedMediaId = new mongoose.Types.ObjectId();
        mediaData._id = generatedMediaId;

        const mediaInfo = {
          mediaId: generatedMediaId,
          mediaCode: mediaData.mediaCode,
          mediaName: mediaData.mediaName,
          siteBillMode: mediaData.siteBillMode,
        };

        for (const owner of mediaData.landOwners) {
          const linkedMaster = await syncOrLinkMediaOwnerToMaster(
            owner,
            userName,
            null,
            mediaInfo,
          );

          // ✅ ADDED — same denormalization as UPDATE branch.
          if (linkedMaster && Array.isArray(linkedMaster.linkedSites)) {
            // const otherSites = linkedMaster.linkedSites.filter(
            //   (site) => String(site.mediaId) !== String(mediaInfo.mediaId),
            // );
            const otherSites = linkedMaster.linkedSites;
            owner.linkedSites = otherSites.map((site) => ({
              mediaId: site.mediaId,
              mediaCode: site.mediaCode,
              mediaName: site.mediaName,
              siteBillMode: site.siteBillMode,
              paymentCategory: site.paymentCategory,
              shareAmount: site.shareAmount,
              cashAmount: site.cashAmount,
              onlineAmount: site.onlineAmount,
              updatedAt: site.updatedAt,
            }));
            owner.linkedMediaCount = otherSites.length;
          } else {
            owner.linkedSites = [];
            owner.linkedMediaCount = 0;
          }
        }

        mediaData.landOwnerMasterIds = mediaData.landOwners
          .map((o) => o.landOwnerMasterId)
          .filter(Boolean);
      }
      // Step 1 & 2: record first-ever totalRentalAmount.
      const { currentBaseRent, rentActuallyChanged } =
        handleRentalAmountHistory(mediaData, null, userName);

      // Step 2: on create, appraisal first entry uses this base.
      await handleAppraisalLogic(
        mediaData,
        null,
        userName,
        currentBaseRent,
        rentActuallyChanged,
      );

      if (Number(mediaData.appraisal?.applicable) === 1) {
        recomputeAppraisalSummary(mediaData.appraisal, currentBaseRent);
      }

      applyAppraisalRentIfDuent(
        mediaData,
        null,
        userName,
        rentActuallyChanged,
      );
      mediaData.gstApplicableFlag = detectInitialGstApplicableFlag(mediaData);
      // Step 4: push first agreement history snapshot.
      if (mediaData.rentalPayment && mediaData.agreement) {
        const pf = mediaData.rentalPayment.paymentFrequency || 1;
         const existingHistory = mediaData.rentalPayment.gstOutstandingHistory || [];
        mediaData.agreement.rentalPayment = {
          totalRentalAmount: mediaData.rentalPayment.totalRentalAmount || 0,
          paymentFrequency: pf,
          // Only set customPaymentFrequency when frequency is actually Custom (6).
          // Leaving it undefined otherwise avoids tripping the schema's `min: 1`
          // validator, since `required` only applies when paymentFrequency === 6.
          ...(pf === 6 && mediaData.rentalPayment.customPaymentFrequency
            ? {
                customPaymentFrequency: Number(
                  mediaData.rentalPayment.customPaymentFrequency,
                ),
              }
            : {}),
             gstOutstandingHistory: existingHistory,
        };
      }
      handleAgreementHistory(mediaData, null, userName);

      // ✅ ADDED — initialize billingStartDate on create so it serves
      // as the stable anchor for all future cycle walking.
      if (mediaData.rentalPayment?.lastBillPaidDate) {
        mediaData.rentalPayment.billingStartDate =
          mediaData.rentalPayment.lastBillPaidDate;
      }
      mediaData.createdAt = nowIST();
      mediaData.updatedAt = nowIST();
      media = new MediaOnboarding(mediaData);
      await media.save({ timestamps: false });
       await MediaOnboarding.syncBillingCycles();
      media = await MediaOnboarding.findById(media._id).lean();
      // ✅ ADDED — same pass-2 correction as UPDATE branch.
      if (media.landOwners && Array.isArray(media.landOwners)) {
        for (const savedOwner of media.landOwners) {
          if (savedOwner.landOwnerMasterId) {
            await correctLinkedSiteAmounts(
              savedOwner.landOwnerMasterId,
              media._id,
              savedOwner,
              null,
            );
          }
        }
      }
    }

    const message = isNew
      ? "Media created successfully"
      : "Media updated successfully";
    return successResponse(res, message, media, isNew ? 201 : 200);
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};

const resolveActiveAgreement = (historyArr) => {
  if (!historyArr || !historyArr.length) return null;

  const now = nowIST();
  const today = new Date(now.setHours(0, 0, 0, 0));

  const toDay = (d) => new Date(new Date(d).setHours(0, 0, 0, 0));

  // 1. Active today: startDate <= today <= endDate
  const active = historyArr.find((h) => {
    if (!h.startDate || !h.endDate) return false;
    return toDay(h.startDate) <= today && today <= toDay(h.endDate);
  });
  if (active) return active;

  // 2. Most recent past: endDate < today → pick the one with latest endDate
  const past = historyArr
    .filter((h) => h.endDate && toDay(h.endDate) < today)
    .sort((a, b) => new Date(b.endDate) - new Date(a.endDate));
  if (past.length) return past[0];

  // 3. Soonest future: startDate > today → pick the one with earliest startDate
  const future = historyArr
    .filter((h) => h.startDate && toDay(h.startDate) > today)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  if (future.length) return future[0];

  return null;
};

//agreement Save
const updateAgreement = async (req, res) => {
  try {
    // const { id } = req.body;
    const id = req.body?.id;
    const userName = req.user?.userName || "Admin";

    if (!id) {
      return errorResponse(
        res,
        "Media ID is required in request body",
        null,
        400,
      );
    }

    const media = await MediaOnboarding.findById(id);
    if (!media) {
      return errorResponse(res, "Media not found with this ID", null, 404);
    }

    let agreementData = req.body;
    if (
      agreementData.agreement &&
      typeof agreementData.agreement === "string"
    ) {
      try {
        agreementData = JSON.parse(agreementData.agreement);
      } catch (error) {
        return errorResponse(res, "Invalid agreement JSON format", null, 400);
      }
    }
    delete agreementData.id;

    // const incoming = agreementData.startDate
    //   ? agreementData
    //   : agreementData.agreement || {};
    const incoming = agreementData.startDate
      ? agreementData // flat FormData or plain JSON body
      : agreementData.agreement && typeof agreementData.agreement === "object"
        ? agreementData.agreement // nested { agreement: { startDate, ... } }
        : {};

    if (!incoming.startDate || !incoming.endDate) {
      return errorResponse(
        res,
        "startDate and endDate are required",
        null,
        400,
      );
    }

    // ─────────────────────────────────────────────
    // PDF Upload
    // ─────────────────────────────────────────────
    const uploadedAgreementPDF = req.files?.agreementPDF?.[0];
    if (uploadedAgreementPDF) {
      incoming.agreementPDF = req.processFile(uploadedAgreementPDF);
    } else if (media.agreement?.agreementPDF) {
      incoming.agreementPDF = media.agreement.agreementPDF.toObject
        ? media.agreement.agreementPDF.toObject()
        : { ...media.agreement.agreementPDF };
    }

    // ─────────────────────────────────────────────
    // Build new agreement object with rentalPayment
    // ─────────────────────────────────────────────
    const paymentFrequencyValue =
      incoming.paymentFrequency !== undefined
        ? Number(incoming.paymentFrequency)
        : media.agreement?.rentalPayment?.paymentFrequency || 1;
    const customPaymentFrequencyValue =
      incoming.customPaymentFrequency !== undefined
        ? Number(incoming.customPaymentFrequency)
        : media.agreement?.rentalPayment?.customPaymentFrequency || undefined;
    const incomingTotalRentalAmount =
      incoming.totalRentalAmount !== undefined
        ? Number(incoming.totalRentalAmount)
        : media.agreement?.rentalPayment?.totalRentalAmount || 0;

    // ── Detect if totalRentalAmount changed so we can stamp updatedAt/updatedBy ──
    const existingTotalRentalAmount = Number(
      media.agreement?.rentalPayment?.totalRentalAmount ?? 0,
    );

    const rentalAmountChanged =
      incomingTotalRentalAmount !== existingTotalRentalAmount;

    // Carry forward the existing stamp when the amount did NOT change.
    const rentalPaymentUpdatedAt = rentalAmountChanged
      ? nowIST()
      : (media.agreement?.rentalPayment?.updatedAt ?? nowIST());

    const rentalPaymentUpdatedBy = rentalAmountChanged
      ? userName
      : (media.agreement?.rentalPayment?.updatedBy ?? userName);

    const newAgreement = {
      startDate: toDateOnly(incoming.startDate),
      endDate: toDateOnly(incoming.endDate),
      reminderBeforeExpiry:
        incoming.reminderBeforeExpiry !== undefined
          ? Number(incoming.reminderBeforeExpiry)
          : media.agreement?.reminderBeforeExpiry || 30,
      advanceRent:
        incoming.advanceRent !== undefined
          ? Number(incoming.advanceRent)
          : media.agreement?.advanceRent || 0,
      agreementPDF: incoming.agreementPDF,
      reason: incoming.reason?.trim() || media.agreement?.reason || "",
      rentalPayment: {
        totalRentalAmount: incomingTotalRentalAmount,
        paymentFrequency: paymentFrequencyValue,
        customPaymentFrequency: customPaymentFrequencyValue,
        // ← stamp who changed totalRentalAmount and when
        updatedBy: rentalPaymentUpdatedBy,
        updatedAt: rentalPaymentUpdatedAt,
      },
    };

    // ─────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────
    if (newAgreement.startDate >= newAgreement.endDate) {
      return errorResponse(
        res,
        "Start date must be before end date",
        null,
        400,
      );
    }

    const validReminderValues = [10, 30, 60, 90];
    if (!validReminderValues.includes(newAgreement.reminderBeforeExpiry)) {
      return errorResponse(
        res,
        `reminderBeforeExpiry must be one of: ${validReminderValues.join(", ")}`,
        null,
        400,
      );
    }

    if (newAgreement.rentalPayment.totalRentalAmount < 0) {
      return errorResponse(
        res,
        "Total rental amount must be a positive number",
        null,
        400,
      );
    }

    const validPaymentFrequencies = [1, 2, 3, 4, 5, 6];
    if (
      !validPaymentFrequencies.includes(
        newAgreement.rentalPayment.paymentFrequency,
      )
    ) {
      return errorResponse(
        res,
        `paymentFrequency must be one of: ${validPaymentFrequencies.join(", ")} (1=Monthly, 2=3M, 3=6M, 4=1Y, 5=2Y)`,
        null,
        400,
      );
    }
    if (
      newAgreement.rentalPayment.paymentFrequency === 6 &&
      (!newAgreement.rentalPayment.customPaymentFrequency ||
        newAgreement.rentalPayment.customPaymentFrequency < 1)
    ) {
      return errorResponse(
        res,
        "customPaymentFrequency (number of months) is required and must be greater than 0 when paymentFrequency is 6 (Custom)",
        null,
        400,
      );
    }
    // ─────────────────────────────────────────────
    // Helper: compare two dates by day only
    // ─────────────────────────────────────────────
    const sameDay = (a, b) =>
      new Date(a).setHours(0, 0, 0, 0) === new Date(b).setHours(0, 0, 0, 0);

    // ─────────────────────────────────────────────
    // Get existing history
    // ─────────────────────────────────────────────
    let existingHistory = (media.agreementHistory || []).map((h) =>
      h.toObject ? h.toObject() : { ...h },
    );

    const currentAgreement = media.agreement;

    // ─────────────────────────────────────────────
    // 1. Preserve the current active agreement in history
    // ─────────────────────────────────────────────
    if (currentAgreement) {
      const alreadyArchived = existingHistory.some(
        (h) =>
          h.startDate &&
          h.endDate &&
          sameDay(h.startDate, currentAgreement.startDate) &&
          sameDay(h.endDate, currentAgreement.endDate),
      );

      if (!alreadyArchived) {
        const currentPaymentFrequency =
          currentAgreement.rentalPayment?.paymentFrequency || 1;

        existingHistory.push({
          startDate: new Date(currentAgreement.startDate),
          endDate: new Date(currentAgreement.endDate),
          reminderBeforeExpiry: currentAgreement.reminderBeforeExpiry || 30,
          advanceRent: currentAgreement.advanceRent || 0,
          reason: currentAgreement.reason || "",
          status: computeAgreementStatus(
            currentAgreement.startDate,
            currentAgreement.endDate,
            currentAgreement.reminderBeforeExpiry || 30,
          ),
          agreementPDF: currentAgreement.agreementPDF
            ? {
                ...(currentAgreement.agreementPDF.toObject
                  ? currentAgreement.agreementPDF.toObject()
                  : currentAgreement.agreementPDF),
              }
            : undefined,
          rentalPayment: {
            totalRentalAmount:
              currentAgreement.rentalPayment?.totalRentalAmount || 0,
            paymentFrequency: currentPaymentFrequency,
            customPaymentFrequency:
              currentAgreement.rentalPayment?.customPaymentFrequency ?? null,
            // ← Carry forward the existing stamp when archiving the current agreement
            updatedBy: currentAgreement.rentalPayment?.updatedBy ?? userName,
            updatedAt: currentAgreement.rentalPayment?.updatedAt ?? nowIST(),
          },
          updatedBy: userName,
          uploadedAt: nowIST(),
        });
      }
    }

    // ─────────────────────────────────────────────
    // 2. Does a history entry with the INCOMING dates already exist?
    // ─────────────────────────────────────────────
    let entryIndex = -1;
    for (let i = existingHistory.length - 1; i >= 0; i--) {
      const h = existingHistory[i];
      if (!h.startDate || !h.endDate) continue;
      if (
        sameDay(h.startDate, newAgreement.startDate) &&
        sameDay(h.endDate, newAgreement.endDate)
      ) {
        entryIndex = i;
        break;
      }
    }

    const shouldCreateNewEntry = entryIndex === -1;

    // ─────────────────────────────────────────────
    // 3. Build the entry payload with rentalPayment
    // ─────────────────────────────────────────────

    // For the history snapshot: detect if totalRentalAmount changed vs the
    // existing history entry (if updating an existing one).
    const existingHistoryEntryRentalAmount =
      entryIndex !== -1
        ? Number(
            existingHistory[entryIndex]?.rentalPayment?.totalRentalAmount ?? 0,
          )
        : null;

    const historyEntryRentalAmountChanged =
      existingHistoryEntryRentalAmount === null ||
      incomingTotalRentalAmount !== existingHistoryEntryRentalAmount;

    const historyRentalUpdatedAt = historyEntryRentalAmountChanged
      ? nowIST()
      : (existingHistory[entryIndex]?.rentalPayment?.updatedAt ?? nowIST());

    const historyRentalUpdatedBy = historyEntryRentalAmountChanged
      ? userName
      : (existingHistory[entryIndex]?.rentalPayment?.updatedBy ?? userName);

    const entryPayload = {
      startDate: new Date(newAgreement.startDate),
      endDate: new Date(newAgreement.endDate),
      reminderBeforeExpiry: newAgreement.reminderBeforeExpiry,
      advanceRent: newAgreement.advanceRent || 0,
      reason: newAgreement.reason || "",
      status: computeAgreementStatus(
        newAgreement.startDate,
        newAgreement.endDate,
        newAgreement.reminderBeforeExpiry,
      ),
      agreementPDF: newAgreement.agreementPDF
        ? {
            ...(newAgreement.agreementPDF.toObject
              ? newAgreement.agreementPDF.toObject()
              : newAgreement.agreementPDF),
          }
        : entryIndex !== -1
          ? existingHistory[entryIndex].agreementPDF
          : undefined,
      rentalPayment: {
        totalRentalAmount: newAgreement.rentalPayment.totalRentalAmount,
        paymentFrequency: newAgreement.rentalPayment.paymentFrequency,
        customPaymentFrequency:
          newAgreement.rentalPayment?.customPaymentFrequency ?? null,
        // ← stamp on the history snapshot entry
        updatedBy: historyRentalUpdatedBy,
        updatedAt: historyRentalUpdatedAt,
      },
      updatedBy: userName,
      uploadedAt: nowIST(),
    };

    // ─────────────────────────────────────────────
    // 4. Create new entry OR update existing one in place
    // ─────────────────────────────────────────────
    if (shouldCreateNewEntry) {
      existingHistory.push(entryPayload);
    } else {
      const existingRentalPayment =
        existingHistory[entryIndex]?.rentalPayment || {};
      const paymentFreq =
        incoming.paymentFrequency !== undefined
          ? Number(incoming.paymentFrequency)
          : existingRentalPayment.paymentFrequency || 1;
      const customPaymentFreq =
        incoming.customPaymentFrequency !== undefined
          ? Number(incoming.customPaymentFrequency)
          : existingRentalPayment.customPaymentFrequency || undefined;
      const updatedTotalRentalAmount =
        incoming.totalRentalAmount !== undefined
          ? Number(incoming.totalRentalAmount)
          : existingRentalPayment.totalRentalAmount || 0;

      // Re-check change against the existing entry's amount.
      const entryAmountChanged =
        updatedTotalRentalAmount !==
        Number(existingRentalPayment.totalRentalAmount ?? 0);

      existingHistory[entryIndex] = {
        ...existingHistory[entryIndex],
        ...entryPayload,
        rentalPayment: {
          totalRentalAmount: updatedTotalRentalAmount,
          paymentFrequency: paymentFreq,
          customPaymentFrequency: customPaymentFreq,
          // ← only refresh stamp when amount actually changed
          updatedBy: entryAmountChanged
            ? userName
            : (existingRentalPayment.updatedBy ?? userName),
          updatedAt: entryAmountChanged
            ? nowIST()
            : (existingRentalPayment.updatedAt ?? nowIST()),
        },
      };
    }

    // ─────────────────────────────────────────────
    // Resolve which agreement should be "active"
    // ─────────────────────────────────────────────
    const activeAgreement = resolveActiveAgreement(existingHistory);

    // ─────────────────────────────────────────────
    // Persist agreement + history
    // ─────────────────────────────────────────────
    media.agreementHistory = existingHistory;

    if (activeAgreement) {
      const activePaymentFreq =
        activeAgreement.rentalPayment?.paymentFrequency || 1;

      media.agreement = {
        startDate: activeAgreement.startDate,
        endDate: activeAgreement.endDate,
        reminderBeforeExpiry: activeAgreement.reminderBeforeExpiry,
        advanceRent: activeAgreement.advanceRent || 0,
        reason: activeAgreement.reason || "",
        updatedBy: userName,
        status: computeAgreementStatus(
          activeAgreement.startDate,
          activeAgreement.endDate,
          activeAgreement.reminderBeforeExpiry,
        ),
        agreementPDF: activeAgreement.agreementPDF,
        rentalPayment: {
          totalRentalAmount:
            activeAgreement.rentalPayment?.totalRentalAmount || 0,
          paymentFrequency: activePaymentFreq,
          customPaymentFrequency:
            activeAgreement.rentalPayment?.customPaymentFrequency,
          // ← carry the stamp from the active history entry into the live agreement
          updatedBy: activeAgreement.rentalPayment?.updatedBy ?? userName,
          updatedAt: activeAgreement.rentalPayment?.updatedAt ?? nowIST(),
        },
      };
    } else {
      // Fallback: use the new agreement directly
      media.agreement = {
        ...newAgreement,
        status: computeAgreementStatus(
          newAgreement.startDate,
          newAgreement.endDate,
          newAgreement.reminderBeforeExpiry,
        ),
      };
    }

    // ─────────────────────────────────────────────
    // NEW: Sync top-level media.rentalPayment with the now-active agreement's
    // totalRentalAmount. Only totalRentalAmount + rentalAmountHistory are
    // touched here — gstAmount/tdsAmount/netPayable/ownerPayments are left
    // alone since they're recalculated by a separate flow (e.g. appraisal).
    // ─────────────────────────────────────────────
    const activeTotalRentalAmount =
      media.agreement?.rentalPayment?.totalRentalAmount ?? 0;
    const activePaymentFrequency =
      media.agreement?.rentalPayment?.paymentFrequency ?? 1;
    const activeCustomPaymentFrequency =
      media.agreement?.rentalPayment?.customPaymentFrequency;
    if (!media.rentalPayment) {
      // No top-level rentalPayment block exists yet — initialize minimally.
      media.rentalPayment = {
        totalRentalAmount: activeTotalRentalAmount,
        paymentFrequency: activePaymentFrequency,
        customPaymentFrequency: activeCustomPaymentFrequency,
        rentalAmountHistory: [
          {
            amount: activeTotalRentalAmount,
            updatedBy: userName,
            updatedAt: nowIST(),
          },
        ],
      };
    } else {
      const existingTopLevelAmount = Number(
        media.rentalPayment.totalRentalAmount ?? 0,
      );

      if (activeTotalRentalAmount !== existingTopLevelAmount) {
        const rentalAmountHistory = (
          media.rentalPayment.rentalAmountHistory || []
        ).map((h) => (h.toObject ? h.toObject() : { ...h }));

        rentalAmountHistory.push({
          amount: activeTotalRentalAmount,
          // updatedBy: userName,
          updatedBy: `${userName} (Agreement Update)`,
          updatedAt: nowIST(),
        });

        // Sort rentalAmountHistory by updatedAt DESC
        rentalAmountHistory.sort((a, b) => b.updatedAt - a.updatedAt);

        media.rentalPayment.totalRentalAmount = activeTotalRentalAmount;
        media.rentalPayment.rentalAmountHistory = rentalAmountHistory;
        // NOTE: gstAmount, tdsAmount, netPayable, ownerPayments are intentionally
        // left untouched — they're recalculated elsewhere (e.g. appraisal flow).
      }
      media.rentalPayment.paymentFrequency = activePaymentFrequency;
      media.rentalPayment.customPaymentFrequency = activeCustomPaymentFrequency;
    }

    media.updatedAt = nowIST();
    await media.save({ timestamps: false });

    const saved = await MediaOnboarding.findById(media._id)
      .select("agreement agreementHistory rentalPayment")
      .lean();

    return successResponse(
      res,
      shouldCreateNewEntry
        ? "Agreement updated successfully and previous agreement moved to history"
        : "Agreement details updated successfully",
      saved,
      200,
    );
  } catch (error) {
    console.error("Error updating agreement:", error);
    return errorResponse(
      res,
      error.message || "Failed to update agreement",
      null,
      500,
    );
  }
};

const mediaList = async (req, res) => {
  try {
    const {
      pageNumber = 1,
      count = 10,
      mediaType,
      agreementStatus,
      city,
      status,
      search,
      landOwnerName,
      landOwnerMasterId,
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
if (landOwnerMasterId) {
      const idList = Array.isArray(landOwnerMasterId)
        ? landOwnerMasterId
        : [landOwnerMasterId];
      const validIds = idList
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (validIds.length > 0) {
        filter["landOwners.landOwnerMasterId"] = { $in: validIds };
      }
    } else if (landOwnerName) {
      const nameList = Array.isArray(landOwnerName)
        ? landOwnerName
        : [landOwnerName];

      filter["landOwners.name"] = {
        $in: nameList.map((n) => new RegExp(n.trim(), "i")),
      };
    }
    // ── STATUS FILTER ──────────────────────────────────────────
    // 1 / 2 / 3  -> plain `status` field (unchanged legacy behavior)
    // 4          -> virtual status, maps to agreement.status === 2
    // 5          -> virtual status, maps to agreement.status === 3
    if (status !== undefined && status !== null && status !== "") {
      const statusArray = Array.isArray(status) ? status : [status];
      const statusNums = statusArray.map(Number);

      const regularStatuses = statusNums.filter((s) => s !== 4 && s !== 5);
      const orConditions = [];

      if (regularStatuses.length > 0) {
        orConditions.push({ status: { $in: regularStatuses } });
      }
      if (statusNums.includes(4)) {
        orConditions.push({ "agreement.status": 2 });
      }
      if (statusNums.includes(5)) {
        orConditions.push({ "agreement.status": 3 });
      }

      if (orConditions.length === 1) {
        // only one condition type selected — apply directly, no $or needed
        Object.assign(filter, orConditions[0]);
      } else if (orConditions.length > 1) {
        // mixed selection (e.g. status = [1, 4]) — match either
        filter.$or = orConditions;
      }
    }

    if (
      agreementStatus !== undefined &&
      agreementStatus !== null &&
      agreementStatus !== ""
    ) {
      filter["agreement.status"] = Number(agreementStatus);
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
      .sort({ updatedAt: -1})
      .skip((pageNumbers - 1) * pageSize)
      .limit(pageSize)
      .lean();

    // ✅ Sort rentalAmountHistory by updatedAt DESC for each media item
    mediaListData.forEach((item) => {
      if (item.rentalPayment?.rentalAmountHistory) {
        item.rentalPayment.rentalAmountHistory.sort(
          (a, b) => b.updatedAt - a.updatedAt
        );
      }
    });

    // ===============================
    // AGGREGATION FOR STATISTICS
    // ===============================

    // Get active count - using numeric status value (adjust based on your schema)
    // Common conventions: 1 = Active, 0 = Inactive, or 2 = Active, etc.
    const activeCount = await MediaOnboarding.countDocuments({
      status: 1, // Change this to match your active status number
    });

    // Get agreement expired count (agreement.status = 3)
    const agreementExpiredCount = await MediaOnboarding.countDocuments({
      "agreement.status": 3,
    });

    // Get total rental amounts from all documents
    const rentalAggregation = await MediaOnboarding.aggregate([
      {
        $group: {
          _id: null,
          totalRentalAmount: {
            $sum: "$rentalPayment.totalRentalAmount",
          },
          totalNetPayable: {
            $sum: "$rentalPayment.netPayable",
          },
        },
      },
    ]);

    const totalRentalAmount =
      rentalAggregation.length > 0 ? rentalAggregation[0].totalRentalAmount : 0;
    const totalNetPayable =
      rentalAggregation.length > 0 ? rentalAggregation[0].totalNetPayable : 0;

    // ===============================
    // FILTER OPTIONS (always from full collection)
    // ===============================

    const allData = await MediaOnboarding.find(
      {},
      "city mediaType status landOwners.name",
    ).lean();

    const cityFilter = [...new Set(allData.map((item) => item.city))].filter(
      Boolean,
    );
    const mediaTypeFilter = [
      ...new Set(allData.map((item) => item.mediaType)),
    ].filter(Boolean);
const allLandOwnersForNameFilter = await LandOwnerMaster.find({})
  .select("name updatedAt")
  .sort({ updatedAt: -1 })
  .lean();

const landOwnerNameFilter = allLandOwnersForNameFilter.map((item) => ({
  id: item._id,
  name: item.name,
}));
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
        landOwnerNameFilter,
        mediaList: mediaListData,
        // New keys added:
        activeCount,
        agreementExpiredCount,
        totalRentalAmount,
        totalNetPayable,
      },
      200,
    );
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};
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

    // ✅ Sort rentalAmountHistory by updatedAt DESC
    if (mediaData.rentalPayment?.rentalAmountHistory) {
      mediaData.rentalPayment.rentalAmountHistory.sort(
        (a, b) => b.updatedAt - a.updatedAt
      );
    }

    // Return success response with media data
    return successResponse(
      res,
      "Media details fetched successfully",
      {
        media: mediaData,
      },
      200,
    );
  } catch (error) {
    // Handle invalid ObjectId format
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return errorResponse(res, "Invalid media ID format", null, 400);
    }
    return errorResponse(res, error.message, null, 400);
  }
};

// Excel Upload
const COLUMN_MAP = {
  state: "state",
  city: "city",
  "media name": "mediaName",
  "media code": "mediaCode",
  "media type": "mediaType",
  width: "width",
  hight: "height",
  height: "height",
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
    const today = nowIST();
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

      // ✅ Robust case-insensitive header matching
      Object.keys(row).forEach((excelKey) => {
        const normalizedKey = excelKey.trim().toLowerCase();
        const schemaField = COLUMN_MAP[normalizedKey];
        if (schemaField && (row[excelKey] !== undefined && row[excelKey] !== null)) {
          mapped[schemaField] = row[excelKey];
        }
      });

      mapped.mediaName = mapped.mediaName || `Media-${excelRow}`;

      const missing = [];
      if (!mapped.mediaCode) missing.push("Media Code");
      if (!mapped.mediaName) missing.push("Media Name");
      if (!mapped.state) missing.push("State");
      if (!mapped.city) missing.push("City");
      if (!mapped.width) missing.push("Width");
      if (!mapped.height) missing.push("Height");
      if (!mapped.mediaType) missing.push("Media Type");

      if (missing.length) {
        results.errors.push({
          row: excelRow,
          reason: `Missing: ${missing.join(", ")}`,
        });
        results.skipped++;
        continue;
      }

      mapped.width = Math.floor(Number(mapped.width) || 0);
      mapped.height = Math.floor(Number(mapped.height) || 0);
      mapped.totalSqFt = Math.floor((mapped.width * mapped.height).toFixed(2));
      mapped.excelRowNumber = excelRow;

      // ── Assign unique mediaId from in-memory counter ──
      mapped.mediaId = `${prefix}MED#${nextNumber}`;

      // ✅ Reversed index-based offset: first row gets HIGHEST timestamp
      // so it appears at the TOP of the dashboard (sort: { updatedAt: -1 })
      const rowTimestamp = new Date(today.getTime() + (rows.length - index));
      mapped.createdAt = rowTimestamp;
      mapped.updatedAt = rowTimestamp;

      nextNumber++;
      // ─────────────────────────────────────────────────

      const { mediaCode, createdAt, mediaId, ...dataToUpdate } = mapped;
      bulkOps.push({
        updateOne: {
          filter: { mediaCode },
          update: {
            $set: dataToUpdate,
            $setOnInsert: { createdAt, mediaId },
          },
          upsert: true,
        },
      });
    }

    if (bulkOps.length) {
      const bulkResult = await MediaOnboarding.bulkWrite(bulkOps, {
        ordered: false,
        timestamps: false,
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
const syncBillingCyclesNow = async (req, res) => {
  try {
    const result = await MediaOnboarding.syncBillingCycles();
    return successResponse(res, "Billing cycles synced", result, 200);
  } catch (error) {
    return errorResponse(res, "Failed to sync billing cycles", { error: error.message }, 500);
  }
};
module.exports = {
  mediaOnboarding,
  mediaList,
  uploadExcel,
  updateAgreement,
  getMediaById,
  syncBillingCyclesNow
};
