// ✅ NEW — /admin/ledger-list payment details (Payment Through / Type Of Payment /
// Bank Reference / Narration) saved per ledger row BEFORE the UTR is entered.
// Stored on the site as media.ledgerPaymentInfo[] (existing ledger / GST rows and
// their UTR logic are never touched):
//   { _id, entryType: "rent" | "gst", rentalDueId, landOwnerId, paymentMode,
//     billType, dueMonth, gstBalanceHistoryId, paymentThrough, typeOfPayment,
//     bankRefNo, narration, createdBy, createdAt, updatedBy, updatedAt, history[] }
// A row is "Yet to Payment" (1) while its UTR is not entered, "Completed" (2) after.
// Pure helpers, no DB.

const PAYMENT_INFO_FIELDS = ["paymentThrough", "typeOfPayment", "bankRefNo", "narration"];
const STATUS_LABEL = { 1: "Yet to Payment", 2: "Completed" };

const idStr = (v) => (v === null || v === undefined || v === "" ? "" : String(v));
const ownerOf = (row) => idStr(row?.landOwnerId || row?.ownerId);
const modeOf = (v) => (String(v || "").toLowerCase() === "cash" ? "Cash" : "Online");

// payment details of one rent row (ledger[]) — rentalDueId + landowner + mode
// (dueMonth when the row has no rentalDueId)
function findRentInfo(infos, row) {
  const owner = ownerOf(row);
  const mode = modeOf(row?.paymentMode);
  const billId = idStr(row?.rentalDueId);
  return (
    (infos || []).find((i) => {
      if (!i || i.entryType === "gst") return false;
      if (idStr(i.landOwnerId) !== owner || modeOf(i.paymentMode) !== mode) return false;
      if (billId && idStr(i.rentalDueId)) return idStr(i.rentalDueId) === billId;
      return !!i.dueMonth && i.dueMonth === row?.dueMonth && (i.billType || "bill") === (row?.billType || "bill");
    }) || null
  );
}

// payment details of one GST row (gstBalanceHistory[]) — its _id, else rentalDueId
// + landowner (a virtual GST row has no _id; it keeps rentalDueId after it is paid)
function findGstInfo(infos, row) {
  const rowId = idStr(row?._id);
  const billId = idStr(row?.rentalDueId);
  const owner = ownerOf(row);
  const gst = (infos || []).filter((i) => i && i.entryType === "gst");
  return (
    (rowId && gst.find((i) => idStr(i.gstBalanceHistoryId) === rowId)) ||
    (billId && gst.find((i) => idStr(i.rentalDueId) === billId && (!idStr(i.landOwnerId) || idStr(i.landOwnerId) === owner))) ||
    null
  );
}

// UTR entered? rent: UTR saved (Cash: the cash entry saved); GST: paid / UTR saved
const rentRowDone = (row) =>
  String(row?.utrNumber || "").trim() !== "" || (modeOf(row?.paymentMode) === "Cash" && row?.isVirtual !== true && !!row?.date);
const gstRowDone = (row) => row?.isPaid === true || String(row?.utrNumber || "").trim() !== "";

function toPaymentInfo(info, done) {
  if (!info) return null;
  const status = done ? 2 : 1;
  return {
    paymentThrough: info.paymentThrough || "",
    typeOfPayment: info.typeOfPayment || "",
    bankRefNo: info.bankRefNo || "",
    narration: info.narration || "",
    paymentInfoStatus: status,
    paymentInfoStatusLabel: STATUS_LABEL[status],
    source: "paymentInfo", // ✅ NEW — saved through ledger-payment-info-save
    updatedBy: info.updatedBy || "",
    updatedAt: info.updatedAt || null,
  };
}

// ✅ NEW — old paid row: UTR / cash entry done straight in the ledger, payment
// details never saved → Completed with empty details (source "ledger")
function oldPaidInfo(row) {
  return {
    paymentThrough: "",
    typeOfPayment: "",
    bankRefNo: String(row?.bankRefNo || ""),
    narration: "",
    paymentInfoStatus: 2,
    paymentInfoStatusLabel: STATUS_LABEL[2],
    source: "ledger",
    updatedBy: row?.updatedBy || "",
    updatedAt: row?.updatedAt || row?.date || null,
  };
}

