// Fix ledger remarks whose bank narration was cut at a date ("... Rent For"). Reads the full narration from
// the Finance "Payment Uploaded" mail in Gmail (read-only) by the entry's Bank Reference. Dry run by default.
//   node scripts/fixTruncatedNarrations.js           → dry run (no DB writes)
//   node scripts/fixTruncatedNarrations.js --apply   → write the full narration
// Safe to re-run: an entry is changed only when the mail narration STARTS WITH its current (cut) remark and differs.
require("dotenv").config();
const mongoose = require("mongoose");
const { searchThreads, getThread } = require("../utils/gmailService");
const { collectBankRows } = require("../utils/bankNarration"); // must already have the ROW_HEAD fix


const APPLY = process.argv.includes("--apply");
const DANGLING = /\b(for|from|to|period|dated|on|of|between|till|upto)\s*$/i; // remark ends where a date was cut off


(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection("mediaonboardings");


  const cands = [];
  for await (const m of col.find({}, { projection: { ledger: 1, withGst1Ledger: 1, ledgerHistory: 1, arrearsDue: 1, "mediaDetails.mediaCode": 1 } })) {
    const code = (m.mediaDetails || []).map((f) => f.mediaCode).filter(Boolean).join(", ");
    const check = (path, e) => {
      const v = typeof e?.remark === "string" ? e.remark.trim() : "";
      if (e && e.bankRefNo && v && DANGLING.test(v))
        cands.push({ mediaId: m._id, code, path: `${path}.remark`, old: e.remark, ref: e.bankRefNo, who: e.landOwnerName || "", utr: e.utrNumber || "" });
    };
    (m.ledger || []).forEach((e, i) => check(`ledger.${i}`, e));
    (m.withGst1Ledger || []).forEach((e, i) => check(`withGst1Ledger.${i}`, e));
    (m.ledgerHistory || []).forEach((y, yi) => (y.months || []).forEach((mo, mi) => (mo.entries || []).forEach((e, ei) =>
      check(`ledgerHistory.${yi}.months.${mi}.entries.${ei}`, e))));
    (m.arrearsDue || []).forEach((b, bi) => (b.payments || []).forEach((p, pi) => check(`arrearsDue.${bi}.payments.${pi}`, p)));
  }


  const full = {};
  for (const ref of [...new Set(cands.map((c) => c.ref))]) {
    try {
      for (const t of await searchThreads(`"${ref}"`, 5)) {
        const th = await getThread(t.id);
        const msgs = (th.messages || []).map((x) => ({ id: x.id, bodyText: x.bodyText || x.text || "" }));
        const row = collectBankRows(msgs).rows.find((r) => r.reference === ref);
        if (row && row.narration) { full[ref] = row.narration; break; }
      }
    } catch (err) { console.log(`  Gmail read failed for ${ref}: ${err.message}`); }
  }


  const plan = cands
    .filter((c) => full[c.ref] && full[c.ref] !== c.old.trim() && full[c.ref].startsWith(c.old.trim()))
    .map((c) => ({ ...c, next: full[c.ref] }));
  const notFound = cands.filter((c) => !full[c.ref]);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — cut remarks: ${cands.length}, fixable from Gmail: ${plan.length}, narration not found in Gmail: ${notFound.length}`);
  plan.forEach((p) => console.log(`  ${p.code} | ${p.who} | ${p.ref} | ${p.path}\n     "${p.old}" -> "${p.next}"`));
  notFound.forEach((c) => console.log(`  NOT FOUND: ${c.code} | ${c.who} | ${c.ref} | "${c.old}"`));
  if (!APPLY || plan.length === 0) process.exit(0);


  let ok = 0, skipped = 0;
  for (const p of plan) {
    const r = await col.updateOne({ _id: p.mediaId, [p.path]: p.old }, { $set: { [p.path]: p.next } }); // only if unchanged
    r.modifiedCount === 1 ? ok++ : skipped++;
  }
  console.log(`updated ${ok}, skipped ${skipped}`);
  process.exit(0);
})().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
