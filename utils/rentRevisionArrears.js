// ─────────────────────────────────────────────────────────────
// ✅ NEW — Rent revision arrears (POST /admin/rent-revision)
//
// A rent revision changes the site rent from a past month (fromMonth):
//   • months from fromMonth whose bill is already CMD approved keep the
//     approved rent (rentalPayment.rentRevisionKeptMonths) and the
//     difference becomes a separate arrears bill (media.arrearsDue[])
//   • pending bills from fromMonth are updated to the new rent
//   • the site rent becomes the new rent from fromMonth
//     (rentalAmountHistory row with effectiveFrom = fromMonth)
// Arrears bills are paid separately through POST /admin/ledger-save with
// the arrears bill's id as rentalDueId, and are shown in ledger-list.
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const { getRentForDueDate, mediaAsOfDate, rentPartsForDueDate, advanceDeductionFor } = require("./appraisalRent");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const toPlain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

const monthKey = (input) => {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

const monthLabelOfKey = (key) => `${MONTHS[key % 12]} ${Math.floor(key / 12)}`;

// "August 2026" / "Aug 2026" / "2026-08" / a date → 1st of that month (UTC); null if invalid
function parseFromMonth(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return new Date(Date.UTC(Number(m[1]), month - 1, 1));
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    let idx = MONTHS.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
    // ✅ NEW — small spelling mistake ("Aguest", "Septmber") → the closest month
    if (idx < 0) idx = closestMonthIndex(m[1]);
    if (idx < 0) return null;
    return new Date(Date.UTC(Number(m[2]), idx, 1));
  }
  return null;
}

// ✅ NEW — month name with at most 2 letter mistakes (a swap of two letters
// counts as one) → that month's index; -1 when none or more than one is that close
function closestMonthIndex(word) {
  const w = String(word || "").toLowerCase();
  if (w.length < 3) return -1;
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  const scored = MONTHS.map((n, i) => ({ i, dist: distance(w, n.toLowerCase()) })).sort((a, b) => a.dist - b.dist);
  if (scored[0].dist > 2) return -1;
  if (scored[1] && scored[1].dist === scored[0].dist) return -1;
  return scored[0].i;
}

const round = (v) => Math.round(Number(v) || 0);

// GST in force for the month (owner level first, else site level) — same
// order the approval mail uses
function monthGst(monthMedia) {
  const rp = monthMedia?.rentalPayment || {};
  const ownerGst = (monthMedia?.landOwners || [])
    .filter((o) => Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0)
    .reduce((s, o) => s + Number(o.gstAmount || 0), 0);
  if (ownerGst > 0) return ownerGst;
  return Number(rp.gstApplicable) === 1 ? Number(rp.gstAmount || 0) : 0;
}

// Splits `total` by weights; the last part takes the remainder
function splitByWeights(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  let used = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return total - used;
    const part = round((total * w) / sum);
    used += part;
    return part;
  });
}

/**
 * What a revision does to the site (no DB write).
 * media: lean / plain media doc. Returns
 * { oldRent, keptMonths[], arrearsBills[], billsUpdated[], heldMonth }
 */
// ✅ CHANGED — opts.fromMonthIncrease: fromMonth is priced at its own rent +
// this amount (later months at newRent). opts.gstOnIncrease 0 → no GST on the
// fromMonth increase (its GST stays on the old rent).
// ✅ NEW — opts.monthIncreases (Map monthKey → amount, BILL "months" array):
// each listed month is priced at its own rent + its amount; months between the
// listed ones are not changed; applyToAllMonths 1 → months after the LAST
// listed month at newRent.
function buildRevisionPlan(media, fromDate, newRent, applyToAllMonths = 1, opts = {}) {
  // applyToAllMonths 0 → only fromMonth changes (site rent and later months stay)
  const onlyFromMonth = Number(applyToAllMonths) === 0 && applyToAllMonths !== null;
  const m = toPlain(media) || {};
  const rp = m.rentalPayment || {};
  const oldRent = Number(rp.totalRentalAmount || 0);
  const fromKey = monthKey(fromDate);
  const fromMonthIncrease = opts.fromMonthIncrease === undefined || opts.fromMonthIncrease === null ? null : Number(opts.fromMonthIncrease);
  const noGstOnFrom = opts.gstOnIncrease !== undefined && opts.gstOnIncrease !== null && Number(opts.gstOnIncrease) === 0;
  const monthIncreases = opts.monthIncreases instanceof Map && opts.monthIncreases.size ? opts.monthIncreases : null;
  const lastIncreaseKey = monthIncreases ? Math.max(...monthIncreases.keys()) : fromKey;
  // month with its own increase (listed month / fromMonth) → its amount, else null
  const increaseFor = (key) => {
    if (monthIncreases) return monthIncreases.has(key) ? Number(monthIncreases.get(key)) : null;
    return key === fromKey && fromMonthIncrease !== null ? fromMonthIncrease : null;
  };
  // rent the month should have after the revision (an approved advance stays deducted)
  const targetRent = (dueDate, monthRent) => {
    const key = monthKey(dueDate);
    const inc = increaseFor(key);
    if (inc !== null) return round(monthRent + inc);
    return round(newRent - advanceDeductionFor(m, key).amount);
  };
  const noGstFor = (dueDate) => noGstOnFrom && increaseFor(monthKey(dueDate)) !== null;
  const inPlan = (key) => {
    if (monthIncreases) return monthIncreases.has(key) || (!onlyFromMonth && key > lastIncreaseKey);
    return onlyFromMonth ? key === fromKey : key >= fromKey;
  };

  const bills = (m.rentalDue || [])
    .filter((b) => b && b.dueDate && inPlan(monthKey(b.dueDate)))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const heldBill = bills.find((b) => Number(b?.appraisalHold?.hold) === 1);

  const byMonth = new Map();
  bills.forEach((b) => {
    const label = b.dueMonth || monthLabelOfKey(monthKey(b.dueDate));
    if (!byMonth.has(label)) byMonth.set(label, []);
    byMonth.get(label).push(b);
  });

  const keptMonths = [];
  const arrearsBills = [];
  const billsUpdated = [];

  byMonth.forEach((monthBills, dueMonth) => {
    const dueDate = monthBills[0].dueDate;
    const { rent: monthRent, gstRent: monthGstRent } = rentPartsForDueDate(m, dueDate);
    const isApprovedMonth = monthBills.some((b) => Number(b.approvalStatus) === 3);
    const target = targetRent(dueDate, monthRent);
    const noGst = noGstFor(dueDate);

    if (isApprovedMonth) {
      // approved at monthRent → stays; difference = arrears
      keptMonths.push({ dueMonth, rent: monthRent, ...(monthGstRent !== monthRent ? { gstRent: monthGstRent } : {}) });
      const diff = round(target - monthRent);
      if (diff <= 0 || monthRent <= 0) return;

      const monthMedia = toPlain(mediaAsOfDate(m, dueDate)) || {};
      const owners = monthMedia.landOwners || [];
      // GST of the month → GST on the difference (none when the increase is without GST)
      const gstForMonth = noGst ? 0 : monthGstRent > 0 ? (monthGst(monthMedia) * monthRent) / monthGstRent : 0;
      const ratio = diff / monthRent;
      const billParts = splitByWeights(
        diff,
        monthBills.map((b) => Number(b.baseAmount || b.netPayable || 0)),
      );

      monthBills.forEach((bill, i) => {
        const amount = billParts[i];
        if (amount <= 0) return;
        const billFraction = amount / diff;
        const ownerRows = owners.map((o) => ({
          landOwnerId: o._id,
          landOwnerMasterId: o.landOwnerMasterId || null,
          landOwnerName: o.name || "",
          paymentCategory: Number(o.paymentCategory || 1),
          shareAmount: round(Number(o.shareAmount || 0) * ratio * billFraction),
          cashAmount: round(Number(o.cashAmount || 0) * ratio * billFraction),
          onlineAmount: round(Number(o.onlineAmount || 0) * ratio * billFraction),
          gstAmount: noGst ? 0 : round(Number(o.gstAmount || 0) * (monthGstRent > 0 ? diff / monthGstRent : ratio) * billFraction),
          tdsAmount: 0, // ✅ CHANGED — no TDS on arrears
          paidCash: false,
          paidOnline: false,
        }));
        arrearsBills.push({
          parentRentalDueId: bill._id,
          mediaDetailId: bill.mediaDetailId || null,
          withGst: Number(bill.withGst || 0), // same as the approved bill
          dueMonth,
          dueDate: bill.dueDate,
          oldMonthRent: monthRent,
          newRent: target,
          arrearsAmount: amount,
          gstAmount: round(gstForMonth * ratio * billFraction),
          tdsAmount: ownerRows.reduce((s, o) => s + o.tdsAmount, 0),
          cashAmount: ownerRows.reduce((s, o) => s + o.cashAmount, 0),
          onlineAmount: ownerRows.reduce((s, o) => s + o.onlineAmount, 0),
          owners: ownerRows,
        });
      });
      return;
    }

    // pending month → bills move to the new rent
    // (only this month / fromMonth increase: the month is priced at its target
    // rent, GST kept on the old rent when the increase is without GST)
    const isIncreaseMonth = increaseFor(monthKey(dueDate)) !== null;
    if (onlyFromMonth || isIncreaseMonth) {
      keptMonths.push({ dueMonth, rent: target, ...(noGst ? { gstRent: monthGstRent } : {}) });
    }
    monthBills.forEach((bill) => {
      const scale = monthRent > 0 ? target / monthRent : 1;
      const gstScale = noGst ? 1 : scale;
      const oldAmount = Number(bill.netPayable || 0);
      const gst = Number(bill.gstAmount || 0);
      const newGst = round(gst * gstScale);
      const gstInNet = Number(bill.withGst) === 2 ? gst : 0;
      billsUpdated.push({
        rentalDueId: bill._id,
        dueMonth,
        oldAmount,
        newAmount: round((oldAmount - gstInNet) * scale) + (gstInNet ? newGst : 0),
        baseAmount: round((Number(bill.baseAmount || 0) - gst) * scale) + newGst,
        gstAmount: newGst,
      });
    });
  });

  return {
    oldRent,
    keptMonths,
    arrearsBills,
    billsUpdated,
    heldMonth: heldBill ? heldBill.dueMonth || monthLabelOfKey(monthKey(heldBill.dueDate)) : null,
  };
}

