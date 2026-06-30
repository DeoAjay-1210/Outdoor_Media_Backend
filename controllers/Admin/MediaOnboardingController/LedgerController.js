const mongoose = require("mongoose");
const { successResponse, errorResponse } = require("../../../utils/response");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema"); // adjust path to wherever MediaSchema.js actually lives in your project
// const nowIST = require("../../../utils/updatedAt")
const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
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
      updatedBy:req.user?.userName || "Admin",
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
      siteName: media.mediaName,
      utrNumber: savedLedgerEntry.utrNumber,
      date: savedLedgerEntry.date,
      updatedBy:req.user?.userName || "Admin",
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
      201
    );
  } catch (error) {
    console.error("createLedgerEntry error:", error);
    return errorResponse(
      res,
      "Something went wrong while creating ledger entry",
      { error: error.message },
      500
    );
  }
};


exports.listMediaByLedger = async (req, res) => {
  try {
    const {
      pageNumber = 1,
      count = 10,
      search,
      status 
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};

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
          400
        );
      }
      filter["ledger.status"] = statusNum;
    }

    const skip = (pageNumbers - 1) * pageSize;

    const [results, totalCount] = await Promise.all([
      Media.find(filter)
        .select("mediaCode mediaName mediaType state city location rentalPayment ledger ledgerHistory")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Media.countDocuments(filter),
    ]);

    // Transform data if needed
     const mediaListData = results.map((media) => {
      const mediaObj = media.toObject();

      let latestLedger = [];

      if (Array.isArray(mediaObj.ledger) && mediaObj.ledger.length > 0) {
        latestLedger = [
          [...mediaObj.ledger].sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
          )[0],
        ];
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
      200
    );
  } catch (error) {
    console.error("listMediaByLedger error:", error);
    return errorResponse(
      res,
      "Something went wrong while fetching media list",
      { error: error.message },
      500
    );
  }
};

exports.getLedgerHistory = async (req, res) => {
  try {
    const { mediaId, year, month } = req.query;

    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(
        res,
        "mediaId is not a valid ObjectId",
        null,
        400
      );
    }

    // Use .lean() to get plain JSON objects
    const media = await Media.findById(mediaId)
      .select("mediaName rentalPayment ledgerHistory")
      .lean();

    if (!media) {
      return errorResponse(
        res,
        "Media not found for given mediaId",
        null,
        404
      );
    }

    let ledgerHistory = media.ledgerHistory || [];

    // Filter by Year
    if (year) {
      ledgerHistory = ledgerHistory.filter(
        (item) => item.year === String(year)
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
            (m) => m.month.toLowerCase() === monthName.toLowerCase()
          ),
        }))
        .filter((item) => item.months.length > 0);
    }

    return successResponse(
      res,
      "Ledger history fetched successfully",
      {
        mediaId: media._id,
        mediaName: media.mediaName,
        rentalPayment:media.rentalPayment,
        ledgerHistory,
      },
      200
    );
  } catch (error) {
    console.error("getLedgerHistory error:", error);

    return errorResponse(
      res,
      "Something went wrong while fetching ledger history",
      { error: error.message },
      500
    );
  }
};
