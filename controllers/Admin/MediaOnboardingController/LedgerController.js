// const mongoose = require("mongoose");
// const { successResponse, errorResponse } = require("../../../utils/response");
// const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema"); // adjust path to wherever MediaSchema.js actually lives in your project
// // const nowIST = require("../../../utils/updatedAt")
// const IST_OFFSET_MS = 330 * 60000; // 5h30m

// const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
// const MONTH_NAMES = [
//   "January",
//   "February",
//   "March",
//   "April",
//   "May",
//   "June",
//   "July",
//   "August",
//   "September",
//   "October",
//   "November",
//   "December",
// ];

// function getYearAndMonthName(date) {
//   const d = new Date(date);
//   return {
//     year: String(d.getFullYear()),
//     month: MONTH_NAMES[d.getMonth()],
//   };
// }
// function getCurrentCycle(nextBillingDate) {
//   if (!nextBillingDate) return null;
//   const d = new Date(nextBillingDate);
//   if (Number.isNaN(d.getTime())) return null;
//   d.setHours(0, 0, 0, 0);
//   return d;
// }

// // Simple human-readable date formatter, e.g. "July 12, 2026"
// function formatDate(date) {
//   if (!date) return "";
//   const d = new Date(date);
//   if (Number.isNaN(d.getTime())) return "";
//   return d.toLocaleDateString("en-US", {
//     year: "numeric",
//     month: "long",
//     day: "numeric",
//   });
// }
// function advanceRentalPaymentOnOwnerApproval(media) {
//   const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
//   const frequency = media.rentalPayment?.paymentFrequency;
//   const monthsToAdd = FREQUENCY_MONTHS_MAP[frequency] || 1;

//   const baseDate = currentNextBillingDate
//     ? new Date(currentNextBillingDate)
//     : new Date();

//   media.rentalPayment.lastBillPaidDate = baseDate;
//   media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);

//   // reset live agreement verification flags for the new cycle
//   media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
//   media.markModified("agreementDocVerified");

//   // ✅ NEW — reset ledger immediately when the cycle rolls over, instead
//   // of waiting for the next createLedgerEntry call. The old cycle's
//   // entries are already safely preserved in ledgerHistory, so nothing
//   // is lost — this just makes `ledger` empty right away for the new
//   // cycle that just opened.
//   if (Array.isArray(media.ledger) && media.ledger.length > 0) {
//     media.ledger = [];
//     media.markModified("ledger");
//   }
// }const normalizeDate = (d) => {
//   if (!d) return "";
//   const dt = new Date(d);
//   return Number.isNaN(dt.getTime()) ? String(d) : dt.toISOString().slice(0, 10);
// };
// exports.createLedgerEntry = async (req, res) => {
//   try {
//     const { mediaId, entries } = req.body;

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

//     // ── Validate entries array ──
//     if (!Array.isArray(entries) || entries.length === 0) {
//       return errorResponse(
//         res,
//         "entries array is required and must not be empty",
//         null,
//         400,
//       );
//     }

//     // ── Validate every entry — utrNumber, landOwnerId, withGst, month
//     // are ALL now validated PER ENTRY, not once at the top level ──
//     for (let i = 0; i < entries.length; i++) {
//       const item = entries[i];

//       // if (!item.utrNumber) {
//       //   return errorResponse(
//       //     res,
//       //     `entries[${i}].utrNumber is required`,
//       //     null,
//       //     400,
//       //   );
//       // }

//       // ✅ withGst now validated per entry
//       if (item.withGst === undefined || item.withGst === null) {
//         return errorResponse(
//           res,
//           `entries[${i}].withGst is required`,
//           null,
//           400,
//         );
//       }

//       if (typeof item.withGst !== "number" || item.withGst < 0) {
//         return errorResponse(
//           res,
//           `entries[${i}].withGst must be a positive number`,
//           null,
//           400,
//         );
//       }

//       // ✅ month now validated per entry
//       if (item.withGst !== 2) {
//         if (!item.month) {
//           return errorResponse(
//             res,
//             `entries[${i}].month is required when withGst is not 2`,
//             null,
//             400,
//           );
//         }
//       } else {
//         // If withGst is 2, month is not needed - set to null
//         item.month = null;
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
//       if (item.rentalDueId) {
//         if (!mongoose.Types.ObjectId.isValid(item.rentalDueId)) {
//           return errorResponse(
//             res,
//             `entries[${i}].rentalDueId is not a valid ObjectId`,
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
//    const dedupeIncomingEntries = (rawEntries) => {
//       const map = new Map();
//       rawEntries.forEach((item) => {
//         const key =
//           item.withGst === 2
//             ? `2_${String(item.landOwnerId || "")}_${String(item.utrNumber || "")}_${normalizeDate(item.date)}`
//             : `1_${String(item.landOwnerId || "")}_${String(item.rentalDueId || "")}_${String(item.utrNumber || "")}_${normalizeDate(item.date)}`;
//         map.set(key, item);
//       });
//       return Array.from(map.values());
//     };

//     const dedupedEntries = dedupeIncomingEntries(entries);
//     const savedLedgerEntries = [];
//     const historyBuckets = [];
//     const updatedGstBalanceRecords = [];
//     // 1. Build + push a ledger entry AND its history bucket entry for EACH item
//     // for (const item of entries) {
//     //   const entryDate = item.date ? new Date(item.date) : new Date();

//     //   // Look up the matched land owner again (to pull name + auto-fill it)
//     //   const matchedOwner = item.landOwnerId
//     //     ? media.landOwners.id(item.landOwnerId)
//     //     : null;

//     //   const ledgerEntry = {
//     //     landOwnerId: matchedOwner ? matchedOwner._id : null,
//     //     landOwnerName: matchedOwner ? matchedOwner.name : "",
//     //     utrNumber: item.utrNumber,
//     //     date: entryDate,
//     //     status: 1,
//     //     cycle: currentCycle,
//     //     updatedBy: req.user?.userName || "Admin",
//     //     updatedAt: nowIST(),
//     //     // ✅ FIXED — withGst/month now come from THIS entry, not a
//     //     // shared top-level value applied to all entries.
//     //     withGst: item.withGst,
//     //     month: item.month,
//     //     rentalDueId: item.rentalDueId || null,
//     //   };

//     //   media.ledger.push(ledgerEntry);
//     //   const savedLedgerEntry = media.ledger[media.ledger.length - 1];
//     //   savedLedgerEntries.push(savedLedgerEntry);
//     //   if (item.rentalDueId) {
//     //     const matchingGstRecords = media.gstBalanceHistory.filter(
//     //       (g) => String(g.rentalDueId) === String(item.rentalDueId),
//     //     );

//     //     matchingGstRecords.forEach((g) => {
//     //       g.utrNumber = item.utrNumber;
//     //       g.date = entryDate;
//     //       updatedGstBalanceRecords.push(g);
//     //     });

//     //     if (matchingGstRecords.length > 0) {
//     //       media.markModified("gstBalanceHistory");
//     //     }
//     //   }
//     //   // 2. Auto-bucket into ledgerHistory: year -> month -> entries
//     //   const { year, month: monthName } = getYearAndMonthName(entryDate);

//     //   let yearBucket = media.ledgerHistory.find((y) => y.year === year);
//     //   if (!yearBucket) {
//     //     media.ledgerHistory.push({ year, months: [] });
//     //     yearBucket = media.ledgerHistory[media.ledgerHistory.length - 1];
//     //   }

//     //   let monthBucket = yearBucket.months.find((m) => m.month === monthName);
//     //   if (!monthBucket) {
//     //     yearBucket.months.push({ month: monthName, entries: [] });
//     //     monthBucket = yearBucket.months[yearBucket.months.length - 1];
//     //   }

//     //   monthBucket.entries.push({
//     //     landOwnerId: matchedOwner ? matchedOwner._id : null,
//     //     landOwnerName: matchedOwner ? matchedOwner.name : "",
//     //     mediaName: media.mediaName,
//     //     paymentFrequency: media.rentalPayment.paymentFrequency,
//     //     netPayable: media.rentalPayment.netPayable,
//     //     nextBillingDate: media.rentalPayment.nextBillingDate,
//     //     utrNumber: savedLedgerEntry.utrNumber,
//     //     date: savedLedgerEntry.date,
//     //     updatedBy: req.user?.userName || "Admin",
//     //     updatedAt: nowIST(),
//     //     // ✅ FIXED — per-entry values here too
//     //     withGst: item.withGst,
//     //     month: item.month,
//     //     rentalDueId: item.rentalDueId || null,
//     //   });

//     //   historyBuckets.push({ year, month: monthName });
//     // }
//     for (const item of dedupedEntries) {
//       const entryDate = item.date ? new Date(item.date) : new Date();

//       const matchedOwner = item.landOwnerId
//         ? media.landOwners.id(item.landOwnerId)
//         : null;

//       const ledgerEntryData = {
//         landOwnerId: matchedOwner ? matchedOwner._id : null,
//         landOwnerName: matchedOwner ? matchedOwner.name : "",
//         utrNumber: item.utrNumber,
//         date: entryDate,
//         status: 1,
//         cycle: currentCycle,
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//         withGst: item.withGst,
//         month: item.month,
//         rentalDueId: item.rentalDueId || null,
//       };

