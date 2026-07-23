const mongoose = require("mongoose");
const { successResponse, errorResponse } = require("../../../utils/response");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema"); // adjust path to wherever MediaSchema.js actually lives in your project
// const nowIST = require("../../../utils/updatedAt")
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

// Simple human-readable date formatter, e.g. "July 12, 2026"
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

// exports.createLedgerEntry = async (req, res) => {
//   try {
//     const { mediaId, entries } = req.body;

//     if (!mediaId) return errorResponse(res, "mediaId is required", null, 400);
//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     const media = await Media.findById(mediaId);
//     if (!media)
//       return errorResponse(res, "Media not found for given mediaId", null, 404);

//     if (!Array.isArray(media.ledger)) media.ledger = [];
//     if (!Array.isArray(media.withGst1Ledger)) media.withGst1Ledger = [];
//     if (!Array.isArray(media.ledgerHistory)) media.ledgerHistory = [];
//     if (!Array.isArray(media.gstBalanceHistory)) media.gstBalanceHistory = [];
//     if (!Array.isArray(media.tdsBalanceHistory)) media.tdsBalanceHistory = [];

//     if (!Array.isArray(entries) || entries.length === 0) {
//       return errorResponse(
//         res,
//         "entries array is required and must not be empty",
//         null,
//         400,
//       );
//     }

//     // ── Validate every entry ──
//     for (let i = 0; i < entries.length; i++) {
//       const item = entries[i];

//       const hasPaymentMode =
//         item.paymentMode !== undefined && item.paymentMode !== null;
//       const hasWithTds = item.withTds !== undefined && item.withTds !== null;

//       if (!hasPaymentMode && !hasWithTds) {
//         return errorResponse(
//           res,
//           `entries[${i}] must include paymentMode or withTds`,
//           null,
//           400,
//         );
//       }

//       if (hasPaymentMode) {
//         if (!["Cash", "Online"].includes(item.paymentMode)) {
//           return errorResponse(
//             res,
//             `entries[${i}].paymentMode must be "Cash" or "Online"`,
//             null,
//             400,
//           );
//         }
//         if (item.paymentMode === "Online" && !item.utrNumber) {
//           return errorResponse(
//             res,
//             `entries[${i}].utrNumber is required when paymentMode is "Online"`,
//             null,
//             400,
//           );
//         }
//         if (![1, 2].includes(Number(item.withGst ?? item.withGst))) {
//           return errorResponse(
//             res,
//             `entries[${i}].withGst (or withGst) must be 1 or 2 when paymentMode is present`,
//             null,
//             400,
//           );
//         }
//         const withGstValue = Number(item.withGst ?? item.withGst);
//         if (withGstValue === 1 && !item.rentalDueId) {
//           return errorResponse(
//             res,
//             `entries[${i}].rentalDueId is required when withGst (or withGst) is 1`,
//             null,
//             400,
//           );
//         }
//       }

//       if (hasWithTds && Number(item.withTds) === 1 && !item.utrNumber) {
//         return errorResponse(
//           res,
//           `entries[${i}].utrNumber is required when withTds is 1`,
//           null,
//           400,
//         );
//       }
//       if (hasWithTds && Number(item.withTds) === 1 && !item.landOwnerId) {
//         return errorResponse(
//           res,
//           `entries[${i}].landOwnerId is required when withTds is 1`,
//           null,
//           400,
//         );
//       }
//       if (item.landOwnerId) {
//         if (!mongoose.Types.ObjectId.isValid(item.landOwnerId)) {
//           return errorResponse(
//             res,
//             `entries[${i}].landOwnerId is not a valid ObjectId`,
//             null,
//             400,
//           );
//         }
//         const matchedOwner = media.landOwners.id(item.landOwnerId);
//         if (!matchedOwner && item.landOwnerName) {
//           matchedOwner = media.landOwners.find(
//             (o) => o.name === item.landOwnerName,
//           );
//         }

//         if (!matchedOwner) {
//           return errorResponse(
//             res,
//             `entries[${i}].landOwnerId does not match any landOwner on this media`,
//             null,
//             400,
//           );
//         }
//       }
//     }

//     const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

//     const savedLedgerEntries = [];
//     const savedTdsRecords = [];
//     const historyBuckets = [];
//     const updatedGstBalanceRecords = [];

//     let gst2SlotIndex = 0;

//     for (let i = 0; i < entries.length; i++) {
//       const item = entries[i];
//       const entryDate = item.date ? new Date(item.date) : new Date();
//       const matchedOwner = item.landOwnerId
//         ? media.landOwners.id(item.landOwnerId)
//         : null;
//       const withGst = Number(item.withGst ?? item.withGst);

//       // ══════════════════════════════════════════════════════
//       // LEDGER (paymentMode: Cash / Online) — routes to `ledger`
//       // (withGst===2) or `withGst1Ledger` (withGst===1)
//       // ══════════════════════════════════════════════════════
//       if (item.paymentMode) {
//         const ledgerEntryData = {
//           landOwnerId: matchedOwner ? matchedOwner._id : null,
//           landOwnerName: matchedOwner ? matchedOwner.name : "",
//           utrNumber: item.paymentMode === "Online" ? item.utrNumber : null,
//           paymentMode: item.paymentMode,
//           date: entryDate,
//           status: 1,
//           cycle: currentCycle,
//           updatedBy: req.user?.userName || "Admin",
//           updatedAt: nowIST(),
//           withGst,
//           month: item.month || null,
//           rentalDueId: item.rentalDueId || null,
//         };

//         let savedLedgerEntry;

//         if (withGst === 2) {
//           // ── LIVE `ledger`: UPSERT by landOwnerId (fixed-slot logic
//           // replaced with landOwnerId match, so Cash then Online for
//           // the SAME owner updates the SAME slot instead of consuming
//           // two separate slots) ──
//           const existingIdx = media.ledger.findIndex(
//             (e) =>
//               String(e.landOwnerId || "") ===
//                 String(ledgerEntryData.landOwnerId || "") &&
//               e.paymentMode === ledgerEntryData.paymentMode,
//           );

//           if (existingIdx !== -1) {
//             const preservedIndex = media.ledger[existingIdx].index;
//             ledgerEntryData.index = preservedIndex;
//             Object.assign(media.ledger[existingIdx], ledgerEntryData);
//             savedLedgerEntry = media.ledger[existingIdx];
//           } else {
//             ledgerEntryData.index = media.ledger.length;
//             media.ledger.push(ledgerEntryData);
//             savedLedgerEntry = media.ledger[media.ledger.length - 1];
//           }
//           media.markModified("ledger");
//         } else {
//           // ── LIVE `withGst1Ledger`: UPSERT by rentalDueId (fallback:
//           // landOwnerId + month). Cash entry created first, then
//           // Online added for the SAME owner+month/rentalDueId ->
//           // UPDATES the same record, sets paymentMode to "Online" and
//           // the new utrNumber — matches Step 3's requirement exactly. ──
//           const existingIndex = media.withGst1Ledger.findIndex((existing) => {
//             if (item.rentalDueId) {
//               return (
//                 String(existing.rentalDueId || "") === String(item.rentalDueId)
//               );
//             }
//             return (
//               String(existing.landOwnerId || "") ===
//                 String(ledgerEntryData.landOwnerId || "") &&
//               existing.month === item.month
//             );
//           });

//           if (existingIndex !== -1) {
//             Object.assign(media.withGst1Ledger[existingIndex], ledgerEntryData);
//             savedLedgerEntry = media.withGst1Ledger[existingIndex];
//           } else {
//             media.withGst1Ledger.push(ledgerEntryData);
//             savedLedgerEntry =
//               media.withGst1Ledger[media.withGst1Ledger.length - 1];
//           }
//           media.markModified("withGst1Ledger");
//         }

//         savedLedgerEntries.push(savedLedgerEntry);

//         if (item.rentalDueId) {
//           const matchingGstRecords = media.gstBalanceHistory.filter(
//             (g) => String(g.rentalDueId) === String(item.rentalDueId),
//           );
//           matchingGstRecords.forEach((g) => {
//             g.utrNumber = item.utrNumber;
//             g.date = entryDate;
//             updatedGstBalanceRecords.push(g);
//           });
//           if (matchingGstRecords.length > 0)
//             media.markModified("gstBalanceHistory");
//         }

//         // ── PERMANENT ledgerHistory ──
//         const { year, month: monthName } = getYearAndMonthName(entryDate);
//         let yearBucket = media.ledgerHistory.find((y) => y.year === year);
//         if (!yearBucket) {
//           media.ledgerHistory.push({ year, months: [] });
//           yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
//         }
//         let monthBucket = yearBucket.months.find((m) => m.month === monthName);
//         if (!monthBucket) {
//           yearBucket.months.push({ month: monthName, entries: [] });
//           monthBucket = yearBucket.months[yearBucket.months.length - 1];
//         }
//         monthBucket.entries.push({
//           landOwnerId: matchedOwner ? matchedOwner._id : null,
//           landOwnerName: matchedOwner ? matchedOwner.name : "",
//           mediaName: media.mediaName,
//           paymentFrequency: media.rentalPayment.paymentFrequency,
//           netPayable: media.rentalPayment.netPayable,
//           nextBillingDate: media.rentalPayment.nextBillingDate,
//           lastBillPaidDate: media.rentalPayment.lastBillPaidDate,
//           utrNumber: savedLedgerEntry.utrNumber,
//           paymentMode: item.paymentMode,
//           date: savedLedgerEntry.date,
//           updatedBy: req.user?.userName || "Admin",
//           updatedAt: nowIST(),
//           withGst,
//           month: item.month || null,
//           rentalDueId: item.rentalDueId || null,
//           index: withGst === 2 ? ledgerEntryData.index : null,
//         });
//         historyBuckets.push({ year, month: monthName });
//       }

//       // ══════════════════════════════════════════════════════
//       // ✅ TDS — withTds: 1, UPSERT by landOwnerId + month
//       // ══════════════════════════════════════════════════════
//       if (Number(item.withTds) === 1) {
//         const { year, month: monthName } = getYearAndMonthName(entryDate);
//         // Prefer the caller-supplied dueMonth-style `item.month` (e.g. "July 2026");
//         // fall back to deriving it from entryDate if not provided.
//         const dueMonth = item.month || `${monthName} ${year}`;

