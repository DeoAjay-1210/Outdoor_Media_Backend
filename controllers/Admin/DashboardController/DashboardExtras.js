// Dashboard v2 calculations. Pure functions over lean MediaOnboarding docs.
// Reuses the existing rental-due rules (rentalDueStats / LedgerNew2Controller) — no business rule is changed here.
const {
  getOverallSummaryForCycle,
  getAllDueCycles,
  getRequiredModesShared,
  calculateOverallLedgerSummary,
} = require("../MediaOnboardingController/LedgerNew2Controller");
const { computeRentalDueStats } = require("../../../utils/rentalDueStats");

const IST_OFFSET_MS = 330 * 60000;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ROLE_LABEL = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const num = (v) => Number(v) || 0;
const labelOf = (y, m) => `${MONTH_NAMES[m - 1]} ${y}`;

// ── Filters ──────────────────────────────────────────────────
/** Validates body and returns { error } or { range, filters }. Month boundaries are whole IST calendar months. */
function parseFilters(body = {}) {
  const now = nowIST();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  const date = ["current", "last", "custom"].includes(body.date) ? body.date : null;

  let months = [];
  if (date === "custom") {
    const s = new Date(body.startDate);
    const e = new Date(body.endDate);
    if (isNaN(s) || isNaN(e)) return { error: "startDate and endDate are required for a custom range" };
    if (e < s) return { error: "endDate must be on or after startDate" };
    let cy = s.getUTCFullYear(), cm = s.getUTCMonth() + 1;
    const ey = e.getUTCFullYear(), em = e.getUTCMonth() + 1;
    while (cy * 12 + cm <= ey * 12 + em) {
      months.push({ year: cy, month: cm });
      cm += 1;
      if (cm > 12) { cm = 1; cy += 1; }
    }
    if (months.length > 12) return { error: "Custom range cannot exceed 12 months" };
  } else {
    // legacy "MM-YYYY" month param is still honoured
    if (typeof body.month === "string" && /^\d{2}-\d{4}$/.test(body.month)) {
      m = parseInt(body.month.slice(0, 2), 10);
      y = parseInt(body.month.slice(3), 10);
      if (m < 1 || m > 12) return { error: "Invalid month" };
    }
    if (date === "last") { m -= 1; if (m < 1) { m = 12; y -= 1; } }
    months = [{ year: y, month: m }];
  }
  const first = months[0], last = months[months.length - 1];
  const range = {
    months, first, last,
    start: new Date(Date.UTC(first.year, first.month - 1, 1)),
    end: new Date(Date.UTC(last.year, last.month, 0, 23, 59, 59, 999)),
    labels: new Set(months.map((x) => labelOf(x.year, x.month).toLowerCase())),
    from: date === "custom" ? new Date(Date.UTC(new Date(body.startDate).getUTCFullYear(), new Date(body.startDate).getUTCMonth(), new Date(body.startDate).getUTCDate())) : null,
    to: date === "custom" ? new Date(Date.UTC(new Date(body.endDate).getUTCFullYear(), new Date(body.endDate).getUTCMonth(), new Date(body.endDate).getUTCDate(), 23, 59, 59, 999)) : null,
  };

  const role = (v) => ([1, 2, 3].includes(Number(v)) ? Number(v) : null);
  if (body.loginRole && !role(body.loginRole) && Number(body.loginRole) !== 0) return { error: "Invalid loginRole" };
  const gst = ["with", "without"].includes(body.gst) ? body.gst : "all";
  const status = ["pending", "approved"].includes(body.status) ? body.status : "all";
  return { range, filters: { loginRole: role(body.loginRole), status, gst } };
}

// Every saved ledger entry is mirrored into ledgerHistory with a different _id, so identify an entry by its content.
const entryKey = (e) => [e.landOwnerId, e.paymentMode, e.utrNumber, e.rentalDueId, e.index, num(e.amount), e.date ? new Date(e.date).getTime() : ""].join("|");

const siteHasGst = (d) => num(d.gstApplicableFlag) > 0 || (d.landOwners || []).some((o) => num(o.gstApplicable) === 1);
const applyGst = (docs, gst) => (gst === "all" ? docs : docs.filter((d) => (gst === "with" ? siteHasGst(d) : !siteHasGst(d))));
// Login filter = rentalDue entry was saved by a user of that role (entry.savedBy.role)
// Pending / Approved for a role (Rental Master rule): approved = that role's step approved; pending = not fully approved and the role has not acted.
// No role (All Logins) → overall approval state.
function matchStatus(entry, role, status) {
  if (status === "all") return true;
  const overall = num(entry?.approvalStatus) === 3;
  if (!role) return status === "approved" ? overall : !overall;
  const st = (entry?.approvalSteps || []).find((x) => x.role === role);
  const approved = !!st && num(st.status) === 2, acted = !!st && [2, 3].includes(num(st.status));
  return status === "approved" ? approved : !overall && !acted;
}
// custom range: keep a cycle only when its due date falls inside [from, to]
const inWindow = (range, entry, year, month) => {
  if (!range.from) return true;
  const d = entry?.dueDate ? new Date(entry.dueDate) : new Date(Date.UTC(year, month - 1, 1));
  return d >= range.from && d <= range.to;
};
const loginFilter = (role) => (role ? (entry) => !!entry && num(entry.savedBy?.role) === role : null);