// Preview / response shape of a plan
function planPreview(plan, newRent, siteRentAfter = newRent) {
  return {
    arrearsBills: plan.arrearsBills.map((b) => ({
      dueMonth: b.dueMonth,
      parentRentalDueId: b.parentRentalDueId,
      arrearsAmount: b.arrearsAmount,
      gstAmount: b.gstAmount,
      tdsAmount: b.tdsAmount,
      withGst: Number(b.withGst || 0),
    })),
    arrearsTotal: plan.arrearsBills.reduce((s, b) => s + b.arrearsAmount, 0),
    billsUpdated: plan.billsUpdated.map((b) => ({
      dueMonth: b.dueMonth,
      rentalDueId: b.rentalDueId,
      oldAmount: b.oldAmount,
      newAmount: b.newAmount,
    })),
    siteRentAfter,
  };
}

// Plan arrears bill → stored arrears bill (media.arrearsDue[])
function toArrearsBill(planBill, revisionId, userName, now) {
  return {
    _id: new mongoose.Types.ObjectId(),
    type: "arrears",
    label: `New Bill – ${planBill.dueMonth}`, // ✅ CHANGED — was "Arrears – …"
    rentRevisionId: revisionId,
    parentRentalDueId: planBill.parentRentalDueId,
    mediaDetailId: planBill.mediaDetailId,
    dueMonth: planBill.dueMonth,
    dueDate: planBill.dueDate,
    oldMonthRent: planBill.oldMonthRent,
    newRent: planBill.newRent,
    netPayable: planBill.arrearsAmount,
    baseAmount: planBill.arrearsAmount,
    gstAmount: planBill.gstAmount,
    tdsAmount: planBill.tdsAmount,
    withGst: Number(planBill.withGst || 0),
    cashAmount: planBill.cashAmount,
    onlineAmount: planBill.onlineAmount,
    owners: planBill.owners,
    approvalStatus: 3,
    status: 3,
    ownerApprovalDate: now,
    rentPaid: 0,
    gstPaid: 0,
    payments: [],
    mailSent: false,
    mailSentAt: null,
    createdBy: userName,
    createdAt: now,
    updatedAt: now,
  };
}

// ── ✅ NEW — rent revision ADVANCE ───────────────────────────
// The owner asks part of the next bill in advance (e.g. quarterly 50k bill,
// Sep generated, next Dec; 25k asked in Oct). On CMD approval an advance bill
// (media.arrearsDue[], type "advance") is created for the advance month and
// the amount is deducted from the next bill (rentalPayment.advanceAdjustments).

const FREQUENCY_MONTHS = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
const cycleMonthsOf = (rp) => {
  const f = Number(rp?.paymentFrequency || 1);
  if (f === 6) return Number(rp?.customPaymentFrequency) || 1;
  return FREQUENCY_MONTHS[f] || 1;
};

// GST % of the site for a month (0 → site has no GST)
function gstPercentageFor(media, dueDate) {
  const m = toPlain(media) || {};
  const { gstRent } = rentPartsForDueDate(m, dueDate);
  const gst = monthGst(toPlain(mediaAsOfDate(m, dueDate)) || {});
  if (gstRent <= 0 || gst <= 0) return 0;
  return Math.round((gst / gstRent) * 10000) / 100;
}

// next bill after the given month (not generated yet) → 1st of that month (UTC) or null
function nextBillDateAfter(media, afterDate) {
  const m = toPlain(media) || {};
  const rp = m.rentalPayment || {};
  const cycle = cycleMonthsOf(rp);
  const afterKey = monthKey(afterDate);
  const lastBill = (m.rentalDue || [])
    .filter((b) => b && b.dueDate)
    .sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate))[0];
  let key = null;
  if (lastBill) key = monthKey(lastBill.dueDate) + cycle;
  else if (rp.nextBillingDate) key = monthKey(rp.nextBillingDate);
  else if (rp.billingStartDate) key = monthKey(rp.billingStartDate) + cycle;
  if (key === null || afterKey === null) return null;
  let guard = 0;
  while (key <= afterKey && guard < 500) {
    key += cycle;
    guard += 1;
  }
  return new Date(Date.UTC(Math.floor(key / 12), key % 12, 1));
}

