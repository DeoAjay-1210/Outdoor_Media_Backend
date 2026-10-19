// ─────────────────────────────────────────────────────────────
// Rental Due stats — ONE shared rule for the Dashboard, Rental Due list
// (admin/rental-due-list) and Landowner site filter (landowner/site-filter),
// so dueThisMonth / pending / approved / overDue always match everywhere.
//
// Rules:
//  • Amounts come from the ledger cycle summary (getOverallSummaryForCycle):
//    real billing cycles only, active faces only, appraisal-aware rent.
//    rentalDue rows are used ONLY to decide a face's approval status, so
//    stale rows (removed faces) or per-face rows holding the full site rent
//    can no longer inflate the totals.
//  • Overdue = still NOT approved after its due date — for the current month
//    AND for past months. An approved-but-unpaid month is NOT overdue.
//  • "1 day after": a due becomes overdue when dueDate < start of today (IST).
//
// Media docs must include: mediaDetails, rentalPayment, landOwners, rentalDue,
// ledger, ledgerHistory, gstBalanceHistory, gstApplicableFlag, appraisal.
// ─────────────────────────────────────────────────────────────
const {
  getOverallSummaryForCycle,
  getAllDueCycles,
} = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");

const IST_OFFSET_MS = 330 * 60000; // 5h30m
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Start of today in IST, as the UTC-midnight Date of the IST calendar day —
// same shape as stored dueDates (e.g. 2026-10-03T00:00:00.000Z).
function startOfTodayIST() {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const isApprovedDue = (e) => Number(e.approvalStatus) === 3;

// best-match row for a face: approved first, then latest updated;
// site-level rows (no mediaDetailId) apply to every face
function pickFaceEntry(entries, faceId) {
  return entries
    .filter((e) => !e.mediaDetailId || String(e.mediaDetailId) === faceId)
    .sort((a, b) => {
      if (isApprovedDue(a) !== isApprovedDue(b)) return isApprovedDue(a) ? -1 : 1;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    })[0];
}

// ✅ NEW — opt-in (dashboard/v2): a SINGLE-bill site (every active face
// siteBillMode ≠ 2, 2+ faces) has ONE bill, so all its faces take the stage
// of the furthest-along row of the month (fully approved first, then the
// highest approved / skipped step, then latest updated). Without it a face
// left one step behind (e.g. ADINCHN0086 still at Manager while ADINCHN0085
// is at CMD) split one bill across two stages.
const approvalProgress = (e) =>
  isApprovedDue(e)
    ? 100
    : Math.max(0, ...(e.approvalSteps || []).filter((s) => s.status === 2 || s.status === 3).map((s) => Number(s.role) || 0));
const isSingleBillSite = (activeFaces) =>
  activeFaces.length > 1 && activeFaces.every((d) => Number(d.siteBillMode) !== 2);
function pickSiteBillEntry(entries, activeFaces) {
  const faceIds = new Set(activeFaces.map((d) => String(d._id)));
  return entries
    .filter((e) => !e.mediaDetailId || faceIds.has(String(e.mediaDetailId)))
    .sort(
      (a, b) =>
        approvalProgress(b) - approvalProgress(a) ||
        new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0),
    )[0];
}

// Role view of one face's entry (targetRole null = overall approval status)
//  • approved → that role's step is approved
//  • open (pending) → not fully approved AND that role has not approved / been
//    skipped yet — so a due pending at Rental Executive is also pending for
//    Rental Manager and CMD, until each of them (or a higher role) approves.
// Overdue never uses the role view — it is always the overall status.
//
// ✅ NEW — opts.pendingAtRoleOnly (opt-in, used by landowner/site-filter only):
// pending = the due is WAITING ON that role — every earlier step of the chain
// is approved / skipped and the role itself has not acted. So a due still at
// the Rental Executive is pending only for the Executive; once the Executive
// approves it moves to the Manager; once the Manager approves, to the CMD.
// Without the option the rule above is unchanged (Dashboard, Rental Due list).
const FIRST_APPROVER_ROLE = 1; // Rental Executive — first step of every chain
const isStepActed = (s) => s.status === 2 || s.status === 3;
function isWaitingOnRole(entry, targetRole) {
  const steps = entry?.approvalSteps || [];
  // no due row / no steps yet → nothing approved → waiting on the first role
  if (steps.length === 0) return Number(targetRole) === FIRST_APPROVER_ROLE;
  const idx = steps.findIndex((s) => s.role === targetRole);
  if (idx === -1 || isStepActed(steps[idx])) return false;
  return steps.slice(0, idx).every(isStepActed);
}

