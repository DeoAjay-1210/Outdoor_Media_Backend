
const mongoose = require("mongoose");
const { successResponse, errorResponse } = require("../../../utils/response");
const axios = require("axios");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const path = require("path");
const OverDueHistory = require("../../../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { computeOutstandingSummary, getOverallSummaryForCycle } = require("../../../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");

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
const { getRentForDueDate, getRentRatioForDueDate, getGstRatioForDueDate, mediaAsOfDate } = require("../../../utils/appraisalRent");
const { computeRentalDueStats } = require("../../../utils/rentalDueStats");
const {
  createRentalApprovalNotification,
  createOverdueRemarkNotification,
} = require("../../../controllers/Admin/NotificationController/CmdNotificationController");
const { notifyRentalDueChat, notifyOverdueRemarkChat, rentalDueChatKey } = require("../../../utils/googleChat");
const { collectRentalDueChanges, recordRentalDueChanges } = require("./RentalDueHistoryController");
const { formatDraft } = require("./RentalDueDraftController"); // ✅ NEW — rentalDueEntries[].draft
const RentRevision = require("../../../models/Admin/MediaOnboardingSchema/RentRevisionSchema"); // ✅ NEW — rentalDueEntries[].rentRevision
const { effectiveAppraisalHold } = require("./AppraisalHoldController"); // ✅ NEW — hold shown on later bills too
const { siteBillDate } = require("../../../utils/billDate"); // ✅ NEW — rentalDueEntries[].billDate
const { overdueRemarkReceivers, istRemarkEditTimes } = require("./OverdueRemarkChatController"); // ✅ NEW — remark chat moved there

// ✅ NEW — CMD notification helpers. A Rental Executive (STAFF) / Rental
// Manager (TEAM_LEAD) save only counts as an approval when that role's own
// step moves to status 2 in THIS request (a save while it is not their turn
// only updates fields and must not notify).
const isRentalApproverRole = (userType) => userType === ROLE.STAFF || userType === ROLE.TEAM_LEAD;
// ✅ NEW — overdue remark roleName (same names as notifications / Google Chat);
// ROLE_LABEL ("Owner" for 3) stays as-is for the approval / verification messages
const REMARK_ROLE_NAME = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
// ✅ NEW — roles whose approval sends a notification (CMD approval → Executive + Manager)
const isApprovalNotifyRole = (userType) => isRentalApproverRole(userType) || userType === ROLE.OWNER;
const isRoleStepApproved = (entry, role) =>
  !!(entry?.approvalSteps || []).find((s) => s.role === role && s.status === 2);
const findRentalDueEntryById = (media, rentalDueId) =>
  (media?.rentalDue || []).find((d) => String(d._id) === String(rentalDueId));

const IST_OFFSET_MS = 330 * 60000; // 5h30m

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

/**
 * ✅ NEW — Combines a provided date string with the current time
 * to ensure timestamps are preserved even when a backdated date is given.
 */
const combineDateWithCurrentTime = (dateInput) => {
  const now = nowIST();
  if (!dateInput) return now;
  const d = new Date(dateInput);
  if (!isNaN(d.getTime())) {
    d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  }
  return d;
};

// ═════════════════════════════════════════════════════════════
// UNCHANGED HELPERS — copied verbatim from the existing file
// ═════════════════════════════════════════════════════════════
function ensureApprovalStepsPopulated(entry) {
  if (Array.isArray(entry.approvalSteps) && entry.approvalSteps.length > 0) {
    return false; // already fine
  }

  const rebuiltSteps = buildApprovalSteps(entry.approvalFlow || 2);

  // Preserve remarks note so it's visible this was a repair, not an
  // original auto-generated entry.
  if (rebuiltSteps[0]) {
    rebuiltSteps[0].remarks = "Auto-generated for missed cycle (steps repaired)";
  }

  entry.approvalSteps = rebuiltSteps;
  entry.currentPendingRole = rebuiltSteps[0]?.role ?? ROLE.STAFF;
  if (entry.approvalStatus === 3 || entry.status === 3) {
    // don't reopen an already-fully-approved entry — leave status alone
  } else if (!entry.approvalStatus || entry.approvalStatus === 0) {
    entry.approvalStatus = 1;
    entry.status = 1;
  }

  return true;
}
const buildApprovalSteps = (approvalFlow) => {
  const chain = FLOW_CHAIN[approvalFlow] || FLOW_CHAIN[1];

  // ✅ ADDED — hard safety net. If FLOW_CHAIN[approvalFlow] AND
  // FLOW_CHAIN[1] are both missing/empty, fall back to the standard
  // 3-role chain instead of silently returning []. An empty
  // approvalSteps array is what caused entries to save with no
  // steps at all — nothing to approve, nothing to verify against.
  const safeChain =
    Array.isArray(chain) && chain.length > 0
      ? chain
      : [ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER];

  return safeChain.map((role) => ({
    role,
    userId: null,
    userName: "",
    approvedAt: null,
    status: 1,
    docVerified: false,
  }));
};

const FREQUENCY_MONTHS_MAP = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };

function getCycleMonthsForFrequency(media) {
  const frequency = Number(media.rentalPayment?.paymentFrequency || 1);
  if (frequency === 6) {
    return Number(media.rentalPayment?.customPaymentFrequency) || 1;
  }
  return FREQUENCY_MONTHS_MAP[frequency] || 1;
}

function addMonthsUTC(date, months) {
  const d = new Date(date);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Handle month-end overflow (e.g., Jan 31 + 1 month -> March 3)
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0);
  }
  return d;
}

function ensureNextBillingDateSeed(media) {
  if (media.rentalPayment?.nextBillingDate) return false; // already seeded

  const seedDate =
    media.agreement?.startDate
      ? new Date(media.agreement.startDate)
      : new Date();

  if (!media.rentalPayment) media.rentalPayment = {};
  media.rentalPayment.nextBillingDate = seedDate;
  media.markModified("rentalPayment");
  return true;
}

function ensureNextBillingDateSeed(media) {
  if (media.rentalPayment?.nextBillingDate) return false; // already set

  const seedDate = media.agreement?.startDate
    ? new Date(media.agreement.startDate)
    : new Date();

  if (!media.rentalPayment) media.rentalPayment = {};
  media.rentalPayment.nextBillingDate = seedDate;
  media.markModified("rentalPayment");
  return true;
}

async function generateMissedEntriesForMedia(media, userName) {
  if (!media.mediaDetails?.some(d => d.status === 1)) {
    return { generatedEntries: [] };
  }

  if (!Array.isArray(media.rentalDue)) media.rentalDue = [];
  if (!Array.isArray(media.rentalDueHistory)) media.rentalDueHistory = [];

  if (media.rentalPayment?.lastBillPaidDate) {
    const lbpDate = new Date(media.rentalPayment.lastBillPaidDate);
    if (!Number.isNaN(lbpDate.getTime())) {
      const lbpMonthLabel = getDueMonthLabel(lbpDate);

      // ✅ FIXED — Always sync per face to support face-based tracking
      const facesToSync = media.mediaDetails || [];
      for (const face of facesToSync) {
        const faceId = face ? face._id : null;
        const matchingEntry = media.rentalDue.find(
          (e) => e.dueMonth === lbpMonthLabel && String(e.mediaDetailId || "") === String(faceId || ""),
        );
        if (
          matchingEntry &&
          new Date(matchingEntry.dueDate).getTime() !== lbpDate.getTime()
        ) {
          const syncResult = await atomicallyEnsureOrUpdateRentalDueEntry(
            media._id,
            { dueMonth: lbpMonthLabel, dueDate: lbpDate, mediaDetailId: faceId },
          );
          if (syncResult.result) {
            media.rentalDue = syncResult.result.rentalDue;
          }
        }
      }
    }
  }

  const cycleMonths = getCycleMonthsForFrequency(media);
  if (!cycleMonths || cycleMonths <= 0) return { generatedEntries: [] };

  const billingStartDate = media.rentalPayment?.billingStartDate;
  const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate;
  const anchorRaw = billingStartDate || lastBillPaidDate;
  if (!anchorRaw) return { generatedEntries: [] };

  const anchorDateObj = new Date(anchorRaw);
  const anchorMonthStart = new Date(Date.UTC(
    anchorDateObj.getUTCFullYear(),
    anchorDateObj.getUTCMonth(),
    anchorDateObj.getUTCDate()
  ));

  const today = new Date();
  const referenceDate = today;

  const dueCycles = [];
  let cursor = addMonthsUTC(anchorMonthStart, cycleMonths);

  let guard = 0;
  while (guard < 240) {
    const cursorIsPastReference =
      cursor.getUTCFullYear() > referenceDate.getUTCFullYear() ||
      (cursor.getUTCFullYear() === referenceDate.getUTCFullYear() &&
        cursor.getUTCMonth() > referenceDate.getUTCMonth());
    if (cursorIsPastReference) break;

    dueCycles.push(new Date(cursor));

    if (
      cursor.getFullYear() === referenceDate.getFullYear() &&
      cursor.getMonth() === referenceDate.getMonth()
    ) {
      break;
    }
    cursor = addMonthsUTC(cursor, cycleMonths);
    guard++;
  }

  if (dueCycles.length === 0) return { generatedEntries: [] };

  const generatedEntries = [];
  let latestCycleDate = null;

  for (const candidateDate of dueCycles) {
    latestCycleDate = candidateDate;
    const candidateMonthLabel = getDueMonthLabel(candidateDate);

    // ✅ FIXED — Always generate per face to support face-based tracking
    const facesToGenerate = media.mediaDetails || [];

    for (const face of facesToGenerate) {
      const faceId = face ? face._id : null;

      // ✅ FIXED — check for ANY entry for this month (face-specific OR site-wide).
      // If a site-wide entry (null) exists, we consider the month "covered" for this face
      // to prevent creating a face-specific duplicate that leads to double-counting.
      const existingEntryForMonth = media.rentalDue.find(
        (e) => e.dueMonth === candidateMonthLabel && (String(e.mediaDetailId || "") === String(faceId || "") || !e.mediaDetailId),
      );
      if (
        existingEntryForMonth &&
        new Date(existingEntryForMonth.dueDate).getTime() === candidateDate.getTime()
      ) {
        // ✅ SYNC PENDING ENTRY AMOUNTS — if configuration (GST/rent) changed while pending
        if (existingEntryForMonth.approvalStatus === 1) {
          const inferredWithGst = Number(existingEntryForMonth.withGst || 0);
          const currentGstSplit = computeGstSplit(media, inferredWithGst, faceId, existingEntryForMonth.dueDate);

          if (
            Number(existingEntryForMonth.netPayable) !== Number(currentGstSplit.netPayable) ||
            Number(existingEntryForMonth.gstAmount) !== Number(currentGstSplit.gstAmount) ||
            Number(existingEntryForMonth.baseAmount) !== Number(currentGstSplit.baseAmount)
          ) {
            existingEntryForMonth.netPayable = Number(currentGstSplit.netPayable);
            existingEntryForMonth.gstAmount = Number(currentGstSplit.gstAmount);
            existingEntryForMonth.baseAmount = Number(currentGstSplit.baseAmount);

            // Also update history entry if it exists
            const yearLabel = getYearLabel(candidateDate);
            const monthLabel = getMonthLabel(candidateDate);
            const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
            const monthBucket = yearBucket?.months.find((m) => m.month === monthLabel);
            const historyRecord = monthBucket?.entries.find(
              (h) => String(h.rentalDueId) === String(existingEntryForMonth._id)
            );
            if (historyRecord) {
              historyRecord.netPayable = existingEntryForMonth.netPayable;
              historyRecord.updatedAt = nowIST();
              historyRecord.updatedBy = userName || "System (auto-update)";
            }
            media.markModified("rentalDue");
            media.markModified("rentalDueHistory");
          }
        }
        continue;
      }

      const chainSteps = buildApprovalSteps(2);
      const steps = [
        {
          role: ROLE.STAFF,
          userId: null,
          userName: "",
          approvedAt: null,
          status: 1,
          docVerified: false,
          remarks: "Auto-generated for missed cycle",
        },
        ...chainSteps,
      ];

      const inferredWithGst = 0;
      const gstSplit = computeGstSplit(media, inferredWithGst, faceId, candidateDate);

      const newEntry = {
        dueMonth: candidateMonthLabel,
        dueDate: new Date(candidateDate),
        mediaDetailId: faceId,
        netPayable: Number(gstSplit.netPayable) || 0,
        paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
        customPaymentFrequency:
          media.rentalPayment?.paymentFrequency === 6
            ? media.rentalPayment?.customPaymentFrequency || 1
            : undefined,
        ownerApprovalDate: null,
        mailSent: false,
        gstAddedToBalance: false,
        campaignName: "",
        reason: "",
        proofOfCampaign: null,
        savedBy: {
          userId: null,
          userName: "System (auto-generated)",
          role: null,
          savedAt: nowIST(),
        },
        approvalFlow: 2,
        approvalSteps: steps,
        approvalStatus: 1,
        currentPendingRole: ROLE.STAFF,
        agreementDocVerified: false,
        status: 1,
        withGst: inferredWithGst,
        gstAmount: Number(gstSplit.gstAmount) || 0,
        baseAmount: Number(gstSplit.baseAmount) || 0,
        gstApplicableFlag: 0,
        pastgstApplicableFlag: media.pastgstApplicableFlag || 0,
        updatedBy: userName || "",
        updatedAt: nowIST(),
      };

      const { result: atomicResult } = await atomicallyEnsureOrUpdateRentalDueEntry(media._id, newEntry);

      if (!atomicResult) continue;

      media.rentalDue = atomicResult.rentalDue;
      const savedEntry = media.rentalDue[media.rentalDue.length - 1];

      const yearLabel = getYearLabel(candidateDate);
      const monthLabel = getMonthLabel(candidateDate);

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
        siteName: face ? face.mediaName : (media.mediaDetails?.map(d => d.mediaName).join(", ") || "Unknown"),
        campaignName: "",
        reason: "",
        dueDate: new Date(candidateDate),
        netPayable: Number(newEntry.netPayable) || 0,
        approvalStatus: newEntry.approvalStatus,
        savedBy: "System (auto-generated)",
        savedByRole: null,
        updatedAt: nowIST(),
        updatedBy: userName || "",
      });

      generatedEntries.push({
        rentalDueId: savedEntry._id,
        dueMonth: newEntry.dueMonth,
        dueDate: newEntry.dueDate,
        netPayable: newEntry.netPayable,
        approvalStatus: newEntry.approvalStatus,
        currentPendingRole: newEntry.currentPendingRole,
      });
    }
  }

  if (latestCycleDate) {
    media.rentalPayment.lastBillPaidDate = latestCycleDate;
    media.rentalPayment.nextBillingDate = addMonthsUTC(latestCycleDate, cycleMonths);
    media.markModified("rentalPayment");
  }

  await syncAllOverdueEntriesForMedia(media, userName);

  if (generatedEntries.length > 0) {
    media.markModified("rentalDueHistory");
    await media.save({ timestamps: false });
  } else if (latestCycleDate) {
    await media.save({ timestamps: false });
  }

  return { generatedEntries };
}
exports.generateMissedEntriesForMedia = generateMissedEntriesForMedia;
exports.sendRentalDueApprovalMail = sendRentalDueApprovalMail; // ✅ NEW — rent revision arrears mail

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

/**
 * ✅ NEW — maintain history of overdue entries before they are removed by approval.
 */
// siteRows (✅ NEW, optional) = this site's overdue rows loaded once by
// syncAllOverdueEntriesForMedia; the same 3 lookups then run in memory
// instead of 1–3 database round trips per bill. Without it → database as before.
async function saveOverDueHistoryIfApplicable(media, entry, userName, siteRows = null) {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Extract approval details from entry steps
    const staffStep = (entry.approvalSteps || []).find(
      (s) => Number(s.role) === 1 && (Number(s.status) === 2 || Number(s.status) === 3 || s.approvedAt)
    );
    const teamLeadStep = (entry.approvalSteps || []).find(
      (s) => Number(s.role) === 2 && (Number(s.status) === 2 || Number(s.status) === 3 || s.approvedAt)
    );
    const ownerStep = (entry.approvalSteps || []).find(
      (s) => Number(s.role) === 3 && (Number(s.status) === 2 || Number(s.status) === 3 || s.approvedAt)
    );

    const staffApprovedAt = staffStep?.approvedAt || (staffStep?.status === 3 ? (entry.ownerApprovalDate || entry.updatedAt) : null);
    const staffApprovedBy = staffStep?.userName || (staffStep?.status === 3 ? "Skipped (Owner Approved)" : null);

    const teamLeadApprovedAt = teamLeadStep?.approvedAt || (teamLeadStep?.status === 3 ? (entry.ownerApprovalDate || entry.updatedAt) : null);
    const teamLeadApprovedBy = teamLeadStep?.userName || (teamLeadStep?.status === 3 ? "Skipped (Owner Approved)" : null);

    const ownerApprovedAt =
      ownerStep?.approvedAt ||
      entry.ownerApprovalDate ||
      (Number(entry.approvalStatus) === 3 ? entry.updatedAt || nowIST() : null);
    const ownerApprovedBy =
      ownerStep?.userName ||
      (Number(entry.approvalStatus) === 3 ? userName || entry.savedBy?.userName : null);

    const calcDiffDays = (date) => {
      if (!date || !entry.dueDate) return "-";
      const diff = Math.floor((new Date(date) - new Date(entry.dueDate)) / 86400000);
      return diff > 0 ? `${diff} days` : "0 days";
    };

    const OverdueByStaff = calcDiffDays(staffApprovedAt);
    const OverdueByTeamLead = calcDiffDays(teamLeadApprovedAt);
    const OverdueByCMD = calcDiffDays(ownerApprovedAt);

    const hasAnyApproval = !!(staffApprovedAt || teamLeadApprovedAt || ownerApprovedAt || Number(entry.approvalStatus) === 3);

    const isOverdue =
      Number(media.rentalPayment?.status) === 3 ||
      (entry.dueDate && new Date(entry.dueDate) < today);

    // ✅ NEW — same lookup, from the preloaded site rows when given
    const findRow = (predicate, query) =>
      siteRows ? Promise.resolve(siteRows.find(predicate) || null) : OverDueHistory.findOne(query);

    // Check for duplicate for this specific cycle/media
    let existing = await findRow(
      (r) => r.rentalDueId && String(r.rentalDueId) === String(entry._id),
      { mediaId: media._id, rentalDueId: entry._id },
    );

    if (!existing && entry.dueMonth) {
      existing = await findRow(
        (r) => r.dueMonth === entry.dueMonth,
        { mediaId: media._id, dueMonth: entry.dueMonth },
      );
      if (existing && !existing.rentalDueId) {
        existing.rentalDueId = entry._id;
      }
    }

    if (!existing) {
      existing = await findRow(
        (r) => r.rentalDueId === null || r.rentalDueId === undefined,
        { mediaId: media._id, $or: [{ rentalDueId: null }, { rentalDueId: { $exists: false } }] },
      );
      if (existing) {
        existing.rentalDueId = entry._id;
        existing.dueMonth = entry.dueMonth;
        existing.dueDate = entry.dueDate;
      }
    }

    // Skip creating new records if not overdue, no existing record, and no approvals
    if (!isOverdue && !existing && !hasAnyApproval) return;

    const entryGst = Number(entry.gstAmount || 0);
    const siteGst = Number(media.rentalPayment?.gstAmount || 0);
    const ownerGst = (media.landOwners || []).filter(o => Number(o.gstApplicable) === 1).reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
    let resolvedGst = entryGst > 0 ? entryGst : (siteGst > 0 ? siteGst : ownerGst);

    let baseAmount = Number(entry.netPayable || 0);
    // ✅ NEW — single-bill multi-face site: the row is ONE per site per month,
    // so it stores the whole bill (site rent / GST), not this face's share
    const siteBill = siteBillForOverdue(media, entry.dueDate);
    if (siteBill) {
      resolvedGst = siteBill.gst;
      baseAmount = Number(entry.withGst) === 2 ? siteBill.rent + siteBill.gst : siteBill.rent;
    }
    const isGstApplicable = resolvedGst > 0;

    const mDetails = (media.mediaDetails || []).map(d => ({
      mediaCode: d.mediaCode,
      mediaName: d.mediaName,
      mediaType: d.mediaType,
      city: d.city,
      location: d.location
    }));

    const lOwners = (media.landOwners || []).map(o => ({
      landOwnerMasterId: o.landOwnerMasterId || null,
      name: o.name || o.landOwnerName || "",
      landOwnerName: o.name || o.landOwnerName || "",
      phone: o.phone || "",
      panNumber: o.panNumber || "",
      accountNumber: o.accountNumber || "",
      bankName: o.bankName || "",
      ifsc: o.ifsc || "",
      paymentCategory: o.paymentCategory,
      sharePercentage: o.sharePercentage,
      shareAmount: o.shareAmount,
      gstApplicable: o.gstApplicable,
      gstAmount: o.gstAmount,
    }));

    const mainLandOwnerName = lOwners
      .map((o) => o.name || o.landOwnerName)
      .filter(Boolean)
      .join(", ");

    if (existing) {
      let updated = false;
      let significantChange = false;

      if (Number(entry.withGst || 0) !== Number(existing.withGst || 0)) {
        existing.withGst = Number(entry.withGst || 0);
        updated = true;
        significantChange = true;
      }
      if (baseAmount > 0 && existing.overDueAmount !== baseAmount) {
        existing.overDueAmount = baseAmount;
        updated = true;
      }
      if (resolvedGst > 0 && existing.gstAmount !== resolvedGst) {
        existing.gstAmount = resolvedGst;
        updated = true;
      }
      if (entry.dueMonth && existing.dueMonth !== entry.dueMonth) {
        existing.dueMonth = entry.dueMonth;
        updated = true;
      }
      if (entry.dueDate && existing.dueDate !== entry.dueDate) {
        existing.dueDate = entry.dueDate;
        updated = true;
      }
      if (mDetails.length > 0 && (!existing.mediaDetails || existing.mediaDetails.length === 0)) {
        existing.mediaDetails = mDetails;
        updated = true;
      }
      if (lOwners.length > 0 && (!existing.landOwners || existing.landOwners.length === 0)) {
        existing.landOwners = lOwners;
        existing.landOwnerName = mainLandOwnerName;
        updated = true;
      }
      if (entry.approvalStatus && existing.status !== entry.approvalStatus) {
        existing.status = entry.approvalStatus;
        updated = true;
        significantChange = true;
      }
      if (staffApprovedAt) {
        existing.staffApprovedAt = staffApprovedAt;
        existing.staffApprovedBy = staffApprovedBy || existing.staffApprovedBy || "";
        existing.OverdueByStaff = OverdueByStaff;
        updated = true;
        significantChange = true;
      }
      if (teamLeadApprovedAt) {
        existing.teamLeadApprovedAt = teamLeadApprovedAt;
        existing.teamLeadApprovedBy = teamLeadApprovedBy || existing.teamLeadApprovedBy || "";
        existing.OverdueByTeamLead = OverdueByTeamLead;
        updated = true;
        significantChange = true;
      }
      if (ownerApprovedAt) {
        existing.ownerApprovedAt = ownerApprovedAt;
        existing.ownerApprovedBy = ownerApprovedBy || existing.ownerApprovedBy || "";
        existing.approvedDate = ownerApprovedAt;
        existing.removedDate = ownerApprovedAt;
        existing.OverdueByCMD = OverdueByCMD;
        existing.approvalOverdueBy = OverdueByCMD;
        updated = true;
        significantChange = true;
      }
      if (updated) {
        existing.updatedBy = userName || existing.updatedBy;
        if (significantChange || !existing.updatedAt) {
          existing.updatedAt = nowIST();
        }
        await existing.save();
      }
      return;
    }

    const createdRow = await OverDueHistory.create({
      mediaId: media._id,
      mediaDetails: mDetails,
      landOwners: lOwners,
      landOwnerName: mainLandOwnerName,
      previousBillDate: media.rentalPayment?.previousBillGenerateDate,
      currentBillDate: entry.dueDate,
      nextBillDate: media.rentalPayment?.nextBillingDate,
      overDueAmount: baseAmount,
      gstAmount: resolvedGst,
      isGstApplicable,
      approvedDate: ownerApprovedAt || null,
      removedDate: ownerApprovedAt || null,
      staffApprovedAt,
      staffApprovedBy,
      teamLeadApprovedAt,
      teamLeadApprovedBy,
      ownerApprovedAt,
      ownerApprovedBy,
      OverdueByStaff,
      OverdueByTeamLead,
      OverdueByCMD,
      approvalOverdueBy: ownerApprovedAt ? OverdueByCMD : "-",
      dueMonth: entry.dueMonth,
      dueDate: entry.dueDate,
      rentalDueId: entry._id,
      withGst: Number(entry.withGst || 0),
      status: entry.approvalStatus || 2, // 2: Pending Entry
      updatedBy: userName,
      createdAt: nowIST(),
      updatedAt: nowIST(),
    });
    // ✅ NEW — later bills of this site in the same sweep see the new row
    if (siteRows && createdRow) siteRows.push(createdRow);
  } catch (err) {
    console.error("❌ Error saving OverDue History:", err.message);
  }
}

async function syncAllOverdueEntriesForMedia(media, userName = "System") {
  if (!media || !Array.isArray(media.rentalDue)) return;
  // ✅ CHANGED — the site's overdue rows are loaded ONCE (same documents
  // findOne returned, natural order) instead of 1–3 lookups per bill
  const siteRows = await OverDueHistory.find({ mediaId: media._id });
  for (const entry of media.rentalDue) {
    await saveOverDueHistoryIfApplicable(media, entry, userName, siteRows);
  }
}

// ✅ NEW — sweep several sites at a time (each site only touches its own
// overdue rows); same result as one by one, fewer waits on the database
async function syncOverdueEntriesForSites(sites, userName = "", concurrency = 5) {
  let next = 0;
  const worker = async () => {
    while (next < sites.length) {
      const site = sites[next++];
      await syncAllOverdueEntriesForMedia(site, userName);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sites.length) }, worker));
}

async function cleanupDuplicateOverDueHistoryRecords() {
  try {
    const allOverdue = await OverDueHistory.find({}).lean();
    if (!allOverdue || allOverdue.length === 0) return;

    const mediaGroups = new Map();
    allOverdue.forEach((item) => {
      const mId = String(item.mediaId);
      if (!mediaGroups.has(mId)) mediaGroups.set(mId, []);
      mediaGroups.get(mId).push(item);
    });

    for (const [mId, records] of mediaGroups.entries()) {
      const cycleGroups = new Map();
      const orphans = [];

      records.forEach((rec) => {
        const key = rec.rentalDueId
          ? String(rec.rentalDueId)
          : rec.dueDate
          ? String(rec.dueDate)
          : rec.dueMonth
          ? String(rec.dueMonth)
          : null;
        if (key) {
          if (!cycleGroups.has(key)) cycleGroups.set(key, []);
          cycleGroups.get(key).push(rec);
        } else {
          orphans.push(rec);
        }
      });

      // Handle orphans with 0 amount / no rentalDueId / no dueDate / no dueMonth
      for (const orphan of orphans) {
        const realRecord = records.find(
          (r) => r._id.toString() !== orphan._id.toString() && (r.rentalDueId || r.dueDate || r.dueMonth || r.overDueAmount > 0)
        );
        if (realRecord) {
          if (orphan.remarks || (orphan.overDueRemarks && orphan.overDueRemarks.length > 0)) {
            const mergedRemarks = [
              ...(realRecord.overDueRemarks || []),
              ...(orphan.overDueRemarks || []),
            ];
            await OverDueHistory.updateOne(
              { _id: realRecord._id },
              {
                $set: {
                  remarks: orphan.remarks || realRecord.remarks,
                  overDueRemarks: mergedRemarks,
                },
              }
            );
          }
          await OverDueHistory.deleteOne({ _id: orphan._id });
        }
      }

      // Handle duplicates sharing the same rentalDueId / dueMonth
      for (const [key, cycleRecs] of cycleGroups.entries()) {
        if (cycleRecs.length <= 1) continue;

        cycleRecs.sort((a, b) => {
          const scoreA =
            (a.ownerApprovedAt ? 10 : 0) +
            (a.overDueRemarks?.length || 0) +
            (a.overDueAmount ? 5 : 0);
          const scoreB =
            (b.ownerApprovedAt ? 10 : 0) +
            (b.overDueRemarks?.length || 0) +
            (b.overDueAmount ? 5 : 0);
          return scoreB - scoreA;
        });

        const primary = cycleRecs[0];
        const duplicates = cycleRecs.slice(1);

        for (const dup of duplicates) {
          if (dup.remarks || (dup.overDueRemarks && dup.overDueRemarks.length > 0)) {
            const merged = [
              ...(primary.overDueRemarks || []),
              ...(dup.overDueRemarks || []),
            ];
            await OverDueHistory.updateOne(
              { _id: primary._id },
              { $set: { overDueRemarks: merged, remarks: primary.remarks || dup.remarks } }
            );
          }
          await OverDueHistory.deleteOne({ _id: dup._id });
        }
      }
    }
  } catch (err) {
    console.error("❌ Error cleaning duplicate OverDueHistory records:", err.message);
  }
}