//       // ── LIVE ledger: find-and-update-in-place ──
//       // withGst === 2        -> unique per landOwnerId
//       // withGst !== 2 (i.e.1)-> unique per landOwnerId + rentalDueId
//       const existingEntry = media.ledger.find((entry) => {
//         if (entry.withGst !== item.withGst) return false;

//         const sameOwner =
//           String(entry.landOwnerId || "") ===
//           String(ledgerEntryData.landOwnerId || "");

//         if (!sameOwner) return false;

//         return (
//           String(entry.utrNumber || "") ===
//             String(ledgerEntryData.utrNumber || "") &&
//           normalizeDate(entry.date) === normalizeDate(ledgerEntryData.date)
//         );
//       });

//       let savedLedgerEntry;
//       if (existingEntry) {
//         Object.assign(existingEntry, ledgerEntryData);
//         savedLedgerEntry = existingEntry;
//         media.markModified("ledger");
//       } else {
//         media.ledger.push(ledgerEntryData);
//         savedLedgerEntry = media.ledger[media.ledger.length - 1];
//       }
//       savedLedgerEntries.push(savedLedgerEntry);

//       if (item.rentalDueId) {
//         const matchingGstRecords = media.gstBalanceHistory.filter(
//           (g) => String(g.rentalDueId) === String(item.rentalDueId),
//         );

//         matchingGstRecords.forEach((g) => {
//           g.utrNumber = item.utrNumber;
//           g.date = entryDate;
//           updatedGstBalanceRecords.push(g);
//         });

//         if (matchingGstRecords.length > 0) {
//           media.markModified("gstBalanceHistory");
//         }
//       }

//       // ── PERMANENT ledgerHistory: always append, never dedupe here ──
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
//         withGst: item.withGst,
//         month: item.month,
//         rentalDueId: item.rentalDueId || null,
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
//         updatedGstBalanceRecords, // ✅ shows which GST records got tagged with utrNumber/date
//         gstBalanceHistory: media.gstBalanceHistory,
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
//           $elemMatch: { status: 1 },
//         };
//       } else if (statusNum === 0) {
//         filter.$or = [
//           { ledger: { $exists: false } },
//           { ledger: { $size: 0 } },
//           { "ledger.status": 0 },
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
//             {
//               "rentalDue.dueDate": {
//                 $gte: startDate,
//                 $lte: endDate,
//               },
//             },
//             {
//               ledgerHistory: {
//                 $elemMatch: {
//                   year: String(startDate.getUTCFullYear()),
//                   months: {
//                     $elemMatch: {
//                       month: [
//                         "January", "February", "March", "April", "May", "June",
//                         "July", "August", "September", "October", "November", "December",
//                       ][startDate.getUTCMonth()],
//                     },
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

//     const [results, totalCount] = await Promise.all([
//       Media.find(filter)
//         .select(
//           "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory landOwners ledger ledgerHistory rentalDue createdAt updatedAt",
//         )
//         .sort({ updatedAt: -1 })
//         .skip(skip)
//         .limit(pageSize),
//       Media.countDocuments(filter),
//     ]);

//     const mediaListData = results.map((media) => {
//       const mediaObj = media.toObject();

//       const inRequestedMonth = (date) => {
//         if (!requestedMonthRange || !date) return true;
//         const d = new Date(date);
//         return (
//           d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
//         );
//       };

//       const dedupeLedgerEntries = (entries, useRentalDueId) => {
//         const sorted = [...entries].sort(
//           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//         );
//         const seen = new Set();
//         const deduped = [];

//          for (const entry of sorted) {
//           const key = useRentalDueId
//             ? `${String(entry.landOwnerId || "")}_${String(entry.rentalDueId || "")}_${String(entry.utrNumber || "")}_${normalizeDate(entry.date)}`
//             : `${String(entry.landOwnerId || "")}_${String(entry.utrNumber || "")}_${normalizeDate(entry.date)}`;

//           if (!seen.has(key)) {
//             seen.add(key);
//             deduped.push(entry);
//           }
//         }
//         return deduped;
//       };

//       // ── ALWAYS sourced from ledgerHistory whenever a month filter is
//       // applied — this correctly covers the current/live month too,
//       // since createLedgerEntry writes every entry into ledgerHistory
//       // immediately, regardless of billing-cycle state. No live-vs-
//       // history branching is needed for "is this month current or past."
//       let sourceEntries;

//       if (requestedMonthRange) {
//         const monthNames = [
//           "January", "February", "March", "April", "May", "June",
//           "July", "August", "September", "October", "November", "December",
//         ];
//         const requestedMonthName =
//           monthNames[requestedMonthRange.startDate.getUTCMonth()];
//         const requestedYear = String(
//           requestedMonthRange.startDate.getUTCFullYear(),
//         );

//         const yearBucket = (mediaObj.ledgerHistory || []).find(
//           (y) => y.year === requestedYear,
//         );
//         const monthBucket = yearBucket?.months.find(
//           (m) => m.month === requestedMonthName,
//         );

//         sourceEntries = monthBucket?.entries || [];
//       } else {
//         sourceEntries = mediaObj.ledger || [];
//       }

//       let latestLedger = [];
//       let withGst1Ledger = [];

//       if (sourceEntries.length > 0) {
//         const monthScopedLedger = requestedMonthRange
//           ? sourceEntries
//           : sourceEntries.filter((entry) => inRequestedMonth(entry.date));

//         const gst2Entries = monthScopedLedger.filter(
//           (entry) => entry.withGst === 2,
//         );
//         const gst1Entries = monthScopedLedger.filter(
//           (entry) => entry.withGst === 1,
//         );

//         // For GST2: deduplicate using multiple fields to keep unique entries
//         const dedupedGst2 = dedupeLedgerEntries(gst2Entries, false);
//         latestLedger = dedupedGst2.slice(0, 2);

//         // For GST1: deduplicate by rentalDueId
//         const dedupedGst1 = dedupeLedgerEntries(gst1Entries, true);
//         withGst1Ledger = dedupedGst1.slice(0, 2);
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
//       let gstPayment = false;
//       if (fullGstBalanceHistory.length > 0) {
//         const hasEmptyUtr = fullGstBalanceHistory.some(
//           (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
//         );
//         gstPayment = hasEmptyUtr;
//       }

//       const { ledgerHistory, ...restOfMediaObj } = mediaObj;

//       return {
//         ...restOfMediaObj,
//         ledger: latestLedger,
//         withGst1Ledger: withGst1Ledger,
//         rentalDue: rentalDueWithApproval,
//         gstPayment: gstPayment,
//         gstBalanceHistory: fullGstBalanceHistory,
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

// exports.getLedgerHistory = async (req, res) => {
//   try {
//     const { mediaId, year, month } = req.query;

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     // Use .lean() to get plain JSON objects
//     const media = await Media.findById(mediaId)
//       .select(
//         "mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners gstBalanceHistory",
//       )
//       .lean();

//     if (!media) {
//       return errorResponse(res, "Media not found for given mediaId", null, 404);
//     }

//     let ledgerHistory = media.ledgerHistory || [];

//     // Filter by Year
//     if (year) {
//       ledgerHistory = ledgerHistory.filter(
//         (item) => item.year === String(year),
//       );
//     }

//     // Filter by Month
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

//     // ✅ Calculate gstPayment flag (same logic as list API)
//     const fullGstBalanceHistory = Array.isArray(media.gstBalanceHistory)
//       ? media.gstBalanceHistory
//       : [];
//     let gstPayment = false;
//     if (fullGstBalanceHistory.length > 0) {
//       const hasEmptyUtr = fullGstBalanceHistory.some(
//         (entry) => !entry.utrNumber || entry.utrNumber.trim() === ""
//       );
//       gstPayment = hasEmptyUtr;
//     }

//     const dedupeByRentalDueId = (entries, type = 'all') => {
//       const sorted = [...entries].sort(
//         (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//       );
//       const seen = new Set();
//       const deduped = [];

//       for (const entry of sorted) {
//         let key;
//         if (type === 'gst1') {
//           key = `${entry.rentalDueId ? `rd_${String(entry.rentalDueId)}` : `owner_${String(entry.landOwnerId || "")}`}_${String(entry.utrNumber || "")}_${normalizeDate(entry.date)}`;
//         } else if (type === 'gst2') {
//           key = `owner_${String(entry.landOwnerId || "")}_${String(entry.utrNumber || "")}_${normalizeDate(entry.date)}`;
//         } else {
//           key = entry.rentalDueId
//             ? `rd_${String(entry.rentalDueId)}`
//             : `owner_${String(entry.landOwnerId || "")}`;
//         }

//         if (!seen.has(key)) {
//           seen.add(key);
//           deduped.push(entry);
//         }
//       }
//       return deduped;
//     };

//     const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
//       ...yearEntry,
//       months: yearEntry.months.map((monthEntry) => {
//         const allEntries = monthEntry.entries || [];

