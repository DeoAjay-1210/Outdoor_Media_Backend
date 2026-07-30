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
const { successResponse, errorResponse } = require("../../../utils/response");
const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

// ═════════════════════════════════════════════════════════════
// UNCHANGED HELPERS — copied verbatim from the existing file
// ═════════════════════════════════════════════════════════════

const buildApprovalSteps = (approvalFlow) => {
  const chain = FLOW_CHAIN[approvalFlow] || FLOW_CHAIN[1];
  return chain.map((role) => ({
    role,
    userId: null,
    userName: "",
    approvedAt: null,
    status: 1,
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

const getCurrentCycle = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatDate = (date) => {
  if (!date) return "";
  let d;
  if (typeof date === "string" && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = date.split("-");
    d = new Date(year, month - 1, day);
  } else {
    d = new Date(date);
  }
  const options = { year: "numeric", month: "long", day: "numeric" };
  return d.toLocaleDateString("en-US", options);
};

function advanceRentalPaymentOnOwnerApproval(media) {
  const currentNextBillingDate = media.rentalPayment?.nextBillingDate;
  const frequency = media.rentalPayment?.paymentFrequency;

  const frequencyMap = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
  const monthsToAdd =
    frequency === 6
      ? Number(media.rentalPayment?.customPaymentFrequency) || 1
      : frequencyMap[frequency] || 1;

  const baseDate = currentNextBillingDate
    ? new Date(currentNextBillingDate)
    : new Date();

  media.rentalPayment.lastBillPaidDate = baseDate;
  media.rentalPayment.nextBillingDate = addMonths(baseDate, monthsToAdd);

  resetLiveAgreementFlags(media);
}

function computeGstSplit(media, withGst) {
  const totalRentalAmount = media.rentalPayment?.netPayable || 0;
  const gstAmountFull = media.rentalPayment?.gstAmount || 0;
  const totalWithGst =
    media.rentalPayment?.totalRentalAmountWithGst ||
    totalRentalAmount + gstAmountFull;

  if (withGst === 1) {
    return {
      baseAmount: totalRentalAmount,
      gstAmount: gstAmountFull,
      netPayable: totalRentalAmount,
    };
  }

  return {
    baseAmount: totalWithGst,
    gstAmount: 0,
    netPayable: totalWithGst,
  };
}

// async function sendRentalDueApprovalMail(media, entry) {
//   try {
//     const toMail = process.env.T0_EMail;
//     const ccMail = process.env.CC_EMail;
//     const mailMode = process.env.MAIL_MODE || "development";
//     const formatDMY = (date) =>
//       date
//         ? new Date(date).toLocaleDateString("en-GB").replace(/\//g, "-")
//         : null;

//     const rp = media.rentalPayment || {};
//     const appraisal = media.appraisal || {};
//     const agreement = media.agreement || {};

//     const gstHoldValue = Number(entry?.withGst) === 1 ? 1 : 0;

//     const landOwnersPayload = (media.landOwners || []).map((owner) => ({
//       name: owner.name || "",
//       phone: owner.phone || "",
//       bankName: owner.bankName || "",
//       ifsc: owner.ifsc || "",
//       accountNumber: owner.accountNumber || "",
//       panNumber: owner.panNumber || "",
//       paymentCategory: owner.paymentCategory || 0,
//       typeShare: owner.typeShare || 0,
//       shareAmount: owner.shareAmount || 0,
//       onlineMode: owner.onlineMode || 0,
//       onlineAmount: owner.onlineAmount || 0,
//       cashAmount: owner.cashAmount || 0,
//       gstApplicable: owner.gstApplicable || 0,
//       gstPercentage: owner.gstPercentage || 0,
//       gstAmount: owner.gstAmount || 0,
//       tdsApplicable: owner.tdsApplicable || 0,
//       tdsPercentage: owner.tdsPercentage || 0,
//       tdsAmount: owner.tdsAmount || 0,
//       totalAmountWithGst: owner.totalAmountWithGst || 0,
//       tdsHold: 0,
//       gstHold: gstHoldValue,
//     }));

//     let previousRentValue = 0;
//     if (appraisal.lastAppraisalDate && Array.isArray(appraisal.history)) {
//       const lastAppraisalKey = new Date(appraisal.lastAppraisalDate).getTime();
//       const matchingEntry = appraisal.history.find(
//         (h) =>
//           h.appraisalDate &&
//           new Date(h.appraisalDate).getTime() === lastAppraisalKey,
//       );
//       previousRentValue = Number(matchingEntry?.previousRent || 0);
//     }

//     let appraisalPayload = {};
//     if (appraisal.lastAppraisalDate) {
//       const lastAppraisalDate = new Date(appraisal.lastAppraisalDate);
//       const today = new Date();
//       const isCurrentMonth =
//         lastAppraisalDate.getUTCFullYear() === today.getUTCFullYear() &&
//         lastAppraisalDate.getUTCMonth() === today.getUTCMonth();

//       if (isCurrentMonth) {
//         appraisalPayload = {
//           applicable: appraisal.applicable || 0,
//           type: appraisal.type || 0,
//           percentage: appraisal.percentage || 0,
//           fixedAmount: appraisal.fixedAmount || 0,
//           frequency: appraisal.frequency || 0,
//           currentRent: previousRentValue,
//           appraisalAmount: appraisal.appraisalAmount || 0,
//           totalAppraisalAmount: appraisal.totalAppraisalAmount || 0,
//           lastAppraisalDate: formatDMY(appraisal.lastAppraisalDate),
//           nextAppraisalDate: formatDMY(appraisal.nextAppraisalDate),
//         };
//       }
//     }
//     const proofOfCampaignPayload = entry?.proofOfCampaign?.filePath
//       ? [entry.proofOfCampaign.filePath]
//       : [];
//     const mailPayload = {
//       mailtype: "cmdapproval",
//       to: [toMail],
//       data: {
//         _id: media._id,
//         mediaCode: media.mediaCode || "",
//         mediaName: media.mediaName || "",
//         mediaType: media.mediaType || "",
//         state: media.state || "",
//         city: media.city || "",
//         location: media.location || "",
//         width: media.width || 0,
//         height: media.height || 0,
//         status: media.status || 0,
//         totalSqFt: media.totalSqFt || 0,
//         numberOfLandOwners: media.numberOfLandOwners || 0,
//         proof_of_campaign: proofOfCampaignPayload,
//         rentalPayment: {
//           totalRentalAmount: rp.totalRentalAmount || 0,
//           gstApplicable: rp.gstApplicable || 0,
//           gstNumber: rp.gstNumber || "",
//           gstPercentage: rp.gstPercentage || 0,
//           gstAmount: rp.gstAmount || 0,
//           totalRentalAmountWithGst: rp.totalRentalAmountWithGst || 0,
//           netPayable: rp.netPayable || 0,
//           paymentFrequency: rp.paymentFrequency || 0,
//           customPaymentFrequency: rp.rentalPayment || 0,
//           lastBillPaidDate: formatDMY(rp.lastBillPaidDate),
//           nextBillingDate: formatDMY(rp.nextBillingDate),
//           balanceGstAmount: rp.balanceGstAmount || 0,
//           status: rp.status || 0,
//         },
//         appraisal: appraisalPayload,
//         agreement: {
//           startDate: formatDMY(agreement.startDate),
//           endDate: formatDMY(agreement.endDate),
//           reminderBeforeExpiry: agreement.reminderBeforeExpiry || 0,
//           advanceRent: agreement.advanceRent || 0,
//           status: agreement.status || 0,
//         },
//         landOwners: landOwnersPayload,
//       },
//     };

//     console.log(
//       "📧 RENTAL DUE MAIL PAYLOAD:",
//       JSON.stringify(mailPayload, null, 2),
//     );
//     if (mailMode !== "production") {
//       console.log(
//         `📭 MAIL_MODE="${mailMode}" — skipping live mail API call. Payload logged above only.`,
//       );
//       return {
//         mailtype: "cmdapproval",
//         to: [toMail],
//         cc: [ccMail],
//         success: true,
//         sent: false,
//         statusCode: 200,
//         message: `Mail skipped (MAIL_MODE=${mailMode}) — not sent`,
//         data: mailPayload.data,
//       };
//     }
//     const response = await axios.post(
//       "https://adinndigital.com/api/outdoormedia/cmdApprovalSK.php",
//       mailPayload,
//       { headers: { "Content-Type": "application/json" } },
//     );

//     const isMailSuccess =
//       response.data &&
//       (response.data.success === true ||
//         response.data.status === "success" ||
//         response.status === 200);

//     return {
//       mailtype: "cmdapproval",
//       to: [toMail],
//       cc: [ccMail],
//       success: !!isMailSuccess,
//       sent: !!isMailSuccess,
//       statusCode: response.status || (isMailSuccess ? 200 : 500),
//       message: isMailSuccess
//         ? "Rental due approval mail sent successfully"
//         : "Rental due approval mail failed",
//       data: mailPayload.data,
//     };
//   } catch (mailErr) {
//     console.error(
//       "❌ Rental due approval mail error:",
//       mailErr?.message || mailErr,
//     );
//     return {
//       mailtype: "cmdapproval",
//       to: [process.env.T0_EMail],
//       cc: [process.env.CC_EMail],
//       success: false,
//       sent: false,
//       statusCode: 500,
//       message: mailErr?.message || "Unknown mail error",
//       data: null,
//     };
//   }
// }
// ─────────────────────────────────────────────────────────────
// Helper — same "only include appraisal if lastAppraisalDate falls
// in the CURRENT calendar month" rule the current site already uses,
// extracted so it can be reused for both the current site AND every
// linked site.
// ─────────────────────────────────────────────────────────────
function buildAppraisalPayloadIfDueThisMonth(appraisal, formatDMY) {
  if (!appraisal || !appraisal.lastAppraisalDate) return {};

  let previousRentValue = 0;
  if (Array.isArray(appraisal.history)) {
    const lastAppraisalKey = new Date(appraisal.lastAppraisalDate).getTime();
    const matchingEntry = appraisal.history.find(
      (h) =>
        h.appraisalDate &&
        new Date(h.appraisalDate).getTime() === lastAppraisalKey,
    );
    previousRentValue = Number(matchingEntry?.previousRent || 0);
  }

  const lastAppraisalDate = new Date(appraisal.lastAppraisalDate);
  const today = new Date();
  const isCurrentMonth =
    lastAppraisalDate.getUTCFullYear() === today.getUTCFullYear() &&
    lastAppraisalDate.getUTCMonth() === today.getUTCMonth();

  if (!isCurrentMonth) return {};

  return {
    applicable: appraisal.applicable || 0,
    type: appraisal.type || 0,
    percentage: appraisal.percentage || 0,
    fixedAmount: appraisal.fixedAmount || 0,
    frequency: appraisal.frequency || 0,
    currentRent: previousRentValue,
    appraisalAmount: appraisal.appraisalAmount || 0,
    totalAppraisalAmount: appraisal.totalAppraisalAmount || 0,
    lastAppraisalDate: formatDMY(appraisal.lastAppraisalDate),
    nextAppraisalDate: formatDMY(appraisal.nextAppraisalDate),
  };
}

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

    const gstHoldValue = Number(entry?.withGst) === 1 ? 1 : 0;

    // ✅ NEW — collect every OTHER site referenced across all owners on
    // this Media (landOwners[].linkedSites[].mediaId), one DB call for
    // all of them combined, so we don't run N queries for N owners.
    const allLinkedMediaIds = new Set();
    (media.landOwners || []).forEach((owner) => {
      (owner.linkedSites || []).forEach((site) => {
        if (site.mediaId) allLinkedMediaIds.add(String(site.mediaId));
      });
    });

    let linkedMediaDocsById = {};
    if (allLinkedMediaIds.size > 0) {
      const linkedMediaDocs = await MediaOnboarding.find(
        { _id: { $in: Array.from(allLinkedMediaIds) } },
        "mediaCode mediaName rentalPayment agreement appraisal",
      ).lean();

      linkedMediaDocs.forEach((doc) => {
        linkedMediaDocsById[String(doc._id)] = doc;
      });
    }

    const landOwnersPayload = (media.landOwners || []).map((owner) => {
      // ✅ NEW — build linkedSites for THIS owner, merging the
      // lightweight snapshot already stored on owner.linkedSites
      // (paymentCategory/shareAmount/cashAmount/onlineAmount) with the
      // FULL rentalPayment/agreement/appraisal fetched above for each
      // linked site.
      const linkedSitesPayload = (owner.linkedSites || []).map((site) => {
        const fullSite = linkedMediaDocsById[String(site.mediaId)];

        return {
          mediaId: site.mediaId,
          mediaCode: site.mediaCode || fullSite?.mediaCode || "",
          mediaName: site.mediaName || fullSite?.mediaName || "",
          paymentCategory: site.paymentCategory || 0,
          shareAmount: site.shareAmount || 0,
          cashAmount: site.cashAmount || 0,
          onlineAmount: site.onlineAmount || 0,
          rentalPayment: {
            totalRentalAmount: fullSite?.rentalPayment?.totalRentalAmount || 0,
            gstApplicable: fullSite?.rentalPayment?.gstApplicable || 0,
            gstAmount: fullSite?.rentalPayment?.gstAmount || 0,
            netPayable: fullSite?.rentalPayment?.netPayable || 0,
            paymentFrequency: fullSite?.rentalPayment?.paymentFrequency || 0,
            lastBillPaidDate: formatDMY(
              fullSite?.rentalPayment?.lastBillPaidDate,
            ),
            nextBillingDate: formatDMY(
              fullSite?.rentalPayment?.nextBillingDate,
            ),
            balanceGstAmount: fullSite?.rentalPayment?.balanceGstAmount || 0,
            status: fullSite?.rentalPayment?.status || 0,
          },
          agreement: {
            startDate: formatDMY(fullSite?.agreement?.startDate),
            endDate: formatDMY(fullSite?.agreement?.endDate),
            reminderBeforeExpiry:
              fullSite?.agreement?.reminderBeforeExpiry || 0,
            advanceRent: fullSite?.agreement?.advanceRent || 0,
            status: fullSite?.agreement?.status || 0,
          },
          // ✅ same "due this month" rule as the current site's own appraisal
          appraisal: buildAppraisalPayloadIfDueThisMonth(
            fullSite?.appraisal,
            formatDMY,
          ),
        };
      });

      return {
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
        tdsApplicable: owner.tdsApplicable || 0,
        tdsPercentage: owner.tdsPercentage || 0,
        tdsAmount: owner.tdsAmount || 0,
        totalAmountWithGst: owner.totalAmountWithGst || 0,
        tdsHold: 0,
        gstHold: gstHoldValue,

        // ✅ NEW — site-linkage info for this owner
        totalSites: linkedSitesPayload.length + 1, // +1 for THIS current site
        linkedSites: linkedSitesPayload,
      };
    });

    let previousRentValue = 0;
    if (appraisal.lastAppraisalDate && Array.isArray(appraisal.history)) {
      const lastAppraisalKey = new Date(appraisal.lastAppraisalDate).getTime();
      const matchingEntry = appraisal.history.find(
        (h) =>
          h.appraisalDate &&
          new Date(h.appraisalDate).getTime() === lastAppraisalKey,
      );
      previousRentValue = Number(matchingEntry?.previousRent || 0);
    }

    let appraisalPayload = {};
    if (appraisal.lastAppraisalDate) {
      const lastAppraisalDate = new Date(appraisal.lastAppraisalDate);
      const today = new Date();
      const isCurrentMonth =
        lastAppraisalDate.getUTCFullYear() === today.getUTCFullYear() &&
        lastAppraisalDate.getUTCMonth() === today.getUTCMonth();

      if (isCurrentMonth) {
        appraisalPayload = {
          applicable: appraisal.applicable || 0,
          type: appraisal.type || 0,
          percentage: appraisal.percentage || 0,
          fixedAmount: appraisal.fixedAmount || 0,
          frequency: appraisal.frequency || 0,
          currentRent: previousRentValue,
          appraisalAmount: appraisal.appraisalAmount || 0,
          totalAppraisalAmount: appraisal.totalAppraisalAmount || 0,
          lastAppraisalDate: formatDMY(appraisal.lastAppraisalDate),
          nextAppraisalDate: formatDMY(appraisal.nextAppraisalDate),
        };
      }
    }

    const proofOfCampaignPayload = entry?.proofOfCampaign?.filePath
      ? [entry.proofOfCampaign.filePath]
      : [];

    const mailPayload = {
      mailtype: "cmdapproval",
      to: [toMail],
      data: {
        _id: media._id,
        mediaCode: media.mediaCode || "",
        mediaName: media.mediaName || "",
        mediaType: media.mediaType || "",
        state: media.state || "",
        city: media.city || "",
        location: media.location || "",
        width: media.width || 0,
        height: media.height || 0,
        status: media.status || 0,
        totalSqFt: media.totalSqFt || 0,
        numberOfLandOwners: media.numberOfLandOwners || 0,
        proof_of_campaign: proofOfCampaignPayload,
        rentalPayment: {
          totalRentalAmount: rp.totalRentalAmount || 0,
          gstApplicable: rp.gstApplicable || 0,
          gstNumber: rp.gstNumber || "",
          gstPercentage: rp.gstPercentage || 0,
          gstAmount: rp.gstAmount || 0,
          totalRentalAmountWithGst: rp.totalRentalAmountWithGst || 0,
          netPayable: rp.netPayable || 0,
          paymentFrequency: rp.paymentFrequency || 0,
          customPaymentFrequency: rp.rentalPayment || 0,
          lastBillPaidDate: formatDMY(rp.lastBillPaidDate),
          nextBillingDate: formatDMY(rp.nextBillingDate),
          balanceGstAmount: rp.balanceGstAmount || 0,
          status: rp.status || 0,
        },
        appraisal: appraisalPayload,
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

    console.log(
      "📧 RENTAL DUE MAIL PAYLOAD:",
      JSON.stringify(mailPayload, null, 2),
    );
    if (mailMode !== "production") {
      console.log(
        `📭 MAIL_MODE="${mailMode}" — skipping live mail API call. Payload logged above only.`,
      );
      return {
        mailtype: "cmdapproval",
        to: [toMail],
        cc: [ccMail],
        success: true,
        sent: false,
        statusCode: 200,
        message: `Mail skipped (MAIL_MODE=${mailMode}) — not sent`,
        data: mailPayload.data,
      };
    }
    const response = await axios.post(
      "https://adinndigital.com/api/outdoormedia/cmdApprovalSK.php",
      mailPayload,
      { headers: { "Content-Type": "application/json" } },
    );

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
      sent: !!isMailSuccess,
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
      sent: false,
      statusCode: 500,
      message: mailErr?.message || "Unknown mail error",
      data: null,
    };
  }
}
function addGstToBalanceIfApplicable(media, entry, userName) {
  if (entry.gstAddedToBalance) return;

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
      source: "rental",
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
  if (entry.withGst !== 1) return;
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
        source: "owner",
        ownerId: owner._id,
        ownerName: owner.name,
      });
      anyAdded = true;
    }
  });

  if (anyAdded) {
    media.markModified("gstBalanceHistory");
    entry.ownerGstAddedToBalance = true;
    recomputeBalanceGstAmount(media);
  }
}

