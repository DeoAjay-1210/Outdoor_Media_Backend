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
  for (let i = 1; i < rows.length; i++) {
    if (/Appraisal/i.test(String(rows[i].updatedBy || ""))) continue;
    if (monthKey(rowEffectiveDate(rows[i])) > dueKey) return Number(rows[i - 1].amount) || 0;
  }
  return 0;
}

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ✅ NEW — rent revision: a month already CMD approved before the revision keeps
// the rent it was approved at (its difference is a separate arrears bill).
// Latest revision wins. Returns 0 when the month was not kept.
function rentRevisionKeptRent(media, dueKey) {
  const kept = media?.rentalPayment?.rentRevisionKeptMonths;
  if (!Array.isArray(kept) || kept.length === 0) return 0;
  const label = `${MONTH_LABELS[dueKey % 12]} ${Math.floor(dueKey / 12)}`;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i] && kept[i].dueMonth === label && Number(kept[i].rent) > 0) return Number(kept[i].rent);
  }
  return 0;
}

function getRentForDueDate(media, dueDate) {
  let currentRent = Number(media?.rentalPayment?.totalRentalAmount || 0);
  const dueKey = dueDate ? monthKey(dueDate) : null;
  // ✅ NEW — month kept at its approved rent by a rent revision
  if (dueKey !== null) {
    const keptRent = rentRevisionKeptRent(media, dueKey);
    if (keptRent > 0) return keptRent;
  }
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

const toPlain = (doc) =>
  doc && typeof doc.toObject === "function" ? doc.toObject() : doc;

// Owner split amounts (share/cash/online/GST/TDS) are stored against the
// CURRENT rent; scale them back to the rent in force for the due date.
function scaleOwner(owner, ratio) {
  if (!owner || ratio === 1) return owner;
  const o = toPlain(owner);
  const scale = (v) => (v === undefined || v === null ? v : Math.round(Number(v) * ratio));
  return {
    ...o,
    shareAmount: scale(o.shareAmount),
    cashAmount: scale(o.cashAmount),
    onlineAmount: scale(o.onlineAmount),
    gstAmount: scale(o.gstAmount),
    tdsAmount: scale(o.tdsAmount),
  };
}

function ownerAsOfDate(media, owner, dueDate) {
  return scaleOwner(owner, getRentRatioForDueDate(media, dueDate));
}

function landOwnersAsOfDate(media, dueDate) {
  const owners = media?.landOwners || [];
  const ratio = getRentRatioForDueDate(media, dueDate);
  if (ratio === 1) return owners;
  return owners.map((o) => scaleOwner(o, ratio));
}

// Plain-object view of the media with rent, site GST and owner amounts as
// they were for the due date. Returns the same object when nothing changes.
function mediaAsOfDate(media, dueDate) {
  if (!media) return media;
  const ratio = getRentRatioForDueDate(media, dueDate);
  if (ratio === 1) return media;
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
          : Math.round(Number(rp.gstAmount) * ratio),
    },
    landOwners: (base.landOwners || []).map((o) => scaleOwner(o, ratio)),
  };
}

module.exports = {
  getRentForDueDate,
  getRentRatioForDueDate,
  ownerAsOfDate,
  landOwnersAsOfDate,
  mediaAsOfDate,
};
