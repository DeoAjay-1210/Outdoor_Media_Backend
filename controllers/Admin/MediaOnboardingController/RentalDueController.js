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
      // Self-heal old documents: if they still have data sitting under the
      // old field name `rentalDue`, migrate it over on first touch instead
      // of dropping it. New/blank docs just get an empty array.
      media.rentalDueEntries = Array.isArray(media.rentalDue)
        ? media.rentalDue
        : [];
    }
    if (!Array.isArray(media.rentalDueHistory)) {
      media.rentalDueHistory = [];
    }
 
    // Most recently created entry that hasn't been fully approved yet.
    // Because a closed cycle always ends at approvalStatus === 3, this
    // correctly returns nothing once the current cycle is fully approved,
    // which is what lets BRANCH 2 create a fresh entry for the new month.
    const pendingEntry = [...media.rentalDueEntries]
      .reverse()
      .find((e) => e.approvalStatus !== 3);
 
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
 
        // log + close out the cycle (this also resets the live flags)
        markRoleVerified(media, entry, ROLE.OWNER, userName);
        advanceRentalPaymentOnOwnerApproval(media);
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
 
        // ✅ live flag + history for THIS role, every time — not just on
        // final approval. This is what was missing before.
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
 
          // Chain completed and the final approver was the Owner —
          // close out the cycle (rolls billing date + resets live flags)
          if (userType === ROLE.OWNER) {
            advanceRentalPaymentOnOwnerApproval(media);
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
          agreementDocVerified: media.agreementDocVerified, // live, current-cycle flags
          agreementDocVerificationHistory: media.agreementDocVerificationHistory,
          agreementDocVerificationStatus: getAgreementVerificationStatus(media),
          rentalPayment: media.rentalPayment, // ✅ so frontend sees updated dates
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
 
    let proofOfCampaign = null;
    if (req.file) {
      if (!req.file.mimetype?.startsWith("image/")) {
        return res.status(400).json({
          success: false,
          message: "Proof of campaign must be an image file",
        });
      }
      proofOfCampaign = {
        originalName: req.file.originalname,
        fileName: req.file.filename,
        filePath: req.file.path,
        mimeType: req.file.mimetype,
        size: req.file.size,
        fileType: "image",
        uploadedAt: nowIST(),
      };
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
 
    // ✅ live flags + history for whichever role(s) just approved on creation
    if (isOwnerOverride) {
      markRoleVerified(media, savedEntry, ROLE.OWNER, userName);
    } else if (isTeamLeadCreating) {
      markRoleVerified(media, savedEntry, ROLE.TEAM_LEAD, userName);
    }
    // plain Staff creation leaves all flags false — correct, nobody has
    // verified anything yet.
 
    // Owner created AND fully approved it directly — roll billing date
    // forward and reset the live flags for the cycle after this one.
    if (isOwnerOverride) {
      advanceRentalPaymentOnOwnerApproval(media);
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
        agreementDocVerified: media.agreementDocVerified, // live, current-cycle flags
        agreementDocVerificationHistory: media.agreementDocVerificationHistory,
        agreementDocVerificationStatus: getAgreementVerificationStatus(media),
        rentalPayment: media.rentalPayment, // ✅ so frontend sees updated dates
      },
    });
  } catch (err) {
    console.error("saveRentalDue error:", err);
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

    const media = await Media.findById(mediaId);
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

    const currentFile = media.agreement?.agreementPDF?.fileName;

    // Does a verification record for `role` exist against the CURRENT
    // agreement PDF? (If the PDF was re-uploaded, old records no longer
    // count — verification can happen again in order.)
    const isVerifiedByRole = (role) =>
      media.agreementDocVerification.some((h) => {
        if (h.verifiedByRole !== role || !h.isVerified) return false;
        const verifiedFile = h.agreementPDF?.fileName;
        if (currentFile && verifiedFile) return currentFile === verifiedFile;
        return true;
      });

    // Has any role RANKED HIGHER than `userType` already verified the
    // current PDF? If so, lower ranks are permanently locked out for
    // this PDF — regardless of whether the normal order was followed.
    // e.g. Team Lead verifies directly -> Staff is locked.
    //      Owner verifies directly     -> Staff AND Team Lead are locked.
    const getBlockingHigherRole = () => {
      const userRank = ROLE_RANK[userType];
      let blocker = null;

      for (const h of media.agreementDocVerification) {
        if (!h.isVerified) continue;
        const role = h.verifiedByRole;
        const rank = ROLE_RANK[role];
        if (rank == null || rank <= userRank) continue;

        const verifiedFile = h.agreementPDF?.fileName;
        const matchesCurrentFile =
          currentFile && verifiedFile ? currentFile === verifiedFile : true;
        if (!matchesCurrentFile) continue;

        if (!blocker || rank > ROLE_RANK[blocker]) blocker = role;
      }

      return blocker;
    };

    // ── Block duplicate verification by the same role ──
    if (isVerifiedByRole(userType)) {
      return res.status(400).json({
        success: false,
        message: `${ROLE_LABEL[userType]} has already verified this agreement document`,
      });
    }

    // ── Block if a higher-ranked role has already verified ──
    const blockingRole = getBlockingHigherRole();
    if (blockingRole) {
      return res.status(403).json({
        success: false,
        message: `${ROLE_LABEL[userType]} cannot verify after ${ROLE_LABEL[blockingRole]} has already verified`,
      });
    }

    const verificationRecord = {
      isVerified: true,
      verifiedBy: userName,
      verifiedByRole: userType,
      verifiedAt: nowIST(),
      rentalDueId: null,
      agreementPDF: media.agreement?.agreementPDF || {},
      updatedAt: nowIST(),
      updatedBy: userName,
    };

    media.agreementDocVerification.push(verificationRecord);
    media.updatedBy = userName;
    media.updatedAt = nowIST();

    await media.save();

    return res.status(200).json({
      success: true,
      message: `${ROLE_LABEL[userType]} verified the agreement document successfully`,
      data: {
        verificationRecord,
        agreementDocVerificationStatus: getAgreementVerificationStatus(media),
      },
    });
  } catch (err) {
    console.error("verifyAgreementDoc error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

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
      agreementDocVerified: getAgreementVerificationStatus(item),
      agreementDocVerificationHistory: item.agreementDocVerification || [],
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
    console.error("getRentalDueListWithStats error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};