/**
 * What an advance does (no DB write). Returns { error } or
 * { adjustInDate, adjustInMonth, billRent, balanceAmount, gstPercentage,
 *   advanceGstAmount, balanceGstAmount, owners[], tdsAmount, cashAmount, onlineAmount, withGst }
 */
// ✅ NEW — a rent payment is already saved for these bills (ledger /
// ledgerHistory entry with their rentalDueId, or with their cycle month)
function billsHavePayment(media, monthBills) {
  const ids = new Set((monthBills || []).map((b) => String(b._id)));
  const key = monthBills && monthBills[0] ? monthKey(monthBills[0].dueDate) : null;
  const isPayment = (e) => {
    if (!e) return false;
    if (e.rentalDueId && ids.has(String(e.rentalDueId))) return true;
    if (e.rentalDueId) return false;
    const hasPayData = !!(String(e.utrNumber || "").trim() || e.paymentMode || Number(e.amount || 0) > 0);
    return hasPayData && key !== null && e.cycle && monthKey(e.cycle) === key;
  };
  if ((media.ledger || []).some(isPayment)) return true;
  return (media.ledgerHistory || []).some((y) => (y?.months || []).some((mo) => (mo?.entries || []).some(isPayment)));
}

// ✅ CHANGED — the bill the advance is deducted from:
//   adjustInDate given → that bill month (generated and unpaid, or a future cycle month)
//   else → first generated, unpaid bill from the advance month, else the next bill
// Returns { adjustInDate, monthBills } or { error }
function pickAdvanceBill(m, advanceDate, adjustInDate) {
  const advanceKey = monthKey(advanceDate);
  const byKey = new Map();
  (m.rentalDue || []).forEach((b) => {
    if (!b || !b.dueDate) return;
    const k = monthKey(b.dueDate);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  });
  const generatedBill = (k) => {
    const monthBills = byKey.get(k);
    const label = monthLabelOfKey(k);
    if (billsHavePayment(m, monthBills)) return { error: `${label} bill is already paid — advance not allowed` };
    // ✅ CHANGED — only a bill not CMD approved yet can take an advance
    if (monthBills.some((b) => Number(b?.approvalStatus) === 3)) {
      return { error: `${label} bill is already CMD approved — advance not allowed` };
    }
    if (monthBills.some((b) => Number(b?.appraisalHold?.hold) === 1)) {
      return { error: `${label} bill is on appraisal hold — release it first` };
    }
    return { adjustInDate: new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)), monthBills };
  };

  if (adjustInDate) {
    const k = monthKey(adjustInDate);
    if (k < advanceKey) return { error: "adjustInMonth cannot be before advanceMonth" };
    if (byKey.has(k)) return generatedBill(k);
    // not generated yet → must be one of the site's coming bill months
    const lastKey = byKey.size ? Math.max(...byKey.keys()) : null;
    const cycle = cycleMonthsOf(m.rentalPayment);
    const firstKey = lastKey !== null ? lastKey + cycle : monthKey(m.rentalPayment?.nextBillingDate);
    if (firstKey === null || k < firstKey || (k - firstKey) % cycle !== 0) {
      return { error: `${monthLabelOfKey(k)} is not a bill month of this site` };
    }
    return { adjustInDate: new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)), monthBills: [] };
  }

  const keys = [...byKey.keys()].filter((k) => k >= advanceKey).sort((a, b) => a - b);
  let firstError = null;
  for (const k of keys) {
    const r = generatedBill(k);
    if (!r.error) return r;
    if (!firstError && !/already paid|already CMD approved/.test(r.error)) firstError = r;
    if (firstError) return firstError; // on hold → stop (don't skip to a later bill)
  }
  const next = nextBillDateAfter(m, advanceDate);
  if (!next) return { error: "Next bill month not found for this site" };
  return { adjustInDate: next, monthBills: [] };
}

