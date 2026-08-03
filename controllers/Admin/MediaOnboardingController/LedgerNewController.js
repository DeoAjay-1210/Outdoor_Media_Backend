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
function getCurrentBillDate(media, requestedMonthYear) {
  const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate;
  if (!lastBillPaidDate) return "";
  const d = new Date(lastBillPaidDate);
  if (Number.isNaN(d.getTime())) return "";

  let refMonth, refYear;
  if (requestedMonthYear) {
    refMonth = requestedMonthYear.month - 1;
    refYear = requestedMonthYear.year;
  } else {
    const now = new Date();
    refMonth = now.getMonth();
    refYear = now.getFullYear();
  }

  const matches =
    d.getUTCMonth() === refMonth && d.getUTCFullYear() === refYear;
  return matches ? lastBillPaidDate : "";
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

/**
 * Sum of unpaid GST rows in gstBalanceHistory whose dueMonth is NOT the
 * site's current live cycle month (post-onboarding "hold" debt that rolled
 * forward from a previous, already-closed cycle).
 */
// function sumUnpaidPastCycleGst(media) {
//   const liveCycleDate = media.rentalPayment?.nextBillingDate;
//   if (!liveCycleDate) return 0;
//   const liveDate = new Date(liveCycleDate);
//   const liveKey = `${liveDate.getUTCFullYear()}-${liveDate.getUTCMonth()}`;

//   return (media.gstBalanceHistory || []).reduce((sum, row) => {
//     if (row.isPaid) return sum;
//     const parsed = parseDueMonthLabel(row.dueMonth);
//     if (!parsed) return sum;
//     const rowKey = `${parsed.year}-${parsed.monthIdx}`;
//     if (rowKey === liveKey) return sum; // current cycle — not "past"
//     return sum + Number(row.gstAmount || 0);
//   }, 0);
// }

/**
 * Current cycle GST due — unpaid gstBalanceHistory rows tagged to the
 * site's live cycle month.
 */
// function getCurrentGstDue(media) {
//   const liveCycleDate = media.rentalPayment?.nextBillingDate;
//   if (!liveCycleDate) return 0;
//   const liveDate = new Date(liveCycleDate);
//   const liveKey = `${liveDate.getUTCFullYear()}-${liveDate.getUTCMonth()}`;

//   return (media.gstBalanceHistory || []).reduce((sum, row) => {
//     if (row.isPaid) return sum;
//     const parsed = parseDueMonthLabel(row.dueMonth);
//     if (!parsed) return sum;
//     const rowKey = `${parsed.year}-${parsed.monthIdx}`;
//     if (rowKey !== liveKey) return sum;
//     return sum + Number(row.gstAmount || 0);
//   }, 0);
// }

/**
 * Current cycle base rent due. Uses the SAME signal your original
 * recomputePendingMonths/advanceRentalPaymentOnOwnerApproval logic relies
 * on: media.ledger holds the LIVE cycle's rental entries and is wiped on
 * cycle advance. If it has at least one status:1 entry, treat current rent
 * as settled for this simplified summary figure.
 */
function getCurrentBaseRent(media) {
  const netPayable = Number(media.rentalPayment?.totalRentalAmount || 0);
  const liveLedger = media.ledger || [];
  const anyPaidThisCycle = liveLedger.some((e) => e.status === 1);
  return anyPaidThisCycle ? 0 : netPayable;
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
    const isBeforeLive = parsed.year < liveYr || (parsed.year === liveYr && parsed.monthIdx < liveMonthIdx);
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

function computeOutstandingSummary(media, requestedMonthYear) {
  const currentBaseRent = getCurrentBaseRent(media);
  const currentGSTDue = getCurrentGstDue(media, requestedMonthYear);
  const previousBaseRentDue = sumUnpaidRentalOutstanding(media);
  const previousGSTDue = sumUnpaidPastCycleGst(media, requestedMonthYear) + sumUnpaidGstOutstanding(media);

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

/* ═══════════════════════════════════════════════════════════════════════
 * createLedgerEntry — ORIGINAL entries[] flow kept 100% AS-IS below.
 * NEW: an optional `outstandingEntries[]` array is processed afterward for
 * the pastCycle/outstanding flows. Nothing in the original entries[]
 * handling is modified.
 * ═══════════════════════════════════════════════════════════════════════*/
exports.createLedgerEntry = async (req, res) => {
  try {
  const { mediaId } = req.body;
    let { entries, outstandingEntries } = req.body;
 const { entryType, targetType, landOwnerId, rentalDueId, paymentMode, utrNumber, date, paymentSplits } = req.body;
    if (entryType && targetType && !entries && !outstandingEntries) {
      if (entryType === "rental" && targetType === "current") {
        entries = [{
          landOwnerId, rentalDueId, paymentMode, utrNumber, date,
          withGst: 2,
        }];
      } else if (entryType === "gst" && targetType === "current") {
        entries = [{
          landOwnerId, rentalDueId, paymentMode, utrNumber, date,
          withGst: 1,
        }];
      } else {
        // pastCycle / outstanding (gst or rental) — route through outstandingEntries[]
        outstandingEntries = [{
          entryType, targetType, landOwnerId, paymentMode, utrNumber, date, paymentSplits,
          gstBalanceHistoryId: req.body.gstBalanceHistoryId,
          gstOutstandingId: req.body.gstOutstandingId,
          rentalOutstandingId: req.body.rentalOutstandingId,
        }];
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
    media.landOwners.find((o) => String(o.landOwnerMasterId) === String(item.landOwnerId));
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
    media.landOwners.find((o) => String(o.landOwnerMasterId) === String(item.landOwnerId))
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
 * listMediaByLedger — ORIGINAL logic kept AS-IS. NEW: landOwnerMasterId[]
 * filter, mediaId[] filter, and outstanding/currentBillDate/outstanding
 * history fields appended to each list item.
 * ═══════════════════════════════════════════════════════════════════════*/
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
    filter.rentalStatus = 3;
    if (search) {
      filter.$or = [
        { mediaName: { $regex: search, $options: "i" } },
        { mediaCode: { $regex: search, $options: "i" } },
      ];
    }

    // ✅ NEW — mediaId[] filter
    if (Array.isArray(mediaId) && mediaId.length > 0) {
  const validMediaIds = mediaId.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (validMediaIds.length !== mediaId.length) {
    return errorResponse(res, "mediaId array contains an invalid ObjectId", null, 400);
  }
  filter._id = { $in: validMediaIds.map((id) => new mongoose.Types.ObjectId(id)) };
}

if (Array.isArray(landOwnerMasterId) && landOwnerMasterId.length > 0) {
  const validOwnerIds = landOwnerMasterId.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (validOwnerIds.length !== landOwnerMasterId.length) {
    return errorResponse(res, "landOwnerMasterId array contains an invalid ObjectId", null, 400);
  }
  filter["landOwners.landOwnerMasterId"] = { $in: validOwnerIds.map((id) => new mongoose.Types.ObjectId(id)) };
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
              "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue pendingMonths createdAt updatedAt",
            )
            .sort({ updatedAt: -1 })
        : Media.find(filter)
            .select(
              "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue pendingMonths createdAt updatedAt",
            )
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(pageSize),
      Media.countDocuments(filter),
      Media.find(baseFilterForOverallCounts).select(
        "rentalPayment ledgerHistory landOwners rentalDue gstBalanceHistory tdsBalanceHistory",
      ),
    ]);

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
        mediaObj.rentalPayment?.nextBillingDate ||
        mediaObj.rentalPayment?.lastBillPaidDate;

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
          .map((due) => ({
            _id: due._id,
            ownerApprovalDate: due.ownerApprovalDate,
            dueMonth: due.dueMonth,
            dueDate: due.dueDate,
            netPayable: due.netPayable,
            approvalStatus: due.approvalStatus,
            withGst: due.withGst,
            gstAmount: due.gstAmount,
            baseAmount: due.baseAmount,
            paymentFrequency: due.paymentFrequency,
            campaignName: due.campaignName,
            status: due.status,
            updatedAt: due.updatedAt,
            createdAt: due.createdAt,
          }));
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
      const outstanding = computeOutstandingSummary(mediaObj, requestedMonthYearParsed);
      const currentBillDateForMedia = getCurrentBillDate(
        mediaObj,
        requestedMonthYearParsed,
      );

      return {
        ...restOfMediaObj,
        ledger: latestLedger,
        withGst1Ledger: withGst1Ledger,
        pendingMonths,
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

    if (
      requestedMonthRange &&
      !isPendingFilter &&
      !isGstPendingFilter &&
      !isTdsPendingFilter
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
        const s = computeOutstandingSummary(obj);
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
// exports.getLedgerHistory = async (req, res) => {
//   try {
//     const { mediaId, year, month, currentMonth } = req.query; // ✅ NEW: currentMonth query param

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     const media = await Media.findById(mediaId)
//       .select(
//         "mediaName city mediaType mediaCode rentalPayment rentalDueHistory ledgerHistory landOwners agreement gstBalanceHistory tdsBalanceHistory rentalDue pendingMonths",
//       )
//       .lean();

//     if (!media) {
//       return errorResponse(res, "Media not found for given mediaId", null, 404);
//     }

//     const mergeLedgerSources = (sourceA, sourceB) => {
//       const yearMap = new Map();

//       const addYearEntry = (yearEntry) => {
//         if (!yearEntry || !yearEntry.year) return;
//         if (!yearMap.has(yearEntry.year)) {
//           yearMap.set(yearEntry.year, new Map());
//         }
//         const monthMap = yearMap.get(yearEntry.year);

//         (yearEntry.months || []).forEach((monthEntry) => {
//           if (!monthEntry || !monthEntry.month) return;
//           const key = monthEntry.month.toLowerCase();

//           if (!monthMap.has(key)) {
//             monthMap.set(key, {
//               month: monthEntry.month,
//               entries: [...(monthEntry.entries || [])],
//             });
//           } else {
//             monthMap.get(key).entries.push(...(monthEntry.entries || []));
//           }
//         });
//       };

//       (sourceA || []).forEach(addYearEntry);
//       (sourceB || []).forEach(addYearEntry);

//       return Array.from(yearMap.entries()).map(([yr, monthMap]) => ({
//         year: yr,
//         months: Array.from(monthMap.values()),
//       }));
//     };

//     let ledgerHistory = mergeLedgerSources(
//       media.rentalDueHistory,
//       media.ledgerHistory,
//     );

//     if (year) {
//       ledgerHistory = ledgerHistory.filter(
//         (item) => item.year === String(year),
//       );
//     }

//     if (month) {
//       const monthNames = [
//         "January",
//         "February",
//         "March",
//         "April",
//         "May",
//         "June",
//         "July",
//         "August",
//         "September",
//         "October",
//         "November",
//         "December",
//       ];
//       const monthName = monthNames[Number(month) - 1];

//       ledgerHistory = ledgerHistory
//         .map((item) => ({
//           ...item,
//           months: item.months.filter(
//             (m) => m.month.toLowerCase() === monthName.toLowerCase(),
//           ),
//         }))
//         .filter((item) => item.months.length > 0);
//     }

//     // ✅ NEW — dedupe fix applied before any downstream computation uses it
//     const fullGstBalanceHistory = dedupeGstBalanceHistory(
//       Array.isArray(media.gstBalanceHistory) ? media.gstBalanceHistory : [],
//     );

//     let gstPayment = false;
//     if (fullGstBalanceHistory.length > 0) {
//       const hasEmptyUtr = fullGstBalanceHistory.some(
//         (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
//       );
//       gstPayment = hasEmptyUtr;
//     }

//     const fullTdsBalanceHistory = Array.isArray(media.tdsBalanceHistory)
//       ? media.tdsBalanceHistory
//       : [];
//     let tdsPayment = false;
//     if (fullTdsBalanceHistory.length > 0) {
//       const hasUnpaidTds = fullTdsBalanceHistory.some(
//         (entry) =>
//           entry.isUtrEntry === false ||
//           !entry.utrNumber ||
//           entry.utrNumber.trim() === "",
//       );
//       tdsPayment = hasUnpaidTds;
//     }

//     const dedupeByKey = (entries, getKey) => {
//       const withPos = entries.map((entry, pos) => ({ entry, pos }));
//       const sorted = withPos.sort(
//         (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
//       );
//       const seen = new Set();
//       const deduped = [];

//       for (const { entry, pos } of sorted) {
//         const key = getKey(entry, pos);
//         if (!seen.has(key)) {
//           seen.add(key);
//           deduped.push(entry);
//         }
//       }
//       return deduped;
//     };

//     const gst2Key = (entry, pos) =>
//       entry.index !== undefined && entry.index !== null
//         ? `idx_${entry.index}`
//         : entry._id
//           ? `id_${String(entry._id)}`
//           : `pos_${pos}`;

//     const gst1Key = (entry, pos) =>
//       entry.rentalDueId
//         ? `rd_${String(entry.rentalDueId)}`
//         : entry.landOwnerId
//           ? `owner_${String(entry.landOwnerId)}_${entry.month || ""}`
//           : entry._id
//             ? `id_${String(entry._id)}`
//             : `pos_${pos}`;

//     const getGstBalanceDetails = (
//       landOwnerId,
//       monthLabel,
//       rentalDueId,
//       entryDate,
//     ) => {
//       try {
//         if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) {
//           return { isPaid: false, gstAmount: 0 };
//         }
//         if (!landOwnerId) {
//           return { isPaid: false, gstAmount: 0 };
//         }

//         let gstEntry = null;

//         gstEntry = fullGstBalanceHistory.find(
//           (entry) =>
//             entry &&
//             String(entry.landOwnerId) === String(landOwnerId) &&
//             entry.month === monthLabel,
//         );

//         if (!gstEntry && rentalDueId) {
//           gstEntry = fullGstBalanceHistory.find(
//             (entry) =>
//               entry &&
//               entry.rentalDueId &&
//               String(entry.rentalDueId) === String(rentalDueId),
//           );
//         }

//         if (!gstEntry && entryDate) {
//           const entryDateObj = new Date(entryDate);
//           const entryMonth = entryDateObj.getMonth();
//           const entryYear = entryDateObj.getFullYear();

//           gstEntry = fullGstBalanceHistory.find(
//             (entry) =>
//               entry &&
//               entry.date &&
//               String(entry.landOwnerId) === String(landOwnerId) &&
//               new Date(entry.date).getMonth() === entryMonth &&
//               new Date(entry.date).getFullYear() === entryYear,
//           );
//         }

//         if (!gstEntry) {
//           const monthMatches = fullGstBalanceHistory.filter(
//             (entry) => entry && entry.month === monthLabel,
//           );
//           if (monthMatches.length === 1) {
//             gstEntry = monthMatches[0];
//           }
//         }

//         return {
//           isPaid: gstEntry ? gstEntry.isPaid || false : false,
//           gstAmount: gstEntry ? gstEntry.gstAmount || 0 : 0,
//         };
//       } catch (gstError) {
//         console.error("Error getting GST balance details:", gstError);
//         return { isPaid: false, gstAmount: 0 };
//       }
//     };

//     const getGstBalanceHistoryForMonth = (monthName) => {
//       if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) {
//         return [];
//       }
//       return fullGstBalanceHistory.filter((entry) => {
//         if (!entry || !entry.dueMonth) return false;
//         return entry.dueMonth.toLowerCase().includes(monthName.toLowerCase());
//       });
//     };

//     const getTdsBalanceHistoryForMonth = (
//       monthName,
//       yearFromEntry,
//       cycleDate,
//     ) => {
//       const realForMonth = (fullTdsBalanceHistory || []).filter((entry) => {
//         if (!entry) return false;
//         if (
//           entry.month &&
//           entry.month.toLowerCase() !== monthName.toLowerCase()
//         ) {
//           return false;
//         }
//         if (!entry.month && entry.dueMonth) {
//           const expectedDueMonth =
//             `${monthName} ${yearFromEntry}`.toLowerCase();
//           return entry.dueMonth.toLowerCase() === expectedDueMonth;
//         }
//         if (yearFromEntry && entry.dueMonth) {
//           return entry.dueMonth.toLowerCase().includes(String(yearFromEntry));
//         }
//         return !!entry.month;
//       });

//       const realOwnerIds = new Set(
//         realForMonth.map((t) => String(t.landOwnerId)),
//       );

//       const virtualForMonth = [];
//       (media.landOwners || []).forEach((owner) => {
//         const isApplicable =
//           owner.tdsApplicable === 1 ||
//           owner.tdsApplicable === "1" ||
//           owner.tdsApplicable === true;
//         if (!isApplicable) return;
//         if (realOwnerIds.has(String(owner._id))) return;

//         virtualForMonth.push({
//           _id: null,
//           dueMonth: `${monthName} ${yearFromEntry || ""}`.trim(),
//           month: monthName,
//           cycle: cycleDate || null,
//           tdsAmount: Number(owner.tdsAmount || 0),
//           isUtrEntry: false,
//           paidAmount: 0,
//           paidAt: null,
//           landOwnerId: owner._id,
//           landOwnerName: owner.name,
//           utrNumber: "",
//           date: null,
//           isVirtual: true,
//         });
//       });

//       return [...realForMonth, ...virtualForMonth];
//     };

//     const MONTH_NAMES_LOCAL = [
//       "January",
//       "February",
//       "March",
//       "April",
//       "May",
//       "June",
//       "July",
//       "August",
//       "September",
//       "October",
//       "November",
//       "December",
//     ];

//     const storedPendingMonths = Array.isArray(media.pendingMonths)
//       ? media.pendingMonths
//       : [];

//     const getPendingLedgerHistoryForMonth = (monthName, yearValue) => {
//       const monthLabel = `${monthName} ${yearValue}`;
//       const match = storedPendingMonths.find((pm) => pm.month === monthLabel);
//       if (!match) return [];
//       return (match.owners || []).map((owner) => ({
//         ...owner,
//         month: match.month,
//         cycle: match.cycle,
//       }));
//     };

//     const getRequiredModes = (paymentCategory) => {
//       if (paymentCategory === 1) return ["Cash"];
//       if (paymentCategory === 2) return ["Online"];
//       if (paymentCategory === 3) return ["Cash", "Online"];
//       return ["Cash"];
//     };

//     const buildModeSplitLedger = (
//       realEntries,
//       withGstValue,
//       monthLabel,
//       cycleDate,
//     ) => {
//       const result = [];

//       (media.landOwners || []).forEach((owner) => {
//         const paymentCategory = Number(owner.paymentCategory || 1);
//         const requiredModes = getRequiredModes(paymentCategory);

//         requiredModes.forEach((mode) => {
//           const realEntry = realEntries.find(
//             (e) =>
//               String(e.landOwnerId) === String(owner._id) &&
//               e.paymentMode === mode,
//           );

//           if (realEntry) {
//             result.push({
//               landOwnerId: realEntry.landOwnerId,
//               landOwnerName: realEntry.landOwnerName,
//               paymentCategory,
//               paymentMode: realEntry.paymentMode,
//               utrNumber: realEntry.utrNumber,
//               date: realEntry.date,
//               status: realEntry.status,
//               withGst: realEntry.withGst,
//               month: realEntry.month,
//               cycle: realEntry.cycle,
//               rentalDueId: realEntry.rentalDueId,
//               index: realEntry.index,
//               updatedBy: realEntry.updatedBy,
//               updatedAt: realEntry.updatedAt,
//               _id: realEntry._id,
//               mediaName: media.mediaName,
//               paymentFrequency: realEntry.paymentFrequency,
//               netPayable: realEntry.netPayable,
//               lastBillPaidDate: realEntry.lastBillPaidDate,
//               nextBillingDate: realEntry.nextBillingDate,
//               amount: realEntry.amount, // ✅ NEW field only
//               isVirtual: false,
//             });
//           } else {
//             result.push({
//               landOwnerId: owner._id,
//               landOwnerName: owner.name,
//               paymentCategory,
//               paymentMode: mode,
//               utrNumber: "",
//               date: null,
//               status: 0,
//               withGst: withGstValue,
//               month: monthLabel,
//               cycle: cycleDate,
//               rentalDueId: null,
//               index: null,
//               updatedBy: "",
//               updatedAt: null,
//               amount: 0, // ✅ NEW field only
//               isVirtual: true,
//             });
//           }
//         });
//       });

//       return result;
//     };

//     let transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
//       ...yearEntry,
//       months: yearEntry.months.map((monthEntry) => {
//         const allEntries = monthEntry.entries || [];

//         const withGst2Entries = allEntries.filter(
//           (entry) => entry.withGst === 2,
//         );
//         const withGst1Entries = allEntries.filter(
//           (entry) => entry.withGst === 1,
//         );

//         const sortByUpdatedAt = (entries) =>
//           [...entries].sort(
//             (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//           );

//         const latestGst2 = dedupeByKey(withGst2Entries, gst2Key);
//         const latestGst1 = dedupeByKey(withGst1Entries, gst1Key);
//         const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(
//           monthEntry.month,
//         );

//         const monthIndex = MONTH_NAMES_LOCAL.findIndex(
//           (m) => m.toLowerCase() === monthEntry.month.toLowerCase(),
//         );

//         const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate
//           ? new Date(media.rentalPayment.lastBillPaidDate)
//           : null;

//         const cycleDateForMonth =
//           lastBillPaidDate &&
//           String(lastBillPaidDate.getUTCFullYear()) === yearEntry.year &&
//           lastBillPaidDate.getUTCMonth() === monthIndex
//             ? lastBillPaidDate
//             : new Date(Date.UTC(Number(yearEntry.year), monthIndex, 1));

//         const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
//           monthEntry.month,
//           yearEntry.year,
//           cycleDateForMonth,
//         );

//         const pendingLedgerHistory = getPendingLedgerHistoryForMonth(
//           monthEntry.month,
//           yearEntry.year,
//         );

//         const ledgerFinal = buildModeSplitLedger(
//           latestGst2,
//           2,
//           monthEntry.month,
//           cycleDateForMonth,
//         );

//         const realWithGst1Mapped = latestGst1.map((entry) => {
//           const gstDetails = getGstBalanceDetails(
//             entry.landOwnerId,
//             entry.month || monthEntry.month,
//             entry.rentalDueId,
//             entry.date || entry.createdAt,
//           );

//           return {
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month || monthEntry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             index: entry.index,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             lastBillPaidDate: entry.lastBillPaidDate,
//             nextBillingDate: entry.nextBillingDate,
//             isPaid: gstDetails.isPaid,
//             gstAmount: gstDetails.gstAmount,
//             amount: entry.amount, // ✅ NEW field only
//             isVirtual: false,
//           };
//         });

//         const withGst1OwnerIds = new Set(
//           realWithGst1Mapped
//             .filter((e) => e.landOwnerId)
//             .map((e) => String(e.landOwnerId)),
//         );

//         const virtualWithGst1Entries = (media.landOwners || [])
//           .filter((owner) => !withGst1OwnerIds.has(String(owner._id)))
//           .map((owner) => ({
//             landOwnerId: owner._id,
//             landOwnerName: owner.name,
//             utrNumber: "",
//             date: null,
//             status: 0,
//             withGst: 1,
//             month: monthEntry.month,
//             cycle: cycleDateForMonth,
//             rentalDueId: null,
//             index: null,
//             updatedBy: "",
//             updatedAt: null,
//             isPaid: false,
//             gstAmount: 0,
//             amount: 0, // ✅ NEW field only
//             isVirtual: true,
//           }));

//         const withGst1Final = [
//           ...realWithGst1Mapped,
//           ...virtualWithGst1Entries,
//         ];

//         return {
//           month: monthEntry.month,
//           ledger: ledgerFinal,
//           withGst1Ledger: withGst1Final,
//           allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
//             ...entry,
//             mediaName: media.mediaName,
//           })),
//           gstBalanceHistory: gstBalanceHistoryForMonth,
//           tdsBalanceHistory: tdsBalanceHistoryForMonth,
//           pendingLedgerHistory,
//           isSyntheticMonth: false,
//         };
//       }),
//     }));

//     const existingBucketKeys = new Set();
//     transformedLedgerHistory.forEach((yearEntry) => {
//       (yearEntry.months || []).forEach((monthEntry) => {
//         existingBucketKeys.add(
//           `${yearEntry.year}-${monthEntry.month.toLowerCase()}`,
//         );
//       });
//     });

//     storedPendingMonths.forEach((pendingMonthEntry) => {
//       const parts = pendingMonthEntry.month.trim().split(/\s+/);
//       const pendingMonthName = parts[0];
//       const pendingYear = parts[1];
//       if (!pendingMonthName || !pendingYear) return;

//       const bucketKey = `${pendingYear}-${pendingMonthName.toLowerCase()}`;
//       if (existingBucketKeys.has(bucketKey)) return;

//       const cycleDate = pendingMonthEntry.cycle
//         ? new Date(pendingMonthEntry.cycle)
//         : new Date(
//             Date.UTC(
//               Number(pendingYear),
//               MONTH_NAMES_LOCAL.findIndex(
//                 (m) => m.toLowerCase() === pendingMonthName.toLowerCase(),
//               ),
//               1,
//             ),
//           );

//       const gstBalanceHistoryForMonth =
//         getGstBalanceHistoryForMonth(pendingMonthName);
//       const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
//         pendingMonthName,
//         pendingYear,
//         cycleDate,
//       );

//       const ledgerFinal = buildModeSplitLedger(
//         [],
//         2,
//         pendingMonthName,
//         cycleDate,
//       );

//       const withGst1Final = (media.landOwners || []).map((owner) => ({
//         landOwnerId: owner._id,
//         landOwnerName: owner.name,
//         utrNumber: "",
//         date: null,
//         status: 0,
//         withGst: 1,
//         month: pendingMonthName,
//         cycle: cycleDate,
//         rentalDueId: null,
//         index: null,
//         updatedBy: "",
//         updatedAt: null,
//         isPaid: false,
//         gstAmount: 0,
//         isVirtual: true,
//       }));

//       const syntheticMonthBucket = {
//         month: pendingMonthName,
//         ledger: ledgerFinal,
//         withGst1Ledger: withGst1Final,
//         allEntries: [],
//         gstBalanceHistory: gstBalanceHistoryForMonth,
//         tdsBalanceHistory: tdsBalanceHistoryForMonth,
//         pendingLedgerHistory: (pendingMonthEntry.owners || []).map((owner) => ({
//           ...owner,
//           month: pendingMonthEntry.month,
//           cycle: pendingMonthEntry.cycle,
//         })),
//         isSyntheticMonth: true,
//       };

//       let yearEntry = transformedLedgerHistory.find(
//         (y) => y.year === pendingYear,
//       );
//       if (!yearEntry) {
//         yearEntry = { year: pendingYear, months: [] };
//         transformedLedgerHistory.push(yearEntry);
//       }
//       yearEntry.months.push(syntheticMonthBucket);
//       existingBucketKeys.add(bucketKey);
//     });

//     transformedLedgerHistory.sort((a, b) => Number(a.year) - Number(b.year));
//     transformedLedgerHistory.forEach((yearEntry) => {
//       yearEntry.months.sort((a, b) => {
//         const idxA = MONTH_NAMES_LOCAL.findIndex(
//           (m) => m.toLowerCase() === a.month.toLowerCase(),
//         );
//         const idxB = MONTH_NAMES_LOCAL.findIndex(
//           (m) => m.toLowerCase() === b.month.toLowerCase(),
//         );
//         return idxA - idxB;
//       });
//     });

//     if (transformedLedgerHistory.length === 0) {
//       let targetYear = year ? String(year) : null;
//       let targetMonthName = month ? MONTH_NAMES_LOCAL[Number(month) - 1] : null;

//       const fallbackCycle =
//         media.rentalPayment?.lastBillPaidDate ||
//         media.rentalPayment?.nextBillingDate ||
//         new Date();
//       const d = new Date(fallbackCycle);

//       if (!targetYear || !targetMonthName) {
//         targetYear = targetYear || String(d.getUTCFullYear());
//         targetMonthName = targetMonthName || MONTH_NAMES_LOCAL[d.getUTCMonth()];
//       }

//       const gstBalanceHistoryForMonth =
//         getGstBalanceHistoryForMonth(targetMonthName);
//       const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
//         targetMonthName,
//         targetYear,
//         d,
//       );

//       const ledgerFinal = buildModeSplitLedger([], 2, targetMonthName, d);

//       const withGst1Final = (media.landOwners || []).map((owner) => ({
//         landOwnerId: owner._id,
//         landOwnerName: owner.name,
//         utrNumber: "",
//         date: null,
//         status: 0,
//         withGst: 1,
//         month: targetMonthName,
//         cycle: d,
//         rentalDueId: null,
//         index: null,
//         updatedBy: "",
//         updatedAt: null,
//         isPaid: false,
//         gstAmount: 0,
//         isVirtual: true,
//       }));

//       const pendingLedgerHistory = getPendingLedgerHistoryForMonth(
//         targetMonthName,
//         targetYear,
//       );

//       transformedLedgerHistory = [
//         {
//           year: targetYear,
//           months: [
//             {
//               month: targetMonthName,
//               ledger: ledgerFinal,
//               withGst1Ledger: withGst1Final,
//               allEntries: [],
//               gstBalanceHistory: gstBalanceHistoryForMonth,
//               tdsBalanceHistory: tdsBalanceHistoryForMonth,
//               pendingLedgerHistory,
//               isSyntheticMonth: true,
//             },
//           ],
//         },
//       ];
//     }

//     const rentalDueEntries = Array.isArray(media.rentalDue)
//   ? [...new Set(
//       media.rentalDue
//         .map((entry) => Number(entry.withGst))
//         .filter((withGst) => [1, 2].includes(withGst)),
//     )].map((withGst) => ({ withGst }))
//   : [];

//     // ✅ NEW — outstanding summary + currentBillDate + outstanding history blocks
//     const requestedMonthYearParsed = currentMonth
//   ? parseMonthYearParam(currentMonth)
//   : null;
// const outstanding = computeOutstandingSummary(media, requestedMonthYearParsed);
// const currentBillDate = getCurrentBillDate(media, requestedMonthYearParsed);

//     return successResponse(
//       res,
//       "Ledger history fetched successfully",
//       {
//         mediaId: media._id,
//         mediaName: media.mediaName,
//         mediaType: media.mediaType,
//         mediaCode: media.mediaCode,
//         city: media.city,
//         rentalPayment: media.rentalPayment,
//         landOwners: media.landOwners,
//         agreement: media.agreement,
//         currentRentalPayment: {
//           paymentFrequency: media.rentalPayment.paymentFrequency,
//           netPayable: media.rentalPayment.netPayable,
//           lastBillPaidDate: media.rentalPayment.lastBillPaidDate,
//           nextBillingDate: media.rentalPayment.nextBillingDate,
//         },
//         ledgerHistory: transformedLedgerHistory,
//         rentalDueEntries,
//         gstPayment: gstPayment,
//         tdsPayment: tdsPayment,

//         // ══ NEW ══
//         outstanding,
//         lastBillDate: formatDate(media.rentalPayment?.lastBillPaidDate),
//         nextBillingDate: formatDate(media.rentalPayment?.nextBillingDate),
//         currentBillDate: currentBillDate ? formatDate(currentBillDate) : "",
//         outStantStatus:
//           media.rentalPayment?.outStantStatus ??
//           (outstanding.totalOutstandingAmount > 0 ? 1 : 0),
//         // gstOutstandingHistory: media.rentalPayment?.gstOutstandingHistory || [],
//         // rentalOutstandingHistory:
//         //   media.rentalPayment?.rentalOutstandingHistory || [],
//       },
//       200,
//     );
//   } catch (error) {
//     console.error("getLedgerHistory error:", error);

//     return errorResponse(
//       res,
//       "Something went wrong while fetching ledger history",
//       { error: error.message },
//       500,
//     );
//   }
// };


exports.getLedgerHistory = async (req, res) => {
  try {
    const { mediaId, landOwnerMasterId, year, month } = req.body;
 
    if (!Array.isArray(mediaId) || mediaId.length === 0) {
      return errorResponse(res, "mediaId must be a non-empty array", null, 400);
    }
    const validMediaIds = mediaId.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validMediaIds.length !== mediaId.length) {
      return errorResponse(res, "mediaId array contains an invalid ObjectId", null, 400);
    }
 
    let ownerMasterIdFilter = null;
    if (landOwnerMasterId !== undefined && landOwnerMasterId !== null && landOwnerMasterId !== "") {
      if (!Array.isArray(landOwnerMasterId) || landOwnerMasterId.length === 0) {
        return errorResponse(res, "landOwnerMasterId must be a non-empty array when provided", null, 400);
      }
      const validOwnerIds = landOwnerMasterId.filter((id) => mongoose.Types.ObjectId.isValid(id));
      if (validOwnerIds.length !== landOwnerMasterId.length) {
        return errorResponse(res, "landOwnerMasterId array contains an invalid ObjectId", null, 400);
      }
      ownerMasterIdFilter = validOwnerIds.map(String);
    }
 
    const mediaDocs = await Media.find({ _id: { $in: validMediaIds } })
      .select(
        "mediaName city mediaType mediaCode rentalPayment rentalDueHistory ledgerHistory landOwners agreement gstBalanceHistory tdsBalanceHistory rentalDue pendingMonths",
      )
      .lean();
 
    const foundIds = new Set(mediaDocs.map((m) => String(m._id)));
    const notFoundIds = validMediaIds.filter((id) => !foundIds.has(String(id)));
 
    const mediaHistoryList = mediaDocs.map((media) =>
      buildSingleMediaHistoryBlock(media, { year, month, ownerMasterIdFilter }),
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
        acc.overallTotalOutstandingAmount += block.outstanding.totalOutstandingAmount;
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
 
    return successResponse(
      res,
      "Ledger history fetched successfully",
      {
        requestedFilters: { mediaId: validMediaIds, landOwnerMasterId: ownerMasterIdFilter, year: year || null, month: month || null },
        notFoundMediaIds: notFoundIds,
        mediaHistoryList,
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
 
/* ═══════════════════════════════════════════════════════════════════════
 * buildSingleMediaHistoryBlock — the ENTIRE original per-media getLedgerHistory
 * body, unchanged in its internal logic, wrapped as a reusable function and
 * extended with landOwnerMasterId filtering at every array that carries a
 * landOwnerId.
 * ═══════════════════════════════════════════════════════════════════════*/
function buildSingleMediaHistoryBlock(media, { year, month, ownerMasterIdFilter }) {
  // ── landOwnerMasterId -> matching embedded landOwners._id set ──
  const allLandOwners = media.landOwners || [];
  const matchingLandOwners = ownerMasterIdFilter
    ? allLandOwners.filter((o) => ownerMasterIdFilter.includes(String(o.landOwnerMasterId)))
    : allLandOwners;
  const matchingOwnerIdSet = new Set(matchingLandOwners.map((o) => String(o._id)));
 
  const belongsToMatchingOwner = (landOwnerId) =>
    !ownerMasterIdFilter || matchingOwnerIdSet.has(String(landOwnerId));
 
  if (ownerMasterIdFilter && matchingLandOwners.length === 0) {
    // No owner on this media matches the filter — return an empty-but-present block
    const emptyOutstanding = { currentBaseRent: 0, currentGSTDue: 0, previousBaseRentDue: 0, previousGSTDue: 0, totalOutstandingAmount: 0 };
    return {
      mediaId: media._id,
      mediaName: media.mediaName,
      mediaType: media.mediaType,
      mediaCode: media.mediaCode,
      city: media.city,
      landOwners: [],
      ledgerHistory: [],
      rentalDueEntries: [],
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
 
  let ledgerHistory = mergeLedgerSources(media.rentalDueHistory, media.ledgerHistory);

// ✅ CHANGED — normalize both sides to trimmed strings before comparing.
// `item.year` can arrive as a Number from one merged source and a String
// from the other; strict === was silently matching nothing.
if (year) {
  ledgerHistory = ledgerHistory.filter((item) => String(item.year).trim() === String(year).trim());
}

if (month) {
  const monthIdx = Number(month) - 1;
  const monthName = MONTH_NAMES[monthIdx];
  if (!monthName) {
    // invalid month number (e.g. "13", "0", non-numeric) — don't silently
    // fall through to "no filter", make it explicit
    ledgerHistory = [];
  } else {
    ledgerHistory = ledgerHistory
      .map((item) => ({
        ...item,
        months: (item.months || []).filter(
          (m) => String(m.month).trim().toLowerCase() === monthName.toLowerCase(),
        ),
      }))
      .filter((item) => item.months.length > 0);
  }
}
 
  // ✅ owner filter applied to every month bucket's raw entries up front
  if (ownerMasterIdFilter) {
    ledgerHistory = ledgerHistory.map((yearEntry) => ({
      ...yearEntry,
      months: yearEntry.months.map((monthEntry) => ({
        ...monthEntry,
        entries: (monthEntry.entries || []).filter((e) => belongsToMatchingOwner(e.landOwnerId)),
      })),
    }));
  }
 
  const fullGstBalanceHistoryUnfiltered = dedupeGstBalanceHistory(
    Array.isArray(media.gstBalanceHistory) ? media.gstBalanceHistory : [],
  );
  const fullGstBalanceHistory = ownerMasterIdFilter
    ? fullGstBalanceHistoryUnfiltered.filter((g) => belongsToMatchingOwner(g.ownerId || g.landOwnerId))
    : fullGstBalanceHistoryUnfiltered;
 
  let gstPayment = false;
  if (fullGstBalanceHistory.length > 0) {
    gstPayment = fullGstBalanceHistory.some((entry) => !entry.utrNumber || entry.utrNumber.trim() === "");
  }
 
  const fullTdsBalanceHistoryUnfiltered = Array.isArray(media.tdsBalanceHistory) ? media.tdsBalanceHistory : [];
  const fullTdsBalanceHistory = ownerMasterIdFilter
    ? fullTdsBalanceHistoryUnfiltered.filter((t) => belongsToMatchingOwner(t.landOwnerId))
    : fullTdsBalanceHistoryUnfiltered;
 
  let tdsPayment = false;
  if (fullTdsBalanceHistory.length > 0) {
    tdsPayment = fullTdsBalanceHistory.some(
      (entry) => entry.isUtrEntry === false || !entry.utrNumber || entry.utrNumber.trim() === "",
    );
  }
 
  const dedupeByKey = (entries, getKey) => {
    const withPos = entries.map((entry, pos) => ({ entry, pos }));
    const sorted = withPos.sort((a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt));
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
 
  const getGstBalanceDetails = (landOwnerId, monthLabel, rentalDueId, entryDate) => {
    try {
      if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) return { isPaid: false, gstAmount: 0 };
      if (!landOwnerId) return { isPaid: false, gstAmount: 0 };
 
      let gstEntry = fullGstBalanceHistory.find(
        (entry) => entry && String(entry.landOwnerId) === String(landOwnerId) && entry.month === monthLabel,
      );
 
      if (!gstEntry && rentalDueId) {
        gstEntry = fullGstBalanceHistory.find(
          (entry) => entry && entry.rentalDueId && String(entry.rentalDueId) === String(rentalDueId),
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
        const monthMatches = fullGstBalanceHistory.filter((entry) => entry && entry.month === monthLabel);
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
      (entry) => entry && entry.dueMonth && entry.dueMonth.toLowerCase().includes(monthName.toLowerCase()),
    );
  };
 
  const getTdsBalanceHistoryForMonth = (monthName, yearFromEntry, cycleDate) => {
    const realForMonth = (fullTdsBalanceHistory || []).filter((entry) => {
      if (!entry) return false;
      if (entry.month && entry.month.toLowerCase() !== monthName.toLowerCase()) return false;
      if (!entry.month && entry.dueMonth) {
        const expectedDueMonth = `${monthName} ${yearFromEntry}`.toLowerCase();
        return entry.dueMonth.toLowerCase() === expectedDueMonth;
      }
      if (yearFromEntry && entry.dueMonth) return entry.dueMonth.toLowerCase().includes(String(yearFromEntry));
      return !!entry.month;
    });
 
    const realOwnerIds = new Set(realForMonth.map((t) => String(t.landOwnerId)));
 
    const virtualForMonth = [];
    matchingLandOwners.forEach((owner) => {
      const isApplicable = owner.tdsApplicable === 1 || owner.tdsApplicable === "1" || owner.tdsApplicable === true;
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
 
  const storedPendingMonthsUnfiltered = Array.isArray(media.pendingMonths) ? media.pendingMonths : [];
  const getPendingLedgerHistoryForMonth = (monthName, yearValue) => {
    const monthLabel = `${monthName} ${yearValue}`;
    const match = storedPendingMonthsUnfiltered.find((pm) => pm.month === monthLabel);
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
 
  const buildModeSplitLedger = (realEntries, withGstValue, monthLabel, cycleDate) => {
    const result = [];
    matchingLandOwners.forEach((owner) => {
      const paymentCategory = Number(owner.paymentCategory || 1);
      const requiredModes = getRequiredModes(paymentCategory);
 
      requiredModes.forEach((mode) => {
        const realEntry = realEntries.find(
          (e) => String(e.landOwnerId) === String(owner._id) && e.paymentMode === mode,
        );
 
        if (realEntry) {
          result.push({
            landOwnerId: realEntry.landOwnerId,
            landOwnerName: realEntry.landOwnerName,
            paymentCategory,
            paymentMode: realEntry.paymentMode,
            utrNumber: realEntry.utrNumber,
            date: realEntry.date,
            status: realEntry.status,
            withGst: realEntry.withGst,
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
            amount: realEntry.amount,
            isVirtual: false,
          });
        } else {
          result.push({
            landOwnerId: owner._id,
            landOwnerName: owner.name,
            paymentCategory,
            paymentMode: mode,
            utrNumber: "",
            date: null,
            status: 0,
            withGst: withGstValue,
            month: monthLabel,
            cycle: cycleDate,
            rentalDueId: null,
            index: null,
            updatedBy: "",
            updatedAt: null,
            amount: 0,
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
 
      const sortByUpdatedAt = (entries) => [...entries].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
 
      const latestGst2 = dedupeByKey(withGst2Entries, gst2Key);
      const latestGst1 = dedupeByKey(withGst1Entries, gst1Key);
      const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(monthEntry.month);
 
      const monthIndex = MONTH_NAMES_LOCAL.findIndex((m) => m.toLowerCase() === monthEntry.month.toLowerCase());
 
      const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate ? new Date(media.rentalPayment.lastBillPaidDate) : null;
 
      const cycleDateForMonth =
        lastBillPaidDate &&
        String(lastBillPaidDate.getUTCFullYear()) === yearEntry.year &&
        lastBillPaidDate.getUTCMonth() === monthIndex
          ? lastBillPaidDate
          : new Date(Date.UTC(Number(yearEntry.year), monthIndex, 1));
 
      const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(monthEntry.month, yearEntry.year, cycleDateForMonth);
      const pendingLedgerHistory = getPendingLedgerHistoryForMonth(monthEntry.month, yearEntry.year);
      const ledgerFinal = buildModeSplitLedger(latestGst2, 2, monthEntry.month, cycleDateForMonth);
 
      const realWithGst1Mapped = latestGst1.map((entry) => {
        const gstDetails = getGstBalanceDetails(entry.landOwnerId, entry.month || monthEntry.month, entry.rentalDueId, entry.date || entry.createdAt);
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
 
      const withGst1OwnerIds = new Set(realWithGst1Mapped.filter((e) => e.landOwnerId).map((e) => String(e.landOwnerId)));
 
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
        allEntries: sortByUpdatedAt(allEntries).map((entry) => ({ ...entry, mediaName: media.mediaName })),
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
      existingBucketKeys.add(`${yearEntry.year}-${monthEntry.month.toLowerCase()}`);
    });
  });
 
  const storedPendingMonthsForBuckets = ownerMasterIdFilter
    ? storedPendingMonthsUnfiltered
        .map((pm) => ({ ...pm, owners: (pm.owners || []).filter((o) => belongsToMatchingOwner(o.landOwnerId)) }))
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
    if (!requestedMonthName || pendingMonthName.toLowerCase() !== requestedMonthName.toLowerCase()) return;
  }

  const bucketKey = `${pendingYear}-${pendingMonthName.toLowerCase()}`;
  if (existingBucketKeys.has(bucketKey)) return;
 
    const cycleDate = pendingMonthEntry.cycle
      ? new Date(pendingMonthEntry.cycle)
      : new Date(Date.UTC(Number(pendingYear), MONTH_NAMES_LOCAL.findIndex((m) => m.toLowerCase() === pendingMonthName.toLowerCase()), 1));
 
    const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(pendingMonthName);
    const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(pendingMonthName, pendingYear, cycleDate);
    const ledgerFinal = buildModeSplitLedger([], 2, pendingMonthName, cycleDate);
 
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
      pendingLedgerHistory: (pendingMonthEntry.owners || []).map((owner) => ({ ...owner, month: pendingMonthEntry.month, cycle: pendingMonthEntry.cycle })),
      isSyntheticMonth: true,
    };
 
    let yearEntry = transformedLedgerHistory.find((y) => y.year === pendingYear);
    if (!yearEntry) {
      yearEntry = { year: pendingYear, months: [] };
      transformedLedgerHistory.push(yearEntry);
    }
    yearEntry.months.push(syntheticMonthBucket);
    existingBucketKeys.add(bucketKey);
  });
 
  transformedLedgerHistory.sort((a, b) => Number(a.year) - Number(b.year));
  transformedLedgerHistory.forEach((yearEntry) => {
    yearEntry.months.sort((a, b) => {
      const idxA = MONTH_NAMES_LOCAL.findIndex((m) => m.toLowerCase() === a.month.toLowerCase());
      const idxB = MONTH_NAMES_LOCAL.findIndex((m) => m.toLowerCase() === b.month.toLowerCase());
      return idxA - idxB;
    });
  });
 
  if (transformedLedgerHistory.length === 0) {
  // ✅ CHANGED — if the person EXPLICITLY requested a specific year/month
  // and nothing was found for it, return genuinely empty (no fabricated
  // virtual placeholder entries). The synthetic "today's month" fallback
  // below is ONLY for when no year/month filter was given at all.
  if (year || month) {
    transformedLedgerHistory = [];
  } else {
    const targetYear = String(new Date().getUTCFullYear());
    const targetMonthName = (() => {
      const fallbackCycle = media.rentalPayment?.lastBillPaidDate || media.rentalPayment?.nextBillingDate || new Date();
      return MONTH_NAMES_LOCAL[new Date(fallbackCycle).getUTCMonth()];
    })();

    const fallbackCycle = media.rentalPayment?.lastBillPaidDate || media.rentalPayment?.nextBillingDate || new Date();
    const d = new Date(fallbackCycle);

    const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(targetMonthName);
    const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(targetMonthName, targetYear, d);
    const ledgerFinal = buildModeSplitLedger([], 2, targetMonthName, d);

    const withGst1Final = matchingLandOwners.map((owner) => ({
      landOwnerId: owner._id,
      landOwnerName: owner.name,
      utrNumber: "",
      date: null,
      status: 0,
      withGst: 1,
      month: targetMonthName,
      cycle: d,
      rentalDueId: null,
      index: null,
      updatedBy: "",
      updatedAt: null,
      isPaid: false,
      gstAmount: 0,
      isVirtual: true,
    }));

    const pendingLedgerHistory = getPendingLedgerHistoryForMonth(targetMonthName, targetYear);

    transformedLedgerHistory = [
      {
        year: targetYear,
        months: [
          {
            month: targetMonthName,
            ledger: ledgerFinal,
            withGst1Ledger: withGst1Final,
            allEntries: [],
            gstBalanceHistory: gstBalanceHistoryForMonth,
            tdsBalanceHistory: tdsBalanceHistoryForMonth,
            pendingLedgerHistory,
            isSyntheticMonth: true,
          },
        ],
      },
    ];
  }
}
 
  const rentalDueEntries = Array.isArray(media.rentalDue)
    ? [...new Set(
        media.rentalDue.map((entry) =>
          entry.withGst === null || entry.withGst === undefined
            ? (Number(media.rentalPayment?.gstApplicable || 0) === 1 ? undefined : "not_applicable")
            : ([1, 2].includes(Number(entry.withGst)) ? Number(entry.withGst) : undefined),
        ).filter((v) => v !== undefined),
      )].map((withGst) => ({ withGst: withGst === "not_applicable" ? null : withGst }))
    : [];
 
  // ✅ currentMonth removed — outstanding/currentBillDate now always
  // reflect the site's actual live cycle ("now"), not a requested month
  const outstanding = computeOutstandingSummary(media, null);
  const currentBillDate = getCurrentBillDate(media, null);
 
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
    outStantStatus: media.rentalPayment?.outStantStatus ?? (outstanding.totalOutstandingAmount > 0 ? 1 : 0),
    gstOutstandingHistory: media.rentalPayment?.gstOutstandingHistory || [],
    rentalOutstandingHistory: media.rentalPayment?.rentalOutstandingHistory || [],
  };
}