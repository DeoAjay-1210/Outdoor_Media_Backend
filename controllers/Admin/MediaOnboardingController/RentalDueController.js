// controllers/rentalDue.controller.js
const mongoose = require("mongoose");
const Media    = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const path     = require("path");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const FREQ_LABEL = { 1: "Monthly", 2: "2 Months", 3: "3 Months", 4: "6 Months", 5: "Yearly", 6: "2 Years" };

const getDueMonthLabel = (date) => {
  const d = new Date(date);
  return d.toLocaleString("en-IN", { month: "long", year: "numeric" });
};

const getYearLabel  = (date) => String(new Date(date).getFullYear());
const getMonthLabel = (date) => new Date(date).toLocaleString("en-IN", { month: "long" });

/**
 * Build the initial approvalSteps array based on the chosen flow.
 * Flow 1 = Staff → TeamLead → Owner
 * Flow 2 = TeamLead → Owner  (owner granted TL permission)
 * Flow 3 = Owner Only
 */
const buildApprovalSteps = (flow, savedByRole, savedByUserId, savedByUserName) => {
  const roles = flow === 1 ? [1, 2, 3] : flow === 2 ? [2, 3] : [3];
  return roles.map((role) => ({
    role,
    userId:   savedByUserId,   // placeholder — real userId assigned on approve
    userName: "",
    approvedAt: null,
    // If the person saving already satisfies this step, mark it Approved
    status: role === savedByRole && flow !== 1 ? 1 : 1, // start all as Pending
  }));
};

/** Determine which role should be pending next after an approval */
const nextPendingRole = (steps) => {
  const pending = steps.find((s) => s.status === 1);
  return pending ? pending.role : null;
};