//         const withGst2Entries = allEntries.filter((entry) => entry.withGst === 2);
//         const withGst1Entries = allEntries.filter((entry) => entry.withGst === 1);

//         const sortByUpdatedAt = (entries) =>
//           [...entries].sort(
//             (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//           );

//         // For GST2: deduplicate using multiple fields
//         const dedupedGst2 = dedupeByRentalDueId(withGst2Entries, 'gst2');
//         const latestTwoGst2 = dedupedGst2.slice(0, 2);

//         // For GST1: deduplicate by rentalDueId
//         const dedupedGst1 = dedupeByRentalDueId(withGst1Entries, 'gst1');
//         const latestTwoGst1 = dedupedGst1.slice(0, 2);

//         return {
//           month: monthEntry.month,

//           ledger: latestTwoGst2.map((entry) => ({
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             nextBillingDate: entry.nextBillingDate,
//           })),

//           withGst1Ledger: latestTwoGst1.map((entry) => ({
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             nextBillingDate: entry.nextBillingDate,
//           })),

//           // ✅ UNCHANGED — full permanent history, never deduped
//           allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
//             ...entry,
//             mediaName: media.mediaName,
//           })),
//         };
//       }),
//     }));

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
//         currentRentalPayment: {
//           paymentFrequency: media.rentalPayment.paymentFrequency,
//           netPayable: media.rentalPayment.netPayable,
//           nextBillingDate: media.rentalPayment.nextBillingDate,
//         },
//         ledgerHistory: transformedLedgerHistory,
//         gstBalanceHistory: media.gstBalanceHistory,
//         gstPayment: gstPayment,
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

// // exports.listMediaByLedger = async (req, res) => {
// //   try {
// //     const {
// //       pageNumber = 1,
// //       count = 10,
// //       search,
// //       status,
// //       dateRange,
// //       currentMonth,
// //     } = req.body;

// //     const pageNumbers = parseInt(pageNumber) || 1;
// //     const pageSize = parseInt(count) || 10;

// //     const filter = {};
// //     filter.rentalStatus = 3;
// //     if (search) {
// //       filter.mediaName = { $regex: search, $options: "i" };
// //     }

// //     if (status !== undefined && status !== null && status !== "") {
// //       const statusNum = Number(status);
// //       if (![0, 1].includes(statusNum)) {
// //         return errorResponse(
// //           res,
// //           "status must be one of 0 (Not approve), 1 (Approve)",
// //           null,
// //           400,
// //         );
// //       }

// //       if (statusNum === 1) {
// //         filter["ledger"] = {
// //           $exists: true,
// //           $not: { $size: 0 },
// //           $elemMatch: { status: 1 },
// //         };
// //       } else if (statusNum === 0) {
// //         filter.$or = [
// //           { ledger: { $exists: false } },
// //           { ledger: { $size: 0 } },
// //           { "ledger.status": 0 },
// //         ];
// //       }
// //     }

// //     const validateMonthYear = (monthYear) => {
// //       const regex = /^(0[1-9]|1[0-2])-([0-9]{4})$/;
// //       return regex.test(monthYear);
// //     };

// //     const getMonthDateRange = (monthYear) => {
// //       const [month, year] = monthYear.split("-").map(Number);
// //       const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
// //       const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
// //       return { startDate, endDate };
// //     };

// //     let requestedMonthRange = null;

// //     const applyDateFilter = (monthYear, filterObj) => {
// //       if (!validateMonthYear(monthYear)) {
// //         throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
// //       }
// //       const { startDate, endDate } = getMonthDateRange(monthYear);
// //       requestedMonthRange = { startDate, endDate };

// //       filterObj.$and = [
// //         ...(filterObj.$and || []),
// //         {
// //           $or: [
// //             {
// //               "rentalPayment.lastBillPaidDate": {
// //                 $gte: startDate,
// //                 $lte: endDate,
// //               },
// //             },
// //             {
// //               "rentalDue.dueDate": {
// //                 $gte: startDate,
// //                 $lte: endDate,
// //               },
// //             },
// //             // ✅ Also match if the site's ledgerHistory already has a
// //             // bucket for this year/month — covers BOTH past cycles
// //             // (live cycle already advanced) AND the current/live month
// //             // (a fresh manual entry was just created for it).
// //             {
// //               ledgerHistory: {
// //                 $elemMatch: {
// //                   year: String(startDate.getUTCFullYear()),
// //                   months: {
// //                     $elemMatch: {
// //                       month: [
// //                         "January", "February", "March", "April", "May", "June",
// //                         "July", "August", "September", "October", "November", "December",
// //                       ][startDate.getUTCMonth()],
// //                     },
// //                   },
// //                 },
// //               },
// //             },
// //           ],
// //         },
// //       ];
// //       return filterObj;
// //     };

// //     if (dateRange) {
// //       try {
// //         applyDateFilter(dateRange, filter);
// //       } catch (error) {
// //         return errorResponse(res, error.message, null, 400);
// //       }
// //     }

// //     if (currentMonth) {
// //       try {
// //         applyDateFilter(currentMonth, filter);
// //       } catch (error) {
// //         return errorResponse(res, error.message, null, 400);
// //       }
// //     }

// //     const skip = (pageNumbers - 1) * pageSize;

// //     const [results, totalCount] = await Promise.all([
// //       Media.find(filter)
// //         .select(
// //           "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory landOwners ledger ledgerHistory rentalDue createdAt updatedAt",
// //         )
// //         .sort({ updatedAt: -1 })
// //         .skip(skip)
// //         .limit(pageSize),
// //       Media.countDocuments(filter),
// //     ]);

// //     const mediaListData = results.map((media) => {
// //       const mediaObj = media.toObject();

// //       const inRequestedMonth = (date) => {
// //         if (!requestedMonthRange || !date) return true;
// //         const d = new Date(date);
// //         return (
// //           d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
// //         );
// //       };

// //       const dedupeLedgerEntries = (entries, useRentalDueId) => {
// //         const sorted = [...entries].sort(
// //           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
// //         );
// //         const seen = new Set();
// //         const deduped = [];

// //         for (const entry of sorted) {
// //           const key = useRentalDueId
// //             ? `${String(entry.landOwnerId || "")}_${String(entry.rentalDueId || "")}`
// //             : String(entry.landOwnerId || "");

// //           if (!seen.has(key)) {
// //             seen.add(key);
// //             deduped.push(entry);
// //           }
// //         }
// //         return deduped;
// //       };

// //       // ── ALWAYS sourced from ledgerHistory whenever a month filter is
// //       // applied — this correctly covers the current/live month too,
// //       // since createLedgerEntry writes every entry into ledgerHistory
// //       // immediately, regardless of billing-cycle state. No live-vs-
// //       // history branching is needed for "is this month current or past."
// //       let sourceEntries;

// //       if (requestedMonthRange) {
// //         const monthNames = [
// //           "January", "February", "March", "April", "May", "June",
// //           "July", "August", "September", "October", "November", "December",
// //         ];
// //         const requestedMonthName =
// //           monthNames[requestedMonthRange.startDate.getUTCMonth()];
// //         const requestedYear = String(
// //           requestedMonthRange.startDate.getUTCFullYear(),
// //         );

// //         const yearBucket = (mediaObj.ledgerHistory || []).find(
// //           (y) => y.year === requestedYear,
// //         );
// //         const monthBucket = yearBucket?.months.find(
// //           (m) => m.month === requestedMonthName,
// //         );

// //         sourceEntries = monthBucket?.entries || [];
// //       } else {
// //         sourceEntries = mediaObj.ledger || [];
// //       }

// //       let latestLedger = [];
// //       let withGst1Ledger = [];

// //       if (sourceEntries.length > 0) {
// //         const monthScopedLedger = requestedMonthRange
// //           ? sourceEntries
// //           : sourceEntries.filter((entry) => inRequestedMonth(entry.date));

// //         const gst2Entries = monthScopedLedger.filter(
// //           (entry) => entry.withGst === 2,
// //         );
// //         const gst1Entries = monthScopedLedger.filter(
// //           (entry) => entry.withGst === 1,
// //         );

// //         const dedupedGst2 = dedupeLedgerEntries(gst2Entries, false);
// //         latestLedger = dedupedGst2.slice(0, 2);

// //         const dedupedGst1 = dedupeLedgerEntries(gst1Entries, true);
// //         withGst1Ledger = dedupedGst1.slice(0, 2);
// //       }

// //       let rentalDueWithApproval = [];
// //       if (Array.isArray(mediaObj.rentalDue) && mediaObj.rentalDue.length > 0) {
// //         const monthScopedDue = mediaObj.rentalDue.filter((due) =>
// //           inRequestedMonth(due.dueDate),
// //         );

// //         const sortedDue = [...monthScopedDue].sort((a, b) => {
// //           const dateA = a.ownerApprovalDate
// //             ? new Date(a.ownerApprovalDate)
// //             : new Date(0);
// //           const dateB = b.ownerApprovalDate
// //             ? new Date(b.ownerApprovalDate)
// //             : new Date(0);
// //           return dateB - dateA;
// //         });