// ── Approval stage helpers (skipped steps are never pending) ──
function pendingRoleOf(entry) {
  if (!entry) return 1;
  if (num(entry.approvalStatus) === 3) return null;
  const steps = entry.approvalSteps || [];
  if (!steps.length) return num(entry.currentPendingRole) || 1;
  // a stage below an already-approved higher stage was bypassed (e.g. CMD direct approval) → never pending
  const maxApproved = Math.max(0, ...steps.filter((s) => num(s.status) === 2).map((s) => s.role));
  const open = steps.filter((s) => num(s.status) === 1 && s.role > maxApproved).sort((a, b) => a.role - b.role)[0];
  return open ? open.role : null;
}
function finalApproverOf(entry) {
  const done = (entry?.approvalSteps || []).filter((s) => num(s.status) === 2).sort((a, b) => b.role - a.role)[0];
  return done ? done.role : null;
}
/** Effective 3-stage flow for display: Approved / Pending / Skipped (never a skipped stage shown as pending or approved). */
function approvalFlow(entry) {
  const steps = entry?.approvalSteps || [];
  const overall = num(entry?.approvalStatus) === 3;
  const maxApproved = Math.max(0, ...steps.filter((x) => num(x.status) === 2).map((x) => x.role));
  return [1, 2, 3].map((role) => {
    const st = steps.find((x) => x.role === role);
    let state = "Pending";
    if (st && num(st.status) === 2) state = "Approved";
    else if ((st && num(st.status) === 3) || role < maxApproved || (overall && !(st && num(st.status) === 2))) state = "Skipped";
    return { role, label: ROLE_LABEL[role], state, by: state === "Approved" ? st.userName || "" : "", at: state === "Approved" ? st.approvedAt || null : null, remarks: st?.remarks || "" };
  });
}
const stageText = (entry) => {
  if (!entry) return { status: "Not generated", role: null };
  if (num(entry.approvalStatus) === 3) return { status: "Approved", role: finalApproverOf(entry) };
  const r = pendingRoleOf(entry);
  return { status: r ? `Pending at ${ROLE_LABEL[r]}` : "Pending", role: r };
};

// distinct landlords on a site (master id, else sub-document id)
const addLandlords = (set, media) => (media.landOwners || []).forEach((o) => set.add(String(o.landOwnerMasterId || o._id)));