// rows + paymentInfo (null when nothing saved for that row)
// ✅ CHANGED — opts.oldPaid (ledger-list with paymentInfoStatus): a paid row without
// saved details gets oldPaidInfo instead of null
const withRentPaymentInfo = (rows, infos, opts = {}) =>
  (rows || []).map((r) => {
    if (!r) return r;
    const info = findRentInfo(infos, r);
    const done = rentRowDone(r);
    return { ...r, paymentInfo: info ? toPaymentInfo(info, done) : opts.oldPaid && done ? oldPaidInfo(r) : null };
  });
const withGstPaymentInfo = (rows, infos, opts = {}) =>
  (rows || []).map((r) => {
    if (!r) return r;
    const info = findGstInfo(infos, r);
    const done = gstRowDone(r);
    return { ...r, paymentInfo: info ? toPaymentInfo(info, done) : opts.oldPaid && done ? oldPaidInfo(r) : null };
  });

// ── cmdApproval — same bills as landowner/site-filter cmdApproval: a rentalDue
// bill up to the requested month, CMD approved and not fully settled (every
// owner's rent mode(s) entered; GST rows only when GST is held, withGst 1).
// The caller builds cmd = { approved: Set(billId), open: Set(billId), bills: Map(billId → bill) }:
//   approved = CMD approved bills up to the month, open = those not settled yet.
// New Bill / advance / arrears rows are not in site-filter cmdApproval → not here.
const cmdApprovedBill = (due) =>
  Number(due?.approvalStatus) === 3 && (due?.approvalSteps || []).some((s) => Number(s.role) === 3 && Number(s.status) === 2);
// requireUnpaid (cmdApproval list without paymentInfoStatus): open bills, rows
// whose payment is not entered yet; with paymentInfoStatus the tab decides paid / not.
function isCmdRow(row, cmd, kind, requireUnpaid = true) {
  if (!row || !cmd) return false;
  if ((row.billType || "bill") !== "bill") return false;
  const id = idStr(row.rentalDueId);
  if (!cmd.approved.has(id)) return false;
  const due = cmd.bills.get(id) || {};
  if (due.approvedVia === "advance") return false; // ₹0 bill — paid on the advance row
  if (kind === "gst" && Number(due.withGst) !== 1) return false; // direct GST is paid with the rent
  if (!requireUnpaid) return true;
  if (!cmd.open.has(id)) return false;
  return kind === "rent" ? !rentRowDone(row) && row.isVirtual === true : !gstRowDone(row);
}

const rowAmount = (row, kind) => {
  if (kind === "gst") return Number(row.gstAmount || 0);
  const modeAmount = modeOf(row.paymentMode) === "Cash" ? row.cashAmount : row.onlineAmount;
  const v = modeAmount ?? row.shareAmount ?? row.amount ?? 0;
  return Number(v) || 0;
};

/**
 * ledger-list row filters. Rows already carry paymentInfo.
 *   cmdApproval (no paymentInfoStatus) → the sites of landowner/site-filter
 *     cmdApproval (a CMD approved bill whose payment is not entered yet), each
 *     with ALL its ledger[] / gstBalanceHistory[] rows (same as the normal list)
 *   paymentInfoStatus 1 / 2 → the sites with a row whose payment details are in
 *     that state (Yet to Payment / Completed), each with ALL its rows (every row
 *     carries its own paymentInfo); sites without such a row dropped
 * counts = Yet to Payment / Completed rows with payment details (= the two tabs).
 * sites: [{ _id, ledger, gstBalanceHistory }], cmdBySite: Map(siteId → cmd) (see isCmdRow)
 */