function buildAdvancePlan(media, advanceDate, advanceAmount, gstOnIncrease, adjustInDateReq = null) {
  const m = toPlain(media) || {};
  const pick = pickAdvanceBill(m, advanceDate, adjustInDateReq);
  if (pick.error) return { error: pick.error };
  const { adjustInDate, monthBills } = pick;
  const adjustInMonth = monthLabelOfKey(monthKey(adjustInDate));
  const billGenerated = monthBills.length > 0;

  // rent of that bill (an advance already approved for it is deducted)
  const { rent: billRent, gstRent } = rentPartsForDueDate(m, adjustInDate);
  // ✅ NEW — advances already approved for this bill (more than one allowed,
  // e.g. yearly bill: January + April advances both deducted from November)
  const previousAdvances = (m.rentalPayment?.advanceAdjustments || [])
    .filter((a) => a && a.dueMonth === adjustInMonth)
    .map((a) => {
      const b = (m.arrearsDue || []).find((x) => x && String(x._id) === String(a.advanceBillId)) || {};
      return {
        revisionId: a.rentRevisionId || null,
        advanceMonth: b.dueMonth || "",
        amount: Number(a.amount || 0),
        gstAmount: Number(a.gstDeducted) === 1 ? Number(b.gstAmount || 0) : 0,
        paymentStatus: b._id ? arrearsStatus(b) : "Pending",
      };
    });
  const previousAdvanceTotal = previousAdvances.reduce((s, a) => s + a.amount, 0);
  const previousAdvanceGst = previousAdvances.reduce((s, a) => s + a.gstAmount, 0);
  if (billRent <= 0) return { error: `${adjustInMonth} bill amount is 0 — advance not allowed` };
  if (advanceAmount > billRent) {
    return {
      error: `Advance ${advanceAmount} is more than the ${adjustInMonth} bill amount ${billRent}${previousAdvanceTotal > 0 ? ` (after earlier advances ${previousAdvanceTotal})` : ""}`,
    };
  }

  const monthMedia = toPlain(mediaAsOfDate(m, adjustInDate)) || {};
  const gstForMonth = monthGst(monthMedia);
  const siteHasGst = gstForMonth > 0;
  const withGstOnAdvance = siteHasGst && Number(gstOnIncrease) === 1;
  const ratio = advanceAmount / billRent;
  const gstRatio = gstRent > 0 ? advanceAmount / gstRent : 0;
  const owners = (monthMedia.landOwners || []).map((o) => ({
    landOwnerId: o._id,
    landOwnerMasterId: o.landOwnerMasterId || null,
    landOwnerName: o.name || "",
    paymentCategory: Number(o.paymentCategory || 1),
    shareAmount: round(Number(o.shareAmount || 0) * ratio),
    cashAmount: round(Number(o.cashAmount || 0) * ratio),
    onlineAmount: round(Number(o.onlineAmount || 0) * ratio),
    gstAmount: withGstOnAdvance ? round(Number(o.gstAmount || 0) * gstRatio) : 0,
    tdsAmount: 0, // ✅ CHANGED — no TDS on an advance
    paidCash: false,
    paidOnline: false,
  }));
  const advanceGstAmount = withGstOnAdvance ? round(gstForMonth * gstRatio) : 0;
  const fullGst = gstRent > 0 ? round((gstForMonth * billRent) / gstRent) : 0;
  // withGst of the advance bill: the adjusted bill's, else last bill's (GST
  // hold / direct), hold when unknown
  const lastWithGst = Number(
    (billGenerated
      ? monthBills[0]
      : (m.rentalDue || []).filter((b) => b && b.dueDate).sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate))[0] || {}
    ).withGst || 0,
  );
  return {
    adjustInDate,
    adjustInMonth,
    billRent,
    balanceAmount: round(billRent - advanceAmount),
    siteHasGst,
    gstPercentage: gstPercentageFor(m, adjustInDate),
    advanceGstAmount,
    balanceGstAmount: Math.max(0, round(gstForMonth - advanceGstAmount)),
    billGstAmount: fullGst,
    // ✅ NEW — earlier advances of this bill; full bill = before every advance
    previousAdvances,
    previousAdvanceTotal,
    fullBillRent: billRent + previousAdvanceTotal,
    fullBillGstAmount: fullGst + previousAdvanceGst,
    owners,
    tdsAmount: owners.reduce((s, o) => s + o.tdsAmount, 0),
    cashAmount: owners.reduce((s, o) => s + o.cashAmount, 0),
    onlineAmount: owners.reduce((s, o) => s + o.onlineAmount, 0),
    withGst: advanceGstAmount > 0 ? (lastWithGst > 0 ? lastWithGst : 1) : 0,
    // ✅ NEW — bill already generated → its amounts go down on CMD approval
    // (its approval stays as it is)
    billGenerated,
    adjustInRentalDueId: billGenerated ? monthBills[0]._id : null,
    billApprovalStatus: billGenerated ? Math.max(...monthBills.map((b) => Number(b.approvalStatus || 1))) : null,
    billsToUpdate: monthBills.map((b) => {
      const scale = (billRent - advanceAmount) / billRent;
      const gstScale = withGstOnAdvance && gstRent > 0 ? (gstRent - advanceAmount) / gstRent : 1;
      const net = Number(b.netPayable || 0);
      const gst = Number(b.gstAmount || 0);
      const newGst = round(gst * gstScale);
      const gstInNet = Number(b.withGst) === 2 ? gst : 0;
      return {
        rentalDueId: b._id,
        oldAmount: net,
        newAmount: round((net - gstInNet) * scale) + (gstInNet ? newGst : 0),
        baseAmount: round((Number(b.baseAmount || 0) - gst) * scale) + newGst,
        gstAmount: newGst,
      };
    }),
  };
}

// advance plan → stored advance bill (media.arrearsDue[], type "advance")
function toAdvanceBill(plan, { revisionId, advanceDate, advanceAmount, mediaDetailId = null }, userName, now) {
  const advanceMonth = monthLabelOfKey(monthKey(advanceDate));
  return {
    _id: new mongoose.Types.ObjectId(),
    type: "advance",
    label: `Advance — ${advanceMonth} (adjust in ${plan.adjustInMonth})`,
    rentRevisionId: revisionId,
    parentRentalDueId: null,
    mediaDetailId,
    dueMonth: advanceMonth,
    dueDate: advanceDate,
    adjustInMonth: plan.adjustInMonth,
    adjustInDate: plan.adjustInDate,
    billRent: plan.billRent,
    netPayable: advanceAmount,
    baseAmount: advanceAmount,
    gstAmount: plan.advanceGstAmount,
    tdsAmount: plan.tdsAmount,
    withGst: plan.withGst,
    cashAmount: plan.cashAmount,
    onlineAmount: plan.onlineAmount,
    owners: plan.owners,
    approvalStatus: 3,
    status: 3,
    ownerApprovalDate: now,
    rentPaid: 0,
    gstPaid: 0,
    payments: [],
    mailSent: false,
    mailSentAt: null,
    createdBy: userName,
    createdAt: now,
    updatedAt: now,
  };
}

const arrearsStatus = (bill) => {
  const rentDone = Number(bill.rentPaid || 0) >= Number(bill.netPayable || 0);
  const gstDone = Number(bill.gstPaid || 0) >= Number(bill.gstAmount || 0);
  if (rentDone && gstDone) return "Paid";
  if (Number(bill.rentPaid || 0) > 0 || Number(bill.gstPaid || 0) > 0) return "Partially Paid";
  return "Pending";
};

// arrears bill withGst — the parent bill's when the arrears bill has none (bills
// created before withGst was copied)
const effectiveWithGst = (bill, parentWithGst) => {
  const own = Number(bill?.withGst || 0);
  return own > 0 ? own : Number(parentWithGst || 0);
};

const ownerModeAmount = (owner, mode) => Number(mode === "Cash" ? owner.cashAmount : owner.onlineAmount) || 0;
const ownerModePaid = (owner, mode) => (mode === "Cash" ? owner.paidCash : owner.paidOnline) === true;

/**
 * Pays an arrears bill (rent or GST). Mutates and returns the bill copy.
 * Throws { message, statusCode } on a bad request.
 */
