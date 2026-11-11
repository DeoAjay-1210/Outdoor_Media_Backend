/**
 * Pending payments of CMD-approved + mailed bills (READ-ONLY). Used by GET /api/gmail/pending-utr-bills
 * and by the automatic UTR processor.
 *
 * Source: MediaOnboarding.rentalDue[] (approvalStatus 3 = fully CMD approved, mailSent true, Bill Number
 * set). One list item per Bill Number; its pendingPayments[] holds every payment still open:
 *
 *   cash         owner paymentCategory 1 or 3 and no Cash row in ledger / ledgerHistory.
 *                The ledger itself needs no UTR for Cash (the app sends utrNumber "" and the row is paid once it
 *                has a date), so utrRequired:false. The Cash row does not exist until it is saved, so saving a
 *                Cash payment CREATES the paid row (existing ledger-save rule). Gmail is still searched for the
 *                bank reference when the mapping is safe (autoProcess:true); actual saving of Cash is behind its
 *                own switch (GMAIL_UTR_CASH_SAVE_ENABLED) in the processor.
 *   online_rent  owner paymentCategory 2 or 3 and no Online rent row in ledger / ledgerHistory.
 *   gst          the rent was approved with GST on hold (rentalDue.withGst 1) and its
 *                gstBalanceHistory row (linked by rentalDueId) is not paid and has no UTR.
 *                A separate item; never mixed with rent; manual review for now (autoProcess:false).
 *
 * Payment rows are matched by rentalDueId (any row of the bill) AND landlord, and also with the existing
 * helper isOwnerModePaidForCycle (month + mode + landlord). Verified on the database: for a single-bill site
 * with several face rows, the ledger / GST row is stored against the FIRST row of the group (55/55 rent
 * rows, 3/3 GST rows), so the "primary row" of a bill = its first rentalDue row, and that is the
 * rentalDueId used for saving.
 *
 * mappingSafe (the UTR can be saved automatically) is true ONLY when ALL hold:
 *   one media, active | one landlord | no separate-landlord numbers | no GST-on-hold row on the bill |
 *   rows (if several faces) share one month on a single-bill site | exactly ONE open rent payment (Cash OR
 *   Online — a cat-3 landlord with both open has two UTRs in the reply and stays manual).
 * Anything else is listed with skipReason / manualReviewReasons and stays manual:
 *   duplicate_bill_number | media_inactive | multiple_landlords | separate_landlord_bills |
 *   gst_separate_utr | rows_in_different_months | separate_bill_site_rows | no_rent_payment_pending |
 *   no_single_rent_slot
 */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const IST_OFFSET_MS = 330 * 60 * 1000;

const BILL_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-\/]{5,39}$/;
const isValidBill = (v) => typeof v === "string" && BILL_FORMAT.test(v.trim()) && /\d/.test(v);

// The number printed in the approval mail is rentalDue.adinn_ooh_bills (RentalDueNew2Controller:1572/1687).
// GMAIL_UTR_BILL_FIELD=billNo switches to the older rentalDue.billNo if a deployment ever mails that one.
const billField = () => (process.env.GMAIL_UTR_BILL_FIELD === "billNo" ? "billNo" : "adinn_ooh_bills");

const idStr = (v) => (v === null || v === undefined ? "" : String(v));
const hasText = (v) => String(v === null || v === undefined ? "" : v).trim() !== "";

