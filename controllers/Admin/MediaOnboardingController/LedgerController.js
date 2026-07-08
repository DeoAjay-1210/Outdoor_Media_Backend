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

  // ✅ NEW — reset ledger immediately when the cycle rolls over, instead
  // of waiting for the next createLedgerEntry call. The old cycle's
  // entries are already safely preserved in ledgerHistory, so nothing
  // is lost — this just makes `ledger` empty right away for the new
  // cycle that just opened.
  if (Array.isArray(media.ledger) && media.ledger.length > 0) {
    media.ledger = [];
    media.markModified("ledger");
  }
}

// exports.createLedgerEntry = async (req, res) => {
//   try {
//     const { mediaId, entries, utrNumber, date, landOwnerId } = req.body;

//     if (!mediaId) {
//       return errorResponse(res, "mediaId is required", null, 400);
//     }

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     const media = await Media.findById(mediaId);
//     if (!media) {
//       return errorResponse(res, "Media not found for given mediaId", null, 404);
//     }

//     if (!Array.isArray(media.ledger)) {
//       media.ledger = [];
//     }
//     if (!Array.isArray(media.ledgerHistory)) {
//       media.ledgerHistory = [];
//     }

//     // ── Normalize input: support both the OLD single-entry format
//     //    and the NEW multi-entry (multiple landOwners) format ──
//     let entryList = [];

//     if (Array.isArray(entries) && entries.length > 0) {
//       entryList = entries;
//     } else if (utrNumber) {
//       // backward-compatible single entry
//       entryList = [{ utrNumber, date, landOwnerId }];
//     } else {
//       return errorResponse(
//         res,
//         "Either 'entries' (array of { utrNumber, date, landOwnerId }) or a top-level 'utrNumber' is required",
//         null,
//         400,
//       );
//     }

//     // ── Validate every entry: utrNumber required, landOwnerId (if given)
//     //    must exist in media.landOwners ──
//     for (let i = 0; i < entryList.length; i++) {
//       const item = entryList[i];

//       if (!item.utrNumber) {
//         return errorResponse(
//           res,
//           `entries[${i}].utrNumber is required`,
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

//     // ── Tag every entry with the site's CURRENT billing cycle.
//     // The reset itself no longer happens here — it happens proactively
//     // in saveRentalDue at the moment the cycle actually rolls over
//     // (advanceRentalPaymentOnOwnerApproval). This is just for reference
//     // / consistency with the rest of the cycle-based system. ──
//     const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

//     if (!currentCycle) {
//       return errorResponse(
//         res,
//         "Unable to determine current billing cycle",
//         null,
//         400,
//       );
//     }

//     const savedLedgerEntries = [];
//     const historyBuckets = [];

//     // 1. Build + push a ledger entry AND its history bucket entry for EACH item
//     for (const item of entryList) {
//       const entryDate = item.date ? new Date(item.date) : new Date();

//       // Look up the matched land owner again (to pull name + auto-fill it)
//       const matchedOwner = item.landOwnerId
//         ? media.landOwners.id(item.landOwnerId)
//         : null;

//       const ledgerEntry = {
//         landOwnerId: matchedOwner ? matchedOwner._id : null,
//         landOwnerName: matchedOwner ? matchedOwner.name : "",
//         utrNumber: item.utrNumber,
//         date: entryDate,
//         status: 1,
//         cycle: currentCycle,
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//       };

//       media.ledger.push(ledgerEntry);
//       const savedLedgerEntry = media.ledger[media.ledger.length - 1];
//       savedLedgerEntries.push(savedLedgerEntry);

//       // 2. Auto-bucket into ledgerHistory: year -> month -> entries
//       // (PERMANENT record — never reset)
//       const { year, month } = getYearAndMonthName(entryDate);

//       let yearBucket = media.ledgerHistory.find((y) => y.year === year);
//       if (!yearBucket) {
//         media.ledgerHistory.push({ year, months: [] });
//         yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
//       }

//       let monthBucket = yearBucket.months.find((m) => m.month === month);
//       if (!monthBucket) {
//         yearBucket.months.push({ month, entries: [] });
//         monthBucket = yearBucket.months[yearBucket.months.length - 1];
//       }

