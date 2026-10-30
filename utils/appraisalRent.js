// ─────────────────────────────────────────────────────────────
// Rent effective for a given due date.
//
// rentalPayment.totalRentalAmount always holds the CURRENT rent, which
// already includes any appraisal applied this month. A due entry for an
// earlier cycle (e.g. September, when the appraisal starts in October)
// must keep the pre-appraisal rent, so it is resolved from
// appraisal.history: if an already-applied appraisal starts in a month
// AFTER the due month, the due month uses that appraisal's previousRent.
// ─────────────────────────────────────────────────────────────
const monthKey = (input) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

// ✅ NEW — a MANUAL rent change (media onboarding totalRentalAmount, e.g. 50k →
// 55k in October) takes effect from the month it was made: a due month BEFORE
// that change keeps the rent in force before it (August / September stay 50k,
// October onwards 55k). Returns that earlier rent, or 0 when no manual change
// was made after the due month. Not counted as a manual change: the first
// history row (onboarding amount) and the system rows (appraisal applied /
// appraisal hold release).
// ✅ NEW — rent revision row: applies from its fromMonth (effectiveFrom)
const rowEffectiveDate = (h) => h.effectiveFrom || h.updatedAt;

function rentBeforeLaterManualChange(media, dueKey) {
  const rows = (media?.rentalPayment?.rentalAmountHistory || [])
    .filter((h) => h && Number(h.amount || 0) > 0 && h.updatedAt && monthKey(rowEffectiveDate(h)) !== null)
    .slice()
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  const isAppraisalRow = (h) => /Appraisal/i.test(String(h.updatedBy || ""));
  let start = 1;
  for (;;) {
    // first manual change effective AFTER the due month
    let first = -1;
    for (let i = start; i < rows.length; i++) {
      if (isAppraisalRow(rows[i])) continue;
      if (monthKey(rowEffectiveDate(rows[i])) > dueKey) {
        first = i;
        break;
      }
    }
    if (first < 0) return 0;
    // ✅ NEW — a LATER change with effectiveFrom on/before the due month (rent
    // change applied to every not-approved month) overrides it
    let cover = -1;
    for (let j = first + 1; j < rows.length; j++) {
      if (isAppraisalRow(rows[j]) || !rows[j].effectiveFrom) continue;
      if (monthKey(rows[j].effectiveFrom) <= dueKey) cover = j;
    }
    if (cover < 0) return Number(rows[first - 1].amount) || 0;
    start = cover + 1;
  }
}

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ✅ NEW — rent revision: a month already CMD approved before the revision keeps
// the rent it was approved at (its difference is a separate arrears bill).
// Latest revision wins. Returns 0 when the month was not kept.
function rentRevisionKeptEntry(media, dueKey) {
  const kept = media?.rentalPayment?.rentRevisionKeptMonths;
  if (!Array.isArray(kept) || kept.length === 0) return null;
  const label = `${MONTH_LABELS[dueKey % 12]} ${Math.floor(dueKey / 12)}`;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i] && kept[i].dueMonth === label && Number(kept[i].rent) > 0) return kept[i];
  }
  return null;
}

function rentRevisionKeptRent(media, dueKey) {
  const entry = rentRevisionKeptEntry(media, dueKey);
  return entry ? Number(entry.rent) : 0;
}

// ✅ NEW — rent revision ADVANCE: a CMD approved advance is deducted from the
// bill it is adjusted in (rentalPayment.advanceAdjustments[{ dueMonth, amount,
// gstDeducted: 1 → its GST is deducted too }]). Returns { amount, gstAmount }.
// afterTime → only advances approved after it (a kept month already has the
// earlier ones in its rent)
function advanceDeductionFor(media, dueKey, afterTime = null) {
  const rows = media?.rentalPayment?.advanceAdjustments;
  const out = { amount: 0, gstAmount: 0 };
  if (!Array.isArray(rows) || rows.length === 0 || dueKey === null) return out;
  const label = `${MONTH_LABELS[dueKey % 12]} ${Math.floor(dueKey / 12)}`;
  rows.forEach((r) => {
    if (!r || r.dueMonth !== label) return;
    if (afterTime && r.createdAt && new Date(r.createdAt).getTime() <= afterTime) return;
    const amount = Number(r.amount || 0);
    out.amount += amount;
    if (Number(r.gstDeducted) === 1) out.gstAmount += amount;
  });
  return out;
}

// rent of the due month (rent) and the rent its GST is worked out on (gstRent).
// They differ when an increase / advance was taken without GST.
function rentPartsForDueDate(media, dueDate) {
  const dueKey = dueDate ? monthKey(dueDate) : null;
  // month kept at a fixed rent (rent revision / CMD approved before a rent
  // change) → that rent; ✅ CHANGED — an advance approved AFTER it was kept is
  // still deducted (kept rows without a time → every advance)
  if (dueKey !== null) {
    const kept = rentRevisionKeptEntry(media, dueKey);
    if (kept) {
      const rent = Number(kept.rent);
      const gstRent = Number(kept.gstRent) > 0 ? Number(kept.gstRent) : rent;
      const keptTime = kept.keptAt || kept.lockedAt;
      const later = advanceDeductionFor(media, dueKey, keptTime ? new Date(keptTime).getTime() : 0);
      return {
        rent: Math.max(0, rent - later.amount),
        gstRent: Math.max(0, gstRent - later.gstAmount),
      };
    }
  }
  const rent = rentBeforeAdvance(media, dueDate);
  const advance = advanceDeductionFor(media, dueKey);
  if (advance.amount <= 0) return { rent, gstRent: rent };
  return {
    rent: Math.max(0, rent - advance.amount),
    gstRent: Math.max(0, rent - advance.gstAmount),
  };
}

