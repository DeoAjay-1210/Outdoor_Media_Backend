/**
 * UTR TRACKER (READ-ONLY) — one row per Bill Number x landlord x payment part, for every bill CMD approved (and mailed)
 * between two dates. Used by GET /api/gmail/utr-tracker/export (Excel).
 *
 * Nothing here writes to the database and nothing here changes the Gmail UTR processor: it only READS
 *   - Media (rentalDue / arrearsDue / ledger / gstBalanceHistory ...) through the same pure helpers the pending lists use
 *     (evaluateGroup / evaluateArrearsGroup / storedPayments), so "open" and "saved" mean exactly what the processor means;
 *   - the Gmail run log (latest non-dry row per bill) for the last error / review reason. No Gmail call is made.
 *
 * Payment parts: Rent Online, Rent Cash, GST.   Bill types: Normal Bill, New Bill, Advance Bill.
 * Status: Saved | Waiting for UTR | Needs review.   UTR column: the saved UTR, "Cash" for a saved Cash payment, "-" while open.
 */
const { evaluateGroup, billField, isValidBill } = require("./pendingUtrBills");
const { evaluateArrearsGroup } = require("./pendingArrearsUtrBills");
const { storedPayments } = require("./utrCorrection");
const { effectiveWithGst } = require("./rentRevisionArrears");

const IST_OFFSET_MS = 330 * 60 * 1000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FREQUENCY = { 1: "Monthly", 2: "Quarterly", 3: "Half-Yearly", 4: "Yearly", 5: "2 Years", 6: "Custom" };
const SAMPLE_UTR = "SBIN92023012200543117";
const SAMPLE_GST = "SBIN92023012200543118";

const idStr = (v) => (v === null || v === undefined ? "" : String(v));
const hasText = (v) => String(v === null || v === undefined ? "" : v).trim() !== "";
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ownerIdOf = (o) => idStr(o.landOwnerId || o._id);
const ownerMatches = (o, id) => { const s = idStr(id); return s !== "" && (s === idStr(o._id) || s === idStr(o.landOwnerId) || s === idStr(o.landOwnerMasterId)); };
const istDay = (d) => {
  const t = new Date(d).getTime();
  if (!d || Number.isNaN(t)) return "";
  const x = new Date(t + IST_OFFSET_MS);
  return `${String(x.getUTCDate()).padStart(2, "0")} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
const istDayStart = (ymd) => Date.parse(`${ymd}T00:00:00+05:30`);

/** What an error / review code of the Gmail run log means, in plain English. */
const MESSAGES = {
  utr_not_found: "No UTR in the reply yet (no reply received, or the reply has no UTR line)",
  bill_not_found: "No Gmail mail found for this Bill Number",
  multiple_review_required: "More than one Gmail conversation for this Bill Number - manual review",
  ambiguous_mapping: "The reply could not be matched safely - manual review",
  gmail_error: "Gmail connection error - will be retried",
  database_error: "Database save error - will be retried",
  invalid_utr: "The UTR format is not valid",
  duplicate_utr: "The same UTR was given for two payments",
  utr_already_used_on_this_site: "This UTR is already used for another payment on this site",
  paid_date_not_determined: "Paid Date is not valid (before the approval day or after the mail date)",
  landlord_name_not_found: "The landlord name in the reply does not match any landlord of this bill",
  landlord_name_ambiguous: "The landlord name matches more than one landlord - write the full name",
  landlord_name_too_short: "The landlord name is too short (initials only)",
  unnamed_utr_line: "UTR line without a landlord name",
  no_rent_or_gst_label: "The line has no Rent / GST label",
  no_bill_type_label: "The line has no NewBill / Advance label",
  bill_type_mismatch: "The bill type in the reply (NewBill / Advance) does not match this bill",
  missing_landlord_utr: "A landlord of this bill has no UTR in the reply",
  missing_landlord_cash_line: "A Cash landlord has no 'Cash' line in the reply",
  conflicting_utr_for_landlord: "Two different UTRs for one landlord",
  conflicting_utr_for_kind: "Two different UTRs for Rent / GST",
  conflicting_utr_for_landlord_payment: "Two different UTRs for one payment",
  conflicting_cash_paid_date: "Two different Paid Dates for one Cash payment",
  utrs_in_multiple_replies: "UTRs are spread over several replies - send all landlords in ONE mail",
  reply_not_linked_to_approval_mail: "The reply is not linked to the approval mail (use the Reply button)",
  thread_mentions_other_bill_numbers: "The thread also mentions another Bill Number",
  cash_auto_save_disabled: "Cash auto-save switch is off",
  gst_split_auto_save_disabled: "GST auto-save switch is off",
  multi_landlord_auto_save_disabled: "Multi-landlord auto-save switch is off",
  account_mismatch_in_reply: "The account number in the reply does not match",
  bank_mismatch_in_reply: "The bank in the reply does not match",
  registry_record_missing: "Bill registry record is missing",
  registry_media_mismatch: "Bill registry points to another site",
  registry_month_mismatch: "Bill registry month does not match",
  registry_rows_mismatch: "Bill registry rows do not match",
  registry_kind_mismatch: "Bill registry bill type does not match",
  duplicate_bill_number: "The same Bill Number exists on more than one site",
  media_inactive: "Site is inactive",
  multiple_landlords: "Several landlords - a per-landlord reply is required",
  separate_landlord_bills: "Separate Bill Number per landlord",
  gst_separate_utr: "GST on hold - separate Rent and GST UTRs are required",
  rows_in_different_months: "The bill has rows in different months",
  separate_bill_site_rows: "Separate bill rows per site",
  no_single_rent_slot: "Single landlord with Cash + Online rent - manual entry",
  landlord_with_two_open_payments: "Landlord has Cash / Online open on different bills - manual entry",
  no_landlord_on_bill: "No landlord on the bill",
  bill_kind_mixed: "New Bill and Advance are mixed under one number",
  gst_mixed_across_bills: "GST hold is mixed across the bills",
};
const explain = (code) => (code ? MESSAGES[code] || code : "");
const REVIEW_STATUSES = new Set(["ambiguous_mapping", "multiple_review_required", "database_error", "gmail_error", "bill_not_found"]);

/** Exact reply line Finance must write for ONE open payment (the same lines the processor reads). */
function replyFormat({ flow, word, single, hold, part, mode, name, paired }) {
  const lead = `${name} - `; // the landlord name is always written (single or several landlords)
  const bill = ""; // the NewBill / Advance word is no longer needed in the reply (bill type comes from the bill)
  if (part === "gst") return `${lead}${bill}GST - UTR : <UTR>`;
  const label = ""; // no "Rent" word: "Name - UTR : X" is the Rent UTR, "Name - GST - UTR : X" the GST UTR
  if (mode === "Cash") {
    if (paired) return `AUTO - taken from the date of the mail that carries the Online Rent UTR (different date: ${lead}${bill}${label}Cash - Paid Date: 08-Nov-2026)`;
    return `AUTO - no Cash line needed: Paid Date = date of Finance's "Approved through this bank" mail (different date: ${lead}${bill}${label}Cash - Paid Date: 08-Nov-2026)`;
  }
  return `${lead}${bill}${label}UTR : <UTR>`;
}
const exampleOf = (fmt, part) => (fmt.startsWith("AUTO") || fmt.startsWith("Manual") ? "" : fmt.split("   (")[0].replace("<UTR>", part === "gst" ? SAMPLE_GST : SAMPLE_UTR));

