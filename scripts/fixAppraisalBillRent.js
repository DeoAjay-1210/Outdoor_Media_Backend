// One-time fix: bills generated at the rent BEFORE an appraisal that applies to their month.
//   node scripts/fixAppraisalBillRent.js           → dry run (no writes)
//   node scripts/fixAppraisalBillRent.js --apply   → update, ONCE (logged in data_fixes)
// Only plain bills are fixed automatically: no GST on the bill, not paid yet, baseAmount == netPayable,
// stored site rent == the appraisal's previousRent. Everything else is only REPORTED (manual check).
require("dotenv").config();
const mongoose = require("mongoose");
const { getRentForDueDate } = require("../utils/appraisalRent");


const APPLY = process.argv.includes("--apply");
const FIX_ID = "appraisal-bill-rent-2026-11";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const mk = (d) => { const x = new Date(d); return Number.isNaN(x.getTime()) ? null : x.getUTCFullYear() * 12 + x.getUTCMonth(); };
const labelKey = (l) => { const [m, y] = String(l || "").trim().split(/\s+/); const i = MONTHS.findIndex((n) => n.toLowerCase() === String(m).toLowerCase()); return i < 0 || !Number(y) ? null : Number(y) * 12 + i; };


(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const col = db.collection("mediaonboardings");
  const log = db.collection("data_fixes");
  const done = await log.findOne({ _id: FIX_ID });
  if (done) { console.log(`Already applied on ${done.appliedAt.toISOString()} (${done.count} rows) — nothing to do.`); process.exit(0); }


  const nowKey = mk(new Date());
  const plan = [], manual = [];
  for await (const m of col.find({ "appraisal.history.0": { $exists: true }, "mediaDetails.status": 1 })) {
    const hist = (m.appraisal.history || []).filter((h) => h && h.appraisalDate && !h.isAnchorEntry && Number(h.appraisalAmount) > 0 && Number(h.previousRent) > 0);
    if (!hist.length) continue;
    const active = new Set((m.mediaDetails || []).filter((f) => Number(f.status) === 1).map((f) => String(f._id)));
    const code = (m.mediaDetails || []).filter((f) => Number(f.status) === 1).map((f) => f.mediaCode).join(", ");
    const byMonth = new Map();
    (m.rentalDue || []).forEach((r, i) => {
      if (!r || !r.dueMonth || (r.mediaDetailId && !active.has(String(r.mediaDetailId)))) return; // stale face rows skipped
      if (!byMonth.has(r.dueMonth)) byMonth.set(r.dueMonth, []);
      byMonth.get(r.dueMonth).push({ r, i });
    });
    for (const [label, rows] of byMonth) {
      const key = labelKey(label);
      if (key === null || key > nowKey) continue;
      const h = hist.filter((x) => { const k = mk(x.appraisalDate); return k !== null && k <= key && k <= nowKey; })
        .sort((a, b) => new Date(b.appraisalDate) - new Date(a.appraisalDate))[0];
      if (!h) continue;
      const stored = rows.reduce((s, { r }) => s + (Number(r.withGst) === 2 ? Number(r.netPayable || 0) - Number(r.gstAmount || 0) : Number(r.netPayable || 0)), 0);
      if (Math.abs(stored - Number(h.previousRent)) > rows.length) continue; // not priced at the old rent
      const dueDate = rows[0].r.dueDate || new Date(Date.UTC(Math.floor(key / 12), key % 12, 1));
      const rentNow = Number(getRentForDueDate(m, dueDate) || 0);
      if (rentNow <= 0 || Math.abs(rentNow - stored) <= rows.length) continue;


      const ids = new Set(rows.map(({ r }) => String(r._id)));
      const monthName = MONTHS[key % 12], year = String(Math.floor(key / 12));
      const paid =
        (m.ledger || []).some((e) => e && (e.month === label || e.dueMonth === label || ids.has(String(e.rentalDueId)))) ||
        (m.ledgerHistory || []).some((y) => y.year === year && (y.months || []).some((mo) => String(mo.month).toLowerCase() === monthName.toLowerCase() && (mo.entries || []).length > 0));
      const info = { mediaId: m._id, code, label, stored, rentNow, appraisal: `${new Date(h.appraisalDate).toISOString().slice(0, 10)} ${h.previousRent}→${h.newRent}`, approval: rows.map(({ r }) => r.approvalStatus).join("/") };
      const reason =
        paid ? "payment already saved for this month" :
        rows.some(({ r }) => Number(r.gstAmount || 0) > 0 || Number(r.withGst) === 2) ? "bill has GST" :
        rows.some(({ r }) => Number(r.baseAmount) !== Number(r.netPayable)) ? "baseAmount differs from netPayable" : null;
      if (reason) { manual.push({ ...info, reason }); continue; }


      // split the new rent over the rows in the stored proportion; last row takes the rounding remainder
      let left = rentNow;
      rows.forEach(({ r, i }, n) => {
        const next = n === rows.length - 1 ? left : Math.round((Number(r.netPayable) * rentNow) / stored);
        left -= next;
        plan.push({ ...info, rowIndex: i, rowId: r._id, face: String(r.mediaDetailId || "site"), old: Number(r.netPayable), next });
      });
    }
  }


  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — rows to fix: ${plan.length}, manual check: ${manual.length}`);
  plan.forEach((p) => console.log(`  ${p.code} | ${p.label} | appraisal ${p.appraisal} | approval ${p.approval} | row ${p.rowId} face ${p.face}: ${p.old} -> ${p.next}  (site ${p.stored} -> ${p.rentNow})`));
  manual.forEach((p) => console.log(`  MANUAL: ${p.code} | ${p.label} | site ${p.stored} -> ${p.rentNow} | appraisal ${p.appraisal} | ${p.reason}`));
  if (!APPLY || plan.length === 0) process.exit(0);


  let ok = 0, skipped = 0; const applied = [];
  for (const p of plan) {
    const r = await col.updateOne(
      { _id: p.mediaId, rentalDue: { $elemMatch: { _id: p.rowId, netPayable: p.old, baseAmount: p.old } } }, // only if unchanged
      { $set: { "rentalDue.$.netPayable": p.next, "rentalDue.$.baseAmount": p.next } },
    );
    if (r.modifiedCount === 1) { ok++; applied.push({ mediaId: p.mediaId, rowId: p.rowId, label: p.label, old: p.old, new: p.next }); } else skipped++;
  }
  await log.insertOne({ _id: FIX_ID, appliedAt: new Date(), count: ok, rows: applied });
  console.log(`updated ${ok}, skipped ${skipped}. Logged in data_fixes/${FIX_ID} — a second --apply will not run.`);
  process.exit(0);
})().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
