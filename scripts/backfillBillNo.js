#!/usr/bin/env node
// One-time: gives a bill number (utils/billNo.js) to every existing bill
// (media.rentalDue[]) that has none, oldest first (dueDate, then createdAt).
// Single bill site → every face row of the same month shares one number.
// Bills that already have a billNo are not touched. New bills continue the
// same running number afterwards.
//
// Usage:
//   node scripts/backfillBillNo.js            → dry run (prints, writes nothing)
//   node scripts/backfillBillNo.js --apply    → saves the numbers
require("dotenv").config();
const mongoose = require("mongoose");
const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { formatBillNo, nextBillSeq, isSingleBillSite } = require("../utils/billNo");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const docs = await Media.find({ "rentalDue.0": { $exists: true } })
    .select("mediaDetails.siteBillMode mediaDetails.mediaCode rentalDue._id rentalDue.dueMonth rentalDue.dueDate rentalDue.createdAt rentalDue.mediaDetailId rentalDue.billNo")
    .lean();

  // one group = one bill number: single bill site → media + month, else each row
  const groups = [];
  docs.forEach((m) => {
    const single = isSingleBillSite(m);
    const byKey = new Map();
    (m.rentalDue || []).forEach((r) => {
      if (!r || !r.dueDate) return;
      const key = single ? r.dueMonth : String(r._id);
      if (!byKey.has(key)) byKey.set(key, { mediaId: m._id, code: (m.mediaDetails || []).map((d) => d.mediaCode).join(" / "), rows: [] });
      byKey.get(key).rows.push(r);
    });
    byKey.forEach((g) => {
      const missing = g.rows.filter((r) => !r.billNo);
      if (!missing.length) return;
      const existing = g.rows.find((r) => r.billNo);
      const first = [...g.rows].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
      groups.push({ ...g, missing, existingBillNo: existing ? existing.billNo : null, dueDate: first.dueDate, createdAt: first.createdAt, dueMonth: first.dueMonth });
    });
  });
  groups.sort(
    (a, b) =>
      new Date(a.dueDate) - new Date(b.dueDate) ||
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0),
  );

  console.log(`${groups.length} bill(s) without a bill number${APPLY ? "" : " (dry run — add --apply to save)"}`);
  let dryCount = 0;
  for (const g of groups) {
    let billNo = g.existingBillNo;
    if (!billNo) billNo = APPLY ? formatBillNo(g.dueDate, await nextBillSeq()) : `${formatBillNo(g.dueDate, ++dryCount)} (preview)`;
    console.log(`${g.code} | ${g.dueMonth} | ${g.missing.length} row(s) → ${billNo}`);
    if (!APPLY) continue;
    await Media.updateOne(
      { _id: g.mediaId },
      { $set: { "rentalDue.$[e].billNo": billNo } },
      { arrayFilters: [{ "e._id": { $in: g.missing.map((r) => r._id) }, "e.billNo": null }], timestamps: false },
    );
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
