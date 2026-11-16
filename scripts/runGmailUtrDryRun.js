// LOCAL-ONLY: run ONE Gmail UTR dry run right now — the same function the cron calls — without waiting 10 minutes.
//
//   node scripts/runGmailUtrDryRun.js
//   node scripts/runGmailUtrDryRun.js --bill=ADNOOHBILL0611202601 --bill=ADNOOHBILL0611202602
//   node scripts/runGmailUtrDryRun.js --max=5 --force --current-month-only
//
// It is ALWAYS a dry run: it reads MongoDB + Gmail and prints what WOULD be saved. There is no flag to save, it
// ignores GMAIL_UTR_SAVE_ENABLED, writes nothing to MongoDB, and is not an HTTP endpoint (it only runs when you
// start it in a terminal on this machine). The run is also appended to logs/gmail-utr-runs.jsonl.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const arg = (name) => process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const flag = (name) => process.argv.includes(`--${name}`);

const describeDb = (uri) => {
  const u = String(uri || "");
  const host = (u.match(/@([^\/?]+)/) || u.match(/\/\/([^\/?]+)/) || [])[1] || "?";
  const db = (u.match(/\/([A-Za-z0-9_\-]+)(\?|$)/) || [])[1] || "?";
  return `${host} / db=${db}`; // credentials never printed
};

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  console.log(`[dry-run] database: ${describeDb(process.env.MONGODB_URI)}`);
  await mongoose.connect(process.env.MONGODB_URI);

  const { processPendingUtrs } = require("../utils/utrProcessor");
  const bills = arg("bill");
  const result = await processPendingUtrs({
    dryRun: true, // hard-coded: this script can never save
    triggeredBy: "manual-script",
    billNumbers: bills.length ? bills : undefined,
    maxBills: arg("max")[0] ? Number(arg("max")[0]) : undefined,
    force: flag("force"),
    currentMonthOnly: flag("current-month-only"),
  });

  console.log("\n[dry-run] result:");
  console.log(JSON.stringify({ runId: result.runId, dryRun: result.dryRun, skipped: result.skipped || false, startedAt: result.startedAt, finishedAt: result.finishedAt, scope: result.scope, pendingTotal: result.pendingTotal, processed: result.processed, counts: result.counts, aborted: result.aborted }, null, 2));
  console.log("\n[dry-run] matched bills (nothing was saved):");
  (result.results || []).filter((r) => r.utr).forEach((r) =>
    console.log(`  ${r.billNumber}  ${r.paymentType || ""}  utr=${r.utr}  paidDate=${r.paidDate} (${r.paidDateSource})  eligible=${r.eligibleForSaving}  blockedBy=${JSON.stringify(r.savingBlockedBy)}`));
  console.log("\n[dry-run] skipped bills:");
  (result.results || []).filter((r) => !r.utr).forEach((r) => console.log(`  ${r.billNumber}  ${r.status}${r.reason ? "  (" + r.reason + ")" : ""}`));
  console.log("\n[dry-run] full detail: logs/gmail-utr-runs.jsonl");
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("[dry-run] failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