// ── Rental section: cards + donut ────────────────────────────
function computeRental(docs, range, filters) {
  const gdocs = applyGst(docs, filters.gst);
  const targetRole = filters.loginRole || null; // Login = Rental Master "View for" role
  let curMonth = null;
  const faceFilter = (entry) => inWindow(range, entry, curMonth.year, curMonth.month) && matchStatus(entry, targetRole, filters.status);
  const roleLL = { 1: { p: new Set(), a: new Set() }, 2: { p: new Set(), a: new Set() }, 3: { p: new Set(), a: new Set() } }; // distinct landlords behind each role card
  const roleStats = { 1: { p: [0, 0], a: [0, 0] }, 2: { p: [0, 0], a: [0, 0] }, 3: { p: [0, 0], a: [0, 0] } }; // Rental Master per-role Pending / Approved cards
  const sum = { due: [0, 0], approved: [0, 0], overdue: [0, 0], gst: 0, tds: 0, hold: [0, 0] };
  const gstSites = new Set(), tdsSites = new Set();
  const LL = { due: new Set(), approved: new Set(), overdue: new Set(), gst: new Set(), tds: new Set(), hold: new Set() }; // distinct landlords per card
  const drill = { 1: { pending: new Set(), approved: new Set() }, 2: { pending: new Set(), approved: new Set() }, 3: { pending: new Set(), approved: new Set() } }; // site ids per donut bucket
  const bucket = () => ({ pending: { count: 0, amount: 0, ll: new Set() }, approved: { count: 0, amount: 0, ll: new Set() } });
  const donut = { 1: bucket(), 2: bucket(), 3: bucket() };

  range.months.forEach(({ year, month }, idx) => {
    curMonth = { year, month };
    const st = computeRentalDueStats(gdocs, {
      year, month, targetRole, faceFilter,
      onFace: ({ media, entry, amount, cycle, state, past }) => {
        if (past) { addLandlords(LL.overdue, media); return; } // past-month overdue face: only the overdue landlords
        addLandlords(LL.due, media);
        if (state === "approved") addLandlords(LL.approved, media);
        if (state === "overdue") addLandlords(LL.overdue, media);
        const faceCount = (media.mediaDetails || []).filter((d) => num(d.status) === 1).length || 1;
        const gstFace = num(cycle.currentMonthGstAmount) / faceCount;
        const tdsFace = (media.landOwners || []).reduce((t, o) => t + (num(o.tdsApplicable) ? num(o.tdsAmount) : 0), 0) / faceCount;
        sum.gst += gstFace;
        sum.tds += tdsFace;
        if (gstFace > 0) { gstSites.add(String(media._id)); addLandlords(LL.gst, media); } // distinct sites / landlords, never rows
        if (tdsFace > 0) { tdsSites.add(String(media._id)); addLandlords(LL.tds, media); }
        // hold = existing marker (entry.withGst === 1 or owner.gstHold === 1), see buildLandOwnerObject
        const hold = num(entry?.withGst) === 1 || (media.landOwners || []).some((o) => num(o.gstHold) === 1);
        if (hold && gstFace > 0) { sum.hold[0] += 1; sum.hold[1] += gstFace; addLandlords(LL.hold, media); }
        // donut: each face counted once — approved under its final approver, otherwise pending at its single open stage
        if (num(entry?.approvalStatus) === 3) {
          const r = finalApproverOf(entry);
          if (r) { donut[r].approved.count += 1; donut[r].approved.amount += amount; addLandlords(donut[r].approved.ll, media); drill[r].approved.add(String(media._id)); }
        } else {
          const r = pendingRoleOf(entry);
          if (r) { donut[r].pending.count += 1; donut[r].pending.amount += amount; addLandlords(donut[r].pending.ll, media); drill[r].pending.add(String(media._id)); }
        }
      },
    });
    // SAME shared rule Rental Master uses for "View for <role>": computeRentalDueStats(..., targetRole)
    for (const r of [1, 2, 3]) {
      const sr = computeRentalDueStats(gdocs, {
        year, month, targetRole: r, faceFilter: (e) => inWindow(range, e, year, month),
        onFace: ({ media, state, past }) => {
          if (past) return;
          const set = state === "approved" ? roleLL[r].a : state === "pending" || state === "overdue" ? roleLL[r].p : null;
          if (set) addLandlords(set, media);
        },
      });
      roleStats[r].p[0] += sr.pendingCount; roleStats[r].p[1] += sr.pendingAmountTotal;
      roleStats[r].a[0] += sr.approvedCount; roleStats[r].a[1] += sr.approvedAmountTotal;
    }
    sum.due[0] += st.dueThisMonthCount; sum.due[1] += st.dueThisMonthAmount;
    sum.approved[0] += st.approvedCount; sum.approved[1] += st.approvedAmountTotal;
    // overdue is cumulative (current + past months): take it from the last month of the range
    if (idx === range.months.length - 1) { sum.overdue = [st.overdueCount, st.overdueAmountTotal]; }
  });

  // approval filter narrows the donut to the chosen role

  // Overdue Sites on the donut: independent of ALL dashboard filters (today's month, all docs)
  const n = nowIST();
  const un = computeRentalDueStats(docs, { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1 });

  const r0 = (x) => Math.round(x);
  const roleOut = (r) => ({
    role: r, label: ROLE_LABEL[r],
    pending: { count: roleStats[r].p[0], landlords: roleLL[r].p.size, amount: r0(roleStats[r].p[1]) },
    approved: { count: roleStats[r].a[0], landlords: roleLL[r].a.size, amount: r0(roleStats[r].a[1]) },
  });
  return {
    drill: Object.fromEntries([1, 2, 3].map((r) => [r, { pending: [...drill[r].pending], approved: [...drill[r].approved] }])),
    cards: {
      due: { landlords: LL.due.size, sites: sum.due[0], amount: r0(sum.due[1]) },
      gst: { landlords: LL.gst.size, amount: r0(sum.gst), sites: gstSites.size },
      tds: { landlords: LL.tds.size, amount: r0(sum.tds), sites: tdsSites.size },
      overdue: { landlords: LL.overdue.size, sites: sum.overdue[0], amount: r0(sum.overdue[1]) },
      approved: { landlords: LL.approved.size, sites: sum.approved[0], amount: r0(sum.approved[1]) },
      gstHold: { landlords: LL.hold.size, sites: sum.hold[0], amount: r0(sum.hold[1]) },
    },
    donut: {
      dueThisMonth: { sites: sum.due[0], amount: r0(sum.due[1]) },
      roles: [1, 2, 3].map(roleOut),
      overdue: { sites: un.overdueCount, amount: r0(un.overdueAmountTotal), unfiltered: true },
    },
  };
}

// ── Ledger entries per site, de-duplicated (each saved entry is mirrored into ledger + ledgerHistory) ──
function entriesByLabel(d) {
  const m = new Map(), seen = new Set();
  const push = (label, e) => {
    const k = entryKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    const key = String(label || "").trim().toLowerCase();
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(e);
  };
  // only completed (status 1), real (non-virtual), non-UTR-marker entries count as payments
  for (const e of d.ledger || []) if (num(e.status) === 1 && !e.isVirtual && !e.isUtrEntry && e.paymentMode && num(e.amount) > 0) push(e.month || e.dueMonth, e);
  for (const y of d.ledgerHistory || []) for (const mo of y.months || []) for (const e of mo.entries || []) if (!e.isUtrEntry && e.paymentMode && num(e.amount) > 0) push(`${mo.month} ${y.year}`, e);
  return m;
}
const sumAmt = (arr) => arr.reduce((t, e) => t + num(e.amount), 0);
const gstPaidRecords = (d, label) => (d.gstBalanceHistory || []).filter((g) => g.isPaid && String(g.dueMonth || "").toLowerCase() === label.toLowerCase());