// //         rentalDueWithApproval = sortedDue
// //           .filter((due) => due.ownerApprovalDate)
// //           .map((due) => ({
// //             _id: due._id,
// //             ownerApprovalDate: due.ownerApprovalDate,
// //             dueMonth: due.dueMonth,
// //             dueDate: due.dueDate,
// //             netPayable: due.netPayable,
// //             approvalStatus: due.approvalStatus,
// //             withGst: due.withGst,
// //             gstAmount: due.gstAmount,
// //             baseAmount: due.baseAmount,
// //             paymentFrequency: due.paymentFrequency,
// //             campaignName: due.campaignName,
// //             status: due.status,
// //             updatedAt: due.updatedAt,
// //             createdAt: due.createdAt,
// //           }));
// //       }

// //       const fullGstBalanceHistory = Array.isArray(mediaObj.gstBalanceHistory)
// //         ? mediaObj.gstBalanceHistory
// //         : [];
// //       let gstPayment = false;
// //       if (fullGstBalanceHistory.length > 0) {
// //         const hasEmptyUtr = fullGstBalanceHistory.some(
// //           (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
// //         );
// //         gstPayment = hasEmptyUtr;
// //       }

// //       const { ledgerHistory, ...restOfMediaObj } = mediaObj;

// //       return {
// //         ...restOfMediaObj,
// //         ledger: latestLedger,
// //         withGst1Ledger: withGst1Ledger,
// //         rentalDue: rentalDueWithApproval,
// //         gstPayment: gstPayment,
// //         gstBalanceHistory: fullGstBalanceHistory,
// //       };
// //     });

// //     return successResponse(
// //       res,
// //       "Media list fetched successfully",
// //       {
// //         pageNumber: pageNumbers,
// //         count: pageSize,
// //         totalCount,
// //         totalPages: Math.ceil(totalCount / pageSize),
// //         mediaList: mediaListData,
// //       },
// //       200,
// //     );
// //   } catch (error) {
// //     console.error("listMediaByLedger error:", error);
// //     return errorResponse(
// //       res,
// //       "Something went wrong while fetching media list",
// //       { error: error.message },
// //       500,
// //     );
// //   }
// // };

// // exports.getLedgerHistory = async (req, res) => {
// //   try {
// //     const { mediaId, year, month } = req.query;

// //     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
// //       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
// //     }

// //     // Use .lean() to get plain JSON objects
// //     const media = await Media.findById(mediaId)
// //       .select(
// //         "mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners gstBalanceHistory",
// //       )
// //       .lean();

// //     if (!media) {
// //       return errorResponse(res, "Media not found for given mediaId", null, 404);
// //     }

// //     let ledgerHistory = media.ledgerHistory || [];

// //     // Filter by Year
// //     if (year) {
// //       ledgerHistory = ledgerHistory.filter(
// //         (item) => item.year === String(year),
// //       );
// //     }

// //     // Filter by Month
// //     if (month) {
// //       const monthNames = [
// //         "January",
// //         "February",
// //         "March",
// //         "April",
// //         "May",
// //         "June",
// //         "July",
// //         "August",
// //         "September",
// //         "October",
// //         "November",
// //         "December",
// //       ];

// //       const monthName = monthNames[Number(month) - 1];

// //       ledgerHistory = ledgerHistory
// //         .map((item) => ({
// //           ...item,
// //           months: item.months.filter(
// //             (m) => m.month.toLowerCase() === monthName.toLowerCase(),
// //           ),
// //         }))
// //         .filter((item) => item.months.length > 0);
// //     }

// //     // ✅ Calculate gstPayment flag (same logic as list API)
// //     const fullGstBalanceHistory = Array.isArray(media.gstBalanceHistory)
// //       ? media.gstBalanceHistory
// //       : [];
// //     let gstPayment = false;
// //     if (fullGstBalanceHistory.length > 0) {
// //       const hasEmptyUtr = fullGstBalanceHistory.some(
// //         (entry) => !entry.utrNumber || entry.utrNumber.trim() === ""
// //       );
// //       gstPayment = hasEmptyUtr;
// //     }
// //   const dedupeByRentalDueId = (entries) => {
// //       const sorted = [...entries].sort(
// //         (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
// //       );
// //       const seen = new Set();
// //       const deduped = [];

// //       for (const entry of sorted) {
// //         const key = entry.rentalDueId
// //           ? `rd_${String(entry.rentalDueId)}`
// //           : `owner_${String(entry.landOwnerId || "")}`;

// //         if (!seen.has(key)) {
// //           seen.add(key);
// //           deduped.push(entry);
// //         }
// //       }
// //       return deduped;
// //     };
// // const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
// //   ...yearEntry,
// //   months: yearEntry.months.map((monthEntry) => {
// //     const allEntries = monthEntry.entries || [];

// //     const withGst2Entries = allEntries.filter((entry) => entry.withGst === 2);
// //     const withGst1Entries = allEntries.filter((entry) => entry.withGst === 1);

// //     const sortByUpdatedAt = (entries) =>
// //       [...entries].sort(
// //         (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
// //       );

// //     const dedupedGst2 = dedupeByRentalDueId(withGst2Entries);
// //     const latestTwoGst2 = dedupedGst2.slice(0, 2);

// //     const dedupedGst1 = dedupeByRentalDueId(withGst1Entries);
// //     const latestTwoGst1 = dedupedGst1.slice(0, 2);

// //     return {
// //       month: monthEntry.month,

// //       ledger: latestTwoGst2.map((entry) => ({
// //         landOwnerId: entry.landOwnerId,
// //         landOwnerName: entry.landOwnerName,
// //         utrNumber: entry.utrNumber,
// //         date: entry.date,
// //         status: entry.status,
// //         withGst: entry.withGst,
// //         month: entry.month,
// //         cycle: entry.cycle,
// //         rentalDueId: entry.rentalDueId,
// //         updatedBy: entry.updatedBy,
// //         updatedAt: entry.updatedAt,
// //         _id: entry._id,
// //         mediaName: media.mediaName,
// //         paymentFrequency: entry.paymentFrequency,
// //         netPayable: entry.netPayable,
// //         nextBillingDate: entry.nextBillingDate,
// //       })),

// //       withGst1Ledger: latestTwoGst1.map((entry) => ({
// //         landOwnerId: entry.landOwnerId,
// //         landOwnerName: entry.landOwnerName,
// //         utrNumber: entry.utrNumber,
// //         date: entry.date,
// //         status: entry.status,
// //         withGst: entry.withGst,
// //         month: entry.month,
// //         cycle: entry.cycle,
// //         rentalDueId: entry.rentalDueId,
// //         updatedBy: entry.updatedBy,
// //         updatedAt: entry.updatedAt,
// //         _id: entry._id,
// //         mediaName: media.mediaName,
// //         paymentFrequency: entry.paymentFrequency,
// //         netPayable: entry.netPayable,
// //         nextBillingDate: entry.nextBillingDate,
// //       })),

// //       // ✅ UNCHANGED — full permanent history, never deduped
// //       allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
// //         ...entry,
// //         mediaName: media.mediaName,
// //       })),
// //     };
// //   }),
// // }));
// //     return successResponse(
// //       res,
// //       "Ledger history fetched successfully",
// //       {
// //         mediaId: media._id,
// //         mediaName: media.mediaName,
// //         mediaType: media.mediaType,
// //         mediaCode: media.mediaCode,
// //         city: media.city,
// //         rentalPayment: media.rentalPayment,
// //         landOwners: media.landOwners,
// //         currentRentalPayment: {
// //           paymentFrequency: media.rentalPayment.paymentFrequency,
// //           netPayable: media.rentalPayment.netPayable,
// //           nextBillingDate: media.rentalPayment.nextBillingDate,
// //         },
// //         ledgerHistory: transformedLedgerHistory,
// //         gstBalanceHistory: media.gstBalanceHistory,
// //         gstPayment: gstPayment,
// //       },
// //       200,
// //     );
// //   } catch (error) {
// //     console.error("getLedgerHistory error:", error);

// //     return errorResponse(
// //       res,
// //       "Something went wrong while fetching ledger history",
// //       { error: error.message },
// //       500,
// //     );
// //   }
// // };


// const mongoose = require("mongoose");
// const { successResponse, errorResponse } = require("../../../utils/response");
// const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema"); // adjust path to wherever MediaSchema.js actually lives in your project
// // const nowIST = require("../../../utils/updatedAt")
// const IST_OFFSET_MS = 330 * 60000; // 5h30m

// const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
// const MONTH_NAMES = [
//   "January",
//   "February",
//   "March",
//   "April",
//   "May",
//   "June",
//   "July",
//   "August",
//   "September",
//   "October",
//   "November",
//   "December",
// ];

// // ── Max slots allowed in the LIVE `media.ledger` array per media ──
// // index 0, 1, 2 => 3 slots total. Saving again with the same index
// // OVERWRITES that slot in place. It never pushes a new element and
// // never touches any other index.
// const MAX_LEDGER_SLOTS = 3;

