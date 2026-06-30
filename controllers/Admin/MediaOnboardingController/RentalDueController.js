// controllers/rentalDue.controller.js
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const path = require("path");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const FREQ_LABEL = {
  1: "Monthly",
  2: "2 Months",
  3: "3 Months",
  4: "6 Months",
  5: "Yearly",
  6: "2 Years",
};
const STATUS_LABEL = { 1: "Active", 2: "Expire Zone", 3: "Overdue" };
const ROLE_LABEL = { 1: "Staff", 2: "Team Lead", 3: "Owner" };
const getDueMonthLabel = (date) => {
  const d = new Date(date);
  return d.toLocaleString("en-IN", { month: "long", year: "numeric" });
};

const getYearLabel = (date) => String(new Date(date).getFullYear());
const getMonthLabel = (date) =>
  new Date(date).toLocaleString("en-IN", { month: "long" });

const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
/** Determine which role should be pending next after an approval */
const nextPendingRole = (steps) => {
  const pending = steps.find((s) => s.status === 1);
  return pending ? pending.role : null;
};

// exports.getRentalDueListWithStats = async (req, res) => {
//   try {
//     const {
//       dueDate, // "2026-06" — filters the LIST by rentalPayment.nextBillingDate month
//       city,
//       mediaType,
//       frequency,
//       status, // filters by rentalPayment.status: 1=Active 2=ExpireZone 3=Expired/Overdue
//       search,
//       pageNumber = 1,
//       count = 10,
//     } = req.body;

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;
//     const skip = (pageNumbers - 1) * pageSize;

//     // ── Validate and prepare date filters ────────────────────────────────────
//     let dateFilter;
//     let monthStart;
//     let monthEnd;

//     if (dueDate) {
//       if (!dueDate.match(/^\d{4}-\d{2}$/)) {
//         return res.status(400).json({
//           success: false,
//           message: "Invalid dueDate format. Please use YYYY-MM (e.g., 2026-06)",
//         });
//       }
//       const [yr, mo] = dueDate.split("-").map(Number);
//       monthStart = new Date(yr, mo - 1, 1);
//       monthEnd = new Date(yr, mo, 0, 23, 59, 59);
//       dateFilter = {
//         $gte: monthStart,
//         $lte: monthEnd,
//       };
//     } else {
//       // Fallback to current month if dueDate is not provided
//       const now = new Date();
//       monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
//       monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
//       dateFilter = {
//         $gte: monthStart,
//         $lte: monthEnd,
//       };
//     }

//     // ── Media-level filters ────────────────────────────────────
//     const mediaMatch = { status: 1 }; // only active sites
//     if (city) mediaMatch.city = { $regex: city, $options: "i" };
//     if (mediaType) mediaMatch.mediaType = { $regex: mediaType, $options: "i" };
//     if (frequency)
//       mediaMatch["rentalPayment.paymentFrequency"] = parseInt(frequency, 10);

//     // status filter: maps to rentalPayment.status (1=Active 2=ExpireZone 3=Overdue)
//     if (status !== undefined && status !== null && status !== "") {
//       const statusMap = { active: 1, expirezone: 2, overdue: 3, expired: 3 };
//       const parsed = parseInt(status, 10);
//       const resolvedStatus = isNaN(parsed)
//         ? statusMap[String(status).toLowerCase()]
//         : parsed;
//       if (resolvedStatus) mediaMatch["rentalPayment.status"] = resolvedStatus;
//     }

//     if (search) {
//       mediaMatch.$or = [
//         { mediaCode: { $regex: search, $options: "i" } },
//         { mediaName: { $regex: search, $options: "i" } },
//         { city: { $regex: search, $options: "i" } },
//         { location: { $regex: search, $options: "i" } },
//       ];
//     }

//     // ─────────────────────────────────────────────────────────
//     // 1) STATS — Based on the dueDate parameter
//     // ─────────────────────────────────────────────────────────
//     const totalSites = await Media.countDocuments({ status: 1 });