// ✅ NEW — Partial Paid (paymentInfoStatus 3): a bill (same rentalDueId / month, same
// landowner) whose rent OR GST is paid, not both. Only GST held bills (withGst 1);
// direct GST is paid with the rent. Rent paid = every rent row (Cash / Online) of that
// landowner done. New Bill / Advance GST is site level → all rent rows of the bill.
// Returns { pairs: [{ owner, rentRows, gstRow, rentDone, gstDone }], rows: Set(row) }
function partialPaidOf(site) {
  const groupKey = (r) => `${r.billType || "bill"}|${idStr(r.rentalDueId) || r.dueMonth || r.month || ""}`;
  const rentByGroup = new Map();
  (site.ledger || []).forEach((r) => {
    if (!r) return;
    const k = groupKey(r);
    if (!rentByGroup.has(k)) rentByGroup.set(k, []);
    rentByGroup.get(k).push(r);
  });
  const pairs = [];
  const rows = new Set();
  (site.gstBalanceHistory || []).forEach((g) => {
    if (!g) return;
    if (Number(g.withGst ?? 1) !== 1) return; // direct GST — paid with the rent
    const owner = ownerOf(g);
    const rentRows = (rentByGroup.get(groupKey(g)) || []).filter((r) => !owner || ownerOf(r) === owner);
    if (!rentRows.length) return;
    const rentDone = rentRows.every(rentRowDone);
    const gstDone = gstRowDone(g);
    if (rentDone === gstDone) return;
    pairs.push({ owner, rentRows, gstRow: g, rentDone, gstDone });
    rows.add(g);
    rentRows.forEach((r) => rows.add(r));
  });
  return { pairs, rows };
}

function filterLedgerRows(sites, { cmdApproval = false, paymentInfoStatus = null, cmdBySite = new Map() }) {
  const counts = {
    yetToPayment: { sites: new Set(), landOwners: new Set(), rows: 0, amount: 0 },
    completed: { sites: new Set(), landOwners: new Set(), rows: 0, amount: 0 },
  };
  // ✅ NEW — Partial Paid count
  const partial = { sites: new Set(), landOwners: new Set(), bills: 0, rentPaidGstPending: 0, gstPaidRentPending: 0, paidAmount: 0, pendingAmount: 0 };
  const out = [];
  (sites || []).forEach((m0) => {
    let m = m0;
    const siteId = idStr(m._id || m.mediaId);
    // ✅ NEW — partial paid bills of the site (count; rows get isPartialPaid in the status tabs)
    const pp = partialPaidOf(m);
    pp.pairs.forEach((p) => {
      partial.sites.add(siteId);
      if (p.owner) partial.landOwners.add(p.owner);
      else p.rentRows.forEach((r) => ownerOf(r) && partial.landOwners.add(ownerOf(r)));
      partial.bills += 1;
      const rentAmt = p.rentRows.reduce((s, r) => s + rowAmount(r, "rent"), 0);
      const gstAmt = rowAmount(p.gstRow, "gst");
      if (p.rentDone) {
        partial.rentPaidGstPending += 1;
        partial.paidAmount += rentAmt;
        partial.pendingAmount += gstAmt;
      } else {
        partial.gstPaidRentPending += 1;
        partial.paidAmount += gstAmt;
        partial.pendingAmount += rentAmt;
      }
    });
    if (paymentInfoStatus && pp.rows.size) {
      const mark = (rows) => (rows || []).map((r) => (pp.rows.has(r) ? { ...r, isPartialPaid: true } : r));
      m = { ...m, ledger: Array.isArray(m.ledger) ? mark(m.ledger) : m.ledger, gstBalanceHistory: Array.isArray(m.gstBalanceHistory) ? mark(m.gstBalanceHistory) : m.gstBalanceHistory };
    }
    const statusOf = (r) => (r && r.paymentInfo ? r.paymentInfo.paymentInfoStatus : null);
    const tally = (rows, kind) =>
      (rows || []).forEach((r) => {
        const st = statusOf(r);
        if (!st) return;
        const c = st === 2 ? counts.completed : counts.yetToPayment;
        c.sites.add(siteId);
        if (ownerOf(r)) c.landOwners.add(ownerOf(r));
        c.rows += 1;
        c.amount += rowAmount(r, kind);
      });
    tally(m.ledger, "rent");
    tally(m.gstBalanceHistory, "gst");

    // ✅ NEW — Partial Paid tab: sites with a bill paid on one side (rent or GST) only
    if (paymentInfoStatus === 3) {
      if (pp.pairs.length) out.push(m);
      return;
    }
    if (paymentInfoStatus) {
      // ✅ CHANGED — all rows of the site (a site with only its GST row saved still shows its rent rows)
      const hasStatusRow = (m.ledger || []).some((r) => statusOf(r) === paymentInfoStatus) || (m.gstBalanceHistory || []).some((r) => statusOf(r) === paymentInfoStatus);
      if (hasStatusRow) out.push(m);
      return;
    }
    if (cmdApproval) {
      const cmd = cmdBySite.get(siteId) || null;
      const isCmdSite =
        (m.ledger || []).some((r) => isCmdRow(r, cmd, "rent", true)) || (m.gstBalanceHistory || []).some((r) => isCmdRow(r, cmd, "gst", true));
      if (isCmdSite) out.push(m);
      return;
    }
    out.push(m);
  });
  const fin = (c) => ({ sites: c.sites.size, landOwners: c.landOwners.size, rows: c.rows, amount: Math.round(c.amount) });
  return {
    sites: out,
    counts: {
      yetToPayment: fin(counts.yetToPayment),
      completed: fin(counts.completed),
      // ✅ NEW
      partialPaid: {
        sites: partial.sites.size,
        landOwners: partial.landOwners.size,
        bills: partial.bills,
        rentPaidGstPending: partial.rentPaidGstPending,
        gstPaidRentPending: partial.gstPaidRentPending,
        paidAmount: Math.round(partial.paidAmount),
        pendingAmount: Math.round(partial.pendingAmount),
      },
    },
  };
}

