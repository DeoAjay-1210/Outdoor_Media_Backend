/**
 * NEW BILL / ADVANCE BILL — pending UTR bills (media.arrearsDue[]). PURE evaluation + one read-only query.
 *
 * A rent revision (CMD approved) creates arrears bills in media.arrearsDue[]; ONE mail per revision prints ONE Bill Number
 * (revision.adinn_ooh_bills, copied to every arrears bill of the revision). type "advance" = Advance Bill, anything else = New Bill.
 * Payments are NOT ledger rows: they live in bill.payments[] and on bill.owners[] (paidOnline / paidCash / paidGst).
 *
 * Output items are shaped like the Rental Bill items of pendingUtrBills.js (billNumber, mediaId, dueMonth, pendingPayments, ...)
 * plus source: "arrears", billKind: "newBill" | "advance", arrearsBillId, slots[] and eligible. The Rental Bill list is untouched.
 */
const { effectiveWithGst } = require("./rentRevisionArrears");

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BILL_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-\/]{5,39}$/;
const idStr = (v) => (v === null || v === undefined ? "" : String(v));
const hasText = (v) => String(v === null || v === undefined ? "" : v).trim() !== "";
const isValidBill = (v) => typeof v === "string" && BILL_FORMAT.test(v.trim()) && /\d/.test(v);
const monthLabelOf = (ms) => {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const ownerMatches = (o, id) => {
  const s = idStr(id);
  return s !== "" && (s === idStr(o.landOwnerId) || s === idStr(o.landOwnerMasterId));
};
const modeAmount = (o, mode) => Number(mode === "Cash" ? o.cashAmount : o.onlineAmount) || 0;
const modePaid = (bill, o, mode) =>
  (mode === "Cash" ? o.paidCash : o.paidOnline) === true ||
  (bill.payments || []).some((p) => p && p.type === "rental" && p.paymentMode === mode && ownerMatches(o, p.landOwnerId));
const gstPaidFor = (bill, o) =>
  o.paidGst === true || (bill.payments || []).some((p) => p && p.type === "gst" && hasText(p.landOwnerId) && ownerMatches(o, p.landOwnerId));

/**
 * One Bill Number = one mail = one payment per landlord and kind. A revision can create SEVERAL arrears bills (months / faces)
 * that all carry the revision's number; like a Rental Bill with several faces, ONE UTR (or one Cash paid date) per landlord and
 * kind covers every one of those bills, so every bill that still owes that payment gets its own open slot (same UTR on each).
 * Item, or null when nothing is open.
 */
function evaluateArrearsGroup(billNumber, entries) {
  const { media } = entries[0];
  const bills = entries.map((e) => e.bill);
  const first = bills[0];
  const kind = first.type === "advance" ? "advance" : "newBill";
  const parentHold = (b) => {
    const parent = (media.rentalDue || []).find((d) => idStr(d._id) === idStr(b.parentRentalDueId));
    return effectiveWithGst(b, parent && parent.withGst);
  };
  const holdOf = (b) => parentHold(b) === 1 && Number(b.gstAmount || 0) > 0;

  const reasons = [];
  if (new Set(entries.map((e) => idStr(e.media._id))).size > 1) reasons.push("duplicate_bill_number");
  if (new Set(bills.map((b) => (b.type === "advance" ? "advance" : "newBill"))).size > 1) reasons.push("bill_kind_mixed");
  if (!(media.mediaDetails || []).some((d) => Number(d.status) === 1)) reasons.push("media_inactive");
  if (bills.some((b) => !(b.owners || []).length)) reasons.push("no_landlord_on_bill");
  if (new Set(bills.map((b) => (holdOf(b) ? 1 : 0))).size > 1) reasons.push("gst_mixed_across_bills");

  // ── open payments of every bill: rent per landlord and mode, GST per landlord (GST on hold) ──
  const slots = [];
  for (const bill of bills) {
    const owners = bill.owners || [];
    owners.forEach((o) => {
      ["Online", "Cash"].forEach((md) => {
        if (modeAmount(o, md) > 0 && !modePaid(bill, o, md)) {
          slots.push({ kind: "rent", paymentType: md === "Cash" ? "cash" : "online_rent", paymentMode: md, landOwnerId: idStr(o.landOwnerId), landOwnerName: o.landOwnerName || "", rentalDueId: idStr(bill._id), dueMonth: bill.dueMonth || "", amount: modeAmount(o, md) });
        }
      });
    });
    if (holdOf(bill) && Number(bill.gstPaid || 0) < Number(bill.gstAmount || 0)) {
      if (owners.length === 1) {
        if (!gstPaidFor(bill, owners[0])) slots.push({ kind: "gst", scope: "bill", paymentType: "gst", paymentMode: "Online", landOwnerId: idStr(owners[0].landOwnerId), landOwnerName: owners[0].landOwnerName || "", rentalDueId: idStr(bill._id), dueMonth: bill.dueMonth || "", amount: Number(bill.gstAmount || 0) - Number(bill.gstPaid || 0) });
      } else {
        owners.forEach((o) => {
          if (Number(o.gstAmount || 0) > 0 && !gstPaidFor(bill, o)) slots.push({ kind: "gst", scope: "landlord", paymentType: "gst", paymentMode: "Online", landOwnerId: idStr(o.landOwnerId), landOwnerName: o.landOwnerName || "", rentalDueId: idStr(bill._id), dueMonth: bill.dueMonth || "", amount: Number(o.gstAmount || 0) });
        });
      }
    }
  }
  if (!slots.length) return null; // everything on this Bill Number is paid

  // a landlord with Cash AND Online open on one bill, or Cash on one bill and Online on another: which payment a line means is unknown
  const perBillOwner = new Map();
  const modesByKey = new Map();
  slots.filter((x) => x.kind === "rent").forEach((x) => {
    const k1 = x.rentalDueId + "|" + x.landOwnerId;
    perBillOwner.set(k1, (perBillOwner.get(k1) || 0) + 1);
    modesByKey.set(x.landOwnerId, new Set([...(modesByKey.get(x.landOwnerId) || []), x.paymentMode]));
  });
  // Cash + Online open for a landlord is a payment PAIR (Online = the UTR line, Cash takes the mail date) when EVERY bill of the
  // Bill Number that owes this landlord rent owes both; Cash on one bill and Online on another stays manual review
  const modesAt = new Map();
  slots.filter((x) => x.kind === "rent").forEach((x) => { if (!modesAt.has(x.landOwnerId)) modesAt.set(x.landOwnerId, new Map()); const m = modesAt.get(x.landOwnerId); m.set(x.rentalDueId, new Set([...(m.get(x.rentalDueId) || []), x.paymentMode])); });
  const pairBroken = [...modesAt.values()].some((m) => { const sets = [...m.values()]; const modes = new Set(sets.flatMap((s) => [...s])); return modes.size > 1 && !sets.every((s) => s.size === 2); });
  if (pairBroken) reasons.push("landlord_with_two_open_payments");

  const siteOwners = media.landOwners || [];
  const byId = new Map();
  bills.forEach((b) => (b.owners || []).forEach((o) => { if (!byId.has(idStr(o.landOwnerId))) byId.set(idStr(o.landOwnerId), o); }));
  const landlords = [...byId.values()].map((o) => {
    const probe = { landOwnerId: o.landOwnerId, landOwnerMasterId: o.landOwnerMasterId };
    const full = siteOwners.find((x) => ownerMatches({ landOwnerId: x._id, landOwnerMasterId: x.landOwnerMasterId }, probe.landOwnerId) || ownerMatches({ landOwnerId: x._id, landOwnerMasterId: x.landOwnerMasterId }, probe.landOwnerMasterId)) || {};
    const digits = String(full.accountNumber || "").replace(/\D/g, "");
    return {
      landOwnerId: idStr(o.landOwnerId),
      landOwnerMasterId: idStr(o.landOwnerMasterId || full.landOwnerMasterId),
      name: o.landOwnerName || full.name || "",
      bankName: full.bankName || "",
      accountLast4: digits.length >= 4 ? digits.slice(-4) : null,
      paymentCategory: Number(full.paymentCategory || 1),
    };
  });

  const detail = (media.mediaDetails || [])[0] || {};
  const gstHold = bills.some(holdOf);
  return {
    source: "arrears",
    billKind: kind, // "newBill" | "advance" — a New Bill UTR is never an Advance UTR
    billNumber,
    status: "pending",
    eligible: reasons.length === 0,
    mappingSafe: reasons.length === 0,
    skipReason: reasons[0] || null,
    manualReviewReasons: reasons,
    paymentTypes: [...new Set(slots.map((x) => x.paymentType))],
    mediaId: idStr(media._id),
    mediaCode: detail.mediaCode || media.mediaCode || "",
    mediaName: detail.mediaName || media.mediaName || "",
    mediaDetails: [],
    siteBillMode: 1,
    arrearsBillId: idStr(first._id),
    arrearsBillIds: bills.map((b) => idStr(b._id)),
    rentRevisionId: idStr(first.rentRevisionId),
    rentalDueIds: bills.map((b) => idStr(b._id)),
    label: first.label || "",
    dueMonth: first.dueMonth || "",
    dueMonths: [...new Set(bills.map((b) => b.dueMonth || ""))],
    adjustInMonth: first.adjustInMonth || "",
    dueDate: first.dueDate || first.createdAt || null,
    withGst: parentHold(first),
    gstHold,
    gstAmount: bills.reduce((t, b) => t + Number(b.gstAmount || 0), 0),
    approvalStatus: Number(first.approvalStatus),
    mailSent: first.mailSent === true,
    approvalDate: first.ownerApprovalDate || null, // earliest Paid Date the Ledger Entry screen allows
    landlords,
    slots,
    pendingPayments: slots.map((x) => ({ paymentType: x.paymentType, rentalDueId: x.rentalDueId, landOwnerId: x.landOwnerId, landOwnerName: x.landOwnerName, paymentMode: x.paymentMode, entryType: x.kind === "gst" ? "gst" : "rental", targetType: kind, utrRequired: x.paymentMode !== "Cash", autoProcess: false })),
  };
}

/**
 * deps (optional, tests): { Media, now }. opts: { limit, sinceDays, billNumbers, currentMonthOnly } (same meaning as the Rental list).
 * Default = ALL months, no age limit. -> { bills, totalPending }
 */
async function getPendingArrearsUtrBills(opts = {}, deps = {}) {
  const Media = deps.Media || require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const nowMs = deps.now || Date.now();
  const limit = Math.max(1, Number(opts.limit) || 500);
  const cutoff = opts.sinceDays ? nowMs - Number(opts.sinceDays) * 86400000 : null;
  const currentLabel = opts.currentMonthOnly ? monthLabelOf(nowMs) : null;
  const wanted = Array.isArray(opts.billNumbers) && opts.billNumbers.length ? new Set(opts.billNumbers.map(String)) : null;

  const docs = await Media.find({
    arrearsDue: { $elemMatch: { approvalStatus: 3, mailSent: true, adinn_ooh_bills: { $nin: [null, ""] } } },
  })
    .select("mediaName mediaCode mediaDetails landOwners arrearsDue rentalDue._id rentalDue.withGst")
    .lean();

  const byBill = new Map();
  for (const media of docs || []) {
    for (const bill of media.arrearsDue || []) {
      if (!bill || Number(bill.approvalStatus) !== 3 || bill.mailSent !== true) continue;
      const no = hasText(bill.adinn_ooh_bills) ? String(bill.adinn_ooh_bills).trim() : "";
      if (!isValidBill(no)) continue;
      if (currentLabel && bill.dueMonth !== currentLabel) continue;
      if (cutoff && new Date(bill.ownerApprovalDate || bill.createdAt || 0).getTime() < cutoff) continue;
      if (wanted && !wanted.has(no)) continue;
      if (!byBill.has(no)) byBill.set(no, []);
      byBill.get(no).push({ media, bill });
    }
  }
  const items = [];
  for (const [no, entries] of byBill) {
    const item = evaluateArrearsGroup(no, entries);
    if (item) items.push(item);
  }
  items.sort((a, b) => new Date(a.approvalDate || 0) - new Date(b.approvalDate || 0) || a.billNumber.localeCompare(b.billNumber));
  return { bills: items.slice(0, limit), totalPending: items.length };
}

module.exports = { getPendingArrearsUtrBills, evaluateArrearsGroup };