function applyArrearsPayment(billIn, { entryType, landOwnerId, paymentMode, utrNumber, date, userName, parentWithGst }) {
  // shallow copies — keeps ObjectIds as ObjectIds
  const bill = { ...billIn };
  bill.owners = (billIn.owners || []).map((o) => ({ ...o }));
  bill.payments = [...(billIn.payments || [])];
  bill.withGst = effectiveWithGst(billIn, parentWithGst);
  const gstWithRent = bill.withGst === 2; // direct GST → paid with the rent
  const payDate = date ? new Date(date) : new Date();
  const mode = paymentMode ? (String(paymentMode).toLowerCase() === "cash" ? "Cash" : "Online") : null;
  if (mode === "Online" && !String(utrNumber || "").trim()) {
    throw { message: "utrNumber is required when paymentMode is Online", statusCode: 400 };
  }
  const saved = [];

  if (entryType === "gst") {
    const gstPending = round(Number(bill.gstAmount || 0) - Number(bill.gstPaid || 0));
    if (Number(bill.gstAmount || 0) <= 0) throw { message: `${bill.label} has no GST`, statusCode: 400 };
    if (gstPending <= 0) throw { message: `${bill.label} GST already paid`, statusCode: 400 };
    bill.gstPaid = Number(bill.gstAmount || 0);
    const row = { _id: new mongoose.Types.ObjectId(), type: "gst", amount: gstPending, paymentMode: mode || "Online", utrNumber: utrNumber || "", date: payDate, createdBy: userName, createdAt: new Date() };
    bill.payments.push(row);
    saved.push(row);
  } else {
    const owners = landOwnerId
      ? bill.owners.filter((o) => String(o.landOwnerId) === String(landOwnerId) || String(o.landOwnerMasterId) === String(landOwnerId))
      : bill.owners;
    if (landOwnerId && owners.length === 0) throw { message: "landOwnerId not found on this arrears bill", statusCode: 400 };
    owners.forEach((o) => {
      const modes = mode ? [mode] : ["Online", "Cash"];
      modes.forEach((md) => {
        const rentAmount = ownerModeAmount(o, md);
        if (rentAmount <= 0 || ownerModePaid(o, md)) return;
        const share = Number(o.shareAmount || 0);
        const tds = 0; // ✅ CHANGED — no TDS on arrears / advance (full amount paid)
        const gstPart = gstWithRent && share > 0 ? round((Number(o.gstAmount || 0) * rentAmount) / share) : 0;
        if (gstPart > 0) bill.gstPaid = Math.min(Number(bill.gstAmount || 0), Number(bill.gstPaid || 0) + gstPart);
        if (md === "Cash") o.paidCash = true;
        else o.paidOnline = true;
        bill.rentPaid = Number(bill.rentPaid || 0) + rentAmount;
        const row = {
          _id: new mongoose.Types.ObjectId(),
          type: "rental",
          landOwnerId: o.landOwnerId,
          landOwnerName: o.landOwnerName,
          rentAmount,
          tdsAmount: tds,
          gstAmount: gstPart,
          amount: rentAmount - tds + gstPart,
          paymentMode: md,
          utrNumber: md === "Online" ? utrNumber || "" : "",
          date: payDate,
          createdBy: userName,
          createdAt: new Date(),
        };
        bill.payments.push(row);
        saved.push(row);
      });
    });
    if (saved.length === 0) throw { message: `${bill.label} rent already paid`, statusCode: 400 };
    if (Number(bill.rentPaid) > Number(bill.netPayable || 0)) bill.rentPaid = Number(bill.netPayable || 0);
    // direct GST: rent fully paid → the bill's GST is paid too (rounding / site-level GST)
    if (gstWithRent && Number(bill.rentPaid) >= Number(bill.netPayable || 0)) bill.gstPaid = Number(bill.gstAmount || 0);
  }
  bill.status = arrearsStatus(bill) === "Paid" ? 3 : bill.status;
  bill.updatedAt = new Date();
  return { bill, saved };
}

// ── ledger-list additions ────────────────────────────────────

const billPending = (b) => Math.max(0, round(Number(b.netPayable || 0) - Number(b.rentPaid || 0)));
const billGstPending = (b) => Math.max(0, round(Number(b.gstAmount || 0) - Number(b.gstPaid || 0)));

function arrearsBlock(bills) {
  if (!bills.length) return null;
  const sum = (fn) => bills.reduce((s, b) => s + fn(b), 0);
  return {
    totalAmount: sum((b) => Number(b.netPayable || 0)),
    totalGst: sum((b) => Number(b.gstAmount || 0)),
    totalTds: 0, // ✅ CHANGED — no TDS on arrears / advance
    paidAmount: sum((b) => Number(b.rentPaid || 0)),
    paidGst: sum((b) => Number(b.gstPaid || 0)),
    pendingAmount: sum(billPending),
    pendingGst: sum(billGstPending),
    bills: bills.map((b) => ({
      rentalDueId: b._id,
      label: newBillLabel(b.label),
      dueMonth: b.dueMonth,
      parentRentalDueId: b.parentRentalDueId,
      rentRevisionId: b.rentRevisionId,
      rentAmount: Number(b.netPayable || 0),
      gstAmount: Number(b.gstAmount || 0),
      tdsAmount: 0,
      rentPaid: Number(b.rentPaid || 0),
      gstPaid: Number(b.gstPaid || 0),
      status: arrearsStatus(b),
      payments: (b.payments || []).map((p) => ({
        type: p.type,
        landOwnerName: p.landOwnerName,
        amount: p.amount,
        paymentMode: p.paymentMode,
        utrNumber: p.utrNumber,
        date: p.date,
      })),
    })),
  };
}

const ownerMode = (o) => (Number(o.onlineAmount || 0) > 0 ? "Online" : "Cash");
const ownerPaid = (o) => (ownerMode(o) === "Cash" ? o.paidCash === true : o.paidOnline === true);

// Inserts rows after the last row of the same month (✅ CHANGED — no row of
// that month: before the first later month, else appends)
function insertAfterMonth(list, rows, dueMonth) {
  const out = [...(list || [])];
  let at = -1;
  out.forEach((r, i) => {
    if (r && (r.dueMonth === dueMonth || r.month === dueMonth)) at = i;
  });
  if (at >= 0) {
    out.splice(at + 1, 0, ...rows);
    return out;
  }
  const key = monthKey(parseFromMonth(dueMonth));
  const later = key === null ? -1 : out.findIndex((r) => {
    const k = r ? monthKey(parseFromMonth(r.dueMonth || r.month)) : null;
    return k !== null && k > key;
  });
  if (later < 0) out.push(...rows);
  else out.splice(later, 0, ...rows);
  return out;
}

// arrears bills with the effective withGst (parent bill's when not set)
const arrearsBillsWithGst = (arrearsBills, parentWithGstById = new Map()) =>
  (arrearsBills || [])
    .filter((b) => b && b.type === "arrears")
    .map((b) => ({ ...b, withGst: effectiveWithGst(b, parentWithGstById.get(String(b.parentRentalDueId))) }));

const revisionBlock = (r) =>
  r
    ? {
        revisionId: r._id,
        fromMonth: r.fromMonth,
        // ✅ NEW — BILL "months" list
        ...(Array.isArray(r.months) && r.months.length
          ? { billType: "BILL", toMonth: r.toMonth || "", totalIncreaseAmount: Number(r.totalIncreaseAmount || 0) }
          : {}),
        oldRent: r.oldRent,
        increaseAmount: r.increaseAmount ?? r.difference,
        newRent: r.newRent,
        applyToAllMonths: r.applyToAllMonths ?? null,
        status: r.status,
        approvedAt: r.approvedAt,
      }
    : null;

// ✅ CHANGED — shown as "newBill" | "advance" (stored as type "arrears" /
// "advance" in media.arrearsDue[]; the DB value is not changed)
const billKind = (b) => (b && b.type === "advance" ? "advance" : "newBill");
// ✅ NEW — old saved labels "Arrears – August 2026" → "New Bill – August 2026"
const newBillLabel = (label) => String(label || "").replace(/^Arrears(?=\s)/, "New Bill");
const advanceExtras = (b) =>
  billKind(b) === "advance" ? { adjustInMonth: b.adjustInMonth || "", adjustInDate: b.adjustInDate || null } : {};

