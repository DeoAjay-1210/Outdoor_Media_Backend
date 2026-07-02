// controllers/rentalDue.controller.js
const mongoose = require("mongoose");
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


// const RENTAL_STATUS_MAP = {
//   [ROLE.STAFF]: 1,
//   [ROLE.TEAM_LEAD]: 2,
//   [ROLE.OWNER]: 3,
// };

// // paymentFrequency -> number of months to add
// const FREQUENCY_MONTHS_MAP = {
//   1: 1,   // 1 month
//   2: 2,   // 2 months
//   3: 3,   // 3 months
//   4: 6,   // 6 months
//   5: 12,  // 1 year
//   6: 24,  // 2 years
// };

// // Adds N months to a date, safely (handles month-end overflow)
// function addMonths(date, months) {
//   const d = new Date(date);
//   d.setMonth(d.getMonth() + months);
//   return d;
// }

// // Rolls rentalPayment forward on final Owner approval:
// // lastBillPaidDate = current nextBillingDate
// // nextBillingDate  = current nextBillingDate + frequency months
// function advanceRentalPaymentOnOwnerApproval(media) {
//   const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
//   const frequency = media.rentalPayment?.paymentFrequency;
//   const monthsToAdd = FREQUENCY_MONTHS_MAP[frequency] || 1;

//   const baseDate = currentNextBillingDate
//     ? new Date(currentNextBillingDate)
//     : new Date();

//   media.rentalPayment.lastBillPaidDate = baseDate;
//   media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);
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

//     // Helper to check if duplicate verification exists
//     const isAlreadyVerified = (rentalDueId, role) => {
//       return media.agreementDocVerification.some(
//         (v) =>
//           String(v.rentalDueId) === String(rentalDueId) &&
//           v.verifiedByRole === role,
//       );
//     };

//     // Most recently created entry that hasn't been fully approved yet
//     const pendingEntry = [...media.rentalDue]
//       .reverse()
//       .find((e) => e.approvalStatus !== 3);

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

//       let wasAgreementVerified = false;

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
//         wasAgreementVerified = true;

//         // ✅ Owner approved (direct override) — roll billing date forward
//         advanceRentalPaymentOnOwnerApproval(media);
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
//           wasAgreementVerified = true;

//           // ✅ Chain completed AND the final approver was the Owner —
//           //    roll billing date forward
//           if (userType === ROLE.OWNER) {
//             advanceRentalPaymentOnOwnerApproval(media);
//           }
//         }
//       }

//       entry.updatedBy = userName;
//       entry.updatedAt = nowIST();

//       // ✅ Only push if agreement is verified AND no duplicate exists
//       // if (wasAgreementVerified && !isAlreadyVerified(entry._id, userType)) {
//       //   media.agreementDocVerification.push({
//       //     isVerified: true,
//       //     verifiedBy: userName,
//       //     verifiedByRole: userType,
//       //     verifiedAt: nowIST(),
//       //     rentalDueId: entry._id,
//       //     agreementPDF: media.agreement?.agreementPDF || {},
//       //     updatedAt: nowIST(),
//       //     updatedBy: userName,
//       //   });
//       // }

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
//           agreementDocVerified: entry.agreementDocVerified,
//           agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//           rentalPayment: media.rentalPayment, // ✅ so frontend sees updated dates
//         },
//       });
//     }

//     // ═══════════════════════════════════════
//     // BRANCH 2: no pending entry → CREATE.
//     // ═══════════════════════════════════════
//     if (!campaignName) {
//       return res
//         .status(400)
//         .json({ success: false, message: "campaignName is required" });
//     }

//     let proofOfCampaign = null;
//     if (req.file) {
//       if (!req.file.mimetype?.startsWith("image/")) {
//         return res.status(400).json({
//           success: false,
//           message: "Proof of campaign must be an image file",
//         });
//       }
//       proofOfCampaign = {
//         originalName: req.file.originalname,
//         fileName: req.file.filename,
//         filePath: req.file.path,
//         mimeType: req.file.mimetype,
//         size: req.file.size,
//         fileType: "image",
//         uploadedAt: nowIST(),
//       };
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
//     let wasAgreementVerified = false;

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
//       wasAgreementVerified = true;
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
//       wasAgreementVerified = false;
//     } else {
//       staffStep.status = 2;
//       staffStep.userId = userId;
//       staffStep.userName = userName;
//       staffStep.approvedAt = nowIST();
//       staffStep.docVerified = false;
//       staffStep.remarks = "Entry created by Staff";
//       wasAgreementVerified = false;
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

//     // ✅ Owner created AND fully approved it directly — roll billing date forward
//     if (isOwnerOverride) {
//       advanceRentalPaymentOnOwnerApproval(media);
//     }