// function getYearAndMonthName(date) {
//   const d = new Date(date);
//   return {
//     year: String(d.getFullYear()),
//     month: MONTH_NAMES[d.getMonth()],
//   };
// }
// function getCurrentCycle(nextBillingDate) {
//   if (!nextBillingDate) return null;
//   const d = new Date(nextBillingDate);
//   if (Number.isNaN(d.getTime())) return null;
//   d.setHours(0, 0, 0, 0);
//   return d;
// }

// // Simple human-readable date formatter, e.g. "July 12, 2026"
// function formatDate(date) {
//   if (!date) return "";
//   const d = new Date(date);
//   if (Number.isNaN(d.getTime())) return "";
//   return d.toLocaleDateString("en-US", {
//     year: "numeric",
//     month: "long",
//     day: "numeric",
//   });
// }
// function advanceRentalPaymentOnOwnerApproval(media) {
//   const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
//   const frequency = media.rentalPayment?.paymentFrequency;
//   const monthsToAdd = FREQUENCY_MONTHS_MAP[frequency] || 1;

//   const baseDate = currentNextBillingDate
//     ? new Date(currentNextBillingDate)
//     : new Date();

//   media.rentalPayment.lastBillPaidDate = baseDate;
//   media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);

//   // reset live agreement verification flags for the new cycle
//   media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
//   media.markModified("agreementDocVerified");

//   // ✅ reset ledger immediately when the cycle rolls over, instead
//   // of waiting for the next createLedgerEntry call. The old cycle's
//   // entries are already safely preserved in ledgerHistory, so nothing
//   // is lost — this just makes `ledger` empty right away for the new
//   // cycle that just opened.
//   if (Array.isArray(media.ledger) && media.ledger.length > 0) {
//     media.ledger = [];
//     media.markModified("ledger");
//   }
// }

// exports.createLedgerEntry = async (req, res) => {
//   try {
//     const { mediaId, entries } = req.body;

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

//     // ── Validate entries array ──
//     if (!Array.isArray(entries) || entries.length === 0) {
//       return errorResponse(
//         res,
//         "entries array is required and must not be empty",
//         null,
//         400,
//       );
//     }

//     // ✅ The SLOT (0, 1, or 2) an entry updates is derived from its
//     // POSITION in this array — entries[0] -> slot 0, entries[1] ->
//     // slot 1, entries[2] -> slot 2. No explicit `index` field needed
//     // from the client. Max 3 slots total, so reject anything longer.
//     if (entries.length > MAX_LEDGER_SLOTS) {
//       return errorResponse(
//         res,
//         `entries array cannot contain more than ${MAX_LEDGER_SLOTS} items (max ${MAX_LEDGER_SLOTS} ledger slots)`,
//         null,
//         400,
//       );
//     }

//     // ── Validate every entry — utrNumber, landOwnerId, withGst, month
//     // are ALL validated PER ENTRY, not once at the top level ──
//     for (let i = 0; i < entries.length; i++) {
//       const item = entries[i];

//       // if (!item.utrNumber) {
//       //   return errorResponse(
//       //     res,
//       //     `entries[${i}].utrNumber is required`,
//       //     null,
//       //     400,
//       //   );
//       // }

//       // ✅ withGst validated per entry
//       if (item.withGst === undefined || item.withGst === null) {
//         return errorResponse(
//           res,
//           `entries[${i}].withGst is required`,
//           null,
//           400,
//         );
//       }

//       if (typeof item.withGst !== "number" || item.withGst < 0) {
//         return errorResponse(
//           res,
//           `entries[${i}].withGst must be a positive number`,
//           null,
//           400,
//         );
//       }

//       // ✅ month validated per entry
//       if (item.withGst !== 2) {
//         if (!item.month) {
//           return errorResponse(
//             res,
//             `entries[${i}].month is required when withGst is not 2`,
//             null,
//             400,
//           );
//         }
//       } else {
//         // If withGst is 2, month is not needed - set to null
//         item.month = null;
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
//       if (item.rentalDueId) {
//         if (!mongoose.Types.ObjectId.isValid(item.rentalDueId)) {
//           return errorResponse(
//             res,
//             `entries[${i}].rentalDueId is not a valid ObjectId`,
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
//     const updatedGstBalanceRecords = [];

//     for (let i = 0; i < entries.length; i++) {
//       const item = entries[i];
//       const slotIndex = i; // ✅ position in the request array = ledger slot

//       const entryDate = item.date ? new Date(item.date) : new Date();

//       const matchedOwner = item.landOwnerId
//         ? media.landOwners.id(item.landOwnerId)
//         : null;

//       const ledgerEntryData = {
//         landOwnerId: matchedOwner ? matchedOwner._id : null,
//         landOwnerName: matchedOwner ? matchedOwner.name : "",
//         utrNumber: item.utrNumber,
//         date: entryDate,
//         status: 1,
//         cycle: currentCycle,
//         updatedBy: req.user?.userName || "Admin",
//         updatedAt: nowIST(),
//         withGst: item.withGst,
//         month: item.month,
//         rentalDueId: item.rentalDueId || null,
//         index: slotIndex,
//       };

//       // ── LIVE ledger: fixed-slot upsert by array position ──
//       // media.ledger[slotIndex] is OVERWRITTEN in place. No new
//       // element is ever pushed and no other slot is ever touched.
//       // If earlier slots don't exist yet, they're left untouched
//       // (sparse) — only the targeted slot is written.
//       media.ledger[slotIndex] = ledgerEntryData;
//       media.markModified("ledger");

//       const savedLedgerEntry = media.ledger[slotIndex];
//       savedLedgerEntries.push(savedLedgerEntry);

//       if (item.rentalDueId) {
//         const matchingGstRecords = media.gstBalanceHistory.filter(
//           (g) => String(g.rentalDueId) === String(item.rentalDueId),
//         );

//         matchingGstRecords.forEach((g) => {
//           g.utrNumber = item.utrNumber;
//           g.date = entryDate;
//           updatedGstBalanceRecords.push(g);
//         });

//         if (matchingGstRecords.length > 0) {
//           media.markModified("gstBalanceHistory");
//         }
//       }

//       // ── PERMANENT ledgerHistory: always append, never dedupe here ──
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
//         withGst: item.withGst,
//         month: item.month,
//         rentalDueId: item.rentalDueId || null,
//         index: slotIndex,
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
//         updatedGstBalanceRecords, // ✅ shows which GST records got tagged with utrNumber/date
//         gstBalanceHistory: media.gstBalanceHistory,
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
//           $elemMatch: { status: 1 },
//         };
//       } else if (statusNum === 0) {
//         filter.$or = [
//           { ledger: { $exists: false } },
//           { ledger: { $size: 0 } },
//           { "ledger.status": 0 },
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
//             {
//               "rentalDue.dueDate": {
//                 $gte: startDate,
//                 $lte: endDate,
//               },
//             },
//             // ✅ Also match if the site's ledgerHistory already has a
//             // bucket for this year/month — covers BOTH past cycles
//             // (live cycle already advanced) AND the current/live month
//             // (a fresh manual entry was just created for it).
//             {
//               ledgerHistory: {
//                 $elemMatch: {
//                   year: String(startDate.getUTCFullYear()),
//                   months: {
//                     $elemMatch: {
//                       month: [
//                         "January", "February", "March", "April", "May", "June",
//                         "July", "August", "September", "October", "November", "December",
//                       ][startDate.getUTCMonth()],
//                     },
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

//     const [results, totalCount] = await Promise.all([
//       Media.find(filter)
//         .select(
//           "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory landOwners ledger ledgerHistory rentalDue createdAt updatedAt",
//         )
//         .sort({ updatedAt: -1 })
//         .skip(skip)
//         .limit(pageSize),
//       Media.countDocuments(filter),
//     ]);

//     const mediaListData = results.map((media) => {
//       const mediaObj = media.toObject();

//       const inRequestedMonth = (date) => {
//         if (!requestedMonthRange || !date) return true;
//         const d = new Date(date);
//         return (
//           d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
//         );
//       };

//       // ── For the CURRENT calendar month, `ledger`/`withGst1Ledger`
//       // are sourced from the LIVE media.ledger array — same as when no
//       // filter is passed at all. The live array is always the accurate,
//       // max-3-slot "current state" (createLedgerEntry overwrites slots
//       // in place), so there's no need to dedupe anything from history.
//       //
//       // For a PAST month (already closed, no more live updates coming),
//       // there's no live snapshot left, so we fall back to the
//       // ledgerHistory bucket for that month, best-effort deduped.
//       //
//       // Either way, the FULL list of everything saved during the
//       // requested month (including every re-save) is also returned
//       // separately as `monthHistoryEntries`, so nothing is lost.
//       const now = new Date();
//       const isCurrentCalendarMonth =
//         requestedMonthRange &&
//         requestedMonthRange.startDate.getUTCFullYear() === now.getUTCFullYear() &&
//         requestedMonthRange.startDate.getUTCMonth() === now.getUTCMonth();

//       let sourceEntries;
//       let monthHistoryEntries = [];