// ledger rows of one arrears / advance bill (one per owner, same shape as ledger rows)
function arrearsLedgerRows(b) {
  const lastPay = (b.payments || []).filter((p) => p.type === "rental").slice(-1)[0];
  const kind = billKind(b);
  return (b.owners || []).map((o) => {
    const paid = ownerPaid(o);
    return {
      landOwnerId: o.landOwnerId,
      landOwnerName: o.landOwnerName,
      paymentCategory: o.paymentCategory,
      paymentMode: ownerMode(o),
      utrNumber: paid && lastPay ? lastPay.utrNumber || "" : "",
      date: paid && lastPay ? lastPay.date : null,
      status: 1,
      dueMonth: b.dueMonth,
      cycle: b.dueDate,
      rentalDueId: b._id,
      parentRentalDueId: b.parentRentalDueId,
      billType: kind,
      label: newBillLabel(b.label),
      rentRevisionId: b.rentRevisionId,
      ...advanceExtras(b),
      index: null,
      updatedBy: paid && lastPay ? lastPay.createdBy || "" : "",
      updatedAt: paid && lastPay ? lastPay.createdAt : null,
      shareAmount: Number(o.shareAmount || 0),
      tdsAmount: 0, // ✅ CHANGED — no TDS on arrears / advance
      isVirtual: !paid,
      isPaid: paid,
      targetType: kind,
      rentalDueApprovalStatus: 3,
      withGst: Number(b.withGst || 0),
      gstAmount: Number(o.gstAmount || 0),
    };
  });
}

// arrears GST row (same shape as gstBalanceHistory rows; _id = arrears bill id,
// so it can be paid with gstBalanceHistoryId or rentalDueId). null when no GST.
function arrearsGstRow(b) {
  if (Number(b.gstAmount || 0) <= 0) return null;
  const gstPays = (b.payments || []).filter((p) => p.type === "gst" || Number(p.gstAmount || 0) > 0);
  const lastGst = gstPays.slice(-1)[0];
  const gstPaidFull = Number(b.gstPaid || 0) >= Number(b.gstAmount || 0);
  return {
    _id: b._id,
    rentalDueId: b._id,
    parentRentalDueId: b.parentRentalDueId,
    billType: billKind(b),
    label: billKind(b) === "advance" ? `${b.label.split(" (")[0]} GST` : `${newBillLabel(b.label)} GST`,
    dueMonth: b.dueMonth,
    cycle: b.dueDate,
    gstAmount: Number(b.gstAmount || 0),
    isPaid: gstPaidFull,
    paidAmount: Number(b.gstPaid || 0),
    paidAt: lastGst ? lastGst.date : null,
    paidBy: lastGst ? lastGst.createdBy || "" : "",
    createdAt: b.createdAt || null,
    createdBy: b.createdBy || "",
    source: "rental",
    ownerId: null,
    ownerName: "",
    utrNumber: lastGst ? lastGst.utrNumber || "" : "",
    date: lastGst ? lastGst.date : null,
    isUtrEntry: gstPaidFull,
    withGst: b.withGst,
  };
}

// outstanding + arrears pending
function withArrearsOutstanding(outstanding, bills) {
  if (!outstanding) return outstanding;
  const pending = bills.reduce((s, b) => s + billPending(b), 0);
  const gstPending = bills.reduce((s, b) => s + billGstPending(b), 0);
  return {
    ...outstanding,
    arrearsDue: pending,
    arrearsGSTDue: gstPending,
    totalOutstandingAmount: Number(outstanding.totalOutstandingAmount || 0) + pending + gstPending,
  };
}

/**
 * One ledger-list mediaList item + that site's arrears bills / last
 * approved revision → item with the arrears rows and amounts added.
 */
function decorateLedgerItem(item, arrearsBills, lastRevision, parentWithGstById = new Map(), billMonths = null) {
  const arrears = arrearsBillsWithGst(arrearsBills, parentWithGstById);
  const advances = advanceBillsOf(arrearsBills); // ✅ NEW
  const bills = [...arrears, ...advances];
  let out = { ...item };
  delete out.arrearsDue;
  if (lastRevision) out.rentRevision = revisionBlock(lastRevision);
  out.advance = advanceBlock(advances, billMonths); // ✅ NEW — null when no advance
  out = markAdvanceAdjustedRows(out, advances); // ✅ NEW — billType "bill" + bill the advance is deducted from
  if (!bills.length) {
    out.arrears = null;
    return out;
  }

  let ledger = out.ledger || [];
  let rentalDueEntries = out.rentalDueEntries || [];
  let pendingMonths = out.pendingMonths || [];
  let gstBalanceHistory = out.gstBalanceHistory || [];
  let unpaidBills = 0;

  bills.forEach((b) => {
    const kind = billKind(b);
    ledger = insertAfterMonth(ledger, arrearsLedgerRows(b).map(({ isPaid, ...r }) => r), b.dueMonth);
    const gstRow = arrearsGstRow(b);
    if (gstRow) gstBalanceHistory = insertAfterMonth(gstBalanceHistory, [gstRow], b.dueMonth);

    rentalDueEntries = insertAfterMonth(
      rentalDueEntries,
      [{
        _id: b._id,
        type: kind,
        label: newBillLabel(b.label),
        parentRentalDueId: b.parentRentalDueId,
        dueMonth: b.dueMonth,
        dueDate: b.dueDate,
        ...advanceExtras(b),
        netPayable: Number(b.netPayable || 0),
        withGst: Number(b.withGst || 0),
        gstAmount: Number(b.gstAmount || 0),
        cashAmount: Number(b.cashAmount || 0),
        onlineAmount: Number(b.onlineAmount || 0),
        isPaid: billPending(b) === 0,
        isCurrentCycle: false,
      }],
      b.dueMonth,
    );

    if (billPending(b) > 0) {
      unpaidBills += 1;
      const due = new Date(b.dueDate);
      pendingMonths = insertAfterMonth(
        pendingMonths,
        [{
          month: b.dueMonth,
          billType: kind,
          label: newBillLabel(b.label),
          rentalDueId: b._id,
          ...advanceExtras(b),
          cycle: new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1)),
          owners: (b.owners || [])
            .filter((o) => !ownerPaid(o))
            .map((o) => ({
              landOwnerId: o.landOwnerId,
              landOwnerName: o.landOwnerName,
              paymentCategory: o.paymentCategory,
              paymentMode: ownerMode(o),
              ...(ownerMode(o) === "Cash" ? { cashAmount: Number(o.cashAmount || 0) } : { onlineAmount: Number(o.onlineAmount || 0) }),
              [ownerMode(o) === "Cash" ? "cashEntry" : "onlineEntry"]: false,
              pendingType: `${kind}Pending`,
            })),
        }],
        b.dueMonth,
      );
    }
  });

  out.ledger = ledger;
  out.rentalDue = [
    ...(out.rentalDue || []),
    ...bills.map(({ owners, payments, ...b }) => b),
  ];
  out.rentalDueEntries = rentalDueEntries;
  out.pendingMonths = pendingMonths;
  out.gstBalanceHistory = gstBalanceHistory;
  out.pendingMonthsCount = Number(out.pendingMonthsCount || 0) + unpaidBills;
  if (arrears.length) out.outstanding = withArrearsOutstanding(out.outstanding, arrears);
  if (advances.length) out.outstanding = withAdvanceOutstanding(out.outstanding, advances);
  out.arrears = arrearsBlock(arrears);
  return out;
}

// ── ✅ NEW — advance bills in ledger-list / ledger-history ────

