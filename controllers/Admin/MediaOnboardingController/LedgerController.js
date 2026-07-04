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
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//       };

//       media.ledger.push(ledgerEntry);
//       const savedLedgerEntry = media.ledger[media.ledger.length - 1];
//       savedLedgerEntries.push(savedLedgerEntry);

//       // 2. Auto-bucket into ledgerHistory: year -> month -> entries
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
    const { mediaId, entries, utrNumber, date, landOwnerId } = req.body;

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

    // ── Normalize input: support both the OLD single-entry format
    //    and the NEW multi-entry (multiple landOwners) format ──
    let entryList = [];

    if (Array.isArray(entries) && entries.length > 0) {
      entryList = entries;
    } else if (utrNumber) {
      // backward-compatible single entry
      entryList = [{ utrNumber, date, landOwnerId }];
    } else {
      return errorResponse(
        res,
        "Either 'entries' (array of { utrNumber, date, landOwnerId }) or a top-level 'utrNumber' is required",
        null,
        400,
      );
    }

    // ── Validate every entry: utrNumber required, landOwnerId (if given)
    //    must exist in media.landOwners ──
    for (let i = 0; i < entryList.length; i++) {
      const item = entryList[i];

      if (!item.utrNumber) {
        return errorResponse(
          res,
          `entries[${i}].utrNumber is required`,
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
    }

    // ── Tag every entry with the site's CURRENT billing cycle.
    // The reset itself no longer happens here — it happens proactively
    // in saveRentalDue at the moment the cycle actually rolls over
    // (advanceRentalPaymentOnOwnerApproval). This is just for reference
    // / consistency with the rest of the cycle-based system. ──
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

    // 1. Build + push a ledger entry AND its history bucket entry for EACH item
    for (const item of entryList) {
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
      };

      media.ledger.push(ledgerEntry);
      const savedLedgerEntry = media.ledger[media.ledger.length - 1];
      savedLedgerEntries.push(savedLedgerEntry);

      // 2. Auto-bucket into ledgerHistory: year -> month -> entries
      // (PERMANENT record — never reset)
      const { year, month } = getYearAndMonthName(entryDate);

      let yearBucket = media.ledgerHistory.find((y) => y.year === year);
      if (!yearBucket) {
        media.ledgerHistory.push({ year, months: [] });
        yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
      }

      let monthBucket = yearBucket.months.find((m) => m.month === month);
      if (!monthBucket) {
        yearBucket.months.push({ month, entries: [] });
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
      });

      historyBuckets.push({ year, month });
    }

    await media.save();

    return successResponse(
      res,
      "Ledger entry created successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        ledgerEntries: savedLedgerEntries,      // array (1 or many)
        ledgerHistoryBuckets: historyBuckets,   // array (1 or many)
        currentCycle: formatDate(currentCycle),
        currentLedger: media.ledger,            // full current-cycle ledger state
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
//       dateRange, // Format: "07-2026"
//       currentMonth, // Format: "07-2026"
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
//       // filter["ledger.status"] = statusNum;
       
//       if (statusNum === 1) {
//         // Status 1: Show media with at least one approved ledger entry
//         filter["ledger"] = {
//           $exists: true,
//           $not: { $size: 0 },
//           $elemMatch: { status: 1 }
//         };
//       } else if (statusNum === 0) {
//         // Status 0: Show media with NO ledger entries OR ledger entries with status 0
//         filter.$or = [
//           { ledger: { $exists: false } },
//           { ledger: { $size: 0 } },
//           { "ledger.status": 0 }
//         ];
//       }
//     }

//     // Helper function to validate MM-YYYY format
//     const validateMonthYear = (monthYear) => {
//       const regex = /^(0[1-9]|1[0-2])-([0-9]{4})$/;
//       return regex.test(monthYear);
//     };

//     // Helper function to convert MM-YYYY to date range
//     const getMonthDateRange = (monthYear) => {
//       const [month, year] = monthYear.split("-").map(Number);

//       // Create start date (first day of month at 00:00:00)
//       const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));

//       // Create end date (last day of month at 23:59:59)
//       const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

//       return { startDate, endDate };
//     };

//     // Apply date filter on rentalPayment.nextBillingDate
//     const applyDateFilter = (monthYear, filterObj) => {
//       if (!validateMonthYear(monthYear)) {
//         throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
//       }

//       const { startDate, endDate } = getMonthDateRange(monthYear);

//       // Filter on rentalPayment.nextBillingDate (not ledger.nextBillingDate)
//       filterObj["rentalPayment.lastBillPaidDate"] = {
//         $gte: startDate,
//         $lte: endDate,
//       };

//       return filterObj;
//     };

//     // Date Range Filter - Single Month-Year format
//     if (dateRange) {
//       try {
//         applyDateFilter(dateRange, filter);
//       } catch (error) {
//         return errorResponse(res, error.message, null, 400);
//       }
//     }

//     // Current Month Filter - Single Month-Year format
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
//           "mediaCode mediaName mediaType state city location rentalDueEntries rentalStatus rentalPayment  landOwners ledger ",
//         )
//         .sort({ updatedAt: -1 })
//         .skip(skip)
//         .limit(pageSize),
//       Media.countDocuments(filter),
//     ]);

//     // Transform data - Get latest ledger entry PER landOwner (not just one overall)
//     const mediaListData = results.map((media) => {
//       const mediaObj = media.toObject();

//       let latestLedger = [];

//       if (Array.isArray(mediaObj.ledger) && mediaObj.ledger.length > 0) {
//         // Sort newest first
//         const sortedLedger = [...mediaObj.ledger].sort(
//           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//         );

//         // ✅ Keep only the latest entry PER landOwnerId
//         // (entries with no landOwnerId are each kept individually,
//         //  since there's nothing to dedupe them against)
//         const seenOwners = new Set();
//         latestLedger = [];

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

//       return {
//         ...mediaObj,
//         ledger: latestLedger, // ✅ now shows 1 latest entry PER landOwner
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
          $elemMatch: { status: 1 }
        };
      } else if (statusNum === 0) {
        filter.$or = [
          { ledger: { $exists: false } },
          { ledger: { $size: 0 } },
          { "ledger.status": 0 }
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

    const applyDateFilter = (monthYear, filterObj) => {
      if (!validateMonthYear(monthYear)) {
        throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
      }
      const { startDate, endDate } = getMonthDateRange(monthYear);
      filterObj["rentalPayment.lastBillPaidDate"] = {
        $gte: startDate,
        $lte: endDate,
      };
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
          "mediaCode mediaName mediaType state city location rentalStatus rentalPayment landOwners ledger rentalDue   createdAt updatedAt"
        )
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Media.countDocuments(filter),
    ]);

    const mediaListData = results.map((media) => {
      const mediaObj = media.toObject();

      // Process ledger - get latest entry per landOwner
      let latestLedger = [];
      if (Array.isArray(mediaObj.ledger) && mediaObj.ledger.length > 0) {
        const sortedLedger = [...mediaObj.ledger].sort(
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

      // Process rentalDueEntries - sort by ownerApprovalDate (most recent first)
      let rentalDueEntriesWithApproval = [];
      if (Array.isArray(mediaObj.rentalDueEntries) && mediaObj.rentalDueEntries.length > 0) {
        const sortedEntries = [...mediaObj.rentalDueEntries].sort((a, b) => {
          const dateA = a.ownerApprovalDate ? new Date(a.ownerApprovalDate) : new Date(0);
          const dateB = b.ownerApprovalDate ? new Date(b.ownerApprovalDate) : new Date(0);
          return dateB - dateA; // Most recent first
        });

        rentalDueEntriesWithApproval = sortedEntries
          .filter(due => due.ownerApprovalDate)
          .map(due => ({
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
            createdAt: due.createdAt
          }));
      }

      // Process rentalDue - sort by ownerApprovalDate (most recent first)
      let rentalDueWithApproval = [];
      if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
        const sortedDue = [...mediaObj.rentalDue].sort((a, b) => {
          const dateA = a.ownerApprovalDate ? new Date(a.ownerApprovalDate) : new Date(0);
          const dateB = b.ownerApprovalDate ? new Date(b.ownerApprovalDate) : new Date(0);
          return dateB - dateA; // Most recent first
        });

        rentalDueWithApproval = sortedDue
          .filter(due => due.ownerApprovalDate)
          .map(due => ({
            _id: due._id,
            ownerApprovalDate: due.ownerApprovalDate,
            dueMonth: due.dueMonth,
            
          }));
      }

      return {
        ...mediaObj,
        ledger: latestLedger,
        rentalDue: rentalDueWithApproval,
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