//       if (requestedMonthRange) {
//         const monthNames = [
//           "January", "February", "March", "April", "May", "June",
//           "July", "August", "September", "October", "November", "December",
//         ];
//         const requestedMonthName =
//           monthNames[requestedMonthRange.startDate.getUTCMonth()];
//         const requestedYear = String(
//           requestedMonthRange.startDate.getUTCFullYear(),
//         );

//         const yearBucket = (mediaObj.ledgerHistory || []).find(
//           (y) => y.year === requestedYear,
//         );
//         const monthBucket = yearBucket?.months.find(
//           (m) => m.month === requestedMonthName,
//         );

//         monthHistoryEntries = [...(monthBucket?.entries || [])].sort(
//           (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//         );

//         if (isCurrentCalendarMonth) {
//           sourceEntries = (mediaObj.ledger || []).filter(Boolean);
//         } else {
//           sourceEntries = monthBucket?.entries || [];
//         }
//       } else {
//         // Live ledger is now a fixed max-3-slot array (indexes 0/1/2),
//         // possibly sparse. Filter out empty/null slots before use.
//         sourceEntries = (mediaObj.ledger || []).filter(Boolean);
//       }

//       // Best-effort dedupe for the PAST-month/ledgerHistory case only.
//       // Falls back to _id, then to array position, so entries can never
//       // silently collapse even if `index`/`_id` are missing on the
//       // stored document.
//       const dedupeLedgerEntries = (entries) => {
//         const withPos = entries.map((entry, pos) => ({ entry, pos }));
//         const sorted = withPos.sort(
//           (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
//         );
//         const seen = new Set();
//         const deduped = [];

//         for (const { entry, pos } of sorted) {
//           const key =
//             entry.index !== undefined && entry.index !== null
//               ? `idx_${entry.index}`
//               : entry._id
//                 ? `id_${String(entry._id)}`
//                 : `pos_${pos}`;

//           if (!seen.has(key)) {
//             seen.add(key);
//             deduped.push(entry);
//           }
//         }
//         return deduped;
//       };

//       let latestLedger = [];
//       let withGst1Ledger = [];

//       if (sourceEntries.length > 0) {
//         const monthScopedLedger = requestedMonthRange
//           ? sourceEntries
//           : sourceEntries.filter((entry) => inRequestedMonth(entry.date));

//         const gst2Entries = monthScopedLedger.filter(
//           (entry) => entry.withGst === 2,
//         );
//         const gst1Entries = monthScopedLedger.filter(
//           (entry) => entry.withGst === 1,
//         );

//         const sourcedFromLiveLedger = !requestedMonthRange || isCurrentCalendarMonth;

//         if (sourcedFromLiveLedger) {
//           // Already the accurate current state — show as-is, no dedupe.
//           const sortByUpdatedAtDesc = (list) =>
//             [...list].sort(
//               (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//             );
//           latestLedger = sortByUpdatedAtDesc(gst2Entries);
//           withGst1Ledger = sortByUpdatedAtDesc(gst1Entries);
//         } else {
//           // Past month sourced from ledgerHistory — dedupe to latest per slot.
//           latestLedger = dedupeLedgerEntries(gst2Entries);
//           withGst1Ledger = dedupeLedgerEntries(gst1Entries);
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
//       let gstPayment = false;
//       if (fullGstBalanceHistory.length > 0) {
//         const hasEmptyUtr = fullGstBalanceHistory.some(
//           (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
//         );
//         gstPayment = hasEmptyUtr;
//       }

//       const { ledgerHistory, ...restOfMediaObj } = mediaObj;

//       return {
//         ...restOfMediaObj,
//         ledger: latestLedger,
//         withGst1Ledger: withGst1Ledger,
//         // ✅ Full, un-deduped list of everything saved for the requested
//         // month (every re-save included) — only populated when
//         // dateRange/currentMonth is passed. `ledger`/`withGst1Ledger`
//         // above stay as the "current state" summary (max 3 slots).
//         monthHistoryEntries: requestedMonthRange ? monthHistoryEntries : undefined,
//         rentalDue: rentalDueWithApproval,
//         gstPayment: gstPayment,
//         gstBalanceHistory: fullGstBalanceHistory,
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



// exports.getLedgerHistory = async (req, res) => {
//   try {
//     const { mediaId, year, month } = req.query;

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     // Use .lean() to get plain JSON objects
//     const media = await Media.findById(mediaId)
//       .select(
//         "mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners gstBalanceHistory",
//       )
//       .lean();

//     if (!media) {
//       return errorResponse(res, "Media not found for given mediaId", null, 404);
//     }

//     let ledgerHistory = media.ledgerHistory || [];

//     // Filter by Year
//     if (year) {
//       ledgerHistory = ledgerHistory.filter(
//         (item) => item.year === String(year),
//       );
//     }

//     // Filter by Month
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

//     // ✅ Calculate gstPayment flag (same logic as list API)
//     const fullGstBalanceHistory = Array.isArray(media.gstBalanceHistory)
//       ? media.gstBalanceHistory
//       : [];
//     let gstPayment = false;
//     if (fullGstBalanceHistory.length > 0) {
//       const hasEmptyUtr = fullGstBalanceHistory.some(
//         (entry) => !entry.utrNumber || entry.utrNumber.trim() === ""
//       );
//       gstPayment = hasEmptyUtr;
//     }

//     // ── Dedupe key is now the fixed ledger SLOT (`index`: 0/1/2),
//     // not rentalDueId/landOwnerId. Falls back to _id, then to the
//     // entry's own array position — a plain array position is always
//     // unique, so entries can never silently collapse even if both
//     // `index` and `_id` are missing from the stored document.
//     const dedupeByIndex = (entries) => {
//       const withPos = entries.map((entry, pos) => ({ entry, pos }));
//       const sorted = withPos.sort(
//         (a, b) => new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt),
//       );
//       const seen = new Set();
//       const deduped = [];

//       for (const { entry, pos } of sorted) {
//         const key =
//           entry.index !== undefined && entry.index !== null
//             ? `idx_${entry.index}`
//             : entry._id
//               ? `id_${String(entry._id)}`
//               : `pos_${pos}`;

//         if (!seen.has(key)) {
//           seen.add(key);
//           deduped.push(entry);
//         }
//       }
//       return deduped;
//     };

//     const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
//       ...yearEntry,
//       months: yearEntry.months.map((monthEntry) => {
//         const allEntries = monthEntry.entries || [];

//         const withGst2Entries = allEntries.filter((entry) => entry.withGst === 2);
//         const withGst1Entries = allEntries.filter((entry) => entry.withGst === 1);

//         const sortByUpdatedAt = (entries) =>
//           [...entries].sort(
//             (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//           );

//         // Each slot (0/1/2) shows only its latest saved state for the month
//         const latestGst2 = dedupeByIndex(withGst2Entries);
//         const latestGst1 = dedupeByIndex(withGst1Entries);

//         return {
//           month: monthEntry.month,

//           ledger: latestGst2.map((entry) => ({
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             index: entry.index,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             nextBillingDate: entry.nextBillingDate,
//           })),

//           withGst1Ledger: latestGst1.map((entry) => ({
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             index: entry.index,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             nextBillingDate: entry.nextBillingDate,
//           })),

//           // ✅ UNCHANGED — full permanent history, never deduped
//           allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
//             ...entry,
//             mediaName: media.mediaName,
//           })),
//         };
//       }),
//     }));

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
//         currentRentalPayment: {
//           paymentFrequency: media.rentalPayment.paymentFrequency,
//           netPayable: media.rentalPayment.netPayable,
//           nextBillingDate: media.rentalPayment.nextBillingDate,
//         },
//         ledgerHistory: transformedLedgerHistory,
//         gstBalanceHistory: media.gstBalanceHistory,
//         gstPayment: gstPayment,
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