function roleStatus(entry, targetRole, opts = {}) {
  const isApprovedOverall = entry ? isApprovedDue(entry) : false;
  if (targetRole === null || targetRole === undefined) {
    return { isApproved: isApprovedOverall, isOpen: !isApprovedOverall };
  }
  const roleStep = (entry?.approvalSteps || []).find((s) => s.role === targetRole);
  const hasRoleApproved = !!roleStep && roleStep.status === 2;
  if (opts.pendingAtRoleOnly) {
    return { isApproved: hasRoleApproved, isOpen: !isApprovedOverall && isWaitingOnRole(entry, targetRole) };
  }
  const hasRoleActed = !!roleStep && (roleStep.status === 2 || roleStep.status === 3);
  return { isApproved: hasRoleApproved, isOpen: !isApprovedOverall && !hasRoleActed };
}

// ✅ NEW — landowner breakdown for one bucket (dueThisMonth / approved / pending /
// overdue). A face's amount is split between the site's landowners by their
// shareAmount (equal split when no shares), so the owners' amounts add up to
// the bucket amount.
function addFaceToOwnerBucket(bucket, media, faceId, amount) {
  const owners = media.landOwners || [];
  if (!owners.length) return;
  const totalShare = owners.reduce((s, o) => s + (Number(o.shareAmount) || 0), 0);
  owners.forEach((o) => {
    const key = String(o.landOwnerMasterId || o._id || o.name || "");
    if (!key) return;
    const ratio = totalShare > 0 ? (Number(o.shareAmount) || 0) / totalShare : 1 / owners.length;
    if (!bucket.has(key)) {
      bucket.set(key, {
        landOwnerMasterId: o.landOwnerMasterId || null,
        name: o.name || "",
        phone: o.phone || "",
        faces: new Set(),
        amount: 0,
      });
    }
    const item = bucket.get(key);
    item.faces.add(`${String(media._id)}_${faceId}`);
    item.amount += amount * ratio;
  });
}

