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
const { getRentForDueDate, mediaAsOfDate } = require("./appraisalRent");

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
    const idx = MONTHS.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
    if (idx < 0) return null;
    return new Date(Date.UTC(Number(m[2]), idx, 1));
  }
  return null;
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
function buildRevisionPlan(media, fromDate, newRent, applyToAllMonths = 1) {
  // applyToAllMonths 0 → only fromMonth changes (site rent and later months stay)
  const onlyFromMonth = Number(applyToAllMonths) === 0 && applyToAllMonths !== null;
  const m = toPlain(media) || {};
  const rp = m.rentalPayment || {};
  const oldRent = Number(rp.totalRentalAmount || 0);
  const fromKey = monthKey(fromDate);

  const bills = (m.rentalDue || [])
    .filter((b) => b && b.dueDate && (onlyFromMonth ? monthKey(b.dueDate) === fromKey : monthKey(b.dueDate) >= fromKey))
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
    const monthRent = getRentForDueDate(m, dueDate);
    const isApprovedMonth = monthBills.some((b) => Number(b.approvalStatus) === 3);

    if (isApprovedMonth) {
      // approved at monthRent → stays; difference = arrears
      keptMonths.push({ dueMonth, rent: monthRent });
      const diff = round(newRent - monthRent);
      if (diff <= 0 || monthRent <= 0) return;

      const monthMedia = toPlain(mediaAsOfDate(m, dueDate)) || {};
      const owners = monthMedia.landOwners || [];
      const gstForMonth = monthGst(monthMedia);
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
          gstAmount: round(Number(o.gstAmount || 0) * ratio * billFraction),
          tdsAmount: round(Number(o.tdsAmount || 0) * ratio * billFraction),
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
          newRent,
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
    // (only this month: the month is priced at the new rent, site rent stays)
    if (onlyFromMonth) keptMonths.push({ dueMonth, rent: newRent });
    monthBills.forEach((bill) => {
      const scale = monthRent > 0 ? newRent / monthRent : 1;
      const oldAmount = Number(bill.netPayable || 0);
      billsUpdated.push({
        rentalDueId: bill._id,
        dueMonth,
        oldAmount,
        newAmount: round(oldAmount * scale),
        baseAmount: round(Number(bill.baseAmount || 0) * scale),
        gstAmount: round(Number(bill.gstAmount || 0) * scale),
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
    label: `Arrears – ${planBill.dueMonth}`,
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
        const tds = share > 0 ? round((Number(o.tdsAmount || 0) * rentAmount) / share) : 0;
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
    totalTds: sum((b) => Number(b.tdsAmount || 0)),
    paidAmount: sum((b) => Number(b.rentPaid || 0)),
    paidGst: sum((b) => Number(b.gstPaid || 0)),
    pendingAmount: sum(billPending),
    pendingGst: sum(billGstPending),
    bills: bills.map((b) => ({
      rentalDueId: b._id,
      label: b.label,
      dueMonth: b.dueMonth,
      parentRentalDueId: b.parentRentalDueId,
      rentRevisionId: b.rentRevisionId,
      rentAmount: Number(b.netPayable || 0),
      gstAmount: Number(b.gstAmount || 0),
      tdsAmount: Number(b.tdsAmount || 0),
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

// Inserts rows after the last row of the same month (else appends)
function insertAfterMonth(list, rows, dueMonth) {
  const out = [...(list || [])];
  let at = -1;
  out.forEach((r, i) => {
    if (r && (r.dueMonth === dueMonth || r.month === dueMonth)) at = i;
  });
  if (at < 0) out.push(...rows);
  else out.splice(at + 1, 0, ...rows);
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
        oldRent: r.oldRent,
        increaseAmount: r.increaseAmount ?? r.difference,
        newRent: r.newRent,
        applyToAllMonths: r.applyToAllMonths ?? null,
        status: r.status,
        approvedAt: r.approvedAt,
      }
    : null;

// ledger rows of one arrears bill (one per owner, same shape as ledger rows)
function arrearsLedgerRows(b) {
  const lastPay = (b.payments || []).filter((p) => p.type === "rental").slice(-1)[0];
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
      billType: "arrears",
      label: b.label,
      rentRevisionId: b.rentRevisionId,
      index: null,
      updatedBy: paid && lastPay ? lastPay.createdBy || "" : "",
      updatedAt: paid && lastPay ? lastPay.createdAt : null,
      shareAmount: Number(o.shareAmount || 0),
      tdsAmount: Number(o.tdsAmount || 0),
      isVirtual: !paid,
      isPaid: paid,
      targetType: "arrears",
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
    billType: "arrears",
    label: `${b.label} GST`,
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
function decorateLedgerItem(item, arrearsBills, lastRevision, parentWithGstById = new Map()) {
  const bills = arrearsBillsWithGst(arrearsBills, parentWithGstById);
  const out = { ...item };
  delete out.arrearsDue;
  if (lastRevision) out.rentRevision = revisionBlock(lastRevision);
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
    ledger = insertAfterMonth(ledger, arrearsLedgerRows(b).map(({ isPaid, ...r }) => r), b.dueMonth);
    const gstRow = arrearsGstRow(b);
    if (gstRow) gstBalanceHistory = insertAfterMonth(gstBalanceHistory, [gstRow], b.dueMonth);

    rentalDueEntries = insertAfterMonth(
      rentalDueEntries,
      [{
        _id: b._id,
        type: "arrears",
        label: b.label,
        parentRentalDueId: b.parentRentalDueId,
        dueMonth: b.dueMonth,
        dueDate: b.dueDate,
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
          billType: "arrears",
          label: b.label,
          rentalDueId: b._id,
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
              pendingType: "arrearsPending",
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
  out.outstanding = withArrearsOutstanding(out.outstanding, bills);
  out.arrears = arrearsBlock(bills);
  return out;
}

/**
 * One ledger-history media block + that site's arrears bills → the arrears
 * rows added to the arrears month's bucket (ledgerHistory[year].months[month]:
 * ledger, allEntries, withGst1Ledger, gstBalanceHistory), the full
 * gstBalanceHistory, outstanding, arrears and rentRevision blocks.
 * inRange(date) → false skips a month outside the requested filter.
 */
function decorateLedgerHistoryBlock(block, arrearsBills, lastRevision, parentWithGstById = new Map(), inRange = () => true) {
  const bills = arrearsBillsWithGst(arrearsBills, parentWithGstById);
  const out = { ...block };
  if (lastRevision) out.rentRevision = revisionBlock(lastRevision);
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
      amount: r.isPaid ? Number(r.shareAmount || 0) - Number(r.tdsAmount || 0) : 0,
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
      billType: "arrears",
      label: p.type === "gst" ? `${b.label} GST` : b.label,
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
      gstBalanceHistory = insertAfterMonth(gstBalanceHistory, [gstRow], b.dueMonth);
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
            billType: "arrears",
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
  out.outstanding = withArrearsOutstanding(out.outstanding, bills);
  out.arrears = arrearsBlock(bills);
  return out;
}

/**
 * Overall arrears totals across sites: docs = [{ _id, arrearsDue }]
 */
function overallArrearsTotals(docs) {
  const t = {
    amount: 0, gst: 0, paid: 0, gstPaid: 0, pending: 0, gstPending: 0,
    amountSites: 0, paidSites: 0, pendingSites: 0, gstPendingSites: 0,
  };
  (docs || []).forEach((d) => {
    const bills = (d.arrearsDue || []).filter((b) => b && b.type === "arrears");
    if (!bills.length) return;
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
  arrearsStatus,
  effectiveWithGst,
  applyArrearsPayment,
  arrearsBlock,
  decorateLedgerItem,
  decorateLedgerHistoryBlock,
  overallArrearsTotals,
};