const advanceBillsOf = (bills) =>
  (bills || []).filter((b) => b && b.type === "advance").map((b) => ({ ...b, withGst: Number(b.withGst || 0) }));

// adjusted = the bill it is deducted from is generated (billMonths: Set of
// the site's bill months; null → unknown, false)
function advanceBlock(bills, billMonths = null) {
  if (!bills.length) return null;
  const sum = (fn) => bills.reduce((s, b) => s + fn(b), 0);
  const isAdjusted = (b) => !!(billMonths && billMonths.has(b.adjustInMonth));
  return {
    totalAmount: sum((b) => Number(b.netPayable || 0)),
    totalGst: sum((b) => Number(b.gstAmount || 0)),
    totalTds: 0, // ✅ CHANGED — no TDS on arrears / advance
    paidAmount: sum((b) => Number(b.rentPaid || 0)),
    paidGst: sum((b) => Number(b.gstPaid || 0)),
    pendingAmount: sum(billPending),
    pendingGst: sum(billGstPending),
    adjustedAmount: sum((b) => (isAdjusted(b) ? Number(b.netPayable || 0) : 0)),
    bills: bills.map((b) => ({
      rentalDueId: b._id,
      label: newBillLabel(b.label),
      dueMonth: b.dueMonth,
      adjustInMonth: b.adjustInMonth || "",
      adjusted: isAdjusted(b),
      rentRevisionId: b.rentRevisionId,
      rentAmount: Number(b.netPayable || 0),
      gstAmount: Number(b.gstAmount || 0),
      tdsAmount: 0,
      rentPaid: Number(b.rentPaid || 0),
      gstPaid: Number(b.gstPaid || 0),
      status: arrearsStatus(b),
      mailSent: !!b.mailSent,
      mailSentAt: b.mailSentAt || null,
      payments: (b.payments || []).map((p) => ({
        type: p.type,
        landOwnerName: p.landOwnerName,
        amount: p.amount,
        paymentMode: p.paymentMode,
        utrNumber: p.utrNumber,
        date: p.date,
      })),
    })),
  };
}

// outstanding + advance pending
function withAdvanceOutstanding(outstanding, bills) {
  if (!outstanding) return outstanding;
  const pending = bills.reduce((s, b) => s + billPending(b), 0);
  const gstPending = bills.reduce((s, b) => s + billGstPending(b), 0);
  return {
    ...outstanding,
    advanceDue: pending,
    advanceGSTDue: gstPending,
    totalOutstandingAmount: Number(outstanding.totalOutstandingAmount || 0) + pending + gstPending,
  };
}

// month → { totalRentalAmount, advanceAdjusted, advanceGstAdjusted, advanceRentalDueId }
function advanceAdjustByMonth(advances) {
  const map = new Map();
  (advances || []).forEach((b) => {
    if (!b.adjustInMonth) return;
    const cur = map.get(b.adjustInMonth) || {
      totalRentalAmount: Number(b.billRent || 0),
      advanceAdjusted: 0,
      advanceGstAdjusted: 0,
      advanceRentalDueId: b._id,
    };
    cur.advanceAdjusted += Number(b.netPayable || 0);
    cur.advanceGstAdjusted += Number(b.gstAmount || 0);
    map.set(b.adjustInMonth, cur);
  });
  return map;
}

// normal bill rows of the adjusted month get the advance amounts; every
// normal row gets billType "bill"
function markAdvanceAdjustedRows(out, advances) {
  const byMonth = advanceAdjustByMonth(advances);
  const mark = (rows) =>
    Array.isArray(rows)
      ? rows.map((r) => {
          if (!r || typeof r !== "object" || r.billType === "arrears" || r.billType === "newBill" || r.billType === "advance") return r;
          const adj = byMonth.get(r.dueMonth) || byMonth.get(r.month);
          return { ...r, billType: r.billType || "bill", ...(adj || {}) };
        })
      : rows;
  return {
    ...out,
    ledger: mark(out.ledger),
    rentalDueEntries: mark(out.rentalDueEntries),
    pendingMonths: mark(out.pendingMonths),
    gstBalanceHistory: mark(out.gstBalanceHistory),
  };
}

// ✅ NEW — ledger-history: every normal row gets billType "bill"; the month the
// advance is deducted from (e.g. September 2026 bucket) gets the advance amounts
// on its bill rows and on the month itself (TDS rows: billType only)
function markAdvanceAdjustedHistory(out, advances) {
  const byMonth = advanceAdjustByMonth(advances);
  const isExtra = (r) => !r || typeof r !== "object" || r.billType === "arrears" || r.billType === "newBill" || r.billType === "advance";
  const markRow = (adj) => (r) => (isExtra(r) ? r : { ...r, billType: r.billType || "bill", ...(adj || {}) });
  const ROW_KEYS = ["ledger", "withGst1Ledger", "allEntries", "gstBalanceHistory", "pendingLedgerHistory"];
  const ledgerHistory = Array.isArray(out.ledgerHistory)
    ? out.ledgerHistory.map((y) => ({
        ...y,
        months: (y?.months || []).map((mo) => {
          const idx = MONTHS.findIndex((n) => n.toLowerCase() === String(mo?.month || "").trim().toLowerCase());
          const adj = idx >= 0 ? byMonth.get(`${MONTHS[idx]} ${String(y.year).trim()}`) : null;
          const next = { ...mo };
          ROW_KEYS.forEach((k) => {
            if (Array.isArray(next[k])) next[k] = next[k].map(markRow(adj));
          });
          if (Array.isArray(next.tdsBalanceHistory)) next.tdsBalanceHistory = next.tdsBalanceHistory.map(markRow(null));
          return adj ? { ...next, ...adj } : next;
        }),
      }))
    : out.ledgerHistory;
  // top-level gstBalanceHistory: marked in the controller (buildSingleMediaHistoryBlock)
  return { ...out, ledgerHistory };
}

/**
 * One ledger-history media block + that site's arrears bills → the arrears
 * rows added to the arrears month's bucket (ledgerHistory[year].months[month]:
 * ledger, allEntries, withGst1Ledger, gstBalanceHistory), the full
 * gstBalanceHistory, outstanding, arrears and rentRevision blocks.
 * inRange(date) → false skips a month outside the requested filter.
 */
