// controllers/rentalDue.controller.js
const mongoose = require("mongoose");
const axios = require("axios");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const path = require("path");
const {
  ROLE,
  ROLE_LABEL,
  ROLE_FLAG_KEY,
  FLOW_CHAIN,
} = require("../../../models/Admin/MediaOnboardingSchema/RentalDueModel");
const {
  getDueMonthLabel,
  getYearLabel,
  getMonthLabel,
} = require("../../../utils/Datehelpers");
const { FREQ_LABEL, STATUS_LABEL } = require("../../../utils/Labels");

const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

const buildApprovalSteps = (approvalFlow) => {
  const chain = FLOW_CHAIN[approvalFlow] || FLOW_CHAIN[1];
  return chain.map((role) => ({
    role,
    userId: null,
    userName: "",
    approvedAt: null,
    status: 1, // Pending
    docVerified: false,
  }));
};

function getAgreementVerificationStatus(item) {
  const history = item.agreementDocVerification || [];
  const currentFile = item.agreement?.agreementPDF?.fileName;

  const isRoleVerified = (role) => {
    const roleRecords = history
      .filter((h) => h.verifiedByRole === role && h.isVerified)
      .sort((a, b) => new Date(b.verifiedAt) - new Date(a.verifiedAt));

    const latest = roleRecords[0];
    if (!latest) return false;

    const verifiedFile = latest.agreementPDF?.fileName;
    if (currentFile && verifiedFile) {
      return currentFile === verifiedFile;
    }
    return true;
  };

  return {
    staff: isRoleVerified(ROLE.STAFF),
    teamLead: isRoleVerified(ROLE.TEAM_LEAD),
    owner: isRoleVerified(ROLE.OWNER),
  };
}

const RENTAL_STATUS_MAP = {
  [ROLE.STAFF]: 1,
  [ROLE.TEAM_LEAD]: 2,
  [ROLE.OWNER]: 3,
};

// paymentFrequency -> number of months to add
const FREQUENCY_MONTHS_MAP = {
  1: 1, // 1 month
  2: 2, // 2 months
  3: 3, // 3 months
  4: 6, // 6 months
  5: 12, // 1 year
  6: 24, // 2 years
};

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function resetLiveAgreementFlags(media) {
  media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
}

function pushVerificationHistory(media, entry, role, userName) {
  const alreadyLogged = media.agreementDocVerificationHistory.some(
    (v) =>
      String(v.rentalDueId) === String(entry._id) && v.verifiedByRole === role,
  );
  if (alreadyLogged) return;

  media.agreementDocVerificationHistory.push({
    isVerified: true,
    verifiedBy: userName,
    verifiedByRole: role,
    verifiedAt: nowIST(),
    rentalDueId: entry._id,
    dueMonth: entry.dueMonth,
    dueDate: entry.dueDate,
    agreementPDF: media.agreement?.agreementPDF || {},
    updatedAt: nowIST(),
    updatedBy: userName,
  });
}

function markRoleVerified(media, entry, role, userName) {
  media.agreementDocVerified[ROLE_FLAG_KEY[role]] = true;
  pushVerificationHistory(media, entry, role, userName);
}

function advanceRentalPaymentOnOwnerApproval(media) {
  const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
  const frequency = media.rentalPayment?.paymentFrequency;

  const frequencyMap = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 12, 6: 24 };
  const monthsToAdd =
    frequency === 7
      ? Number(media.rentalPayment?.customPaymentFrequency) || 1 // ✅ added
      : frequencyMap[frequency] || 1;

  const baseDate = currentNextBillingDate
    ? new Date(currentNextBillingDate)
    : new Date();

  media.rentalPayment.lastBillPaidDate = baseDate;
  media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);

  resetLiveAgreementFlags(media);
}

function getAgreementVerificationStatus(media) {
  const f = media.agreementDocVerified || {};
  if (f.staff && f.teamLead && f.owner) return "Fully Verified";
  if (f.staff || f.teamLead || f.owner) return "Partially Verified";
  return "Not Verified";
}

// Computes the base/gst/netPayable split for a rentalDue entry based on
// the requested withGst mode, using the media's CURRENT rentalPayment
// figures as the source of truth for this cycle.
function computeGstSplit(media, withGst) {
  const totalRentalAmount = media.rentalPayment?.netPayable || 0;
  const gstAmountFull = media.rentalPayment?.gstAmount || 0;
  const totalWithGst =
    media.rentalPayment?.totalRentalAmountWithGst ||
    totalRentalAmount + gstAmountFull;

  if (withGst === 1) {
    // With GST: client billed ONLY the base amount; GST held back to be
    // tracked in balanceGstAmount (pending remittance to government).
    return {
      baseAmount: totalRentalAmount,
      gstAmount: gstAmountFull,
      netPayable: totalRentalAmount,
    };
  }

  // withGst === 2 (Without GST): client billed the full inclusive amount,
  // nothing held back / tracked separately.
  return {
    baseAmount: totalWithGst,
    gstAmount: 0,
    netPayable: totalWithGst,
  };
}

// Adds this entry's GST amount to the running balanceGstAmount tracker —
// call this at the moment the cycle is CLOSED (Owner's final approval),
// not at creation, since that's when the billing amount is considered
// finalized for the cycle.
// function addGstToBalanceIfApplicable(media, entry) {
//   if (entry.gstAddedToBalance) return; // already counted — never add twice

//   if (entry?.withGst === 1 && entry.gstAmount > 0) {
//     media.rentalPayment.balanceGstAmount =
//       (media.rentalPayment.balanceGstAmount || 0) + entry.gstAmount;
//     media.markModified("rentalPayment");
//     entry.gstAddedToBalance = true; // ✅ mark so later approval steps don't re-add
//   }
// }
// exports.saveRentalDue = async (req, res) => {
//   try {
//     const { userType, userId, userName } = req.user;
//     const { mediaId, campaignName } = req.body;

//     if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
//       return res
//         .status(400)
//         .json({ success: false, message: "A valid mediaId is required" });
//     }
//     if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
//       return res
//         .status(403)
//         .json({ success: false, message: "Invalid or missing user role" });
//     }

//     const media = await Media.findById(mediaId);
//     if (!media) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Media not found" });
//     }

//     // Defensive init — older docs saved before this migration may not
//     // have these fields yet.
//     if (!media.agreementDocVerified) {
//       media.agreementDocVerified = {
//         staff: false,
//         teamLead: false,
//         owner: false,
//       };
//     }
//     if (!media.agreementDocVerificationHistory) {
//       media.agreementDocVerificationHistory = [];
//     }
//     if (!Array.isArray(media.rentalDueEntries)) {
//       media.rentalDueEntries = Array.isArray(media.rentalDue)
//         ? media.rentalDue
//         : [];
//     }
//     if (!Array.isArray(media.rentalDueHistory)) {
//       media.rentalDueHistory = [];
//     }
//     if (!Array.isArray(media.agreementDocVerification)) {
//       media.agreementDocVerification = [];
//     }

//     // ══════════════════════════════════════════════════════════════
//     // 🔒 NEW GUARD — "verify first, then save"
//     // The caller's role must have already verified the agreement
//     // document (via verifyAgreementDoc) for the CURRENT billing
//     // cycle before they're allowed to create OR approve a rental
//     // due entry. This applies identically to Staff, Team Lead and
//     // Owner, and to both branches below (approval + create), since
//     // it's checked before the branch split.
//     //
//     // Reuses the exact same cycle-matching logic as verifyAgreementDoc
//     // (getCurrentCycle + isSameCycle via getTime comparison) so the
//     // "current cycle" here always matches the one verification was
//     // recorded against — no drift between the two endpoints.
//     // ══════════════════════════════════════════════════════════════
//     const currentCycleForVerification = getCurrentCycle(
//       media.rentalPayment?.nextBillingDate,
//     );

//     if (!currentCycleForVerification) {
//       return res.status(400).json({
//         success: false,
//         message: "Unable to determine current billing cycle",
//       });
//     }

//     const isSameCycle = (a, b) => {
//       if (!a || !b) return false;
//       const t1 = new Date(a).getTime();
//       const t2 = new Date(b).getTime();
//       return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
//     };

//     // const hasVerifiedThisCycle = media.agreementDocVerification.some(
//     //   (h) =>
//     //     h.isVerified &&
//     //     h.verifiedByRole === userType &&
//     //     isSameCycle(h.cycle, currentCycleForVerification),
//     // );

//     // if (!hasVerifiedThisCycle) {
//     //   return res.status(400).json({
//     //     success: false,
//     //     message: `${ROLE_LABEL[userType]} must verify the agreement document for the billing cycle starting ${formatDate(currentCycleForVerification)} before saving`,
//     //   });
//     // }
//     const currentCycleVerificationsForSave =
//       media.agreementDocVerification.filter(
//         (h) =>
//           h.isVerified && isSameCycle(h.cycle, currentCycleForVerification),
//       );

//     // ✅ "2 verified is enough" rule — same as verifyAgreementDoc.
//     // Count DISTINCT roles that verified this cycle (dedupe defensively,
//     // in case of any legacy duplicate records).
//     const verifiedRolesThisCycle = new Set(
//       currentCycleVerificationsForSave.map((h) => h.verifiedByRole),
//     );
//     const verifiedCountThisCycle = verifiedRolesThisCycle.size;

//     const hasVerifiedThisCycle = verifiedRolesThisCycle.has(userType);

//     // Allowed to save if EITHER:
//     //   a) 2+ distinct roles have already verified this cycle (quorum met —
//     //      the caller doesn't need to have personally verified), OR
//     //   b) the caller's own role has verified this cycle
//     const canProceedToSave =
//       verifiedCountThisCycle >= 2 || hasVerifiedThisCycle;

//     if (!canProceedToSave) {
//       return res.status(400).json({
//         success: false,
//         message: `${ROLE_LABEL[userType]} must verify the agreement document for the billing cycle starting ${formatDate(currentCycleForVerification)} before saving`,
//       });
//     }
//     // Most recently created entry that hasn't been fully approved yet.
//     const pendingEntry = [...media.rentalDueEntries]
//       .reverse()
//       .find((e) => e.approvalStatus !== 3);

//     // ── Current cycle = the billing date this request is acting against ──
//     const currentCycleDate = media.rentalPayment?.nextBillingDate
//       ? new Date(media.rentalPayment.nextBillingDate).getTime()
//       : null;

//     // ── SELF-CONTAINED GUARD — doesn't depend on any external helper.
//     // Checks the actual entries array: has ANY entry for this exact
//     // billing cycle (same dueDate) already been fully approved (status
//     // === 3) by the Owner? If yes, block — regardless of what
//     // agreementDocVerified.owner currently says. ──
//     const ownerAlreadyClosedThisCycle = media.rentalDueEntries.some((e) => {
//       if (e.status !== 3) return false;
//       if (!currentCycleDate || !e.dueDate) return false;
//       if (new Date(e.dueDate).getTime() !== currentCycleDate) return false;
//       // final approver was Owner for this entry
//       const ownerStep = e.approvalSteps?.find((s) => s.role === ROLE.OWNER);
//       return ownerStep?.status === 2;
//     });

//     if (userType === ROLE.OWNER && ownerAlreadyClosedThisCycle) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "Owner has already approved this document for the current cycle",
//       });
//     }

//     // ═══════════════════════════════════════
//     // BRANCH 1: pending entry exists → this call is an APPROVAL
//     // ═══════════════════════════════════════
//     if (pendingEntry) {
//       const entry = pendingEntry;
//       const chain = FLOW_CHAIN[entry.approvalFlow] || FLOW_CHAIN[1];
//       const isOwnerOverride =
//         userType === ROLE.OWNER && entry.currentPendingRole !== ROLE.OWNER;

//       if (!isOwnerOverride && userType !== entry.currentPendingRole) {
//         return res.status(403).json({
//           success: false,
//           message: `It's not your turn to approve. Waiting on ${ROLE_LABEL[entry.currentPendingRole] || "N/A"}`,
//         });
//       }