function recomputeBalanceGstAmount(media) {
  const unpaidTotal = (media.gstBalanceHistory || []).reduce((sum, g) => {
    if (g.isPaid) return sum;
    const remaining = (g.gstAmount || 0) - (g.paidAmount || 0);
    return sum + Math.max(remaining, 0);
  }, 0);

  media.rentalPayment.balanceGstAmount = unpaidTotal;
  media.markModified("rentalPayment");
}

function syncGstBalanceOnWithGstChange(media, entry, newWithGst, userName) {
  if (!Array.isArray(media.gstBalanceHistory)) {
    media.gstBalanceHistory = [];
  }

  const existingRecord = media.gstBalanceHistory.find(
    (g) => String(g.rentalDueId) === String(entry._id),
  );

  if (newWithGst === 2) {
    if (existingRecord && !existingRecord.isPaid) {
      media.gstBalanceHistory = media.gstBalanceHistory.filter(
        (g) => String(g._id) !== String(existingRecord._id),
      );
      media.markModified("gstBalanceHistory");
    }
    entry.gstAddedToBalance = false;
  } else if (newWithGst === 1) {
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
      existingRecord.gstAmount = entry.gstAmount;
      media.markModified("gstBalanceHistory");
    }
  }

  recomputeBalanceGstAmount(media);
}

function applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag) {
  if (userType !== ROLE.OWNER) return;
  if (![0, 1, 2].includes(Number(gstApplicableFlag))) return;
  media.gstApplicableFlag = Number(gstApplicableFlag);
}

const resolveGstApplicable = (item) => {
  const flag = Number(item.gstApplicableFlag) || 0;

  if (flag === 0) {
    return {
      gstApplicableFlag: 0,
      source: null,
      gstApplicable: 0,
      message:
        "GST source not yet determined — Owner has not set gstApplicableFlag",
    };
  }

  if (flag === 1) {
    return {
      gstApplicableFlag: flag,
      source: "rentalPayment",
      gstApplicable: Number(item.rentalPayment?.gstApplicable) || 0,
      gstPercentage: item.rentalPayment?.gstPercentage || 0,
      gstAmount: item.rentalPayment?.gstAmount || 0,
    };
  }

  const gstOwners = (item.landOwners || []).filter(
    (o) => Number(o.gstApplicable) === 1,
  );

  return {
    gstApplicableFlag: flag,
    source: "landOwners",
    gstApplicable: gstOwners.length > 0 ? 1 : 0,
    owners: gstOwners.map((o) => ({
      ownerId: o._id,
      ownerName: o.name,
      gstApplicable: Number(o.gstApplicable) || 0,
      gstPercentage: o.gstPercentage || 0,
      gstAmount: o.gstAmount || 0,
    })),
  };
};

const ROLE_RANK = {
  [ROLE.STAFF]: 1,
  [ROLE.TEAM_LEAD]: 2,
  [ROLE.OWNER]: 3,
};

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

const isSameCycle = (a, b) => {
  if (!a || !b) return false;
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
};

// ── saveRentalDue — one site ───────────────────────────────────
async function processSingleRentalDue({
  mediaId,
  campaignName,
  withGst,
  gstApplicableFlag,
  proofOfCampaign,
  userType,
  userId,
  userName,
}) {
  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

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

  const currentCycleForVerification = getCurrentCycle(
    media.rentalPayment?.nextBillingDate,
  );

  if (!currentCycleForVerification) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "Unable to determine current billing cycle",
    };
  }

  const currentCycleVerificationsForSave =
    media.agreementDocVerification.filter(
      (h) => h.isVerified && isSameCycle(h.cycle, currentCycleForVerification),
    );

  const verifiedRolesThisCycle = new Set(
    currentCycleVerificationsForSave.map((h) => h.verifiedByRole),
  );
  const verifiedCountThisCycle = verifiedRolesThisCycle.size;
  const hasVerifiedThisCycle = verifiedRolesThisCycle.has(userType);
  if (!hasVerifiedThisCycle) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: `${ROLE_LABEL[userType]} must verify the agreement document for the billing cycle starting ${formatDate(currentCycleForVerification)} before saving`,
    };
  }
  if (userType === ROLE.OWNER) {
    const canProceedToSave =
      verifiedCountThisCycle >= 2 || hasVerifiedThisCycle;

    if (!canProceedToSave) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `${ROLE_LABEL[userType]} must verify the agreement document for the billing cycle starting ${formatDate(currentCycleForVerification)} before saving`,
      };
    }
  }

  const pendingEntry = [...media.rentalDueEntries]
    .reverse()
    .find((e) => e.approvalStatus !== 3);

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
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "Owner has already approved this document for the current cycle",
    };
  }

  // ── BRANCH 1: UPDATE / APPROVAL ──
  if (pendingEntry) {
    const entry = pendingEntry;
    const chain = FLOW_CHAIN[entry.approvalFlow] || FLOW_CHAIN[1];
    const isOwnerOverride =
      userType === ROLE.OWNER && entry.currentPendingRole !== ROLE.OWNER;
    const isStaffOrTeamLead =
      userType === ROLE.STAFF || userType === ROLE.TEAM_LEAD;

    if (
      !isOwnerOverride &&
      !isStaffOrTeamLead &&
      userType !== entry.currentPendingRole
    ) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `It's not your turn to approve. Waiting on ${ROLE_LABEL[entry.currentPendingRole] || "N/A"}`,
      };
    }

    if (campaignName) entry.campaignName = campaignName;
    if (proofOfCampaign) entry.proofOfCampaign = proofOfCampaign;

    if ([1, 2].includes(Number(withGst))) {
      const newWithGst = Number(withGst);
      if (entry.withGst !== newWithGst) {
        entry.withGst = newWithGst;
        const recomputedSplit = computeGstSplit(media, newWithGst);
        entry.gstAmount = Number(recomputedSplit.gstAmount) || 0;
        entry.baseAmount = Number(recomputedSplit.baseAmount) || 0;
        entry.netPayable = Number(recomputedSplit.netPayable) || 0;

        if (userType === ROLE.OWNER) {
          syncGstBalanceOnWithGstChange(media, entry, newWithGst, userName);
        }
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
      applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag);
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
    } else {
      const step = entry.approvalSteps.find(
        (s) => s.role === userType && s.status === 1,
      );

      if (step) {
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
            applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag);
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
    }

    entry.updatedBy = userName;
    entry.updatedAt = nowIST();

    const yearLabel = getYearLabel(entry.dueDate);
    const monthLabel = getMonthLabel(entry.dueDate);
    const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    const monthBucket = yearBucket?.months.find((m) => m.month === monthLabel);
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

    let mailSentFlag = entry.mailSent;
    if (userType === ROLE.OWNER && entry.approvalStatus === 3) {
      const mailResult = await sendRentalDueApprovalMail(media, entry);
      entry.mailSent = !!mailResult.sent;
      mailSentFlag = entry.mailSent;
      await media.save();
    }

    return {
      success: true,
      mediaId: media._id,
      mediaName: media.mediaName,
      rentalDueId: entry._id,
      campaignName: entry.campaignName,
      proofOfCampaign: entry.proofOfCampaign,
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
      agreementDocVerificationHistory: media.agreementDocVerificationHistory,
      agreementDocVerificationStatus: getAgreementVerificationStatus(media),
      rentalPayment: media.rentalPayment,
      ledger: media.ledger,
      mailSent: mailSentFlag,
    };
  }

  // ── BRANCH 2: CREATE ──
  if (!campaignName) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "campaignName is required",
    };
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
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message:
          "Owner has already approved this document for the current cycle",
      };
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

  const resolvedWithGst = [0, 1, 2].includes(Number(withGst))
    ? Number(withGst)
    : 0;
  const gstSplit = computeGstSplit(media, resolvedWithGst);

  const newEntry = {
    dueMonth: getDueMonthLabel(dueDateObj),
    dueDate: dueDateObj,
    netPayable: Number(gstSplit.netPayable) || 0,
    paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
    customPaymentFrequency:
      media.rentalPayment?.paymentFrequency === 6
        ? media.rentalPayment?.customPaymentFrequency || 1
        : undefined,
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
    applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag);
    addGstToBalanceIfApplicable(media, savedEntry, userName);
    addOwnerGstToBalanceIfApplicable(media, savedEntry, userName);
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
    netPayable: Number(newEntry.netPayable) || 0,
    approvalStatus: newEntry.approvalStatus,
    savedBy: userName,
    savedByRole: userType,
    updatedAt: nowIST(),
    updatedBy: userName,
  });

  media.updatedBy = userName;
  media.updatedAt = nowIST();
  await media.save();

  let mailSentFlag = savedEntry.mailSent;
  if (isOwnerOverride && savedEntry.approvalStatus === 3) {
    const mailResult = await sendRentalDueApprovalMail(media, savedEntry);
    savedEntry.mailSent = !!mailResult.sent;
    mailSentFlag = savedEntry.mailSent;
    await media.save();
  }

  return {
    success: true,
    isNew: true,
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
    mailSent: mailSentFlag,
  };
}