const monthLabelOf = (date) => {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const defaultLedgerHelpers = () => require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");

const ownerMatches = (owner, id) => {
  const s = idStr(id);
  return s !== "" && (s === idStr(owner._id) || s === idStr(owner.landOwnerMasterId));
};

/** A rent payment row (not a GST row) of this mode exists for the bill and landlord. */
function hasRentPayment(media, owner, rowIds, primaryRow, mode, helpers) {
  const single = (media.landOwners || []).length === 1;
  const ok = (e) =>
    e && e.isUtrEntry !== true && e.paymentMode === mode && rowIds.has(idStr(e.rentalDueId)) && (ownerMatches(owner, e.landOwnerId) || (single && !hasText(e.landOwnerId)));
  if ((media.ledger || []).some(ok)) return true;
  for (const y of media.ledgerHistory || []) {
    for (const m of y.months || []) if ((m.entries || []).some(ok)) return true;
  }
  const due = new Date(primaryRow.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  return !!helpers.isOwnerModePaidForCycle(media, owner, mode, due);
}

/** UTR already stored for this landlord on this bill (any rent row of the bill), or null. */
function storedUtrFor(media, owner, rowIds) {
  const hit = (e) => e && e.isUtrEntry !== true && rowIds.has(idStr(e.rentalDueId)) && ownerMatches(owner, e.landOwnerId) && hasText(e.utrNumber);
  const live = (media.ledger || []).find(hit);
  if (live) return String(live.utrNumber).trim();
  for (const y of media.ledgerHistory || []) {
    for (const m of y.months || []) {
      const e = (m.entries || []).find(hit);
      if (e) return String(e.utrNumber).trim();
    }
  }
  return null;
}

/** Every gstBalanceHistory row of the bill's GST-on-hold rows (paid or not). */
function linkedGstRows(media, rows) {
  const holdIds = new Set(rows.filter((r) => Number(r.withGst) === 1).map((r) => idStr(r._id)));
  return holdIds.size ? (media.gstBalanceHistory || []).filter((g) => holdIds.has(idStr(g.rentalDueId))) : [];
}

/** Open GST-on-hold rows of the bill: gstBalanceHistory linked by rentalDueId, not paid, no UTR. */
function pendingGstRows(media, rows) {
  const holdIds = new Set(rows.filter((r) => Number(r.withGst) === 1).map((r) => idStr(r._id)));
  if (!holdIds.size) return [];
  return (media.gstBalanceHistory || []).filter(
    (g) => holdIds.has(idStr(g.rentalDueId)) && g.isPaid !== true && !hasText(g.utrNumber),
  );
}

/** [{ mediaId, mediaDetailId, mediaCode, mediaName, rentalDueIds }] — one entry per face, no duplicates. */
function buildMediaDetails(entries) {
  const out = new Map();
  entries.forEach(({ media, row }) => {
    const faces = media.mediaDetails || [];
    const face = faces.find((d) => idStr(d._id) === idStr(row.mediaDetailId)) || (faces.length === 1 ? faces[0] : null);
    const key = `${idStr(media._id)}|${face ? idStr(face._id) : idStr(row.mediaDetailId)}`;
    if (!out.has(key)) {
      out.set(key, {
        mediaId: idStr(media._id),
        mediaDetailId: face ? idStr(face._id) : idStr(row.mediaDetailId),
        mediaCode: face?.mediaCode || "",
        mediaName: face?.mediaName || "",
        rentalDueIds: [],
      });
    }
    const e = out.get(key);
    if (!e.rentalDueIds.includes(idStr(row._id))) e.rentalDueIds.push(idStr(row._id));
  });
  return [...out.values()];
}

/** Group = every row (any site) that carries the same Bill Number: [{ media, row }]. Item, or null when nothing is open. */
function evaluateGroup(billNumber, entries, helpers, nowMs = Date.now()) {
  const first = entries[0];
  const media = first.media;
  const rows = entries.map((e) => e.row);
  const rowIds = new Set(rows.map((r) => idStr(r._id)));
  const primary = first.row; // verified: payments / GST rows are stored against the first row of the group
  const owners = media.landOwners || [];
  const currentLabel = monthLabelOf(nowMs);
  const targetType = primary.dueMonth === currentLabel ? "current" : "pastCycle";

  const pendingPayments = [];
  const base = (owner) => ({
    rentalDueId: idStr(primary._id),
    landOwnerId: idStr(owner._id),
    landOwnerMasterId: idStr(owner.landOwnerMasterId),
    landOwnerName: owner.name || "",
    targetType,
  });

  owners.forEach((owner) => {
    const cat = Number(owner.paymentCategory || 1);
    if ((cat === 1 || cat === 3) && !hasRentPayment(media, owner, rowIds, primary, "Cash", helpers)) {
      pendingPayments.push({ paymentType: "cash", ...base(owner), entryType: "rental", paymentMode: "Cash", utrRequired: false, autoProcess: false });
    }
    if ((cat === 2 || cat === 3) && !hasRentPayment(media, owner, rowIds, primary, "Online", helpers)) {
      pendingPayments.push({ paymentType: "online_rent", ...base(owner), entryType: "rental", paymentMode: "Online", utrRequired: true, autoProcess: false });
    }
  });

  pendingGstRows(media, rows).forEach((g) => {
    const owner = owners.find((o) => ownerMatches(o, g.ownerId || g.landOwnerId)) || (owners.length === 1 ? owners[0] : null);
    pendingPayments.push({
      paymentType: "gst",
      rentalDueId: idStr(g.rentalDueId),
      landOwnerId: owner ? idStr(owner._id) : idStr(g.ownerId || g.landOwnerId),
      landOwnerMasterId: owner ? idStr(owner.landOwnerMasterId) : "",
      landOwnerName: owner ? owner.name || "" : g.ownerName || "",
      entryType: "gst",
      paymentMode: null, // not decided yet — taken from the payment when it is made
      targetType: g.dueMonth === currentLabel ? "current" : "pastCycle",
      gstBalanceHistoryId: idStr(g._id),
      gstDueMonth: g.dueMonth || "",
      gstAmount: Number(g.gstAmount || 0),
      utrRequired: true,
      autoProcess: false,
      reason: "gst_separate_utr_manual_review",
    });
  });

  if (!pendingPayments.length) return null; // everything on this bill is paid

  // ── safety of saving a UTR automatically ──
  const reasons = [];
  const mediaIds = new Set(entries.map((e) => idStr(e.media._id)));
  const separateSite = (media.mediaDetails || []).some((d) => Number(d.siteBillMode) === 2);
  const rentSlots = pendingPayments.filter((p) => p.paymentType === "online_rent" || p.paymentType === "cash");

  if (mediaIds.size > 1) reasons.push("duplicate_bill_number");
  if (!(media.mediaDetails || []).some((d) => Number(d.status) === 1)) reasons.push("media_inactive");
  if (owners.length !== 1) reasons.push("multiple_landlords");
  if (Array.isArray(primary.adinn_ooh_bills_landOwners) && primary.adinn_ooh_bills_landOwners.length > 0) reasons.push("separate_landlord_bills");
  if (rows.some((r) => Number(r.withGst) === 1) || pendingPayments.some((p) => p.paymentType === "gst")) reasons.push("gst_separate_utr");
  if (rows.length > 1) {
    if (new Set(rows.map((r) => r.dueMonth)).size > 1) reasons.push("rows_in_different_months");
    if (separateSite) reasons.push("separate_bill_site_rows");
  }
  if (!rentSlots.length) reasons.push("no_rent_payment_pending");
  else if (rentSlots.length !== 1) reasons.push("no_single_rent_slot");

  // Several landlords: the bill stays mappingSafe:false ("multiple_landlords"). It is eligible for the per-landlord matching
  // (finance reply, one line per landlord) when that is the ONLY thing in the way and no landlord has two open payments.
  const slotCount = new Map();
  rentSlots.forEach((p) => slotCount.set(p.landOwnerId, (slotCount.get(p.landOwnerId) || 0) + 1));
  const otherBlockers = reasons.filter((r) => r !== "multiple_landlords" && r !== "no_single_rent_slot");
  if ([...slotCount.values()].some((n) => n > 1)) otherBlockers.push("landlord_with_two_open_payments");
  const perLandlordEligible = owners.length > 1 && reasons.includes("multiple_landlords") && otherBlockers.length === 0 && rentSlots.length > 0;
  const perLandlordMapping =
    owners.length > 1
      ? {
          eligible: perLandlordEligible,
          reasons: perLandlordEligible ? [] : otherBlockers,
          landlords: owners.map((o) => {
            const slot = rentSlots.find((p) => p.landOwnerId === idStr(o._id));
            const digits = String(o.accountNumber || "").replace(/\D/g, "");
            return {
              landOwnerId: idStr(o._id),
              landOwnerMasterId: idStr(o.landOwnerMasterId),
              name: o.name || "",
              bankName: o.bankName || "",
              accountLast4: digits.length >= 4 ? digits.slice(-4) : null,
              state: slot ? "pending" : "settled",
              paymentType: slot ? slot.paymentType : null,
              paymentMode: slot ? slot.paymentMode : null,
              rentalDueId: idStr(primary._id),
              storedUtr: slot ? null : storedUtrFor(media, o, rowIds),
            };
          }),
        }
      : null;

  // GST ON HOLD, one landlord: rent and GST are two payments with two UTRs, usually days apart. The bill stays
  // mappingSafe:false ("gst_separate_utr"); it is eligible for the labelled Rent / GST matching when that is the only thing
  // in the way, it has at most one open rent payment and exactly one GST row.
  const holdBill = rows.some((r) => Number(r.withGst) === 1);
  const gstRowsAll = holdBill ? linkedGstRows(media, rows) : [];
  const gstOpen = pendingPayments.filter((p) => p.paymentType === "gst");
  const splitBlockers = reasons.filter((r) => !["gst_separate_utr", "no_single_rent_slot", "no_rent_payment_pending"].includes(r));
  if (rentSlots.length > 1) splitBlockers.push("no_single_rent_slot");
  if (gstRowsAll.length !== 1) splitBlockers.push(gstRowsAll.length ? "multiple_gst_rows" : "no_gst_row");
  const splitEligible = holdBill && owners.length === 1 && splitBlockers.length === 0;
  const gstSplitMapping = holdBill
    ? {
        eligible: splitEligible,
        reasons: splitEligible ? [] : splitBlockers,
        landlord: owners[0]
          ? { landOwnerId: idStr(owners[0]._id), name: owners[0].name || "", bankName: owners[0].bankName || "", accountLast4: (String(owners[0].accountNumber || "").replace(/D/g, "").slice(-4)) || null }
          : null,
        // only the payments still open; each needs its own labelled UTR line
        slots: [
          ...rentSlots.map((p) => ({ kind: "rent", paymentType: p.paymentType, paymentMode: p.paymentMode, rentalDueId: p.rentalDueId, targetType: p.targetType, landOwnerId: p.landOwnerId, landOwnerName: p.landOwnerName })),
          ...gstOpen.map((p) => ({ kind: "gst", paymentType: "gst", paymentMode: "Online", rentalDueId: p.rentalDueId, targetType: p.targetType, landOwnerId: p.landOwnerId, landOwnerName: p.landOwnerName, gstBalanceHistoryId: p.gstBalanceHistoryId, gstAmount: p.gstAmount, gstDueMonth: p.gstDueMonth })),
        ],
      }
    : null;

  // GST ON HOLD, SEVERAL landlords: each landlord has his own rent payment and his own GST row (gstBalanceHistory, one per
  // landlord). Eligible for the "<landlord> - Rent|GST - UTR" matching when that is the only thing in the way.
  const multiHold = holdBill && owners.length > 1;
  const mgBlockers = reasons.filter((r) => !["multiple_landlords", "gst_separate_utr", "no_single_rent_slot", "no_rent_payment_pending"].includes(r));
  if ([...slotCount.values()].some((n) => n > 1)) mgBlockers.push("landlord_with_two_open_payments");
  if (multiHold) {
    const perOwner = new Map();
    gstRowsAll.forEach((g) => {
      const o = owners.find((x) => ownerMatches(x, g.ownerId || g.landOwnerId));
      if (!o) { if (!mgBlockers.includes("gst_row_without_landlord")) mgBlockers.push("gst_row_without_landlord"); return; }
      perOwner.set(idStr(o._id), (perOwner.get(idStr(o._id)) || 0) + 1);
    });
    if (!gstRowsAll.length) mgBlockers.push("no_gst_row");
    if ([...perOwner.values()].some((n) => n > 1)) mgBlockers.push("multiple_gst_rows_for_landlord");
  }
  const mgSlots = multiHold
    ? [
        ...rentSlots.map((p) => ({ kind: "rent", paymentType: p.paymentType, paymentMode: p.paymentMode, rentalDueId: p.rentalDueId, targetType: p.targetType, landOwnerId: p.landOwnerId, landOwnerName: p.landOwnerName })),
        ...gstOpen.map((p) => ({ kind: "gst", paymentType: "gst", paymentMode: "Online", rentalDueId: p.rentalDueId, targetType: p.targetType, landOwnerId: p.landOwnerId, landOwnerName: p.landOwnerName, gstBalanceHistoryId: p.gstBalanceHistoryId, gstAmount: p.gstAmount, gstDueMonth: p.gstDueMonth })),
      ]
    : [];
  const mgEligible = multiHold && mgBlockers.length === 0 && mgSlots.length > 0;
  const landlordGstMapping = multiHold
    ? {
        eligible: mgEligible,
        reasons: mgEligible ? [] : mgBlockers,
        landlords: owners.map((o) => {
          const digits = String(o.accountNumber || "").replace(/\D/g, "");
          return { landOwnerId: idStr(o._id), landOwnerMasterId: idStr(o.landOwnerMasterId), name: o.name || "", bankName: o.bankName || "", accountLast4: digits.length >= 4 ? digits.slice(-4) : null };
        }),
        slots: mgSlots, // only the payments still open; each needs its own "<landlord> - Rent|GST" line
      }
    : null;

  const mappingSafe = reasons.length === 0;
  if (mappingSafe) rentSlots[0].autoProcess = true;
  else rentSlots.forEach((p) => { p.reason = reasons[0]; });

  const mediaDetails = buildMediaDetails(entries);
  const siteBillMode = separateSite ? 2 : 1;

  return {
    billNumber,
    status: "pending",
    mappingSafe,
    skipReason: mappingSafe ? null : reasons[0],
    manualReviewReasons: reasons,
    landlordGstMapping, // GST on hold, SEVERAL landlords: "<landlord> - Rent|GST" matching (own switches)
    gstSplitMapping, // GST on hold, one landlord: the Rent / GST labelled matching (never auto-saved without its own switch)
    perLandlordMapping, // several landlords only: how each landlord's UTR can be matched (never auto-saved without its own switch)
    paymentTypes: [...new Set(pendingPayments.map((p) => p.paymentType))],
    // backward compatible single-site fields (= first site of mediaDetails)
    mediaId: idStr(media._id),
    mediaCode: mediaDetails[0]?.mediaCode || media.mediaCode || "",
    mediaName: mediaDetails[0]?.mediaName || media.mediaName || "",
    mediaDetails,
    siteBillMode,
    rentalDueIds: rows.map((r) => idStr(r._id)),
    dueMonth: primary.dueMonth || "",
    dueDate: primary.dueDate || null,
    withGst: Number(primary.withGst || 0),
    approvalStatus: Number(primary.approvalStatus),
    mailSent: primary.mailSent === true,
    approvalDate: primary.ownerApprovalDate || null, // earliest Paid Date the Ledger Entry screen allows
    landlords: owners.map((o) => ({
      landOwnerId: idStr(o._id),
      landOwnerMasterId: idStr(o.landOwnerMasterId),
      name: o.name || "",
      paymentCategory: Number(o.paymentCategory || 1),
    })),
    pendingPayments,
  };
}

/**
 * deps (all optional, for tests): { Media, Log, helpers: { isOwnerModePaidForCycle }, now }
 * opts: { limit, sinceDays, billNumbers, currentMonthOnly }
 * Default = ALL months. currentMonthOnly:true keeps only bills whose dueMonth is this month (India time).
 * There is no age limit unless sinceDays is passed explicitly.
 */
async function getPendingUtrBills(opts = {}, deps = {}) {
  const Media = deps.Media || require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const helpers = deps.helpers || defaultLedgerHelpers();
  const nowMs = deps.now || Date.now();
  const field = billField();
  const limit = Math.max(1, Number(opts.limit) || 500);
  const cutoff = opts.sinceDays ? nowMs - Number(opts.sinceDays) * 86400000 : null;
  const currentLabel = opts.currentMonthOnly ? monthLabelOf(nowMs) : null;
  const wanted = Array.isArray(opts.billNumbers) && opts.billNumbers.length ? new Set(opts.billNumbers.map(String)) : null;

  const docs = await Media.find({
    rentalDue: { $elemMatch: { approvalStatus: 3, mailSent: true, [field]: { $nin: [null, ""] } } },
  })
    .select("mediaName mediaCode mediaDetails landOwners rentalDue ledger ledgerHistory gstBalanceHistory")
    .lean();

  // every approved + mailed row with a usable Bill Number, grouped by that number (array order kept)
  const byBill = new Map();
  for (const media of docs) {
    for (const row of media.rentalDue || []) {
      if (!row || Number(row.approvalStatus) !== 3 || row.mailSent !== true) continue;
      const bill = hasText(row[field]) ? String(row[field]).trim() : "";
      if (!isValidBill(bill)) continue;
      if (currentLabel && row.dueMonth !== currentLabel) continue;
      if (cutoff && new Date(row.dueDate).getTime() < cutoff) continue;
      if (wanted && !wanted.has(bill)) continue;
      if (!byBill.has(bill)) byBill.set(bill, []);
      byBill.get(bill).push({ media, row });
    }
  }

  let bills = [];
  for (const [bill, entries] of byBill) {
    const item = evaluateGroup(bill, entries, helpers, nowMs);
    if (item) bills.push(item);
  }
  bills.sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0) || a.billNumber.localeCompare(b.billNumber));
  const totalPending = bills.length;
  const all = bills;
  bills = bills.slice(0, limit);

  // latest processing result per bill (best effort — a missing log never breaks this read)
  try {
    const Log = deps.Log || require("../models/Admin/GmailUtrLogSchema");
    const logs = await Log.find({ billNumber: { $in: bills.map((b) => b.billNumber) }, dryRun: false })
      .sort({ createdAt: -1 })
      .select("billNumber status reason createdAt")
      .lean();
    const latest = new Map();
    logs.forEach((l) => latest.has(l.billNumber) || latest.set(l.billNumber, l));
    bills.forEach((b) => {
      const l = latest.get(b.billNumber);
      b.lastProcessing = l ? { status: l.status, reason: l.reason || "", at: l.createdAt } : null;
    });
  } catch (_) {
    /* ignore */
  }

  const paymentCounts = { cash: 0, online_rent: 0, gst: 0 };
  all.forEach((b) => b.pendingPayments.forEach((p) => { paymentCounts[p.paymentType] += 1; }));

  return {
    billField: field,
    scope: currentLabel ? `current month only (${currentLabel})` : "all months",
    totalPending,
    returned: bills.length,
    safeToAutoSave: all.filter((b) => b.mappingSafe).length,
    needsManualReview: all.filter((b) => !b.mappingSafe).length,
    pendingPaymentCounts: paymentCounts,
    bills,
  };
}

module.exports = { getPendingUtrBills, evaluateGroup, buildMediaDetails, pendingGstRows, isValidBill, billField, monthLabelOf };
