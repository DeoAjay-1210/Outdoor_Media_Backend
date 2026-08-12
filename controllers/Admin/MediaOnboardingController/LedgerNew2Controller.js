const mongoose = require("mongoose");
const { successResponse, errorResponse } = require("../../../utils/response");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema"); // adjust path to wherever MediaSchema.js actually lives in your project
const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const MONTH_NAMES = [
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

function getYearAndMonthName(date) {
  const d = new Date(date);
  return {
    year: String(d.getFullYear()),
    month: MONTH_NAMES[d.getMonth()],
  };
}
function getCurrentCycle(nextBillingDate) {
  if (!nextBillingDate) return null;
  const d = new Date(nextBillingDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(date) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
function advanceRentalPaymentOnOwnerApproval(media) {
  const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
  const frequency = media.rentalPayment?.paymentFrequency;
  const monthsToAdd = FREQUENCY_MONTHS_MAP[frequency] || 1;

  const baseDate = currentNextBillingDate
    ? new Date(currentNextBillingDate)
    : new Date();

  media.rentalPayment.lastBillPaidDate = baseDate;
  media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);

  // reset live agreement verification flags for the new cycle
  media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
  media.markModified("agreementDocVerified");

  if (Array.isArray(media.ledger) && media.ledger.length > 0) {
    media.ledger = [];
    media.markModified("ledger");
  }
  if (Array.isArray(media.withGst1Ledger) && media.withGst1Ledger.length > 0) {
    media.withGst1Ledger = [];
    media.markModified("withGst1Ledger");
  }
}

function recomputePendingMonths(media) {
  const mediaObj = media.toObject ? media.toObject() : media;

  const referenceDateRaw =
    mediaObj.rentalPayment?.lastBillPaidDate ||
    mediaObj.rentalPayment?.nextBillingDate ||
    null;

  if (!referenceDateRaw) {
    media.pendingMonths = [];
    media.markModified("pendingMonths");
    return;
  }

  const refDate = new Date(referenceDateRaw);
  const referenceYear = refDate.getUTCFullYear();
  const referenceMonthIndex = refDate.getUTCMonth();

  const savedLedgerMonthKeys = new Set();
  (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
    (yearBucket.months || []).forEach((monthBucket) => {
      const monthIdx = MONTH_NAMES.findIndex(
        (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
      );
      const entries = monthBucket.entries || [];
      const gst2Entries = entries.filter((e) => e.withGst === 2);

      const allOwnersComplete =
        (mediaObj.landOwners || []).length > 0 &&
        (mediaObj.landOwners || []).every((owner) => {
          const ownerEntries = gst2Entries.filter(
            (e) => String(e.landOwnerId) === String(owner._id),
          );
          const hasCash = ownerEntries.some((e) => e.paymentMode === "Cash");
          const hasOnline = ownerEntries.some(
            (e) => e.paymentMode === "Online",
          );
          const paymentCategory = Number(owner.paymentCategory || 1);
          if (paymentCategory === 1) return hasCash;
          if (paymentCategory === 2) return hasOnline;
          if (paymentCategory === 3) return hasCash && hasOnline;
          return hasCash || hasOnline;
        });

      if (allOwnersComplete) {
        savedLedgerMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
      }
    });
  });

  const neededMonthKeys = new Set();
  if (Array.isArray(mediaObj.rentalDue)) {
    mediaObj.rentalDue.forEach((due) => {
      if (!due.dueDate) return;
      const d = new Date(due.dueDate);
      if (isNaN(d.getTime())) return;
      neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
    });
  }
  if (mediaObj.rentalPayment?.lastBillPaidDate) {
    const d = new Date(mediaObj.rentalPayment.lastBillPaidDate);
    if (!isNaN(d.getTime())) {
      neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
    }
  }
  (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
    (yearBucket.months || []).forEach((monthBucket) => {
      const monthIdx = MONTH_NAMES.findIndex(
        (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
      );
      neededMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
    });
  });

  const pendingKeys = [];
  for (const key of neededMonthKeys) {
    const [yrStr, monthIdxStr] = key.split("-");
    const yr = Number(yrStr);
    const monthIdx = Number(monthIdxStr);
    // ✅ MUST be <= here, not
    const isUpToAndIncludingReference =
      yr < referenceYear ||
      (yr === referenceYear && monthIdx <= referenceMonthIndex);
    if (isUpToAndIncludingReference && !savedLedgerMonthKeys.has(key)) {
      pendingKeys.push({ yr, monthIdx });
    }
  }
  pendingKeys.sort((a, b) => a.yr - b.yr || a.monthIdx - b.monthIdx);

  const pendingMonths = [];

  pendingKeys.forEach((pendingMonth) => {
    const targetYear = String(pendingMonth.yr);
    const targetMonthName = MONTH_NAMES[pendingMonth.monthIdx];
    const targetMonthLabel = `${targetMonthName} ${pendingMonth.yr}`;
    const pendingCycleDate = new Date(
      Date.UTC(pendingMonth.yr, pendingMonth.monthIdx, 1),
    );

    const yearBucket = (mediaObj.ledgerHistory || []).find(
      (y) => String(y.year).trim() === targetYear,
    );
    const monthBucket = yearBucket?.months.find(
      (m) => m.month.toLowerCase() === targetMonthName.toLowerCase(),
    );
    const monthEntries = monthBucket?.entries || [];
    const gst2Entries = monthEntries.filter((e) => e.withGst === 2);

    const owners = [];

    (mediaObj.landOwners || []).forEach((owner) => {
      const paymentCategory = Number(owner.paymentCategory || 1);
      const ownerEntries = gst2Entries.filter(
        (e) => String(e.landOwnerId) === String(owner._id),
      );
      const cashEntry = ownerEntries.some((e) => e.paymentMode === "Cash");
      const onlineEntry = ownerEntries.some((e) => e.paymentMode === "Online");
      const ownerCashAmount =
        paymentCategory === 3
          ? Number(owner.cashAmount || 0)
          : Number(owner.shareAmount || 0);
      const ownerOnlineAmount =
        paymentCategory === 3
          ? Number(owner.onlineAmount || 0)
          : Number(owner.shareAmount || 0);
      if (paymentCategory === 1) {
        if (!cashEntry) {
          owners.push({
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            paymentCategory,
            paymentMode: "Cash",
            cashAmount: ownerCashAmount,
            cashEntry,
            pendingType: "cashPending",
          });
        }
      } else if (paymentCategory === 2) {
        if (!onlineEntry) {
          owners.push({
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            paymentCategory,
            paymentMode: "Online",
            onlineAmount: ownerOnlineAmount,
            onlineEntry,
            pendingType: "onlinePending",
          });
        }
      } else if (paymentCategory === 3) {
        if (!cashEntry) {
          owners.push({
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            paymentCategory,
            paymentMode: "Cash",
            cashAmount: ownerCashAmount,
            cashEntry,
            pendingType: "cashPending",
          });
        }
        if (!onlineEntry) {
          owners.push({
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            paymentCategory,
            paymentMode: "Online",
            onlineAmount: ownerOnlineAmount,
            onlineEntry,
            pendingType: "onlinePending",
          });
        }
      }
    });

    if (owners.length > 0) {
      pendingMonths.push({
        month: targetMonthLabel,
        cycle: pendingCycleDate,
        owners,
      });
    }
  });

  media.pendingMonths = pendingMonths;
  media.markModified("pendingMonths");
}

/* ═══════════════════════════════════════════════════════════════════════
 * ══════════════════ NEW — Rental-based outstanding helpers ══════════════
 * (Everything above this line is your ORIGINAL code, untouched.)
 * ═══════════════════════════════════════════════════════════════════════*/

/** "08-2026" -> { month:8, year:2026 } | null */
function parseMonthYearParam(monthYearStr) {
  if (!monthYearStr) return null;
  const match = /^(0[1-9]|1[0-2])-([0-9]{4})$/.exec(monthYearStr);
  if (!match) return null;
  return { month: Number(match[1]), year: Number(match[2]) };
}

/** "August 2026" -> { monthIdx, year } | null */
function parseDueMonthLabel(label) {
  if (!label) return null;
  const parts = String(label).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const monthIdx = MONTH_NAMES.findIndex(
    (m) => m.toLowerCase() === parts[0].toLowerCase(),
  );
  const year = Number(parts[1]);
  if (monthIdx === -1 || Number.isNaN(year)) return null;
  return { monthIdx, year };
}

/**
 * currentBillDate RULE (locked with the user):
 * currentBillDate = rentalPayment.lastBillPaidDate, ONLY IF that date's
 * month/year equals the requested currentMonth (or "now" if none given).
 * Otherwise "" — meaning the site is behind on its cycle relative to the
 * requested/current month.
 */
// function getCurrentBillDate(media, requestedMonthYear) {
//   const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate;
//   if (!lastBillPaidDate) return "";
//   const d = new Date(lastBillPaidDate);
//   if (Number.isNaN(d.getTime())) return "";

//   let refMonth, refYear;
//   if (requestedMonthYear) {
//     refMonth = requestedMonthYear.month - 1;
//     refYear = requestedMonthYear.year;
//   } else {
//     const now = new Date();
//     refMonth = now.getMonth();
//     refYear = now.getFullYear();
//   }

//   const matches =
//     d.getUTCMonth() === refMonth && d.getUTCFullYear() === refYear;
//   return matches ? lastBillPaidDate : "";
// }
function getCurrentBillDate(media, requestedMonthYear) {
  let liveMonthLabel;

  if (requestedMonthYear) {
    // caller explicitly wants a specific month evaluated
    liveMonthLabel = `${MONTH_NAMES[requestedMonthYear.month - 1]} ${requestedMonthYear.year}`;
  } else {
    const nextBillingDate = media.rentalPayment?.nextBillingDate;
    if (!nextBillingDate) return media.rentalPayment?.lastBillPaidDate || "";
    const d = new Date(nextBillingDate);
    if (Number.isNaN(d.getTime())) return media.rentalPayment?.lastBillPaidDate || "";
    liveMonthLabel = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  // ✅ dueMonth-based match — same label comparison style as
  // classifyDueMonthTargetType/isLiveCycleMonthLabel elsewhere in
  // this file.
 const matchedDue = (media.rentalDue || []).find(
    (due) =>
      String(due.dueMonth).trim().toLowerCase() === liveMonthLabel.toLowerCase(),
  );

  return matchedDue ? media.rentalPayment?.lastBillPaidDate || "" : "";
}
/** Sum of unpaid rows in rentalPayment.gstOutstandingHistory (pre-onboarding legacy GST debt) */
function sumUnpaidGstOutstanding(media) {
  return (media.rentalPayment?.gstOutstandingHistory || []).reduce(
    (sum, row) => {
      if (row.isPaid) return sum;
      return sum + Number(row.gstOutStandingAmount || 0);
    },
    0,
  );
}

/** Sum of unpaid rows in rentalPayment.rentalOutstandingHistory (pre-onboarding legacy rent debt) */
function sumUnpaidRentalOutstanding(media) {
  return (media.rentalPayment?.rentalOutstandingHistory || []).reduce(
    (sum, row) => {
      if (row.isPaid) return sum;
      return sum + Number(row.baseRentOutstandingAmount || 0);
    },
    0,
  );
}

function getCurrentBaseRent(media) {
  // ✅ FIXED — was zeroing out currentBaseRent the moment ANY single
  // Cash/Online entry existed, even if the owner's other required mode
  // (paymentCategory:3 needs BOTH) was still unpaid. Now checks
  // per-owner, per-required-mode completeness — same rule already used
  // by recomputePendingMonths/List API's isFullyPaid logic — and sums
  // only the genuinely remaining unpaid amount.
  const liveLedger = media.ledger || [];
  const owners = media.landOwners || [];

  if (owners.length === 0) {
    const netPayable = Number(media.rentalPayment?.totalRentalAmount || 0);
    const anyPaidThisCycle = liveLedger.some((e) => e.status === 1);
    return anyPaidThisCycle ? 0 : netPayable;
  }

  const getRequiredModes = (paymentCategory) => {
    if (paymentCategory === 1) return ["Cash"];
    if (paymentCategory === 2) return ["Online"];
    if (paymentCategory === 3) return ["Cash", "Online"];
    return ["Cash"];
  };

  let remainingDue = 0;
  owners.forEach((owner) => {
    const paymentCategory = Number(owner.paymentCategory || 1);
    const requiredModes = getRequiredModes(paymentCategory);

    requiredModes.forEach((mode) => {
      const isPaid = liveLedger.some(
        (e) =>
          e.status === 1 &&
          String(e.landOwnerId) === String(owner._id) &&
          e.paymentMode === mode,
      );
      if (isPaid) return;

      const modeAmount =
        mode === "Cash"
          ? Number(owner.cashAmount || owner.shareAmount || 0)
          : Number(owner.onlineAmount || owner.shareAmount || 0);
      remainingDue += modeAmount;
    });
  });

  return remainingDue;
}

/**
 * TotalOutstandingAmount = CurrentBaseRent + CurrentGSTDue
 *                         + PreviousBaseRentDue + PreviousGSTDue
 * where Previous* = (post-onboarding unpaid past cycles) + (pre-onboarding
 * legacy outstanding snapshot).
 */
function getLiveKeyForOutstanding(media, requestedMonthYear) {
  if (requestedMonthYear) {
    return `${requestedMonthYear.year}-${requestedMonthYear.month - 1}`;
  }
  const liveCycleDate = media.rentalPayment?.nextBillingDate;
  if (!liveCycleDate) return null;
  const liveDate = new Date(liveCycleDate);
  return `${liveDate.getUTCFullYear()}-${liveDate.getUTCMonth()}`;
}

function sumUnpaidPastCycleGst(media, requestedMonthYear) {
  const liveKey = getLiveKeyForOutstanding(media, requestedMonthYear);
  if (!liveKey) return 0;

  return (media.gstBalanceHistory || []).reduce((sum, row) => {
    if (row.isPaid) return sum;
    const parsed = parseDueMonthLabel(row.dueMonth);
    if (!parsed) return sum;
    const rowKey = `${parsed.year}-${parsed.monthIdx}`;
    if (rowKey === liveKey) return sum; // this is the CURRENT (requested) month, not past
    // ✅ also guard: only count rows strictly BEFORE the requested month as "previous"
    const [liveYr, liveMonthIdx] = liveKey.split("-").map(Number);
    const isBeforeLive =
      parsed.year < liveYr ||
      (parsed.year === liveYr && parsed.monthIdx < liveMonthIdx);
    if (!isBeforeLive) return sum; // future rows relative to requested month — ignore
    return sum + Number(row.gstAmount || 0);
  }, 0);
}

function getCurrentGstDue(media, requestedMonthYear) {
  const liveKey = getLiveKeyForOutstanding(media, requestedMonthYear);
  if (!liveKey) return 0;

  return (media.gstBalanceHistory || []).reduce((sum, row) => {
    if (row.isPaid) return sum;
    const parsed = parseDueMonthLabel(row.dueMonth);
    if (!parsed) return sum;
    const rowKey = `${parsed.year}-${parsed.monthIdx}`;
    if (rowKey !== liveKey) return sum;
    return sum + Number(row.gstAmount || 0);
  }, 0);
}

function sumUnpaidPastCycleRent(media, requestedMonthYear) {
  const liveKey = getLiveKeyForOutstanding(media, requestedMonthYear);
  if (!liveKey) return 0;
  const [liveYr, liveMonthIdx] = liveKey.split("-").map(Number);

  const pendingMonths = Array.isArray(media.pendingMonths)
    ? media.pendingMonths
    : [];

  return pendingMonths.reduce((sum, pm) => {
    const parts = String(pm.month || "")
      .trim()
      .split(/\s+/);
    const monthIdx = MONTH_NAMES.findIndex(
      (m) => m.toLowerCase() === parts[0]?.toLowerCase(),
    );
    const yr = Number(parts[1]);
    if (monthIdx === -1 || Number.isNaN(yr)) return sum;

    const isBeforeLive =
      yr < liveYr || (yr === liveYr && monthIdx < liveMonthIdx);
    if (!isBeforeLive) return sum;

    (pm.owners || []).forEach((o) => {
      if (o.pendingType === "cashPending") sum += Number(o.cashAmount || 0);
      else if (o.pendingType === "onlinePending")
        sum += Number(o.onlineAmount || 0);
    });
    return sum;
  }, 0);
}

function computeOutstandingSummary(media, requestedMonthYear) {
  const rentResult = getUnpaidRentForCycle(media, requestedMonthYear);
  const gstResult = getGstDueForCycles(media, requestedMonthYear);

  const currentBaseRent = rentResult.currentBaseRent;
  const currentGSTDue = gstResult.currentGSTDue;
  const previousBaseRentDue = rentResult.previousBaseRentDue + sumUnpaidRentalOutstanding(media);
  const previousGSTDue = gstResult.previousGSTDue + sumUnpaidGstOutstanding(media);

  return {
    currentBaseRent,
    currentGSTDue,
    previousBaseRentDue,
    previousGSTDue,
    totalOutstandingAmount:
      currentBaseRent + currentGSTDue + previousBaseRentDue + previousGSTDue,
  };
}

/**
 * Splits a due amount across Cash+Online for a paymentCategory:3 owner,
 * using their stored cashAmount/onlineAmount. Falls back to 50/50 if those
 * aren't configured.
 */
function splitAmountForOwner(owner, totalAmount) {
  const cashAmount = Number(owner?.cashAmount || 0);
  const onlineAmount = Number(owner?.onlineAmount || 0);
  if (cashAmount > 0 || onlineAmount > 0) {
    return { cash: cashAmount, online: onlineAmount };
  }
  const half = Math.round((totalAmount / 2) * 100) / 100;
  return { cash: half, online: totalAmount - half };
}
function getCycleMonthsForFrequency(paymentFrequency, customPaymentFrequency) {
  switch (Number(paymentFrequency)) {
    case 1: return 1;   // Monthly
    case 2: return 3;   // Quarterly
    case 3: return 6;   // Half-Yearly
    case 4: return 12;  // Yearly
    case 5: return 24;  // 2 Year
    case 6: return Number(customPaymentFrequency) || 1; // Custom
    default: return 1;
  }
}

function addMonthsUTC(date, months) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}
function getAllDueCycles(media, requestedMonthYear) {
  // ✅ CHANGED — anchor is now billingStartDate (immutable, set once at
  // onboarding, never touched by any approval/advance flow) instead of
  // lastBillPaidDate (which other code silently advances, breaking
  // cycle-walking for any media that already got advanced without a
  // genuine payment). Falls back to lastBillPaidDate only for OLD media
  // documents that haven't been backfilled with billingStartDate yet.
  const billingStartDate = media.rentalPayment?.billingStartDate;
  const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate;
  const anchorRaw = billingStartDate || lastBillPaidDate;
  if (!anchorRaw) return [];

  const cycleMonths = getCycleMonthsForFrequency(
    media.rentalPayment?.paymentFrequency,
    media.rentalPayment?.customPaymentFrequency,
  );

  const referenceDate = requestedMonthYear
    ? new Date(Date.UTC(requestedMonthYear.year, requestedMonthYear.month - 1, 1))
    : new Date();
  const refKey = `${referenceDate.getUTCFullYear()}-${referenceDate.getUTCMonth()}`;

const anchorDateObj = new Date(anchorRaw);
  const anchorMonthStart = new Date(Date.UTC(
    anchorDateObj.getUTCFullYear(),
    anchorDateObj.getUTCMonth(),
    1,
  ));

  let cursor = addMonthsUTC(anchorMonthStart, cycleMonths);

 const cycles = [];
  let guard = 0;
  while (guard < 240) {
    // ✅ FIXED — check BEFORE pushing. For non-monthly frequencies,
    // cycles rarely land exactly on the requested month, so pushing
    // first then checking overshoot always included one future,
    // not-yet-due cycle. Now: only push if this cycle's month is <= the
    // reference month.
    const cursorIsPastReference =
      cursor.getUTCFullYear() > referenceDate.getUTCFullYear() ||
      (cursor.getUTCFullYear() === referenceDate.getUTCFullYear() &&
        cursor.getUTCMonth() > referenceDate.getUTCMonth());
    if (cursorIsPastReference) break;

    cycles.push(new Date(cursor));

    const cursorKey = `${cursor.getUTCFullYear()}-${cursor.getUTCMonth()}`;
    const refKey = `${referenceDate.getUTCFullYear()}-${referenceDate.getUTCMonth()}`;
    if (cursorKey === refKey) break;

    cursor = addMonthsUTC(cursor, cycleMonths);
    guard++;
  }
  return cycles;
}
const MONTH_NAMES_FOR_CYCLES = MONTH_NAMES;

function getRequiredModesShared(paymentCategory) {
  if (paymentCategory === 1) return ["Cash"];
  if (paymentCategory === 2) return ["Online"];
  if (paymentCategory === 3) return ["Cash", "Online"];
  return ["Cash"];
}

function isOwnerModePaidForCycle(media, owner, mode, cycleDate, isLiveCycle) {
  if (isLiveCycle) {
    return (media.ledger || []).some(
      (e) =>
        e.status === 1 &&
        String(e.landOwnerId) === String(owner._id) &&
        e.paymentMode === mode,
    );
  }
  const cycleYear = String(cycleDate.getUTCFullYear());
  const cycleMonthName = MONTH_NAMES_FOR_CYCLES[cycleDate.getUTCMonth()];
  const yearBucket = (media.ledgerHistory || []).find((y) => y.year === cycleYear);
  const monthBucket = yearBucket?.months?.find(
    (m) => m.month.toLowerCase() === cycleMonthName.toLowerCase(),
  );
  return (monthBucket?.entries || []).some(
    (e) =>
      e.withGst === 2 &&
      e.paymentMode === mode &&
      String(e.landOwnerId) === String(owner._id),
  );
}

function getUnpaidRentForCycle(media, requestedMonthYear) {
  const owners = media.landOwners || [];
  const cycles = getAllDueCycles(media, requestedMonthYear);
  if (cycles.length === 0) {
    return { currentBaseRent: 0, previousBaseRentDue: 0 };
  }

  const liveCycleKey = `${cycles[cycles.length - 1].getUTCFullYear()}-${cycles[cycles.length - 1].getUTCMonth()}`;

  let currentBaseRent = 0;
  let previousBaseRentDue = 0;

  cycles.forEach((cycleDate) => {
    const cycleKey = `${cycleDate.getUTCFullYear()}-${cycleDate.getUTCMonth()}`;
    const isLiveCycle = cycleKey === liveCycleKey;

    let cycleUnpaid = 0;
    if (owners.length === 0) {
      cycleUnpaid = isLiveCycle ? Number(media.rentalPayment?.totalRentalAmount || 0) : 0;
    } else {
      owners.forEach((owner) => {
        const paymentCategory = Number(owner.paymentCategory || 1);
        getRequiredModesShared(paymentCategory).forEach((mode) => {
          const isPaid = isOwnerModePaidForCycle(media, owner, mode, cycleDate, isLiveCycle);
          if (isPaid) return;
          const modeAmount =
            mode === "Cash"
              ? Number(owner.cashAmount || owner.shareAmount || 0)
              : Number(owner.onlineAmount || owner.shareAmount || 0);
          cycleUnpaid += modeAmount;
        });
      });
    }

    if (isLiveCycle) currentBaseRent += cycleUnpaid;
    else previousBaseRentDue += cycleUnpaid;
  });

  return { currentBaseRent, previousBaseRentDue };
}

function resolveExpectedGstForCycle(media) {
  const gstFlag = Number(media.gstApplicableFlag || 0);
  if (gstFlag === 1) {
    return Number(media.rentalPayment?.gstApplicable) === 1
      ? Number(media.rentalPayment?.gstAmount || 0)
      : 0;
  }
  return (media.landOwners || [])
    .filter((o) => Number(o.gstApplicable) === 1)
    .reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
}

function getGstDueForCycles(media, requestedMonthYear) {
  const cycles = getAllDueCycles(media, requestedMonthYear);
  if (cycles.length === 0) {
    return { currentGSTDue: 0, previousGSTDue: 0 };
  }
  const liveCycleKey = `${cycles[cycles.length - 1].getUTCFullYear()}-${cycles[cycles.length - 1].getUTCMonth()}`;
  const expectedGstPerCycle = resolveExpectedGstForCycle(media);

  let currentGSTDue = 0;
  let previousGSTDue = 0;

  cycles.forEach((cycleDate) => {
    const cycleKey = `${cycleDate.getUTCFullYear()}-${cycleDate.getUTCMonth()}`;
    const isLiveCycle = cycleKey === liveCycleKey;
    const cycleMonthLabel = `${MONTH_NAMES_FOR_CYCLES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;

    const paidRow = (media.gstBalanceHistory || []).find(
      (row) => row.dueMonth === cycleMonthLabel && row.isPaid,
    );
    if (paidRow) return;

    const unpaidRow = (media.gstBalanceHistory || []).find(
      (row) => row.dueMonth === cycleMonthLabel && !row.isPaid,
    );
    const amount = unpaidRow ? Number(unpaidRow.gstAmount || 0) : expectedGstPerCycle;

    if (isLiveCycle) currentGSTDue += amount;
    else previousGSTDue += amount;
  });

  return { currentGSTDue, previousGSTDue };
}

function buildAutoRentalDueEntries(media, requestedMonthYear) {
  const cycles = getAllDueCycles(media, requestedMonthYear);
  if (cycles.length === 0) return [];

  const liveCycleKey = `${cycles[cycles.length - 1].getUTCFullYear()}-${cycles[cycles.length - 1].getUTCMonth()}`;
  const expectedGstPerCycle = resolveExpectedGstForCycle(media);
  const owners = media.landOwners || [];

  return cycles.map((cycleDate) => {
    const cycleKey = `${cycleDate.getUTCFullYear()}-${cycleDate.getUTCMonth()}`;
    const isLiveCycle = cycleKey === liveCycleKey;
    const cycleMonthLabel = `${MONTH_NAMES_FOR_CYCLES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;

    let cycleUnpaidRent = 0;
    let cashAmount = 0;
    let onlineAmount = 0;

    if (owners.length === 0) {
      cycleUnpaidRent = isLiveCycle ? Number(media.rentalPayment?.totalRentalAmount || 0) : 0;
    } else {
      owners.forEach((owner) => {
        const paymentCategory = Number(owner.paymentCategory || 1);
        getRequiredModesShared(paymentCategory).forEach((mode) => {
          const isPaid = isOwnerModePaidForCycle(media, owner, mode, cycleDate, isLiveCycle);
          const modeAmount =
            mode === "Cash"
              ? Number(owner.cashAmount || owner.shareAmount || 0)
              : Number(owner.onlineAmount || owner.shareAmount || 0);
          if (!isPaid) {
            cycleUnpaidRent += modeAmount;
            if (mode === "Cash") cashAmount += modeAmount;
            else onlineAmount += modeAmount;
          }
        });
      });
    }

    const paidGstRow = (media.gstBalanceHistory || []).find(
      (row) => row.dueMonth === cycleMonthLabel && row.isPaid,
    );
    const unpaidGstRow = (media.gstBalanceHistory || []).find(
      (row) => row.dueMonth === cycleMonthLabel && !row.isPaid,
    );
    const cycleGstAmount = paidGstRow
      ? 0
      : unpaidGstRow
        ? Number(unpaidGstRow.gstAmount || 0)
        : expectedGstPerCycle;

    const matchedRealDue = (media.rentalDue || []).find((d) => d.dueMonth === cycleMonthLabel);
    return {
      _id: matchedRealDue?._id || null, // ✅ NEW — real rentalDueId, now that ensureRentalDueForCycles guarantees it exists
      dueMonth: cycleMonthLabel,
      dueDate: cycleDate,
      netPayable: Number(media.rentalPayment?.totalRentalAmount || 0),
      withGst: expectedGstPerCycle > 0 ? 2 : null,
      gstAmount: cycleGstAmount,
      cashAmount,
      onlineAmount,
      isPaid: cycleUnpaidRent === 0,
      isCurrentCycle: isLiveCycle,
    };
  });
}

/**
 * Defensive dedupe for gstBalanceHistory: collapses accidental duplicate
 * rows sharing the same rentalDueId + dueMonth where one has a real
 * landOwnerId and another has landOwnerId:null (the placeholder-duplicate
 * bug reported). Keeps the real-owner row, drops the null-owner one, ONLY
 * when both exist for the same rentalDueId+dueMonth pairing. Does not
 * touch or reorder anything else.
 */
function dedupeGstBalanceHistory(gstBalanceHistoryArr) {
  const list = gstBalanceHistoryArr || [];
  const byKey = new Map();
  const withoutOwnerKey = new Map();

  list.forEach((row) => {
    const key = `${row.rentalDueId || ""}_${row.dueMonth || ""}`;
    if (row.landOwnerId) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    } else {
      if (!withoutOwnerKey.has(key)) withoutOwnerKey.set(key, []);
      withoutOwnerKey.get(key).push(row);
    }
  });

  const result = [];
  list.forEach((row) => {
    const key = `${row.rentalDueId || ""}_${row.dueMonth || ""}`;
    const hasRealOwnerVersion = byKey.has(key) && byKey.get(key).length > 0;
    if (!row.landOwnerId && hasRealOwnerVersion) {
      return; // drop the null-owner placeholder — a real-owner row covers this key
    }
    result.push(row);
  });
  return result;
}

/**
 * ✅ NEW — classifies a dueMonth label ("August 2026") as "current",
 * "pastCycle" relative to a site's live cycle (nextBillingDate), used to
 * fill in targetType/breakdown on billGroups built from already-saved
 * ledger entries (which don't store targetType directly — it's inferred
 * here from the month vs. the site's live cycle, same logic as
 * getCurrentGstDue/sumUnpaidPastCycleGst above).
 */
function classifyDueMonthTargetType(dueMonthLabel, nextBillingDate) {
  if (!dueMonthLabel || !nextBillingDate) return "current";
  const parsed = parseDueMonthLabel(dueMonthLabel);
  if (!parsed) return "current";
  const liveDate = new Date(nextBillingDate);
  const liveKey = `${liveDate.getUTCFullYear()}-${liveDate.getUTCMonth()}`;
  const rowKey = `${parsed.year}-${parsed.monthIdx}`;
  return rowKey === liveKey ? "current" : "pastCycle";
}
function isLiveCycleMonthLabel(media, monthLabel) {
  if (!monthLabel) return true; // no month given -> default/original behavior (live)
  const liveDate = media.rentalPayment?.nextBillingDate;
  if (!liveDate) return true;
  const d = new Date(liveDate);
  const liveLabel = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return String(monthLabel).trim().toLowerCase() === liveLabel.toLowerCase();
}
/* ═══════════════════════════════════════════════════════════════════════
 * createLedgerEntry — ORIGINAL entries[] flow kept 100% AS-IS below.
 * NEW: an optional `outstandingEntries[]` array is processed afterward for
 * the pastCycle/outstanding flows. Nothing in the original entries[]
 * handling is modified.
 * ═══════════════════════════════════════════════════════════════════════*/
exports.createLedgerEntry = async (req, res) => {
  try {
    // ✅ NEW — single API, two shapes. If the request carries payments[]
    // (the siteBillMode/multi-site/multi-owner/mixed-targetType shape),
    // dispatch to the bulk handler and return. Otherwise fall through to
    // the original single-media mediaId+entries[]/outstandingEntries[]
    // flow below, completely unchanged.
    if (Array.isArray(req.body.payments)) {
      return runBulkLedgerEntry(req, res);
    }

    const { mediaId } = req.body;
    let { entries, outstandingEntries } = req.body;
    const {
      entryType,
      targetType,
      landOwnerId,
      rentalDueId,
      paymentMode,
      utrNumber,
      date,
      paymentSplits,
    } = req.body;
    if (entryType && targetType && !entries && !outstandingEntries) {
      if (entryType === "rental" && targetType === "current") {
        entries = [
          {
            landOwnerId,
            rentalDueId,
            paymentMode,
            utrNumber,
            date,
            // withGst: 2,
          },
        ];
      } else if (entryType === "gst" && targetType === "current") {
        entries = [
          {
            landOwnerId,
            rentalDueId,
            paymentMode,
            utrNumber,
            date,
            withGst: 1,
          },
        ];
      } else {
        // pastCycle / outstanding (gst or rental) — route through outstandingEntries[]
        outstandingEntries = [
          {
            entryType,
            targetType,
            landOwnerId,
            paymentMode,
            utrNumber,
            date,
            paymentSplits,
            gstBalanceHistoryId: req.body.gstBalanceHistoryId,
            gstOutstandingId: req.body.gstOutstandingId,
            rentalOutstandingId: req.body.rentalOutstandingId,
          },
        ];
      }
    }
    if (!mediaId) return errorResponse(res, "mediaId is required", null, 400);
    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
    }

    const media = await Media.findById(mediaId);
    if (!media)
      return errorResponse(res, "Media not found for given mediaId", null, 404);

    if (!Array.isArray(media.ledger)) media.ledger = [];
    if (!Array.isArray(media.withGst1Ledger)) media.withGst1Ledger = [];
    if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
    if (!Array.isArray(media.gstBalanceHistory)) media.gstBalanceHistory = [];
    if (!Array.isArray(media.tdsBalanceHistory)) media.tdsBalanceHistory = [];
    if (!media.rentalPayment.gstOutstandingHistory)
      media.rentalPayment.gstOutstandingHistory = [];
    if (!media.rentalPayment.rentalOutstandingHistory)
      media.rentalPayment.rentalOutstandingHistory = [];

    const hasEntries = Array.isArray(entries) && entries.length > 0;
    const hasOutstandingEntries =
      Array.isArray(outstandingEntries) && outstandingEntries.length > 0;

    if (!hasEntries && !hasOutstandingEntries) {
      return errorResponse(
        res,
        "Provide entries[] and/or outstandingEntries[] (at least one, non-empty)",
        null,
        400,
      );
    }

    const savedLedgerEntries = [];
    const savedTdsRecords = [];
    const historyBuckets = [];
    const updatedGstBalanceRecords = [];
    const savedOutstandingResults = []; // ← NEW

    if (hasEntries) {
      // ── Validate every entry ── (UNCHANGED from your original code)
      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];

        const hasPaymentMode =
          item.paymentMode !== undefined && item.paymentMode !== null;
        const hasWithTds = item.withTds !== undefined && item.withTds !== null;

        if (!hasPaymentMode && !hasWithTds) {
          return errorResponse(
            res,
            `entries[${i}] must include paymentMode or withTds`,
            null,
            400,
          );
        }

        if (hasPaymentMode) {
          if (!["Cash", "Online"].includes(item.paymentMode)) {
            return errorResponse(
              res,
              `entries[${i}].paymentMode must be "Cash" or "Online"`,
              null,
              400,
            );
          }
          if (item.paymentMode === "Online" && !item.utrNumber) {
            return errorResponse(
              res,
              `entries[${i}].utrNumber is required when paymentMode is "Online"`,
              null,
              400,
            );
          }
          if (![1, 2].includes(Number(item.withGst ?? item.withGst))) {
            return errorResponse(
              res,
              `entries[${i}].withGst (or withGst) must be 1 or 2 when paymentMode is present`,
              null,
              400,
            );
          }
          const withGstValue = Number(item.withGst ?? item.withGst);
          if (withGstValue === 1 && !item.rentalDueId) {
            return errorResponse(
              res,
              `entries[${i}].rentalDueId is required when withGst (or withGst) is 1`,
              null,
              400,
            );
          }
        }

        if (hasWithTds && Number(item.withTds) === 1 && !item.utrNumber) {
          return errorResponse(
            res,
            `entries[${i}].utrNumber is required when withTds is 1`,
            null,
            400,
          );
        }
        if (hasWithTds && Number(item.withTds) === 1 && !item.landOwnerId) {
          return errorResponse(
            res,
            `entries[${i}].landOwnerId is required when withTds is 1`,
            null,
            400,
          );
        }
        if (item.landOwnerId) {
          if (!mongoose.Types.ObjectId.isValid(item.landOwnerId)) {
            return errorResponse(
              res,
              `entries[${i}].landOwnerId is not a valid ObjectId`,
              null,
              400,
            );
          }
          // ✅ CHANGED — accept EITHER the embedded landOwners._id OR the
          // landOwnerMasterId (what the client is actually sending)
          let matchedOwner =
            media.landOwners.id(item.landOwnerId) ||
            media.landOwners.find(
              (o) => String(o.landOwnerMasterId) === String(item.landOwnerId),
            );
          if (!matchedOwner && item.landOwnerName) {
            matchedOwner = media.landOwners.find(
              (o) => o.name === item.landOwnerName,
            );
          }

          if (!matchedOwner) {
            return errorResponse(
              res,
              `entries[${i}].landOwnerId does not match any landOwner on this media (checked both landOwners._id and landOwnerMasterId)`,
              null,
              400,
            );
          }
        }
      }

      const currentCycle = getCurrentCycle(
        media.rentalPayment?.nextBillingDate,
      );

      let gst2SlotIndex = 0;

      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        const entryDate = item.date ? new Date(item.date) : new Date();
        const matchedOwner = item.landOwnerId
          ? media.landOwners.id(item.landOwnerId) ||
            media.landOwners.find(
              (o) => String(o.landOwnerMasterId) === String(item.landOwnerId),
            )
          : null;
        const withGst = Number(item.withGst ?? item.withGst);

        // ══════════════════════════════════════════════════════
        // LEDGER (paymentMode: Cash / Online) — routes to `ledger`
        // (withGst===2) or `withGst1Ledger` (withGst===1)
        // ══════════════════════════════════════════════════════
        if (item.paymentMode) {
          const ledgerEntryData = {
            landOwnerId: matchedOwner ? matchedOwner._id : null,
            landOwnerName: matchedOwner ? matchedOwner.name : "",
            utrNumber: item.paymentMode === "Online" ? item.utrNumber : null,
            paymentMode: item.paymentMode,
            date: entryDate,
            status: 1,
            cycle: currentCycle,
            updatedBy: req.user?.userName || "Admin",
            updatedAt: nowIST(),
            withGst,
            month: item.month || null,
            rentalDueId: item.rentalDueId || null,
            // ✅ NEW field only — amount, when caller supplies it (optional,
            // does not affect any existing matching/upsert logic below)
            amount: item.amount !== undefined ? Number(item.amount) : 0,
          };

          let savedLedgerEntry;

          if (withGst === 2) {
            const existingIdx = media.ledger.findIndex(
              (e) =>
                String(e.landOwnerId || "") ===
                  String(ledgerEntryData.landOwnerId || "") &&
                e.paymentMode === ledgerEntryData.paymentMode,
            );

            if (existingIdx !== -1) {
              const preservedIndex = media.ledger[existingIdx].index;
              ledgerEntryData.index = preservedIndex;
              Object.assign(media.ledger[existingIdx], ledgerEntryData);
              savedLedgerEntry = media.ledger[existingIdx];
            } else {
              ledgerEntryData.index = media.ledger.length;
              media.ledger.push(ledgerEntryData);
              savedLedgerEntry = media.ledger[media.ledger.length - 1];
            }
            media.markModified("ledger");
          } else {
            const existingIndex = media.withGst1Ledger.findIndex((existing) => {
              if (item.rentalDueId) {
                return (
                  String(existing.rentalDueId || "") ===
                  String(item.rentalDueId)
                );
              }
              return (
                String(existing.landOwnerId || "") ===
                  String(ledgerEntryData.landOwnerId || "") &&
                existing.month === item.month
              );
            });

            if (existingIndex !== -1) {
              Object.assign(
                media.withGst1Ledger[existingIndex],
                ledgerEntryData,
              );
              savedLedgerEntry = media.withGst1Ledger[existingIndex];
            } else {
              media.withGst1Ledger.push(ledgerEntryData);
              savedLedgerEntry =
                media.withGst1Ledger[media.withGst1Ledger.length - 1];
            }
            media.markModified("withGst1Ledger");
          }

          savedLedgerEntries.push(savedLedgerEntry);

          if (item.rentalDueId) {
            const matchingGstRecords = media.gstBalanceHistory.filter(
              (g) => String(g.rentalDueId) === String(item.rentalDueId),
            );
            matchingGstRecords.forEach((g) => {
              g.utrNumber = item.utrNumber;
              g.date = entryDate;
              g.isUtrEntry = true;
              g.updatedBy = req.user?.userName || "";
              g.updatedAt = nowIST();
              updatedGstBalanceRecords.push(g);
            });
            if (matchingGstRecords.length > 0)
              media.markModified("gstBalanceHistory");
          }

          let bucketYear;
          let bucketMonthName;

          if (item.month) {
            const parts = item.month.trim().split(/\s+/);
            const monthToken = parts[0];
            const yearToken = parts[1];

            const matchedMonthIdx = MONTH_NAMES.findIndex(
              (m) =>
                m.toLowerCase() === monthToken.toLowerCase() ||
                m.toLowerCase().startsWith(monthToken.toLowerCase()),
            );

            if (
              matchedMonthIdx !== -1 &&
              yearToken &&
              /^\d{4}$/.test(yearToken)
            ) {
              bucketYear = yearToken;
              bucketMonthName = MONTH_NAMES[matchedMonthIdx];
            }
          }

          if (!bucketYear || !bucketMonthName) {
            const fallback = getYearAndMonthName(entryDate);
            bucketYear = fallback.year;
            bucketMonthName = fallback.month;
          }

          let yearBucket = media.ledgerHistory.find(
            (y) => y.year === bucketYear,
          );
          if (!yearBucket) {
            media.ledgerHistory.push({ year: bucketYear, months: [] });
            yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
          }
          let monthBucket = yearBucket.months.find(
            (m) => m.month === bucketMonthName,
          );
          if (!monthBucket) {
            yearBucket.months.push({ month: bucketMonthName, entries: [] });
            monthBucket = yearBucket.months[yearBucket.months.length - 1];
          }
          monthBucket.entries.push({
            landOwnerId: matchedOwner ? matchedOwner._id : null,
            landOwnerName: matchedOwner ? matchedOwner.name : "",
            mediaName: media.mediaName,
            paymentFrequency: media.rentalPayment.paymentFrequency,
            netPayable: media.rentalPayment.netPayable,
            nextBillingDate: media.rentalPayment.nextBillingDate,
            lastBillPaidDate: media.rentalPayment.lastBillPaidDate,
            utrNumber: savedLedgerEntry.utrNumber,
            paymentMode: item.paymentMode,
            date: savedLedgerEntry.date,
            updatedBy: req.user?.userName || "Admin",
            updatedAt: nowIST(),
            withGst,
            month: item.month || null,
            rentalDueId: item.rentalDueId || null,
            index: withGst === 2 ? ledgerEntryData.index : null,
            amount: ledgerEntryData.amount, // ✅ NEW field only
          });
          historyBuckets.push({ year: bucketYear, month: bucketMonthName });
        }

        // ══════════════════════════════════════════════════════
        // ✅ TDS — withTds: 1, UPSERT by landOwnerId + month
        // ══════════════════════════════════════════════════════
        if (Number(item.withTds) === 1) {
          const { year, month: monthName } = getYearAndMonthName(entryDate);
          const dueMonth = item.month || `${monthName} ${year}`;

          let tdsAmount = matchedOwner
            ? Number(matchedOwner.tdsAmount || 0)
            : 0;

          let tdsRecord = media.tdsBalanceHistory.find(
            (t) =>
              String(t.landOwnerId) === String(matchedOwner?._id) &&
              t.dueMonth === dueMonth,
          );

          if (!tdsRecord) {
            media.tdsBalanceHistory.push({
              dueMonth,
              cycle: currentCycle,
              tdsAmount,
              isUtrEntry: true,
              paidAmount: tdsAmount,
              paidAt: entryDate,
              paidBy: req.user?.userName || "Admin",
              createdAt: nowIST(),
              createdBy: req.user?.userName || "Admin",
              landOwnerId: matchedOwner ? matchedOwner._id : null,
              landOwnerName: matchedOwner ? matchedOwner.name : "",
              utrNumber: item.utrNumber,
              date: item.date,
            });
            tdsRecord =
              media.tdsBalanceHistory[media.tdsBalanceHistory.length - 1];
          } else {
            tdsRecord.tdsAmount = tdsAmount;
            tdsRecord.isUtrEntry = true;
            tdsRecord.paidAmount = tdsAmount;
            tdsRecord.paidAt = entryDate;
            tdsRecord.paidBy = req.user?.userName || "Admin";
            tdsRecord.utrNumber = item.utrNumber;
            tdsRecord.date = entryDate;
            tdsRecord.dueMonth = dueMonth;
          }
          media.markModified("tdsBalanceHistory");
          savedTdsRecords.push(tdsRecord);
        }
      }
    }

    /* ═════════════════════════════════════════════════════════════════
     * ══════════════ NEW — outstandingEntries[] processing ═════════════
     * Handles: gst+pastCycle, gst+outstanding, rental+outstanding.
     * (rental+pastCycle is already covered above via entries[] + an
     * explicit item.month override — no new code needed for that case.)
     * ═════════════════════════════════════════════════════════════════*/
    if (hasOutstandingEntries) {
      for (let i = 0; i < outstandingEntries.length; i++) {
        const item = outstandingEntries[i];
        const {
          entryType,
          targetType,
          landOwnerId,
          paymentMode,
          utrNumber,
          date,
          paymentSplits,
          gstBalanceHistoryId,
          gstOutstandingId,
          rentalOutstandingId,
        } = item;

        if (!["gst", "rental"].includes(entryType)) {
          return errorResponse(
            res,
            `outstandingEntries[${i}].entryType must be "gst" or "rental"`,
            null,
            400,
          );
        }
        if (!["pastCycle", "outstanding"].includes(targetType)) {
          return errorResponse(
            res,
            `outstandingEntries[${i}].targetType must be "pastCycle" or "outstanding"`,
            null,
            400,
          );
        }
        if (!landOwnerId || !mongoose.Types.ObjectId.isValid(landOwnerId)) {
          return errorResponse(
            res,
            `outstandingEntries[${i}].landOwnerId is required and must be valid`,
            null,
            400,
          );
        }
        const owner = media.landOwners.id(landOwnerId);
        if (!owner) {
          return errorResponse(
            res,
            `outstandingEntries[${i}].landOwnerId does not match any landOwner`,
            null,
            400,
          );
        }

        const hasSingleMode = !!paymentMode;
        const hasSplits =
          Array.isArray(paymentSplits) && paymentSplits.length > 0;
        if (hasSingleMode === hasSplits) {
          return errorResponse(
            res,
            `outstandingEntries[${i}] must provide exactly one of paymentMode or paymentSplits`,
            null,
            400,
          );
        }
        if (hasSingleMode && !["Cash", "Online"].includes(paymentMode)) {
          return errorResponse(
            res,
            `outstandingEntries[${i}].paymentMode must be "Cash" or "Online"`,
            null,
            400,
          );
        }
        if (hasSingleMode && paymentMode === "Online" && !utrNumber) {
          return errorResponse(
            res,
            `outstandingEntries[${i}].utrNumber is required when paymentMode is Online`,
            null,
            400,
          );
        }
        let onlineSplit = null;
        if (hasSplits) {
          const modes = paymentSplits.map((s) => s.paymentMode);
          if (
            !modes.includes("Cash") ||
            !modes.includes("Online") ||
            modes.length !== 2
          ) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].paymentSplits must contain exactly one Cash and one Online entry`,
              null,
              400,
            );
          }
          onlineSplit = paymentSplits.find((s) => s.paymentMode === "Online");
          if (!onlineSplit?.utrNumber) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].paymentSplits Online entry requires utrNumber`,
              null,
              400,
            );
          }
        }

        const entryDate = date ? new Date(date) : nowIST();
        const updatedBy = req.user?.userName || "Admin";

        if (entryType === "gst" && targetType === "pastCycle") {
          if (!gstBalanceHistoryId) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].gstBalanceHistoryId is required for gst+pastCycle`,
              null,
              400,
            );
          }
          const row = media.gstBalanceHistory.id(gstBalanceHistoryId);
          if (!row) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].gstBalanceHistoryId does not match any gstBalanceHistory record`,
              null,
              400,
            );
          }
          const totalAmount = Number(row.gstAmount || 0);
          if (hasSplits) {
            const { cash, online } = splitAmountForOwner(owner, totalAmount);
            row.paymentBreakup = [
              {
                paymentMode: "Cash",
                amount: cash,
                utrNumber: null,
                date: entryDate,
              },
              {
                paymentMode: "Online",
                amount: online,
                utrNumber: onlineSplit.utrNumber,
                date: entryDate,
              },
            ];
            row.paymentMode = "Cash+Online";
            row.utrNumber = onlineSplit.utrNumber;
          } else {
            row.paymentMode = paymentMode;
            row.utrNumber = paymentMode === "Online" ? utrNumber : "";
          }
          row.isPaid = true;
          row.isUtrEntry = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("gstBalanceHistory");
          savedOutstandingResults.push({
            entryType,
            targetType,
            updatedGstBalanceEntry: row.toObject(),
          });
        } else if (entryType === "gst" && targetType === "outstanding") {
          if (!gstOutstandingId) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].gstOutstandingId is required for gst+outstanding`,
              null,
              400,
            );
          }
          const row =
            media.rentalPayment.gstOutstandingHistory.id(gstOutstandingId);
          if (!row) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].gstOutstandingId does not match any gstOutstandingHistory record`,
              null,
              400,
            );
          }
          const totalAmount = Number(row.gstOutStandingAmount || 0);
          if (hasSplits) {
            const { cash, online } = splitAmountForOwner(owner, totalAmount);
            row.paymentBreakup = [
              {
                paymentMode: "Cash",
                amount: cash,
                utrNumber: null,
                date: entryDate,
              },
              {
                paymentMode: "Online",
                amount: online,
                utrNumber: onlineSplit.utrNumber,
                date: entryDate,
              },
            ];
            row.paymentMode = "Cash+Online";
            row.utrNumber = onlineSplit.utrNumber;
          } else {
            row.paymentMode = paymentMode;
            row.utrNumber = paymentMode === "Online" ? utrNumber : null;
          }
          row.isPaid = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("rentalPayment");
          savedOutstandingResults.push({
            entryType,
            targetType,
            updatedGstOutstandingEntry: row.toObject(),
          });
        } else if (entryType === "rental" && targetType === "outstanding") {
          if (!rentalOutstandingId) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].rentalOutstandingId is required for rental+outstanding`,
              null,
              400,
            );
          }
          const row =
            media.rentalPayment.rentalOutstandingHistory.id(
              rentalOutstandingId,
            );
          if (!row) {
            return errorResponse(
              res,
              `outstandingEntries[${i}].rentalOutstandingId does not match any rentalOutstandingHistory record`,
              null,
              400,
            );
          }
          const totalAmount = Number(row.baseRentOutstandingAmount || 0);
          if (hasSplits) {
            const { cash, online } = splitAmountForOwner(owner, totalAmount);
            row.paymentBreakup = [
              {
                paymentMode: "Cash",
                amount: cash,
                utrNumber: null,
                date: entryDate,
              },
              {
                paymentMode: "Online",
                amount: online,
                utrNumber: onlineSplit.utrNumber,
                date: entryDate,
              },
            ];
            row.paymentMode = "Cash+Online";
            row.utrNumber = onlineSplit.utrNumber;
          } else {
            row.paymentMode = paymentMode;
            row.utrNumber = paymentMode === "Online" ? utrNumber : null;
          }
          row.isPaid = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("rentalPayment");
          savedOutstandingResults.push({
            entryType,
            targetType,
            updatedRentalOutstandingEntry: row.toObject(),
          });
        } else {
          return errorResponse(
            res,
            `outstandingEntries[${i}]: rental+pastCycle is not handled here — send it through entries[] with an explicit "month" field instead (reuses your existing ledgerHistory bucketing logic)`,
            null,
            400,
          );
        }
      }
    }

    recomputePendingMonths(media);
    await media.save();

    // ✅ NEW — outstanding summary + currentBillDate appended to response
    const outstanding = computeOutstandingSummary(media, null); // save response always reflects the site's actual live cycle, not a requested month
    const currentBillDate = getCurrentBillDate(media, null);
    const currentCycleForResponse = getCurrentCycle(
      media.rentalPayment?.nextBillingDate,
    );

    return successResponse(
      res,
      "Ledger entry created successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        ledgerEntries: savedLedgerEntries,
        tdsRecords: savedTdsRecords,
        ledgerHistoryBuckets: historyBuckets,
        currentCycle: formatDate(currentCycleForResponse),
        currentLedger: media.ledger,
        currentWithGst1Ledger: media.withGst1Ledger,
        updatedGstBalanceRecords,
        gstBalanceHistory: media.gstBalanceHistory,
        tdsBalanceHistory: media.tdsBalanceHistory,

        // ══ NEW ══
        outstandingResults: savedOutstandingResults,
        outstanding,
        lastBillDate: formatDate(media.rentalPayment?.lastBillPaidDate),
        nextBillingDate: formatDate(media.rentalPayment?.nextBillingDate),
        currentBillDate: currentBillDate ? formatDate(currentBillDate) : "",
        gstOutstandingHistory: media.rentalPayment?.gstOutstandingHistory || [],
        rentalOutstandingHistory:
          media.rentalPayment?.rentalOutstandingHistory || [],
      },
      201,
    );
  } catch (error) {
    console.error("createLedgerEntry error:", error);
    return errorResponse(
      res,
      "Something went wrong while creating ledger entry",
      { error: error.message },
      500,
    );
  }
};

/* ═══════════════════════════════════════════════════════════════════════
 * createLedgerEntryBulk — NEW, SEPARATE export. Handles the payments[]
 * + siteBillMode contract (one shared paymentMode/utrNumber/date across
 * many mediaId + landOwnerId combinations, for all 6 flows: rental/gst
 * × current/pastCycle/outstanding).
 *
 * Deliberately kept independent from createLedgerEntry above — does not
 * touch or reuse its internals, so nothing in the existing single-media
 * flow is modified or put at risk.
 * ═══════════════════════════════════════════════════════════════════════*/
// async function runBulkLedgerEntry(req, res) {
//   try {
//     const {
//       siteBillMode,
//       entryType,
//       payments,
//       date,
//     } = req.body;

//     if (![1, 2].includes(Number(siteBillMode))) {
//       return errorResponse(res, "siteBillMode must be 1 (single bill) or 2 (separate)", null, 400);
//     }
//     if (!["rental", "gst"].includes(entryType)) {
//       return errorResponse(res, `entryType must be "rental" or "gst"`, null, 400);
//     }
//     if (!Array.isArray(payments) || payments.length === 0) {
//       return errorResponse(res, "payments must be a non-empty array", null, 400);
//     }
//     // ✅ CHANGED — targetType AND paymentMode/utrNumber now validated PER
//     // ITEM, not at the top level, since different sites/owners in the same
//     // bill can pay via different modes (e.g. one Cash, one Online) and mix
//     // current/pastCycle/outstanding.
//     for (let i = 0; i < payments.length; i++) {
//       if (!["current", "pastCycle", "outstanding"].includes(payments[i].targetType)) {
//         return errorResponse(
//           res,
//           `payments[${i}].targetType must be "current", "pastCycle", or "outstanding"`,
//           null,
//           400,
//         );
//       }
//       if (!payments[i].paymentMode || !["Cash", "Online"].includes(payments[i].paymentMode)) {
//         return errorResponse(
//           res,
//           `payments[${i}].paymentMode must be "Cash" or "Online"`,
//           null,
//           400,
//         );
//       }
//       if (payments[i].paymentMode === "Online" && !payments[i].utrNumber) {
//         return errorResponse(
//           res,
//           `payments[${i}].utrNumber is required when paymentMode is Online`,
//           null,
//           400,
//         );
//       }
//     }

//     const distinctMediaIds = [...new Set(payments.map((p) => String(p.mediaId)))];
//     if (Number(siteBillMode) === 2 && distinctMediaIds.length !== 1) {
//       return errorResponse(
//         res,
//         `siteBillMode 2 (separate) requires all payments[] items to share the same mediaId — found ${distinctMediaIds.length} distinct sites. Use siteBillMode 1 for a single bill spanning multiple sites.`,
//         null,
//         400,
//       );
//     }
//     if (Number(siteBillMode) === 1 && distinctMediaIds.length < 1) {
//       return errorResponse(res, "siteBillMode 1 requires at least one mediaId in payments[]", null, 400);
//     }

//     const entryDate = date ? new Date(date) : nowIST();
//     const updatedBy = req.user?.userName || "Admin";
//     const savedEntries = [];
//     let totalAmountSaved = 0;

//     // ✅ NEW — how many payments[] items target the SAME rentalDueId (used
//     // to detect a co-owned site where one due is split across owners, so
//     // rental+current doesn't push the full site-wide netPayable once per
//     // owner and double-count).
// const rentalDueIdCounts = {};
//     payments.forEach((p) => {
//       if ((p.targetType === "current" || p.targetType === "pastCycle") && p.rentalDueId) {
//         const key = String(p.rentalDueId);
//         rentalDueIdCounts[key] = (rentalDueIdCounts[key] || 0) + 1;
//       }
//     });

//     for (let i = 0; i < payments.length; i++) {
//       const item = payments[i];
//       const targetType = item.targetType;
//       const result = {
//         mediaId: item.mediaId,
//         landOwnerId: item.landOwnerId,
//         targetType,
//         paymentMode: item.paymentMode, // ✅ NEW — per-item now, not shared
//         utrNumber: item.paymentMode === "Online" ? item.utrNumber : null, // ✅ NEW
//       };

//       try {
//         if (!item.mediaId || !mongoose.Types.ObjectId.isValid(item.mediaId)) {
//           throw new Error("invalid or missing mediaId");
//         }
//         if (!item.landOwnerId || !mongoose.Types.ObjectId.isValid(item.landOwnerId)) {
//           throw new Error("invalid or missing landOwnerId");
//         }

//         const media = await Media.findById(item.mediaId);
//         if (!media) throw new Error("Media not found for given mediaId");

//         result.mediaName = media.mediaName;

//         const owner =
//           media.landOwners.id(item.landOwnerId) ||
//           media.landOwners.find(
//             (o) => String(o.landOwnerMasterId) === String(item.landOwnerId),
//           );
//         if (!owner) throw new Error("landOwnerId does not match any landOwner on this media");
//         result.landOwnerId = owner._id;
//         result.landOwnerName = owner.name;

//         if (!Array.isArray(media.ledger)) media.ledger = [];
//         if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
//         if (!Array.isArray(media.gstBalanceHistory)) media.gstBalanceHistory = [];
//         if (!media.rentalPayment.gstOutstandingHistory) media.rentalPayment.gstOutstandingHistory = [];
//         if (!media.rentalPayment.rentalOutstandingHistory) media.rentalPayment.rentalOutstandingHistory = [];

//         let amount = 0;

//         if (entryType === "rental" && targetType === "current") {
//   if (!item.rentalDueId) throw new Error("rentalDueId is required for rental+current");
//   const rentalDue = media.rentalDue?.find((d) => String(d._id) === String(item.rentalDueId));
//   if (!rentalDue) throw new Error("rentalDueId does not match any rentalDue record on this media");

//   const isSharedDue = (rentalDueIdCounts[String(item.rentalDueId)] || 0) > 1;
//   amount = isSharedDue
//     ? Number(owner.netPayable || owner.shareAmount || 0)
//     : Number(rentalDue.netPayable || media.rentalPayment?.netPayable || 0);

//   const ledgerEntryPayload = {
//     landOwnerId: owner._id,
//     landOwnerName: owner.name,
//     paymentMode: item.paymentMode,
//     utrNumber: item.paymentMode === "Online" ? item.utrNumber : null,
//     date: entryDate,
//     status: 1,
//     // withGst: 2,
//     month: rentalDue.dueMonth,
//     cycle: rentalDue.dueDate,
//     rentalDueId: item.rentalDueId,
//     amount,
//     updatedBy,
//     updatedAt: nowIST(),
//   };

//   // write to the live cycle array (as before)
//   media.ledger.push({ ...ledgerEntryPayload, index: media.ledger.length });
//   media.markModified("ledger");

//   // ✅ NEW — also upsert into ledgerHistory's month bucket, same pattern
//   // as the pastCycle branch below, so getLedgerHistory (History API)
//   // can see this real entry instead of falling back to a virtual one.
//   const parsedCurrent = parseDueMonthLabel(rentalDue.dueMonth);
//   const bucketYear = parsedCurrent
//     ? String(parsedCurrent.year)
//     : String(new Date(rentalDue.dueDate).getUTCFullYear());
//   const bucketMonthName = parsedCurrent
//     ? MONTH_NAMES[parsedCurrent.monthIdx]
//     : MONTH_NAMES[new Date(rentalDue.dueDate).getUTCMonth()];

//   if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
//   let yearBucket = media.ledgerHistory.find((y) => y.year === bucketYear);
//   if (!yearBucket) {
//     media.ledgerHistory.push({ year: bucketYear, months: [] });
//     yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
//   }
//   let monthBucket = yearBucket.months.find((m) => m.month === bucketMonthName);
//   if (!monthBucket) {
//     yearBucket.months.push({ month: bucketMonthName, entries: [] });
//     monthBucket = yearBucket.months[yearBucket.months.length - 1];
//   }

//   let historyTarget = monthBucket.entries.find(
//     (e) =>
//       String(e.rentalDueId) === String(item.rentalDueId) &&
//       String(e.landOwnerId) === String(owner._id) &&
//       e.paymentMode === item.paymentMode,
//   );
//   if (!historyTarget) {
//     monthBucket.entries.push({
//       landOwnerId: owner._id,
//       landOwnerName: owner.name,
//       mediaName: media.mediaName,
//       paymentFrequency: media.rentalPayment.paymentFrequency,
//       netPayable: rentalDue.netPayable,
//       rentalDueId: item.rentalDueId,
//     //   withGst: 2,
//       month: rentalDue.dueMonth,
//       cycle: rentalDue.dueDate,
//     });
//     historyTarget = monthBucket.entries[monthBucket.entries.length - 1];
//   }
//   historyTarget.paymentMode = item.paymentMode;
//   historyTarget.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
//   historyTarget.status = 1;
//   historyTarget.date = entryDate;
//   historyTarget.amount = amount;
//   historyTarget.updatedBy = updatedBy;
//   historyTarget.updatedAt = nowIST();
//   media.markModified("ledgerHistory");

//   result.dueMonth = rentalDue.dueMonth;
//   result.rentalDueId = item.rentalDueId;
// }

//         else if (entryType === "rental" && targetType === "pastCycle") {
//           // ✅ CHANGED — saved by rentalDueId, not ledgerHistoryId. A fully
//           // unpaid past month has no pre-existing ledgerHistory row to
//           // update (a ledgerHistoryId only exists AFTER a first partial
//           // payment was made), so this always WRITES/upserts a fresh entry
//           // into the correct month bucket instead of requiring one to
//           // already exist.
//           if (!item.rentalDueId) throw new Error("rentalDueId is required for rental+pastCycle");
//           const rentalDue = media.rentalDue?.find((d) => String(d._id) === String(item.rentalDueId));
//           if (!rentalDue) throw new Error("rentalDueId does not match any rentalDue record on this media");

//           const isSharedDue = (rentalDueIdCounts[String(item.rentalDueId)] || 0) > 1;
//           amount = isSharedDue
//             ? Number(owner.netPayable || owner.shareAmount || 0)
//             : Number(rentalDue.netPayable || 0);

//           const parsed = parseDueMonthLabel(rentalDue.dueMonth);
//           const bucketYear = parsed ? String(parsed.year) : String(new Date(rentalDue.dueDate).getUTCFullYear());
//           const bucketMonthName = parsed ? MONTH_NAMES[parsed.monthIdx] : MONTH_NAMES[new Date(rentalDue.dueDate).getUTCMonth()];

//           if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
//           let yearBucket = media.ledgerHistory.find((y) => y.year === bucketYear);
//           if (!yearBucket) {
//             media.ledgerHistory.push({ year: bucketYear, months: [] });
//             yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
//           }
//           let monthBucket = yearBucket.months.find((m) => m.month === bucketMonthName);
//           if (!monthBucket) {
//             yearBucket.months.push({ month: bucketMonthName, entries: [] });
//             monthBucket = yearBucket.months[yearBucket.months.length - 1];
//           }

//           // upsert by rentalDueId + landOwnerId + paymentMode — Cash then
//           // Online for the same due/owner updates the SAME entry instead
//           // of duplicating
//           let target = monthBucket.entries.find(
//     (e) =>
//       String(e.rentalDueId) === String(item.rentalDueId) &&
//       String(e.landOwnerId) === String(owner._id) &&
//       e.paymentMode === item.paymentMode,
//   );
//   if (!target) {
//     monthBucket.entries.push({
//       landOwnerId: owner._id,
//       landOwnerName: owner.name,
//       mediaName: media.mediaName,
//       paymentFrequency: media.rentalPayment.paymentFrequency,
//       netPayable: rentalDue.netPayable,
//       rentalDueId: item.rentalDueId,
//       // withGst: 2,
//       month: rentalDue.dueMonth,
//       cycle: rentalDue.dueDate,
//     });
//     target = monthBucket.entries[monthBucket.entries.length - 1];
//   }

//   // ✅ CRITICAL FIX - Set these fields BEFORE markModified
//   target.paymentMode = item.paymentMode;
//   target.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
//   target.status = 1;
//   target.date = entryDate; // ← This needs to be properly set
//   target.amount = amount;
//   target.updatedBy = updatedBy;
//   target.updatedAt = nowIST();

//   // ✅ IMPORTANT - Mark the entire monthBucket as modified to ensure nested changes are saved
//   media.markModified(`ledgerHistory.${media.ledgerHistory.indexOf(yearBucket)}.months.${yearBucket.months.indexOf(monthBucket)}.entries`);
//   // OR use the simpler but more broad approach:
//   // media.markModified('ledgerHistory');

//   result.dueMonth = rentalDue.dueMonth;
//   result.rentalDueId = item.rentalDueId;
//   result.ledgerHistoryId = target._id || null;
// }

//         else if (entryType === "rental" && targetType === "outstanding") {
//           if (!item.rentalOutstandingId) throw new Error("rentalOutstandingId is required for rental+outstanding");
//           const row = media.rentalPayment.rentalOutstandingHistory.id(item.rentalOutstandingId);
//           if (!row) throw new Error("rentalOutstandingId does not match any rentalOutstandingHistory record");
//           amount = Number(row.baseRentOutstandingAmount || 0);

//           row.paymentMode = item.paymentMode;
//           row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
//           row.isPaid = true;
//           row.date = entryDate;
//           row.updatedBy = updatedBy;
//           row.updatedAt = nowIST();
//           media.markModified("rentalPayment");
//           result.dueMonth = row.dueMonth;
//           result.rentalOutstandingId = item.rentalOutstandingId;
//         }

//         else if (entryType === "gst" && targetType === "current") {
//           if (!item.rentalDueId) throw new Error("rentalDueId is required for gst+current");
//           const rentalDue = media.rentalDue?.find((d) => String(d._id) === String(item.rentalDueId));
//           if (!rentalDue) throw new Error("rentalDueId does not match any rentalDue record on this media");

//           // ✅ FIXED — was matching on g.landOwnerId, but gstBalanceHistory
//           // rows in this schema store the owner reference as `ownerId`,
//           // not `landOwnerId` (see the "source":"owner" rows you pasted —
//           // they use ownerId). The old check never matched, so every save
//           // created a brand-new row instead of updating the existing one,
//           // producing a duplicate for the same rentalDueId+dueMonth.
//           let row = media.gstBalanceHistory.find(
//             (g) => String(g.rentalDueId) === String(item.rentalDueId) && String(g.ownerId) === String(owner._id),
//           );
//           if (!row) {
//             media.gstBalanceHistory.push({
//               rentalDueId: item.rentalDueId,
//               dueMonth: rentalDue.dueMonth,
//               cycle: rentalDue.dueDate,
//               gstAmount: Number(rentalDue.gstAmount || 0),
//               isPaid: false,
//               source: "owner",
//              ownerId: owner._id, // ✅ FIXED — was landOwnerId, schema field is ownerId
//               ownerName: owner.name,
//               createdAt: nowIST(),
//               createdBy: updatedBy,
//             });
//             row = media.gstBalanceHistory[media.gstBalanceHistory.length - 1];
//           }
//           amount = Number(row.gstAmount || 0);

//           row.paymentMode = item.paymentMode;
//           row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : "";
//           row.isPaid = true;
//           row.isUtrEntry = true;
//           row.date = entryDate;
//           row.updatedBy = updatedBy;
//           row.updatedAt = nowIST();
//           media.markModified("gstBalanceHistory");
//           result.dueMonth = row.dueMonth;
//           result.rentalDueId = item.rentalDueId;
//           result.gstAmount = amount;
//         }

//         else if (entryType === "gst" && targetType === "pastCycle") {
//           if (!item.gstBalanceHistoryId) throw new Error("gstBalanceHistoryId is required for gst+pastCycle");
//           const row = media.gstBalanceHistory.id(item.gstBalanceHistoryId);
//           if (!row) throw new Error("gstBalanceHistoryId does not match any gstBalanceHistory record");
//           amount = Number(row.gstAmount || 0);

//           row.paymentMode = item.paymentMode;
//           row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : "";
//           row.isPaid = true;
//           row.isUtrEntry = true;
//           row.date = entryDate;
//           row.updatedBy = updatedBy;
//           row.updatedAt = nowIST();
//           media.markModified("gstBalanceHistory");
//           result.dueMonth = row.dueMonth;
//           result.gstBalanceHistoryId = item.gstBalanceHistoryId;
//           result.gstAmount = amount;
//         }

//         else if (entryType === "gst" && targetType === "outstanding") {
//           if (!item.gstOutstandingId) throw new Error("gstOutstandingId is required for gst+outstanding");
//           const row = media.rentalPayment.gstOutstandingHistory.id(item.gstOutstandingId);
//           if (!row) throw new Error("gstOutstandingId does not match any gstOutstandingHistory record");
//           amount = Number(row.gstOutStandingAmount || 0);

//           row.paymentMode = item.paymentMode;
//           row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
//           row.isPaid = true;
//           row.date = entryDate;
//           row.updatedBy = updatedBy;
//           row.updatedAt = nowIST();
//           media.markModified("rentalPayment");
//           result.dueMonth = row.dueMonth;
//           result.gstOutstandingId = item.gstOutstandingId;
//           result.gstOutStandingAmount = amount;
//         }

//         await media.save();

//         result.amount = amount;
//         result.status = "saved";
//         totalAmountSaved += amount;
//       } catch (itemError) {
//         result.status = "failed";
//         result.error = itemError.message;
//       }

//       savedEntries.push(result);
//     }

//     const sitesSucceeded = savedEntries.filter((e) => e.status === "saved").length;
//     const sitesFailed = savedEntries.filter((e) => e.status === "failed").length;
//     const distinctOwnersCovered = [...new Set(payments.map((p) => String(p.landOwnerId)))];

//     // ✅ NEW — breakdown by targetType across all saved (not failed) entries
//     const breakdown = savedEntries.reduce(
//       (acc, e) => {
//         if (e.status !== "saved") return acc;
//         if (e.targetType === "current") acc.currentAmount += e.amount;
//         else if (e.targetType === "pastCycle") acc.pastCycleAmount += e.amount;
//         else if (e.targetType === "outstanding") acc.outstandingAmount += e.amount;
//         return acc;
//       },
//       { currentAmount: 0, pastCycleAmount: 0, outstandingAmount: 0 },
//     );

//     // ✅ NEW — every distinct dueMonth actually covered by this bill
//     const distinctMonthsCovered = [
//       ...new Set(savedEntries.filter((e) => e.status === "saved").map((e) => e.dueMonth).filter(Boolean)),
//     ];

//     // ✅ CHANGED — billGroupId is now potentially MULTIPLE groups (one per
//     // distinct UTR used across payments[]), since paymentMode/utrNumber
//     // are per-item now instead of one shared value for the whole bill.
//     const distinctUtrGroups = [
//       ...new Set(
//         savedEntries
//           .filter((e) => e.status === "saved" && e.paymentMode === "Online" && e.utrNumber)
//           .map((e) => `${e.utrNumber}_${entryDate.getUTCMonth() + 1}-${entryDate.getUTCFullYear()}`),
//       ),
//     ];

//     return successResponse(
//       res,
//       sitesFailed === 0
//         ? "Payment saved successfully"
//         : `Payment saved with ${sitesFailed} failure(s)`,
//       {
//         siteBillMode: Number(siteBillMode),
//         billGroupIds: distinctUtrGroups, // ✅ CHANGED — was singular billGroupId
//         entryType,
//         date: formatDate(entryDate),
//         savedEntries, // ✅ each item now carries its own paymentMode/utrNumber
//         totalAmountSaved,
//         breakdown, // ✅ NEW
//         distinctSitesCovered: distinctMediaIds.length,
//         distinctOwnersCovered: distinctOwnersCovered.length,
//         distinctMonthsCovered, // ✅ NEW
//         sitesSucceeded,
//         sitesFailed,
//       },
//       sitesFailed === 0 ? 201 : 207,
//     );
//   } catch (error) {
//     console.error("createLedgerEntryBulk error:", error);
//     return errorResponse(
//       res,
//       "Something went wrong while creating bulk ledger entries",
//       { error: error.message },
//       500,
//     );
//   }
// };
async function ensureRentalDueForCycles(media, requestedMonthYear, updatedBy) {
  const cycles = getAllDueCycles(media, requestedMonthYear);
  if (cycles.length === 0) return false;

  if (!Array.isArray(media.rentalDue)) media.rentalDue = [];
  const expectedGstPerCycle = resolveExpectedGstForCycle(media);
  let anyCreated = false;

  cycles.forEach((cycleDate) => {
    const cycleMonthLabel = `${MONTH_NAMES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;
    const alreadyExists = media.rentalDue.some((d) => d.dueMonth === cycleMonthLabel);
    if (alreadyExists) return;

    media.rentalDue.push({
      dueMonth: cycleMonthLabel,
      dueDate: cycleDate,
      netPayable: Number(media.rentalPayment?.totalRentalAmount || 0),
      // ✅ FIXED — omitted entirely; approvalStatus enum doesn't include 0.
      // Letting the schema's own default apply avoids guessing at a valid
      // value that doesn't match your actual rentalDueEntrySchema.
      withGst: expectedGstPerCycle > 0 ? 2 : null,
      gstAmount: expectedGstPerCycle,
      baseAmount: Number(media.rentalPayment?.totalRentalAmount || 0),
      paymentFrequency: media.rentalPayment?.paymentFrequency,
      status: 1,
      createdAt: nowIST(),
      updatedAt: nowIST(),
    });
    anyCreated = true;
  });

  if (anyCreated) {
    media.markModified("rentalDue");
    await media.save();
  }
  return anyCreated;
}
async function runBulkLedgerEntry(req, res) {
  try {
    const { siteBillMode, entryType, payments, date } = req.body;

    if (![1, 2].includes(Number(siteBillMode))) {
      return errorResponse(
        res,
        "siteBillMode must be 1 (single bill) or 2 (separate)",
        null,
        400,
      );
    }
    if (!["rental", "gst"].includes(entryType)) {
      return errorResponse(
        res,
        `entryType must be "rental" or "gst"`,
        null,
        400,
      );
    }
    if (!Array.isArray(payments) || payments.length === 0) {
      return errorResponse(
        res,
        "payments must be a non-empty array",
        null,
        400,
      );
    }

    for (let i = 0; i < payments.length; i++) {
      if (
        !["current", "pastCycle", "outstanding"].includes(
          payments[i].targetType,
        )
      ) {
        return errorResponse(
          res,
          `payments[${i}].targetType must be "current", "pastCycle", or "outstanding"`,
          null,
          400,
        );
      }
      if (
        !payments[i].paymentMode ||
        !["Cash", "Online"].includes(payments[i].paymentMode)
      ) {
        return errorResponse(
          res,
          `payments[${i}].paymentMode must be "Cash" or "Online"`,
          null,
          400,
        );
      }
      if (payments[i].paymentMode === "Online" && !payments[i].utrNumber) {
        return errorResponse(
          res,
          `payments[${i}].utrNumber is required when paymentMode is Online`,
          null,
          400,
        );
      }
    }

    const distinctMediaIds = [
      ...new Set(payments.map((p) => String(p.mediaId))),
    ];
    if (Number(siteBillMode) === 2 && distinctMediaIds.length !== 1) {
      return errorResponse(
        res,
        `siteBillMode 2 (separate) requires all payments[] items to share the same mediaId — found ${distinctMediaIds.length} distinct sites. Use siteBillMode 1 for a single bill spanning multiple sites.`,
        null,
        400,
      );
    }
    if (Number(siteBillMode) === 1 && distinctMediaIds.length < 1) {
      return errorResponse(
        res,
        "siteBillMode 1 requires at least one mediaId in payments[]",
        null,
        400,
      );
    }

    const entryDate = date ? new Date(date) : nowIST();
    const updatedBy = req.user?.userName || "Admin";
    const savedEntries = [];
    let totalAmountSaved = 0;

    const rentalDueIdCounts = {};
    payments.forEach((p) => {
      if (
        (p.targetType === "current" || p.targetType === "pastCycle") &&
        p.rentalDueId
      ) {
        const key = String(p.rentalDueId);
        rentalDueIdCounts[key] = (rentalDueIdCounts[key] || 0) + 1;
      }
    });

    // ✅ CRITICAL FIX: Process each payment and SAVE after EACH one
    for (let i = 0; i < payments.length; i++) {
      const item = payments[i];
      const targetType = item.targetType;
      const result = {
        mediaId: item.mediaId,
        landOwnerId: item.landOwnerId,
        targetType,
        paymentMode: item.paymentMode,
        utrNumber: item.paymentMode === "Online" ? item.utrNumber : null,
      };

      try {
        if (!item.mediaId || !mongoose.Types.ObjectId.isValid(item.mediaId)) {
          throw new Error("invalid or missing mediaId");
        }
        if (
          !item.landOwnerId ||
          !mongoose.Types.ObjectId.isValid(item.landOwnerId)
        ) {
          throw new Error("invalid or missing landOwnerId");
        }

        const media = await Media.findById(item.mediaId);
        if (!media) throw new Error("Media not found for given mediaId");

        result.mediaName = media.mediaName;

        const owner =
          media.landOwners.id(item.landOwnerId) ||
          media.landOwners.find(
            (o) => String(o.landOwnerMasterId) === String(item.landOwnerId),
          );
        if (!owner)
          throw new Error(
            "landOwnerId does not match any landOwner on this media",
          );
        result.landOwnerId = owner._id;
        result.landOwnerName = owner.name;

        if (!Array.isArray(media.ledger)) media.ledger = [];
        if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
        if (!Array.isArray(media.gstBalanceHistory))
          media.gstBalanceHistory = [];
        if (!media.rentalPayment.gstOutstandingHistory)
          media.rentalPayment.gstOutstandingHistory = [];
        if (!media.rentalPayment.rentalOutstandingHistory)
          media.rentalPayment.rentalOutstandingHistory = [];

        let amount = 0;

        // if (entryType === "rental" && targetType === "current") {
        //   if (!item.rentalDueId)
        //     throw new Error("rentalDueId is required for rental+current");
        //   const rentalDue = media.rentalDue?.find(
        //     (d) => String(d._id) === String(item.rentalDueId),
        //   );
        //   if (!rentalDue)
        //     throw new Error(
        //       "rentalDueId does not match any rentalDue record on this media",
        //     );

        //   const isSharedDue =
        //     (rentalDueIdCounts[String(item.rentalDueId)] || 0) > 1;
        //   amount = isSharedDue
        //     ? Number(owner.netPayable || owner.shareAmount || 0)
        //     : Number(
        //         rentalDue.netPayable || media.rentalPayment?.netPayable || 0,
        //       );

        //   const ledgerEntryPayload = {
        //     landOwnerId: owner._id,
        //     landOwnerName: owner.name,
        //     paymentMode: item.paymentMode,
        //     utrNumber: item.paymentMode === "Online" ? item.utrNumber : null,
        //     date: entryDate,
        //     status: 1,
        //     month: rentalDue.dueMonth,
        //     cycle: rentalDue.dueDate,
        //     rentalDueId: item.rentalDueId,
        //     amount,
        //     updatedBy,
        //     updatedAt: nowIST(),
        //   };

        //   media.ledger.push({
        //     ...ledgerEntryPayload,
        //     index: media.ledger.length,
        //   });
        //   media.markModified("ledger");

        //   // Also update ledgerHistory
        //   const parsedCurrent = parseDueMonthLabel(rentalDue.dueMonth);
        //   const bucketYear = parsedCurrent
        //     ? String(parsedCurrent.year)
        //     : String(new Date(rentalDue.dueDate).getUTCFullYear());
        //   const bucketMonthName = parsedCurrent
        //     ? MONTH_NAMES[parsedCurrent.monthIdx]
        //     : MONTH_NAMES[new Date(rentalDue.dueDate).getUTCMonth()];

        //   if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
        //   let yearBucket = media.ledgerHistory.find((y) => y.year === bucketYear);
        //   if (!yearBucket) {
        //     media.ledgerHistory.push({ year: bucketYear, months: [] });
        //     yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
        //   }
        //   let monthBucket = yearBucket.months.find((m) => m.month === bucketMonthName);
        //   if (!monthBucket) {
        //     yearBucket.months.push({ month: bucketMonthName, entries: [] });
        //     monthBucket = yearBucket.months[yearBucket.months.length - 1];
        //   }

        //   // ✅ CHANGED — match by dueMonth + landOwnerId + paymentMode
        //   // (works whether or not a real rentalDue exists), instead of
        //   // requiring rentalDueId.
        //   let target = monthBucket.entries.find(
        //     (e) =>
        //       e.month === dueMonthLabel &&
        //       String(e.landOwnerId) === String(owner._id) &&
        //       e.paymentMode === item.paymentMode,
        //   );
        //   if (!target) {
        //     monthBucket.entries.push({
        //       landOwnerId: owner._id,
        //       landOwnerName: owner.name,
        //       mediaName: media.mediaName,
        //       paymentFrequency: media.rentalPayment.paymentFrequency,
        //       netPayable: rentalDue?.netPayable || Number(media.rentalPayment?.totalRentalAmount || 0),
        //       rentalDueId: item.rentalDueId || null,
        //       withGst: 2,
        //       month: dueMonthLabel,
        //       cycle: dueDate,
        //     });
        //     target = monthBucket.entries[monthBucket.entries.length - 1];
        //   }

        //   target.paymentMode = item.paymentMode;
        //   target.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
        //   target.status = 1;
        //   target.date = entryDate;
        //   target.amount = amount;
        //   target.updatedBy = updatedBy;
        //   target.updatedAt = nowIST();
        //   media.markModified("ledgerHistory");
        //   result.dueMonth = dueMonthLabel;
        //   result.rentalDueId = item.rentalDueId || null;
        //   result.ledgerHistoryId = target._id || null;
        // }
        if (entryType === "rental" && targetType === "current") {
  if (!item.rentalDueId)
    throw new Error("rentalDueId is required for rental+current");
  const rentalDue = media.rentalDue?.find(
    (d) => String(d._id) === String(item.rentalDueId),
  );
  if (!rentalDue)
    throw new Error(
      "rentalDueId does not match any rentalDue record on this media",
    );

  const isSharedDue =
    (rentalDueIdCounts[String(item.rentalDueId)] || 0) > 1;
  amount = isSharedDue
    ? Number(owner.netPayable || owner.shareAmount || 0)
    : Number(
        rentalDue.netPayable || media.rentalPayment?.netPayable || 0,
      );

  const ledgerEntryPayload = {
    landOwnerId: owner._id,
    landOwnerName: owner.name,
    paymentMode: item.paymentMode,
    utrNumber: item.paymentMode === "Online" ? item.utrNumber : null,
    date: entryDate,
    status: 1,
    month: rentalDue.dueMonth,
    cycle: rentalDue.dueDate,
    rentalDueId: item.rentalDueId,
    amount,
    updatedBy,
    updatedAt: nowIST(),
  };

  media.ledger.push({
    ...ledgerEntryPayload,
    index: media.ledger.length,
  });
  media.markModified("ledger");

  // Also update ledgerHistory
  const parsedCurrent = parseDueMonthLabel(rentalDue.dueMonth);
  const bucketYear = parsedCurrent
    ? String(parsedCurrent.year)
    : String(new Date(rentalDue.dueDate).getUTCFullYear());
  const bucketMonthName = parsedCurrent
    ? MONTH_NAMES[parsedCurrent.monthIdx]
    : MONTH_NAMES[new Date(rentalDue.dueDate).getUTCMonth()];

  if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
  let yearBucket = media.ledgerHistory.find((y) => y.year === bucketYear);
  if (!yearBucket) {
    media.ledgerHistory.push({ year: bucketYear, months: [] });
    yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
  }
  let monthBucket = yearBucket.months.find((m) => m.month === bucketMonthName);
  if (!monthBucket) {
    yearBucket.months.push({ month: bucketMonthName, entries: [] });
    monthBucket = yearBucket.months[yearBucket.months.length - 1];
  }

  // ✅ FIXED — dueMonthLabel and dueDate were never declared anywhere
  // in this function (leftover names from an earlier draft), which
  // threw "dueMonthLabel is not defined" on every single payment and
  // failed the whole batch. The real values were already computed
  // just above: rentalDue.dueMonth / rentalDue.dueDate (matched via
  // item.rentalDueId), and bucketMonthName (the normalized month
  // name used for the ledgerHistory bucket). Using those instead.
  let target = monthBucket.entries.find(
    (e) =>
      e.month === rentalDue.dueMonth &&
      String(e.landOwnerId) === String(owner._id) &&
      e.paymentMode === item.paymentMode,
  );
  if (!target) {
    monthBucket.entries.push({
      landOwnerId: owner._id,
      landOwnerName: owner.name,
      mediaName: media.mediaName,
      paymentFrequency: media.rentalPayment.paymentFrequency,
      netPayable: rentalDue?.netPayable || Number(media.rentalPayment?.totalRentalAmount || 0),
      rentalDueId: item.rentalDueId || null,
      withGst: 2,
      month: rentalDue.dueMonth,
      cycle: rentalDue.dueDate,
    });
    target = monthBucket.entries[monthBucket.entries.length - 1];
  }

  target.paymentMode = item.paymentMode;
  target.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
  target.status = 1;
  target.date = entryDate;
  target.amount = amount;
  target.updatedBy = updatedBy;
  target.updatedAt = nowIST();
  media.markModified("ledgerHistory");
  result.dueMonth = rentalDue.dueMonth;
  result.rentalDueId = item.rentalDueId || null;
  result.ledgerHistoryId = target._id || null;
}
        else if (entryType === "rental" && targetType === "pastCycle") {
          if (!item.rentalDueId) throw new Error("rentalDueId is required for rental+pastCycle");
          const rentalDue = media.rentalDue?.find((d) => String(d._id) === String(item.rentalDueId));
          if (!rentalDue) throw new Error("rentalDueId does not match any rentalDue record on this media");

          const isSharedDue = (rentalDueIdCounts[String(item.rentalDueId)] || 0) > 1;
          amount = isSharedDue
            ? Number(owner.netPayable || owner.shareAmount || 0)
            : Number(rentalDue.netPayable || owner.shareAmount || owner.onlineAmount || owner.cashAmount || 0);

          const parsed = parseDueMonthLabel(rentalDue.dueMonth);
          const bucketYear = parsed ? String(parsed.year) : String(new Date(rentalDue.dueDate).getUTCFullYear());
          const bucketMonthName = parsed ? MONTH_NAMES[parsed.monthIdx] : MONTH_NAMES[new Date(rentalDue.dueDate).getUTCMonth()];

          if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
          let yearBucket = media.ledgerHistory.find((y) => y.year === bucketYear);
          if (!yearBucket) {
            media.ledgerHistory.push({ year: bucketYear, months: [] });
            yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
          }
          let monthBucket = yearBucket.months.find((m) => m.month === bucketMonthName);
          if (!monthBucket) {
            yearBucket.months.push({ month: bucketMonthName, entries: [] });
            monthBucket = yearBucket.months[yearBucket.months.length - 1];
          }

          let target = monthBucket.entries.find(
            (e) =>
              String(e.rentalDueId) === String(item.rentalDueId) &&
              String(e.landOwnerId) === String(owner._id) &&
              e.paymentMode === item.paymentMode,
          );
          if (!target) {
            monthBucket.entries.push({
              landOwnerId: owner._id,
              landOwnerName: owner.name,
              mediaName: media.mediaName,
              paymentFrequency: media.rentalPayment.paymentFrequency,
              netPayable: rentalDue.netPayable,
              rentalDueId: item.rentalDueId,
              withGst: 2,
              month: rentalDue.dueMonth,
              cycle: rentalDue.dueDate,
            });
            target = monthBucket.entries[monthBucket.entries.length - 1];
          }

          target.paymentMode = item.paymentMode;
          target.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
          target.status = 1;
          target.date = entryDate;
          target.amount = amount;
          target.updatedBy = updatedBy;
          target.updatedAt = nowIST();
          media.markModified("ledgerHistory");
          result.dueMonth = rentalDue.dueMonth;
          result.rentalDueId = item.rentalDueId;
          result.ledgerHistoryId = target._id || null;
        } else if (entryType === "rental" && targetType === "outstanding") {
          if (!item.rentalOutstandingId)
            throw new Error(
              "rentalOutstandingId is required for rental+outstanding",
            );
          const row = media.rentalPayment.rentalOutstandingHistory.id(
            item.rentalOutstandingId,
          );
          if (!row)
            throw new Error(
              "rentalOutstandingId does not match any rentalOutstandingHistory record",
            );
          amount = Number(row.baseRentOutstandingAmount || 0);

          row.paymentMode = item.paymentMode;
          row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
          row.isPaid = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("rentalPayment");
          result.dueMonth = row.dueMonth;
          result.rentalOutstandingId = item.rentalOutstandingId;
        } else if (entryType === "gst" && targetType === "current") {
          if (!item.rentalDueId)
            throw new Error("rentalDueId is required for gst+current");
          const rentalDue = media.rentalDue?.find(
            (d) => String(d._id) === String(item.rentalDueId),
          );
          if (!rentalDue)
            throw new Error(
              "rentalDueId does not match any rentalDue record on this media",
            );

          let row = media.gstBalanceHistory.find(
            (g) =>
              String(g.rentalDueId) === String(item.rentalDueId) &&
              String(g.ownerId) === String(owner._id),
          );
          if (!row) {
            media.gstBalanceHistory.push({
              rentalDueId: item.rentalDueId,
              dueMonth: rentalDue.dueMonth,
              cycle: rentalDue.dueDate,
              gstAmount: Number(rentalDue.gstAmount || 0),
              isPaid: false,
              source: "owner",
              ownerId: owner._id,
              ownerName: owner.name,
              createdAt: nowIST(),
              createdBy: updatedBy,
            });
            row = media.gstBalanceHistory[media.gstBalanceHistory.length - 1];
          }
          amount = Number(row.gstAmount || 0);

          row.paymentMode = item.paymentMode;
          row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : "";
          row.isPaid = true;
          row.isUtrEntry = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("gstBalanceHistory");
          result.dueMonth = row.dueMonth;
          result.rentalDueId = item.rentalDueId;
          result.gstAmount = amount;
        } else if (entryType === "gst" && targetType === "pastCycle") {
          if (!item.gstBalanceHistoryId)
            throw new Error(
              "gstBalanceHistoryId is required for gst+pastCycle",
            );
          const row = media.gstBalanceHistory.id(item.gstBalanceHistoryId);
          if (!row)
            throw new Error(
              "gstBalanceHistoryId does not match any gstBalanceHistory record",
            );
          amount = Number(row.gstAmount || 0);

          row.paymentMode = item.paymentMode;
          row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : "";
          row.isPaid = true;
          row.isUtrEntry = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("gstBalanceHistory");
          result.dueMonth = row.dueMonth;
          result.gstBalanceHistoryId = item.gstBalanceHistoryId;
          result.gstAmount = amount;
        } else if (entryType === "gst" && targetType === "outstanding") {
          if (!item.gstOutstandingId)
            throw new Error("gstOutstandingId is required for gst+outstanding");
          const row = media.rentalPayment.gstOutstandingHistory.id(
            item.gstOutstandingId,
          );
          if (!row)
            throw new Error(
              "gstOutstandingId does not match any gstOutstandingHistory record",
            );
          amount = Number(row.gstOutStandingAmount || 0);

          row.paymentMode = item.paymentMode;
          row.utrNumber = item.paymentMode === "Online" ? item.utrNumber : null;
          row.isPaid = true;
          row.date = entryDate;
          row.updatedBy = updatedBy;
          row.updatedAt = nowIST();
          media.markModified("rentalPayment");
          result.dueMonth = row.dueMonth;
          result.gstOutstandingId = item.gstOutstandingId;
          result.gstOutStandingAmount = amount;
        }

        // ✅ CRITICAL FIX: Save after EACH payment, not all at once
        await media.save();

        result.amount = amount;
        result.status = "saved";
        totalAmountSaved += amount;
      } catch (itemError) {
        console.error(`Error processing payment ${i}:`, itemError);
        result.status = "failed";
        result.error = itemError.message;
      }

      savedEntries.push(result);
    }

    const sitesSucceeded = savedEntries.filter(
      (e) => e.status === "saved",
    ).length;
    const sitesFailed = savedEntries.filter(
      (e) => e.status === "failed",
    ).length;
    const distinctOwnersCovered = [
      ...new Set(payments.map((p) => String(p.landOwnerId))),
    ];

    const breakdown = savedEntries.reduce(
      (acc, e) => {
        if (e.status !== "saved") return acc;
        if (e.targetType === "current") acc.currentAmount += e.amount;
        else if (e.targetType === "pastCycle") acc.pastCycleAmount += e.amount;
        else if (e.targetType === "outstanding")
          acc.outstandingAmount += e.amount;
        return acc;
      },
      { currentAmount: 0, pastCycleAmount: 0, outstandingAmount: 0 },
    );

    const distinctMonthsCovered = [
      ...new Set(
        savedEntries
          .filter((e) => e.status === "saved")
          .map((e) => e.dueMonth)
          .filter(Boolean),
      ),
    ];

    const distinctUtrGroups = [
      ...new Set(
        savedEntries
          .filter(
            (e) =>
              e.status === "saved" && e.paymentMode === "Online" && e.utrNumber,
          )
          .map(
            (e) =>
              `${e.utrNumber}_${entryDate.getUTCMonth() + 1}-${entryDate.getUTCFullYear()}`,
          ),
      ),
    ];

    return successResponse(
      res,
      sitesFailed === 0
        ? "Payment saved successfully"
        : `Payment saved with ${sitesFailed} failure(s)`,
      {
        siteBillMode: Number(siteBillMode),
        billGroupIds: distinctUtrGroups,
        entryType,
        date: formatDate(entryDate),
        savedEntries,
        totalAmountSaved,
        breakdown,
        distinctSitesCovered: distinctMediaIds.length,
        distinctOwnersCovered: distinctOwnersCovered.length,
        distinctMonthsCovered,
        sitesSucceeded,
        sitesFailed,
      },
      sitesFailed === 0 ? 201 : 207,
    );
  } catch (error) {
    console.error("createLedgerEntryBulk error:", error);
    return errorResponse(
      res,
      "Something went wrong while creating bulk ledger entries",
      { error: error.message },
      500,
    );
  }
}
exports.listMediaByLedger = async (req, res) => {
  try {
    const {
      pageNumber = 1,
      count = 10,
      search,
      status,
      dateRange,
      currentMonth,
      isPending,
      isGstPending,
      isTdsPending,
      landOwnerMasterId, // ✅ NEW
      mediaId, // ✅ NEW
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};
    if (!(Array.isArray(req.body.mediaId) && req.body.mediaId.length > 0)) {
      filter.rentalStatus = 3;
    }

    if (search) {
      filter.$or = [
        { mediaName: { $regex: search, $options: "i" } },
        { mediaCode: { $regex: search, $options: "i" } },
      ];
    }

    // ✅ NEW — mediaId[] filter
    if (Array.isArray(mediaId) && mediaId.length > 0) {
      const validMediaIds = mediaId.filter((id) =>
        mongoose.Types.ObjectId.isValid(id),
      );
      if (validMediaIds.length !== mediaId.length) {
        return errorResponse(
          res,
          "mediaId array contains an invalid ObjectId",
          null,
          400,
        );
      }
      filter._id = {
        $in: validMediaIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    if (Array.isArray(landOwnerMasterId) && landOwnerMasterId.length > 0) {
      const validOwnerIds = landOwnerMasterId.filter((id) =>
        mongoose.Types.ObjectId.isValid(id),
      );
      if (validOwnerIds.length !== landOwnerMasterId.length) {
        return errorResponse(
          res,
          "landOwnerMasterId array contains an invalid ObjectId",
          null,
          400,
        );
      }
      filter["landOwners.landOwnerMasterId"] = {
        $in: validOwnerIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // ✅ NEW — snapshot the base filter BEFORE any status-specific (0-5)
    // conditions get merged into `filter`. This is used ONLY for the
    // overallPastMonthPendingCount query below, so that count stays
    // constant no matter what `status` value is passed in the request.
    const baseFilterForOverallCounts = { ...filter };

    let tdsStatusFilter = null;
    if (status !== undefined && status !== null && status !== "") {
      const statusNum = Number(status);
      if ([4, 5].includes(statusNum)) {
        tdsStatusFilter = statusNum;
      }
    }

    if (status !== undefined && status !== null && status !== "") {
      const statusNum = Number(status);
      if (![0, 1, 2, 3, 4, 5].includes(statusNum)) {
        return errorResponse(
          res,
          "status must be one of 0 (Not approve), 1 (Approve), 2 (GST Pending), 3 (GST Completed), 4 (TDS Pending), 5 (TDS Completed)",
          null,
          400,
        );
      }
      if (statusNum === 1) {
        filter["ledger"] = {
          $exists: true,
          $not: { $size: 0 },
          $elemMatch: { status: 1 },
        };
      } else if (statusNum === 0) {
        filter.$or = [
          { ledger: { $exists: false } },
          { ledger: { $size: 0 } },
          { "ledger.status": 0 },
        ];
      } else if (statusNum === 2) {
        filter["gstBalanceHistory"] = {
          $exists: true,
          $not: { $size: 0 },
          $elemMatch: { isPaid: false },
        };
      } else if (statusNum === 3) {
        filter["gstBalanceHistory"] = {
          $exists: true,
          $not: { $size: 0 },
          $all: [{ $elemMatch: { isPaid: true, utrNumber: { $ne: "" } } }],
        };
        filter["gstBalanceHistory.isPaid"] = { $ne: false };
        filter["gstBalanceHistory.utrNumber"] = { $ne: "" };
      }
    }

    const validateMonthYear = (monthYear) =>
      /^(0[1-9]|1[0-2])-([0-9]{4})$/.test(monthYear);

    const getMonthDateRange = (monthYear) => {
      const [month, year] = monthYear.split("-").map(Number);
      const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
      const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
      return { startDate, endDate };
    };

    let requestedMonthRange = null;
    let requestedMonthYearParsed = null; // ✅ NEW — for getCurrentBillDate

    let isPendingFilter = false;
    if (isPending !== undefined && isPending !== null && isPending !== "") {
      const isPendingNum = Number(isPending);
      if (isPendingNum !== 1) {
        return errorResponse(
          res,
          "isPending must be 1 (any other value is invalid)",
          null,
          400,
        );
      }
      isPendingFilter = true;
    }

    let isGstPendingFilter = false;
    if (
      isGstPending !== undefined &&
      isGstPending !== null &&
      isGstPending !== ""
    ) {
      const isGstPendingNum = Number(isGstPending);
      if (isGstPendingNum !== 1) {
        return errorResponse(
          res,
          "isGstPending must be 1 (any other value is invalid)",
          null,
          400,
        );
      }
      isGstPendingFilter = true;
    }

    let isTdsPendingFilter = false;
    if (
      isTdsPending !== undefined &&
      isTdsPending !== null &&
      isTdsPending !== ""
    ) {
      const isTdsPendingNum = Number(isTdsPending);
      if (isTdsPendingNum !== 1) {
        return errorResponse(
          res,
          "isTdsPending must be 1 (any other value is invalid)",
          null,
          400,
        );
      }
      isTdsPendingFilter = true;
    }

    let isPendingExplicitCutoff = null;
    const refMonthYear = dateRange || currentMonth || null;
    if (refMonthYear) {
      if (!validateMonthYear(refMonthYear)) {
        return errorResponse(
          res,
          "Invalid format. Use MM-YYYY format (e.g., 07-2026)",
          null,
          400,
        );
      }
      const [refMonth, refYear] = refMonthYear.split("-").map(Number);
      isPendingExplicitCutoff = { year: refYear, monthIndex: refMonth - 1 };

      const { startDate, endDate } = getMonthDateRange(refMonthYear);
      requestedMonthRange = { startDate, endDate };
    }
    if (currentMonth) {
      requestedMonthYearParsed = parseMonthYearParam(currentMonth); // ✅ NEW
    }

    const skip = (pageNumbers - 1) * pageSize;
    const needsFullFetchForTdsFilter = tdsStatusFilter !== null;
    const needsFullFetch =
      needsFullFetchForTdsFilter ||
      isPendingFilter ||
      isGstPendingFilter ||
      isTdsPendingFilter ||
      !!isPendingExplicitCutoff;

    const MONTH_NAME_TO_INDEX_FOR_HELPER = MONTH_NAMES.reduce(
      (acc, name, idx) => {
        acc[name.toLowerCase()] = idx;
        return acc;
      },
      {},
    );

    function hasAnyPastMonthPending(mediaObj, explicitCutoff) {
      let referenceYear = null;
      let referenceMonthIndex = null;

      if (explicitCutoff) {
        referenceYear = explicitCutoff.year;
        referenceMonthIndex = explicitCutoff.monthIndex;
      } else {
        const referenceDateRaw =
          mediaObj.rentalPayment?.lastBillPaidDate ||
          mediaObj.rentalPayment?.nextBillingDate ||
          null;
        if (referenceDateRaw) {
          const refDate = new Date(referenceDateRaw);
          referenceYear = refDate.getUTCFullYear();
          referenceMonthIndex = refDate.getUTCMonth();
        }
      }

      if (referenceYear === null) return false;

      const savedLedgerMonthKeys = new Set();
      (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
        (yearBucket.months || []).forEach((monthBucket) => {
          const monthIdx =
            MONTH_NAME_TO_INDEX_FOR_HELPER[monthBucket.month.toLowerCase()];
          const entries = monthBucket.entries || [];
          const gst2Entries = entries.filter((e) => e.withGst === 2);

          const allOwnersComplete =
            (mediaObj.landOwners || []).length > 0 &&
            (mediaObj.landOwners || []).every((owner) => {
              const ownerEntries = gst2Entries.filter(
                (e) => String(e.landOwnerId) === String(owner._id),
              );
              const hasCash = ownerEntries.some(
                (e) => e.paymentMode === "Cash",
              );
              const hasOnline = ownerEntries.some(
                (e) => e.paymentMode === "Online",
              );
              const paymentCategory = Number(owner.paymentCategory || 1);
              if (paymentCategory === 1) return hasCash;
              if (paymentCategory === 2) return hasOnline;
              if (paymentCategory === 3) return hasCash && hasOnline;
              return hasCash || hasOnline;
            });

          if (allOwnersComplete) {
            savedLedgerMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
          }
        });
      });

      const neededMonthKeys = new Set();

      if (Array.isArray(mediaObj.rentalDue)) {
        mediaObj.rentalDue.forEach((due) => {
          if (!due.dueDate) return;
          const d = new Date(due.dueDate);
          if (isNaN(d.getTime())) return;
          neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
        });
      }

      if (mediaObj.rentalPayment?.lastBillPaidDate) {
        const d = new Date(mediaObj.rentalPayment.lastBillPaidDate);
        if (!isNaN(d.getTime())) {
          neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
        }
      }

      (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
        (yearBucket.months || []).forEach((monthBucket) => {
          const monthIdx =
            MONTH_NAME_TO_INDEX_FOR_HELPER[monthBucket.month.toLowerCase()];
          neededMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
        });
      });

      for (const key of neededMonthKeys) {
        const [yrStr, monthIdxStr] = key.split("-");
        const yr = Number(yrStr);
        const monthIdx = Number(monthIdxStr);

        const isBeforeReference =
          yr < referenceYear ||
          (yr === referenceYear && monthIdx < referenceMonthIndex);

        if (isBeforeReference && !savedLedgerMonthKeys.has(key)) {
          return true;
        }
      }

      return false;
    }

    const [results, totalCount, overallPendingDocs] = await Promise.all([
      needsFullFetch
        ? Media.find(filter)
            .select(
              "mediaCode mediaName mediaType state  siteBillMode city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue pendingMonths createdAt updatedAt",
            )
            .sort({ updatedAt: -1 })
        : Media.find(filter)
            .select(
              "mediaCode mediaName mediaType state siteBillMode city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue pendingMonths createdAt updatedAt",
            )
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(pageSize),
      Media.countDocuments(filter),
      Media.find(baseFilterForOverallCounts).select(
        "rentalPayment ledgerHistory landOwners rentalDue gstBalanceHistory tdsBalanceHistory ledger",
      ),
    ]);
    const ownerMasterIdsInResults = [
      ...new Set(
        results.flatMap((m) =>
          (m.landOwners || [])
            .filter((o) => o.landOwnerMasterId)
            .map((o) => String(o.landOwnerMasterId)),
        ),
      ),
    ];
    const allMediaSharingOwners = ownerMasterIdsInResults.length
      ? await Media.find({
          "landOwners.landOwnerMasterId": {
            $in: ownerMasterIdsInResults.map(
              (id) => new mongoose.Types.ObjectId(id),
            ),
          },
        })
          .select(
            "mediaCode mediaName siteBillMode landOwners._id landOwners.landOwnerMasterId landOwners.paymentCategory landOwners.shareAmount landOwners.cashAmount landOwners.onlineAmount landOwners.updatedAt",
          )
          .lean()
      : [];
    let overallGstPendingAmount = 0;
    let overallPastMonthPendingCount = 0;
    const MONTH_NAME_TO_INDEX = MONTH_NAMES.reduce((acc, name, idx) => {
      acc[name.toLowerCase()] = idx;
      return acc;
    }, {});

    overallPastMonthPendingCount = overallPendingDocs.reduce((cnt, doc) => {
      const obj = doc.toObject();
      return hasAnyPastMonthPending(obj, isPendingExplicitCutoff)
        ? cnt + 1
        : cnt;
    }, 0);

for (const media of results) {
      await ensureRentalDueForCycles(media, requestedMonthYearParsed, req.user?.userName || "Admin");
    }

    const mediaListData = results.map((media) => {
      const mediaObj = media.toObject();

      const inRequestedMonth = (date) => {
        if (!requestedMonthRange || !date) return true;
        const d = new Date(date);
        return (
          d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
        );
      };

      const siteLiveCycleDate =
        mediaObj.rentalPayment?.lastBillPaidDate ||
        mediaObj.rentalPayment?.nextBillingDate;

      let isPendingAcrossPastMonths = false;
      let earliestPendingMonthKey = null;
      let allPendingMonthKeys = [];
      let pastMonthPendingCount = 0;
      {
        let referenceYear = null;
        let referenceMonthIndex = null;

        if (isPendingExplicitCutoff) {
          referenceYear = isPendingExplicitCutoff.year;
          referenceMonthIndex = isPendingExplicitCutoff.monthIndex;
        } else {
          const referenceDateRaw =
            mediaObj.rentalPayment?.lastBillPaidDate ||
            mediaObj.rentalPayment?.nextBillingDate ||
            null;
          if (referenceDateRaw) {
            const refDate = new Date(referenceDateRaw);
            referenceYear = refDate.getUTCFullYear();
            referenceMonthIndex = refDate.getUTCMonth();
          }
        }

        if (referenceYear !== null) {
          const savedLedgerMonthKeys = new Set();
          (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
            (yearBucket.months || []).forEach((monthBucket) => {
              const monthIdx = MONTH_NAMES.findIndex(
                (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
              );
              const entries = monthBucket.entries || [];
              const gst2Entries = entries.filter((e) => e.withGst === 2);

              const allOwnersComplete =
                (mediaObj.landOwners || []).length > 0 &&
                (mediaObj.landOwners || []).every((owner) => {
                  const ownerEntries = gst2Entries.filter(
                    (e) => String(e.landOwnerId) === String(owner._id),
                  );
                  const hasCash = ownerEntries.some(
                    (e) => e.paymentMode === "Cash",
                  );
                  const hasOnline = ownerEntries.some(
                    (e) => e.paymentMode === "Online",
                  );
                  const paymentCategory = Number(owner.paymentCategory || 1);
                  if (paymentCategory === 1) return hasCash;
                  if (paymentCategory === 2) return hasOnline;
                  if (paymentCategory === 3) return hasCash && hasOnline;
                  return hasCash || hasOnline;
                });

              if (allOwnersComplete) {
                savedLedgerMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
              }
            });
          });

          const neededMonthKeys = new Set();

          if (Array.isArray(mediaObj.rentalDue)) {
            mediaObj.rentalDue.forEach((due) => {
              if (!due.dueDate) return;
              const d = new Date(due.dueDate);
              if (isNaN(d.getTime())) return;
              neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
            });
          }

          if (mediaObj.rentalPayment?.lastBillPaidDate) {
            const d = new Date(mediaObj.rentalPayment.lastBillPaidDate);
            if (!isNaN(d.getTime())) {
              neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
            }
          }

          (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
            (yearBucket.months || []).forEach((monthBucket) => {
              const monthIdx = MONTH_NAMES.findIndex(
                (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
              );
              neededMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
            });
          });

          const pendingKeys = [];
          for (const key of neededMonthKeys) {
            const [yrStr, monthIdxStr] = key.split("-");
            const yr = Number(yrStr);
            const monthIdx = Number(monthIdxStr);

            const isBeforeReference =
              yr < referenceYear ||
              (yr === referenceYear && monthIdx < referenceMonthIndex);

            if (isBeforeReference && !savedLedgerMonthKeys.has(key)) {
              pendingKeys.push({ key, yr, monthIdx });
            }
          }

          pendingKeys.sort((a, b) => a.yr - b.yr || a.monthIdx - b.monthIdx);

          if (pendingKeys.length > 0) {
            isPendingAcrossPastMonths = true;
            earliestPendingMonthKey = pendingKeys[0];
            allPendingMonthKeys = pendingKeys;
            pastMonthPendingCount = pendingKeys.length;
          }
        }
      }

      let pendingMonths = Array.isArray(mediaObj.pendingMonths)
        ? mediaObj.pendingMonths
        : [];

      if (pendingMonths.length === 0 && allPendingMonthKeys.length > 0) {
        pendingMonths = [];

        allPendingMonthKeys.forEach((pendingMonth) => {
          const targetYear = String(pendingMonth.yr);
          const targetMonthName = MONTH_NAMES[pendingMonth.monthIdx];
          const targetMonthLabel = `${targetMonthName} ${pendingMonth.yr}`;
          const pendingCycleDate = new Date(
            Date.UTC(pendingMonth.yr, pendingMonth.monthIdx, 1),
          );

          const yearBucket = (mediaObj.ledgerHistory || []).find(
            (y) => String(y.year).trim() === targetYear,
          );
          const monthBucket = yearBucket?.months.find(
            (m) => m.month.toLowerCase() === targetMonthName.toLowerCase(),
          );
          const monthEntries = monthBucket?.entries || [];
          const gst2Entries = monthEntries.filter((e) => e.withGst === 2);

          const owners = [];

          (mediaObj.landOwners || []).forEach((owner) => {
            const paymentCategory = Number(owner.paymentCategory || 1);
            const ownerEntries = gst2Entries.filter(
              (e) => String(e.landOwnerId) === String(owner._id),
            );
            const cashEntry = ownerEntries.some(
              (e) => e.paymentMode === "Cash",
            );
            const onlineEntry = ownerEntries.some(
              (e) => e.paymentMode === "Online",
            );
            const ownerCashAmount =
              paymentCategory === 3
                ? Number(owner.cashAmount || 0)
                : Number(owner.shareAmount || 0);
            const ownerOnlineAmount =
              paymentCategory === 3
                ? Number(owner.onlineAmount || 0)
                : Number(owner.shareAmount || 0);
            if (paymentCategory === 1) {
              if (!cashEntry) {
                owners.push({
                  landOwnerId: owner._id,
                  landOwnerName: owner.name,
                  paymentCategory,
                  paymentMode: "Cash",
                  cashAmount: ownerCashAmount,
                  cashEntry,
                  pendingType: "cashPending",
                });
              }
            } else if (paymentCategory === 2) {
              if (!onlineEntry) {
                owners.push({
                  landOwnerId: owner._id,
                  landOwnerName: owner.name,
                  paymentCategory,
                  paymentMode: "Online",
                  onlineAmount: ownerOnlineAmount,
                  onlineEntry,
                  pendingType: "onlinePending",
                });
              }
            } else if (paymentCategory === 3) {
              if (!cashEntry) {
                owners.push({
                  landOwnerId: owner._id,
                  landOwnerName: owner.name,
                  paymentCategory,
                  paymentMode: "Cash",
                  cashAmount: ownerCashAmount,
                  cashEntry,
                  pendingType: "cashPending",
                });
              }
              if (!onlineEntry) {
                owners.push({
                  landOwnerId: owner._id,
                  landOwnerName: owner.name,
                  paymentCategory,
                  paymentMode: "Online",
                  onlineAmount: ownerOnlineAmount,
                  onlineEntry,
                  pendingType: "onlinePending",
                });
              }
            }
          });

          if (owners.length > 0) {
            pendingMonths.push({
              month: targetMonthLabel,
              cycle: pendingCycleDate,
              owners,
            });
          }
        });
      }
      {
        let referenceYear = null;
        let referenceMonthIndex = null;

        if (isPendingExplicitCutoff) {
          referenceYear = isPendingExplicitCutoff.year;
          referenceMonthIndex = isPendingExplicitCutoff.monthIndex;
        } else {
          const referenceDateRaw =
            mediaObj.rentalPayment?.lastBillPaidDate ||
            mediaObj.rentalPayment?.nextBillingDate ||
            null;
          if (referenceDateRaw) {
            const refDate = new Date(referenceDateRaw);
            referenceYear = refDate.getUTCFullYear();
            referenceMonthIndex = refDate.getUTCMonth();
          }
        }

        if (referenceYear !== null) {
          pendingMonths = pendingMonths.filter((pm) => {
            const parts = pm.month.trim().split(/\s+/);
            const pmMonthName = parts[0];
            const pmYear = Number(parts[1]);
            const pmMonthIdx = MONTH_NAMES.findIndex(
              (m) => m.toLowerCase() === pmMonthName.toLowerCase(),
            );
            if (pmMonthIdx === -1 || isNaN(pmYear)) return true;

            const isStrictlyBeforeReference =
              pmYear < referenceYear ||
              (pmYear === referenceYear && pmMonthIdx < referenceMonthIndex);

            return isStrictlyBeforeReference;
          });
        }
      }

      const isSiteCurrentLiveCycleMonth =
        requestedMonthRange &&
        siteLiveCycleDate &&
        (() => {
          const d = new Date(siteLiveCycleDate);
          return (
            d.getUTCFullYear() ===
              requestedMonthRange.startDate.getUTCFullYear() &&
            d.getUTCMonth() === requestedMonthRange.startDate.getUTCMonth()
          );
        })();

      let gst2SourceEntries;
      let gst1SourceEntries;
      let monthHistoryEntries = [];

      if (requestedMonthRange) {
        const requestedMonthName =
          MONTH_NAMES[requestedMonthRange.startDate.getUTCMonth()];
        const requestedYear = String(
          requestedMonthRange.startDate.getUTCFullYear(),
        );

        const yearBucket = (mediaObj.ledgerHistory || []).find(
          (y) => String(y.year).trim() === requestedYear,
        );
        const monthBucket = yearBucket?.months.find(
          (m) =>
            String(m.month).trim().toLowerCase() ===
            requestedMonthName.toLowerCase(),
        );

        monthHistoryEntries = [...(monthBucket?.entries || [])].sort(
          (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
        );

        if (isSiteCurrentLiveCycleMonth) {
          gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
          gst1SourceEntries = mediaObj.withGst1Ledger || [];
        } else {
          const allMonthEntries = monthBucket?.entries || [];
          gst2SourceEntries = allMonthEntries.filter((e) => e.withGst === 2);
          gst1SourceEntries = allMonthEntries.filter((e) => e.withGst === 1);
        }
      } else {
        gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
        gst1SourceEntries = mediaObj.withGst1Ledger || [];
      }

      const dedupeByKey = (entries, getKey) => {
        const withPos = entries.map((entry, pos) => ({ entry, pos }));
        const sorted = withPos.sort(
          (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
        );
        const seen = new Set();
        const deduped = [];
        for (const { entry, pos } of sorted) {
          const key = getKey(entry, pos);
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(entry);
          }
        }
        return deduped;
      };

      const gst2Key = (entry, pos) =>
        entry.index !== undefined && entry.index !== null
          ? `idx_${entry.index}`
          : entry._id
            ? `id_${String(entry._id)}`
            : `pos_${pos}`;

      const gst1Key = (entry, pos) =>
        entry.rentalDueId
          ? `rd_${String(entry.rentalDueId)}`
          : entry.landOwnerId
            ? `owner_${String(entry.landOwnerId)}_${entry.month || ""}`
            : entry._id
              ? `id_${String(entry._id)}`
              : `pos_${pos}`;

      let latestLedger = [];
      let withGst1Ledger = [];

      if (isPendingFilter && earliestPendingMonthKey) {
        const targetYear = String(earliestPendingMonthKey.yr);
        const targetMonthName = MONTH_NAMES[earliestPendingMonthKey.monthIdx];

        const yearBucket = (mediaObj.ledgerHistory || []).find(
          (y) => String(y.year).trim() === targetYear,
        );
        const monthBucket = yearBucket?.months.find(
          (m) => m.month.toLowerCase() === targetMonthName.toLowerCase(),
        );
        const monthEntries = monthBucket?.entries || [];

        latestLedger = monthEntries.filter((e) => e.withGst === 2);
        withGst1Ledger = monthEntries.filter((e) => e.withGst === 1);
      } else {
        const sourcedFromLiveLedger =
          !requestedMonthRange || isSiteCurrentLiveCycleMonth;

        if (gst2SourceEntries.length > 0) {
          const monthScoped = requestedMonthRange
            ? gst2SourceEntries
            : gst2SourceEntries.filter((entry) => inRequestedMonth(entry.date));
          latestLedger = sourcedFromLiveLedger
            ? [...monthScoped].sort(
                (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
              )
            : dedupeByKey(monthScoped, gst2Key);
        }

        if (gst1SourceEntries.length > 0) {
          const monthScoped = requestedMonthRange
            ? gst1SourceEntries
            : gst1SourceEntries.filter((entry) => inRequestedMonth(entry.date));
          withGst1Ledger = sourcedFromLiveLedger
            ? [...monthScoped].sort(
                (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
              )
            : dedupeByKey(monthScoped, gst1Key);
        }
      }

      // ✅ NEW — build one Cash + one Online virtual row (or just the required
      // mode, per paymentCategory) for EVERY owner-approved rentalDue that has
      // no matching real ledger entry yet. Sourced directly from rentalDue
      // (dueMonth, dueDate, _id, cashAmount, onlineAmount) rather than
      // pendingMonths, so each row carries the exact rentalDueId + per-month
      // cash/online split to save against.
      latestLedger = latestLedger.map((entry) => {
        // ✅ NEW — attach cashAmount/onlineAmount to real (already-saved)
        // ledger rows too, sourced the same way as the virtual placeholder
        // rows below: rentalDue.cashAmount/onlineAmount first, falling
        // back to the landOwner's configured cashAmount/onlineAmount.
        const matchedOwnerForAmt = (mediaObj.landOwners || []).find(
          (o) => String(o._id) === String(entry.landOwnerId),
        );
        const paymentCategory = Number(
          matchedOwnerForAmt?.paymentCategory || 1,
        );

        // ✅ ADDED — rentalDueApprovalStatus must ALWAYS be present on
        // every ledger entry, real or virtual — this line was the gap.
        // dueVirtualEntries (below) and the history-matched branch
        // already set this field, but entries sourced straight from
        // the live mediaObj.ledger array (the most common case — this
        // is the FIRST place any entry gets shaped) never had it
        // attached at all, so the key silently disappeared depending
        // on which code path produced a given row. Resolved the same
        // way those other two spots do: match this entry's own
        // dueMonth against mediaObj.rentalDue[] and read
        // approvalStatus from there, defaulting to 0 if no match.
        const dueMonthForMatch = entry.dueMonth || entry.month || null;
        const matchedDueForApproval = (mediaObj.rentalDue || []).find(
          (d) => d.dueMonth === dueMonthForMatch,
        );

        return {
          ...entry,
          dueMonth: dueMonthForMatch,
          paymentCategory, // ✅ NEW — was missing on real/live ledger rows
          cashAmount:
            entry.paymentMode === "Cash"
              ? Number(matchedOwnerForAmt?.cashAmount ?? 0)
              : entry.cashAmount,
          onlineAmount:
            entry.paymentMode === "Online"
              ? Number(matchedOwnerForAmt?.onlineAmount ?? 0)
              : entry.onlineAmount,
          // ✅ ADDED — always present now, on every entry regardless
          // of source. Preserves an already-set value on the entry
          // (e.g. if it came from a source that already computed it)
          // before falling back to the freshly matched rentalDue.
          rentalDueApprovalStatus:
            entry.rentalDueApprovalStatus ??
            matchedDueForApproval?.approvalStatus ??
            0,
        };
      });

      const getRequiredModesForOwner = (paymentCategory) => {
        if (paymentCategory === 1) return ["Cash"];
        if (paymentCategory === 2) return ["Online"];
        if (paymentCategory === 3) return ["Cash", "Online"];
        return ["Cash"];
      };

       const autoDueCycles = getAllDueCycles(mediaObj, requestedMonthYearParsed);
      const liveCycleKey = autoDueCycles.length > 0
        ? `${autoDueCycles[autoDueCycles.length - 1].getUTCFullYear()}-${autoDueCycles[autoDueCycles.length - 1].getUTCMonth()}`
        : null;

      const realLedgerHistoryEntries = [];
      (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
        (yearBucket.months || []).forEach((monthBucket) => {
          (monthBucket.entries || []).forEach((entry) => {
            if (entry.withGst === 2 && entry.paymentMode) {
              realLedgerHistoryEntries.push({ ...entry, dueMonth: entry.month, status: 1 });
            }
          });
        });
      });

      const dueVirtualEntries = [];
      autoDueCycles.forEach((cycleDate) => {
        const cycleKey = `${cycleDate.getUTCFullYear()}-${cycleDate.getUTCMonth()}`;
        const targetType = cycleKey === liveCycleKey ? "current" : "pastCycle";
        const cycleMonthLabel = `${MONTH_NAMES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;

        (mediaObj.landOwners || []).forEach((owner) => {
          const paymentCategory = Number(owner.paymentCategory || 1);
          const requiredModes = getRequiredModesForOwner(paymentCategory);

          requiredModes.forEach((mode) => {
            const alreadyRealInLiveLedger = latestLedger.some(
              (e) =>
                !e.isVirtual &&
                String(e.landOwnerId) === String(owner._id) &&
                e.paymentMode === mode &&
                (e.dueMonth === cycleMonthLabel || e.month === cycleMonthLabel),
            );
            if (alreadyRealInLiveLedger && targetType === "current") return;

            const realHistoryEntry = realLedgerHistoryEntries.find(
              (e) =>
                e.paymentMode === mode &&
                String(e.landOwnerId) === String(owner._id) &&
                e.dueMonth === cycleMonthLabel,
            );
            if (realHistoryEntry) {
               const matchedDueForApproval = (mediaObj.rentalDue || []).find(
                (d) => d.dueMonth === cycleMonthLabel,
              );
              latestLedger.push({
                ...realHistoryEntry,
                isVirtual: false,
                targetType,
                paymentCategory,
                cashAmount: mode === "Cash" ? Number(owner.cashAmount || 0) : undefined,
                onlineAmount: mode === "Online" ? Number(owner.onlineAmount || 0) : undefined,
                rentalDueApprovalStatus: matchedDueForApproval?.approvalStatus ?? 0,
              });
              return;
            }

            const isSplitCategory = paymentCategory === 3;
            const resolvedCashAmount =
              isSplitCategory && mode === "Cash" ? Number(owner.cashAmount || 0) : undefined;
            const resolvedOnlineAmount =
              isSplitCategory && mode === "Online" ? Number(owner.onlineAmount || 0) : undefined;
            const resolvedShareAmount = !isSplitCategory
              ? Number(owner.shareAmount || 0)
              : undefined;

             const matchedRealDueForLedger = (mediaObj.rentalDue || []).find((d) => d.dueMonth === cycleMonthLabel);
            const matchedDueForApproval = (mediaObj.rentalDue || []).find(
              (d) => d.dueMonth === cycleMonthLabel,
            );
             dueVirtualEntries.push({
              landOwnerId: owner._id,
              landOwnerName: owner.name,
              paymentCategory,
              paymentMode: mode,
              utrNumber: "",
              date: null,
              status: 0,
              dueMonth: cycleMonthLabel,
              cycle: cycleDate,
              rentalDueId: matchedRealDueForLedger?._id || null, // ✅ NEW
              index: null,
              updatedBy: "",
              updatedAt: null,
              cashAmount: resolvedCashAmount,
              onlineAmount: resolvedOnlineAmount,
              shareAmount: resolvedShareAmount,
              isVirtual: true,
              targetType,
               rentalDueApprovalStatus: matchedDueForApproval?.approvalStatus ?? 0, // ✅ NEW
            });
          });
        });
      });

      latestLedger = [...latestLedger, ...dueVirtualEntries];
      // AFTER
latestLedger = latestLedger.sort((a, b) => {
  // 1) Group by month/cycle first — earliest month first (July before August)
  const cycleA = a.cycle ? new Date(a.cycle).getTime() : 0;
  const cycleB = b.cycle ? new Date(b.cycle).getTime() : 0;
  if (cycleA !== cycleB) return cycleA - cycleB;

  // 2) Within the same month: Cash before Online
  if (a.paymentMode && b.paymentMode) {
    if (a.paymentMode === 'Cash' && b.paymentMode === 'Online') return -1;
    if (a.paymentMode === 'Online' && b.paymentMode === 'Cash') return 1;
  }

  // 3) Within same month+mode (shouldn't normally tie): paid before unpaid
  if (a.status === 1 && b.status !== 1) return -1;
  if (a.status !== 1 && b.status === 1) return 1;

  return 0;
});
      // if (
      //   latestLedger.length === 0 &&
      //   (mediaObj.landOwners || []).length > 0 &&
      //   currentCycleDueMonth
      // ) {
      //   const getRequiredModesForOwner = (paymentCategory) => {
      //     if (paymentCategory === 1) return ["Cash"];
      //     if (paymentCategory === 2) return ["Online"];
      //     if (paymentCategory === 3) return ["Cash", "Online"];
      //     return ["Cash"];
      //   };

      //   (mediaObj.landOwners || []).forEach((owner) => {
      //     const paymentCategory = Number(owner.paymentCategory || 1);
      //     getRequiredModesForOwner(paymentCategory).forEach((mode) => {
      //       latestLedger.push({
      //         landOwnerId: owner._id,
      //         landOwnerName: owner.name,
      //         paymentCategory,
      //         paymentMode: mode,
      //         utrNumber: "",
      //         date: null,
      //         status: 0,
      //       //   withGst: 2,
      //         dueMonth: currentCycleDueMonth,
      //         cycle: mediaObj.rentalPayment?.nextBillingDate || null,
      //         rentalDueId: null,
      //         index: null,
      //         updatedBy: "",
      //         updatedAt: null,
      //         amount: 0,
      //         isVirtual: true,
      //       });
      //     });
      //   });
      // }
      let rentalDueWithApproval = [];
      if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
        const sortedDue = [...mediaObj.rentalDue].sort((a, b) => {
          const dateA = a.ownerApprovalDate
            ? new Date(a.ownerApprovalDate)
            : new Date(0);
          const dateB = b.ownerApprovalDate
            ? new Date(b.ownerApprovalDate)
            : new Date(0);
          return dateB - dateA;
        });
        rentalDueWithApproval = sortedDue
          .filter((due) => due.ownerApprovalDate)
          .map((due) => {
            // ✅ NEW — cashAmount/onlineAmount live on the landOwner subdocument,
            // not on rentalDue itself. Match by due.landOwnerId if it exists on
            // your rentalDue schema; otherwise fall back to summing across every
            // landOwner on this media (covers the common single-owner-per-site case
            // and multi-owner sites where the due isn't owner-scoped).
            let cashAmount = 0;
            let onlineAmount = 0;

            if (due.landOwnerId) {
              const matchedOwner = (mediaObj.landOwners || []).find(
                (o) => String(o._id) === String(due.landOwnerId),
              );
              if (matchedOwner) {
                cashAmount = Number(matchedOwner.cashAmount || 0);
                onlineAmount = Number(matchedOwner.onlineAmount || 0);
              }
            } else {
              cashAmount = (mediaObj.landOwners || []).reduce(
                (sum, o) => sum + Number(o.cashAmount || 0),
                0,
              );
              onlineAmount = (mediaObj.landOwners || []).reduce(
                (sum, o) => sum + Number(o.onlineAmount || 0),
                0,
              );
            }
            // ✅ CHANGED — respects gstApplicableFlag to pick the correct source:
            // 1 = site-level (rentalPayment.gstApplicable/gstAmount) is authoritative
            // 2 = owner-level (landOwners[].gstApplicable/gstAmount) is authoritative
            // 0/unset = fall back to owner-level (previous behavior) as a best guess
            let gstAmount = Number(due.gstAmount || 0);
            if (Number(due.withGst) === 1 && gstAmount === 0) {
              const gstFlag = Number(mediaObj.gstApplicableFlag || 0);

              if (gstFlag === 1) {
                // site-level GST is authoritative
                if (Number(mediaObj.rentalPayment?.gstApplicable || 0) === 1) {
                  gstAmount = Number(mediaObj.rentalPayment?.gstAmount || 0);
                }
              } else {
                // gstFlag === 2, or 0/unset — use owner-level GST
                if (due.landOwnerId) {
                  const matchedOwner = (mediaObj.landOwners || []).find(
                    (o) => String(o._id) === String(due.landOwnerId),
                  );
                  if (
                    matchedOwner &&
                    Number(matchedOwner.gstApplicable || 0) === 1
                  ) {
                    gstAmount = Number(matchedOwner.gstAmount || 0);
                  }
                } else {
                  gstAmount = (mediaObj.landOwners || [])
                    .filter((o) => Number(o.gstApplicable || 0) === 1)
                    .reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
                }
              }
            }
            return {
              _id: due._id,
              ownerApprovalDate: due.ownerApprovalDate,
              dueMonth: due.dueMonth,
              dueDate: due.dueDate,
              netPayable: due.netPayable,
              approvalStatus: due.approvalStatus,
              withGst: due.withGst,
              gstAmount,
              baseAmount: due.baseAmount,
              paymentFrequency: due.paymentFrequency,
              campaignName: due.campaignName,
              status: due.status,
              updatedAt: due.updatedAt,
              createdAt: due.createdAt,
              cashAmount,
              onlineAmount,
            };
          });
      }

      // ✅ NEW — owner-approval list ALWAYS includes past-month pending
      // items too (in addition to the current cycle), per your note:
      // "owner approval list only show that fine cycle based working
      // incase past month pending data owner will approval that data
      // also show the list"
      const pendingApprovalsIncludingPastMonths = rentalDueWithApproval.filter(
        (due) =>
          due.approvalStatus === 0 ||
          due.approvalStatus === undefined ||
          due.approvalStatus === null,
      );

      const fullGstBalanceHistoryRaw = Array.isArray(mediaObj.gstBalanceHistory)
        ? mediaObj.gstBalanceHistory
        : [];
      // ✅ NEW — dedupe fix (drop accidental null-owner placeholder rows
      // when a real-owner row already covers that rentalDueId+dueMonth)
      const fullGstBalanceHistory = dedupeGstBalanceHistory(
        fullGstBalanceHistoryRaw,
      );

      let gstPendingAmount = 0;
      if (fullGstBalanceHistory.length > 0) {
        fullGstBalanceHistory.forEach((entry) => {
          const isPaid = entry.isPaid;
          const isPaidFalse =
            isPaid === false ||
            isPaid === "false" ||
            isPaid === 0 ||
            isPaid === "0";
          const hasRealUtr = entry.utrNumber && entry.utrNumber.trim() !== "";
          const isGenuinelyUnpaid = isPaidFalse || !hasRealUtr;
          if (isGenuinelyUnpaid) {
            const amount =
              Number(entry.paidAmount) ||
              Number(entry.amount) ||
              Number(entry.gstAmount) ||
              0;
            gstPendingAmount += amount;
          }
        });
      }

      let gstPayment = false;
      if (fullGstBalanceHistory.length > 0) {
        const hasEmptyUtr = fullGstBalanceHistory.some(
          (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
        );
        gstPayment = hasEmptyUtr;
      }

      const isGstPending = gstPayment || gstPendingAmount > 0;

      const gstPendingEntries = fullGstBalanceHistory.filter((entry) => {
        const isPaid = entry.isPaid;
        const isPaidFalse =
          isPaid === false ||
          isPaid === "false" ||
          isPaid === 0 ||
          isPaid === "0";
        const hasRealUtr = entry.utrNumber && entry.utrNumber.trim() !== "";
        return isPaidFalse || !hasRealUtr;
      });

      const realTdsEntries = Array.isArray(mediaObj.tdsBalanceHistory)
        ? mediaObj.tdsBalanceHistory
        : [];

      const toDueMonth = (dateVal) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      };

      const uniqueDueMonths = new Map();

      const addDueMonth = (dueMonthRaw, cycleValue) => {
        const dueMonth = dueMonthRaw || toDueMonth(cycleValue);
        if (!dueMonth) return;
        if (!uniqueDueMonths.has(dueMonth)) {
          uniqueDueMonths.set(
            dueMonth,
            cycleValue ? new Date(cycleValue) : null,
          );
        }
      };

      fullGstBalanceHistory.forEach((g) => {
        addDueMonth(g.dueMonth, g.cycle || g.date);
      });

      if (uniqueDueMonths.size === 0 && Array.isArray(mediaObj.rentalDue)) {
        mediaObj.rentalDue.forEach((due) => {
          addDueMonth(due.dueMonth, due.dueDate);
        });
      }

      if (uniqueDueMonths.size === 0 && Array.isArray(mediaObj.ledgerHistory)) {
        mediaObj.ledgerHistory.forEach((yearBucket) => {
          (yearBucket.months || []).forEach((monthBucket) => {
            const dueMonth = `${monthBucket.month} ${yearBucket.year}`;
            addDueMonth(dueMonth, null);
          });
        });
      }

      if (uniqueDueMonths.size === 0) {
        const fallbackCycle =
          mediaObj.rentalPayment?.nextBillingDate ||
          mediaObj.rentalPayment?.lastBillPaidDate ||
          new Date();
        addDueMonth(null, fallbackCycle);
      }

      const realTdsKeySet = new Set(
        realTdsEntries.map((t) => `${String(t.landOwnerId)}_${t.dueMonth}`),
      );

      const virtualTdsEntries = [];
      uniqueDueMonths.forEach((cycleDate, dueMonth) => {
        const monthName = dueMonth.split(" ")[0];

        (mediaObj.landOwners || []).forEach((owner) => {
          const isApplicable =
            owner.tdsApplicable === 1 ||
            owner.tdsApplicable === "1" ||
            owner.tdsApplicable === true;
          if (!isApplicable) return;

          const key = `${String(owner._id)}_${dueMonth}`;
          if (realTdsKeySet.has(key)) return;

          const tdsAmount = Number(owner.tdsAmount || 0);

          virtualTdsEntries.push({
            _id: null,
            dueMonth,
            month: monthName,
            cycle: cycleDate,
            tdsAmount,
            isUtrEntry: false,
            paidAmount: 0,
            paidAt: null,
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            utrNumber: "",
            date: null,
            isVirtual: true,
          });
        });
      });

      const tdsBalanceHistoryFiltered = [
        ...realTdsEntries,
        ...virtualTdsEntries,
      ].sort(
        (a, b) =>
          new Date(a.cycle || a.date || 0) - new Date(b.cycle || b.date || 0),
      );

      let tdsPendingAmount = 0;
      tdsBalanceHistoryFiltered.forEach((entry) => {
        const isUtrEntry = entry.isUtrEntry;
        const isUnpaid =
          isUtrEntry === false ||
          isUtrEntry === "false" ||
          isUtrEntry === undefined ||
          isUtrEntry === null;
        if (isUnpaid) {
          const amount =
            Number(entry.paidAmount) || Number(entry.tdsAmount) || 0;
          tdsPendingAmount += amount;
        }
      });

      const hasUnpaidTds = tdsBalanceHistoryFiltered.some(
        (t) => !t.isUtrEntry || !t.utrNumber || t.utrNumber.trim() === "",
      );
      const hasAnyTdsRecord = tdsBalanceHistoryFiltered.length > 0;
      const isTdsFullyPaid = hasAnyTdsRecord && !hasUnpaidTds;

      const isTdsPending = hasUnpaidTds;

      const tdsPendingEntries = tdsBalanceHistoryFiltered.filter((entry) => {
        const isUtrEntry = entry.isUtrEntry;
        return (
          isUtrEntry === false ||
          isUtrEntry === "false" ||
          isUtrEntry === undefined ||
          isUtrEntry === null
        );
      });

      const {
        ledgerHistory,
        pendingMonths: rawPendingMonths,
        ...restOfMediaObj
      } = mediaObj;

      // ✅ NEW — outstanding summary + currentBillDate for this media
      const outstanding = computeOutstandingSummary(
        mediaObj,
        requestedMonthYearParsed,
      );
      const currentBillDateForMedia = getCurrentBillDate(
        mediaObj,
        requestedMonthYearParsed,
      );
      const correctedLandOwners = (mediaObj.landOwners || []).map((owner) => {
        if (!owner.landOwnerMasterId) return owner;
        const trueLinkedSites = allMediaSharingOwners
          .filter((m) =>
            (m.landOwners || []).some(
              (o) =>
                String(o.landOwnerMasterId) === String(owner.landOwnerMasterId),
            ),
          )
          .map((m) => {
            const matchedOwnerOnThatSite = m.landOwners.find(
              (o) =>
                String(o.landOwnerMasterId) === String(owner.landOwnerMasterId),
            );
            return {
              mediaId: m._id,
              mediaCode: m.mediaCode,
              mediaName: m.mediaName,
              siteBillMode: m.siteBillMode,
              paymentCategory: matchedOwnerOnThatSite?.paymentCategory,
              shareAmount: matchedOwnerOnThatSite?.shareAmount || 0,
              cashAmount: matchedOwnerOnThatSite?.cashAmount || 0,
              onlineAmount: matchedOwnerOnThatSite?.onlineAmount || 0,
              updatedAt: matchedOwnerOnThatSite?.updatedAt || null,
              _id: matchedOwnerOnThatSite?._id,
            };
          });
        return {
          ...owner,
          linkedMediaCount: trueLinkedSites.length,
          linkedSites: trueLinkedSites,
        };
      });
      return {
        ...restOfMediaObj,
        landOwners: correctedLandOwners,
        ledger: latestLedger,
        withGst1Ledger: withGst1Ledger,
        pendingMonths,
        pendingMonthsCount: autoDueCycles.length,
         rentalDueEntries: buildAutoRentalDueEntries(mediaObj, requestedMonthYearParsed),
        monthHistoryEntries: requestedMonthRange
          ? monthHistoryEntries
          : undefined,
        rentalDue: rentalDueWithApproval,
        gstPayment: gstPayment,
        gstBalanceHistory: fullGstBalanceHistory,
        gstPendingAmount: gstPendingAmount,
        isGstPending: isGstPending,
        gstPendingEntries: gstPendingEntries,
        tdsPendingAmount: tdsPendingAmount,
        tdsBalanceHistory: tdsBalanceHistoryFiltered,
        isTdsPending: isTdsPending,
        tdsPendingEntries: tdsPendingEntries,
        tdsStatusFlags: { hasUnpaidTds, isTdsFullyPaid },
        isPendingAcrossPastMonths,
        _pastMonthPendingCount: pastMonthPendingCount,

        // ══ NEW fields appended below — nothing above this line changed ══
        outstanding,
        currentBillDate: currentBillDateForMedia
          ? formatDate(currentBillDateForMedia)
          : "",
        lastBillDate: formatDate(mediaObj.rentalPayment?.lastBillPaidDate),
        nextBillingDate: formatDate(mediaObj.rentalPayment?.nextBillingDate),
        outStantStatus:
          mediaObj.rentalPayment?.outStantStatus ??
          (outstanding.totalOutstandingAmount > 0 ? 1 : 0),
        // gstOutstandingHistory:
        //   mediaObj.rentalPayment?.gstOutstandingHistory || [],
        rentalOutstandingHistory:
          mediaObj.rentalPayment?.rentalOutstandingHistory || [],
        pendingApprovals: pendingApprovalsIncludingPastMonths,
      };
    });

    let finalMediaListData = mediaListData;

    // ✅ NEW — when mediaId[] is explicitly provided, the caller asked for
    // THOSE sites specifically. currentMonth should shape what's shown for
    // each (ledger/outstanding values), never decide whether an explicitly
    // requested site appears at all — e.g. a 6-month-frequency site whose
    // cycle dates fall outside the requested month must still show up.
    const mediaIdExplicitlyRequested =
      Array.isArray(req.body.mediaId) && req.body.mediaId.length > 0;

    if (
      requestedMonthRange &&
      !isPendingFilter &&
      !isGstPendingFilter &&
      !isTdsPendingFilter &&
      !mediaIdExplicitlyRequested
    ) {
      const requestedMonthName =
        MONTH_NAMES[requestedMonthRange.startDate.getUTCMonth()];

      finalMediaListData = finalMediaListData.filter((m) => {
        const lastBillPaidDate = m.rentalPayment?.lastBillPaidDate;
        if (lastBillPaidDate) {
          const d = new Date(lastBillPaidDate);
          if (
            d >= requestedMonthRange.startDate &&
            d <= requestedMonthRange.endDate
          ) {
            return true;
          }
        }

        if (Array.isArray(m.rentalDue)) {
          const hasMatchingDue = m.rentalDue.some((due) => {
            if (!due.dueDate) return false;
            const d = new Date(due.dueDate);
            return (
              d >= requestedMonthRange.startDate &&
              d <= requestedMonthRange.endDate
            );
          });
          if (hasMatchingDue) return true;
        }

        const hasLedgerActivity =
          (Array.isArray(m.ledger) &&
            m.ledger.some(
              (e) => !e.isVirtual && e.month?.includes(requestedMonthName),
            )) ||
          (Array.isArray(m.withGst1Ledger) &&
            m.withGst1Ledger.some(
              (e) => !e.isVirtual && e.month?.includes(requestedMonthName),
            ));
        if (hasLedgerActivity) return true;

        return false;
      });
    }

    if (isPendingFilter) {
      finalMediaListData = finalMediaListData.filter(
        (m) => m.isPendingAcrossPastMonths,
      );
    }

    if (isGstPendingFilter || isTdsPendingFilter) {
      finalMediaListData = finalMediaListData.filter((m) => {
        const matchesGst = isGstPendingFilter && m.isGstPending;
        const matchesTds = isTdsPendingFilter && m.isTdsPending;
        return matchesGst || matchesTds;
      });
    }

    if (tdsStatusFilter === 4) {
      finalMediaListData = finalMediaListData.filter(
        (m) => m.tdsStatusFlags.hasUnpaidTds,
      );
    } else if (tdsStatusFilter === 5) {
      finalMediaListData = finalMediaListData.filter(
        (m) => m.tdsStatusFlags.isTdsFullyPaid,
      );
    }

    const computeGstPendingAmountForDoc = (obj) => {
      const fullGstBalanceHistory = Array.isArray(obj.gstBalanceHistory)
        ? obj.gstBalanceHistory
        : [];
      let amountSum = 0;
      fullGstBalanceHistory.forEach((entry) => {
        const isPaid = entry.isPaid;
        const isPaidFalse =
          isPaid === false ||
          isPaid === "false" ||
          isPaid === 0 ||
          isPaid === "0";
        const hasRealUtr = entry.utrNumber && entry.utrNumber.trim() !== "";
        const isGenuinelyUnpaid = isPaidFalse || !hasRealUtr;
        if (isGenuinelyUnpaid) {
          const amount =
            Number(entry.paidAmount) ||
            Number(entry.amount) ||
            Number(entry.gstAmount) ||
            0;
          amountSum += amount;
        }
      });
      return amountSum;
    };

    const computeTdsPendingAmountForDoc = (obj) => {
      const realTdsEntries = Array.isArray(obj.tdsBalanceHistory)
        ? obj.tdsBalanceHistory
        : [];

      const toDueMonth = (dateVal) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      };

      const uniqueDueMonths = new Map();
      const addDueMonth = (dueMonthRaw, cycleValue) => {
        const dueMonth = dueMonthRaw || toDueMonth(cycleValue);
        if (!dueMonth) return;
        if (!uniqueDueMonths.has(dueMonth)) {
          uniqueDueMonths.set(
            dueMonth,
            cycleValue ? new Date(cycleValue) : null,
          );
        }
      };

      (Array.isArray(obj.gstBalanceHistory)
        ? obj.gstBalanceHistory
        : []
      ).forEach((g) => addDueMonth(g.dueMonth, g.cycle || g.date));
      if (uniqueDueMonths.size === 0 && Array.isArray(obj.rentalDue)) {
        obj.rentalDue.forEach((due) => addDueMonth(due.dueMonth, due.dueDate));
      }
      if (uniqueDueMonths.size === 0 && Array.isArray(obj.ledgerHistory)) {
        obj.ledgerHistory.forEach((yearBucket) => {
          (yearBucket.months || []).forEach((monthBucket) => {
            addDueMonth(`${monthBucket.month} ${yearBucket.year}`, null);
          });
        });
      }
      if (uniqueDueMonths.size === 0) {
        const fallbackCycle =
          obj.rentalPayment?.nextBillingDate ||
          obj.rentalPayment?.lastBillPaidDate ||
          new Date();
        addDueMonth(null, fallbackCycle);
      }

      const realTdsKeySet = new Set(
        realTdsEntries.map((t) => `${String(t.landOwnerId)}_${t.dueMonth}`),
      );

      const virtualTdsEntries = [];
      uniqueDueMonths.forEach((cycleDate, dueMonth) => {
        (obj.landOwners || []).forEach((owner) => {
          const isApplicable =
            owner.tdsApplicable === 1 ||
            owner.tdsApplicable === "1" ||
            owner.tdsApplicable === true;
          if (!isApplicable) return;

          const key = `${String(owner._id)}_${dueMonth}`;
          if (realTdsKeySet.has(key)) return;

          virtualTdsEntries.push({
            tdsAmount: Number(owner.tdsAmount || 0),
            isUtrEntry: false,
            paidAmount: 0,
          });
        });
      });

      const tdsBalanceHistoryFiltered = [
        ...realTdsEntries,
        ...virtualTdsEntries,
      ];

      let amountSum = 0;
      tdsBalanceHistoryFiltered.forEach((entry) => {
        const isUtrEntry = entry.isUtrEntry;
        const isUnpaid =
          isUtrEntry === false ||
          isUtrEntry === "false" ||
          isUtrEntry === undefined ||
          isUtrEntry === null;
        if (isUnpaid) {
          const amount =
            Number(entry.paidAmount) || Number(entry.tdsAmount) || 0;
          amountSum += amount;
        }
      });
      return amountSum;
    };

    overallGstPendingAmount = overallPendingDocs.reduce((sum, doc) => {
      const obj = doc.toObject();
      return sum + computeGstPendingAmountForDoc(obj);
    }, 0);

    const overallTdsPendingAmount = overallPendingDocs.reduce((sum, doc) => {
      const obj = doc.toObject();
      return sum + computeTdsPendingAmountForDoc(obj);
    }, 0);
    const GSTPeningCount = mediaListData.filter((m) => m.isGstPending).length;
    const TDSPeningCount = mediaListData.filter((m) => m.isTdsPending).length;

    finalMediaListData = finalMediaListData.map(
      ({
        tdsStatusFlags,
        isPendingAcrossPastMonths,
        _pastMonthPendingCount,
        ...rest
      }) => rest,
    );

    let effectiveTotalCount = totalCount;
    if (needsFullFetch) {
      effectiveTotalCount = finalMediaListData.length;
      finalMediaListData = finalMediaListData.slice(skip, skip + pageSize);
    }

    // ✅ NEW — overall outstanding totals across the overallPendingDocs set
    const overallOutstandingTotals = overallPendingDocs.reduce(
      (acc, doc) => {
        const obj = doc.toObject();
        // ✅ FIXED — was missing requestedMonthYearParsed, so
        // getCurrentGstDue fell back to nextBillingDate (already advanced
        // past the live cycle) instead of the actual requested/current
        // month, causing this cycle's real GST due to get miscounted as
        // "previous" instead of "current".
        const s = computeOutstandingSummary(obj, requestedMonthYearParsed);
        acc.overallCurrentBaseRentDue += s.currentBaseRent;
        acc.overallCurrentGSTDue += s.currentGSTDue;
        acc.overallPreviousBaseRentDue += s.previousBaseRentDue;
        acc.overallPreviousGSTDue += s.previousGSTDue;
        acc.overallTotalOutstandingAmount += s.totalOutstandingAmount;
        return acc;
      },
      {
        overallCurrentBaseRentDue: 0,
        overallCurrentGSTDue: 0,
        overallPreviousBaseRentDue: 0,
        overallPreviousGSTDue: 0,
        overallTotalOutstandingAmount: 0,
      },
    );

    // ✅ NEW — billGroups: collapse ledger entries that share the same
    // utrNumber (a siteBillMode:1 single bill spanning multiple sites/
    // owners) into one grouped row, instead of repeating the same UTR
    // once per site in the flat mediaList. Cash entries (no UTR) are
    // never grouped — each stays under its own media item as before.
    const billGroupsMap = new Map();
    finalMediaListData.forEach((mediaItem) => {
      const allLedgerEntries = [
        ...(Array.isArray(mediaItem.ledger) ? mediaItem.ledger : []),
        ...(Array.isArray(mediaItem.withGst1Ledger)
          ? mediaItem.withGst1Ledger
          : []),
      ];
      const nextBillingDate = mediaItem.rentalPayment?.nextBillingDate;
      allLedgerEntries.forEach((entry) => {
        if (entry.isVirtual) return; // only real, saved entries form a bill group
        if (!entry.utrNumber || String(entry.utrNumber).trim() === "") return;
        const monthKey = entry.dueMonth || entry.month || "";
        const groupKey = `${entry.utrNumber}_${monthKey}`;

        if (!billGroupsMap.has(groupKey)) {
          billGroupsMap.set(groupKey, {
            billGroupId: groupKey,
            dueMonth: monthKey,
            paymentMode: entry.paymentMode,
            utrNumber: entry.utrNumber,
            date: entry.date,
            landOwners: [],
            sites: [],
            totalAmount: 0,
            breakdown: {
              currentAmount: 0,
              pastCycleAmount: 0,
              outstandingAmount: 0,
            }, // ✅ NEW
          });
        }
        const group = billGroupsMap.get(groupKey);

        // ✅ NEW — inferred targetType per site (dueMonth vs. this site's
        // own live cycle — each site in a multi-site bill can have a
        // different live cycle, so this is computed per entry, not once
        // for the whole group)
        const inferredTargetType = classifyDueMonthTargetType(
          monthKey,
          nextBillingDate,
        );

        if (
          !group.landOwners.some(
            (o) => String(o.landOwnerId) === String(entry.landOwnerId),
          )
        ) {
          group.landOwners.push({
            landOwnerId: entry.landOwnerId,
            landOwnerName: entry.landOwnerName,
          });
        }
        group.sites.push({
          mediaId: mediaItem._id || mediaItem.mediaId,
          mediaName: mediaItem.mediaName,
          landOwnerId: entry.landOwnerId,
          amount: Number(entry.amount || 0),
          rentalDueId: entry.rentalDueId || null,
          targetType: inferredTargetType, // ✅ NEW
        });
        group.totalAmount += Number(entry.amount || 0);
        if (inferredTargetType === "current")
          group.breakdown.currentAmount += Number(entry.amount || 0);
        else group.breakdown.pastCycleAmount += Number(entry.amount || 0);
      });
    });
    const billGroups = Array.from(billGroupsMap.values()).filter(
      (g) => g.sites.length > 1,
    );

    return successResponse(
      res,
      "Media list fetched successfully",
      {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount: effectiveTotalCount,
        totalPages: Math.ceil(effectiveTotalCount / pageSize),
        overallGstPendingAmount,
        overallTdsPendingAmount,
        overallPastMonthPendingCount,
        GSTPeningCount,
        TDSPeningCount,
        ...overallOutstandingTotals, // ✅ NEW
        // billGroups, // ✅ NEW
        mediaList: finalMediaListData,
      },
      200,
    );
  } catch (error) {
    console.error("listMediaByLedger error:", error);
    return errorResponse(
      res,
      "Something went wrong while fetching media list",
      { error: error.message },
      500,
    );
  }
};

/* ═══════════════════════════════════════════════════════════════════════
 * getLedgerHistory — ORIGINAL logic kept AS-IS. NEW: outstanding summary,
 * currentBillDate, gstOutstandingHistory/rentalOutstandingHistory blocks,
 * and the gstBalanceHistory dedupe fix appended to the response.
 * ═══════════════════════════════════════════════════════════════════════*/
function getAutoCurrentMonthYM() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

// ✅ ADDED — compares two {year, month} objects: negative if a < b,
// positive if a > b, 0 if equal.
function compareYM(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

// ✅ ADDED — inclusive range check. A null bound means "unbounded" on
// that side (e.g. rangeStart: null means "from the beginning").
function isYMInRange(ym, rangeStart, rangeEnd) {
  if (rangeStart && compareYM(ym, rangeStart) < 0) return false;
  if (rangeEnd && compareYM(ym, rangeEnd) > 0) return false;
  return true;
}
exports.getLedgerHistory = async (req, res) => {
  try {
     const { mediaId, landOwnerMasterId, year, startMonth, endMonth, currentMonth } = req.body;
    if (!Array.isArray(mediaId) || mediaId.length === 0) {
      return errorResponse(res, "mediaId must be a non-empty array", null, 400);
    }
    const validMediaIds = mediaId.filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );
    if (validMediaIds.length !== mediaId.length) {
      return errorResponse(
        res,
        "mediaId array contains an invalid ObjectId",
        null,
        400,
      );
    }

    let ownerMasterIdFilter = null;
    if (
      landOwnerMasterId !== undefined &&
      landOwnerMasterId !== null &&
      landOwnerMasterId !== ""
    ) {
      if (!Array.isArray(landOwnerMasterId) || landOwnerMasterId.length === 0) {
        return errorResponse(
          res,
          "landOwnerMasterId must be a non-empty array when provided",
          null,
          400,
        );
      }
      const validOwnerIds = landOwnerMasterId.filter((id) =>
        mongoose.Types.ObjectId.isValid(id),
      );
      if (validOwnerIds.length !== landOwnerMasterId.length) {
        return errorResponse(
          res,
          "landOwnerMasterId array contains an invalid ObjectId",
          null,
          400,
        );
      }
      ownerMasterIdFilter = validOwnerIds.map(String);
    }

    // ✅ ADDED — currentMonth, always "now" (rule #2).
     let autoCurrentMonthYM = getAutoCurrentMonthYM();
    if (currentMonth) {
      const parsedCurrentMonth = parseMonthYearParam(currentMonth);
      if (!parsedCurrentMonth) {
        return errorResponse(res, "currentMonth must be in MM-YYYY format", null, 400);
      }
      autoCurrentMonthYM = parsedCurrentMonth;
    }

    // ✅ ADDED — parse startMonth/endMonth ("MM-YYYY").
    const parsedStartMonth = startMonth ? parseMonthYearParam(startMonth) : null;
    const parsedEndMonth = endMonth ? parseMonthYearParam(endMonth) : null;
    if (startMonth && !parsedStartMonth) {
      return errorResponse(res, "startMonth must be in MM-YYYY format", null, 400);
    }
    if (endMonth && !parsedEndMonth) {
      return errorResponse(res, "endMonth must be in MM-YYYY format", null, 400);
    }

    // ✅ ADDED — priority logic, exactly as specified:
    let rangeStart = null;
    let rangeEnd = null;
    if (parsedStartMonth && parsedEndMonth) {
      // both given → ONLY startMonth -> endMonth, currentMonth NOT applied (rule #5)
      rangeStart = parsedStartMonth;
      rangeEnd = parsedEndMonth;
    } else if (parsedStartMonth) {
      // startMonth only → startMonth -> currentMonth (rule #4)
      rangeStart = parsedStartMonth;
      rangeEnd = autoCurrentMonthYM;
    } else if (parsedEndMonth) {
      // endMonth only → up to endMonth, no currentMonth fallback (rule #6)
      rangeStart = null;
      rangeEnd = parsedEndMonth;
    } else {
      // neither → currentMonth logic (rule #3)
      rangeStart = null;
      rangeEnd = autoCurrentMonthYM;
    }

    const mediaDocs = await Media.find({ _id: { $in: validMediaIds } })
      .select(
        "mediaName city mediaType mediaCode rentalPayment rentalDueHistory ledgerHistory ledger withGst1Ledger landOwners agreement gstBalanceHistory tdsBalanceHistory rentalDue pendingMonths",
      )
      .lean();

    const foundIds = new Set(mediaDocs.map((m) => String(m._id)));
    const notFoundIds = validMediaIds.filter((id) => !foundIds.has(String(id)));

    // ✅ CHANGED — pass rangeStart/rangeEnd instead of month/requestedMonthYear
    const mediaHistoryList = mediaDocs.map((media) =>
      buildSingleMediaHistoryBlock(media, {
        year,
        ownerMasterIdFilter,
        rangeStart,
        rangeEnd,
      }),
    );

    const summary = mediaHistoryList.reduce(
      (acc, block) => {
        acc.totalMediaRequested = validMediaIds.length;
        if (block.landOwners.length > 0 || !ownerMasterIdFilter) {
          acc.totalMediaWithMatchingOwner += 1;
        }
        acc.overallCurrentBaseRentDue += block.outstanding.currentBaseRent;
        acc.overallCurrentGSTDue += block.outstanding.currentGSTDue;
        acc.overallPreviousBaseRentDue += block.outstanding.previousBaseRentDue;
        acc.overallPreviousGSTDue += block.outstanding.previousGSTDue;
        acc.overallTotalOutstandingAmount +=
          block.outstanding.totalOutstandingAmount;
        return acc;
      },
      {
        totalMediaRequested: validMediaIds.length,
        totalMediaWithMatchingOwner: 0,
        overallCurrentBaseRentDue: 0,
        overallCurrentGSTDue: 0,
        overallPreviousBaseRentDue: 0,
        overallPreviousGSTDue: 0,
        overallTotalOutstandingAmount: 0,
      },
    );

    // ✅ NEW — same billGroups collapsing as listMediaByLedger, applied
    // across every media block's ledgerHistory months. Groups real
    // (non-virtual) entries sharing a utrNumber into one row spanning
    // all the sites/owners it actually paid for.
    const billGroupsMap = new Map();
    mediaHistoryList.forEach((block) => {
      const nextBillingDate = block.rentalPayment?.nextBillingDate;
      (block.ledgerHistory || []).forEach((yearEntry) => {
        (yearEntry.months || []).forEach((monthEntry) => {
          const allEntries = [
            ...(monthEntry.ledger || []),
            ...(monthEntry.withGst1Ledger || []),
          ];
          allEntries.forEach((entry) => {
            if (entry.isVirtual) return;
            if (!entry.utrNumber || String(entry.utrNumber).trim() === "")
              return;
            const monthKey = entry.month || monthEntry.month || "";
            const groupKey = `${entry.utrNumber}_${monthKey}`;

            if (!billGroupsMap.has(groupKey)) {
              billGroupsMap.set(groupKey, {
                billGroupId: groupKey,
                dueMonth: monthKey,
                paymentMode: entry.paymentMode,
                utrNumber: entry.utrNumber,
                date: entry.date,
                landOwners: [],
                sites: [],
                totalAmount: 0,
                breakdown: {
                  currentAmount: 0,
                  pastCycleAmount: 0,
                  outstandingAmount: 0,
                }, // ✅ NEW
              });
            }
            const group = billGroupsMap.get(groupKey);

            // ✅ NEW — inferred targetType per site
            const inferredTargetType = classifyDueMonthTargetType(
              monthKey,
              nextBillingDate,
            );

            if (
              !group.landOwners.some(
                (o) => String(o.landOwnerId) === String(entry.landOwnerId),
              )
            ) {
              group.landOwners.push({
                landOwnerId: entry.landOwnerId,
                landOwnerName: entry.landOwnerName,
              });
            }
            group.sites.push({
              mediaId: block.mediaId,
              mediaName: block.mediaName,
              landOwnerId: entry.landOwnerId,
              amount: Number(entry.amount || 0),
              rentalDueId: entry.rentalDueId || null,
              targetType: inferredTargetType, // ✅ NEW
            });
            group.totalAmount += Number(entry.amount || 0);
            if (inferredTargetType === "current")
              group.breakdown.currentAmount += Number(entry.amount || 0);
            else group.breakdown.pastCycleAmount += Number(entry.amount || 0);
          });
        });
      });
    });
    const billGroups = Array.from(billGroupsMap.values()).filter(
      (g) => g.sites.length > 1,
    );

    return successResponse(
      res,
      "Ledger history fetched successfully",
      {
        requestedFilters: {
          mediaId: validMediaIds,
          landOwnerMasterId: ownerMasterIdFilter,
          year: year || null,
          startMonth: startMonth || null,
          endMonth: endMonth || null,
          currentMonth: currentMonth || null, // ✅ CHANGED — echoes what the frontend actually sent
          currentMonthResolved: `${String(autoCurrentMonthYM.month).padStart(2, "0")}-${autoCurrentMonthYM.year}`, // ✅ RENAMED from currentMonthAuto — the value actually used (frontend's, or server fallback)
        },
        notFoundMediaIds: notFoundIds,
        mediaHistoryList,
        billGroups, // ✅ NEW
        summary,
      },
      200,
    );
  } catch (error) {
    console.error("getLedgerHistory error:", error);
    return errorResponse(
      res,
      "Something went wrong while fetching ledger history",
      { error: error.message },
      500,
    );
  }
};


function buildSingleMediaHistoryBlock(
  media,
   { year, ownerMasterIdFilter, rangeStart, rangeEnd },
) {
  // ── landOwnerMasterId -> matching embedded landOwners._id set ──
  const allLandOwners = media.landOwners || [];
  const matchingLandOwners = ownerMasterIdFilter
    ? allLandOwners.filter((o) =>
        ownerMasterIdFilter.includes(String(o.landOwnerMasterId)),
      )
    : allLandOwners;
  const matchingOwnerIdSet = new Set(
    matchingLandOwners.map((o) => String(o._id)),
  );

 const belongsToMatchingOwner = (landOwnerId) =>
    !ownerMasterIdFilter || !landOwnerId || matchingOwnerIdSet.has(String(landOwnerId));

  if (ownerMasterIdFilter && matchingLandOwners.length === 0) {
    // No owner on this media matches the filter — return an empty-but-present block
    const emptyOutstanding = {
      currentBaseRent: 0,
      currentGSTDue: 0,
      previousBaseRentDue: 0,
      previousGSTDue: 0,
      totalOutstandingAmount: 0,
    };
    return {
      mediaId: media._id,
      mediaName: media.mediaName,
      mediaType: media.mediaType,
      mediaCode: media.mediaCode,
      city: media.city,
      landOwners: [],
      ledgerHistory: [],
       rentalDueEntries: buildAutoRentalDueEntries(media, rangeEnd || null),
      gstPayment: false,
      tdsPayment: false,
      outstanding: emptyOutstanding,
      lastBillDate: formatDate(media.rentalPayment?.lastBillPaidDate),
      nextBillingDate: formatDate(media.rentalPayment?.nextBillingDate),
      currentBillDate: "",
      outStantStatus: media.rentalPayment?.outStantStatus ?? 0,
      gstOutstandingHistory: [],
      rentalOutstandingHistory: [],
      note: "No landOwner on this media matches the requested landOwnerMasterId — media included with empty history rather than silently dropped.",
    };
  }

  const mergeLedgerSources = (sourceA, sourceB) => {
    const yearMap = new Map();

    const addYearEntry = (yearEntry) => {
      if (!yearEntry || !yearEntry.year) return;
      const yearKey = String(yearEntry.year).trim(); // ✅ CHANGED — normalize key type
      if (!yearMap.has(yearKey)) {
        yearMap.set(yearKey, new Map());
      }
      const monthMap = yearMap.get(yearKey);

      (yearEntry.months || []).forEach((monthEntry) => {
        if (!monthEntry || !monthEntry.month) return;
        const key = monthEntry.month.toLowerCase();

        if (!monthMap.has(key)) {
          monthMap.set(key, {
            month: monthEntry.month,
            entries: [...(monthEntry.entries || [])],
          });
        } else {
          monthMap.get(key).entries.push(...(monthEntry.entries || []));
        }
      });
    };

    (sourceA || []).forEach(addYearEntry);
    (sourceB || []).forEach(addYearEntry);

    return Array.from(yearMap.entries()).map(([yr, monthMap]) => ({
      year: yr,
      months: Array.from(monthMap.values()),
    }));
  };

  let ledgerHistory = mergeLedgerSources(
    media.rentalDueHistory,
    media.ledgerHistory,
  );

  const effectiveYear = year ? String(year) : null;

  if (effectiveYear) {
    ledgerHistory = ledgerHistory.filter(
      (item) => String(item.year).trim() === String(effectiveYear).trim(),
    );
  }

  if (rangeStart || rangeEnd) {
    ledgerHistory = ledgerHistory
      .map((item) => ({
        ...item,
        months: (item.months || []).filter((m) => {
          const monthIdx = MONTH_NAMES.findIndex(
            (mn) => mn.toLowerCase() === String(m.month).trim().toLowerCase(),
          );
          if (monthIdx === -1) return false;
          const ym = { year: Number(item.year), month: monthIdx + 1 };
          return isYMInRange(ym, rangeStart, rangeEnd);
        }),
      }))
      .filter((item) => item.months.length > 0);
  }

  // ✅ used for outstanding/currentBillDate/auto-cycle-walk reference —
  // the upper bound of the resolved range.
  const effectiveMonthYear = rangeEnd || null;

  // ✅ owner filter applied to every month bucket's raw entries up front
  if (ownerMasterIdFilter) {
    ledgerHistory = ledgerHistory.map((yearEntry) => ({
      ...yearEntry,
      months: yearEntry.months.map((monthEntry) => ({
        ...monthEntry,
        entries: (monthEntry.entries || []).filter((e) =>
          belongsToMatchingOwner(e.landOwnerId),
        ),
      })),
    }));
  }

  const fullGstBalanceHistoryUnfiltered = dedupeGstBalanceHistory(
    Array.isArray(media.gstBalanceHistory) ? media.gstBalanceHistory : [],
  );
  const fullGstBalanceHistory = ownerMasterIdFilter
    ? fullGstBalanceHistoryUnfiltered.filter((g) =>
        belongsToMatchingOwner(g.ownerId || g.landOwnerId),
      )
    : fullGstBalanceHistoryUnfiltered;

  let gstPayment = false;
  if (fullGstBalanceHistory.length > 0) {
    gstPayment = fullGstBalanceHistory.some(
      (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
    );
  }

  const fullTdsBalanceHistoryUnfiltered = Array.isArray(media.tdsBalanceHistory)
    ? media.tdsBalanceHistory
    : [];
  const fullTdsBalanceHistory = ownerMasterIdFilter
    ? fullTdsBalanceHistoryUnfiltered.filter((t) =>
        belongsToMatchingOwner(t.landOwnerId),
      )
    : fullTdsBalanceHistoryUnfiltered;

  let tdsPayment = false;
  if (fullTdsBalanceHistory.length > 0) {
    tdsPayment = fullTdsBalanceHistory.some(
      (entry) =>
        entry.isUtrEntry === false ||
        !entry.utrNumber ||
        entry.utrNumber.trim() === "",
    );
  }

  const dedupeByKey = (entries, getKey) => {
    const withPos = entries.map((entry, pos) => ({ entry, pos }));
    const sorted = withPos.sort(
      (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
    );
    const seen = new Set();
    const deduped = [];
    for (const { entry, pos } of sorted) {
      const key = getKey(entry, pos);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(entry);
      }
    }
    return deduped;
  };

  const gst2Key = (entry, pos) =>
    entry.index !== undefined && entry.index !== null
      ? `idx_${entry.index}`
      : entry._id
        ? `id_${String(entry._id)}`
        : `pos_${pos}`;

  const gst1Key = (entry, pos) =>
    entry.rentalDueId
      ? `rd_${String(entry.rentalDueId)}`
      : entry.landOwnerId
        ? `owner_${String(entry.landOwnerId)}_${entry.month || ""}`
        : entry._id
          ? `id_${String(entry._id)}`
          : `pos_${pos}`;

  const getGstBalanceDetails = (
    landOwnerId,
    monthLabel,
    rentalDueId,
    entryDate,
  ) => {
    try {
      if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0)
        return { isPaid: false, gstAmount: 0 };
      if (!landOwnerId) return { isPaid: false, gstAmount: 0 };

      let gstEntry = fullGstBalanceHistory.find(
        (entry) =>
          entry &&
          String(entry.landOwnerId) === String(landOwnerId) &&
          entry.month === monthLabel,
      );

      if (!gstEntry && rentalDueId) {
        gstEntry = fullGstBalanceHistory.find(
          (entry) =>
            entry &&
            entry.rentalDueId &&
            String(entry.rentalDueId) === String(rentalDueId),
        );
      }

      if (!gstEntry && entryDate) {
        const entryDateObj = new Date(entryDate);
        const entryMonth = entryDateObj.getMonth();
        const entryYear = entryDateObj.getFullYear();

        gstEntry = fullGstBalanceHistory.find(
          (entry) =>
            entry &&
            entry.date &&
            String(entry.landOwnerId) === String(landOwnerId) &&
            new Date(entry.date).getMonth() === entryMonth &&
            new Date(entry.date).getFullYear() === entryYear,
        );
      }

      if (!gstEntry) {
        const monthMatches = fullGstBalanceHistory.filter(
          (entry) => entry && entry.month === monthLabel,
        );
        if (monthMatches.length === 1) gstEntry = monthMatches[0];
      }

      return {
        isPaid: gstEntry ? gstEntry.isPaid || false : false,
        gstAmount: gstEntry ? gstEntry.gstAmount || 0 : 0,
      };
    } catch (gstError) {
      console.error("Error getting GST balance details:", gstError);
      return { isPaid: false, gstAmount: 0 };
    }
  };

  const getGstBalanceHistoryForMonth = (monthName) => {
    if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) return [];
    return fullGstBalanceHistory.filter(
      (entry) =>
        entry &&
        entry.dueMonth &&
        entry.dueMonth.toLowerCase().includes(monthName.toLowerCase()),
    );
  };

  const getTdsBalanceHistoryForMonth = (
    monthName,
    yearFromEntry,
    cycleDate,
  ) => {
    const realForMonth = (fullTdsBalanceHistory || []).filter((entry) => {
      if (!entry) return false;
      if (entry.month && entry.month.toLowerCase() !== monthName.toLowerCase())
        return false;
      if (!entry.month && entry.dueMonth) {
        const expectedDueMonth = `${monthName} ${yearFromEntry}`.toLowerCase();
        return entry.dueMonth.toLowerCase() === expectedDueMonth;
      }
      if (yearFromEntry && entry.dueMonth)
        return entry.dueMonth.toLowerCase().includes(String(yearFromEntry));
      return !!entry.month;
    });

    const realOwnerIds = new Set(
      realForMonth.map((t) => String(t.landOwnerId)),
    );

    const virtualForMonth = [];
    matchingLandOwners.forEach((owner) => {
      const isApplicable =
        owner.tdsApplicable === 1 ||
        owner.tdsApplicable === "1" ||
        owner.tdsApplicable === true;
      if (!isApplicable) return;
      if (realOwnerIds.has(String(owner._id))) return;

      virtualForMonth.push({
        _id: null,
        dueMonth: `${monthName} ${yearFromEntry || ""}`.trim(),
        month: monthName,
        cycle: cycleDate || null,
        tdsAmount: Number(owner.tdsAmount || 0),
        isUtrEntry: false,
        paidAmount: 0,
        paidAt: null,
        landOwnerId: owner._id,
        landOwnerName: owner.name,
        utrNumber: "",
        date: null,
        isVirtual: true,
      });
    });

    return [...realForMonth, ...virtualForMonth];
  };

  const storedPendingMonthsUnfiltered = Array.isArray(media.pendingMonths)
    ? media.pendingMonths
    : [];
  const getPendingLedgerHistoryForMonth = (monthName, yearValue) => {
    const monthLabel = `${monthName} ${yearValue}`;
    const match = storedPendingMonthsUnfiltered.find(
      (pm) => pm.month === monthLabel,
    );
    if (!match) return [];
    return (match.owners || [])
      .filter((owner) => belongsToMatchingOwner(owner.landOwnerId))
      .map((owner) => ({ ...owner, month: match.month, cycle: match.cycle }));
  };

  const getRequiredModes = (paymentCategory) => {
    if (paymentCategory === 1) return ["Cash"];
    if (paymentCategory === 2) return ["Online"];
    if (paymentCategory === 3) return ["Cash", "Online"];
    return ["Cash"];
  };

  const getRequiredModesForOwner = (paymentCategory) => {
    if (paymentCategory === 1) return ["Cash"];
    if (paymentCategory === 2) return ["Online"];
    if (paymentCategory === 3) return ["Cash", "Online"];
    return ["Cash"];
  };

    const isGstApplicableForOwner = (owner) => {
    const gstFlag = Number(media.gstApplicableFlag || 0);
    if (gstFlag === 1) {
      return Number(media.rentalPayment?.gstApplicable || 0) === 1;
    }
    return Number(owner.gstApplicable || 0) === 1;
  };
const computeOwnerModeAmount = (owner, mode, matchedDue, effectiveWithGst, paymentCategory) => {
  let baseAmount;
  if (Number(paymentCategory) === 3) {
    baseAmount =
      mode === "Cash"
        ? Number(matchedDue?.cashAmount ?? owner.cashAmount ?? 0)
        : Number(matchedDue?.onlineAmount ?? owner.onlineAmount ?? 0);
  } else {
    // paymentCategory 1 or 2 — single combined share value
    baseAmount = Number(matchedDue?.shareAmount ?? owner.shareAmount ?? 0);
  }

  if (Number(effectiveWithGst) !== 2) {
    return baseAmount;
  }

  const gstFlag = Number(media.gstApplicableFlag || 0);
  let ownerGst = 0;
  if (gstFlag === 1) {
    const ownerCount = matchingLandOwners.length || 1;
    ownerGst = Number(media.rentalPayment?.gstAmount || 0) / ownerCount;
  } else {
    ownerGst = Number(owner.gstAmount || 0);
  }
  return baseAmount + ownerGst;
};
  const buildModeSplitLedger = (
    realEntries,
    withGstValue,
    monthLabel,
    cycleDate,
  ) => {
    const result = [];

    matchingLandOwners.forEach((owner) => {
      const paymentCategory = Number(owner.paymentCategory || 1);
      const requiredModes = getRequiredModesForOwner(paymentCategory);

      requiredModes.forEach((mode) => {
        const realEntry = realEntries.find(
          (e) =>
            String(e.landOwnerId) === String(owner._id) &&
            e.paymentMode === mode,
        );

         if (realEntry) {
          // ✅ NEW — same cashAmount/onlineAmount source as the virtual
          // (unpaid) branch below, so real entries match that shape.
          const matchedDue = (media.rentalDue || []).find(
            (d) => String(d._id) === String(realEntry.rentalDueId),
          );
          const realWithGst = isGstApplicableForOwner(owner) ? withGstValue : 0;

          // ✅ ADDED — do not return amount:0 when the corresponding
          // rental amount is available. Only recompute a fallback
          // amount when the real saved entry genuinely has no amount
          // recorded — a real entry's OWN saved amount always takes
          // priority when present (never overridden).
           const resolvedRealAmount =
            realEntry.amount && Number(realEntry.amount) > 0
              ? Number(realEntry.amount)
              : computeOwnerModeAmount(owner, mode, matchedDue, realWithGst, paymentCategory);
   const isSplitCategory = Number(paymentCategory) === 3;
          const resolvedCashAmount =
            isSplitCategory && mode === "Cash"
              ? Number(matchedDue?.cashAmount ?? owner.cashAmount ?? 0)
              : 0;
          const resolvedOnlineAmount =
            isSplitCategory && mode === "Online"
              ? Number(matchedDue?.onlineAmount ?? owner.onlineAmount ?? 0)
              : 0;
          const resolvedShareAmount = isSplitCategory
            ? 0
            : Number(matchedDue?.shareAmount ?? owner.shareAmount ?? 0);
          result.push({
            landOwnerId: realEntry.landOwnerId,
            landOwnerName: realEntry.landOwnerName,
            paymentCategory,
            paymentMode: realEntry.paymentMode,
            utrNumber: realEntry.utrNumber,
            date: realEntry.date,
            status: realEntry.status,
           withGst: realWithGst,
            month: realEntry.month,
            cycle: realEntry.cycle,
            rentalDueId: realEntry.rentalDueId,
            index: realEntry.index,
            updatedBy: realEntry.updatedBy,
            updatedAt: realEntry.updatedAt,
            _id: realEntry._id,
            mediaName: media.mediaName,
            paymentFrequency: realEntry.paymentFrequency,
            netPayable: realEntry.netPayable,
            lastBillPaidDate: realEntry.lastBillPaidDate,
            nextBillingDate: realEntry.nextBillingDate,
            // amount: resolvedRealAmount,
            paymentCategory,
            cashAmount: resolvedCashAmount, // ✅ CHANGED — always a number now
            onlineAmount: resolvedOnlineAmount, // ✅ CHANGED — always a number now
            shareAmount: resolvedShareAmount, // ✅ ADDED
            isVirtual: false,
          });
        } else {
              const fullMonthLabelForGstMatch = `${monthLabel} ${cycleDate.getUTCFullYear()}`;
          const matchedGstBalanceRow = (fullGstBalanceHistory || []).find(
            (g) =>
              g.dueMonth === fullMonthLabelForGstMatch &&
              (!g.ownerId || String(g.ownerId) === String(owner._id)),
          );

          const isSplitCategoryVirtual = Number(paymentCategory) === 3;

          // ✅ ADDED — second tier: no gstBalanceHistory HOLD exists,
          // but GST may still genuinely be applicable to this owner
          // (added directly into the payment, withGst: 2), instead of
          // silently defaulting to 0. Reuses the same
          // gstApplicableFlag-driven resolution as computeOwnerModeAmount.
          let directGstAmount = 0;
          if (!matchedGstBalanceRow) {
            const gstFlag = Number(media.gstApplicableFlag || 0);
            if (gstFlag === 1 && Number(media.rentalPayment?.gstApplicable) === 1) {
              const ownerCount = matchingLandOwners.length || 1;
              directGstAmount = Number(media.rentalPayment?.gstAmount || 0) / ownerCount;
            } else if (Number(owner.gstApplicable) === 1) {
              directGstAmount = Number(owner.gstAmount || 0);
            }
          }

          // ✅ withGst: 1 = held (real gstBalanceHistory row), 2 = GST
          // applicable and added directly, 0 = not applicable at all.
          // For category 3, direct GST (withGst:2) only ever attaches
          // to the ONLINE row — the Cash row stays GST-free.
         const virtualWithGst = matchedGstBalanceRow
            ? 1
            : directGstAmount > 0
              ? 2
              : 0;

          // ✅ this gate is now ONLY used to decide which row's AMOUNT
          // gets the GST money added — unchanged from before.
          const appliesDirectGstToThisRow =
            directGstAmount > 0 && (!isSplitCategoryVirtual || mode === "Online");

          const matchedDueForVirtual = (media.rentalDue || []).find(
            (d) => d.dueMonth === monthLabel,
          );

          const baseAmountVirtual = computeOwnerModeAmount(
            owner,
            mode,
            matchedDueForVirtual,
            0,
            paymentCategory,
          );

          let resolvedVirtualAmount = baseAmountVirtual;
          if (matchedGstBalanceRow) {
            resolvedVirtualAmount = baseAmountVirtual + Number(matchedGstBalanceRow.gstAmount || 0);
          } else if (appliesDirectGstToThisRow) {
            resolvedVirtualAmount = baseAmountVirtual + directGstAmount;
          }

          const resolvedCashAmountVirtual =
            isSplitCategoryVirtual && mode === "Cash"
              ? Number(matchedDueForVirtual?.cashAmount ?? owner.cashAmount ?? 0)
              : 0;
          // ✅ CHANGED — Online amount now includes the direct GST
          // addition (category 3 case) when applicable.
          const resolvedOnlineAmountVirtual =
            isSplitCategoryVirtual && mode === "Online"
              ? Number(matchedDueForVirtual?.onlineAmount ?? owner.onlineAmount ?? 0) +
                (appliesDirectGstToThisRow ? directGstAmount : 0)
              : 0;
          // ✅ CHANGED — shareAmount now includes the direct GST
          // addition (category 1/2 case) when applicable.
          const resolvedShareAmountVirtual = isSplitCategoryVirtual
            ? 0
            : Number(matchedDueForVirtual?.shareAmount ?? owner.shareAmount ?? 0) +
              (appliesDirectGstToThisRow ? directGstAmount : 0);

          result.push({
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            paymentCategory,
            paymentMode: mode,
            utrNumber: "",
            date: null,
            status: 0,
            withGst: virtualWithGst,
            month: monthLabel,
            cycle: cycleDate,
            rentalDueId: null,
            index: null,
            updatedBy: "",
            updatedAt: null,
            amount: resolvedVirtualAmount,
            cashAmount: resolvedCashAmountVirtual,
            onlineAmount: resolvedOnlineAmountVirtual,
            shareAmount: resolvedShareAmountVirtual,
            isVirtual: true,
          });
        }
      });
    });
    return result;
  };

  const MONTH_NAMES_LOCAL = MONTH_NAMES;

  let transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
    ...yearEntry,
    months: yearEntry.months.map((monthEntry) => {
      const allEntries = monthEntry.entries || [];

      const withGst2Entries = allEntries.filter((entry) => entry.withGst === 2);
      const withGst1Entries = allEntries.filter((entry) => entry.withGst === 1);

      const sortByUpdatedAt = (entries) =>
        [...entries].sort(
          (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
        );

      const latestGst2 = dedupeByKey(withGst2Entries, gst2Key);
      const latestGst1 = dedupeByKey(withGst1Entries, gst1Key);
      const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(
        monthEntry.month,
      );

      const monthIndex = MONTH_NAMES_LOCAL.findIndex(
        (m) => m.toLowerCase() === monthEntry.month.toLowerCase(),
      );

      const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate
        ? new Date(media.rentalPayment.lastBillPaidDate)
        : null;

      const cycleDateForMonth =
        lastBillPaidDate &&
        String(lastBillPaidDate.getUTCFullYear()) === yearEntry.year &&
        lastBillPaidDate.getUTCMonth() === monthIndex
          ? lastBillPaidDate
          : new Date(Date.UTC(Number(yearEntry.year), monthIndex, 1));

      const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
        monthEntry.month,
        yearEntry.year,
        cycleDateForMonth,
      );
      const pendingLedgerHistory = getPendingLedgerHistoryForMonth(
        monthEntry.month,
        yearEntry.year,
      );
      const ledgerFinal = buildModeSplitLedger(
        latestGst2,
        2,
        monthEntry.month,
        cycleDateForMonth,
      );

      const realWithGst1Mapped = latestGst1.map((entry) => {
        const gstDetails = getGstBalanceDetails(
          entry.landOwnerId,
          entry.month || monthEntry.month,
          entry.rentalDueId,
          entry.date || entry.createdAt,
        );
        return {
          landOwnerId: entry.landOwnerId,
          landOwnerName: entry.landOwnerName,
          utrNumber: entry.utrNumber,
          date: entry.date,
          status: entry.status,
          withGst: entry.withGst,
          month: entry.month || monthEntry.month,
          cycle: entry.cycle,
          rentalDueId: entry.rentalDueId,
          index: entry.index,
          updatedBy: entry.updatedBy,
          updatedAt: entry.updatedAt,
          _id: entry._id,
          mediaName: media.mediaName,
          paymentFrequency: entry.paymentFrequency,
          netPayable: entry.netPayable,
          lastBillPaidDate: entry.lastBillPaidDate,
          nextBillingDate: entry.nextBillingDate,
          isPaid: gstDetails.isPaid,
          gstAmount: gstDetails.gstAmount,
          amount: entry.amount,
          isVirtual: false,
        };
      });

      const withGst1OwnerIds = new Set(
        realWithGst1Mapped
          .filter((e) => e.landOwnerId)
          .map((e) => String(e.landOwnerId)),
      );

      const virtualWithGst1Entries = matchingLandOwners
        .filter((owner) => !withGst1OwnerIds.has(String(owner._id)))
        .map((owner) => ({
          landOwnerId: owner._id,
          landOwnerName: owner.name,
          utrNumber: "",
          date: null,
          status: 0,
          withGst: 1,
          month: monthEntry.month,
          cycle: cycleDateForMonth,
          rentalDueId: null,
          index: null,
          updatedBy: "",
          updatedAt: null,
          isPaid: false,
          gstAmount: 0,
          amount: 0,
          isVirtual: true,
        }));

      const withGst1Final = [...realWithGst1Mapped, ...virtualWithGst1Entries];

      return {
        month: monthEntry.month,
        ledger: ledgerFinal,
        withGst1Ledger: withGst1Final,
        allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
          ...entry,
          mediaName: media.mediaName,
        })),
        gstBalanceHistory: gstBalanceHistoryForMonth,
        tdsBalanceHistory: tdsBalanceHistoryForMonth,
        pendingLedgerHistory,
        isSyntheticMonth: false,
      };
    }),
  }));

  const existingBucketKeys = new Set();
  transformedLedgerHistory.forEach((yearEntry) => {
    (yearEntry.months || []).forEach((monthEntry) => {
      existingBucketKeys.add(
        `${yearEntry.year}-${monthEntry.month.toLowerCase()}`,
      );
    });
  });

  const storedPendingMonthsForBuckets = ownerMasterIdFilter
    ? storedPendingMonthsUnfiltered
        .map((pm) => ({
          ...pm,
          owners: (pm.owners || []).filter((o) =>
            belongsToMatchingOwner(o.landOwnerId),
          ),
        }))
        .filter((pm) => pm.owners.length > 0)
    : storedPendingMonthsUnfiltered;

  storedPendingMonthsForBuckets.forEach((pendingMonthEntry) => {
    const parts = pendingMonthEntry.month.trim().split(/\s+/);
    const pendingMonthName = parts[0];
    const pendingYear = parts[1];
    if (!pendingMonthName || !pendingYear) return;

    // ✅ NEW — respect the requested year/month filter. Without this, every
    // pending month gets injected regardless of what was filtered, which is
    // exactly why "2027-09" was showing June/July/August 2026 instead of
    // empty/synthetic-September-2027.
    if (year && String(pendingYear).trim() !== String(year).trim()) return;
    if (month) {
      const requestedMonthName = MONTH_NAMES[Number(month) - 1];
      if (
        !requestedMonthName ||
        pendingMonthName.toLowerCase() !== requestedMonthName.toLowerCase()
      )
        return;
    }

    const bucketKey = `${pendingYear}-${pendingMonthName.toLowerCase()}`;
    if (existingBucketKeys.has(bucketKey)) return;

    const cycleDate = pendingMonthEntry.cycle
      ? new Date(pendingMonthEntry.cycle)
      : new Date(
          Date.UTC(
            Number(pendingYear),
            MONTH_NAMES_LOCAL.findIndex(
              (m) => m.toLowerCase() === pendingMonthName.toLowerCase(),
            ),
            1,
          ),
        );

    const gstBalanceHistoryForMonth =
      getGstBalanceHistoryForMonth(pendingMonthName);
    const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
      pendingMonthName,
      pendingYear,
      cycleDate,
    );
    const ledgerFinal = buildModeSplitLedger(
      [],
      2,
      pendingMonthName,
      cycleDate,
    );

    const withGst1Final = matchingLandOwners.map((owner) => ({
      landOwnerId: owner._id,
      landOwnerName: owner.name,
      utrNumber: "",
      date: null,
      status: 0,
      withGst: 1,
      month: pendingMonthName,
      cycle: cycleDate,
      rentalDueId: null,
      index: null,
      updatedBy: "",
      updatedAt: null,
      isPaid: false,
      gstAmount: 0,
      isVirtual: true,
    }));

    const syntheticMonthBucket = {
      month: pendingMonthName,
      ledger: ledgerFinal,
      withGst1Ledger: withGst1Final,
      allEntries: [],
      gstBalanceHistory: gstBalanceHistoryForMonth,
      tdsBalanceHistory: tdsBalanceHistoryForMonth,
      pendingLedgerHistory: (pendingMonthEntry.owners || []).map((owner) => ({
        ...owner,
        month: pendingMonthEntry.month,
        cycle: pendingMonthEntry.cycle,
      })),
      isSyntheticMonth: true,
    };

 let yearEntry = transformedLedgerHistory.find(
      (y) => y.year === pendingYear,
    );
    if (!yearEntry) {
      yearEntry = { year: pendingYear, months: [] };
      transformedLedgerHistory.push(yearEntry);
    }
    yearEntry.months.push(syntheticMonthBucket);
    existingBucketKeys.add(bucketKey);
  });

  // ✅ NEW — same auto-cycle-walking engine the List API's ledger[]
  // builder uses. Ensures EVERY elapsed billing cycle (not just months
  // that already have a real ledgerHistory bucket) shows up here too —
  // e.g. August, even though only July has a real saved payment.
    const hasExplicitRangeFilter = !!(rangeStart || rangeEnd);

  // {
  //   const autoCyclesForHistory = getAllDueCycles(media, effectiveMonthYear);
  //   autoCyclesForHistory.forEach((cycleDate) => {
  //     const cycleYM = {
  //       year: cycleDate.getUTCFullYear(),
  //       month: cycleDate.getUTCMonth() + 1,
  //     };
  //     if (!isYMInRange(cycleYM, rangeStart, rangeEnd)) return;
  //     if (effectiveYear && cycleYM.year !== Number(effectiveYear)) return;

  //     const cycleYear = String(cycleDate.getUTCFullYear());
  //     const cycleMonthName = MONTH_NAMES_LOCAL[cycleDate.getUTCMonth()];
  //     const bucketKey = `${cycleYear}-${cycleMonthName.toLowerCase()}`;
  //     if (existingBucketKeys.has(bucketKey)) return;

  //     const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(cycleMonthName);
  //     const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(cycleMonthName, cycleYear, cycleDate);
  //     const ledgerFinal = buildModeSplitLedger([], 2, cycleMonthName, cycleDate);

  //     const withGst1Final = matchingLandOwners.map((owner) => ({
  //       landOwnerId: owner._id,
  //       landOwnerName: owner.name,
  //       utrNumber: "",
  //       date: null,
  //       status: 0,
  //       withGst: 1,
  //       month: cycleMonthName,
  //       cycle: cycleDate,
  //       rentalDueId: null,
  //       index: null,
  //       updatedBy: "",
  //       updatedAt: null,
  //       isPaid: false,
  //       gstAmount: 0,
  //       isVirtual: true,
  //     }));

  //     const syntheticCycleBucket = {
  //       month: cycleMonthName,
  //       ledger: ledgerFinal,
  //       withGst1Ledger: withGst1Final,
  //       allEntries: [],
  //       gstBalanceHistory: gstBalanceHistoryForMonth,
  //       tdsBalanceHistory: tdsBalanceHistoryForMonth,
  //       pendingLedgerHistory: [],
  //       isSyntheticMonth: true,
  //     };

  //     let cycleYearEntry = transformedLedgerHistory.find((y) => y.year === cycleYear);
  //     if (!cycleYearEntry) {
  //       cycleYearEntry = { year: cycleYear, months: [] };
  //       transformedLedgerHistory.push(cycleYearEntry);
  //     }
  //     cycleYearEntry.months.push(syntheticCycleBucket);
  //     existingBucketKeys.add(bucketKey);
  //   });
  // }

  transformedLedgerHistory.sort((a, b) => Number(a.year) - Number(b.year));
  transformedLedgerHistory.forEach((yearEntry) => {
    yearEntry.months.sort((a, b) => {
      const idxA = MONTH_NAMES_LOCAL.findIndex(
        (m) => m.toLowerCase() === a.month.toLowerCase(),
      );
      const idxB = MONTH_NAMES_LOCAL.findIndex(
        (m) => m.toLowerCase() === b.month.toLowerCase(),
      );
      return idxA - idxB;
    });
  });

  // if (transformedLedgerHistory.length === 0) {
  //   // ✅ CHANGED — if the person EXPLICITLY requested a specific year/month
  //   // and nothing was found for it, return genuinely empty (no fabricated
  //   // virtual placeholder entries). The synthetic "today's month" fallback
  //   // below is ONLY for when no year/month filter was given at all.
  //   if (hasExplicitRangeFilter  || year) {
  //     transformedLedgerHistory = [];
  //   } else {
  //     const targetYear = String(new Date().getUTCFullYear());
  //     const targetMonthName = (() => {
  //       const fallbackCycle =
  //         media.rentalPayment?.lastBillPaidDate ||
  //         media.rentalPayment?.nextBillingDate ||
  //         new Date();
  //       return MONTH_NAMES_LOCAL[new Date(fallbackCycle).getUTCMonth()];
  //     })();

  //     const fallbackCycle =
  //       media.rentalPayment?.lastBillPaidDate ||
  //       media.rentalPayment?.nextBillingDate ||
  //       new Date();
  //     const d = new Date(fallbackCycle);

  //     const gstBalanceHistoryForMonth =
  //       getGstBalanceHistoryForMonth(targetMonthName);
  //     const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
  //       targetMonthName,
  //       targetYear,
  //       d,
  //     );
  //     const ledgerFinal = buildModeSplitLedger([], 2, targetMonthName, d);

  //     const withGst1Final = matchingLandOwners.map((owner) => ({
  //       landOwnerId: owner._id,
  //       landOwnerName: owner.name,
  //       utrNumber: "",
  //       date: null,
  //       status: 0,
  //       withGst: 1,
  //       month: targetMonthName,
  //       cycle: d,
  //       rentalDueId: null,
  //       index: null,
  //       updatedBy: "",
  //       updatedAt: null,
  //       isPaid: false,
  //       gstAmount: 0,
  //       isVirtual: true,
  //     }));

  //     const pendingLedgerHistory = getPendingLedgerHistoryForMonth(
  //       targetMonthName,
  //       targetYear,
  //     );

  //     transformedLedgerHistory = [
  //       {
  //         year: targetYear,
  //         months: [
  //           {
  //             month: targetMonthName,
  //             ledger: ledgerFinal,
  //             withGst1Ledger: withGst1Final,
  //             allEntries: [],
  //             gstBalanceHistory: gstBalanceHistoryForMonth,
  //             tdsBalanceHistory: tdsBalanceHistoryForMonth,
  //             pendingLedgerHistory,
  //             isSyntheticMonth: true,
  //           },
  //         ],
  //       },
  //     ];
  //   }
  // }
 if (transformedLedgerHistory.length === 0) {
    transformedLedgerHistory = [];
  }
  const rentalDueEntries = Array.isArray(media.rentalDue)
    ? [
        ...new Set(
          media.rentalDue
            .map((entry) =>
              entry.withGst === null || entry.withGst === undefined
                ? Number(media.rentalPayment?.gstApplicable || 0) === 1
                  ? undefined
                  : "not_applicable"
                : [1, 2].includes(Number(entry.withGst))
                  ? Number(entry.withGst)
                  : undefined,
            )
            .filter((v) => v !== undefined),
        ),
      ].map((withGst) => ({
        withGst: withGst === "not_applicable" ? null : withGst,
      }))
    : [];

  // ✅ currentMonth removed — outstanding/currentBillDate now always
  // reflect the site's actual live cycle ("now"), not a requested month
const outstanding = computeOutstandingSummary(media, effectiveMonthYear);
  const currentBillDate = getCurrentBillDate(media, effectiveMonthYear);

  return {
    mediaId: media._id,
    mediaName: media.mediaName,
    mediaType: media.mediaType,
    mediaCode: media.mediaCode,
    city: media.city,
    rentalPayment: media.rentalPayment,
    landOwners: matchingLandOwners,
    agreement: media.agreement,
    currentRentalPayment: {
      paymentFrequency: media.rentalPayment.paymentFrequency,
      netPayable: media.rentalPayment.netPayable,
      lastBillPaidDate: media.rentalPayment.lastBillPaidDate,
      nextBillingDate: media.rentalPayment.nextBillingDate,
    },
    ledgerHistory: transformedLedgerHistory,
    rentalDueEntries,
    gstPayment,
    tdsPayment,
    outstanding,
    lastBillDate: formatDate(media.rentalPayment?.lastBillPaidDate),
    nextBillingDate: formatDate(media.rentalPayment?.nextBillingDate),
    currentBillDate: currentBillDate ? formatDate(currentBillDate) : "",
    outStantStatus:
      media.rentalPayment?.outStantStatus ??
      (outstanding.totalOutstandingAmount > 0 ? 1 : 0),
    gstOutstandingHistory: media.rentalPayment?.gstOutstandingHistory || [],
    rentalOutstandingHistory:
      media.rentalPayment?.rentalOutstandingHistory || [],
  };
}
exports.computeOutstandingSummary = computeOutstandingSummary;