/** One approved site-cycle obligation: what the ledger expects vs what is entered (rent / GST kept apart). */
function obligation(d, year, month, byLabel) {
  const label = labelOf(year, month);
  const due = (d.rentalDue || []).find((e) => e.dueMonth === label && num(e.approvalStatus) === 3);
  if (!due) return null;
  const cyc = getOverallSummaryForCycle(d, { year, month });
  const rent = num(cyc.currentMonthRentalAmount), gstA = num(cyc.currentMonthGstAmount);
  if (rent + gstA <= 0) return null;
  const gstInLedger = num(due.withGst) === 2; // existing ledger rule: entry amount already includes GST
  const ents = byLabel.get(label.toLowerCase()) || [];
  const gstRecs = gstInLedger ? [] : gstPaidRecords(d, label);
  return {
    label, ents, gstRecs, gstInLedger,
    expectedRent: gstInLedger ? rent + gstA : rent, expectedGst: gstInLedger ? 0 : gstA,
    enteredRent: sumAmt(ents), enteredGst: gstRecs.reduce((t, g) => t + num(g.paidAmount || g.gstAmount), 0),
    owners: (d.landOwners || []).length || 1, rent, gstA,
  };
}
const cycleInMonth = (d, year, month) => getAllDueCycles(d, { year, month }).some((c) => c.getUTCFullYear() === year && c.getUTCMonth() === month - 1);

// ── Disbursement: Total payable / Paid / Pending per payment mode ──
// Total = approved obligations in the period split by owner & mode; Paid = completed ledger entries (+ GST remitted
// separately); Pending = what is still unpaid per owner/mode (an over-payment never reduces another obligation).
function computeDisbursement(docs, range, gst) {
  const out = { Online: { total: 0, paid: 0, pending: 0 }, Cash: { total: 0, paid: 0, pending: 0 } };
  for (const d of applyGst(docs, gst)) {
    if (!(d.mediaDetails || []).some((f) => num(f.status) === 1)) continue;
    const byLabel = entriesByLabel(d);
    for (const { year, month } of range.months) {
      if (!cycleInMonth(d, year, month)) continue;
      const ob = obligation(d, year, month, byLabel);
      if (!ob) continue;
      const owners = d.landOwners || [];
      for (const o of owners) {
        const ids = new Set([String(o._id || ""), String(o.landOwnerMasterId || "")].filter(Boolean));
        const modes = getRequiredModesShared(num(o.paymentCategory) || 1).map((m) => (m === "Cash" ? "Cash" : "Online"));
        const gstShare = ob.gstA / ob.owners;
        modes.forEach((mode, i) => {
          let expected = mode === "Cash" ? num(o.cashAmount || o.shareAmount) : num(o.onlineAmount || o.shareAmount);
          const carriesGst = mode === "Online" || (i === 0 && !modes.includes("Online")); // GST travels with the online (else first) mode
          if (carriesGst) expected += gstShare; // GST is part of the payable (inside the entry, or remitted separately)
          let paid = sumAmt(ob.ents.filter((e) => e.paymentMode === mode && ids.has(String(e.landOwnerId))));
          if (carriesGst && !ob.gstInLedger) paid += ob.enteredGst / ob.owners;
          if (expected <= 0) return;
          out[mode].total += expected; out[mode].paid += Math.min(paid, expected + Math.max(paid - expected, 0)); // paid is real money, even if above total
          out[mode].pending += Math.max(expected - paid, 0);
        });
      }
    }
  }
  const r = Math.round;
  const fmt = (x) => ({ total: r(x.total), paid: r(x.paid), pending: r(x.pending) });
  return { online: fmt(out.Online), offline: fmt(out.Cash) };
}

/** Ledger Entries cards = the Ledger screen's own summary (calculateOverallLedgerSummary): same amounts, same site counts. */
function computeLedgerEntries(docs, range, gst) {
  const list = applyGst(docs, gst);
  const ym = { month: range.first.month, year: range.first.year };
  const s = calculateOverallLedgerSummary(list, ym);
  // landlords behind each card: distinct landlords of the sites whose own ledger summary has that value (same rule as the totals)
  const ll = { rp: new Set(), gp: new Set(), rpend: new Set(), gpend: new Set(), prp: new Set(), pgp: new Set() };
  for (const d of list) {
    if (!(d.mediaDetails || []).some((f) => num(f.status) === 1)) continue;
    const m = getOverallSummaryForCycle(d, ym);
    if (num(m.currentMonthRentPaid) > 0) addLandlords(ll.rp, d);
    if (num(m.currentMonthGstPaid) > 0) addLandlords(ll.gp, d);
    if (num(m.currentMonthRentPending) > 0) addLandlords(ll.rpend, d);
    if (num(m.currentMonthGstPending) > 0) addLandlords(ll.gpend, d);
    if (num(m.pastRentPending) > 0) addLandlords(ll.prp, d);
    if (num(m.pastGstPending) > 0) addLandlords(ll.pgp, d);
  }
  const c = (amount, set, sites) => ({ count: set.size, sites: num(sites), amount: Math.round(num(amount)) });
  const both = new Set([...ll.rp, ...ll.gp]);
  return {
    total: c(num(s.currentMonthRentPaid) + num(s.currentMonthGstPaid), both, num(s.currentMonthRentPaidSites) + num(s.currentMonthGstPaidSites)),
    rent: c(s.currentMonthRentPaid, ll.rp, s.currentMonthRentPaidSites),
    gst: c(s.currentMonthGstPaid, ll.gp, s.currentMonthGstPaidSites),
    rentPending: c(s.currentMonthRentPending, ll.rpend, s.currentMonthRentPendingSites),
    gstPending: c(s.currentMonthGstPending, ll.gpend, s.currentMonthGstPendingSites),
    pastRentPending: c(s.pastRentPending, ll.prp, s.pastRentPendingSites),
    pastGstPending: c(s.pastGstPending, ll.pgp, s.pastGstPendingSites),
  };
}