/**
 * Save request → { error } or { key, values } (values = the 4 fields sent).
 */
function parsePaymentInfoBody(body) {
  const b = body || {};
  const entryType = String(b.entryType || "rent").toLowerCase() === "gst" ? "gst" : "rent";
  const values = {};
  PAYMENT_INFO_FIELDS.forEach((k) => {
    if (b[k] !== undefined && b[k] !== null) values[k] = String(b[k]).trim();
  });
  if (!Object.keys(values).length) return { error: `Send at least one of ${PAYMENT_INFO_FIELDS.join(", ")}` };
  if (entryType === "rent") {
    if (!idStr(b.rentalDueId)) return { error: "rentalDueId is required" };
    if (!idStr(b.landOwnerId)) return { error: "landOwnerId is required" };
    if (!b.paymentMode) return { error: "paymentMode is required (Cash / Online)" };
    return {
      key: { entryType, rentalDueId: idStr(b.rentalDueId), landOwnerId: idStr(b.landOwnerId), paymentMode: modeOf(b.paymentMode), billType: b.billType || "bill", gstBalanceHistoryId: "" },
      values,
    };
  }
  if (!idStr(b.gstBalanceHistoryId) && !idStr(b.rentalDueId)) return { error: "gstBalanceHistoryId (or rentalDueId) is required for a GST row" };
  return {
    key: { entryType, rentalDueId: idStr(b.rentalDueId), landOwnerId: idStr(b.landOwnerId), paymentMode: "", billType: b.billType || "bill", gstBalanceHistoryId: idStr(b.gstBalanceHistoryId) },
    values,
  };
}

// saved row with the same key (index in the list or -1)
function findInfoIndex(infos, key) {
  return (infos || []).findIndex((i) => {
    if (!i || (i.entryType || "rent") !== key.entryType) return false;
    if (key.entryType === "gst") {
      // both have the row _id → by _id; else rentalDueId + landowner (a GST row saved
      // before it was paid has no _id; it keeps rentalDueId after)
      if (key.gstBalanceHistoryId && idStr(i.gstBalanceHistoryId)) return idStr(i.gstBalanceHistoryId) === key.gstBalanceHistoryId;
      if (!key.rentalDueId) return false;
      return idStr(i.rentalDueId) === key.rentalDueId && idStr(i.landOwnerId) === key.landOwnerId;
    }
    return idStr(i.rentalDueId) === key.rentalDueId && idStr(i.landOwnerId) === key.landOwnerId && modeOf(i.paymentMode) === key.paymentMode;
  });
}

module.exports = {
  PAYMENT_INFO_FIELDS,
  STATUS_LABEL,
  findRentInfo,
  findGstInfo,
  rentRowDone,
  gstRowDone,
  toPaymentInfo,
  oldPaidInfo,
  withRentPaymentInfo,
  withGstPaymentInfo,
  isCmdRow,
  cmdApprovedBill,
  filterLedgerRows,
  partialPaidOf,
  parsePaymentInfoBody,
  findInfoIndex,
};
