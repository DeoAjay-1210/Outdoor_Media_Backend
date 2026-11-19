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
// ✅ NEW — opts.overdueFrom (opt-in, landowner/site-filter billDate filter):
// (media, entry) → the date after which an open current-month due is overdue
// (instead of entry.dueDate). Without it the rule is unchanged.
// ✅ NEW — opts.overdueByRole (opt-in, landowner/site-filter only): with a
// targetRole, overdue = past-due bills WAITING ON that role (same rule as
// pending), current and past months. Without it overdue stays role independent.
// ✅ NEW — opts.pastOverdueOnly (opt-in, landowner/site-filter only): overdue
// counts PAST months only — the current month's overdue is not added.
// ✅ NEW — opts.overdueByMonth (opt-in): stats.overdueMonths = past-month
// overdue breakdown [{ month, siteCount, amount, landOwnerCount }], oldest first.
// ✅ NEW — opts.pastApprovedInMonth (opt-in): stats.pastApprovedInMonth = PAST
// month bills approved inside this month (approvalSteps[].approvedAt), at that
// bill month's own rent + GST. With targetRole → that role's approval date.
// ✅ NEW — opts.pastPendingByMonth (opt-in): stats.pastMonthPending = PAST month
// bills still not approved (same bills as the past overdue) with rent / GST split,
// + totalPendingThisMonth (past + this month's pending). pastApprovedInMonth also
// adds totalApprovedThisMonth (past approved in this month + this month's approved).
function computeRentalDueStats(mediaDocs, { year, month, targetRole = null, trackLandOwners = false, faceFilter = null, onFace = null, pendingAtRoleOnly = false, singleBillAsSite = false, overdueFrom = null, overdueByRole = false, dueThisMonthByRole = false, pastOverdueOnly = false, overdueByMonth = false, pastApprovedInMonth = false, pastPendingByMonth = false }) {
  const overdueMonthBuckets = overdueByMonth || pastPendingByMonth ? new Map() : null; // ✅ NEW
  const pastApproved = pastApprovedInMonth ? { faces: new Set(), owners: new Map(), months: new Map() } : null; // ✅ NEW
  // ✅ NEW — this month's approved / pending faces + landowners (for the combined totals)
  const curApproved = pastApprovedInMonth ? { faces: new Set(), owners: new Map() } : null;
  const curPending = pastPendingByMonth ? { faces: new Set(), owners: new Map() } : null;
  const trackCur = (acc, media, faceId, amount) => {
    if (!acc) return;
    acc.faces.add(`${String(media._id)}_${faceId}`);
    addFaceToOwnerBucket(acc.owners, media, faceId, amount);
  };
  const roleOverdue = overdueByRole && targetRole !== null && targetRole !== undefined;
  // ✅ NEW — opts.dueThisMonthByRole (opt-in, landowner/site-filter only): with a
  // targetRole, dueThisMonth counts only this month's bills WAITING ON that role
  const roleDueThisMonth = dueThisMonthByRole && targetRole !== null && targetRole !== undefined;
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
        // const entry = pickFaceEntry(currentMonthEntries, faceId);
        const { isApproved, isOpen } = roleStatus(entry, targetRole, { pendingAtRoleOnly });
        // ✅ NEW — dueThisMonthByRole: only this month's bills waiting on that role
        if (!roleDueThisMonth || isOpen) {
          stats.dueThisMonthCount += 1;
          stats.dueThisMonthAmount += faceAmount;
          trackOwner("dueThisMonth", media, faceId, faceAmount);
        }
        // overdue is role independent → always the overall approval status
        const isOpenOverall = roleStatus(entry, null).isOpen;

        if (isApproved) {
          stats.approvedCount += 1;
          stats.approvedAmountTotal += faceAmount;
           trackOwner("approved", media, faceId, faceAmount);
          trackCur(curApproved, media, faceId, faceAmount); // ✅ NEW
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
          trackCur(curPending, media, faceId, faceAmount); // ✅ NEW
        }
        if (!isOpenOverall) continue;
        if (roleOverdue && !isOpen) continue; // ✅ NEW — not waiting on this role → not its overdue

        // overdue = open current-month due already past its due date (1 day after)
        const overdueDate = overdueFrom ? overdueFrom(media, entry) : entry?.dueDate;
        const isOverdue =
          (!overdueFrom && Number(media.rentalPayment?.status) === 3) ||
          (overdueDate && new Date(overdueDate) < today);
        if (isOverdue && !pastOverdueOnly) { // ✅ CHANGED — pastOverdueOnly: current month not added
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
        // ✅ NEW — pastApprovedInMonth: this past bill approved inside this month
        if (pastApproved && approvedAtInRange(entry, targetRole, monthStart, monthEnd)) {
          const gstShare = Number(pastSummary.currentMonthGstAmount || 0) / faceCount;
          addToMonthBucket(pastApproved.months, cycleLabel, cycleYear * 12 + cycleMonthIdx, media, faceId, pastFaceAmount, gstShare);
          pastApproved.faces.add(`${String(media._id)}_${faceId}`);
          addFaceToOwnerBucket(pastApproved.owners, media, faceId, pastFaceAmount);
        }
        const { isOpen } = roleStatus(entry, null); // overdue is role independent
        if (!isOpen) continue;
        // ✅ NEW — overdueByRole: only past bills waiting on this role
        if (roleOverdue && !roleStatus(entry, targetRole, { pendingAtRoleOnly }).isOpen) continue;
        overdueFaces.add(faceId);
        // ✅ NEW — overdueByMonth: past-month breakdown
        if (overdueMonthBuckets) addToMonthBucket(overdueMonthBuckets, cycleLabel, cycleYear * 12 + cycleMonthIdx, media, faceId, pastFaceAmount, Number(pastSummary.currentMonthGstAmount || 0) / faceCount);
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

  // ✅ NEW — combined total: past month part + this month part, sites and
  // landowners counted once even when they are in both
  const combinedTotal = (pastPart, cur, curAmount, curCount) => {
    const faces = new Set([...pastPart.faces, ...cur.faces]);
    const owners = new Set([...pastPart.ownerKeys, ...cur.owners.keys()]);
    const currentMonthTotalAmount = Math.round(curAmount);
    return {
      pastMonthTotalAmount: pastPart.totalAmount,
      pastMonthSiteCount: new Set(pastPart.faces).size, // ✅ NEW — distinct past-month sites (faces)
      pastMonthLandOwnerCount: new Set(pastPart.ownerKeys).size, // ✅ NEW — distinct past-month landowners
      currentMonth: `${MONTH_NAMES[month - 1]} ${year}`,
      currentMonthTotalAmount,
      currentMonthSiteCount: curCount,
      currentMonthLandOwnerCount: cur.owners.size,
      totalAmount: pastPart.totalAmount + currentMonthTotalAmount,
      siteCount: faces.size,
      landOwnerCount: owners.size,
    };
  };

  // ✅ NEW — past month bills still not approved (opt-in)
  if (pastPendingByMonth) {
    const months = finalizeMonthBuckets(overdueMonthBuckets);
    const faces = new Set();
    const ownerKeys = new Set();
    overdueMonthBuckets.forEach((b) => {
      b.faces.forEach((f) => faces.add(f));
      b.owners.forEach((_, k) => ownerKeys.add(k));
    });
    const totalAmount = months.reduce((s, m) => s + m.totalAmount, 0);
    stats.pastMonthPending = {
      currentMonth: `${MONTH_NAMES[month - 1]} ${year}`,
      siteCount: faces.size,
      amount: months.reduce((s, m) => s + m.amount, 0),
      gstAmount: months.reduce((s, m) => s + m.gstAmount, 0),
      totalAmount,
      landOwnerCount: ownerKeys.size,
      months,
      totalPendingThisMonth: combinedTotal({ faces, ownerKeys, totalAmount }, curPending, stats.pendingAmountTotal, stats.pendingCount),
    };
  }

  // ✅ NEW — past-month overdue breakdown (opt-in)
  if (overdueByMonth) {
    stats.overdueMonths = finalizeMonthBuckets(overdueMonthBuckets).map(({ month: m, siteCount, totalAmount, landOwnerCount }) => ({
      month: m,
      siteCount,
      amount: totalAmount,
      landOwnerCount,
    }));
  }
  // ✅ NEW — past bills approved inside this month (opt-in)
  if (pastApproved) {
    const months = finalizeMonthBuckets(pastApproved.months);
    stats.pastApprovedInMonth = {
      approvedMonth: `${MONTH_NAMES[month - 1]} ${year}`,
      siteCount: pastApproved.faces.size,
      amount: months.reduce((s, m) => s + m.amount, 0),
      gstAmount: months.reduce((s, m) => s + m.gstAmount, 0),
      totalAmount: months.reduce((s, m) => s + m.totalAmount, 0),
      landOwnerCount: pastApproved.owners.size,
      months,
    };
    // ✅ NEW — every approval of this month: past month bills + this month's bill
    stats.pastApprovedInMonth.totalApprovedThisMonth = combinedTotal(
      { faces: pastApproved.faces, ownerKeys: new Set(pastApproved.owners.keys()), totalAmount: stats.pastApprovedInMonth.totalAmount },
      curApproved,
      stats.approvedAmountTotal,
      stats.approvedCount,
    );
  }

  return stats;
}

// ✅ NEW — approval date of a bill inside [from, to]: targetRole given → that
// role's step (approved); otherwise the bill must be fully approved and its
// last step approval date is used. approvedAt is stored nowIST-style, so it is
// compared as-is with the UTC month bounds (no local-time conversion).
function approvedAtInRange(entry, targetRole, from, to) {
  if (!entry) return null;
  const steps = entry.approvalSteps || [];
  let at = null;
  if (targetRole !== null && targetRole !== undefined) {
    const step = steps.find((s) => s.role === targetRole);
    if (!step || step.status !== 2 || !step.approvedAt) return null;
    at = new Date(step.approvedAt);
  } else {
    if (!isApprovedDue(entry)) return null;
    steps.forEach((s) => {
      if ((s.status === 2 || s.status === 3) && s.approvedAt) {
        const d = new Date(s.approvedAt);
        if (!at || d > at) at = d;
      }
    });
  }
  if (!at || Number.isNaN(at.getTime())) return null;
  return at >= from && at <= to ? at : null;
}

// ✅ NEW — month-wise bucket: faces, landowners, rent + GST
function addToMonthBucket(buckets, label, sortKey, media, faceId, totalAmount, gstAmount) {
  if (!buckets.has(label)) buckets.set(label, { sortKey, faces: new Set(), owners: new Map(), total: 0, gst: 0 });
  const b = buckets.get(label);
  b.faces.add(`${String(media._id)}_${faceId}`);
  b.total += totalAmount;
  b.gst += gstAmount;
  addFaceToOwnerBucket(b.owners, media, faceId, totalAmount);
}

function finalizeMonthBuckets(buckets) {
  return Array.from(buckets.entries())
    .sort((a, b) => a[1].sortKey - b[1].sortKey)
    .map(([label, b]) => {
      const totalAmount = Math.round(b.total);
      const gstAmount = Math.round(b.gst);
      return {
        month: label,
        siteCount: b.faces.size,
        amount: totalAmount - gstAmount,
        gstAmount,
        totalAmount,
        landOwnerCount: b.owners.size,
      };
    });
}

/**
 * Per-face role status of ONE media for the month — same rules as
 * computeRentalDueStats, so a site list filtered with it matches the header
 * counts (approvedCount / pendingCount / overDue.siteCount).
 * @returns {Map<string, {approved:boolean, pending:boolean, overdue:boolean}>} keyed by face _id
 */
// ✅ NEW — opts.pastOverdueOnly (opt-in): overdue = past months only (same as computeRentalDueStats)
function getFaceRoleStatus(media, { year, month, targetRole = null, pendingAtRoleOnly = false, singleBillAsSite = false, overdueByRole = false, pastOverdueOnly = false }) {
  // ✅ NEW — overdueByRole: overdue only while waiting on targetRole (same as computeRentalDueStats)
  const roleOverdue = overdueByRole && targetRole !== null && targetRole !== undefined;
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
      if (pastOverdueOnly) continue; // ✅ NEW — current month never overdue
      // overdue is role independent → overall approval status
      if (!roleStatus(entry, null).isOpen) continue;
      if (roleOverdue && !isOpen) continue; // ✅ NEW — not waiting on this role
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
      if (!roleStatus(entry, null).isOpen) continue;
      // ✅ NEW — overdueByRole: only past bills waiting on this role
      if (roleOverdue && !roleStatus(entry, targetRole, { pendingAtRoleOnly }).isOpen) continue;
      result.get(String(face._id)).overdue = true;
    }
  }

  return result;
}

module.exports = { computeRentalDueStats, getFaceRoleStatus, roleStatus, startOfTodayIST, isSingleBillSite, pickSiteBillEntry };