//       monthBucket.entries.push({
//         landOwnerId: matchedOwner ? matchedOwner._id : null,
//         landOwnerName: matchedOwner ? matchedOwner.name : "",
//         mediaName: media.mediaName,
//         paymentFrequency: media.rentalPayment.paymentFrequency,
//         netPayable: media.rentalPayment.netPayable,
//         nextBillingDate: media.rentalPayment.nextBillingDate,
//         utrNumber: savedLedgerEntry.utrNumber,
//         date: savedLedgerEntry.date,
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//       });

//       historyBuckets.push({ year, month });
//     }

//     await media.save();

//     return successResponse(
//       res,
//       "Ledger entry created successfully",
//       {
//         mediaId: media._id,
//         mediaName: media.mediaName,
//         ledgerEntries: savedLedgerEntries,      // array (1 or many)
//         ledgerHistoryBuckets: historyBuckets,   // array (1 or many)
//         currentCycle: formatDate(currentCycle),
//         currentLedger: media.ledger,            // full current-cycle ledger state
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












// exports.createLedgerEntry = async (req, res) => {
//   try {
//     const { mediaId, entries, utrNumber, date, landOwnerId,withGst, month } = req.body;

//     if (!mediaId) {
//       return errorResponse(res, "mediaId is required", null, 400);
//     }

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     // Validate top-level withGst
//     if (withGst === undefined || withGst === null) {
//       return errorResponse(
//         res,
//         "withGst is required at top level",
//         null,
//         400,
//       );
//     }

//     if (typeof withGst !== 'number' || withGst < 0) {
//       return errorResponse(
//         res,
//         "withGst must be a positive number",
//         null,
//         400,
//       );
//     }

 

//     const media = await Media.findById(mediaId);
//     if (!media) {
//       return errorResponse(res, "Media not found for given mediaId", null, 404);
//     }

//     if (!Array.isArray(media.ledger)) {
//       media.ledger = [];
//     }
//     if (!Array.isArray(media.ledgerHistory)) {
//       media.ledgerHistory = [];
//     }

//     // ── Validate entries array ──
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

//       if (!item.utrNumber) {
//         return errorResponse(
//           res,
//           `entries[${i}].utrNumber is required`,
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

//     // ── Tag every entry with the site's CURRENT billing cycle ──
//     const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

//     if (!currentCycle) {
//       return errorResponse(
//         res,
//         "Unable to determine current billing cycle",
//         null,
//         400,
//       );
//     }

//     const savedLedgerEntries = [];
//     const historyBuckets = [];

//     // 1. Build + push a ledger entry AND its history bucket entry for EACH item
//     for (const item of entries) {
//       const entryDate = item.date ? new Date(item.date) : new Date();

//       // Look up the matched land owner again (to pull name + auto-fill it)
//       const matchedOwner = item.landOwnerId
//         ? media.landOwners.id(item.landOwnerId)
//         : null;

//       const ledgerEntry = {
//         landOwnerId: matchedOwner ? matchedOwner._id : null,
//         landOwnerName: matchedOwner ? matchedOwner.name : "",
//         utrNumber: item.utrNumber,
//         date: entryDate,
//         status: 1,
//         cycle: currentCycle,
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//         // NEW FIELDS - from top-level payload
//         withGst: withGst,    // Applied to all entries
//         month: month         // Applied to all entries (e.g., "July 2026")
//       };

//       media.ledger.push(ledgerEntry);
//       const savedLedgerEntry = media.ledger[media.ledger.length - 1];
//       savedLedgerEntries.push(savedLedgerEntry);

//       // 2. Auto-bucket into ledgerHistory: year -> month -> entries
//       const { year, month: monthName } = getYearAndMonthName(entryDate);

//       let yearBucket = media.ledgerHistory.find((y) => y.year === year);
//       if (!yearBucket) {
//         media.ledgerHistory.push({ year, months: [] });
//         yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
//       }

//       let monthBucket = yearBucket.months.find((m) => m.month === monthName);
//       if (!monthBucket) {
//         yearBucket.months.push({ month: monthName, entries: [] });
//         monthBucket = yearBucket.months[yearBucket.months.length - 1];
//       }

//       monthBucket.entries.push({
//         landOwnerId: matchedOwner ? matchedOwner._id : null,
//         landOwnerName: matchedOwner ? matchedOwner.name : "",
//         mediaName: media.mediaName,
//         paymentFrequency: media.rentalPayment.paymentFrequency,
//         netPayable: media.rentalPayment.netPayable,
//         nextBillingDate: media.rentalPayment.nextBillingDate,
//         utrNumber: savedLedgerEntry.utrNumber,
//         date: savedLedgerEntry.date,
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//         // NEW FIELDS in history - from top-level payload
//         withGst: withGst,    // Applied to all entries
//         month: month         // Applied to all entries
//       });