/**
 * Ensures existing OverDueHistory documents in DB have landOwners and landOwnerName populated.
 */
async function ensureOverDueHistoryLandOwnersPopulated() {
  try {
    const unpopulated = await OverDueHistory.find({
      $or: [
        { landOwners: { $exists: false } },
        { landOwners: { $size: 0 } },
        { landOwnerName: { $exists: false } },
        { landOwnerName: "" },
        { landOwnerName: null },
      ],
    }).limit(200).lean();

    if (!unpopulated || unpopulated.length === 0) return;

    const mediaIds = [...new Set(unpopulated.map((u) => u.mediaId).filter(Boolean))];
    const mediaDocs = await Media.find({ _id: { $in: mediaIds } }).select("landOwners").lean();
    const mediaMap = new Map(mediaDocs.map((m) => [String(m._id), m.landOwners || []]));

    for (const doc of unpopulated) {
      const owners = mediaMap.get(String(doc.mediaId)) || [];
      const lOwners = owners.map((o) => ({
        landOwnerMasterId: o.landOwnerMasterId || null,
        name: o.name || o.landOwnerName || "",
        landOwnerName: o.name || o.landOwnerName || "",
        phone: o.phone || "",
        panNumber: o.panNumber || "",
        accountNumber: o.accountNumber || "",
        bankName: o.bankName || "",
        ifsc: o.ifsc || "",
        paymentCategory: o.paymentCategory,
        sharePercentage: o.sharePercentage,
        shareAmount: o.shareAmount,
        gstApplicable: o.gstApplicable,
        gstAmount: o.gstAmount,
      }));

      const landOwnerName = lOwners
        .map((o) => o.name || o.landOwnerName)
        .filter(Boolean)
        .join(", ");

      await OverDueHistory.updateOne(
        { _id: doc._id },
        { $set: { landOwners: lOwners, landOwnerName } }
      );
    }
  } catch (err) {
    console.error("❌ Error ensuring OverDueHistory landOwners populated:", err.message);
  }
}

const getCurrentCycle = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// ✅ NEW — cycles under which THIS bill (rentalDueId) was doc-verified.
// Differs from the bill's own dueDate cycle only when a billing date revert
// moved the bill after it was verified.
const billVerificationCycles = (item, rentalDueId) =>
  new Set(
    (item.agreementDocVerification || [])
      .filter((h) => h.isVerified && h.rentalDueId && h.cycle && String(h.rentalDueId) === String(rentalDueId))
      .map((h) => getCurrentCycle(h.cycle)),
  );

