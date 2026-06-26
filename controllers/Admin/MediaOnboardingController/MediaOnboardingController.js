

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
          ownerShare = parseFloat(
            ((netPayable * (Number(owner.sharePercentage) || 0)) / 100).toFixed(
              2,
            ),
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
  gstApplicable,
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

      totalComputedAmount += parseFloat(
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
      message: ` net payable amount (${netPayable.toFixed(2)}). Difference: ${diff.toFixed(2)}`,
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



const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60000;


const getISTDate = () => {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MS);
};


const toAppraisalDate = (input) => {
  const d = new Date(input);
  // Convert input to IST
  const istTime = new Date(d.getTime() + IST_OFFSET_MS);
  // Get IST date components
  const year = istTime.getUTCFullYear();
  const month = istTime.getUTCMonth();
  const date = istTime.getUTCDate();
  // Return UTC midnight of that IST date
  return new Date(Date.UTC(year, month, date));
};


const dayKey = (input) => toAppraisalDate(input).getTime();

const todayKey = () => dayKey(new Date());

const sameDay = (a, b) => dayKey(a) === dayKey(b);


const stampNowIstTime = (input) => {
  const d = new Date(input);
  // Convert input to IST
  const istTime = new Date(d.getTime() + IST_OFFSET_MS);
  
  // Get components in IST
  const year = istTime.getUTCFullYear();
  const month = istTime.getUTCMonth();
  const date = istTime.getUTCDate();
  const hours = istTime.getUTCHours();
  const minutes = istTime.getUTCMinutes();
  const seconds = istTime.getUTCSeconds();
  const milliseconds = istTime.getUTCMilliseconds();
  
  // Create a UTC date that represents the IST time
  // This stores the correct UTC instant that corresponds to the IST wall time
  return new Date(Date.UTC(year, month, date, hours, minutes, seconds, milliseconds));
};








const getISTDateString = (date) => {
  const d = new Date(date);
  const istTime = new Date(d.getTime() + IST_OFFSET_MS);
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};


const APPLY_ON_SAME_DAY = true;
const isApplied = (date) =>
  APPLY_ON_SAME_DAY ? dayKey(date) <= todayKey() : dayKey(date) < todayKey();
const isUpcoming = (date) => !isApplied(date);

const APPRAISAL_FREQUENCY_MONTHS = { 1: 6, 2: 12, 3: 24 };
const APPRAISAL_FREQUENCY_LABEL = {
  1: "6 Months",
  2: "Yearly (12 Months)",
  3: "2 Years (24 Months)",
  4: "Custom",
};
const APPRAISAL_FREQUENCY_MONTHS_MAP = { 1: 6, 2: 12, 3: 24 };

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

  if (dayKey(candidateDate) >= dayKey(endDate)) {
    const label = APPRAISAL_FREQUENCY_LABEL[frequency];
    const freqDisplay = frequency === 4 ? `Custom (${months} months)` : label;
    // Use IST for consistent date display
    const candidateIST = getISTDateString(candidateDate);
    const endIST = getISTDateString(endDate);
    return {
      valid: false,
      message: `Appraisal frequency "${freqDisplay}" is not applicable. The next appraisal (${candidateIST}) would fall on or after the agreement end date (${endIST}).`,
    };
  }

  return { valid: true };
};


const computeAppraisalAmount = (entry, previousRent) => {
  if (Number(entry.type) === 1) {
    return Math.round((previousRent * Number(entry.percentage || 0)) / 100);
  }
  if (Number(entry.type) === 2) {
    return Math.round(Number(entry.fixedAmount || 0));
  }
  return 0;
};


const cascadeHistory = (history, baseRent) => {
  const sorted = history
    .filter((h) => h.appraisalDate)
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  let prev = Number(baseRent || 0);
  for (const entry of sorted) {
    entry.previousRent = prev;
    entry.appraisalAmount = computeAppraisalAmount(entry, prev);
    entry.newRent = Math.round(prev + entry.appraisalAmount);
    prev = entry.newRent;
  }
  return sorted;
};