/** Saved payment: the reply line in the format that was used, with the saved UTR in it ("UTR : X", "Landlord1 - UTR : X", "Landlord1 - Rent - UTR : X", "Cash" ...). */
function savedLine(r) {
  const fmt = replyFormat({ flow: r.flow, word: r._word, single: r._single, hold: r._hold, part: r._part, mode: r.paymentMode, name: r.landlordName, paired: false });
  if (r.paymentMode === "Cash") return "Cash";
  return r.utr && r.utr !== "-" ? fmt.replace("<UTR>", r.utr) : "-";
}

/**
 * opts: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" } (CMD approval date, India time, both days included)
 * deps (tests): { Media, Log, helpers, now }
 * -> { rows: [...], summary: { total, saved, waiting, review }, from, to }
 */
async function buildUtrTracker(opts = {}, deps = {}) {
  const Media = deps.Media || require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const helpers = deps.helpers || require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
  const nowMs = deps.now || Date.now();
  const field = billField();
  const fromMs = istDayStart(opts.from);
  const toMs = istDayStart(opts.to) + 86400000 - 1;
  const inRange = (d) => { const t = new Date(d || 0).getTime(); return t >= fromMs && t <= toMs; };
  const range = { $gte: new Date(fromMs), $lte: new Date(toMs) };

  const docs = await Media.find({
    $or: [
      { rentalDue: { $elemMatch: { approvalStatus: 3, mailSent: true, [field]: { $nin: [null, ""] }, ownerApprovalDate: range } } },
      { arrearsDue: { $elemMatch: { approvalStatus: 3, mailSent: true, adinn_ooh_bills: { $nin: [null, ""] }, ownerApprovalDate: range } } },
    ],
  })
    .select("mediaName mediaCode mediaDetails landOwners rentalDue arrearsDue ledger ledgerHistory withGst1Ledger gstBalanceHistory rentalPayment.paymentFrequency rentalPayment.customPaymentFrequency")
    .lean();

  // ── group rows by Bill Number exactly like the pending lists ──
  const rentalBills = new Map();
  const arrearsBills = new Map();
  for (const media of docs || []) {
    for (const row of media.rentalDue || []) {
      if (!row || Number(row.approvalStatus) !== 3 || row.mailSent !== true) continue;
      const no = hasText(row[field]) ? String(row[field]).trim() : "";
      if (!isValidBill(no)) continue;
      if (!rentalBills.has(no)) rentalBills.set(no, []);
      rentalBills.get(no).push({ media, row });
    }
    for (const bill of media.arrearsDue || []) {
      if (!bill || Number(bill.approvalStatus) !== 3 || bill.mailSent !== true) continue;
      const no = hasText(bill.adinn_ooh_bills) ? String(bill.adinn_ooh_bills).trim() : "";
      if (!isValidBill(no)) continue;
      if (!arrearsBills.has(no)) arrearsBills.set(no, []);
      arrearsBills.get(no).push({ media, bill });
    }
  }

  const frequencyOf = (media) => {
    const rp = media.rentalPayment || {};
    const f = Number(rp.paymentFrequency);
    return f === 6 && rp.customPaymentFrequency ? `Every ${rp.customPaymentFrequency} months` : FREQUENCY[f] || "";
  };
  const siteOf = (media, rows) => {
    const faces = media.mediaDetails || [];
    const used = rows.map((r) => faces.find((d) => idStr(d._id) === idStr(r.mediaDetailId))).filter(Boolean);
    const list = used.length ? used : faces;
    const uniq = (a) => [...new Set(a.filter(hasText))];
    return { siteName: uniq(list.map((f) => f.mediaName)).join(" | ") || media.mediaName || "", siteCode: uniq(list.map((f) => f.mediaCode)).join(", ") || media.mediaCode || "" };
  };

  const out = [];
  // every part remembers its landlord and, when it is saved, its Paid Date and Narration (the ledger "remark")
  let curOid = "";
  let curMeta = new Map();
  const dmy = (d) => { const t = new Date(d); return Number.isNaN(t.getTime()) ? "" : `${String(t.getUTCDate()).padStart(2, "0")} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };
  const push = (r) => {
    const m = r._saved ? curMeta.get(`${curOid}|${r.paymentPart === "GST" ? "gst" : "rent|" + r.paymentMode}`) : null;
    out.push({ ...r, _oid: curOid, _paid: m && m.date ? dmy(m.date) : "", _narr: m && hasText(m.remark) ? String(m.remark).trim() : "", _bank: m && hasText(m.bankRefNo) ? String(m.bankRefNo).trim() : "" });
  };
  /** Paid Date + remark of the saved payments of a Rental bill: key "<landlord>|rent|Online|Cash" / "<landlord>|gst" (the latest entry wins). */
  const rentalMeta = (media, rowIds, owners) => {
    const map = new Map();
    const single = owners.length === 1;
    const ownerOf = (id) => owners.find((o) => ownerMatches(o, id)) || (!hasText(id) && single ? owners[0] : null);
    const put = (o, key, date, remark, bankRefNo) => {
      if (!o) return;
      const k = `${idStr(o._id)}|${key}`;
      const prev = map.get(k);
      if (!prev || new Date(date || 0).getTime() >= new Date(prev.date || 0).getTime()) map.set(k, { date, remark, bankRefNo });
    };
    const scan = (list) => (list || []).forEach((e) => {
      if (!e || !rowIds.has(idStr(e.rentalDueId))) return;
      if (e.isUtrEntry === true) put(ownerOf(e.landOwnerId), "gst", e.date, e.remarks || e.remark, e.bankRefNo);
      else if (e.paymentMode) put(ownerOf(e.landOwnerId), `rent|${e.paymentMode}`, e.date, e.remarks || e.remark, e.bankRefNo);
    });
    scan(media.ledger);
    scan(media.withGst1Ledger);
    (media.ledgerHistory || []).forEach((y) => (y.months || []).forEach((m) => scan(m.entries)));
    (media.gstBalanceHistory || []).forEach((g) => {
      if (!g || !rowIds.has(idStr(g.rentalDueId)) || !(g.isPaid === true || hasText(g.utrNumber))) return;
      put(ownerOf(g.ownerId || g.landOwnerId), "gst", g.date || g.paidAt, g.remarks || g.remark, g.bankRefNo);
    });
    return map;
  };
  /** The same for a New Bill / Advance bill (arrearsDue[].payments[]). */
  const arrearsMeta = (bills, owners) => {
    const map = new Map();
    const list = [...owners.values()];
    bills.forEach((b) => (b.payments || []).forEach((p) => {
      const o = list.find((x) => ownerIdOf(x) === idStr(p.landOwnerId)) || (!hasText(p.landOwnerId) && list.length === 1 ? list[0] : null);
      if (!o) return;
      const k = `${ownerIdOf(o)}|${p.type === "gst" ? "gst" : `rent|${p.paymentMode}`}`;
      const prev = map.get(k);
      if (!prev || new Date(p.date || 0).getTime() >= new Date(prev.date || 0).getTime()) map.set(k, { date: p.date, remark: p.remarks || p.remark, bankRefNo: p.bankRefNo });
    }));
    return map;
  };

  // ── RENTAL (normal) bills ──
  for (const [billNumber, entries] of rentalBills) {
    const primary = entries[0].row;
    if (!inRange(primary.ownerApprovalDate)) continue;
    const media = entries[0].media;
    const rows = entries.map((e) => e.row);
    const rowIds = new Set(rows.map((r) => idStr(r._id)));
    const owners = media.landOwners || [];
    const single = owners.length === 1;
    const holdRowIds = new Set(rows.filter((r) => Number(r.withGst) === 1).map((r) => idStr(r._id)));
    const hold = holdRowIds.size > 0;
    let item = null;
    try { item = evaluateGroup(billNumber, entries, helpers, nowMs); } catch (_) { item = null; }
    const open = new Set(((item && item.pendingPayments) || []).map((p) => (p.paymentType === "gst" ? `${p.landOwnerId}|gst|${p.gstBalanceHistoryId}` : `${p.landOwnerId}|${p.paymentType === "cash" ? "Cash" : "Online"}`)));
    let stored = { slots: new Map() };
    try { stored = storedPayments(media, billNumber, field); } catch (_) { /* best effort */ }
    const utrOf = (ownerId, kind) => { const s = stored.slots.get(`${ownerId}|${kind}`); return s && s.utrs.length ? s.utrs[0] : ""; };
    const eligible = !!(item && (item.mappingSafe || (item.perLandlordMapping && item.perLandlordMapping.eligible) || (item.gstSplitMapping && item.gstSplitMapping.eligible) || (item.landlordGstMapping && item.landlordGstMapping.eligible)));
    const site = siteOf(media, rows);
    const base = { billNumber, billType: "Normal Bill", ...site, month: primary.dueMonth || "", monthKey: primary.dueMonth || "", paymentFrequency: frequencyOf(media), approvedDate: istDay(primary.ownerApprovalDate), approvedMs: new Date(primary.ownerApprovalDate).getTime(), gstLabel: hold ? "Yes - On hold" : rows.some((r) => Number(r.withGst) === 2) ? "Yes - Included in rent" : "No", flow: "rental" };

    curMeta = rentalMeta(media, rowIds, owners);
    owners.forEach((o) => {
      const oid = idStr(o._id);
      curOid = oid;
      const cat = Number(o.paymentCategory || 1);
      const pair = cat === 3;
      const parts = [];
      if (cat === 2 || cat === 3) parts.push({ part: "rent", mode: "Online", amount: num(o.onlineAmount) || (cat === 2 ? num(o.shareAmount) : 0) });
      if (cat === 1 || cat === 3) parts.push({ part: "rent", mode: "Cash", amount: num(o.cashAmount) || (cat === 1 ? num(o.shareAmount) : 0) });
      (media.gstBalanceHistory || []).filter((g) => g && holdRowIds.has(idStr(g.rentalDueId)) && (ownerMatches(o, g.ownerId || g.landOwnerId) || (single && !hasText(g.ownerId || g.landOwnerId)))).forEach((g) => parts.push({ part: "gst", mode: "Online", amount: num(g.gstAmount), gstId: idStr(g._id), paidGst: g.isPaid === true || hasText(g.utrNumber), gstUtr: hasText(g.utrNumber) ? String(g.utrNumber).trim() : "" }));
      parts.forEach((p) => {
        const isOpen = p.part === "gst" ? open.has(`${oid}|gst|${p.gstId}`) : open.has(`${oid}|${p.mode}`);
        const saved = !isOpen;
        let utr = "";
        if (saved) utr = p.part === "gst" ? p.gstUtr || utrOf(oid, "gst") : p.mode === "Cash" ? "" : utrOf(oid, "rent") || "";
        push({ ...base, category: cat === 3 ? "Cash + Online" : cat === 1 ? "Cash" : "Online", landlordName: o.name || "", amount: p.amount, paymentPart: p.part === "gst" ? "GST" : "Rent", paymentMode: p.mode, utr: utr || "-", _saved: saved, _open: isOpen, _eligible: eligible, _single: single, _hold: hold, _paired: pair && p.mode === "Cash", _pairNoAuto: false, _word: "", _part: p.part, _reasons: (item && item.manualReviewReasons) || [], _dupOrInactive: item && (item.manualReviewReasons || []).filter((r) => ["duplicate_bill_number", "media_inactive"].includes(r)) });
      });
    });
  }

  // ── NEW BILL / ADVANCE bills ──
  for (const [billNumber, entries] of arrearsBills) {
    const first = entries[0].bill;
    if (!inRange(first.ownerApprovalDate || first.createdAt)) continue;
    const media = entries[0].media;
    const bills = entries.map((e) => e.bill);
    const kind = first.type === "advance" ? "advance" : "newBill";
    const word = kind === "advance" ? "Advance" : "NewBill";
    let item = null;
    try { item = evaluateArrearsGroup(billNumber, entries); } catch (_) { item = null; }
    const openSlots = (item && item.slots) || [];
    let stored = { slots: new Map() };
    try { stored = storedPayments(media, billNumber, "adinn_ooh_bills"); } catch (_) { /* best effort */ }
    const holdOf = (b) => {
      const parent = (media.rentalDue || []).find((d) => idStr(d._id) === idStr(b.parentRentalDueId));
      return effectiveWithGst(b, parent && parent.withGst) === 1 && num(b.gstAmount) > 0;
    };
    const hold = bills.some(holdOf);
    const owners = new Map();
    bills.forEach((b) => (b.owners || []).forEach((o) => { if (!owners.has(ownerIdOf(o))) owners.set(ownerIdOf(o), o); }));
    const single = owners.size === 1;
    const site = siteOf(media, []);
    const months = [...new Set(bills.map((b) => b.dueMonth).filter(hasText))].join(", ");
    const base = { billNumber, billType: kind === "advance" ? "Advance Bill" : "New Bill", ...site, month: months, monthKey: first.dueMonth || "", paymentFrequency: frequencyOf(media), approvedDate: istDay(first.ownerApprovalDate || first.createdAt), approvedMs: new Date(first.ownerApprovalDate || first.createdAt).getTime(), gstLabel: hold ? "Yes - On hold" : "No", flow: kind };
    const eligible = !!(item && item.eligible);

    curMeta = arrearsMeta(bills, owners);
    owners.forEach((o, oid) => {
      curOid = oid;
      const sumOf = (fn) => bills.reduce((t, b) => t + fn((b.owners || []).find((x) => ownerIdOf(x) === oid) || {}, b), 0);
      const online = sumOf((x) => num(x.onlineAmount));
      const cash = sumOf((x) => num(x.cashAmount));
      const parts = [];
      if (online > 0) parts.push({ part: "rent", mode: "Online", amount: online });
      if (cash > 0) parts.push({ part: "rent", mode: "Cash", amount: cash });
      if (hold) {
        const g = single ? bills.reduce((t, b) => t + (holdOf(b) ? num(b.gstAmount) : 0), 0) : sumOf((x, b) => (holdOf(b) ? num(x.gstAmount) : 0));
        if (g > 0) parts.push({ part: "gst", mode: "Online", amount: g });
      }
      const pair = online > 0 && cash > 0;
      parts.forEach((p) => {
        const isOpen = openSlots.some((s) => s.landOwnerId === oid && (p.part === "gst" ? s.kind === "gst" : s.kind === "rent" && s.paymentMode === p.mode));
        const utr = isOpen ? "-" : p.part === "gst" ? (stored.slots.get(`${oid}|gst`) || { utrs: [] }).utrs[0] || "-" : p.mode === "Cash" ? "-" : (stored.slots.get(`${oid}|rent`) || { utrs: [] }).utrs[0] || "-";
        push({ ...base, category: pair ? "Cash + Online" : cash > 0 ? "Cash" : "Online", landlordName: o.landOwnerName || o.name || "", _saved: !isOpen, amount: p.amount, paymentPart: p.part === "gst" ? "GST" : "Rent", paymentMode: p.mode, utr, _open: isOpen, _eligible: eligible, _single: single, _hold: hold, _paired: pair && p.mode === "Cash", _pairNoAuto: false, _word: word, _part: p.part, _reasons: (item && item.manualReviewReasons) || [], _dupOrInactive: [] });
      });
    });
  }

  // ── latest Gmail run (non-dry) per bill: the last error / review reason ──
  const latest = new Map();
  try {
    const Log = deps.Log || require("../models/Admin/GmailUtrLogSchema");
    const nos = [...new Set(out.map((r) => r.billNumber))];
    if (nos.length) {
      const logs = await Log.find({ billNumber: { $in: nos }, dryRun: false }).sort({ createdAt: -1 }).select("billNumber status reason createdAt replyLines").lean();
      logs.forEach((l) => latest.has(l.billNumber) || latest.set(l.billNumber, l));
    }
  } catch (_) { /* a missing log never breaks the report */ }

  // ── status / error / reply line of every payment part ──
  const parts = out.map((r) => {
    const log = latest.get(r.billNumber);
    let status = "Saved";
    let code = "";
    let format = "-";
    if (r._open) {
      const blockedBill = !r._eligible;
      const logReview = log && REVIEW_STATUSES.has(log.status);
      if (r._pairNoAuto) { status = "Needs review"; code = "no_single_rent_slot"; format = "Manual entry - not auto-saved (single landlord Cash + Online)"; }
      else if (blockedBill) { status = "Needs review"; code = (r._dupOrInactive && r._dupOrInactive[0]) || r._reasons[0] || (log && log.reason) || "multiple_landlords"; format = `Manual entry - not eligible for auto-save (${[...new Set(r._reasons)].join(", ") || code})`; }
      else {
        status = logReview ? "Needs review" : "Waiting for UTR";
        code = log && (logReview || log.status === "utr_not_found") ? log.reason || log.status : "";
        format = replyFormat({ flow: r.flow, word: r._word, single: r._single, hold: r._hold, part: r._part, mode: r.paymentMode, name: r.landlordName, paired: r._paired });
      }
      if (!code && !log) code = "not_checked_yet";
    }
    const line = r._open ? format : savedLine(r);
    return {
      ...r, status, code,
      errorText: r._open ? (code === "not_checked_yet" ? "Not checked in Gmail yet" : explain(code)) : "",
      line: line === "-" || line.startsWith("AUTO") ? "" : line, // the Cash part of a Cash + Online landlord is automatic: no line to write
      example: r._open ? exampleOf(format, r._part) : "",
    };
  });

  // ── ONE row per Bill Number: Rent and GST share the row; several landlords / sites are written side by side with ", " ──
  const uniq = (a) => [...new Set(a.filter((x) => hasText(x)))];
  const monthDate = (label) => { const t = Date.parse("1 " + label); return Number.isNaN(t) ? 0 : t; };
  const byBill = new Map();
  parts.forEach((p) => { if (!byBill.has(p.billNumber)) byBill.set(p.billNumber, []); byBill.get(p.billNumber).push(p); });
  const rows = [];
  for (const [billNumber, list] of byBill) {
    const first = list[0];
    const landlords = uniq(list.map((p) => p.landlordName));
    const pick = (name, fn) => list.find((p) => p.landlordName === name && fn(p));
    const rentUtr = landlords.map((n) => { const p = pick(n, (x) => x._part === "rent" && x.paymentMode === "Online"); return p ? p.utr : "-"; });
    const gstUtr = landlords.map((n) => { const p = pick(n, (x) => x._part === "gst"); return p ? p.utr : "-"; });
    const rent = list.filter((p) => p._part === "rent").reduce((t, p) => t + num(p.amount), 0);
    const gst = list.filter((p) => p._part === "gst").reduce((t, p) => t + num(p.amount), 0);
    const perLandlord = (fn) => landlords.map((n) => uniq(list.filter((p) => p.landlordName === n && p._saved).map(fn)));
    const paidDates = perLandlord((p) => p._paid).map((a) => (a.length ? a.join(" / ") : "-"));
    const narrOf = (part) => landlords.map((n) => uniq(list.filter((p) => p.landlordName === n && p._saved && p._part === part).map((p) => p._narr)).join(" / ") || "-");
    const narrText = (arr) => (landlords.length > 1 ? landlords.map((n, i) => `${n}: ${arr[i]}`).join("\n") : arr[0] || "-");
    const bankRefs = landlords.map((n) => uniq(list.filter((p) => p.landlordName === n && p._saved).map((p) => p._bank)).join(" / ") || "-");
    const rentNarr = narrOf("rent");
    const gstNarr = narrOf("gst");
    const st = new Set(list.map((p) => p.status));
    const open = list.filter((p) => p._open);
    // Some payment of the bill is already saved and the ONLY thing still open is a part whose reply used a wrong landlord name: that is not a problem of
    // the saved part - the bill is "Partially saved" and waits for the right line (the Error says which one), it is not "Needs review"
    const reviewParts = list.filter((p) => p.status === "Needs review");
    const soft = list.some((p) => p._saved) && reviewParts.length > 0 && reviewParts.every((p) => p.code === "landlord_name_not_found");
    const status = soft ? "Partially saved" : st.has("Needs review") ? "Needs review" : st.has("Waiting for UTR") ? (st.has("Saved") ? "Partially saved" : "Waiting for UTR") : "Saved";
    const waitingFor = uniq(open.map((p) => p.paymentPart)).join(" and ");
    rows.push({
      "Month": first.month, "Approval Date": first.approvedDate, "Bill Type": first.billType, "Bill Number": billNumber,
      "Site Code": uniq(list.flatMap((p) => String(p.siteCode).split(", "))).join(", "),
      "Site Name": uniq(list.flatMap((p) => String(p.siteName).split(" | "))).join(", "),
      "Landlord Name": landlords.join(", "),
      "Payment Category": landlords.map((n) => (list.find((p) => p.landlordName === n) || {}).category).join(", "),
      "Payment Frequency": first.paymentFrequency, "GST Applicable": first.gstLabel,
      "Total Rental Amount": rent, "GST Amount": gst, "Total Amount": rent + gst,
      "Rent UTR": rentUtr.join(", "), "GST UTR": first.gstLabel === "Yes - On hold" ? gstUtr.join(", ") : "-",
      "Paid Date": paidDates.join(", "),
      "Bank Ref No": bankRefs.join(", "),
      "Rent Narration": narrText(rentNarr),
      "GST Narration": first.gstLabel === "Yes - On hold" ? narrText(gstNarr) : "-",
      "Status": status,
      "Error": soft ? `Waiting for the ${waitingFor} UTR - the reply used a landlord name that is not on this bill` : uniq(open.map((p) => p.errorText)).join("\n"),
      // a bill that needs review: show what Finance ACTUALLY replied (e.g. "Dhoni - UTR : …"), not the format that was expected
      "Reply Format (exact)": status === "Needs review" && (latest.get(billNumber) || {}).replyLines && latest.get(billNumber).replyLines.length ? latest.get(billNumber).replyLines.join("\n") : uniq(list.map((p) => p.line)).join("\n"),
      "Reply Example": uniq(open.map((p) => p.example)).join("\n"),
      "Error Code": soft ? "" : uniq(open.map((p) => p.code).filter((c) => c !== "not_checked_yet")).join(", "),
      _monthKey: first.monthKey, _monthMs: monthDate(first.monthKey), _approvedMs: first.approvedMs || 0,
    });
  }
  rows.sort((a, b) => a._monthMs - b._monthMs || a._approvedMs - b._approvedMs || a["Bill Number"].localeCompare(b["Bill Number"]));
  const summary = {
    total: rows.length,
    saved: rows.filter((r) => r.Status === "Saved").length,
    partial: rows.filter((r) => r.Status === "Partially saved").length,
    waiting: rows.filter((r) => r.Status === "Waiting for UTR").length,
    review: rows.filter((r) => r.Status === "Needs review").length,
  };
  return { from: opts.from, to: opts.to, summary, rows };
}

// ───────────────────────── Excel (same look as the Approved Sites report) ─────────────────────────
const COLS = [
  ["Month", 16], ["Approval Date", 15], ["Bill Type", 14], ["Bill Number", 25], ["Site Code", 22], ["Site Name", 34], ["Landlord Name", 30],
  ["Payment Category", 18], ["Payment Frequency", 16], ["GST Applicable", 20], ["Total Rental Amount", 20], ["GST Amount", 16], ["Total Amount", 18],
  ["Rent UTR", 30], ["GST UTR", 30], ["Paid Date", 22], ["Bank Ref No", 24], ["Rent Narration", 46], ["GST Narration", 46], ["Status", 17], ["Error", 50], ["Reply Format (exact)", 62], ["Reply Example", 56], ["Error Code", 26],
];
const COL_RENT = 10; // Total Rental Amount .. Total Amount = columns 10-12
const COL_TOTAL = 12;
const COL_STATUS = COLS.findIndex((x) => x[0] === "Status");
const COL_ERROR = COLS.findIndex((x) => x[0] === "Error");
const CENTER = new Set([0, 1, 2, 7, 8, 9, COLS.findIndex((x) => x[0] === "Paid Date"), COL_STATUS]);

/** Excel (Buffer): sheets "UTR Tracker" (everything), "Waiting for UTR" and "Needs Review"; month by month, header rows frozen. */
function trackerWorkbook(data) {
  const XLSX = require("xlsx-js-style");
  const LAST = COLS.length - 1;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const fmtLong = (ymd) => { const [y, m, d] = String(ymd).split("-"); return `${d} ${MONTH_NAMES[Number(m) - 1].slice(0, 3)} ${y}`; };
  const money = "₹ #,##,##0";
  const border = { bottom: { style: "thin", color: { rgb: "D1D4D7" } } };
  const S = {
    title: { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center" } },
    period: { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" } },
    head: { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: { top: { style: "thin" }, bottom: { style: "thin" } } },
    month: { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, alignment: { vertical: "center" }, border },
    total: (even) => ({ fill: { fgColor: { rgb: even ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" } }),
    grand: { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" } },
  };
  const STATUS_COLOR = { "Saved": "38761D", "Partially saved": "2F5597", "Waiting for UTR": "C55A11", "Needs review": "C00000" };

  const sheet = (rows, label) => {
    const aoa = [];
    const kind = []; // row type per aoa row
    const merges = [];
    const blank = (first) => [first, ...Array(LAST).fill("")];
    aoa.push(blank(`UTR TRACKER REPORT - ${label.toUpperCase()}`)); kind.push("title"); merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST } });
    aoa.push(blank(`Approval Period: ${fmtLong(data.from)} to ${fmtLong(data.to)}`)); kind.push("period"); merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST } });
    aoa.push(COLS.map((c) => c[0])); kind.push("head");

    const totals = (labelText, list) => {
      const row = blank(labelText);
      row[COL_RENT] = list.reduce((t, r) => t + r["Total Rental Amount"], 0);
      row[COL_RENT + 1] = list.reduce((t, r) => t + r["GST Amount"], 0);
      row[COL_TOTAL] = row[COL_RENT] + row[COL_RENT + 1];
      return row;
    };
    const months = [];
    rows.forEach((r) => { let m = months[months.length - 1]; if (!m || m.key !== r._monthKey) { m = { key: r._monthKey, list: [] }; months.push(m); } m.list.push(r); });
    let even = 0;
    months.forEach((m) => {
      const name = String(m.key || "No month").toUpperCase();
      aoa.push(blank(name)); kind.push("month"); merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: LAST } });
      m.list.forEach((r) => { aoa.push(COLS.map((c) => (r[c[0]] === "" || r[c[0]] === null || r[c[0]] === undefined ? "-" : r[c[0]]))); kind.push("data"); }); // an empty cell shows "-"
      aoa.push(totals(`${name} TOTAL (${m.list.length} ${m.list.length === 1 ? "bill" : "bills"})`, m.list)); kind.push(even++ % 2 === 0 ? "total0" : "total1");
      merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: COL_RENT - 1 } });
      aoa.push([]); kind.push("gap");
    });
    if (rows.length) {
      aoa.push(totals(`GRAND TOTAL (${rows.length} ${rows.length === 1 ? "bill" : "bills"})`, rows)); kind.push("grand");
      merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: COL_RENT - 1 } });
    } else {
      aoa.push(blank("No bills found for this period")); kind.push("none"); merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: LAST } });
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let r = 0; r < aoa.length; r++) {
      for (let c = 0; c <= LAST; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) continue;
        const k = kind[r];
        const isAmount = c >= COL_RENT && c <= COL_TOTAL;
        if (k === "title") ws[addr].s = S.title;
        else if (k === "period") ws[addr].s = S.period;
        else if (k === "head") ws[addr].s = S.head;
        else if (k === "month") ws[addr].s = S.month;
        else if (k === "total0" || k === "total1") { ws[addr].s = S.total(k === "total0"); if (isAmount) ws[addr].z = money; }
        else if (k === "grand") { ws[addr].s = S.grand; if (isAmount) ws[addr].z = money; }
        else if (k === "none") ws[addr].s = { font: { bold: true, italic: true, color: { rgb: "C00000" } }, alignment: { horizontal: "center", vertical: "center" } };
        else if (k === "data") {
          ws[addr].s = { border, alignment: { vertical: "center", wrapText: true, horizontal: CENTER.has(c) ? "center" : "left" } };
          if (isAmount) ws[addr].z = money;
          if (c === COL_STATUS) ws[addr].s.font = { bold: true, color: { rgb: STATUS_COLOR[aoa[r][c]] || "000000" } };
          if (c === COL_ERROR && aoa[r][c] && aoa[r][c] !== "-") ws[addr].s.font = { color: { rgb: "C00000" } };
        }
      }
    }
    ws["!merges"] = merges;
    ws["!cols"] = COLS.map((c) => ({ wch: c[1] }));
    ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 35 }];
    ws["!views"] = [{ state: "frozen", xSplit: 0, ySplit: 3, topLeftCell: "A4", activePane: "bottomLeft" }];
    return ws;
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(data.rows, "All bills"), "UTR Tracker");
  XLSX.utils.book_append_sheet(wb, sheet(data.rows.filter((r) => r.Status === "Waiting for UTR" || r.Status === "Partially saved"), "Waiting for UTR"), "Waiting for UTR");
  XLSX.utils.book_append_sheet(wb, sheet(data.rows.filter((r) => r.Status === "Needs review"), "Needs review"), "Needs Review");
  const raw = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  try { return require("../controllers/Admin/MediaOnboardingController/RentalOOHExcelController").freezeHeaderInXlsxBuffer(raw, 3); } catch (_) { return raw; } // header rows stay while scrolling
}

module.exports = { buildUtrTracker, trackerWorkbook, replyFormat };