const isBillRedatedAfterVerification = (item, rentalDueId, billCycleStr) => {
  if (!rentalDueId || !billCycleStr) return false;
  for (const c of billVerificationCycles(item, rentalDueId)) {
    if (c !== billCycleStr) return true;
  }
  return false;
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

function computeGstSplit(media, withGst, targetFaceId = null, dueDate = null) {
  // ✅ FIXED — use the rent in force for the entry's due month, so a cycle
  // before an appraisal (e.g. Sep when appraisal starts Oct) keeps the old rent.
  let baseRent = getRentForDueDate(media, dueDate);
  // ✅ CHANGED — GST ratio (same as the rent ratio unless an increase / advance
  // was taken without GST)
  const rentRatio = getGstRatioForDueDate(media, dueDate);

  // ✅ FIXED — resolve the FULL GST from the best available source (Site or Sum of Owners)
  let gstAmountFull = Number(media.rentalPayment?.gstAmount || 0);
  if (gstAmountFull <= 0) {
    gstAmountFull = (media.landOwners || [])
      .filter((o) => Number(o.gstApplicable) === 1)
      .reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
  }
  if (rentRatio !== 1) gstAmountFull = Math.floor(gstAmountFull * rentRatio);

  const billMode = Number((media.landOwners || [])[0]?.agreementBillMode || 1);
  const details = media.mediaDetails || [];

  // Mode 1: Single Amount Agreement — split site totals across faces
  if (billMode === 1 && targetFaceId && details.length > 1) {
    const totalSqFt = details.reduce((sum, d) => sum + (d.totalSqFt || 0), 0);
    const targetFace = details.find((d) => String(d._id) === String(targetFaceId));
    if (totalSqFt > 0 && targetFace) {
      const ratio = (targetFace.totalSqFt || 0) / totalSqFt;
      baseRent = Math.floor(baseRent * ratio);
      gstAmountFull = Math.floor(gstAmountFull * ratio);
    }
  }

  const totalWithGst = baseRent + gstAmountFull;

  if (withGst === 1 || withGst === 0) {
    return {
      baseAmount: totalWithGst,
      gstAmount: gstAmountFull,
      netPayable: baseRent,
    };
  }

  // for withGst === 2 (Direct), we fold it into netPayable
  // BUT we still return the gstAmount for record keeping in the entry
  return {
    baseAmount: totalWithGst,
    gstAmount: gstAmountFull,
    netPayable: totalWithGst,
  };
}


 async function sendRentalDueApprovalMail(media, entry, batchSites = null, extraData = null) {
    try {
      const toMail = process.env.T0_EMail;
      const ccMail = process.env.CC_EMail;
      const mailMode = process.env.MAIL_MODE || "development";

      const formatYMD = (date) => {
        if (!date) return null;
        const d = new Date(date);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().split("T")[0];
      };

      // ✅ NEW — billing dates of the APPROVED BILL's own cycle (due-month
      // based), not the site's latest cycle: Sep bill → last 10.08,
      // current 10.09, next 10.10. Falls back to the site's stored dates
      // only when the bill has no due date.
      const billCycleDates = (site, siteEntry) => {
        const rp = site?.rentalPayment || {};
        const due = siteEntry?.dueDate ? new Date(siteEntry.dueDate) : null;
        if (!due || isNaN(due.getTime())) {
          return {
            lastBillPaidDate: formatYMD(rp.lastBillPaidDate),
            currentBillPaidDate: null,
            nextBillingDate: formatYMD(rp.nextBillingDate),
          };
        }
        const freq = Number(rp.paymentFrequency || 1);
        const cycleMonths = freq === 6 ? Number(rp.customPaymentFrequency) || 1 : FREQUENCY_MONTHS_MAP[freq] || 1;
        return {
          lastBillPaidDate: formatYMD(addMonthsUTC(due, -cycleMonths)),
          currentBillPaidDate: formatYMD(due),
          nextBillingDate: formatYMD(addMonthsUTC(due, cycleMonths)),
        };
      };

      const parseEmailList = (mailStr) => {
        if (!mailStr) return [];
        if (Array.isArray(mailStr)) {
          return mailStr.flatMap((s) => String(s).split(",")).map((e) => e.trim()).filter(Boolean);
        }
        return String(mailStr).split(",").map((e) => e.trim()).filter(Boolean);
      };

      const toArray = parseEmailList(toMail);
      const ccArray = parseEmailList(ccMail);

      // ── GROUPING LOGIC ──
      let sitesInGroupData = (Array.isArray(batchSites) && batchSites.length > 0)
        ? batchSites
        : [{ media, entry }];

      // ✅ FIXED — the same bill approved twice in one batch (same rentalDueId
      // sent twice in entries[]) was listed twice in sites[]. One row per bill.
      {
        const seenBills = new Set();
        sitesInGroupData = sitesInGroupData.filter((item) => {
          const key = item?.entry?._id
            ? String(item.entry._id)
            : `${String(item?.media?._id)}_${String(item?.entry?.mediaDetailId || "")}_${item?.entry?.dueMonth || ""}`;
          if (seenBills.has(key)) return false;
          seenBills.add(key);
          return true;
        });
      }

      // ✅ FIXED — price each site as of its due entry's month, so a cycle
      // before an appraisal (e.g. Sep when appraisal starts Oct) mails the
      // old rent/owner amounts instead of the current post-appraisal ones.
      sitesInGroupData = sitesInGroupData.map((item) => ({
        ...item,
        media: mediaAsOfDate(item.media, item.entry?.dueDate),
      }));

      // ✅ NEW — CMD appraisal hold (POST /admin/appraisal-hold): a held bill is
      // mailed at the rent WITHOUT that month's appraisal (e.g. 52k → 50k);
      // rent, site GST, owner amounts and the bill's own amounts are scaled
      // the same way, and the appraisal block is not sent. Mail payload only.
      sitesInGroupData = sitesInGroupData.map((item) => {
        // ✅ CHANGED — also an earlier month's hold still on (later bill)
        const held = effectiveAppraisalHold(item.media, item.entry);
        const heldRent = Number(held?.rentWithoutAppraisal || 0);
        const pricedRent = Number(item.media?.rentalPayment?.totalRentalAmount || 0);
        if (Number(held?.hold) !== 1 || heldRent <= 0 || pricedRent <= 0) return item;
        if (heldRent === pricedRent) {
          // site amounts already reduced by the hold → only drop the appraisal block
          const plain = typeof item.media.toObject === "function" ? item.media.toObject() : item.media;
          return { ...item, media: { ...plain, appraisal: { ...(plain.appraisal || {}), applicable: 0 } } };
        }
        const ratio = heldRent / pricedRent;
        const scale = (v) => (v === undefined || v === null ? v : Math.round(Number(v) * ratio));
        const base = typeof item.media.toObject === "function" ? item.media.toObject() : item.media;
        const rp = base.rentalPayment || {};
        const entryPlain = typeof item.entry.toObject === "function" ? item.entry.toObject() : item.entry;
        return {
          ...item,
          media: {
            ...base,
            rentalPayment: { ...rp, totalRentalAmount: heldRent, gstAmount: scale(rp.gstAmount), netPayable: scale(rp.netPayable) },
            landOwners: (base.landOwners || []).map((o) => {
              const op = typeof o.toObject === "function" ? o.toObject() : o;
              return {
                ...op,
                shareAmount: scale(op.shareAmount),
                cashAmount: scale(op.cashAmount),
                onlineAmount: scale(op.onlineAmount),
                gstAmount: scale(op.gstAmount),
                tdsAmount: scale(op.tdsAmount),
              };
            }),
            appraisal: { ...(base.appraisal || {}), applicable: 0 }, // → no appraisal block
          },
          entry: {
            ...entryPlain,
            netPayable: scale(entryPlain.netPayable),
            baseAmount: scale(entryPlain.baseAmount),
            gstAmount: scale(entryPlain.gstAmount),
          },
        };
      });

      const buildAppraisalPayload = (siteAppraisal, siteEntry) => {
        if (!siteAppraisal || Number(siteAppraisal.applicable) !== 1) {
          return {};
        }

        // Check if appraisal applies to current month / cycle
        const isCurrentMonthAppraisal = () => {
          const entryDate = siteEntry?.dueDate
            ? new Date(siteEntry.dueDate)
            : siteEntry?.cycle
            ? new Date(siteEntry.cycle)
            : nowIST();

          const entryYear = !isNaN(entryDate.getTime())
            ? entryDate.getFullYear()
            : new Date().getFullYear();
          const entryMonth = !isNaN(entryDate.getTime())
            ? entryDate.getMonth()
            : new Date().getMonth();

          const entryMonthLabel = siteEntry?.dueMonth
            ? String(siteEntry.dueMonth).toLowerCase()
            : "";

          // ✅ FIXED — the appraisal belongs ONLY to the bill whose billing
          // period contains the appraisal month (monthly → that same month;
          // quarterly → the 3 months ending with the due month, etc.).
          // Previously any appraisal dated on/before the bill matched, so a
          // Sep appraisal was mailed again with Oct, Nov, ... bills.
          const entryCycleMonths = (() => {
            const f = Number(siteEntry?.paymentFrequency || 1);
            return f === 6 ? Number(siteEntry?.customPaymentFrequency) || 1 : FREQUENCY_MONTHS_MAP[f] || 1;
          })();
          const entryMonthIndex = entryYear * 12 + entryMonth;

          const checkDateMatch = (dateInput) => {
            if (!dateInput) return false;
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return false;
            if (d.getFullYear() === entryYear && d.getMonth() === entryMonth) {
              return true;
            }
            const appraisalMonthIndex = d.getFullYear() * 12 + d.getMonth();
            if (appraisalMonthIndex <= entryMonthIndex && appraisalMonthIndex > entryMonthIndex - entryCycleMonths) {
              return true;
            }
            if (entryMonthLabel) {
              const monthName = d.toLocaleString("en-US", { month: "long" }).toLowerCase();
              const shortMonthName = d.toLocaleString("en-US", { month: "short" }).toLowerCase();
              const yearStr = String(d.getFullYear());
              if (
                (entryMonthLabel.includes(monthName) || entryMonthLabel.includes(shortMonthName)) &&
                entryMonthLabel.includes(yearStr)
              ) {
                return true;
              }
            }
            return false;
          };

          if (checkDateMatch(siteAppraisal.nextAppraisalDate)) return true;
          if (checkDateMatch(siteAppraisal.lastAppraisalDate)) return true;
          if (checkDateMatch(siteAppraisal.appraisalDate)) return true;
          if (checkDateMatch(siteEntry?.appraisalDate)) return true;

          if (!siteAppraisal.nextAppraisalDate && !siteAppraisal.lastAppraisalDate) {
            return true;
          }

          return false;
        };

        if (!isCurrentMonthAppraisal()) {
          return {};
        }

        const appObj = {
          applicable: 1,
          type: Number(siteAppraisal.type || 1),
        };

        if (Number(siteAppraisal.type) === 1) {
          if (siteAppraisal.percentage !== undefined && siteAppraisal.percentage !== null) {
            appObj.percentage = Number(siteAppraisal.percentage);
          }
        } else if (Number(siteAppraisal.type) === 2) {
          if (siteAppraisal.fixedAmount !== undefined && siteAppraisal.fixedAmount !== null) {
            appObj.fixedAmount = Number(siteAppraisal.fixedAmount);
          }
        }

        appObj.appraisalAmount = Number(siteAppraisal.appraisalAmount || 0);
        if (siteAppraisal.frequency) {
          appObj.frequency = Number(siteAppraisal.frequency);
        }
        if (siteAppraisal.lastAppraisalDate) {
          appObj.lastAppraisalDate = formatYMD(siteAppraisal.lastAppraisalDate);
        }
        if (siteAppraisal.nextAppraisalDate) {
          appObj.nextAppraisalDate = formatYMD(siteAppraisal.nextAppraisalDate);
        }
        appObj.includedInCurrentRent = Number(
          siteAppraisal.includedInCurrentRent !== undefined
            ? siteAppraisal.includedInCurrentRent
            : 1
        );

        return appObj;
      };

      const buildAgreementPayload = (ag) => {
        if (!ag || (!ag.startDate && !ag.endDate)) return null;

        // Agreement Status Mapping for Mail Payload:
        // 3 -> Active (when DB status is 1)
        // 4 -> Expired (when DB status is 3)
        // 5 -> Expired soon (when DB status is 2)
        const rawStatus = Number(ag.status || 1);
        let mappedStatus = 3;
        if (rawStatus === 1) {
          mappedStatus = 3; // 3 -> Active
        } else if (rawStatus === 3) {
          mappedStatus = 4; // 4 -> Expired
        } else if (rawStatus === 2) {
          mappedStatus = 5; // 5 -> Expired soon
        } else {
          mappedStatus = rawStatus;
        }

        return {
          startDate: formatYMD(ag.startDate),
          endDate: formatYMD(ag.endDate),
          reminderBeforeExpiry: Number(ag.reminderBeforeExpiry || 30),
          advanceRent: Number(ag.advanceRent || 0),
          status: mappedStatus,
        };
      };

      const buildLandOwnerObject = (o, siteEntry) => {
        const isGstHold = Number(siteEntry?.withGst) === 1 || Number(o.gstHold) === 1 ? 1 : 0;
        const isTdsHold = Number(siteEntry?.tdsHold) === 1 || Number(o.tdsHold) === 1 ? 1 : 0;
        return {
          name: o.name || "",
          phone: o.phone || "",
          bankName: o.bankName || "",
          ifsc: o.ifsc || "",
          accountNumber: o.accountNumber || "",
          panNumber: o.panNumber || "",
          paymentCategory: Number(o.paymentCategory || 1),
          onlineMode: Number(o.onlineMode || 0),
          shareAmount: Number(o.shareAmount || 0),
          onlineAmount: Number(o.onlineAmount || 0),
          cashAmount: Number(o.cashAmount || 0),
          tdsPercentage: Number(o.tdsPercentage || 0),
          tdsAmount: Number(o.tdsAmount || 0),
          tdsApplicable: Number(o.tdsApplicable || 0),
          gstHold: isGstHold,
          tdsHold: isTdsHold,
          gstApplicable: Number(o.gstApplicable || 0),
          gstAmount: Number(o.gstAmount || 0),
          gstNumber: o.gstNumber || "",
        };
      };

      const extractProofs = (site, siteEntry) => {
        let proofs = [];
        if (siteEntry?.proofOfCampaign?.filePath) {
          proofs.push(siteEntry.proofOfCampaign.filePath);
        } else if (Array.isArray(siteEntry?.proofOfCampaign)) {
          proofs = siteEntry.proofOfCampaign.map((p) => (typeof p === "string" ? p : p.filePath || p.url || p)).filter(Boolean);
        } else if (Array.isArray(siteEntry?.proof_of_campaign)) {
          proofs = siteEntry.proof_of_campaign.filter(Boolean);
        } else if (Array.isArray(site?.proof_of_campaign)) {
          proofs = site.proof_of_campaign.filter(Boolean);
        }
        return proofs;
      };

      const getSiteBillMode = (item) => {
        const s = item.media || {};
        const e = item.entry || {};
        const matchedDetail = (s.mediaDetails || []).find((d) => String(d._id) === String(e.mediaDetailId));

        if (e.billingType === "separate_bill" || e.billingType === "seperate_bill" || s.billingType === "separate_bill" || s.billingType === "seperate_bill") return 2;
        if (Number(e.siteBillMode) === 2 || Number(e.billMode) === 2) return 2;
        if (matchedDetail && (Number(matchedDetail.siteBillMode) === 2 || Number(matchedDetail.billMode) === 2)) return 2;
        if ((s.landOwners || []).some((o) => Number(o.siteBillMode) === 2 || Number(o.landOwnerBillMode) === 2)) return 2;
        if (Number(s.siteBillMode) === 2 || Number(s.billMode) === 2) return 2;

        return 1;
      };

      const getAgreementMode = (item) => {
        const s = item.media || {};
        const e = item.entry || {};
        const matchedDetail = (s.mediaDetails || []).find((d) => String(d._id) === String(e.mediaDetailId));

        if (e.agreementType === "separate_agreement" || s.agreementType === "separate_agreement") return 2;
        if (Number(e.agreementBillMode) === 2) return 2;
        if (matchedDetail && Number(matchedDetail.agreementBillMode) === 2) return 2;
        if ((s.landOwners || []).some((o) => Number(o.agreementBillMode) === 2)) return 2;
        if (Number(s.agreementBillMode) === 2) return 2;

        return 1;
      };

    const isSingleBill = sitesInGroupData.every((item) => getSiteBillMode(item) === 1);
    const isSingleAgreement = sitesInGroupData.every((item) => getAgreementMode(item) === 1);

    const billingType = isSingleBill ? "single_bill" : "seperate_bill";
    const agreementType = isSingleAgreement ? "single_agreement" : "separate_agreement";

    let data = {};

    const firstItem = sitesInGroupData[0];
    const firstSite = firstItem.media;
    const firstEntry = firstItem.entry;
    const firstLandOwners = (firstSite.landOwners || []).map((o) => buildLandOwnerObject(o, firstEntry));

    // Check if Single Site + Single Landlord
    const isSingleSiteSingleLandlord = sitesInGroupData.length === 1 && firstLandOwners.length <= 1;

    if (isSingleSiteSingleLandlord) {
      // ── SINGLE SITE SCENARIO ──
      const item = sitesInGroupData[0];
      const site = item.media;
      const siteEntry = item.entry;

      const activeDetail = (site.mediaDetails || []).find((d) => String(d._id) === String(siteEntry?.mediaDetailId)) || (site.mediaDetails || []).find((d) => Number(d.status) === 1) || site.mediaDetails?.[0] || {};
      const rp = site.rentalPayment || {};
      const ag = site.agreement || {};

      const isGstApplicable = Number(rp.gstApplicable || siteEntry?.gstApplicable || 0) === 1;

      const totalRentalAmountVal = Number(rp.totalRentalAmount || siteEntry?.baseAmount || 0);

      const landownerGstSum = (site.landOwners || [])
        .filter((o) => Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0)
        .reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);

      const siteGstSum = Number(rp.gstAmount || siteEntry?.gstAmount || 0);
      const effectiveGst = landownerGstSum > 0 ? landownerGstSum : (isGstApplicable ? siteGstSum : 0);

      let gstInvoiceUrlVal = "";
      if (siteEntry?.invoice?.filePath) {
        gstInvoiceUrlVal = siteEntry.invoice.filePath;
      } else if (rp.gstInvoiceUrl) {
        gstInvoiceUrlVal = rp.gstInvoiceUrl;
      }

      let gstAmountVal = 0;
      let gstNumberVal = "";
      let gstPercentageVal = Number(rp.gstPercentage || 18);

      if (isGstApplicable) {
        gstAmountVal = siteGstSum > 0 ? siteGstSum : landownerGstSum;
        gstNumberVal = rp.gstNumber || siteEntry?.gstNumber || "";
      }

      let netPayableVal = Number(siteEntry?.netPayable || rp.netPayable || 0);
      const totalExpectedNet = totalRentalAmountVal + effectiveGst;
      if (netPayableVal <= 0 || netPayableVal < totalExpectedNet) {
        netPayableVal = totalExpectedNet;
      }

      const rentalPaymentObj = {
        totalRentalAmount: totalRentalAmountVal,
        gstApplicable: isGstApplicable ? 1 : 0,
        netPayableAmount: netPayableVal,
        gstAmount: gstAmountVal,
        gstNumber: gstNumberVal,
        gstPercentage: gstPercentageVal,
        gstInvoiceUrl: gstInvoiceUrlVal,
      };

      rentalPaymentObj.paymentFrequency = Number(siteEntry?.paymentFrequency || rp.paymentFrequency || 1);
      Object.assign(rentalPaymentObj, billCycleDates(site, siteEntry));

      const landOwnersList = (site.landOwners || []).map((o) => buildLandOwnerObject(o, siteEntry));

      data = {
        billingType: billingType,
        agreementType: agreementType,
        mediaCode: activeDetail.mediaCode || site.mediaCode || site.siteCode || "",
        mediaName: activeDetail.mediaName || site.mediaName || "",
        mediaType: activeDetail.mediaType || site.mediaType || "",
        state: activeDetail.state || site.state || "",
        city: activeDetail.city || site.city || "",
        location: activeDetail.location || site.location || "",
        fullAddress: site.fullAddress || (activeDetail.location ? `${activeDetail.location}, ${activeDetail.city || ""}` : (site.location || "")),
        width: Number(activeDetail.width || site.width || 0),
        height: Number(activeDetail.height || site.height || 0),
        totalSqFt: Number(activeDetail.totalSqFt || site.totalSqFt || 0),
        numberOfLandOwners: landOwnersList.length || Number(site.numberOfLandOwners) || 1,
        status: Number(activeDetail.status || site.status || 1),
        rentalPayment: rentalPaymentObj,
        agreement: buildAgreementPayload(ag),
        appraisal: (() => {
          const app = buildAppraisalPayload(site.appraisal, siteEntry);
          return (app && Object.keys(app).length > 0) ? app : [];
        })(),
        landOwners: landOwnersList,
        proof_of_campaign: extractProofs(site, siteEntry),
      };

    } else {
      // ── SEPARATE AGREEMENT OR MULTIPLE SITES SCENARIO ──
      const firstSite = sitesInGroupData[0].media;

        // Deduplicate parent Media documents for single_bill root calculations
        const parentMediaMap = new Map();
        sitesInGroupData.forEach((item) => {
          const mId = String(item.media._id);
          if (!parentMediaMap.has(mId)) {
            parentMediaMap.set(mId, item);
          }
        });
        const uniqueParentMedias = Array.from(parentMediaMap.values());

        const itemsForTotals = isSingleBill ? uniqueParentMedias : sitesInGroupData;

        const ownersMap = new Map();
        const ownerSiteBreakdownMap = new Map();

        itemsForTotals.forEach((item) => {
          const site = item.media;
          const siteEntry = item.entry;
          const activeDetail = (site.mediaDetails || []).find((d) => String(d._id) === String(siteEntry?.mediaDetailId)) || (site.mediaDetails || []).find((d) => Number(d.status) === 1) || site.mediaDetails?.[0] || {};
          const siteCode = activeDetail.mediaCode || site.mediaCode || site.siteCode || "";

          (site.landOwners || []).forEach((o) => {
            const key = String(o.landOwnerMasterId || o._id || o.name);
            if (!ownersMap.has(key)) {
              ownersMap.set(key, {
                obj: {
                  ...(o.toObject ? o.toObject() : o),
                  shareAmount: Number(o.shareAmount || 0),
                  onlineAmount: Number(o.onlineAmount || 0),
                  cashAmount: Number(o.cashAmount || 0),
                  tdsAmount: Number(o.tdsAmount || 0),
                  gstAmount: Number(o.gstAmount || 0),
                },
                siteEntry: siteEntry,
              });
            } else {
              const existingObj = ownersMap.get(key).obj;
              existingObj.shareAmount = Number(existingObj.shareAmount || 0) + Number(o.shareAmount || 0);
              existingObj.onlineAmount = Number(existingObj.onlineAmount || 0) + Number(o.onlineAmount || 0);
              existingObj.cashAmount = Number(existingObj.cashAmount || 0) + Number(o.cashAmount || 0);
              existingObj.tdsAmount = Number(existingObj.tdsAmount || 0) + Number(o.tdsAmount || 0);
              existingObj.gstAmount = Number(existingObj.gstAmount || 0) + Number(o.gstAmount || 0);
            }

            if (!ownerSiteBreakdownMap.has(key)) {
              ownerSiteBreakdownMap.set(key, []);
            }
            ownerSiteBreakdownMap.get(key).push({
              mediaCode: siteCode,
              shareAmount: Number(o.shareAmount || 0),
              onlineAmount: Number(o.onlineAmount || 0),
              cashAmount: Number(o.cashAmount || 0),
            });
          });
        });

        const rootLandOwners = [];
        ownersMap.forEach((val, key) => {
          const loObj = buildLandOwnerObject(val.obj, val.siteEntry);
          const breakdown = ownerSiteBreakdownMap.get(key) || [];
          if (!isSingleBill && breakdown.length > 1) {
            loObj.siteRentBreakdown = breakdown;
          }
          rootLandOwners.push(loObj);
        });

        // Calculate root rental payment totals for single_bill using itemsForTotals
        const totalRentalSum = itemsForTotals.reduce((sum, item) => sum + Number(item.media.rentalPayment?.totalRentalAmount || item.entry?.baseAmount || 0), 0);
        const totalGstSum = itemsForTotals.reduce((sum, item) => {
          const rp = item.media.rentalPayment || {};
          const isSiteGstOn = Number(rp.gstApplicable || item.entry?.gstApplicable || 0) === 1;
          const siteGst = Number(rp.gstAmount || item.entry?.gstAmount || 0);
          const ownerGst = (item.media.landOwners || [])
            .filter((o) => Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0)
            .reduce((s, o) => s + Number(o.gstAmount || 0), 0);
          const effectiveGst = ownerGst > 0 ? ownerGst : (isSiteGstOn ? siteGst : 0);
          return sum + effectiveGst;
        }, 0);

        const totalNetPayableSum = itemsForTotals.reduce((sum, item) => {
          const siteEntry = item.entry || {};
          const rp = item.media?.rentalPayment || {};
          const net = Number(siteEntry.netPayable || rp.netPayable || 0);
          if (net > 0 && !isSingleBill) return sum + net;
          const rent = Number(rp.totalRentalAmount || siteEntry.baseAmount || 0);
          const isSiteGstOn = Number(rp.gstApplicable || siteEntry.gstApplicable || 0) === 1;
          const siteGst = Number(rp.gstAmount || siteEntry.gstAmount || 0);
          const ownerGst = (item.media?.landOwners || [])
            .filter((o) => Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0)
            .reduce((s, o) => s + Number(o.gstAmount || 0), 0);
          const effectiveGst = ownerGst > 0 ? ownerGst : (isSiteGstOn ? siteGst : 0);
          return sum + rent + effectiveGst;
        }, 0);

        const anySiteGstApplicable = itemsForTotals.some((item) =>
          Number(item.media?.rentalPayment?.gstApplicable || item.entry?.gstApplicable || 0) === 1 ||
          (item.media?.landOwners || []).some((o) => Number(o.gstApplicable) === 1)
        );

        const rootGstInvoiceUrl = itemsForTotals
          .map((item) => item.entry?.invoice?.filePath || item.media?.rentalPayment?.gstInvoiceUrl)
          .find(Boolean) || "";

        const rootRentalPaymentObj = {
          totalRentalAmount: totalRentalSum || Number(firstSite.rentalPayment?.totalRentalAmount || 0),
          gstApplicable: anySiteGstApplicable ? 1 : 0,
          gstAmount: anySiteGstApplicable ? totalGstSum : 0,
          gstNumber: firstSite.rentalPayment?.gstNumber || sitesInGroupData[0]?.entry?.gstNumber || "",
          gstInvoiceUrl: rootGstInvoiceUrl,
          netPayableAmount: totalNetPayableSum || (totalRentalSum + totalGstSum),
          paymentFrequency: Number(sitesInGroupData[0]?.entry?.paymentFrequency || firstSite.rentalPayment?.paymentFrequency || 1),
          ...billCycleDates(firstSite, sitesInGroupData[0]?.entry),
        };

        const sitesPayload = sitesInGroupData.map((item) => {
          const site = item.media;
          const siteEntry = item.entry;
          const activeDetail = (site.mediaDetails || []).find((d) => String(d._id) === String(siteEntry?.mediaDetailId)) || (site.mediaDetails || []).find((d) => Number(d.status) === 1) || site.mediaDetails?.[0] || {};
          const rp = site.rentalPayment || {};
          const ag = site.agreement || {};

          const siteObj = {
            mediaCode: activeDetail.mediaCode || site.mediaCode || site.siteCode || "",
            mediaName: activeDetail.mediaName || site.mediaName || "",
          };

          if (activeDetail.location || site.location) {
            siteObj.location = activeDetail.location || site.location;
          }

          if (!isSingleBill || !isSingleAgreement) {
            const isGstApplicable = Number(rp.gstApplicable || siteEntry?.gstApplicable || 0) === 1;

            const siteTotalRentalVal = Number(rp.totalRentalAmount || siteEntry?.baseAmount || 0);

            const siteLandownerGstSum = (site.landOwners || [])
              .filter((o) => Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0)
              .reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);

            let siteGstAmountVal = 0;
            let siteGstPercentageVal = Number(rp.gstPercentage || 18);
            const siteGstInvoiceUrlVal = siteEntry?.invoice?.filePath || rp.gstInvoiceUrl || "";

            if (isGstApplicable) {
              siteGstAmountVal = Number(rp.gstAmount || siteEntry?.gstAmount || siteLandownerGstSum || 0);
            }

            let siteNetPayableVal = Number(siteEntry?.netPayable || rp.netPayable || 0);
            const siteTotalExpectedNet = siteTotalRentalVal + (isGstApplicable ? siteGstAmountVal : siteLandownerGstSum);
            if (siteNetPayableVal <= 0 || siteNetPayableVal < siteTotalExpectedNet) {
              siteNetPayableVal = siteTotalExpectedNet;
            }

            const siteRentalPayment = {
              totalRentalAmount: siteTotalRentalVal,
              netPayableAmount: siteNetPayableVal,
              paymentFrequency: Number(siteEntry?.paymentFrequency || rp.paymentFrequency || 1),
            };

            if (isGstApplicable || !isSingleBill) {
              siteRentalPayment.gstApplicable = isGstApplicable ? 1 : 0;
            }

            if (isGstApplicable) {
              siteRentalPayment.gstAmount = siteGstAmountVal;
              siteRentalPayment.gstPercentage = siteGstPercentageVal;
            }
            if (siteGstInvoiceUrlVal) {
              siteRentalPayment.gstInvoiceUrl = siteGstInvoiceUrlVal;
            }

            const siteCycleDates = billCycleDates(site, siteEntry);
            if (siteCycleDates.lastBillPaidDate) {
              siteRentalPayment.lastBillPaidDate = siteCycleDates.lastBillPaidDate;
            }
            if (siteCycleDates.currentBillPaidDate) {
              siteRentalPayment.currentBillPaidDate = siteCycleDates.currentBillPaidDate;
            }
            if (siteCycleDates.nextBillingDate) {
              siteRentalPayment.nextBillingDate = siteCycleDates.nextBillingDate;
            }

            siteObj.rentalPayment = siteRentalPayment;

            const agPayload = buildAgreementPayload(ag);
            if (agPayload) {
              siteObj.agreement = agPayload;
            }

            const siteAppraisalPayload = buildAppraisalPayload(site.appraisal, siteEntry);
            siteObj.appraisal = (siteAppraisalPayload && Object.keys(siteAppraisalPayload).length > 0) ? siteAppraisalPayload : [];
          }

          siteObj.proof_of_campaign = extractProofs(site, siteEntry);

          return siteObj;
        });

        data = {
          billingType: billingType,
          agreementType: agreementType,
        };

        if (agreementType === "separate_agreement" || rootLandOwners.length > 1) {
          data.numberOfLandOwners = rootLandOwners.length || Number(firstSite.numberOfLandOwners) || 1;
        }

        if (isSingleBill) {
          if (isSingleAgreement || sitesInGroupData.length === 1) {
            data.rentalPayment = rootRentalPaymentObj;
            const mainAg = buildAgreementPayload(firstSite.agreement);
            if (mainAg) {
              data.agreement = mainAg;
            }
            const mainAppraisal = buildAppraisalPayload(firstSite.appraisal, firstEntry);
            if (mainAppraisal && Object.keys(mainAppraisal).length > 0) {
              data.appraisal = mainAppraisal;
            }
          }
        } else {
          if (isSingleAgreement || sitesInGroupData.length === 1) {
            const mainAg = buildAgreementPayload(firstSite.agreement);
            if (mainAg) {
              data.agreement = mainAg;
            }
            const mainAppraisal = buildAppraisalPayload(firstSite.appraisal, firstEntry);
            if (mainAppraisal && Object.keys(mainAppraisal).length > 0) {
              data.appraisal = mainAppraisal;
            }
          }
        }

        data.landOwners = rootLandOwners;
        data.sites = sitesPayload;
      }

      // ✅ NEW — extra blocks added to data (e.g. rentRevision for an arrears bill mail)
      if (extraData && typeof extraData === "object") Object.assign(data, extraData);

      const mailPayload = {
        mailtype: "cmdapproval",
        to: toArray,
        data: data,
      };

      if (ccArray.length > 0) {
        mailPayload.cc = ccArray;
      }

      console.log(
        "📧 RENTAL DUE MAIL PAYLOAD:",
        JSON.stringify(mailPayload, null, 2)
      );

      if (mailMode !== "production") {
        console.log(
          `📭 MAIL_MODE="${mailMode}" — skipping live mail API call. Payload logged above only.`
        );
        return {
          mailtype: "cmdapproval",
          to: toArray,
          ...(ccArray.length > 0 ? { cc: ccArray } : {}),
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
        { headers: { "Content-Type": "application/json" } }
      );

      console.log("📬 RENTAL DUE MAIL PRODUCTION RESPONSE:", response.data);

      const isMailSuccess =
        response.data &&
        (response.data.success === true ||
          response.data.status === "success" ||
          response.status === 200);

      return {
        mailtype: "cmdapproval",
        to: toArray,
        ...(ccArray.length > 0 ? { cc: ccArray } : {}),
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
        mailErr?.message || mailErr
      );
      return {
        mailtype: "cmdapproval",
        to: parseEmailList(process.env.T0_EMail),
        cc: parseEmailList(process.env.CC_EMail),
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

  const billMode = Number((media.landOwners || [])[0]?.agreementBillMode || 1);

  // ✅ FIXED — for Mode 1 (Single Amount Agreement), only add the site-level GST once per month.
  // Check if ANY entry for this dueMonth already exists in history.
  const existsForMonth = (media.gstBalanceHistory || []).some(
    (g) => g.dueMonth === entry.dueMonth
  );

  if (billMode === 1 && existsForMonth) {
    entry.gstAddedToBalance = true;
    return;
  }

  if (entry?.withGst === 1) {
    // Resolve the full site GST if entry amount is split
    const split = computeGstSplit(media, entry.withGst, null, entry.dueDate); // passing null faceId gets full site total
    const fullGst = split.gstAmount;

    if (fullGst > 0) {
      if (!Array.isArray(media.gstBalanceHistory)) {
        media.gstBalanceHistory = [];
      }

      media.gstBalanceHistory.push({
        rentalDueId: entry._id,
        dueMonth: entry.dueMonth,
        cycle: entry.dueDate,
        gstAmount: fullGst,
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
}

function addOwnerGstToBalanceIfApplicable(media, entry, userName) {
  if (entry.ownerGstAddedToBalance) return;
  if (entry.withGst !== 1) return;
  if (!Array.isArray(media.landOwners) || media.landOwners.length === 0) return;

  if (!Array.isArray(media.gstBalanceHistory)) {
    media.gstBalanceHistory = [];
  }

  const billMode = Number((media.landOwners || [])[0]?.agreementBillMode || 1);
  const ownerRowsToAdd = [];

  media.landOwners.forEach((owner) => {
    const ownerGstApplicable = Number(owner.gstApplicable || 0);
    const ownerGstAmount = Number(owner.gstAmount || 0);

    if (ownerGstApplicable === 1 && ownerGstAmount > 0) {
      // ✅ FIXED — for Mode 1 (Single Amount Agreement), only add each owner's GST once per month.
      const alreadyExists = (media.gstBalanceHistory || []).some(
        (g) => g.dueMonth === entry.dueMonth && String(g.ownerId || g.landOwnerId) === String(owner._id)
      );

      if (billMode === 1 && alreadyExists) return;

      ownerRowsToAdd.push({
        rentalDueId: entry._id,
        dueMonth: entry.dueMonth,
        cycle: entry.dueDate,
        gstAmount: ownerGstAmount, // Full owner GST (not split)
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
    }
  });

  if (ownerRowsToAdd.length > 0) {
    // If Mode 1, we might be replacing a site-level placeholder that was added by the same OR different face.
    const placeholderFilter = (g) => g.dueMonth === entry.dueMonth && g.source === "rental" && !g.ownerId;

    if (media.gstBalanceHistory.some(placeholderFilter)) {
      media.gstBalanceHistory = media.gstBalanceHistory.filter((g) => !placeholderFilter(g));
    }

    media.gstBalanceHistory.push(...ownerRowsToAdd);
    media.markModified("gstBalanceHistory");
    entry.ownerGstAddedToBalance = true;
    entry.gstAddedToBalance = true;
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

function applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag, pastgstApplicableFlag) {
  let resolvedFlag = Number(gstApplicableFlag) || 0;

  // ✅ AUTO-INFER if 0
  if (resolvedFlag === 0 && (Number(media.gstApplicableFlag) || 0) === 0) {
    const siteGst = Number(media.rentalPayment?.gstApplicable) === 1;
    const ownerGst = (media.landOwners || []).some((o) => Number(o.gstApplicable) === 1);
    if (ownerGst || siteGst) resolvedFlag = 2;
  }

  if ([0, 1, 2].includes(resolvedFlag)) {
    media.gstApplicableFlag = resolvedFlag;
  }

  const parsedPastFlag = Number(pastgstApplicableFlag);
  if ([0, 1, 2].includes(parsedPastFlag)) {
    media.pastgstApplicableFlag = parsedPastFlag;
  }
}

const resolveGstApplicable = (item, entryGstFlag, entryPastFlag) => {
  let flag =
    entryGstFlag !== undefined && entryGstFlag !== null && Number(entryGstFlag) !== 0
      ? Number(entryGstFlag)
      : Number(item.gstApplicableFlag) || 0;

  const pastgstApplicableFlag =
    entryPastFlag !== undefined && entryPastFlag !== null && Number(entryPastFlag) !== 0
      ? Number(entryPastFlag)
      : Number(item.pastgstApplicableFlag) || 0;

  // ✅ FIXED — Default to 2 if GST is present anywhere
  if (flag === 0) {
    const siteGst = Number(item.rentalPayment?.gstApplicable) === 1;
    const ownerGst = (item.landOwners || []).some((o) => Number(o.gstApplicable) === 1);
    if (ownerGst || siteGst) flag = 2;
  }

  if (flag === 0) {
    return {
      gstApplicableFlag: 0,
      pastgstApplicableFlag,
      source: null,
      gstApplicable: 0,
      message:
        "GST source not yet determined — Owner has not set gstApplicableFlag",
    };
  }

  if (flag === 1) {
    return {
      gstApplicableFlag: flag,
      pastgstApplicableFlag,
      source: "rentalPayment",
      gstApplicable: Number(item.rentalPayment?.gstApplicable) || 0,
      gstPercentage: item.rentalPayment?.gstPercentage || 0,
      gstAmount: item.rentalPayment?.gstAmount || 0,
    };
  }

  // Flag is 2
  const gstOwners = (item.landOwners || []).filter(
    (o) => Number(o.gstApplicable) === 1,
  );

  if (gstOwners.length > 0) {
    return {
      gstApplicableFlag: flag,
      pastgstApplicableFlag,
      source: "landOwners",
      gstApplicable: 1,
      owners: gstOwners.map((o) => ({
        ownerId: o._id,
        ownerName: o.name,
        gstApplicable: Number(o.gstApplicable) || 0,
        gstPercentage: o.gstPercentage || 0,
        gstAmount: o.gstAmount || 0,
      })),
    };
  }

  // Fallback for flag 2 if owners don't have GST but site does
  return {
    gstApplicableFlag: flag,
    pastgstApplicableFlag,
    source: "rentalPayment",
    gstApplicable: Number(item.rentalPayment?.gstApplicable) || 0,
    gstPercentage: item.rentalPayment?.gstPercentage || 0,
    gstAmount: item.rentalPayment?.gstAmount || 0,
  };
};

const ROLE_RANK = {
  [ROLE.STAFF]: 1,
  [ROLE.TEAM_LEAD]: 2,
  [ROLE.OWNER]: 3,
};

function saveVerificationProgressSnapshot(media, cycle, progress, userName, rentalDueId) {
  if (!Array.isArray(media.verificationProgressHistory)) {
    media.verificationProgressHistory = [];
  }

  const snapshot = {
    cycle,
    rentalDueId: rentalDueId || null, // ✅ ADDED
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

// ═════════════════════════════════════════════════════════════
// NEW — per-site "core" processors. Each takes an already-fetched
// `media` document + the request params for ONE site, does exactly
// what the old single-site logic did, and RETURNS a result object
// instead of writing the HTTP response directly. The exported
// controllers below call these once (old single-body request) or in
// a loop (new array-body request).
// ═════════════════════════════════════════════════════════════

// ✅ INTERNAL HELPER for processing updates on a PRE-LOADED media document

// ── saveRentalDue — one site ───────────────────────────────────
// ✅ INTERNAL HELPER for processing updates on a PRE-LOADED media document
async function processSingleRentalDueInternal({
  media,
  rentalDueId,
  mediaDetailId,
  campaignName,
  reason,
  withGst,
  gstApplicableFlag,
  pastgstApplicableFlag: requestedPastFlag,
  proofOfCampaign,
  invoice,
  userType,
  userId,
  userName,
  changeLog, // ✅ NEW — optional array; receives campaignName/reason/proof/invoice changes
  campaignStatus, // ✅ NEW — 0 / 1; not sent → the saved value is kept
}) {
  const mediaId = media._id;

  const pendingEntry = (media.rentalDue || []).find(
    (d) => String(d._id) === String(rentalDueId),
  );

  if (!pendingEntry) {
    return { success: false, mediaId, message: "Rental due entry not found" };
  }
  // ✅ NEW — campaignStatus: only 0 or 1 (not sent / "" → unchanged)
  const hasCampaignStatus = campaignStatus !== undefined && campaignStatus !== null && campaignStatus !== "";
  if (hasCampaignStatus && ![0, 1].includes(Number(campaignStatus))) {
    return { success: false, mediaId, message: "campaignStatus must be 0 or 1" };
  }

  const entry = pendingEntry;
  ensureApprovalStepsPopulated(entry);

  const chain = FLOW_CHAIN[entry.approvalFlow] || FLOW_CHAIN[1];
  const isOwnerOverride =
    userType === ROLE.OWNER && entry.currentPendingRole !== ROLE.OWNER;
  const isTeamLeadOverride =
    userType === ROLE.TEAM_LEAD && entry.currentPendingRole === ROLE.STAFF;
  const isStaffOrTeamLead = userType === ROLE.STAFF || userType === ROLE.TEAM_LEAD;

  if (!isOwnerOverride && !isStaffOrTeamLead && userType !== entry.currentPendingRole) {
    return {
      success: false,
      mediaId,
      message: `It's not your turn to approve. Waiting on ${ROLE_LABEL[entry.currentPendingRole] || "N/A"}`,
    };
  }

  // ✅ NEW — capture old → new BEFORE the values are applied (rental due history)
  if (Array.isArray(changeLog)) {
    changeLog.push(...collectRentalDueChanges(entry, { campaignName, reason, proofOfCampaign, invoice }));
  }

  if (campaignName) entry.campaignName = campaignName;
  if (reason) entry.reason = reason;
  if (proofOfCampaign) entry.proofOfCampaign = proofOfCampaign;
  if (invoice) entry.invoice = invoice;
  if (hasCampaignStatus) entry.campaignStatus = Number(campaignStatus); // ✅ NEW
  // ✅ NEW — saved for real → its "Save as Draft" values are cleared
  if (entry.draft && Number(entry.draft.isDraft) === 1) entry.draft = { isDraft: 0 };

  // ✅ AUTO-INFER gstApplicableFlag
  let resolvedUpdateFlag = gstApplicableFlag !== undefined ? Number(gstApplicableFlag) : Number(entry.gstApplicableFlag || 0);
  if (resolvedUpdateFlag === 0) {
    const siteGst = Number(media.rentalPayment?.gstApplicable) === 1;
    const anyOwnerGst = (media.landOwners || []).some((o) => Number(o.gstApplicable) === 1);
    if (anyOwnerGst || siteGst) resolvedUpdateFlag = 2;
  }
  if ([0, 1, 2].includes(resolvedUpdateFlag)) {
    entry.gstApplicableFlag = resolvedUpdateFlag;
    if (gstApplicableFlag !== undefined || (Number(media.gstApplicableFlag) || 0) === 0) {
        media.gstApplicableFlag = resolvedUpdateFlag;
    }
  }

  if (requestedPastFlag !== undefined && requestedPastFlag !== null && requestedPastFlag !== "") {
    const parsedPast = Number(requestedPastFlag);
    if ([0, 1, 2].includes(parsedPast)) {
      entry.pastgstApplicableFlag = parsedPast;
      media.pastgstApplicableFlag = parsedPast;
      media.markModified("pastgstApplicableFlag");
    }
  } else if ((!entry.pastgstApplicableFlag || entry.pastgstApplicableFlag === 0) && media.pastgstApplicableFlag) {
    entry.pastgstApplicableFlag = media.pastgstApplicableFlag;
  }

  if ([0, 1, 2].includes(Number(withGst)) && withGst !== undefined && withGst !== null && withGst !== "") {
    const newWithGst = Number(withGst);
    if (entry.withGst !== newWithGst || (!entry.gstAmount && newWithGst > 0)) {
      entry.withGst = newWithGst;
      if (newWithGst > 0) {
        entry.gstApplicableFlag = newWithGst;
        media.gstApplicableFlag = newWithGst;
      }
      const recomputedSplit = computeGstSplit(media, newWithGst, entry.mediaDetailId, entry.dueDate);
      entry.gstAmount = Number(recomputedSplit.gstAmount) || 0;
      entry.baseAmount = Number(recomputedSplit.baseAmount) || 0;
      entry.netPayable = Number(recomputedSplit.netPayable) || 0;
    }
  }

  if (!entry.savedBy?.userId && entry.savedBy?.userName === "System (auto-generated)") {
    entry.savedBy = { userId, userName, role: userType, savedAt: nowIST() };
  }

  // ✅ NEW — a Rental Executive / Manager saving again AFTER their own approval
  // (not their turn, e.g. Executive re-saves after the Manager approved) and
  // before CMD's final approval: refresh their own step's approvedAt to this
  // save. Only that step's time / user change — status, turn and the other
  // roles' steps stay as they are.
  let lateSkippedStepApproved = false; // ✅ NEW — see below
  if (
    isStaffOrTeamLead &&
    !isTeamLeadOverride &&
    userType !== entry.currentPendingRole &&
    Number(entry.approvalStatus) !== 3
  ) {
    const ownApprovedStep = (entry.approvalSteps || []).find((s) => s.role === userType && s.status === 2);
    if (ownApprovedStep) {
      ownApprovedStep.approvedAt = nowIST();
      ownApprovedStep.userId = userId;
      ownApprovedStep.userName = userName;
    }
    // ✅ NEW — the role's step was SKIPPED (e.g. Manager approved first →
    // Executive "Skipped — approved directly by Team Lead") and that role now
    // approves: record it as approved by them. The turn (e.g. still CMD) and
    // the other roles' steps stay as they are.
    const ownSkippedStep = !ownApprovedStep
      ? (entry.approvalSteps || []).find((s) => s.role === userType && s.status === 3)
      : null;
    if (ownSkippedStep) {
      ownSkippedStep.status = 2;
      ownSkippedStep.userId = userId;
      ownSkippedStep.userName = userName;
      ownSkippedStep.approvedAt = nowIST();
      ownSkippedStep.docVerified = true;
      ownSkippedStep.remarks = "";
      lateSkippedStepApproved = true;
    }
  }

  if (isOwnerOverride || isTeamLeadOverride || userType === entry.currentPendingRole) {
    if (isOwnerOverride) {
      entry.approvalSteps.forEach((step) => {
        if (step.status === 1) {
          if (step.role === ROLE.OWNER) {
            step.status = 2;
            step.userId = userId;
            step.userName = userName;
            step.approvedAt = nowIST();
            step.docVerified = true;
          } else {
            step.status = 3;
            step.remarks = "Skipped — owner approved directly";
          }
        }
      });
      entry.approvalStatus = 3;
      entry.status = 3;
      entry.currentPendingRole = null;
      entry.agreementDocVerified = true;
      entry.ownerApprovalDate = nowIST();
      media.rentalStatus = RENTAL_STATUS_MAP[ROLE.OWNER];
    } else if (isTeamLeadOverride) {
      entry.approvalSteps.forEach((step) => {
        if (step.status === 1) {
          if (step.role === ROLE.TEAM_LEAD) {
            step.status = 2;
            step.userId = userId;
            step.userName = userName;
            step.approvedAt = nowIST();
            step.docVerified = true;
          } else if (step.role === ROLE.STAFF) {
            step.status = 3;
            step.remarks = "Skipped — approved directly by Team Lead";
          }
        }
      });
      const roleIndex = chain.indexOf(ROLE.TEAM_LEAD);
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
      }
      media.rentalStatus = RENTAL_STATUS_MAP[ROLE.TEAM_LEAD];
    } else {
      const step = entry.approvalSteps.find((s) => s.role === userType && s.status === 1);
      if (step) {
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
          if (userType === ROLE.OWNER) entry.ownerApprovalDate = nowIST();
        }
        media.rentalStatus = RENTAL_STATUS_MAP[userType];
      }
    }

    await saveOverDueHistoryIfApplicable(media, entry, userName);

    if (entry.approvalStatus === 3) {
      applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag, requestedPastFlag);
      addGstToBalanceIfApplicable(media, entry, userName);
      addOwnerGstToBalanceIfApplicable(media, entry, userName);
      resetLiveAgreementFlags(media);
      if (Array.isArray(media.ledger)) media.ledger = [];
      media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
    }
  }

  media.markModified("rentalDue");
  entry.updatedBy = userName;
  entry.updatedAt = nowIST();

  const yearLabel = getYearLabel(entry.dueDate);
  const monthLabel = getMonthLabel(entry.dueDate);
  const yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
  const monthBucket = yearBucket?.months.find((m) => m.month === monthLabel);
  const historyRecord = monthBucket?.entries.find((e) => String(e.rentalDueId) === String(entry._id));
  if (historyRecord) {
    historyRecord.approvalStatus = entry.approvalStatus;
    historyRecord.campaignName = entry.campaignName;
    historyRecord.updatedAt = nowIST();
    historyRecord.updatedBy = userName;
    media.markModified("rentalDueHistory");
  }

  const resGst = resolveGstApplicable(media, entry.gstApplicableFlag, entry.pastgstApplicableFlag);

  const internalResult = {
    success: true,
    mediaId,
    mediaName: media.mediaName,
    rentalDueId: entry._id,
    approvalStatus: entry.approvalStatus,
    campaignStatus: entry.campaignStatus ?? null, // ✅ NEW
    entryDoc: entry,
    gstApplicableFlag: resGst.gstApplicableFlag,
    pastgstApplicableFlag: resGst.pastgstApplicableFlag,
    gstApplicableDisplay: resGst,
  };
  // ✅ NEW — internal only (not in the JSON response): a skipped step approved
  // late; callers skip the "approved → awaiting next role" notifications for it
  Object.defineProperty(internalResult, "lateApproval", { value: lateSkippedStepApproved, enumerable: false });
  return internalResult;
}

// ── saveRentalDue — one site ───────────────────────────────────
async function processSingleRentalDue({
  mediaId,
  rentalDueId,
  mediaDetailId,
  campaignName,
  reason,
  withGst,
  gstApplicableFlag,
  pastgstApplicableFlag: requestedPastFlag,
  proofOfCampaign,
  invoice,
  userType,
  userId,
  userName,
  skipMail = false,
  campaignStatus, // ✅ NEW
}) {
  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

  await generateMissedEntriesForMedia(media, userName);

  if (rentalDueId) {
    // ✅ NEW — snapshot before processing, to detect an approval made in this request
    const roleStepWasApproved = isRoleStepApproved(findRentalDueEntryById(media, rentalDueId), userType);
    const changeLog = []; // ✅ NEW — rental due history

    const result = await processSingleRentalDueInternal({
      media,
      rentalDueId,
      mediaDetailId,
      campaignName,
      reason,
      withGst,
      gstApplicableFlag,
      pastgstApplicableFlag: requestedPastFlag,
      proofOfCampaign,
      invoice,
      userType,
      userId,
      userName,
      changeLog,
      campaignStatus, // ✅ NEW
    });

    if (result.success) {
      await media.save({ timestamps: false });
      // ✅ NEW — rental due history, only after the save succeeded
      recordRentalDueChanges({ media, entry: result.entryDoc, changes: changeLog, userId, userName, userType });
      if (!skipMail && userType === ROLE.OWNER && result.approvalStatus === 3) {
        const mailRes = await sendRentalDueApprovalMail(media, result.entryDoc);
        result.entryDoc.mailSent = !!mailRes.sent;
        await media.save({ timestamps: false });
      }
      // ✅ NEW — CMD notification after a saved Rental Executive / Manager approval
      // (✅ NEW — not for a late approval of a skipped step: the bill already moved on)
      if (isApprovalNotifyRole(userType) && !roleStepWasApproved && isRoleStepApproved(result.entryDoc, userType) && !result.lateApproval) {
        await createRentalApprovalNotification({ media, entry: result.entryDoc, userType, userId, userName });
      }
      // ✅ NEW — Google Chat message for an approval made in this request (any role)
      if (!roleStepWasApproved && isRoleStepApproved(result.entryDoc, userType) && !result.lateApproval) {
        notifyRentalDueChat({ media, entry: result.entryDoc, userType, userName, action: "approved" });
      }
    }
    return result;
  }

  // ── BRANCH 2: CREATE ──
  if (Number(media.status) !== 1) {
    return { success: false, mediaId, message: "This site is Inactive" };
  }
  if (!campaignName) {
    return { success: false, mediaId, message: "campaignName is required" };
  }

  const dueDateObj = media.rentalPayment?.nextBillingDate ? new Date(media.rentalPayment.nextBillingDate) : new Date();
  const chainSteps = buildApprovalSteps(2);
  const steps = [{ role: ROLE.STAFF, userId: null, userName: "", approvedAt: null, status: 1, docVerified: false, remarks: "" }, ...chainSteps];

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
      } else {
        step.status = 3;
        step.remarks = "Skipped — owner approved directly";
      }
    });
  } else if (isTeamLeadCreating) {
    staffStep.status = 3;
    const teamLeadStep = steps.find((s) => s.role === ROLE.TEAM_LEAD);
    teamLeadStep.status = 2;
    teamLeadStep.userId = userId;
    teamLeadStep.userName = userName;
    teamLeadStep.approvedAt = nowIST();
    teamLeadStep.docVerified = true;
  } else {
    staffStep.status = 2;
    staffStep.userId = userId;
    staffStep.userName = userName;
    staffStep.approvedAt = nowIST();
  }

  const nextPendingStep = steps.find((s) => s.status === 1);
  const allApproved = !nextPendingStep;
  const resolvedWithGst = [0, 1, 2].includes(Number(withGst)) ? Number(withGst) : 0;
  const gstSplit = computeGstSplit(media, resolvedWithGst, null, dueDateObj);

  const newEntry = {
    dueMonth: getDueMonthLabel(dueDateObj),
    dueDate: dueDateObj,
    netPayable: Number(gstSplit.netPayable) || 0,
    paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
    customPaymentFrequency: media.rentalPayment?.paymentFrequency === 6 ? media.rentalPayment?.customPaymentFrequency || 1 : undefined,
    ownerApprovalDate: isOwnerOverride ? nowIST() : null,
    campaignName,
    reason,
    proofOfCampaign,
    invoice,
    savedBy: { userId, userName, role: userType, savedAt: nowIST() },
    approvalSteps: steps,
    approvalStatus: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
    currentPendingRole: nextPendingStep ? nextPendingStep.role : null,
    agreementDocVerified: allApproved,
    status: allApproved ? 3 : isTeamLeadCreating ? 2 : 1,
    withGst: resolvedWithGst,
    gstApplicableFlag: resolvedWithGst,
    pastgstApplicableFlag: Number(requestedPastFlag) || 0,
    gstAmount: Number(gstSplit.gstAmount) || 0,
    baseAmount: Number(gstSplit.baseAmount) || 0,
    updatedBy: userName,
    updatedAt: nowIST(),
  };

  const { result: atomicResult, action: atomicAction } = await atomicallyEnsureOrUpdateRentalDueEntry(media._id, newEntry);
  if (atomicResult) {
    media.rentalDue = atomicResult.rentalDue;
    const savedEntry = media.rentalDue[media.rentalDue.length - 1];
    media.rentalStatus = RENTAL_STATUS_MAP[userType];

    if (isOwnerOverride) {
      applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag, requestedPastFlag);
      await saveOverDueHistoryIfApplicable(media, savedEntry, userName);
      addGstToBalanceIfApplicable(media, savedEntry, userName);
      addOwnerGstToBalanceIfApplicable(media, savedEntry, userName);
      resetLiveAgreementFlags(media);
      if (Array.isArray(media.ledger)) media.ledger = [];
      media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
    }

    if (requestedPastFlag !== undefined && requestedPastFlag !== null && requestedPastFlag !== "") {
      const parsedPast = Number(requestedPastFlag);
      if ([0, 1, 2].includes(parsedPast)) {
        media.pastgstApplicableFlag = parsedPast;
      }
    }

    const yearLabel = getYearLabel(dueDateObj);
    const monthLabel = getMonthLabel(dueDateObj);
    let yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    if (!yearBucket) { media.rentalDueHistory.push({ year: yearLabel, months: [] }); yearBucket = media.rentalDueHistory[media.rentalDueHistory.length - 1]; }
    let monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
    if (!monthBucket) { yearBucket.months.push({ month: monthLabel, entries: [] }); monthBucket = yearBucket.months[yearBucket.months.length - 1]; }
    monthBucket.entries.push({ rentalDueId: savedEntry._id, siteName: media.mediaName, campaignName, reason, dueDate: dueDateObj, netPayable: Number(newEntry.netPayable) || 0, approvalStatus: newEntry.approvalStatus, savedBy: userName, savedByRole: userType, updatedAt: nowIST(), updatedBy: userName });

    await media.save({ timestamps: false });
    // ✅ NEW — rental due history: initial values of a newly created bill
    if (atomicAction === "created") {
      recordRentalDueChanges({
        media,
        entry: savedEntry,
        changes: collectRentalDueChanges({}, { campaignName, reason, proofOfCampaign, invoice }),
        userId,
        userName,
        userType,
      });
    }

    // ✅ NEW — CMD notification: a Rental Executive / Manager creating the entry
    // approves their own step at creation
    if (isApprovalNotifyRole(userType)) {
      await createRentalApprovalNotification({ media, entry: savedEntry, userType, userId, userName });
    }
    // ✅ NEW — Google Chat message: the creator's own step is approved at creation
    if (isRoleStepApproved(savedEntry, userType)) {
      notifyRentalDueChat({ media, entry: savedEntry, userType, userName, action: "approved" });
    }

    if (!skipMail && isOwnerOverride && savedEntry.approvalStatus === 3) {
      const mailResult = await sendRentalDueApprovalMail(media, savedEntry);
      savedEntry.mailSent = !!mailResult.sent;
      await media.save({ timestamps: false });
    }

    const resGst = resolveGstApplicable(media, savedEntry.gstApplicableFlag, savedEntry.pastgstApplicableFlag);
    return { success: true, mediaId: media._id, mediaName: media.mediaName, rentalDueId: savedEntry._id, approvalStatus: savedEntry.approvalStatus, entryDoc: savedEntry, gstApplicableFlag: resGst.gstApplicableFlag, pastgstApplicableFlag: resGst.pastgstApplicableFlag, gstApplicableDisplay: resGst };
  }

  return { success: false, mediaId, message: "No pending cycle found" };
}

// ═════════════════════════════════════════════════════════════
// exports.saveRentalDue — backward compatible + new batch mode
// ═════════════════════════════════════════════════════════════
exports.saveRentalDue = async (req, res) => {
  try {
    const { userType, userId, userName } = req.user;
    const { mediaId, rentalDueId, campaignName,reason, withGst, gstApplicableFlag,pastgstApplicableFlag, entries } =
      req.body;

    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid or missing user role" });
    }

    const files = req.files || [];

    let proofOfCampaign = null;
    const singleProofFile = files.find((f) => f.fieldname === "proofOfCampaign");
    if (singleProofFile) {
      if (!singleProofFile.mimetype?.startsWith("image/")) {
        return res.status(400).json({
          success: false,
          message: "Proof of campaign must be an image file",
        });
      }
      proofOfCampaign = req.processFile(singleProofFile);
    }

    let invoice = null;
    const singleInvoiceFile = files.find((f) => f.fieldname === "invoice");
    if (singleInvoiceFile) {
      const isPdf = singleInvoiceFile.mimetype === "application/pdf";
      const isImage = singleInvoiceFile.mimetype?.startsWith("image/");
      if (!isPdf && !isImage) {
        return res.status(400).json({
          success: false,
          message: "Invoice must be a PDF or image file",
        });
      }
      invoice = req.processFile(singleInvoiceFile);
    }

    // ── NEW — batch mode ──
    let entriesArray = [];
    if (Array.isArray(entries)) {
      entriesArray = entries;
    } else if (entries && typeof entries === "object") {
      // Handle Postman form-data style objects { "0": {...}, "1": {...} }
      const keys = Object.keys(entries).filter(k => !isNaN(k));
      if (keys.length > 0) {
        entriesArray = keys
          .sort((a, b) => Number(a) - Number(b))
          .map((key) => entries[key]);
      }
    }

    // Fallback: Manually gather entries from top-level req.body if the above failed
    // (Happens if the parser doesn't group entries[0] into a single 'entries' object)
    if (entriesArray.length === 0) {
      const manualEntries = {};
      Object.keys(req.body).forEach(key => {
        const match = key.match(/^entries\[(\d+)\]\[(\w+)\]$/);
        if (match) {
          const index = match[1];
          const field = match[2];
          if (!manualEntries[index]) manualEntries[index] = {};
          manualEntries[index][field] = req.body[key];
        }
      });
      const indices = Object.keys(manualEntries).sort((a, b) => Number(a) - Number(b));
      if (indices.length > 0) {
        entriesArray = indices.map(i => manualEntries[i]);
      }
    }

    if (entriesArray.length > 0) {
      const parseEntryFileIndex = (fieldname) => {
        const match = fieldname.match(/^entries\[(\d+)\]\[proofOfCampaign\]$/);
        return match ? Number(match[1]) : null;
      };

      const parseEntryInvoiceIndex = (fieldname) => {
        const match = fieldname.match(/^entries\[(\d+)\]\[invoice\]$/);
        return match ? Number(match[1]) : null;
      };

      const entryFileMap = {};
      const entryInvoiceFileMap = {};

      files.forEach((f) => {
        const pIdx = parseEntryFileIndex(f.fieldname);
        if (pIdx !== null) entryFileMap[pIdx] = f;

        const iIdx = parseEntryInvoiceIndex(f.fieldname);
        if (iIdx !== null) entryInvoiceFileMap[iIdx] = f;
      });

      // ✅ GROUP ENTRIES BY mediaId TO PREVENT RACE CONDITIONS
      const mediaGroups = {};
      entriesArray.forEach((item, index) => {
        const mId = String(item.mediaId).trim();
        if (!mediaGroups[mId]) mediaGroups[mId] = [];
        mediaGroups[mId].push({ ...item, originalIndex: index });
      });

      const results = [];
      const batchApprovedSites = [];

      // Process each media document once
      for (const mId of Object.keys(mediaGroups)) {
        const group = mediaGroups[mId];
        const media = await Media.findById(mId);

        if (!media) {
          group.forEach(item => results.push({ success: false, mediaId: mId, message: "Media not found" }));
          continue;
        }

        // Before processing, run catch-up sweep
        await generateMissedEntriesForMedia(media, userName);

        // ✅ NEW — approvals made in this request, notified only after the save below
        const groupCmdApprovals = [];
        const groupChatApprovals = []; // any role — Google Chat
        const groupHistoryChanges = []; // ✅ NEW — rental due history, recorded after the save

        for (const item of group) {
          const index = item.originalIndex;
          let entryProofOfCampaign = null;
          if (entryFileMap[index]) {
            entryProofOfCampaign = req.processFile(entryFileMap[index]);
          }

          let entryInvoice = null;
          if (entryInvoiceFileMap[index]) {
            entryInvoice = req.processFile(entryInvoiceFileMap[index]);
          }

          // ✅ NEW — snapshot before processing, to detect an approval made in this request
          const roleStepWasApproved = isRoleStepApproved(findRentalDueEntryById(media, item.rentalDueId), userType);
          const itemChangeLog = []; // ✅ NEW — rental due history

          // Directly process on the loaded document instance
          const processResult = await processSingleRentalDueInternal({
            media,
            rentalDueId: item.rentalDueId,
            mediaDetailId: item.mediaDetailId,
            campaignName: item.campaignName,
            reason: item.reason,
            withGst: item.withGst,
            gstApplicableFlag: item.gstApplicableFlag,
            pastgstApplicableFlag: item.pastgstApplicableFlag,
            proofOfCampaign: entryProofOfCampaign,
            invoice: entryInvoice,
            userType,
            userId,
            userName,
            changeLog: itemChangeLog,
            campaignStatus: item.campaignStatus ?? req.body.campaignStatus, // ✅ NEW
          });

          results.push({ ...processResult, originalIndex: index });
          if (processResult.success && itemChangeLog.length) {
            groupHistoryChanges.push({ entry: processResult.entryDoc, changes: itemChangeLog });
          }
          if (processResult.success && processResult.approvalStatus === 3) {
            batchApprovedSites.push({ media, entry: processResult.entryDoc });
          }
          if (
            processResult.success &&
            isApprovalNotifyRole(userType) &&
            !roleStepWasApproved &&
            isRoleStepApproved(processResult.entryDoc, userType) &&
            !processResult.lateApproval // ✅ NEW — late approval of a skipped step
          ) {
            groupCmdApprovals.push(processResult.entryDoc);
          }
          if (
            processResult.success &&
            !roleStepWasApproved &&
            isRoleStepApproved(processResult.entryDoc, userType) &&
            !processResult.lateApproval // ✅ NEW — late approval of a skipped step
          ) {
            groupChatApprovals.push(processResult.entryDoc);
          }
        }

        // Save the document ONCE after all updates for its faces/cycles are done
        await media.save({ timestamps: false });

        // ✅ NEW — rental due history, only after the save succeeded
        for (const h of groupHistoryChanges) {
          recordRentalDueChanges({ media, entry: h.entry, changes: h.changes, userId, userName, userType });
        }

        // ✅ NEW — CMD notifications (site-wise) only after a successful save
        for (const approvedEntry of groupCmdApprovals) {
          await createRentalApprovalNotification({ media, entry: approvedEntry, userType, userId, userName });
        }
        // ✅ FIXED — single-bill site: every face has its own row for the month,
        // and each built the SAME message → sent once per bill (per site per
        // month; a separate-bill face still gets its own message)
        const sentChatKeys = new Set();
        for (const approvedEntry of groupChatApprovals) {
          const chatKey = rentalDueChatKey(media, approvedEntry);
          if (sentChatKeys.has(chatKey)) continue;
          sentChatKeys.add(chatKey);
          notifyRentalDueChat({ media, entry: approvedEntry, userType, userName, action: "approved" });
        }
      }

      // Re-sort results to match incoming order
      results.sort((a, b) => a.originalIndex - b.originalIndex);

      // ✅ Send one grouped mail if multiple sites were fully approved together
      if (batchApprovedSites.length > 0) {
        const first = batchApprovedSites[0];
        const mailRes = await sendRentalDueApprovalMail(first.media, first.entry, batchApprovedSites);

        // Mark all as sent in DB
        for (const item of batchApprovedSites) {
          item.entry.mailSent = !!mailRes.sent;
          await item.media.save({ timestamps: false });
        }
      }

      // ── landOwnerSummary — per-owner rollup across every successful entry ──
      const ownerMap = new Map();
      for (const r of results) {
        if (!r.success) continue;
        const media = await Media.findById(r.mediaId, "landOwners mediaCode mediaName").lean();
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

      return res.status(200).json({
        success: true,
        message: `Rental due processed for ${results.length} site(s)`,
        data: {
          results,
          landOwnerSummary: Array.from(ownerMap.values()),
          siteSummary: {
            totalSites: results.length,
            successCount,
            failedCount,
            totalBaseAmount: results.reduce((s, r) => s + (r.baseAmount || 0), 0),
            totalGstAmount: results.reduce((s, r) => s + (r.gstAmount || 0), 0),
            totalNetPayable: results.reduce((s, r) => s + (r.netPayable || 0) + (r.gstAmount || 0), 0),
          },
        },
      });
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    // ✅ FIXED — same trim() defense as the batch path above.
    const trimmedMediaId = typeof mediaId === "string" ? mediaId.trim() : mediaId;

    if (!trimmedMediaId || !mongoose.Types.ObjectId.isValid(trimmedMediaId)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid mediaId is required" });
    }

    const result = await processSingleRentalDue({
      mediaId: trimmedMediaId,
      rentalDueId: typeof rentalDueId === "string" ? rentalDueId.trim() : rentalDueId,
      mediaDetailId: req.body.mediaDetailId, // ✅ NEW
      campaignName: typeof campaignName === "string" ? campaignName.trim() : campaignName,
      reason: typeof reason === "string" ? reason.trim() : reason,
      withGst,
      gstApplicableFlag,
      pastgstApplicableFlag,
      proofOfCampaign,
      invoice, // ✅ ADDED
      userType,
      userId,
      userName,
      campaignStatus: req.body.campaignStatus, // ✅ NEW
    });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return res.status(statusCode).json({ success: false, message: result.message });
    }

    const statusCode = result.isNew ? 201 : 200;
    const message = result.isNew
      ? "Rental due entry saved — waiting on Team Lead approval"
      : "Approval recorded";

    delete result.success;
    delete result.isNew;

    return res.status(statusCode).json({ success: true, message, data: result });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ── verifyAgreementDoc — one site ──────────────────────────────
async function processSingleVerification({ mediaId, rentalDueId, userType, userName }) {
  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }

  let media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

  // ✅ ADDED — if rentalDueId is provided, target THAT entry's own
  // dueDate as the cycle to verify, instead of nextBillingDate (which
  // no longer marks "the current pending cycle" now that dates
  // auto-advance regardless of approval — nextBillingDate could be a
  // future month with no rentalDue entry at all).
  let targetEntry = null;
  let currentCycle;

  if (rentalDueId) {
    targetEntry = (media.rentalDue || media.rentalDueEntries || []).find(
      (e) => String(e._id) === String(rentalDueId),
    );
    if (!targetEntry) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `No rentalDue entry found with id ${rentalDueId} on this site`,
      };
    }
     if (ensureApprovalStepsPopulated(targetEntry)) {
    media.markModified("rentalDue");
    await media.save({ timestamps: false });
  }
    currentCycle = getCurrentCycle(targetEntry.dueDate);
  } else {
    currentCycle = getCurrentCycle(media.rentalPayment?.nextBillingDate);
  }

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

  const staffVerified = currentCycleVerifications.some((h) => h.verifiedByRole === ROLE.STAFF);
  const teamLeadVerified = currentCycleVerifications.some((h) => h.verifiedByRole === ROLE.TEAM_LEAD);
  const ownerVerified = currentCycleVerifications.some((h) => h.verifiedByRole === ROLE.OWNER);

  const getHighestVerifiedRole = (staff, teamLead, owner) => {
    if (owner) return ROLE.OWNER;
    if (teamLead) return ROLE.TEAM_LEAD;
    if (staff) return ROLE.STAFF;
    return null;
  };

  const highestVerifiedRole = getHighestVerifiedRole(staffVerified, teamLeadVerified, ownerVerified);
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

  // ✅ CHANGED — no cross-role blocking: Rental Executive, Rental Manager and
  // CMD each verify once per billing cycle, in any order (even after CMD).
  // Only the role's own repeat verification is blocked (checks above).

  const verificationRecord = {
    isVerified: true,
    verifiedBy: userName,
    verifiedByRole: userType,
    verifiedAt: nowIST(),
    rentalDueId: targetEntry ? targetEntry._id : null, // ✅ CHANGED — links to the specific month, when targeted
    agreementPDF: media.agreement?.agreementPDF || {},
    cycle: currentCycle,
    cycleStartDate: targetEntry ? targetEntry.dueDate : media.rentalPayment?.nextBillingDate, // ✅ CHANGED
    updatedAt: nowIST(),
    updatedBy: userName,
  };

  // ✅ CHANGED — same rule as above: only the role's own verification blocks
  const blockingRoles = [ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].filter((role) => role === userType);

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
      $set: { updatedBy: userName },
    },
    {
      returnDocument: "after",
      timestamps: false,
    },
  );

  if (!updatedMedia) {
    const latestMedia = await Media.findById(mediaId);
    const latestVerifications = (latestMedia?.agreementDocVerification || []).filter(
      (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
    );
    const selfAlreadyVerified = latestVerifications.some((h) => h.verifiedByRole === userType);
    const blocker = null; // ✅ CHANGED — other roles never block a verification

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
      message: "Verification could not be completed due to a conflicting update. Please try again.",
    };
  }

  media = updatedMedia;

  const updatedVerifications = media.agreementDocVerification.filter(
    (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
  );
  const updatedStaffVerified = updatedVerifications.some((h) => h.verifiedByRole === ROLE.STAFF);
  const updatedTeamLeadVerified = updatedVerifications.some((h) => h.verifiedByRole === ROLE.TEAM_LEAD);
  const updatedOwnerVerified = updatedVerifications.some((h) => h.verifiedByRole === ROLE.OWNER);
  const updatedVerifiedCount = [updatedStaffVerified, updatedTeamLeadVerified, updatedOwnerVerified].filter(Boolean).length;

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
  targetEntry ? targetEntry._id : null,
);
  await media.save({ timestamps: false });

  return {
    success: true,
    mediaId: media._id,
    mediaName: media.mediaDetails?.map(d => d.mediaName).join(", ") || "Unknown",
    rentalDueId: targetEntry ? targetEntry._id : null, // ✅ ADDED
    dueMonth: targetEntry ? targetEntry.dueMonth : null, // ✅ ADDED
    message: targetEntry
      ? `${ROLE_LABEL[userType]} verified the agreement document successfully for ${targetEntry.dueMonth}`
      : `${ROLE_LABEL[userType]} verified the agreement document successfully for the billing cycle starting ${formatDate(currentCycle)}`,
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
    const { mediaId, rentalDueId, mediaIds, entries } = req.body;
    const { userType, userName } = req.user;

    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid or missing user role" });
    }

    // ✅ ADDED — batch mode with per-site targeting:
    // entries: [ { mediaId, rentalDueId }, ... ]
    // Use this when you need to verify a SPECIFIC month per site
    // (e.g. May on Site A, June on Site B) in one call.
    if (Array.isArray(entries) && entries.length > 0) {
      const results = [];
      for (const item of entries) {
        const result = await processSingleVerification({
          mediaId: item.mediaId,
          rentalDueId: item.rentalDueId,
          userType,
          userName,
        });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return res.status(200).json({
        success: true,
        message: `Processed verification for ${results.length} site(s)`,
        data: { results, totalSites: results.length, successCount, failedCount },
      });
    }

    // ── batch mode (unchanged): mediaIds: [id1, id2, id3] — always
    // targets each site's current nextBillingDate cycle, no per-site
    // month targeting. Use the new entries[] mode above if you need
    // to target specific months.
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

      return res.status(200).json({
        success: true,
        message: `Processed verification for ${results.length} site(s)`,
        data: { results, totalSites: results.length, successCount, failedCount },
      });
    }

    // ── OLD — single mediaId request, response shape UNCHANGED
    // (rentalDueId is a new OPTIONAL addition — omit it and behavior
    // is identical to before) ──
    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid mediaId is required" });
    }

    const result = await processSingleVerification({
      mediaId,
      rentalDueId, // ✅ ADDED
      userType,
      userName,
    });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return res.status(statusCode).json({ success: false, message: result.message });
    }

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        rentalDueId: result.rentalDueId, // ✅ ADDED
        dueMonth: result.dueMonth, // ✅ ADDED
        verificationRecord: undefined, // kept for shape parity — original returned this too
        currentCycle: result.currentCycle,
        verificationProgress: result.verificationProgress,
        verificationProgressHistory: result.verificationProgressHistory,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * ✅ UPDATED — Dedicated API for OverDue History List with Summary and calculated overdue days
 */