function decorateLedgerHistoryBlock(block, arrearsBills, lastRevision, parentWithGstById = new Map(), inRange = () => true, billMonths = null) {
  const arrears = arrearsBillsWithGst(arrearsBills, parentWithGstById);
  const advances = advanceBillsOf(arrearsBills); // ✅ NEW
  const bills = [...arrears, ...advances];
  let out = { ...block };
  if (lastRevision) out.rentRevision = revisionBlock(lastRevision);
  out.advance = advanceBlock(advances, billMonths); // ✅ NEW — null when no advance
  out = markAdvanceAdjustedHistory(out, advances); // ✅ NEW — billType "bill" + bill the advance is deducted from
  if (!bills.length) {
    out.arrears = null;
    return out;
  }

  let ledgerHistory = (out.ledgerHistory || []).map((y) => ({ ...y, months: [...(y.months || [])] }));
  let gstBalanceHistory = out.gstBalanceHistory || [];

  bills.forEach((b) => {
    const due = new Date(b.dueDate);
    if (Number.isNaN(due.getTime()) || !inRange(due)) return;
    const yearKey = String(due.getUTCFullYear());
    const monthName = MONTHS[due.getUTCMonth()];

    let yearEntry = ledgerHistory.find((y) => String(y.year).trim() === yearKey);
    if (!yearEntry) {
      yearEntry = { year: yearKey, months: [] };
      ledgerHistory.push(yearEntry);
    }
    let mIdx = yearEntry.months.findIndex((m) => String(m.month || "").toLowerCase() === monthName.toLowerCase());
    if (mIdx < 0) {
      yearEntry.months.push({
        month: monthName,
        ledger: [],
        withGst1Ledger: [],
        allEntries: [],
        gstBalanceHistory: [],
        tdsBalanceHistory: [],
        pendingLedgerHistory: [],
        isSyntheticMonth: true,
      });
      mIdx = yearEntry.months.length - 1;
    }
    const month = { ...yearEntry.months[mIdx] };

    const rows = arrearsLedgerRows(b).map((r) => ({
      ...r,
      month: monthName,
      amount: r.isPaid ? Number(r.shareAmount || 0) : 0, // ✅ CHANGED — no TDS
    }));
    month.ledger = [...(month.ledger || []), ...rows];

    // real payments (rent / GST) → allEntries, like saved ledger entries
    const paidEntries = (b.payments || []).map((p) => ({
      _id: p._id,
      landOwnerId: p.landOwnerId || null,
      landOwnerName: p.landOwnerName || "",
      paymentMode: p.paymentMode,
      utrNumber: p.utrNumber || "",
      date: p.date,
      status: 1,
      month: monthName,
      dueMonth: b.dueMonth,
      cycle: b.dueDate,
      rentalDueId: b._id,
      parentRentalDueId: b.parentRentalDueId,
      billType: billKind(b),
      ...advanceExtras(b),
      label: p.type === "gst" ? `${newBillLabel(b.label)} GST` : newBillLabel(b.label),
      amount: Number(p.amount || 0),
      shareAmount: Number(p.rentAmount || 0),
      tdsAmount: Number(p.tdsAmount || 0),
      gstAmount: p.type === "gst" ? Number(p.amount || 0) : Number(p.gstAmount || 0),
      withGst: p.type === "gst" ? 1 : Number(b.withGst || 0),
      isPaid: true,
      isVirtual: false,
      updatedBy: p.createdBy || "",
      updatedAt: p.createdAt || null,
    }));
    month.allEntries = [...(month.allEntries || []), ...paidEntries];

    const gstRow = arrearsGstRow(b);
    if (gstRow) {
      month.gstBalanceHistory = [...(month.gstBalanceHistory || []), gstRow];
      // advance GST rows of the top-level gstBalanceHistory are added in the controller
      if (billKind(b) !== "advance") gstBalanceHistory = insertAfterMonth(gstBalanceHistory, [gstRow], b.dueMonth);
      // GST hold (withGst 1) → its own GST row, like withGst1Ledger entries
      if (Number(b.withGst) === 1) {
        month.withGst1Ledger = [
          ...(month.withGst1Ledger || []),
          {
            landOwnerId: null,
            landOwnerName: "",
            paymentMode: "Online",
            utrNumber: gstRow.utrNumber,
            date: gstRow.date,
            status: gstRow.isPaid ? 1 : 0,
            withGst: 1,
            month: monthName,
            dueMonth: b.dueMonth,
            cycle: b.dueDate,
            rentalDueId: b._id,
            parentRentalDueId: b.parentRentalDueId,
            billType: billKind(b),
            label: gstRow.label,
            index: null,
            updatedBy: gstRow.paidBy,
            updatedAt: gstRow.paidAt,
            isPaid: gstRow.isPaid,
            gstAmount: gstRow.gstAmount,
            amount: gstRow.isPaid ? gstRow.gstAmount : 0,
            rentalDueApprovalStatus: 3,
            isVirtual: !gstRow.isPaid,
          },
        ];
      }
    }
    yearEntry.months[mIdx] = month;
  });

  out.ledgerHistory = ledgerHistory;
  out.gstBalanceHistory = gstBalanceHistory;
  if (arrears.length) out.outstanding = withArrearsOutstanding(out.outstanding, arrears);
  if (advances.length) out.outstanding = withAdvanceOutstanding(out.outstanding, advances);
  out.arrears = arrearsBlock(arrears);
  return out;
}

/**
 * Overall arrears totals across sites: docs = [{ _id, arrearsDue }]
 * ✅ CHANGED — type "advance" → advance totals (+ adjusted when docs carry rentalDue.dueMonth)
 */
function overallArrearsTotals(docs, type = "arrears") {
  const t = {
    amount: 0, gst: 0, paid: 0, gstPaid: 0, pending: 0, gstPending: 0,
    amountSites: 0, paidSites: 0, pendingSites: 0, gstPendingSites: 0,
    ...(type === "advance" ? { adjusted: 0, adjustedSites: 0 } : {}),
  };
  (docs || []).forEach((d) => {
    const bills = (d.arrearsDue || []).filter((b) => b && b.type === type);
    if (!bills.length) return;
    if (type === "advance") {
      const months = new Set((d.rentalDue || []).map((r) => r && r.dueMonth).filter(Boolean));
      const adjusted = bills.filter((b) => months.has(b.adjustInMonth)).reduce((s, b) => s + Number(b.netPayable || 0), 0);
      t.adjusted += adjusted;
      if (adjusted > 0) t.adjustedSites += 1;
    }
    let paid = 0; let pending = 0; let gstPending = 0;
    bills.forEach((b) => {
      t.amount += Number(b.netPayable || 0);
      t.gst += Number(b.gstAmount || 0);
      t.paid += Number(b.rentPaid || 0);
      t.gstPaid += Number(b.gstPaid || 0);
      pending += billPending(b);
      gstPending += billGstPending(b);
      paid += Number(b.rentPaid || 0);
    });
    t.pending += pending;
    t.gstPending += gstPending;
    t.amountSites += 1;
    if (paid > 0) t.paidSites += 1;
    if (pending > 0) t.pendingSites += 1;
    if (gstPending > 0) t.gstPendingSites += 1;
  });
  return t;
}

module.exports = {
  MONTHS,
  monthKey,
  monthLabelOfKey,
  parseFromMonth,
  buildRevisionPlan,
  planPreview,
  toArrearsBill,
  buildAdvancePlan, // ✅ NEW
  toAdvanceBill, // ✅ NEW
  nextBillDateAfter, // ✅ NEW
  gstPercentageFor, // ✅ NEW
  cycleMonthsOf, // ✅ NEW
  advanceBlock, // ✅ NEW
  arrearsStatus,
  newBillLabel, // ✅ NEW
  effectiveWithGst,
  applyArrearsPayment,
  arrearsBlock,
  decorateLedgerItem,
  decorateLedgerHistoryBlock,
  overallArrearsTotals,
};