const handleAppraisalLogic = async (mediaData, existingMedia, userName) => {
  const appraisal = mediaData.appraisal;
  const agreement = mediaData.agreement || existingMedia?.agreement;

  if (!appraisal || Number(appraisal.applicable) !== 1) return mediaData;
  if (!agreement?.startDate || !agreement?.endDate) return mediaData;

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

  const netPayable = Number(mediaData.rentalPayment?.totalRentalAmount || 0);
  const isNew = !existingMedia;

  // Normalize incoming next date to canonical shape + guard end date.
  let nextDate = null;       // date-only key for matching/guards
  let nextStamped = null;    // value actually stored (carries current IST time)
  if (appraisal.nextAppraisalDate) {
    nextDate = toAppraisalDate(appraisal.nextAppraisalDate);
    nextStamped = stampNowIstTime(appraisal.nextAppraisalDate);
    appraisal.nextAppraisalDate = nextStamped;
    if (dayKey(nextDate) > dayKey(agreementEndDate)) {
      throw new Error(
        "Next appraisal date cannot be greater than agreement end date",
      );
    }
  }

  // ── CREATE flow ──────────────────────────────────────────────────────────
  if (isNew) {
    if (!nextDate) {
      const firstDate = new Date(agreementStartDate);
      firstDate.setMonth(firstDate.getMonth() + months);
      if (dayKey(firstDate) <= dayKey(agreementEndDate)) {
        nextDate = toAppraisalDate(firstDate);
        nextStamped = stampNowIstTime(firstDate);
        appraisal.nextAppraisalDate = nextStamped;
      }
    }

    appraisal.history = [];
    if (nextDate) {
      appraisal.history.push({
        appraisalDate: nextStamped,
        type: appraisal.type,
        percentage: appraisal.percentage || 0,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        previousRent: netPayable,
        appraisalAmount: 0,
        newRent: 0,
        updatedBy: userName,
        updatedAt: getISTDate(),
      });
      appraisal.history = cascadeHistory(appraisal.history, netPayable);
    }

    mediaData.appraisal = appraisal;
    return mediaData;
  }

  // ── UPDATE flow ────────────────────────────────────────────────────────────
  const oldAppraisal = existingMedia.appraisal
    ? JSON.parse(JSON.stringify(existingMedia.appraisal))
    : {};

  let history = (Array.isArray(oldAppraisal.history) ? oldAppraisal.history : [])
    .filter((h) => h.appraisalDate)
    .map((h) => ({ ...h }))
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  const baseRent = history.length
    ? Number(history[0].previousRent ?? netPayable)
    : netPayable;

  if (nextDate) {
    const idx = history.findIndex((h) => sameDay(h.appraisalDate, nextDate));

    if (idx !== -1) {
      // Edit an EXISTING entry (past or future) — allowed.
      history[idx] = {
        ...history[idx],
        appraisalDate: nextStamped,
        type: appraisal.type,
        percentage: appraisal.percentage || 0,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        updatedBy: userName,
        updatedAt: getISTDate(),
      };
    } else {
      // A NEW date — block only if it is genuinely in the past (IST).
      if (dayKey(nextDate) < todayKey()) {
        const nextDateIST = getISTDateString(nextDate);
        throw new Error(
          `Next appraisal date (${nextDateIST}) is a past date and cannot be added as a new appraisal.`,
        );
      }
      history.push({
        appraisalDate: nextStamped,
        type: appraisal.type,
        percentage: appraisal.percentage || 0,
        fixedAmount: Number(appraisal.fixedAmount || 0),
        previousRent: 0,
        appraisalAmount: 0,
        newRent: 0,
        updatedBy: userName,
        updatedAt: getISTDate(),
      });
    }
  }

  appraisal.history = cascadeHistory(history, baseRent);

  mediaData.appraisal = appraisal;
  return mediaData;
};