// ── Ledger Entries summary cards ──
function computeLedgerEntriesObligations(docs, range, gst) { // superseded by computeLedgerEntries (ledger module summary)
  const z = () => ({ count: 0, amount: 0 });
  const o = { total: z(), rent: z(), gst: z(), rentPending: z(), gstPending: z(), pastRentPending: z(), pastGstPending: z() };
  const firstKey = range.first.year * 12 + range.first.month - 1;
  for (const d of applyGst(docs, gst)) {
    if (!(d.mediaDetails || []).some((f) => num(f.status) === 1)) continue;
    const byLabel = entriesByLabel(d);
    // posted entries in the period (rent ledger entries + GST remitted records)
    for (const { year, month } of range.months) {
      const label = labelOf(year, month);
      const ents = byLabel.get(label.toLowerCase()) || [];
      o.rent.count += ents.length; o.rent.amount += sumAmt(ents);
      const g = gstPaidRecords(d, label);
      o.gst.count += g.length; o.gst.amount += g.reduce((t, x) => t + num(x.paidAmount || x.gstAmount), 0);
      if (cycleInMonth(d, year, month)) {
        const ob = obligation(d, year, month, byLabel);
        if (ob) {
          const pr = ob.expectedRent - ob.enteredRent, pg = ob.expectedGst - ob.enteredGst;
          if (pr > 1) { o.rentPending.count += 1; o.rentPending.amount += pr; }
          if (pg > 1) { o.gstPending.count += 1; o.gstPending.amount += pg; }
        }
      }
    }
    // obligations of earlier periods still unpaid
    for (const c of getAllDueCycles(d, { year: range.first.year, month: range.first.month })) {
      const y = c.getUTCFullYear(), m = c.getUTCMonth() + 1;
      if (y * 12 + m - 1 >= firstKey) continue;
      const ob = obligation(d, y, m, byLabel);
      if (!ob) continue;
      const pr = ob.expectedRent - ob.enteredRent, pg = ob.expectedGst - ob.enteredGst;
      if (pr > 1) { o.pastRentPending.count += 1; o.pastRentPending.amount += pr; }
      if (pg > 1) { o.pastGstPending.count += 1; o.pastGstPending.amount += pg; }
    }
  }
  o.total = { count: o.rent.count + o.gst.count, amount: o.rent.amount + o.gst.amount };
  const r = Math.round;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { count: v.count, amount: r(v.amount) }]));
}

// ── Ledger mismatch ──────────────────────────────────────────
// Per approved site-cycle obligation: Expected = approved payable (cycle rent + GST, same figure as the
// "Approved"/"Due" cards); Actual = SUM of all valid ledger entries for that site + month (real, approved,
// non-virtual, non-UTR; active + archived, de-duplicated by _id) + GST remitted separately for withGst=1 cycles.
// Rent share already includes TDS in the ledger module, so no TDS adjustment. Mismatch = Expected − Actual.
function classifyMismatch(expected, actual) {
  const diff = Math.round(actual - expected);
  if (Math.abs(diff) <= 1) return null; // exact match (₹1 rounding tolerance)
  if (actual <= 0) return "missing";
  return diff < 0 ? "short" : "excess";
}
const MISMATCH_LABEL = { missing: "No ledger entry", short: "Short ledger entry", excess: "Excess ledger entry" };

function computeLedgerMismatch(docs, range, gst) {
  const rows = [];
  for (const d of applyGst(docs, gst)) {
    const faces = (d.mediaDetails || []).filter((x) => num(x.status) === 1);
    if (!faces.length) continue;
    for (const { year, month } of range.months) {
      const label = labelOf(year, month);
      const cycleHit = getAllDueCycles(d, { year, month }).some((c) => c.getUTCFullYear() === year && c.getUTCMonth() === month - 1);
      if (!cycleHit) continue;
      const dues = (d.rentalDue || []).filter((e) => e.dueMonth === label);
      const approvedDue = dues.find((e) => num(e.approvalStatus) === 3);
      if (!approvedDue) continue; // no approved obligation → nothing to reconcile
      const cyc = getOverallSummaryForCycle(d, { year, month });
      const expected = num(cyc.currentMonthRentalAmount) + num(cyc.currentMonthGstAmount);
      if (expected <= 0) continue;

      const seen = new Set();
      let actual = 0, count = 0;
      const take = (e) => { if (seen.has(entryKey(e))) return; seen.add(entryKey(e)); actual += num(e.amount); count += 1; };
      for (const e of d.ledger || []) {
        if (num(e.status) === 1 && !e.isVirtual && !e.isUtrEntry && e.paymentMode && String(e.month || e.dueMonth || "").trim().toLowerCase() === label.toLowerCase()) take(e);
      }
      const yb = (d.ledgerHistory || []).find((y) => String(y.year) === String(year));
      const mb = yb?.months?.find((x) => String(x.month).toLowerCase() === MONTH_NAMES[month - 1].toLowerCase());
      for (const e of mb?.entries || []) if (!e.isUtrEntry && e.paymentMode) take(e);
      if (num(approvedDue.withGst) === 1) { // GST settled outside the ledger entries for this cycle type
        for (const g of d.gstBalanceHistory || []) if (g.isPaid && g.dueMonth === label) actual += num(g.paidAmount || g.gstAmount);
      }

      const type = classifyMismatch(expected, actual);
      if (!type) continue;
      rows.push({
        mediaId: String(d._id), siteCode: faces.map((f) => f.mediaCode).join(" / "), siteName: faces.map((f) => f.mediaName).join(", "),
        landOwner: (d.landOwners || []).map((o) => o.name).filter(Boolean).join(", "), month: label,
        approvedAmount: Math.round(expected), ledgerAmount: Math.round(actual), difference: Math.round(actual - expected),
        gstAmount: Math.round(num(cyc.currentMonthGstAmount)), entries: count, type, status: MISMATCH_LABEL[type],
        approvedBy: approvedDue.approvalSteps?.filter((s) => num(s.status) === 2).map((s) => ROLE_LABEL[s.role]).pop() || "",
      });
    }
  }
  const agg = (t) => {
    const r = rows.filter((x) => !t || x.type === t);
    return { amount: r.reduce((a, x) => a + Math.abs(x.difference), 0), sites: new Set(r.map((x) => x.mediaId)).size, count: r.length };
  };
  return { summary: { total: agg(), missing: agg("missing"), short: agg("short"), excess: agg("excess") }, rows };
}

