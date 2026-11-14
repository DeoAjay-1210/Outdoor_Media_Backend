// Daily refresh of agreement.status (1=Active 2=Expire soon 3=Expired).
// The status is otherwise computed only when a site is saved (MediaSchema PRE-SAVE 4 — Agreement Status),
// so a site nobody saves keeps a stale status. Same formula as that pre-save hook; only agreement.status of
// changed sites is written (no other field, no updatedAt change).
const DAY_MS = 86400000;

/** Same rule as MediaSchema PRE-SAVE 4: days = ceil((end - now) / 1 day); < 0 → 3, <= reminder (default 30) → 2, else 1. */
const agreementStatusFor = (endDate, reminderBeforeExpiry, now = new Date()) => {
  const days = Math.ceil((new Date(endDate).getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return 3;
  if (days <= (Number(reminderBeforeExpiry) || 30)) return 2;
  return 1;
};

/** Refreshes agreement.status of every site with a start + end date. Returns { checked, updated }. */
async function syncAgreementStatuses(Media, now = new Date()) {
  const docs = await Media.find(
    { "agreement.startDate": { $ne: null }, "agreement.endDate": { $ne: null } },
    "agreement.startDate agreement.endDate agreement.reminderBeforeExpiry agreement.status",
  ).lean();
  const ops = [];
  for (const d of docs) {
    const ag = d.agreement || {};
    if (!ag.startDate || !ag.endDate || Number.isNaN(new Date(ag.endDate).getTime())) continue;
    const status = agreementStatusFor(ag.endDate, ag.reminderBeforeExpiry, now);
    if (Number(ag.status) !== status) {
      ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { "agreement.status": status } } } });
    }
  }
  if (ops.length) await Media.collection.bulkWrite(ops, { ordered: false });
  return { checked: docs.length, updated: ops.length };
}

module.exports = { agreementStatusFor, syncAgreementStatuses };
