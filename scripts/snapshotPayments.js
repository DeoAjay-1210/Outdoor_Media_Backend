// READ-ONLY proof that a dry run changed no payment data.
//
//   node scripts/snapshotPayments.js save before.json     (take a snapshot BEFORE the dry run)
//   ... run the cron / dry run ...
//   node scripts/snapshotPayments.js save after.json
//   node scripts/snapshotPayments.js compare before.json after.json
//
// For every site it stores a hash of: rentalDue, ledger, withGst1Ledger, ledgerHistory, gstBalanceHistory,
// tdsBalanceHistory, arrearsDue — plus counts of the OverDueHistory / gmail_utr_logs / counters collections.
// Only find() / countDocuments() are used: this script never writes to MongoDB.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const FIELDS = ["rentalDue", "ledger", "withGst1Ledger", "ledgerHistory", "gstBalanceHistory", "tdsBalanceHistory", "arrearsDue"];
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);

async function takeSnapshot() {
  const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const docs = await Media.find({}).select(FIELDS.join(" ") + " mediaName").lean();
  const sites = {};
  for (const d of docs) {
    const entry = { name: d.mediaName || "" };
    FIELDS.forEach((f) => { entry[f] = { n: Array.isArray(d[f]) ? d[f].length : 0, h: hash(d[f]) }; });
    sites[String(d._id)] = entry;
  }
  const db = mongoose.connection.db;
  const count = (c) => db.collection(c).countDocuments({}).catch(() => null);
  const lock = await db.collection("counters").findOne({ _id: "gmail_utr_lock" });
  return {
    takenAt: new Date().toISOString(),
    sitesCount: docs.length,
    overdueHistoryDocs: await count("overduehistories"),
    gmailUtrLogs: await count("gmail_utr_logs"),
    countersDocs: await count("counters"),
    gmailLockRowExists: !!lock,
    sites,
  };
}

function compare(a, b) {
  const changes = [];
  const ids = new Set([...Object.keys(a.sites), ...Object.keys(b.sites)]);
  for (const id of ids) {
    const x = a.sites[id];
    const y = b.sites[id];
    if (!x || !y) { changes.push(`site ${id}: ${x ? "removed" : "added"}`); continue; }
    FIELDS.forEach((f) => { if (x[f].h !== y[f].h) changes.push(`site ${id} (${y.name}) ${f}: ${x[f].n} -> ${y[f].n} entries, content changed`); });
  }
  ["sitesCount", "overdueHistoryDocs", "gmailUtrLogs", "countersDocs", "gmailLockRowExists"].forEach((k) => { if (a[k] !== b[k]) changes.push(`${k}: ${a[k]} -> ${b[k]}`); });
  return changes;
}

(async () => {
  const [cmd, f1, f2] = process.argv.slice(2);
  if (cmd === "compare") {
    const changes = compare(JSON.parse(fs.readFileSync(f1, "utf8")), JSON.parse(fs.readFileSync(f2, "utf8")));
    if (!changes.length) console.log("NO CHANGES: payment data, overdue history, logs and counters are identical between the two snapshots.");
    else { console.log(`${changes.length} difference(s):`); changes.forEach((c) => console.log("  - " + c)); process.exitCode = 2; }
    return;
  }
  if (cmd !== "save" || !f1) { console.log("usage: node scripts/snapshotPayments.js save <file> | compare <before> <after>"); process.exitCode = 1; return; }
  await mongoose.connect(process.env.MONGODB_URI);
  const snap = await takeSnapshot();
  fs.writeFileSync(f1, JSON.stringify(snap));
  console.log(`snapshot saved: ${f1}  (${snap.sitesCount} sites, gmail_utr_logs=${snap.gmailUtrLogs}, gmail lock row exists=${snap.gmailLockRowExists})`);
  await mongoose.disconnect();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });

module.exports = { compare };