const recomputeAppraisalSummary = (appraisal, fallbackBaseRent = 0) => {
  if (
    !appraisal ||
    !Array.isArray(appraisal.history) ||
    !appraisal.history.length
  ) {
    return appraisal;
  }

  const sorted = appraisal.history
    .filter((h) => h.appraisalDate)
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate));

  if (!sorted.length) return appraisal;

  const baseRent = Number(sorted[0].previousRent ?? fallbackBaseRent ?? 0);

  // Determine applied (past/current) and upcoming (future) entries
  const applied = sorted.filter((h) => isApplied(h.appraisalDate));
  const upcoming = sorted.filter((h) => isUpcoming(h.appraisalDate));

  // ── Current Rent & Last Appraisal Date ──────────────────────────────
  if (applied.length) {
    const last = applied[applied.length - 1];
    appraisal.currentRent = Number(last.newRent || baseRent);
    appraisal.lastAppraisalDate = new Date(last.appraisalDate);
  } else {
    appraisal.currentRent = baseRent;
    appraisal.lastAppraisalDate = null;
  }

  // ── Next Appraisal & Its Configuration ──────────────────────────────
  if (upcoming.length) {
    const next = upcoming[0]; // First upcoming entry
    
    // Set next appraisal date
    appraisal.nextAppraisalDate = new Date(next.appraisalDate);
    
    // CRITICAL FIX: Use the NEXT upcoming entry's configuration,
    // NOT the most recent entry overall
    appraisal.type = next.type;
    appraisal.percentage = next.percentage || 0;
    appraisal.fixedAmount = next.fixedAmount || 0;
    appraisal.appraisalAmount = Number(next.appraisalAmount || 0);
    
    // Calculate total appraisal amount (current rent + appraisal amount)
    appraisal.totalAppraisalAmount = Math.round(
      Number(appraisal.currentRent || 0) + Number(next.appraisalAmount || 0),
    );
  } else {
    // No upcoming entries - use the last applied entry's config
    appraisal.nextAppraisalDate = null;
    
    if (applied.length) {
      const last = applied[applied.length - 1];
      appraisal.type = last.type;
      appraisal.percentage = last.percentage || 0;
      appraisal.fixedAmount = last.fixedAmount || 0;
      appraisal.appraisalAmount = Number(last.appraisalAmount || 0);
    }
    
    appraisal.totalAppraisalAmount = Math.round(
      Number(appraisal.currentRent || 0),
    );
  }

  return appraisal;
};

const computeAgreementStatus = (startDate, endDate, reminderDays) => {
  if (!startDate || !endDate) return 1;
  // Use IST for consistent comparison
  const nowIST = getISTDate();
  const end = new Date(endDate);
  // Convert end date to IST for comparison
  const endIST = new Date(end.getTime() + IST_OFFSET_MS);
  const daysUntilExpiry = Math.ceil((endIST - nowIST) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry < 0) return 3;
  if (daysUntilExpiry <= reminderDays) return 2;
  return 1;
};