//     // dueThisMonth - based on dueDate
//     const dueThisMonthAgg = await Media.aggregate([
//       { $match: { status: 1 } },
//       {
//         $match: {
//           "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           totalNetPayable: { $sum: "$rentalPayment.netPayable" },
//           count: { $sum: 1 },
//         },
//       },
//     ]);
//     const dueThisMonth = {
//       totalNetPayable: dueThisMonthAgg[0]?.totalNetPayable || 0,
//       count: dueThisMonthAgg[0]?.count || 0,
//     };

//     // dueAmountOpen - based on dueDate AND status (2 or 3)
//     const dueAmountOpenAgg = await Media.aggregate([
//       {
//         $match: {
//           status: 1,
//           "rentalPayment.status": { $in: [2, 3] },
//           "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
//         },
//       },
//       {
//         $group: { _id: null, totalOpen: { $sum: "$rentalPayment.netPayable" } },
//       },
//     ]);
//     const dueAmountOpen = dueAmountOpenAgg[0]?.totalOpen || 0;

//     // overDue sites - based on dueDate and status === 3
//     const overDueSiteCount = await Media.countDocuments({
//       status: 1,
//       "rentalPayment.status": 3,
//       "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
//     });

//     // Pending / Approved counts come from rentalDue[] (the approval workflow array)
//     // — these stay 0 until users actually start raising rentalDue entries via the save API.
//     const approvalBreakdownAgg = await Media.aggregate([
//       { $match: { status: 1 } },
//       { $unwind: "$rentalDue" },
//       { $match: { "rentalDue.approvalStatus": { $in: [1, 2] } } },
//       { $group: { _id: "$rentalDue.currentPendingRole", count: { $sum: 1 } } },
//     ]);
//     const pendingByRole = { staff: 0, teamLead: 0, owner: 0, total: 0 };
//     approvalBreakdownAgg.forEach(({ _id, count }) => {
//       if (_id === 1) pendingByRole.staff = count;
//       if (_id === 2) pendingByRole.teamLead = count;
//       if (_id === 3) pendingByRole.owner = count;
//       pendingByRole.total += count;
//     });

//     const approvedCountAgg = await Media.aggregate([
//       { $match: { status: 1 } },
//       { $unwind: "$rentalDue" },
//       { $match: { "rentalDue.status": 3 } },
//       { $group: { _id: null, count: { $sum: 1 } } },
//     ]);
//     const approvedCount = approvedCountAgg[0]?.count || 0;

//     // ─────────────────────────────────────────────────────────
//     // 2) LIST — filtered by dueDate
//     // ─────────────────────────────────────────────────────────
//     const listMatch = {
//       ...mediaMatch,
//       "rentalPayment.nextBillingDate": dateFilter,
//     };

//     const listPipeline = [
//       { $match: listMatch },
//       {
//         $project: {
//           mediaCode: 1,
//           mediaName: 1,
//           mediaType: 1,
//           city: 1,
//           state: 1,
//           location: 1,
//           rentalPayment: 1,
//           agreement: 1,
//           rentalDue: 1, // include if you also want to show any raised approval entries
//         },
//       },
//       {
//         $facet: {
//           data: [{ $skip: skip }, { $limit: pageSize }],
//           total: [{ $count: "count" }],
//         },
//       },
//     ];

//     const result = await Media.aggregate(listPipeline);
//     const data = result[0]?.data || [];
//     const total = result[0]?.total[0]?.count || 0;

//     const STATUS_LABEL = { 1: "Active", 2: "Expire Zone", 3: "Overdue" };

