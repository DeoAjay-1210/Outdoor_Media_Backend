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

exports.createLedgerEntry = async (req, res) => {
  try {
    const { mediaId, utrNumber, date } = req.body;

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

    const entryDate = date ? new Date(date) : new Date();

    // 1. Build the ledger entry
    const ledgerEntry = {
      utrNumber,
      date: entryDate,
      status: 1,
      updatedBy: req.user?.userName || "Admin",
      updatedAt: nowIST(),
    };

    media.ledger.push(ledgerEntry);
    const savedLedgerEntry = media.ledger[media.ledger.length - 1];

    // 2. Auto-bucket into ledgerHistory: year -> month -> entries
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
      mediaName: media.mediaName,
      paymentFrequency: media.rentalPayment.paymentFrequency,
      netPayable: media.rentalPayment.netPayable,
      nextBillingDate: media.rentalPayment.nextBillingDate,
      utrNumber: savedLedgerEntry.utrNumber,
      date: savedLedgerEntry.date,
      updatedBy: req.user?.userName || "Admin",
      updatedAt: nowIST(),
    });

    await media.save();

    return successResponse(
      res,
      "Ledger entry created successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        ledgerEntry: savedLedgerEntry,
        ledgerHistoryBucket: { year, month },
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
      dateRange, // Format: "07-2026"
      currentMonth, // Format: "07-2026"
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};
    filter.rentalStatus = 3;
    if (search) {
      filter.mediaName = { $regex: search, $options: "i" };
    }

    if (status !== undefined && status !== "") {
      const statusNum = Number(status);
      if (![0, 1].includes(statusNum)) {
        return errorResponse(
          res,
          "status must be one of 0 (Not approve), 1 (Approve)",
          null,
          400,
        );
      }
      filter["ledger.status"] = statusNum;
    }

    // Helper function to validate MM-YYYY format
    const validateMonthYear = (monthYear) => {
      const regex = /^(0[1-9]|1[0-2])-([0-9]{4})$/;
      return regex.test(monthYear);
    };

    // Helper function to convert MM-YYYY to date range
    const getMonthDateRange = (monthYear) => {
      const [month, year] = monthYear.split("-").map(Number);

      // Create start date (first day of month at 00:00:00)
      const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));

      // Create end date (last day of month at 23:59:59)
      const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      return { startDate, endDate };
    };

    // Apply date filter on rentalPayment.nextBillingDate
    const applyDateFilter = (monthYear, filterObj) => {
      if (!validateMonthYear(monthYear)) {
        throw new Error("Invalid format. Use MM-YYYY format (e.g., 07-2026)");
      }

      const { startDate, endDate } = getMonthDateRange(monthYear);

      // Filter on rentalPayment.nextBillingDate (not ledger.nextBillingDate)
      filterObj["rentalPayment.nextBillingDate"] = {
        $gte: startDate,
        $lte: endDate,
      };

      return filterObj;
    };

    // Date Range Filter - Single Month-Year format
    if (dateRange) {
      try {
        applyDateFilter(dateRange, filter);
      } catch (error) {
        return errorResponse(res, error.message, null, 400);
      }
    }

    // Current Month Filter - Single Month-Year format
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
          "mediaCode mediaName mediaType state city location rentalStatus rentalPayment landOwners ledger",
        )
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Media.countDocuments(filter),
    ]);

    // Transform data - Get latest ledger entry
    const mediaListData = results.map((media) => {
      const mediaObj = media.toObject();

      let latestLedger = [];

      if (Array.isArray(mediaObj.ledger) && mediaObj.ledger.length > 0) {
        // Sort by updatedAt and get the latest
        const sortedLedger = [...mediaObj.ledger].sort(
          (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
        );
        latestLedger = [sortedLedger[0]];
      }

      return {
        ...mediaObj,
        ledger: latestLedger,
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

// exports.getLedgerHistory = async (req, res) => {
//   try {
//     const { mediaId, year, month } = req.query;

//     if (!mongoose.Types.ObjectId.isValid(mediaId)) {
//       return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
//     }

//     // Use .lean() to get plain JSON objects
//     const media = await Media.findById(mediaId)
//       .select("mediaName city mediaType mediaCode rentalPayment ledgerHistory")
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

//     // Transform ledgerHistory to include mediaName in each ledger entry
//     const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
//       ...yearEntry,
//       months: yearEntry.months.map((monthEntry) => ({
//         ...monthEntry,
//         entries: monthEntry.entries.map((entry) => ({
//           ...entry,
//           mediaName: media.mediaName, // Add mediaName to each entry
//         })),
//       })),
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
//          currentRentalPayment: {
//           paymentFrequency: media.rentalPayment.paymentFrequency,
//           netPayable: media.rentalPayment.netPayable,
//           nextBillingDate: media.rentalPayment.nextBillingDate,
//         },
//         ledgerHistory: transformedLedgerHistory,
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

    // Transform ledgerHistory to include mediaName and show only latest entry per month based on updatedAt
    const transformedLedgerHistory = ledgerHistory.map((yearEntry) => ({
      ...yearEntry,
      months: yearEntry.months.map((monthEntry) => {
        // Sort entries by updatedAt (newest first)
        const sortedEntries = [...monthEntry.entries].sort((a, b) => {
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });

        // Get the latest entry (first after sorting by updatedAt)
        const latestEntry = sortedEntries[0];

        return {
          month: monthEntry.month,
          // Only show the latest entry based on updatedAt
          entries: latestEntry
            ? [
                {
                  ...latestEntry,
                  mediaName: media.mediaName,
                },
              ]
            : [],
          // Keep all entries for historical data
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