const mediaOnboarding = async (req, res) => {
  try {
    const { id } = req.body;
    const mediaData = req.body;
    const userName = req.user?.userName || "Admin";

    const jsonFields = ["landOwners", "rentalPayment", "agreement", "appraisal"];
    jsonFields.forEach((field) => {
      if (mediaData[field] && typeof mediaData[field] === "string") {
        try {
          mediaData[field] = JSON.parse(mediaData[field]);
        } catch {
          /* leave as-is */
        }
      }
    });

    if (mediaData.rentalPayment) {
      if (mediaData.rentalPayment.totalRentalAmount !== undefined)
        mediaData.rentalPayment.totalRentalAmount = Number(
          mediaData.rentalPayment.totalRentalAmount,
        );
      if (mediaData.rentalPayment.paymentFrequency)
        mediaData.rentalPayment.paymentFrequency = Number(
          mediaData.rentalPayment.paymentFrequency,
        );
      if (mediaData.rentalPayment.tdsApplicable !== undefined)
        mediaData.rentalPayment.tdsApplicable = Number(
          mediaData.rentalPayment.tdsApplicable,
        );
      if (mediaData.rentalPayment.gstApplicable !== undefined)
        mediaData.rentalPayment.gstApplicable = Number(
          mediaData.rentalPayment.gstApplicable,
        );
    }

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
        onlineMode: hasValue(owner.onlineMode)
          ? Number(owner.onlineMode)
          : undefined,
        cashAmount: hasValue(owner.cashAmount) ? Number(owner.cashAmount) : 0,
        onlineAmount: hasValue(owner.onlineAmount)
          ? Number(owner.onlineAmount)
          : 0,
        gstApplicable: hasValue(owner.gstApplicable)
          ? Number(owner.gstApplicable)
          : 0,
      }));
    }

    if (mediaData.landOwners?.length === 1) {
      const owner = mediaData.landOwners[0];
      if (!owner.typeShare) {
        owner.typeShare = 1;
        owner.sharePercentage = 100;
      }
    }

    if (mediaData.agreement) {
      // Handle dates in IST
      if (mediaData.agreement.startDate) {
        const startDate = new Date(mediaData.agreement.startDate);
        // Store as UTC midnight of the IST date
        mediaData.agreement.startDate = toAppraisalDate(startDate);
      }
      if (mediaData.agreement.endDate) {
        const endDate = new Date(mediaData.agreement.endDate);
        // Store as UTC midnight of the IST date
        mediaData.agreement.endDate = toAppraisalDate(endDate);
      }
      if (mediaData.agreement.reminderBeforeExpiry)
        mediaData.agreement.reminderBeforeExpiry = Number(
          mediaData.agreement.reminderBeforeExpiry,
        );
      if (mediaData.rentalPayment) {
        mediaData.agreement.rentalPayment = {
          totalRentalAmount: mediaData.rentalPayment.totalRentalAmount || 0,
          paymentFrequency: mediaData.rentalPayment.paymentFrequency || 1,
        };
      }
      mediaData.agreement.updatedBy = userName;
    }

    if (mediaData.rentalPayment?.lastBillPaidDate) {
      // Store as UTC midnight of the IST date
      mediaData.rentalPayment.lastBillPaidDate = toAppraisalDate(
        mediaData.rentalPayment.lastBillPaidDate
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
        mediaData.appraisal.fixedAmount = Number(mediaData.appraisal.fixedAmount);
      if (mediaData.appraisal.frequency)
        mediaData.appraisal.frequency = Number(mediaData.appraisal.frequency);
      if (mediaData.appraisal.customFrequencyMonths)
        mediaData.appraisal.customFrequencyMonths = Number(
          mediaData.appraisal.customFrequencyMonths,
        );
      // Store next appraisal date with IST time
      if (mediaData.appraisal.nextAppraisalDate) {
        mediaData.appraisal.nextAppraisalDate = stampNowIstTime(
          mediaData.appraisal.nextAppraisalDate,
        );
      }
    }

    if (mediaData.width) mediaData.width = Number(mediaData.width);
    if (mediaData.height) mediaData.height = Number(mediaData.height);
    if (mediaData.status) mediaData.status = Number(mediaData.status);
    if (mediaData.numberOfLandOwners)
      mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);

    if (mediaData.rentalPayment) {
      const gstCheck = validateGst(mediaData.rentalPayment);
      if (!gstCheck.valid) return errorResponse(res, gstCheck.message, null, 400);
    }

    if (
      mediaData.landOwners?.length &&
      mediaData.rentalPayment?.totalRentalAmount
    ) {
      const tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable) || 0;
      const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
      const tdsPercentage =
        tdsApplicable === 1
          ? envTdsPercent > 0
            ? envTdsPercent
            : Number(mediaData.rentalPayment.tdsPercentage || 0)
          : 0;
      const rentalGstApplicable =
        Number(mediaData.rentalPayment.gstApplicable) || 0;

      const shareCheck = validateLandOwnerShares(
        mediaData.landOwners,
        Number(mediaData.rentalPayment.totalRentalAmount),
        tdsApplicable,
        tdsPercentage,
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

    let media;
    let isNew = false;

    if (id) {
      media = await MediaOnboarding.findById(id);
      if (!media)
        return errorResponse(res, "Media not found with this ID", null, 404);

      delete mediaData.id;

      await handleAppraisalLogic(mediaData, media, userName);

      if (Number(mediaData.appraisal?.applicable) === 1) {
        recomputeAppraisalSummary(
          mediaData.appraisal,
          Number(mediaData.rentalPayment?.totalRentalAmount || 0),
        );
      }

      if (mediaData.rentalPayment && mediaData.agreement) {
        mediaData.agreement.rentalPayment = {
          totalRentalAmount: mediaData.rentalPayment.totalRentalAmount || 0,
          paymentFrequency: mediaData.rentalPayment.paymentFrequency || 1,
        };
      }

      handleAgreementHistory(mediaData, media, userName);

      Object.keys(mediaData).forEach((key) => {
        if (!["_id", "__v", "createdAt", "mediaId"].includes(key)) {
          media[key] = mediaData[key];
        }
      });

      await media.save();
      media = await MediaOnboarding.findById(media._id).lean();
    } else {
      await handleAppraisalLogic(mediaData, null, userName);

      if (Number(mediaData.appraisal?.applicable) === 1) {
        recomputeAppraisalSummary(
          mediaData.appraisal,
          Number(mediaData.rentalPayment?.totalRentalAmount || 0),
        );
      }

      if (mediaData.rentalPayment && mediaData.agreement) {
        mediaData.agreement.rentalPayment = {
          totalRentalAmount: mediaData.rentalPayment.totalRentalAmount || 0,
          paymentFrequency: mediaData.rentalPayment.paymentFrequency || 1,
        };
      }

      handleAgreementHistory(mediaData, null, userName);

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






















// ──────────────────────────────────────────────────────────────
// UPDATED: handleAgreementHistory function
// ──────────────────────────────────────────────────────────────
const handleAgreementHistory = (mediaData, existingMedia, userName) => {
  const agreement = mediaData.agreement;
  if (!agreement || !agreement.startDate || !agreement.endDate) return;

  // Get existing history
  let history = existingMedia?.agreementHistory ? 
    existingMedia.agreementHistory.map(h => h.toObject ? h.toObject() : { ...h }) : 
    [];

  // Get current agreement from existing media
  const currentAgreement = existingMedia?.agreement;

  // Helper to compare dates
  const sameDay = (a, b) =>
    new Date(a).setHours(0, 0, 0, 0) === new Date(b).setHours(0, 0, 0, 0);

  // Check if current agreement is already in history
  if (currentAgreement && currentAgreement.startDate && currentAgreement.endDate) {
    const alreadyInHistory = history.some(h =>
      h.startDate && h.endDate &&
      sameDay(h.startDate, currentAgreement.startDate) &&
      sameDay(h.endDate, currentAgreement.endDate)
    );

    // If not in history, add it
    if (!alreadyInHistory) {
      // NEW: Get rentalPayment from current agreement or default
      const rentalPayment = currentAgreement.rentalPayment || {
        totalRentalAmount: mediaData.rentalPayment?.totalRentalAmount || 0,
        paymentFrequency: mediaData.rentalPayment?.paymentFrequency || 1,
      };

      history.push({
        startDate: new Date(currentAgreement.startDate),
        endDate: new Date(currentAgreement.endDate),
        reminderBeforeExpiry: currentAgreement.reminderBeforeExpiry || 30,
        advanceRent: currentAgreement.advanceRent || 0,
        reason: currentAgreement.reason || "",
        status: computeAgreementStatus(
          currentAgreement.startDate,
          currentAgreement.endDate,
          currentAgreement.reminderBeforeExpiry || 30
        ),
        agreementPDF: currentAgreement.agreementPDF ? { ...currentAgreement.agreementPDF } : undefined,
        // NEW: Include rentalPayment in history
        rentalPayment: {
          totalRentalAmount: rentalPayment.totalRentalAmount || 0,
          paymentFrequency: rentalPayment.paymentFrequency || 1,
        },
        updatedBy: userName || "Admin",
        uploadedAt: getISTDate(),
      });
    }
  }

  // Check if new agreement dates already exist in history
  const existingEntryIndex = history.findIndex(h =>
    h.startDate && h.endDate &&
    sameDay(h.startDate, agreement.startDate) &&
    sameDay(h.endDate, agreement.endDate)
  );

  // NEW: Get rentalPayment from agreement or rentalPayment object
  const newRentalPayment = agreement.rentalPayment || {
    totalRentalAmount: mediaData.rentalPayment?.totalRentalAmount || 0,
    paymentFrequency: mediaData.rentalPayment?.paymentFrequency || 1,
  };

  const newHistoryEntry = {
    startDate: new Date(agreement.startDate),
    endDate: new Date(agreement.endDate),
    reminderBeforeExpiry: agreement.reminderBeforeExpiry || 30,
    advanceRent: agreement.advanceRent || 0,
    reason: agreement.reason || "",
    status: computeAgreementStatus(
      agreement.startDate,
      agreement.endDate,
      agreement.reminderBeforeExpiry || 30
    ),
    agreementPDF: agreement.agreementPDF ? { ...agreement.agreementPDF } : undefined,
    // NEW: Include rentalPayment in history entry
    rentalPayment: {
      totalRentalAmount: newRentalPayment.totalRentalAmount || 0,
      paymentFrequency: newRentalPayment.paymentFrequency || 1,
    },
    updatedBy: userName || "Admin",
    uploadedAt: getISTDate(),
  };

  // Update or add to history
  if (existingEntryIndex !== -1) {
    // Update existing entry (preserve rentalPayment if not provided)
    const existingEntry = history[existingEntryIndex];
    history[existingEntryIndex] = {
      ...existingEntry,
      ...newHistoryEntry,
      rentalPayment: {
        totalRentalAmount: newRentalPayment.totalRentalAmount || existingEntry.rentalPayment?.totalRentalAmount || 0,
        paymentFrequency: newRentalPayment.paymentFrequency || existingEntry.rentalPayment?.paymentFrequency || 1,
      },
    };
  } else {
    // Add new entry
    history.push(newHistoryEntry);
  }

  // Update mediaData with new history
  mediaData.agreementHistory = history;

  // Also update agreement with rentalPayment if not present
  if (mediaData.agreement && !mediaData.agreement.rentalPayment) {
    mediaData.agreement.rentalPayment = {
      totalRentalAmount: mediaData.rentalPayment?.totalRentalAmount || 0,
      paymentFrequency: mediaData.rentalPayment?.paymentFrequency || 1,
    };
  }
};
const resolveActiveAgreement = (historyArr) => {
  if (!historyArr || !historyArr.length) return null;

  const now = new Date();
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

const updateAgreement = async (req, res) => {
  try {
    const { id } = req.body;
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
    const paymentFrequencyValue = incoming.paymentFrequency !== undefined
      ? Number(incoming.paymentFrequency)
      : media.agreement?.rentalPayment?.paymentFrequency || 1;

    const newAgreement = {
      startDate: new Date(incoming.startDate),
      endDate: new Date(incoming.endDate),
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
      // NEW: Rental payment details - only store the number
      rentalPayment: {
        totalRentalAmount: incoming.totalRentalAmount !== undefined
          ? Number(incoming.totalRentalAmount)
          : media.agreement?.rentalPayment?.totalRentalAmount || 0,
        paymentFrequency: paymentFrequencyValue, // Store as number (1-6)
      },
    };

    // ─────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────
    if (newAgreement.startDate >= newAgreement.endDate) {
      return errorResponse(res, "Start date must be before end date", null, 400);
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

    // Validate rental payment fields
    if (newAgreement.rentalPayment.totalRentalAmount < 0) {
      return errorResponse(res, "Total rental amount must be a positive number", null, 400);
    }

    const validPaymentFrequencies = [1, 2, 3, 4, 5, 6];
    if (!validPaymentFrequencies.includes(newAgreement.rentalPayment.paymentFrequency)) {
      return errorResponse(
        res,
        `paymentFrequency must be one of: ${validPaymentFrequencies.join(", ")} (1=Monthly, 2=2M, 3=3M, 4=6M, 5=1Y, 6=2Y)`,
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
    // 1. Make sure the current active agreement is preserved in history
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
        const currentPaymentFrequency = currentAgreement.rentalPayment?.paymentFrequency || 1;
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
          // NEW: Include rentalPayment in history (only number)
          rentalPayment: {
            totalRentalAmount: currentAgreement.rentalPayment?.totalRentalAmount || 0,
            paymentFrequency: currentPaymentFrequency,
          },
          updatedBy: userName,
          uploadedAt: getISTDate(),
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

    // New entry ONLY when the incoming date range is not already in history.
    const shouldCreateNewEntry = entryIndex === -1;

    // ─────────────────────────────────────────────
    // 3. Build the entry payload with rentalPayment
    // ─────────────────────────────────────────────
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
      // NEW: Include rentalPayment in entry payload (only number)
      rentalPayment: {
        totalRentalAmount: newAgreement.rentalPayment.totalRentalAmount,
        paymentFrequency: newAgreement.rentalPayment.paymentFrequency,
      },
      updatedBy: userName,
      uploadedAt: getISTDate(),
    };

    // ─────────────────────────────────────────────
    // 4. Create new entry OR update existing one in place
    // ─────────────────────────────────────────────
    if (shouldCreateNewEntry) {
      // Date range changed → add a fresh entry
      existingHistory.push(entryPayload);
    } else {
      // Same date range → update existing entry (no duplicate)
      // Preserve existing rentalPayment if not provided in new agreement
      const existingRentalPayment = existingHistory[entryIndex]?.rentalPayment || {};
      const paymentFreq = incoming.paymentFrequency !== undefined 
        ? Number(incoming.paymentFrequency) 
        : existingRentalPayment.paymentFrequency || 1;
      
      existingHistory[entryIndex] = {
        ...existingHistory[entryIndex],
        ...entryPayload,
        rentalPayment: {
          totalRentalAmount: incoming.totalRentalAmount !== undefined 
            ? Number(incoming.totalRentalAmount) 
            : existingRentalPayment.totalRentalAmount || 0,
          paymentFrequency: paymentFreq,
        },
      };
    }

    // ─────────────────────────────────────────────
    // Resolve which agreement should be "active"
    // ─────────────────────────────────────────────
    const activeAgreement = resolveActiveAgreement(existingHistory);

    // ─────────────────────────────────────────────
    // Persist
    // ─────────────────────────────────────────────
    media.agreementHistory = existingHistory;

    if (activeAgreement) {
      const activePaymentFreq = activeAgreement.rentalPayment?.paymentFrequency || 1;
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
        // NEW: Include rentalPayment in active agreement (only number)
        rentalPayment: {
          totalRentalAmount: activeAgreement.rentalPayment?.totalRentalAmount || 0,
          paymentFrequency: activePaymentFreq,
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

    media.updatedAt = getISTDate();
    await media.save();

    const saved = await MediaOnboarding.findById(media._id)
      .select("agreement agreementHistory")
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



// Media List
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


module.exports = {
  mediaOnboarding,
  mediaList,
  uploadExcel,
  updateAgreement,
  getMediaById,
};
