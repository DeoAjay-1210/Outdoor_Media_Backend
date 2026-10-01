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

function getRentForDueDate(media, dueDate) {
  const currentRent = Number(media?.rentalPayment?.totalRentalAmount || 0);
  const dueKey = dueDate ? monthKey(dueDate) : null;
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