// ═════════════════════════════════════════════════════════════
// exports.saveRentalDue — backward compatible + new batch mode
// ═════════════════════════════════════════════════════════════
exports.saveRentalDue = async (req, res) => {
  try {
    const { userType, userId, userName } = req.user;
    const { mediaId, campaignName, withGst, gstApplicableFlag, entries } =
      req.body;

    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return errorResponse(res, "Invalid or missing user role", null, 403);
    }

    // ✅ CHANGED — with upload.any(), req.files is now a FLAT ARRAY of
    // { fieldname, ... } objects (not the object-keyed-by-field-name
    // shape upload.fields() produced). Find the single-request file by
    // its exact fieldname.
    const files = req.files || [];

    let proofOfCampaign = null;
    const singleProofFile = files.find(
      (f) => f.fieldname === "proofOfCampaign",
    );
    if (singleProofFile) {
      if (!singleProofFile.mimetype?.startsWith("image/")) {
        return errorResponse(
          res,
          "Proof of campaign must be an image file",
          null,
          400,
        );
      }
      proofOfCampaign = req.processFile(singleProofFile);
    }

    // ── NEW — batch mode: entries: [ { mediaId, campaignName, withGst, gstApplicableFlag }, ... ]
    // ✅ CHANGED — proofOfCampaign is now supported PER ENTRY, matched
    // by indexed fieldname "entries[N][proofOfCampaign]" (same pattern
    // as landOwners[N][panCardImage] elsewhere in this codebase).
    if (Array.isArray(entries) && entries.length > 0) {
      const parseEntryFile = (fieldname) => {
        const match = fieldname.match(/^entries\[(\d+)\]\[proofOfCampaign\]$/);
        return match ? Number(match[1]) : null;
      };

      const entryFileMap = {};
      files.forEach((f) => {
        const idx = parseEntryFile(f.fieldname);
        if (idx !== null) entryFileMap[idx] = f;
      });

      const results = [];
      for (let index = 0; index < entries.length; index++) {
        const item = entries[index];

        let entryProofOfCampaign = null;
        const entryFile = entryFileMap[index];
        if (entryFile) {
          if (!entryFile.mimetype?.startsWith("image/")) {
            results.push({
              success: false,
              mediaId: item.mediaId,
              message: `entries[${index}].proofOfCampaign must be an image file`,
            });
            continue;
          }
          entryProofOfCampaign = req.processFile(entryFile);
        }

        const result = await processSingleRentalDue({
          mediaId:
            typeof item.mediaId === "string"
              ? item.mediaId.trim()
              : item.mediaId,
          campaignName:
            typeof item.campaignName === "string"
              ? item.campaignName.trim()
              : item.campaignName,
          withGst: item.withGst,
          gstApplicableFlag: item.gstApplicableFlag,
          proofOfCampaign: entryProofOfCampaign,
          userType,
          userId,
          userName,
        });
        results.push(result);
      }

      // ── landOwnerSummary — per-owner rollup across every successful entry ──
      const ownerMap = new Map();
      for (const r of results) {
        if (!r.success) continue;
        const media = await Media.findById(
          r.mediaId,
          "landOwners mediaCode mediaName",
        ).lean();
        if (!media || !Array.isArray(media.landOwners)) continue;

        for (const owner of media.landOwners) {
          if (!owner.landOwnerMasterId) continue;
          const key = String(owner.landOwnerMasterId);

          if (!ownerMap.has(key)) {
            ownerMap.set(key, {
              landOwnerMasterId: owner.landOwnerMasterId,
              landOwnerName: owner.name,
              totalSites: 0,
              sites: [],
              totalShareAmount: 0,
              totalGstAmount: 0,
              totalNetPayableToOwner: 0,
            });
          }

          const bucket = ownerMap.get(key);
          bucket.totalSites += 1;
          bucket.sites.push({
            mediaId: media._id,
            mediaCode: media.mediaCode,
            mediaName: media.mediaName,
            shareAmount: owner.shareAmount || 0,
            gstAmount: owner.gstAmount || 0,
            netPayableToOwner: owner.netPayableToOwner || 0,
          });
          bucket.totalShareAmount += owner.shareAmount || 0;
          bucket.totalGstAmount += owner.gstAmount || 0;
          bucket.totalNetPayableToOwner += owner.netPayableToOwner || 0;
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return successResponse(
        res,
        `Rental due processed for ${results.length} site(s)`,
        {
          results,
          landOwnerSummary: Array.from(ownerMap.values()),
          siteSummary: {
            totalSites: results.length,
            successCount,
            failedCount,
            totalBaseAmount: results.reduce(
              (s, r) => s + (r.baseAmount || 0),
              0,
            ),
            totalGstAmount: results.reduce((s, r) => s + (r.gstAmount || 0), 0),
            totalNetPayable: results.reduce(
              (s, r) => s + (r.netPayable || 0),
              0,
            ),
          },
        },
        200,
      );
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    const trimmedMediaId =
      typeof mediaId === "string" ? mediaId.trim() : mediaId;

    if (!trimmedMediaId || !mongoose.Types.ObjectId.isValid(trimmedMediaId)) {
      return errorResponse(res, "A valid mediaId is required", null, 400);
    }

    const result = await processSingleRentalDue({
      mediaId: trimmedMediaId,
      campaignName,
      withGst,
      gstApplicableFlag,
      proofOfCampaign,
      userType,
      userId,
      userName,
    });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return errorResponse(res, result.message, null, statusCode);
    }

    const statusCode = result.isNew ? 201 : 200;
    const message = result.isNew
      ? "Rental due entry saved — waiting on Team Lead approval"
      : "Approval recorded";

    delete result.success;
    delete result.isNew;

    return successResponse(res, message, result, statusCode);
  } catch (err) {
    return errorResponse(res, "Server error", { error: err.message }, 500);
  }
};

// ── verifyAgreementDoc — one site ──────────────────────────────
async function processSingleVerification({ mediaId, userType, userName }) {
  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }

  let media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

  const currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);
  if (!currentCycle) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "Unable to determine current billing cycle",
    };
  }

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

  if (userType === ROLE.STAFF && staffVerified) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: `${ROLE_LABEL[ROLE.STAFF]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
    };
  }
  if (userType === ROLE.TEAM_LEAD && teamLeadVerified) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: `${ROLE_LABEL[ROLE.TEAM_LEAD]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
    };
  }
  if (userType === ROLE.OWNER && ownerVerified) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: `${ROLE_LABEL[ROLE.OWNER]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
    };
  }

  if (highestVerifiedRole) {
    const highestRank = ROLE_RANK[highestVerifiedRole];
    if (highestRank > userRank) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `${ROLE_LABEL[userType]} cannot verify because ${ROLE_LABEL[highestVerifiedRole]} has already verified for this billing cycle`,
      };
    }
  }

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

  const blockingRoles = [ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].filter(
    (role) => role === userType || ROLE_RANK[role] > userRank,
  );

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
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `${ROLE_LABEL[userType]} has already verified for the billing cycle starting ${formatDate(currentCycle)}`,
      };
    }
    if (blocker) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `${ROLE_LABEL[userType]} cannot verify because ${ROLE_LABEL[blocker.verifiedByRole]} has already verified for this billing cycle`,
      };
    }
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message:
        "Verification could not be completed due to a conflicting update. Please try again.",
    };
  }

  media = updatedMedia;

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

  return {
    success: true,
    mediaId: media._id,
    mediaName: media.mediaName,
    message: `${ROLE_LABEL[userType]} verified the agreement document successfully for the billing cycle starting ${formatDate(currentCycle)}`,
    currentCycle: formatDate(currentCycle),
    verificationProgress,
    verificationProgressHistory: media.verificationProgressHistory,
  };
}

// ═════════════════════════════════════════════════════════════
// exports.verifyAgreementDoc — backward compatible + new batch mode
// ═════════════════════════════════════════════════════════════
exports.verifyAgreementDoc = async (req, res) => {
  try {
    const { mediaId, mediaIds } = req.body;
    const { userType, userName } = req.user;

    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return errorResponse(res, "Invalid or missing user role", null, 403);
    }

    // ── NEW — batch mode: mediaIds: [id1, id2, id3] ──
    if (Array.isArray(mediaIds) && mediaIds.length > 0) {
      const results = [];
      for (const id of mediaIds) {
        const result = await processSingleVerification({
          mediaId: id,
          userType,
          userName,
        });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return successResponse(
        res,
        `Processed verification for ${results.length} site(s)`,
        { results, totalSites: results.length, successCount, failedCount },
        200,
      );
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "A valid mediaId is required", null, 400);
    }

    const result = await processSingleVerification({
      mediaId,
      userType,
      userName,
    });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return errorResponse(res, result.message, null, statusCode);
    }

    return successResponse(
      res,
      result.message,
      {
        verificationRecord: undefined, // kept for shape parity — original returned this too
        currentCycle: result.currentCycle,
        verificationProgress: result.verificationProgress,
        verificationProgressHistory: result.verificationProgressHistory,
      },
      200,
    );
  } catch (err) {
    return errorResponse(res, "Server error", { error: err.message }, 500);
  }
};

// ── GstAmountPaid — one site ────────────────────────────────────
async function processSingleGstPayment({ mediaId, gstCycleIds, userName }) {
  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }
  if (!Array.isArray(gstCycleIds) || gstCycleIds.length === 0) {
    return {
      success: false,
      mediaId,
      message:
        "gstCycleIds must be a non-empty array of GST balance record IDs",
    };
  }
  for (const id of gstCycleIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { success: false, mediaId, message: `Invalid gstCycleId: ${id}` };
    }
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }
  if (!Array.isArray(media.gstBalanceHistory)) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "No GST balance history found for this media",
    };
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

    record.isPaid = true;
    record.paidAmount = record.gstAmount;
    record.paidAt = nowIST();
    record.paidBy = userName;

    updatedRecords.push(record);
  }

  if (updatedRecords.length === 0) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "No matching unpaid GST records were found to update",
      notFoundIds,
      alreadyPaidIds,
    };
  }

  media.markModified("gstBalanceHistory");
  recomputeBalanceGstAmount(media);
  media.updatedBy = userName;
  media.updatedAt = nowIST();
  await media.save();

  return {
    success: true,
    mediaId: media._id,
    mediaName: media.mediaName,
    updatedCount: updatedRecords.length,
    updatedRecords,
    totalGstPaid: updatedRecords.reduce((s, r) => s + (r.gstAmount || 0), 0),
    notFoundIds,
    alreadyPaidIds,
    balanceGstAmount: media.rentalPayment?.balanceGstAmount || 0,
    gstBalanceHistory: media.gstBalanceHistory,
  };
}

// ═════════════════════════════════════════════════════════════
// exports.GstAmountPaid — backward compatible + new batch mode
// ═════════════════════════════════════════════════════════════
exports.GstAmountPaid = async (req, res) => {
  try {
    const { userName } = req.user;
    const { mediaId, gstCycleIds, entries } = req.body;

    // ── NEW — batch mode ──
    if (Array.isArray(entries) && entries.length > 0) {
      const results = [];
      for (const item of entries) {
        const result = await processSingleGstPayment({
          mediaId: item.mediaId,
          gstCycleIds: item.gstCycleIds,
          userName,
        });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;

      return successResponse(
        res,
        `GST marked paid across ${results.length} site(s)`,
        {
          results,
          totalSites: results.length,
          totalGstPaid: results.reduce((s, r) => s + (r.totalGstPaid || 0), 0),
          successCount,
          failedCount: results.length - successCount,
        },
        200,
      );
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "A valid mediaId is required", null, 400);
    }

    const result = await processSingleGstPayment({
      mediaId,
      gstCycleIds,
      userName,
    });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return errorResponse(
        res,
        result.message,
        {
          notFoundIds: result.notFoundIds,
          alreadyPaidIds: result.alreadyPaidIds,
        },
        statusCode,
      );
    }

    return successResponse(
      res,
      `${result.updatedCount} GST cycle record(s) marked as paid`,
      {
        mediaId: result.mediaId,
        updatedRecords: result.updatedRecords,
        notFoundIds: result.notFoundIds,
        alreadyPaidIds: result.alreadyPaidIds,
        balanceGstAmount: result.balanceGstAmount,
        gstBalanceHistory: result.gstBalanceHistory,
      },
      200,
    );
  } catch (err) {
    return errorResponse(res, "Server error", { error: err.message }, 500);
  }
};

// ── revertAgreementDocVerification — one site ──────────────────
async function processSingleRevertVerification({ mediaId, role }) {
  const userType = Number(role);

  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }
  if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
    return {
      success: false,
      mediaId,
      message: "role must be 1 (Staff), 2 (Team Lead) or 3 (Owner)",
    };
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

  if (
    !Array.isArray(media.agreementDocVerification) ||
    !media.agreementDocVerification.length
  ) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "No verification records found to revert",
    };
  }

  const match = media.agreementDocVerification
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => rec.verifiedByRole === userType && rec.isVerified)
    .sort((a, b) => new Date(b.rec.verifiedAt) - new Date(a.rec.verifiedAt))[0];

  if (!match) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: `No verification record found for ${ROLE_LABEL[userType]} to revert`,
    };
  }

  const ROLE_RANK_LOCAL = {
    [ROLE.STAFF]: 1,
    [ROLE.TEAM_LEAD]: 2,
    [ROLE.OWNER]: 3,
  };
  const cycle = match.rec.cycle;

  const higherBlocker = media.agreementDocVerification.find(
    (h) =>
      h.isVerified &&
      isSameCycle(h.cycle, cycle) &&
      ROLE_RANK_LOCAL[h.verifiedByRole] > ROLE_RANK_LOCAL[userType],
  );
  if (higherBlocker) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: `Cannot revert ${ROLE_LABEL[userType]} — ${ROLE_LABEL[higherBlocker.verifiedByRole]} has already verified this cycle. Revert ${ROLE_LABEL[higherBlocker.verifiedByRole]} first.`,
    };
  }

  media.agreementDocVerification.splice(match.i, 1);
  media.markModified("agreementDocVerification");

  if (
    Array.isArray(media.verificationProgressHistory) &&
    media.verificationProgressHistory.length
  ) {
    media.verificationProgressHistory.pop();
    media.markModified("verificationProgressHistory");
  }

  const flagKey = ROLE_FLAG_KEY[userType];
  if (flagKey && media.agreementDocVerified) {
    media.agreementDocVerified[flagKey] = false;
    media.markModified("agreementDocVerified");
  }

  if (Array.isArray(media.agreementDocVerificationHistory)) {
    const pendingEntry = Array.isArray(media.rentalDueEntries)
      ? [...media.rentalDueEntries]
          .reverse()
          .find((e) => e.approvalStatus !== 3) ||
        media.rentalDueEntries[media.rentalDueEntries.length - 1]
      : null;

    if (pendingEntry) {
      const histMatch = media.agreementDocVerificationHistory
        .map((h, i) => ({ h, i }))
        .filter(
          ({ h }) =>
            h.verifiedByRole === userType &&
            String(h.rentalDueId) === String(pendingEntry._id),
        )
        .sort((a, b) => new Date(b.h.verifiedAt) - new Date(a.h.verifiedAt))[0];

      if (histMatch) {
        media.agreementDocVerificationHistory.splice(histMatch.i, 1);
        media.markModified("agreementDocVerificationHistory");
      }
    }
  }

  media.updatedAt = nowIST();
  await media.save();

  return {
    success: true,
    mediaId: media._id,
    mediaName: media.mediaName,
    role: userType,
    roleLabel: ROLE_LABEL[userType],
    agreementDocVerified: media.agreementDocVerified,
    agreementDocVerification: media.agreementDocVerification,
    verificationProgressHistory: media.verificationProgressHistory,
    agreementDocVerificationHistory: media.agreementDocVerificationHistory,
  };
}

// ═════════════════════════════════════════════════════════════
// exports.revertAgreementDocVerification — backward compatible + batch
// ═════════════════════════════════════════════════════════════
exports.revertAgreementDocVerification = async (req, res) => {
  try {
    const { mediaId, mediaIds, role } = req.body;

    // ── NEW — batch mode ──
    if (Array.isArray(mediaIds) && mediaIds.length > 0) {
      const results = [];
      for (const id of mediaIds) {
        const result = await processSingleRevertVerification({
          mediaId: id,
          role,
        });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return successResponse(
        res,
        `${ROLE_LABEL[Number(role)] || "Role"} verification reverted for ${successCount} of ${results.length} site(s)`,
        { results, totalSites: results.length, successCount, failedCount },
        200,
      );
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    const result = await processSingleRevertVerification({ mediaId, role });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return errorResponse(res, result.message, null, statusCode);
    }

    return successResponse(
      res,
      `${result.roleLabel} document verification reverted successfully`,
      {
        mediaId: result.mediaId,
        role: result.role,
        roleLabel: result.roleLabel,
        agreementDocVerified: result.agreementDocVerified,
        agreementDocVerification: result.agreementDocVerification,
        verificationProgressHistory: result.verificationProgressHistory,
        agreementDocVerificationHistory: result.agreementDocVerificationHistory,
      },
      200,
    );
  } catch (err) {
    return errorResponse(res, "Server error", { error: err.message }, 500);
  }
};

// ── revertRentalApproval — one site ─────────────────────────────
async function processSingleRevertApproval({ mediaId, role }) {
  const userType = Number(role);

  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }
  if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
    return {
      success: false,
      mediaId,
      message: "role must be 1 (Staff), 2 (Team Lead) or 3 (Owner)",
    };
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

  const entriesField = Array.isArray(media.rentalDue)
    ? "rentalDue"
    : Array.isArray(media.rentalDueEntries)
      ? "rentalDueEntries"
      : null;

  if (!entriesField || !media[entriesField].length) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "No rental due entries found to revert",
    };
  }

  const entries = media[entriesField];
  const entry = entries[entries.length - 1];
  let reverted = false;

  if (userType === ROLE.STAFF) {
    const laterStepsUntouched = entry.approvalSteps
      ?.filter((s) => s.role !== ROLE.STAFF)
      .every((s) => s.status === 1);

    if (!laterStepsUntouched) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message:
          "Cannot revert Staff approval — Team Lead/Owner has already acted on this entry",
      };
    }
    if (media.rentalStatus !== 1) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: "Staff approval hasn't happened yet for this cycle",
      };
    }

    media.rentalStatus = 0;
    reverted = true;

    media[entriesField] = entries.slice(0, -1);
    media.markModified(entriesField);

    const yearLabel = getYearLabel(entry.dueDate);
    const monthLabel = getMonthLabel(entry.dueDate);
    const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    const monthBucket = yearBucket?.months.find((m) => m.month === monthLabel);
    if (monthBucket) {
      monthBucket.entries = monthBucket.entries.filter(
        (e) => String(e.rentalDueId) !== String(entry._id),
      );
      media.markModified("rentalDueHistory");
    }
  } else if (userType === ROLE.TEAM_LEAD) {
    if (media.rentalStatus !== 2) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: "Team Lead approval hasn't happened yet for this cycle",
      };
    }

    media.rentalStatus = 1;
    reverted = true;

    entry.approvalStatus = 1;
    entry.currentPendingRole = ROLE.TEAM_LEAD;
    entry.status = 1;
    entry.agreementDocVerified = false;

    const tlStep = entry.approvalSteps?.find((s) => s.role === ROLE.TEAM_LEAD);
    if (tlStep) {
      tlStep.userId = null;
      tlStep.userName = "";
      tlStep.approvedAt = null;
      tlStep.status = 1;
      tlStep.docVerified = false;
    }
    media.markModified(entriesField);
  } else if (userType === ROLE.OWNER) {
    if (media.rentalStatus !== 3) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: "Owner approval hasn't happened yet for this cycle",
      };
    }

    media.rentalStatus = 2;
    reverted = true;

    entry.approvalStatus = 2;
    entry.currentPendingRole = ROLE.OWNER;
    entry.status = 2;
    entry.agreementDocVerified = false;
    entry.ownerApprovalDate = null;

    const ownerStep = entry.approvalSteps?.find((s) => s.role === ROLE.OWNER);
    if (ownerStep) {
      ownerStep.userId = null;
      ownerStep.userName = "";
      ownerStep.approvedAt = null;
      ownerStep.status = 1;
      ownerStep.docVerified = false;
    }
    media.markModified(entriesField);

    const prevEntry = entries.length > 1 ? entries[entries.length - 2] : null;
    media.rentalPayment.nextBillingDate = entry.dueDate;
    media.rentalPayment.lastBillPaidDate = prevEntry ? prevEntry.dueDate : null;
    media.markModified("rentalPayment");

    media.agreementDocVerified = { staff: true, teamLead: true, owner: false };
    media.markModified("agreementDocVerified");
  }

  if (userType !== ROLE.STAFF) {
    const yearLabel = getYearLabel(entry.dueDate);
    const monthLabel = getMonthLabel(entry.dueDate);
    const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    const monthBucket = yearBucket?.months.find((m) => m.month === monthLabel);
    const historyRecord = monthBucket?.entries.find(
      (e) => String(e.rentalDueId) === String(entry._id),
    );
    if (historyRecord) {
      historyRecord.approvalStatus = entry.approvalStatus;
      historyRecord.updatedAt = nowIST();
      media.markModified("rentalDueHistory");
    }
  }

  media.updatedAt = nowIST();
  await media.save();

  return {
    success: true,
    mediaId: media._id,
    mediaName: media.mediaName,
    role: userType,
    roleLabel: ROLE_LABEL[userType],
    reverted,
    rentalStatus: media.rentalStatus,
    rentalDueEntry: userType === ROLE.STAFF ? null : entry,
    rentalPayment: media.rentalPayment,
    agreementDocVerified: media.agreementDocVerified,
  };
}

// ═════════════════════════════════════════════════════════════
// exports.revertRentalApproval — backward compatible + batch
// ═════════════════════════════════════════════════════════════
exports.revertRentalApproval = async (req, res) => {
  try {
    const { mediaId, mediaIds, role } = req.body;

    // ── NEW — batch mode ──
    if (Array.isArray(mediaIds) && mediaIds.length > 0) {
      const results = [];
      for (const id of mediaIds) {
        const result = await processSingleRevertApproval({ mediaId: id, role });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return successResponse(
        res,
        `${ROLE_LABEL[Number(role)] || "Role"} approval reverted for ${successCount} site(s)`,
        { results, totalSites: results.length, successCount, failedCount },
        200,
      );
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    const result = await processSingleRevertApproval({ mediaId, role });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return errorResponse(res, result.message, null, statusCode);
    }

    return successResponse(
      res,
      `${result.roleLabel} approval reverted successfully`,
      {
        mediaId: result.mediaId,
        role: result.role,
        roleLabel: result.roleLabel,
        reverted: result.reverted,
        rentalStatus: result.rentalStatus,
        rentalDueEntry: result.rentalDueEntry,
        rentalPayment: result.rentalPayment,
        agreementDocVerified: result.agreementDocVerified,
      },
      200,
    );
  } catch (err) {
    return errorResponse(res, "Server error", { error: err.message }, 500);
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
      isOverdue,
      isPending,
      isApproved,
      isPastPending,
      roleType,
      edit,
    } = req.body;

    const targetRole = roleType ? parseInt(roleType) : null;

    if (!dueDate) {
      return errorResponse(
        res,
        "dueDate is required. Please use format MM-YYYY (e.g., 07-2026)",
        null,
        400,
      );
    }
    if (!dueDate.match(/^\d{2}-\d{4}$/)) {
      return errorResponse(
        res,
        "Invalid dueDate format. Please use MM-YYYY (e.g., 07-2026)",
        null,
        400,
      );
    }

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const [mo, yr] = dueDate.split("-").map(Number);
    const monthStart = new Date(yr, mo - 1, 1);
    const monthEnd = new Date(yr, mo, 0, 23, 59, 59);

    // ═══════════════════════════════════════════════════════════
    // SECTION A — STATS (UNCHANGED — identical to the site-based
    // version, produces the exact same `value` block every time)
    // ═══════════════════════════════════════════════════════════

    const isClosedOverallCond = {
      $gt: [
        {
          $size: {
            $filter: {
              input: { $ifNull: ["$rentalDue", []] },
              as: "rd",
              cond: {
                $and: [
                  { $gte: ["$$rd.dueDate", monthStart] },
                  { $lte: ["$$rd.dueDate", monthEnd] },
                  { $eq: ["$$rd.approvalStatus", 3] },
                ],
              },
            },
          },
        },
        0,
      ],
    };

    const hasRoleApprovedCond =
      targetRole === null
        ? isClosedOverallCond
        : {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$rentalDue", []] },
                    as: "rd",
                    cond: {
                      $and: [
                        { $gte: ["$$rd.dueDate", monthStart] },
                        { $lte: ["$$rd.dueDate", monthEnd] },
                        {
                          $gt: [
                            {
                              $size: {
                                $filter: {
                                  input: {
                                    $ifNull: ["$$rd.approvalSteps", []],
                                  },
                                  as: "s",
                                  cond: {
                                    $and: [
                                      { $eq: ["$$s.role", targetRole] },
                                      { $eq: ["$$s.status", 2] },
                                    ],
                                  },
                                },
                              },
                            },
                            0,
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              0,
            ],
          };

    const hasRoleActedCond =
      targetRole === null
        ? isClosedOverallCond
        : {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$rentalDue", []] },
                    as: "rd",
                    cond: {
                      $and: [
                        { $gte: ["$$rd.dueDate", monthStart] },
                        { $lte: ["$$rd.dueDate", monthEnd] },
                        {
                          $gt: [
                            {
                              $size: {
                                $filter: {
                                  input: {
                                    $ifNull: ["$$rd.approvalSteps", []],
                                  },
                                  as: "s",
                                  cond: {
                                    $and: [
                                      { $eq: ["$$s.role", targetRole] },
                                      { $in: ["$$s.status", [2, 3]] },
                                    ],
                                  },
                                },
                              },
                            },
                            0,
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              0,
            ],
          };

    const relevantToRoleMatch =
      targetRole === null
        ? {}
        : {
            $expr: {
              $or: [
                hasRoleApprovedCond,
                {
                  $and: [
                    { $not: [isClosedOverallCond] },
                    { $not: [hasRoleActedCond] },
                  ],
                },
              ],
            },
          };

    const mediaMatch = { status: 1 };
    if (city) mediaMatch.city = { $regex: city, $options: "i" };
    if (mediaType) mediaMatch.mediaType = { $regex: mediaType, $options: "i" };
    if (frequency)
      mediaMatch["rentalPayment.paymentFrequency"] = parseInt(frequency, 10);

    if (status !== undefined && status !== null && status !== "") {
      const statusMap = { active: 1, expiresoon: 2, overdue: 3, expired: 3 };
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
        { "landOwners.name": { $regex: search, $options: "i" } },
      ];
    }

    const totalSites = await Media.countDocuments({ status: 1 });

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

    const dueAmountOpenAgg = await Media.aggregate([
      { $match: { status: 1, "rentalPayment.status": { $in: [2, 3] } } },
      { $match: monthOrCondition },
      { $match: { $expr: { $not: [isClosedOverallCond] } } },
      {
        $group: { _id: null, totalOpen: { $sum: "$rentalPayment.netPayable" } },
      },
    ]);
    const dueAmountOpen = dueAmountOpenAgg[0]?.totalOpen || 0;

    const statsAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $match: monthOrCondition },
      {
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
          isApprovedByRole: hasRoleApprovedCond,
          isClosedOverall: isClosedOverallCond,
          hasRoleActed: hasRoleActedCond,
          isOverdueGlobally: { $eq: ["$rentalPayment.status", 3] },
        },
      },
      {
        $group: {
          _id: null,
          approved: { $sum: { $cond: ["$isApprovedByRole", 1, 0] } },
          approvedAmount: {
            $sum: { $cond: ["$isApprovedByRole", "$effectiveNetPayable", 0] },
          },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: ["$isApprovedByRole"] },
                    { $not: ["$isClosedOverall"] },
                    { $not: ["$hasRoleActed"] },
                    { $eq: ["$isOverdueGlobally", true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          overdueAmount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: ["$isApprovedByRole"] },
                    { $not: ["$isClosedOverall"] },
                    { $not: ["$hasRoleActed"] },
                    { $eq: ["$isOverdueGlobally", true] },
                  ],
                },
                "$effectiveNetPayable",
                0,
              ],
            },
          },
          pending: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: ["$isApprovedByRole"] },
                    { $not: ["$isClosedOverall"] },
                    { $not: ["$hasRoleActed"] },
                    { $not: ["$isOverdueGlobally"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          pendingAmount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: ["$isApprovedByRole"] },
                    { $not: ["$isClosedOverall"] },
                    { $not: ["$hasRoleActed"] },
                    { $not: ["$isOverdueGlobally"] },
                  ],
                },
                "$effectiveNetPayable",
                0,
              ],
            },
          },
        },
      },
    ]);

    const approvedCount = statsAgg[0]?.approved || 0;
    const approvedAmountTotal = statsAgg[0]?.approvedAmount || 0;
    const overDueSiteCount = statsAgg[0]?.overdue || 0;
    const overDueAmountTotal = statsAgg[0]?.overdueAmount || 0;
    const pendingCount = (statsAgg[0]?.pending || 0) + overDueSiteCount;
    const pendingAmountTotal =
      (statsAgg[0]?.pendingAmount || 0) + overDueAmountTotal;

    const pastPendingAgg = await Media.aggregate([
      {
        $match: {
          status: 1,
          "rentalPayment.nextBillingDate": { $lt: monthStart },
        },
      },
      {
        $addFields: {
          matchingEntry: {
            $first: {
              $filter: {
                input: { $ifNull: ["$rentalDue", []] },
                as: "rd",
                cond: {
                  $eq: ["$$rd.dueDate", "$rentalPayment.nextBillingDate"],
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          roleStep: {
            $cond: [
              { $eq: [targetRole, null] },
              null,
              {
                $first: {
                  $filter: {
                    input: { $ifNull: ["$matchingEntry.approvalSteps", []] },
                    as: "s",
                    cond: { $eq: ["$$s.role", targetRole] },
                  },
                },
              },
            ],
          },
        },
      },
      {
        $addFields: {
          isApprovedByRole:
            targetRole === null
              ? { $eq: ["$matchingEntry.approvalStatus", 3] }
              : {
                  $and: [
                    { $eq: ["$roleStep.status", 2] },
                    { $eq: ["$matchingEntry.approvalStatus", 3] },
                  ],
                },
        },
      },
      {
        $addFields: {
          isPendingByRole:
            targetRole === null
              ? { $ne: ["$matchingEntry.approvalStatus", 3] }
              : {
                  $and: [
                    { $ne: ["$matchingEntry.approvalStatus", 3] },
                    { $not: [{ $in: ["$roleStep.status", [2, 3]] }] },
                  ],
                },
        },
      },
      { $match: { isPendingByRole: true } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: {
            $sum: {
              $ifNull: [
                "$matchingEntry.netPayable",
                "$rentalPayment.netPayable",
              ],
            },
          },
        },
      },
    ]);
    const pastPendingApproval = {
      count: pastPendingAgg[0]?.count || 0,
      amount: pastPendingAgg[0]?.amount || 0,
    };

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

    const approvalCompletedBreakdownAgg = await Media.aggregate([
      { $match: { status: 1 } },
      { $unwind: "$rentalDue" },
      {
        $match: {
          "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd },
        },
      },
      { $unwind: "$rentalDue.approvalSteps" },
      { $match: { "rentalDue.approvalSteps.status": 2 } },
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

    // ═══════════════════════════════════════════════════════════
    // SECTION B — LANDOWNER-GROUPED LIST, with FULL SITE DETAIL
    // nested inside each owner's sites[] entry (same field set as
    // the original site-based `enriched` response — mediaType,
    // totalSqFt, appraisal, frontView, full landOwners[], history
    // arrays, etc.) PLUS the owner-specific slice (paymentCategory,
    // shareAmount, gstAmount, tdsAmount, netPayableToOwner) laid on
    // top. Pagination applies to OWNERS.
    // ═══════════════════════════════════════════════════════════

    const isPastPendingByRoleCond = {
      $and: [
        { $lt: ["$rentalPayment.nextBillingDate", monthStart] },
        {
          $let: {
            vars: {
              matchingEntry: {
                $first: {
                  $filter: {
                    input: { $ifNull: ["$rentalDue", []] },
                    as: "rd",
                    cond: {
                      $eq: ["$$rd.dueDate", "$rentalPayment.nextBillingDate"],
                    },
                  },
                },
              },
            },
            in:
              targetRole === null
                ? { $ne: ["$$matchingEntry.approvalStatus", 3] }
                : {
                    $let: {
                      vars: {
                        roleStep: {
                          $first: {
                            $filter: {
                              input: {
                                $ifNull: ["$$matchingEntry.approvalSteps", []],
                              },
                              as: "s",
                              cond: { $eq: ["$$s.role", targetRole] },
                            },
                          },
                        },
                      },
                      in: {
                        $and: [
                          { $ne: ["$$matchingEntry.approvalStatus", 3] },
                          { $not: [{ $in: ["$$roleStep.status", [2, 3]] }] },
                        ],
                      },
                    },
                  },
          },
        },
      ],
    };

    const listMatch = { ...mediaMatch };
    const showPast = Number(isPastPending) === 1;
    const showCurrent =
      Number(isApproved) === 1 ||
      Number(isPending) === 1 ||
      Number(isOverdue) === 1 ||
      (!showPast && !isApproved && !isPending && !isOverdue);

    if (showPast && showCurrent) {
      listMatch.$or = [
        monthOrCondition,
        { "rentalPayment.nextBillingDate": { $lt: monthStart } },
      ];
    } else if (showPast) {
      listMatch["rentalPayment.nextBillingDate"] = { $lt: monthStart };
    } else {
      listMatch.$and = [monthOrCondition];
    }

    const listPipeline = [
      { $match: listMatch },
      { $match: relevantToRoleMatch },
      {
        $addFields: {
          isApprovedThisMonth: hasRoleApprovedCond,
          isClosedOverall: isClosedOverallCond,
          hasRoleActed: hasRoleActedCond,
          isOverdueGlobally: { $eq: ["$rentalPayment.status", 3] },
          isPastPendingByRole: isPastPendingByRoleCond,
        },
      },
      {
        $addFields: {
          isOverdueThisMonth: {
            $and: [
              { $not: ["$isApprovedThisMonth"] },
              { $not: ["$isClosedOverall"] },
              { $not: ["$hasRoleActed"] },
              { $eq: ["$isOverdueGlobally", true] },
            ],
          },
        },
      },
      {
        $addFields: {
          isPendingThisMonth: {
            $and: [
              { $not: ["$isApprovedThisMonth"] },
              { $not: ["$isClosedOverall"] },
              { $not: ["$hasRoleActed"] },
              { $not: ["$isOverdueGlobally"] },
              { $not: ["$isPastPendingByRole"] },
            ],
          },
        },
      },
    ];

    const orFilters = [];
    if (Number(isOverdue) === 1) orFilters.push({ isOverdueThisMonth: true });
    if (Number(isPending) === 1) {
      orFilters.push({ isPendingThisMonth: true });
      orFilters.push({ isOverdueThisMonth: true });
    }
    if (Number(isApproved) === 1) orFilters.push({ isApprovedThisMonth: true });
    if (Number(isPastPending) === 1)
      orFilters.push({ isPastPendingByRole: true });

    if (orFilters.length > 0) {
      listPipeline.push({ $match: { $or: orFilters } });
    }

    // ✅ No $skip/$limit here — pagination happens AFTER grouping by
    // owner below, so a site whose owner sits on a page boundary
    // never gets split across pages.
    // ✅ Full field set projected — same fields the site-based list
    // returns (mediaType, state, location, rentalStatus, totalSqFt,
    // appraisal, frontView, etc.) so each owner's sites[] entry can
    // carry the FULL site detail, not a trimmed subset.
    listPipeline.push({
      $project: {
        mediaCode: 1,
        mediaName: 1,
        mediaType: 1,
        city: 1,
        state: 1,
        location: 1,
        rentalStatus: 1,
        totalSqFt: 1,
        landOwners: 1,
        appraisal: 1,
        frontView: 1,
        rentalPayment: 1,
        agreement: 1,
        agreementDocVerification: 1,
        verificationProgressHistory: 1,
        gstApplicableFlag: 1,
        gstBalanceHistory: 1,
        rentalDue: 1,
        updatedAt: 1,
      },
    });

    const sites = await Media.aggregate(listPipeline);

    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    // ✅ SAME buildVerificationProgress as the site-based list — reused
    // as-is so verificationProgress inside each site entry matches
    // exactly what the original site-based response produced.
    const buildVerificationProgress = (item, targetCycleDate) => {
      const targetCycleStr = getCurrentCycle(targetCycleDate);

      const historyForMonth = (item.verificationProgressHistory || []).filter(
        (v) => {
          if (!v.cycle || !targetCycleStr) return false;
          return getCurrentCycle(v.cycle) === targetCycleStr;
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
          if (!h.isVerified || !h.cycle || !targetCycleStr) return false;
          return getCurrentCycle(h.cycle) === targetCycleStr;
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

      const cycleString = getCurrentCycle(targetCycleDate);

      return {
        currentCycle: formatDate(cycleString),
        staffVerified,
        teamLeadVerified,
        ownerVerified,
        verifiedCount,
        isComplete: verifiedCount >= 2,
        highestVerifiedRole,
      };
    };

    // ✅ SAME per-site enrichment as the site-based list — builds the
    // FULL detail object for one site (identical shape to the
    // original `enriched` map entries).
    const buildFullSiteDetail = (item) => {
      const isActuallyPastPending =
        item.rentalPayment?.nextBillingDate &&
        new Date(item.rentalPayment.nextBillingDate) < monthStart;

      const usePastDetails =
        Number(isPastPending) === 1 && isActuallyPastPending;
      const targetCycleDate = usePastDetails
        ? item.rentalPayment.nextBillingDate
        : (() => {
            const monthlyEntry = (item.rentalDue || []).find((e) => {
              if (!e.dueDate) return false;
              const d = new Date(e.dueDate);
              return d >= monthStart && d <= monthEnd;
            });
            if (monthlyEntry) return monthlyEntry.dueDate;
            if (item.rentalPayment?.nextBillingDate) {
              const nbd = new Date(item.rentalPayment.nextBillingDate);
              if (nbd >= monthStart && nbd <= monthEnd)
                return item.rentalPayment.nextBillingDate;
            }
            return monthStart;
          })();

      const filteredRentalDueEntries = (item.rentalDue || []).filter(
        (entry) => {
          if (!entry.dueDate) return false;
          if (usePastDetails) {
            return (
              new Date(entry.dueDate).getTime() ===
              new Date(item.rentalPayment.nextBillingDate).getTime()
            );
          }
          const entryDate = new Date(entry.dueDate);
          return entryDate >= monthStart && entryDate <= monthEnd;
        },
      );

      const filteredAgreementDocVerificationHistory = (
        item.agreementDocVerification || []
      ).filter((h) => {
        if (!h.cycle) return false;
        if (usePastDetails) {
          return (
            new Date(h.cycle).getTime() ===
            new Date(item.rentalPayment.nextBillingDate).getTime()
          );
        }
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
        appraisal: item.appraisal,
        frontView: item.frontView,
        paymentFrequency: item.rentalPayment?.paymentFrequency,
        customPaymentFrequency: item.rentalPayment?.customPaymentFrequency,
        paymentFrequencyLabel:
          FREQ_LABEL[item.rentalPayment?.paymentFrequency] || "",
        nextBillingDate: item.rentalPayment?.nextBillingDate,
        lastBillPaidDate: item.rentalPayment?.lastBillPaidDate,
        dueStatus: item.rentalPayment?.status,
        dueStatusLabel: STATUS_LABEL[item.rentalPayment?.status] || "",
        gstApplicableDisplay: resolveGstApplicable(item),
        agreementPeriod: {
          startDate: item.agreement?.startDate,
          endDate: item.agreement?.endDate,
          agreementPDF: item.agreement?.agreementPDF,
        },
        agreementDocVerificationHistory:
          filteredAgreementDocVerificationHistory,
        verificationProgress: buildVerificationProgress(item, targetCycleDate),
        verificationProgressHistory: item.verificationProgressHistory || [],
        gstBalanceHistory: item.gstBalanceHistory || [],
        rentalDueEntries: filteredRentalDueEntries,
      };
    };

    const ownerMap = new Map();

    for (const site of sites) {
      if (!Array.isArray(site.landOwners)) continue;

      // Build the full site detail ONCE per site — reused for every
      // owner on that site, so the (potentially large) history arrays
      // aren't recomputed per-owner.
      const fullSiteDetail = buildFullSiteDetail(site);

      for (const owner of site.landOwners) {
        if (!owner.landOwnerMasterId) continue;
        const key = String(owner.landOwnerMasterId);

        if (!ownerMap.has(key)) {
          ownerMap.set(key, {
            landOwnerMasterId: owner.landOwnerMasterId,
            landOwnerName: owner.name,
            phone: owner.phone,
            totalSites: 0,
            totalShareAmount: 0,
            totalGstAmount: 0,
            totalNetPayableToOwner: 0,
            latestUpdatedAt: site.updatedAt,
            sites: [],
          });
        }

        const bucket = ownerMap.get(key);
        bucket.totalSites += 1;
        bucket.totalShareAmount += owner.shareAmount || 0;
        bucket.totalGstAmount += owner.gstAmount || 0;
        bucket.totalNetPayableToOwner += owner.netPayableToOwner || 0;
        if (new Date(site.updatedAt) > new Date(bucket.latestUpdatedAt)) {
          bucket.latestUpdatedAt = site.updatedAt;
        }

        // ✅ MERGED — full site detail (mediaType, totalSqFt, appraisal,
        // frontView, full landOwners[], history arrays, etc.) PLUS the
        // owner-specific slice (paymentCategory, shareAmount, gstAmount,
        // tdsAmount, netPayableToOwner) laid on top. The owner-specific
        // fields intentionally OVERRIDE any same-named field coming
        // from fullSiteDetail (e.g. gstAmount) so each entry reads as
        // "this owner's amount on this site", not the site's total.
        bucket.sites.push({
          ...fullSiteDetail,
          mediaId: site._id,
          paymentCategory: owner.paymentCategory,
          shareAmount: owner.shareAmount || 0,
          gstAmount: owner.gstAmount || 0,
          tdsAmount: owner.tdsAmount || 0,
          netPayableToOwner: owner.netPayableToOwner || 0,
        });
      }
    }

    let allOwners = Array.from(ownerMap.values());

    // ✅ edit-mode stability — same principle as the site-based list:
    // when edit === 1, sort by landOwnerMasterId (stable, never
    // reshuffles) instead of latestUpdatedAt (which jumps the moment
    // any of the owner's sites gets edited).
    if (Number(edit) === 1) {
      allOwners.sort((a, b) =>
        String(a.landOwnerMasterId).localeCompare(String(b.landOwnerMasterId)),
      );
    } else {
      allOwners.sort(
        (a, b) => new Date(b.latestUpdatedAt) - new Date(a.latestUpdatedAt),
      );
    }

    allOwners = allOwners.map(({ latestUpdatedAt, ...rest }) => rest);

    const startIdx = (pageNumbers - 1) * pageSize;
    const pagedOwners = allOwners.slice(startIdx, startIdx + pageSize);

    // ═══════════════════════════════════════════════════════════
    // SECTION C — RESPONSE — `value` block UNCHANGED, `data` is now
    // the landowner-grouped, paginated array with full site detail.
    // ═══════════════════════════════════════════════════════════
    return successResponse(
      res,
      "Rental due list fetched successfully",
      {
        value: {
          totalSites,
          dueThisMonth,
          dueAmountOpen,
          overDue: { siteCount: overDueSiteCount, amount: overDueAmountTotal },
          approvedCount,
          approvedAmountTotal,
          pendingCount,
          pendingAmountTotal,
          pastPendingApproval,
          pendingApproval: {
            staff: pendingByRole.staff,
            teamLead: pendingByRole.teamLead,
            owner: pendingByRole.owner,
            total: pendingByRole.total,
          },
          approvalBreakdown: {
            staff: approvedByRole.staff,
            teamLead: approvedByRole.teamLead,
            owner: approvedByRole.owner,
            total: approvedByRole.total,
          },
          pagination: {
            count: pageSize,
            pageNumber: pageNumbers,
            totalCount: allOwners.length,
            totalPages: Math.ceil(allOwners.length / pageSize),
          },
        },
        data: pagedOwners,
      },
      200,
    );
  } catch (err) {
    return errorResponse(res, "Server error", { error: err.message }, 500);
  }
};