//         let tdsAmount = matchedOwner ? Number(matchedOwner.tdsAmount || 0) : 0;

//         // ✅ match by landOwnerId + dueMonth, NOT just month name
//         let tdsRecord = media.tdsBalanceHistory.find(
//           (t) =>
//             String(t.landOwnerId) === String(matchedOwner?._id) &&
//             t.dueMonth === dueMonth,
//         );

//         if (!tdsRecord) {
//           media.tdsBalanceHistory.push({
//             dueMonth,
//             cycle: currentCycle,
//             tdsAmount,
//             isUtrEntry: true,
//             paidAmount: tdsAmount,
//             paidAt: entryDate,
//             paidBy: req.user?.userName || "Admin",
//             createdAt: nowIST(),
//             createdBy: req.user?.userName || "Admin",
//             landOwnerId: matchedOwner ? matchedOwner._id : null,
//             landOwnerName: matchedOwner ? matchedOwner.name : "",
//             utrNumber: item.utrNumber,
//             date: item.date,
//           });
//           // Mongoose auto-generates a fresh _id here since the subdoc schema has { _id: true }
//           tdsRecord =
//             media.tdsBalanceHistory[media.tdsBalanceHistory.length - 1];
//         } else {
//           // Same owner + same dueMonth already paid once before -> UPDATE in place
//           // (e.g. re-saving July again just corrects that same July record)
//           tdsRecord.tdsAmount = tdsAmount;
//           tdsRecord.isUtrEntry = true;
//           tdsRecord.paidAmount = tdsAmount;
//           tdsRecord.paidAt = entryDate;
//           tdsRecord.paidBy = req.user?.userName || "Admin";
//           tdsRecord.utrNumber = item.utrNumber;
//           tdsRecord.date = entryDate;
//           tdsRecord.dueMonth = dueMonth;
//         }
//         media.markModified("tdsBalanceHistory");
//         savedTdsRecords.push(tdsRecord);
//       }
//     }

//     await media.save();

