
const mongoose = require("mongoose");
const { successResponse, errorResponse } = require("../../../utils/response");
const axios = require("axios");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const path = require("path");
const OverDueHistory = require("../../../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { computeOutstandingSummary } = require("../../../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");

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

// ═════════════════════════════════════════════════════════════
// ✅ AUTO-GENERATE MISSED RENTAL DUE ENTRIES (shared helper, NO
// standalone endpoint — called from inside saveRentalDue and
// getRentalDueListWithStats below).
//
// ✅ UPDATED — "Rule 1" (dates only change on Owner approval) has
// been SCRAPPED per explicit instruction. This function now
// auto-advances rentalPayment.lastBillPaidDate and
// rentalPayment.nextBillingDate on schedule, based on
// paymentFrequency, REGARDLESS of whether any bill was approved.
// advanceRentalPaymentOnOwnerApproval (further below) is no longer
// called anywhere — kept in the file but dead code, since dates now
// move here instead.
//
// Still true: walks forward from the CURRENT nextBillingDate one
// cycle at a time (cycle length = paymentFrequency), and for every
// past cycle date that doesn't already have a rentalDue[] entry,
// creates a new independent PENDING entry — never overwrites an
// existing one (this part is unchanged).
//
// Idempotent — safe to call on every saveRentalDue/list request; it
// skips any cycle date that already has an entry.
// ═════════════════════════════════════════════════════════════
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

// async function generateMissedEntriesForMedia(media, userName) {
//   // ✅ ADDED — only Active (status: 1) sites auto-generate missed
//   // bills. Inactive (status: 2) sites are skipped entirely — no new
//   // pending months get created for them, regardless of how many
//   // cycles have passed.
//   if (Number(media.status) !== 1) {
//     return { generatedEntries: [] };
//   }

//   const today = new Date();

//   // ✅ FIXED — operate DIRECTLY on media.rentalDue, the REAL schema
//   // field on MediaSchema. "rentalDueEntries" is NOT an actual schema
//   // path — it was only ever a plain in-memory alias
//   // (media.rentalDueEntries = media.rentalDue), and this function was
//   // calling media.markModified("rentalDueEntries") afterward, which
//   // targets a path that doesn't exist in the schema at all. Combined
//   // with the alias indirection, this made persistence unreliable —
//   // entries could appear generated in-memory/in the response but
//   // never actually get saved to the DB, so August looked like it
//   // "couldn't generate" (it kept vanishing on the next fetch).
//   if (!Array.isArray(media.rentalDue)) {
//     media.rentalDue = [];
//   }
//   if (!Array.isArray(media.rentalDueHistory)) {
//     media.rentalDueHistory = [];
//   }

//   const cycleMonths = getCycleMonthsForFrequency(media);
//   if (!cycleMonths || cycleMonths <= 0) return { generatedEntries: [] };

//   const existingDueDateKeys = new Set(
//     media.rentalDue
//       .filter((e) => e.dueDate)
//       .map((e) => new Date(e.dueDate).getTime()),
//   );

//   // ✅ FIXED (previous pass) — the walk's starting point comes from
//   // the LATEST EXISTING rentalDue entry (ground truth), NOT from
//   // rentalPayment.nextBillingDate, which can drift ahead and
//   // permanently hide gaps.
//   const sortedExistingEntries = [...media.rentalDue]
//     .filter((e) => e.dueDate)
//     .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

//   let candidateDate;
//   if (sortedExistingEntries.length > 0) {
//     const latestExisting = sortedExistingEntries[sortedExistingEntries.length - 1];
//     candidateDate = addMonthsLocal(new Date(latestExisting.dueDate), cycleMonths);
//   } else {
//     // no entries exist at all yet — fall back to nextBillingDate as
//     // the seed for the very FIRST entry ever generated on this site.
//     const anchorDate = media.rentalPayment?.nextBillingDate;
//     if (!anchorDate) return { generatedEntries: [] };
//     candidateDate = new Date(anchorDate);
//   }
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

// async function generateMissedEntriesForMedia(media, userName) {
//   if (Number(media.status) !== 1) {
//     return { generatedEntries: [] };
//   }

//   const today = new Date();

//   if (!Array.isArray(media.rentalDue)) {
//     media.rentalDue = [];
//   }
//   if (!Array.isArray(media.rentalDueHistory)) {
//     media.rentalDueHistory = [];
//   }

//   const cycleMonths = getCycleMonthsForFrequency(media);
//   if (!cycleMonths || cycleMonths <= 0) return { generatedEntries: [] };

//   const existingDueDateKeys = new Set(
//     media.rentalDue
//       .filter((e) => e.dueDate)
//       .map((e) => new Date(e.dueDate).getTime()),
//   );

//   const sortedExistingEntries = [...media.rentalDue]
//   .filter((e) => e.dueDate)
//   .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

// // ✅ ADDED — figure out the TRUE genesis cycle independent of
// // whatever's already in rentalDue[], so we can detect (and backfill)
// // a gap sitting BEFORE the earliest existing entry. This is what
// // self-heals a site that was corrupted by an earlier buggy run
// // (e.g. an "August-only" entry created while July was skipped).
// const nextBillingDate = media.rentalPayment?.nextBillingDate;
// const lastBillPaidDate = media.rentalPayment?.lastBillPaidDate;

// let genesisCandidate = null;
// if (
//   lastBillPaidDate &&
//   (!nextBillingDate || new Date(lastBillPaidDate) < new Date(nextBillingDate))
// ) {
//   genesisCandidate = addMonthsLocal(new Date(lastBillPaidDate), cycleMonths);
// } else if (nextBillingDate) {
//   genesisCandidate = new Date(nextBillingDate);
// }

// let candidateDate;
// if (sortedExistingEntries.length > 0) {
//   const earliestExisting = sortedExistingEntries[0];
//   const latestExisting = sortedExistingEntries[sortedExistingEntries.length - 1];

//   // ✅ ADDED — if the true genesis cycle is EARLIER than the
//   // earliest entry we already have, start there instead — this
//   // backfills the gap (e.g. July) instead of only ever walking
//   // forward from whatever entry happens to exist already.
//   if (genesisCandidate && genesisCandidate < new Date(earliestExisting.dueDate)) {
//     candidateDate = genesisCandidate;
//   } else {
//     candidateDate = addMonthsLocal(new Date(latestExisting.dueDate), cycleMonths);
//   }
// } else {
//   if (!genesisCandidate) return { generatedEntries: [] };
//   candidateDate = genesisCandidate;
// }
//   const generatedEntries = [];
//   let safety = 0;

//   // previousCycleDate tracks the cycle just before candidateDate, so
//   // lastBillPaidDate/nextBillingDate get updated to match wherever
//   // the walk actually lands — self-correcting any prior drift.
//   let previousCycleDate = new Date(candidateDate);

//   // ✅ compare against the END of the CURRENT CALENDAR MONTH — any
//   // cycle date within or before the current month generates
//   // immediately, matching "monthly" auto-generation rather than
//   // waiting for the exact billing day to pass.
//   const currentMonthEnd = new Date(
//     today.getFullYear(),
//     today.getMonth() + 1,
//     0,
//     23,
//     59,
//     59,
//   );

//   while (candidateDate <= currentMonthEnd && safety < 60) {
//     safety++;
//     const candidateKey = candidateDate.getTime();

//     if (!existingDueDateKeys.has(candidateKey)) {
//       const chainSteps = buildApprovalSteps(2);
//       const steps = [
//         {
//           role: ROLE.STAFF,
//           userId: null,
//           userName: "",
//           approvedAt: null,
//           status: 1,
//           docVerified: false,
//           remarks: "Auto-generated for missed cycle",
//         },
//         ...chainSteps,
//       ];

//       const gstSplit = computeGstSplit(media, 0);

//       const newEntry = {
//         dueMonth: getDueMonthLabel(candidateDate),
//         dueDate: new Date(candidateDate),
//         netPayable: Number(gstSplit.netPayable) || 0,
//         paymentFrequency: media.rentalPayment?.paymentFrequency || 1,
//         customPaymentFrequency:
//           media.rentalPayment?.paymentFrequency === 6
//             ? media.rentalPayment?.customPaymentFrequency || 1
//             : undefined,
//         ownerApprovalDate: null,
//         mailSent: false,
//         gstAddedToBalance: false,
//         campaignName: "",
//         proofOfCampaign: null,
//         savedBy: {
//           userId: null,
//           userName: "System (auto-generated)",
//           role: null,
//           savedAt: nowIST(),
//         },
//         approvalFlow: 2,
//         approvalSteps: steps,
//         approvalStatus: 1,
//         currentPendingRole: ROLE.STAFF,
//         agreementDocVerified: false,
//         status: 1,
//         withGst: 0,
//         gstAmount: Number(gstSplit.gstAmount) || 0,
//         baseAmount: Number(gstSplit.baseAmount) || 0,
//         updatedBy: userName || "",
//         updatedAt: nowIST(),
//       };

//       // ✅ FIXED — push directly onto the real schema field.
//       media.rentalDue.push(newEntry);
//       const savedEntry = media.rentalDue[media.rentalDue.length - 1];

//       const yearLabel = getYearLabel(candidateDate);
//       const monthLabel = getMonthLabel(candidateDate);

//       let yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
//       if (!yearBucket) {
//         media.rentalDueHistory.push({ year: yearLabel, months: [] });
//         yearBucket = media.rentalDueHistory[media.rentalDueHistory.length - 1];
//       }
//       let monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
//       if (!monthBucket) {
//         yearBucket.months.push({ month: monthLabel, entries: [] });
//         monthBucket = yearBucket.months[yearBucket.months.length - 1];
//       }
//       monthBucket.entries.push({
//         rentalDueId: savedEntry._id,
//         siteName: media.mediaName,
//         campaignName: "",
//         dueDate: new Date(candidateDate),
//         netPayable: Number(newEntry.netPayable) || 0,
//         approvalStatus: newEntry.approvalStatus,
//         savedBy: "System (auto-generated)",
//         savedByRole: null,
//         updatedAt: nowIST(),
//         updatedBy: userName || "",
//       });

//       generatedEntries.push({
//         rentalDueId: savedEntry._id,
//         dueMonth: newEntry.dueMonth,
//         dueDate: newEntry.dueDate,
//         netPayable: newEntry.netPayable,
//         approvalStatus: newEntry.approvalStatus,
//         currentPendingRole: newEntry.currentPendingRole,
//       });

//       existingDueDateKeys.add(candidateKey);
//     }

//     previousCycleDate = candidateDate;
//     candidateDate = addMonthsLocal(candidateDate, cycleMonths);
//   }

//   // ✅ ADDED — auto-advance the real billing dates on the document,
//   // to match wherever the schedule walk landed. This is the scrapped-
//   // Rule-1 behavior: lastBillPaidDate/nextBillingDate move forward on
//   // schedule regardless of whether any bill was ever approved.
//   if (generatedEntries.length > 0) {
//     media.rentalPayment.lastBillPaidDate = previousCycleDate;
//     media.rentalPayment.nextBillingDate = candidateDate;
//     media.markModified("rentalPayment");
//   }

//   if (generatedEntries.length > 0) {
//     // ✅ FIXED — markModified the REAL schema path ("rentalDue"), not
//     // the fake "rentalDueEntries" path that doesn't exist in the
//     // schema and was never actually doing anything.
//     media.markModified("rentalDue");
//     media.markModified("rentalDueHistory");
//     media.updatedBy = userName || "";
//     media.updatedAt = nowIST();
//     await media.save({ timestamps: false });
//   }

//   return { generatedEntries };
// }
// ✅ REPLACED — generateMissedEntriesForMedia now uses the SAME
// cycle-walking algorithm as LedgerNew2Controller.getAllDueCycles,
// instead of a different "extend from last saved entry" approach.
// That mismatch was the actual root cause: ledger-list computes its
// due cycles fresh from the anchor date every single call (stateless
// full walk), while this function only ever advanced forward from
// whatever was already saved — so a site with no rentalDue[] entries
// yet showed nothing here until ledger-list's own walk ran once and
// persisted entries via ensureRentalDueForCycles. Now both
// controllers derive the identical cycle list from the identical
// anchor, so rental-list is self-sufficient on the very first call.
async function generateMissedEntriesForMedia(media, userName) {
  if (!media.mediaDetails?.some(d => d.status === 1)) {
    return { generatedEntries: [] };
  }

  if (!Array.isArray(media.rentalDue)) media.rentalDue = [];
  if (!Array.isArray(media.rentalDueHistory)) media.rentalDueHistory = [];

  const siteBillMode = media.siteBillMode || media.mediaDetails?.[0]?.siteBillMode || 1;

  if (media.rentalPayment?.lastBillPaidDate) {
    const lbpDate = new Date(media.rentalPayment.lastBillPaidDate);
    if (!Number.isNaN(lbpDate.getTime())) {
      const lbpMonthLabel = getDueMonthLabel(lbpDate);

      const facesToSync = siteBillMode === 2 ? media.mediaDetails : [null];
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

    const facesToGenerate = siteBillMode === 2 ? media.mediaDetails : [null];

    for (const face of facesToGenerate) {
      const faceId = face ? face._id : null;

      const existingEntryForMonth = media.rentalDue.find(
        (e) => e.dueMonth === candidateMonthLabel && String(e.mediaDetailId || "") === String(faceId || ""),
      );
      if (
        existingEntryForMonth &&
        new Date(existingEntryForMonth.dueDate).getTime() === candidateDate.getTime()
      ) {
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
      const gstSplit = computeGstSplit(media, inferredWithGst);

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

  if (generatedEntries.length > 0) {
    media.markModified("rentalDueHistory");
    await media.save({ timestamps: false });
  } else if (latestCycleDate) {
    await media.save({ timestamps: false });
  }

  return { generatedEntries };
}
exports.generateMissedEntriesForMedia = generateMissedEntriesForMedia;

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
async function saveOverDueHistoryIfApplicable(media, entry, userName) {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const isOverdue =
      Number(media.rentalPayment?.status) === 3 ||
      (entry.dueDate && new Date(entry.dueDate) < today);

    if (!isOverdue) return;

    // Check for duplicate for this specific cycle/media to avoid double logging
    const existing = await OverDueHistory.findOne({
      mediaId: media._id,
      rentalDueId: entry._id,
    });
    if (existing) return;

    const entryGst = Number(entry.gstAmount || 0);
    const siteGst = Number(media.rentalPayment?.gstAmount || 0);
    const ownerGst = (media.landOwners || []).filter(o => Number(o.gstApplicable) === 1).reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
    const resolvedGst = entryGst > 0 ? entryGst : (siteGst > 0 ? siteGst : ownerGst);

    const baseAmount = Number(entry.netPayable || 0);
    const isGstApplicable = resolvedGst > 0;

    await OverDueHistory.create({
      mediaId: media._id,
      mediaName: media.mediaName,
      mediaCode: media.mediaCode,
      previousBillDate: media.rentalPayment?.previousBillGenerateDate,
      currentBillDate: entry.dueDate,
      nextBillDate: media.rentalPayment?.nextBillingDate,
      overDueAmount: baseAmount,
      gstAmount: resolvedGst,
      isGstApplicable,
      approvedDate: nowIST(),
      removedDate: nowIST(),
      dueMonth: entry.dueMonth,
      dueDate: entry.dueDate,
      rentalDueId: entry._id,
      withGst: Number(entry.withGst || 0),
      status: 2, // 2: Pending Entry
      updatedBy: userName,
      createdAt: nowIST(),
      updatedAt: nowIST(),
    });
  } catch (err) {
    console.error("❌ Error saving OverDue History:", err.message);
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
  const baseRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const gstAmountFull = Number(media.rentalPayment?.gstAmount || 0);
  const totalWithGst =
    media.rentalPayment?.totalRentalAmountWithGst ||
    baseRent + gstAmountFull;

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

async function sendRentalDueApprovalMail(media, entry, batchSites = null) {
  try {
    const toMail = process.env.T0_EMail;
    const ccMail = process.env.CC_EMail;
    const mailMode = process.env.MAIL_MODE || "development";

    const formatYMD = (date) =>
      date ? new Date(date).toISOString().split("T")[0] : null;

    const targetDueMonth = entry.dueMonth;

    // ── GROUPING LOGIC ──
    // ✅ FIXED — Removed automatic DB lookup for other sites.
    // If batchSites is provided (from batch approval), use them.
    // Otherwise, it's a single site mail as requested.
    let sitesInGroupData = [];
    if (Array.isArray(batchSites) && batchSites.length > 0) {
      sitesInGroupData = batchSites;
    } else {
      sitesInGroupData = [{ media, entry }];
    }

    // Identify unique landowners across the provided sites
    const uniqueOwnersMap = new Map();
    sitesInGroupData.forEach(({ media: siteMedia }) => {
      (siteMedia.landOwners || []).forEach((owner) => {
        if (owner.landOwnerMasterId) {
          const key = String(owner.landOwnerMasterId);
          if (!uniqueOwnersMap.has(key)) {
            uniqueOwnersMap.set(key, owner.toObject ? owner.toObject() : owner);
          }
        }
      });
    });

    const uniqueOwners = Array.from(uniqueOwnersMap.values());
    const ownerRefs = {};
    uniqueOwners.forEach((owner, idx) => {
      const ref = `LO-${String(idx + 1).padStart(2, "0")}`;
      ownerRefs[String(owner.landOwnerMasterId)] = ref;
      owner.ownerRef = ref;
    });

    // ── BUILD SITES PAYLOAD ──
    const allProofs = [];
    const allInvoices = [];
    const sitesPayload = sitesInGroupData.map(({ media: site, entry: siteInputEntry }) => {
      const siteEntry = (site.rentalDue || []).find((e) => e.dueMonth === targetDueMonth) || siteInputEntry;
      const rp = site.rentalPayment || {};
      const agreement = site.agreement || {};
      const appraisal = site.appraisal || {};

      const proof = siteEntry?.proofOfCampaign?.filePath;
      if (proof) allProofs.push(proof);

      const inv = siteEntry?.invoice?.filePath;
      if (inv) allInvoices.push(inv);

      const siteGstAmount = Number(siteEntry?.gstAmount || 0);
      const siteGstApplicable = Number(rp.gstApplicable) === 1 ? 1 : 0;
      const siteBaseRent = Number(rp.totalRentalAmount || 0);

      // ✅ Site specific appraisal logic
      let siteAppraisalPayload = {};
      // ... (rest of siteAppraisalPayload logic same as before)
      if (appraisal.lastAppraisalDate) {
        const lastAppDate = new Date(appraisal.lastAppraisalDate);
        const today = new Date();
        if (
          lastAppDate.getUTCFullYear() === today.getUTCFullYear() &&
          lastAppDate.getUTCMonth() === today.getUTCMonth()
        ) {
          let prevRentValue = 0;
          if (Array.isArray(appraisal.history)) {
            const lastKey = lastAppDate.getTime();
            const matchH = appraisal.history.find(
              (h) => h.appraisalDate && new Date(h.appraisalDate).getTime() === lastKey
            );
            prevRentValue = Number(matchH?.previousRent || 0);
          }
          siteAppraisalPayload = {
            applicable: appraisal.applicable || 0,
            type: appraisal.type || 0,
            percentage: appraisal.percentage || 0,
            fixedAmount: appraisal.fixedAmount || 0,
            frequency: appraisal.frequency || 0,
            currentRent: prevRentValue,
            appraisalAmount: appraisal.appraisalAmount || 0,
            totalAppraisalAmount: appraisal.totalAppraisalAmount || 0,
            lastAppraisalDate: formatYMD(appraisal.lastAppraisalDate),
            nextAppraisalDate: formatYMD(appraisal.nextAppraisalDate),
          };
        }
      }

      const siteOwnerGst = (site.landOwners || []).reduce((sum, o) => sum + Number(o.gstAmount || 0), 0);
      const siteLandOwners = (site.landOwners || []).map((o) => {
        return {
          ownerRef: ownerRefs[String(o.landOwnerMasterId)],
          name: o.name || "",
          phone: o.phone || "",
          bankName: o.bankName || "",
          ifsc: o.ifsc || "",
          accountNumber: o.accountNumber || "",
          panNumber: o.panNumber || "",
          paymentCategory: o.paymentCategory || 0,
          onlineMode: o.onlineMode || 0,
          shareAmount: o.shareAmount || 0,
          onlineAmount: o.onlineAmount || 0,
          cashAmount: o.cashAmount || 0,
          tdsApplicable: o.tdsApplicable || 0,
          tdsPercentage: o.tdsPercentage || 0,
          tdsAmount: o.tdsAmount || 0,
          tdsHold: 0,
          gstHold: Number(siteEntry?.withGst) === 1 ? 1 : 0,
          gstApplicable: o.gstApplicable || 0,
          gstNumber: o.gstNumber || "",
          gstPercentage: o.gstPercentage || 0,
          gstAmount: o.gstAmount || 0,
          totalAmountWithGst: Number(o.totalAmountWithGst || (Number(o.shareAmount || 0) + Number(o.gstAmount || 0))),
        };
      });

      const siteNetPayable = siteBaseRent + siteGstAmount + siteOwnerGst;
      const siteLandOwnerRefs = (site.landOwners || [])
        .map((o) => ownerRefs[String(o.landOwnerMasterId)])
        .filter(Boolean);

      return {
        mediaCode: site.mediaCode || "",
        mediaName: site.mediaName || "",
        mediaType: site.mediaType || "",
        state: site.state || "",
        city: site.city || "",
        location: site.location || "",
        width: site.width || 0,
        height: site.height || 0,
        totalSqFt: site.totalSqFt || 0,
        status: site.status || 0, // ✅ MOVED — now inside site object
        rentalPayment: {
          totalRentalAmount: siteBaseRent,
          gstApplicable: siteGstApplicable,
          gstNumber: rp.gstNumber || "",
          gstPercentage: rp.gstPercentage || 0,
          gstAmount: siteGstAmount,
          netPayable: siteNetPayable,
          paymentFrequency: siteEntry?.paymentFrequency || rp.paymentFrequency || 0,
          lastBillPaidDate: formatYMD(rp.lastBillPaidDate),
          nextBillingDate: formatYMD(rp.nextBillingDate),
        },
        agreement: {
          startDate: formatYMD(agreement.startDate),
          endDate: formatYMD(agreement.endDate),
          reminderBeforeExpiry: agreement.reminderBeforeExpiry || 0,
          advanceRent: agreement.advanceRent || 0,
          status: agreement.status || 0,
        },
        appraisal: siteAppraisalPayload,
        landOwners: siteLandOwners,
        proof_of_campaign: proof ? [proof] : [],
        invoice: inv ? [inv] : [],
        landOwnerRefs: uniqueOwners.length > 1 ? siteLandOwnerRefs : undefined,
      };
    });

    // ── BUILD LANDOWNERS PAYLOAD ──
    // const landOwnersPayload = uniqueOwners.map((owner) => {
    //   let totalShareAmount = 0;
    //   let totalOnlineAmount = 0;
    //   let totalCashAmount = 0;
    //   let totalGstAmount = 0;
    //   let totalTdsAmount = 0;
    //   let totalAmountWithGst = 0;

    //   // ✅ ADDED — capture GST specific details for the owner
    //   let ownerGstApplicable = 0;
    //   let ownerGstNumber = "";
    //   let ownerGstPercentage = 0;

    //   const siteRentBreakdown = [];

    //   sitesInGroupData.forEach(({ media: site }) => {
    //     const matchedOwner = (site.landOwners || []).find(
    //       (o) =>
    //         o.landOwnerMasterId &&
    //         String(o.landOwnerMasterId) === String(owner.landOwnerMasterId)
    //     );
    //     if (matchedOwner) {
    //       const share = Number(matchedOwner.shareAmount || 0);
    //       totalShareAmount += share;
    //       totalOnlineAmount += Number(matchedOwner.onlineAmount || 0);
    //       totalCashAmount += Number(matchedOwner.cashAmount || 0);

    //       const ownerGst = Number(matchedOwner.gstAmount || 0);
    //       totalGstAmount += ownerGst;

    //       totalTdsAmount += Number(matchedOwner.tdsAmount || 0);

    //       totalAmountWithGst += Number(matchedOwner.totalAmountWithGst || (share + ownerGst));

    //       // ✅ Capture details from the owner record
    //       if (!ownerGstNumber) ownerGstNumber = matchedOwner.gstNumber || "";
    //       if (!ownerGstPercentage) ownerGstPercentage = Number(matchedOwner.gstPercentage || 0);
    //       if (Number(matchedOwner.gstApplicable) === 1) ownerGstApplicable = 1;

    //       siteRentBreakdown.push({
    //         mediaCode: site.mediaCode,
    //         shareAmount: share,
    //       });
    //     }
    //   });

    //   const ownerObj = {
    //     ownerRef: owner.ownerRef,
    //     name: owner.name || "",
    //     phone: owner.phone || "",
    //     bankName: owner.bankName || "",
    //     ifsc: owner.ifsc || "",
    //     accountNumber: owner.accountNumber || "",
    //     panNumber: owner.panNumber || "",
    //     paymentCategory: owner.paymentCategory || 0,
    //     onlineMode: owner.onlineMode || 0,
    //     shareAmount: totalShareAmount,
    //     onlineAmount: totalOnlineAmount,
    //     cashAmount: totalCashAmount,
    //     tdsApplicable: owner.tdsApplicable || 0,
    //     tdsPercentage: owner.tdsPercentage || 0,
    //     tdsAmount: totalTdsAmount,
    //     tdsHold: 0,
    //     gstHold: Number(entry?.withGst) === 1 ? 1 : 0,
    //     // ✅ NEW — explicitly include GST fields as requested
    //     gstApplicable: ownerGstApplicable,
    //     gstNumber: ownerGstNumber,
    //     gstPercentage: ownerGstPercentage,
    //     gstAmount: totalGstAmount,
    //     totalAmountWithGst: totalAmountWithGst,
    //   };

    //   if (sitesInGroupData.length > 1) {
    //     ownerObj.siteRentBreakdown = siteRentBreakdown;
    //   }
    //   return ownerObj;
    // });

    const isSingleBill = (media.mediaDetails?.some(d => d.siteBillMode === 1) || media.siteBillMode === 1);
    const data = {
      billingType: isSingleBill ? "single_bill" : "separate_bill",
    };

    if (isSingleBill) {
      data.numberOfSites = sitesPayload.length;
    }

    data.numberOfLandOwners = uniqueOwners.length;
    // status removed from here

    if (isSingleBill) {
      data.sites = sitesPayload;
    } else {
      const s = sitesPayload[0];
      Object.assign(data, s);
    }


    const mailPayload = {
      mailtype: "cmdapproval",
      to: [toMail],
       cc: [ccMail],
      data: data,
    };

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
      mailErr?.message || mailErr
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

  // ✅ NEW GUARD — if per-owner GST rows already exist for this
  // rentalDueId, the owner-level breakdown already covers it. Do NOT
  // also create the generic ownerId:null placeholder row — that's what
  // was causing the duplicate (gstAmount:0 + gstAmount:9000 for the
  // same rentalDueId/dueMonth).
  const ownerRowsExist = (media.gstBalanceHistory || []).some(
    (g) => String(g.rentalDueId) === String(entry._id) && g.source === "owner",
  );
  if (ownerRowsExist) {
    entry.gstAddedToBalance = true;
    return;
  }

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

  // ✅ FIXED — build the owner-level rows FIRST, and only remove the
  // site-level placeholder (and mark it as replaced) if at least one
  // owner-level row was actually added. Previously the placeholder was
  // deleted UNCONDITIONALLY before checking whether any owner
  // qualified — so if the site-level GST was genuinely held
  // (addGstToBalanceIfApplicable had already pushed it) but no
  // individual owner had BOTH gstApplicable===1 AND gstAmount>0, the
  // valid placeholder got deleted here and nothing replaced it,
  // leaving gstBalanceHistory empty despite a real GST hold existing.
  const ownerRowsToAdd = [];

  media.landOwners.forEach((owner) => {
    const ownerGstApplicable = Number(owner.gstApplicable || 0);
    const ownerGstAmount = Number(owner.gstAmount || 0);

    if (ownerGstApplicable === 1 && ownerGstAmount > 0) {
      ownerRowsToAdd.push({
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
    }
  });

  if (ownerRowsToAdd.length > 0) {
    // ✅ only remove the placeholder NOW, since we know it's genuinely
    // being replaced by real owner-level rows.
    const placeholderExists = media.gstBalanceHistory.some(
      (g) => String(g.rentalDueId) === String(entry._id) && g.source === "rental" && !g.ownerId,
    );
    if (placeholderExists) {
      media.gstBalanceHistory = media.gstBalanceHistory.filter(
        (g) => !(String(g.rentalDueId) === String(entry._id) && g.source === "rental" && !g.ownerId),
      );
    }

    media.gstBalanceHistory.push(...ownerRowsToAdd);
    media.markModified("gstBalanceHistory");
    entry.ownerGstAddedToBalance = true;
    entry.gstAddedToBalance = true;
    recomputeBalanceGstAmount(media);
  }
  // ✅ if ownerRowsToAdd is empty, we do NOTHING — the site-level
  // placeholder (if it exists) is left completely intact, so
  // gstBalanceHistory still correctly reflects the site-level GST hold.
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
  let flag = entryGstFlag !== undefined ? Number(entryGstFlag) : (Number(item.gstApplicableFlag) || 0);
  const pastgstApplicableFlag = entryPastFlag !== undefined ? Number(entryPastFlag) : (Number(item.pastgstApplicableFlag) || 0);

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
}) {
  const mediaId = media._id;

  const pendingEntry = (media.rentalDue || []).find(
    (d) => String(d._id) === String(rentalDueId),
  );

  if (!pendingEntry) {
    return { success: false, mediaId, message: "Rental due entry not found" };
  }

  const entry = pendingEntry;
  const chain = FLOW_CHAIN[entry.approvalFlow] || FLOW_CHAIN[1];
  const isOwnerOverride =
    userType === ROLE.OWNER && entry.currentPendingRole !== ROLE.OWNER;
  const isStaffOrTeamLead = userType === ROLE.STAFF || userType === ROLE.TEAM_LEAD;

  if (!isOwnerOverride && !isStaffOrTeamLead && userType !== entry.currentPendingRole) {
    return {
      success: false,
      mediaId,
      message: `It's not your turn to approve. Waiting on ${ROLE_LABEL[entry.currentPendingRole] || "N/A"}`,
    };
  }

  if (campaignName) entry.campaignName = campaignName;
  if (reason) entry.reason = reason;
  if (proofOfCampaign) entry.proofOfCampaign = proofOfCampaign;
  if (invoice) entry.invoice = invoice;

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

  if ([1, 2].includes(Number(withGst))) {
    const newWithGst = Number(withGst);
    if (entry.withGst !== newWithGst) {
      entry.withGst = newWithGst;
      entry.gstApplicableFlag = newWithGst;
      const recomputedSplit = computeGstSplit(media, newWithGst);
      entry.gstAmount = Number(recomputedSplit.gstAmount) || 0;
      entry.baseAmount = Number(recomputedSplit.baseAmount) || 0;
      entry.netPayable = Number(recomputedSplit.netPayable) || 0;
    }
  }

  if (isOwnerOverride || userType === entry.currentPendingRole) {
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
      }
    }

    if (entry.approvalStatus === 3) {
      await saveOverDueHistoryIfApplicable(media, entry, userName);
      applyGstApplicableFlagIfOwner(media, userType, gstApplicableFlag, requestedPastFlag);
      addGstToBalanceIfApplicable(media, entry, userName);
      addOwnerGstToBalanceIfApplicable(media, entry, userName);
      resetLiveAgreementFlags(media);
      if (Array.isArray(media.ledger)) media.ledger = [];
      media.agreementDocVerified = { staff: false, teamLead: false, owner: false };
    }
  }

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
  }

  return {
    success: true,
    mediaId,
    mediaName: media.mediaName,
    rentalDueId: entry._id,
    approvalStatus: entry.approvalStatus,
    entryDoc: entry,
  };
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
    });

    if (result.success) {
      await media.save({ timestamps: false });
      if (!skipMail && userType === ROLE.OWNER && result.approvalStatus === 3) {
        const mailRes = await sendRentalDueApprovalMail(media, result.entryDoc);
        result.entryDoc.mailSent = !!mailRes.sent;
        await media.save({ timestamps: false });
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
  const gstSplit = computeGstSplit(media, resolvedWithGst);

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

  const { result: atomicResult } = await atomicallyEnsureOrUpdateRentalDueEntry(media._id, newEntry);
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

    const yearLabel = getYearLabel(dueDateObj);
    const monthLabel = getMonthLabel(dueDateObj);
    let yearBucket = media.rentalDueHistory.find((y) => y.year === yearLabel);
    if (!yearBucket) { media.rentalDueHistory.push({ year: yearLabel, months: [] }); yearBucket = media.rentalDueHistory[media.rentalDueHistory.length - 1]; }
    let monthBucket = yearBucket.months.find((m) => m.month === monthLabel);
    if (!monthBucket) { yearBucket.months.push({ month: monthLabel, entries: [] }); monthBucket = yearBucket.months[yearBucket.months.length - 1]; }
    monthBucket.entries.push({ rentalDueId: savedEntry._id, siteName: media.mediaName, campaignName, reason, dueDate: dueDateObj, netPayable: Number(newEntry.netPayable) || 0, approvalStatus: newEntry.approvalStatus, savedBy: userName, savedByRole: userType, updatedAt: nowIST(), updatedBy: userName });

    await media.save({ timestamps: false });

    if (!skipMail && isOwnerOverride && savedEntry.approvalStatus === 3) {
      const mailResult = await sendRentalDueApprovalMail(media, savedEntry);
      savedEntry.mailSent = !!mailResult.sent;
      await media.save({ timestamps: false });
    }

    const resGst = resolveGstApplicable(media, savedEntry.gstApplicableFlag, savedEntry.pastgstApplicableFlag);
    return { success: true, mediaId: media._id, mediaName: media.mediaName, rentalDueId: savedEntry._id, approvalStatus: savedEntry.approvalStatus, entryDoc: savedEntry, gstApplicableFlag: resGst.gstApplicableFlag, gstApplicableDisplay: resGst };
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
          });

          results.push({ ...processResult, originalIndex: index });
          if (processResult.success && processResult.approvalStatus === 3) {
            batchApprovedSites.push({ media, entry: processResult.entryDoc });
          }
        }

        // Save the document ONCE after all updates for its faces/cycles are done
        await media.save({ timestamps: false });
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
    rentalDueId: targetEntry ? targetEntry._id : null, // ✅ CHANGED — links to the specific month, when targeted
    agreementPDF: media.agreement?.agreementPDF || {},
    cycle: currentCycle,
    cycleStartDate: targetEntry ? targetEntry.dueDate : media.rentalPayment?.nextBillingDate, // ✅ CHANGED
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
      $set: { updatedBy: userName },
    },
    { new: true,timestamps: false },
  );

  if (!updatedMedia) {
    const latestMedia = await Media.findById(mediaId);
    const latestVerifications = (latestMedia?.agreementDocVerification || []).filter(
      (h) => h.isVerified && isSameCycle(h.cycle, currentCycle),
    );
    const selfAlreadyVerified = latestVerifications.some((h) => h.verifiedByRole === userType);
    const blocker = latestVerifications.find((h) => ROLE_RANK[h.verifiedByRole] > userRank);

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
exports.getOverDueHistoryList = async (req, res) => {
  try {
    const { pageNumber = 1, count = 10, search, dueMonth, dueYear, status } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;
    const skip = (pageNumbers - 1) * pageSize;

    const filter = {};

    if (search) {
      filter.$or = [
        { mediaName: { $regex: search, $options: "i" } },
        { mediaCode: { $regex: search, $options: "i" } },
      ];
    }

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    if (dueMonth && dueMonth.match(/^\d{2}-\d{4}$/)) {
        const [mo, yr] = dueMonth.split("-").map(Number);
        const monthName = monthNames[mo - 1]; // Reverted to standard 1-based mapping (08 = August)
        if (monthName) {
            filter.dueMonth = `${monthName} ${yr}`;
        }
    } else if (dueMonth || dueYear) {
        // Support separate dueMonth and dueYear
        const mo = parseInt(dueMonth);
        const yr = parseInt(dueYear);

        let monthName = null;
        if (!isNaN(mo) && mo >= 1 && mo <= 12) {
            monthName = monthNames[mo - 1]; // Standard 1-based mapping
        } else if (typeof dueMonth === 'string' && isNaN(mo)) {
            monthName = dueMonth; // User sent "August"
        }

        if (monthName && !isNaN(yr)) {
            filter.dueMonth = new RegExp(`${monthName}.*${yr}`, "i");
        } else if (monthName) {
            filter.dueMonth = { $regex: monthName, $options: "i" };
        } else if (!isNaN(yr)) {
            filter.dueMonth = { $regex: String(yr), $options: "i" };
        }
    }

    if (status !== undefined && status !== null && status !== "") {
        const s = Number(status);
        if (s === 0) {
            // Pending: Both are null
            filter.ledgerEntryDate = null;
            filter.gstEntryDate = null;
        } else if (s === 1) {
            // Rent Entry only
            filter.ledgerEntryDate = { $ne: null };
            filter.gstEntryDate = null;
        } else if (s === 2) {
            // GST Entry only
            filter.ledgerEntryDate = null;
            filter.gstEntryDate = { $ne: null };
        } else if (s === 3) {
            // Complete
            // We can't easily filter "Complete" with a single condition because it depends on withGst
            // However, we can approximate or use $or
            filter.$or = [
                { ledgerEntryDate: { $ne: null }, gstEntryDate: { $ne: null } },
                { ledgerEntryDate: { $ne: null }, withGst: 2 }
            ];
        }
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // 1) Summary Statistics
    const statsAgg = await OverDueHistory.aggregate([
      { $match: filter },
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
                      { $and: [{ $eq: ["$ledgerEntryDate", null] }, { $eq: ["$gstEntryDate", null] }] },
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
                    $cond: [{ $ne: ["$gstEntryDate", null] }, 1, 0]
                  }
                },
                bothEntry: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $and: [{ $ne: ["$ledgerEntryDate", null] }, { $ne: ["$gstEntryDate", null] }] },
                          { $and: [{ $ne: ["$ledgerEntryDate", null] }, { $eq: ["$withGst", 2] }] }
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

    // 2) Data Fetch
    const [history, totalCount] = await Promise.all([
      OverDueHistory.find(filter)
        .sort({ approvedDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      OverDueHistory.countDocuments(filter)
    ]);

    // 3) Enrichment for UI
    const enrichedHistory = history.map(item => {
        const dDate = item.dueDate ? new Date(item.dueDate) : null;

        const calcOverdueBy = (date) => {
            if (!date || !dDate) return "-";
            const diff = Math.floor((new Date(date) - dDate) / 86400000);
            return diff > 0 ? `${diff} days` : "0 days";
        };

        const ledgerDate = item.ledgerEntryDate;
        const gstDate = item.gstEntryDate;
        const withGst = Number(item.withGst || 0);

        let calculatedStatus = 0;
        let statusLabel = "Pending";

        if (withGst === 2) {
            // Rental Only (GST folded or not handled separately)
            if (ledgerDate) {
                calculatedStatus = 3;
                statusLabel = "Rent Entry (Complete)";
            }
        } else {
            // Tracked GST (withGst: 1) or Other
            if (ledgerDate && gstDate) {
                calculatedStatus = 3;
                statusLabel = "Rent + GST Entry";
            } else if (ledgerDate) {
                calculatedStatus = 1;
                statusLabel = "Rent Entry";
            } else if (gstDate) {
                calculatedStatus = 2;
                statusLabel = "GST Entry";
            }
        }

        const isDirect = withGst === 2;
        const rentAmount = isDirect ? Math.max((item.overDueAmount || 0) - (item.gstAmount || 0), 0) : (item.overDueAmount || 0);
        const totalAmount = isDirect ? (item.overDueAmount || 0) : (item.overDueAmount || 0) + (item.gstAmount || 0);

        return {
            ...item,
            rentAmount,
            overDueAmount: totalAmount,
            totalAmount: totalAmount,
            overdueDays: dDate ? Math.floor((today - dDate) / 86400000) : 0,
            approvalOverdueBy: calcOverdueBy(item.approvedDate),
            ledgerOverdueBy: calcOverdueBy(item.ledgerEntryDate),
            gstOverdueBy: calcOverdueBy(item.gstEntryDate),
            calculatedStatus,
            statusLabel
        };
    });

    return successResponse(res, "OverDue history fetched successfully", {
      summary: {
          ...summary,
          avgOverdueDays: Math.round(summary.avgOverdueDays || 0)
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
async function processSingleRevertVerification({ mediaId, role }) {
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

  if (Array.isArray(media.verificationProgressHistory) && media.verificationProgressHistory.length) {
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
      ? [...media.rentalDueEntries].reverse().find((e) => e.approvalStatus !== 3) ||
        media.rentalDueEntries[media.rentalDueEntries.length - 1]
      : null;

    if (pendingEntry) {
      const histMatch = media.agreementDocVerificationHistory
        .map((h, i) => ({ h, i }))
        .filter(({ h }) => h.verifiedByRole === userType && String(h.rentalDueId) === String(pendingEntry._id))
        .sort((a, b) => new Date(b.h.verifiedAt) - new Date(a.h.verifiedAt))[0];

      if (histMatch) {
        media.agreementDocVerificationHistory.splice(histMatch.i, 1);
        media.markModified("agreementDocVerificationHistory");
      }
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
    const { mediaId, mediaIds, role } = req.body;

    // ── NEW — batch mode ──
    if (Array.isArray(mediaIds) && mediaIds.length > 0) {
      const results = [];
      for (const id of mediaIds) {
        const result = await processSingleRevertVerification({ mediaId: id, role });
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
    const result = await processSingleRevertVerification({ mediaId, role });

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
async function processSingleRevertApproval({ mediaId, role }) {
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
        message: "Cannot revert Staff approval — Team Lead/Owner has already acted on this entry",
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

      return res.status(200).json({
        success: true,
        message: `${ROLE_LABEL[Number(role)] || "Role"} approval reverted for ${successCount} site(s)`,
        data: { results, totalSites: results.length, successCount, failedCount },
      });
    }

    // ── OLD — single mediaId request, response shape UNCHANGED ──
    const result = await processSingleRevertApproval({ mediaId, role });

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

    // ✅ FIXED — totalSites now counts EVERY site regardless of
    // status (Active + Inactive), so inactive sites still show up in
    // this count. Bill auto-generation itself still correctly skips
    // inactive sites (see generateMissedEntriesForMedia's status
    // guard) — this only affects the COUNT shown here, not whether
    // bills get created.
    const totalSites = await Media.countDocuments({});

    // ✅ ADDED — before computing any stats/list data, sweep every
    // active site and catch it up on any missed billing cycles. Same
    // rules as inside saveRentalDue: only CREATES new pending entries
    // for past cycles that don't have one yet (Rule 2), never touches
    // nextBillingDate/lastBillPaidDate (Rule 1). This guarantees the
    // list always reflects up-to-date pending/overdue bills even for
    // sites nobody has opened saveRentalDue for recently.
  const activeSitesForSweep = await Media.find({ "mediaDetails.status": 1 });
// const sweepDebugLog = [];
for (const siteDoc of activeSitesForSweep) {
  const hadNextBillingDateBefore = !!siteDoc.rentalPayment?.nextBillingDate; // ✅ ADDED
  const result = await generateMissedEntriesForMedia(siteDoc, "");
  const generatedCount = result?.generatedEntries?.length || 0;

  // ✅ CHANGED — save even when generatedCount is 0, so a freshly
  // seeded nextBillingDate (via ensureNextBillingDateSeed inside
  // generateMissedEntriesForMedia) isn't lost. Without this, the seed
  // would be discarded every request and rentalDue would NEVER catch
  // up on sites whose seed date is still in the future.
  if (generatedCount > 0 || siteDoc.isModified()) {
    await siteDoc.save({ timestamps: false });
  }

  // sweepDebugLog.push({
  //   mediaId: siteDoc._id,
  //   mediaName: siteDoc.mediaDetails?.[0]?.mediaName || "Unknown",
  //   generatedCount,
  //   latestDueMonth: siteDoc.rentalDue?.length
  //     ? siteDoc.rentalDue[siteDoc.rentalDue.length - 1]?.dueMonth
  //     : null,
  //   // ✅ ADDED — makes the exact root cause visible in the response
  //   // itself next time this happens, instead of having to guess.
  //   nextBillingDateWasSeededThisRequest:
  //     !hadNextBillingDateBefore && !!siteDoc.rentalPayment?.nextBillingDate,
  // });
}

    const monthOrCondition = {
      $or: [
        {
          "rentalPayment.nextBillingDate": { $gte: monthStart, $lte: monthEnd },
        },
        { "rentalDue.dueDate": { $gte: monthStart, $lte: monthEnd } },
      ],
    };

    const dueThisMonthAgg = await Media.aggregate([
      { $match: { "mediaDetails.status": 1 } },
      { $match: monthOrCondition },
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
          effectiveNetPayable: {
            $let: {
              vars: {
                base: { $ifNull: ["$matchingEntry.netPayable", "$rentalPayment.netPayable"] },
                entryGst: { $ifNull: ["$matchingEntry.gstAmount", 0] },
                siteGst: { $ifNull: ["$rentalPayment.gstAmount", 0] },
                ownerGst: {
                  $sum: {
                    $map: {
                      input: { $filter: { input: { $ifNull: ["$landOwners", []] }, as: "o", cond: { $eq: ["$$o.gstApplicable", 1] } } },
                      as: "o",
                      in: { $ifNull: ["$$o.gstAmount", 0] }
                    }
                  }
                }
              },
              in: {
                $let: {
                  vars: {
                    gst: {
                      $cond: [ { $gt: ["$$entryGst", 0] }, "$$entryGst", { $cond: [ { $gt: ["$$siteGst", 0] }, "$$siteGst", "$$ownerGst" ] } ]
                    }
                  },
                  in: {
                    $cond: [
                      {
                        $and: [
                          { $gt: ["$$gst", 0] },
                          { $gte: ["$$base", { $add: [{ $ifNull: ["$rentalPayment.totalRentalAmount", 0] }, "$$gst"] }] }
                        ]
                      },
                      "$$base",
                      { $add: ["$$base", "$$gst"] }
                    ]
                  }
                }
              }
            }
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
      { $match: { "mediaDetails.status": 1 } },
      { $match: monthOrCondition },
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
          effectiveNetPayable: {
            $let: {
              vars: {
                base: { $ifNull: ["$matchingEntry.netPayable", "$rentalPayment.netPayable"] },
                entryGst: { $ifNull: ["$matchingEntry.gstAmount", 0] },
                siteGst: { $ifNull: ["$rentalPayment.gstAmount", 0] },
                ownerGst: {
                  $sum: {
                    $map: {
                      input: { $filter: { input: { $ifNull: ["$landOwners", []] }, as: "o", cond: { $eq: ["$$o.gstApplicable", 1] } } },
                      as: "o",
                      in: { $ifNull: ["$$o.gstAmount", 0] }
                    }
                  }
                }
              },
              in: {
                $let: {
                  vars: {
                    gst: {
                      $cond: [ { $gt: ["$$entryGst", 0] }, "$$entryGst", { $cond: [ { $gt: ["$$siteGst", 0] }, "$$siteGst", "$$ownerGst" ] } ]
                    }
                  },
                  in: {
                    $cond: [
                      {
                        $and: [
                          { $gt: ["$$gst", 0] },
                          { $gte: ["$$base", { $add: [{ $ifNull: ["$rentalPayment.totalRentalAmount", 0] }, "$$gst"] }] }
                        ]
                      },
                      "$$base",
                      { $add: ["$$base", "$$gst"] }
                    ]
                  }
                }
              }
            }
          },
        },
      },
      {
        $match: {
          $or: [
            { "rentalPayment.status": { $in: [2, 3] } },
            {
              "matchingEntry.dueDate": { $lt: today },
              "matchingEntry.approvalStatus": { $ne: 3 },
            },
          ],
        },
      },
      { $match: { $expr: { $not: [isClosedOverallCond] } } },
      {
        $group: { _id: null, totalOpen: { $sum: "$effectiveNetPayable" } },
      },
    ]);
    const dueAmountOpen = dueAmountOpenAgg[0]?.totalOpen || 0;

    const statsAgg = await Media.aggregate([
      { $match: { "mediaDetails.status": 1 } },
      { $match: monthOrCondition },
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
          effectiveNetPayable: {
            $let: {
              vars: {
                base: { $ifNull: ["$matchingEntry.netPayable", "$rentalPayment.netPayable"] },
                entryGst: { $ifNull: ["$matchingEntry.gstAmount", 0] },
                siteGst: { $ifNull: ["$rentalPayment.gstAmount", 0] },
                ownerGst: {
                  $sum: {
                    $map: {
                      input: { $filter: { input: { $ifNull: ["$landOwners", []] }, as: "o", cond: { $eq: ["$$o.gstApplicable", 1] } } },
                      as: "o",
                      in: { $ifNull: ["$$o.gstAmount", 0] }
                    }
                  }
                }
              },
              in: {
                $let: {
                  vars: {
                    gst: {
                      $cond: [ { $gt: ["$$entryGst", 0] }, "$$entryGst", { $cond: [ { $gt: ["$$siteGst", 0] }, "$$siteGst", "$$ownerGst" ] } ]
                    }
                  },
                  in: {
                    $cond: [
                      {
                        $and: [
                          { $gt: ["$$gst", 0] },
                          { $gte: ["$$base", { $add: [{ $ifNull: ["$rentalPayment.totalRentalAmount", 0] }, "$$gst"] }] }
                        ]
                      },
                      "$$base",
                      { $add: ["$$base", "$$gst"] }
                    ]
                  }
                }
              }
            }
          },
          isApprovedByRole: hasRoleApprovedCond,
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


    // ✅ FIXED — same root cause as isPastPendingByRoleCond above.
    // Since nextBillingDate auto-advances regardless of approval, the
    // old approach (match sites where nextBillingDate < monthStart,
    // then find the ONE entry matching that date) misses every
    // past-pending month once the schedule has moved past it — which
    // is now the normal case whenever a bill isn't approved. Rewritten
    // to $unwind rentalDue and evaluate EVERY entry on its own merits
    // (its own dueDate, its own approvalStatus/approvalSteps),
    // counting each unapproved past entry independently — so 2 missed
    // months on the same site now correctly count as 2, not 0.
    const pastPendingAgg = await Media.aggregate([
      { $match: { "mediaDetails.status": 1 } },
      { $unwind: "$rentalDue" },
      { $match: { "rentalDue.dueDate": { $lt: monthStart } } },
      {
        $addFields: {
          roleStep: {
            $cond: [
              { $eq: [targetRole, null] },
              null,
              {
                $first: {
                  $filter: {
                    input: { $ifNull: ["$rentalDue.approvalSteps", []] },
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
          isPendingByRole:
            targetRole === null
              ? { $ne: ["$rentalDue.approvalStatus", 3] }
              : {
                  $and: [
                    { $ne: ["$rentalDue.approvalStatus", 3] },
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
              $let: {
                vars: {
                  base: "$rentalDue.netPayable",
                  entryGst: { $ifNull: ["$rentalDue.gstAmount", 0] },
                  siteGst: { $ifNull: ["$rentalPayment.gstAmount", 0] },
                  ownerGst: {
                    $sum: {
                      $map: {
                        input: { $filter: { input: { $ifNull: ["$landOwners", []] }, as: "o", cond: { $eq: ["$$o.gstApplicable", 1] } } },
                        as: "o",
                        in: { $ifNull: ["$$o.gstAmount", 0] }
                      }
                    }
                  }
                },
                in: {
                  $let: {
                    vars: {
                      gst: {
                        $cond: [ { $gt: ["$$entryGst", 0] }, "$$entryGst", { $cond: [ { $gt: ["$$siteGst", 0] }, "$$siteGst", "$$ownerGst" ] } ]
                      }
                    },
                    in: {
                      $cond: [
                        { $and: [ { $gt: ["$$gst", 0] }, { $gte: ["$$base", { $add: ["$rentalPayment.totalRentalAmount", "$$gst"] }] } ] },
                        "$$base",
                        { $add: ["$$base", "$$gst"] }
                      ]
                    }
                  }
                }
              }
            }
          },
        },
      },
    ]);
    const pastPendingApproval = {
      count: pastPendingAgg[0]?.count || 0,
      amount: pastPendingAgg[0]?.amount || 0,
    };

    const approvedCount = statsAgg[0]?.approved || 0;
    const approvedAmountTotal = statsAgg[0]?.approvedAmount || 0;
    const overDueSiteCount = (statsAgg[0]?.overdue || 0) + (pastPendingApproval.count || 0);
    const overDueAmountTotal = (statsAgg[0]?.overdueAmount || 0) + (pastPendingApproval.amount || 0);
    const pendingCount = (statsAgg[0]?.pending || 0) + overDueSiteCount;
    const pendingAmountTotal =
      (statsAgg[0]?.pendingAmount || 0) + overDueAmountTotal;

    const approvalBreakdownAgg = await Media.aggregate([
      { $match: { "mediaDetails.status": 1 } },
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
  const buildVerificationProgress = (item, targetCycleDate, targetRentalDueId) => {
  const targetCycleStr = getCurrentCycle(targetCycleDate);

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
  return vCycleKey === entryCycleKey;
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
    verificationProgress: buildVerificationProgress(item, entryObj.dueDate, entryObj._id),
    verificationProgressHistory: entryVerificationProgressHistory,
    gstApplicableDisplay: resolvedGstDisplay,
  };
});

      // verification history across every still-pending cycle shown above
      const pendingCycleKeys = new Set(
  pendingEntriesUpToMonth.map((e) => getCurrentCycle(e.dueDate)),
);

const filteredAgreementDocVerificationHistory = (
  item.agreementDocVerification || []
).filter((h) => {
  if (!h.cycle) return false;
  const hCycleKey =
    typeof h.cycle === "string" && h.cycle.match(/^\d{4}-\d{2}-\d{2}$/)
      ? h.cycle
      : getCurrentCycle(h.cycle);
  return pendingCycleKeys.has(hCycleKey);
});

      const details = item.mediaDetails || [];
      const siteBillMode = details[0]?.siteBillMode || 1;

      // ✅ SITE-BASED RENTAL ENTRIES:
      // If Single Bill (1): Return one entry per month for the whole site.
      // If Separate Bill (2): Return one entry per face per month.
      const rentalDueEntries = [];
      if (siteBillMode === 2) {
        details.forEach((face) => {
          filteredRentalDueEntries.forEach((entry) => {
            // ✅ ONLY pick entries that belong to this specific face
            if (String(entry.mediaDetailId || "") !== String(face._id)) return;

            rentalDueEntries.push({
              ...entry,
              mediaId: item._id,
              mediaDetailId: face._id,
              mediaName: face.mediaName,
              mediaCode: face.mediaCode,
              rentalDueId: entry._id, // User requested alias
              totalSqFt: face.totalSqFt,
            });
          });
        });
      } else {
        // Single Bill Mode
        filteredRentalDueEntries.forEach((entry) => {
          rentalDueEntries.push({
            ...entry,
            mediaId: item._id,
            mediaDetailId: null,
            mediaName: details.map((d) => d.mediaName).join(", "),
            mediaCode: details.map((d) => d.mediaCode).join(" / "),
            rentalDueId: entry._id,
            totalSqFt: details.reduce((sum, d) => sum + (d.totalSqFt || 0), 0),
          });
        });
      }

      return {
        _id: item._id,
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
        nextBillingDate: item.rentalPayment?.nextBillingDate,
        lastBillPaidDate: item.rentalPayment?.lastBillPaidDate,
        previousBillGenerateDate: (() => {
          const pbgd = item.rentalPayment?.previousBillGenerateDate;
          if (pbgd) return formatDate(pbgd);
          const lp = item.rentalPayment?.lastBillPaidDate;
          if (!lp) return "";
          const freq = Number(item.rentalPayment?.paymentFrequency || 1);
          const custom = Number(item.rentalPayment?.customPaymentFrequency || 1);
          const map = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
          const months = freq === 6 ? custom : (map[freq] || 1);
          const d = new Date(lp);
          d.setMonth(d.getMonth() - months);

          // ✅ CLAMP — don't go before billingStartDate
          const anchor = item.rentalPayment?.billingStartDate || lp;
          return formatDate(d < new Date(anchor) ? anchor : d);
        })(),
        // ✅ FIXED — return the entry's dueDate, fallback to lastBillPaidDate
        currentBillDate: currentMonthEntry
          ? formatDate(currentMonthEntry.dueDate)
          : formatDate(item.rentalPayment?.lastBillPaidDate),
        dueStatus: resolvedDueStatus,
        dueStatusLabel: STATUS_LABEL[resolvedDueStatus] || "",
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
    (e) => Number(e.gstApplicableFlag) === 1 || Number(e.gstApplicableFlag) === 2,
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

    return res.status(200).json({
      success: true,
      // sweepDebugLog,
      value: {
        totalSites,
        previousBillGenerateDate: formatDate(new Date(yr, mo - 2, 1)),
        currentBillDate: formatDate(monthStart),
        dueThisMonth,
        dueAmountOpen,
        overDue: { siteCount: overDueSiteCount, amount: overDueAmountTotal },
        approvedCount,
        approvedAmountTotal,
        pendingCount,
        pendingAmountTotal,
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