// ── Recent activity: normalized workflow events from approval, verification, campaign, ledger and GST history ──
function computeActivity(docs, limit = 20) {
  const ev = [];
  for (const d of docs) {
    const faces = d.mediaDetails || [];
    const base = {
      mediaId: String(d._id), siteName: faces.map((f) => f.mediaName).filter(Boolean).join(", "), siteCode: faces.map((f) => f.mediaCode).filter(Boolean).join(" / "),
      landlordName: (d.landOwners || []).map((o) => o.name).filter(Boolean).join(", "),
      sites: faces.map((f) => ({ mediaName: f.mediaName, mediaCode: f.mediaCode, mediaType: f.mediaType, city: f.city, state: f.state, location: f.location, width: f.width, height: f.height, totalSqFt: f.totalSqFt })),
      landlords: (d.landOwners || []).map((o) => ({
        name: o.name || "", splitType: num(o.typeShare) === 2 ? "amount" : "percentage",
        splitValue: num(o.typeShare) === 2 ? num(o.shareAmount) : num(o.sharePercentage), allocated: Math.round(num(o.shareAmount)),
        paymentMode: getRequiredModesShared(num(o.paymentCategory) || 1).map((m) => (m === "Cash" ? "Cash" : "Online")).join(" + "),
      })),
    };
    const modeOf = (name) => {
      const o = (d.landOwners || []).find((x) => x.name === name) || (d.landOwners || [])[0];
      return o ? [...new Set(getRequiredModesShared(num(o.paymentCategory) || 1).map((m) => (m === "Cash" ? "Cash" : "Online")))].join(" + ") : "";
    };
    const push = (e) => ev.push({ ...base, paymentMode: modeOf(e.landlordName), ...e, landlordName: e.landlordName || base.landlordName });
    for (const e of d.rentalDue || []) {
      for (const s of e.approvalSteps || []) {
        if (num(s.status) === 2 && s.approvedAt) push({ activityType: "approval", action: `${ROLE_LABEL[s.role]} Approved`, status: "Approved", actorName: s.userName || "", actorRole: ROLE_LABEL[s.role] || "", occurredAt: s.approvedAt, dueMonth: e.dueMonth, ctx: { label: "Stage", value: ROLE_LABEL[s.role] || "", sub: "Approved" }, sentence: `${s.userName || "User"} (${ROLE_LABEL[s.role]}) approved the rental for ${e.dueMonth}.` });
      }
    }
    for (const v of d.agreementDocVerification || []) {
      if (!v.verifiedAt) continue;
      const role = ROLE_LABEL[v.verifiedByRole] || "";
      push({ activityType: "verification", ctx: { label: "Agreement", value: v.isVerified ? "Verified" : "Reverted" }, action: v.isVerified ? "Agreement Verified" : "Verification Reverted", status: v.isVerified ? "Verified" : "Reverted", actorName: v.verifiedBy || "", actorRole: role, occurredAt: v.verifiedAt, dueMonth: v.dueMonth || null,
        sentence: `${v.verifiedBy || "User"}${role ? ` (${role})` : ""} ${v.isVerified ? "verified" : "reverted the verification of"} the agreement.` });
    }
    for (const y of d.rentalDueHistory || []) for (const m of y.months || []) {
      const byDue = new Map();
      for (const h of m.entries || []) { const k = String(h.rentalDueId); if (!byDue.has(k)) byDue.set(k, []); byDue.get(k).push(h); }
      for (const list of byDue.values()) {
        let prev = null;
        for (const h of list.sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0))) {
          const by = h.updatedBy || h.savedBy || "";
          if (/^system/i.test(by) || (!h.campaignName && !h.reason) || !h.updatedAt) continue;
          if (prev && prev.campaignName === h.campaignName && prev.reason === h.reason && (prev.updatedBy || prev.savedBy) === by) continue;
          push({ activityType: "campaign", action: prev ? "Campaign Details Updated" : "Campaign Details Added", status: prev ? "Updated" : "Added", actorName: by, actorRole: ROLE_LABEL[h.savedByRole] || "", occurredAt: h.updatedAt, dueMonth: `${m.month} ${y.year}`,
            campaignName: h.campaignName || "", reason: h.reason || "", ctx: { label: "Campaign", value: `${m.month} ${y.year}`, sub: h.campaignName || "" },
            sentence: prev && prev.campaignName !== h.campaignName ? `${by} updated the campaign from “${prev.campaignName}” to “${h.campaignName}”.` : `${by} ${prev ? "updated" : "added"} the campaign details.` });
          prev = h;
        }
      }
    }
    const seen = new Set();
    const ledgerEntries = [...(d.ledger || []).filter((l) => num(l.status) === 1 && !l.isVirtual && !l.isUtrEntry),
      ...(d.ledgerHistory || []).flatMap((y) => (y.months || []).flatMap((mo) => (mo.entries || []).filter((l) => !l.isUtrEntry).map((l) => ({ ...l, month: l.month || `${mo.month} ${y.year}` }))))];
    for (const l of ledgerEntries) {
      const k = entryKey(l);
      if (seen.has(k) || !l.paymentMode || num(l.amount) <= 0) continue;
      seen.add(k);
      const at = l.updatedAt || l.date;
      if (at) push({ activityType: "ledger", action: "Rent Ledger Entry Added", status: "Ledger", actorName: l.updatedBy || "", actorRole: "", occurredAt: at, dueMonth: l.month, landlordName: l.landOwnerName || "", paymentMode: l.paymentMode, amount: num(l.amount), entryType: "Rent", ctx: { label: "Ledger", value: "Rent", amount: num(l.amount) },
        sentence: `${l.updatedBy || "User"} added a Rent ledger entry of ₹${num(l.amount).toLocaleString("en-IN")}.` });
    }
    for (const g of d.gstBalanceHistory || []) {
      if (g.isPaid && g.paidAt) push({ activityType: "ledger", action: "GST Ledger Entry Added", status: "Ledger", actorName: g.paidBy || "", actorRole: "", occurredAt: g.paidAt, dueMonth: g.dueMonth, amount: num(g.paidAmount || g.gstAmount), entryType: "GST", ctx: { label: "GST", value: "Ledger", amount: num(g.paidAmount || g.gstAmount) }, sentence: `${g.paidBy || "User"} recorded the GST payment.` });
    }
  }
  const seenEv = new Set();
  const uniq = ev.filter((x) => {
    const k = [x.mediaId, x.action, x.actorName, x.dueMonth, x.landlordName || "", x.campaignName || "", x.amount || "", Math.floor(new Date(x.occurredAt).getTime() / 1000)].join("|");
    if (seenEv.has(k)) return false;
    seenEv.add(k);
    return true;
  });
  // campaign details are mandatory before approval → show them inside the approval they belong to (same site, month, actor, within 5 min)
  const merged = new Set();
  for (const ap of uniq.filter((x) => x.activityType === "approval")) {
    const t = new Date(ap.occurredAt).getTime();
    const cs = uniq.filter((c) => c.activityType === "campaign" && c.mediaId === ap.mediaId && c.dueMonth === ap.dueMonth && c.actorName === ap.actorName && Math.abs(new Date(c.occurredAt).getTime() - t) <= 5 * 60000);
    if (cs.length) {
      ap.ctx = { ...ap.ctx, extra: `Campaign: ${[...new Set(cs.map((c) => c.campaignName).filter(Boolean))].join(", ")}` };
      cs.forEach((c) => merged.add(c));
    }
  }
  return uniq.filter((x) => x.occurredAt && !merged.has(x)).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)).slice(0, Math.min(Math.max(num(limit), 1), 100));
}