//     const enriched = data.map((item) => ({
//       _id: item._id,
//       mediaCode: item.mediaCode,
//       mediaName: item.mediaName,
//       mediaType: item.mediaType,
//       city: item.city,
//       state: item.state,
//       location: item.location,
//       netPayable: item.rentalPayment?.netPayable || 0,
//       paymentFrequency: item.rentalPayment?.paymentFrequency,
//       paymentFrequencyLabel:
//         FREQ_LABEL[item.rentalPayment?.paymentFrequency] || "",
//       nextBillingDate: item.rentalPayment?.nextBillingDate,
//       lastBillPaidDate: item.rentalPayment?.lastBillPaidDate,
//       dueStatus: item.rentalPayment?.status,
//       dueStatusLabel: STATUS_LABEL[item.rentalPayment?.status] || "",
//       agreementPeriod: {
//         startDate: item.agreement?.startDate,
//         endDate: item.agreement?.endDate,
//         agreementPDF: item.agreement?.agreementPDF,
//       },
//       agreementDocVerified:
//         item.rentalDue?.[0]?.agreementDocVerification?.isVerified || false,
//       // Any explicit rentalDue approval entries raised for this site
//       rentalDueEntries: item.rentalDue || [],
//     }));

//     // ─────────────────────────────────────────────────────────
//     // FINAL RESPONSE
//     // ─────────────────────────────────────────────────────────
//     return res.status(200).json({
//       success: true,
//       value: {
//         totalSites,
//         dueThisMonth, // Now based on dueDate
//         dueAmountOpen, // Now based on dueDate
//         overDue: {
//           siteCount: overDueSiteCount,
//           // entryCount: overDueSiteCount, // entries == sites here since rentalDue[] isn't the source of truth
//         },
//         approvedCount,
//         pendingApproval: {
//           staff: pendingByRole.staff,
//           teamLead: pendingByRole.teamLead,
//           owner: pendingByRole.owner,
//           total: pendingByRole.total,
//         },
//       },
//       data: enriched,
//     });
//   } catch (err) {
//     console.error("getRentalDueListWithStats error:", err);
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }
// };

const isCurrentAgreementVerified = (media) => {
  const history = media.agreementDocVerification || [];
  if (!history.length) return false;

  const latest = [...history].sort(
    (a, b) => new Date(b.verifiedAt) - new Date(a.verifiedAt),
  )[0];

  const currentStart = media.agreement?.startDate?.toString();
  const currentEnd = media.agreement?.endDate?.toString();

  const matchesCurrentPeriod =
    latest.agreementPeriod?.startDate?.toString() === currentStart &&
    latest.agreementPeriod?.endDate?.toString() === currentEnd;

  return Boolean(latest.isVerified && matchesCurrentPeriod);
};

