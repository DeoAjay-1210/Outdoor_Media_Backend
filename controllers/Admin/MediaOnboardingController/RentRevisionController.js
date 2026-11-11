// ─────────────────────────────────────────────────────────────
// ✅ NEW — Rent revision (rent changed from a past month, arrears paid separately)
//
//   POST /admin/rent-revision           { mediaId, fromMonth, newRent, reason }
//   POST /admin/rent-revision/approve   { revisionId, action: 1 approve | 2 reject, remark }
//   GET  /admin/rent-revision-list      ?mediaId=&status=&pageNumber=&count=
//
// Approval: Rental Executive (1) → Rental Manager (2) → CMD (3), in order;
// every approval is stored. CMD approval applies the revision (see
// utils/rentRevisionArrears.js) and sends the CMD approval mail for each
// arrears bill. Arrears are paid through POST /admin/ledger-save.
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const axios = require("axios");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const RentRevision = require("../../../models/Admin/MediaOnboardingSchema/RentRevisionSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const {
  monthKey,
  monthLabelOfKey,
  parseFromMonth,
  buildRevisionPlan,
  toArrearsBill,
  arrearsStatus,
  newBillLabel,
  buildAdvancePlan,
  toAdvanceBill,
  gstPercentageFor,
  cycleMonthsOf,
  nextBillDateAfter,
  splitByWeights, // ✅ NEW — month payment split
} = require("../../../utils/rentRevisionArrears");
const { rentPartsForDueDate, landOwnersAsOfDate } = require("../../../utils/appraisalRent"); // ✅ NEW — BILL decrease; ✅ CHANGED — + landOwnersAsOfDate (payment split)
const { ensureRevisionAdinnOohBill } = require("../../../utils/adinnOohBills"); // ✅ NEW — New Bill / Advance bill number

const ROLE_NAMES = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const round = (v) => Math.round(Number(v) || 0);

const siteCodeName = (media) => {
  const details = media?.mediaDetails || [];
  return {
    mediaCode: details.map((d) => d.mediaCode).filter(Boolean).join(" / "),
    mediaName: details.map((d) => d.mediaName).filter(Boolean).join(", "),
  };
};

const formatSteps = (steps) =>
  (steps || []).map((s) => ({
    role: s.role,
    roleName: s.roleName || ROLE_NAMES[s.role],
    status: s.status,
    by: s.by || "",
    byUserId: s.byUserId || null,
    at: s.at || null,
    remark: s.remark || "",
  }));

// ✅ NEW — latest decided step (Approved / Rejected, by `at`; Skipped ignored);
// same time → the higher role (CMD). null when nobody decided yet.
const lastRemarkOf = (steps) => {
  const decided = (steps || []).filter((st) => st && st.at && (st.status === "Approved" || st.status === "Rejected"));
  if (!decided.length) return null;
  const last = decided.reduce((a, b) => {
    const ta = new Date(a.at).getTime();
    const tb = new Date(b.at).getTime();
    if (tb !== ta) return tb > ta ? b : a;
    return Number(b.role) > Number(a.role) ? b : a;
  });
  return {
    role: last.role,
    roleName: last.roleName || ROLE_NAMES[last.role],
    status: last.status,
    by: last.by || "",
    remark: last.remark || "",
    at: last.at || null,
  };
};

// ✅ CHANGED — + withGst1Ledger gstBalanceHistory (BILL decrease: payment check / GST rows)
const RENT_REVISION_MEDIA_FIELDS =
  "mediaDetails rentalPayment landOwners appraisal rentalDue arrearsDue gstApplicableFlag agreement status ledger ledgerHistory withGst1Ledger gstBalanceHistory";

// mediaId: array, JSON string array, "a,b" or a single id → [ids]
const parseMediaIds = (value) => {
  if (value === undefined || value === null || value === "") return [];
  let list = value;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("[")) {
      try { list = JSON.parse(t); } catch (e) { list = t.replace(/[[\]"']/g, "").split(","); }
    } else {
      list = t.split(",");
    }
  }
  if (!Array.isArray(list)) list = [list];
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
};

// applyToAllMonths: "" / null / undefined → null (from fromMonth onwards), "0" → 0, "1" → 1; invalid → undefined
const parseApplyToAllMonths = (value) => {
  if (value === undefined || value === null || String(value).trim() === "" || String(value).trim() === "null") return null;
  const n = Number(value);
  return n === 0 || n === 1 ? n : undefined;
};

// ✅ NEW — billType: "BILL" (default) | "ADVANCE"; invalid → undefined
// ✅ CHANGED — + "NORMAL_BILL"; "NEW_BILL" = "BILL"
const parseBillType = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return "BILL";
  const t = String(value).trim().toUpperCase();
  if (t === "NEW_BILL") return "BILL";
  return t === "BILL" || t === "ADVANCE" || t === "NORMAL_BILL" || t === "CANCEL" ? t : undefined; // ✅ CHANGED — + CANCEL
};
const BILL_TYPE_ERROR = "billType must be BILL (NEW_BILL), NORMAL_BILL, CANCEL or ADVANCE";
// ✅ NEW — billTypes saved and applied at once (no rent revision approval)
const AUTO_BILL_TYPES = ["NORMAL_BILL", "CANCEL"];

// ✅ NEW — gstOnIncrease: "" / null → null, "0" / "1" (also yes / no); invalid → undefined
const parseGstOnIncrease = (value) => {
  if (value === undefined || value === null || String(value).trim() === "" || String(value).trim() === "null") return null;
  const t = String(value).trim().toLowerCase();
  if (t === "1" || t === "yes" || t === "true") return 1;
  if (t === "0" || t === "no" || t === "false") return 0;
  return undefined;
};

// ✅ NEW — withGst: not sent → 0 (as per the bill), 1 → GST hold, 2 → direct; invalid → undefined
const parseRevisionWithGst = (value) => {
  if (value === undefined || value === null || String(value).trim() === "" || String(value).trim() === "null") return 0;
  const n = Number(String(value).trim());
  return n === 0 || n === 1 || n === 2 ? n : undefined;
};
const WITH_GST_LABELS = { 0: "As per bill", 1: "GST Hold", 2: "Direct (No Hold)" };

// ✅ NEW — next months amount (applyToAllMonths 1): increase → nextIncreaseAmount,
// decrease → nextDecreaseAmount (the other key → error). Returns
// { amount: positive | null (not sent → last listed month's amount) } | { error }
function parseNextAmount(src, action, prefix = "") {
  const sentInc = src.nextIncreaseAmount !== undefined && src.nextIncreaseAmount !== null && String(src.nextIncreaseAmount).trim() !== "";
  const sentDec = src.nextDecreaseAmount !== undefined && src.nextDecreaseAmount !== null && String(src.nextDecreaseAmount).trim() !== "";
  const at = prefix ? prefix.replace(/\.$/, ": ") : ""; // "sites[0]." → "sites[0]: "
  if (action === "decrease" && sentInc) return { error: `${at}use nextDecreaseAmount for a decrease` };
  if (action !== "decrease" && sentDec) return { error: `${at}use nextIncreaseAmount for an increase` };
  const key = action === "decrease" ? "nextDecreaseAmount" : "nextIncreaseAmount";
  const amount = parseAmount(src[key]);
  if (amount === undefined) return { error: `${prefix}${key} must be more than 0` };
  return { amount };
}

// ✅ NEW — positive amount or null (not sent); invalid → undefined
const parseAmount = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? round(n) : undefined;
};

// ✅ CHANGED — arrays / objects (BILL months) compared by value
const sameValue = (a, b) => {
  const norm = (v) => (v && typeof v === "object" ? JSON.stringify(v) : v ?? null);
  return norm(a) === norm(b);
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW — month payment split (only inside months[]): how the month's
// increase / decrease / advance amount is paid.
//   paymentCategory 1 Cash | 2 Online | 3 Cash + Online (cashAmount + onlineAmount)
//   paymentMode "Cash" / "Online" (optional, must match 1 / 2)
//   landOwners [{ landOwnerId, paymentCategory, paymentMode, cashAmount, onlineAmount }]
// Not sent → null (owners' amounts as before).
// ─────────────────────────────────────────────────────────────
const PAY_MODE_OF = { 1: "Cash", 2: "Online" };
const sentVal = (v) => v !== undefined && v !== null && String(v).trim() !== "";
function parseMonthPayment(raw, label) {
  if (!raw || typeof raw !== "object") return { payment: null };
  const hasOwners = raw.landOwners !== undefined && raw.landOwners !== null && raw.landOwners !== "";
  if (!hasOwners && !["paymentCategory", "paymentMode", "cashAmount", "onlineAmount"].some((f) => sentVal(raw[f]))) return { payment: null };
  const one = (src, at) => {
    const pc = Number(src?.paymentCategory);
    if (![1, 2, 3].includes(pc)) return { error: `${at}paymentCategory must be 1 (Cash), 2 (Online) or 3 (Cash+Online)` };
    if (sentVal(src.paymentMode) && pc !== 3) {
      const m = String(src.paymentMode).trim().toLowerCase();
      const mode = m === "cash" ? "Cash" : m === "online" ? "Online" : null;
      if (!mode) return { error: `${at}paymentMode must be Cash or Online` };
      if (mode !== PAY_MODE_OF[pc]) return { error: `${at}paymentMode must be ${PAY_MODE_OF[pc]} for paymentCategory ${pc}` };
    }
    const num = (f) => (sentVal(src[f]) ? Number(src[f]) : null);
    const cash = num("cashAmount");
    const online = num("onlineAmount");
    if (cash !== null && (!Number.isFinite(cash) || cash < 0)) return { error: `${at}cashAmount must be 0 or more` };
    if (online !== null && (!Number.isFinite(online) || online < 0)) return { error: `${at}onlineAmount must be 0 or more` };
    return { pc, cash, online };
  };
  if (hasOwners) {
    let list = raw.landOwners;
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch (e) {
        return { error: `${label}: landOwners is invalid` };
      }
    }
    if (!Array.isArray(list) || !list.length) return { error: `${label}: landOwners must be a non-empty array` };
    if (sentVal(raw.paymentCategory)) return { error: `${label}: send paymentCategory inside landOwners (not both)` };
    const seen = new Set();
    const owners = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i] || {};
      const at = `${label}: landOwners[${i}].`;
      if (!mongoose.Types.ObjectId.isValid(String(o.landOwnerId || ""))) return { error: `${at}landOwnerId is invalid` };
      if (seen.has(String(o.landOwnerId))) return { error: `${at}landOwnerId is repeated` };
      seen.add(String(o.landOwnerId));
      const r = one(o, at);
      if (r.error) return r;
      if (r.pc !== 2 && r.cash === null) return { error: `${at}cashAmount is required for paymentCategory ${r.pc}` };
      if (r.pc !== 1 && r.online === null) return { error: `${at}onlineAmount is required for paymentCategory ${r.pc}` };
      owners.push({
        landOwnerId: String(o.landOwnerId),
        paymentCategory: r.pc,
        cashAmount: r.pc === 2 ? 0 : round(r.cash),
        onlineAmount: r.pc === 1 ? 0 : round(r.online),
      });
    }
    return { payment: { landOwners: owners } };
  }
  const r = one(raw, `${label}: `);
  if (r.error) return r;
  if (r.pc === 3 && (r.cash === null || r.online === null)) {
    return { error: `${label}: cashAmount and onlineAmount are required for paymentCategory 3` };
  }
  return {
    payment: {
      paymentCategory: r.pc,
      paymentMode: r.pc === 3 ? "Cash+Online" : PAY_MODE_OF[r.pc],
      ...(r.pc === 3 ? { cashAmount: round(r.cash), onlineAmount: round(r.online) } : {}),
    },
  };
}
// split amounts must add up to the month amount
function paymentTotalError(payment, amountAbs, label) {
  if (!payment) return null;
  if (payment.landOwners) {
    const s = payment.landOwners.reduce((t, o) => t + Number(o.cashAmount || 0) + Number(o.onlineAmount || 0), 0);
    return round(s) === round(amountAbs) ? null : `${label}: landOwners amounts must add up to ${amountAbs}`;
  }
  if (payment.paymentCategory === 3 && round(Number(payment.cashAmount) + Number(payment.onlineAmount)) !== round(amountAbs)) {
    return `${label}: cashAmount + onlineAmount must be ${amountAbs}`;
  }
  return null;
}
// per owner { landOwnerId, cash, online } of the month amount (negative for a decrease)
function monthOwnerDeltas(media, date, amount, payment, label) {
  if (!payment || !Number(amount)) return { deltas: null };
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(Number(amount));
  const owners = landOwnersAsOfDate(media, date) || [];
  if (!owners.length) return { error: `${label}: this site has no landowner` };
  if (payment.landOwners) {
    const bad = payment.landOwners.find((p) => !owners.some((o) => String(o._id) === String(p.landOwnerId)));
    if (bad) return { error: `${label}: landOwnerId ${bad.landOwnerId} is not a landowner of this site` };
    return {
      deltas: owners.map((o) => {
        const p = payment.landOwners.find((x) => String(x.landOwnerId) === String(o._id)) || {};
        return { landOwnerId: o._id, cash: sign * Number(p.cashAmount || 0), online: sign * Number(p.onlineAmount || 0), requestedPaymentCategory: Number(p.paymentCategory) || null }; // ✅ CHANGED — + requested category
      }),
    };
  }
  const pc = Number(payment.paymentCategory);
  const cashTotal = pc === 1 ? abs : pc === 2 ? 0 : Number(payment.cashAmount || 0);
  const onlineTotal = pc === 1 ? 0 : pc === 2 ? abs : Number(payment.onlineAmount || 0);
  const weights = owners.map((o) => Number(o.shareAmount || 0));
  const cashParts = splitByWeights(cashTotal, weights);
  const onlineParts = splitByWeights(onlineTotal, weights);
  return { deltas: owners.map((o, i) => ({ landOwnerId: o._id, cash: sign * cashParts[i], online: sign * onlineParts[i], requestedPaymentCategory: pc || null })) }; // ✅ CHANGED — + requested category
}
// owners of a rentalDue month after the change → kept month ownerSplit
function ownerSplitAfter(media, date, deltas, label) {
  if (!deltas) return { split: null };
  const owners = landOwnersAsOfDate(media, date) || [];
  const split = [];
  for (const o of owners) {
    const d = deltas.find((x) => String(x.landOwnerId) === String(o._id)) || { cash: 0, online: 0 };
    const pc = Number(o.paymentCategory || 1);
    const share = Number(o.shareAmount || 0);
    const baseCash = pc === 1 ? share : pc === 2 ? 0 : Number(o.cashAmount || 0);
    const baseOnline = pc === 2 ? share : pc === 1 ? 0 : Number(o.onlineAmount || 0);
    const cash = round(baseCash + d.cash);
    const online = round(baseOnline + d.online);
    const who = (owners.length > 1 && o.name ? ` (${o.name})` : "");
    if (cash < 0) return { error: `${label}: Cash amount cannot go below 0${who} (available ${baseCash})` };
    if (online < 0) return { error: `${label}: Online amount cannot go below 0${who} (available ${baseOnline})` };
    split.push({
      landOwnerId: o._id,
      paymentCategory: cash > 0 && online > 0 ? 3 : online > 0 ? 2 : 1,
      shareAmount: cash + online,
      cashAmount: cash,
      onlineAmount: online,
    });
  }
  return { split };
}
// New Bill / Advance bills (media.arrearsDue[] docs, before saving): each
// owner's cash / online = the split, spread over the bills by their amount
function applySplitToNewBills(bills, deltas) {
  if (!deltas || !bills.length) return;
  const weights = bills.map((b) => Number(b.netPayable || 0));
  deltas.forEach((d) => {
    // ✅ FIXED — owner share per bill split once; cash rounded, online = share −
    // cash (cash + online per bill no longer off by 1 on multi-face sites)
    const shareParts = splitByWeights(Math.abs(d.cash) + Math.abs(d.online), weights);
    const rawCash = splitByWeights(Math.abs(d.cash), weights);
    const cashParts = shareParts.map((s, i) => Math.min(rawCash[i], s));
    const onlineParts = shareParts.map((s, i) => s - cashParts[i]);
    bills.forEach((b, i) => {
      const o = (b.owners || []).find((x) => String(x.landOwnerId) === String(d.landOwnerId));
      if (!o) return;
      o.cashAmount = cashParts[i];
      o.onlineAmount = onlineParts[i];
      o.shareAmount = cashParts[i] + onlineParts[i];
      o.paymentCategory = o.cashAmount > 0 && o.onlineAmount > 0 ? 3 : o.onlineAmount > 0 ? 2 : 1;
      if (d.requestedPaymentCategory) o.requestedPaymentCategory = d.requestedPaymentCategory; // ✅ NEW — category sent (3 → Cash + Online rows even when one is 0)
    });
  });
  bills.forEach((b) => {
    b.cashAmount = (b.owners || []).reduce((s, o) => s + Number(o.cashAmount || 0), 0);
    b.onlineAmount = (b.owners || []).reduce((s, o) => s + Number(o.onlineAmount || 0), 0);
  });
}

// ✅ NEW — ADVANCE inside months: [{ month, advanceAmount, adjustInMonth?, payment
// split }] (one month). null → not sent (advanceMonth / advanceAmount used).
function parseAdvanceMonths(value, p = "") {
  if (value === undefined || value === null || (!Array.isArray(value) && String(value).trim() === "")) return null;
  let arr = value;
  if (typeof value === "string") {
    try {
      arr = JSON.parse(value);
    } catch (e) {
      return { error: `${p}months is invalid — send like [{"month":"November 2026","advanceAmount":10000}]` };
    }
  }
  if (!Array.isArray(arr) || arr.length !== 1) {
    return { error: `${p}months must have one month for ADVANCE — send like [{"month":"November 2026","advanceAmount":10000}]` };
  }
  const x = arr[0] || {};
  const advanceDate = parseFromMonth(x.month);
  if (!advanceDate) return { error: `${p}months[0].month is invalid — send like "November 2026"` };
  const raw = sentVal(x.advanceAmount) ? x.advanceAmount : x.amount;
  const advanceAmount = Number(raw);
  if (!sentVal(raw) || !Number.isFinite(advanceAmount) || advanceAmount <= 0) return { error: `${p}months[0].advanceAmount must be more than 0` };
  let adjustInDate = null;
  if (sentVal(x.adjustInMonth)) {
    adjustInDate = parseFromMonth(x.adjustInMonth);
    if (!adjustInDate) return { error: `${p}months[0].adjustInMonth is invalid — send like "September 2026"` };
  }
  const label = monthLabelOfKey(monthKey(advanceDate));
  const pay = parseMonthPayment(x, label);
  if (pay.error) return { error: `${p}${pay.error}` };
  const totErr = paymentTotalError(pay.payment, round(advanceAmount), label);
  if (totErr) return { error: `${p}${totErr}` };
  return { opts: { advanceDate, advanceLabel: label, advanceAmount: round(advanceAmount), adjustInDate, advancePayment: pay.payment } };
}