// ── Rental details table rows (one per site document per month) ──
function buildRentalRows(docs, range, filters, remarksByDue = new Map()) {
  const rows = [];
  // Login = role R → only rentals that role R has approved (its own actions)
  const lf = filters.loginRole ? (e) => (e?.approvalSteps || []).some((st) => st.role === filters.loginRole && num(st.status) === 2) : null;
  for (const d of applyGst(docs, filters.gst)) {
    const faces = (d.mediaDetails || []).filter((x) => num(x.status) === 1);
    if (!faces.length) continue;
    for (const { year, month } of range.months) {
      const cyc = getOverallSummaryForCycle(d, { year, month });
      const rent = num(cyc.currentMonthRentalAmount), gstAmt = num(cyc.currentMonthGstAmount);
      if (rent + gstAmt <= 0) continue;
      const label = labelOf(year, month);
      const entries = (d.rentalDue || []).filter((e) => e.dueMonth === label)
        .sort((a, b) => (num(b.approvalStatus) === 3) - (num(a.approvalStatus) === 3) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const entry = entries[0];
      if (!inWindow(range, entry, year, month)) continue;
      if (filters.status !== "all") { if (!matchStatus(entry, filters.loginRole, filters.status)) continue; }
      else if (lf && !lf(entry)) continue; // Login only: rentals this role has approved
      const stage = stageText(entry);
      const tds = (d.landOwners || []).reduce((t, o) => t + (num(o.tdsApplicable) ? num(o.tdsAmount) : 0), 0);
      const modes = [...new Set((d.landOwners || []).flatMap((o) => getRequiredModesShared(num(o.paymentCategory) || 1)))];
      // every verification event for this cycle (history is never overwritten), oldest first
      const verEvents = (d.agreementDocVerification || [])
        .filter((v) => v.isVerified && v.verifiedAt && ((entry && String(v.rentalDueId) === String(entry._id)) || v.dueMonth === label))
        .sort((x, y) => new Date(x.verifiedAt) - new Date(y.verifiedAt))
        .map((v) => ({ role: ROLE_LABEL[v.verifiedByRole] || "", by: v.verifiedBy || "", at: v.verifiedAt, action: "Verified" }));
      const verifiedFlag = verEvents.length > 0 || !!entry?.agreementDocVerified;
      // campaign revisions from rentalDueHistory (one record per save), humans only, consecutive duplicates collapsed
      const revisions = [];
      if (entry) {
        const yb = (d.rentalDueHistory || []).find((y) => String(y.year) === String(year));
        const mb = yb?.months?.find((m) => String(m.month).toLowerCase() === MONTH_NAMES[month - 1].toLowerCase());
        for (const h of (mb?.entries || []).filter((x) => String(x.rentalDueId) === String(entry._id)).sort((x, y) => new Date(x.updatedAt || 0) - new Date(y.updatedAt || 0))) {
          const by = h.updatedBy || h.savedBy || "";
          if (/^system/i.test(by) || (!h.campaignName && !h.reason)) continue;
          const last = revisions[revisions.length - 1];
          if (last && last.name === (h.campaignName || "") && last.reason === (h.reason || "") && last.by === by) continue;
          revisions.push({ name: h.campaignName || "", reason: h.reason || "", by, role: ROLE_LABEL[h.savedByRole] || "", at: h.updatedAt || null });
        }
      }
      const hold = num(entry?.withGst) === 1 || (d.landOwners || []).some((o) => num(o.gstHold) === 1);
      rows.push({
        id: `${d._id}_${year}-${month}`, mediaId: String(d._id), month: label, dueDate: entry?.dueDate || null,
        sites: faces.map((f) => ({ mediaName: f.mediaName, mediaCode: f.mediaCode, mediaType: f.mediaType, city: f.city, state: f.state, location: f.location, width: f.width, height: f.height, totalSqFt: f.totalSqFt })),
        landlords: (d.landOwners || []).map((o) => ({
          name: o.name || "", splitType: num(o.typeShare) === 2 ? "amount" : "percentage",
          splitValue: num(o.typeShare) === 2 ? num(o.shareAmount) : num(o.sharePercentage), shareAmount: num(o.shareAmount),
          allocated: Math.round(num(o.shareAmount) > 0 ? num(o.shareAmount) : (rent * num(o.sharePercentage)) / 100),
          paymentMode: getRequiredModesShared(num(o.paymentCategory) || 1).map((m) => (m === "Cash" ? "Cash" : "Online")).join(" + "),
        })),
        paymentModes: modes.map((m) => (m === "Online" ? "Online" : "Cash")),
        rentWithTds: Math.round(rent), tds: Math.round(tds), baseRent: Math.round(rent - tds),
        gstApplicable: gstAmt > 0, gstAmount: Math.round(gstAmt), gstHold: hold,
        totalAmount: Math.round(rent + gstAmt),
        remarks: (entry && (remarksByDue.get(String(entry._id)) || (/^auto-generated/i.test(entry.remarks || "") ? "" : entry.remarks))) || "",
        verification: { verified: verifiedFlag, events: verEvents },
        campaign: entry ? { revisions, name: entry.campaignName || "", reason: entry.reason || "", by: entry.savedBy?.userName || "", role: ROLE_LABEL[entry.savedBy?.role] || "", at: entry.proofOfCampaign?.uploadedAt || entry.invoice?.uploadedAt || entry.savedBy?.savedAt || null, proof: entry.proofOfCampaign?.filePath ? entry.proofOfCampaign : null, invoice: entry.invoice?.filePath ? entry.invoice : null } : null,
        approval: {
          status: stage.status, approved: num(entry?.approvalStatus) === 3,
          steps: approvalFlow(entry),
          savedBy: entry?.savedBy ? { by: entry.savedBy.userName, role: ROLE_LABEL[entry.savedBy.role], at: entry.savedBy.savedAt } : null,
        },
      });
    }
  }
  return rows;
}

const SORTERS = {
  totalAmount: (r) => r.totalAmount, rent: (r) => r.rentWithTds, gst: (r) => r.gstAmount,
  site: (r) => (r.sites[0]?.mediaName || "").toLowerCase(), landlord: (r) => (r.landlords[0]?.name || "").toLowerCase(),
  month: (r) => new Date(r.dueDate || 0).getTime(), status: (r) => r.approval.status,
};

function searchSortPage(rows, { search, sortBy, sortDir, page, limit }) {
  let out = rows;
  const q = String(search || "").trim().toLowerCase();
  if (q) {
    out = out.filter((r) => [
      ...r.sites.flatMap((s) => [s.mediaName, s.mediaCode, s.city, s.location, s.mediaType]),
      ...r.landlords.map((l) => l.name), r.month, r.remarks, r.campaign?.name, r.campaign?.reason, r.approval.status,
    ].some((v) => String(v || "").toLowerCase().includes(q)));
  }
  const key = SORTERS[sortBy] || SORTERS.month;
  const dir = sortDir === "asc" ? 1 : -1;
  out = [...out].sort((a, b) => (key(a) > key(b) ? dir : key(a) < key(b) ? -dir : 0));
  const size = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  return { data: out.slice((p - 1) * size, p * size), pagination: { page: p, limit: size, totalCount: out.length, totalPages: Math.ceil(out.length / size) } };
}

module.exports = { parseFilters, applyGst, computeRental, computeDisbursement, computeLedgerMismatch, classifyMismatch, computeActivity, pendingRoleOf, finalApproverOf, approvalFlow, computeLedgerEntries, buildRentalRows, searchSortPage, ROLE_LABEL };