exports.getRentalDueListWithStats = async (req, res) => {
  try {
    const {
      dueDate, // "2026-06" — filters the LIST by rentalPayment.nextBillingDate month
      city,
      mediaType,
      frequency,
      status, // filters by rentalPayment.status: 1=Active 2=ExpireZone 3=Expired/Overdue
      search,
      pageNumber = 1,
      count = 10,
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;
    const skip = (pageNumbers - 1) * pageSize;

    // ── Validate and prepare date filters ────────────────────────────────────
    let dateFilter;
    let monthStart;
    let monthEnd;

    if (dueDate) {
      if (!dueDate.match(/^\d{4}-\d{2}$/)) {
        return res.status(400).json({
          success: false,
          message: "Invalid dueDate format. Please use YYYY-MM (e.g., 2026-06)",
        });
      }
      const [yr, mo] = dueDate.split("-").map(Number);
      monthStart = new Date(yr, mo - 1, 1);
      monthEnd = new Date(yr, mo, 0, 23, 59, 59);
      dateFilter = {
        $gte: monthStart,
        $lte: monthEnd,
      };
    } else {
      // Fallback to current month if dueDate is not provided
      const now = new Date();
      monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      dateFilter = {
        $gte: monthStart,
        $lte: monthEnd,
      };
    }

    // ── Media-level filters ────────────────────────────────────
    const mediaMatch = { status: 1 }; // only active sites
    if (city) mediaMatch.city = { $regex: city, $options: "i" };
    if (mediaType) mediaMatch.mediaType = { $regex: mediaType, $options: "i" };
    if (frequency)
      mediaMatch["rentalPayment.paymentFrequency"] = parseInt(frequency, 10);

    // status filter: maps to rentalPayment.status (1=Active 2=ExpireZone 3=Overdue)
    if (status !== undefined && status !== null && status !== "") {
      const statusMap = { active: 1, expirezone: 2, overdue: 3, expired: 3 };
      const parsed = parseInt(status, 10);
      const resolvedStatus = isNaN(parsed)
        ? statusMap[String(status).toLowerCase()]
        : parsed;
      if (resolvedStatus) mediaMatch["rentalPayment.status"] = resolvedStatus;
    }

    if (search) {
      mediaMatch.$or = [
        { mediaCode: { $regex: search, $options: "i" } },
        { mediaName: { $regex: search, $options: "i" } },
        { city: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
      ];
    }

    // ─────────────────────────────────────────────────────────
    // 1) STATS — Based on the dueDate parameter
    // ─────────────────────────────────────────────────────────
    const totalSites = await Media.countDocuments({ status: 1 });

    // dueThisMonth - based on dueDate
    const dueThisMonthAgg = await Media.aggregate([
      { $match: { status: 1 } },
      {
        $match: {
          "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalNetPayable: { $sum: "$rentalPayment.netPayable" },
          count: { $sum: 1 },
        },
      },
    ]);
    const dueThisMonth = {
      totalNetPayable: dueThisMonthAgg[0]?.totalNetPayable || 0,
      count: dueThisMonthAgg[0]?.count || 0,
    };

    // dueAmountOpen - based on dueDate AND status (2 or 3)
    const dueAmountOpenAgg = await Media.aggregate([
      {
        $match: {
          status: 1,
          "rentalPayment.status": { $in: [2, 3] },
          "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
        },
      },
      {
        $group: { _id: null, totalOpen: { $sum: "$rentalPayment.netPayable" } },
      },
    ]);
    const dueAmountOpen = dueAmountOpenAgg[0]?.totalOpen || 0;

    // overDue sites - based on dueDate and status === 3
    const overDueSiteCount = await Media.countDocuments({
      status: 1,
      "rentalPayment.status": 3,
      "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
    });

    // Pending / Approved counts come from rentalDue[] (the approval workflow array)
    // — these stay 0 until users actually start raising rentalDue entries via the save API.
    const approvalBreakdownAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $unwind: "$rentalDue" },
      { $match: { "rentalDue.approvalStatus": { $in: [1, 2] } } },
      { $group: { _id: "$rentalDue.currentPendingRole", count: { $sum: 1 } } },
    ]);
    const pendingByRole = { staff: 0, teamLead: 0, owner: 0, total: 0 };
    approvalBreakdownAgg.forEach(({ _id, count }) => {
      if (_id === 1) pendingByRole.staff = count;
      if (_id === 2) pendingByRole.teamLead = count;
      if (_id === 3) pendingByRole.owner = count;
      pendingByRole.total += count;
    });

    const approvedCountAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $unwind: "$rentalDue" },
      { $match: { "rentalDue.status": 3 } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);
    const approvedCount = approvedCountAgg[0]?.count || 0;

    // ─────────────────────────────────────────────────────────
    // 2) LIST — filtered by dueDate
    // ─────────────────────────────────────────────────────────
    const listMatch = {
      ...mediaMatch,
      "rentalPayment.nextBillingDate": dateFilter,
    };

    const listPipeline = [
      { $match: listMatch },
      {
        $project: {
          mediaCode: 1,
          mediaName: 1,
          mediaType: 1,
          city: 1,
          state: 1,
          location: 1,
          rentalPayment: 1,
          agreement: 1,
          agreementDocVerification: 1, // ✅ ADDED — needed for the verified-flag check
          rentalDue: 1, // include if you also want to show any raised approval entries
        },
      },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: pageSize }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const result = await Media.aggregate(listPipeline);
    const data = result[0]?.data || [];
    const total = result[0]?.total[0]?.count || 0;

    const enriched = data.map((item) => ({
      _id: item._id,
      mediaCode: item.mediaCode,
      mediaName: item.mediaName,
      mediaType: item.mediaType,
      city: item.city,
      state: item.state,
      location: item.location,
      netPayable: item.rentalPayment?.netPayable || 0,
      paymentFrequency: item.rentalPayment?.paymentFrequency,
      paymentFrequencyLabel:
        FREQ_LABEL[item.rentalPayment?.paymentFrequency] || "",
      nextBillingDate: item.rentalPayment?.nextBillingDate,
      lastBillPaidDate: item.rentalPayment?.lastBillPaidDate,
      dueStatus: item.rentalPayment?.status,
      dueStatusLabel: STATUS_LABEL[item.rentalPayment?.status] || "",
      agreementPeriod: {
        startDate: item.agreement?.startDate,
        endDate: item.agreement?.endDate,
        agreementPDF: item.agreement?.agreementPDF,
      },

      // ✅ FIXED — was reading item.rentalDue?.[0]?.agreementDocVerification?.isVerified
      // (a dead path that no longer exists in the schema, always returned false).
      // Now reads the top-level agreementDocVerification[] array and checks the
      // LATEST entry against the CURRENT agreement period.
      agreementDocVerified: isCurrentAgreementVerified(item),

      // Full verification history, in case the UI wants to show a timeline
      agreementDocVerificationHistory: item.agreementDocVerification || [],

      // Any explicit rentalDue approval entries raised for this site
      rentalDueEntries: item.rentalDue || [],
    }));

    // ─────────────────────────────────────────────────────────
    // FINAL RESPONSE
    // ─────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      value: {
        totalSites,
        dueThisMonth, // Now based on dueDate
        dueAmountOpen, // Now based on dueDate
        overDue: {
          siteCount: overDueSiteCount,
        },
        approvedCount,
        pendingApproval: {
          staff: pendingByRole.staff,
          teamLead: pendingByRole.teamLead,
          owner: pendingByRole.owner,
          total: pendingByRole.total,
        },
      },
      data: enriched,
    });
  } catch (err) {
    console.error("getRentalDueListWithStats error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
exports.verifyAgreementDoc = async (req, res) => {
  try {
    const { mediaId } = req.body;
    const { userType, userName } = req.user;
    const media = await Media.findById(mediaId);
    if (!media)
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });

    media.agreementDocVerification = {
      isVerified: true,
      verifiedBy: userName,
      verifiedByRole: userType,
      verifiedAt: nowIST(),
      agreementPDF: media.agreement?.agreementPDF || {},
    };

    media.updatedBy = userName;
    media.updatedAt = nowIST();

    await media.save();

    return res.status(200).json({
      success: true,
      message: "Agreement document verified successfully",
      data: media.agreementDocVerification,
    });
  } catch (err) {
    console.error("verifyAgreementDoc error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const buildApprovalSteps = () => {
  return [1, 2, 3].map((role) => ({
    role,
    userId: null,
    userName: "",
    approvedAt: null,
    status: 1, // 1=Pending for every step at creation time
  }));
};

exports.saveRentalDue = async (req, res) => {
  try {
    const { userType, userId, userName } = req.user;
    const { mediaId, campaignName } = req.body;
    // ── Validate required fields ───────────────────────────────
    if (!mediaId) {
      return res
        .status(400)
        .json({ success: false, message: "mediaId is required" });
    }
    if (!campaignName) {
      return res
        .status(400)
        .json({ success: false, message: "campaignName is required" });
    }

    const media = await Media.findById(mediaId);
    if (!media) {
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });
    }

    // ── Proof of campaign image (from multer, optional) ───────
    let proofOfCampaign = null;
    if (req.file) {
      proofOfCampaign = {
        originalName: req.file.originalname,
        fileName: req.file.filename,
        filePath: req.file.path,
        mimeType: req.file.mimetype,
        size: req.file.size,
        fileType: "image",
        uploadedAt: new Date(),
      };
    }
    // let proofOfCampaign = null;

    // ── Auto-derive dueDate from the site's nextBillingDate ────
    // (falls back to today if nextBillingDate isn't set yet)
    const dueDateObj = media.rentalPayment?.nextBillingDate
      ? new Date(media.rentalPayment.nextBillingDate)
      : new Date();

    // ── Approval chain — always starts as full flow: Staff → TL → Owner ──
    const steps = buildApprovalSteps();
    const firstPendingRole = steps[0].role; // always 1 (Staff) on a fresh save

    // ── Build the new rental due entry ─────────────────────────
    const newEntry = {
      dueMonth: getDueMonthLabel(dueDateObj),
      dueDate: dueDateObj,
      netPayable: media.rentalPayment?.netPayable || 0,
      paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
      campaignName,
      proofOfCampaign,
      savedBy: {
        userId,
        userName,
        role: userType,
        savedAt: new Date(),
      },
      approvalFlow: 1, // default full flow on initial save
      approvalSteps: steps,
      approvalStatus: 1, // Pending
      currentPendingRole: firstPendingRole,
      status: 1, // Pending
      updatedBy: userName,
      updatedAt: new Date(),
    };

    media.rentalDue.push(newEntry);

    // ── Append to rentalDueHistory (year → month bucket) ──────
    const yearLabel = getYearLabel(dueDateObj);
    const monthLabel = getMonthLabel(dueDateObj);

    let yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    if (!yearBucket) {
      media.rentalDueHistory.push({ year: yearLabel, months: [] });
      yearBucket = media.rentalDueHistory[media.rentalDueHistory.length - 1];
    }

    let monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
    if (!monthBucket) {
      yearBucket.months.push({ month: monthLabel, entries: [] });
      monthBucket = yearBucket.months[yearBucket.months.length - 1];
    }

    const savedEntry = media.rentalDue[media.rentalDue.length - 1];
    monthBucket.entries.push({
      // rentalDueId: savedEntry._id,
      siteName: media.mediaName,
      campaignName,
      dueDate: dueDateObj,
      netPayable: media.rentalPayment?.netPayable || 0,
      approvalStatus: 1,
      savedBy: userName,
      savedByRole: userType,
      updatedAt: new Date(),
      updatedBy: userName,
    });

    await media.save();

    return res.status(201).json({
      success: true,
      message: "Rental due entry saved successfully",
      data: {
        // rentalDueId: savedEntry._id,
        mediaId: media._id,
        mediaName: media.mediaName,
        campaignName,
        proofOfCampaign,
        dueDate: dueDateObj,
        netPayable: newEntry.netPayable,
        savedBy: {
          userId,
          userName,
          role: userType,
          roleLabel: ROLE_LABEL[userType] || "",
        },
        approvalFlow: 1,
        currentPendingRole: firstPendingRole,
        currentPendingRoleLabel: ROLE_LABEL[firstPendingRole] || "",
      },
    });
  } catch (err) {
    console.error("saveRentalDue error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
exports.getRentalDueById = async (req, res) => {
  try {
    const { mediaId, dueId } = req.params;

    const media = await Media.findById(mediaId, {
      mediaCode: 1,
      mediaName: 1,
      mediaType: 1,
      city: 1,
      state: 1,
      rentalPayment: 1,
      agreement: 1,
      rentalDue: 1,
    });

    if (!media)
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry)
      return res
        .status(404)
        .json({ success: false, message: "Rental due entry not found" });

    return res.status(200).json({
      success: true,
      data: {
        mediaCode: media.mediaCode,
        mediaName: media.mediaName,
        mediaType: media.mediaType,
        city: media.city,
        state: media.state,
        rentalPayment: media.rentalPayment,
        agreement: media.agreement,
        rentalDue: entry,
      },
    });
  } catch (err) {
    console.error("getRentalDueById error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 5. APPROVE RENTAL DUE — PATCH /rental-due/:mediaId/:dueId/approve
//
// Body: { remarks? }
// The approver's role is taken from req.user.userType.
//
// Rules:
//  - Only the role that matches currentPendingRole can approve.
//  - Owner can approve at any step (overrides the pending role).
//  - After all required steps are approved → status = 3 (Approved).
// ─────────────────────────────────────────────────────────────
exports.approveRentalDue = async (req, res) => {
  try {
    const { mediaId, dueId } = req.params;
    const { userType, userId, userName } = req.user;
    const { remarks = "" } = req.body;

    const media = await Media.findById(mediaId);
    if (!media)
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry)
      return res
        .status(404)
        .json({ success: false, message: "Rental due entry not found" });

    if (entry.status === 3) {
      return res.status(400).json({
        success: false,
        message: "This entry is already fully approved",
      });
    }

    // ── Authorisation ─────────────────────────────────────────
    // Owner (role 3) can ALWAYS approve regardless of current pending role.
    // Others must match currentPendingRole exactly.
    if (userType !== 3 && userType !== entry.currentPendingRole) {
      const pendingLabel =
        entry.currentPendingRole === 1
          ? "Staff"
          : entry.currentPendingRole === 2
            ? "Team Lead"
            : "Owner";
      return res.status(403).json({
        success: false,
        message: `Approval is currently awaiting ${pendingLabel}. You cannot approve at this stage.`,
      });
    }

    // ── Mark steps ────────────────────────────────────────────
    const now = new Date();

    if (userType === 3) {
      // Owner approving: skip any still-pending lower roles, approve owner step
      entry.approvalSteps.forEach((step) => {
        if (step.status === 1) {
          if (step.role === 3) {
            // This is owner's own step
            step.status = 2; // Approved
            step.userId = userId;
            step.userName = userName;
            step.approvedAt = now;
            step.remarks = remarks;
          } else {
            // Lower role still pending → mark as Skipped (3)
            step.status = 3;
          }
        }
      });
    } else {
      // Non-owner: mark only their own step
      const myStep = entry.approvalSteps.find(
        (s) => s.role === userType && s.status === 1,
      );
      if (!myStep) {
        return res.status(400).json({
          success: false,
          message: "Your approval step not found or already completed",
        });
      }
      myStep.status = 2;
      myStep.userId = userId;
      myStep.userName = userName;
      myStep.approvedAt = now;
      myStep.remarks = remarks;
    }

    // ── Determine next pending role ───────────────────────────
    const remaining = entry.approvalSteps.find((s) => s.status === 1);

    if (remaining) {
      // Still more steps to go
      entry.currentPendingRole = remaining.role;
      entry.approvalStatus = 2; // PartiallyApproved
      entry.status = 2;
    } else {
      // All steps done → fully approved
      entry.currentPendingRole = null;
      entry.approvalStatus = 3; // Approved
      entry.status = 3;
    }

    entry.updatedBy = userName;
    entry.updatedAt = now;

    // ── Update history bucket ─────────────────────────────────
    const yearLabel = getYearLabel(entry.dueDate);
    const monthLabel = getMonthLabel(entry.dueDate);
    const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    if (yearBucket) {
      const monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
      if (monthBucket) {
        const histEntry = monthBucket.entries.find(
          (e) => e.rentalDueId?.toString() === dueId,
        );
        if (histEntry) {
          histEntry.approvalStatus = entry.approvalStatus;
          histEntry.updatedAt = now;
          histEntry.updatedBy = userName;
        }
      }
    }

    await media.save();

    return res.status(200).json({
      success: true,
      message:
        entry.status === 3
          ? "Rental due fully approved"
          : `Approved by ${userType === 1 ? "Staff" : userType === 2 ? "Team Lead" : "Owner"}. Waiting for next approval.`,
      data: {
        rentalDueId: dueId,
        approvalStatus: entry.approvalStatus,
        currentPendingRole: entry.currentPendingRole,
        status: entry.status,
        approvalSteps: entry.approvalSteps,
      },
    });
  } catch (err) {
    console.error("approveRentalDue error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 6. VERIFY AGREEMENT DOC — PATCH /rental-due/:mediaId/:dueId/verify-agreement
// Allows any role to mark the agreement doc as verified on an existing entry.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 7. IDENTIFY APPROVAL GAP — GET /rental-due/:mediaId/:dueId/approval-gap
// Shows at a glance who has approved and who is still pending.
// ─────────────────────────────────────────────────────────────
exports.getApprovalGap = async (req, res) => {
  try {
    const { mediaId, dueId } = req.params;

    const media = await Media.findById(mediaId, { rentalDue: 1, mediaName: 1 });
    if (!media)
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry)
      return res
        .status(404)
        .json({ success: false, message: "Rental due entry not found" });

    const roleName = (r) =>
      r === 1 ? "Staff" : r === 2 ? "Team Lead" : "Owner";

    const steps = (entry.approvalSteps || []).map((s) => ({
      role: s.role,
      roleLabel: roleName(s.role),
      status:
        s.status === 1 ? "Pending" : s.status === 2 ? "Approved" : "Skipped",
      approvedBy: s.userName || null,
      approvedAt: s.approvedAt || null,
    }));

    // Identify specific gaps
    const staffStep = steps.find((s) => s.role === 1);
    const tlStep = steps.find((s) => s.role === 2);
    const ownerStep = steps.find((s) => s.role === 3);

    const gaps = [];
    if (staffStep?.status === "Approved" && tlStep?.status === "Pending") {
      gaps.push("Staff has approved but Team Lead approval is still pending");
    }
    if (tlStep?.status === "Approved" && ownerStep?.status === "Pending") {
      gaps.push("Team Lead has approved but Owner approval is still pending");
    }
    if (
      staffStep?.status === "Pending" &&
      !tlStep &&
      ownerStep?.status === "Pending"
    ) {
      gaps.push("Awaiting Staff approval before Owner can approve");
    }

    return res.status(200).json({
      success: true,
      data: {
        rentalDueId: dueId,
        mediaName: media.mediaName,
        approvalFlow: entry.approvalFlow,
        approvalFlowLabel:
          entry.approvalFlow === 1
            ? "Staff → Team Lead → Owner"
            : entry.approvalFlow === 2
              ? "Team Lead → Owner"
              : "Owner Only",
        currentPendingRole: entry.currentPendingRole,
        currentPendingRoleLabel: entry.currentPendingRole
          ? roleName(entry.currentPendingRole)
          : "None",
        overallStatus:
          entry.status === 1
            ? "Pending"
            : entry.status === 2
              ? "Partially Approved"
              : entry.status === 3
                ? "Approved"
                : "Overdue",
        steps,
        gaps,
        agreementDocVerified:
          entry.agreementDocVerification?.isVerified || false,
      },
    });
  } catch (err) {
    console.error("getApprovalGap error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 8. RENTAL DUE HISTORY — GET /rental-due/:mediaId/history
// ─────────────────────────────────────────────────────────────
exports.getRentalDueHistory = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { year, month } = req.query;

    const media = await Media.findById(mediaId, {
      mediaName: 1,
      rentalDueHistory: 1,
    });
    if (!media)
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });

    let history = media.rentalDueHistory;

    if (year) {
      history = history.filter((y) => y.year === String(year));
    }
    if (month && history.length) {
      history = history.map((y) => ({
        ...y.toObject(),
        months: y.months.filter(
          (m) => m.month.toLowerCase() === month.toLowerCase(),
        ),
      }));
    }

    return res.status(200).json({
      success: true,
      data: {
        mediaName: media.mediaName,
        history,
      },
    });
  } catch (err) {
    console.error("getRentalDueHistory error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
