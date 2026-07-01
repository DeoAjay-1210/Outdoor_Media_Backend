// controllers/rentalDue.controller.js
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const path = require("path");
const {
  ROLE,
  ROLE_LABEL,
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
//             step.status = 3; // Skipped
//             step.remarks = "Skipped — owner approved directly";
//           }
//         });
//         entry.approvalStatus = 3;
//         entry.status = 3;
//         entry.currentPendingRole = null;
//         entry.agreementDocVerified = true;
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
//           entry.agreementDocVerified = true; // every step approved = doc verified
//         }
//       }
 
//       entry.updatedBy = userName;
//       entry.updatedAt = nowIST();
 
//       // Push a verification history record for THIS approver's role.
//       // getAgreementVerificationStatus() below reads verifiedByRole, so
//       // Staff approving only flips staff:true — not teamLead/owner.
//       media.agreementDocVerification.push({
//         isVerified: true,
//         verifiedBy: userName,
//         verifiedByRole: userType,
//         verifiedAt: nowIST(),
//         rentalDueId: entry._id,
//         agreementPDF: media.agreement?.agreementPDF || {},
//         updatedAt: nowIST(),
//         updatedBy: userName,
//       });
 
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
//           agreementDocVerified: entry.agreementDocVerified,
//           agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//         },
//       });
//     }
 
//     // ═══════════════════════════════════════
//     // BRANCH 2: no pending entry → CREATE.
//     // Staff, Team Lead, or Owner may all start a new entry:
//     //  • Staff creates      → nothing auto-approved, waits on Team Lead.
//     //  • Team Lead creates  → Team Lead's own step is auto-approved
//     //                         (Team Lead can skip Staff entirely), waits
//     //                         on Owner.
//     //  • Owner creates      → everything auto-approved/skipped, done.
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
 
//     // Flow 2 = TeamLead → Owner. Staff is intentionally excluded from the
//     // approval chain — Staff can only create the entry, never approve.
//     // A Staff row is still included in approvalSteps for display purposes
//     // (so the UI can show Staff/TeamLead/Owner together), but it never
//     // participates in the actual chain/turn logic — only role 2 (TeamLead)
//     // and role 3 (Owner) drive currentPendingRole via FLOW_CHAIN[2].
//     const chainSteps = buildApprovalSteps(2); // [TeamLead, Owner]
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
//       // Staff was skipped entirely — Team Lead created directly.
//       staffStep.status = 3;
//       staffStep.remarks = "Skipped — created directly by Team Lead";
 
//       // Team Lead is chain[0] for flow 2 — auto-approve their own step
//       // since they're both creating AND the first required approver.
//       const teamLeadStep = steps.find((s) => s.role === ROLE.TEAM_LEAD);
//       teamLeadStep.status = 2;
//       teamLeadStep.userId = userId;
//       teamLeadStep.userName = userName;
//       teamLeadStep.approvedAt = nowIST();
//       teamLeadStep.docVerified = true;
//       teamLeadStep.remarks = "Created and approved by Team Lead";
//     } else {
//       // Staff is creating — record it on the Staff row (informational,
//       // not a real "approval"), then the entry waits on Team Lead.
//       staffStep.status = 2;
//       staffStep.userId = userId;
//       staffStep.userName = userName;
//       staffStep.approvedAt = nowIST();
//       staffStep.docVerified = false;
//       staffStep.remarks = "Entry created by Staff";
//     }
 
//     // Only role 2 (TeamLead) / role 3 (Owner) can ever be "pending" — the
//     // Staff row is always resolved to Approved(2) or Skipped(3) above.
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
//       // Staff creating does NOT count as an approval → stays Pending(1).
//       // Team Lead creating counts as their approval → PartiallyApproved(2).
//       // Owner creating directly → fully Approved(3).
//       approvalStatus: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
//       currentPendingRole: nextPendingStep ? nextPendingStep.role : null,
//       agreementDocVerified: allApproved,
//       status: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
//       updatedBy: userName,
//       updatedAt: nowIST(),
//     };
 
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
 
//     // Push a verification record whenever this create call ALSO counted as
//     // an approval (Owner override, or Team Lead creating-and-approving).
//     // Plain Staff creation is not an approval, so no record is pushed then.
//     // if (isOwnerOverride || isTeamLeadCreating) {
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
//         agreementDocVerified: newEntry.agreementDocVerified,
//         agreementDocVerificationStatus: getAgreementVerificationStatus(media),
//       },
//     });
//   } catch (err) {
//     console.error("saveRentalDue error:", err);
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
 
    // Helper to check if duplicate verification exists
    const isAlreadyVerified = (rentalDueId, role) => {
      return media.agreementDocVerification.some(
        (v) => 
          String(v.rentalDueId) === String(rentalDueId) && 
          v.verifiedByRole === role
      );
    };
 
    // Most recently created entry that hasn't been fully approved yet
    const pendingEntry = [...media.rentalDue]
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
 
      let wasAgreementVerified = false;
      
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
        wasAgreementVerified = true;
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
          wasAgreementVerified = true;
        }
      }
 
      entry.updatedBy = userName;
      entry.updatedAt = nowIST();
 
      // ✅ Only push if agreement is verified AND no duplicate exists
      // if (wasAgreementVerified && !isAlreadyVerified(entry._id, userType)) {
      //   media.agreementDocVerification.push({
      //     isVerified: true,
      //     verifiedBy: userName,
      //     verifiedByRole: userType,
      //     verifiedAt: nowIST(),
      //     rentalDueId: entry._id,
      //     agreementPDF: media.agreement?.agreementPDF || {},
      //     updatedAt: nowIST(),
      //     updatedBy: userName,
      //   });
      // }
 
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
          agreementDocVerified: entry.agreementDocVerified,
          agreementDocVerificationStatus: getAgreementVerificationStatus(media),
        },
      });
    }
 
    // ═══════════════════════════════════════
    // BRANCH 2: no pending entry → CREATE.
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
    let wasAgreementVerified = false;
 
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
      wasAgreementVerified = true;
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
      wasAgreementVerified = false;
    } else {
      staffStep.status = 2;
      staffStep.userId = userId;
      staffStep.userName = userName;
      staffStep.approvedAt = nowIST();
      staffStep.docVerified = false;
      staffStep.remarks = "Entry created by Staff";
      wasAgreementVerified = false;
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
 
    media.rentalDue.push(newEntry);
    const savedEntry = media.rentalDue[media.rentalDue.length - 1];
 
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
 
    // ✅ Only push if agreement is verified AND no duplicate exists
    // if (wasAgreementVerified && !isAlreadyVerified(savedEntry._id, userType)) {
    //   media.agreementDocVerification.push({
    //     isVerified: true,
    //     verifiedBy: userName,
    //     verifiedByRole: userType,
    //     verifiedAt: nowIST(),
    //     rentalDueId: savedEntry._id,
    //     agreementPDF: media.agreement?.agreementPDF || {},
    //     updatedAt: nowIST(),
    //     updatedBy: userName,
    //   });
    // }
 
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
        agreementDocVerified: newEntry.agreementDocVerified,
        agreementDocVerificationStatus: getAgreementVerificationStatus(media),
      },
    });
  } catch (err) {
    console.error("saveRentalDue error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
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
 
    // Whether a given role already has a verification record against the
    // CURRENT agreement PDF — if the PDF was re-uploaded, old records no
    // longer count, so verification can happen again in order.
    const isVerifiedByRole = (role) =>
      media.agreementDocVerification.some((h) => {
        if (h.verifiedByRole !== role || !h.isVerified) return false;
        const verifiedFile = h.agreementPDF?.fileName;
        if (currentFile && verifiedFile) return currentFile === verifiedFile;
        return true;
      });
 
    // ── Staff can verify first, but once Team Lead has verified, Staff's
    //    window is closed — they can no longer verify after that. ──
    if (userType === ROLE.STAFF && isVerifiedByRole(ROLE.TEAM_LEAD)) {
      return res.status(403).json({
        success: false,
        message: "Staff cannot verify after Team Lead has already verified",
      });
    }
 
    // ── Owner can only verify AFTER Team Lead has verified ──
    if (userType === ROLE.OWNER && !isVerifiedByRole(ROLE.TEAM_LEAD)) {
      return res.status(403).json({
        success: false,
        message: "Team Lead must verify the agreement document before Owner",
      });
    }
 
    // ── Block duplicate verification by the same role ──
    if (isVerifiedByRole(userType)) {
      return res.status(400).json({
        success: false,
        message: `${ROLE_LABEL[userType]} has already verified this agreement document`,
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

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;
    const skip = (pageNumbers - 1) * pageSize;

    let dateFilter, monthStart, monthEnd;

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
      dateFilter = { $gte: monthStart, $lte: monthEnd };
    } else {
      const now = new Date();
      monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      dateFilter = { $gte: monthStart, $lte: monthEnd };
    }

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

    const approvedCountAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $unwind: "$rentalDue" },
      { $match: { "rentalDue.status": 3 } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);
    const approvedCount = approvedCountAgg[0]?.count || 0;

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