// ✅ NEW — BILL months: [{ month, amount }] (array or JSON string) →
// { list: [{ month, amount, key, date }] sorted by month } | { list: null } (not sent) | { error }
const MONTHS_EXAMPLE = '[{"month":"August 2026","amount":2000}]';
// ✅ CHANGED — opts.allowNoAmount (CANCEL): a month without an amount → amount 0, action "none"
const parseRevisionMonths = (value, opts = {}) => {
  if (value === undefined || value === null || (!Array.isArray(value) && String(value).trim() === "")) return { list: null };
  let arr = value;
  if (typeof value === "string") {
    try {
      arr = JSON.parse(value);
    } catch (e) {
      return { error: `months is invalid — send like ${MONTHS_EXAMPLE}` };
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return { error: `months is required — send like ${MONTHS_EXAMPLE}` };
  const seen = new Set();
  const list = [];
  for (let i = 0; i < arr.length; i++) {
    const date = parseFromMonth(arr[i]?.month);
    if (!date) return { error: `months[${i}].month is invalid — send like "October 2026"` };
    // ✅ CHANGED — amount (= increase) | increaseAmount | decreaseAmount, one of them;
    // decrease → amount kept negative. Every month must be the same action.
    const sent = ["amount", "increaseAmount", "decreaseAmount"].filter(
      (f) => arr[i]?.[f] !== undefined && arr[i]?.[f] !== null && String(arr[i][f]).trim() !== "",
    );
    if (sent.length > 1) return { error: `months[${i}]: send only one of amount, increaseAmount or decreaseAmount` };
    if (!sent.length && opts.allowNoAmount) {
      const k0 = monthKey(date);
      const m0 = monthLabelOfKey(k0);
      if (seen.has(k0)) return { error: `${m0} is repeated in months` };
      seen.add(k0);
      list.push({ month: m0, amount: 0, key: k0, date, action: "none" });
      continue;
    }
    const field = sent[0] || "amount";
    const amount = Number(arr[i]?.[field]);
    if (!Number.isFinite(amount) || amount <= 0) return { error: `months[${i}].${field} must be more than 0` };
    const monthAction = field === "decreaseAmount" ? "decrease" : "increase";
    const key = monthKey(date);
    const month = monthLabelOfKey(key);
    if (seen.has(key)) return { error: `${month} is repeated in months` };
    seen.add(key);
    // ✅ NEW — month payment split (optional)
    const pay = parseMonthPayment(arr[i], month);
    if (pay.error) return { error: pay.error };
    const payTotalErr = paymentTotalError(pay.payment, round(amount), month);
    if (payTotalErr) return { error: payTotalErr };
    list.push({
      month,
      amount: monthAction === "decrease" ? -round(amount) : round(amount),
      key,
      date,
      action: monthAction,
      ...(pay.payment ? { payment: pay.payment } : {}),
    });
  }
  const actions = new Set(list.map((x) => x.action).filter((a) => a !== "none"));
  if (actions.size > 1) {
    return { error: "months: send all increaseAmount or all decreaseAmount (not both in one request)" };
  }
  list.sort((a, b) => a.key - b.key);
  return { list, action: actions.size ? [...actions][0] : list.length ? "none" : "increase" };
};

// ✅ NEW — the site already has a Pending revision (same billType) → POST
// /admin/rent-revision updates THAT revision instead of failing.
// compare (amount / month / applyToAllMonths / GST …) changed → approvals reset
// (all 3 steps Pending again); old values + the reset approvals → editHistory.
// reason / invoice only → approvals kept. derived → always saved.
// Returns { revision, action: "updated" | "unchanged" }.
async function editPendingRevision(revision, { compare, derived = {}, reason, invoice, user }) {
  const before = {};
  Object.keys(compare).forEach((k) => {
    // ✅ CHANGED — withGst: revisions saved before it → 0 (no approval reset on resend)
    before[k] = k === "increaseAmount" ? revision.increaseAmount ?? revision.difference : k === "withGst" ? revision.withGst ?? 0 : revision[k] ?? null;
  });
  before.reason = revision.reason || "";
  before.invoice = revision.invoice?.filePath || "";
  // no new invoice uploaded → keep the saved one
  const nextInvoice = invoice || revision.invoice || null;
  const after = { ...compare, reason, invoice: nextInvoice?.filePath || "" };
  const valuesChanged = Object.keys(compare).some((k) => !sameValue(before[k], after[k]));
  if (!valuesChanged && before.reason === after.reason && before.invoice === after.invoice) {
    return { revision, action: "unchanged" };
  }

  const now = nowIST();
  const approvalsReset = valuesChanged
    ? (revision.approvalSteps || [])
        .filter((s) => s.status === "Approved" || s.status === "Skipped")
        .map((s) => ({ role: s.role, roleName: s.roleName || ROLE_NAMES[s.role], status: s.status, by: s.by || "", at: s.at || null }))
    : [];
  if (valuesChanged) {
    revision.approvalSteps = [1, 2, 3].map((role) => ({ role, roleName: ROLE_NAMES[role], status: "Pending" }));
    revision.currentPendingRole = 1;
  }

  Object.entries({ ...compare, ...derived }).forEach(([k, v]) => {
    revision[k] = v;
  });
  revision.reason = reason;
  revision.invoice = nextInvoice;
  revision.editHistory = [
    ...(revision.editHistory || []),
    {
      editedBy: user?.userName || "",
      editedByUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
      editedByRole: Number(user?.userType) || null,
      editedAt: now,
      before,
      after,
      approvalsReset,
    },
  ];
  revision.updatedBy = user?.userName || "";
  await revision.save();
  return { revision, action: "updated" };
}

// active site (lean) or { error }
async function loadActiveMedia(mediaId) {
  if (!mongoose.Types.ObjectId.isValid(String(mediaId))) return { error: "mediaId is not a valid ObjectId" };
  const media = await Media.findById(mediaId).select(RENT_REVISION_MEDIA_FIELDS).lean();
  if (!media) return { error: "Media not found for given mediaId" };
  if (!(media.mediaDetails || []).some((d) => Number(d.status) === 1)) {
    return { error: "Rent revision can only be created for active media" };
  }
  return { media };
}

const newRevisionBase = (mediaId, media, user) => ({
  mediaId,
  ...siteCodeName(media),
  status: "Pending",
  currentPendingRole: 1,
  approvalSteps: [1, 2, 3].map((role) => ({ role, roleName: ROLE_NAMES[role], status: "Pending" })),
  requestedBy: user?.userName || "",
  requestedByUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
  requestedByRole: Number(user?.userType) || null,
  requestedAt: nowIST(),
});

// ✅ NEW — month of the next bill after fromMonth (generated one, else fromMonth + cycle)
function nextBillMonthAfter(media, fromDate) {
  const fromKey = monthKey(fromDate);
  const later = (media.rentalDue || [])
    .map((b) => b && monthKey(b.dueDate))
    .filter((k) => k !== null && k !== undefined && k > fromKey)
    .sort((a, b) => a - b)[0];
  return monthLabelOfKey(later !== undefined ? later : fromKey + cycleMonthsOf(media.rentalPayment));
}

// ✅ NEW — BILL revision only for CMD approved months
const notCmdApprovedError = (months) =>
  `${months.join(", ")} bill${months.length > 1 ? "s are" : " is"} not CMD approved — new bill cannot be generated`;

// one site → { revision, action } or { error }
// ✅ CHANGED — BILL: fromMonth bill + increaseAmount (GST on it only when
// gstOnIncrease 1); applyToAllMonths 1 → site rent + nextIncreaseAmount from
// the next bill (GST as the site's)
// ✅ NEW — billMonths (BILL "months" array): each listed month + its own amount
// ✅ NEW — dryRun: every check runs, nothing is saved ({ dryRun: true } when it would pass)
async function createOneRevision(mediaId, { fromDate, fromLabel, increaseAmount, applyToAllMonths, nextIncreaseAmount, gstOnIncrease, withGst = 0, reason, invoice, user, billMonths = null, billType = "BILL", revisionAction = "increase", dryRun = false }) {
  const loaded = await loadActiveMedia(mediaId);
  if (loaded.error) return loaded;
  const { media } = loaded;
  if (billMonths) return createOneMonthsRevision(mediaId, media, { billMonths, applyToAllMonths, nextIncreaseAmount, gstOnIncrease, withGst, reason, invoice, user, billType, revisionAction, dryRun }); // ✅ CHANGED — + billType / revisionAction
  const hasFromBill = (media.rentalDue || []).some(
    (b) => b && (b.dueMonth === fromLabel || monthKey(b.dueDate) === monthKey(fromDate)),
  );
  if (!hasFromBill) return { error: `No bill for ${fromLabel} on this site` };
  // ✅ NEW — BILL: fromMonth bill must be CMD approved
  const fromApproved = (media.rentalDue || []).some(
    (b) => b && (b.dueMonth === fromLabel || monthKey(b.dueDate) === monthKey(fromDate)) && Number(b.approvalStatus) === 3,
  );
  if (!fromApproved) return { error: notCmdApprovedError([fromLabel]) };

  const gstPercentage = gstPercentageFor(media, fromDate);
  if (gstPercentage > 0 && gstOnIncrease === null) {
    return { error: "This site has GST — send gstOnIncrease (1 = with GST, 0 = without GST)" };
  }
  const gstFlag = gstPercentage > 0 ? gstOnIncrease : null;

  const onlyFromMonth = applyToAllMonths === 0;
  // applyToAllMonths null (old requests) → next months take increaseAmount too
  const nextIncrease = onlyFromMonth ? null : nextIncreaseAmount ?? increaseAmount;
  const oldRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const newRent = onlyFromMonth ? oldRent : round(oldRent + nextIncrease);
  const plan = buildRevisionPlan(media, fromDate, newRent, applyToAllMonths, { fromMonthIncrease: increaseAmount, gstOnIncrease: gstFlag });
  if (plan.heldMonth) return { error: `${plan.heldMonth} is on appraisal hold — release it first` };

  const compare = {
    fromMonth: fromLabel,
    oldRent,
    increaseAmount,
    newRent,
    applyToAllMonths,
    nextIncreaseAmount: nextIncrease,
    gstOnIncrease: gstFlag,
    withGst: gstFlag === 1 ? withGst : 0, // ✅ NEW — no GST → 0
  };
  const derived = {
    billType: "BILL",
    fromDate,
    difference: increaseAmount,
    nextBillFromMonth: onlyFromMonth ? "" : nextBillMonthAfter(media, fromDate),
    gstPercentage,
    increaseGstAmount: gstFlag === 1 ? round((increaseAmount * gstPercentage) / 100) : 0,
    // ✅ NEW — single-month request: no months list (an earlier months request is replaced)
    months: undefined,
    monthsDetail: undefined,
    toMonth: "",
    totalIncreaseAmount: increaseAmount,
  };

  if (dryRun) return { dryRun: true };
  // ✅ CHANGED — already a Pending BILL revision on this site → update it (same API)
  const waiting = await RentRevision.findOne({ mediaId, status: "Pending", billType: { $ne: "ADVANCE" } });
  if (waiting) return editPendingRevision(waiting, { compare, derived, reason, invoice, user });

  const revision = await RentRevision.create({
    ...newRevisionBase(mediaId, media, user),
    ...compare,
    ...derived,
    invoice,
    reason,
  });
  return { revision, action: "created" };
}

// ✅ NEW — BILL with "months" [{ month, amount }]: on CMD approval each listed
// month gets its own amount — CMD approved bill → arrears bill of that month,
// bill not CMD approved → that bill goes up. Months between the listed ones are
// not changed. applyToAllMonths 1 → site rent + nextIncreaseAmount from the next
// bill after the LAST listed month.
// ✅ CHANGED — billType NORMAL_BILL: only months NOT CMD approved, increase /
// decrease applied at once (no approval). revisionAction "decrease" (amounts
// negative): BILL → CMD approved bill goes down after approval (applyBillDecrease)
async function createOneMonthsRevision(mediaId, media, { billMonths, applyToAllMonths, nextIncreaseAmount, gstOnIncrease, withGst = 0, reason, invoice, user, billType = "BILL", revisionAction = "increase", dryRun = false }) {
  const isNormal = billType === "NORMAL_BILL";
  const isCancel = billType === "CANCEL"; // ✅ NEW
  const isDecrease = revisionAction === "decrease";
  const billsOfMonth = (key) => (media.rentalDue || []).filter((b) => b && b.dueDate && monthKey(b.dueDate) === key);
  const missing = billMonths.find((bm) => billsOfMonth(bm.key).length === 0);
  if (missing) return { error: `No bill for ${missing.month} on this site` };
  if (isNormal) {
    // ✅ NEW — NORMAL_BILL: a CMD approved month → BILL
    const approved = billMonths.filter((bm) => billsOfMonth(bm.key).some((b) => Number(b.approvalStatus) === 3));
    if (approved.length) {
      return { error: `${approved.map((bm) => bm.month).join(", ")} bill${approved.length > 1 ? "s are" : " is"} CMD approved — use billType BILL` };
    }
  } else {
    // ✅ NEW — BILL: only CMD approved months (a month with no CMD approved bill → error)
    const notApproved = billMonths.filter((bm) => !billsOfMonth(bm.key).some((b) => Number(b.approvalStatus) === 3));
    if (notApproved.length) {
      return {
        error: isDecrease || isCancel
          ? `${notApproved.map((bm) => bm.month).join(", ")} bill${notApproved.length > 1 ? "s are" : " is"} not CMD approved — use billType NORMAL_BILL`
          : notCmdApprovedError(notApproved.map((bm) => bm.month)),
      };
    }
  }
  // ✅ NEW — CANCEL: no payment on the bill, no rent revision waiting for that month
  if (isCancel) {
    const waitingRevisions = mediaId ? await RentRevision.find({ mediaId, status: "Pending" }).lean() : [];
    for (const bm of billMonths) {
      const bills = billsOfMonth(bm.key);
      if (billHasPayment(media, bills.map((b) => b._id))) return { error: `${bm.month} bill already has a payment — cancel not allowed` };
      const busy = waitingRevisions.some((r) =>
        r.billType === "ADVANCE"
          ? r.adjustInMonth === bm.month || r.fromMonth === bm.month
          : r.fromMonth === bm.month || (r.months || []).some((x) => x && x.month === bm.month),
      );
      if (busy) return { error: `A rent revision is waiting for approval for ${bm.month} — approve or reject it first` };
    }
  }
  // ✅ NEW — decrease: less than the month's bill; BILL decrease → not paid, once per bill
  if (isDecrease) {
    for (const bm of billMonths) {
      const monthRent = Number(rentPartsForDueDate(media, bm.date).rent || 0);
      if (-bm.amount >= monthRent) return { error: `decreaseAmount must be less than the ${bm.month} bill amount (${monthRent})` };
      if (!isNormal && !isCancel) {
        const bills = billsOfMonth(bm.key);
        if (billHasPayment(media, bills.map((b) => b._id))) return { error: `${bm.month} bill already has a payment — decrease not allowed` };
        if (bills.some((b) => b.decreaseRevisionId)) return { error: `${bm.month} bill already decreased once` };
      }
    }
  }

  // ✅ NEW — month payment split: landowners of the site, a decrease cannot take
  // a mode below 0
  for (const bm of billMonths) {
    if (!bm.payment || !bm.amount) continue;
    const d = monthOwnerDeltas(media, bm.date, bm.amount, bm.payment, bm.month);
    if (d.error) return { error: d.error };
    if (bm.amount < 0) {
      const s = ownerSplitAfter(media, bm.date, d.deltas, bm.month);
      if (s.error) return { error: s.error };
    }
  }

  const first = billMonths[0];
  const last = billMonths[billMonths.length - 1];
  const gstPercentage = gstPercentageFor(media, first.date);
  // ✅ CHANGED — NORMAL_BILL / decrease: no gstOnIncrease needed — GST site → GST on the new amount
  if (!isNormal && !isCancel && !isDecrease && gstPercentage > 0 && gstOnIncrease === null) {
    return { error: "This site has GST — send gstOnIncrease (1 = with GST, 0 = without GST)" };
  }
  const gstFlag = gstPercentage > 0 ? (isNormal || isCancel || isDecrease ? 1 : gstOnIncrease) : null; // ✅ CHANGED — + CANCEL

  const onlyListed = applyToAllMonths === 0;
  // applyToAllMonths not sent → next months take the last listed month's amount
  // ✅ CHANGED — decrease → the next months go DOWN (negative)
  const nextIncrease = onlyListed ? null : nextIncreaseAmount !== null && nextIncreaseAmount !== undefined
    ? (isDecrease ? -Math.abs(nextIncreaseAmount) : nextIncreaseAmount)
    : last.amount;
  const oldRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const newRent = onlyListed ? oldRent : round(oldRent + nextIncrease);
  // ✅ NEW — decrease with applyToAllMonths 1: the site rent must stay above 0
  if (!onlyListed && newRent <= 0) return { error: `Site rent ${oldRent} cannot go down by ${Math.abs(nextIncrease)}` };
  // ✅ NEW — CANCEL: the listed months are priced as NOT approved (their
  // approval is cancelled) → their bills move to the new amount
  const planMedia = isCancel ? withMonthsNotApproved(media, billMonths.map((bm) => bm.key)) : media;
  const plan = buildRevisionPlan(planMedia, first.date, newRent, applyToAllMonths, {
    gstOnIncrease: gstFlag,
    monthIncreases: new Map(billMonths.filter((bm) => bm.amount !== 0).map((bm) => [bm.key, bm.amount])),
  });
  if (plan.heldMonth) return { error: `${plan.heldMonth} is on appraisal hold — release it first` };

  const monthsDetail = billMonths.map((bm) => {
    const monthBills = billsOfMonth(bm.key);
    const status = Math.max(...monthBills.map((b) => Number(b.approvalStatus || 1)));
    // ✅ NEW — decrease / NORMAL_BILL: the month's bill before → after (GST on the new amount)
    if (isDecrease || isNormal || isCancel) {
      const monthRent = Number(rentPartsForDueDate(media, bm.date).rent || 0);
      const monthGst = monthBills.reduce((s, b) => s + Number(b.gstAmount || 0), 0);
      const newAmount = round(monthRent + bm.amount);
      const updated = plan.billsUpdated.filter((b) => b.dueMonth === bm.month);
      const newGst = (isNormal || isCancel) && updated.length && bm.amount !== 0
        ? updated.reduce((s, b) => s + Number(b.gstAmount || 0), 0)
        : monthRent > 0 ? round((monthGst * newAmount) / monthRent) : 0;
      return {
        month: bm.month,
        rentalDueId: monthBills[0]._id,
        billStatus: BILL_APPROVAL_LABELS[status] || "Pending",
        currentAmount: monthRent,
        ...(bm.amount < 0 ? { decreaseAmount: -bm.amount } : bm.amount > 0 ? { increaseAmount: bm.amount } : {}),
        amount: bm.amount,
        newAmount,
        gstAmount: newGst,
        action: isCancel ? "cancelApproval" : isNormal ? "billUpdate" : "billDecrease", // ✅ CHANGED — + cancelApproval
        ...(isCancel ? { cancelledBillNo: monthBills.map((b) => b.adinn_ooh_bills).find(Boolean) || null } : {}), // ✅ NEW
      };
    }
    const arrears = plan.arrearsBills.filter((b) => b.dueMonth === bm.month || monthKey(b.dueDate) === bm.key);
    const updated = plan.billsUpdated.filter((b) => b.dueMonth === bm.month);
    const pct = gstPercentageFor(media, bm.date);
    const gstAmount = gstFlag === 1 ? round((bm.amount * pct) / 100) : 0;
    const currentAmount = arrears.length ? Number(arrears[0].oldMonthRent || 0) : updated.reduce((s, b) => s + Number(b.oldAmount || 0), 0);
    return {
      month: bm.month,
      rentalDueId: monthBills[0]._id,
      billStatus: BILL_APPROVAL_LABELS[status] || "Pending",
      currentAmount,
      amount: bm.amount,
      gstAmount,
      totalAmount: bm.amount + gstAmount,
      newAmount: currentAmount + bm.amount,
      action: status === 3 ? "arrears" : "billUpdate",
    };
  });
  const totalIncreaseAmount = billMonths.reduce((s, bm) => s + bm.amount, 0);
  // ✅ NEW — month payment split shown on each month
  monthsDetail.forEach((d, i) => {
    if (billMonths[i] && billMonths[i].payment && billMonths[i].amount) d.payment = billMonths[i].payment;
  });

  const compare = {
    months: billMonths.map((bm) => ({ month: bm.month, amount: bm.amount, ...(bm.payment && bm.amount ? { payment: bm.payment } : {}) })), // ✅ CHANGED — + payment split
    oldRent,
    newRent,
    applyToAllMonths,
    nextIncreaseAmount: nextIncrease,
    gstOnIncrease: gstFlag,
    withGst: gstFlag === 1 ? withGst : 0, // ✅ NEW — no GST → 0
  };
  const derived = {
    billType: isCancel ? "CANCEL" : isNormal ? "NORMAL_BILL" : "BILL", // ✅ CHANGED
    revisionAction, // ✅ NEW
    approvalType: isNormal || isCancel ? "auto" : "normal", // ✅ NEW
    fromMonth: first.month,
    fromDate: first.date,
    toMonth: last.month,
    increaseAmount: totalIncreaseAmount,
    difference: totalIncreaseAmount,
    totalIncreaseAmount,
    monthsDetail,
    nextBillFromMonth: onlyListed ? "" : nextBillMonthAfter(media, last.date),
    gstPercentage,
    // ✅ CHANGED — decrease / NORMAL_BILL: GST change of the bills (new − old)
    increaseGstAmount: isDecrease || isNormal || isCancel
      ? monthsDetail.reduce((s, d) => {
          const oldGst = billsOfMonth(billMonths.find((bm) => bm.month === d.month).key).reduce((t, b) => t + Number(b.gstAmount || 0), 0);
          return s + (Number(d.gstAmount || 0) - oldGst);
        }, 0)
      : monthsDetail.reduce((s, d) => s + d.gstAmount, 0),
  };

  if (dryRun) return { dryRun: true };

  // ✅ NEW — CANCEL: saved as Approved (no rent revision approval); the bills'
  // approval is cancelled (back to Rental Executive), the amount changed (if
  // sent) and the cancel mail sent
  if (isCancel) {
    const now = nowIST();
    const revision = await RentRevision.create({
      ...newRevisionBase(mediaId, media, user),
      status: "Approved",
      currentPendingRole: null,
      approvalSteps: [],
      approvedAt: now,
      ...compare,
      ...derived,
      invoice,
      reason,
    });
    try {
      const cancelled = await cancelBillApprovals(revision, media, user, monthsDetail);
      let result = { billsUpdated: [] };
      if (billMonths.some((bm) => bm.amount !== 0)) {
        result = await applyRevision(revision, planMedia, user?.userName || "");
      } else {
        await pushCancelHistory(revision, media, user?.userName || "", now);
      }
      revision.monthsDetail = monthsDetail.map((d) => {
        const updated = (result.billsUpdated || []).filter((b) => b.dueMonth === d.month);
        return {
          ...d,
          ...(updated.length && d.amount !== 0 ? { gstAmount: updated.reduce((s, b) => s + Number(b.gstAmount || 0), 0) } : {}),
          billApprovalAfter: { approvalStatus: 1, approvalStatusLabel: "Pending", currentPendingRole: 1, currentPendingRoleName: ROLE_NAMES[1] },
        };
      });
      revision.arrearsTotal = 0;
      revision.cancelMail = await sendCancelMails(media, revision, cancelled);
      await revision.save();
    } catch (e) {
      console.error("CANCEL rent revision error:", e);
      revision.cancelMail = { mailSent: false, message: `Cancel stopped: ${e?.message || e}` };
      await revision.save().catch(() => {});
      return { error: e?.message || "Bill approval could not be cancelled" };
    }
    return { revision, action: "created" };
  }

  // ✅ NEW — NORMAL_BILL: saved as Approved (no approval) and applied at once
  if (isNormal) {
    const now = nowIST();
    const revision = await RentRevision.create({
      ...newRevisionBase(mediaId, media, user),
      status: "Approved",
      currentPendingRole: null,
      approvalSteps: [],
      approvedAt: now,
      ...compare,
      ...derived,
      invoice,
      reason,
    });
    try {
      const result = await applyRevision(revision, media, user?.userName || "");
      revision.monthsDetail = monthsDetail.map((d) => {
        const updated = (result.billsUpdated || []).filter((b) => b.dueMonth === d.month);
        return updated.length
          ? { ...d, rentalDueId: updated[0].rentalDueId, gstAmount: updated.reduce((s, b) => s + Number(b.gstAmount || 0), 0) }
          : d;
      });
      revision.arrearsTotal = 0;
      await revision.save();
    } catch (e) {
      await RentRevision.deleteOne({ _id: revision._id });
      return { error: e?.message || "Bill could not be updated" };
    }
    return { revision, action: "created" };
  }

  // already a Pending BILL revision on this site → update it (same API)
  const waiting = await RentRevision.findOne({ mediaId, status: "Pending", billType: { $nin: ["ADVANCE", ...AUTO_BILL_TYPES] } }); // ✅ CHANGED — + CANCEL
  // ✅ NEW — a Pending increase and a decrease (or the other way) are not mixed
  if (waiting && (waiting.revisionAction || "increase") !== revisionAction) {
    return {
      error: `A ${waiting.revisionAction || "increase"} rent revision is already waiting for approval on this site — approve or reject it first`,
      revisionId: waiting._id,
    };
  }
  if (waiting) return editPendingRevision(waiting, { compare, derived, reason, invoice, user });

  const revision = await RentRevision.create({
    ...newRevisionBase(mediaId, media, user),
    ...compare,
    ...derived,
    invoice,
    reason,
  });
  return { revision, action: "created" };
}

// ✅ NEW — CANCEL: plain copy of the media with the listed months' bills as NOT
// approved (approvalStatus 1) → buildRevisionPlan moves them to the new amount
function withMonthsNotApproved(media, keys) {
  const set = new Set(keys);
  return {
    ...media,
    rentalDue: (media.rentalDue || []).map((b) =>
      b && b.dueDate && set.has(monthKey(b.dueDate)) ? { ...b, approvalStatus: 1, status: 1 } : b,
    ),
  };
}

// ✅ NEW — CANCEL: every bill of the listed months back to Pending (Rental
// Executive first, agreement verify again). The old approval (steps, owner
// approval date, ADINN OOH number, mail flag) → bill.approvalResetHistory[].
// Unpaid GST balance rows of those bills are removed (made again on
// re-approval). The ADINN OOH registry entry is closed so re-approval gives a
// NEW number (the old number is never reused). Returns [{ month, bills }].
async function cancelBillApprovals(revision, media, user, monthsDetail) {
  const now = nowIST();
  const userName = user?.userName || "";
  const detailByMonth = new Map((monthsDetail || []).map((d) => [d.month, d]));
  const $set = { updatedAt: now };
  const $push = {};
  const arrayFilters = [];
  const billIds = [];
  const cancelled = [];
  let fi = 0;
  (revision.months || []).forEach((x) => {
    const date = parseFromMonth(x?.month);
    if (!date) return;
    const key = monthKey(date);
    const bills = (media.rentalDue || []).filter((b) => b && b.dueDate && monthKey(b.dueDate) === key);
    const d = detailByMonth.get(x.month) || {};
    bills.forEach((b) => {
      const u = `c${fi++}`;
      billIds.push(b._id);
      const steps = Array.isArray(b.approvalSteps) && b.approvalSteps.length ? b.approvalSteps : [{ role: 1 }, { role: 2 }, { role: 3 }];
      const resetSteps = steps.map((st) => ({ role: st.role, userId: null, userName: "", approvedAt: null, status: 1, docVerified: false, remarks: "" }));
      $set[`rentalDue.$[${u}].approvalStatus`] = 1;
      $set[`rentalDue.$[${u}].status`] = 1;
      $set[`rentalDue.$[${u}].currentPendingRole`] = Number(resetSteps[0]?.role || 1);
      $set[`rentalDue.$[${u}].approvalSteps`] = resetSteps;
      $set[`rentalDue.$[${u}].agreementDocVerified`] = false;
      $set[`rentalDue.$[${u}].ownerApprovalDate`] = null;
      $set[`rentalDue.$[${u}].mailSent`] = false;
      $set[`rentalDue.$[${u}].adinn_ooh_bills`] = null;
      $set[`rentalDue.$[${u}].adinn_ooh_bills_landOwners`] = [];
      $set[`rentalDue.$[${u}].gstAddedToBalance`] = false;
      $set[`rentalDue.$[${u}].ownerGstAddedToBalance`] = false;
      $set[`rentalDue.$[${u}].updatedBy`] = `${userName} (Approval Cancelled)`;
      $set[`rentalDue.$[${u}].updatedAt`] = now;
      $set[`rentalDue.$[${u}].approvalResetHistory`] = [
        ...(Array.isArray(b.approvalResetHistory) ? b.approvalResetHistory : []),
        {
          cancelledAt: now,
          cancelledBy: userName,
          cancelledByUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
          cancelledByRole: Number(user?.userType) || null,
          cancelledByRoleName: ROLE_NAMES[Number(user?.userType)] || "",
          reason: revision.reason || "",
          rentRevisionId: revision._id,
          amountBefore: Number(b.netPayable || 0),
          monthAmountBefore: d.currentAmount ?? null,
          monthAmountAfter: d.newAmount ?? null,
          previousApprovalStatus: Number(b.approvalStatus || 0),
          previousApprovalSteps: steps,
          previousOwnerApprovalDate: b.ownerApprovalDate || null,
          previousMailSent: !!b.mailSent,
          adinn_ooh_bills: b.adinn_ooh_bills || null,
          adinn_ooh_bills_landOwners: b.adinn_ooh_bills_landOwners || [],
          // ✅ NEW — cancel revert: everything needed to bring the bill back
          previousStatus: b.status ?? null,
          previousCurrentPendingRole: b.currentPendingRole ?? null,
          previousAgreementDocVerified: b.agreementDocVerified ?? null,
          previousNetPayable: b.netPayable ?? null,
          previousBaseAmount: b.baseAmount ?? null,
          previousGstAmount: b.gstAmount ?? null,
          previousGstAddedToBalance: !!b.gstAddedToBalance,
          previousOwnerGstAddedToBalance: !!b.ownerGstAddedToBalance,
          removedGstRows: (media.gstBalanceHistory || []).filter(
            (g) => g && String(g.rentalDueId) === String(b._id) && !g.isPaid && !g.isUtrEntry && !(Number(g.paidAmount || 0) > 0),
          ),
        },
      ];
      arrayFilters.push({ [`${u}._id`]: b._id });
    });
    cancelled.push({ month: x.month, bills });
  });
  if (!billIds.length) return cancelled;
  await Media.updateOne({ _id: media._id }, Object.keys($push).length ? { $set, $push } : { $set }, { arrayFilters, strict: false });

  // unpaid GST balance rows of the cancelled bills → removed (re-created on re-approval)
  const idSet = new Set(billIds.map(String));
  const unpaidGst = (media.gstBalanceHistory || []).filter(
    (g) => g && idSet.has(String(g.rentalDueId)) && !g.isPaid && !g.isUtrEntry && !(Number(g.paidAmount || 0) > 0),
  );
  if (unpaidGst.length) {
    const drop = unpaidGst.reduce((s, g) => s + Math.max(0, Number(g.gstAmount || 0) - Number(g.paidAmount || 0)), 0);
    await Media.updateOne(
      { _id: media._id },
      {
        $pull: { gstBalanceHistory: { _id: { $in: unpaidGst.map((g) => g._id) } } },
        ...(drop > 0 ? { $inc: { "rentalPayment.balanceGstAmount": -drop } } : {}),
      },
    );
  }

  // ADINN OOH registry: close the old entry → re-approval gets a NEW number
  try {
    const Registry = require("../../../models/Admin/AdinnOohBillRegistrySchema");
    await Registry.updateMany(
      { rentalDueIds: { $in: billIds }, groupKey: { $not: /\|cancelled:/ } },
      [{ $set: { groupKey: { $concat: ["$groupKey", `|cancelled:${String(revision._id)}`] } } }],
    );
  } catch (e) {
    console.error("CANCEL registry update error:", e.message);
  }
  return cancelled;
}

// ✅ NEW — CANCEL without an amount change: one rentalAmountHistory log row per month
async function pushCancelHistory(revision, media, userName, now) {
  const siteRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const rows = revisionMonthRows(revision).map((r) =>
    revisionHistoryRow(revision, { siteRent, ...r, userName, now, extra: { isRevisionLog: true } }),
  );
  if (!rows.length) return;
  await Media.updateOne(
    { _id: media._id },
    { $push: { "rentalPayment.rentalAmountHistory": { $each: rows, $sort: { updatedAt: -1 } } } },
    { strict: false },
  );
}

// ✅ NEW — CANCEL mail: a reply to the CMD approval mail (same subject with
// "Re:") — "This amount was cancelled." + the reason. One mail per month.
const CMD_APPROVAL_MAIL_URL = "https://adinndigital.com/api/outdoormedia/cmdApprovalSK.php";
const CMD_CANCEL_MAIL_TYPE = "cmdapprovalcancel";
function cmdApprovalSubjectFor(media, bills) {
  const owners = media.landOwners || [];
  const names = owners.map((o) => String(o.name || "").trim()).filter(Boolean);
  const ownerPart = owners.length > 1 ? (names.length ? names.join(", ") : "Multiple Landlords") : names[0] || "";
  const faces = media.mediaDetails || [];
  const codes = [
    ...new Set(
      (bills || [])
        .map((b) => (faces.find((f) => String(f._id) === String(b.mediaDetailId)) || {}).mediaCode)
        .filter(Boolean),
    ),
  ];
  const codePart = (codes.length ? codes : faces.filter((f) => Number(f.status) === 1).map((f) => f.mediaCode).filter(Boolean)).join(", ");
  const parts = [ownerPart, codePart].filter(Boolean);
  return `CMD Payment Approved${parts.length ? ` - ${parts.join(" - ")}` : ""}`;
}
async function sendCancelMails(media, revision, cancelled) {
  const to = mailEmailList(process.env.T0_EMail);
  const cc = mailEmailList(process.env.CC_EMail);
  const mailMode = process.env.MAIL_MODE || "development";
  const results = [];
  // ✅ NEW — mail details: bill no / month / media / amount / cancelled by
  const faces = media.mediaDetails || [];
  const uniq = (list) => [...new Set(list.filter(Boolean))].join(", ");
  const roleName = ROLE_NAMES[Number(revision.requestedByRole)] || "";
  const at = revision.approvedAt || revision.createdAt || nowIST(); // nowIST → IST clock in UTC fields
  const atD = new Date(at);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h24 = atD.getUTCHours();
  const cancelledAt = `${atD.getUTCDate()} ${MON[atD.getUTCMonth()]} ${atD.getUTCFullYear()} ${h24 % 12 || 12}:${String(atD.getUTCMinutes()).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
  for (const c of cancelled || []) {
    const billFaces = (c.bills || []).map((b) => faces.find((f) => String(f._id) === String(b.mediaDetailId)) || {});
    const payload = {
      mailtype: CMD_CANCEL_MAIL_TYPE,
      to,
      ...(cc.length ? { cc } : {}),
      data: {
        subject: `Re: ${cmdApprovalSubjectFor(media, c.bills)}`,
        billNo: uniq((c.bills || []).map((b) => b.adinn_ooh_bills)),
        month: c.month || "",
        mediaCode: uniq(billFaces.map((f) => f.mediaCode)),
        mediaName: uniq(billFaces.map((f) => f.mediaName)),
        amount: (c.bills || []).reduce((s, b) => s + Number(b.netPayable || 0), 0),
        gstAmount: (c.bills || []).reduce((s, b) => s + Number(b.gstAmount || 0), 0),
        cancelledBy: revision.requestedBy || "",
        cancelledByRoleName: roleName,
        cancelledAt,
        reason: revision.reason || "",
      },
    };
    console.log("📧 CMD CANCEL MAIL PAYLOAD:", JSON.stringify(payload, null, 2));
    if (mailMode !== "production") {
      results.push({ month: c.month, sent: false, message: `Mail skipped (MAIL_MODE=${mailMode}) — not sent` });
      continue;
    }
    try {
      const response = await axios.post(CMD_APPROVAL_MAIL_URL, payload, { headers: { "Content-Type": "application/json" } });
      const sent = !!(response.data && (response.data.status === "success" || response.data.success === true));
      results.push({ month: c.month, sent, message: sent ? "Cancel mail sent" : response.data?.message || "Cancel mail failed" });
    } catch (err) {
      results.push({ month: c.month, sent: false, message: err?.response?.data?.message || err?.message || "Mail error" });
    }
  }
  const sent = results.length > 0 && results.every((r) => r.sent);
  return { mailtype: CMD_CANCEL_MAIL_TYPE, mailSent: sent, mailSentAt: sent ? nowIST() : null, months: results, message: results.map((r) => `${r.month}: ${r.message}`).join("; ") };
}

// ✅ NEW — any payment (ledger / GST UTR) on these bills (rentalDue ids)
function billHasPayment(media, billIds) {
  const ids = new Set((billIds || []).map(String));
  const hit = (e) => e && e.rentalDueId && ids.has(String(e.rentalDueId));
  if ((media.ledger || []).some(hit) || (media.withGst1Ledger || []).some(hit)) return true;
  if ((media.ledgerHistory || []).some((y) => (y.months || []).some((m) => (m.entries || []).some(hit)))) return true;
  return (media.gstBalanceHistory || []).some((g) => hit(g) && (g.isPaid === true || g.isUtrEntry === true || Number(g.paidAmount || 0) > 0));
}

// ✅ NEW — CANCEL revert: the bills cancelled by this CANCEL revision go back to
// CMD approved with their old approval, amount, ADINN OOH number and unpaid GST
// balance rows (all kept in bill.approvalResetHistory at cancel time). The
// cancel's amount change is undone (kept months removed, site rent back when the
// cancel changed it, its arrears bills removed). No mail. Any role.
// Returns { statusCode, message, data }.
async function revertCancelRevision(revisionId, { reason, user }) {
  if (!mongoose.Types.ObjectId.isValid(String(revisionId))) return { statusCode: 400, message: "Invalid revisionId" };
  const revision = await RentRevision.findById(revisionId);
  if (!revision || revision.billType !== "CANCEL" || revision.status !== "Approved") {
    return { statusCode: 400, message: "Only CANCEL revision can be reverted" };
  }
  if (revision.cancelReverted) return { statusCode: 400, message: "This cancel is already reverted" };
  const media = await Media.findById(revision.mediaId).lean();
  if (!media) return { statusCode: 404, message: "Media not found" };

  const revId = String(revision._id);
  const userName = user?.userName || "";
  const role = Number(user?.userType) || null;
  const now = nowIST();
  const lastReset = (b) => {
    const h = Array.isArray(b.approvalResetHistory) ? b.approvalResetHistory : [];
    return h.length ? h[h.length - 1] : null;
  };

  // bills of each cancelled month (the ones whose reset history has this revision)
  const months = (revision.months || [])
    .map((x) => ({ month: x?.month, date: parseFromMonth(x?.month) }))
    .filter((x) => x.month && x.date)
    .map((x) => ({
      ...x,
      key: monthKey(x.date),
      bills: (media.rentalDue || []).filter(
        (b) => b && Array.isArray(b.approvalResetHistory) && b.approvalResetHistory.some((h) => h && String(h.rentRevisionId) === revId),
      ).filter((b) => b.dueDate && monthKey(b.dueDate) === monthKey(x.date)),
    }));
  if (!months.length) return { statusCode: 400, message: "No cancelled month on this revision" };
  for (const mo of months) {
    if (!mo.bills.length) return { statusCode: 400, message: `No cancelled bill for ${mo.month} on this site` };
    for (const b of mo.bills) {
      const last = lastReset(b);
      if (!last || String(last.rentRevisionId) !== revId || last.revertedAt) {
        return { statusCode: 400, message: `${mo.month} bill was cancelled again later — revert not allowed` };
      }
      if (Number(b.approvalStatus) === 3) {
        return { statusCode: 400, message: `${mo.month} bill already CMD approved again — revert not allowed` };
      }
    }
    if (billHasPayment(media, mo.bills.map((b) => b._id))) {
      return { statusCode: 400, message: `${mo.month} bill already has a payment — revert not allowed` };
    }
  }

  // a later revision on these months (or any later applied one when the cancel changed the site rent)
  const monthSet = new Set(months.map((mo) => mo.month));
  const oldRent = Number(revision.oldRent || 0);
  const newRent = Number(revision.newRent || 0);
  const siteRentChanged = oldRent > 0 && newRent > 0 && oldRent !== newRent;
  const later = await RentRevision.find({
    mediaId: revision.mediaId,
    _id: { $ne: revision._id },
    createdAt: { $gt: revision.createdAt },
    status: { $in: ["Pending", "Approved"] },
  }).lean();
  for (const r of later) {
    const touched = [r.fromMonth, r.adjustInMonth, ...(r.months || []).map((x) => x && x.month)].find((m) => m && monthSet.has(m));
    if (touched) return { statusCode: 400, message: `${touched} has a later revision — revert not allowed` };
  }
  if (siteRentChanged) {
    if (later.some((r) => r.status === "Approved" && r.billType !== "ADVANCE")) {
      return { statusCode: 400, message: "A later rent revision was applied on this site — revert not allowed" };
    }
    if (Number(media.rentalPayment?.totalRentalAmount || 0) !== newRent) {
      return { statusCode: 400, message: "Site rent changed after this cancel — revert not allowed" };
    }
  }

  // arrears bills made by this cancel (CMD approved months after it) → removed
  const arrears = (media.arrearsDue || []).filter((a) => a && String(a.rentRevisionId) === revId);
  if (arrears.some((a) => Number(a.approvalStatus) === 3) || billHasPayment(media, arrears.map((a) => a._id))) {
    return { statusCode: 400, message: "Arrears bill of this cancel is already approved / paid — revert not allowed" };
  }

  // ── bills back to CMD approved ──
  const $set = { updatedAt: now };
  const arrayFilters = [];
  const gstRowsBack = [];
  const resultMonths = [];
  let fi = 0;
  const faces = media.mediaDetails || [];
  const cancelledIds = new Set();
  for (const mo of months) {
    const billsOut = [];
    let monthGstRowsBack = false;
    for (const b of mo.bills) {
      cancelledIds.add(String(b._id));
      const last = lastReset(b);
      const u = `r${fi++}`;
      const curNet = Number(b.netPayable || 0);
      // amount: old values (older cancels: only amountBefore → base / GST scaled)
      let net = curNet;
      let base = Number(b.baseAmount || 0);
      let gst = Number(b.gstAmount || 0);
      if (last.previousNetPayable !== undefined && last.previousNetPayable !== null) {
        net = Number(last.previousNetPayable);
        base = Number(last.previousBaseAmount ?? base);
        gst = Number(last.previousGstAmount ?? gst);
      } else if (last.amountBefore !== undefined && last.amountBefore !== null && curNet > 0 && Number(last.amountBefore) !== curNet) {
        const ratio = Number(last.amountBefore) / curNet;
        net = Number(last.amountBefore);
        base = round(base * ratio);
        gst = round(gst * ratio);
      }
      const discardedSteps = (b.approvalSteps || []).filter((s) => s && (s.userName || s.approvedAt));

      $set[`rentalDue.$[${u}].approvalStatus`] = Number(last.previousApprovalStatus || 3);
      $set[`rentalDue.$[${u}].status`] = last.previousStatus ?? 3;
      $set[`rentalDue.$[${u}].currentPendingRole`] = last.previousCurrentPendingRole ?? null;
      $set[`rentalDue.$[${u}].approvalSteps`] = last.previousApprovalSteps || b.approvalSteps || [];
      $set[`rentalDue.$[${u}].agreementDocVerified`] = last.previousAgreementDocVerified ?? true;
      $set[`rentalDue.$[${u}].ownerApprovalDate`] = last.previousOwnerApprovalDate || null;
      $set[`rentalDue.$[${u}].mailSent`] = !!last.previousMailSent;
      $set[`rentalDue.$[${u}].adinn_ooh_bills`] = last.adinn_ooh_bills || null;
      $set[`rentalDue.$[${u}].adinn_ooh_bills_landOwners`] = last.adinn_ooh_bills_landOwners || [];
      $set[`rentalDue.$[${u}].netPayable`] = net;
      $set[`rentalDue.$[${u}].baseAmount`] = base;
      $set[`rentalDue.$[${u}].gstAmount`] = gst;
      $set[`rentalDue.$[${u}].updatedBy`] = `${userName} (Cancel Reverted)`;
      $set[`rentalDue.$[${u}].updatedAt`] = now;

      // unpaid GST balance rows removed by the cancel → back
      if (Array.isArray(last.removedGstRows)) {
        gstRowsBack.push(...last.removedGstRows);
        $set[`rentalDue.$[${u}].gstAddedToBalance`] = !!last.previousGstAddedToBalance;
        $set[`rentalDue.$[${u}].ownerGstAddedToBalance`] = !!last.previousOwnerGstAddedToBalance;
      } else if (Number(b.withGst) === 1 && !monthGstRowsBack) {
        // older cancel (rows not kept): one GST hold row for the month, like approval
        const monthGst = mo.bills.reduce((s, x) => s + Number(x === b ? gst : x.gstAmount || 0), 0);
        const hasRow = (media.gstBalanceHistory || []).some((g) => g && g.dueMonth === b.dueMonth);
        if (monthGst > 0 && !hasRow) {
          gstRowsBack.push({
            rentalDueId: b._id,
            dueMonth: b.dueMonth,
            cycle: b.dueDate,
            gstAmount: monthGst,
            isPaid: false,
            paidAmount: 0,
            paidAt: null,
            paidBy: "",
            createdAt: now,
            createdBy: `${userName} (Cancel Reverted)`,
            source: "rental",
            ownerId: null,
            ownerName: "",
          });
        }
        monthGstRowsBack = true;
        $set[`rentalDue.$[${u}].gstAddedToBalance`] = true;
      } else {
        $set[`rentalDue.$[${u}].gstAddedToBalance`] = Number(b.withGst) === 1;
      }

      $set[`rentalDue.$[${u}].approvalResetHistory`] = [
        ...b.approvalResetHistory.slice(0, -1),
        {
          ...last,
          revertedAt: now,
          revertedBy: userName,
          revertedByUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
          revertedByRole: role,
          revertedByRoleName: ROLE_NAMES[role] || "",
          revertReason: reason,
          discardedSteps,
        },
      ];
      arrayFilters.push({ [`${u}._id`]: b._id });
      billsOut.push({
        rentalDueId: b._id,
        mediaCode: (faces.find((f) => String(f._id) === String(b.mediaDetailId)) || {}).mediaCode || "",
        approvalStatus: Number(last.previousApprovalStatus || 3),
        amountBeforeRevert: curNet,
        amountAfterRevert: net,
        adinn_ooh_bills: last.adinn_ooh_bills || null,
        discardedSteps,
      });
    }
    resultMonths.push({ month: mo.month, bills: billsOut });
  }

  // ── site rent back (the cancel changed it) ──
  const lastListedKey = Math.max(...months.map((mo) => mo.key));
  if (siteRentChanged) {
    const s = oldRent / newRent;
    const scale = (v) => (v === undefined || v === null ? v : round(Number(v) * s));
    const rp = media.rentalPayment || {};
    $set["rentalPayment.totalRentalAmount"] = oldRent;
    if (rp.gstAmount !== undefined && rp.gstAmount !== null) $set["rentalPayment.gstAmount"] = scale(rp.gstAmount);
    if (rp.totalRentalAmountWithGst !== undefined && rp.totalRentalAmountWithGst !== null) $set["rentalPayment.totalRentalAmountWithGst"] = scale(rp.totalRentalAmountWithGst);
    if (rp.netPayable !== undefined && rp.netPayable !== null) $set["rentalPayment.netPayable"] = scale(rp.netPayable);
    if (Number(media.appraisal?.applicable) !== 1 && media.appraisal) {
      $set["appraisal.currentRent"] = oldRent;
      $set["appraisal.totalAppraisalAmount"] = oldRent;
    }
    $set.landOwners = (media.landOwners || []).map((o) => ({
      ...o,
      shareAmount: scale(o.shareAmount),
      cashAmount: scale(o.cashAmount),
      onlineAmount: scale(o.onlineAmount),
      gstAmount: scale(o.gstAmount),
      tdsAmount: scale(o.tdsAmount),
      totalAmountWithGst: scale(o.totalAmountWithGst),
      netPayableToOwner: scale(o.netPayableToOwner),
      netPayable: scale(o.netPayable),
      linkedSites: Array.isArray(o.linkedSites)
        ? o.linkedSites.map((ls) =>
            String(ls?.mediaId) === String(media._id)
              ? { ...ls, shareAmount: scale(ls.shareAmount), cashAmount: scale(ls.cashAmount), onlineAmount: scale(ls.onlineAmount) }
              : ls,
          )
        : o.linkedSites,
    }));
    // pending bills after the cancelled months (moved to the new rent) → old rent
    (media.rentalDue || [])
      .filter(
        (b) =>
          b && b.dueDate && monthKey(b.dueDate) > lastListedKey && !cancelledIds.has(String(b._id)) &&
          Number(b.approvalStatus) !== 3 && !billHasPayment(media, [b._id]),
      )
      .forEach((b) => {
        const u = `p${fi++}`;
        const oldAmount = Number(b.netPayable || 0);
        const g = Number(b.gstAmount || 0);
        const newGst = round(g * s);
        const gstInNet = Number(b.withGst) === 2 ? g : 0;
        $set[`rentalDue.$[${u}].netPayable`] = round((oldAmount - gstInNet) * s) + (gstInNet ? newGst : 0);
        $set[`rentalDue.$[${u}].baseAmount`] = round((Number(b.baseAmount || 0) - g) * s) + newGst;
        $set[`rentalDue.$[${u}].gstAmount`] = newGst;
        $set[`rentalDue.$[${u}].updatedBy`] = `${userName} (Cancel Reverted)`;
        arrayFilters.push({ [`${u}._id`]: b._id });
      });
  }

  await Media.updateOne({ _id: media._id }, { $set }, { arrayFilters, strict: false });

  // kept months / arrears of the cancel → removed; GST rows back
  const gstBack = gstRowsBack.reduce((t, g) => t + Math.max(0, Number(g.gstAmount || 0) - Number(g.paidAmount || 0)), 0);
  await Media.updateOne(
    { _id: media._id },
    {
      $pull: {
        "rentalPayment.rentRevisionKeptMonths": { rentRevisionId: revision._id },
        ...(arrears.length ? { arrearsDue: { _id: { $in: arrears.map((a) => a._id) } } } : {}),
      },
    },
    { strict: false },
  );
  if (gstRowsBack.length) {
    await Media.updateOne(
      { _id: media._id },
      { $push: { gstBalanceHistory: { $each: gstRowsBack } }, ...(gstBack > 0 ? { $inc: { "rentalPayment.balanceGstAmount": gstBack } } : {}) },
      { strict: false },
    );
  }

  // rentalAmountHistory: the cancel's site rent row no longer a rent change
  // (kept as a log) + one revert log row per month
  const hasRentRow = (media.rentalPayment?.rentalAmountHistory || []).some(
    (h) => h && String(h.rentRevisionId) === revId && h.isRevisionLog !== true,
  );
  if (hasRentRow) {
    await Media.updateOne(
      { _id: media._id },
      { $set: { "rentalPayment.rentalAmountHistory.$[h].isRevisionLog": true, "rentalPayment.rentalAmountHistory.$[h].cancelReverted": true } },
      { arrayFilters: [{ "h.rentRevisionId": revision._id, "h.isRevisionLog": { $ne: true } }], strict: false },
    );
  }
  const siteRentNow = siteRentChanged ? oldRent : Number(media.rentalPayment?.totalRentalAmount || 0);
  const detailByMonth = new Map((revision.monthsDetail || []).map((d) => [d && d.month, d]));
  const historyRows = months.map((mo) => {
    const d = detailByMonth.get(mo.month) || {};
    const amt = Number(d.amount || 0);
    return revisionHistoryRow(revision, {
      siteRent: siteRentNow,
      previousSiteRent: siteRentChanged ? newRent : siteRentNow,
      month: mo.month,
      changeAmount: amt ? -amt : 0,
      before: d.newAmount ?? null,
      after: d.currentAmount ?? null,
      userName,
      now,
      extra: { isRevisionLog: true, changeType: "cancelRevert", changeLabel: CHANGE_LABELS.cancelRevert, remark: reason },
    });
  });
  await Media.updateOne(
    { _id: media._id },
    { $push: { "rentalPayment.rentalAmountHistory": { $each: historyRows, $sort: { updatedAt: -1 } } } },
    { strict: false },
  );

  // ADINN OOH registry: the closed entry back to its old key (old number again)
  try {
    const Registry = require("../../../models/Admin/AdinnOohBillRegistrySchema");
    const suffix = `|cancelled:${revId}`;
    const entries = await Registry.find({ groupKey: { $regex: `\\|cancelled:${revId}$` } }).lean();
    for (const e of entries) {
      try {
        await Registry.updateOne({ _id: e._id }, { $set: { groupKey: e.groupKey.slice(0, -suffix.length) } });
      } catch (err) {
        console.error("CANCEL revert registry key error:", err.message);
      }
    }
  } catch (e) {
    console.error("CANCEL revert registry error:", e.message);
  }

  revision.cancelReverted = true;
  revision.cancelRevert = {
    revertedAt: now,
    revertedBy: userName,
    revertedByUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
    revertedByRole: role,
    revertedByRoleName: ROLE_NAMES[role] || "",
    reason,
    siteRentReverted: siteRentChanged ? { from: newRent, to: oldRent } : null,
    arrearsRemoved: arrears.map((a) => a._id),
    months: resultMonths,
  };
  revision.updatedBy = userName;
  revision.markModified("cancelRevert");
  await revision.save();

  return {
    statusCode: 200,
    message: `Cancel reverted — ${months.map((mo) => mo.month).join(", ")} bill${months.length > 1 ? "s" : ""} back to CMD approved`,
    data: {
      revisionId: revision._id,
      billType: "CANCEL",
      cancelReverted: true,
      cancelRevert: {
        revertedAt: now,
        revertedBy: userName,
        revertedByRole: role,
        revertedByRoleName: ROLE_NAMES[role] || "",
        reason,
      },
      months: resultMonths,
    },
  };
}

// ✅ NEW — advance withGst 1 / 2 vs the bill it is deducted from: that bill's
// withGst decided (1 / 2) and different → error message, else null
function advanceWithGstError(media, adjustInMonth, withGst) {
  if (!(Number(withGst) > 0)) return null;
  const decided = (media.rentalDue || [])
    .filter((b) => b && b.dueMonth === adjustInMonth)
    .map((b) => Number(b.withGst || 0))
    .filter((w) => w > 0);
  if (!decided.length || decided.includes(Number(withGst))) return null;
  const billWithGst = decided[0];
  return `${adjustInMonth} bill is ${WITH_GST_LABELS[billWithGst]} (${billWithGst}) — withGst must be ${billWithGst}`;
}

// ✅ NEW — New Bill / advance doc + the revision's withGst (1 / 2, bill has GST):
// withGst and withGstFromRevision set; 0 → doc unchanged (as per the bill)
function withRevisionGst(bill, revision) {
  const w = Number(revision?.withGst || 0);
  if (!(w > 0) || !(Number(bill.gstAmount || 0) > 0)) return bill;
  return { ...bill, withGst: w, withGstFromRevision: w };
}

// ✅ NEW — ADVANCE: advanceAmount asked in advanceMonth, deducted from the next bill
async function createOneAdvance(mediaId, { advanceDate, advanceLabel, advanceAmount, adjustInDate = null, advancePayment = null, gstOnIncrease, withGst = 0, reason, invoice, user, dryRun = false }) { // ✅ CHANGED — + advancePayment
  const loaded = await loadActiveMedia(mediaId);
  if (loaded.error) return loaded;
  const { media } = loaded;
  // ✅ NEW — month payment split: landowners of the site
  if (advancePayment) {
    const d = monthOwnerDeltas(media, advanceDate, advanceAmount, advancePayment, advanceLabel);
    if (d.error) return { error: d.error };
  }

  const probe = buildAdvancePlan(media, advanceDate, advanceAmount, 0, adjustInDate);
  if (probe.error) return { error: probe.error };
  if (probe.siteHasGst && gstOnIncrease === null) {
    return { error: "This site has GST — send gstOnIncrease (1 = with GST, 0 = without GST)" };
  }
  const gstFlag = probe.siteHasGst ? gstOnIncrease : null;
  const plan = gstFlag === 1 ? buildAdvancePlan(media, advanceDate, advanceAmount, 1, adjustInDate) : probe;

  // ✅ CHANGED — more than one advance for the same bill is allowed (e.g. a
  // yearly bill: January + April advances); the plan already limits their
  // total to the bill amount

  // ✅ NEW — withGst 1 / 2 must match the bill it is deducted from (when that
  // bill's withGst is already decided); no GST → 0
  const advWithGst = gstFlag === 1 ? withGst : 0;
  const withGstError = advanceWithGstError(media, plan.adjustInMonth, advWithGst);
  if (withGstError) return { error: withGstError };

  const oldRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const compare = {
    fromMonth: advanceLabel,
    advanceAmount,
    gstOnIncrease: gstFlag,
    adjustInMonth: plan.adjustInMonth,
    withGst: advWithGst,
    advancePayment: advancePayment || null, // ✅ NEW — month payment split
  };
  const derived = {
    billType: "ADVANCE",
    fromDate: advanceDate,
    oldRent,
    newRent: oldRent, // site rent does not change
    increaseAmount: 0,
    difference: 0,
    applyToAllMonths: null,
    adjustInDate: plan.adjustInDate,
    gstPercentage: plan.gstPercentage,
    advanceGstAmount: plan.advanceGstAmount,
  };

  if (dryRun) return { dryRun: true };
  const waiting = await RentRevision.findOne({ mediaId, status: "Pending", billType: "ADVANCE" });
  if (waiting) return { ...(await editPendingRevision(waiting, { compare, derived, reason, invoice, user })), plan };

  const revision = await RentRevision.create({
    ...newRevisionBase(mediaId, media, user),
    ...compare,
    ...derived,
    invoice,
    reason,
  });
  return { revision, action: "created", plan };
}

const BILL_APPROVAL_LABELS = { 1: "Pending", 2: "Partially Approved", 3: "CMD Approved" };

// ✅ NEW — revision withGst label ("No GST" when the revision has no GST)
const withGstLabelOf = (r) => (Number(r.gstOnIncrease) === 1 ? WITH_GST_LABELS[Number(r.withGst || 0)] || "" : "No GST");
// ✅ NEW — withGst changes made on approve, with labels
const withGstHistoryOf = (r) =>
  (r.withGstHistory || []).map((h) => ({
    ...h,
    fromLabel: WITH_GST_LABELS[Number(h.from || 0)] || "",
    toLabel: WITH_GST_LABELS[Number(h.to || 0)] || "",
  }));

// ✅ NEW — approve: withGst 1 / 2 sent (revision has GST) → saved on the revision
// + withGstHistory (approvals not reset). Not sent / same / no GST → no change.
// Returns an error message (advance bill withGst mismatch) or null.
async function applyApproveWithGst(revision, withGst, { role, user }) {
  if (withGst === null || Number(revision.gstOnIncrease) !== 1) return null;
  const from = Number(revision.withGst || 0);
  if (from === withGst) return null;
  if (revision.billType === "ADVANCE") {
    const media = await Media.findById(revision.mediaId).select("rentalDue.dueMonth rentalDue.withGst").lean();
    const err = advanceWithGstError(media || {}, revision.adjustInMonth, withGst);
    if (err) return err;
  }
  revision.withGst = withGst;
  revision.withGstHistory = [
    ...(revision.withGstHistory || []),
    {
      from,
      to: withGst,
      role,
      roleName: ROLE_NAMES[role],
      by: user?.userName || "",
      byUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
      at: nowIST(),
    },
  ];
  return null;
}

// ✅ NEW — BILL / ADVANCE amounts of a revision (create / approve / list responses)
function billTypeFields(r, plan = null) {
  const gstPercentage = Number(r.gstPercentage || 0);
  if (r.billType === "ADVANCE") {
    const advanceAmount = Number(r.advanceAmount || 0);
    const advanceGstAmount = Number(r.advanceGstAmount || 0);
    return {
      billType: "ADVANCE",
      advanceMonth: r.fromMonth,
      advanceAmount,
      siteHasGst: gstPercentage > 0,
      gstPercentage,
      gstOnIncrease: r.gstOnIncrease ?? null,
      withGst: Number(r.withGst || 0), // ✅ NEW
      withGstLabel: withGstLabelOf(r), // ✅ NEW
      withGstHistory: withGstHistoryOf(r), // ✅ NEW
      advanceGstAmount,
      advanceTotalWithGst: advanceAmount + advanceGstAmount,
      advancePayment: r.advancePayment || null, // ✅ NEW — payment split
      adjustInMonth: r.adjustInMonth || "",
      ...(plan
        ? {
            adjustInBill: {
              month: plan.adjustInMonth,
              rentalDueId: plan.adjustInRentalDueId,
              billGenerated: plan.billGenerated,
              billApprovalStatus: plan.billApprovalStatus,
              billApprovalStatusLabel: plan.billGenerated ? BILL_APPROVAL_LABELS[plan.billApprovalStatus] || "" : "",
              // ✅ CHANGED — full bill (before every advance) + earlier advances of this bill
              totalRentalAmount: plan.fullBillRent ?? plan.billRent,
              totalGstAmount: plan.fullBillGstAmount ?? plan.billGstAmount,
              previousAdvances: plan.previousAdvances || [],
              previousAdvanceTotal: plan.previousAdvanceTotal || 0,
              advanceAdjusted: advanceAmount,
              advanceGstAdjusted: plan.advanceGstAmount,
              balanceAmount: plan.balanceAmount,
              balanceGstAmount: plan.balanceGstAmount,
            },
          }
        : {}),
    };
  }
  const increaseAmount = Number(r.increaseAmount ?? r.difference ?? 0);
  const increaseGstAmount = Number(r.increaseGstAmount || 0);
  const newRent = Number(r.newRent || 0);
  const out = {
    billType: AUTO_BILL_TYPES.includes(r.billType) ? r.billType : "BILL", // ✅ CHANGED — NORMAL_BILL / CANCEL kept
    ...(r.billType === "CANCEL" ? { cancelMail: r.cancelMail || null } : {}), // ✅ NEW
    ...(r.billType === "CANCEL" ? { cancelReverted: !!r.cancelReverted, cancelRevert: r.cancelRevert || null } : {}), // ✅ NEW — cancel revert
    revisionAction: r.revisionAction || "increase", // ✅ NEW
    approvalType: r.approvalType || "normal", // ✅ NEW
    ...(r.revisionAction === "decrease"
      ? {
          decreaseAmount: Math.abs(increaseAmount),
          nextDecreaseAmount: r.nextIncreaseAmount !== null && r.nextIncreaseAmount !== undefined ? Math.abs(Number(r.nextIncreaseAmount)) : null, // ✅ NEW
        }
      : {}), // ✅ NEW
    fromMonth: r.fromMonth,
    oldRent: r.oldRent,
    increaseAmount,
    applyToAllMonths: r.applyToAllMonths ?? null,
    nextIncreaseAmount: r.nextIncreaseAmount ?? null,
    newRent,
    nextBillFromMonth: r.nextBillFromMonth || "",
    siteHasGst: gstPercentage > 0,
    gstPercentage,
    gstOnIncrease: r.gstOnIncrease ?? null,
    withGst: Number(r.withGst || 0), // ✅ NEW
    withGstLabel: withGstLabelOf(r), // ✅ NEW
    withGstHistory: withGstHistoryOf(r), // ✅ NEW
    increaseGstAmount,
    increaseTotalWithGst: increaseAmount + increaseGstAmount,
  };
  if (gstPercentage > 0 && r.applyToAllMonths !== 0) {
    out.newRentGstAmount = round((newRent * gstPercentage) / 100);
    out.newRentWithGst = newRent + out.newRentGstAmount;
  }
  // ✅ NEW — BILL "months": each month's amount / action, totals
  if (Array.isArray(r.months) && r.months.length) {
    const detail = Array.isArray(r.monthsDetail) && r.monthsDetail.length ? r.monthsDetail : r.months;
    out.toMonth = r.toMonth || "";
    out.monthCount = r.months.length; // ✅ NEW
    out.months = detail.map((d) => (d && typeof d.toObject === "function" ? d.toObject() : { ...d }));
    out.totalIncreaseAmount = Number(r.totalIncreaseAmount || increaseAmount);
    out.totalGstAmount = increaseGstAmount;
    out.totalAmount = out.totalIncreaseAmount + increaseGstAmount;
  }
  return out;
}

const revisionSummary = (r, plan = null) => ({
  revisionId: r._id,
  mediaId: r.mediaId,
  mediaCode: r.mediaCode,
  ...billTypeFields(r, plan),
  invoice: r.invoice || null,
  status: r.status,
  currentPendingRole: r.currentPendingRole ?? null,
  currentPendingRoleName: r.currentPendingRole ? ROLE_NAMES[r.currentPendingRole] : null,
  lastRemark: lastRemarkOf(r.approvalSteps), // ✅ NEW
  approvalSteps: formatSteps(r.approvalSteps),
  requestedBy: r.requestedBy,
  requestedByRole: r.requestedByRole,
  requestedAt: r.requestedAt,
});

// ── POST /admin/rent-revision (form-data) ────────────────────
// billType BILL (default): mediaId (one or array), fromMonth, increaseAmount,
//   applyToAllMonths, nextIncreaseAmount (applyToAllMonths 1), gstOnIncrease
//   (GST site), reason, invoice (PDF)
// billType ADVANCE: mediaId, advanceMonth, advanceAmount, gstOnIncrease (GST
//   site), reason, invoice (PDF)
exports.createRentRevision = async (req, res) => {
  try {
    const body = req.body || {};
    // ✅ NEW — "sites": each site its own amount, saved ALL together (any site
    // fails → nothing saved)
    if (hasSites(body.sites)) {
      const sitesBillType = parseBillType(body.billType);
      if (sitesBillType === undefined) return errorResponse(res, BILL_TYPE_ERROR, null, 400); // ✅ CHANGED — message
      const sitesGst = parseGstOnIncrease(body.gstOnIncrease);
      if (sitesGst === undefined) return errorResponse(res, "gstOnIncrease must be 0 or 1", null, 400);
      const sitesWithGst = parseRevisionWithGst(body.withGst); // ✅ NEW
      if (sitesWithGst === undefined) return errorResponse(res, "withGst must be 0, 1 or 2", null, 400);
      return createSitesRevisions(req, res, sitesBillType, sitesGst, sitesWithGst);
    }
    const mediaIds = parseMediaIds(body.mediaId);
    if (mediaIds.length === 0) return errorResponse(res, "mediaId is required", null, 400);

    const billType = parseBillType(body.billType);
    if (billType === undefined) return errorResponse(res, BILL_TYPE_ERROR, null, 400); // ✅ CHANGED — message
    const gstOnIncrease = parseGstOnIncrease(body.gstOnIncrease);
    if (gstOnIncrease === undefined) return errorResponse(res, "gstOnIncrease must be 0 or 1", null, 400);
    const withGst = parseRevisionWithGst(body.withGst); // ✅ NEW
    if (withGst === undefined) return errorResponse(res, "withGst must be 0, 1 or 2", null, 400);

    let billOpts = null;
    // ✅ NEW — ADVANCE inside months[] (with the payment split)
    const advMonths = billType === "ADVANCE" ? parseAdvanceMonths(body.months) : null;
    if (advMonths && advMonths.error) return errorResponse(res, advMonths.error, null, 400);
    if (advMonths) billOpts = advMonths.opts;
    else if (billType === "ADVANCE") {
      const advanceAmount = parseAmount(body.advanceAmount);
      const advanceDate = parseFromMonth(body.advanceMonth);
      if (advanceAmount === null || !body.advanceMonth) {
        return errorResponse(res, "advanceMonth and advanceAmount are required for ADVANCE", null, 400);
      }
      if (advanceAmount === undefined) return errorResponse(res, "advanceAmount must be more than 0", null, 400);
      if (!advanceDate) return errorResponse(res, 'advanceMonth is invalid — send like "October 2026"', null, 400);
      // ✅ NEW — optional: the bill the advance is deducted from (auto when not sent)
      let adjustInDate = null;
      if (body.adjustInMonth !== undefined && body.adjustInMonth !== null && String(body.adjustInMonth).trim() !== "") {
        adjustInDate = parseFromMonth(body.adjustInMonth);
        if (!adjustInDate) return errorResponse(res, 'adjustInMonth is invalid — send like "September 2026"', null, 400);
      }
      billOpts = { advanceDate, advanceLabel: monthLabelOfKey(monthKey(advanceDate)), advanceAmount, adjustInDate };
    }

    let increaseAmount = 0;
    let applyToAllMonths = null;
    let nextIncreaseAmount = null;
    let fromDate = null;
    let fromLabel = "";
    let billMonths = null; // ✅ NEW — BILL "months" array
    let revisionAction = "increase"; // ✅ NEW
    if (billType === "BILL" || AUTO_BILL_TYPES.includes(billType)) {
      const parsedMonths = parseRevisionMonths(body.months, { allowNoAmount: billType === "CANCEL" });
      if (parsedMonths.error) return errorResponse(res, parsedMonths.error, null, 400);
      billMonths = parsedMonths.list;
      revisionAction = parsedMonths.action || "increase";
    }
    // ✅ NEW — NORMAL_BILL / CANCEL: months + reason required
    if (AUTO_BILL_TYPES.includes(billType)) {
      if (!billMonths) return errorResponse(res, `months is required for ${billType} — send like ${MONTHS_EXAMPLE}`, null, 400);
      if (!String(body.reason || "").trim()) return errorResponse(res, `reason is required for ${billType}`, null, 400);
    }
    if (billType === "BILL" && !billMonths) {
      if (body.increaseAmount === undefined || body.increaseAmount === null || String(body.increaseAmount).trim() === "") {
        return errorResponse(res, "increaseAmount is required", null, 400);
      }
      increaseAmount = Number(body.increaseAmount);
      if (!Number.isFinite(increaseAmount) || increaseAmount <= 0) {
        return errorResponse(res, "increaseAmount must be more than 0", null, 400);
      }
      applyToAllMonths = parseApplyToAllMonths(body.applyToAllMonths);
      if (applyToAllMonths === undefined) return errorResponse(res, "applyToAllMonths must be 0 or 1", null, 400);
      // ✅ NEW — applyToAllMonths 1 → amount added to the site rent from the next bill
      if (applyToAllMonths === 1) {
        nextIncreaseAmount = parseAmount(body.nextIncreaseAmount);
        if (nextIncreaseAmount === null) {
          return errorResponse(res, "nextIncreaseAmount is required when applyToAllMonths is 1", null, 400);
        }
        if (nextIncreaseAmount === undefined) return errorResponse(res, "nextIncreaseAmount must be more than 0", null, 400);
      }

      fromDate = parseFromMonth(body.fromMonth);
      if (!fromDate) return errorResponse(res, 'fromMonth is invalid — send like "August 2026"', null, 400);
      fromLabel = monthLabelOfKey(monthKey(fromDate));
    }
    // ✅ NEW — BILL "months": same applyToAllMonths / nextIncreaseAmount rules
    // ✅ CHANGED — + NORMAL_BILL; decrease / NORMAL_BILL → nextIncreaseAmount optional
    if ((billType === "BILL" || AUTO_BILL_TYPES.includes(billType)) && billMonths) {
      applyToAllMonths = parseApplyToAllMonths(body.applyToAllMonths);
      if (applyToAllMonths === undefined) return errorResponse(res, "applyToAllMonths must be 0 or 1", null, 400);
      if (revisionAction === "none") applyToAllMonths = 0; // ✅ NEW — CANCEL without amount
      if (applyToAllMonths === 1) {
        // ✅ CHANGED — decrease → nextDecreaseAmount (optional); increase → nextIncreaseAmount
        const next = parseNextAmount(body, revisionAction);
        if (next.error) return errorResponse(res, next.error, null, 400);
        nextIncreaseAmount = next.amount;
        if (nextIncreaseAmount === null && !AUTO_BILL_TYPES.includes(billType) && revisionAction !== "decrease") {
          return errorResponse(res, "nextIncreaseAmount is required when applyToAllMonths is 1", null, 400);
        }
      }
      fromDate = billMonths[0].date;
      fromLabel = billMonths[0].month;
      // ✅ NEW — optional total increaseAmount: must equal the months' total
      if (revisionAction === "increase" && body.increaseAmount !== undefined && body.increaseAmount !== null && String(body.increaseAmount).trim() !== "") {
        const sentTotal = Number(body.increaseAmount);
        const monthsTotal = billMonths.reduce((s, bm) => s + bm.amount, 0);
        if (!Number.isFinite(sentTotal) || round(sentTotal) !== monthsTotal) {
          return errorResponse(
            res,
            `increaseAmount ${body.increaseAmount} must equal the total of months ${monthsTotal} (${billMonths.map((bm) => `${bm.month} ${bm.amount}`).join(" + ")})`,
            null,
            400,
          );
        }
      }
    }

    // one invoice PDF for all sites in the request → mail gstInvoiceUrl
    let invoice = null;
    const invoiceFile = (req.files || []).find((f) => f.fieldname === "invoice");
    if (invoiceFile) {
      const isPdf = invoiceFile.mimetype === "application/pdf" || /\.pdf$/i.test(invoiceFile.originalname || "");
      if (!isPdf) return errorResponse(res, "invoice must be a PDF file", null, 400);
      invoice = typeof req.processFile === "function" ? req.processFile(invoiceFile) : null;
    }

    const common = {
      gstOnIncrease,
      withGst, // ✅ NEW
      reason: body.reason ? String(body.reason).trim() : "",
      invoice,
      user: req.user,
    };
    const created = [];
    const failed = [];
    for (const id of mediaIds) {
      const r = billType === "ADVANCE"
        ? await createOneAdvance(id, { ...common, ...billOpts })
        : await createOneRevision(id, {
            ...common,
            fromDate,
            fromLabel,
            increaseAmount: round(increaseAmount),
            applyToAllMonths,
            nextIncreaseAmount,
            billMonths,
            billType, // ✅ NEW
            revisionAction, // ✅ NEW
          });
      if (r.error) failed.push({ mediaId: id, message: r.error, ...(r.revisionId ? { revisionId: r.revisionId } : {}) });
      else {
        created.push({
          action: r.action, // created | updated (a Pending revision already existed) | unchanged
          ...revisionSummary(r.revision, r.plan || null),
          ...(r.action !== "created" ? { editHistory: r.revision.editHistory || [], updatedBy: r.revision.updatedBy || "" } : {}),
        });
      }
    }

    if (created.length === 0) {
      return errorResponse(res, failed.length === 1 ? failed[0].message : "No rent revision created", { failed }, 400);
    }
    const count = (a) => created.filter((c) => c.action === a).length;
    const parts = [
      count("created") ? `${count("created")} created` : "",
      count("updated") ? `${count("updated")} updated` : "",
      count("unchanged") ? `${count("unchanged")} unchanged` : "",
    ].filter(Boolean);
    const pendingRoles = [...new Set(created.map((c) => c.currentPendingRoleName).filter(Boolean))];
    return successResponse(
      res,
      billType === "CANCEL" // ✅ NEW
        ? `Bill approval cancelled (${parts.join(", ")}) — bill sent back to Rental Executive for approval`
        : billType === "NORMAL_BILL" // ✅ NEW
        ? `Bill updated (${parts.join(", ")}) — not CMD approved, no approval needed`
        : `Rent revision ${parts.join(", ")} — waiting for ${pendingRoles.join(" / ") || "Rental Executive"} approval`,
      { ...revisionTotals(billType, created), created, failed }, // ✅ NEW — totals
      failed.length ? 207 : count("created") ? 201 : 200,
    );
  } catch (error) {
    console.error("createRentRevision error:", error);
    return errorResponse(res, "Something went wrong while creating rent revision", { error: error.message }, 500);
  }
};

// ✅ NEW — totals of the created / updated revisions (create response)
function revisionTotals(billType, created) {
  const sum = (f) => created.reduce((t, c) => t + Number(c[f] || 0), 0);
  if (billType === "ADVANCE") {
    const amount = sum("advanceAmount");
    const gst = sum("advanceGstAmount");
    return { totalSites: created.length, totalAdvanceAmount: amount, totalAdvanceGstAmount: gst, totalAmount: amount + gst };
  }
  const amount = sum("increaseAmount");
  const gst = sum("increaseGstAmount");
  return { totalSites: created.length, totalIncreaseAmount: amount, totalGstAmount: gst, totalAmount: amount + gst };
}

const hasSites = (v) => v !== undefined && v !== null && (Array.isArray(v) || String(v).trim() !== "");
const SITES_EXAMPLE = '[{"mediaId":"…","months":[{"month":"August 2026","amount":1200}]}]';

// ✅ NEW — POST /admin/rent-revision with "sites" (form-data JSON string or array):
//   BILL    → [{ mediaId, months: [{ month, amount }], applyToAllMonths?, nextIncreaseAmount? }]
//   ADVANCE → [{ mediaId, advanceMonth, advanceAmount, adjustInMonth? }]
// Shared: billType, gstOnIncrease, reason, invoice (applyToAllMonths /
// nextIncreaseAmount at the top = default for every site).
// 1) every site is checked (dryRun) — any site fails → 400, NOTHING saved
// 2) all pass → every site saved (its own revision, approvals, mail)
async function createSitesRevisions(req, res, billType, gstOnIncrease, withGst = 0) {
  const body = req.body || {};
  let sites = body.sites;
  if (typeof sites === "string") {
    try {
      sites = JSON.parse(sites);
    } catch (e) {
      return errorResponse(res, `sites is invalid — send like ${SITES_EXAMPLE}`, null, 400);
    }
  }
  if (!Array.isArray(sites)) return errorResponse(res, `sites is invalid — send like ${SITES_EXAMPLE}`, null, 400);
  if (sites.length === 0) return errorResponse(res, "sites must have at least one site", null, 400);

  // ── request format (any problem → 400, nothing checked / saved)
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const items = [];
  const seen = new Set();
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i] || {};
    const p = `sites[${i}]`;
    if (!has(site.mediaId)) return errorResponse(res, `${p}.mediaId is required`, null, 400);
    const mediaId = String(site.mediaId).trim();
    if (!mongoose.Types.ObjectId.isValid(mediaId)) return errorResponse(res, `${p}.mediaId is not a valid ObjectId`, null, 400);
    if (seen.has(mediaId)) return errorResponse(res, `${p}.mediaId is repeated in sites`, null, 400);
    seen.add(mediaId);
    // ✅ NEW — per-site gstOnIncrease (not sent → the top-level value)
    let siteGst = gstOnIncrease;
    if (site.gstOnIncrease !== undefined) {
      siteGst = parseGstOnIncrease(site.gstOnIncrease);
      if (siteGst === undefined) return errorResponse(res, `${p}.gstOnIncrease must be 0 or 1`, null, 400);
    }
    // ✅ NEW — per-site withGst (not sent → the top-level value)
    let siteWithGst = withGst;
    if (site.withGst !== undefined) {
      siteWithGst = parseRevisionWithGst(site.withGst);
      if (siteWithGst === undefined) return errorResponse(res, `${p}.withGst must be 0, 1 or 2`, null, 400);
    }

    // ✅ NEW — ADVANCE inside months[] (with the payment split)
    const siteAdvMonths = billType === "ADVANCE" ? parseAdvanceMonths(site.months, `${p}.`) : null;
    if (siteAdvMonths && siteAdvMonths.error) return errorResponse(res, siteAdvMonths.error, null, 400);
    if (siteAdvMonths) {
      items.push({ index: i, mediaId, gst: siteGst, withGst: siteWithGst, opts: siteAdvMonths.opts });
      continue;
    }
    if (billType === "ADVANCE") {
      const advanceAmount = parseAmount(site.advanceAmount);
      if (advanceAmount === null || !has(site.advanceMonth)) {
        return errorResponse(res, `${p}.advanceMonth and advanceAmount are required for ADVANCE`, null, 400);
      }
      if (advanceAmount === undefined) return errorResponse(res, `${p}.advanceAmount must be more than 0`, null, 400);
      const advanceDate = parseFromMonth(site.advanceMonth);
      if (!advanceDate) return errorResponse(res, `${p}.advanceMonth is invalid — send like "October 2026"`, null, 400);
      let adjustInDate = null;
      if (has(site.adjustInMonth)) {
        adjustInDate = parseFromMonth(site.adjustInMonth);
        if (!adjustInDate) return errorResponse(res, `${p}.adjustInMonth is invalid — send like "September 2026"`, null, 400);
      }
      items.push({ index: i, mediaId, gst: siteGst, withGst: siteWithGst, opts: { advanceDate, advanceLabel: monthLabelOfKey(monthKey(advanceDate)), advanceAmount, adjustInDate } });
      continue;
    }

    // ✅ NEW — decreaseAmount belongs inside months (was ignored silently → increase)
    if (has(site.decreaseAmount)) {
      return errorResponse(
        res,
        `${p}.decreaseAmount must be inside months — send like [{"mediaId":"…","months":[{"month":"September 2026","decreaseAmount":3000}]}]`,
        null,
        400,
      );
    }
    const parsedMonths = parseRevisionMonths(site.months, { allowNoAmount: billType === "CANCEL" }); // ✅ CHANGED — CANCEL: month without amount
    if (parsedMonths.error) {
      const err = parsedMonths.error;
      return errorResponse(res, err.startsWith("months") ? `${p}.${err}` : `${p}: ${err}`, null, 400);
    }
    if (!parsedMonths.list) return errorResponse(res, `${p}.months is required — send like ${MONTHS_EXAMPLE}`, null, 400);
    const siteAction = parsedMonths.action || "increase"; // ✅ NEW
    // ✅ NEW — per-site increaseAmount (optional): must equal this site's months total
    if (siteAction === "increase" && has(site.increaseAmount)) {
      const sentTotal = Number(site.increaseAmount);
      const monthsTotal = parsedMonths.list.reduce((t, bm) => t + bm.amount, 0);
      if (!Number.isFinite(sentTotal) || sentTotal <= 0) return errorResponse(res, `${p}.increaseAmount must be more than 0`, null, 400);
      if (round(sentTotal) !== monthsTotal) {
        return errorResponse(
          res,
          `${p}.increaseAmount ${site.increaseAmount} must equal the total of months ${monthsTotal} (${parsedMonths.list.map((bm) => `${bm.month} ${bm.amount}`).join(" + ")})`,
          null,
          400,
        );
      }
    }
    let applyToAllMonths = parseApplyToAllMonths(site.applyToAllMonths !== undefined ? site.applyToAllMonths : body.applyToAllMonths);
    if (applyToAllMonths === undefined) return errorResponse(res, `${p}.applyToAllMonths must be 0 or 1`, null, 400);
    if (siteAction === "none") applyToAllMonths = 0; // ✅ NEW — CANCEL without amount
    let nextIncreaseAmount = null;
    if (applyToAllMonths === 1) {
      // ✅ CHANGED — decrease → nextDecreaseAmount (optional); increase → nextIncreaseAmount
      // (site value, else the top-level value)
      const nextSrc = {
        nextIncreaseAmount: site.nextIncreaseAmount !== undefined ? site.nextIncreaseAmount : body.nextIncreaseAmount,
        nextDecreaseAmount: site.nextDecreaseAmount !== undefined ? site.nextDecreaseAmount : body.nextDecreaseAmount,
      };
      const next = parseNextAmount(nextSrc, siteAction, `${p}.`);
      if (next.error) return errorResponse(res, next.error, null, 400);
      nextIncreaseAmount = next.amount;
      if (nextIncreaseAmount === null && !AUTO_BILL_TYPES.includes(billType) && siteAction !== "decrease") {
        return errorResponse(res, `${p}.nextIncreaseAmount is required when applyToAllMonths is 1`, null, 400);
      }
    }
    items.push({
      index: i,
      mediaId,
      gst: siteGst,
      withGst: siteWithGst, // ✅ NEW
      opts: {
        fromDate: parsedMonths.list[0].date,
        fromLabel: parsedMonths.list[0].month,
        increaseAmount: 0,
        applyToAllMonths,
        nextIncreaseAmount,
        billMonths: parsedMonths.list,
        billType, // ✅ NEW
        revisionAction: siteAction, // ✅ NEW
      },
    });
  }
  // ✅ NEW — NORMAL_BILL / CANCEL: reason required
  if (AUTO_BILL_TYPES.includes(billType) && !String(body.reason || "").trim()) {
    return errorResponse(res, `reason is required for ${billType}`, null, 400);
  }

  // one invoice PDF for all sites → mail gstInvoiceUrl
  let invoice = null;
  const invoiceFile = (req.files || []).find((f) => f.fieldname === "invoice");
  if (invoiceFile) {
    const isPdf = invoiceFile.mimetype === "application/pdf" || /\.pdf$/i.test(invoiceFile.originalname || "");
    if (!isPdf) return errorResponse(res, "invoice must be a PDF file", null, 400);
    invoice = typeof req.processFile === "function" ? req.processFile(invoiceFile) : null;
  }
  const common = { gstOnIncrease, reason: body.reason ? String(body.reason).trim() : "", invoice, user: req.user };
  const runOne = (it, dryRun) =>
    billType === "ADVANCE"
      ? createOneAdvance(it.mediaId, { ...common, gstOnIncrease: it.gst, withGst: it.withGst, ...it.opts, dryRun })
      : createOneRevision(it.mediaId, { ...common, gstOnIncrease: it.gst, withGst: it.withGst, ...it.opts, dryRun });

  // ── 1) check every site — nothing saved
  let failed = [];
  for (const it of items) {
    const r = await runOne(it, true);
    if (r.error) failed.push({ index: it.index, mediaId: it.mediaId, message: r.error });
  }
  if (failed.length) {
    const docs = await Media.find({ _id: { $in: failed.map((f) => f.mediaId) } }).select("mediaDetails").lean();
    const codeById = new Map(docs.map((d) => [String(d._id), siteCodeName(d).mediaCode]));
    failed = failed.map((f) => ({ index: f.index, mediaId: f.mediaId, mediaCode: codeById.get(f.mediaId) || "", message: f.message }));
    return errorResponse(
      res,
      `Rent revision not saved — ${failed.length} of ${items.length} site(s) failed. Fix them and send again.`,
      { totalSites: items.length, passedSites: items.length - failed.length, failedSites: failed.length, failed },
      400,
    );
  }

  // ── 2) all passed → save every site
  const created = [];
  try {
    for (const it of items) {
      const r = await runOne(it, false);
      if (r.error) throw new Error(`sites[${it.index}] (${it.mediaId}): ${r.error}`);
      created.push({
        action: r.action,
        ...revisionSummary(r.revision, r.plan || null),
        ...(r.action !== "created" ? { editHistory: r.revision.editHistory || [], updatedBy: r.revision.updatedBy || "" } : {}),
      });
    }
  } catch (e) {
    console.error("createSitesRevisions save error:", e);
    return errorResponse(
      res,
      "Rent revision partly saved — server error while saving the sites",
      { error: e.message, savedRevisionIds: created.map((c) => c.revisionId) },
      500,
    );
  }

  const count = (a) => created.filter((c) => c.action === a).length;
  const parts = [
    count("created") ? `${count("created")} created` : "",
    count("updated") ? `${count("updated")} updated` : "",
    count("unchanged") ? `${count("unchanged")} unchanged` : "",
  ].filter(Boolean);
  const pendingRoles = [...new Set(created.map((c) => c.currentPendingRoleName).filter(Boolean))];
  return successResponse(
    res,
    billType === "CANCEL" // ✅ NEW
      ? `Bill approval cancelled (${parts.join(", ")}) — bill sent back to Rental Executive for approval`
      : billType === "NORMAL_BILL" // ✅ NEW
      ? `Bill updated (${parts.join(", ")}) — not CMD approved, no approval needed`
      : `Rent revision ${parts.join(", ")} — waiting for ${pendingRoles.join(" / ") || "Rental Executive"} approval`,
    { ...revisionTotals(billType, created), created, failed: [] },
    count("created") ? 201 : 200,
  );
}

// ✅ CHANGED — CMD approval mail of a rent revision → new PHP mail
// (newBillCmdApproval.php, mailtype "newbillcmdapproval"). New Bill / Advance
// amounts only — no last / current / next bill dates. ONE mail per revision.
//   rows        → BILL: [{ month, type: "newBill" | "billUpdate", amount, gstAmount }]
//   advanceBill → ADVANCE: the advance bill (media.arrearsDue[])
//   owners      → each owner's share of the mail amount [{ landOwnerId, shareAmount, ... }]
const NEW_BILL_MAIL_URL = "https://adinndigital.com/api/outdoormedia/newBillCmdApproval.php";
const NEW_BILL_MAIL_TYPE = "newbillcmdapproval";
const mailEmailList = (v) => String(v || "").split(",").map((e) => e.trim()).filter(Boolean);

async function sendNewBillCmdMail(media, revision, { rows = [], advanceBill = null, owners = [], withGst = 0 }) {
  const isAdvance = !!advanceBill;
  const to = mailEmailList(process.env.T0_EMail);
  const cc = mailEmailList(process.env.CC_EMail);
  const mailMode = process.env.MAIL_MODE || "development";
  const rp = media.rentalPayment || {};
  const detail = (media.mediaDetails || [])[0] || {};
  const { mediaCode, mediaName } = siteCodeName(media);

  const ownersById = new Map((owners || []).map((o) => [String(o.landOwnerId), o]));
  const landOwners = (media.landOwners || []).map((o) => {
    const a = ownersById.get(String(o._id)) || {};
    const amt = (f) => Number(a[f] || 0);
    return {
      name: o.name || "",
      phone: o.phone || "",
      panNumber: o.panNumber || "",
      paymentCategory: Number(o.paymentCategory || 1),
      bankName: o.bankName || "",
      accountNumber: o.accountNumber || "",
      ifsc: o.ifsc || "",
      onlineMode: Number(o.onlineMode || 0),
      gstNumber: o.gstNumber || "",
      shareAmount: amt("shareAmount"),
      cashAmount: amt("cashAmount"),
      onlineAmount: amt("onlineAmount"),
      gstAmount: amt("gstAmount"),
      totalAmount: amt("shareAmount") + amt("gstAmount"),
    };
  });

  const cmdStep = (revision.approvalSteps || []).find((s) => Number(s.role) === 3) || {};
  const data = {
    billType: isAdvance ? "ADVANCE" : "BILL",
    revisionId: String(revision._id),
    billNo: revision.adinn_ooh_bills || "", // ✅ NEW — ADINN OOH bill number of the New Bill / Advance
    media: {
      mediaCode,
      mediaName,
      mediaType: detail.mediaType || "",
      state: detail.state || "",
      city: detail.city || "",
      location: detail.location || "",
      fullAddress: [detail.location, detail.district, detail.city, detail.state].filter(Boolean).join(", "),
      width: Number(detail.width || 0),
      height: Number(detail.height || 0),
      totalSqft: Number(detail.totalSqFt || Number(detail.width || 0) * Number(detail.height || 0)),
      // ✅ NEW — every face / site of the media (inactive ones too)
      siteCount: (media.mediaDetails || []).length,
      sites: (media.mediaDetails || []).map((d) => {
        const width = Number(d.width || 0);
        const height = Number(d.height || 0);
        const totalSqft = Number(d.totalSqFt || width * height);
        return {
          mediaCode: d.mediaCode || "",
          mediaName: d.mediaName || "",
          mediaType: d.mediaType || "",
          state: d.state || "",
          city: d.city || "",
          district: d.district || "",
          location: d.location || "",
          fullAddress: [d.location, d.district, d.city, d.state].filter(Boolean).join(", "),
          width,
          height,
          totalSqft,
          size: width && height ? `${width} x ${height} ft (${totalSqft} sq.ft)` : "",
          status: Number(d.status || 0),
        };
      }),
    },
    paymentFrequency: PAYMENT_FREQUENCY_LABELS[Number(rp.paymentFrequency || 1)] || "",
    gstPercentage: gstPercentageFor(media, isAdvance ? revision.adjustInDate || revision.fromDate : revision.fromDate),
    withGst: Number(withGst || 0),
    landOwners,
    reason: revision.reason || "",
    gstInvoiceUrl: revision.invoice?.filePath || "",
    approvedBy: cmdStep.by || "",
    approvedAt: cmdStep.at ? new Date(cmdStep.at).toISOString().replace("T", " ").slice(0, 16) : "",
  };

  let amount;
  let gstAmount;
  if (isAdvance) {
    amount = Number(advanceBill.netPayable || 0);
    gstAmount = Number(advanceBill.gstAmount || 0);
    const billAmount = Number(advanceBill.billRent || 0);
    data.label = `Advance – ${advanceBill.dueMonth}`;
    data.advance = {
      advanceMonth: advanceBill.dueMonth || revision.fromMonth || "",
      advanceAmount: amount,
      advanceGstAmount: gstAmount,
      grandTotal: amount + gstAmount,
      adjustInMonth: advanceBill.adjustInMonth || revision.adjustInMonth || "",
      billAmount,
      balanceAmount: Math.max(0, billAmount - amount),
    };
  } else {
    const months = rows.map((r) => ({
      month: r.month,
      type: r.type,
      amount: Number(r.amount || 0),
      gstAmount: Number(r.gstAmount || 0),
      total: Number(r.amount || 0) + Number(r.gstAmount || 0),
    }));
    amount = months.reduce((s, m) => s + m.amount, 0);
    gstAmount = months.reduce((s, m) => s + m.gstAmount, 0);
    const first = months[0]?.month || revision.fromMonth;
    const last = months[months.length - 1]?.month || first;
    data.label = first === last ? `New Bill – ${first}` : `New Bill – ${first} to ${last}`;
    data.bill = {
      months,
      totalAmount: amount,
      totalGstAmount: gstAmount,
      grandTotal: amount + gstAmount,
      oldRent: Number(revision.oldRent || 0),
      newRent: Number(revision.newRent || 0),
      applyToAllMonths: revision.applyToAllMonths ?? null,
      nextIncreaseAmount: revision.nextIncreaseAmount ?? null,
      nextBillFromMonth: revision.nextBillFromMonth || "",
    };
  }
  data.gstApplicable = gstAmount > 0 ? 1 : 0;

  const mailPayload = { mailtype: NEW_BILL_MAIL_TYPE, to, ...(cc.length ? { cc } : {}), data };
  const amounts = isAdvance
    ? { advanceAmount: amount, advanceGstAmount: gstAmount }
    : { increaseAmount: amount, increaseGstAmount: gstAmount };
  console.log("📧 NEW BILL CMD MAIL PAYLOAD:", JSON.stringify(mailPayload, null, 2));

  if (mailMode !== "production") {
    return { mailtype: NEW_BILL_MAIL_TYPE, sent: false, ...amounts, message: `Mail skipped (MAIL_MODE=${mailMode}) — not sent` };
  }
  try {
    const response = await axios.post(NEW_BILL_MAIL_URL, mailPayload, { headers: { "Content-Type": "application/json" } });
    console.log("📬 NEW BILL CMD MAIL RESPONSE:", response.data);
    const sent = !!(response.data && (response.data.status === "success" || response.data.success === true));
    return {
      mailtype: NEW_BILL_MAIL_TYPE,
      sent,
      ...amounts,
      message: sent ? "New bill CMD approval mail sent successfully" : response.data?.message || "New bill CMD approval mail failed",
    };
  } catch (err) {
    console.error("❌ New bill CMD mail error:", err?.response?.data || err?.message || err);
    return { mailtype: NEW_BILL_MAIL_TYPE, sent: false, ...amounts, message: err?.response?.data?.message || err?.message || "Mail error" };
  }
}

// ✅ NEW — rentalAmountHistory rows of a rent revision (type, month, remark)
const CHANGE_LABELS = {
  normalBillIncrease: "Bill Increase",
  normalBillDecrease: "Bill Decrease",
  cancel: "Bill Approval Cancelled", // ✅ NEW
  cancelRevert: "Bill Approval Cancel Reverted", // ✅ NEW
  newBill: "New Bill",
  newBillDecrease: "Bill Decrease (CMD approved bill)",
  advance: "Advance",
};
function revisionChangeType(revision) {
  if (revision.billType === "ADVANCE") return "advance";
  if (revision.billType === "CANCEL") return "cancel"; // ✅ NEW
  const dec = revision.revisionAction === "decrease";
  if (revision.billType === "NORMAL_BILL") return dec ? "normalBillDecrease" : "normalBillIncrease";
  return dec ? "newBillDecrease" : "newBill";
}
// ✅ CHANGED — reason only (CMD remark no longer added: "Rent reduced")
function revisionRemarkText(revision) {
  return String(revision.reason || "").trim();
}
// one row; siteRent / previousSiteRent = site rent after / before (same when only the month changed)
function revisionHistoryRow(revision, { siteRent, previousSiteRent = siteRent, month, changeAmount = null, before = null, after = null, userName, now, effectiveFrom = null, extra = {} }) {
  const changeType = revisionChangeType(revision);
  return {
    amount: siteRent,
    previousAmount: previousSiteRent,
    changeType,
    changeLabel: CHANGE_LABELS[changeType],
    month: month || "",
    changeAmount,
    monthAmountBefore: before,
    monthAmountAfter: after,
    remark: revisionRemarkText(revision),
    updatedBy: userName,
    updatedAt: now,
    effectiveFrom: effectiveFrom || (month ? parseFromMonth(month) : null),
    rentRevisionId: revision._id,
    isManualChange: false,
    isInitial: false,
    isAppraisal: false,
    ...extra,
  };
}
// month rows of a BILL / NORMAL_BILL revision (monthsDetail, else fromMonth)
function revisionMonthRows(revision) {
  const detail = (revision.monthsDetail || []).map((d) => (d && typeof d.toObject === "function" ? d.toObject() : d)).filter(Boolean);
  if (detail.length) {
    return detail.map((d) => ({
      month: d.month,
      changeAmount: Number(d.amount ?? (d.decreaseAmount ? -d.decreaseAmount : d.increaseAmount) ?? 0),
      before: d.currentAmount ?? null,
      after: d.newAmount ?? null,
    }));
  }
  return [{ month: revision.fromMonth, changeAmount: Number(revision.increaseAmount ?? revision.difference ?? 0), before: null, after: null }];
}

// Applies an approved revision to the site. Returns the arrears bills + total.
async function applyRevision(revision, media, userName) {
  const now = nowIST();
  const newRent = Number(revision.newRent);
  const onlyFromMonth = revision.applyToAllMonths === 0;
  // ✅ CHANGED — fromMonth priced at its own rent + increaseAmount (GST per gstOnIncrease)
  // ✅ NEW — BILL "months": each listed month + its own amount
  const listedMonths = (Array.isArray(revision.months) ? revision.months : [])
    .map((x) => ({ key: monthKey(parseFromMonth(x?.month)), amount: Number(x?.amount || 0) }))
    .filter((x) => x.key !== null && x.amount !== 0); // ✅ CHANGED — decrease (negative) kept
  const monthIncreases = listedMonths.length ? new Map(listedMonths.map((x) => [x.key, x.amount])) : null;
  const lastListedKey = monthIncreases ? Math.max(...monthIncreases.keys()) : null;
  const plan = buildRevisionPlan(media, revision.fromDate, newRent, revision.applyToAllMonths ?? null, {
    fromMonthIncrease: Number(revision.increaseAmount ?? revision.difference ?? 0),
    gstOnIncrease: revision.gstOnIncrease ?? null,
    ...(monthIncreases ? { monthIncreases } : {}),
  });
  if (plan.heldMonth) {
    throw { message: `${plan.heldMonth} is on appraisal hold — release it first`, statusCode: 400 };
  }
  const oldRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  // only fromMonth → site rent / owners stay (ratio 1)
  const ratio = !onlyFromMonth && oldRent > 0 ? newRent / oldRent : 1;
  const scale = (v) => (v === undefined || v === null ? v : round(Number(v) * ratio));
  const rp = media.rentalPayment || {};

  const arrearsBills = plan.arrearsBills.map((b) => withRevisionGst(toArrearsBill(b, revision._id, userName, now), revision)); // ✅ CHANGED — + revision withGst

  // ✅ NEW — month payment split: New Bill of the month → owners' cash / online
  // as per the split; month bill updated (not CMD approved) → kept month ownerSplit
  const splitOwnersByMonth = new Map(); // dueMonth → ownerSplit
  for (const x of Array.isArray(revision.months) ? revision.months : []) {
    const pay = x && x.payment;
    const date = pay ? parseFromMonth(x.month) : null;
    if (!date || !Number(x.amount)) continue;
    const label = monthLabelOfKey(monthKey(date));
    const d = monthOwnerDeltas(media, date, Number(x.amount), pay, label);
    if (d.error) throw { message: d.error, statusCode: 400 };
    const monthNewBills = arrearsBills.filter((b) => b.dueMonth === label);
    if (monthNewBills.length) {
      applySplitToNewBills(monthNewBills, d.deltas);
      continue;
    }
    // CMD approved month without a New Bill (BILL decrease) → done by applyBillDecrease
    const k0 = monthKey(date);
    if ((media.rentalDue || []).some((b) => b && b.dueDate && monthKey(b.dueDate) === k0 && Number(b.approvalStatus) === 3)) continue;
    const s = ownerSplitAfter(media, date, d.deltas, label);
    if (s.error) throw { message: s.error, statusCode: 400 };
    if (s.split) splitOwnersByMonth.set(label, s.split);
  }

  const landOwners = (media.landOwners || []).map((o) => ({
    ...o,
    shareAmount: scale(o.shareAmount),
    cashAmount: scale(o.cashAmount),
    onlineAmount: scale(o.onlineAmount),
    gstAmount: scale(o.gstAmount),
    tdsAmount: scale(o.tdsAmount),
    totalAmountWithGst: scale(o.totalAmountWithGst),
    netPayableToOwner: scale(o.netPayableToOwner),
    netPayable: scale(o.netPayable),
    linkedSites: Array.isArray(o.linkedSites)
      ? o.linkedSites.map((ls) =>
          String(ls?.mediaId) === String(media._id)
            ? { ...ls, shareAmount: scale(ls.shareAmount), cashAmount: scale(ls.cashAmount), onlineAmount: scale(ls.onlineAmount) }
            : ls,
        )
      : o.linkedSites,
  }));

  const $set = onlyFromMonth
    ? { updatedAt: now }
    : { "rentalPayment.totalRentalAmount": newRent, landOwners, updatedAt: now };
  if (!onlyFromMonth && rp.gstAmount !== undefined && rp.gstAmount !== null) $set["rentalPayment.gstAmount"] = scale(rp.gstAmount);
  if (!onlyFromMonth && rp.totalRentalAmountWithGst !== undefined && rp.totalRentalAmountWithGst !== null) {
    $set["rentalPayment.totalRentalAmountWithGst"] = scale(rp.totalRentalAmountWithGst);
  }
  if (!onlyFromMonth && rp.netPayable !== undefined && rp.netPayable !== null) $set["rentalPayment.netPayable"] = scale(rp.netPayable);
  // site without an applied appraisal → keep the appraisal summary rent in step
  if (!onlyFromMonth && Number(media.appraisal?.applicable) !== 1 && media.appraisal) {
    $set["appraisal.currentRent"] = newRent;
    $set["appraisal.totalAppraisalAmount"] = newRent;
  }

  const arrayFilters = [];
  plan.billsUpdated.forEach((b, i) => {
    $set[`rentalDue.$[u${i}].netPayable`] = b.newAmount;
    $set[`rentalDue.$[u${i}].baseAmount`] = b.baseAmount;
    $set[`rentalDue.$[u${i}].gstAmount`] = b.gstAmount;
    $set[`rentalDue.$[u${i}].updatedBy`] = `${userName} (Rent Revision)`;
    arrayFilters.push({ [`u${i}._id`]: b.rentalDueId });
  });

  const $push = {};
  // ✅ CHANGED — rentalAmountHistory: site rent changed → that row (+ type /
  // month / remark of the first month); every other month → a log row
  // (isRevisionLog, site rent same)
  const monthRows = revisionMonthRows(revision);
  const historyRows = [];
  if (!onlyFromMonth) {
    const firstRow = monthRows[0] || {};
    historyRows.push({
      ...revisionHistoryRow(revision, { siteRent: newRent, previousSiteRent: oldRent, ...firstRow, userName, now }),
      amount: newRent,
      updatedBy: `${userName} (Rent Revision - from ${monthIncreases ? revision.nextBillFromMonth || monthLabelOfKey(lastListedKey + 1) : revision.fromMonth})`,
      updatedAt: now,
      // months list → from the month after the last listed month (months
      // between the listed ones keep their rent)
      effectiveFrom: monthIncreases
        ? new Date(Date.UTC(Math.floor((lastListedKey + 1) / 12), (lastListedKey + 1) % 12, 1))
        : revision.fromDate,
      rentRevisionId: revision._id,
    });
  }
  monthRows.slice(onlyFromMonth ? 0 : 1).forEach((r) => {
    historyRows.push(revisionHistoryRow(revision, { siteRent: onlyFromMonth ? oldRent : newRent, ...r, userName, now, extra: { isRevisionLog: true } }));
  });
  if (historyRows.length) {
    $push["rentalPayment.rentalAmountHistory"] = { $each: historyRows, $sort: { updatedAt: -1 } };
  }
  if (plan.keptMonths.length) {
    $push["rentalPayment.rentRevisionKeptMonths"] = {
      // keptAt → an advance approved later is still deducted from the month
      $each: plan.keptMonths.map((k) => ({
        ...k,
        ...(splitOwnersByMonth.has(k.dueMonth) && Number(k.rent) > 0 ? { ownerSplit: splitOwnersByMonth.get(k.dueMonth) } : {}), // ✅ NEW
        rentRevisionId: revision._id,
        keptAt: now,
      })),
    };
  }
  if (arrearsBills.length) $push.arrearsDue = { $each: arrearsBills };

  await Media.updateOne(
    { _id: media._id },
    Object.keys($push).length ? { $set, $push } : { $set },
    arrayFilters.length ? { arrayFilters, strict: false } : { strict: false },
  );

  return {
    arrearsBills,
    arrearsTotal: arrearsBills.reduce((s, b) => s + Number(b.netPayable || 0), 0),
    billsUpdated: plan.billsUpdated, // ✅ NEW — BILL months response
  };
}

// ✅ NEW — approved BILL decrease: each listed CMD approved month's bills go
// down by its amount (negative). The month is kept at the new rent
// (rentRevisionKeptMonths → ledger / owners / mail priced at it), the bills'
// netPayable / baseAmount / GST scaled, unpaid GST balance rows scaled. The
// bills keep originalAmount / decreasedAmount / decreaseRevisionId (once per bill).
// ✅ NEW — opts.skipHistory: rentalAmountHistory already written by applyRevision
// (applyToAllMonths 1 → site rent also goes down from the next bill)
async function applyBillDecrease(revision, media, userName, opts = {}) {
  const now = nowIST();
  const months = (revision.months || [])
    .map((x) => ({ month: x?.month, date: parseFromMonth(x?.month), amount: Number(x?.amount || 0), payment: x?.payment || null })) // ✅ CHANGED — + payment split
    .filter((x) => x.date && x.amount < 0);
  const $set = { updatedAt: now };
  const arrayFilters = [];
  const keptMonths = [];
  const gstRowUpdates = [];
  let gstBalanceDrop = 0;
  let fi = 0;
  for (const mo of months) {
    const key = monthKey(mo.date);
    const bills = (media.rentalDue || []).filter((b) => b && b.dueDate && monthKey(b.dueDate) === key);
    if (!bills.length) throw { message: `No bill for ${mo.month} on this site`, statusCode: 400 };
    if (billHasPayment(media, bills.map((b) => b._id))) throw { message: `${mo.month} bill already has a payment — decrease not allowed`, statusCode: 400 };
    if (bills.some((b) => b.decreaseRevisionId)) throw { message: `${mo.month} bill already decreased once`, statusCode: 400 };
    const { rent: monthRent, gstRent: monthGstRent } = rentPartsForDueDate(media, mo.date);
    const newRent = round(Number(monthRent || 0) + mo.amount);
    if (!(monthRent > 0) || newRent <= 0) throw { message: `decreaseAmount must be less than the ${mo.month} bill amount (${monthRent})`, statusCode: 400 };
    const ratio = newRent / monthRent;
    // ✅ NEW — month payment split → owners' cash / online of the month
    let ownerSplit = null;
    if (mo.payment) {
      const d = monthOwnerDeltas(media, mo.date, mo.amount, mo.payment, mo.month);
      if (d.error) throw { message: d.error, statusCode: 400 };
      const s = ownerSplitAfter(media, mo.date, d.deltas, mo.month);
      if (s.error) throw { message: s.error, statusCode: 400 };
      ownerSplit = s.split;
    }
    keptMonths.push({
      dueMonth: bills[0].dueMonth || mo.month,
      rent: newRent,
      ...(ownerSplit ? { ownerSplit } : {}),
      ...(monthGstRent !== monthRent ? { gstRent: round(Number(monthGstRent || 0) * ratio) } : {}),
      rentRevisionId: revision._id,
      keptAt: now,
    });
    bills.forEach((b) => {
      const u = `d${fi++}`;
      const oldNet = Number(b.netPayable || 0);
      $set[`rentalDue.$[${u}].netPayable`] = round(oldNet * ratio);
      $set[`rentalDue.$[${u}].baseAmount`] = round(Number(b.baseAmount || 0) * ratio);
      $set[`rentalDue.$[${u}].gstAmount`] = round(Number(b.gstAmount || 0) * ratio);
      $set[`rentalDue.$[${u}].originalAmount`] = oldNet;
      $set[`rentalDue.$[${u}].decreasedAmount`] = oldNet - round(oldNet * ratio);
      $set[`rentalDue.$[${u}].decreaseRevisionId`] = revision._id;
      $set[`rentalDue.$[${u}].decreasedAt`] = now;
      $set[`rentalDue.$[${u}].updatedBy`] = `${userName} (Rent Decrease)`;
      arrayFilters.push({ [`${u}._id`]: b._id });
      (media.gstBalanceHistory || [])
        .filter((g) => g && String(g.rentalDueId) === String(b._id) && !g.isPaid && !g.isUtrEntry)
        .forEach((g) => {
          const newGst = round(Number(g.gstAmount || 0) * ratio);
          gstBalanceDrop += Number(g.gstAmount || 0) - newGst;
          gstRowUpdates.push({ id: g._id, gstAmount: newGst });
        });
    });
  }
  // ✅ NEW — rentalAmountHistory log row per decreased month (site rent same)
  const siteRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const historyRows = opts.skipHistory
    ? []
    : revisionMonthRows(revision).map((r) =>
        revisionHistoryRow(revision, { siteRent, ...r, userName, now, extra: { isRevisionLog: true } }),
      );
  await Media.updateOne(
    { _id: media._id },
    {
      $set,
      $push: {
        "rentalPayment.rentRevisionKeptMonths": { $each: keptMonths },
        ...(historyRows.length ? { "rentalPayment.rentalAmountHistory": { $each: historyRows, $sort: { updatedAt: -1 } } } : {}),
      },
    },
    { arrayFilters, strict: false },
  );
  for (const g of gstRowUpdates) {
    await Media.updateOne(
      { _id: media._id },
      { $set: { "gstBalanceHistory.$[g].gstAmount": g.gstAmount } },
      { arrayFilters: [{ "g._id": g.id }], strict: false },
    );
  }
  if (gstBalanceDrop > 0) {
    await Media.updateOne({ _id: media._id }, { $inc: { "rentalPayment.balanceGstAmount": -gstBalanceDrop } });
  }
  revision.monthsDetail = (revision.monthsDetail || []).map((d0) => {
    const d = d0 && typeof d0.toObject === "function" ? d0.toObject() : { ...d0 };
    return { ...d, action: "billDecrease", decreased: true };
  });
  return { arrearsBills: [], arrearsTotal: 0 };
}

// ✅ NEW — BILL decrease: applyToAllMonths 1 → site rent / owners / later
// not-approved bills go down first (applyRevision), then the listed CMD
// approved bills are decreased (their month kept at the decreased rent)
async function applyBillDecreaseAllMonths(revision, media, userName) {
  if (Number(revision.applyToAllMonths) !== 1) return applyBillDecrease(revision, media, userName);
  await applyRevision(revision, media, userName);
  return applyBillDecrease(revision, media, userName, { skipHistory: true });
}

// ✅ NEW — decreased bills: the rental due CMD approval mail again at the new
// amount (one mail per month; all face bills of the month together)
async function sendDecreasedBillMails(revision) {
  const { sendRentalDueApprovalMail } = require("./RentalDueNew2Controller"); // lazy — no require cycle
  const fresh = await Media.findById(revision.mediaId);
  if (!fresh) return { mailSent: false, message: "Media not found" };
  const results = [];
  for (const x of revision.months || []) {
    const date = parseFromMonth(x?.month);
    if (!date || Number(x?.amount || 0) >= 0) continue;
    const key = monthKey(date);
    const entries = (fresh.rentalDue || []).filter((b) => b && b.dueDate && monthKey(b.dueDate) === key);
    if (!entries.length) continue;
    try {
      const r = await sendRentalDueApprovalMail(
        fresh,
        entries[0],
        entries.length > 1 ? entries.map((entry) => ({ media: fresh, entry })) : null,
      );
      results.push({ month: x.month, sent: !!r?.sent, message: r?.message || "" });
    } catch (e) {
      results.push({ month: x.month, sent: false, message: e?.message || "Mail error" });
    }
  }
  const sent = results.length > 0 && results.every((r) => r.sent);
  return { mailtype: "cmdapproval", mailSent: sent, mailSentAt: sent ? nowIST() : null, months: results, message: results.map((r) => `${r.month}: ${r.message}`).join("; ") };
}

// ✅ NEW — approved ADVANCE: advance bill (media.arrearsDue[], type "advance")
// for the advance month + deduction from the next bill
// (rentalPayment.advanceAdjustments). Returns { arrearsBills: [bill], arrearsTotal }.
async function applyAdvance(revision, media, userName) {
  const now = nowIST();
  const advanceAmount = Number(revision.advanceAmount || 0);
  const plan = buildAdvancePlan(media, revision.fromDate, advanceAmount, revision.gstOnIncrease ?? 0, revision.adjustInDate || null);
  if (plan.error) throw { message: plan.error, statusCode: 400 };
  // ✅ NEW — bill already generated (not paid) → its amounts go down now; its
  // approval status stays as it is
  const $set = { updatedAt: now };
  const arrayFilters = [];
  plan.billsToUpdate.forEach((b, i) => {
    $set[`rentalDue.$[v${i}].netPayable`] = b.newAmount;
    $set[`rentalDue.$[v${i}].baseAmount`] = b.baseAmount;
    $set[`rentalDue.$[v${i}].gstAmount`] = b.gstAmount;
    $set[`rentalDue.$[v${i}].updatedBy`] = `${userName} (Advance)`;
    $set[`rentalDue.$[v${i}].updatedAt`] = now;
    arrayFilters.push({ [`v${i}._id`]: b.rentalDueId });
  });
  // ✅ NEW — the bill's withGst may have been decided after the revision was created
  const withGstError = advanceWithGstError(media, plan.adjustInMonth, revision.withGst);
  if (withGstError) throw { message: withGstError, statusCode: 400 };
  const bill = withRevisionGst(toAdvanceBill(plan, { revisionId: revision._id, advanceDate: revision.fromDate, advanceAmount }, userName, now), revision); // ✅ CHANGED — + revision withGst
  // ✅ NEW — month payment split → owners' cash / online of the advance bill
  if (revision.advancePayment) {
    const d = monthOwnerDeltas(media, revision.fromDate, advanceAmount, revision.advancePayment, revision.fromMonth);
    if (d.error) throw { message: d.error, statusCode: 400 };
    applySplitToNewBills([bill], d.deltas);
  }
  await Media.updateOne(
    { _id: media._id },
    {
      $set,
      $push: {
        arrearsDue: bill,
        "rentalPayment.advanceAdjustments": {
          dueMonth: plan.adjustInMonth,
          amount: advanceAmount,
          gstDeducted: plan.advanceGstAmount > 0 ? 1 : 0,
          advanceBillId: bill._id,
          rentRevisionId: revision._id,
          createdAt: now,
        },
        // ✅ NEW — rentalAmountHistory log row (site rent same; the adjust-in bill goes down)
        "rentalPayment.rentalAmountHistory": {
          $each: [
            revisionHistoryRow(revision, {
              siteRent: Number(media.rentalPayment?.totalRentalAmount || 0),
              month: revision.fromMonth,
              changeAmount: advanceAmount,
              before: plan.fullBillRent ?? plan.billRent ?? null,
              after: plan.balanceAmount ?? null,
              userName,
              now,
              extra: { isRevisionLog: true, adjustInMonth: plan.adjustInMonth || "" },
            }),
          ],
          $sort: { updatedAt: -1 },
        },
      },
    },
    arrayFilters.length ? { arrayFilters, strict: false } : { strict: false },
  );
  // rental due history amount too (old sites may miss a level → not blocking)
  for (const b of plan.billsToUpdate) {
    try {
      await Media.updateOne(
        { _id: media._id },
        { $set: { "rentalDueHistory.$[].months.$[].entries.$[h].netPayable": b.newAmount } },
        { arrayFilters: [{ "h.rentalDueId": b.rentalDueId }], strict: false },
      );
    } catch (e) {
      console.error("advance rentalDueHistory update:", e.message);
    }
  }
  revision.adjustInMonth = plan.adjustInMonth;
  revision.adjustInDate = plan.adjustInDate;
  revision.advanceGstAmount = plan.advanceGstAmount;
  revision.advanceBillId = bill._id;
  return { arrearsBills: [bill], arrearsTotal: advanceAmount };
}

// ✅ NEW — mail "bill" for a month whose bill was increased (not CMD approved
// yet): amounts = that month's increase, owners split by their share
function increaseMailBill(media, { month, amount, gstAmount, currentAmount, rentalDueId }) {
  const dues = media.rentalDue || [];
  const due = dues.find((b) => String(b._id) === String(rentalDueId)) || dues.find((b) => b.dueMonth === month) || {};
  const ratio = currentAmount > 0 ? amount / currentAmount : 0;
  const owners = media.landOwners || [];
  const totalShare = owners.reduce((s, o) => s + Number(o.shareAmount || 0), 0);
  return {
    _id: due._id || rentalDueId,
    type: "billUpdate",
    label: `Rent Increase – ${month}`,
    parentRentalDueId: due._id || rentalDueId || null,
    mediaDetailId: due.mediaDetailId || null,
    dueMonth: month,
    dueDate: due.dueDate || null,
    netPayable: amount,
    gstAmount,
    withGst: Number(due.withGst || 0),
    owners: owners.map((o) => ({
      landOwnerId: o._id,
      shareAmount: round(Number(o.shareAmount || 0) * ratio),
      cashAmount: round(Number(o.cashAmount || 0) * ratio),
      onlineAmount: round(Number(o.onlineAmount || 0) * ratio),
      gstAmount: totalShare > 0 ? round((gstAmount * Number(o.shareAmount || 0)) / totalShare) : 0,
      tdsAmount: 0,
    })),
  };
}

// one revision → { statusCode, message, data } (statusCode >= 400 = not done)
async function approveOneRevision(revisionId, { action, remark, role, user, withGst = null, invoice = null }) {
  const userName = user?.userName || "";
  if (!revisionId || !mongoose.Types.ObjectId.isValid(String(revisionId))) {
    return { statusCode: 400, message: "revisionId is not a valid ObjectId" };
  }
  const revision = await RentRevision.findById(revisionId);
  if (!revision) return { statusCode: 404, message: "Rent revision not found" };
  if (revision.status !== "Pending") {
    return { statusCode: 400, message: `This rent revision is already ${revision.status}` };
  }
  const step = revision.approvalSteps.find((s) => Number(s.role) === role);
  // ✅ CHANGED — same role approves again (revision still Pending) → its approval
  // is updated (remark / by / time); the earlier one goes to approvalHistory.
  // Next role and the site are not changed. action 2 still rejects.
  if (step && step.status === "Approved" && action === 1) {
    // ✅ NEW — withGst 1 / 2 sent → saved on the revision
    const reWithGstError = await applyApproveWithGst(revision, withGst, { role, user });
    if (reWithGstError) return { statusCode: 400, message: reWithGstError };
    if (invoice) revision.invoice = invoice; // ✅ NEW — invoice PDF sent on approve → replaces the saved one
    const now = nowIST();
    revision.approvalHistory = [
      ...(revision.approvalHistory || []),
      {
        role: step.role,
        roleName: step.roleName || ROLE_NAMES[role],
        status: step.status,
        by: step.by || "",
        byUserId: step.byUserId || null,
        at: step.at || null,
        remark: step.remark || "",
        replacedAt: now,
      },
    ];
    step.by = user?.userName || "";
    step.byUserId = mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null;
    step.at = now;
    step.remark = remark ? String(remark).trim() : "";
    await revision.save();
    return {
      statusCode: 200,
      message: `Rent revision approval updated by ${ROLE_NAMES[role]}${revision.currentPendingRole ? ` — waiting for ${ROLE_NAMES[revision.currentPendingRole]}` : ""}`,
      data: {
        revisionId: revision._id,
        mediaId: revision.mediaId,
        mediaCode: revision.mediaCode,
        ...billTypeFields(revision),
        invoice: revision.invoice || null, // ✅ NEW
        status: revision.status,
        currentPendingRole: revision.currentPendingRole ?? null,
        currentPendingRoleName: revision.currentPendingRole ? ROLE_NAMES[revision.currentPendingRole] : null,
        lastRemark: lastRemarkOf(revision.approvalSteps), // ✅ NEW
        approvalSteps: formatSteps(revision.approvalSteps),
        approvalHistory: revision.approvalHistory,
      },
    };
  }
  // CMD can approve / reject directly (Executive / Manager not done yet → Skipped)
  if (Number(revision.currentPendingRole) !== role && role !== 3) {
    return { statusCode: 403, message: `Waiting on ${ROLE_NAMES[revision.currentPendingRole] || "another role"}` };
  }
  // ✅ NEW — approve with withGst 1 / 2 → saved on the revision (CMD → used for the bills)
  if (action === 1) {
    const withGstError = await applyApproveWithGst(revision, withGst, { role, user });
    if (withGstError) return { statusCode: 400, message: withGstError };
    // ✅ NEW — invoice PDF sent on approve → replaces the saved one (CMD mail gstInvoiceUrl)
    if (invoice) revision.invoice = invoice;
  }

  const now = nowIST();
  step.status = action === 1 ? "Approved" : "Rejected";
  step.by = userName;
  step.byUserId = mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null;
  step.at = now;
  step.remark = remark ? String(remark).trim() : "";
  if (role === 3) {
    revision.approvalSteps.forEach((st) => {
      if (Number(st.role) < 3 && st.status === "Pending") {
        st.status = "Skipped";
        st.at = now;
        st.remark = "Skipped — CMD decided directly";
      }
    });
  }

  const base = () => ({
    revisionId: revision._id,
    mediaId: revision.mediaId,
    mediaCode: revision.mediaCode,
    ...billTypeFields(revision),
    invoice: revision.invoice || null, // ✅ NEW
    status: revision.status,
  });
  const isAdvance = revision.billType === "ADVANCE";
  const noun = isAdvance ? "Advance" : "Rent revision";

  // ── reject → closed, nothing changes on the site
  if (action === 2) {
    revision.status = "Rejected";
    revision.currentPendingRole = null;
    revision.rejectedAt = now;
    await revision.save();
    return {
      statusCode: 200,
      message: `${noun} rejected by ${ROLE_NAMES[role]}`,
      data: { ...base(), lastRemark: lastRemarkOf(revision.approvalSteps), approvalSteps: formatSteps(revision.approvalSteps) }, // ✅ CHANGED — + lastRemark
    };
  }

  // ── Executive / Manager → next role
  if (role !== 3) {
    revision.currentPendingRole = role + 1;
    await revision.save();
    return {
      statusCode: 200,
      message: `${noun} approved by ${ROLE_NAMES[role]} — waiting for ${ROLE_NAMES[role + 1]}`,
      data: {
        ...base(),
        currentPendingRole: role + 1,
        currentPendingRoleName: ROLE_NAMES[role + 1],
        lastRemark: lastRemarkOf(revision.approvalSteps), // ✅ NEW
        approvalSteps: formatSteps(revision.approvalSteps),
      },
    };
  }

  // ── CMD → apply to the site
  const media = await Media.findById(revision.mediaId).select(RENT_REVISION_MEDIA_FIELDS).lean();
  if (!media) return { statusCode: 404, message: "Media not found for this rent revision" };

  const isDecrease = !isAdvance && revision.revisionAction === "decrease"; // ✅ NEW
  let result;
  try {
    result = isAdvance
      ? await applyAdvance(revision, media, userName)
      : isDecrease
        ? await applyBillDecreaseAllMonths(revision, media, userName) // ✅ NEW
        : await applyRevision(revision, media, userName);
  } catch (e) {
    if (e && e.statusCode) return { statusCode: e.statusCode, message: e.message };
    throw e;
  }

  // ✅ NEW — BILL "months": each month's arrears bill / updated bill
  if (!isAdvance && !isDecrease && Array.isArray(revision.monthsDetail) && revision.monthsDetail.length) {
    revision.monthsDetail = revision.monthsDetail.map((d0) => {
      const d = d0 && typeof d0.toObject === "function" ? d0.toObject() : { ...d0 };
      const arrears = (result.arrearsBills || []).filter((b) => b.dueMonth === d.month);
      const updated = (result.billsUpdated || []).filter((b) => b.dueMonth === d.month);
      if (arrears.length) {
        return {
          ...d,
          action: "arrears",
          arrearsRentalDueId: arrears[0]._id,
          ...(arrears.length > 1 ? { arrearsRentalDueIds: arrears.map((b) => b._id) } : {}),
          gstAmount: arrears.reduce((s, b) => s + Number(b.gstAmount || 0), 0),
        };
      }
      if (updated.length) {
        return { ...d, action: "billUpdate", rentalDueId: updated[0].rentalDueId, newAmount: updated.reduce((s, b) => s + Number(b.newAmount || 0), 0) };
      }
      return d;
    });
  }
  revision.status = "Approved";
  revision.currentPendingRole = null;
  revision.approvedAt = now;
  revision.arrearsTotal = result.arrearsTotal;
  await revision.save();

  // ✅ NEW — decrease: the decreased bills' CMD approval mail again (new amount)
  if (isDecrease) {
    revision.mail = await sendDecreasedBillMails(revision);
    await revision.save();
  }

  // ✅ CHANGED — ONE CMD approval mail for the revision through the new PHP mail
  // (newBillCmdApproval.php): BILL → month-wise New Bill / bill increase
  // amounts, ADVANCE → the advance bill. No bill dates in the mail. Result →
  // revision.mail and each new bill's mailSent. A mail failure does not undo
  // the approval.
  if (!isDecrease) {
    // ✅ NEW — New Bill / Advance bill → ADINN OOH bill number (one per revision),
    // given before the mail (mail shows it as Bill No)
    const newBillIds = (result.arrearsBills || []).map((b) => b._id).filter(Boolean);
    if (newBillIds.length) {
      const no = await ensureRevisionAdinnOohBill({
        mediaId: revision.mediaId,
        revisionId: revision._id,
        kind: isAdvance ? "advance" : "newbill",
        dueMonth: (result.arrearsBills[0] && result.arrearsBills[0].dueMonth) || revision.fromMonth || "",
        billIds: newBillIds,
        billDate: new Date(),
      });
      if (no) {
        (result.arrearsBills || []).forEach((b) => (b.adinn_ooh_bills = no));
        revision.adinn_ooh_bills = no;
        await revision.save();
      }
    }
    const freshMedia = (await Media.findById(revision.mediaId).select(RENT_REVISION_MEDIA_FIELDS).lean()) || media;
    const ownerTotals = new Map();
    const addOwners = (owners) =>
      (owners || []).forEach((o) => {
        const k = String(o.landOwnerId);
        const cur = ownerTotals.get(k) || { landOwnerId: o.landOwnerId, shareAmount: 0, cashAmount: 0, onlineAmount: 0, gstAmount: 0 };
        ["shareAmount", "cashAmount", "onlineAmount", "gstAmount"].forEach((f) => (cur[f] += Number(o[f] || 0)));
        ownerTotals.set(k, cur);
      });
    const arrearsBills = result.arrearsBills || [];
    const rows = [];
    let advanceBill = null;
    let withGst = 0;

    if (isAdvance) {
      advanceBill = arrearsBills[0] || null;
      if (advanceBill) {
        addOwners(advanceBill.owners);
        withGst = Number(advanceBill.withGst || 0);
      }
    } else {
      const dueOf = (id) => (media.rentalDue || []).find((b) => String(b._id) === String(id)) || {};
      const addIncrease = (im) => {
        addOwners(increaseMailBill(media, im).owners);
        rows.push({ month: im.month, type: "billUpdate", amount: im.amount, gstAmount: im.gstAmount });
        if (!withGst) withGst = Number(dueOf(im.rentalDueId).withGst || 0);
      };
      const addNewBill = (month) => {
        const bills = arrearsBills.filter((b) => b.dueMonth === month);
        if (!bills.length) return false;
        bills.forEach((b) => addOwners(b.owners));
        rows.push({
          month,
          type: "newBill",
          amount: bills.reduce((s, b) => s + Number(b.netPayable || 0), 0),
          gstAmount: bills.reduce((s, b) => s + Number(b.gstAmount || 0), 0),
        });
        if (!withGst) withGst = Number(bills[0].withGst || 0);
        return true;
      };
      const detail = (revision.monthsDetail || []).map((d) => (d && typeof d.toObject === "function" ? d.toObject() : d)).filter(Boolean);
      if (detail.length) {
        detail.forEach((d) => {
          if (addNewBill(d.month)) return;
          if (d.action === "billUpdate" || (revision.months || []).length) {
            addIncrease({ month: d.month, amount: Number(d.amount || 0), gstAmount: Number(d.gstAmount || 0), currentAmount: Number(d.currentAmount || 0), rentalDueId: d.rentalDueId });
          }
        });
      } else {
        [...new Set(arrearsBills.map((b) => b.dueMonth))].forEach(addNewBill);
        const fromUpdated = (result.billsUpdated || []).filter((b) => b.dueMonth === revision.fromMonth);
        if (fromUpdated.length) {
          addIncrease({
            month: revision.fromMonth,
            amount: Number(revision.increaseAmount ?? revision.difference ?? 0),
            gstAmount: Number(revision.increaseGstAmount || 0),
            currentAmount: fromUpdated.reduce((s, b) => s + Number(b.oldAmount || 0), 0),
            rentalDueId: fromUpdated[0].rentalDueId,
          });
        }
      }
    }

    // ✅ NEW — withGst 1 / 2 sent on the revision (with GST) → mail hold / direct as per it
    if (Number(revision.withGst || 0) > 0 && Number(revision.gstOnIncrease) === 1) withGst = Number(revision.withGst);

    if (advanceBill || rows.length) {
      let mail;
      try {
        mail = await sendNewBillCmdMail(freshMedia, revision, { rows, advanceBill, owners: [...ownerTotals.values()], withGst });
      } catch (mailErr) {
        mail = { mailtype: NEW_BILL_MAIL_TYPE, sent: false, message: mailErr?.message || "Mail error" };
      }
      const sentAt = mail.sent ? nowIST() : null;
      for (const b of arrearsBills) {
        await Media.updateOne(
          { _id: revision.mediaId },
          { $set: { "arrearsDue.$[a].mailSent": !!mail.sent, "arrearsDue.$[a].mailSentAt": sentAt } },
          { arrayFilters: [{ "a._id": b._id }], strict: false },
        );
      }
      const { sent, ...mailInfo } = mail;
      revision.mail = { ...mailInfo, mailSent: !!sent, mailSentAt: sentAt };
      await revision.save();
    }
  }

  return {
    statusCode: 200,
    message: isAdvance
      ? `Advance approved by CMD — ${revision.fromMonth} advance bill generated (adjusted in ${revision.adjustInMonth})`
      : isDecrease // ✅ NEW
        ? `Rent revision approved by CMD — ${(revision.months || []).map((x) => x.month).join(", ") || revision.fromMonth} bill decreased`
      : Array.isArray(revision.months) && revision.months.length > 1
        ? `Rent revision approved by CMD and applied for ${revision.fromMonth} – ${revision.toMonth}`
        : `Rent revision approved by CMD and applied from ${revision.fromMonth}`,
    data: {
      ...base(),
      currentPendingRole: null,
      lastRemark: lastRemarkOf(revision.approvalSteps), // ✅ NEW
      approvalSteps: formatSteps(revision.approvalSteps),
      mail: revision.mail || null, // ✅ NEW — new bill CMD mail result
      adinn_ooh_bills: revision.adinn_ooh_bills || null, // ✅ NEW — New Bill / Advance bill number
    },
  };
}

// revisionId: array, JSON string array or a single id
const parseRevisionIds = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const t = value === undefined || value === null ? "" : String(value).trim();
  if (t.startsWith("[")) {
    try {
      const list = JSON.parse(t);
      if (Array.isArray(list)) return list.map((v) => String(v).trim()).filter(Boolean);
    } catch (e) {
      // not JSON → treated as a single id below
    }
  }
  return t ? [t] : [];
};

// ── POST /admin/rent-revision/approve ────────────────────────
// revisionId: one id (single response) or an array (results[] / failed[])
// ✅ NEW — POST /admin/rent-revision/cancel-revert { revisionId, reason }
// CANCEL revision undone: bills back to CMD approved (old approval / amount /
// ADINN OOH number). Any role (Executive / Manager / CMD). No mail.
exports.revertCancelRevision = async (req, res) => {
  try {
    const revisionId = String(req.body?.revisionId || "").trim();
    const reason = String(req.body?.reason || "").trim();
    if (!revisionId) return errorResponse(res, "revisionId is required", null, 400);
    if (!reason) return errorResponse(res, "reason is required", null, 400);
    const r = await revertCancelRevision(revisionId, { reason, user: req.user });
    if (r.statusCode >= 400) return errorResponse(res, r.message, null, r.statusCode);
    return successResponse(res, r.message, r.data);
  } catch (err) {
    console.error("❌ Cancel revert error:", err);
    return errorResponse(res, err?.message || "Cancel revert failed", null, err?.statusCode || 500);
  }
};

exports.approveRentRevision = async (req, res) => {
  try {
    const { remark } = req.body || {};
    const action = Number(req.body?.action);
    const role = Number(req.user?.userType);
    const isBulk = Array.isArray(req.body?.revisionId) || String(req.body?.revisionId || "").trim().startsWith("[");
    const ids = [...new Set(parseRevisionIds(req.body?.revisionId))];
    if (ids.length === 0) return errorResponse(res, "revisionId is required", null, 400);
    if (![1, 2].includes(action)) {
      return errorResponse(res, "action must be 1 (approve) or 2 (reject)", null, 400);
    }
    if (![1, 2, 3].includes(role)) {
      return errorResponse(res, "Only Rental Executive, Rental Manager or CMD can approve a rent revision", null, 403);
    }
    // ✅ NEW — optional withGst on approve: 1 (GST hold) / 2 (direct) only
    let withGst = null;
    const rawWithGst = req.body?.withGst;
    if (rawWithGst !== undefined && rawWithGst !== null && String(rawWithGst).trim() !== "" && String(rawWithGst).trim() !== "null") {
      withGst = Number(String(rawWithGst).trim());
      if (withGst !== 1 && withGst !== 2) return errorResponse(res, "withGst must be 1 (GST hold) or 2 (direct)", null, 400);
    }
    // ✅ NEW — optional invoice PDF (form-data key "invoice") on approve
    let invoice = null;
    const invoiceFile = (req.files || []).find((f) => f.fieldname === "invoice");
    if (invoiceFile) {
      const isPdf = invoiceFile.mimetype === "application/pdf" || /\.pdf$/i.test(invoiceFile.originalname || "");
      if (!isPdf) return errorResponse(res, "invoice must be a PDF file", null, 400);
      invoice = typeof req.processFile === "function" ? req.processFile(invoiceFile) : null;
    }
    const opts = { action, remark, role, user: req.user, withGst, invoice };

    if (!isBulk) {
      const r = await approveOneRevision(ids[0], opts);
      if (r.statusCode >= 400) return errorResponse(res, r.message, null, r.statusCode);
      return successResponse(res, r.message, r.data);
    }

    const results = [];
    const failed = [];
    for (const id of ids) {
      const r = await approveOneRevision(id, opts);
      if (r.statusCode >= 400) failed.push({ revisionId: id, statusCode: r.statusCode, message: r.message });
      else results.push({ ...r.data, message: r.message });
    }
    if (results.length === 0) {
      return errorResponse(res, failed.length === 1 ? failed[0].message : "No rent revision processed", { failed }, 400);
    }
    let verb = `rejected by ${ROLE_NAMES[role]}`;
    if (action === 1) verb = role === 3 ? "approved by CMD and applied" : `approved by ${ROLE_NAMES[role]}`;
    return successResponse(res, `${results.length} rent revision(s) ${verb}`, { results, failed }, failed.length ? 207 : 200);
  } catch (error) {
    console.error("approveRentRevision error:", error);
    return errorResponse(res, "Something went wrong while approving rent revision", { error: error.message }, 500);
  }
};

// ✅ NEW — rent-revision-list "site" block: current rent, payment frequency and
// the last CMD-approved bill (previousBill). Same-month bills (multi-face) are
// summed. null previousBill → no CMD-approved bill yet.
const PAYMENT_FREQUENCY_LABELS = { 1: "Monthly", 2: "Quarterly", 3: "Half-Yearly", 4: "Yearly", 5: "2 Years", 6: "Custom" };
function revisionSiteBlock(media) {
  const rp = media?.rentalPayment || {};
  const approved = (media?.rentalDue || [])
    .filter((b) => b && Number(b.approvalStatus) === 3 && b.dueDate)
    .sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));
  let previousBill = null;
  if (approved.length) {
    const lastKey = monthKey(approved[0].dueDate);
    const sameMonth = approved.filter((b) => monthKey(b.dueDate) === lastKey);
    const approvedAts = sameMonth.map((b) => b.ownerApprovalDate).filter(Boolean).map((d) => new Date(d));
    previousBill = {
      rentalDueId: sameMonth[0]._id,
      month: sameMonth[0].dueMonth || monthLabelOfKey(lastKey),
      amount: sameMonth.reduce((s, b) => s + Number(b.netPayable || 0), 0),
      cmdApprovedAt: approvedAts.length ? new Date(Math.max(...approvedAts.map((d) => d.getTime()))) : null,
    };
  }
  const freq = Number(rp.paymentFrequency) || null;
  return {
    currentRent: Number(rp.totalRentalAmount || 0),
    paymentFrequency: freq,
    paymentFrequencyLabel: freq ? PAYMENT_FREQUENCY_LABELS[freq] || "" : "",
    customPaymentFrequency: freq === 6 ? Number(rp.customPaymentFrequency) || null : null,
    previousBill,
  };
}

// ✅ NEW — rent-revision-list "siteBills" (mediaId sent): payment frequency of
// the site and every generated bill month (dueMonth + withGst), oldest first.
// Same-month bills (multi-face) → one row, the highest withGst. null when the
// site is not found.
async function revisionSiteBills(mediaId) {
  const media = await Media.findById(mediaId)
    .select("mediaDetails rentalPayment landOwners rentalDue arrearsDue ledger withGst1Ledger ledgerHistory gstBalanceHistory") // ✅ CHANGED — + arrearsDue, + ledger fields (UTREntry)
    .lean();
  if (!media) return null;
  // ✅ NEW — months with a CMD approved New Bill / Advance bill (by the bill's own month)
  const extraBillMonths = { arrears: new Set(), advance: new Set() };
  (media.arrearsDue || []).forEach((b) => {
    if (!b || (b.type !== "arrears" && b.type !== "advance") || Number(b.approvalStatus) !== 3) return;
    const label = b.dueMonth || (b.dueDate ? monthLabelOfKey(monthKey(b.dueDate)) : "");
    if (label) extraBillMonths[b.type].add(label);
  });
  const rp = media.rentalPayment || {};
  const ymd = (d) => {
    const dt = d ? new Date(d) : null;
    return dt && !Number.isNaN(dt.getTime()) ? dt.toISOString().split("T")[0] : null;
  };
  const byMonth = new Map(); // monthKey → { dueMonth, withGst, dueDate, cmdApproved }
  (media.rentalDue || []).forEach((b) => {
    const k = b && monthKey(b.dueDate);
    if (k === null || k === undefined) return;
    const withGst = Number(b.withGst || 0);
    // ✅ NEW — 1 when the month's bill is CMD approved (most approved bill of the month)
    const cmdApproved = Number(b.approvalStatus) === 3 ? 1 : 0;
    const cur = byMonth.get(k);
    if (!cur) byMonth.set(k, { dueMonth: b.dueMonth || monthLabelOfKey(k), withGst, dueDate: b.dueDate, cmdApproved, billIds: [b._id] });
    else {
      if (withGst > cur.withGst) cur.withGst = withGst;
      if (cmdApproved > cur.cmdApproved) cur.cmdApproved = cmdApproved;
      cur.billIds.push(b._id); // ✅ NEW — UTREntry
    }
  });
  const months = [...byMonth.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const lastBill = months[months.length - 1] || null;
  const next = nextBillDateAfter(media, lastBill ? lastBill.dueDate : new Date());
  const freq = Number(rp.paymentFrequency) || null;
  const gstPercentage = gstPercentageFor(media, lastBill ? lastBill.dueDate : new Date());
  const { mediaCode, mediaName } = siteCodeName(media);
  return {
    mediaId: media._id,
    mediaCode,
    mediaName,
    currentRent: Number(rp.totalRentalAmount || 0),
    gstPercentage,
    siteHasGst: gstPercentage > 0,
    paymentFrequency: freq,
    paymentFrequencyLabel: freq ? PAYMENT_FREQUENCY_LABELS[freq] || "" : "",
    customPaymentFrequency: freq === 6 ? Number(rp.customPaymentFrequency) || null : null,
    cycleMonths: cycleMonthsOf(rp),
    billingStartDate: ymd(rp.billingStartDate),
    lastBillDate: lastBill ? ymd(lastBill.dueDate) : null,
    nextBillingDate: ymd(rp.nextBillingDate),
    nextBillMonth: next ? monthLabelOfKey(monthKey(next)) : "",
    billCount: months.length,
    bills: months.map((m) => ({
      dueMonth: m.dueMonth,
      withGst: m.withGst,
      cmdApproved: m.cmdApproved,
      newBillGenerated: extraBillMonths.arrears.has(m.dueMonth) ? 1 : 0, // ✅ NEW
      advanceGenerated: extraBillMonths.advance.has(m.dueMonth) ? 1 : 0, // ✅ NEW
      // ✅ NEW — 0 not CMD approved, 1 CMD approved (no payment), 2 ledger / UTR entry done
      UTREntry: billHasPayment(media, m.billIds) ? 2 : m.cmdApproved ? 1 : 0,
    })),
  };
}

// ── GET /admin/rent-revision-list ────────────────────────────
exports.getRentRevisionList = async (req, res) => {
  try {
    const q = { ...(req.body || {}), ...(req.query || {}) };
    const pageNumber = Math.max(1, parseInt(q.pageNumber, 10) || 1);
    const count = Math.max(1, parseInt(q.count, 10) || 10);
    const filter = {};
    // ✅ NEW — mediaId as an array (JSON array / JSON string / "id1,id2") →
    // revisions of all those sites; siteBills becomes an array. A single id
    // (plain string) works exactly as before.
    const mediaIdArrayMode =
      Array.isArray(q.mediaId) || (typeof q.mediaId === "string" && (q.mediaId.trim().startsWith("[") || q.mediaId.includes(",")));
    let arrayMediaIds = null;
    const invalidMediaIds = [];
    if (mediaIdArrayMode) {
      arrayMediaIds = [];
      parseMediaIds(q.mediaId).forEach((id) => {
        if (mongoose.Types.ObjectId.isValid(String(id))) arrayMediaIds.push(String(id));
        else invalidMediaIds.push({ mediaId: id, message: "mediaId is not a valid ObjectId" });
      });
      if (arrayMediaIds.length === 0) return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
      filter.mediaId = { $in: arrayMediaIds.map((id) => new mongoose.Types.ObjectId(id)) };
    } else if (q.mediaId) {
      if (!mongoose.Types.ObjectId.isValid(String(q.mediaId))) {
        return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
      }
      filter.mediaId = new mongoose.Types.ObjectId(String(q.mediaId));
    }
    if (q.status && ["Pending", "Approved", "Rejected"].includes(String(q.status))) filter.status = String(q.status);
    if (q.currentPendingRole && [1, 2, 3].includes(Number(q.currentPendingRole))) {
      filter.currentPendingRole = Number(q.currentPendingRole);
    }
    // ✅ NEW — billType filter (old revisions without billType are BILL)
    const billTypeFilter = q.billType ? String(q.billType).trim().toUpperCase() : "";
    if (billTypeFilter === "ADVANCE") filter.billType = "ADVANCE";
    else if (AUTO_BILL_TYPES.includes(billTypeFilter)) filter.billType = billTypeFilter; // ✅ NEW — NORMAL_BILL / CANCEL
    else if (billTypeFilter === "BILL" || billTypeFilter === "NEW_BILL") filter.billType = { $nin: ["ADVANCE", ...AUTO_BILL_TYPES] }; // ✅ CHANGED — + NEW_BILL, not NORMAL_BILL / CANCEL

    const [rows, totalCount] = await Promise.all([
      RentRevision.find(filter).sort({ createdAt: -1 }).skip((pageNumber - 1) * count).limit(count).lean(),
      RentRevision.countDocuments(filter),
    ]);

    // arrears paid / pending from the site's arrears bills
    const mediaIds = [...new Set(rows.map((r) => String(r.mediaId)))];
    const medias = mediaIds.length
      ? await Media.find({ _id: { $in: mediaIds } })
          .select(
            "arrearsDue rentalPayment.totalRentalAmount rentalPayment.paymentFrequency rentalPayment.customPaymentFrequency " +
              "rentalDue._id rentalDue.dueMonth rentalDue.dueDate rentalDue.netPayable rentalDue.approvalStatus rentalDue.ownerApprovalDate " +
              "landOwners._id landOwners.name landOwners.shareAmount", // ✅ CHANGED — + landowners (payment.landOwners)
          )
          .lean()
      : [];
    const siteById = new Map(medias.map((m) => [String(m._id), revisionSiteBlock(m)]));
    // ✅ NEW — month payment sent at month level (no landOwners) → + landOwners:
    // the split per site landowner (one landowner → the whole split; several →
    // by share). Payment with landOwners / no payment → unchanged.
    const ownersById = new Map(medias.map((m) => [String(m._id), m.landOwners || []]));
    const withPaymentOwners = (payment, mediaId, amount) => {
      if (!payment || typeof payment !== "object" || Array.isArray(payment.landOwners)) return payment;
      const owners = ownersById.get(String(mediaId)) || [];
      if (!owners.length) return payment;
      const abs = Math.abs(Number(amount || 0));
      const pc = Number(payment.paymentCategory);
      const cashTotal = pc === 1 ? abs : pc === 2 ? 0 : Number(payment.cashAmount || 0);
      const onlineTotal = pc === 1 ? 0 : pc === 2 ? abs : Number(payment.onlineAmount || 0);
      const weights = owners.map((o) => Number(o.shareAmount || 0));
      const shares = splitByWeights(cashTotal + onlineTotal, weights);
      const rawCash = splitByWeights(cashTotal, weights);
      return {
        ...payment,
        landOwners: owners.map((o, i) => {
          const cash = Math.min(rawCash[i], shares[i]);
          const online = shares[i] - cash;
          return {
            landOwnerId: o._id,
            landOwnerName: o.name || "",
            paymentCategory: pc === 3 ? 3 : cash > 0 && online > 0 ? 3 : online > 0 ? 2 : 1,
            cashAmount: cash,
            onlineAmount: online,
          };
        }),
      };
    };
    const billsByRevision = new Map();
    medias.forEach((m) =>
      (m.arrearsDue || []).forEach((b) => {
        const k = String(b.rentRevisionId);
        if (!billsByRevision.has(k)) billsByRevision.set(k, []);
        billsByRevision.get(k).push(b);
      }),
    );

    const billMonthsById = new Map(
      medias.map((m) => [String(m._id), new Set((m.rentalDue || []).map((b) => b && b.dueMonth).filter(Boolean))]),
    );

    const list = rows.map((r) => {
      const bills = billsByRevision.get(String(r._id)) || [];
      const arrearsPaid = bills.reduce((s, b) => s + Number(b.rentPaid || 0), 0);
      const arrearsTotal = Number(r.arrearsTotal || 0);
      const isAdvance = r.billType === "ADVANCE";
      // ✅ NEW — ADVANCE: its advance bill + whether the next bill already took the deduction
      const advBill = isAdvance ? bills.find((b) => b.type === "advance") || null : null;
      const advanceFields = isAdvance
        ? {
            advanceBill: advBill
              ? {
                  rentalDueId: advBill._id,
                  dueMonth: advBill.dueMonth,
                  amount: Number(advBill.netPayable || 0),
                  gstAmount: Number(advBill.gstAmount || 0),
                  tdsAmount: 0,
                  paid: Number(advBill.rentPaid || 0),
                  pending: Math.max(0, Number(advBill.netPayable || 0) - Number(advBill.rentPaid || 0)),
                  gstPaid: Number(advBill.gstPaid || 0),
                  status: arrearsStatus(advBill),
                  mailSent: !!advBill.mailSent,
                  mailSentAt: advBill.mailSentAt || null,
                }
              : null,
            adjusted: !!(advBill && billMonthsById.get(String(r.mediaId))?.has(advBill.adjustInMonth)),
            // ✅ NEW — ADVANCE months[] (same shape as BILL): the advance month with its
            // payment split — sent split, else the advance bill's owners (single
            // landowner / no split sent too); null before CMD approval without a split
            months: [
              {
                month: r.fromMonth,
                adjustInMonth: r.adjustInMonth || "",
                amount: Number(r.advanceAmount || 0),
                gstAmount: Number(r.advanceGstAmount || 0),
                totalAmount: Number(r.advanceAmount || 0) + Number(r.advanceGstAmount || 0),
                action: "advance",
                payment:
                  withPaymentOwners(r.advancePayment, r.mediaId, r.advanceAmount) || // ✅ CHANGED — + landOwners
                  (advBill && Array.isArray(advBill.owners) && advBill.owners.length
                    ? {
                        landOwners: advBill.owners.map((o) => ({
                          landOwnerId: o.landOwnerId,
                          landOwnerName: o.landOwnerName || "",
                          paymentCategory: Number(o.requestedPaymentCategory || o.paymentCategory || 1),
                          cashAmount: Number(o.cashAmount || 0),
                          onlineAmount: Number(o.onlineAmount || 0),
                        })),
                      }
                    : null),
                advanceRentalDueId: advBill ? advBill._id : null,
                ...(advBill ? { paymentStatus: arrearsStatus(advBill) } : {}),
              },
            ],
          }
        : {};
      return {
        revisionId: r._id,
        mediaId: r.mediaId,
        mediaCode: r.mediaCode,
        mediaName: r.mediaName,
        ...billTypeFields({ ...r, billType: isAdvance ? "ADVANCE" : AUTO_BILL_TYPES.includes(r.billType) ? r.billType : "BILL" }), // ✅ CHANGED — NORMAL_BILL / CANCEL kept
        ...(isAdvance ? {} : { difference: r.difference }),
        ...advanceFields,
        // ✅ NEW — CMD approval mail of months whose bill was increased (no arrears bill)
        ...(!isAdvance ? { billUpdateMails: r.billUpdateMails || [], mail: r.mail || null } : {}),
        // ✅ NEW — BILL "months": payment status of each month's arrears bill
        ...(!isAdvance && Array.isArray(r.monthsDetail) && r.monthsDetail.length
          ? {
              months: r.monthsDetail.map((d0) => {
                const d = d0 && d0.payment ? { ...d0, payment: withPaymentOwners(d0.payment, r.mediaId, d0.amount) } : d0; // ✅ NEW — + payment.landOwners
                const bill = d.arrearsRentalDueId ? bills.find((b) => String(b._id) === String(d.arrearsRentalDueId)) : null;
                return bill ? { ...d, paymentStatus: arrearsStatus(bill) } : { ...d };
              }),
            }
          : {}),
        invoice: r.invoice || null,
        reason: r.reason,
        status: r.status,
        currentPendingRole: r.currentPendingRole ?? null,
        currentPendingRoleName: r.currentPendingRole ? ROLE_NAMES[r.currentPendingRole] : null,
        lastRemark: lastRemarkOf(r.approvalSteps), // ✅ NEW
        approvalSteps: formatSteps(r.approvalSteps),
        arrearsTotal,
        arrearsPaid,
        arrearsPending: Math.max(0, arrearsTotal - arrearsPaid),
        arrearsBills: bills.map((b) => ({
          rentalDueId: b._id,
          label: newBillLabel(b.label), // ✅ CHANGED — "New Bill – …"
          dueMonth: b.dueMonth,
          netPayable: b.netPayable,
          gstAmount: b.gstAmount,
          tdsAmount: 0, // ✅ CHANGED — no TDS on arrears
          rentPaid: b.rentPaid || 0,
          gstPaid: b.gstPaid || 0,
          status: arrearsStatus(b),
          mailSent: !!b.mailSent,
          mailSentAt: b.mailSentAt || null,
          adinn_ooh_bills: b.adinn_ooh_bills || null, // ✅ NEW
        })),
        adinn_ooh_bills: r.adinn_ooh_bills || null, // ✅ NEW — New Bill / Advance bill number
        // ✅ NEW — every update through POST /admin/rent-revision (oldest first)
        editHistory: r.editHistory || [],
        editCount: (r.editHistory || []).length,
        approvalHistory: r.approvalHistory || [], // ✅ NEW — approvals replaced by a re-approval
        site: siteById.get(String(r.mediaId)) || null, // ✅ NEW — rent, payment frequency, last CMD-approved bill
        updatedBy: r.updatedBy || "",
        updatedAt: r.updatedAt || null,
        requestedBy: r.requestedBy,
        requestedByRole: r.requestedByRole,
        requestedAt: r.requestedAt,
        approvedAt: r.approvedAt || null,
        rejectedAt: r.rejectedAt || null,
      };
    });

    return successResponse(res, "Rent revision list fetched successfully", {
      pageNumber,
      count,
      totalCount,
      totalPages: Math.ceil(totalCount / count),
      list,
      // ✅ NEW — mediaId sent → that site's generated bill months + payment frequency
      ...(arrayMediaIds
        ? await (async () => {
            // ✅ NEW — mediaId array → one siteBills object per site (order sent)
            const siteBills = [];
            for (const id of arrayMediaIds) {
              const sb = await revisionSiteBills(id);
              if (sb) siteBills.push(sb);
              else invalidMediaIds.push({ mediaId: id, message: "Media not found" });
            }
            return { siteBills, invalidMediaIds };
          })()
        : { siteBills: filter.mediaId ? await revisionSiteBills(filter.mediaId) : null }),
    });
  } catch (error) {
    console.error("getRentRevisionList error:", error);
    return errorResponse(res, "Something went wrong while fetching rent revisions", { error: error.message }, 500);
  }
};