//     media.rentalDue.push(newEntry);
//     const savedEntry = media.rentalDue[media.rentalDue.length - 1];

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

//     // ✅ Only push if agreement is verified AND no duplicate exists
//     // if (wasAgreementVerified && !isAlreadyVerified(savedEntry._id, userType)) {
//     //   media.agreementDocVerification.push({
//     //     isVerified: true,
//     //     verifiedBy: userName,
//     //     verifiedByRole: userType,
//     //     verifiedAt: nowIST(),
//     //     rentalDueId: savedEntry._id,
//     //     agreementPDF: media.agreement?.agreementPDF || {},
//     //     updatedAt: nowIST(),
//     //     updatedBy: userName,
//     //   });
//     // }

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
//         agreementDocVerified: newEntry.agreementDocVerified,
//         agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//         rentalPayment: media.rentalPayment, // ✅ so frontend sees updated dates
//       },
//     });
//   } catch (err) {
//     console.error("saveRentalDue error:", err);
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }
// };

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
 
// Adds N months to a date, safely (handles month-end overflow)
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
 
// Reset the live "current cycle" flags back to false/false/false.
// Called the instant a cycle closes, so the next cycle starts clean.
function resetLiveAgreementFlags(media) {
  media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
}
 
// Push a permanent, immutable snapshot into the history log.
// Deduped on (rentalDueId, role) so re-saves never create doubles.
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
 
// Marks a role's live flag as verified for the CURRENT cycle and logs it
// to permanent history in the same step.
function markRoleVerified(media, entry, role, userName) {
  media.agreementDocVerified[ROLE_FLAG_KEY[role]] = true;
  pushVerificationHistory(media, entry, role, userName);
}
 
// Rolls rentalPayment forward on final Owner approval, closes out the
// current cycle's live flags, and resets them for the next cycle.
// lastBillPaidDate = current nextBillingDate
// nextBillingDate  = current nextBillingDate + frequency months
function advanceRentalPaymentOnOwnerApproval(media) {
  const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
  const frequency = media.rentalPayment?.paymentFrequency;
  const monthsToAdd = FREQUENCY_MONTHS_MAP[frequency] || 1;
 
  const baseDate = currentNextBillingDate
    ? new Date(currentNextBillingDate)
    : new Date();
 
  media.rentalPayment.lastBillPaidDate = baseDate;
  media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);
 
  // ✅ cycle is now closed — reset live flags so next month starts clean.
  // (History for this closing cycle was already logged via
  // markRoleVerified as each role approved, so nothing is lost.)
  resetLiveAgreementFlags(media);
}
 
// Derives a quick verification status string from the live flags —
// use this in place of any old getAgreementVerificationStatus(media)
// helper that read off the removed agreementDocVerification array.
function getAgreementVerificationStatus(media) {
  const f = media.agreementDocVerified || {};
  if (f.staff && f.teamLead && f.owner) return "Fully Verified";
  if (f.staff || f.teamLead || f.owner) return "Partially Verified";
  return "Not Verified";
}
 
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
//       media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
//     }
//     if (!media.agreementDocVerificationHistory) {
//       media.agreementDocVerificationHistory = [];
//     }
//     if (!Array.isArray(media.rentalDueEntries)) {
//       // Self-heal old documents: if they still have data sitting under the
//       // old field name `rentalDue`, migrate it over on first touch instead
//       // of dropping it. New/blank docs just get an empty array.
//       media.rentalDueEntries = Array.isArray(media.rentalDue)
//         ? media.rentalDue
//         : [];
//     }
//     if (!Array.isArray(media.rentalDueHistory)) {
//       media.rentalDueHistory = [];
//     }
 
//     // Most recently created entry that hasn't been fully approved yet.
//     // Because a closed cycle always ends at approvalStatus === 3, this
//     // correctly returns nothing once the current cycle is fully approved,
//     // which is what lets BRANCH 2 create a fresh entry for the new month.
//     const pendingEntry = [...media.rentalDueEntries]
//       .reverse()
//       .find((e) => e.approvalStatus !== 3);
 
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
 
//         // log + close out the cycle (this also resets the live flags)
//         markRoleVerified(media, entry, ROLE.OWNER, userName);
//         advanceRentalPaymentOnOwnerApproval(media);
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
 
//         // ✅ live flag + history for THIS role, every time — not just on
//         // final approval. This is what was missing before.
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
 
//           // Chain completed and the final approver was the Owner —
//           // close out the cycle (rolls billing date + resets live flags)
//           if (userType === ROLE.OWNER) {
//             advanceRentalPaymentOnOwnerApproval(media);
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
//           agreementDocVerified: media.agreementDocVerified, // live, current-cycle flags
//           agreementDocVerificationHistory: media.agreementDocVerificationHistory,
//           agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//           rentalPayment: media.rentalPayment, // ✅ so frontend sees updated dates
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
 