//     return successResponse(
//       res,
//       "Ledger entry created successfully",
//       {
//         mediaId: media._id,
//         mediaName: media.mediaName,
//         ledgerEntries: savedLedgerEntries,
//         tdsRecords: savedTdsRecords,
//         ledgerHistoryBuckets: historyBuckets,
//         currentCycle: formatDate(currentCycle),
//         currentLedger: media.ledger,
//         currentWithGst1Ledger: media.withGst1Ledger,
//         updatedGstBalanceRecords,
//         gstBalanceHistory: media.gstBalanceHistory,
//         tdsBalanceHistory: media.tdsBalanceHistory,
//       },
//       201,
//     );
//   } catch (error) {
//     console.error("createLedgerEntry error:", error);
//     return errorResponse(
//       res,
//       "Something went wrong while creating ledger entry",
//       { error: error.message },
//       500,
//     );
//   }
// };
exports.createLedgerEntry = async (req, res) => {
  try {
    const { mediaId, entries } = req.body;

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

    if (!Array.isArray(entries) || entries.length === 0) {
      return errorResponse(
        res,
        "entries array is required and must not be empty",
        null,
        400,
      );
    }

    // ── Validate every entry ──
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
        const matchedOwner = media.landOwners.id(item.landOwnerId);
        if (!matchedOwner && item.landOwnerName) {
          matchedOwner = media.landOwners.find(
            (o) => o.name === item.landOwnerName,
          );
        }

        if (!matchedOwner) {
          return errorResponse(
            res,
            `entries[${i}].landOwnerId does not match any landOwner on this media`,
            null,
            400,
          );
        }
      }
    }

    const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

    const savedLedgerEntries = [];
    const savedTdsRecords = [];
    const historyBuckets = [];
    const updatedGstBalanceRecords = [];

    let gst2SlotIndex = 0;

    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      const entryDate = item.date ? new Date(item.date) : new Date();
      const matchedOwner = item.landOwnerId
        ? media.landOwners.id(item.landOwnerId)
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
        };

        let savedLedgerEntry;

        if (withGst === 2) {
          // ── LIVE `ledger`: UPSERT by landOwnerId (fixed-slot logic
          // replaced with landOwnerId match, so Cash then Online for
          // the SAME owner updates the SAME slot instead of consuming
          // two separate slots) ──
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
          // ── LIVE `withGst1Ledger`: UPSERT by rentalDueId (fallback:
          // landOwnerId + month). Cash entry created first, then
          // Online added for the SAME owner+month/rentalDueId ->
          // UPDATES the same record, sets paymentMode to "Online" and
          // the new utrNumber — matches Step 3's requirement exactly. ──
          const existingIndex = media.withGst1Ledger.findIndex((existing) => {
            if (item.rentalDueId) {
              return (
                String(existing.rentalDueId || "") === String(item.rentalDueId)
              );
            }
            return (
              String(existing.landOwnerId || "") ===
                String(ledgerEntryData.landOwnerId || "") &&
              existing.month === item.month
            );
          });

          if (existingIndex !== -1) {
            Object.assign(media.withGst1Ledger[existingIndex], ledgerEntryData);
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
            updatedGstBalanceRecords.push(g);
          });
          if (matchingGstRecords.length > 0)
            media.markModified("gstBalanceHistory");
        }

        // ── PERMANENT ledgerHistory ──
        // const { year, month: monthName } = getYearAndMonthName(entryDate);
        // let yearBucket = media.ledgerHistory.find((y) => y.year === year);
        // if (!yearBucket) {
        //   media.ledgerHistory.push({ year, months: [] });
        //   yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
        // }
        // let monthBucket = yearBucket.months.find((m) => m.month === monthName);
        // if (!monthBucket) {
        //   yearBucket.months.push({ month: monthName, entries: [] });
        //   monthBucket = yearBucket.months[yearBucket.months.length - 1];
        // }
        // monthBucket.entries.push({
        //   landOwnerId: matchedOwner ? matchedOwner._id : null,
        //   landOwnerName: matchedOwner ? matchedOwner.name : "",
        //   mediaName: media.mediaName,
        //   paymentFrequency: media.rentalPayment.paymentFrequency,
        //   netPayable: media.rentalPayment.netPayable,
        //   nextBillingDate: media.rentalPayment.nextBillingDate,
        //   lastBillPaidDate: media.rentalPayment.lastBillPaidDate,
        //   utrNumber: savedLedgerEntry.utrNumber,
        //   paymentMode: item.paymentMode,
        //   date: savedLedgerEntry.date,
        //   updatedBy: req.user?.userName || "Admin",
        //   updatedAt: nowIST(),
        //   withGst,
        //   month: item.month || null,
        //   rentalDueId: item.rentalDueId || null,
        //   index: withGst === 2 ? ledgerEntryData.index : null,
        // });
        // historyBuckets.push({ year, month: monthName });
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

        let yearBucket = media.ledgerHistory.find((y) => y.year === bucketYear);
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
          date: savedLedgerEntry.date, // ✅ still the actual PAYMENT date
          updatedBy: req.user?.userName || "Admin",
          updatedAt: nowIST(),
          withGst,
          month: item.month || null,
          rentalDueId: item.rentalDueId || null,
          index: withGst === 2 ? ledgerEntryData.index : null,
        });
        historyBuckets.push({ year: bucketYear, month: bucketMonthName });
      }

      // ══════════════════════════════════════════════════════
      // ✅ TDS — withTds: 1, UPSERT by landOwnerId + month
      // ══════════════════════════════════════════════════════
      if (Number(item.withTds) === 1) {
        const { year, month: monthName } = getYearAndMonthName(entryDate);
        // Prefer the caller-supplied dueMonth-style `item.month` (e.g. "July 2026");
        // fall back to deriving it from entryDate if not provided.
        const dueMonth = item.month || `${monthName} ${year}`;

        let tdsAmount = matchedOwner ? Number(matchedOwner.tdsAmount || 0) : 0;

        // ✅ match by landOwnerId + dueMonth, NOT just month name
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
          // Mongoose auto-generates a fresh _id here since the subdoc schema has { _id: true }
          tdsRecord =
            media.tdsBalanceHistory[media.tdsBalanceHistory.length - 1];
        } else {
          // Same owner + same dueMonth already paid once before -> UPDATE in place
          // (e.g. re-saving July again just corrects that same July record)
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

    await media.save();

    return successResponse(
      res,
      "Ledger entry created successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        ledgerEntries: savedLedgerEntries,
        tdsRecords: savedTdsRecords,
        ledgerHistoryBuckets: historyBuckets,
        currentCycle: formatDate(currentCycle),
        currentLedger: media.ledger,
        currentWithGst1Ledger: media.withGst1Ledger,
        updatedGstBalanceRecords,
        gstBalanceHistory: media.gstBalanceHistory,
        tdsBalanceHistory: media.tdsBalanceHistory,
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
// exports.listMediaByLedger = async (req, res) => {
//   try {
//     const {
//       pageNumber = 1,
//       count = 10,
//       search,
//       status,
//       dateRange,
//       currentMonth,
//     } = req.body;

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;

//     const filter = {};
//     filter.rentalStatus = 3;
//     if (search) {
//       filter.mediaName = { $regex: search, $options: "i" };
//     }

//     // ✅ TDS status (4/5) extracted separately — applied as a
//     // post-filter AFTER virtual entries are computed, since "pending
//     // TDS" never exists as a real saved record in the DB.
//     let tdsStatusFilter = null;
//     if (status !== undefined && status !== null && status !== "") {
//       const statusNum = Number(status);
//       if ([4, 5].includes(statusNum)) {
//         tdsStatusFilter = statusNum;
//       }
//     }

//     if (status !== undefined && status !== null && status !== "") {
//       const statusNum = Number(status);
//       if (![0, 1, 2, 3, 4, 5].includes(statusNum)) {
//         return errorResponse(
//           res,
//           "status must be one of 0 (Not approve), 1 (Approve), 2 (GST Pending), 3 (GST Completed), 4 (TDS Pending), 5 (TDS Completed)",
//           null,
//           400,
//         );
//       }
//       if (statusNum === 1) {
//         filter["ledger"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $elemMatch: { status: 1 },
//         };
//       } else if (statusNum === 0) {
//         filter.$or = [
//           { ledger: { $exists: false } },
//           { ledger: { $size: 0 } },
//           { "ledger.status": 0 },
//         ];
//       } else if (statusNum === 2) {
//         filter["gstBalanceHistory"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $elemMatch: { isPaid: false },
//         };
//       } else if (statusNum === 3) {
//         filter["gstBalanceHistory"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $all: [{ $elemMatch: { isPaid: true, utrNumber: { $ne: "" } } }],
//         };
//         filter["gstBalanceHistory.isPaid"] = { $ne: false };
//         filter["gstBalanceHistory.utrNumber"] = { $ne: "" };
//       }
//       // statusNum 4/5 intentionally add NOTHING to the DB filter here
//       // — handled entirely by the post-filter after mediaListData is
//       // built, since a real DB record is always isUtrEntry: true.
//     }

//     const validateMonthYear = (monthYear) =>
//       /^(0[1-9]|1[0-2])-([0-9]{4})$/.test(monthYear);

//     const getMonthDateRange = (monthYear) => {
//       const [month, year] = monthYear.split("-").map(Number);
//       const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
//       const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
//       return { startDate, endDate };
//     };

//     let requestedMonthRange = null;

//     const applyDateFilter = (monthYear, filterObj) => {
//       if (!validateMonthYear(monthYear)) {
//         throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
//       }
//       const { startDate, endDate } = getMonthDateRange(monthYear);
//       requestedMonthRange = { startDate, endDate };

//       filterObj.$and = [
//         ...(filterObj.$and || []),
//         {
//           $or: [
//             {
//               "rentalPayment.lastBillPaidDate": {
//                 $gte: startDate,
//                 $lte: endDate,
//               },
//             },
//             { "rentalDue.dueDate": { $gte: startDate, $lte: endDate } },
//             {
//               ledgerHistory: {
//                 $elemMatch: {
//                   year: String(startDate.getUTCFullYear()),
//                   months: {
//                     $elemMatch: { month: MONTH_NAMES[startDate.getUTCMonth()] },
//                   },
//                 },
//               },
//             },
//           ],
//         },
//       ];
//       return filterObj;
//     };

//     if (dateRange) {
//       try {
//         applyDateFilter(dateRange, filter);
//       } catch (error) {
//         return errorResponse(res, error.message, null, 400);
//       }
//     }
//     if (currentMonth) {
//       try {
//         applyDateFilter(currentMonth, filter);
//       } catch (error) {
//         return errorResponse(res, error.message, null, 400);
//       }
//     }

//     const skip = (pageNumbers - 1) * pageSize;
// const needsFullFetchForTdsFilter = tdsStatusFilter !== null;
//    const [results, totalCount] = await Promise.all([
//       needsFullFetchForTdsFilter
//         ? Media.find(filter)
//             .select(
//               "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
//             )
//             .sort({ updatedAt: -1 })
//         : Media.find(filter)
//             .select(
//               "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
//             )
//             .sort({ updatedAt: -1 })
//             .skip(skip)
//             .limit(pageSize),
//       Media.countDocuments(filter), // still the RAW db count, used only as a fallback
//     ]);

//     let overallGstPendingAmount = 0;

//     const MONTH_NAME_TO_INDEX = MONTH_NAMES.reduce((acc, name, idx) => {
//       acc[name.toLowerCase()] = idx;
//       return acc;
//     }, {});

//     const mediaListData = results.map((media) => {
//       const mediaObj = media.toObject();

//       const inRequestedMonth = (date) => {
//         if (!requestedMonthRange || !date) return true;
//         const d = new Date(date);
//         return (
//           d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
//         );
//       };

//       const siteLiveCycleDate =
//         mediaObj.rentalPayment?.nextBillingDate ||
//         mediaObj.rentalPayment?.lastBillPaidDate;

//       const isSiteCurrentLiveCycleMonth =
//         requestedMonthRange &&
//         siteLiveCycleDate &&
//         (() => {
//           const d = new Date(siteLiveCycleDate);
//           return (
//             d.getUTCFullYear() ===
//               requestedMonthRange.startDate.getUTCFullYear() &&
//             d.getUTCMonth() === requestedMonthRange.startDate.getUTCMonth()
//           );
//         })();

//       let gst2SourceEntries;
//       let gst1SourceEntries;
//       let monthHistoryEntries = [];

//       if (requestedMonthRange) {
//         const requestedMonthName =
//           MONTH_NAMES[requestedMonthRange.startDate.getUTCMonth()];
//         const requestedYear = String(
//           requestedMonthRange.startDate.getUTCFullYear(),
//         );

//         const yearBucket = (mediaObj.ledgerHistory || []).find(
//           (y) => String(y.year).trim() === requestedYear,
//         );
//         const monthBucket = yearBucket?.months.find(
//           (m) =>
//             String(m.month).trim().toLowerCase() ===
//             requestedMonthName.toLowerCase(),
//         );

//         monthHistoryEntries = [...(monthBucket?.entries || [])].sort(
//           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//         );

//         if (isSiteCurrentLiveCycleMonth) {
//           gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
//           gst1SourceEntries = mediaObj.withGst1Ledger || [];
//         } else {
//           const allMonthEntries = monthBucket?.entries || [];
//           gst2SourceEntries = allMonthEntries.filter((e) => e.withGst === 2);
//           gst1SourceEntries = allMonthEntries.filter((e) => e.withGst === 1);
//         }
//       } else {
//         gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
//         gst1SourceEntries = mediaObj.withGst1Ledger || [];
//       }

//       const dedupeByKey = (entries, getKey) => {
//         const withPos = entries.map((entry, pos) => ({ entry, pos }));
//         const sorted = withPos.sort(
//           (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
//         );
//         const seen = new Set();
//         const deduped = [];
//         for (const { entry, pos } of sorted) {
//           const key = getKey(entry, pos);
//           if (!seen.has(key)) {
//             seen.add(key);
//             deduped.push(entry);
//           }
//         }
//         return deduped;
//       };

//       const gst2Key = (entry, pos) =>
//         entry.index !== undefined && entry.index !== null
//           ? `idx_${entry.index}`
//           : entry._id
//             ? `id_${String(entry._id)}`
//             : `pos_${pos}`;

//       const gst1Key = (entry, pos) =>
//         entry.rentalDueId
//           ? `rd_${String(entry.rentalDueId)}`
//           : entry.landOwnerId
//             ? `owner_${String(entry.landOwnerId)}_${entry.month || ""}`
//             : entry._id
//               ? `id_${String(entry._id)}`
//               : `pos_${pos}`;

//       let latestLedger = [];
//       let withGst1Ledger = [];

//       const sourcedFromLiveLedger =
//         !requestedMonthRange || isSiteCurrentLiveCycleMonth;

//       if (gst2SourceEntries.length > 0) {
//         const monthScoped = requestedMonthRange
//           ? gst2SourceEntries
//           : gst2SourceEntries.filter((entry) => inRequestedMonth(entry.date));
//         latestLedger = sourcedFromLiveLedger
//           ? [...monthScoped].sort(
//               (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//             )
//           : dedupeByKey(monthScoped, gst2Key);
//       }

//       if (gst1SourceEntries.length > 0) {
//         const monthScoped = requestedMonthRange
//           ? gst1SourceEntries
//           : gst1SourceEntries.filter((entry) => inRequestedMonth(entry.date));
//         withGst1Ledger = sourcedFromLiveLedger
//           ? [...monthScoped].sort(
//               (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//             )
//           : dedupeByKey(monthScoped, gst1Key);
//       }

//       let rentalDueWithApproval = [];
//       if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
//         const monthScopedDue = mediaObj.rentalDue.filter((due) =>
//           inRequestedMonth(due.dueDate),
//         );
//         const sortedDue = [...monthScopedDue].sort((a, b) => {
//           const dateA = a.ownerApprovalDate
//             ? new Date(a.ownerApprovalDate)
//             : new Date(0);
//           const dateB = b.ownerApprovalDate
//             ? new Date(b.ownerApprovalDate)
//             : new Date(0);
//           return dateB - dateA;
//         });
//         rentalDueWithApproval = sortedDue
//           .filter((due) => due.ownerApprovalDate)
//           .map((due) => ({
//             _id: due._id,
//             ownerApprovalDate: due.ownerApprovalDate,
//             dueMonth: due.dueMonth,
//             dueDate: due.dueDate,
//             netPayable: due.netPayable,
//             approvalStatus: due.approvalStatus,
//             withGst: due.withGst,
//             gstAmount: due.gstAmount,
//             baseAmount: due.baseAmount,
//             paymentFrequency: due.paymentFrequency,
//             campaignName: due.campaignName,
//             status: due.status,
//             updatedAt: due.updatedAt,
//             createdAt: due.createdAt,
//           }));
//       }

//       const fullGstBalanceHistory = Array.isArray(mediaObj.gstBalanceHistory)
//         ? mediaObj.gstBalanceHistory
//         : [];
//       let gstPendingAmount = 0;
//       if (fullGstBalanceHistory.length > 0) {
//         fullGstBalanceHistory.forEach((entry) => {
//           const isPaid = entry.isPaid;
//           const isPaidFalse =
//             isPaid === false ||
//             isPaid === "false" ||
//             isPaid === 0 ||
//             isPaid === "0";
//           if (isPaidFalse) {
//             const amount =
//               Number(entry.paidAmount) ||
//               Number(entry.amount) ||
//               Number(entry.gstAmount) ||
//               0;
//             gstPendingAmount += amount;
//           }
//         });
//       }
//       overallGstPendingAmount += gstPendingAmount;

//       let gstPayment = false;
//       if (fullGstBalanceHistory.length > 0) {
//         const hasEmptyUtr = fullGstBalanceHistory.some(
//           (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
//         );
//         gstPayment = hasEmptyUtr;
//       }

//       // ══════════════════════════════════════════════════════
//       // TDS — real records first, then AUTO-DERIVE a virtual
//       // "unpaid" entry per (landOwner × due month)
//       // ══════════════════════════════════════════════════════
//       const realTdsEntries = Array.isArray(mediaObj.tdsBalanceHistory)
//         ? mediaObj.tdsBalanceHistory
//         : [];

//       const toDueMonth = (dateVal) => {
//         if (!dateVal) return null;
//         const d = new Date(dateVal);
//         if (isNaN(d.getTime())) return null;
//         return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
//       };

//       const uniqueDueMonths = new Map();

//       const addDueMonth = (dueMonthRaw, cycleValue) => {
//         const dueMonth = dueMonthRaw || toDueMonth(cycleValue);
//         if (!dueMonth) return;
//         if (!uniqueDueMonths.has(dueMonth)) {
//           uniqueDueMonths.set(
//             dueMonth,
//             cycleValue ? new Date(cycleValue) : null,
//           );
//         }
//       };

//       fullGstBalanceHistory.forEach((g) => {
//         addDueMonth(g.dueMonth, g.cycle || g.date);
//       });

//       if (uniqueDueMonths.size === 0 && Array.isArray(mediaObj.rentalDue)) {
//         mediaObj.rentalDue.forEach((due) => {
//           addDueMonth(due.dueMonth, due.dueDate);
//         });
//       }

//       if (uniqueDueMonths.size === 0 && Array.isArray(mediaObj.ledgerHistory)) {
//         mediaObj.ledgerHistory.forEach((yearBucket) => {
//           (yearBucket.months || []).forEach((monthBucket) => {
//             const dueMonth = `${monthBucket.month} ${yearBucket.year}`;
//             addDueMonth(dueMonth, null);
//           });
//         });
//       }

//       if (uniqueDueMonths.size === 0) {
//         const fallbackCycle =
//           mediaObj.rentalPayment?.nextBillingDate ||
//           mediaObj.rentalPayment?.lastBillPaidDate ||
//           new Date();
//         addDueMonth(null, fallbackCycle);
//       }

//       const realTdsKeySet = new Set(
//         realTdsEntries.map((t) => `${String(t.landOwnerId)}_${t.dueMonth}`),
//       );

//       const virtualTdsEntries = [];
//       uniqueDueMonths.forEach((cycleDate, dueMonth) => {
//         const monthName = dueMonth.split(" ")[0];

//         (mediaObj.landOwners || []).forEach((owner) => {
//           const isApplicable =
//             owner.tdsApplicable === 1 ||
//             owner.tdsApplicable === "1" ||
//             owner.tdsApplicable === true;
//           if (!isApplicable) return;

//           const key = `${String(owner._id)}_${dueMonth}`;
//           if (realTdsKeySet.has(key)) return;

//           const tdsAmount = Number(owner.tdsAmount || 0);

//           virtualTdsEntries.push({
//             _id: null,
//             dueMonth,
//             month: monthName,
//             cycle: cycleDate,
//             tdsAmount,
//             isUtrEntry: false,
//             paidAmount: 0,
//             paidAt: null,
//             landOwnerId: owner._id,
//             landOwnerName: owner.name,
//             utrNumber: "",
//             date: null,
//             isVirtual: true,
//           });
//         });
//       });

//       const tdsBalanceHistoryFiltered = [
//         ...realTdsEntries,
//         ...virtualTdsEntries,
//       ].sort(
//         (a, b) =>
//           new Date(a.cycle || a.date || 0) - new Date(b.cycle || b.date || 0),
//       );

//       // ✅ Status flags for the TDS post-filter
//       const hasUnpaidTds = tdsBalanceHistoryFiltered.some(
//         (t) => !t.isUtrEntry || !t.utrNumber || t.utrNumber.trim() === "",
//       );
//       const hasAnyTdsRecord = tdsBalanceHistoryFiltered.length > 0;
//       const isTdsFullyPaid = hasAnyTdsRecord && !hasUnpaidTds;

//       const { ledgerHistory, ...restOfMediaObj } = mediaObj;

//       return {
//         ...restOfMediaObj,
//         ledger: latestLedger,
//         withGst1Ledger: withGst1Ledger,
//         monthHistoryEntries: requestedMonthRange
//           ? monthHistoryEntries
//           : undefined,
//         rentalDue: rentalDueWithApproval,
//         gstPayment: gstPayment,
//         gstBalanceHistory: fullGstBalanceHistory,
//         gstPendingAmount: gstPendingAmount,
//         tdsBalanceHistory: tdsBalanceHistoryFiltered,
//         tdsStatusFlags: { hasUnpaidTds, isTdsFullyPaid }, // internal, stripped below
//       };
//     });

//     // ✅ Apply TDS status 4/5 post-filter (virtual-aware)
//     let finalMediaListData = mediaListData;
//     if (tdsStatusFilter === 4) {
//       finalMediaListData = mediaListData.filter(
//         (m) => m.tdsStatusFlags.hasUnpaidTds,
//       );
//     } else if (tdsStatusFilter === 5) {
//       finalMediaListData = mediaListData.filter(
//         (m) => m.tdsStatusFlags.isTdsFullyPaid,
//       );
//     }

//     finalMediaListData = finalMediaListData.map(
//       ({ tdsStatusFlags, ...rest }) => rest,
//     );
//     let effectiveTotalCount = totalCount;
//   if (needsFullFetchForTdsFilter) {
//       effectiveTotalCount = finalMediaListData.length;
//       finalMediaListData = finalMediaListData.slice(skip, skip + pageSize);
//     }
//     return successResponse(
//       res,
//       "Media list fetched successfully",
//       {
//         pageNumber: pageNumbers,
//         count: pageSize,
//          totalCount: effectiveTotalCount,
//         totalPages: Math.ceil(effectiveTotalCount  / pageSize),
//         overallGstPendingAmount: overallGstPendingAmount,
//         mediaList: finalMediaListData,
//       },
//       200,
//     );
//   } catch (error) {
//     console.error("listMediaByLedger error:", error);
//     return errorResponse(
//       res,
//       "Something went wrong while fetching media list",
//       { error: error.message },
//       500,
//     );
//   }
// };
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
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};
    filter.rentalStatus = 3;
    if (search) {
      filter.mediaName = { $regex: search, $options: "i" };
    }

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

    // ✅ FIXED — dateRange/currentMonth is resolved ONCE, used for BOTH
    // isPendingExplicitCutoff (pending-month calculation) AND
    // requestedMonthRange (display scoping). It NEVER restricts the
    // DB `filter` itself anymore — that was the root cause of
    // overallGstPendingAmount/overallPastMonthPendingCount differing
    // between requests, since the old code silently excluded sites
    // from the DB query based on the month, causing the two endpoints
    // to sum over different document sets entirely.
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

    const skip = (pageNumbers - 1) * pageSize;
    const needsFullFetchForTdsFilter = tdsStatusFilter !== null;
    // ✅ FIXED — ALSO force a full (unpaginated) fetch whenever a
    // month reference is present, so aggregate totals are always
    // computed over the SAME complete site set, regardless of
    // whether isPending was sent.
    const needsFullFetch =
      needsFullFetchForTdsFilter || isPendingFilter || !!isPendingExplicitCutoff;

    const [results, totalCount] = await Promise.all([
      needsFullFetch
        ? Media.find(filter)
            .select(
              "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
            )
            .sort({ updatedAt: -1 })
        : Media.find(filter)
            .select(
              "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
            )
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(pageSize),
      Media.countDocuments(filter),
    ]);

    let overallGstPendingAmount = 0;
    let overallPastMonthPendingCount = 0;
    const MONTH_NAME_TO_INDEX = MONTH_NAMES.reduce((acc, name, idx) => {
      acc[name.toLowerCase()] = idx;
      return acc;
    }, {});

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

      // ══════════════════════════════════════════════════════
      // ✅ Pending-month calculation — ALWAYS runs for every site,
      // regardless of isPendingFilter. isPendingFilter only decides
      // whether the RESULT is used to filter the list later.
      // ══════════════════════════════════════════════════════
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
          // (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
          //   (yearBucket.months || []).forEach((monthBucket) => {
          //     const monthIdx = MONTH_NAMES.findIndex(
          //       (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
          //     );
          //     const entries = monthBucket.entries || [];
          //     const hasLedgerSave = entries.some((e) => e.withGst === 2);
          //     if (hasLedgerSave) {
          //       savedLedgerMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
          //     }
          //   });
          // });
           (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
            (yearBucket.months || []).forEach((monthBucket) => {
              const monthIdx = MONTH_NAMES.findIndex(
                (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
              );
              const entries = monthBucket.entries || [];
              const gst2Entries = entries.filter((e) => e.withGst === 2);

              // ✅ NEW — a month is only "saved" (cleared from pending)
              // once EVERY landOwner has completed their REQUIRED
              // ledger entries for this month, based on paymentCategory:
              //   1 (Cash)         -> needs 1 Cash entry
              //   2 (Online)       -> needs 1 Online entry
              //   3 (Cash+Online)  -> needs BOTH a Cash entry AND an
              //                       Online entry (2 total)
              // A single Cash-only save for a paymentCategory:3 owner
              // is NOT enough — the month stays pending until the
              // Online entry is also saved. This check runs across
              // ALL landOwners on the site, so multi-owner sites only
              // clear once every owner's required entries are complete.
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
                  return hasCash || hasOnline; // fallback safety
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

      if (isPendingFilter && allPendingMonthKeys.length > 0) {
        latestLedger = [];
        withGst1Ledger = [];

        allPendingMonthKeys.forEach((pendingMonth) => {
          const targetYear = String(pendingMonth.yr);
          const targetMonthName = MONTH_NAMES[pendingMonth.monthIdx];
          const targetMonthLabel = `${targetMonthName} ${pendingMonth.yr}`;

          const yearBucket = (mediaObj.ledgerHistory || []).find(
            (y) => String(y.year).trim() === targetYear,
          );
          const monthBucket = yearBucket?.months.find(
            (m) => m.month.toLowerCase() === targetMonthName.toLowerCase(),
          );
          const monthEntries = monthBucket?.entries || [];

          const realGst2 = monthEntries.filter((e) => e.withGst === 2);
          const realGst1 = monthEntries.filter((e) => e.withGst === 1);

          const pendingCycleDate = new Date(
            Date.UTC(pendingMonth.yr, pendingMonth.monthIdx, 1),
          );

          if (realGst2.length > 0) {
            latestLedger.push(...realGst2);
          } else {
            latestLedger.push(
              ...(mediaObj.landOwners || []).map((owner) => ({
                landOwnerId: owner._id,
                landOwnerName: owner.name,
                utrNumber: "",
                paymentMode: null,
                date: null,
                status: 0,
                withGst: 2,
                month: targetMonthLabel,
                cycle: pendingCycleDate,
                rentalDueId: null,
                index: null,
                updatedBy: "",
                updatedAt: null,
                isVirtual: true,
              })),
            );
          }

          if (realGst1.length > 0) {
            withGst1Ledger.push(...realGst1);
          } else {
            withGst1Ledger.push(
              ...(mediaObj.landOwners || []).map((owner) => ({
                landOwnerId: owner._id,
                landOwnerName: owner.name,
                utrNumber: "",
                paymentMode: null,
                date: null,
                status: 0,
                withGst: 1,
                month: targetMonthLabel,
                cycle: pendingCycleDate,
                rentalDueId: null,
                index: null,
                updatedBy: "",
                updatedAt: null,
                isPaid: false,
                gstAmount: 0,
                isVirtual: true,
              })),
            );
          }
        });
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
        if (latestLedger.length === 0 && withGst1Ledger.length === 0) {
          const dueDateRaw =
            (Array.isArray(mediaObj.rentalDue) &&
              mediaObj.rentalDue[mediaObj.rentalDue.length - 1]?.dueDate) ||
            mediaObj.rentalPayment?.lastBillPaidDate ||
            mediaObj.rentalPayment?.nextBillingDate ||
            null;

          if (dueDateRaw) {
            const dueDate = new Date(dueDateRaw);
            if (!isNaN(dueDate.getTime())) {
              const dueMonthName = MONTH_NAMES[dueDate.getUTCMonth()];
              const dueMonthLabel = `${dueMonthName} ${dueDate.getUTCFullYear()}`;
              latestLedger = (mediaObj.landOwners || []).map((owner) => ({
                landOwnerId: owner._id,
                landOwnerName: owner.name,
                utrNumber: "",
                paymentMode: null,
                date: null,
                status: 0,
                withGst: 2,
                month: dueMonthLabel,
                cycle: dueDate,
                rentalDueId: null,
                index: null,
                updatedBy: "",
                updatedAt: null,
                isVirtual: true,
              }));

              withGst1Ledger = (mediaObj.landOwners || []).map((owner) => ({
                landOwnerId: owner._id,
                landOwnerName: owner.name,
                utrNumber: "",
                paymentMode: null,
                date: null,
                status: 0,
                withGst: 1,
                month: dueMonthLabel,
                cycle: dueDate,
                rentalDueId: null,
                index: null,
                updatedBy: "",
                updatedAt: null,
                isPaid: false,
                gstAmount: 0,
                isVirtual: true,
              }));
            }
          }
        }
      }

      let rentalDueWithApproval = [];
      if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
        const monthScopedDue = mediaObj.rentalDue.filter((due) =>
          inRequestedMonth(due.dueDate),
        );
        const sortedDue = [...monthScopedDue].sort((a, b) => {
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

      const fullGstBalanceHistory = Array.isArray(mediaObj.gstBalanceHistory)
        ? mediaObj.gstBalanceHistory
        : [];
      let gstPendingAmount = 0;
      if (fullGstBalanceHistory.length > 0) {
        fullGstBalanceHistory.forEach((entry) => {
          const isPaid = entry.isPaid;
          const isPaidFalse =
            isPaid === false ||
            isPaid === "false" ||
            isPaid === 0 ||
            isPaid === "0";
          if (isPaidFalse) {
            const amount =
              Number(entry.paidAmount) ||
              Number(entry.amount) ||
              Number(entry.gstAmount) ||
              0;
            gstPendingAmount += amount;
          }
        });
      }
      // ❌ REMOVED — no longer accumulating here. Computed via .reduce()
      // over finalMediaListData AFTER filtering, below.

      let gstPayment = false;
      if (fullGstBalanceHistory.length > 0) {
        const hasEmptyUtr = fullGstBalanceHistory.some(
          (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
        );
        gstPayment = hasEmptyUtr;
      }

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

      const hasUnpaidTds = tdsBalanceHistoryFiltered.some(
        (t) => !t.isUtrEntry || !t.utrNumber || t.utrNumber.trim() === "",
      );
      const hasAnyTdsRecord = tdsBalanceHistoryFiltered.length > 0;
      const isTdsFullyPaid = hasAnyTdsRecord && !hasUnpaidTds;

      const { ledgerHistory, ...restOfMediaObj } = mediaObj;

      return {
        ...restOfMediaObj,
        ledger: latestLedger,
        withGst1Ledger: withGst1Ledger,
        monthHistoryEntries: requestedMonthRange
          ? monthHistoryEntries
          : undefined,
        rentalDue: rentalDueWithApproval,
        gstPayment: gstPayment,
        gstBalanceHistory: fullGstBalanceHistory,
        gstPendingAmount: gstPendingAmount,
        tdsBalanceHistory: tdsBalanceHistoryFiltered,
        tdsStatusFlags: { hasUnpaidTds, isTdsFullyPaid },
        isPendingAcrossPastMonths,
        _pastMonthPendingCount: pastMonthPendingCount,
      };
    });

    let finalMediaListData = mediaListData;
   if (requestedMonthRange && !isPendingFilter) {
      const requestedMonthName =
        MONTH_NAMES[requestedMonthRange.startDate.getUTCMonth()];
      const requestedYear = String(
        requestedMonthRange.startDate.getUTCFullYear(),
      );

      finalMediaListData = finalMediaListData.filter((m) => {
        // Match 1: rentalPayment.lastBillPaidDate falls in the requested month
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

        // Match 2: any rentalDue entry's dueDate falls in the requested month
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

        // Match 3: ledger/withGst1Ledger has real (non-virtual) entries
        // for the requested month — indicates real activity that
        // month, even if lastBillPaidDate/rentalDue don't line up
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

    if (tdsStatusFilter === 4) {
      finalMediaListData = finalMediaListData.filter(
        (m) => m.tdsStatusFlags.hasUnpaidTds,
      );
    } else if (tdsStatusFilter === 5) {
      finalMediaListData = finalMediaListData.filter(
        (m) => m.tdsStatusFlags.isTdsFullyPaid,
      );
    }

    // ✅ FIXED — both aggregates now computed over the SAME final
    // (post-filter, pre-pagination) site set, consistently.
        overallGstPendingAmount = mediaListData.reduce(
      (sum, m) => sum + (m.gstPendingAmount || 0),
      0,
    );

    // ✅ pastMonthPendingCount stays scoped to the FINAL filtered list
    // (unchanged) — only overallGstPendingAmount is now fixed.
    overallPastMonthPendingCount = finalMediaListData.filter(
      (m) => (m._pastMonthPendingCount || 0) > 0,
    ).length;

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

    return successResponse(
      res,
      "Media list fetched successfully",
      {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount: effectiveTotalCount,
        totalPages: Math.ceil(effectiveTotalCount / pageSize),
        overallGstPendingAmount,
        overallPastMonthPendingCount,
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
// exports.listMediaByLedger = async (req, res) => {
//   try {
//     const {
//       pageNumber = 1,
//       count = 10,
//       search,
//       status,
//       dateRange,
//       currentMonth,
//       isPending,
//     } = req.body;

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;

//     const filter = {};
//     filter.rentalStatus = 3;
//     if (search) {
//       filter.mediaName = { $regex: search, $options: "i" };
//     }

//     let tdsStatusFilter = null;
//     if (status !== undefined && status !== null && status !== "") {
//       const statusNum = Number(status);
//       if ([4, 5].includes(statusNum)) {
//         tdsStatusFilter = statusNum;
//       }
//     }

//     if (status !== undefined && status !== null && status !== "") {
//       const statusNum = Number(status);
//       if (![0, 1, 2, 3, 4, 5].includes(statusNum)) {
//         return errorResponse(
//           res,
//           "status must be one of 0 (Not approve), 1 (Approve), 2 (GST Pending), 3 (GST Completed), 4 (TDS Pending), 5 (TDS Completed)",
//           null,
//           400,
//         );
//       }
//       if (statusNum === 1) {
//         filter["ledger"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $elemMatch: { status: 1 },
//         };
//       } else if (statusNum === 0) {
//         filter.$or = [
//           { ledger: { $exists: false } },
//           { ledger: { $size: 0 } },
//           { "ledger.status": 0 },
//         ];
//       } else if (statusNum === 2) {
//         filter["gstBalanceHistory"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $elemMatch: { isPaid: false },
//         };
//       } else if (statusNum === 3) {
//         filter["gstBalanceHistory"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $all: [{ $elemMatch: { isPaid: true, utrNumber: { $ne: "" } } }],
//         };
//         filter["gstBalanceHistory.isPaid"] = { $ne: false };
//         filter["gstBalanceHistory.utrNumber"] = { $ne: "" };
//       }
//     }

//     const validateMonthYear = (monthYear) =>
//       /^(0[1-9]|1[0-2])-([0-9]{4})$/.test(monthYear);

//     const getMonthDateRange = (monthYear) => {
//       const [month, year] = monthYear.split("-").map(Number);
//       const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
//       const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
//       return { startDate, endDate };
//     };

//     let requestedMonthRange = null;

//     const applyDateFilter = (monthYear, filterObj) => {
//       if (!validateMonthYear(monthYear)) {
//         throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
//       }
//       const { startDate, endDate } = getMonthDateRange(monthYear);
//       requestedMonthRange = { startDate, endDate };

//       filterObj.$and = [
//         ...(filterObj.$and || []),
//         {
//           $or: [
//             {
//               "rentalPayment.lastBillPaidDate": {
//                 $gte: startDate,
//                 $lte: endDate,
//               },
//             },
//             { "rentalDue.dueDate": { $gte: startDate, $lte: endDate } },
//             {
//               ledgerHistory: {
//                 $elemMatch: {
//                   year: String(startDate.getUTCFullYear()),
//                   months: {
//                     $elemMatch: { month: MONTH_NAMES[startDate.getUTCMonth()] },
//                   },
//                 },
//               },
//             },
//           ],
//         },
//       ];
//       return filterObj;
//     };

//     let isPendingFilter = false;
//     if (isPending !== undefined && isPending !== null && isPending !== "") {
//       const isPendingNum = Number(isPending);
//       if (isPendingNum !== 1) {
//         return errorResponse(
//           res,
//           "isPending must be 1 (any other value is invalid)",
//           null,
//           400,
//         );
//       }
//       isPendingFilter = true;
//     }

//     // ✅ dateRange/currentMonth, if sent, become the explicit cutoff
//     // for isPending. Only when NEITHER is sent do we fall back to
//     // each site's own lastBillPaidDate at runtime, per media doc.
//     let isPendingExplicitCutoff = null;
//     if (isPendingFilter) {
//       const refMonthYear = dateRange || currentMonth || null;
//       if (refMonthYear) {
//         if (!validateMonthYear(refMonthYear)) {
//           return errorResponse(
//             res,
//             "Invalid format. Use MM-YYYY format (e.g., 07-2026)",
//             null,
//             400,
//           );
//         }
//         const [refMonth, refYear] = refMonthYear.split("-").map(Number);
//         isPendingExplicitCutoff = { year: refYear, monthIndex: refMonth - 1 };
//       }
//     }

//     // dateRange/currentMonth still ALSO work as normal single-month
//     // filters when isPending is NOT set.
//     if (!isPendingFilter) {
//       if (dateRange) {
//         try {
//           applyDateFilter(dateRange, filter);
//         } catch (error) {
//           return errorResponse(res, error.message, null, 400);
//         }
//       }
//       if (currentMonth) {
//         try {
//           applyDateFilter(currentMonth, filter);
//         } catch (error) {
//           return errorResponse(res, error.message, null, 400);
//         }
//       }
//     }

//     const skip = (pageNumbers - 1) * pageSize;
//     const needsFullFetchForTdsFilter = tdsStatusFilter !== null;
//     const needsFullFetch = needsFullFetchForTdsFilter || isPendingFilter;

//     const [results, totalCount] = await Promise.all([
//       needsFullFetch
//         ? Media.find(filter)
//             .select(
//               "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
//             )
//             .sort({ updatedAt: -1 })
//         : Media.find(filter)
//             .select(
//               "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory tdsBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
//             )
//             .sort({ updatedAt: -1 })
//             .skip(skip)
//             .limit(pageSize),
//       Media.countDocuments(filter),
//     ]);

//     let overallGstPendingAmount = 0;
//     let overallPastMonthPendingCount = 0;
//     const MONTH_NAME_TO_INDEX = MONTH_NAMES.reduce((acc, name, idx) => {
//       acc[name.toLowerCase()] = idx;
//       return acc;
//     }, {});

//     const mediaListData = results.map((media) => {
//       const mediaObj = media.toObject();

//       const inRequestedMonth = (date) => {
//         if (!requestedMonthRange || !date) return true;
//         const d = new Date(date);
//         return (
//           d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
//         );
//       };

//       const siteLiveCycleDate =
//         mediaObj.rentalPayment?.nextBillingDate ||
//         mediaObj.rentalPayment?.lastBillPaidDate;

//       // ══════════════════════════════════════════════════════
//       // ✅ isPending: 1 — cutoff resolved in priority order:
//       //   1. Explicit dateRange/currentMonth from the request
//       //   2. This site's own lastBillPaidDate/nextBillingDate
//       // Only months STRICTLY BEFORE the resolved cutoff are checked
//       // for a missing ledger (withGst:2) save.
//       // ══════════════════════════════════════════════════════
//       let isPendingAcrossPastMonths = false;
//       let earliestPendingMonthKey = null;
//       let pastMonthPendingCount = 0;
//       if (isPendingFilter) {
//         let referenceYear = null;
//         let referenceMonthIndex = null;

//         if (isPendingExplicitCutoff) {
//           referenceYear = isPendingExplicitCutoff.year;
//           referenceMonthIndex = isPendingExplicitCutoff.monthIndex;
//         } else {
//           const referenceDateRaw =
//             mediaObj.rentalPayment?.lastBillPaidDate ||
//             mediaObj.rentalPayment?.nextBillingDate ||
//             null;
//           if (referenceDateRaw) {
//             const refDate = new Date(referenceDateRaw);
//             referenceYear = refDate.getUTCFullYear();
//             referenceMonthIndex = refDate.getUTCMonth();
//           }
//         }

//         if (referenceYear !== null) {
//           const savedLedgerMonthKeys = new Set();
//           (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
//             (yearBucket.months || []).forEach((monthBucket) => {
//               const monthIdx = MONTH_NAMES.findIndex(
//                 (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
//               );
//               const entries = monthBucket.entries || [];
//               const hasLedgerSave = entries.some((e) => e.withGst === 2);
//               if (hasLedgerSave) {
//                 savedLedgerMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
//               }
//             });
//           });

//           const neededMonthKeys = new Set();

//           if (Array.isArray(mediaObj.rentalDue)) {
//             mediaObj.rentalDue.forEach((due) => {
//               if (!due.dueDate) return;
//               const d = new Date(due.dueDate);
//               if (isNaN(d.getTime())) return;
//               neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
//             });
//           }

//           if (mediaObj.rentalPayment?.lastBillPaidDate) {
//             const d = new Date(mediaObj.rentalPayment.lastBillPaidDate);
//             if (!isNaN(d.getTime())) {
//               neededMonthKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
//             }
//           }

//           (mediaObj.ledgerHistory || []).forEach((yearBucket) => {
//             (yearBucket.months || []).forEach((monthBucket) => {
//               const monthIdx = MONTH_NAMES.findIndex(
//                 (m) => m.toLowerCase() === monthBucket.month.toLowerCase(),
//               );
//               neededMonthKeys.add(`${yearBucket.year}-${monthIdx}`);
//             });
//           });

//           const pendingKeys = [];
//           for (const key of neededMonthKeys) {
//             const [yrStr, monthIdxStr] = key.split("-");
//             const yr = Number(yrStr);
//             const monthIdx = Number(monthIdxStr);

//             const isBeforeReference =
//               yr < referenceYear ||
//               (yr === referenceYear && monthIdx < referenceMonthIndex);

//             if (isBeforeReference && !savedLedgerMonthKeys.has(key)) {
//               pendingKeys.push({ key, yr, monthIdx });
//             }
//           }

//           pendingKeys.sort((a, b) => a.yr - b.yr || a.monthIdx - b.monthIdx);

//           if (pendingKeys.length > 0) {
//             isPendingAcrossPastMonths = true;
//             earliestPendingMonthKey = pendingKeys[0];
//             pastMonthPendingCount = pendingKeys.length;
//           }
//         }
//       }

//       const isSiteCurrentLiveCycleMonth =
//         requestedMonthRange &&
//         siteLiveCycleDate &&
//         (() => {
//           const d = new Date(siteLiveCycleDate);
//           return (
//             d.getUTCFullYear() ===
//               requestedMonthRange.startDate.getUTCFullYear() &&
//             d.getUTCMonth() === requestedMonthRange.startDate.getUTCMonth()
//           );
//         })();

//       let gst2SourceEntries;
//       let gst1SourceEntries;
//       let monthHistoryEntries = [];

//       if (requestedMonthRange) {
//         const requestedMonthName =
//           MONTH_NAMES[requestedMonthRange.startDate.getUTCMonth()];
//         const requestedYear = String(
//           requestedMonthRange.startDate.getUTCFullYear(),
//         );

//         const yearBucket = (mediaObj.ledgerHistory || []).find(
//           (y) => String(y.year).trim() === requestedYear,
//         );
//         const monthBucket = yearBucket?.months.find(
//           (m) =>
//             String(m.month).trim().toLowerCase() ===
//             requestedMonthName.toLowerCase(),
//         );

//         monthHistoryEntries = [...(monthBucket?.entries || [])].sort(
//           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//         );

//         if (isSiteCurrentLiveCycleMonth) {
//           gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
//           gst1SourceEntries = mediaObj.withGst1Ledger || [];
//         } else {
//           const allMonthEntries = monthBucket?.entries || [];
//           gst2SourceEntries = allMonthEntries.filter((e) => e.withGst === 2);
//           gst1SourceEntries = allMonthEntries.filter((e) => e.withGst === 1);
//         }
//       } else {
//         gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
//         gst1SourceEntries = mediaObj.withGst1Ledger || [];
//       }

//       const dedupeByKey = (entries, getKey) => {
//         const withPos = entries.map((entry, pos) => ({ entry, pos }));
//         const sorted = withPos.sort(
//           (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
//         );
//         const seen = new Set();
//         const deduped = [];
//         for (const { entry, pos } of sorted) {
//           const key = getKey(entry, pos);
//           if (!seen.has(key)) {
//             seen.add(key);
//             deduped.push(entry);
//           }
//         }
//         return deduped;
//       };

//       const gst2Key = (entry, pos) =>
//         entry.index !== undefined && entry.index !== null
//           ? `idx_${entry.index}`
//           : entry._id
//             ? `id_${String(entry._id)}`
//             : `pos_${pos}`;

//       const gst1Key = (entry, pos) =>
//         entry.rentalDueId
//           ? `rd_${String(entry.rentalDueId)}`
//           : entry.landOwnerId
//             ? `owner_${String(entry.landOwnerId)}_${entry.month || ""}`
//             : entry._id
//               ? `id_${String(entry._id)}`
//               : `pos_${pos}`;

//       let latestLedger = [];
//       let withGst1Ledger = [];

//       if (isPendingFilter && earliestPendingMonthKey) {
//         const targetYear = String(earliestPendingMonthKey.yr);
//         const targetMonthName = MONTH_NAMES[earliestPendingMonthKey.monthIdx];

//         const yearBucket = (mediaObj.ledgerHistory || []).find(
//           (y) => String(y.year).trim() === targetYear,
//         );
//         const monthBucket = yearBucket?.months.find(
//           (m) => m.month.toLowerCase() === targetMonthName.toLowerCase(),
//         );
//         const monthEntries = monthBucket?.entries || [];

//         latestLedger = monthEntries.filter((e) => e.withGst === 2);
//         withGst1Ledger = monthEntries.filter((e) => e.withGst === 1);
//         if (latestLedger.length === 0 && withGst1Ledger.length === 0) {
//           const pendingCycleDate = new Date(
//             Date.UTC(
//               earliestPendingMonthKey.yr,
//               earliestPendingMonthKey.monthIdx,
//               1,
//             ),
//           );
//           const targetMonthLabel = `${targetMonthName} ${earliestPendingMonthKey.yr}`;
//           latestLedger = (mediaObj.landOwners || []).map((owner) => ({
//             landOwnerId: owner._id,
//             landOwnerName: owner.name,
//             utrNumber: "",
//             paymentMode: null,
//             date: null,
//             status: 0,
//             withGst: 2,
//             month: targetMonthLabel,
//             cycle: pendingCycleDate,
//             rentalDueId: null,
//             index: null,
//             updatedBy: "",
//             updatedAt: null,
//             isVirtual: true,
//           }));

//           withGst1Ledger = (mediaObj.landOwners || []).map((owner) => ({
//             landOwnerId: owner._id,
//             landOwnerName: owner.name,
//             utrNumber: "",
//             paymentMode: null,
//             date: null,
//             status: 0,
//             withGst: 1,
//             month: targetMonthLabel,
//             cycle: pendingCycleDate,
//             rentalDueId: null,
//             index: null,
//             updatedBy: "",
//             updatedAt: null,
//             isPaid: false,
//             gstAmount: 0,
//             isVirtual: true,
//           }));
//         }
//       } else {
//         const sourcedFromLiveLedger =
//           !requestedMonthRange || isSiteCurrentLiveCycleMonth;

//         if (gst2SourceEntries.length > 0) {
//           const monthScoped = requestedMonthRange
//             ? gst2SourceEntries
//             : gst2SourceEntries.filter((entry) => inRequestedMonth(entry.date));
//           latestLedger = sourcedFromLiveLedger
//             ? [...monthScoped].sort(
//                 (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//               )
//             : dedupeByKey(monthScoped, gst2Key);
//         }

//         if (gst1SourceEntries.length > 0) {
//           const monthScoped = requestedMonthRange
//             ? gst1SourceEntries
//             : gst1SourceEntries.filter((entry) => inRequestedMonth(entry.date));
//           withGst1Ledger = sourcedFromLiveLedger
//             ? [...monthScoped].sort(
//                 (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//               )
//             : dedupeByKey(monthScoped, gst1Key);
//         }
//         if (latestLedger.length === 0 && withGst1Ledger.length === 0) {
//           const dueDateRaw =
//             (Array.isArray(mediaObj.rentalDue) &&
//               mediaObj.rentalDue[mediaObj.rentalDue.length - 1]?.dueDate) ||
//             mediaObj.rentalPayment?.lastBillPaidDate ||
//             mediaObj.rentalPayment?.nextBillingDate ||
//             null;

//           if (dueDateRaw) {
//             const dueDate = new Date(dueDateRaw);
//             if (!isNaN(dueDate.getTime())) {
//               const dueMonthName = MONTH_NAMES[dueDate.getUTCMonth()];
//               const dueMonthLabel = `${dueMonthName} ${dueDate.getUTCFullYear()}`;
//               latestLedger = (mediaObj.landOwners || []).map((owner) => ({
//                 landOwnerId: owner._id,
//                 landOwnerName: owner.name,
//                 utrNumber: "",
//                 paymentMode: null,
//                 date: null,
//                 status: 0,
//                 withGst: 2,
//                 month: dueMonthLabel,
//                 cycle: dueDate,
//                 rentalDueId: null,
//                 index: null,
//                 updatedBy: "",
//                 updatedAt: null,
//                 isVirtual: true,
//               }));

//               withGst1Ledger = (mediaObj.landOwners || []).map((owner) => ({
//                 landOwnerId: owner._id,
//                 landOwnerName: owner.name,
//                 utrNumber: "",
//                 paymentMode: null,
//                 date: null,
//                 status: 0,
//                 withGst: 1,
//                 month: dueMonthLabel,
//                 cycle: dueDate,
//                 rentalDueId: null,
//                 index: null,
//                 updatedBy: "",
//                 updatedAt: null,
//                 isPaid: false,
//                 gstAmount: 0,
//                 isVirtual: true,
//               }));
//             }
//           }
//         }
//       }

//       let rentalDueWithApproval = [];
//       if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
//         const monthScopedDue = mediaObj.rentalDue.filter((due) =>
//           inRequestedMonth(due.dueDate),
//         );
//         const sortedDue = [...monthScopedDue].sort((a, b) => {
//           const dateA = a.ownerApprovalDate
//             ? new Date(a.ownerApprovalDate)
//             : new Date(0);
//           const dateB = b.ownerApprovalDate
//             ? new Date(b.ownerApprovalDate)
//             : new Date(0);
//           return dateB - dateA;
//         });
//         rentalDueWithApproval = sortedDue
//           .filter((due) => due.ownerApprovalDate)
//           .map((due) => ({
//             _id: due._id,
//             ownerApprovalDate: due.ownerApprovalDate,
//             dueMonth: due.dueMonth,
//             dueDate: due.dueDate,
//             netPayable: due.netPayable,
//             approvalStatus: due.approvalStatus,
//             withGst: due.withGst,
//             gstAmount: due.gstAmount,
//             baseAmount: due.baseAmount,
//             paymentFrequency: due.paymentFrequency,
//             campaignName: due.campaignName,
//             status: due.status,
//             updatedAt: due.updatedAt,
//             createdAt: due.createdAt,
//           }));
//       }

//       const fullGstBalanceHistory = Array.isArray(mediaObj.gstBalanceHistory)
//         ? mediaObj.gstBalanceHistory
//         : [];
//       let gstPendingAmount = 0;
//       if (fullGstBalanceHistory.length > 0) {
//         fullGstBalanceHistory.forEach((entry) => {
//           const isPaid = entry.isPaid;
//           const isPaidFalse =
//             isPaid === false ||
//             isPaid === "false" ||
//             isPaid === 0 ||
//             isPaid === "0";
//           if (isPaidFalse) {
//             const amount =
//               Number(entry.paidAmount) ||
//               Number(entry.amount) ||
//               Number(entry.gstAmount) ||
//               0;
//             gstPendingAmount += amount;
//           }
//         });
//       }
//       overallGstPendingAmount += gstPendingAmount;

//       let gstPayment = false;
//       if (fullGstBalanceHistory.length > 0) {
//         const hasEmptyUtr = fullGstBalanceHistory.some(
//           (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
//         );
//         gstPayment = hasEmptyUtr;
//       }

//       const realTdsEntries = Array.isArray(mediaObj.tdsBalanceHistory)
//         ? mediaObj.tdsBalanceHistory
//         : [];

//       const toDueMonth = (dateVal) => {
//         if (!dateVal) return null;
//         const d = new Date(dateVal);
//         if (isNaN(d.getTime())) return null;
//         return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
//       };

//       const uniqueDueMonths = new Map();

//       const addDueMonth = (dueMonthRaw, cycleValue) => {
//         const dueMonth = dueMonthRaw || toDueMonth(cycleValue);
//         if (!dueMonth) return;
//         if (!uniqueDueMonths.has(dueMonth)) {
//           uniqueDueMonths.set(
//             dueMonth,
//             cycleValue ? new Date(cycleValue) : null,
//           );
//         }
//       };

//       fullGstBalanceHistory.forEach((g) => {
//         addDueMonth(g.dueMonth, g.cycle || g.date);
//       });

//       if (uniqueDueMonths.size === 0 && Array.isArray(mediaObj.rentalDue)) {
//         mediaObj.rentalDue.forEach((due) => {
//           addDueMonth(due.dueMonth, due.dueDate);
//         });
//       }

//       if (uniqueDueMonths.size === 0 && Array.isArray(mediaObj.ledgerHistory)) {
//         mediaObj.ledgerHistory.forEach((yearBucket) => {
//           (yearBucket.months || []).forEach((monthBucket) => {
//             const dueMonth = `${monthBucket.month} ${yearBucket.year}`;
//             addDueMonth(dueMonth, null);
//           });
//         });
//       }

//       if (uniqueDueMonths.size === 0) {
//         const fallbackCycle =
//           mediaObj.rentalPayment?.nextBillingDate ||
//           mediaObj.rentalPayment?.lastBillPaidDate ||
//           new Date();
//         addDueMonth(null, fallbackCycle);
//       }

//       const realTdsKeySet = new Set(
//         realTdsEntries.map((t) => `${String(t.landOwnerId)}_${t.dueMonth}`),
//       );

//       const virtualTdsEntries = [];
//       uniqueDueMonths.forEach((cycleDate, dueMonth) => {
//         const monthName = dueMonth.split(" ")[0];

//         (mediaObj.landOwners || []).forEach((owner) => {
//           const isApplicable =
//             owner.tdsApplicable === 1 ||
//             owner.tdsApplicable === "1" ||
//             owner.tdsApplicable === true;
//           if (!isApplicable) return;

//           const key = `${String(owner._id)}_${dueMonth}`;
//           if (realTdsKeySet.has(key)) return;

//           const tdsAmount = Number(owner.tdsAmount || 0);

//           virtualTdsEntries.push({
//             _id: null,
//             dueMonth,
//             month: monthName,
//             cycle: cycleDate,
//             tdsAmount,
//             isUtrEntry: false,
//             paidAmount: 0,
//             paidAt: null,
//             landOwnerId: owner._id,
//             landOwnerName: owner.name,
//             utrNumber: "",
//             date: null,
//             isVirtual: true,
//           });
//         });
//       });

//       const tdsBalanceHistoryFiltered = [
//         ...realTdsEntries,
//         ...virtualTdsEntries,
//       ].sort(
//         (a, b) =>
//           new Date(a.cycle || a.date || 0) - new Date(b.cycle || b.date || 0),
//       );

//       const hasUnpaidTds = tdsBalanceHistoryFiltered.some(
//         (t) => !t.isUtrEntry || !t.utrNumber || t.utrNumber.trim() === "",
//       );
//       const hasAnyTdsRecord = tdsBalanceHistoryFiltered.length > 0;
//       const isTdsFullyPaid = hasAnyTdsRecord && !hasUnpaidTds;

//       const { ledgerHistory, ...restOfMediaObj } = mediaObj;

//       return {
//         ...restOfMediaObj,
//         ledger: latestLedger,
//         withGst1Ledger: withGst1Ledger,
//         monthHistoryEntries: requestedMonthRange
//           ? monthHistoryEntries
//           : undefined,
//         rentalDue: rentalDueWithApproval,
//         gstPayment: gstPayment,
//         gstBalanceHistory: fullGstBalanceHistory,
//         gstPendingAmount: gstPendingAmount,
//         tdsBalanceHistory: tdsBalanceHistoryFiltered,
//         tdsStatusFlags: { hasUnpaidTds, isTdsFullyPaid },
//         isPendingAcrossPastMonths,
//         _pastMonthPendingCount: pastMonthPendingCount,
//       };
//     });

//     let finalMediaListData = mediaListData;

//     if (isPendingFilter) {
//       finalMediaListData = finalMediaListData.filter(
//         (m) => m.isPendingAcrossPastMonths,
//       );
//     }

//     if (tdsStatusFilter === 4) {
//       finalMediaListData = finalMediaListData.filter(
//         (m) => m.tdsStatusFlags.hasUnpaidTds,
//       );
//     } else if (tdsStatusFilter === 5) {
//       finalMediaListData = finalMediaListData.filter(
//         (m) => m.tdsStatusFlags.isTdsFullyPaid,
//       );
//     }
  
//     // ✅ ONLY compute the aggregate when isPending was actually
//     // requested — otherwise it stays 0, matching "only from isPending apply"
  
//     if (isPendingFilter) {
//       overallPastMonthPendingCount = finalMediaListData.reduce(
//         (sum, m) => sum + (m._pastMonthPendingCount || 0),
//         0,
//       );
//     }

//     // ✅ SINGLE strip — remove ALL internal fields in one pass
//     finalMediaListData = finalMediaListData.map(
//       ({
//         tdsStatusFlags,
//         isPendingAcrossPastMonths,
//         _pastMonthPendingCount,
//         ...rest
//       }) => rest,
//     );

//     let effectiveTotalCount = totalCount;
//     if (needsFullFetch) {
//       effectiveTotalCount = finalMediaListData.length;
//       finalMediaListData = finalMediaListData.slice(skip, skip + pageSize);
//     }

//     return successResponse(
//       res,
//       "Media list fetched successfully",
//       {
//         pageNumber: pageNumbers,
//         count: pageSize,
//         totalCount: effectiveTotalCount,
//         totalPages: Math.ceil(effectiveTotalCount / pageSize),
//         overallGstPendingAmount: overallGstPendingAmount,
//         overallPastMonthPendingCount,
//         mediaList: finalMediaListData,
//       },
//       200,
//     );
//   } catch (error) {
//     console.error("listMediaByLedger error:", error);
//     return errorResponse(
//       res,
//       "Something went wrong while fetching media list",
//       { error: error.message },
//       500,
//     );
//   }
// };
exports.getLedgerHistory = async (req, res) => {
  try {
    const { mediaId, year, month } = req.query;

    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
    }

    const media = await Media.findById(mediaId)
      .select(
        "mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners agreement  gstBalanceHistory tdsBalanceHistory rentalDue",
      )
      .lean();

    if (!media) {
      return errorResponse(res, "Media not found for given mediaId", null, 404);
    }

    let ledgerHistory = media.ledgerHistory || [];

    if (year) {
      ledgerHistory = ledgerHistory.filter(
        (item) => item.year === String(year),
      );
    }

    if (month) {
      const monthNames = [
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
      const monthName = monthNames[Number(month) - 1];

      ledgerHistory = ledgerHistory
        .map((item) => ({
          ...item,
          months: item.months.filter(
            (m) => m.month.toLowerCase() === monthName.toLowerCase(),
          ),
        }))
        .filter((item) => item.months.length > 0);
    }

    const fullGstBalanceHistory = Array.isArray(media.gstBalanceHistory)
      ? media.gstBalanceHistory
      : [];
    let gstPayment = false;
    if (fullGstBalanceHistory.length > 0) {
      const hasEmptyUtr = fullGstBalanceHistory.some(
        (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
      );
      gstPayment = hasEmptyUtr;
    }

    const fullTdsBalanceHistory = Array.isArray(media.tdsBalanceHistory)
      ? media.tdsBalanceHistory
      : [];
    let tdsPayment = false;
    if (fullTdsBalanceHistory.length > 0) {
      const hasUnpaidTds = fullTdsBalanceHistory.some(
        (entry) =>
          entry.isUtrEntry === false ||
          !entry.utrNumber ||
          entry.utrNumber.trim() === "",
      );
      tdsPayment = hasUnpaidTds;
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
      month,
      rentalDueId,
      entryDate,
    ) => {
      try {
        if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) {
          return { isPaid: false, gstAmount: 0 };
        }
        if (!landOwnerId) {
          return { isPaid: false, gstAmount: 0 };
        }

        let gstEntry = null;

        gstEntry = fullGstBalanceHistory.find(
          (entry) =>
            entry &&
            String(entry.landOwnerId) === String(landOwnerId) &&
            entry.month === month,
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
            (entry) => entry && entry.month === month,
          );
          if (monthMatches.length === 1) {
            gstEntry = monthMatches[0];
          }
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
      if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) {
        return [];
      }
      return fullGstBalanceHistory.filter((entry) => {
        if (!entry || !entry.dueMonth) return false;
        return entry.dueMonth.toLowerCase().includes(monthName.toLowerCase());
      });
    };

    // ✅ FIXED — now accepts a resolved `cycleDate` param, so virtual
    // entries carry a real cycle value instead of always being null.
    const getTdsBalanceHistoryForMonth = (
      monthName,
      yearFromEntry,
      cycleDate,
    ) => {
      const realForMonth = (fullTdsBalanceHistory || []).filter((entry) => {
        if (!entry) return false;
        if (
          entry.month &&
          entry.month.toLowerCase() !== monthName.toLowerCase()
        ) {
          return false;
        }
        if (!entry.month && entry.dueMonth) {
          const expectedDueMonth =
            `${monthName} ${yearFromEntry}`.toLowerCase();
          return entry.dueMonth.toLowerCase() === expectedDueMonth;
        }
        if (yearFromEntry && entry.dueMonth) {
          return entry.dueMonth.toLowerCase().includes(String(yearFromEntry));
        }
        return !!entry.month;
      });

      const realOwnerIds = new Set(
        realForMonth.map((t) => String(t.landOwnerId)),
      );

      const virtualForMonth = [];
      (media.landOwners || []).forEach((owner) => {
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
          cycle: cycleDate || null, // ✅ FIXED — was hardcoded null
          tdsAmount: Number(owner.tdsAmount || 0),
          isUtrEntry: false,
          paidAmount: 0,
          paidAt: null,
          landOwnerId: owner._id,
          landOwnerName: owner.name,
          utrNumber: "",
          date: null,
          // isVirtual: true,
        });
      });

      return [...realForMonth, ...virtualForMonth];
    };

    const MONTH_NAMES_LOCAL = [
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

    let transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
      ...yearEntry,
      months: yearEntry.months.map((monthEntry) => {
        const allEntries = monthEntry.entries || [];

        const withGst2Entries = allEntries.filter(
          (entry) => entry.withGst === 2,
        );
        const withGst1Entries = allEntries.filter(
          (entry) => entry.withGst === 1,
        );

        const sortByUpdatedAt = (entries) =>
          [...entries].sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
          );

        const latestGst2 = dedupeByKey(withGst2Entries, gst2Key);
        const latestGst1 = dedupeByKey(withGst1Entries, gst1Key);
        const gstBalanceHistoryForMonth = getGstBalanceHistoryForMonth(
          monthEntry.month,
        );

        // ✅ Resolve the cycle date for THIS specific year/month bucket
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
          cycleDateForMonth, // ✅ pass resolved cycle date
        );

        return {
          month: monthEntry.month,

          ledger: latestGst2.map((entry) => ({
            landOwnerId: entry.landOwnerId,
            landOwnerName: entry.landOwnerName,
            utrNumber: entry.utrNumber,
            date: entry.date,
            status: entry.status,
            withGst: entry.withGst,
            month: entry.month,
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
          })),

          withGst1Ledger: latestGst1.map((entry) => {
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
            };
          }),

          allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
            ...entry,
            mediaName: media.mediaName,
          })),
          gstBalanceHistory: gstBalanceHistoryForMonth,
          tdsBalanceHistory: tdsBalanceHistoryForMonth,
        };
      }),
    }));

    // ✅ Fallback synthetic bucket for first-time media (no real
    // ledgerHistory saved yet) — prioritizes lastBillPaidDate over
    // nextBillingDate, and now passes the resolved cycle date into
    // getTdsBalanceHistoryForMonth so `cycle` is never null here either.
    if (transformedLedgerHistory.length === 0) {
      let targetYear = year ? String(year) : null;
      let targetMonthName = month ? MONTH_NAMES_LOCAL[Number(month) - 1] : null;

      const fallbackCycle =
        media.rentalPayment?.lastBillPaidDate ||
        media.rentalPayment?.nextBillingDate ||
        new Date();
      const d = new Date(fallbackCycle);

      if (!targetYear || !targetMonthName) {
        targetYear = targetYear || String(d.getUTCFullYear());
        targetMonthName = targetMonthName || MONTH_NAMES_LOCAL[d.getUTCMonth()];
      }

      const gstBalanceHistoryForMonth =
        getGstBalanceHistoryForMonth(targetMonthName);
      const tdsBalanceHistoryForMonth = getTdsBalanceHistoryForMonth(
        targetMonthName,
        targetYear,
        d, // ✅ resolved cycle date
      );

      transformedLedgerHistory = [
        {
          year: targetYear,
          months: [
            {
              month: targetMonthName,
              ledger: [],
              withGst1Ledger: [],
              allEntries: [],
              gstBalanceHistory: gstBalanceHistoryForMonth,
              tdsBalanceHistory: tdsBalanceHistoryForMonth,
            },
          ],
        },
      ];
    }
    const rentalDueEntries = Array.isArray(media.rentalDue)
      ? [...new Set(media.rentalDue.map((entry) => entry.withGst))].map(
          (withGst) => ({ withGst }),
        )
      : [];

    return successResponse(
      res,
      "Ledger history fetched successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        mediaType: media.mediaType,
        mediaCode: media.mediaCode,
        city: media.city,
        rentalPayment: media.rentalPayment,
        landOwners: media.landOwners,
        agreement: media.agreement,
        currentRentalPayment: {
          paymentFrequency: media.rentalPayment.paymentFrequency,
          netPayable: media.rentalPayment.netPayable,
          lastBillPaidDate: media.rentalPayment.lastBillPaidDate,
          nextBillingDate: media.rentalPayment.nextBillingDate,
        },
        ledgerHistory: transformedLedgerHistory,
        rentalDueEntries,
        // gstPayment: gstPayment,
        // tdsPayment: tdsPayment,
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