// ✅ NEW — response only: an overdue row is ONE per site per month, but its
// stored amount comes from a single face's bill (site rent split by sqft). For
// a SINGLE-bill site with several faces the row stands for the whole bill, so
// rent / GST are taken from the site's cycle summary for the row's month
// (same amounts as rental-due-list / dashboard). Separate-bill and single-face
// rows keep their stored amounts. Returns Map(recordId → { rent, gst }).
// whole-bill { rent, gst } of a SINGLE-bill multi-face site for a month, or null
function siteBillForOverdue(media, dueDate) {
  if (!media || !dueDate) return null;
  const activeFaces = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);
  const isSingleBillMultiFace = activeFaces.length > 1 && activeFaces.every((d) => Number(d.siteBillMode) !== 2);
  if (!isSingleBillMultiFace) return null;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const plain = typeof media.toObject === "function" ? media.toObject() : media;
    const s = getOverallSummaryForCycle(plain, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }) || {};
    const rent = Math.round(Number(s.currentMonthRentalAmount || 0));
    const gst = Math.round(Number(s.currentMonthGstAmount || 0));
    return rent > 0 ? { rent, gst } : null;
  } catch (err) {
    return null;
  }
}

async function siteBillAmountsForOverdueRows(records) {
  const result = new Map();
  const mediaIds = [
    ...new Set(
      (records || [])
        .map((r) => String(r.mediaId?._id || r.mediaId || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
  if (!mediaIds.length) return result;
  // ✅ SPEED — only single-bill multi-face sites get a site bill (see
  // siteBillForOverdue), so the heavy fields are loaded for those sites only
  const faceDocs = await Media.find({ _id: { $in: mediaIds } }).select("mediaDetails.status mediaDetails.siteBillMode").lean();
  const billSiteIds = faceDocs
    .filter((m) => {
      const active = (m.mediaDetails || []).filter((d) => Number(d.status) === 1);
      return active.length > 1 && active.every((d) => Number(d.siteBillMode) !== 2);
    })
    .map((m) => m._id);
  if (!billSiteIds.length) return result;
  const medias = await Media.find({ _id: { $in: billSiteIds } })
    .select("mediaDetails rentalPayment landOwners rentalDue ledger ledgerHistory gstBalanceHistory gstApplicableFlag appraisal")
    .lean();
  const mediaById = new Map(medias.map((m) => [String(m._id), m]));
  for (const r of records) {
    const bill = siteBillForOverdue(mediaById.get(String(r.mediaId?._id || r.mediaId || "")), r.dueDate);
    if (bill) result.set(String(r._id), bill);
  }
  return result;
}

// ✅ NEW — one-time / repeatable fix of EXISTING overdue rows: single-bill
// multi-face sites get the whole bill stored (overDueAmount = rent, or
// rent + GST when withGst is 2 "direct"; gstAmount = site GST). Only rows whose
// amounts differ are written. Run at startup from server.js. Never throws.
async function fixSingleBillOverdueAmounts() {
  const result = { checked: 0, fixed: 0 };
  try {
    const rows = await OverDueHistory.find({ mediaId: { $ne: null } })
      .select("mediaId dueDate overDueAmount gstAmount withGst")
      .lean();
    const amounts = await siteBillAmountsForOverdueRows(rows);
    result.checked = rows.length;
    const ops = [];
    for (const r of rows) {
      const bill = amounts.get(String(r._id));
      if (!bill) continue;
      const overDueAmount = Number(r.withGst) === 2 ? bill.rent + bill.gst : bill.rent;
      if (Number(r.overDueAmount) === overDueAmount && Number(r.gstAmount) === bill.gst) continue;
      ops.push({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { overDueAmount, gstAmount: bill.gst, isGstApplicable: bill.gst > 0 } },
        },
      });
    }
    if (ops.length) {
      const res = await OverDueHistory.bulkWrite(ops);
      result.fixed = res.modifiedCount || 0;
    }
  } catch (err) {
    console.error("[fixSingleBillOverdueAmounts] failed:", err.message);
  }
  return result;
}
exports.fixSingleBillOverdueAmounts = fixSingleBillOverdueAmounts;

// ─────────────────────────────────────────────────────────────
// ✅ SPEED — shared overdue sweep for /admin/overdue-history-list.
// Same steps as before (sync every active site's overdue rows → remove
// duplicates → fill landowners). Calls arriving while a sweep runs share it.
// Only the first call after a server start waits for it; later calls answer
// right away and, when the last sweep is older than OVERDUE_SWEEP_REUSE_MS
// (.env, default 5 min), start a fresh sweep in the background.
// ─────────────────────────────────────────────────────────────
const OVERDUE_SWEEP_REUSE_MS = Number(process.env.OVERDUE_SWEEP_REUSE_MS) || 5 * 60 * 1000;
let overdueSweepInFlight = null;
let overdueSweepFinishedAt = 0;

async function sweepOverdueHistory() {
  const activeSites = await Media.find({ "mediaDetails.status": 1 });
  // 5 sites at a time, each site's rows loaded once (same result)
  await syncOverdueEntriesForSites(activeSites, "");
  await cleanupDuplicateOverDueHistoryRecords();
  await ensureOverDueHistoryLandOwnersPopulated();
}

function startOverdueSweep() {
  if (!overdueSweepInFlight) {
    overdueSweepInFlight = sweepOverdueHistory()
      .then(() => {
        overdueSweepFinishedAt = Date.now();
      })
      .catch((err) => console.error("overdue sweep error:", err.message))
      .finally(() => {
        overdueSweepInFlight = null;
      });
  }
  return overdueSweepInFlight;
}

async function runSharedOverdueSweep() {
  if (!overdueSweepFinishedAt) return startOverdueSweep(); // first call: wait once
  if (Date.now() - overdueSweepFinishedAt >= OVERDUE_SWEEP_REUSE_MS) startOverdueSweep(); // refresh in background
}

exports.getOverDueHistoryList = async (req, res) => {
  try {
    // ✅ CHANGED — shared sweep (see runSharedOverdueSweep) instead of a full
    // sweep on every call
    await runSharedOverdueSweep();

    const {
      pageNumber = 1,
      count = 10,
      search,
      startDueMonth,
      endDueMonth,
      status,
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;
    const skip = (pageNumbers - 1) * pageSize;

    const monthYearConditions = [];
    const searchStatusConditions = [];

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

    // ── 1) Month / Year Filter (startDueMonth to endDueMonth Range) ──
    let effectiveStart = startDueMonth;
    let effectiveEnd = endDueMonth;

    if (effectiveStart && !effectiveEnd) {
      effectiveEnd = effectiveStart;
    } else if (effectiveEnd && !effectiveStart) {
      effectiveStart = effectiveEnd;
    }

    const parseMonthYear = (val) => {
      if (!val) return null;
      const mNames = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"
      ];
      if (typeof val === "string") {
        const trimmed = val.trim();
        let match = trimmed.match(/^(\d{1,2})[-/](\d{4})$/);
        if (match) {
          const mo = parseInt(match[1], 10);
          const yr = parseInt(match[2], 10);
          if (mo >= 1 && mo <= 12) return { month: mo, year: yr };
        }
        match = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
        if (match) {
          const yr = parseInt(match[1], 10);
          const mo = parseInt(match[2], 10);
          if (mo >= 1 && mo <= 12) return { month: mo, year: yr };
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const mStr = parts[0].toLowerCase();
          const yr = parseInt(parts[1], 10);
          const mIdx = mNames.findIndex((m) => m.startsWith(mStr));
          if (mIdx !== -1 && !isNaN(yr)) {
            return { month: mIdx + 1, year: yr };
          }
        }
      }
      return null;
    };

    const startObj = parseMonthYear(effectiveStart);
    const endObj = parseMonthYear(effectiveEnd);

    if (startObj && endObj) {
      let sObj = startObj;
      let eObj = endObj;
      if (
        startObj.year > endObj.year ||
        (startObj.year === endObj.year && startObj.month > endObj.month)
      ) {
        sObj = endObj;
        eObj = startObj;
      }

      const startDate = new Date(Date.UTC(sObj.year, sObj.month - 1, 1, 0, 0, 0, 0));
      const endDate = new Date(Date.UTC(eObj.year, eObj.month, 0, 23, 59, 59, 999));

      const dueMonthOrConditions = [];
      let curYr = sObj.year;
      let curMo = sObj.month;

      while (
        curYr < eObj.year ||
        (curYr === eObj.year && curMo <= eObj.month)
      ) {
        const mName = monthNames[curMo - 1];
        if (mName) {
          dueMonthOrConditions.push({
            dueMonth: new RegExp(`${mName}.*${curYr}`, "i"),
          });
          dueMonthOrConditions.push({
            dueMonth: new RegExp(`^0?${curMo}[-/]${curYr}$`, "i"),
          });
        }
        curMo++;
        if (curMo > 12) {
          curMo = 1;
          curYr++;
        }
      }

      const monthRangeOr = [
        { dueDate: { $gte: startDate, $lte: endDate } },
        { currentBillDate: { $gte: startDate, $lte: endDate } },
        ...dueMonthOrConditions,
      ];

      monthYearConditions.push({ $or: monthRangeOr });
    }

    // ── 2) Search / Status Filter (Table Specific) ──
    if (search && typeof search === "string" && search.trim() !== "") {
      const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(escapedSearch, "i");

      searchStatusConditions.push({
        $or: [
          { "mediaDetails.mediaName": searchRegex },
          { "mediaDetails.mediaCode": searchRegex },
          { "landOwners.name": searchRegex },
          { "landOwners.landOwnerName": searchRegex },
          { landOwnerName: searchRegex },
        ],
      });
    }

    if (status !== undefined && status !== null && status !== "") {
      const s = Number(status);
      if (s === 0) {
        searchStatusConditions.push({
          $or: [
            {
              withGst: 1,
              gstAmount: { $gt: 0 },
              $or: [{ ledgerEntryDate: null }, { gstEntryDate: null }],
            },
            {
              withGst: { $ne: 1 },
              ledgerEntryDate: null,
            },
          ],
        });
      } else if (s === 1) {
        searchStatusConditions.push({
          ledgerEntryDate: { $ne: null },
        });
      } else if (s === 2) {
        searchStatusConditions.push({
          gstEntryDate: { $ne: null },
          gstAmount: { $gt: 0 },
        });
      } else if (s === 3) {
        searchStatusConditions.push({
          $or: [
            {
              withGst: 1,
              gstAmount: { $gt: 0 },
              ledgerEntryDate: { $ne: null },
              gstEntryDate: { $ne: null },
            },
            {
              withGst: { $ne: 1 },
              ledgerEntryDate: { $ne: null },
            },
          ],
        });
      }
    }

    // ── 3) Build Final Filters & Sorting ──
    // Determine sort order based on month range (earlier months first, e.g. July then August)
    let sortDirection = 1;
    if (startObj && endObj) {
      if (
        startObj.year > endObj.year ||
        (startObj.year === endObj.year && startObj.month > endObj.month)
      ) {
        sortDirection = -1;
      }
    }

    const sortOrder = {
      updatedAt: -1,
      dueDate: sortDirection,
      currentBillDate: sortDirection,
      approvedDate: -1,
    };

    // Base condition: require an actual overdue record (overDueAmount > 0 or valid rentalDueId or valid dueDate)
    const validOverdueBaseCondition = {
      $or: [
        { overDueAmount: { $gt: 0 } },
        { rentalDueId: { $exists: true, $ne: null } },
        { dueDate: { $exists: true, $ne: null } },
      ],
    };

    // Summary Filter: Based ONLY on Month/Year + valid overdue record
    const summaryFilter =
      monthYearConditions.length > 0
        ? { $and: [validOverdueBaseCondition, ...monthYearConditions] }
        : validOverdueBaseCondition;

    // List Filter: Combined Base + Search/Status
    const listConditions = [validOverdueBaseCondition, ...monthYearConditions, ...searchStatusConditions];
    const listFilter = { $and: listConditions };

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // 1) Summary Statistics (Uses Summary Filter)
    const statsAgg = await OverDueHistory.aggregate([
      { $match: summaryFilter },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalOverdueSites: { $sum: 1 },
                pendingEntry: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          {
                            $and: [
                              { $eq: ["$withGst", 1] },
                              { $gt: ["$gstAmount", 0] },
                              {
                                $or: [
                                  { $eq: ["$ledgerEntryDate", null] },
                                  { $eq: ["$gstEntryDate", null] }
                                ]
                              }
                            ]
                          },
                          {
                            $and: [
                              { $ne: ["$withGst", 1] },
                              { $eq: ["$ledgerEntryDate", null] }
                            ]
                          }
                        ]
                      },
                      1, 0
                    ]
                  }
                },
                rentEntry: {
                  $sum: {
                    $cond: [{ $ne: ["$ledgerEntryDate", null] }, 1, 0]
                  }
                },
                gstEntry: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$gstEntryDate", null] },
                          { $gt: ["$gstAmount", 0] }
                        ]
                      },
                      1, 0
                    ]
                  }
                },
                bothEntry: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          {
                            $and: [
                              { $eq: ["$withGst", 1] },
                              { $gt: ["$gstAmount", 0] },
                              { $ne: ["$ledgerEntryDate", null] },
                              { $ne: ["$gstEntryDate", null] }
                            ]
                          },
                          {
                            $and: [
                              { $ne: ["$withGst", 1] },
                              { $ne: ["$ledgerEntryDate", null] }
                            ]
                          }
                        ]
                      },
                      1, 0
                    ]
                  }
                },
                totalOverdueAmount: {
                  $sum: {
                    $cond: [
                      { $eq: ["$withGst", 2] },
                      "$overDueAmount",
                      { $add: ["$overDueAmount", "$gstAmount"] }
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    ]);

    const summary = statsAgg[0]?.totals[0] || {
      totalOverdueSites: 0,
      pendingEntry: 0,
      rentEntry: 0,
      gstEntry: 0,
      bothEntry: 0,
      totalOverdueAmount: 0
    };

    // ✅ NEW — totalOverdueAmount with the same single-bill site amounts as the rows
    {
      const summaryRows = await OverDueHistory.find(summaryFilter)
        .select("mediaId dueDate overDueAmount gstAmount withGst")
        .lean();
      const siteAmounts = await siteBillAmountsForOverdueRows(summaryRows);
      if (siteAmounts.size) {
        summary.totalOverdueAmount = summaryRows.reduce((sum, r) => {
          const site = siteAmounts.get(String(r._id));
          if (site) return sum + site.rent + site.gst;
          return sum + (Number(r.withGst) === 2 ? Number(r.overDueAmount || 0) : Number(r.overDueAmount || 0) + Number(r.gstAmount || 0));
        }, 0);
      }
    }

    // 2) Data Fetch (Uses Full Filter & Chronological Sorting)
    const [history, totalCount] = await Promise.all([
      OverDueHistory.find(listFilter)
        .populate({ path: "mediaId", select: "landOwners" })
        .sort(sortOrder)
        .skip(skip)
        .limit(pageSize)
        .lean(),
      OverDueHistory.countDocuments(listFilter)
    ]);

    // ✅ NEW — whole-bill amounts for single-bill multi-face sites (see helper)
    const rowSiteAmounts = await siteBillAmountsForOverdueRows(history);

    // 3) Enrichment for UI
    const enrichedHistory = history.map(item => {
        const dDate = item.dueDate ? new Date(item.dueDate) : null;

        const rawLandOwners = (Array.isArray(item.landOwners) && item.landOwners.length > 0)
          ? item.landOwners
          : (item.mediaId && Array.isArray(item.mediaId.landOwners) ? item.mediaId.landOwners : []);

        const landOwners = rawLandOwners.map(o => ({
          _id: o._id,
          landOwnerMasterId: o.landOwnerMasterId || null,
          name: o.name || o.landOwnerName || "",
          landOwnerName: o.name || o.landOwnerName || "",
          phone: o.phone || "",
          panNumber: o.panNumber || "",
          accountNumber: o.accountNumber || "",
          bankName: o.bankName || "",
          ifsc: o.ifsc || "",
          paymentCategory: o.paymentCategory,
          sharePercentage: o.sharePercentage,
          shareAmount: o.shareAmount,
          gstApplicable: o.gstApplicable,
          gstAmount: o.gstAmount,
        }));

        const mainLandOwnerName = item.landOwnerName || landOwners.map(o => o.name || o.landOwnerName).filter(Boolean).join(", ");

        const mediaIdVal = (item.mediaId && item.mediaId._id) ? item.mediaId._id : item.mediaId;

        const calcOverdueBy = (date) => {
            if (!date || !dDate) return "-";
            const diff = Math.floor((new Date(date) - dDate) / 86400000);
            return diff > 0 ? `${diff} days` : "0 days";
        };

        const ledgerDate = item.ledgerEntryDate;
        const gstDate = item.gstEntryDate;
        const withGst = Number(item.withGst || 0);
        const gstAmt = Number(item.gstAmount || 0);

        let calculatedStatus = 0;
        let statusLabel = "Pending";

        if (withGst === 1 && gstAmt > 0) {
            // Tracked GST
            if (ledgerDate && gstDate) {
                calculatedStatus = 3;
                statusLabel = "Rent + GST Entry";
            } else if (ledgerDate) {
                calculatedStatus = 1;
                statusLabel = "Rent Entry";
            } else if (gstDate) {
                calculatedStatus = 2;
                statusLabel = "GST Entry";
            } else {
                calculatedStatus = 0;
                statusLabel = "Pending";
            }
        } else {
            // Non-tracked GST / GST cannot be held (withGst: 0 or 2, etc.)
            if (ledgerDate) {
                calculatedStatus = 3;
                statusLabel = "Rent Entry (Complete)";
            } else {
                calculatedStatus = 0;
                statusLabel = "Pending";
            }
        }

        const isDirect = withGst === 2;
        let rentAmount = isDirect ? Math.max((item.overDueAmount || 0) - (item.gstAmount || 0), 0) : (item.overDueAmount || 0);
        let totalAmount = isDirect ? (item.overDueAmount || 0) : (item.overDueAmount || 0) + (item.gstAmount || 0);
        // ✅ NEW — single-bill multi-face site: the whole bill (site rent + GST)
        const siteBill = rowSiteAmounts.get(String(item._id));
        let rowGstAmount = item.gstAmount;
        if (siteBill) {
          rentAmount = siteBill.rent;
          rowGstAmount = siteBill.gst;
          totalAmount = siteBill.rent + siteBill.gst;
        }

        const isOwnerApproved = !!(item.ownerApprovedAt || item.approvedDate || Number(item.status) === 3);
        const resolvedApprovedDate = item.approvedDate || item.ownerApprovedAt || null;
        const resolvedRemovedDate = item.removedDate || item.ownerApprovedAt || null;
        const approvalOverdueBy = item.approvalOverdueBy && item.approvalOverdueBy !== "-"
          ? item.approvalOverdueBy
          : (resolvedApprovedDate ? (item.OverdueByCMD && item.OverdueByCMD !== "-" ? item.OverdueByCMD : calcOverdueBy(resolvedApprovedDate)) : "-");

        return {
            ...item,
            mediaId: mediaIdVal,
            landOwners,
            landOwnerName: mainLandOwnerName,
            rentAmount,
            gstAmount: rowGstAmount, // ✅ NEW — site GST for single-bill multi-face rows
            overDueAmount: totalAmount,
            totalAmount: totalAmount,
            approvedDate: resolvedApprovedDate,
            removedDate: resolvedRemovedDate,
            overdueDays: dDate ? Math.floor((today - dDate) / 86400000) : 0,
            approvalOverdueBy,
            ledgerOverdueBy: calcOverdueBy(item.ledgerEntryDate),
            gstOverdueBy: calcOverdueBy(item.gstEntryDate),
            staffApprovedAt: item.staffApprovedAt || null,
            staffApprovedBy: item.staffApprovedBy || "",
            teamLeadApprovedAt: item.teamLeadApprovedAt || null,
            teamLeadApprovedBy: item.teamLeadApprovedBy || "",
            ownerApprovedAt: item.ownerApprovedAt || null,
            ownerApprovedBy: item.ownerApprovedBy || "",
            OverdueByStaff: item.staffApprovedAt ? (item.OverdueByStaff !== "-" ? item.OverdueByStaff : calcOverdueBy(item.staffApprovedAt)) : "-",
            OverdueByTeamLead: item.teamLeadApprovedAt ? (item.OverdueByTeamLead !== "-" ? item.OverdueByTeamLead : calcOverdueBy(item.teamLeadApprovedAt)) : "-",
            OverdueByCMD: isOwnerApproved ? (item.OverdueByCMD !== "-" ? item.OverdueByCMD : calcOverdueBy(item.ownerApprovedAt)) : "-",
            calculatedStatus,
            statusLabel
        };
    });

    return successResponse(res, "OverDue history fetched successfully", {
      summary: {
          ...summary,
          avgOverdueDays: Math.floor(summary.avgOverdueDays || 0)
      },
      pagination: {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
      overDueHistory: enrichedHistory
    }, 200);

  } catch (err) {
    console.error("getOverDueHistoryList error:", err);
    return errorResponse(res, "Something went wrong while fetching overdue history", { error: err.message }, 500);
  }
};