//     let proofOfCampaign = null;
//     if (req.file) {
//       if (!req.file.mimetype?.startsWith("image/")) {
//         return res.status(400).json({
//           success: false,
//           message: "Proof of campaign must be an image file",
//         });
//       }
//       proofOfCampaign = {
//         originalName: req.file.originalname,
//         fileName: req.file.filename,
//         filePath: req.file.path,
//         mimeType: req.file.mimetype,
//         size: req.file.size,
//         fileType: "image",
//         uploadedAt: nowIST(),
//       };
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
//     const savedEntry = media.rentalDueEntries[media.rentalDueEntries.length - 1];
 
//     // ✅ live flags + history for whichever role(s) just approved on creation
//     if (isOwnerOverride) {
//       markRoleVerified(media, savedEntry, ROLE.OWNER, userName);
//     } else if (isTeamLeadCreating) {
//       markRoleVerified(media, savedEntry, ROLE.TEAM_LEAD, userName);
//     }
//     // plain Staff creation leaves all flags false — correct, nobody has
//     // verified anything yet.
 
//     // Owner created AND fully approved it directly — roll billing date
//     // forward and reset the live flags for the cycle after this one.
//     if (isOwnerOverride) {
//       advanceRentalPaymentOnOwnerApproval(media);
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
//         agreementDocVerified: media.agreementDocVerified, // live, current-cycle flags
//         agreementDocVerificationHistory: media.agreementDocVerificationHistory,
//         agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//         rentalPayment: media.rentalPayment, // ✅ so frontend sees updated dates
//       },
//     });
//   } catch (err) {
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }

// };
// const ROLE_RANK = {
//   [ROLE.STAFF]: 1,
//   [ROLE.TEAM_LEAD]: 2,
//   [ROLE.OWNER]: 3,
// };


// exports.verifyAgreementDoc = async (req, res) => {
//   try {
//     const { mediaId } = req.body;
//     const { userType, userName } = req.user;

//     if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
//       return res
//         .status(400)
//         .json({ success: false, message: "A valid mediaId is required" });
//     }

//     let media = await Media.findById(mediaId);
//     if (!media) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Media not found" });
//     }

//     if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
//       return res
//         .status(403)
//         .json({ success: false, message: "Invalid or missing user role" });
//     }

//     // ── Get current cycle from nextBillingDate ──
//     const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);

//     if (!currentCycle) {
//       return res.status(400).json({
//         success: false,
//         message: "Unable to determine current billing cycle"
//       });
//     }

//     // ── Safe cycle comparison ──
//     // IMPORTANT: `h.cycle` and `currentCycle` are Date values. Comparing
//     // them with strict equality (===) compares object references, NOT the
//     // actual date/time — two Date objects for the exact same moment are
//     // never === equal. Always compare via getTime() (or a normalized string).
//     const isSameCycle = (a, b) => {
//       if (!a || !b) return false;
//       const t1 = new Date(a).getTime();
//       const t2 = new Date(b).getTime();
//       return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
//     };

//     // ── Get all verifications for the current cycle ──
//     const currentCycleVerifications = media.agreementDocVerification.filter(
//       h => h.isVerified && isSameCycle(h.cycle, currentCycle)
//     );

//     // ── Check verification status of each role in current cycle ──
//     const staffVerified = currentCycleVerifications.some(
//       h => h.verifiedByRole === ROLE.STAFF
//     );
//     const teamLeadVerified = currentCycleVerifications.some(
//       h => h.verifiedByRole === ROLE.TEAM_LEAD
//     );
//     const ownerVerified = currentCycleVerifications.some(
//       h => h.verifiedByRole === ROLE.OWNER
//     );

//     // ── Get the highest role that has verified, given a set of flags ──
//     // (made into a pure function that takes flags as params, so we can
//     //  call it BOTH before the write [pre-check] and after [response],
//     //  without one call silently reading stale closured variables) ──
//     const getHighestVerifiedRole = (staff, teamLead, owner) => {
//       if (owner) return ROLE.OWNER;
//       if (teamLead) return ROLE.TEAM_LEAD;
//       if (staff) return ROLE.STAFF;
//       return null;
//     };

//     const highestVerifiedRole = getHighestVerifiedRole(
//       staffVerified,
//       teamLeadVerified,
//       ownerVerified,
//     );
//     const userRank = ROLE_RANK[userType];

