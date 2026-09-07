const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema");
const { generateMissedEntriesForMedia } = require("../MediaOnboardingController/RentalDueNew2Controller");
const { calculateOverallLedgerSummary } = require("../MediaOnboardingController/LedgerNew2Controller");
const { successResponse, errorResponse } = require("../../../utils/response");
const mongoose = require("mongoose");

const IST_OFFSET_MS = 330 * 60000; // 5h 30m
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

const FULL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Format Date to IST MM-YYYY
 */
const getCurrentMonthMMYYYY = () => {
  const d = nowIST();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const y = d.getUTCFullYear();
  return `${m}-${y}`;
};

/**
 * Main Admin Dashboard Controller
 * POST /admin/dashboard
 * GET /admin/dashboard
 */
const getAdminDashboard = async (req, res) => {
  try {
    const { month, selectedMonth: reqSelectedMonth } = req.body || req.query || {};

    // 1. Resolve Selected Month parameter (supports "month" or "selectedMonth", format MM-YYYY e.g. "08-2026")
    let rawMonthParam = month || reqSelectedMonth;
    let selectedMonth = (rawMonthParam && typeof rawMonthParam === "string" && rawMonthParam.trim())
      ? rawMonthParam.trim()
      : getCurrentMonthMMYYYY();

    if (!selectedMonth.match(/^\d{2}-\d{4}$/)) {
      return errorResponse(res, "Invalid month format. Please use MM-YYYY (e.g. 08-2026)", null, 400);
    }

    const [mStr, yStr] = selectedMonth.split("-");
    const monthNum = parseInt(mStr, 10); // 1-12
    const yearNum = parseInt(yStr, 10);  // e.g. 2026

    if (monthNum < 1 || monthNum > 12 || isNaN(yearNum)) {
      return errorResponse(res, "Invalid month or year values in selectedMonth", null, 400);
    }

    const monthStart = new Date(Date.UTC(yearNum, monthNum - 1, 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));

    const today = nowIST();
    today.setUTCHours(0, 0, 0, 0);

    // ==========================================
    // 1. MEDIA DASHBOARD OBJECT (MediaOnboardingController logic)
    // ==========================================
    // Fetch all MediaOnboarding docs
    const allMediaDocs = await MediaOnboarding.find({}).lean();

    let totalSitesCount = allMediaDocs.length;
    let activeSitesCount = 0;
    let inactiveSitesCount = 0;

    let activeAgreementCount = 0;
    let expiredAgreementCount = 0;
    let expireSoonAgreementCount = 0;

    allMediaDocs.forEach((site) => {
      const hasActiveFace = (site.mediaDetails || []).some((d) => Number(d.status) === 1);
      if (hasActiveFace) {
        activeSitesCount++;
      } else {
        inactiveSitesCount++;
      }

      // Evaluate agreement status relative to selected month end
      const agreement = site.agreement || {};
      if (agreement.startDate && agreement.endDate) {
        const endDate = new Date(agreement.endDate);
        const reminderDays = Number(agreement.reminderBeforeExpiry || 30);
        const daysUntilExpiry = Math.ceil((endDate.getTime() - monthEnd.getTime()) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry < 0) {
          expiredAgreementCount++;
        } else if (daysUntilExpiry <= reminderDays) {
          expireSoonAgreementCount++;
        } else {
          activeAgreementCount++;
        }
      } else {
        inactiveSitesCount++;
      }
    });

    const mediaObj = {
      totalSites: totalSitesCount,
      activeSites: activeSitesCount,
      inactiveSites: inactiveSitesCount,
      activeAgreement: activeAgreementCount,
      expiredAgreement: expiredAgreementCount,
      expireSoonAgreement: expireSoonAgreementCount,
    };

    // ==========================================
    // 2. RENTAL DASHBOARD OBJECT (RentalDueNew2Controller logic)
    // ==========================================
    // Sweep active sites to generate missed billing cycle entries (same as RentalDueNew2Controller)
    const activeSitesForSweep = await MediaOnboarding.find({ "mediaDetails.status": 1 });
    for (const siteDoc of activeSitesForSweep) {
      const result = await generateMissedEntriesForMedia(siteDoc, "");
      const generatedCount = result?.generatedEntries?.length || 0;
      if (generatedCount > 0 || siteDoc.isModified()) {
        await siteDoc.save({ timestamps: false });
      }
    }

    // Run exact aggregation pipeline from RentalDueNew2Controller
    const summaryStatsAgg = await MediaOnboarding.aggregate([
      { $match: { "mediaDetails.status": 1 } },
      { $unwind: "$rentalDue" },
      { $match: { "rentalDue.dueDate": { $lte: monthEnd } } },
      {
        $addFields: {
          billMode: { $ifNull: [{ $first: "$landOwners.agreementBillMode" }, 1] },
          faceCount: { $size: { $ifNull: ["$mediaDetails", [1]] } }
        }
      },
      {
        $addFields: {
          effectiveNetPayable: {
            $let: {
              vars: {
                siteBase: { $ifNull: ["$rentalPayment.totalRentalAmount", 0] },
                siteGst: {
                  $let: {
                    vars: {
                      rpGst: { $ifNull: ["$rentalPayment.gstAmount", 0] },
                      loGst: {
                        $sum: {
                          $map: {
                            input: { $ifNull: ["$landOwners", []] },
                            as: "o",
                            in: {
                              $cond: [
                                { $eq: [{ $toInt: { $ifNull: ["$$o.gstApplicable", 0] } }, 1] },
                                { $ifNull: ["$$o.gstAmount", 0] },
                                0
                              ]
                            }
                          }
                        }
                      }
                    },
                    in: { $cond: [{ $gt: ["$$rpGst", 0] }, "$$rpGst", "$$loGst"] }
                  }
                },
                faceCount: { $cond: [{ $gt: ["$faceCount", 0] }, "$faceCount", 1] },
                billMode: "$billMode"
              },
              in: {
                $let: {
                  vars: {
                    rawBase: { $ifNull: ["$rentalDue.netPayable", "$rentalDue.baseAmount"] },
                    rawGst: { $ifNull: ["$rentalDue.gstAmount", 0] },
                    withGst: { $ifNull: ["$rentalDue.withGst", 0] }
                  },
                  in: {
                    $let: {
                      vars: {
                        faceBase: {
                          $cond: [
                            { $eq: ["$$billMode", 1] },
                            { $divide: ["$$siteBase", "$$faceCount"] },
                            "$$rawBase"
                          ]
                        },
                        faceGst: {
                          $cond: [
                            { $eq: ["$$billMode", 1] },
                            { $divide: ["$$siteGst", "$$faceCount"] },
                            { $cond: [{ $gt: ["$$rawGst", 0] }, "$$rawGst", "$$siteGst"] }
                          ]
                        }
                      },
                      in: {
                        $cond: [
                          { $eq: ["$$withGst", 2] },
                          {
                            $cond: [
                              { $eq: ["$$billMode", 1] },
                              { $divide: [{ $add: ["$$siteBase", "$$siteGst"] }, "$$faceCount"] },
                              "$$rawBase"
                            ]
                          },
                          { $add: ["$$faceBase", "$$faceGst"] }
                        ]
                      }
                    }
                  }
                }
              }
            }
          },
          isCurrentMonth: { $and: [{ $gte: ["$rentalDue.dueDate", monthStart] }, { $lte: ["$rentalDue.dueDate", monthEnd] }] },
          isApprovedByRole: { $eq: ["$rentalDue.approvalStatus", 3] },
          isOverdueGlobally: {
            $or: [
              { $eq: ["$rentalPayment.status", 3] },
              {
                $and: [
                  { $lt: ["$rentalDue.dueDate", today] },
                  { $ne: ["$rentalDue.approvalStatus", 3] },
                ],
              },
            ],
          },
          isPendingByRole: { $ne: ["$rentalDue.approvalStatus", 3] }
        }
      },
      {
        $group: {
          _id: { mediaId: "$_id", faceId: "$rentalDue.mediaDetailId" },
          faceIsApprovedCurrent: { $max: { $cond: ["$isCurrentMonth", "$isApprovedByRole", false] } },
          faceIsOverdue: { $max: "$isOverdueGlobally" },
          faceIsPendingCurrent: { $max: { $cond: ["$isCurrentMonth", "$isPendingByRole", false] } },
          amtApprovedCurrent: { $sum: { $cond: [{ $and: ["$isCurrentMonth", "$isApprovedByRole"] }, "$effectiveNetPayable", 0] } },
          amtOverdueTotal: { $sum: { $cond: ["$isOverdueGlobally", "$effectiveNetPayable", 0] } },
          amtPendingCurrent: { $sum: { $cond: [{ $and: ["$isCurrentMonth", "$isPendingByRole"] }, "$effectiveNetPayable", 0] } },
          isDueThisMonth: { $max: "$isCurrentMonth" },
          amtDueThisMonth: { $sum: { $cond: ["$isCurrentMonth", "$effectiveNetPayable", 0] } },
        }
      },
      {
        $group: {
          _id: null,
          dueThisMonthCount: { $sum: { $cond: ["$isDueThisMonth", 1, 0] } },
          dueThisMonthAmount: { $sum: "$amtDueThisMonth" },
          approvedCount: { $sum: { $cond: ["$faceIsApprovedCurrent", 1, 0] } },
          approvedAmountTotal: { $sum: "$amtApprovedCurrent" },
          overdueCount: { $sum: { $cond: ["$faceIsOverdue", 1, 0] } },
          overdueAmountTotal: { $sum: "$amtOverdueTotal" },
          pendingCount: { $sum: { $cond: ["$faceIsPendingCurrent", 1, 0] } },
          pendingAmountTotal: { $sum: "$amtPendingCurrent" }
        }
      }
    ]);

    const stats = summaryStatsAgg[0] || {
      dueThisMonthCount: 0,
      dueThisMonthAmount: 0,
      approvedCount: 0,
      approvedAmountTotal: 0,
      overdueCount: 0,
      overdueAmountTotal: 0,
      pendingCount: 0,
      pendingAmountTotal: 0
    };

    const rentalObj = {
      totalDueThisMonth: {
        amount: Math.round(stats.dueThisMonthAmount),
        sites: stats.dueThisMonthCount,
      },
      overdue: {
        amount: Math.round(stats.overdueAmountTotal),
        sites: stats.overdueCount,
      },
      pendingThisMonth: {
        amount: Math.round(stats.pendingAmountTotal),
        sites: stats.pendingCount,
      },
      approvalThisMonth: {
        amount: Math.round(stats.approvedAmountTotal),
        sites: stats.approvedCount,
      },
    };

    // ==========================================
    // 3. LEDGER DASHBOARD OBJECT (LedgerNew2Controller logic)
    // ==========================================
    const activeMediaDocs = await MediaOnboarding.find({ "mediaDetails.status": 1 }).lean();
    const parsedMonthYearObj = { month: monthNum, year: yearNum };
    const ledgerSummary = calculateOverallLedgerSummary(activeMediaDocs, parsedMonthYearObj);

    const ledgerObj = {
      currentMonthBaseRent: {
        amount: Math.floor(
          ledgerSummary.overAllCurrentRentalAmount !== undefined && ledgerSummary.overAllCurrentRentalAmount > 0
            ? ledgerSummary.overAllCurrentRentalAmount
            : (ledgerSummary.currentMonthRentPaid || 0)
        ),
        sites:
          ledgerSummary.overAllCurrentRentalAmountSites !== undefined && ledgerSummary.overAllCurrentRentalAmountSites > 0
            ? ledgerSummary.overAllCurrentRentalAmountSites
            : (ledgerSummary.currentMonthRentPaidSites || 0),
      },
      currentMonthGst: {
        amount: Math.floor(
          ledgerSummary.overAllCurrentMonthGstAmount !== undefined && ledgerSummary.overAllCurrentMonthGstAmount > 0
            ? ledgerSummary.overAllCurrentMonthGstAmount
            : (ledgerSummary.currentMonthGstPaid || 0)
        ),
        sites:
          ledgerSummary.overAllCurrentMonthGstAmountSites !== undefined && ledgerSummary.overAllCurrentMonthGstAmountSites > 0
            ? ledgerSummary.overAllCurrentMonthGstAmountSites
            : (ledgerSummary.currentMonthGstPaidSites || 0),
      },
      pastRentPending: {
        amount: Math.floor(ledgerSummary.pastRentPending || 0),
        sites: ledgerSummary.pastRentPendingSites || 0,
      },
      pastGstPending: {
        amount: Math.floor(ledgerSummary.pastGstPending || 0),
        sites: ledgerSummary.pastGstPendingSites || 0,
      },
    };

    // ==========================================
    // 4. LATEST UPDATED LANDOWNER SECTION (LandOwnerMaster relationship)
    // ==========================================
    const recentLandownersRaw = await LandOwnerMaster.find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(5)
      .lean();

    const recentLandownerIds = recentLandownersRaw.map((l) => l._id);

    const linkedMediaDocs = await MediaOnboarding.find({
      "landOwners.landOwnerMasterId": { $in: recentLandownerIds },
    }).lean();

    const landownersList = recentLandownersRaw.map((owner) => {
      const ownerIdStr = String(owner._id);
      const siteDetailsMap = new Map();

      linkedMediaDocs.forEach((media) => {
        const isLinked = (media.landOwners || []).some(
          (lo) => String(lo.landOwnerMasterId) === ownerIdStr
        );

        if (isLinked) {
          const siteCodeStr = media.siteCode || String(media._id);
          const firstDetail = (media.mediaDetails || [])[0] || {};
          const siteName = firstDetail.mediaName || siteCodeStr;
          const mediaCode = (media.mediaDetails || []).map((d) => d.mediaCode).join(" / ") || siteCodeStr;
          const mediaName = (media.mediaDetails || []).map((d) => d.mediaName).join(", ") || siteName;

          if (!siteDetailsMap.has(siteCodeStr)) {
            siteDetailsMap.set(siteCodeStr, {
              siteName,
              mediaCode,
              mediaName,
            });
          }
        }
      });

      const sitesArray = Array.from(siteDetailsMap.values());

      return {
        landOwnerName: owner.name || "Unknown Landowner",
        lastUpdatedDate: owner.updatedAt || owner.createdAt || nowIST(),
        totalSites: sitesArray.length,
        sites: sitesArray,
      };
    });

    const latestUpdatesObj = {
      landowners: landownersList,
    };

    // ==========================================
    // FINAL RESPONSE
    // ==========================================
    return successResponse(res, "Admin dashboard data fetched successfully", {
      selectedMonth,
      media: mediaObj,
      rental: rentalObj,
      ledger: ledgerObj,
      latestUpdates: latestUpdatesObj,
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

module.exports = {
  getAdminDashboard,
};