//       if (isOwnerOverride) {
//         entry.approvalSteps.forEach((step) => {
//           if (step.status !== 1) return;
//           if (step.role === ROLE.OWNER) {
//             step.status = 2;
//             step.userId = userId;
//             step.userName = userName;
//             step.approvedAt = nowIST();
//             step.docVerified = true;
//             step.remarks = "Direct owner approval";
//           } else {
//             step.status = 3;
//             step.remarks = "Skipped — owner approved directly";
//           }
//         });
//         entry.approvalStatus = 3;
//         entry.status = 3;
//         entry.currentPendingRole = null;
//         entry.agreementDocVerified = true;
//         media.rentalStatus = RENTAL_STATUS_MAP[ROLE.OWNER];

//         markRoleVerified(media, entry, ROLE.OWNER, userName);
//         advanceRentalPaymentOnOwnerApproval(media);

//         // ✅ redundant safety reset — guarantees the live flags are
//         // false for the NEW cycle even if advanceRentalPaymentOnOwnerApproval
//         // doesn't do it correctly internally.
//         media.agreementDocVerified = {
//           staff: false,
//           teamLead: false,
//           owner: false,
//         };
//         media.markModified("agreementDocVerified");
//       } else {
//         const step = entry.approvalSteps.find(
//           (s) => s.role === userType && s.status === 1,
//         );
//         if (!step) {
//           return res.status(400).json({
//             success: false,
//             message: "No pending step found for your role",
//           });
//         }
//         step.status = 2;
//         step.userId = userId;
//         step.userName = userName;
//         step.approvedAt = nowIST();
//         step.docVerified = true;
//         media.rentalStatus = RENTAL_STATUS_MAP[userType];

//         markRoleVerified(media, entry, userType, userName);

//         const roleIndex = chain.indexOf(userType);
//         const nextRole = chain[roleIndex + 1];

//         if (nextRole) {
//           entry.currentPendingRole = nextRole;
//           entry.approvalStatus = 2;
//           entry.status = 2;
//         } else {
//           entry.currentPendingRole = null;
//           entry.approvalStatus = 3;
//           entry.status = 3;
//           entry.agreementDocVerified = true;

//           if (userType === ROLE.OWNER) {
//             advanceRentalPaymentOnOwnerApproval(media);

//             // ✅ redundant safety reset — same as above
//             media.agreementDocVerified = {
//               staff: false,
//               teamLead: false,
//               owner: false,
//             };
//             media.markModified("agreementDocVerified");
//           }
//         }
//       }

//       entry.updatedBy = userName;
//       entry.updatedAt = nowIST();

//       const yearLabel = getYearLabel(entry.dueDate);
//       const monthLabel = getMonthLabel(entry.dueDate);
//       const yearBucket = media.rentalDueHistory.find(
//         (y) => y.year === yearLabel,
//       );
//       const monthBucket = yearBucket?.months.find(
//         (m) => m.month === monthLabel,
//       );
//       const historyRecord = monthBucket?.entries.find(
//         (e) => String(e.rentalDueId) === String(entry._id),
//       );
//       if (historyRecord) {
//         historyRecord.approvalStatus = entry.approvalStatus;
//         historyRecord.updatedAt = nowIST();
//         historyRecord.updatedBy = userName;
//       }

//       media.updatedBy = userName;
//       media.updatedAt = nowIST();
//       await media.save();

//       return res.status(200).json({
//         success: true,
//         message: isOwnerOverride
//           ? "Approved directly by Owner"
//           : `${ROLE_LABEL[userType]} approval recorded`,
//         data: {
//           mediaId: media._id,
//           rentalDueId: entry._id,
//           approvalSteps: entry.approvalSteps,
//           approvalStatus: entry.approvalStatus,
//           currentPendingRole: entry.currentPendingRole,
//           currentPendingRoleLabel: entry.currentPendingRole
//             ? ROLE_LABEL[entry.currentPendingRole]
//             : "Completed",
//           rentalStatus: media.rentalStatus,
//           agreementDocVerified: media.agreementDocVerified,
//           agreementDocVerificationHistory:
//             media.agreementDocVerificationHistory,
//           agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//           rentalPayment: media.rentalPayment,
//         },
//       });
//     }

//     // ═══════════════════════════════════════
//     // BRANCH 2: no pending entry → CREATE (opens a new cycle)
//     // ═══════════════════════════════════════
//     if (!campaignName) {
//       return res
//         .status(400)
//         .json({ success: false, message: "campaignName is required" });
//     }

//     // ✅ Extra guard specifically for the CREATE + Owner-override path —
//     // even if two requests race and both pass the pendingEntry check above
//     // (both read before either saved), this catches an owner trying to
//     // create-and-approve a SECOND entry for a dueDate that already has a
//     // fully-approved-by-owner entry sitting in rentalDueEntries.
//     if (userType === ROLE.OWNER) {
//       const dueDateObjPreCheck = media.rentalPayment?.nextBillingDate
//         ? new Date(media.rentalPayment.nextBillingDate)
//         : new Date();
//       const alreadyClosed = media.rentalDueEntries.some((e) => {
//         if (e.status !== 3 || !e.dueDate) return false;
//         if (new Date(e.dueDate).getTime() !== dueDateObjPreCheck.getTime())
//           return false;
//         const ownerStep = e.approvalSteps?.find((s) => s.role === ROLE.OWNER);
//         return ownerStep?.status === 2;
//       });
//       if (alreadyClosed) {
//         return res.status(400).json({
//           success: false,
//           message:
//             "Owner has already approved this document for the current cycle",
//         });
//       }
//     }

//     // let proofOfCampaign = null;
//     // if (req.file) {
//     //   if (!req.file.mimetype?.startsWith("image/")) {
//     //     return res.status(400).json({
//     //       success: false,
//     //       message: "Proof of campaign must be an image file",
//     //     });
//     //   }
//     //   proofOfCampaign = {
//     //     originalName: req.file.originalname,
//     //     fileName: req.file.filename,
//     //     filePath: req.file.path,
//     //     mimeType: req.file.mimetype,
//     //     size: req.file.size,
//     //     fileType: "image",
//     //     uploadedAt: nowIST(),
//     //   };
//     // }
//     let proofOfCampaign = null;
//     if (req.files?.proofOfCampaign?.[0]) {
//       const file = req.files.proofOfCampaign[0];
//       if (!file.mimetype?.startsWith("image/")) {
//         return res.status(400).json({
//           success: false,
//           message: "Proof of campaign must be an image file",
//         });
//       }
//       proofOfCampaign = req.processFile(file);
//     }
//     const dueDateObj = media.rentalPayment?.nextBillingDate
//       ? new Date(media.rentalPayment.nextBillingDate)
//       : new Date();

//     const chainSteps = buildApprovalSteps(2);
//     const steps = [
//       {
//         role: ROLE.STAFF,
//         userId: null,
//         userName: "",
//         approvedAt: null,
//         status: 1,
//         docVerified: false,
//         remarks: "",
//       },
//       ...chainSteps,
//     ];

//     const isOwnerOverride = userType === ROLE.OWNER;
//     const isTeamLeadCreating = userType === ROLE.TEAM_LEAD;
//     const staffStep = steps.find((s) => s.role === ROLE.STAFF);

//     if (isOwnerOverride) {
//       steps.forEach((step) => {
//         if (step.role === ROLE.OWNER) {
//           step.status = 2;
//           step.userId = userId;
//           step.userName = userName;
//           step.approvedAt = nowIST();
//           step.docVerified = true;
//           step.remarks = "Direct owner approval";
//         } else {
//           step.status = 3;
//           step.remarks = "Skipped — owner approved directly";
//         }
//       });
//     } else if (isTeamLeadCreating) {
//       staffStep.status = 3;
//       staffStep.remarks = "Skipped — created directly by Team Lead";

//       const teamLeadStep = steps.find((s) => s.role === ROLE.TEAM_LEAD);
//       teamLeadStep.status = 2;
//       teamLeadStep.userId = userId;
//       teamLeadStep.userName = userName;
//       teamLeadStep.approvedAt = nowIST();
//       teamLeadStep.docVerified = true;
//       teamLeadStep.remarks = "Created and approved by Team Lead";
//     } else {
//       staffStep.status = 2;
//       staffStep.userId = userId;
//       staffStep.userName = userName;
//       staffStep.approvedAt = nowIST();
//       staffStep.docVerified = false;
//       staffStep.remarks = "Entry created by Staff";
//     }

//     const nextPendingStep = steps.find((s) => s.status === 1);
//     const allApproved = !nextPendingStep;

//     const newEntry = {
//       dueMonth: getDueMonthLabel(dueDateObj),
//       dueDate: dueDateObj,
//       netPayable: media.rentalPayment?.netPayable || 0,
//       paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
//       campaignName,
//       proofOfCampaign,
//       savedBy: { userId, userName, role: userType, savedAt: nowIST() },
//       approvalFlow: 2,
//       approvalSteps: steps,
//       approvalStatus: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
//       currentPendingRole: nextPendingStep ? nextPendingStep.role : null,
//       agreementDocVerified: allApproved,
//       status: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
//       updatedBy: userName,
//       updatedAt: nowIST(),
//     };
//     media.rentalStatus = RENTAL_STATUS_MAP[userType];

//     media.rentalDueEntries.push(newEntry);
//     const savedEntry =
//       media.rentalDueEntries[media.rentalDueEntries.length - 1];

//     if (isOwnerOverride) {
//       markRoleVerified(media, savedEntry, ROLE.OWNER, userName);
//     } else if (isTeamLeadCreating) {
//       markRoleVerified(media, savedEntry, ROLE.TEAM_LEAD, userName);
//     }

//     if (isOwnerOverride) {
//       advanceRentalPaymentOnOwnerApproval(media);

//       // ✅ redundant safety reset — guarantees flags are false for the
//       // NEW cycle that was just opened
//       media.agreementDocVerified = {
//         staff: false,
//         teamLead: false,
//         owner: false,
//       };
//       media.markModified("agreementDocVerified");
//     }

//     const yearLabel = getYearLabel(dueDateObj);
//     const monthLabel = getMonthLabel(dueDateObj);

//     let yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
//     if (!yearBucket) {
//       media.rentalDueHistory.push({ year: yearLabel, months: [] });
//       yearBucket = media.rentalDueHistory[media.rentalDueHistory.length - 1];
//     }
//     let monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
//     if (!monthBucket) {
//       yearBucket.months.push({ month: monthLabel, entries: [] });
//       monthBucket = yearBucket.months[yearBucket.months.length - 1];
//     }
//     monthBucket.entries.push({
//       rentalDueId: savedEntry._id,
//       siteName: media.mediaName,
//       campaignName,
//       dueDate: dueDateObj,
//       netPayable: media.rentalPayment?.netPayable || 0,
//       approvalStatus: newEntry.approvalStatus,
//       savedBy: userName,
//       savedByRole: userType,
//       updatedAt: nowIST(),
//       updatedBy: userName,
//     });

//     media.updatedBy = userName;
//     media.updatedAt = nowIST();
//     await media.save();

//     return res.status(201).json({
//       success: true,
//       message: isOwnerOverride
//         ? "Rental due entry created and approved directly by Owner"
//         : isTeamLeadCreating
//           ? "Rental due entry created and approved by Team Lead — waiting on Owner approval"
//           : "Rental due entry saved — waiting on Team Lead approval",
//       data: {
//         rentalDueId: savedEntry._id,
//         mediaId: media._id,
//         mediaName: media.mediaName,
//         campaignName,
//         proofOfCampaign,
//         dueDate: dueDateObj,
//         netPayable: newEntry.netPayable,
//         savedBy: {
//           userId,
//           userName,
//           role: userType,
//           roleLabel: ROLE_LABEL[userType] || "",
//         },
//         approvalSteps: steps,
//         approvalStatus: newEntry.approvalStatus,
//         currentPendingRole: newEntry.currentPendingRole,
//         currentPendingRoleLabel: newEntry.currentPendingRole
//           ? ROLE_LABEL[newEntry.currentPendingRole]
//           : "Completed",
//         rentalStatus: media.rentalStatus,
//         agreementDocVerified: media.agreementDocVerified,
//         agreementDocVerificationHistory: media.agreementDocVerificationHistory,
//         agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//         rentalPayment: media.rentalPayment,
//       },
//     });
//   } catch (err) {
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }
// };

