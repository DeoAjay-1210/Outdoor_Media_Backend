// One-time fix: ledger dates saved one day early (setHours/nowIST bug). Dry run by default.
//   node scripts/fixShiftedLedgerDates.js           → dry run (no writes)
//   node scripts/fixShiftedLedgerDates.js --apply   → +1 day on the wrong entries, ONCE (logged in data_fixes)
require("dotenv").config();
const mongoose = require("mongoose");


const APPLY = process.argv.includes("--apply");
const FIX_ID = "ledger-date-shift-2026-11";
const DAY = 86400000;
const CUT = (18 * 60 + 30) * 60000; // 18:30 UTC time of day
const tod = (d) => d.getTime() % DAY;
// wrong = saved by the buggy stamp: time >= 18:30, same time as its save stamp, day before the save day
const isWrong = (date, stamp) =>
  date instanceof Date && stamp instanceof Date &&
  tod(date) >= CUT &&
  Math.abs(tod(date) - tod(stamp)) <= 2000 &&
  Math.floor(date.getTime() / DAY) < Math.floor(stamp.getTime() / DAY);


(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const col = db.collection("mediaonboardings");
  const log = db.collection("data_fixes");


  const done = await log.findOne({ _id: FIX_ID });
  if (done) {
    console.log(`Already applied on ${done.appliedAt.toISOString()} (${done.count} entries) — nothing to do.`);
    process.exit(0);
  }


  const fixes = [];
  for await (const m of col.find({}, { projection: { ledger: 1, ledgerHistory: 1, "mediaDetails.mediaCode": 1 } })) {
    const code = (m.mediaDetails || []).map((f) => f.mediaCode).filter(Boolean).join(", ");
    const add = (path, e, stamp) => {
      if (isWrong(e.date, stamp)) fixes.push({ mediaId: m._id, code, path, old: e.date, stamp, who: e.landOwnerName || "", utr: e.utrNumber || "" });
    };
    (m.ledger || []).forEach((e, i) => add(`ledger.${i}.date`, e, e.updatedAt));
    (m.ledgerHistory || []).forEach((y, yi) => (y.months || []).forEach((mo, mi) => (mo.entries || []).forEach((e, ei) =>
      add(`ledgerHistory.${yi}.months.${mi}.entries.${ei}.date`, e, e.updatedAt || e.createdAt))));
  }


  const byField = {};
  fixes.forEach((f) => { const k = f.path.replace(/\.\d+/g, "[]"); byField[k] = (byField[k] || 0) + 1; });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — wrong entries: ${fixes.length}`, byField);
  fixes.slice(0, 30).forEach((f) =>
    console.log(`  ${f.code} | ${f.who} | UTR ${f.utr} | ${f.path} | saved ${f.stamp.toISOString()} | ${f.old.toISOString()} -> ${new Date(f.old.getTime() + DAY).toISOString()}`));
  if (!APPLY || fixes.length === 0) process.exit(0);


  let fixed = 0, skipped = 0;
  const applied = [];
  for (const f of fixes) {
    const next = new Date(f.old.getTime() + DAY);
    const r = await col.updateOne({ _id: f.mediaId, [f.path]: f.old }, { $set: { [f.path]: next } }); // only if unchanged
    if (r.modifiedCount === 1) { fixed++; applied.push({ mediaId: f.mediaId, path: f.path, old: f.old, new: next }); } else skipped++;
  }
  await log.insertOne({ _id: FIX_ID, appliedAt: new Date(), count: fixed, entries: applied });
  console.log(`fixed ${fixed}, skipped ${skipped}. Logged in data_fixes/${FIX_ID} — a second --apply will not run.`);
  process.exit(0);
})().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