//     // ── VALIDATION 1: Check if user already verified in this cycle ──
//     if (userType === ROLE.STAFF && staffVerified) {
//       return res.status(400).json({
//         success: false,
//         message: `${ROLE_LABEL[ROLE.STAFF]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
//       });
//     }
//     if (userType === ROLE.TEAM_LEAD && teamLeadVerified) {
//       return res.status(400).json({
//         success: false,
//         message: `${ROLE_LABEL[ROLE.TEAM_LEAD]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
//       });
//     }
//     if (userType === ROLE.OWNER && ownerVerified) {
//       return res.status(400).json({
//         success: false,
//         message: `${ROLE_LABEL[ROLE.OWNER]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
//       });
//     }

//     // ── VALIDATION 2: A lower-ranked role can never verify AFTER a
//     //    higher-ranked role has already verified in this cycle.
//     //    - If Team Lead verifies first  -> Staff is blocked (Owner can still verify).
//     //    - If Owner verifies first      -> Staff and Team Lead are both blocked.
//     //    A higher role is NEVER blocked by a lower role having verified first,
//     //    and there is no requirement for lower roles to verify first anymore.
//     if (highestVerifiedRole) {
//       const highestRank = ROLE_RANK[highestVerifiedRole];

//       if (highestRank > userRank) {
//         return res.status(403).json({
//           success: false,
//           message: `${ROLE_LABEL[userType]} cannot verify because ${ROLE_LABEL[highestVerifiedRole]} has already verified for this billing cycle`,
//         });
//       }
//     }

//     // ── Create verification record ──
//     const verificationRecord = {
//       isVerified: true,
//       verifiedBy: userName,
//       verifiedByRole: userType,
//       verifiedAt: nowIST(),
//       rentalDueId: null,
//       agreementPDF: media.agreement?.agreementPDF || {},
//       cycle: currentCycle,
//       cycleStartDate: media.rentalPayment?.nextBillingDate,
//       updatedAt: nowIST(),
//       updatedBy: userName,
//     };

//     // ── Roles that would block this user from verifying (own role +
//     //    any higher-ranked role) for this cycle ──
//     const blockingRoles = [ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].filter(
//       role => role === userType || ROLE_RANK[role] > userRank
//     );

//     // ── ATOMIC WRITE ──
//     // Instead of "read media -> check in JS -> push -> save" (which has a
//     // race-condition window: two near-simultaneous requests, e.g. an owner
//     // double-clicking Verify or duplicate network retries, can both read
//     // the doc BEFORE either save() completes, both see "not verified yet",
//     // and both push a record — causing the same role to end up verified
//     // more than once in one cycle), we do a single atomic Mongo update.
//     // The $push only happens if, at write time, the DB does NOT already
//     // contain a matching blocking record for this cycle. Mongo compares
//     // the `cycle` Date by actual value, so this also avoids any JS
//     // Date-reference comparison issues.
//     const updatedMedia = await Media.findOneAndUpdate(
//       {
//         _id: mediaId,
//         agreementDocVerification: {
//           $not: {
//             $elemMatch: {
//               isVerified: true,
//               cycle: currentCycle,
//               verifiedByRole: { $in: blockingRoles },
//             },
//           },
//         },
//       },
//       {
//         $push: { agreementDocVerification: verificationRecord },
//         $set: { updatedBy: userName, updatedAt: nowIST() },
//       },
//       { new: true }
//     );

//     // ── If the atomic update matched nothing, someone else (or a
//     //    duplicate request) already wrote a blocking record between our
//     //    initial read and this write. Re-check to give an accurate message
//     //    instead of silently failing or double-verifying. ──
//     if (!updatedMedia) {
//       const latestMedia = await Media.findById(mediaId);
//       const latestVerifications = (latestMedia?.agreementDocVerification || []).filter(
//         h => h.isVerified && isSameCycle(h.cycle, currentCycle)
//       );
//       const selfAlreadyVerified = latestVerifications.some(
//         h => h.verifiedByRole === userType
//       );
//       const blocker = latestVerifications.find(
//         h => ROLE_RANK[h.verifiedByRole] > userRank
//       );

//       if (selfAlreadyVerified) {
//         return res.status(400).json({
//           success: false,
//           message: `${ROLE_LABEL[userType]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
//         });
//       }
//       if (blocker) {
//         return res.status(403).json({
//           success: false,
//           message: `${ROLE_LABEL[userType]} cannot verify because ${ROLE_LABEL[blocker.verifiedByRole]} has already verified for this billing cycle`,
//         });
//       }
//       return res.status(409).json({
//         success: false,
//         message: "Verification could not be completed due to a conflicting update. Please try again.",
//       });
//     }

//     media = updatedMedia;

//     // ── Get updated verification status (post-write, from the DB) ──
//     const updatedVerifications = media.agreementDocVerification.filter(
//       h => h.isVerified && isSameCycle(h.cycle, currentCycle)
//     );