async function sendRentalDueApprovalMail(media, entry) {
  try {
    const toMail = process.env.T0_EMail;
    const ccMail = process.env.CC_EMail;
    const mailMode = process.env.MAIL_MODE || "development";
    const formatDMY = (date) =>
      date
        ? new Date(date).toLocaleDateString("en-GB").replace(/\//g, "-")
        : null;

    const rp = media.rentalPayment || {};
    const appraisal = media.appraisal || {};
    const agreement = media.agreement || {};

    const landOwnersPayload = (media.landOwners || []).map((owner) => ({
      name: owner.name || "",
      phone: owner.phone || "",
      bankName: owner.bankName || "",
      ifsc: owner.ifsc || "",
      accountNumber: owner.accountNumber || "",
      panNumber: owner.panNumber || "",
      paymentCategory: owner.paymentCategory || 0,
      typeShare: owner.typeShare || 0,
      shareAmount: owner.shareAmount || 0,
      onlineMode: owner.onlineMode || 0,
      onlineAmount: owner.onlineAmount || 0,
      cashAmount: owner.cashAmount || 0,
      gstApplicable: owner.gstApplicable || 0,
      gstPercentage: owner.gstPercentage || 0,
      gstAmount: owner.gstAmount || 0,
      totalAmountWithGst: owner.totalAmountWithGst || 0,
    }));

    const mailPayload = {
      mailtype: "cmdapproval",
      to: [toMail],
      cc: [ccMail],
      data: {
        _id: media._id,
        mediaCode: media.mediaCode || "",
        mediaName: media.mediaName || "",
        mediaType: media.mediaType || "",
        state: media.state || "",
        city: media.city || "",
        location: media.location || "",
        // fullAddress: media.fullAddress || "",
        width: media.width || 0,
        height: media.height || 0,
        status: media.status || 0,
        totalSqFt: media.totalSqFt || 0,
        numberOfLandOwners: media.numberOfLandOwners || 0,

        rentalPayment: {
          totalRentalAmount: rp.totalRentalAmount || 0,
          gstApplicable: rp.gstApplicable || 0,
          gstNumber: rp.gstNumber || "",
          gstPercentage: rp.gstPercentage || 0,
          gstAmount: rp.gstAmount || 0,
          totalRentalAmountWithGst: rp.totalRentalAmountWithGst || 0,
          tdsApplicable: rp.tdsApplicable || 0,
          tdsPercentage: rp.tdsPercentage || 0,
          tdsAmount: rp.tdsAmount || 0,
          netPayable: rp.netPayable || 0,
          paymentFrequency: rp.paymentFrequency || 0,
          customPaymentFrequency: rp.rentalPayment || 0,
          lastBillPaidDate: formatDMY(rp.lastBillPaidDate),
          nextBillingDate: formatDMY(rp.nextBillingDate),
          balanceGstAmount: rp.balanceGstAmount || 0,
          status: rp.status || 0,
        },

        // rentalDueEntry: {
        //   withGst: entry?.withGst ?? null,
        //   baseAmount: entry?.baseAmount || 0,
        //   gstAmount: entry?.gstAmount || 0,
        //   netPayable: entry?.netPayable || 0,
        //   dueMonth: entry?.dueMonth || "",
        //   dueDate: formatDMY(entry?.dueDate),
        //   ownerApprovalDate: formatDMY(entry?.ownerApprovalDate),
        //   campaignName: entry?.campaignName || "",
        //   approvalFlow: entry?.approvalFlow || null,
        //   approvalSteps: entry?.approvalSteps || [],
        // },

        appraisal: {
          applicable: appraisal.applicable || 0,
          type: appraisal.type || 0,
          percentage: appraisal.percentage || 0,
          fixedAmount: appraisal.fixedAmount || 0,
          frequency: appraisal.frequency || 0,
          currentRent: appraisal.currentRent || 0,
          appraisalAmount: appraisal.appraisalAmount || 0,
          totalAppraisalAmount: appraisal.totalAppraisalAmount || 0,
          lastAppraisalDate: formatDMY(appraisal.lastAppraisalDate),
          nextAppraisalDate: formatDMY(appraisal.nextAppraisalDate),
        },

        agreement: {
          startDate: formatDMY(agreement.startDate),
          endDate: formatDMY(agreement.endDate),
          reminderBeforeExpiry: agreement.reminderBeforeExpiry || 0,
          advanceRent: agreement.advanceRent || 0,
          status: agreement.status || 0,
        },

        landOwners: landOwnersPayload,
      },
    };

    // console.log(
    //   "📧 RENTAL DUE MAIL PAYLOAD:",
    //   JSON.stringify(mailPayload, null, 2),
    // );
    if (mailMode !== "production") {
      console.log(
        `📭 MAIL_MODE="${mailMode}" — skipping live mail API call. Payload logged above only.`,
      );
      return {
        mailtype: "cmdapproval",
        to: [toMail],
        cc: [ccMail],
        success: true,
        sent: false, // ✅ mail wasn't actually sent, so mailSent stays false on the entry
        statusCode: 200,
        message: `Mail skipped (MAIL_MODE=${mailMode}) — not sent`,
        data: mailPayload.data,
      };
    }
    const response = await axios.post(
      "https://adinndigital.com/api/outdoormedia/index_cmdapproval.php",
      mailPayload,
      { headers: { "Content-Type": "application/json" } },
    );

    // console.log("✅ Rental due approval mail sent:", response.data);

    const isMailSuccess =
      response.data &&
      (response.data.success === true ||
        response.data.status === "success" ||
        response.status === 200);

    return {
      mailtype: "cmdapproval",
      to: [toMail],
      cc: [ccMail],
      success: !!isMailSuccess,
      sent: !!isMailSuccess, // ✅ NEW — controller reads `sent` to set entry.mailSent
      statusCode: response.status || (isMailSuccess ? 200 : 500),
      message: isMailSuccess
        ? "Rental due approval mail sent successfully"
        : "Rental due approval mail failed",
      data: mailPayload.data,
    };
  } catch (mailErr) {
    console.error(
      "❌ Rental due approval mail error:",
      mailErr?.message || mailErr,
    );
    return {
      mailtype: "cmdapproval",
      to: [process.env.T0_EMail],
      cc: [process.env.CC_EMail],
      success: false,
      sent: false, // ✅ NEW — ensures mailResult.sent is always defined, even on error
      statusCode: 500,
      message: mailErr?.message || "Unknown mail error",
      data: null,
    };
  }
}
// Upserts a verification-progress SNAPSHOT for the given cycle — one
// record per cycle, always overwritten in place as verification status
// changes within that cycle (not appended repeatedly).
// Pushes a per-cycle GST record into gstBalanceHistory (once, guarded by
// gstAddedToBalance flag on the entry) and recomputes the aggregate
// balanceGstAmount as the sum of all UNPAID entries.
function addGstToBalanceIfApplicable(media, entry, userName) {
  if (entry.gstAddedToBalance) return; // already recorded — never duplicate

  if (entry?.withGst === 1 && entry.gstAmount > 0) {
    if (!Array.isArray(media.gstBalanceHistory)) {
      media.gstBalanceHistory = [];
    }

    media.gstBalanceHistory.push({
      rentalDueId: entry._id,
      dueMonth: entry.dueMonth,
      cycle: entry.dueDate,
      gstAmount: entry.gstAmount,
      isPaid: false,
      paidAmount: 0,
      paidAt: null,
      paidBy: "",
      createdAt: nowIST(),
      createdBy: userName,
      source: "rental", // ✅ tagged
      ownerId: null,
      ownerName: "",
    });
    media.markModified("gstBalanceHistory");

    entry.gstAddedToBalance = true;

    recomputeBalanceGstAmount(media);
  }
}
function addOwnerGstToBalanceIfApplicable(media, entry, userName) {
  if (entry.ownerGstAddedToBalance) return;
  if (!Array.isArray(media.landOwners) || media.landOwners.length === 0) return;

  if (!Array.isArray(media.gstBalanceHistory)) {
    media.gstBalanceHistory = [];
  }

  let anyAdded = false;

  media.landOwners.forEach((owner) => {
    const ownerGstApplicable = Number(owner.gstApplicable || 0);
    const ownerGstAmount = Number(owner.gstAmount || 0);

    if (ownerGstApplicable === 1 && ownerGstAmount > 0) {
      media.gstBalanceHistory.push({
        rentalDueId: entry._id,
        dueMonth: entry.dueMonth,
        cycle: entry.dueDate,
        gstAmount: ownerGstAmount,
        isPaid: false,
        paidAmount: 0,
        paidAt: null,
        paidBy: "",
        createdAt: nowIST(),
        createdBy: userName,
        source: "owner", // ✅ tagged
        ownerId: owner._id,
        ownerName: owner.name,
      });
      anyAdded = true;
    }
  });

  if (anyAdded) {
    media.markModified("gstBalanceHistory");
    entry.ownerGstAddedToBalance = true;
    recomputeBalanceGstAmount(media); // ✅ same recompute function, now sums BOTH sources
  }
}

// Recomputes the aggregate balanceGstAmount = sum of all UNPAID cycle
// entries. Call this any time gstBalanceHistory changes.
function recomputeBalanceGstAmount(media) {
  const unpaidTotal = (media.gstBalanceHistory || []).reduce((sum, g) => {
    if (g.isPaid) return sum;
    const remaining = (g.gstAmount || 0) - (g.paidAmount || 0);
    return sum + Math.max(remaining, 0);
  }, 0);

  media.rentalPayment.balanceGstAmount = unpaidTotal;
  media.markModified("rentalPayment");
}
// Keeps gstBalanceHistory in sync when withGst is changed mid-approval
// (by Team Lead or Owner, after Staff already created the entry).
//   - 1 -> 2 (With GST -> Without GST): removes the existing unpaid
//     gstBalanceHistory record for this entry (if one exists and isn't
//     already paid), and resets gstAddedToBalance so a future flip
//     back to withGst=1 can re-create it.
//   - 2 -> 1 (Without GST -> With GST): creates a new gstBalanceHistory
//     record for this entry, same as if it had been created with
//     withGst=1 from the start.
// Always recomputes balanceGstAmount afterward.
function syncGstBalanceOnWithGstChange(media, entry, newWithGst, userName) {
  if (!Array.isArray(media.gstBalanceHistory)) {
    media.gstBalanceHistory = [];
  }

  const existingRecord = media.gstBalanceHistory.find(
    (g) => String(g.rentalDueId) === String(entry._id),
  );

  if (newWithGst === 2) {
    // Switched OFF GST — remove the liability if it hasn't been paid yet.
    if (existingRecord && !existingRecord.isPaid) {
      media.gstBalanceHistory = media.gstBalanceHistory.filter(
        (g) => String(g._id) !== String(existingRecord._id),
      );
      media.markModified("gstBalanceHistory");
    }
    // If it was already paid, we leave the paid record alone — it's a
    // historical record of GST that was actually remitted; don't erase
    // real payment history just because withGst flipped afterward.
    entry.gstAddedToBalance = false;
  } else if (newWithGst === 1) {
    // Switched ON GST — create a fresh record if one doesn't already
    // exist (or the old one was removed above in a previous flip).
    if (!existingRecord) {
      media.gstBalanceHistory.push({
        rentalDueId: entry._id,
        dueMonth: entry.dueMonth,
        cycle: entry.dueDate,
        gstAmount: entry.gstAmount,
        isPaid: false,
        paidAmount: 0,
        paidAt: null,
        paidBy: "",
        createdAt: nowIST(),
        createdBy: userName,
      });
      media.markModified("gstBalanceHistory");
      entry.gstAddedToBalance = true;
    } else if (!existingRecord.isPaid) {
      // Record exists and isn't paid yet — keep its amount in sync with
      // the entry's current gstAmount (in case gstAmount also changed).
      existingRecord.gstAmount = entry.gstAmount;
      media.markModified("gstBalanceHistory");
    }
  }

  recomputeBalanceGstAmount(media);
}
exports.saveRentalDue = async (req, res) => {
  try {
    const { userType, userId, userName } = req.user;
    const { mediaId, campaignName, withGst } = req.body;

    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid mediaId is required" });
    }
    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid or missing user role" });
    }

    const media = await Media.findById(mediaId);
    if (!media) {
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });
    }

    // Defensive init — older docs saved before this migration may not
    // have these fields yet.
    if (!media.agreementDocVerified) {
      media.agreementDocVerified = {
        staff: false,
        teamLead: false,
        owner: false,
      };
    }
    if (!media.agreementDocVerificationHistory) {
      media.agreementDocVerificationHistory = [];
    }
    if (!Array.isArray(media.rentalDueEntries)) {
      media.rentalDueEntries = Array.isArray(media.rentalDue)
        ? media.rentalDue
        : [];
    }
    if (!Array.isArray(media.rentalDueHistory)) {
      media.rentalDueHistory = [];
    }
    if (!Array.isArray(media.agreementDocVerification)) {
      media.agreementDocVerification = [];
    }
    if (!Array.isArray(media.ledger)) {
      media.ledger = [];
    }
    if (media.rentalPayment && media.rentalPayment.balanceGstAmount == null) {
      media.rentalPayment.balanceGstAmount = 0;
    }
    //  let uploadedProofOfCampaign = null;
    //     if (req.files?.proofOfCampaign?.[0]) {
    //       const file = req.files.proofOfCampaign[0];
    //       if (!file.mimetype?.startsWith("image/")) {
    //         return res.status(400).json({
    //           success: false,
    //           message: "Proof of campaign must be an image file",
    //         });
    //       }
    //       uploadedProofOfCampaign = req.processFile(file);
    //     }
    let proofOfCampaign = null;
    if (req.files?.proofOfCampaign?.[0]) {
      const file = req.files.proofOfCampaign[0];
      if (!file.mimetype?.startsWith("image/")) {
        return res.status(400).json({
          success: false,
          message: "Proof of campaign must be an image file",
        });
      }
      proofOfCampaign = req.processFile(file);
    }
    // ══════════════════════════════════════════════════════════════
    // 🔒 GUARD — "verify first, then save"
    // ══════════════════════════════════════════════════════════════
    const currentCycleForVerification = getCurrentCycle(
      media.rentalPayment?.nextBillingDate,
    );

    if (!currentCycleForVerification) {
      return res.status(400).json({
        success: false,
        message: "Unable to determine current billing cycle",
      });
    }

    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    const currentCycleVerificationsForSave =
      media.agreementDocVerification.filter(
        (h) =>
          h.isVerified && isSameCycle(h.cycle, currentCycleForVerification),
      );

    // "2 verified is enough" rule — same as verifyAgreementDoc.
    const verifiedRolesThisCycle = new Set(
      currentCycleVerificationsForSave.map((h) => h.verifiedByRole),
    );
    const verifiedCountThisCycle = verifiedRolesThisCycle.size;

    const hasVerifiedThisCycle = verifiedRolesThisCycle.has(userType);

    const canProceedToSave =
      verifiedCountThisCycle >= 2 || hasVerifiedThisCycle;

    if (!canProceedToSave) {
      return res.status(400).json({
        success: false,
        message: `${ROLE_LABEL[userType]} must verify the agreement document for the billing cycle starting ${formatDate(currentCycleForVerification)} before saving`,
      });
    }

    // Most recently created entry that hasn't been fully approved yet.
    const pendingEntry = [...media.rentalDueEntries]
      .reverse()
      .find((e) => e.approvalStatus !== 3);

    // ── Current cycle = the billing date this request is acting against ──
    const currentCycleDate = media.rentalPayment?.nextBillingDate
      ? new Date(media.rentalPayment.nextBillingDate).getTime()
      : null;

    const ownerAlreadyClosedThisCycle = media.rentalDueEntries.some((e) => {
      if (e.status !== 3) return false;
      if (!currentCycleDate || !e.dueDate) return false;
      if (new Date(e.dueDate).getTime() !== currentCycleDate) return false;
      const ownerStep = e.approvalSteps?.find((s) => s.role === ROLE.OWNER);
      return ownerStep?.status === 2;
    });

    if (userType === ROLE.OWNER && ownerAlreadyClosedThisCycle) {
      return res.status(400).json({
        success: false,
        message:
          "Owner has already approved this document for the current cycle",
      });
    }
    let mailResult = null;
    // ═══════════════════════════════════════
    // BRANCH 1: pending entry exists → this call is an APPROVAL
    // ═══════════════════════════════════════
    if (pendingEntry) {
      const entry = pendingEntry;
      const chain = FLOW_CHAIN[entry.approvalFlow] || FLOW_CHAIN[1];
      const isOwnerOverride =
        userType === ROLE.OWNER && entry.currentPendingRole !== ROLE.OWNER;

      if (!isOwnerOverride && userType !== entry.currentPendingRole) {
        return res.status(403).json({
          success: false,
          message: `It's not your turn to approve. Waiting on ${ROLE_LABEL[entry.currentPendingRole] || "N/A"}`,
        });
      }
      if (campaignName) {
        entry.campaignName = campaignName;
      }
      if (proofOfCampaign) {
        entry.proofOfCampaign = proofOfCampaign;
      }
      // ✅ Applies to EVERY approving role (Staff/Team Lead/Owner), not just
      // Owner's final closure. Tracks/updates balanceGstAmount immediately
      // whenever withGst is 1, at any approval step.
      // if ([1, 2].includes(Number(withGst))) {
      //   const newWithGst = Number(withGst);
      //   const oldGstAmount = entry.gstAmount || 0;

      //   if (entry.withGst !== newWithGst) {
      //     entry.withGst = newWithGst;
      //     const recomputedSplit = computeGstSplit(media, newWithGst);
      //     entry.gstAmount = Number(recomputedSplit.gstAmount) || 0;
      //     entry.baseAmount = Number(recomputedSplit.baseAmount) || 0;
      //     entry.netPayable = Number(recomputedSplit.netPayable) || 0;
      //   }

      //   // Adjust balanceGstAmount to reflect the CURRENT gstAmount for this
      //   // entry — remove the old contribution (if any), add the new one.
      //   media.rentalPayment.balanceGstAmount =
      //     (media.rentalPayment.balanceGstAmount || 0) -
      //     (entry.withGst === newWithGst ? oldGstAmount : 0) +
      //     (newWithGst === 1 ? entry.gstAmount : 0);
      //   media.markModified("rentalPayment");
      // }
      if ([1, 2].includes(Number(withGst))) {
        const newWithGst = Number(withGst);
        if (entry.withGst !== newWithGst) {
          entry.withGst = newWithGst;
          const recomputedSplit = computeGstSplit(media, newWithGst);
          entry.gstAmount = Number(recomputedSplit.gstAmount) || 0;
          entry.baseAmount = Number(recomputedSplit.baseAmount) || 0;
          entry.netPayable = Number(recomputedSplit.netPayable) || 0;

          // ✅ NEW — keep gstBalanceHistory + balanceGstAmount in sync with
          // this change, whether it's Team Lead or Owner making it.
          syncGstBalanceOnWithGstChange(media, entry, newWithGst, userName);
        }
      }
      if (isOwnerOverride) {
        entry.approvalSteps.forEach((step) => {
          if (step.status !== 1) return;
          if (step.role === ROLE.OWNER) {
            step.status = 2;
            step.userId = userId;
            step.userName = userName;
            step.approvedAt = nowIST();
            step.docVerified = true;
            step.remarks = "Direct owner approval";
          } else {
            step.status = 3;
            step.remarks = "Skipped — owner approved directly";
          }
        });
        entry.approvalStatus = 3;
        entry.status = 3;
        entry.currentPendingRole = null;
        entry.agreementDocVerified = true;
        entry.ownerApprovalDate = nowIST();
        media.rentalStatus = RENTAL_STATUS_MAP[ROLE.OWNER];

        markRoleVerified(media, entry, ROLE.OWNER, userName);

        // ✅ close out GST for this cycle BEFORE billing date rolls forward
        addGstToBalanceIfApplicable(media, entry, userName);
        addOwnerGstToBalanceIfApplicable(media, entry, userName);

        advanceRentalPaymentOnOwnerApproval(media);

        // ✅ reset ledger the moment the cycle rolls over — old cycle's
        // entries are already permanently preserved in ledgerHistory
        if (Array.isArray(media.ledger) && media.ledger.length > 0) {
          media.ledger = [];
          media.markModified("ledger");
        }

        // redundant safety reset — guarantees the live flags are
        // false for the NEW cycle
        media.agreementDocVerified = {
          staff: false,
          teamLead: false,
          owner: false,
        };
        media.markModified("agreementDocVerified");
      } else {
        const step = entry.approvalSteps.find(
          (s) => s.role === userType && s.status === 1,
        );
        if (!step) {
          return res.status(400).json({
            success: false,
            message: "No pending step found for your role",
          });
        }
        step.status = 2;
        step.userId = userId;
        step.userName = userName;
        step.approvedAt = nowIST();
        step.docVerified = true;
        media.rentalStatus = RENTAL_STATUS_MAP[userType];

        markRoleVerified(media, entry, userType, userName);

        const roleIndex = chain.indexOf(userType);
        const nextRole = chain[roleIndex + 1];

        if (nextRole) {
          entry.currentPendingRole = nextRole;
          entry.approvalStatus = 2;
          entry.status = 2;
        } else {
          entry.currentPendingRole = null;
          entry.approvalStatus = 3;
          entry.status = 3;
          entry.agreementDocVerified = true;

          if (userType === ROLE.OWNER) {
            entry.ownerApprovalDate = nowIST();
            // addGstToBalanceIfApplicable(media, entry);
            addGstToBalanceIfApplicable(media, entry, userName);
            addOwnerGstToBalanceIfApplicable(media, entry, userName);
            advanceRentalPaymentOnOwnerApproval(media);

            if (Array.isArray(media.ledger) && media.ledger.length > 0) {
              media.ledger = [];
              media.markModified("ledger");
            }

            media.agreementDocVerified = {
              staff: false,
              teamLead: false,
              owner: false,
            };
            media.markModified("agreementDocVerified");
          }
        }
      }

      entry.updatedBy = userName;
      entry.updatedAt = nowIST();

      const yearLabel = getYearLabel(entry.dueDate);
      const monthLabel = getMonthLabel(entry.dueDate);
      const yearBucket = media.rentalDueHistory.find(
        (y) => y.year === yearLabel,
      );
      const monthBucket = yearBucket?.months.find(
        (m) => m.month === monthLabel,
      );
      const historyRecord = monthBucket?.entries.find(
        (e) => String(e.rentalDueId) === String(entry._id),
      );
      if (historyRecord) {
        historyRecord.approvalStatus = entry.approvalStatus;
        historyRecord.campaignName = entry.campaignName;
        historyRecord.updatedAt = nowIST();
        historyRecord.updatedBy = userName;
      }

      media.updatedBy = userName;
      media.updatedAt = nowIST();
      await media.save();

      // ✅ Send owner-approval mail + persist mailSent on THIS entry/cycle
      if (userType === ROLE.OWNER && entry.approvalStatus === 3) {
        const mailResult = await sendRentalDueApprovalMail(media, entry);
        entry.mailSent = !!mailResult.sent;
        await media.save();
      }
      return res.status(200).json({
        success: true,
        message: isOwnerOverride
          ? "Approved directly by Owner"
          : `${ROLE_LABEL[userType]} approval recorded`,
        data: {
          mediaId: media._id,
          rentalDueId: entry._id,
          campaignName: entry.campaignName, // ✅ reflects any update
          proofOfCampaign: entry.proofOfCampaign, // ✅ reflects any update
          approvalSteps: entry.approvalSteps,
          approvalStatus: entry.approvalStatus,
          currentPendingRole: entry.currentPendingRole,
          currentPendingRoleLabel: entry.currentPendingRole
            ? ROLE_LABEL[entry.currentPendingRole]
            : "Completed",
          rentalStatus: media.rentalStatus,
          withGst: entry.withGst,
          gstAmount: entry.gstAmount,
          baseAmount: entry.baseAmount,
          netPayable: entry.netPayable,
          balanceGstAmount: media.rentalPayment?.balanceGstAmount || 0,
          agreementDocVerified: media.agreementDocVerified,
          agreementDocVerificationHistory:
            media.agreementDocVerificationHistory,
          agreementDocVerificationStatus: getAgreementVerificationStatus(media),
          rentalPayment: media.rentalPayment,
          ledger: media.ledger,
          mailSent: entry.mailSent,
        },
      });
    }

    // ═══════════════════════════════════════
    // BRANCH 2: no pending entry → CREATE (opens a new cycle)
    // ═══════════════════════════════════════
    if (!campaignName) {
      return res
        .status(400)
        .json({ success: false, message: "campaignName is required" });
    }

    if (userType === ROLE.OWNER) {
      const dueDateObjPreCheck = media.rentalPayment?.nextBillingDate
        ? new Date(media.rentalPayment.nextBillingDate)
        : new Date();
      const alreadyClosed = media.rentalDueEntries.some((e) => {
        if (e.status !== 3 || !e.dueDate) return false;
        if (new Date(e.dueDate).getTime() !== dueDateObjPreCheck.getTime())
          return false;
        const ownerStep = e.approvalSteps?.find((s) => s.role === ROLE.OWNER);
        return ownerStep?.status === 2;
      });
      if (alreadyClosed) {
        return res.status(400).json({
          success: false,
          message:
            "Owner has already approved this document for the current cycle",
        });
      }
    }

    const dueDateObj = media.rentalPayment?.nextBillingDate
      ? new Date(media.rentalPayment.nextBillingDate)
      : new Date();

    const chainSteps = buildApprovalSteps(2);
    const steps = [
      {
        role: ROLE.STAFF,
        userId: null,
        userName: "",
        approvedAt: null,
        status: 1,
        docVerified: false,
        remarks: "",
      },
      ...chainSteps,
    ];

    const isOwnerOverride = userType === ROLE.OWNER;
    const isTeamLeadCreating = userType === ROLE.TEAM_LEAD;
    const staffStep = steps.find((s) => s.role === ROLE.STAFF);

    if (isOwnerOverride) {
      steps.forEach((step) => {
        if (step.role === ROLE.OWNER) {
          step.status = 2;
          step.userId = userId;
          step.userName = userName;
          step.approvedAt = nowIST();
          step.docVerified = true;
          step.remarks = "Direct owner approval";
        } else {
          step.status = 3;
          step.remarks = "Skipped — owner approved directly";
        }
      });
    } else if (isTeamLeadCreating) {
      staffStep.status = 3;
      staffStep.remarks = "Skipped — created directly by Team Lead";

      const teamLeadStep = steps.find((s) => s.role === ROLE.TEAM_LEAD);
      teamLeadStep.status = 2;
      teamLeadStep.userId = userId;
      teamLeadStep.userName = userName;
      teamLeadStep.approvedAt = nowIST();
      teamLeadStep.docVerified = true;
      teamLeadStep.remarks = "Created and approved by Team Lead";
    } else {
      staffStep.status = 2;
      staffStep.userId = userId;
      staffStep.userName = userName;
      staffStep.approvedAt = nowIST();
      staffStep.docVerified = false;
      staffStep.remarks = "Entry created by Staff";
    }

    const nextPendingStep = steps.find((s) => s.status === 1);
    const allApproved = !nextPendingStep;

    // ✅ resolve withGst mode for this entry (default to 1 / With GST)
    const resolvedWithGst = [1, 2].includes(Number(withGst))
      ? Number(withGst)
      : 1;
    const gstSplit = computeGstSplit(media, resolvedWithGst);

    const newEntry = {
      dueMonth: getDueMonthLabel(dueDateObj),
      dueDate: dueDateObj,
      netPayable: Number(gstSplit.netPayable) || 0, // ✅ uses GST split, not raw rentalPayment
      paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
      customPaymentFrequency:
        media.rentalPayment?.paymentFrequency === 7
          ? media.rentalPayment?.customPaymentFrequency || 1
          : undefined, // ✅ added — only set when frequency is Custom
      ownerApprovalDate: isOwnerOverride ? nowIST() : null,
      mailSent: false,
      gstAddedToBalance: false,
      campaignName,
      proofOfCampaign: proofOfCampaign,
      savedBy: { userId, userName, role: userType, savedAt: nowIST() },
      approvalFlow: 2,
      approvalSteps: steps,
      approvalStatus: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
      currentPendingRole: nextPendingStep ? nextPendingStep.role : null,
      agreementDocVerified: allApproved,
      status: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
      withGst: resolvedWithGst,
      gstAmount: Number(gstSplit.gstAmount) || 0,
      baseAmount: Number(gstSplit.baseAmount) || 0,
      netPayable: Number(gstSplit.netPayable) || 0,
      withGst: resolvedWithGst,
      gstAmount: Number(gstSplit.gstAmount) || 0,
      baseAmount: Number(gstSplit.baseAmount) || 0,
      gstAddedToBalance: false,
      updatedBy: userName,
      updatedAt: nowIST(),
    };
    media.rentalStatus = RENTAL_STATUS_MAP[userType];

    media.rentalDueEntries.push(newEntry);
    const savedEntry =
      media.rentalDueEntries[media.rentalDueEntries.length - 1];
    // addGstToBalanceIfApplicable(media, savedEntry,userName);
    // addOwnerGstToBalanceIfApplicable(media, savedEntry, userName);
    if (isOwnerOverride) {
      markRoleVerified(media, savedEntry, ROLE.OWNER, userName);
    } else if (isTeamLeadCreating) {
      markRoleVerified(media, savedEntry, ROLE.TEAM_LEAD, userName);
    }

    if (isOwnerOverride) {
      // Owner created AND fully approved directly — cycle closes here too
      // addGstToBalanceIfApplicable(media, savedEntry);
      addGstToBalanceIfApplicable(media, savedEntry, userName);
      addOwnerGstToBalanceIfApplicable(media, savedEntry, userName);
      advanceRentalPaymentOnOwnerApproval(media);

      // ✅ reset ledger for the new cycle that just opened
      if (Array.isArray(media.ledger) && media.ledger.length > 0) {
        media.ledger = [];
        media.markModified("ledger");
      }

      media.agreementDocVerified = {
        staff: false,
        teamLead: false,
        owner: false,
      };
      media.markModified("agreementDocVerified");
    }

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
    monthBucket.entries.push({
      rentalDueId: savedEntry._id,
      siteName: media.mediaName,
      campaignName,
      dueDate: dueDateObj,
      netPayable: Number(newEntry.netPayable) || 0, // ✅ uses GST split, not raw rentalPayment
      approvalStatus: newEntry.approvalStatus,
      savedBy: userName,
      savedByRole: userType,
      updatedAt: nowIST(),
      updatedBy: userName,
    });

    media.updatedBy = userName;
    media.updatedAt = nowIST();
    await media.save();

    if (isOwnerOverride && savedEntry.approvalStatus === 3) {
      const mailResult = await sendRentalDueApprovalMail(media, savedEntry);
      savedEntry.mailSent = !!mailResult.sent;
      await media.save();
    }
    return res.status(201).json({
      success: true,
      message: isOwnerOverride
        ? "Rental due entry created and approved directly by Owner"
        : isTeamLeadCreating
          ? "Rental due entry created and approved by Team Lead — waiting on Owner approval"
          : "Rental due entry saved — waiting on Team Lead approval",
      data: {
        rentalDueId: savedEntry._id,
        mediaId: media._id,
        mediaName: media.mediaName,
        campaignName,
        proofOfCampaign,
        dueDate: dueDateObj,
        netPayable: newEntry.netPayable,
        withGst: newEntry.withGst,
        gstAmount: newEntry.gstAmount,
        baseAmount: newEntry.baseAmount,
        balanceGstAmount: media.rentalPayment?.balanceGstAmount || 0,
        savedBy: {
          userId,
          userName,
          role: userType,
          roleLabel: ROLE_LABEL[userType] || "",
        },
        approvalSteps: steps,
        approvalStatus: newEntry.approvalStatus,
        currentPendingRole: newEntry.currentPendingRole,
        currentPendingRoleLabel: newEntry.currentPendingRole
          ? ROLE_LABEL[newEntry.currentPendingRole]
          : "Completed",
        rentalStatus: media.rentalStatus,
        agreementDocVerified: media.agreementDocVerified,
        agreementDocVerificationHistory: media.agreementDocVerificationHistory,
        agreementDocVerificationStatus: getAgreementVerificationStatus(media),
        rentalPayment: media.rentalPayment,
        ledger: media.ledger,
        mailSent: savedEntry.mailSent,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const ROLE_RANK = {
  [ROLE.STAFF]: 1,
  [ROLE.TEAM_LEAD]: 2,
  [ROLE.OWNER]: 3,
};
// function saveVerificationProgressSnapshot(media, cycle, progress, userName) {
//   if (!Array.isArray(media.verificationProgressHistory)) {
//     media.verificationProgressHistory = [];
//   }

//   const cycleTime = new Date(cycle).getTime();
//   const existing = media.verificationProgressHistory.find(
//     (v) => new Date(v.cycle).getTime() === cycleTime,
//   );

//   const snapshot = {
//     cycle,
//     currentCycleLabel: formatDate(cycle),
//     staffVerified: progress.staffVerified,
//     teamLeadVerified: progress.teamLeadVerified,
//     ownerVerified: progress.ownerVerified,
//     verifiedCount: progress.verifiedCount,
//     isComplete: progress.isComplete,
//     highestVerifiedRole: progress.highestVerifiedRole,
//     updatedAt: nowIST(),
//     updatedBy: userName,
//   };

//   if (existing) {
//     Object.assign(existing, snapshot);
//   } else {
//     media.verificationProgressHistory.push(snapshot);
//   }

//   media.markModified("verificationProgressHistory");
// }
// Always APPENDS a new snapshot — one entry per verification ACTION,
// not one per cycle. This preserves the full progression (e.g. Staff's
// snapshot, then Team Lead's snapshot, then Owner's) instead of
// overwriting earlier entries as the cycle progresses.
function saveVerificationProgressSnapshot(media, cycle, progress, userName) {
  if (!Array.isArray(media.verificationProgressHistory)) {
    media.verificationProgressHistory = [];
  }

  const snapshot = {
    cycle,
    currentCycleLabel: formatDate(cycle),
    staffVerified: progress.staffVerified,
    teamLeadVerified: progress.teamLeadVerified,
    ownerVerified: progress.ownerVerified,
    verifiedCount: progress.verifiedCount,
    isComplete: progress.isComplete,
    highestVerifiedRole: progress.highestVerifiedRole,
    updatedAt: nowIST(),
    updatedBy: userName,
  };

  media.verificationProgressHistory.push(snapshot);
  media.markModified("verificationProgressHistory");
}
exports.verifyAgreementDoc = async (req, res) => {
  try {
    const { mediaId } = req.body;
    const { userType, userName } = req.user;

    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid mediaId is required" });
    }

    let media = await Media.findById(mediaId);
    if (!media) {
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });
    }

    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid or missing user role" });
    }

    // ── Get current cycle from nextBillingDate ──
    const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

    if (!currentCycle) {
      return res.status(400).json({
        success: false,
        message: "Unable to determine current billing cycle",
      });
    }

    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    // ── Get all verifications for the current cycle ──
    const currentCycleVerifications = media.agreementDocVerification.filter(
      (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
    );

    const staffVerified = currentCycleVerifications.some(
      (h) => h.verifiedByRole === ROLE.STAFF,
    );
    const teamLeadVerified = currentCycleVerifications.some(
      (h) => h.verifiedByRole === ROLE.TEAM_LEAD,
    );
    const ownerVerified = currentCycleVerifications.some(
      (h) => h.verifiedByRole === ROLE.OWNER,
    );

    const verifiedCount = [
      staffVerified,
      teamLeadVerified,
      ownerVerified,
    ].filter(Boolean).length;

    const getHighestVerifiedRole = (staff, teamLead, owner) => {
      if (owner) return ROLE.OWNER;
      if (teamLead) return ROLE.TEAM_LEAD;
      if (staff) return ROLE.STAFF;
      return null;
    };

    const highestVerifiedRole = getHighestVerifiedRole(
      staffVerified,
      teamLeadVerified,
      ownerVerified,
    );
    const userRank = ROLE_RANK[userType];

    // ── VALIDATION 1: user already verified this cycle ──
    if (userType === ROLE.STAFF && staffVerified) {
      return res.status(400).json({
        success: false,
        message: `${ROLE_LABEL[ROLE.STAFF]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
      });
    }
    if (userType === ROLE.TEAM_LEAD && teamLeadVerified) {
      return res.status(400).json({
        success: false,
        message: `${ROLE_LABEL[ROLE.TEAM_LEAD]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
      });
    }
    if (userType === ROLE.OWNER && ownerVerified) {
      return res.status(400).json({
        success: false,
        message: `${ROLE_LABEL[ROLE.OWNER]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
      });
    }

    // ❌ REMOVED — the old "verifiedCount >= 2 => block" rule.
    // Owner verification stays OPTIONAL once 2 have verified, but is
    // still ALLOWED if Owner chooses to verify anyway. Nothing blocks
    // it here anymore; only VALIDATION 3 (rank block) below still applies.

    // ── VALIDATION 3 (rank block): a lower-ranked role can never verify
    //    AFTER a higher-ranked role has already verified.
    //    - Team Lead verifies first  -> Staff is blocked (Owner can still verify).
    //    - Owner verifies first      -> Staff and Team Lead are both blocked.
    if (highestVerifiedRole) {
      const highestRank = ROLE_RANK[highestVerifiedRole];

      if (highestRank > userRank) {
        return res.status(403).json({
          success: false,
          message: `${ROLE_LABEL[userType]} cannot verify because ${ROLE_LABEL[highestVerifiedRole]} has already verified for this billing cycle`,
        });
      }
    }

    // ── Create verification record ──
    const verificationRecord = {
      isVerified: true,
      verifiedBy: userName,
      verifiedByRole: userType,
      verifiedAt: nowIST(),
      rentalDueId: null,
      agreementPDF: media.agreement?.agreementPDF || {},
      cycle: currentCycle,
      cycleStartDate: media.rentalPayment?.nextBillingDate,
      updatedAt: nowIST(),
      updatedBy: userName,
    };

    // ── Roles that would block this user from verifying (own role +
    //    any higher-ranked role) for this cycle ──
    const blockingRoles = [ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].filter(
      (role) => role === userType || ROLE_RANK[role] > userRank,
    );

    // ── ATOMIC WRITE ──
    // The $push only happens if, at write time, no blocking role (self
    // or higher-ranked) has already verified this cycle. The old "fewer
    // than 2 verified" $expr condition has been REMOVED — a 3rd/optional
    // verification (e.g. Owner, after Staff+TeamLead) is now allowed
    // through at the DB level too.
    const updatedMedia = await Media.findOneAndUpdate(
      {
        _id: mediaId,
        agreementDocVerification: {
          $not: {
            $elemMatch: {
              isVerified: true,
              cycle: currentCycle,
              verifiedByRole: { $in: blockingRoles },
            },
          },
        },
      },
      {
        $push: { agreementDocVerification: verificationRecord },
        $set: { updatedBy: userName, updatedAt: nowIST() },
      },
      { new: true },
    );

    // ── If the atomic update matched nothing, someone else (or a
    //    duplicate request) already wrote a blocking record between our
    //    initial read and this write. Re-check to give an accurate message. ──
    if (!updatedMedia) {
      const latestMedia = await Media.findById(mediaId);
      const latestVerifications = (
        latestMedia?.agreementDocVerification || []
      ).filter((h) => h.isVerified && isSameCycle(h.cycle, currentCycle));
      const selfAlreadyVerified = latestVerifications.some(
        (h) => h.verifiedByRole === userType,
      );
      const blocker = latestVerifications.find(
        (h) => ROLE_RANK[h.verifiedByRole] > userRank,
      );

      if (selfAlreadyVerified) {
        return res.status(400).json({
          success: false,
          message: `${ROLE_LABEL[userType]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
        });
      }
      if (blocker) {
        return res.status(403).json({
          success: false,
          message: `${ROLE_LABEL[userType]} cannot verify because ${ROLE_LABEL[blocker.verifiedByRole]} has already verified for this billing cycle`,
        });
      }
      return res.status(409).json({
        success: false,
        message:
          "Verification could not be completed due to a conflicting update. Please try again.",
      });
    }

    media = updatedMedia;

    // ── Get updated verification status (post-write, from the DB) ──
    const updatedVerifications = media.agreementDocVerification.filter(
      (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
    );

    const updatedStaffVerified = updatedVerifications.some(
      (h) => h.verifiedByRole === ROLE.STAFF,
    );
    const updatedTeamLeadVerified = updatedVerifications.some(
      (h) => h.verifiedByRole === ROLE.TEAM_LEAD,
    );
    const updatedOwnerVerified = updatedVerifications.some(
      (h) => h.verifiedByRole === ROLE.OWNER,
    );

    // "isComplete" stays true once 2 of 3 verified — this only signals
    // the quorum requirement is met, it does NOT block the 3rd role from
    // optionally verifying too.
    const updatedVerifiedCount = [
      updatedStaffVerified,
      updatedTeamLeadVerified,
      updatedOwnerVerified,
    ].filter(Boolean).length;

    const finalHighestVerifiedRole = getHighestVerifiedRole(
      updatedStaffVerified,
      updatedTeamLeadVerified,
      updatedOwnerVerified,
    );

    const verificationProgress = {
      staffVerified: updatedStaffVerified,
      teamLeadVerified: updatedTeamLeadVerified,
      ownerVerified: updatedOwnerVerified,
      verifiedCount: updatedVerifiedCount,
      isComplete: updatedVerifiedCount >= 2,
      highestVerifiedRole: finalHighestVerifiedRole,
    };
    saveVerificationProgressSnapshot(
      media,
      currentCycle,
      verificationProgress,
      userName,
    );
    await media.save();
    return res.status(200).json({
      success: true,
      message: `${ROLE_LABEL[userType]} verified the agreement document successfully for the billing cycle starting ${formatDate(currentCycle)}`,
      data: {
        verificationRecord,
        currentCycle: formatDate(currentCycle),
        verificationProgress,
        verificationProgressHistory: media.verificationProgressHistory,
        // verificationProgress: {
        //   staffVerified: updatedStaffVerified,
        //   teamLeadVerified: updatedTeamLeadVerified,
        //   ownerVerified: updatedOwnerVerified,
        //   verifiedCount: updatedVerifiedCount,
        //   isComplete: updatedVerifiedCount >= 2,
        //   highestVerifiedRole: getHighestVerifiedRole(
        //     updatedStaffVerified,
        //     updatedTeamLeadVerified,
        //     updatedOwnerVerified,
        //   ),
        // },
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
// ── Helper functions ──
function getCurrentCycle(nextBillingDate) {
  if (!nextBillingDate) return null;

  const billingDate = new Date(nextBillingDate);
  const year = billingDate.getFullYear();
  const month = String(billingDate.getMonth() + 1).padStart(2, "0");
  const day = String(billingDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDate(cycleIdentifier) {
  if (!cycleIdentifier) return "Unknown";

  if (cycleIdentifier.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = cycleIdentifier.split("-");
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  return cycleIdentifier;
}

// ── Helper functions ──
function getCurrentCycle(nextBillingDate) {
  if (!nextBillingDate) return null;

  const billingDate = new Date(nextBillingDate);
  const year = billingDate.getFullYear();
  const month = String(billingDate.getMonth() + 1).padStart(2, "0");
  const day = String(billingDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDate(cycleIdentifier) {
  if (!cycleIdentifier) return "Unknown";

  if (cycleIdentifier.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = cycleIdentifier.split("-");
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  return cycleIdentifier;
}
// ── Helper function to get current cycle based on nextBillingDate ──
function getCurrentCycle(nextBillingDate) {
  if (!nextBillingDate) return null;

  // Parse the nextBillingDate
  const billingDate = new Date(nextBillingDate);

  // Create a cycle identifier using year, month, and day
  // This ensures each billing cycle is uniquely identified
  const year = billingDate.getFullYear();
  const month = String(billingDate.getMonth() + 1).padStart(2, "0");
  const day = String(billingDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// ── Helper function to format date for display ──
function formatDate(cycleIdentifier) {
  if (!cycleIdentifier) return "Unknown";

  // If it's in YYYY-MM-DD format
  if (cycleIdentifier.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = cycleIdentifier.split("-");
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  return cycleIdentifier;
}

// exports.getRentalDueListWithStats = async (req, res) => {
//   try {
//     const {
//       dueDate,
//       city,
//       mediaType,
//       frequency,
//       status,
//       search,
//       pageNumber = 1,
//       count = 10,
//     } = req.body;

//     if (!dueDate) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "dueDate is required. Please use format MM-YYYY (e.g., 07-2026)",
//       });
//     }

//     if (!dueDate.match(/^\d{2}-\d{4}$/)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid dueDate format. Please use MM-YYYY (e.g., 07-2026)",
//       });
//     }

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;
//     const skip = (pageNumbers - 1) * pageSize;

//     const [mo, yr] = dueDate.split("-").map(Number);
//     const monthStart = new Date(yr, mo - 1, 1);
//     const monthEnd = new Date(yr, mo, 0, 23, 59, 59);
//     const dateFilter = { $gte: monthStart, $lte: monthEnd };

//     const mediaMatch = { status: 1 };
//     if (city) mediaMatch.city = { $regex: city, $options: "i" };
//     if (mediaType) mediaMatch.mediaType = { $regex: mediaType, $options: "i" };
//     if (frequency)
//       mediaMatch["rentalPayment.paymentFrequency"] = parseInt(frequency, 10);

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

//     const totalSites = await Media.countDocuments({ status: 1 });

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

//     const overDueSiteCount = await Media.countDocuments({
//       status: 1,
//       "rentalPayment.status": 3,
//       "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
//     });

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

//     const approvedCount = await Media.countDocuments({
//       status: 1,
//       rentalStatus: 3,
//       "rentalPayment.nextBillingDate": dateFilter,
//     });

//     const pendingCount = Math.max(
//       dueThisMonth.count - approvedCount - overDueSiteCount,
//       0,
//     );

//     // const listMatch = {
//     //   ...mediaMatch,
//     //   "rentalPayment.nextBillingDate": dateFilter,
//     // };
// const listMatch = {
//   ...mediaMatch,
//   $and: [
//     {
//       $or: [
//         { "rentalPayment.nextBillingDate": dateFilter },
//         { "rentalDue.dueDate": dateFilter },
//       ],
//     },
//   ],
// };
//     const listPipeline = [
//       { $match: listMatch },
//       {
//         $project: {
//           mediaCode: 1,
//           mediaName: 1,
//           landOwners: 1,
//           mediaType: 1,
//           city: 1,
//           state: 1,
//           rentalStatus: 1,
//           totalSqFt: 1,
//           location: 1,
//           rentalPayment: 1,
//           agreement: 1,
//           agreementDocVerification: 1,
//           verificationProgressHistory: 1,
//           rentalDue: 1,
//           updatedAt: 1,
//           lastUpdateDate: {
//             $max: [
//               "$updatedAt",
//               "$createdAt",
//               { $max: "$rentalDue.updatedAt" },
//               { $max: "$rentalDue.createdAt" },
//               { $max: "$agreementDocVerification.updatedAt" },
//               { $max: "$agreementDocVerification.createdAt" },
//             ],
//           },
//         },
//       },
//       {
//         $facet: {
//           data: [
//             { $sort: { updatedAt: -1 } },
//             { $skip: skip },
//             { $limit: pageSize },
//           ],
//           total: [{ $count: "count" }],
//         },
//       },
//     ];

//     const result = await Media.aggregate(listPipeline);
//     const data = result[0]?.data || [];
//     const total = result[0]?.total[0]?.count || 0;

//     const isSameCycle = (a, b) => {
//       if (!a || !b) return false;
//       const t1 = new Date(a).getTime();
//       const t2 = new Date(b).getTime();
//       return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
//     };

//     // const buildVerificationProgress = (item) => {
//     //   const currentCycle = getCurrentCycle(item.rentalPayment?.nextBillingDate);

//     //   if (!currentCycle) {
//     //     return {
//     //       currentCycle: null,
//     //       staffVerified: false,
//     //       teamLeadVerified: false,
//     //       ownerVerified: false,
//     //       verifiedCount: 0,
//     //       isComplete: false,
//     //       highestVerifiedRole: null,
//     //     };
//     //   }

//     //   const cycleVerifications = (item.agreementDocVerification || []).filter(
//     //     (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
//     //   );

//     //   // ── These now reflect ONLY actual verification records — never
//     //   // auto-marked true just because quorum (2 of 3) was reached by
//     //   // other roles. ──
//     //   const staffVerified = cycleVerifications.some(
//     //     (h) => h.verifiedByRole === ROLE.STAFF,
//     //   );
//     //   const teamLeadVerified = cycleVerifications.some(
//     //     (h) => h.verifiedByRole === ROLE.TEAM_LEAD,
//     //   );
//     //   const ownerVerified = cycleVerifications.some(
//     //     (h) => h.verifiedByRole === ROLE.OWNER,
//     //   );

//     //   const highestVerifiedRole = ownerVerified
//     //     ? ROLE.OWNER
//     //     : teamLeadVerified
//     //       ? ROLE.TEAM_LEAD
//     //       : staffVerified
//     //         ? ROLE.STAFF
//     //         : null;

//     //   const verifiedCount = [
//     //     staffVerified,
//     //     teamLeadVerified,
//     //     ownerVerified,
//     //   ].filter(Boolean).length;

//     //   // ── "isComplete" is the ONLY field that reflects the quorum rule —
//     //   // Staff + Team Lead verifying (2 of 3) is enough to close the cycle,
//     //   // Owner verification is then optional. But individual flags never lie
//     //   // about who actually verified. ──
//     //   return {
//     //     currentCycle: formatDate(currentCycle),
//     //     staffVerified,
//     //     teamLeadVerified,
//     //     ownerVerified, // ✅ true ONLY if Owner actually verified this cycle
//     //     verifiedCount,
//     //     isComplete: verifiedCount >= 2,
//     //     highestVerifiedRole,
//     //   };
//     // };
//     // const enriched = data.map((item) => ({

//     //   _id: item._id,
//     //   mediaCode: item.mediaCode,
//     //   mediaName: item.mediaName,
//     //   mediaType: item.mediaType,
//     //   city: item.city,
//     //   state: item.state,
//     //   location: item.location,
//     //   rentalStatus: item.rentalStatus,
//     //   totalSqFt: item.totalSqFt,
//     //   netPayable: item.rentalPayment?.netPayable || 0,
//     //   landOwners: item.landOwners,
//     //   paymentFrequency: item.rentalPayment?.paymentFrequency,
//     //   paymentFrequencyLabel:
//     //     FREQ_LABEL[item.rentalPayment?.paymentFrequency] || "",
//     //   nextBillingDate: item.rentalPayment?.nextBillingDate,
//     //   lastBillPaidDate: item.rentalPayment?.lastBillPaidDate,
//     //   dueStatus: item.rentalPayment?.status,
//     //   dueStatusLabel: STATUS_LABEL[item.rentalPayment?.status] || "",
//     //   agreementPeriod: {
//     //     startDate: item.agreement?.startDate,
//     //     endDate: item.agreement?.endDate,
//     //     agreementPDF: item.agreement?.agreementPDF,
//     //   },
//     //   agreementDocVerificationHistory: item.agreementDocVerification || [],
//     //   verificationProgress: buildVerificationProgress(item),
//     //   verificationProgressHistory: item.verificationProgressHistory || [],
//     //   rentalDueEntries: item.rentalDue || [],
//     // }));
// // ✅ Now takes the requested month's range and looks up the matching
// // snapshot from verificationProgressHistory (or falls back to computing
// // from agreementDocVerification if no snapshot exists yet for that
// // month) — instead of always using the LIVE nextBillingDate, which may
// // have already advanced past the requested month after Owner's approval.
// const buildVerificationProgress = (item, monthStart, monthEnd) => {
//   // 1️⃣ Try to find a persisted snapshot whose cycle falls in the
//   // requested month — this reflects what actually happened THAT month,
//   // even if nextBillingDate has since moved forward.
//   const historyForMonth = (item.verificationProgressHistory || []).filter(
//     (v) => {
//       const cycleDate = new Date(v.cycle);
//       return cycleDate >= monthStart && cycleDate <= monthEnd;
//     },
//   );

//   if (historyForMonth.length > 0) {
//     // Use the LATEST snapshot for that month (last one pushed = most
//     // complete state, e.g. after Team Lead verified following Staff)
//     const latest = historyForMonth[historyForMonth.length - 1];
//     return {
//       currentCycle: latest.currentCycleLabel,
//       staffVerified: latest.staffVerified,
//       teamLeadVerified: latest.teamLeadVerified,
//       ownerVerified: latest.ownerVerified,
//       verifiedCount: latest.verifiedCount,
//       isComplete: latest.isComplete,
//       highestVerifiedRole: latest.highestVerifiedRole,
//     };
//   }

//   // 2️⃣ Fallback — no snapshot exists yet for this month (e.g. nobody
//   // has verified for it at all). Compute directly from
//   // agreementDocVerification, filtering by cycle falling in the
//   // requested month range instead of matching the live nextBillingDate.
//   const cycleVerifications = (item.agreementDocVerification || []).filter(
//     (h) => {
//       if (!h.isVerified || !h.cycle) return false;
//       const cycleDate = new Date(h.cycle);
//       return cycleDate >= monthStart && cycleDate <= monthEnd;
//     },
//   );

//   const staffVerified = cycleVerifications.some(
//     (h) => h.verifiedByRole === ROLE.STAFF,
//   );
//   const teamLeadVerified = cycleVerifications.some(
//     (h) => h.verifiedByRole === ROLE.TEAM_LEAD,
//   );
//   const ownerVerified = cycleVerifications.some(
//     (h) => h.verifiedByRole === ROLE.OWNER,
//   );

//   const highestVerifiedRole = ownerVerified
//     ? ROLE.OWNER
//     : teamLeadVerified
//       ? ROLE.TEAM_LEAD
//       : staffVerified
//         ? ROLE.STAFF
//         : null;

//   const verifiedCount = [staffVerified, teamLeadVerified, ownerVerified].filter(
//     Boolean,
//   ).length;
// const monthStartCycleString = getCurrentCycle(monthStart);
//   return {
//     currentCycle: formatDate(monthStartCycleString), // label based on requested month
//     staffVerified,
//     teamLeadVerified,
//     ownerVerified,
//     verifiedCount,
//     isComplete: verifiedCount >= 2,
//     highestVerifiedRole,
//   };
// };
//     const enriched = data.map((item) => {
//   // ✅ NEW — filter rentalDueEntries down to ONLY the requested month
//   // (dueDate query param). The full history stays intact in the DB
//   // (item.rentalDue / rentalDueHistory) — this just scopes what's
//   // returned for THIS list call.
//   const filteredRentalDueEntries = (item.rentalDue || []).filter((entry) => {
//     if (!entry.dueDate) return false;
//     const entryDate = new Date(entry.dueDate);
//     return entryDate >= monthStart && entryDate <= monthEnd;
//   });

//   return {
//     _id: item._id,
//     mediaCode: item.mediaCode,
//     mediaName: item.mediaName,
//     mediaType: item.mediaType,
//     city: item.city,
//     state: item.state,
//     location: item.location,
//     rentalStatus: item.rentalStatus,
//     totalSqFt: item.totalSqFt,
//     netPayable: item.rentalPayment?.netPayable || 0,
//     landOwners: item.landOwners,
//     paymentFrequency: item.rentalPayment?.paymentFrequency,
//     paymentFrequencyLabel:
//       FREQ_LABEL[item.rentalPayment?.paymentFrequency] || "",
//     nextBillingDate: item.rentalPayment?.nextBillingDate,
//     lastBillPaidDate: item.rentalPayment?.lastBillPaidDate,
//     dueStatus: item.rentalPayment?.status,
//     dueStatusLabel: STATUS_LABEL[item.rentalPayment?.status] || "",
//     agreementPeriod: {
//       startDate: item.agreement?.startDate,
//       endDate: item.agreement?.endDate,
//       agreementPDF: item.agreement?.agreementPDF,
//     },
//     agreementDocVerificationHistory: item.agreementDocVerification || [],
//     verificationProgress: buildVerificationProgress(item, monthStart, monthEnd),
//     verificationProgressHistory: item.verificationProgressHistory || [],
//     rentalDueEntries: filteredRentalDueEntries, // ✅ now month-scoped, [] if none match
//   };
// });
//     return res.status(200).json({
//       success: true,
//       value: {
//         totalSites,
//         dueThisMonth,
//         dueAmountOpen,
//         overDue: { siteCount: overDueSiteCount },
//         approvedCount,
//         pendingCount,
//         // pendingApproval: {
//         //   staff: pendingByRole.staff,
//         //   teamLead: pendingByRole.teamLead,
//         //   owner: pendingByRole.owner,
//         //   total: pendingByRole.total,
//         // },
//       },
//       data: enriched,
//     });
//   } catch (err) {
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }
// };
exports.getRentalDueListWithStats = async (req, res) => {
  try {
    const {
      dueDate,
      city,
      mediaType,
      frequency,
      status,
      search,
      pageNumber = 1,
      count = 10,
    } = req.body;

    if (!dueDate) {
      return res.status(400).json({
        success: false,
        message:
          "dueDate is required. Please use format MM-YYYY (e.g., 07-2026)",
      });
    }

    if (!dueDate.match(/^\d{2}-\d{4}$/)) {
      return res.status(400).json({
        success: false,
        message: "Invalid dueDate format. Please use MM-YYYY (e.g., 07-2026)",
      });
    }

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;
    const skip = (pageNumbers - 1) * pageSize;

    const [mo, yr] = dueDate.split("-").map(Number);
    const monthStart = new Date(yr, mo - 1, 1);
    const monthEnd = new Date(yr, mo, 0, 23, 59, 59);
    const dateFilter = { $gte: monthStart, $lte: monthEnd };

    const mediaMatch = { status: 1 };
    if (city) mediaMatch.city = { $regex: city, $options: "i" };
    if (mediaType) mediaMatch.mediaType = { $regex: mediaType, $options: "i" };
    if (frequency)
      mediaMatch["rentalPayment.paymentFrequency"] = parseInt(frequency, 10);

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

    const totalSites = await Media.countDocuments({ status: 1 });

    // ✅ FIXED — match on EITHER the live nextBillingDate OR any
    // rentalDue entry's dueDate falling in the requested month. This
    // way, a site whose cycle already advanced (after Owner approved)
    // still counts toward the month it was actually due/approved in.
    const monthOrCondition = {
      $or: [
        {
          "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
        },
        { "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd } },
      ],
    };

    const dueThisMonthAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $match: monthOrCondition },
      {
        // Use the matching rentalDue entry's netPayable if the live
        // nextBillingDate has already moved past this month; otherwise
        // fall back to rentalPayment.netPayable.
        $addFields: {
          matchingEntry: {
            $first: {
              $filter: {
                input: { $ifNull: ["$rentalDue", []] },
                as: "rd",
                cond: {
                  $and: [
                    { $gte: ["$$rd.dueDate", monthStart] },
                    { $lte: ["$$rd.dueDate", monthEnd] },
                  ],
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          effectiveNetPayable: {
            $ifNull: ["$matchingEntry.netPayable", "$rentalPayment.netPayable"],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalNetPayable: { $sum: "$effectiveNetPayable" },
          count: { $sum: 1 },
        },
      },
    ]);
    const dueThisMonth = {
      totalNetPayable: dueThisMonthAgg[0]?.totalNetPayable || 0,
      count: dueThisMonthAgg[0]?.count || 0,
    };

    // ✅ dueAmountOpen — sites still open (status 2/3) for this month,
    // using the same either/or month match
    const dueAmountOpenAgg = await Media.aggregate([
      { $match: { status: 1, "rentalPayment.status": { $in: [2, 3] } } },
      { $match: monthOrCondition },
      {
        $group: { _id: null, totalOpen: { $sum: "$rentalPayment.netPayable" } },
      },
    ]);
    const dueAmountOpen = dueAmountOpenAgg[0]?.totalOpen || 0;

    // ✅ overDueSiteCount — same either/or month match
    const overDueSiteCount = await Media.countDocuments({
      status: 1,
      "rentalPayment.status": 3,
      ...monthOrCondition,
    });

    // ✅ approvedCount — sites with a rentalDue entry FULLY APPROVED
    // (status === 3) for THIS specific month, instead of relying on the
    // live top-level rentalStatus + nextBillingDate (which moves once
    // approved).
    const approvedCount = await Media.countDocuments({
      status: 1,
      rentalDue: {
        $elemMatch: {
          status: 3,
          dueDate: { $gte: monthStart, $lte: monthEnd },
        },
      },
    });

    const pendingCount = Math.max(
      dueThisMonth.count - approvedCount - overDueSiteCount,
      0,
    );

    // ✅ RE-ENABLED — Staff / Team Lead / Owner pending-approval
    // breakdown, scoped to rentalDue entries whose dueDate falls in the
    // requested month (not just "still pending" globally across all
    // months).
    const approvalBreakdownAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $unwind: "$rentalDue" },
      {
        $match: {
          "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd },
          "rentalDue.approvalStatus": { $in: [1, 2] },
        },
      },
      { $group: { _id: "$rentalDue.currentPendingRole", count: { $sum: 1 } } },
    ]);
    const pendingByRole = { staff: 0, teamLead: 0, owner: 0, total: 0 };
    approvalBreakdownAgg.forEach(({ _id, count }) => {
      if (_id === 1) pendingByRole.staff = count;
      if (_id === 2) pendingByRole.teamLead = count;
      if (_id === 3) pendingByRole.owner = count;
      pendingByRole.total += count;
    });

    // ✅ NEW — actual approval breakdown: how many entries were approved
    // by EACH role this month (based on approvalSteps, status === 2 for
    // that role's step), so you can see Staff-approved / Team-Lead-approved
    // / Owner-approved counts for the month, not just "who's still pending".
    const approvalCompletedBreakdownAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $unwind: "$rentalDue" },
      {
        $match: {
          "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd },
        },
      },
      { $unwind: "$rentalDue.approvalSteps" },
      {
        $match: {
          "rentalDue.approvalSteps.status": 2, // 2 = Approved
        },
      },
      {
        $group: {
          _id: "$rentalDue.approvalSteps.role",
          count: { $sum: 1 },
        },
      },
    ]);
    const approvedByRole = { staff: 0, teamLead: 0, owner: 0, total: 0 };
    approvalCompletedBreakdownAgg.forEach(({ _id, count }) => {
      if (_id === 1) approvedByRole.staff = count;
      if (_id === 2) approvedByRole.teamLead = count;
      if (_id === 3) approvedByRole.owner = count;
      approvedByRole.total += count;
    });

    const listMatch = {
      ...mediaMatch,
      $and: [monthOrCondition],
    };

    const listPipeline = [
      { $match: listMatch },
      {
        $project: {
          mediaCode: 1,
          mediaName: 1,
          landOwners: 1,
          mediaType: 1,
          city: 1,
          state: 1,
          rentalStatus: 1,
          totalSqFt: 1,
          location: 1,
          rentalPayment: 1,
          agreement: 1,
          agreementDocVerification: 1,
          verificationProgressHistory: 1,
          gstBalanceHistory: 1,
          rentalDue: 1,
          updatedAt: 1,
        },
      },
      {
        $facet: {
          data: [
            { $sort: { updatedAt: -1 } },
            { $skip: skip },
            { $limit: pageSize },
          ],
          total: [{ $count: "count" }],
        },
      },
    ];

    const result = await Media.aggregate(listPipeline);
    const data = result[0]?.data || [];
    const total = result[0]?.total[0]?.count || 0;

    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    const buildVerificationProgress = (item, monthStart, monthEnd) => {
      const historyForMonth = (item.verificationProgressHistory || []).filter(
        (v) => {
          const cycleDate = new Date(v.cycle);
          return cycleDate >= monthStart && cycleDate <= monthEnd;
        },
      );

      if (historyForMonth.length > 0) {
        const latest = historyForMonth[historyForMonth.length - 1];
        return {
          currentCycle: latest.currentCycleLabel,
          staffVerified: latest.staffVerified,
          teamLeadVerified: latest.teamLeadVerified,
          ownerVerified: latest.ownerVerified,
          verifiedCount: latest.verifiedCount,
          isComplete: latest.isComplete,
          highestVerifiedRole: latest.highestVerifiedRole,
        };
      }

      const cycleVerifications = (item.agreementDocVerification || []).filter(
        (h) => {
          if (!h.isVerified || !h.cycle) return false;
          const cycleDate = new Date(h.cycle);
          return cycleDate >= monthStart && cycleDate <= monthEnd;
        },
      );

      const staffVerified = cycleVerifications.some(
        (h) => h.verifiedByRole === ROLE.STAFF,
      );
      const teamLeadVerified = cycleVerifications.some(
        (h) => h.verifiedByRole === ROLE.TEAM_LEAD,
      );
      const ownerVerified = cycleVerifications.some(
        (h) => h.verifiedByRole === ROLE.OWNER,
      );

      const highestVerifiedRole = ownerVerified
        ? ROLE.OWNER
        : teamLeadVerified
          ? ROLE.TEAM_LEAD
          : staffVerified
            ? ROLE.STAFF
            : null;

      const verifiedCount = [
        staffVerified,
        teamLeadVerified,
        ownerVerified,
      ].filter(Boolean).length;

      const monthStartCycleString = getCurrentCycle(monthStart);

      return {
        currentCycle: formatDate(monthStartCycleString),
        staffVerified,
        teamLeadVerified,
        ownerVerified,
        verifiedCount,
        isComplete: verifiedCount >= 2,
        highestVerifiedRole,
      };
    };

    const enriched = data.map((item) => {
      const filteredRentalDueEntries = (item.rentalDue || []).filter(
        (entry) => {
          if (!entry.dueDate) return false;
          const entryDate = new Date(entry.dueDate);
          return entryDate >= monthStart && entryDate <= monthEnd;
        },
      );
      const filteredAgreementDocVerificationHistory = (
        item.agreementDocVerification || []
      ).filter((h) => {
        if (!h.cycle) return false;
        const cycleDate = new Date(h.cycle);
        return cycleDate >= monthStart && cycleDate <= monthEnd;
      });
      return {
        _id: item._id,
        mediaCode: item.mediaCode,
        mediaName: item.mediaName,
        mediaType: item.mediaType,
        city: item.city,
        state: item.state,
        location: item.location,
        rentalStatus: item.rentalStatus,
        totalSqFt: item.totalSqFt,
        totalRentalAmount: item.rentalPayment?.totalRentalAmount || 0,
        netPayable: item.rentalPayment?.netPayable || 0,
        gstApplicable: item.rentalPayment?.gstApplicable || 0,
        gstAmount: item.rentalPayment?.gstAmount || 0,
        landOwners: item.landOwners,
        paymentFrequency: item.rentalPayment?.paymentFrequency,
        customPaymentFrequency: item.rentalPayment?.customPaymentFrequency,
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
        // agreementDocVerificationHistory: item.agreementDocVerification || [],
        agreementDocVerificationHistory:
          filteredAgreementDocVerificationHistory,
        verificationProgress: buildVerificationProgress(
          item,
          monthStart,
          monthEnd,
        ),
        verificationProgressHistory: item.verificationProgressHistory || [],
        gstBalanceHistory: item.gstBalanceHistory || [],
        rentalDueEntries: filteredRentalDueEntries,
      };
    });

    return res.status(200).json({
      success: true,
      value: {
        totalSites,
        dueThisMonth,
        dueAmountOpen,
        overDue: { siteCount: overDueSiteCount },
        approvedCount,
        pendingCount,
        // ✅ RE-ENABLED — who's still pending approval, this month
        pendingApproval: {
          staff: pendingByRole.staff,
          teamLead: pendingByRole.teamLead,
          owner: pendingByRole.owner,
          total: pendingByRole.total,
        },
        // ✅ NEW — who ALREADY approved, this month
        approvalBreakdown: {
          staff: approvedByRole.staff,
          teamLead: approvedByRole.teamLead,
          owner: approvedByRole.owner,
          total: approvedByRole.total,
        },
      },
      data: enriched,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

exports.GstAmountPaid = async (req, res) => {
  try {
    const { userName } = req.user;
    const { mediaId, gstCycleIds } = req.body;

    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid mediaId is required" });
    }

    if (!Array.isArray(gstCycleIds) || gstCycleIds.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "gstCycleIds must be a non-empty array of GST balance record IDs",
      });
    }

    for (const id of gstCycleIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: `Invalid gstCycleId: ${id}`,
        });
      }
    }

    const media = await Media.findById(mediaId);
    if (!media) {
      return res
        .status(404)
        .json({ success: false, message: "Media not found" });
    }

    if (!Array.isArray(media.gstBalanceHistory)) {
      return res.status(400).json({
        success: false,
        message: "No GST balance history found for this media",
      });
    }

    const updatedRecords = [];
    const notFoundIds = [];
    const alreadyPaidIds = [];

    for (const id of gstCycleIds) {
      const record = media.gstBalanceHistory.find(
        (g) =>
          String(g._id) === String(id) || String(g.rentalDueId) === String(id),
      );

      if (!record) {
        notFoundIds.push(id);
        continue;
      }

      if (record.isPaid) {
        alreadyPaidIds.push(id);
        continue;
      }

      // ✅ FIXED — no paidAmount from request. Always pays off the
      // record's OWN gstAmount in full.
      record.isPaid = true;
      record.paidAmount = record.gstAmount;
      record.paidAt = nowIST();
      record.paidBy = userName;

      updatedRecords.push(record);
    }

    if (updatedRecords.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No matching unpaid GST records were found to update",
        notFoundIds,
        alreadyPaidIds,
      });
    }

    media.markModified("gstBalanceHistory");

    // Recompute balanceGstAmount as sum of remaining unpaid records
    recomputeBalanceGstAmount(media);

    media.updatedBy = userName;
    media.updatedAt = nowIST();
    await media.save();

    return res.status(200).json({
      success: true,
      message: `${updatedRecords.length} GST cycle record(s) marked as paid`,
      data: {
        mediaId: media._id,
        updatedRecords,
        notFoundIds,
        alreadyPaidIds,
        balanceGstAmount: media.rentalPayment?.balanceGstAmount || 0,
        gstBalanceHistory: media.gstBalanceHistory,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