const finalizeOwnerBucket = (bucket) =>
  Array.from(bucket.values())
    .map((o) => ({
      landOwnerMasterId: o.landOwnerMasterId,
      name: o.name,
      phone: o.phone,
      siteCount: o.faces.size,
      amount: Math.round(o.amount),
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

/**
 * @param {Array} mediaDocs  active media docs (lean or mongoose)
 * @param {{year:number, month:number, targetRole?:number|null, trackLandOwners?:boolean}} opts  month is 1-12
 *   trackLandOwners (opt-in) → also returns stats.landOwners { dueThisMonth, approved, pending, overdue }
 */
function computeRentalDueStats(mediaDocs, { year, month, targetRole = null, trackLandOwners = false, faceFilter = null, onFace = null, pendingAtRoleOnly = false, singleBillAsSite = false }) {
  const ownerBuckets = trackLandOwners
    ? { dueThisMonth: new Map(), approved: new Map(), pending: new Map(), overdue: new Map() }
    : null;
  const trackOwner = (bucketName, media, faceId, amount) => {
    if (ownerBuckets) addFaceToOwnerBucket(ownerBuckets[bucketName], media, faceId, amount);
  };

  const stats = {
    dueThisMonthCount: 0,
    dueThisMonthAmount: 0,
    dueAmountOpen: 0,
    approvedCount: 0,
    approvedAmountTotal: 0,
    overdueCount: 0,
    overdueAmountTotal: 0,
    pendingCount: 0,
    pendingAmountTotal: 0,
  };

  const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const currentCycleKey = year * 12 + (month - 1);
  const statsMonthYear = { year, month };
  const today = startOfTodayIST();

  for (const media of mediaDocs || []) {
    const activeFacesList = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);
    if (activeFacesList.length === 0) continue;
    const faceCount = activeFacesList.length;
    const overdueFaces = new Set();

    // ── 1) Current month ──
    const cycleSummary = getOverallSummaryForCycle(media, statsMonthYear);
    const currentSiteAmount =
      Number(cycleSummary.currentMonthRentalAmount || 0) +
      Number(cycleSummary.currentMonthGstAmount || 0);

    if (currentSiteAmount > 0) {
      const faceAmount = currentSiteAmount / faceCount;
      const currentMonthEntries = (media.rentalDue || []).filter((e) => {
        if (!e.dueDate) return false;
        const d = new Date(e.dueDate);
        return d >= monthStart && d <= monthEnd;
      });

      // ✅ NEW — singleBillAsSite: one bill → one row for every face of the site
      const siteBillEntry =
        singleBillAsSite && isSingleBillSite(activeFacesList)
          ? pickSiteBillEntry(currentMonthEntries, activeFacesList)
          : undefined;
      for (const face of activeFacesList) {
        const faceId = String(face._id);
        const entry = siteBillEntry !== undefined ? siteBillEntry : pickFaceEntry(currentMonthEntries, faceId);
        // optional caller filter (e.g. login role) — default: no filtering
        if (faceFilter && !faceFilter(entry, media, face)) continue;
        stats.dueThisMonthCount += 1;
        stats.dueThisMonthAmount += faceAmount;
        trackOwner("dueThisMonth", media, faceId, faceAmount);

        // const entry = pickFaceEntry(currentMonthEntries, faceId);
        const { isApproved, isOpen } = roleStatus(entry, targetRole, { pendingAtRoleOnly });
        // overdue is role independent → always the overall approval status
        const isOpenOverall = roleStatus(entry, null).isOpen;

        if (isApproved) {
          stats.approvedCount += 1;
          stats.approvedAmountTotal += faceAmount;
           trackOwner("approved", media, faceId, faceAmount);
          if (onFace) onFace({ media, face, entry, amount: faceAmount, state: "approved", cycle: cycleSummary, rolePending: false });
          continue;
        }
        // ✅ NEW — pendingAtRoleOnly: a due still waiting on an EARLIER role is
        // not pending for this role, but it must still reach the overdue check
        // below (overdue is role independent).
        const notYetAtRole = pendingAtRoleOnly && !isOpen && isOpenOverall;
        if (!isOpen && !notYetAtRole) {
          if (onFace) onFace({ media, face, entry, amount: faceAmount, state: "closed", cycle: cycleSummary, rolePending: false });
          continue;
        }

         else if (isOpen) {
          // pending = every open current-month due (for the role, when given)
          stats.pendingCount += 1;
          stats.pendingAmountTotal += faceAmount;
          trackOwner("pending", media, faceId, faceAmount);
        }
        if (!isOpenOverall) continue;

        // overdue = open current-month due already past its due date (1 day after)
        const isOverdue =
          Number(media.rentalPayment?.status) === 3 ||
          (entry?.dueDate && new Date(entry.dueDate) < today);
        if (isOverdue) {
          overdueFaces.add(faceId);
          stats.overdueAmountTotal += faceAmount;
          stats.dueAmountOpen += faceAmount;
          trackOwner("overdue", media, faceId, faceAmount);
        }
        // rolePending (✅ NEW) = this face is counted in pendingCount for the role
        if (onFace) onFace({ media, face, entry, amount: faceAmount, state: isOverdue ? "overdue" : notYetAtRole ? "closed" : "pending", cycle: cycleSummary, rolePending: isOpen, cycleLabel: `${MONTH_NAMES[month - 1]} ${year}`, gstShare: Number(cycleSummary.currentMonthGstAmount || 0) / faceCount });
      }
    }

    // ── 2) Past months — overdue while still NOT approved ──
    const pastCycles = getAllDueCycles(media, statsMonthYear).filter(
      (c) => c.getUTCFullYear() * 12 + c.getUTCMonth() < currentCycleKey,
    );
    for (const cycleDate of pastCycles) {
      const cycleYear = cycleDate.getUTCFullYear();
      const cycleMonthIdx = cycleDate.getUTCMonth();
      const cycleLabel = `${MONTH_NAMES[cycleMonthIdx]} ${cycleYear}`;

      const pastSummary = getOverallSummaryForCycle(media, { year: cycleYear, month: cycleMonthIdx + 1 });
      const pastCycleAmount =
        Number(pastSummary.currentMonthRentalAmount || 0) +
        Number(pastSummary.currentMonthGstAmount || 0);
      if (pastCycleAmount <= 0) continue;
      const pastFaceAmount = pastCycleAmount / faceCount;

      const pastCycleEntries = (media.rentalDue || []).filter((e) => e.dueMonth === cycleLabel);
      const pastSiteBillEntry =
        singleBillAsSite && isSingleBillSite(activeFacesList)
          ? pickSiteBillEntry(pastCycleEntries, activeFacesList)
          : undefined;
      for (const face of activeFacesList) {
        const faceId = String(face._id);
        const entry = pastSiteBillEntry !== undefined ? pastSiteBillEntry : pickFaceEntry(pastCycleEntries, faceId);
        if (faceFilter && !faceFilter(entry, media, face)) continue;
        const { isOpen } = roleStatus(entry, null); // overdue is role independent
        if (!isOpen) continue;
        overdueFaces.add(faceId);
        stats.overdueAmountTotal += pastFaceAmount;
        if (onFace) onFace({ media, face, entry, amount: pastFaceAmount, state: "overdue", past: true, cycleLabel, cycleDate, gstShare: Number(pastSummary.currentMonthGstAmount || 0) / faceCount });
        trackOwner("overdue", media, faceId, pastFaceAmount);
      }
    }

    stats.overdueCount += overdueFaces.size;
  }

  if (ownerBuckets) {
    stats.landOwners = {
      dueThisMonth: finalizeOwnerBucket(ownerBuckets.dueThisMonth),
      approved: finalizeOwnerBucket(ownerBuckets.approved),
      pending: finalizeOwnerBucket(ownerBuckets.pending),
      overdue: finalizeOwnerBucket(ownerBuckets.overdue),
    };
  }

  return stats;
}

/**
 * Per-face role status of ONE media for the month — same rules as
 * computeRentalDueStats, so a site list filtered with it matches the header
 * counts (approvedCount / pendingCount / overDue.siteCount).
 * @returns {Map<string, {approved:boolean, pending:boolean, overdue:boolean}>} keyed by face _id
 */
function getFaceRoleStatus(media, { year, month, targetRole = null, pendingAtRoleOnly = false, singleBillAsSite = false }) {
  const result = new Map();
  const activeFacesList = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);
  if (activeFacesList.length === 0) return result;
  activeFacesList.forEach((face) =>
    result.set(String(face._id), { approved: false, pending: false, overdue: false }),
  );

  const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const currentCycleKey = year * 12 + (month - 1);
  const statsMonthYear = { year, month };
  const today = startOfTodayIST();

  // ── 1) Current month ──
  const cycleSummary = getOverallSummaryForCycle(media, statsMonthYear);
  const currentSiteAmount =
    Number(cycleSummary.currentMonthRentalAmount || 0) +
    Number(cycleSummary.currentMonthGstAmount || 0);
  if (currentSiteAmount > 0) {
    const currentMonthEntries = (media.rentalDue || []).filter((e) => {
      if (!e.dueDate) return false;
      const d = new Date(e.dueDate);
      return d >= monthStart && d <= monthEnd;
    });
    const siteBillEntry =
      singleBillAsSite && isSingleBillSite(activeFacesList)
        ? pickSiteBillEntry(currentMonthEntries, activeFacesList)
        : undefined;
    for (const face of activeFacesList) {
      const flags = result.get(String(face._id));
      const entry = siteBillEntry !== undefined ? siteBillEntry : pickFaceEntry(currentMonthEntries, String(face._id));
      const { isApproved, isOpen } = roleStatus(entry, targetRole, { pendingAtRoleOnly });
      if (isApproved) flags.approved = true;
      else if (isOpen) flags.pending = true;
      // overdue is role independent → overall approval status
      if (!roleStatus(entry, null).isOpen) continue;
      if (Number(media.rentalPayment?.status) === 3 || (entry?.dueDate && new Date(entry.dueDate) < today)) {
        flags.overdue = true;
      }
    }
  }

  // ── 2) Past months — overdue while still open ──
  const pastCycles = getAllDueCycles(media, statsMonthYear).filter(
    (c) => c.getUTCFullYear() * 12 + c.getUTCMonth() < currentCycleKey,
  );
  for (const cycleDate of pastCycles) {
    const cycleLabel = `${MONTH_NAMES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;
    const pastSummary = getOverallSummaryForCycle(media, {
      year: cycleDate.getUTCFullYear(),
      month: cycleDate.getUTCMonth() + 1,
    });
    const pastCycleAmount =
      Number(pastSummary.currentMonthRentalAmount || 0) +
      Number(pastSummary.currentMonthGstAmount || 0);
    if (pastCycleAmount <= 0) continue;
    const pastCycleEntries = (media.rentalDue || []).filter((e) => e.dueMonth === cycleLabel);
    const pastSiteBillEntry =
      singleBillAsSite && isSingleBillSite(activeFacesList)
        ? pickSiteBillEntry(pastCycleEntries, activeFacesList)
        : undefined;
    for (const face of activeFacesList) {
      const entry = pastSiteBillEntry !== undefined ? pastSiteBillEntry : pickFaceEntry(pastCycleEntries, String(face._id));
      if (roleStatus(entry, null).isOpen) result.get(String(face._id)).overdue = true;
    }
  }

  return result;
}

module.exports = { computeRentalDueStats, getFaceRoleStatus, roleStatus, startOfTodayIST, isSingleBillSite, pickSiteBillEntry };