//     const updatedStaffVerified = updatedVerifications.some(
//       h => h.verifiedByRole === ROLE.STAFF
//     );
//     const updatedTeamLeadVerified = updatedVerifications.some(
//       h => h.verifiedByRole === ROLE.TEAM_LEAD
//     );
//     const updatedOwnerVerified = updatedVerifications.some(
//       h => h.verifiedByRole === ROLE.OWNER
//     );

//     return res.status(200).json({
//       success: true,
//       message: `${ROLE_LABEL[userType]} verified the agreement document successfully for the billing cycle starting ${formatDate(currentCycle)}`,
//       data: {
//         verificationRecord,
//         // agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//         currentCycle: formatDate(currentCycle),
//         verificationProgress: {
//           staffVerified: updatedStaffVerified,
//           teamLeadVerified: updatedTeamLeadVerified,
//           ownerVerified: updatedOwnerVerified,
//           isComplete: updatedStaffVerified && updatedTeamLeadVerified && updatedOwnerVerified,
//           // ✅ fixed — now uses the FRESH post-write flags instead of the
//           // stale pre-write closured variables (staffVerified/teamLeadVerified/ownerVerified)
//           highestVerifiedRole: getHighestVerifiedRole(
//             updatedStaffVerified,
//             updatedTeamLeadVerified,
//             updatedOwnerVerified,
//           ),
//         }
//       },
//     });
//   } catch (err) {
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }
// };
exports.saveRentalDue = async (req, res) => {
  try {
    const { userType, userId, userName } = req.user;
    const { mediaId, campaignName } = req.body;

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
      media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
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

    // ══════════════════════════════════════════════════════════════
    // 🔒 NEW GUARD — "verify first, then save"
    // The caller's role must have already verified the agreement
    // document (via verifyAgreementDoc) for the CURRENT billing
    // cycle before they're allowed to create OR approve a rental
    // due entry. This applies identically to Staff, Team Lead and
    // Owner, and to both branches below (approval + create), since
    // it's checked before the branch split.
    //
    // Reuses the exact same cycle-matching logic as verifyAgreementDoc
    // (getCurrentCycle + isSameCycle via getTime comparison) so the
    // "current cycle" here always matches the one verification was
    // recorded against — no drift between the two endpoints.
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

    const hasVerifiedThisCycle = media.agreementDocVerification.some(
      (h) =>
        h.isVerified &&
        h.verifiedByRole === userType &&
        isSameCycle(h.cycle, currentCycleForVerification),
    );

    if (!hasVerifiedThisCycle) {
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

    // ── SELF-CONTAINED GUARD — doesn't depend on any external helper.
    // Checks the actual entries array: has ANY entry for this exact
    // billing cycle (same dueDate) already been fully approved (status
    // === 3) by the Owner? If yes, block — regardless of what
    // agreementDocVerified.owner currently says. ──
    const ownerAlreadyClosedThisCycle = media.rentalDueEntries.some((e) => {
      if (e.status !== 3) return false;
      if (!currentCycleDate || !e.dueDate) return false;
      if (new Date(e.dueDate).getTime() !== currentCycleDate) return false;
      // final approver was Owner for this entry
      const ownerStep = e.approvalSteps?.find((s) => s.role === ROLE.OWNER);
      return ownerStep?.status === 2;
    });

    if (userType === ROLE.OWNER && ownerAlreadyClosedThisCycle) {
      return res.status(400).json({
        success: false,
        message: "Owner has already approved this document for the current cycle",
      });
    }

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
        media.rentalStatus = RENTAL_STATUS_MAP[ROLE.OWNER];

        markRoleVerified(media, entry, ROLE.OWNER, userName);
        advanceRentalPaymentOnOwnerApproval(media);

        // ✅ redundant safety reset — guarantees the live flags are
        // false for the NEW cycle even if advanceRentalPaymentOnOwnerApproval
        // doesn't do it correctly internally.
        media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
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
            advanceRentalPaymentOnOwnerApproval(media);

            // ✅ redundant safety reset — same as above
            media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
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
        historyRecord.updatedAt = nowIST();
        historyRecord.updatedBy = userName;
      }

      media.updatedBy = userName;
      media.updatedAt = nowIST();
      await media.save();

      return res.status(200).json({
        success: true,
        message: isOwnerOverride
          ? "Approved directly by Owner"
          : `${ROLE_LABEL[userType]} approval recorded`,
        data: {
          mediaId: media._id,
          rentalDueId: entry._id,
          approvalSteps: entry.approvalSteps,
          approvalStatus: entry.approvalStatus,
          currentPendingRole: entry.currentPendingRole,
          currentPendingRoleLabel: entry.currentPendingRole
            ? ROLE_LABEL[entry.currentPendingRole]
            : "Completed",
          rentalStatus: media.rentalStatus,
          agreementDocVerified: media.agreementDocVerified,
          agreementDocVerificationHistory: media.agreementDocVerificationHistory,
          agreementDocVerificationStatus: getAgreementVerificationStatus(media),
          rentalPayment: media.rentalPayment,
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

    // ✅ Extra guard specifically for the CREATE + Owner-override path —
    // even if two requests race and both pass the pendingEntry check above
    // (both read before either saved), this catches an owner trying to
    // create-and-approve a SECOND entry for a dueDate that already has a
    // fully-approved-by-owner entry sitting in rentalDueEntries.
    if (userType === ROLE.OWNER) {
      const dueDateObjPreCheck = media.rentalPayment?.nextBillingDate
        ? new Date(media.rentalPayment.nextBillingDate)
        : new Date();
      const alreadyClosed = media.rentalDueEntries.some((e) => {
        if (e.status !== 3 || !e.dueDate) return false;
        if (new Date(e.dueDate).getTime() !== dueDateObjPreCheck.getTime()) return false;
        const ownerStep = e.approvalSteps?.find((s) => s.role === ROLE.OWNER);
        return ownerStep?.status === 2;
      });
      if (alreadyClosed) {
        return res.status(400).json({
          success: false,
          message: "Owner has already approved this document for the current cycle",
        });
      }
    }

    // let proofOfCampaign = null;
    // if (req.file) {
    //   if (!req.file.mimetype?.startsWith("image/")) {
    //     return res.status(400).json({
    //       success: false,
    //       message: "Proof of campaign must be an image file",
    //     });
    //   }
    //   proofOfCampaign = {
    //     originalName: req.file.originalname,
    //     fileName: req.file.filename,
    //     filePath: req.file.path,
    //     mimeType: req.file.mimetype,
    //     size: req.file.size,
    //     fileType: "image",
    //     uploadedAt: nowIST(),
    //   };
    // }
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

    const newEntry = {
      dueMonth: getDueMonthLabel(dueDateObj),
      dueDate: dueDateObj,
      netPayable: media.rentalPayment?.netPayable || 0,
      paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
      campaignName,
      proofOfCampaign,
      savedBy: { userId, userName, role: userType, savedAt: nowIST() },
      approvalFlow: 2,
      approvalSteps: steps,
      approvalStatus: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
      currentPendingRole: nextPendingStep ? nextPendingStep.role : null,
      agreementDocVerified: allApproved,
      status: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
      updatedBy: userName,
      updatedAt: nowIST(),
    };
    media.rentalStatus = RENTAL_STATUS_MAP[userType];

    media.rentalDueEntries.push(newEntry);
    const savedEntry = media.rentalDueEntries[media.rentalDueEntries.length - 1];

    if (isOwnerOverride) {
      markRoleVerified(media, savedEntry, ROLE.OWNER, userName);
    } else if (isTeamLeadCreating) {
      markRoleVerified(media, savedEntry, ROLE.TEAM_LEAD, userName);
    }

    if (isOwnerOverride) {
      advanceRentalPaymentOnOwnerApproval(media);

      // ✅ redundant safety reset — guarantees flags are false for the
      // NEW cycle that was just opened
      media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
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
      netPayable: media.rentalPayment?.netPayable || 0,
      approvalStatus: newEntry.approvalStatus,
      savedBy: userName,
      savedByRole: userType,
      updatedAt: nowIST(),
      updatedBy: userName,
    });

    media.updatedBy = userName;
    media.updatedAt = nowIST();
    await media.save();

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
        message: "Unable to determine current billing cycle"
      });
    }

    // ── Safe cycle comparison ──
    // IMPORTANT: `h.cycle` and `currentCycle` are Date values. Comparing
    // them with strict equality (===) compares object references, NOT the
    // actual date/time — two Date objects for the exact same moment are
    // never === equal. Always compare via getTime() (or a normalized string).
    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    // ── Get all verifications for the current cycle ──
    const currentCycleVerifications = media.agreementDocVerification.filter(
      h => h.isVerified && isSameCycle(h.cycle, currentCycle)
    );

    // ── Check verification status of each role in current cycle ──
    const staffVerified = currentCycleVerifications.some(
      h => h.verifiedByRole === ROLE.STAFF
    );
    const teamLeadVerified = currentCycleVerifications.some(
      h => h.verifiedByRole === ROLE.TEAM_LEAD
    );
    const ownerVerified = currentCycleVerifications.some(
      h => h.verifiedByRole === ROLE.OWNER
    );

    // ── Get the highest role that has verified, given a set of flags ──
    // (made into a pure function that takes flags as params, so we can
    //  call it BOTH before the write [pre-check] and after [response],
    //  without one call silently reading stale closured variables) ──
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

    // ── VALIDATION 1: Check if user already verified in this cycle ──
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

    // ── VALIDATION 2: A lower-ranked role can never verify AFTER a
    //    higher-ranked role has already verified in this cycle.
    //    - If Team Lead verifies first  -> Staff is blocked (Owner can still verify).
    //    - If Owner verifies first      -> Staff and Team Lead are both blocked.
    //    A higher role is NEVER blocked by a lower role having verified first,
    //    and there is no requirement for lower roles to verify first anymore.
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
      role => role === userType || ROLE_RANK[role] > userRank
    );

    // ── ATOMIC WRITE ──
    // Instead of "read media -> check in JS -> push -> save" (which has a
    // race-condition window: two near-simultaneous requests, e.g. an owner
    // double-clicking Verify or duplicate network retries, can both read
    // the doc BEFORE either save() completes, both see "not verified yet",
    // and both push a record — causing the same role to end up verified
    // more than once in one cycle), we do a single atomic Mongo update.
    // The $push only happens if, at write time, the DB does NOT already
    // contain a matching blocking record for this cycle. Mongo compares
    // the `cycle` Date by actual value, so this also avoids any JS
    // Date-reference comparison issues.
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
      { new: true }
    );

    // ── If the atomic update matched nothing, someone else (or a
    //    duplicate request) already wrote a blocking record between our
    //    initial read and this write. Re-check to give an accurate message
    //    instead of silently failing or double-verifying. ──
    if (!updatedMedia) {
      const latestMedia = await Media.findById(mediaId);
      const latestVerifications = (latestMedia?.agreementDocVerification || []).filter(
        h => h.isVerified && isSameCycle(h.cycle, currentCycle)
      );
      const selfAlreadyVerified = latestVerifications.some(
        h => h.verifiedByRole === userType
      );
      const blocker = latestVerifications.find(
        h => ROLE_RANK[h.verifiedByRole] > userRank
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
        message: "Verification could not be completed due to a conflicting update. Please try again.",
      });
    }

    media = updatedMedia;

    // ── Get updated verification status (post-write, from the DB) ──
    const updatedVerifications = media.agreementDocVerification.filter(
      h => h.isVerified && isSameCycle(h.cycle, currentCycle)
    );

    const updatedStaffVerified = updatedVerifications.some(
      h => h.verifiedByRole === ROLE.STAFF
    );
    const updatedTeamLeadVerified = updatedVerifications.some(
      h => h.verifiedByRole === ROLE.TEAM_LEAD
    );
    const updatedOwnerVerified = updatedVerifications.some(
      h => h.verifiedByRole === ROLE.OWNER
    );

    return res.status(200).json({
      success: true,
      message: `${ROLE_LABEL[userType]} verified the agreement document successfully for the billing cycle starting ${formatDate(currentCycle)}`,
      data: {
        verificationRecord,
        // agreementDocVerificationStatus: getAgreementVerificationStatus(media),
        currentCycle: formatDate(currentCycle),
        verificationProgress: {
          staffVerified: updatedStaffVerified,
          teamLeadVerified: updatedTeamLeadVerified,
          ownerVerified: updatedOwnerVerified,
          isComplete: updatedStaffVerified && updatedTeamLeadVerified && updatedOwnerVerified,
          // ✅ fixed — now uses the FRESH post-write flags instead of the
          // stale pre-write closured variables (staffVerified/teamLeadVerified/ownerVerified)
          highestVerifiedRole: getHighestVerifiedRole(
            updatedStaffVerified,
            updatedTeamLeadVerified,
            updatedOwnerVerified,
          ),
        }
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
  const month = String(billingDate.getMonth() + 1).padStart(2, '0');
  const day = String(billingDate.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

function formatDate(cycleIdentifier) {
  if (!cycleIdentifier) return 'Unknown';
  
  if (cycleIdentifier.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = cycleIdentifier.split('-');
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }
  
  return cycleIdentifier;
}

// ── Helper functions ──
function getCurrentCycle(nextBillingDate) {
  if (!nextBillingDate) return null;
  
  const billingDate = new Date(nextBillingDate);
  const year = billingDate.getFullYear();
  const month = String(billingDate.getMonth() + 1).padStart(2, '0');
  const day = String(billingDate.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

function formatDate(cycleIdentifier) {
  if (!cycleIdentifier) return 'Unknown';
  
  if (cycleIdentifier.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = cycleIdentifier.split('-');
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
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
  const month = String(billingDate.getMonth() + 1).padStart(2, '0');
  const day = String(billingDate.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

// ── Helper function to format date for display ──
function formatDate(cycleIdentifier) {
  if (!cycleIdentifier) return 'Unknown';
  
  // If it's in YYYY-MM-DD format
  if (cycleIdentifier.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = cycleIdentifier.split('-');
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }
  
  return cycleIdentifier;
}
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
        message: "dueDate is required. Please use format MM-YYYY (e.g., 07-2026)",
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

    const overDueSiteCount = await Media.countDocuments({
      status: 1,
      "rentalPayment.status": 3,
      "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
    });

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

    // ✅ approvedCount = sites where Owner has approved (top-level rentalStatus === 3)
    const approvedCount = await Media.countDocuments({
      status: 1,
      rentalStatus: 3,
    });

    // ✅ pendingCount = totalSites minus approved minus overdue (this month)
    const pendingCount = Math.max(totalSites - approvedCount - overDueSiteCount, 0);

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
          rentalStatus: 1,
          totalSqFt: 1,
          location: 1,
          rentalPayment: 1,
          agreement: 1,
          agreementDocVerification: 1,
          rentalDue: 1,
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

    // ── Same cycle comparison logic used in verifyAgreementDoc ──
    // Compares Date VALUES, not references — required since two Date
    // objects for the same moment are never === equal.
    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    // ── Builds the per-item cycle-based verification progress ──
    // Cycle = the site's OWN current rentalPayment.nextBillingDate.
    // When nextBillingDate advances (after Owner approval on saveRentalDue),
    // the cycle changes automatically, so old verifications from the
    // previous cycle no longer match -> staff/teamLead/owner all reset
    // to false for the new cycle without needing to delete old records.
    const buildVerificationProgress = (item) => {
      const currentCycle = getCurrentCycle(item.rentalPayment?.nextBillingDate);

      if (!currentCycle) {
        return {
          currentCycle: null,
          staffVerified: false,
          teamLeadVerified: false,
          ownerVerified: false,
          isComplete: false,
          highestVerifiedRole: null,
        };
      }

      const cycleVerifications = (item.agreementDocVerification || []).filter(
        (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
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

      return {
        currentCycle: formatDate(currentCycle),
        staffVerified,
        teamLeadVerified,
        ownerVerified,
        isComplete: staffVerified && teamLeadVerified && ownerVerified,
        highestVerifiedRole,
      };
    };

    const enriched = data.map((item) => ({
      _id: item._id,
      mediaCode: item.mediaCode,
      mediaName: item.mediaName,
      mediaType: item.mediaType,
      city: item.city,
      state: item.state,
      location: item.location,
      rentalStatus: item.rentalStatus,
      totalSqFt: item.totalSqFt,
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
      // agreementDocVerified: getAgreementVerificationStatus(item),
      agreementDocVerificationHistory: item.agreementDocVerification || [],
      verificationProgress: buildVerificationProgress(item), // ✅ added — cycle-based staff/teamLead/owner true/false
      rentalDueEntries: item.rentalDue || [],
    }));

    return res.status(200).json({
      success: true,
      value: {
        totalSites,
        dueThisMonth,
        dueAmountOpen,
        overDue: { siteCount: overDueSiteCount },
        approvedCount,
        pendingCount,
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
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
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
//         message: "dueDate is required. Please use format MM-YYYY (e.g., 07-2026)",
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

//     // ✅ approvedCount = sites where Owner has approved (top-level rentalStatus === 3)
//     const approvedCount = await Media.countDocuments({
//       status: 1,
//       rentalStatus: 3,
//     });

//     // ✅ pendingCount = totalSites minus approved minus overdue (this month)
//     const pendingCount = Math.max(totalSites - approvedCount - overDueSiteCount, 0);

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
//           rentalStatus: 1,
//           totalSqFt: 1,
//           location: 1,
//           rentalPayment: 1,
//           agreement: 1,
//           agreementDocVerification: 1,
//           rentalDue: 1,
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

//     const enriched = data.map((item) => ({
//       _id: item._id,
//       mediaCode: item.mediaCode,
//       mediaName: item.mediaName,
//       mediaType: item.mediaType,
//       city: item.city,
//       state: item.state,
//       location: item.location,
//       rentalStatus: item.rentalStatus,
//       totalSqFt: item.totalSqFt,
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
//       agreementDocVerified: getAgreementVerificationStatus(item),
//       agreementDocVerificationHistory: item.agreementDocVerification || [],
//       rentalDueEntries: item.rentalDue || [],
//     }));

//     return res.status(200).json({
//       success: true,
//       value: {
//         totalSites,
//         dueThisMonth,
//         dueAmountOpen,
//         overDue: { siteCount: overDueSiteCount },
//         approvedCount,
//         pendingCount,
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