exports.getRentalDueListWithStats = async (req, res) => {
  try {
    const {
      dueDate,        // "2026-06" (YYYY-MM format)
      city,
      mediaType,
      frequency,      // paymentFrequency number
      status,
      search,
      pageNumber = 1,
      count = 10,
    } = req.body;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // ── Parse pagination ──────────────────────────────────────
    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;
    const skip = (pageNumbers - 1) * pageSize;

    // ── Parse dueDate (YYYY-MM) ──────────────────────────────
    let dateFilter = {};
    
    if (dueDate) {
      // Validate format YYYY-MM
      if (!dueDate.match(/^\d{4}-\d{2}$/)) {
        return res.status(400).json({
          success: false,
          message: "Invalid dueDate format. Please use YYYY-MM (e.g., 2026-06)"
        });
      }
      
      const [yr, mo] = dueDate.split("-").map(Number);
      const start = new Date(yr, mo - 1, 1);
      const end = new Date(yr, mo, 0, 23, 59, 59);
      
      dateFilter = {
        $gte: start,
        $lte: end
      };
    } else {
      // Default: current month
      dateFilter = {
        $gte: monthStart,
        $lte: monthEnd
      };
    }

    // ── Status mapping ─────────────────────────────────────────
    const statusMap = { 
      pending: 1, 
      partiallyapproved: 2, 
      approved: 3, 
      overdue: 4 
    };
    
    let statusFilter = null;
    if (status !== undefined && status !== null && status !== '') {
      const parsed = parseInt(status, 10);
      statusFilter = isNaN(parsed)
        ? statusMap[String(status).toLowerCase()] || null
        : parsed;
    }

    // ── Media-level match ─────────────────────────────────────
    const mediaMatch = {};
    if (city) mediaMatch.city = { $regex: city, $options: "i" };
    if (mediaType) mediaMatch.mediaType = { $regex: mediaType, $options: "i" };
    
    // ── Search filter ──────────────────────────────────────────
    let searchFilter = {};
    if (search) {
      searchFilter = {
        $or: [
          { mediaCode: { $regex: search, $options: "i" } },
          { mediaName: { $regex: search, $options: "i" } },
          { city: { $regex: search, $options: "i" } },
          { location: { $regex: search, $options: "i" } },
        ]
      };
    }

    // Combine media match with search
    const finalMediaMatch = {
      ...mediaMatch,
      ...searchFilter
    };

    // ── Base pipeline for filtering rentalDue entries ────────
    const basePipeline = [
      { $match: finalMediaMatch },
      { $unwind: "$rentalDue" },
      { $match: { "rentalDue.dueDate": dateFilter } },
      ...(frequency ? [{ $match: { "rentalDue.paymentFrequency": parseInt(frequency, 10) } }] : []),
      ...(statusFilter !== null ? [{ $match: { "rentalDue.status": statusFilter } }] : []),
    ];

    // ── STATISTICS CALCULATION ─────────────────────────────────
    
    // 1. Total Sites
    const totalSites = await Media.countDocuments({ status: 1 });

    // 2. Due This Month - Calculate totalNetPayable from rentalDue
    const dueThisMonthAgg = await Media.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: null,
          totalNetPayable: { $sum: "$rentalDue.netPayable" },
          count: { $sum: 1 },
        },
      },
    ]);

    const dueThisMonth = {
      totalNetPayable: dueThisMonthAgg[0]?.totalNetPayable || 0,
      count: dueThisMonthAgg[0]?.count || 0,
    };

    // 3. OverDue - Sites where rentalPayment.status === 3
    const overDueCount = await Media.countDocuments({
      "rentalPayment.status": 3,
    });

    // Overdue entries from rentalDue where status === 4
    const overDueEntriesAgg = await Media.aggregate([
      ...basePipeline,
      { $match: { "rentalDue.status": 4 } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);
    const overDueEntries = overDueEntriesAgg[0]?.count || 0;

    // 4. Pending Approval
    const approvalBreakdownAgg = await Media.aggregate([
      ...basePipeline,
      {
        $match: {
          "rentalDue.approvalStatus": { $in: [1, 2] }, // Pending or Partial
        },
      },
      {
        $group: {
          _id: "$rentalDue.currentPendingRole",
          count: { $sum: 1 },
        },
      },
    ]);

    const pendingByRole = { staff: 0, teamLead: 0, owner: 0, total: 0 };
    approvalBreakdownAgg.forEach(({ _id, count }) => {
      if (_id === 1) pendingByRole.staff = count;
      if (_id === 2) pendingByRole.teamLead = count;
      if (_id === 3) pendingByRole.owner = count;
      pendingByRole.total += count;
    });

    // Staff approved but TeamLead hasn't
    const staffApprovedTLPendingAgg = await Media.aggregate([
      ...basePipeline,
      {
        $match: {
          "rentalDue.approvalSteps": {
            $elemMatch: { role: 1, status: 2 },
          },
          "rentalDue.currentPendingRole": 2,
        },
      },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);

    const tlPendingAfterStaff = staffApprovedTLPendingAgg[0]?.count || 0;

    // TeamLead approved but Owner hasn't
    const tlApprovedOwnerPendingAgg = await Media.aggregate([
      ...basePipeline,
      {
        $match: {
          "rentalDue.approvalSteps": {
            $elemMatch: { role: 2, status: 2 },
          },
          "rentalDue.currentPendingRole": 3,
        },
      },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);

    const ownerPendingAfterTL = tlApprovedOwnerPendingAgg[0]?.count || 0;

    // ── LIST DATA WITH PAGINATION ──────────────────────────────
    const pipeline = [
      ...basePipeline,
      {
        $project: {
          _id: 1,
          mediaCode: 1,
          mediaName: 1,
          mediaType: 1,
          city: 1,
          state: 1,
          location: 1,
          "rentalPayment.netPayable": 1,
          "rentalPayment.paymentFrequency": 1,
          "rentalPayment.status": 1,
          rentalDue: 1,
        },
      },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: pageSize },
          ],
          total: [{ $count: "count" }],
        },
      },
    ];

    const result = await Media.aggregate(pipeline);
    const data = result[0]?.data || [];
    const total = result[0]?.total[0]?.count || 0;

    // ── Enrich with human-readable labels ─────────────────────
    const FREQ_LABEL = {
      1: "Monthly",
      2: "Quarterly",
      3: "Half-Yearly",
      4: "Yearly",
    };

    const enriched = data.map((item) => {
      const rd = item.rentalDue;
      return {
        ...item,
        rentalDue: {
          ...rd,
          statusLabel: ["", "Pending", "Partially Approved", "Approved", "Overdue"][rd.status] || "",
          approvalStatusLabel: ["", "Pending", "Partially Approved", "Approved", "Overdue"][rd.approvalStatus] || "",
          paymentFrequencyLabel: FREQ_LABEL[rd.paymentFrequency] || "",
          currentPendingRoleLabel: rd.currentPendingRole === 1 ? "Staff"
            : rd.currentPendingRole === 2 ? "Team Lead"
            : rd.currentPendingRole === 3 ? "Owner" : "",
          approvalSummary: (rd.approvalSteps || []).map((s) => ({
            role: s.role === 1 ? "Staff" : s.role === 2 ? "Team Lead" : "Owner",
            status: s.status === 1 ? "Pending" : s.status === 2 ? "Approved" : "Skipped",
            userName: s.userName,
            approvedAt: s.approvedAt,
          })),
        },
      };
    });

    // ── FINAL RESPONSE ──────────────────────────────────────────
    return res.status(200).json({
      success: true,
      stats: {
        totalSites,
        dueThisMonth,
        overDue: {
          siteCount: overDueCount,
          entryCount: overDueEntries,
        },
        pendingApproval: {
          staff: pendingByRole.staff,
          teamLead: pendingByRole.teamLead,
          owner: pendingByRole.owner,
          total: pendingByRole.total,
          staffApprovedTLPending: tlPendingAfterStaff,
          tlApprovedOwnerPending: ownerPendingAfterTL,
        },
      },
      data: enriched,
      pagination: {
        total,
        pageNumber: pageNumbers,
        count: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
      
    });
  } catch (err) {
    console.error("getRentalDueListWithStats error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message
    });
  }
};
// ─────────────────────────────────────────────────────────────
// 3. GET SINGLE RENTAL DUE ENTRY — GET /rental-due/:mediaId/:dueId
// ─────────────────────────────────────────────────────────────
exports.getRentalDueById = async (req, res) => {
  try {
    const { mediaId, dueId } = req.params;

    const media = await Media.findById(mediaId, {
      mediaCode: 1, mediaName: 1, mediaType: 1, city: 1, state: 1,
      rentalPayment: 1, agreement: 1, rentalDue: 1,
    });

    if (!media) return res.status(404).json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry) return res.status(404).json({ success: false, message: "Rental due entry not found" });

    return res.status(200).json({
      success: true,
      data: {
        mediaCode: media.mediaCode,
        mediaName: media.mediaName,
        mediaType: media.mediaType,
        city:      media.city,
        state:     media.state,
        rentalPayment: media.rentalPayment,
        agreement:     media.agreement,
        rentalDue:     entry,
      },
    });
  } catch (err) {
    console.error("getRentalDueById error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 4. SAVE RENTAL DUE — POST /rental-due/:mediaId/save
//
// Body (multipart/form-data):
//   campaignName      (string)
//   dueDate           (ISO date string)
//   approvalFlow      (1 | 2 | 3)   — optional, defaults to 1
//   verifyAgreementDoc (0 | 1)      — did the user verify the agreement doc?
//   proofOfCampaign   (file)
//
// req.user must be populated by auth middleware.
// ─────────────────────────────────────────────────────────────
exports.saveRentalDue = async (req, res) => {
  try {
    const { mediaId }   = req.params;
    const { resolvedRole, userId, userName } = req.user;

    const {
      campaignName,
      dueDate,
      approvalFlow       = 1,
      verifyAgreementDoc = 0,
    } = req.body;

    if (!campaignName) return res.status(400).json({ success: false, message: "campaignName is required" });
    if (!dueDate)      return res.status(400).json({ success: false, message: "dueDate is required" });

    const parsedFlow = parseInt(approvalFlow, 10);
    if (![1, 2, 3].includes(parsedFlow)) {
      return res.status(400).json({ success: false, message: "approvalFlow must be 1, 2, or 3" });
    }

    // Only Owner can set flow 2 (skip staff) or flow 3 (owner only)
    if ((parsedFlow === 2 || parsedFlow === 3) && resolvedRole !== 3) {
      return res.status(403).json({
        success: false,
        message: "Only Owner can configure approval flow 2 or 3",
      });
    }

    const media = await Media.findById(mediaId);
    if (!media) return res.status(404).json({ success: false, message: "Media not found" });

    // ── Agreement doc verification ────────────────────────────
    const isVerified = parseInt(verifyAgreementDoc, 10) === 1;
    const agreementDocVerification = {
      isVerified,
      verifiedBy:     isVerified ? userName : null,
      verifiedByRole: isVerified ? resolvedRole : null,
      verifiedAt:     isVerified ? new Date() : null,
      // Snapshot the current agreement PDF
      agreementPDF:   isVerified ? (media.agreement?.agreementPDF || {}) : {},
    };

    // ── Proof of campaign image (from multer) ─────────────────
    let proofOfCampaign = null;
    if (req.file) {
      proofOfCampaign = {
        originalName: req.file.originalname,
        fileName:     req.file.filename,
        filePath:     req.file.path,
        mimeType:     req.file.mimetype,
        size:         req.file.size,
        fileType:     "image",
        uploadedAt:   new Date(),
      };
    }

    // ── Build approval steps ──────────────────────────────────
    const steps = buildApprovalSteps(parsedFlow, resolvedRole, userId, userName);

    // Determine first pending role
    const firstPendingRole = steps[0]?.role || resolvedRole;

    // ── Build the new rental due entry ────────────────────────
    const dueDateObj = new Date(dueDate);
    const newEntry = {
      dueMonth:         getDueMonthLabel(dueDateObj),
      dueDate:          dueDateObj,
      netPayable:       media.rentalPayment?.netPayable || 0,
      paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
      campaignName,
      proofOfCampaign,
      agreementDocVerification,
      savedBy: {
        userId,
        userName,
        role:    resolvedRole,
        savedAt: new Date(),
      },
      approvalFlow:       parsedFlow,
      approvalSteps:      steps,
      approvalStatus:     1,  // Pending
      currentPendingRole: firstPendingRole,
      status:             1,  // Pending
      updatedBy:          userName,
      updatedAt:          new Date(),
    };

    media.rentalDue.push(newEntry);

    // ── Append to rentalDueHistory (year → month bucket) ─────
    const yearLabel  = getYearLabel(dueDateObj);
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

    // Get the new entry's _id (populated after push)
    const savedEntry = media.rentalDue[media.rentalDue.length - 1];
    monthBucket.entries.push({
      rentalDueId:    savedEntry._id,
      siteName:       media.mediaName,
      campaignName,
      dueDate:        dueDateObj,
      netPayable:     media.rentalPayment?.netPayable || 0,
      approvalStatus: 1,
      savedBy:        userName,
      savedByRole:    resolvedRole,
      updatedAt:      new Date(),
      updatedBy:      userName,
    });

    await media.save();

    return res.status(201).json({
      success:   true,
      message:   "Rental due entry saved successfully",
      data: {
        rentalDueId:  savedEntry._id,
        mediaId:      media._id,
        mediaName:    media.mediaName,
        campaignName,
        dueDate:      dueDateObj,
        savedBy: {
          userId,
          userName,
          role:      resolvedRole,
          roleLabel: resolvedRole === 1 ? "Staff" : resolvedRole === 2 ? "Team Lead" : "Owner",
        },
        approvalFlow:       parsedFlow,
        currentPendingRole: firstPendingRole,
        agreementDocVerified: isVerified,
      },
    });
  } catch (err) {
    console.error("saveRentalDue error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 5. APPROVE RENTAL DUE — PATCH /rental-due/:mediaId/:dueId/approve
//
// Body: { remarks? }
// The approver's role is taken from req.user.resolvedRole.
//
// Rules:
//  - Only the role that matches currentPendingRole can approve.
//  - Owner can approve at any step (overrides the pending role).
//  - After all required steps are approved → status = 3 (Approved).
// ─────────────────────────────────────────────────────────────
exports.approveRentalDue = async (req, res) => {
  try {
    const { mediaId, dueId }         = req.params;
    const { resolvedRole, userId, userName } = req.user;
    const { remarks = "" }           = req.body;

    const media = await Media.findById(mediaId);
    if (!media) return res.status(404).json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry) return res.status(404).json({ success: false, message: "Rental due entry not found" });

    if (entry.status === 3) {
      return res.status(400).json({ success: false, message: "This entry is already fully approved" });
    }

    // ── Authorisation ─────────────────────────────────────────
    // Owner (role 3) can ALWAYS approve regardless of current pending role.
    // Others must match currentPendingRole exactly.
    if (resolvedRole !== 3 && resolvedRole !== entry.currentPendingRole) {
      const pendingLabel = entry.currentPendingRole === 1 ? "Staff"
        : entry.currentPendingRole === 2 ? "Team Lead" : "Owner";
      return res.status(403).json({
        success: false,
        message: `Approval is currently awaiting ${pendingLabel}. You cannot approve at this stage.`,
      });
    }

    // ── Mark steps ────────────────────────────────────────────
    const now = new Date();

    if (resolvedRole === 3) {
      // Owner approving: skip any still-pending lower roles, approve owner step
      entry.approvalSteps.forEach((step) => {
        if (step.status === 1) {
          if (step.role === 3) {
            // This is owner's own step
            step.status     = 2; // Approved
            step.userId     = userId;
            step.userName   = userName;
            step.approvedAt = now;
            step.remarks    = remarks;
          } else {
            // Lower role still pending → mark as Skipped (3)
            step.status = 3;
          }
        }
      });
    } else {
      // Non-owner: mark only their own step
      const myStep = entry.approvalSteps.find((s) => s.role === resolvedRole && s.status === 1);
      if (!myStep) {
        return res.status(400).json({ success: false, message: "Your approval step not found or already completed" });
      }
      myStep.status     = 2;
      myStep.userId     = userId;
      myStep.userName   = userName;
      myStep.approvedAt = now;
      myStep.remarks    = remarks;
    }

    // ── Determine next pending role ───────────────────────────
    const remaining = entry.approvalSteps.find((s) => s.status === 1);

    if (remaining) {
      // Still more steps to go
      entry.currentPendingRole = remaining.role;
      entry.approvalStatus     = 2; // PartiallyApproved
      entry.status             = 2;
    } else {
      // All steps done → fully approved
      entry.currentPendingRole = null;
      entry.approvalStatus     = 3; // Approved
      entry.status             = 3;
    }

    entry.updatedBy = userName;
    entry.updatedAt = now;

    // ── Update history bucket ─────────────────────────────────
    const yearLabel  = getYearLabel(entry.dueDate);
    const monthLabel = getMonthLabel(entry.dueDate);
    const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    if (yearBucket) {
      const monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
      if (monthBucket) {
        const histEntry = monthBucket.entries.find(
          (e) => e.rentalDueId?.toString() === dueId
        );
        if (histEntry) {
          histEntry.approvalStatus = entry.approvalStatus;
          histEntry.updatedAt      = now;
          histEntry.updatedBy      = userName;
        }
      }
    }

    await media.save();

    return res.status(200).json({
      success: true,
      message: entry.status === 3
        ? "Rental due fully approved"
        : `Approved by ${resolvedRole === 1 ? "Staff" : resolvedRole === 2 ? "Team Lead" : "Owner"}. Waiting for next approval.`,
      data: {
        rentalDueId:        dueId,
        approvalStatus:     entry.approvalStatus,
        currentPendingRole: entry.currentPendingRole,
        status:             entry.status,
        approvalSteps:      entry.approvalSteps,
      },
    });
  } catch (err) {
    console.error("approveRentalDue error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 6. VERIFY AGREEMENT DOC — PATCH /rental-due/:mediaId/:dueId/verify-agreement
// Allows any role to mark the agreement doc as verified on an existing entry.
// ─────────────────────────────────────────────────────────────
exports.verifyAgreementDoc = async (req, res) => {
  try {
    const { mediaId, dueId }         = req.params;
    const { resolvedRole, userName } = req.user;

    const media = await Media.findById(mediaId);
    if (!media) return res.status(404).json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry) return res.status(404).json({ success: false, message: "Rental due entry not found" });

    entry.agreementDocVerification = {
      isVerified:     true,
      verifiedBy:     userName,
      verifiedByRole: resolvedRole,
      verifiedAt:     new Date(),
      agreementPDF:   media.agreement?.agreementPDF || {},
    };

    entry.updatedBy = userName;
    entry.updatedAt = new Date();

    await media.save();

    return res.status(200).json({
      success: true,
      message: "Agreement document verified successfully",
      data:    entry.agreementDocVerification,
    });
  } catch (err) {
    console.error("verifyAgreementDoc error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 7. IDENTIFY APPROVAL GAP — GET /rental-due/:mediaId/:dueId/approval-gap
// Shows at a glance who has approved and who is still pending.
// ─────────────────────────────────────────────────────────────
exports.getApprovalGap = async (req, res) => {
  try {
    const { mediaId, dueId } = req.params;

    const media = await Media.findById(mediaId, { rentalDue: 1, mediaName: 1 });
    if (!media) return res.status(404).json({ success: false, message: "Media not found" });

    const entry = media.rentalDue.id(dueId);
    if (!entry) return res.status(404).json({ success: false, message: "Rental due entry not found" });

    const roleName = (r) => r === 1 ? "Staff" : r === 2 ? "Team Lead" : "Owner";

    const steps = (entry.approvalSteps || []).map((s) => ({
      role:      s.role,
      roleLabel: roleName(s.role),
      status:    s.status === 1 ? "Pending" : s.status === 2 ? "Approved" : "Skipped",
      approvedBy: s.userName || null,
      approvedAt: s.approvedAt || null,
    }));

    // Identify specific gaps
    const staffStep  = steps.find((s) => s.role === 1);
    const tlStep     = steps.find((s) => s.role === 2);
    const ownerStep  = steps.find((s) => s.role === 3);

    const gaps = [];
    if (staffStep?.status === "Approved" && tlStep?.status === "Pending") {
      gaps.push("Staff has approved but Team Lead approval is still pending");
    }
    if (tlStep?.status === "Approved" && ownerStep?.status === "Pending") {
      gaps.push("Team Lead has approved but Owner approval is still pending");
    }
    if (staffStep?.status === "Pending" && !tlStep && ownerStep?.status === "Pending") {
      gaps.push("Awaiting Staff approval before Owner can approve");
    }

    return res.status(200).json({
      success: true,
      data: {
        rentalDueId:        dueId,
        mediaName:          media.mediaName,
        approvalFlow:       entry.approvalFlow,
        approvalFlowLabel:  entry.approvalFlow === 1 ? "Staff → Team Lead → Owner"
                          : entry.approvalFlow === 2 ? "Team Lead → Owner"
                          : "Owner Only",
        currentPendingRole: entry.currentPendingRole,
        currentPendingRoleLabel: entry.currentPendingRole ? roleName(entry.currentPendingRole) : "None",
        overallStatus:      entry.status === 1 ? "Pending"
                          : entry.status === 2 ? "Partially Approved"
                          : entry.status === 3 ? "Approved"
                          : "Overdue",
        steps,
        gaps,
        agreementDocVerified: entry.agreementDocVerification?.isVerified || false,
      },
    });
  } catch (err) {
    console.error("getApprovalGap error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// 8. RENTAL DUE HISTORY — GET /rental-due/:mediaId/history
// ─────────────────────────────────────────────────────────────
exports.getRentalDueHistory = async (req, res) => {
  try {
    const { mediaId }        = req.params;
    const { year, month }    = req.query;

    const media = await Media.findById(mediaId, {
      mediaName: 1, rentalDueHistory: 1,
    });
    if (!media) return res.status(404).json({ success: false, message: "Media not found" });

    let history = media.rentalDueHistory;

    if (year) {
      history = history.filter((y) => y.year === String(year));
    }
    if (month && history.length) {
      history = history.map((y) => ({
        ...y.toObject(),
        months: y.months.filter((m) => m.month.toLowerCase() === month.toLowerCase()),
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
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};