/**
 * ✅ NEW — API to save overdue remarks for a media site / face / landowner
 */
exports.overDueRemark = async (req, res) => {
  try {
    const {
      mediaId,
      rentalDueId,
      mediaDetailId,
      mediaDetailsId,
      landOwnerId,
      landownerId,
      remarks,
      entries,
    } = req.body;

    let entriesArray = [];

    if (Array.isArray(mediaId) || Array.isArray(rentalDueId) || Array.isArray(mediaDetailId) || Array.isArray(mediaDetailsId) || Array.isArray(landOwnerId) || Array.isArray(landownerId)) {
      const mediaIds = Array.isArray(mediaId) ? mediaId : (mediaId ? [mediaId] : []);
      const rentalDueIds = Array.isArray(rentalDueId) ? rentalDueId : (rentalDueId ? [rentalDueId] : []);
      const mediaDetailIds = Array.isArray(mediaDetailId || mediaDetailsId) ? (mediaDetailId || mediaDetailsId) : ((mediaDetailId || mediaDetailsId) ? [mediaDetailId || mediaDetailsId] : []);
      const landOwnerIds = Array.isArray(landOwnerId || landownerId) ? (landOwnerId || landownerId) : ((landOwnerId || landownerId) ? [landOwnerId || landownerId] : []);

      const maxLength = Math.max(mediaIds.length, rentalDueIds.length, mediaDetailIds.length, landOwnerIds.length);
      for (let i = 0; i < maxLength; i++) {
        entriesArray.push({
          mediaId: mediaIds[i] || mediaIds[0],
          rentalDueId: rentalDueIds[i] || rentalDueIds[0] || null,
          mediaDetailId: mediaDetailIds[i] || mediaDetailIds[0] || null,
          landOwnerId: landOwnerIds[i] || landOwnerIds[0] || null,
          remarks: remarks,
        });
      }
    } else if (Array.isArray(entries)) {
      entriesArray = entries;
    } else if (entries && typeof entries === "object") {
      const keys = Object.keys(entries).filter(k => !isNaN(k));
      if (keys.length > 0) {
        entriesArray = keys.sort((a, b) => Number(a) - Number(b)).map(k => entries[k]);
      }
    }

    if (entriesArray.length === 0) {
      const manualEntries = {};
      Object.keys(req.body).forEach(key => {
        const match = key.match(/^entries\[(\d+)\]\[(\w+)\]$/);
        if (match) {
          const index = match[1];
          const field = match[2];
          if (!manualEntries[index]) manualEntries[index] = {};
          manualEntries[index][field] = req.body[key];
        }
      });
      const indices = Object.keys(manualEntries).sort((a, b) => Number(a) - Number(b));
      if (indices.length > 0) {
        entriesArray = indices.map(i => manualEntries[i]);
      }
    }

    if (entriesArray.length === 0) {
      entriesArray = [{
        mediaId: Array.isArray(mediaId) ? mediaId[0] : mediaId,
        rentalDueId: Array.isArray(rentalDueId) ? rentalDueId[0] : rentalDueId,
        mediaDetailId: Array.isArray(mediaDetailId || mediaDetailsId) ? (mediaDetailId || mediaDetailsId)[0] : (mediaDetailId || mediaDetailsId),
        landOwnerId: Array.isArray(landOwnerId || landownerId) ? (landOwnerId || landownerId)[0] : (landOwnerId || landownerId),
        remarks,
      }];
    }

    const userName = req.user?.userName || "Admin";
    const savedResults = [];

    // ✅ CHANGED — same base URL as the other uploads (.env LOCAL_BASE_URL,
    // e.g. http://localhost:5000) instead of the request's host IP
    const baseUrl = String(process.env.LOCAL_BASE_URL || "http://localhost:5000").trim().replace(/\/+$/, "");
    // ✅ NEW — STORAGE_TYPE=space → the file is in DigitalOcean Spaces (CDN link),
    // otherwise the local public/overdueRemarks folder
    const remarkFileUrl = (file) =>
      file.key
        ? `${require("../../../middleware/dynamicFileUpload").CDN_BASE_URL}/${file.key}`
        : `${baseUrl}/public/overdueRemarks/${file.filename}`;
    let attachments = [];
    if (req.files && Array.isArray(req.files)) {
      attachments = req.files.map(file => ({
        fileUrl: remarkFileUrl(file),
        fileName: file.originalname,
        fileType: file.mimetype.startsWith('image/') ? 'image' : 'document',
        fileSize: file.size,
        mimeType: file.mimetype,
      }));
    } else if (req.file) {
      attachments = [{
        fileUrl: remarkFileUrl(req.file),
        fileName: req.file.originalname,
        fileType: req.file.mimetype.startsWith('image/') ? 'image' : 'document',
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
      }];
    }

    let voiceMessageObj = null;
    if (req.body.voiceMessage) {
      try {
        voiceMessageObj = typeof req.body.voiceMessage === 'string' ? JSON.parse(req.body.voiceMessage) : req.body.voiceMessage;
        if (voiceMessageObj && !voiceMessageObj.audioUrl && attachments.length > 0) {
          const audioAttIndex = attachments.findIndex(a => a.mimeType?.startsWith('audio/') || a.fileName?.includes('voice_recording'));
          if (audioAttIndex !== -1) {
            voiceMessageObj.audioUrl = attachments[audioAttIndex].fileUrl;
            attachments.splice(audioAttIndex, 1);
          } else {
            voiceMessageObj.audioUrl = attachments[0].fileUrl;
            attachments.splice(0, 1);
          }
        }
      } catch (e) {}
    }

    let replyToObj = null;
    if (req.body.replyTo) {
      try {
        replyToObj = typeof req.body.replyTo === 'string' ? JSON.parse(req.body.replyTo) : req.body.replyTo;
      } catch (e) {}
    }

    for (const item of entriesArray) {
      const mId = item.mediaId;
      const rId = item.rentalDueId;
      const mDetailId = item.mediaDetailId || item.mediaDetailsId;
      const lOwnerId = item.landOwnerId || item.landownerId;
      const rem = item.remarks || remarks || "";

      if (!mId) continue;
      if (!mongoose.Types.ObjectId.isValid(mId)) continue;

      const trimmedRemarks = typeof rem === "string" ? rem.trim() : "";
      const hasContent = trimmedRemarks || attachments.length > 0 || voiceMessageObj;
      if (!hasContent) continue;

      const media = await Media.findById(mId);
      if (!media) continue;

      // Sync any active overdue entries for this media first
      await syncAllOverdueEntriesForMedia(media, userName);
      const userTypeNum = Number(req.user?.userType) || null;
      const remarkAddedAt = nowIST();
      const newRemark = {
        mediaDetailId: mDetailId && mongoose.Types.ObjectId.isValid(mDetailId) ? new mongoose.Types.ObjectId(mDetailId) : null,
        landOwnerId: lOwnerId && mongoose.Types.ObjectId.isValid(lOwnerId) ? new mongoose.Types.ObjectId(lOwnerId) : null,
        remarks: trimmedRemarks,
        addedBy: userName,
        addedAt: remarkAddedAt,
        userType: userTypeNum,
        role: userTypeNum,
        readByRoles: userTypeNum ? [userTypeNum] : [],
        // ✅ NEW — delivered on send to every user of the other roles
        // (RE → RM + CMD, RM → RE + CMD, CMD → RE + RM)
        deliveredTo: await overdueRemarkReceivers(userTypeNum, req.user?._id || req.user?.userId || req.user?.id, remarkAddedAt),
        attachments,
        voiceMessage: voiceMessageObj,
        replyTo: replyToObj,
      };

      // Find matching rentalDue entry from media to populate full overdue details
      let targetEntry = null;
      if (rId && mongoose.Types.ObjectId.isValid(rId)) {
        targetEntry = (media.rentalDue || []).find((e) => String(e._id) === String(rId));
      }
      if (!targetEntry && mDetailId && mongoose.Types.ObjectId.isValid(mDetailId)) {
        targetEntry = (media.rentalDue || []).find((e) => String(e.mediaDetailId || "") === String(mDetailId));
      }
      if (!targetEntry && (media.rentalDue || []).length > 0) {
        targetEntry = (media.rentalDue || [])[(media.rentalDue || []).length - 1];
      }

      // Extract approval details from targetEntry if available
      const staffStep = (targetEntry?.approvalSteps || []).find(
        (s) => Number(s.role) === 1 && (Number(s.status) === 2 || s.approvedAt)
      );
      const teamLeadStep = (targetEntry?.approvalSteps || []).find(
        (s) => Number(s.role) === 2 && (Number(s.status) === 2 || s.approvedAt)
      );
      const ownerStep = (targetEntry?.approvalSteps || []).find(
        (s) => Number(s.role) === 3 && (Number(s.status) === 2 || s.approvedAt)
      );

      const staffApprovedAt = staffStep?.approvedAt || null;
      const staffApprovedBy = staffStep?.userName || null;

      const teamLeadApprovedAt = teamLeadStep?.approvedAt || null;
      const teamLeadApprovedBy = teamLeadStep?.userName || null;

      const ownerApprovedAt =
        ownerStep?.approvedAt ||
        targetEntry?.ownerApprovalDate ||
        (Number(targetEntry?.approvalStatus) === 3 ? targetEntry?.updatedAt || nowIST() : null);
      const ownerApprovedBy =
        ownerStep?.userName ||
        (Number(targetEntry?.approvalStatus) === 3 ? userName : null);

      const calcDiffDays = (date) => {
        if (!date || !targetEntry?.dueDate) return "-";
        const diff = Math.floor((new Date(date) - new Date(targetEntry.dueDate)) / 86400000);
        return diff > 0 ? `${diff} days` : "0 days";
      };

      const OverdueByStaff = calcDiffDays(staffApprovedAt);
      const OverdueByTeamLead = calcDiffDays(teamLeadApprovedAt);
      const OverdueByCMD = calcDiffDays(ownerApprovedAt);

      const query = { mediaId: media._id };
      if (rId && mongoose.Types.ObjectId.isValid(rId)) {
        query.rentalDueId = new mongoose.Types.ObjectId(rId);
      }

      let overdueRecords = await OverDueHistory.find(query);
      if (overdueRecords.length === 0 && rId && mongoose.Types.ObjectId.isValid(rId)) {
        overdueRecords = await OverDueHistory.find({ mediaId: media._id });
      }

      if (overdueRecords.length > 0) {
        for (const record of overdueRecords) {
          if (!Array.isArray(record.overDueRemarks)) {
            record.overDueRemarks = [];
          }
          record.overDueRemarks.push(newRemark);
          record.remarks = trimmedRemarks;
          record.updatedBy = userName;
          record.updatedAt = nowIST();

          if (targetEntry) {
            if (!record.rentalDueId) record.rentalDueId = targetEntry._id;
            if (!record.dueMonth) record.dueMonth = targetEntry.dueMonth;
            if (!record.dueDate) record.dueDate = targetEntry.dueDate;
            if (!record.currentBillDate) record.currentBillDate = targetEntry.dueDate;
            if (!record.overDueAmount || record.overDueAmount === 0) {
              record.overDueAmount = Number(targetEntry.netPayable || targetEntry.baseAmount || 0);
            }
            if (!record.gstAmount || record.gstAmount === 0) {
              record.gstAmount = Number(targetEntry.gstAmount || 0);
            }
            if (!record.withGst) record.withGst = Number(targetEntry.withGst || 0);
            if (!record.status) record.status = targetEntry.approvalStatus || 2;

            if (staffApprovedAt && !record.staffApprovedAt) {
              record.staffApprovedAt = staffApprovedAt;
              record.staffApprovedBy = staffApprovedBy;
              record.OverdueByStaff = OverdueByStaff;
            }
            if (teamLeadApprovedAt && !record.teamLeadApprovedAt) {
              record.teamLeadApprovedAt = teamLeadApprovedAt;
              record.teamLeadApprovedBy = teamLeadApprovedBy;
              record.OverdueByTeamLead = OverdueByTeamLead;
            }
            if (ownerApprovedAt && !record.ownerApprovedAt) {
              record.ownerApprovedAt = ownerApprovedAt;
              record.ownerApprovedBy = ownerApprovedBy;
              record.approvedDate = ownerApprovedAt;
              record.removedDate = ownerApprovedAt;
              record.OverdueByCMD = OverdueByCMD;
              record.approvalOverdueBy = OverdueByCMD;
            }
          }

          await record.save();
        }
      } else {
        const entryGst = targetEntry ? Number(targetEntry.gstAmount || 0) : 0;
        const siteGst = Number(media.rentalPayment?.gstAmount || 0);
        const ownerGst = (media.landOwners || []).filter(o => Number(o.gstApplicable) === 1).reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
        let resolvedGst = entryGst > 0 ? entryGst : (siteGst > 0 ? siteGst : ownerGst);

        let baseAmount = targetEntry
          ? Number(targetEntry.netPayable || targetEntry.baseAmount || 0)
          : Number(media.rentalPayment?.totalRentalAmount || 0);
        // ✅ NEW — single-bill multi-face site: store the whole bill (one row per site / month)
        const remarkSiteBill = siteBillForOverdue(media, targetEntry ? targetEntry.dueDate : null);
        if (remarkSiteBill) {
          resolvedGst = remarkSiteBill.gst;
          baseAmount = Number(targetEntry?.withGst) === 2 ? remarkSiteBill.rent + remarkSiteBill.gst : remarkSiteBill.rent;
        }

        const mDetails = (media.mediaDetails || []).map((d) => ({
          mediaCode: d.mediaCode,
          mediaName: d.mediaName,
          mediaType: d.mediaType,
          city: d.city,
          location: d.location,
        }));

        const lOwners = (media.landOwners || []).map((o) => ({
          landOwnerMasterId: o.landOwnerMasterId || null,
          name: o.name || o.landOwnerName || "",
          landOwnerName: o.name || o.landOwnerName || "",
          phone: o.phone || "",
          panNumber: o.panNumber || "",
          accountNumber: o.accountNumber || "",
          bankName: o.bankName || "",
          ifsc: o.ifsc || "",
          paymentCategory: o.paymentCategory,
          sharePercentage: o.sharePercentage,
          shareAmount: o.shareAmount,
          gstApplicable: o.gstApplicable,
          gstAmount: o.gstAmount,
        }));

        const mainLandOwnerName = lOwners
          .map((o) => o.name || o.landOwnerName)
          .filter(Boolean)
          .join(", ");

        await OverDueHistory.create({
          mediaId: media._id,
          rentalDueId: targetEntry ? targetEntry._id : (rId && mongoose.Types.ObjectId.isValid(rId) ? new mongoose.Types.ObjectId(rId) : null),
          mediaDetails: mDetails,
          landOwners: lOwners,
          landOwnerName: mainLandOwnerName,
          previousBillDate: media.rentalPayment?.previousBillGenerateDate,
          currentBillDate: targetEntry ? targetEntry.dueDate : media.rentalPayment?.nextBillingDate,
          nextBillDate: media.rentalPayment?.nextBillingDate,
          dueMonth: targetEntry ? targetEntry.dueMonth : getDueMonthLabel(media.rentalPayment?.nextBillingDate || new Date()),
          dueDate: targetEntry ? targetEntry.dueDate : (media.rentalPayment?.nextBillingDate || new Date()),
          overDueAmount: baseAmount,
          gstAmount: resolvedGst,
          isGstApplicable: resolvedGst > 0,
          withGst: targetEntry ? Number(targetEntry.withGst || 0) : Number(media.rentalPayment?.gstApplicable || 0),
          status: targetEntry ? (targetEntry.approvalStatus || 2) : 2,
          approvedDate: ownerApprovedAt || null,
          removedDate: ownerApprovedAt || null,
          staffApprovedAt,
          staffApprovedBy,
          teamLeadApprovedAt,
          teamLeadApprovedBy,
          ownerApprovedAt,
          ownerApprovedBy,
          OverdueByStaff,
          OverdueByTeamLead,
          OverdueByCMD,
          approvalOverdueBy: ownerApprovedAt ? OverdueByCMD : "-",
          remarks: trimmedRemarks,
          overDueRemarks: [newRemark],
          updatedBy: userName,
          createdAt: nowIST(),
          updatedAt: nowIST(),
        });
      }

      savedResults.push({
        mediaId: String(mId),
        rentalDueId: rId ? String(rId) : null,
        mediaDetailId: mDetailId ? String(mDetailId) : null,
        landOwnerId: lOwnerId ? String(lOwnerId) : null,
        remarks: trimmedRemarks,
        addedBy: userName,
        addedAt: newRemark.addedAt,
        userType: userTypeNum,
role: userTypeNum,
roleName: REMARK_ROLE_NAME[userTypeNum] || "User",
      });

      // ✅ NEW — Google Chat message after the remark is saved
      notifyOverdueRemarkChat({
        media,
        mediaDetailId: newRemark.mediaDetailId,
        landOwnerId: newRemark.landOwnerId,
        dueMonth: targetEntry ? targetEntry.dueMonth : getDueMonthLabel(media.rentalPayment?.nextBillingDate || new Date()),
        remark: trimmedRemarks,
        userType: Number(req.user?.userType),
        userName,
        attachments: [...(attachments || []), ...(voiceMessageObj?.audioUrl ? [voiceMessageObj] : [])],
        replyTo: replyToObj,
      });

      // ✅ NEW — overdue remark notification (read only)
      await createOverdueRemarkNotification({
        media,
        dueMonth: targetEntry ? targetEntry.dueMonth : getDueMonthLabel(media.rentalPayment?.nextBillingDate || new Date()),
        rentalDueId: targetEntry ? targetEntry._id : rId,
        mediaDetailId: newRemark.mediaDetailId,
        remark: trimmedRemarks,
        userType: Number(req.user?.userType),
        userId: req.user?.userId,
        userName,
        attachments: [...(attachments || []), ...(voiceMessageObj?.audioUrl ? [voiceMessageObj] : [])],
        replyTo: replyToObj,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Overdue remarks saved successfully",
      data: savedResults,
    });
  } catch (err) {
    console.error("overDueRemark error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

exports.getOverDueRemarks = async (req, res) => {
  try {
    const mediaIdParam = req.query.mediaId || req.body?.mediaId;

    const parseIds = (param) => {
      if (!param) return [];
      if (Array.isArray(param)) return param.map(String).map(id => id.trim()).filter(Boolean);
      let s = String(param).trim();
      if (s.startsWith("[") && s.endsWith("]")) {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) {
            return parsed.map(String).map(id => id.trim()).filter(Boolean);
          }
        } catch (_) {}
      }
      return s.replace(/[\[\]"]/g, "").split(",").map(id => id.trim()).filter(Boolean);
    };

    const mediaIds = parseIds(mediaIdParam);

    const query = {};
    if (mediaIds.length > 0) {
      const validMediaIds = mediaIds.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (validMediaIds.length > 0) {
        query.mediaId = { $in: validMediaIds.map(id => new mongoose.Types.ObjectId(id)) };
      }
    }

    const records = await OverDueHistory.find(query).lean();
    // ✅ NEW — isRead per remark for the logged-in role (from the token)
    const viewerRole = Number(req.user?.userType) || null;
    // ✅ NEW — the logged-in role's overdueRemark notification for each record
    // (one per site + month), so the frontend can send its notificationId to
    // /admin/cmd-notifications/read. The adding role has no notification → null.
    const CmdNotification = require("../../../models/Admin/NotificationSchema/CmdNotificationSchema");
    const remarkNotifications = viewerRole && records.length
      ? await CmdNotification.find({
          notificationType: "overdueRemark",
          targetRole: viewerRole,
          mediaId: { $in: [...new Set(records.map((r) => String(r.mediaId)))].map((id) => new mongoose.Types.ObjectId(id)) },
        })
          .select("_id mediaId dueMonth rentalDueId")
          .lean()
      : [];
    const notificationIdFor = (rec) => {
      const sameSite = remarkNotifications.filter((n) => String(n.mediaId) === String(rec.mediaId));
      const match =
        (rec.dueMonth && sameSite.find((n) => n.dueMonth === rec.dueMonth)) ||
        (rec.rentalDueId && sameSite.find((n) => String(n.rentalDueId) === String(rec.rentalDueId)));
      return match ? match._id : null;
    };
const UserModel = require("../../../models/Admin/UserSchema/UserSchema");
const allUsers = await UserModel.find({}, "userName userType").lean();
const roleByName = new Map(allUsers.map((u) => [String(u.userName).trim().toLowerCase(), Number(u.userType)]));


records.forEach((rec) => {
  if (Array.isArray(rec.overDueRemarks)) {
    const recNotificationId = notificationIdFor(rec); // ✅ NEW
    rec.overDueRemarks.forEach((r) => {
      let rNum = Number(r.role || r.userType) || null;
      if (!rNum && r.addedBy) {
        rNum = roleByName.get(String(r.addedBy).trim().toLowerCase()) || null;
        if (!rNum) {
          const lower = String(r.addedBy).trim().toLowerCase();
          if (lower.includes("cmd") || lower.includes("owner")) rNum = 3;
          else if (lower.includes("manager") || lower.includes("team lead")) rNum = 2;
          else if (lower.includes("executive") || lower.includes("staff")) rNum = 1;
        }
      }
      r.role = rNum;
      r.userType = rNum;
      r.roleName = REMARK_ROLE_NAME[rNum] || "User";
      // ✅ NEW — read for the adding role, or once this role read it; remarks
      // saved before read tracking existed (no readByRoles) count as read
      r.isRead = !Array.isArray(r.readByRoles)
        ? true
        : (!!viewerRole && rNum === viewerRole) || r.readByRoles.map(Number).includes(viewerRole);
      delete r.readByRoles;
      // ✅ NEW — send this to /admin/cmd-notifications/read; null for the
      // adding role's own remark (no notification to read)
      r.notificationId = !!viewerRole && rNum === viewerRole ? null : recNotificationId;
      istRemarkEditTimes(r); // ✅ NEW — editedAt in IST, same as addedAt
    });
  }
});
    return res.status(200).json({
      success: true,
      message: "Overdue remarks fetched successfully",
      data: records,
    });
  } catch (err) {
    console.error("getOverDueRemarks error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
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
      message: "gstCycleIds must be a non-empty array of GST balance record IDs",
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
      (g) => String(g._id) === String(id) || String(g.rentalDueId) === String(id),
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
  await media.save({ timestamps: false });

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

      return res.status(200).json({
        success: true,
        message: `GST marked paid across ${results.length} site(s)`,
        data: {
          results,
          totalSites: results.length,
          totalGstPaid: results.reduce((s, r) => s + (r.totalGstPaid || 0), 0),
          successCount,
          failedCount: results.length - successCount,
        },
      });
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid mediaId is required" });
    }

    const result = await processSingleGstPayment({ mediaId, gstCycleIds, userName });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return res.status(statusCode).json({
        success: false,
        message: result.message,
        notFoundIds: result.notFoundIds,
        alreadyPaidIds: result.alreadyPaidIds,
      });
    }

    return res.status(200).json({
      success: true,
      message: `${result.updatedCount} GST cycle record(s) marked as paid`,
      data: {
        mediaId: result.mediaId,
        updatedRecords: result.updatedRecords,
        notFoundIds: result.notFoundIds,
        alreadyPaidIds: result.alreadyPaidIds,
        balanceGstAmount: result.balanceGstAmount,
        gstBalanceHistory: result.gstBalanceHistory,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ── revertAgreementDocVerification — one site ──────────────────
// ✅ FIXED — every verify PUSHES a progress snapshot, so a cycle can have
// several rows and readers use the latest one. Deleting only the first row
// left the newest one (e.g. ownerVerified: true) in place, and the old
// .pop() fallback could delete another cycle's progress. Now: drop ALL rows
// of this cycle, then save one fresh row recalculated from the verifications
// that remain (same rules as the verify flow).
function rebuildVerificationProgress(media, cycle, userType, rentalDueId) {
  if (!Array.isArray(media.verificationProgressHistory) || !cycle) return;

  media.verificationProgressHistory = media.verificationProgressHistory.filter(
    (h) => !isSameCycle(h.cycle, cycle),
  );

  const remaining = (media.agreementDocVerification || []).filter(
    (h) => h.isVerified && isSameCycle(h.cycle, cycle),
  );
  if (remaining.length) {
    const staffVerified = remaining.some((h) => h.verifiedByRole === ROLE.STAFF);
    const teamLeadVerified = remaining.some((h) => h.verifiedByRole === ROLE.TEAM_LEAD);
    const ownerVerified = remaining.some((h) => h.verifiedByRole === ROLE.OWNER);
    const verifiedCount = [staffVerified, teamLeadVerified, ownerVerified].filter(Boolean).length;
    saveVerificationProgressSnapshot(
      media,
      cycle,
      {
        staffVerified,
        teamLeadVerified,
        ownerVerified,
        verifiedCount,
        isComplete: verifiedCount >= 2,
        highestVerifiedRole: ownerVerified
          ? ROLE.OWNER
          : teamLeadVerified
            ? ROLE.TEAM_LEAD
            : staffVerified
              ? ROLE.STAFF
              : null,
      },
      `${ROLE_LABEL[userType]} verification reverted`,
      rentalDueId || null,
    );
  }
  media.markModified("verificationProgressHistory");
}

async function processSingleRevertVerification({ mediaId, rentalDueId, role, strictRentalDueId = false }) {
  const userType = Number(role);

  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }
  if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
    return { success: false, mediaId, message: "role must be 1 (Staff), 2 (Team Lead) or 3 (Owner)" };
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    return { success: false, mediaId, message: "Media not found" };
  }

  if (!Array.isArray(media.agreementDocVerification) || !media.agreementDocVerification.length) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: "No verification records found to revert",
    };
  }

  const entriesList = Array.isArray(media.rentalDue)
    ? media.rentalDue
    : Array.isArray(media.rentalDueEntries)
      ? media.rentalDueEntries
      : [];

  const targetEntry = rentalDueId
    ? entriesList.find((e) => String(e._id) === String(rentalDueId))
    : null;

  const targetCycle = targetEntry?.dueDate ? getCurrentCycle(targetEntry.dueDate) : null;

  // ✅ NEW — entries[] batch: the given rentalDueId must belong to this site
  if (strictRentalDueId && (!rentalDueId || !targetEntry)) {
    return {
      success: false,
      mediaId,
      mediaName: media.mediaName,
      message: rentalDueId ? "rentalDueId not found on this site" : "rentalDueId is required for each entry",
    };
  }

  const match = media.agreementDocVerification
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => {
      if (rec.verifiedByRole !== userType || !rec.isVerified) return false;
      if (rentalDueId) {
        if (rec.rentalDueId && String(rec.rentalDueId) === String(rentalDueId)) return true;
        if (targetCycle && rec.cycle && isSameCycle(rec.cycle, targetCycle)) return true;
        return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.rec.verifiedAt) - new Date(a.rec.verifiedAt))[0];

  if (!match) {
    // ✅ NEW — the role's record is already gone, but the cycle's progress row
    // still says that role verified (stale row left by the old revert logic).
    // Rebuild the progress from the records that remain, so the revert succeeds.
    const PROGRESS_FLAG = { [ROLE.STAFF]: "staffVerified", [ROLE.TEAM_LEAD]: "teamLeadVerified", [ROLE.OWNER]: "ownerVerified" };
    // a rentalDueId that is not on this site never repairs another cycle's row
    const staleRows = rentalDueId && !targetCycle
      ? []
      : (media.verificationProgressHistory || []).filter(
          (h) => h[PROGRESS_FLAG[userType]] === true && (!targetCycle || isSameCycle(h.cycle, targetCycle)),
        );
    const staleCycle = staleRows.length
      ? staleRows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0].cycle
      : null;
    const stillVerifiedHigher = staleCycle && media.agreementDocVerification.some(
      (h) => h.isVerified && isSameCycle(h.cycle, staleCycle) && ROLE_RANK[h.verifiedByRole] > ROLE_RANK[userType],
    );

    if (!staleCycle || stillVerifiedHigher) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: `No verification record found for ${ROLE_LABEL[userType]} to revert`,
      };
    }

    rebuildVerificationProgress(media, staleCycle, userType, rentalDueId);
    await media.save({ timestamps: false });
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

  const ROLE_RANK_LOCAL = { [ROLE.STAFF]: 1, [ROLE.TEAM_LEAD]: 2, [ROLE.OWNER]: 3 };
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

  rebuildVerificationProgress(media, cycle, userType, rentalDueId);

  const flagKey = ROLE_FLAG_KEY[userType];
  if (flagKey && media.agreementDocVerified) {
    media.agreementDocVerified[flagKey] = false;
    media.markModified("agreementDocVerified");
  }

  if (Array.isArray(media.agreementDocVerificationHistory)) {
    const targetId = rentalDueId || (targetEntry ? targetEntry._id : null);
    const histMatch = media.agreementDocVerificationHistory
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => {
        if (h.verifiedByRole !== userType) return false;
        if (targetId) return String(h.rentalDueId) === String(targetId);
        return true;
      })
      .sort((a, b) => new Date(b.h.verifiedAt) - new Date(a.h.verifiedAt))[0];

    if (histMatch) {
      media.agreementDocVerificationHistory.splice(histMatch.i, 1);
      media.markModified("agreementDocVerificationHistory");
    }
  }

  await media.save({ timestamps: false });

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
    const { mediaId, rentalDueId, mediaIds, entries, role } = req.body;

    // ✅ NEW — batch mode with per-site targeting (same format as verify-agreement):
    // entries: [ { mediaId, rentalDueId, role? }, ... ] — item.role overrides the top-level role
    if (Array.isArray(entries) && entries.length > 0) {
      const results = [];
      for (const item of entries) {
        const result = await processSingleRevertVerification({
          mediaId: item?.mediaId,
          rentalDueId: item?.rentalDueId,
          role: item?.role ?? role,
          strictRentalDueId: true,
        });
        results.push({ ...result, rentalDueId: item?.rentalDueId || null });
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return res.status(200).json({
        success: true,
        message: `Verification reverted for ${successCount} of ${results.length} entr${results.length === 1 ? "y" : "ies"}`,
        data: { results, totalEntries: results.length, successCount, failedCount },
      });
    }

    // ── NEW — batch mode ──
    if (Array.isArray(mediaIds) && mediaIds.length > 0) {
      const results = [];
      for (const id of mediaIds) {
        const result = await processSingleRevertVerification({ mediaId: id, rentalDueId, role });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return res.status(200).json({
        success: true,
        message: `${ROLE_LABEL[Number(role)] || "Role"} verification reverted for ${successCount} of ${results.length} site(s)`,
        data: { results, totalSites: results.length, successCount, failedCount },
      });
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    const result = await processSingleRevertVerification({ mediaId, rentalDueId, role });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return res.status(statusCode).json({ success: false, message: result.message });
    }

    return res.status(200).json({
      success: true,
      message: `${result.roleLabel} document verification reverted successfully`,
      data: {
        mediaId: result.mediaId,
        role: result.role,
        roleLabel: result.roleLabel,
        agreementDocVerified: result.agreementDocVerified,
        agreementDocVerification: result.agreementDocVerification,
        verificationProgressHistory: result.verificationProgressHistory,
        agreementDocVerificationHistory: result.agreementDocVerificationHistory,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ── revertRentalApproval — one site ─────────────────────────────
async function processSingleRevertApproval({ mediaId, rentalDueId, role, strictRentalDueId = false }) {
  const userType = Number(role);

  if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
    return { success: false, mediaId, message: "A valid mediaId is required" };
  }
  if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
    return { success: false, mediaId, message: "role must be 1 (Staff), 2 (Team Lead) or 3 (Owner)" };
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
  let entry = entries[entries.length - 1];
  if (rentalDueId) {
    const found = entries.find((e) => String(e._id) === String(rentalDueId));
    if (found) entry = found;
    // ✅ NEW — entries[] batch: never fall back to another entry
    else if (strictRentalDueId) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: "rentalDueId not found on this site",
      };
    }
  } else if (strictRentalDueId) {
    return { success: false, mediaId, mediaName: media.mediaName, message: "rentalDueId is required for each entry" };
  }

  ensureApprovalStepsPopulated(entry);
  let reverted = false;

  if (userType === ROLE.STAFF) {
    const staffStep = entry.approvalSteps?.find((s) => s.role === ROLE.STAFF);
    const isStaffApproved =
      staffStep?.status === 2 ||
      staffStep?.status === 3 ||
      entry.approvalStatus >= 2 ||
      media.rentalStatus === 1;

    if (!isStaffApproved) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: "Staff approval hasn't happened yet for this cycle",
      };
    }

    const laterStepsUntouched = entry.approvalSteps
      ?.filter((s) => s.role !== ROLE.STAFF)
      .every((s) => s.status === 1);

    if (!laterStepsUntouched) {
      return {
        success: false,
        mediaId,
        mediaName: media.mediaName,
        message: "Cannot revert Staff approval — Team Lead/Owner has already acted on this entry",
      };
    }

    media.rentalStatus = 0;
    reverted = true;

    if (entry.savedBy?.userName === "System (auto-generated)") {
      entry.approvalStatus = 1;
      entry.currentPendingRole = ROLE.STAFF;
      entry.status = 1;
      entry.agreementDocVerified = false;
      if (staffStep) {
        staffStep.userId = null;
        staffStep.userName = "";
        staffStep.approvedAt = null;
        staffStep.status = 1;
        staffStep.docVerified = false;
      }
      media.markModified(entriesField);
    } else {
      media[entriesField] = entries.filter((e) => String(e._id) !== String(entry._id));
      media.markModified(entriesField);
    }

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
    const tlStep = entry.approvalSteps?.find((s) => s.role === ROLE.TEAM_LEAD);
    const isTeamLeadApproved =
      tlStep?.status === 2 ||
      media.rentalStatus === 2 ||
      (entry.approvalStatus >= 2 && entry.currentPendingRole === ROLE.OWNER);

    if (!isTeamLeadApproved) {
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

    if (tlStep) {
      tlStep.userId = null;
      tlStep.userName = "";
      tlStep.approvedAt = null;
      tlStep.status = 1;
      tlStep.docVerified = false;
    }
    media.markModified(entriesField);
  } else if (userType === ROLE.OWNER) {
    const ownerStep = entry.approvalSteps?.find((s) => s.role === ROLE.OWNER);
    const isOwnerApproved =
      ownerStep?.status === 2 ||
      media.rentalStatus === 3 ||
      entry.approvalStatus === 3;

    if (!isOwnerApproved) {
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

  await media.save({ timestamps: false });

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
    const { mediaId, rentalDueId, mediaIds, entries, role } = req.body;

    // ✅ NEW — batch mode with per-site targeting:
    // entries: [ { mediaId, rentalDueId, role? }, ... ] — item.role overrides the top-level role.
    // Approvals are per rental due entry, so send one item per face for separate-bill sites.
    if (Array.isArray(entries) && entries.length > 0) {
      const results = [];
      for (const item of entries) {
        const result = await processSingleRevertApproval({
          mediaId: item?.mediaId,
          rentalDueId: item?.rentalDueId,
          role: item?.role ?? role,
          strictRentalDueId: true,
        });
        results.push({ ...result, rentalDueId: item?.rentalDueId || null });
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return res.status(200).json({
        success: true,
        message: `Approval reverted for ${successCount} of ${results.length} entr${results.length === 1 ? "y" : "ies"}`,
        data: { results, totalEntries: results.length, successCount, failedCount },
      });
    }

    // ── NEW — batch mode ──
    if (Array.isArray(mediaIds) && mediaIds.length > 0) {
      const results = [];
      for (const id of mediaIds) {
        const result = await processSingleRevertApproval({ mediaId: id, rentalDueId, role });
        results.push(result);
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.length - successCount;

      return res.status(200).json({
        success: true,
        message: `${ROLE_LABEL[Number(role)] || "Role"} approval reverted for ${successCount} site(s)`,
        data: { results, totalSites: results.length, successCount, failedCount },
      });
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    const result = await processSingleRevertApproval({ mediaId, rentalDueId, role });

    if (!result.success) {
      const statusCode = result.message === "Media not found" ? 404 : 400;
      return res.status(statusCode).json({ success: false, message: result.message });
    }

    return res.status(200).json({
      success: true,
      message: `${result.roleLabel} approval reverted successfully`,
      data: {
        mediaId: result.mediaId,
        role: result.role,
        roleLabel: result.roleLabel,
        reverted: result.reverted,
        rentalStatus: result.rentalStatus,
        rentalDueEntry: result.rentalDueEntry,
        rentalPayment: result.rentalPayment,
        agreementDocVerified: result.agreementDocVerified,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

async function atomicallyEnsureOrUpdateRentalDueEntry(mediaId, newEntry) {
  const updated = await Media.findOneAndUpdate(
    {
      _id: mediaId,
      rentalDue: {
        $elemMatch: {
          dueMonth: newEntry.dueMonth,
          mediaDetailId: newEntry.mediaDetailId || null
        },
      },
    },
    {
      $set: {
        "rentalDue.$[elem].dueDate": newEntry.dueDate,
      },
    },
    {
      returnDocument: 'after',
      timestamps: false,
      arrayFilters: [
        {
          "elem.dueMonth": newEntry.dueMonth,
          "elem.mediaDetailId": newEntry.mediaDetailId || null
        },
      ],
    },
  );
  if (updated) return { result: updated, action: "updated" };

  const created = await Media.findOneAndUpdate(
    {
      _id: mediaId,
      rentalDue: {
        $not: {
          $elemMatch: {
            dueMonth: newEntry.dueMonth,
            mediaDetailId: newEntry.mediaDetailId || null
          }
        }
      },
    },
    {
      $push: { rentalDue: newEntry },
    },
    { returnDocument: 'after',timestamps: false  },
  );
  return created ? { result: created, action: "created" } : { result: null, action: "none" };
}
// ─────────────────────────────────────────────────────────────
// ✅ SPEED — shared site sweep for /admin/rental-due-list.
// Same per-site steps as before (fresh re-read → catch up missed bills →
// save if changed), 5 sites at a time. Calls arriving while a sweep runs
// wait for THAT sweep (no second one); a sweep finished within
// RENTAL_DUE_SWEEP_REUSE_MS (5 min) is reused, so the list answers quickly.
// ─────────────────────────────────────────────────────────────
const RENTAL_DUE_SWEEP_REUSE_MS = 5 * 60 * 1000;
let rentalDueSweepInFlight = null;
let rentalDueSweepFinishedAt = 0;

async function sweepRentalDueSites() {
  // load only ids up front and re-read each site right before processing it
  // (saving a copy loaded at the start would write stale rentalPayment back)
  const activeSitesForSweep = await Media.find({ "mediaDetails.status": 1 }).select("_id").lean();
  const sweepOneSite = async (sweepSiteId) => {
    const siteDoc = await Media.findById(sweepSiteId);
    if (!siteDoc) return;
    const result = await generateMissedEntriesForMedia(siteDoc, "");
    const generatedCount = result?.generatedEntries?.length || 0;
    // save even when generatedCount is 0, so a freshly seeded nextBillingDate
    // (ensureNextBillingDateSeed inside generateMissedEntriesForMedia) isn't lost
    if (generatedCount > 0 || siteDoc.isModified()) {
      await siteDoc.save({ timestamps: false });
    }
  };
  let nextSweepIdx = 0;
  const sweepWorker = async () => {
    while (nextSweepIdx < activeSitesForSweep.length) {
      const { _id: sweepSiteId } = activeSitesForSweep[nextSweepIdx++];
      await sweepOneSite(sweepSiteId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, activeSitesForSweep.length) }, sweepWorker));
}

async function runSharedRentalDueSweep() {
  if (rentalDueSweepInFlight) return rentalDueSweepInFlight; // join the running sweep
  if (Date.now() - rentalDueSweepFinishedAt < RENTAL_DUE_SWEEP_REUSE_MS) return; // recent sweep reused
  rentalDueSweepInFlight = sweepRentalDueSites()
    .then(() => {
      rentalDueSweepFinishedAt = Date.now();
    })
    .finally(() => {
      rentalDueSweepInFlight = null;
    });
  return rentalDueSweepInFlight;
}

// ✅ NEW — response only: TDS hold status of a site's landowners
// (POST /admin/tds-hold), shown on every bill of the site in rentalDueEntries[].
// hold 1 = any landowner held now; landOwners[] = those ever held.
function buildTdsHoldSummary(landOwners) {
  const everHeld = (landOwners || []).filter((o) => o && o.tdsHoldDetail && o.tdsHoldDetail.heldAt);
  const list = everHeld.map((o) => {
    const t = o.tdsHoldDetail || {};
    const held = Number(o.tdsHold) === 1;
    return {
      landOwnerId: o._id,
      landOwnerMasterId: o.landOwnerMasterId || null,
      landOwnerName: o.name || "",
      tdsHold: held ? 1 : 0, // ✅ CHANGED — API value: 1 = on hold, 0 = released
      holdStatus: held ? "On Hold" : "Released",
      tdsPercentage: Number(o.tdsPercentage || 0),
      tdsAmountBeforeHold: Number(t.tdsAmountBeforeHold || 0),
      tdsAmount: Number(o.tdsAmount || 0),
      remark: t.remark || "",
      heldBy: t.heldBy || "",
      heldAt: t.heldAt || null,
      releasedBy: t.releasedBy || "",
      releasedAt: t.releasedAt || null,
      releaseReason: t.releaseReason || "",
    };
  });
  const holdCount = list.filter((x) => x.holdStatus === "On Hold").length;
  // ✅ CHANGED — API value: hold 1 = a landowner's TDS is on hold, 0 = none held
  return { hold: holdCount > 0 ? 1 : 0, holdCount, landOwners: list };
}

// ✅ NEW — response only: each landOwners[].linkedSites[] item gets the bank
// details that linked site pays to (that site's own landowner row), same as
// /admin/ledger-list. One batched read; never changes stored data or amounts.
async function addBankDetailsToLinkedSites(owners) {
  const linkedPairs = [];
  (owners || []).forEach((owner) =>
    (owner.sites || []).forEach((site) =>
      (site.landOwners || []).forEach((lo) => {
        if (!lo?.landOwnerMasterId) return;
        (lo.linkedSites || []).forEach((ls) => {
          if (ls?.mediaId) linkedPairs.push({ ls, masterId: String(lo.landOwnerMasterId) });
        });
      }),
    ),
  );
  if (linkedPairs.length === 0) return;

  const mediaIds = [...new Set(linkedPairs.map((p) => String(p.ls.mediaId)))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const linkedMedia = await Media.find({ _id: { $in: mediaIds } })
    .select(
      "landOwners.landOwnerMasterId landOwners.bankAccountId landOwners.bankName landOwners.ifsc landOwners.accountNumber landOwners.bankPassbook landOwners.cancelCheckLeaf",
    )
    .lean();
  const bankBySiteOwner = new Map();
  linkedMedia.forEach((m) =>
    (m.landOwners || []).forEach((o) => {
      if (o.landOwnerMasterId) bankBySiteOwner.set(`${String(m._id)}:${String(o.landOwnerMasterId)}`, o);
    }),
  );

  linkedPairs.forEach(({ ls, masterId }) => {
    const o = bankBySiteOwner.get(`${String(ls.mediaId)}:${masterId}`);
    ls.bankAccountId = o?.bankAccountId || null;
    ls.bankName = o?.bankName || "";
    ls.ifsc = o?.ifsc || "";
    ls.accountNumber = o?.accountNumber || "";
    ls.bankPassbook = o?.bankPassbook || null;
    ls.cancelCheckLeaf = o?.cancelCheckLeaf || null;
  });
}

// ✅ NEW — rent revision ADVANCE deducted from this bill (e.g. Dec bill 50k,
// Oct advance 25k → balance 25k). {} when the bill has no advance.
// ✅ NEW — rentalDueEntries[].rentRevision: why this bill's amount changed.
//   bill    → a CMD approved BILL revision changed this bill: "increase" (this
//             month listed, its own amount) or "newRent" (month after the
//             revision with applyToAllMonths 1 → old rent → new rent)
//   arrears → this month was CMD approved before the revision: a separate
//             arrears bill (this bill's amount did not change)
//   advance → an ADVANCE deducted from this bill
// baseRent / baseGstAmount = before all of these, finalRent / finalGstAmount =
// now (this face's share, same split as netPayable). null when none apply.
const RR_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const rrMonthKey = (d) => {
  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt.getUTCFullYear() * 12 + dt.getUTCMonth() : null;
};
const rrKeyOfLabel = (label) => {
  const parts = String(label || "").trim().split(/\s+/);
  const idx = RR_MONTHS.findIndex((m) => m.toLowerCase() === String(parts[0] || "").toLowerCase());
  const year = Number(parts[1]);
  return idx >= 0 && year ? year * 12 + idx : null;
};
const rrLabelOfKey = (k) => `${RR_MONTHS[k % 12]} ${Math.floor(k / 12)}`;
const rrPaymentStatus = (bills) => {
  const sum = (f) => bills.reduce((s, b) => s + Number(b[f] || 0), 0);
  const rentDone = sum("rentPaid") >= sum("netPayable");
  const gstDone = sum("gstPaid") >= sum("gstAmount");
  if (rentDone && gstDone) return "Paid";
  if (sum("rentPaid") > 0 || sum("gstPaid") > 0) return "Partially Paid";
  return "Pending";
};

function rentRevisionForEntry(item, entry, revisions) {
  const key = rrMonthKey(entry?.dueDate) ?? rrKeyOfLabel(entry?.dueMonth);
  if (key === null) return null;
  const r0 = (v) => Math.round(Number(v) || 0);
  const gstNow = Number(entry.gstAmount || 0);
  const finalRent = Number(entry.netPayable || 0) - (Number(entry.withGst) === 2 ? gstNow : 0);
  // this face's share of the site's month rent
  const siteRent = Number(getRentForDueDate(item, entry.dueDate) || 0);
  const ratio = siteRent > 0 ? finalRent / siteRent : 1;

  // arrears bills of this month (this face's bill, else site-level)
  const monthArrears = (item.arrearsBills || []).filter((b) => b && rrMonthKey(b.dueDate) === key);
  const ownArrears = monthArrears.filter((b) => b.parentRentalDueId && String(b.parentRentalDueId) === String(entry._id));
  const arrearsBills = ownArrears.length ? ownArrears : monthArrears.filter((b) => !b.parentRentalDueId);
  const arrearsRevisionIds = new Set(monthArrears.map((b) => String(b.rentRevisionId)));

  // latest CMD approved BILL revision that changed this bill
  let bill = null;
  (revisions || [])
    .filter((r) => r && r.billType !== "ADVANCE")
    .forEach((r) => {
      if (arrearsRevisionIds.has(String(r._id))) return; // arrears instead — bill unchanged
      const months = Array.isArray(r.months) && r.months.length ? r.months : null;
      let amount = null;
      let gst = 0;
      if (months) {
        const m = months.find((x) => rrKeyOfLabel(x.month) === key);
        if (m) {
          amount = Number(m.amount || 0);
          const d = (r.monthsDetail || []).find((x) => x.month === m.month);
          gst = Number(d?.gstAmount || 0);
        }
      } else if (rrMonthKey(r.fromDate) === key) {
        amount = Number(r.increaseAmount ?? r.difference ?? 0);
        gst = Number(r.increaseGstAmount || 0);
      }
      if (amount !== null) {
        bill = {
          type: "increase",
          revisionId: r._id,
          fromMonth: r.fromMonth,
          toMonth: r.toMonth || r.fromMonth,
          increaseAmount: r0(amount * ratio),
          increaseGstAmount: r0(gst * ratio),
          totalIncreaseAmount: Number(r.totalIncreaseAmount || r.increaseAmount || 0),
          approvedAt: r.approvedAt || null,
          reason: r.reason || "",
          _inc: amount * ratio,
          _incGst: gst * ratio,
        };
        return;
      }
      if (r.applyToAllMonths === 0) return;
      const lastKey = months ? Math.max(...months.map((x) => rrKeyOfLabel(x.month)).filter((k) => k !== null)) : rrMonthKey(r.fromDate);
      const inc = Number(r.newRent || 0) - Number(r.oldRent || 0);
      if (lastKey === null || key <= lastKey || inc <= 0) return;
      const incGst = gstNow > 0 ? (inc * Number(r.gstPercentage || 0)) / 100 : 0;
      bill = {
        type: "newRent",
        revisionId: r._id,
        oldRent: Number(r.oldRent || 0),
        newRent: Number(r.newRent || 0),
        nextIncreaseAmount: r.nextIncreaseAmount ?? null,
        fromMonth: r.nextBillFromMonth || rrLabelOfKey(lastKey + 1),
        approvedAt: r.approvedAt || null,
        _inc: inc * ratio,
        _incGst: incGst * ratio,
      };
    });

  const arrears = arrearsBills.length
    ? {
        revisionId: arrearsBills[0].rentRevisionId || null,
        arrearsRentalDueId: arrearsBills[0]._id,
        label: arrearsBills[0].label || "",
        amount: arrearsBills.reduce((s, b) => s + Number(b.netPayable || 0), 0),
        gstAmount: arrearsBills.reduce((s, b) => s + Number(b.gstAmount || 0), 0),
        paymentStatus: rrPaymentStatus(arrearsBills),
      }
    : null;

  // advance deducted from this bill (same rows as advanceFieldsForEntry)
  const advRows = (item?.rentalPayment?.advanceAdjustments || []).filter((a) => a && a.dueMonth === entry.dueMonth);
  let advance = null;
  let advAmt = 0;
  let advGst = 0;
  if (advRows.length) {
    const advBills = advRows
      .map((a) => (item.advanceBills || []).find((b) => String(b._id) === String(a.advanceBillId)))
      .filter(Boolean);
    advAmt = advRows.reduce((s, a) => s + Number(a.amount || 0), 0) * ratio;
    advGst =
      advRows.reduce((s, a) => {
        const b = (item.advanceBills || []).find((x) => String(x._id) === String(a.advanceBillId));
        return s + (Number(a.gstDeducted) === 1 ? Number(b?.gstAmount || 0) : 0);
      }, 0) * ratio;
    advance = {
      revisionId: advRows[0].rentRevisionId || null,
      advanceRentalDueId: advRows[0].advanceBillId || null,
      advanceMonth: advBills[0]?.dueMonth || "",
      advanceAdjusted: r0(advAmt),
      advanceGstAdjusted: r0(advGst),
      paymentStatus: advBills.length ? rrPaymentStatus(advBills) : "Pending",
    };
  }

  if (!bill && !arrears && !advance) return null;
  const inc = bill ? bill._inc : 0;
  const incGst = bill ? bill._incGst : 0;
  if (bill) {
    delete bill._inc;
    delete bill._incGst;
  }
  return {
    baseRent: r0(finalRent - inc + advAmt),
    baseGstAmount: r0(gstNow - incGst + advGst),
    finalRent: r0(finalRent),
    finalGstAmount: r0(gstNow),
    bill,
    arrears,
    advance,
  };
}

function advanceFieldsForEntry(item, entry) {
  const rows = (item?.rentalPayment?.advanceAdjustments || []).filter((a) => a && a.dueMonth === entry?.dueMonth);
  if (!rows.length) return {};
  const bills = item.advanceBills || [];
  const details = rows.map((a) => {
    const b = bills.find((x) => String(x._id) === String(a.advanceBillId)) || {};
    const paid = Number(b.rentPaid || 0) >= Number(b.netPayable || a.amount || 0);
    return {
      rentalDueId: a.advanceBillId || null,
      revisionId: a.rentRevisionId || null,
      advanceMonth: b.dueMonth || "",
      amount: Number(a.amount || 0),
      gstAmount: Number(b.gstAmount || 0),
      isPaid: paid,
    };
  });
  const advanceAdjusted = details.reduce((s, d) => s + d.amount, 0);
  const advanceGstAdjusted = details.reduce((s, d) => s + d.gstAmount, 0);
  const billRent = Number((bills.find((x) => String(x._id) === String(rows[0].advanceBillId)) || {}).billRent || 0);
  return {
    totalRentalAmount: billRent || Number(entry.netPayable || 0) + advanceAdjusted,
    advanceAdjusted,
    advanceGstAdjusted,
    balanceAmount: Number(entry.netPayable || 0),
    balanceGstAmount: Number(entry.gstAmount || 0),
    advanceDetails: details,
  };
}

exports.getRentalDueListWithStats = async (req, res) => {
  try {
    const today = new Date();
    // Normalize today to start of day UTC to match stored dueDates (e.g. 2026-08-15T00:00:00.000Z)
    // This ensures it only becomes "Overdue" the day AFTER the due date.
    today.setUTCHours(0, 0, 0, 0);

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
      edit,
      landOwnerMasterId, // ✅ ADDED — filter to one specific landowner
      mediaId,
      sortOrder,
    } = req.body;

    const targetRole = null; // ✅ Role-based filtering moved to landOwnerSiteFilter

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

    const mediaMatch = { "mediaDetails.status": 1 };
    if (city) mediaMatch["mediaDetails.city"] = { $regex: city, $options: "i" };
    if (mediaType) mediaMatch["mediaDetails.mediaType"] = { $regex: mediaType, $options: "i" };
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
        { "mediaDetails.mediaCode": { $regex: search, $options: "i" } },
        { "mediaDetails.mediaName": { $regex: search, $options: "i" } },
        { "mediaDetails.city": { $regex: search, $options: "i" } },
        { "mediaDetails.location": { $regex: search, $options: "i" } },
        { "landOwners.name": { $regex: search, $options: "i" } },
      ];
    }

    // ✅ FIXED — aggregate() does NOT auto-cast strings to ObjectId
    // the way Model.find() does. Comparing a raw string against the
    // actual ObjectId field in landOwners.landOwnerMasterId silently
    // matched nothing, even though the id was correct — this is why
    // `data` came back empty despite the landowner genuinely existing.
     let landOwnerMasterIdList = [];
    if (landOwnerMasterId) {
      landOwnerMasterIdList = Array.isArray(landOwnerMasterId)
        ? landOwnerMasterId
        : [landOwnerMasterId];

      const invalidId = landOwnerMasterIdList.find(
        (id) => !mongoose.Types.ObjectId.isValid(id),
      );
      if (invalidId) {
        return res.status(400).json({
          success: false,
          message: `Invalid landOwnerMasterId: ${invalidId}`,
        });
      }

      mediaMatch["landOwners.landOwnerMasterId"] = {
        $in: landOwnerMasterIdList.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // ✅ ADDED — mediaId filter, independent of landOwnerMasterId.
    // When sent (single string or array), restricts the query to
    // ONLY those specific sites — so "2 owners" no longer means
    // "every site those 2 owners have", it means "only the site(s)
    // you explicitly asked for, belonging to those owners".
    let mediaIdList = [];
    if (mediaId) {
      mediaIdList = Array.isArray(mediaId) ? mediaId : [mediaId];

      const invalidMediaId = mediaIdList.find(
        (id) => !mongoose.Types.ObjectId.isValid(id),
      );
      if (invalidMediaId) {
        return res.status(400).json({
          success: false,
          message: `Invalid mediaId: ${invalidMediaId}`,
        });
      }

      mediaMatch._id = {
        $in: mediaIdList.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // ✅ FIXED — totalSites now counts EVERY face in the system (from mediaDetails),
    // matching the global onboarding count rather than just the rental-active count.
    // ✅ SPEED — the three counts are independent → run together (same results)
    const [totalFacesAgg, siteCount, activeCountAgg] = await Promise.all([
      Media.aggregate([
        { $unwind: "$mediaDetails" },
        { $count: "count" },
      ]),
      // ✅ FIXED — siteCount now counts EVERY unique document (Site) in onboarding.
      Media.countDocuments({}),
      // ✅ ADDED — activeCount specifically for status: 1 faces (rental-active).
      Media.aggregate([
        { $unwind: "$mediaDetails" },
        { $match: { "mediaDetails.status": 1 } },
        { $count: "count" },
      ]),
    ]);
    const totalSites = totalFacesAgg[0]?.count || 0;
    const activeCount = activeCountAgg[0]?.count || 0;

    // ✅ ADDED — before computing any stats/list data, sweep every
    // active site and catch it up on any missed billing cycles. Same
    // rules as inside saveRentalDue: only CREATES new pending entries
    // for past cycles that don't have one yet (Rule 2), never touches
    // nextBillingDate/lastBillPaidDate (Rule 1). This guarantees the
    // list always reflects up-to-date pending/overdue bills even for
    // sites nobody has opened saveRentalDue for recently.
  // ✅ FIXED — load only ids up front and re-read each site right before
  // processing it. Saving a copy loaded at the start of the sweep wrote
  // stale rentalPayment back over changes made meanwhile (e.g. a CMD
  // billing date revert approval or a manual media edit).
  // ✅ SPEED — one shared sweep: calls arriving together wait for the SAME
  // sweep, and a sweep finished within the last 5 minutes is reused (see
  // runSharedRentalDueSweep). The per-site steps are unchanged.
  await runSharedRentalDueSweep();

    const monthOrCondition = {
      $or: [
        {
          "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
        },
        { "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd } },
      ],
    };

    // ✅ FIXED — stats amounts now come from the SAME cycle-walking summary
    // that feeds overAllCurrentRentalAmount / overAllCurrentMonthGstAmount
    // (getOverallSummaryForCycle), so dueThisMonth / overDue / pending /
    // approved reconcile with the ledger totals. The old aggregation re-priced
    // every raw rentalDue row as totalRentalAmount / faceCount, which also
    // counted stale/duplicate rows and sites whose cycle isn't due this month.
    // rentalDue rows are now used ONLY to decide each face's approval status.
    // ✅ FIXED — shared Rental Due stats (same rule as Dashboard and
    // landowner/site-filter). Overdue = not approved after its due date for the
    // current AND past months (approved-but-unpaid is no longer overdue),
    // 1 day after in IST; appraisal is loaded so pre-appraisal months use old rent.
    const statsDocs = await Media.find(
      { "mediaDetails.status": 1 },
      "status gstApplicableFlag mediaDetails rentalPayment landOwners ledger ledgerHistory gstBalanceHistory rentalDue appraisal",
    ).lean();
    const statsAcc = computeRentalDueStats(statsDocs, { year: yr, month: mo, targetRole });
    const summaryStatsAgg = [statsAcc];

    const stats = summaryStatsAgg[0] || {
      dueThisMonthCount: 0,
      dueThisMonthAmount: 0,
      dueAmountOpen: 0,
      approvedCount: 0,
      approvedAmountTotal: 0,
      overdueCount: 0,
      overdueAmountTotal: 0,
      pendingCount: 0,
      pendingAmountTotal: 0
    };

    const dueThisMonth = {
      totalNetPayable: Math.round(stats.dueThisMonthAmount),
      count: stats.dueThisMonthCount,
    };
    const dueAmountOpen = Math.round(stats.dueAmountOpen);
    const approvedCount = stats.approvedCount;
    const approvedAmountTotal = Math.round(stats.approvedAmountTotal);
    const overDueSiteCount = stats.overdueCount;
    const overDueAmountTotal = Math.round(stats.overdueAmountTotal);
    const pendingCount = stats.pendingCount;
    const pendingAmountTotal = Math.round(stats.pendingAmountTotal);

    const approvalBreakdownAgg = await Media.aggregate([
      { $match: { "mediaDetails.status": 1 } },
      { $unwind: "$rentalDue" },
      {
        $match: {
          "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd },
          "rentalDue.approvalStatus": { $in: [1, 2] },
        },
      },
      // Deduplicate faces per role (Current Month Only)
      {
        $group: {
          _id: {
            role: "$rentalDue.currentPendingRole",
            mediaId: "$_id",
            faceId: "$rentalDue.mediaDetailId"
          }
        }
      },
      { $group: { _id: "$_id.role", count: { $sum: 1 } } },
    ]);
    const pendingByRole = { staff: 0, teamLead: 0, owner: 0, total: 0 };
    approvalBreakdownAgg.forEach(({ _id, count }) => {
      if (_id === 1) pendingByRole.staff = count;
      if (_id === 2) pendingByRole.teamLead = count;
      if (_id === 3) pendingByRole.owner = count;
      pendingByRole.total += count;
    });

    const approvalCompletedBreakdownAgg = await Media.aggregate([
      { $match: { "mediaDetails.status": 1 } },
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

    // ✅ FIXED — since Rule 1 was scrapped, nextBillingDate now
    // auto-advances every cycle REGARDLESS of approval. That means
    // nextBillingDate no longer marks "the stuck unapproved cycle" —
    // it's just wherever the schedule currently sits, possibly
    // already past several unapproved months (e.g. May AND June both
    // pending, nextBillingDate already at July). The old condition
    // matched only ONE entry (dueDate === nextBillingDate), which
    // would never find May or June anymore.
    //
    // Fixed to scan EVERY rentalDue[] entry independently — any entry
    // whose OWN dueDate is before the requested month AND isn't
    // approved (by the target role, or overall) counts as past
    // pending. This correctly surfaces multiple stacked-up pending
    // months, not just one.
    const isPastPendingByRoleCond = {
      $gt: [
        {
          $size: {
            $filter: {
              input: { $ifNull: ["$rentalDue", []] },
              as: "rd",
              cond: {
                $and: [
                  { $lt: ["$$rd.dueDate", monthStart] },
                  targetRole === null
                    ? { $ne: ["$$rd.approvalStatus", 3] }
                    : {
                        $let: {
                          vars: {
                            roleStep: {
                              $first: {
                                $filter: {
                                  input: { $ifNull: ["$$rd.approvalSteps", []] },
                                  as: "s",
                                  cond: { $eq: ["$$s.role", targetRole] },
                                },
                              },
                            },
                          },
                          in: {
                            $and: [
                              { $ne: ["$$rd.approvalStatus", 3] },
                              { $not: [{ $in: ["$$roleStep.status", [2, 3]] }] },
                            ],
                          },
                        },
                      },
                ],
              },
            },
          },
        },
        0,
      ],
    };

    const listMatch = { ...mediaMatch };

    // ✅ FIXED — no longer relies on rentalPayment.nextBillingDate to
    // detect "past pending" sites. Since Rule 1 was scrapped,
    // nextBillingDate auto-advances every cycle regardless of
    // approval, so it no longer marks "the stuck cycle" — it's just
    // wherever the schedule currently sits (often already past every
    // unapproved month). Matching on it here excluded every site with
    // real past-pending entries, causing empty data[] even when
    // pastPendingApproval.count was correctly > 0.
    //
    // Also fixed: isPastPending=1 now ALWAYS includes the current
    // requested month too (e.g. May+June+July together), not just
    // past months — matching what buildFullSiteDetail already returns
    // per-site once the site passes this gate.
    // ✅ FIXED — isPastPending=1 now means PAST-ONLY (excludes current
    // month entirely, e.g. only May+June, never July). Without the
    // flag, behavior is unchanged: matches the current requested
    // month's sites (buildFullSiteDetail below then shows everything
    // pending up through that month, past+current together).
    const explicitMediaIdRequested = mediaIdList.length > 0;

if (Number(isPastPending) === 1) {
  listMatch.rentalDue = {
    $elemMatch: {
      dueDate: { $lt: monthStart },
      approvalStatus: { $ne: 3 },
    },
  };
} else if (!explicitMediaIdRequested) {
  listMatch.$and = [monthOrCondition];
}

    const listPipeline = [
      { $match: listMatch },
      { $match: relevantToRoleMatch },
      {
        $addFields: {
          matchingEntry: {
            $let: {
              vars: {
                filtered: {
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
              in: {
                $let: {
                  vars: {
                    approved: {
                      $filter: {
                        input: "$$filtered",
                        as: "f",
                        cond: { $eq: ["$$f.approvalStatus", 3] },
                      },
                    },
                  },
                  in: {
                    $cond: [
                      { $gt: [{ $size: "$$approved" }, 0] },
                      { $first: "$$approved" },
                      { $first: "$$filtered" },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          isApprovedThisMonth: hasRoleApprovedCond,
          isClosedOverall: isClosedOverallCond,
          hasRoleActed: hasRoleActedCond,
          isOverdueGlobally: {
            $or: [
              { $eq: ["$rentalPayment.status", 3] },
              {
                $and: [
                  { $lt: ["$matchingEntry.dueDate", today] },
                  { $ne: ["$matchingEntry.approvalStatus", 3] },
                ],
              },
            ],
          },
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
        mediaDetails: 1,
        rentalStatus: 1,
        landOwners: 1,
        appraisal: 1,
        frontView: 1,
        rentalPayment: 1,
        agreement: 1,
        agreementDocVerification: 1,
        verificationProgressHistory: 1,
        gstApplicableFlag: 1,
        pastgstApplicableFlag: 1,
        gstBalanceHistory: 1,
        rentalDue: 1,
        // ✅ NEW — rent revision advance bills only (advance deducted from a bill)
        advanceBills: {
          $filter: { input: { $ifNull: ["$arrearsDue", []] }, as: "a", cond: { $eq: ["$$a.type", "advance"] } },
        },
        // ✅ NEW — rent revision arrears bills (rentalDueEntries[].rentRevision)
        arrearsBills: {
          $filter: { input: { $ifNull: ["$arrearsDue", []] }, as: "a", cond: { $eq: ["$$a.type", "arrears"] } },
        },
        updatedAt: 1,
      },
    });

    const sites = await Media.aggregate(listPipeline);

    // ✅ NEW — CMD approved rent revisions of these sites, oldest first
    // (rentalDueEntries[].rentRevision — why a bill's amount changed)
    const approvedRevisionsByMedia = new Map();
    if (sites.length) {
      const revisions = await RentRevision.find({ mediaId: { $in: sites.map((s) => s._id) }, status: "Approved" })
        .sort({ approvedAt: 1 })
        .lean();
      revisions.forEach((r) => {
        const k = String(r.mediaId);
        if (!approvedRevisionsByMedia.has(k)) approvedRevisionsByMedia.set(k, []);
        approvedRevisionsByMedia.get(k).push(r);
      });
    }

    const isSameCycle = (a, b) => {
      if (!a || !b) return false;
      const t1 = new Date(a).getTime();
      const t2 = new Date(b).getTime();
      return !Number.isNaN(t1) && !Number.isNaN(t2) && t1 === t2;
    };

    // ✅ SAME buildVerificationProgress as the site-based list — reused
    // as-is so verificationProgress inside each site entry matches
    // exactly what the original site-based response produced.
  const buildVerificationProgress = (item, targetCycleDate, targetRentalDueId) => {
  const targetCycleStr = getCurrentCycle(targetCycleDate);

  // ✅ FIXED — a billing date revert can move a bill's dueDate AFTER it was
  // verified (e.g. verified on the 16.10 cycle, bill now due 28.10). Its
  // verification records still carry its rentalDueId, so for such a
  // re-dated bill match by rentalDueId as well. Bills never re-dated keep
  // the existing cycle-based logic below unchanged.
  if (targetRentalDueId && isBillRedatedAfterVerification(item, targetRentalDueId, targetCycleStr)) {
    const billVerifications = (item.agreementDocVerification || []).filter(
      (h) =>
        h.isVerified &&
        ((h.rentalDueId && String(h.rentalDueId) === String(targetRentalDueId)) ||
          (h.cycle && targetCycleStr && getCurrentCycle(h.cycle) === targetCycleStr)),
    );
    const staffOk = billVerifications.some((h) => h.verifiedByRole === ROLE.STAFF);
    const teamLeadOk = billVerifications.some((h) => h.verifiedByRole === ROLE.TEAM_LEAD);
    const ownerOk = billVerifications.some((h) => h.verifiedByRole === ROLE.OWNER);
    const count = [staffOk, teamLeadOk, ownerOk].filter(Boolean).length;
    return {
      currentCycle: formatDate(targetCycleStr),
      staffVerified: staffOk,
      teamLeadVerified: teamLeadOk,
      ownerVerified: ownerOk,
      verifiedCount: count,
      isComplete: count >= 2,
      highestVerifiedRole: ownerOk ? ROLE.OWNER : teamLeadOk ? ROLE.TEAM_LEAD : staffOk ? ROLE.STAFF : null,
    };
  }

  const historyForMonth = (item.verificationProgressHistory || []).filter(
    (v) => {
      if (targetRentalDueId && v.rentalDueId) {
        return String(v.rentalDueId) === String(targetRentalDueId);
      }
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
    //
    // ✅ FIXED — rentalDueEntries now ALWAYS includes every NOT-YET-
    // APPROVED month up through the requested month (e.g. May + June
    // + July, all still pending) — no isPastPending flag needed to
    // see them. The instant any of those months gets approved
    // (approvalStatus === 3), it's excluded automatically, since the
    // filter only keeps entries where approvalStatus !== 3. Each
    // entry carries its own verificationProgress, computed for that
    // entry's own dueDate/cycle.
    const buildFullSiteDetail = (item) => {
      // ✅ ADDED — calculate dynamic overdue status for the current cycle
      const currentMonthEntry = (item.rentalDue || []).find((e) => {
        if (!e.dueDate) return false;
        const d = new Date(e.dueDate);
        return d >= monthStart && d <= monthEnd;
      });

      // ✅ FIXED — month-wise billing dates. When the selected month has a billing
      // cycle (its rentalDue entry, or the site's own cycle date in that month),
      // the dates come from THAT cycle instead of the site's latest cycle.
      // No cycle in the selected month → the site-level values, as before.
      const billFreq = Number(item.rentalPayment?.paymentFrequency || 1);
      const billCycleMonths =
        billFreq === 6
          ? Number(item.rentalPayment?.customPaymentFrequency || 1)
          : ({ 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 }[billFreq] || 1);
      // lastBillPaidDate = the previous cycle (the last bill before this one)
      const cycleBillDates = (cycleDate) => ({
        lastBillPaidDate: addMonthsUTC(cycleDate, -billCycleMonths),
        nextBillingDate: addMonthsUTC(cycleDate, billCycleMonths),
        previousBillGenerateDate: formatDate(addMonthsUTC(cycleDate, -billCycleMonths)),
        currentBillDate: formatDate(cycleDate),
      });
      const isInSelectedMonth = (dt) => {
        if (!dt) return false;
        const d = new Date(dt);
        return d >= monthStart && d <= monthEnd;
      };
      // ✅ FIXED — a lastBillPaidDate in a FUTURE month (billing date moved
      // forward by an approved billing date revert) is not a generated bill,
      // so it must not show as that month's billing cycle.
      const lastBillPaid = item.rentalPayment?.lastBillPaidDate
        ? new Date(item.rentalPayment.lastBillPaidDate)
        : null;
      const lastBillPaidIsFutureMonth =
        !!lastBillPaid &&
        lastBillPaid.getUTCFullYear() * 12 + lastBillPaid.getUTCMonth() >
          today.getUTCFullYear() * 12 + today.getUTCMonth();
      const selectedCycleDate = currentMonthEntry?.dueDate
        ? new Date(currentMonthEntry.dueDate)
        : isInSelectedMonth(item.rentalPayment?.nextBillingDate)
          ? new Date(item.rentalPayment.nextBillingDate)
          : !lastBillPaidIsFutureMonth && isInSelectedMonth(item.rentalPayment?.lastBillPaidDate)
            ? new Date(item.rentalPayment.lastBillPaidDate)
            : null;
      let selectedCycleBillDates = selectedCycleDate ? cycleBillDates(selectedCycleDate) : null;
      // ✅ NEW — the selected month's cycle is the site's lastBillPaidDate itself
      // (already paid — e.g. entered at media onboarding, no bill this month) →
      // lastBillPaidDate is that date, nextBillingDate the site's next bill and
      // no current bill date.
      if (
        selectedCycleBillDates &&
        !currentMonthEntry?.dueDate &&
        !isInSelectedMonth(item.rentalPayment?.nextBillingDate) &&
        !lastBillPaidIsFutureMonth &&
        isInSelectedMonth(item.rentalPayment?.lastBillPaidDate)
      ) {
        const siteNext = item.rentalPayment?.nextBillingDate ? new Date(item.rentalPayment.nextBillingDate) : null;
        selectedCycleBillDates = {
          ...selectedCycleBillDates,
          lastBillPaidDate: new Date(item.rentalPayment.lastBillPaidDate),
          nextBillingDate: siteNext && siteNext > lastBillPaid ? siteNext : selectedCycleBillDates.nextBillingDate,
          currentBillDate: "",
        };
      }
      // ✅ FIXED — after a forward move, the cycle right after this one may
      // fall on/before the future lastBillPaidDate and will never be billed;
      // the real next bill is the site's nextBillingDate.
      if (
        selectedCycleBillDates &&
        lastBillPaidIsFutureMonth &&
        item.rentalPayment?.nextBillingDate &&
        new Date(selectedCycleBillDates.nextBillingDate) <= lastBillPaid
      ) {
        selectedCycleBillDates.nextBillingDate = new Date(item.rentalPayment.nextBillingDate);
      }

      // ✅ NEW — month-wise amounts of each rentalDueEntries item (its own dueMonth),
      // from the existing ledger cycle summary (appraisal-aware rent + GST).
      // One summary per month per site.
      const monthSummaryCache = new Map();
      const monthWiseAmountFor = (entry) => {
        if (!entry?.dueDate) return null;
        const d = new Date(entry.dueDate);
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth() + 1;
        const key = `${year}-${month}`;
        if (!monthSummaryCache.has(key)) {
          monthSummaryCache.set(key, getOverallSummaryForCycle(item, { year, month }));
        }
        const s = monthSummaryCache.get(key) || {};
        const totalRentalAmount = Math.round(Number(s.currentMonthRentalAmount || 0));
        const gstAmount = Math.round(Number(s.currentMonthGstAmount || 0));

        return {
          dueMonth: entry.dueMonth,
          totalRentalAmount,
          gstAmount,
          totalAmount: totalRentalAmount + gstAmount,
        };
      };

      const isOverdue =
        item.rentalPayment?.status === 3 ||
        (currentMonthEntry &&
          new Date(currentMonthEntry.dueDate) < today &&
          currentMonthEntry.approvalStatus !== 3);

      const resolvedDueStatus = isOverdue ? 3 : (item.rentalPayment?.status || 1);

      // ✅ FIXED — isPastPending=1 now excludes the current month
      // (dueDate < monthStart, strictly past), so only May/June show,
      // never July. Without the flag: unchanged, dueDate <= monthEnd
      // shows everything pending up through the current month.
          const pendingEntriesUpToMonth = (item.rentalDue || []).filter((e) => {
        if (!e.dueDate) return false;
        const passesDateCheck =
          Number(isPastPending) === 1
            ? new Date(e.dueDate) < monthStart
            : new Date(e.dueDate) <= monthEnd;
        if (!passesDateCheck) return false;

        // ✅ FIXED — the CURRENT requested month's entry must always
        // show, even after Owner approval (approvalStatus === 3).
        // Removing approved entries is still correct for PAST months
        // (isPastPending mode) — only the current month is exempt
        // from being dropped once approved.
        const isCurrentMonthEntry =
          new Date(e.dueDate) >= monthStart && new Date(e.dueDate) <= monthEnd;
        if (isCurrentMonthEntry) return true;

        return Number(e.approvalStatus) !== 3;
      });

      // ✅ ADDED — Dedupe for safety. If multiple entries exist for the same
      // month + face, priority: Approved (3) > most recently updated.
      const dedupedMap = new Map();
      pendingEntriesUpToMonth.forEach((e) => {
        const key = `${String(e.dueMonth).trim()}_${String(e.mediaDetailId || "null")}`;
        const existing = dedupedMap.get(key);
        if (!existing) {
          dedupedMap.set(key, e);
        } else {
          // Priority: 1) Approved (3) wins. 2) Most recent wins.
          const existingStatus = Number(existing.approvalStatus || 0);
          const currentStatus = Number(e.approvalStatus || 0);
          const isBetter =
            (currentStatus === 3 && existingStatus !== 3) ||
            (currentStatus === existingStatus &&
              new Date(e.updatedAt) > new Date(existing.updatedAt));
          if (isBetter) dedupedMap.set(key, e);
        }
      });
      const finalPendingEntries = Array.from(dedupedMap.values()).sort(
        (a, b) => new Date(a.dueDate) - new Date(b.dueDate),
      );

      // ✅ CHANGED — verificationProgressHistory is now ALSO nested
      // per-entry (filtered to that entry's own dueDate/cycle),
      // alongside the already-per-entry verificationProgress. Neither
      // field is returned at the site level anymore — both live only
      // inside each rentalDueEntries[] item, scoped to that specific
      // pending month.
      const filteredRentalDueEntries = finalPendingEntries.map((entry) => {
      const entryObj = entry.toObject ? entry.toObject() : entry;
      const entryCycleKey = entryObj.dueDate ? getCurrentCycle(entryObj.dueDate) : null;
      // ✅ FIXED — a bill re-dated by a billing date revert also shows the
      // history rows of the cycle it was verified under
      const entryVerifiedCycleKeys = isBillRedatedAfterVerification(item, entryObj._id, entryCycleKey)
        ? billVerificationCycles(item, entryObj._id)
        : new Set();

const entryVerificationProgressHistory = (
  item.verificationProgressHistory || []
).filter((v) => {
  if (v.rentalDueId) {
    return String(v.rentalDueId) === String(entryObj._id);
  }
  if (!v.cycle || !entryCycleKey) return false;
  const vCycleKey =
    typeof v.cycle === "string" && v.cycle.match(/^\d{4}-\d{2}-\d{2}$/)
      ? v.cycle
      : getCurrentCycle(v.cycle);
  return vCycleKey === entryCycleKey || entryVerifiedCycleKeys.has(vCycleKey);
});

  const resolvedGstDisplay = resolveGstApplicable(item, entryObj.gstApplicableFlag, entryObj.pastgstApplicableFlag);

  let resolvedEntryGstAmount = Number(entryObj.gstAmount || 0);
  if (resolvedEntryGstAmount === 0) {
    const gstFlag = resolvedGstDisplay.gstApplicableFlag;
    if (gstFlag === 1 && Number(item.rentalPayment?.gstApplicable) === 1) {
      resolvedEntryGstAmount = Number(item.rentalPayment?.gstAmount || 0);
    } else if (gstFlag === 2) {
      resolvedEntryGstAmount = (item.landOwners || [])
        .filter((o) => Number(o.gstApplicable) === 1)
        .reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
    }
  }

  return {
    ...entryObj,
    gstAmount: resolvedEntryGstAmount,
    gstApplicableFlag: resolvedGstDisplay.gstApplicableFlag,
    pastgstApplicableFlag: resolvedGstDisplay.pastgstApplicableFlag,
    verificationProgress: buildVerificationProgress(item, entryObj.dueDate, entryObj._id),
    verificationProgressHistory: entryVerificationProgressHistory,
    gstApplicableDisplay: resolvedGstDisplay,
  };
});

      // verification history across every still-pending cycle shown above
      const pendingCycleKeys = new Set(
  pendingEntriesUpToMonth.map((e) => getCurrentCycle(e.dueDate)),
);

// ✅ FIXED — also keep records of a shown bill that was re-dated after it was
// verified (matched by rentalDueId instead of the moved cycle)
const pendingEntryIds = new Set(pendingEntriesUpToMonth.map((e) => String(e._id)));
const filteredAgreementDocVerificationHistory = (
  item.agreementDocVerification || []
).filter((h) => {
  if (h.rentalDueId && pendingEntryIds.has(String(h.rentalDueId))) return true;
  if (!h.cycle) return false;
  const hCycleKey =
    typeof h.cycle === "string" && h.cycle.match(/^\d{4}-\d{2}-\d{2}$/)
      ? h.cycle
      : getCurrentCycle(h.cycle);
  return pendingCycleKeys.has(hCycleKey);
});

      const parentMediaId = item.mediaId || String(item._id);
const details = (item.mediaDetails || []).map((d) => ({
  ...d,
  mediaId: parentMediaId,
}));

      // ✅ SITE-BASED RENTAL ENTRIES:
      // Always Return one entry per face per month to support tracking different campaigns.
      // Proportional amounts are handled by computeGstSplit during generation.
      const rentalDueEntries = [];
      details.forEach((face) => {
        const faceIdStr = String(face._id);
        filteredRentalDueEntries.forEach((entry) => {
          const entryFaceId = entry.mediaDetailId ? String(entry.mediaDetailId) : null;

          // ✅ Match logic:
          // 1. Exact match for this face ID
          // 2. Site-wide entry (null) ONLY IF this specific face doesn't have its own entry for this month
          let isMatch = false;
          if (entryFaceId === faceIdStr) {
            isMatch = true;
          } else if (entryFaceId === null) {
            const hasSpecificEntry = filteredRentalDueEntries.some(
              (e) => e.dueMonth === entry.dueMonth && String(e.mediaDetailId || "") === faceIdStr
            );
            if (!hasSpecificEntry) isMatch = true;
          }

          if (!isMatch) return;

          rentalDueEntries.push({
            ...entry,
            mediaId: item._id,
            mediaDetailId: face._id,
            mediaName: face.mediaName,
            mediaCode: face.mediaCode,
            rentalDueId: entry._id, // User requested alias
            campaignStatus: entry.campaignStatus ?? null, // ✅ NEW — 0 / 1, null = not set
            billDate: siteBillDate(item), // ✅ NEW — site bill date slot (5/10/15/20/25/30, default 5)
            totalSqFt: face.totalSqFt,
            // ✅ NEW — this entry's own cycle dates (from its dueDate)
            ...(entry.dueDate ? cycleBillDates(new Date(entry.dueDate)) : {}),
            // ✅ NEW — this entry's month-wise amounts (new object)
            monthWiseAmount: monthWiseAmountFor(entry),
            // ✅ NEW — appraisal hold, display fields only (internal restore data
            // — amountsSnapshot, siteReduced, appraisalApplicableBefore,
            // heldByUserId — is not sent)
            // ✅ CHANGED — a later month's bill also shows an earlier month's
            // hold that is still on (e.g. September held → October On Hold)
            ...((ah) =>
              ah
                ? {
                    appraisalHold: {
                      hold: Number(ah.hold) === 1 ? 0 : 1, // ✅ CHANGED — API value: 0 = on hold, 1 = released
                      appraisalAmount: Number(ah.appraisalAmount || 0),
                      rentWithAppraisal: Number(ah.rentWithAppraisal || 0),
                      rentWithoutAppraisal: Number(ah.rentWithoutAppraisal || 0),
                      remark: ah.remark || "",
                      heldBy: ah.heldBy || "",
                      heldAt: ah.heldAt || null,
                      releasedBy: ah.releasedBy || "",
                      releasedAt: ah.releasedAt || null,
                      releaseReason: ah.releaseReason || "",
                      // ✅ NEW — the month whose hold applies here ("" = this bill's own)
                      heldDueMonth: ah.heldDueMonth || "",
                    },
                  }
                : {})(effectiveAppraisalHold(item, entry)),
            // ✅ NEW — TDS hold status of this site's landowners (always present)
            tdsHold: buildTdsHoldSummary(item.landOwners),
            // ✅ NEW — "Save as Draft" values ({ isDraft: 0 } when none)
            draft: formatDraft(entry.draft),
            // ✅ NEW — rent revision advance deducted from this bill
            ...advanceFieldsForEntry(item, entry),
            // ✅ NEW — why this bill's amount changed (BILL increase / new rent /
            // arrears / advance); null when no rent revision touched it
            rentRevision: rentRevisionForEntry(item, entry, approvedRevisionsByMedia.get(String(item._id)) || []),
          });
        });
      });

      return {
        _id: item._id,
        mediaId: parentMediaId,
        mediaCode: details.map(d => d.mediaCode).join(" / "),
        mediaName: details.map(d => d.mediaName).join(", "),
        mediaType: details[0]?.mediaType,
        city: details[0]?.city,
        state: details[0]?.state,
        location: details[0]?.location,
        siteBillMode: details[0]?.siteBillMode,
        rentalStatus: item.rentalStatus,
        totalSqFt: details.reduce((sum, d) => sum + (d.totalSqFt || 0), 0),
        mediaDetails: details,
        totalRentalAmount: item.rentalPayment?.totalRentalAmount || 0,
        netPayable: item.rentalPayment?.netPayable || 0,
        gstApplicable: item.rentalPayment?.gstApplicable || 0,
        gstAmount:
          item.rentalPayment?.gstAmount ||
          (Number(item.rentalPayment?.gstApplicable) === 1
            ? Math.max(
                (item.rentalPayment?.netPayable || 0) -
                  (item.rentalPayment?.totalRentalAmount || 0),
                0,
              )
            : 0),
        landOwners: item.landOwners,
        appraisal: item.appraisal,
        frontView: item.frontView,
        paymentFrequency: item.rentalPayment?.paymentFrequency,
        customPaymentFrequency: item.rentalPayment?.customPaymentFrequency,
        paymentFrequencyLabel:
          FREQ_LABEL[item.rentalPayment?.paymentFrequency] || "",
        nextBillingDate: selectedCycleBillDates
          ? selectedCycleBillDates.nextBillingDate
          : item.rentalPayment?.nextBillingDate,
        lastBillPaidDate: selectedCycleBillDates
          ? selectedCycleBillDates.lastBillPaidDate
          : item.rentalPayment?.lastBillPaidDate,
        previousBillGenerateDate: (() => {
          if (selectedCycleBillDates) return selectedCycleBillDates.previousBillGenerateDate;
          const lp = item.rentalPayment?.lastBillPaidDate;
          const pbgd = item.rentalPayment?.previousBillGenerateDate;

          const freq = Number(item.rentalPayment?.paymentFrequency || 1);
          const custom = Number(item.rentalPayment?.customPaymentFrequency || 1);
          const map = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
          const months = freq === 6 ? custom : (map[freq] || 1);

          const d = new Date(lp);
          d.setUTCMonth(d.getUTCMonth() - months);
          const calculatedPrev = d;

          // ✅ FIXED — If previousBillGenerateDate is inconsistent (e.g. same as lastBillPaidDate
          // or more than 1 cycle away), we return the calculated date.
          if (lp && pbgd) {
            const dLP = new Date(lp);
            const dPBGD = new Date(pbgd);
            const diffMonths =
              (dLP.getUTCFullYear() - dPBGD.getUTCFullYear()) * 12 +
              (dLP.getUTCMonth() - dPBGD.getUTCMonth());

            if (diffMonths === months) {
              return formatDate(pbgd);
            }
          }

          return formatDate(calculatedPrev);
        })(),
        // ✅ FIXED — currentBillDate should only show if a cycle falls in the target month.
        currentBillDate: (() => {
          if (currentMonthEntry) return formatDate(currentMonthEntry.dueDate);
          // ✅ FIXED — same month-wise cycle as the dates above (e.g. a future month's cycle)
          if (selectedCycleBillDates) return selectedCycleBillDates.currentBillDate;

          const nb = item.rentalPayment?.nextBillingDate;
          if (nb) {
            const dnb = new Date(nb);
            if (
              dnb.getUTCMonth() === monthStart.getUTCMonth() &&
              dnb.getUTCFullYear() === monthStart.getUTCFullYear()
            ) {
              return formatDate(nb);
            }
          }
          return "";
        })(),
        dueStatus: resolvedDueStatus,
        dueStatusLabel: STATUS_LABEL[resolvedDueStatus] || "",
        pastgstApplicableFlag: (() => {
          const currentEntry = (item.rentalDue || []).find((e) => {
            if (!e.dueDate) return false;
            const d = new Date(e.dueDate);
            return d >= monthStart && d <= monthEnd;
          });
          if (currentEntry) {
            return resolveGstApplicable(item, currentEntry.gstApplicableFlag, currentEntry.pastgstApplicableFlag).pastgstApplicableFlag;
          }
          const anyEntryWithFlag = (item.rentalDue || []).find(
            (e) => Number(e.gstApplicableFlag) === 1 || Number(e.gstApplicableFlag) === 2 || Number(e.pastgstApplicableFlag) === 1 || Number(e.pastgstApplicableFlag) === 2,
          );
          if (anyEntryWithFlag) {
            return resolveGstApplicable(item, anyEntryWithFlag.gstApplicableFlag, anyEntryWithFlag.pastgstApplicableFlag).pastgstApplicableFlag;
          }
          return resolveGstApplicable(item).pastgstApplicableFlag;
        })(),
        gstApplicableDisplay: (() => {
          // Find the entry for the current requested month to get its specific flags
          const currentEntry = (item.rentalDue || []).find((e) => {
            if (!e.dueDate) return false;
            const d = new Date(e.dueDate);
            return d >= monthStart && d <= monthEnd;
          });
          if (currentEntry) {
            return resolveGstApplicable(item, currentEntry.gstApplicableFlag, currentEntry.pastgstApplicableFlag);
          }
          const anyEntryWithFlag = (item.rentalDue || []).find(
            (e) => Number(e.gstApplicableFlag) === 1 || Number(e.gstApplicableFlag) === 2 || Number(e.pastgstApplicableFlag) === 1 || Number(e.pastgstApplicableFlag) === 2,
          );
          if (anyEntryWithFlag) {
            return resolveGstApplicable(item, anyEntryWithFlag.gstApplicableFlag, anyEntryWithFlag.pastgstApplicableFlag);
          }

          return resolveGstApplicable(item);
        })(),

        agreementPeriod: {
          startDate: item.agreement?.startDate,
          endDate: item.agreement?.endDate,
          agreementPDF: item.agreement?.agreementPDF,
          status: item.agreement?.status,
          agreementStatus: item.agreement?.agreementStatus ?? null, // 1=Original 2=Draft
        },
        agreementDocVerificationHistory:
          filteredAgreementDocVerificationHistory,
        gstBalanceHistory: item.gstBalanceHistory || [],
        gstOutstandingHistory: item.rentalPayment?.gstOutstandingHistory || [], // ✅ NEW
        rentalDueEntries: rentalDueEntries, // ✅ CHANGED: Now contains face-based entries
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

        // ✅ ADDED — when landOwnerMasterId filter is active, only
        // build the entry for THAT owner. Without this, a shared site
        // (e.g. Site B with Ramesh + Suresh) would still leak the
        // OTHER co-owner into the response even though only one was
        // requested.
        if (
          landOwnerMasterIdList.length > 0 &&
          !landOwnerMasterIdList.map(String).includes(key)
        )
          continue;

          if (!ownerMap.has(key)) {
          ownerMap.set(key, {
            landOwnerMasterId: owner.landOwnerMasterId,
            landOwnerName: owner.name,
            phone: owner.phone,
            totalSites: 0,
            totalShareAmount: 0,
            // ✅ RENAMED — was totalGstAmount, now explicitly
            // totalOwnerGstAmount, to sit alongside the NEW
            // totalSiteGstAmount below without any ambiguity about
            // which "GST total" each one means.
            totalOwnerGstAmount: 0,
            // ✅ ADDED — sum of each SITE's own gstAmount (the
            // property's total GST, e.g. 10800), separate from the
            // owner's personal GST above.
            totalSiteGstAmount: 0,
            totalNetPayableToOwner: 0,
            latestUpdatedAt: site.updatedAt,
            sites: [],
          });
        }

        const bucket = ownerMap.get(key);
        bucket.totalSites += 1;
        bucket.totalShareAmount += owner.shareAmount || 0;
        bucket.totalOwnerGstAmount += owner.gstAmount || 0; // ✅ RENAMED
        // ✅ ADDED — accumulate the SITE's own gstAmount (from
        // fullSiteDetail, computed with the earlier netPayable
        // fallback fix), not the owner's personal GST.
        bucket.totalSiteGstAmount += fullSiteDetail.gstAmount || 0;
        bucket.totalNetPayableToOwner += owner.netPayableToOwner || 0;
        if (new Date(site.updatedAt) > new Date(bucket.latestUpdatedAt)) {
          bucket.latestUpdatedAt = site.updatedAt;
        }

        // ✅ MERGED — full site detail (mediaType, totalSqFt, appraisal,
        // frontView, full landOwners[], history arrays, etc.) PLUS the
        // owner-specific slice (paymentCategory, shareAmount,
        // ownerGstAmount, tdsAmount, netPayableToOwner) laid on top.
        bucket.sites.push({
          ...fullSiteDetail,
          mediaId: site._id,
          paymentCategory: owner.paymentCategory,
          shareAmount: owner.shareAmount || 0,
          // ✅ RENAMED — was gstAmount (which overwrote
          // fullSiteDetail.gstAmount, the site's own GST). Now
          // ownerGstAmount, so both coexist without collision.
          ownerGstAmount: owner.gstAmount || 0,
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
  if (Number(sortOrder) === 1) {
      allOwners.sort(
        (a, b) => (a.totalNetPayableToOwner || 0) - (b.totalNetPayableToOwner || 0),
      );
    } else if (Number(sortOrder) === 2) {
      allOwners.sort(
        (a, b) => (b.totalNetPayableToOwner || 0) - (a.totalNetPayableToOwner || 0),
      );
    }
    // ✅ edit-mode stability — same principle as the site-based list:
    // when edit === 1 AND sortOrder was NOT sent, sort by
    // landOwnerMasterId (stable, never reshuffles) instead of
    // latestUpdatedAt (which jumps the moment any of the owner's
    // sites gets edited).
    else if (Number(edit) === 1) {
      allOwners.sort((a, b) =>
        String(a.landOwnerMasterId).localeCompare(String(b.landOwnerMasterId)),
      );
    } else {
      allOwners.sort((a, b) => new Date(b.latestUpdatedAt) - new Date(a.latestUpdatedAt));
    }

    allOwners = allOwners.map(({ latestUpdatedAt, ...rest }) => rest);

    const startIdx = (pageNumbers - 1) * pageSize;
    const pagedOwners = allOwners.slice(startIdx, startIdx + pageSize);

    // ═══════════════════════════════════════════════════════════
    // SECTION C — RESPONSE — `value` block UNCHANGED, `data` is the
    // landowner-grouped, paginated array with full site detail.
    // landOwnerMasterId filter (see mediaMatch above + the owner-loop
    // skip further up) still narrows `data` to one owner when sent —
    // full LandOwnerMaster profiles are NOT fetched here anymore; use
    // the separate landOwnerList API for that.
    // ═══════════════════════════════════════════════════════════
    // ✅ FIXED — was matching { status: 1 } (EVERY Active site in the
    // whole database), completely ignoring landOwnerMasterId/mediaId
    // filters. Now scoped to mediaMatch — the exact same filtered site
    // set used everywhere else in this endpoint (listMatch, sites
    // aggregation, etc.) — so these totals only reflect the sites/owner
    // actually requested, matching what the ledger List API already
    // correctly shows for the same filter.
      const outstandingScopedSites = await Media.find(mediaMatch)
      .select("mediaDetails gstApplicableFlag rentalDue landOwners ledger ledgerHistory rentalPayment pendingMonths gstBalanceHistory")
      .lean();

    const overallOutstandingTotals = outstandingScopedSites.reduce(
      (acc, site) => {
        const s = computeOutstandingSummary(site, null);
        acc.overallCurrentBaseRentDue += s.currentBaseRent;
        acc.overallCurrentGSTDue += s.currentGSTDue;
        acc.overallPreviousBaseRentDue += s.previousBaseRentDue;
        acc.overallPreviousGSTDue += s.previousGSTDue;
        acc.overallTotalOutstandingAmount += s.totalOutstandingAmount;
        return acc;
      },
      {
        overallCurrentBaseRentDue: 0,
        overallCurrentGSTDue: 0,
        overallPreviousBaseRentDue: 0,
        overallPreviousGSTDue: 0,
        overallTotalOutstandingAmount: 0,
      },
    );

    const {
      overallCurrentBaseRentDue,
      overallCurrentGSTDue,
      overallPreviousBaseRentDue,
      overallPreviousGSTDue,
      overallTotalOutstandingAmount,
    } = overallOutstandingTotals;

    // ✅ NEW — linkedSites[] bank details (response only, current page only)
    await addBankDetailsToLinkedSites(pagedOwners);

    return res.status(200).json({
      success: true,
      // sweepDebugLog,
      value: {
        totalSites,
        siteCount,
        activeCount,
        previousBillGenerateDate: formatDate(addMonthsUTC(monthStart, -1)),
        currentBillDate: (() => {
          // If the requested month has no DUE entries and nextBillingDate has already moved past it,
          // then currentBillDate for this month view should be empty.
          const anyDueThisMonth = summaryStatsAgg[0]?.dueThisMonthCount > 0;
          if (anyDueThisMonth) return formatDate(monthStart);

          const now = nowIST();
          if (
            now.getUTCMonth() === monthStart.getUTCMonth() &&
            now.getUTCFullYear() === monthStart.getUTCFullYear()
          ) {
            // Even if no due entries, if we are IN the month, we might show the month start as the anchor
            // but the user wants it EMPTY if the bill is already generated/paid and moved to next month.
            return "";
          }

          return "";
        })(),
        dueThisMonth,
        dueAmountOpen,
        overDue: { siteCount: Math.floor(overDueSiteCount), amount: Math.floor(overDueAmountTotal) },
        approvedCount: Math.floor(approvedCount),
        approvedAmountTotal: Math.floor(approvedAmountTotal),
        pendingCount: Math.floor(pendingCount),
        pendingAmountTotal: Math.floor(pendingAmountTotal),
        // pastPendingApproval removed per user request (merged into overDue)
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
        // ══ NEW ══
        overallCurrentBaseRentDue,
        overallCurrentGSTDue,
        overallPreviousBaseRentDue,
        overallPreviousGSTDue,
        overallTotalOutstandingAmount,
        pagination: {
          count: pageSize,
          pageNumber: pageNumbers,
          totalCount: allOwners.length,
          totalPages: Math.ceil(allOwners.length / pageSize),
        },
      },
      data: pagedOwners,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