// ── Max slots allowed in the LIVE `media.ledger` array (withGst===2 only).
// index 0, 1, 2 => 3 slots total. Saving again with the same index
// OVERWRITES that slot in place. It never pushes a new element and
// never touches any other index.
// `media.withGst1Ledger` (withGst===1) has NO fixed slot cap — it's
// upserted by rentalDueId instead, so it can grow to however many
// distinct rentalDueIds exist.
const MAX_LEDGER_SLOTS = 10;

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

  // ✅ reset BOTH live ledgers immediately when the cycle rolls over,
  // instead of waiting for the next createLedgerEntry call. The old
  // cycle's entries are already safely preserved in ledgerHistory, so
  // nothing is lost — this just makes the live state empty right away
  // for the new cycle that just opened.
  if (Array.isArray(media.ledger) && media.ledger.length > 0) {
    media.ledger = [];
    media.markModified("ledger");
  }
  if (Array.isArray(media.withGst1Ledger) && media.withGst1Ledger.length > 0) {
    media.withGst1Ledger = [];
    media.markModified("withGst1Ledger");
  }
}

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
    // ✅ NEW — separate live array for withGst===1 entries.
    if (!Array.isArray(media.withGst1Ledger)) {
      media.withGst1Ledger = [];
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

    // ✅ The SLOT (0, 1, or 2) a withGst===2 entry updates is derived
    // from its POSITION among the withGst===2 entries in this request
    // (entries[0] of type gst2 -> slot 0, entries[1] of type gst2 ->
    // slot 1, etc). Only withGst===2 entries consume the 3 fixed
    // `media.ledger` slots — withGst===1 entries never do.
    const gst2Count = entries.filter((e) => e.withGst === 2).length;
    if (gst2Count > MAX_LEDGER_SLOTS) {
      return errorResponse(
        res,
        `entries with withGst=2 cannot exceed ${MAX_LEDGER_SLOTS} in a single request (max ${MAX_LEDGER_SLOTS} ledger slots)`,
        null,
        400,
      );
    }

    // ── Validate every entry — utrNumber, landOwnerId, withGst, month
    // are ALL validated PER ENTRY, not once at the top level ──
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];

      // if (!item.utrNumber) {
      //   return errorResponse(
      //     res,
      //     `entries[${i}].utrNumber is required`,
      //     null,
      //     400,
      //   );
      // }

      // ✅ withGst validated per entry
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

      // ✅ month validated per entry
      if (item.withGst !== 2) {
        if (!item.month) {
          return errorResponse(
            res,
            `entries[${i}].month is required when withGst is not 2`,
            null,
            400,
          );
        }
      } else {
        // If withGst is 2, month is not needed - set to null
        item.month = null;
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

    let gst2SlotIndex = 0; // increments ONLY for withGst===2 entries

    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      const entryDate = item.date ? new Date(item.date) : new Date();

      const matchedOwner = item.landOwnerId
        ? media.landOwners.id(item.landOwnerId)
        : null;

      const ledgerEntryData = {
        landOwnerId: matchedOwner ? matchedOwner._id : null,
        landOwnerName: matchedOwner ? matchedOwner.name : "",
        utrNumber: item.utrNumber,
        date: entryDate,
        status: 1,
        cycle: currentCycle,
        updatedBy: req.user?.userName || "Admin",
        updatedAt: nowIST(),
        withGst: item.withGst,
        month: item.month,
        rentalDueId: item.rentalDueId || null,
      };

      let savedLedgerEntry;

      if (item.withGst === 2) {
        // ── LIVE `ledger`: fixed-slot upsert by position ──
        // media.ledger[slotIndex] is OVERWRITTEN in place. No new
        // element is ever pushed and no other slot is ever touched.
        const slotIndex = gst2SlotIndex++;
        ledgerEntryData.index = slotIndex;

        media.ledger[slotIndex] = ledgerEntryData;
        media.markModified("ledger");
        savedLedgerEntry = media.ledger[slotIndex];
      } else {
        // ── LIVE `withGst1Ledger`: upsert by rentalDueId ──
        // First save for a given rentalDueId PUSHES a new entry.
        // Saving again with the SAME rentalDueId UPDATES that entry
        // in place — never pushes a duplicate. This array never
        // touches `media.ledger` and has no fixed slot cap.
        // Fallback match (when no rentalDueId given): same
        // landOwnerId + same month.
        const existingIndex = media.withGst1Ledger.findIndex((existing) => {
          if (item.rentalDueId) {
            return String(existing.rentalDueId || "") === String(item.rentalDueId);
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

        if (matchingGstRecords.length > 0) {
          media.markModified("gstBalanceHistory");
        }
      }

      // ── PERMANENT ledgerHistory: always append, never dedupe here,
      // regardless of withGst type ──
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
        withGst: item.withGst,
        month: item.month,
        rentalDueId: item.rentalDueId || null,
        // `index` only means something for withGst===2 (ledger slot).
        // withGst===1 entries are identified by rentalDueId instead.
        index: item.withGst === 2 ? ledgerEntryData.index : null,
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
        currentWithGst1Ledger: media.withGst1Ledger,
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
      if (![0, 1,2,3].includes(statusNum)) {
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
      }else if (statusNum === 2) {
    // GST not paid: at least one gstBalanceHistory entry with isPaid: false
    filter["gstBalanceHistory"] = {
      $exists: true,
      $not: { $size: 0 },
      $elemMatch: { isPaid: false },
    };
  } else if (statusNum === 3) {
    // GST paid: at least one gstBalanceHistory entry with isPaid: true
    filter["gstBalanceHistory"] = {
      $exists: true,
      $not: { $size: 0 },
      $elemMatch: { isPaid: true },
    };
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

    let requestedMonthRange = null;

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
            {
              "rentalDue.dueDate": {
                $gte: startDate,
                $lte: endDate,
              },
            },
            // ✅ Also match if the site's ledgerHistory already has a
            // bucket for this year/month — covers BOTH past cycles
            // (live cycle already advanced) AND the current/live month
            // (a fresh manual entry was just created for it).
            {
              ledgerHistory: {
                $elemMatch: {
                  year: String(startDate.getUTCFullYear()),
                  months: {
                    $elemMatch: {
                      month: [
                        "January", "February", "March", "April", "May", "June",
                        "July", "August", "September", "October", "November", "December",
                      ][startDate.getUTCMonth()],
                    },
                  },
                },
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
          "mediaCode mediaName mediaType state city location rentalStatus rentalPayment gstBalanceHistory landOwners ledger withGst1Ledger ledgerHistory rentalDue createdAt updatedAt",
        )
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Media.countDocuments(filter),
    ]);
let overallGstPendingAmount = 0;
    const mediaListData = results.map((media) => {
      const mediaObj = media.toObject();

      const inRequestedMonth = (date) => {
        if (!requestedMonthRange || !date) return true;
        const d = new Date(date);
        return (
          d >= requestedMonthRange.startDate && d <= requestedMonthRange.endDate
        );
      };

      // ── For the CURRENT calendar month, `ledger`/`withGst1Ledger`
      // are sourced from the LIVE media.ledger / media.withGst1Ledger
      // arrays — same as when no filter is passed at all. Both live
      // arrays are always the accurate current state (createLedgerEntry
      // overwrites/upserts in place), so there's no need to dedupe
      // anything from history.
      //
      // For a PAST month (already closed, no more live updates coming),
      // there's no live snapshot left, so we fall back to the
      // ledgerHistory bucket for that month, best-effort deduped.
      //
      // Either way, the FULL list of everything saved during the
      // requested month (including every re-save) is also returned
      // separately as `monthHistoryEntries`, so nothing is lost.
      const now = new Date();
      const isCurrentCalendarMonth =
        requestedMonthRange &&
        requestedMonthRange.startDate.getUTCFullYear() === now.getUTCFullYear() &&
        requestedMonthRange.startDate.getUTCMonth() === now.getUTCMonth();

      let gst2SourceEntries;
      let gst1SourceEntries;
      let monthHistoryEntries = [];

      if (requestedMonthRange) {
        const monthNames = [
          "January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December",
        ];
        const requestedMonthName =
          monthNames[requestedMonthRange.startDate.getUTCMonth()];
        const requestedYear = String(
          requestedMonthRange.startDate.getUTCFullYear(),
        );

        const yearBucket = (mediaObj.ledgerHistory || []).find(
          (y) => y.year === requestedYear,
        );
        const monthBucket = yearBucket?.months.find(
          (m) => m.month === requestedMonthName,
        );

        monthHistoryEntries = [...(monthBucket?.entries || [])].sort(
          (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
        );

        if (isCurrentCalendarMonth) {
          gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
          gst1SourceEntries = mediaObj.withGst1Ledger || [];
        } else {
          const allMonthEntries = monthBucket?.entries || [];
          gst2SourceEntries = allMonthEntries.filter((e) => e.withGst === 2);
          gst1SourceEntries = allMonthEntries.filter((e) => e.withGst === 1);
        }
      } else {
        // Live arrays. `ledger` is a fixed max-3-slot array (indexes
        // 0/1/2), possibly sparse — filter out empty/null slots.
        // `withGst1Ledger` is already unique per rentalDueId by design.
        gst2SourceEntries = (mediaObj.ledger || []).filter(Boolean);
        gst1SourceEntries = mediaObj.withGst1Ledger || [];
      }

      // Best-effort dedupe for the PAST-month/ledgerHistory case only.
      // gst2 entries are keyed by `index` (ledger slot). gst1 entries
      // are keyed by `rentalDueId` (falls back to landOwnerId+month).
      // Both fall back further to array position so entries can never
      // silently collapse even if identifying fields are missing.
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

      const sourcedFromLiveLedger = !requestedMonthRange || isCurrentCalendarMonth;

      if (gst2SourceEntries.length > 0) {
        const monthScoped = requestedMonthRange
          ? gst2SourceEntries
          : gst2SourceEntries.filter((entry) => inRequestedMonth(entry.date));

        if (sourcedFromLiveLedger) {
          latestLedger = [...monthScoped].sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
          );
        } else {
          latestLedger = dedupeByKey(monthScoped, gst2Key);
        }
      }

      if (gst1SourceEntries.length > 0) {
        const monthScoped = requestedMonthRange
          ? gst1SourceEntries
          : gst1SourceEntries.filter((entry) => inRequestedMonth(entry.date));

        if (sourcedFromLiveLedger) {
          withGst1Ledger = [...monthScoped].sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
          );
        } else {
          withGst1Ledger = dedupeByKey(monthScoped, gst1Key);
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
        fullGstBalanceHistory.forEach((entry,index) => {
         const isPaid = entry.isPaid;
          const isPaidFalse = isPaid === false || isPaid === 'false' || isPaid === 0 || isPaid === '0';
          
          if (isPaidFalse) {
            // Get the amount - could be paidAmount, amount, or gstAmount
            const amount = Number(entry.paidAmount) || 
                          Number(entry.amount) || 
                          Number(entry.gstAmount) || 
                          0;
            
            // console.log(`Adding amount: ${amount}`);
            gstPendingAmount += amount;
          }
        });
      }
      
      // Add to overall total
      overallGstPendingAmount += gstPendingAmount;
      let gstPayment = false;
      if (fullGstBalanceHistory.length > 0) {
        const hasEmptyUtr = fullGstBalanceHistory.some(
          (entry) => !entry.utrNumber || entry.utrNumber.trim() === "",
        );
        gstPayment = hasEmptyUtr;
      }

      const { ledgerHistory, ...restOfMediaObj } = mediaObj;

      return {
        ...restOfMediaObj,
        ledger: latestLedger,
        withGst1Ledger: withGst1Ledger,
        // ✅ Full, un-deduped list of everything saved for the requested
        // month (every re-save included) — only populated when
        // dateRange/currentMonth is passed. `ledger`/`withGst1Ledger`
        // above stay as the "current state" summary.
        monthHistoryEntries: requestedMonthRange ? monthHistoryEntries : undefined,
        rentalDue: rentalDueWithApproval,
        gstPayment: gstPayment,
        gstBalanceHistory: fullGstBalanceHistory,
        gstPendingAmount: gstPendingAmount, 
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
         overallGstPendingAmount: overallGstPendingAmount, 
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
      .select(
        "mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners agreement gstBalanceHistory",
      )
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

    // ✅ Calculate gstPayment flag (same logic as list API)
    const fullGstBalanceHistory = Array.isArray(media.gstBalanceHistory)
      ? media.gstBalanceHistory
      : [];
    let gstPayment = false;
    if (fullGstBalanceHistory.length > 0) {
      const hasEmptyUtr = fullGstBalanceHistory.some(
        (entry) => !entry.utrNumber || entry.utrNumber.trim() === ""
      );
      gstPayment = hasEmptyUtr;
    }

    // ── gst2 entries (withGst===2) are keyed by `index` (ledger slot).
    // gst1 entries (withGst===1) are keyed by `rentalDueId` — that's
    // their real identity now, matching how the live withGst1Ledger
    // array is upserted in createLedgerEntry. Both fall back further
    // to the entry's own array position, which is always unique, so
    // entries can never silently collapse even if identifying fields
    // are missing from the stored document.
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

    // Helper function to get GST balance for a specific landOwnerId and month
    const getGstBalanceDetails = (landOwnerId, month) => {
      if (!fullGstBalanceHistory || fullGstBalanceHistory.length === 0) {
        return { isPaid: false, gstAmount: 0 };
      }

      // Find the GST balance entry for this landOwner and month
      const gstEntry = fullGstBalanceHistory.find(
        (entry) => 
          String(entry.landOwnerId) === String(landOwnerId) && 
          entry.month === month
      );

      return {
        isPaid: gstEntry ? gstEntry.isPaid || false : false,
        gstAmount: gstEntry ? gstEntry.gstAmount || 0 : 0
      };
    };

    const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
      ...yearEntry,
      months: yearEntry.months.map((monthEntry) => {
        const allEntries = monthEntry.entries || [];

        const withGst2Entries = allEntries.filter((entry) => entry.withGst === 2);
        const withGst1Entries = allEntries.filter((entry) => entry.withGst === 1);

        const sortByUpdatedAt = (entries) =>
          [...entries].sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
          );

        // gst2: latest entry per ledger slot. gst1: latest entry per rentalDueId.
        const latestGst2 = dedupeByKey(withGst2Entries, gst2Key);
        const latestGst1 = dedupeByKey(withGst1Entries, gst1Key);

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
            nextBillingDate: entry.nextBillingDate,
          })),

          withGst1Ledger: latestGst1.map((entry) => {
            // Get GST balance details for this entry
            const gstDetails = getGstBalanceDetails(entry.landOwnerId, entry.month);
            
            return {
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
              nextBillingDate: entry.nextBillingDate,
              // ✅ Added GST balance details
              isPaid: gstDetails.isPaid,
              gstAmount: gstDetails.gstAmount
            };
          }),

          // ✅ UNCHANGED — full permanent history, never deduped
          allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
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
        city: media.city,
        rentalPayment: media.rentalPayment,
        landOwners: media.landOwners,
        agreement:media.agreement,
        currentRentalPayment: {
          paymentFrequency: media.rentalPayment.paymentFrequency,
          netPayable: media.rentalPayment.netPayable,
          nextBillingDate: media.rentalPayment.nextBillingDate,
        },
        ledgerHistory: transformedLedgerHistory,
        gstBalanceHistory: media.gstBalanceHistory,
        gstPayment: gstPayment,
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
// exports.getLedgerHistory = async (req, res) => {
//   try {
//     const { mediaId, year, month } = req.query;

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     // Use .lean() to get plain JSON objects
//     const media = await Media.findById(mediaId)
//       .select(
//         "mediaName city mediaType mediaCode rentalPayment ledgerHistory landOwners agreement gstBalanceHistory",
//       )
//       .lean();

//     if (!media) {
//       return errorResponse(res, "Media not found for given mediaId", null, 404);
//     }

//     let ledgerHistory = media.ledgerHistory || [];

//     // Filter by Year
//     if (year) {
//       ledgerHistory = ledgerHistory.filter(
//         (item) => item.year === String(year),
//       );
//     }

//     // Filter by Month
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

//     // ✅ Calculate gstPayment flag (same logic as list API)
//     const fullGstBalanceHistory = Array.isArray(media.gstBalanceHistory)
//       ? media.gstBalanceHistory
//       : [];
//     let gstPayment = false;
//     if (fullGstBalanceHistory.length > 0) {
//       const hasEmptyUtr = fullGstBalanceHistory.some(
//         (entry) => !entry.utrNumber || entry.utrNumber.trim() === ""
//       );
//       gstPayment = hasEmptyUtr;
//     }

//     // ── gst2 entries (withGst===2) are keyed by `index` (ledger slot).
//     // gst1 entries (withGst===1) are keyed by `rentalDueId` — that's
//     // their real identity now, matching how the live withGst1Ledger
//     // array is upserted in createLedgerEntry. Both fall back further
//     // to the entry's own array position, which is always unique, so
//     // entries can never silently collapse even if identifying fields
//     // are missing from the stored document.
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

//     const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
//       ...yearEntry,
//       months: yearEntry.months.map((monthEntry) => {
//         const allEntries = monthEntry.entries || [];

//         const withGst2Entries = allEntries.filter((entry) => entry.withGst === 2);
//         const withGst1Entries = allEntries.filter((entry) => entry.withGst === 1);

//         const sortByUpdatedAt = (entries) =>
//           [...entries].sort(
//             (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
//           );

//         // gst2: latest entry per ledger slot. gst1: latest entry per rentalDueId.
//         const latestGst2 = dedupeByKey(withGst2Entries, gst2Key);
//         const latestGst1 = dedupeByKey(withGst1Entries, gst1Key);

//         return {
//           month: monthEntry.month,

//           ledger: latestGst2.map((entry) => ({
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             index: entry.index,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             nextBillingDate: entry.nextBillingDate,
//           })),

//           withGst1Ledger: latestGst1.map((entry) => ({
//             landOwnerId: entry.landOwnerId,
//             landOwnerName: entry.landOwnerName,
//             utrNumber: entry.utrNumber,
//             date: entry.date,
//             status: entry.status,
//             withGst: entry.withGst,
//             month: entry.month,
//             cycle: entry.cycle,
//             rentalDueId: entry.rentalDueId,
//             index: entry.index,
//             updatedBy: entry.updatedBy,
//             updatedAt: entry.updatedAt,
//             _id: entry._id,
//             mediaName: media.mediaName,
//             paymentFrequency: entry.paymentFrequency,
//             netPayable: entry.netPayable,
//             nextBillingDate: entry.nextBillingDate,
//           })),

//           // ✅ UNCHANGED — full permanent history, never deduped
//           allEntries: sortByUpdatedAt(allEntries).map((entry) => ({
//             ...entry,
//             mediaName: media.mediaName,
//           })),
//         };
//       }),
//     }));

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
//         agreement:media.agreement,
//         currentRentalPayment: {
//           paymentFrequency: media.rentalPayment.paymentFrequency,
//           netPayable: media.rentalPayment.netPayable,
//           nextBillingDate: media.rentalPayment.nextBillingDate,
//         },
//         ledgerHistory: transformedLedgerHistory,
//         gstBalanceHistory: media.gstBalanceHistory,
//         gstPayment: gstPayment,
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