//       historyBuckets.push({ year, month: monthName });
//     }

//     await media.save();

//     return successResponse(
//       res,
//       "Ledger entry created successfully",
//       {
//         mediaId: media._id,
//         mediaName: media.mediaName,
//         ledgerEntries: savedLedgerEntries,
//         ledgerHistoryBuckets: historyBuckets,
//         currentCycle: formatDate(currentCycle),
//         currentLedger: media.ledger,
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

    if (!mediaId) {
      return errorResponse(res, "mediaId is required", null, 400);
    }

    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
    }

    const media = await Media.findById(mediaId);
    if (!media) {
      return errorResponse(res, "Media not found for given mediaId", null, 404);
    }

    if (!Array.isArray(media.ledger)) {
      media.ledger = [];
    }
    if (!Array.isArray(media.ledgerHistory)) {
      media.ledgerHistory = [];
    }

    // ── Validate entries array ──
    if (!Array.isArray(entries) || entries.length === 0) {
      return errorResponse(
        res,
        "entries array is required and must not be empty",
        null,
        400,
      );
    }

    // ── Validate every entry — utrNumber, landOwnerId, withGst, month
    // are ALL now validated PER ENTRY, not once at the top level ──
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];

      if (!item.utrNumber) {
        return errorResponse(
          res,
          `entries[${i}].utrNumber is required`,
          null,
          400,
        );
      }

      // ✅ withGst now validated per entry
      if (item.withGst === undefined || item.withGst === null) {
        return errorResponse(
          res,
          `entries[${i}].withGst is required`,
          null,
          400,
        );
      }

      if (typeof item.withGst !== "number" || item.withGst < 0) {
        return errorResponse(
          res,
          `entries[${i}].withGst must be a positive number`,
          null,
          400,
        );
      }

      // ✅ month now validated per entry
      if (!item.month) {
        return errorResponse(
          res,
          `entries[${i}].month is required`,
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
        if (!matchedOwner) {
          return errorResponse(
            res,
            `entries[${i}].landOwnerId does not match any landOwner on this media`,
            null,
            400,
          );
        }
      }
      if (item.rentalDueId) {
        if (!mongoose.Types.ObjectId.isValid(item.rentalDueId)) {
          return errorResponse(
            res,
            `entries[${i}].rentalDueId is not a valid ObjectId`,
            null,
            400,
          );
        }
      }
    }
     
    
    // ── Tag every entry with the site's CURRENT billing cycle ──
    const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

    if (!currentCycle) {
      return errorResponse(
        res,
        "Unable to determine current billing cycle",
        null,
        400,
      );
    }

    const savedLedgerEntries = [];
    const historyBuckets = [];
 const updatedGstBalanceRecords = [];
    // 1. Build + push a ledger entry AND its history bucket entry for EACH item
    for (const item of entries) {
      const entryDate = item.date ? new Date(item.date) : new Date();

      // Look up the matched land owner again (to pull name + auto-fill it)
      const matchedOwner = item.landOwnerId
        ? media.landOwners.id(item.landOwnerId)
        : null;

      const ledgerEntry = {
        landOwnerId: matchedOwner ? matchedOwner._id : null,
        landOwnerName: matchedOwner ? matchedOwner.name : "",
        utrNumber: item.utrNumber,
        date: entryDate,
        status: 1,
        cycle: currentCycle,
        updatedBy: req.user?.userName || "Admin",
        updatedAt: nowIST(),
        // ✅ FIXED — withGst/month now come from THIS entry, not a
        // shared top-level value applied to all entries.
        withGst: item.withGst,
        month: item.month,
         rentalDueId: item.rentalDueId || null,
      };

      media.ledger.push(ledgerEntry);
      const savedLedgerEntry = media.ledger[media.ledger.length - 1];
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

        if (matchingGstRecords.length > 0) {
          media.markModified("gstBalanceHistory");
        }
      }
      // 2. Auto-bucket into ledgerHistory: year -> month -> entries
      const { year, month: monthName } = getYearAndMonthName(entryDate);

      let yearBucket = media.ledgerHistory.find((y) => y.year === year);
      if (!yearBucket) {
        media.ledgerHistory.push({ year, months: [] });
        yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
      }

      let monthBucket = yearBucket.months.find((m) => m.month === monthName);
      if (!monthBucket) {
        yearBucket.months.push({ month: monthName, entries: [] });
        monthBucket = yearBucket.months[yearBucket.months.length - 1];
      }

      monthBucket.entries.push({
        landOwnerId: matchedOwner ? matchedOwner._id : null,
        landOwnerName: matchedOwner ? matchedOwner.name : "",
        mediaName: media.mediaName,
        paymentFrequency: media.rentalPayment.paymentFrequency,
        netPayable: media.rentalPayment.netPayable,
        nextBillingDate: media.rentalPayment.nextBillingDate,
        utrNumber: savedLedgerEntry.utrNumber,
        date: savedLedgerEntry.date,
        updatedBy: req.user?.userName || "Admin",
        updatedAt: nowIST(),
        // ✅ FIXED — per-entry values here too
        withGst: item.withGst,
        month: item.month,
         rentalDueId: item.rentalDueId || null,
      });

      historyBuckets.push({ year, month: monthName });
    }

    await media.save();

    return successResponse(
      res,
      "Ledger entry created successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        ledgerEntries: savedLedgerEntries,
        ledgerHistoryBuckets: historyBuckets,
        currentCycle: formatDate(currentCycle),
        currentLedger: media.ledger,
        updatedGstBalanceRecords, // ✅ shows which GST records got tagged with utrNumber/date
        gstBalanceHistory: media.gstBalanceHistory,
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

//     if (status !== undefined && status !== null && status !== "") {
//       const statusNum = Number(status);
//       if (![0, 1].includes(statusNum)) {
//         return errorResponse(
//           res,
//           "status must be one of 0 (Not approve), 1 (Approve)",
//           null,
//           400,
//         );
//       }
       
//       if (statusNum === 1) {
//         filter["ledger"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $elemMatch: { status: 1 }
//         };
//       } else if (statusNum === 0) {
//         filter.$or = [
//           { ledger: { $exists: false } },
//           { ledger: { $size: 0 } },
//           { "ledger.status": 0 }
//         ];
//       }
//     }

//     const validateMonthYear = (monthYear) => {
//       const regex = /^(0[1-9]|1[0-2])-([0-9]{4})$/;
//       return regex.test(monthYear);
//     };

//     const getMonthDateRange = (monthYear) => {
//       const [month, year] = monthYear.split("-").map(Number);
//       const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
//       const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
//       return { startDate, endDate };
//     };

//     const applyDateFilter = (monthYear, filterObj) => {
//       if (!validateMonthYear(monthYear)) {
//         throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
//       }
//       const { startDate, endDate } = getMonthDateRange(monthYear);
//       filterObj["rentalPayment.lastBillPaidDate"] = {
//         $gte: startDate,
//         $lte: endDate,
//       };
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

//     const [results, totalCount] = await Promise.all([
//       Media.find(filter)
//         .select(
//           "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory landOwners ledger rentalDue   createdAt updatedAt"
//         )
//         .sort({ updatedAt: -1 })
//         .skip(skip)
//         .limit(pageSize),
//       Media.countDocuments(filter),
//     ]);

//     const mediaListData = results.map((media) => {
//       const mediaObj = media.toObject();

//       // Process ledger - get latest entry per landOwner
//       let latestLedger = [];
//       if (Array.isArray(mediaObj.ledger) && mediaObj.ledger.length > 0) {
//         const sortedLedger = [...mediaObj.ledger].sort(
//           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//         );

//         const seenOwners = new Set();
//         for (const entry of sortedLedger) {
//           const ownerKey = entry.landOwnerId
//             ? String(entry.landOwnerId)
//             : `__no_owner_${entry._id}`;

//           if (!seenOwners.has(ownerKey)) {
//             seenOwners.add(ownerKey);
//             latestLedger.push(entry);
//           }
//         }
//       }

//       // Process rentalDueEntries - sort by ownerApprovalDate (most recent first)
//       let rentalDueEntriesWithApproval = [];
//       if (Array.isArray(mediaObj.rentalDueEntries) && mediaObj.rentalDueEntries.length > 0) {
//         const sortedEntries = [...mediaObj.rentalDueEntries].sort((a, b) => {
//           const dateA = a.ownerApprovalDate ? new Date(a.ownerApprovalDate) : new Date(0);
//           const dateB = b.ownerApprovalDate ? new Date(b.ownerApprovalDate) : new Date(0);
//           return dateB - dateA; // Most recent first
//         });

//         rentalDueEntriesWithApproval = sortedEntries
//           .filter(due => due.ownerApprovalDate)
//           .map(due => ({
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
//             createdAt: due.createdAt
//           }));
//       }

//       // Process rentalDue - sort by ownerApprovalDate (most recent first)
//       let rentalDueWithApproval = [];
//       if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
//         const sortedDue = [...mediaObj.rentalDue].sort((a, b) => {
//           const dateA = a.ownerApprovalDate ? new Date(a.ownerApprovalDate) : new Date(0);
//           const dateB = b.ownerApprovalDate ? new Date(b.ownerApprovalDate) : new Date(0);
//           return dateB - dateA; // Most recent first
//         });

//         rentalDueWithApproval = sortedDue
//           .filter(due => due.ownerApprovalDate)
//           .map(due => ({
//             _id: due._id,
//             ownerApprovalDate: due.ownerApprovalDate,
//             dueMonth: due.dueMonth,
            
//           }));
//       }

//       return {
//         ...mediaObj,
//         ledger: latestLedger,
//         rentalDue: rentalDueWithApproval,
//       };
//     });

//     return successResponse(
//       res,
//       "Media list fetched successfully",
//       {
//         pageNumber: pageNumbers,
//         count: pageSize,
//         totalCount,
//         totalPages: Math.ceil(totalCount / pageSize),
//         mediaList: mediaListData,
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
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};
    filter.rentalStatus = 3;
    if (search) {
      filter.mediaName = { $regex: search, $options: "i" };
    }

    if (status !== undefined && status !== null && status !== "") {
      const statusNum = Number(status);
      if (![0, 1].includes(statusNum)) {
        return errorResponse(
          res,
          "status must be one of 0 (Not approve), 1 (Approve)",
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
      }
    }

    const validateMonthYear = (monthYear) => {
      const regex = /^(0[1-9]|1[0-2])-([0-9]{4})$/;
      return regex.test(monthYear);
    };

    const getMonthDateRange = (monthYear) => {
      const [month, year] = monthYear.split("-").map(Number);
      const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
      const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
      return { startDate, endDate };
    };

    // ✅ FIXED — instead of filtering ONLY on rentalPayment.lastBillPaidDate
    // (which reflects the LIVE billing cycle and moves forward once
    // Owner approves), match on EITHER lastBillPaidDate/nextBillingDate
    // being in range, OR any rentalDue entry's dueDate being in range.
    // This keeps a site visible for the month it was actually due/paid,
    // even after its cycle has since advanced.
    let requestedMonthRange = null; // tracked so we can also filter the
    // returned arrays (ledger/rentalDue/gstBalanceHistory) to this month

    const applyDateFilter = (monthYear, filterObj) => {
      if (!validateMonthYear(monthYear)) {
        throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
      }
      const { startDate, endDate } = getMonthDateRange(monthYear);
      requestedMonthRange = { startDate, endDate };

      filterObj.$and = [
        ...(filterObj.$and || []),
        {
          $or: [
            {
              "rentalPayment.lastBillPaidDate": {
                $gte: startDate,
                $lte: endDate,
              },
            },
            // {
            //   "rentalPayment.nextBillingDate": {
            //     $gte: startDate,
            //     $lte: endDate,
            //   },
            // },
            {
              "rentalDue.dueDate": {
                $gte: startDate,
                $lte: endDate,
              },
            },
          ],
        },
      ];
      return filterObj;
    };

    if (dateRange) {
      try {
        applyDateFilter(dateRange, filter);
      } catch (error) {
        return errorResponse(res, error.message, null, 400);
      }
    }

    if (currentMonth) {
      try {
        applyDateFilter(currentMonth, filter);
      } catch (error) {
        return errorResponse(res, error.message, null, 400);
      }
    }

    const skip = (pageNumbers - 1) * pageSize;

    const [results, totalCount] = await Promise.all([
      Media.find(filter)
        .select(
          "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory landOwners ledger rentalDue createdAt updatedAt",
        )
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Media.countDocuments(filter),
    ]);

    const mediaListData = results.map((media) => {
      const mediaObj = media.toObject();

      // ✅ Helper: is this date within the requested month? If no month
      // filter was applied (neither dateRange nor currentMonth sent),
      // don't filter at all — show everything, same as before.
      const inRequestedMonth = (date) => {
        if (!requestedMonthRange || !date) return true;
        const d = new Date(date);
        return d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate;
      };

      // Process ledger - get latest entry per landOwner, scoped to month
      let latestLedger = [];
      if (Array.isArray(mediaObj.ledger) && mediaObj.ledger.length > 0) {
        const monthScopedLedger = mediaObj.ledger.filter((entry) =>
          inRequestedMonth(entry.date),
        );

        const sortedLedger = [...monthScopedLedger].sort(
          (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
        );

        const seenOwners = new Set();
        for (const entry of sortedLedger) {
          const ownerKey = entry.landOwnerId
            ? String(entry.landOwnerId)
            : `__no_owner_${entry._id}`;

          if (!seenOwners.has(ownerKey)) {
            seenOwners.add(ownerKey);
            latestLedger.push(entry);
          }
        }
      }

      // Process rentalDue - scoped to requested month, sorted by
      // ownerApprovalDate (most recent first)
      let rentalDueWithApproval = [];
      if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
        const monthScopedDue = mediaObj.rentalDue.filter((due) =>
          inRequestedMonth(due.dueDate),
        );

        const sortedDue = [...monthScopedDue].sort((a, b) => {
          const dateA = a.ownerApprovalDate ? new Date(a.ownerApprovalDate) : new Date(0);
          const dateB = b.ownerApprovalDate ? new Date(b.ownerApprovalDate) : new Date(0);
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

      // ✅ NEW — gstBalanceHistory scoped to requested month too
     const fullGstBalanceHistory = Array.isArray(mediaObj.gstBalanceHistory) 
        ? mediaObj.gstBalanceHistory 
        : [];

      return {
        ...mediaObj,
        ledger: latestLedger,
        rentalDue: rentalDueWithApproval,
        gstBalanceHistory: fullGstBalanceHistory, // All entries, not filtered by month
      };
    });

    return successResponse(
      res,
      "Media list fetched successfully",
      {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        mediaList: mediaListData,
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
exports.getLedgerHistory = async (req, res) => {
  try {
    const { mediaId, year, month } = req.query;

    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
    }

    // Use .lean() to get plain JSON objects
    const media = await Media.findById(mediaId)
      .select("mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners")
      .lean();

    if (!media) {
      return errorResponse(res, "Media not found for given mediaId", null, 404);
    }

    let ledgerHistory = media.ledgerHistory || [];

    // Filter by Year
    if (year) {
      ledgerHistory = ledgerHistory.filter(
        (item) => item.year === String(year),
      );
    }

    // Filter by Month
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

    // ✅ Helper: get latest entry PER landOwnerId (not just one overall)
    const getLatestPerLandOwner = (entries) => {
      const sortedEntries = [...entries].sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      );

      const seenOwners = new Set();
      const latestPerOwner = [];

      for (const entry of sortedEntries) {
        const ownerKey = entry.landOwnerId
          ? String(entry.landOwnerId)
          : `__no_owner_${entry.utrNumber}_${entry.date}`;

        if (!seenOwners.has(ownerKey)) {
          seenOwners.add(ownerKey);
          latestPerOwner.push(entry);
        }
      }

      return latestPerOwner;
    };

    // Transform ledgerHistory to include mediaName and show latest entry PER landOwner
    const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
      ...yearEntry,
      months: yearEntry.months.map((monthEntry) => {
        // ✅ latest entry per landOwner instead of a single overall latest
        const latestEntries = getLatestPerLandOwner(monthEntry.entries);

        return {
          month: monthEntry.month,
          // Now shows one latest entry PER landOwner (e.g. 2 owners -> 2 entries)
          entries: latestEntries.map((entry) => ({
            ...entry,
            mediaName: media.mediaName,
          })),
          // Keep all entries for historical/audit data
          allEntries: monthEntry.entries.map((entry) => ({
            ...entry,
            mediaName: media.mediaName,
          })),
        };
      }),
    }));

    return successResponse(
      res,
      "Ledger history fetched successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        mediaType: media.mediaType,
        mediaCode: media.mediaCode,
        landOwners: media.landOwners,
        city: media.city,
        rentalPayment: media.rentalPayment,
        currentRentalPayment: {
          paymentFrequency: media.rentalPayment.paymentFrequency,
          netPayable: media.rentalPayment.netPayable,
          nextBillingDate: media.rentalPayment.nextBillingDate,
        },
        ledgerHistory: transformedLedgerHistory,
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