function getRentForDueDate(media, dueDate) {
  return rentPartsForDueDate(media, dueDate).rent;
}

function rentBeforeAdvance(media, dueDate) {
  let currentRent = Number(media?.rentalPayment?.totalRentalAmount || 0);
  const dueKey = dueDate ? monthKey(dueDate) : null;
  // ✅ NEW — rent changed manually AFTER this month → this month keeps the old rent
  if (dueKey !== null) {
    const rentBefore = rentBeforeLaterManualChange(media, dueKey);
    if (rentBefore > 0) currentRent = rentBefore;
  }
  const history = media?.appraisal?.history;
  if (dueKey === null || !Array.isArray(history) || history.length === 0) {
    return currentRent;
  }

  const currentKey = monthKey(new Date());

  // Earliest appraisal that has already taken effect (month <= now) but
  // started after the due month — its previousRent was the rent in force.
  const laterApplied = history
    .filter((h) => {
      if (!h || !h.appraisalDate || h.isAnchorEntry) return false;
      if (Number(h.appraisalAmount || 0) <= 0) return false;
      if (Number(h.previousRent || 0) <= 0) return false;
      const k = monthKey(h.appraisalDate);
      return k !== null && k > dueKey && k <= currentKey;
    })
    .sort((a, b) => new Date(a.appraisalDate) - new Date(b.appraisalDate))[0];

  return laterApplied ? Number(laterApplied.previousRent) : currentRent;
}

// Ratio to scale current-rent-derived amounts (GST, owner shares) back to
// the rent effective for the due date. 1 when no appraisal applies.
function getRentRatioForDueDate(media, dueDate) {
  const currentRent = Number(media?.rentalPayment?.totalRentalAmount || 0);
  if (currentRent <= 0) return 1;
  return getRentForDueDate(media, dueDate) / currentRent;
}

// ✅ NEW — ratio for GST amounts (differs from the rent ratio only when an
// increase / advance was taken without GST)
function getGstRatioForDueDate(media, dueDate) {
  const currentRent = Number(media?.rentalPayment?.totalRentalAmount || 0);
  if (currentRent <= 0) return 1;
  return rentPartsForDueDate(media, dueDate).gstRent / currentRent;
}

const toPlain = (doc) =>
  doc && typeof doc.toObject === "function" ? doc.toObject() : doc;

// Owner split amounts (share/cash/online/GST/TDS) are stored against the
// CURRENT rent; scale them back to the rent in force for the due date.
// gstRatio (optional) → GST scaled by its own ratio
function scaleOwner(owner, ratio, gstRatio = ratio) {
  if (!owner || (ratio === 1 && gstRatio === 1)) return owner;
  const o = toPlain(owner);
  const scale = (v) => (v === undefined || v === null ? v : Math.round(Number(v) * ratio));
  return {
    ...o,
    shareAmount: scale(o.shareAmount),
    cashAmount: scale(o.cashAmount),
    onlineAmount: scale(o.onlineAmount),
    gstAmount: o.gstAmount === undefined || o.gstAmount === null ? o.gstAmount : Math.round(Number(o.gstAmount) * gstRatio),
    tdsAmount: scale(o.tdsAmount),
  };
}

function ownerAsOfDate(media, owner, dueDate) {
  return scaleOwner(owner, getRentRatioForDueDate(media, dueDate), getGstRatioForDueDate(media, dueDate));
}

function landOwnersAsOfDate(media, dueDate) {
  const owners = media?.landOwners || [];
  const ratio = getRentRatioForDueDate(media, dueDate);
  const gstRatio = getGstRatioForDueDate(media, dueDate);
  if (ratio === 1 && gstRatio === 1) return owners;
  return owners.map((o) => scaleOwner(o, ratio, gstRatio));
}

// Plain-object view of the media with rent, site GST and owner amounts as
// they were for the due date. Returns the same object when nothing changes.
function mediaAsOfDate(media, dueDate) {
  if (!media) return media;
  const ratio = getRentRatioForDueDate(media, dueDate);
  const gstRatio = getGstRatioForDueDate(media, dueDate);
  if (ratio === 1 && gstRatio === 1) return media;
  const base = toPlain(media);
  const rp = base.rentalPayment || {};
  return {
    ...base,
    rentalPayment: {
      ...rp,
      totalRentalAmount: getRentForDueDate(media, dueDate),
      gstAmount:
        rp.gstAmount === undefined || rp.gstAmount === null
          ? rp.gstAmount
          : Math.round(Number(rp.gstAmount) * gstRatio),
    },
    landOwners: (base.landOwners || []).map((o) => scaleOwner(o, ratio, gstRatio)),
  };
}

module.exports = {
  getRentForDueDate,
  getRentRatioForDueDate,
  getGstRatioForDueDate, // ✅ NEW
  rentPartsForDueDate, // ✅ NEW
  advanceDeductionFor, // ✅ NEW
  monthKey, // ✅ NEW
  ownerAsOfDate,
  landOwnersAsOfDate,
  mediaAsOfDate,
};
