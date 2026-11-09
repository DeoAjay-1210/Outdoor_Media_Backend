#!/usr/bin/env node
// ✅ NEW — gives adinn_ooh_bills (utils/adinnOohBills.js) to every APPROVED bill
// (media.rentalDue[], approvalStatus 3) that has none, from the first system
// bill to the current month. The existing billNo is never touched.
//
// Order: bill date (calendar day) → earliest createdAt of the bill's rows →
// mediaId → bill key → landlord order. First bill = serial 01.
//
// First --apply (counter "adinn_ooh_bills_global" not created yet): historical
// bills get serials max(registry)+1, +2, … and the counter is then set to the
// last serial, so new approvals continue from there (no reset, no reuse).
// Rerun (counter exists): numbered bills are kept as they are; any bill still
// without a number gets the next serials from the counter. Safe to rerun after
// an interruption.
//
// Usage:
//   node scripts/backfillAdinnOohBills.js            → dry run (prints a report, writes nothing)
//   node scripts/backfillAdinnOohBills.js --apply    → saves the numbers (take a DB backup first)
//   add --list to print every planned bill in the dry run
require("dotenv").config();
const mongoose = require("mongoose");
const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const Registry = require("../models/Admin/AdinnOohBillRegistrySchema");
const Counter = require("../models/Admin/CounterSchema");
const {
  ADINN_COUNTER_ID,
  planMediaBills,
  compareBases,
  formatAdinnOohBillNo,
  toValidDate,
  createAdinnOohBills,
} = require("../utils/adinnOohBills");

const APPLY = process.argv.includes("--apply");
const LIST = process.argv.includes("--list");
const day = (d) => (toValidDate(d) ? toValidDate(d).toISOString().slice(0, 10) : "—");

async function loadPlan() {
  const docs = await Media.find({ "rentalDue.0": { $exists: true } })
    .select(
      "mediaDetails._id mediaDetails.mediaCode mediaDetails.siteBillMode landOwners._id landOwners.name landOwners.landOwnerMasterId landOwners.landOwnerBillMode rentalDue._id rentalDue.dueMonth rentalDue.dueDate rentalDue.createdAt rentalDue.approvalStatus rentalDue.mediaDetailId rentalDue.billNo rentalDue.adinn_ooh_bills",
    )
    .lean();
  const codeOf = new Map();
  const rowCount = { total: 0, approved: 0, byStatus: {} };
  const bases = [];
  docs.forEach((m) => {
    (m.rentalDue || []).forEach((r) => {
      rowCount.total++;
      rowCount.byStatus[r.approvalStatus] = (rowCount.byStatus[r.approvalStatus] || 0) + 1;
      if (Number(r.approvalStatus) === 3) rowCount.approved++;
    });
    codeOf.set(String(m._id), (m.mediaDetails || []).map((d) => d.mediaCode).join(" / "));
    planMediaBills(m).forEach((b) => bases.push(b));
  });
  bases.sort(compareBases);
  return { docs, bases, codeOf, rowCount };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const { bases, codeOf, rowCount } = await loadPlan();

  const registered = new Set((await Registry.find({}, { groupKey: 1 }).lean()).map((r) => r.groupKey));
  const maxReg = await Registry.findOne({}, { serial: 1 }).sort({ serial: -1 }).lean();
  const counter = await Counter.findById(ADINN_COUNTER_ID).lean();

  const billCount = bases.reduce((n, b) => n + b.bills.length, 0);
  const todo = bases.filter((b) => b.needRowIds.length || b.bills.some((x) => !registered.has(x.groupKey)));
  const invalidDate = todo.filter((b) => !toValidDate(b.billDate));
  const conflicts = todo.filter((b) => b.billDateConflict);
  const fromIdTime = todo.filter((b) => b.entryTimeFromId);
  const alreadyOnRow = bases.filter((b) => b.existingNo);

  console.log(`adinn_ooh_bills backfill${APPLY ? "" : " — DRY RUN (add --apply to save)"}`);
  console.log(`  bill rows: ${rowCount.total} (approvalStatus ${JSON.stringify(rowCount.byStatus)}), approved rows: ${rowCount.approved}`);
  console.log(`  approved bills (one number each): ${billCount} in ${bases.length} bill group(s)`);
  console.log(`  already registered: ${registered.size}, bills with a number already on a row: ${alreadyOnRow.length}`);
  console.log(`  bills to number now: ${todo.reduce((n, b) => n + b.bills.filter((x) => !registered.has(x.groupKey)).length, 0)}`);
  console.log(`  counter ${ADINN_COUNTER_ID}: ${counter ? counter.seq : "not created yet (first run)"}, highest registered serial: ${maxReg ? maxReg.serial : 0}`);
  if (todo.length) console.log(`  first: ${day(todo[0].billDate)}  last: ${day(todo[todo.length - 1].billDate)}`);
  console.log(`  ⚠ invalid / missing bill date (skipped): ${invalidDate.length}`);
  invalidDate.forEach((b) => console.log(`     ${codeOf.get(b.mediaId)} | ${b.dueMonth} | ${b.baseKey}`));
  console.log(`  ⚠ single bill with different face bill dates (earliest date used): ${conflicts.length}`);
  conflicts.forEach((b) => console.log(`     ${codeOf.get(b.mediaId)} | ${b.dueMonth} | dates ${b.dates.join(", ")}`));
  console.log(`  ⚠ entry time taken from the record id (no createdAt): ${fromIdTime.length}`);

  // planned serials
  let next = counter ? counter.seq + 1 : (maxReg ? maxReg.serial : 0) + 1;
  const plan = [];
  todo.forEach((b) => {
    if (!toValidDate(b.billDate)) return;
    b.bills.forEach((bill) => {
      if (registered.has(bill.groupKey)) return;
      const keep = bill.ownerIndex === 0 && b.existingNo;
      plan.push({ b, bill, serial: keep ? null : next, no: keep ? b.existingNo : formatAdinnOohBillNo(b.billDate, next) });
      if (!keep) next++;
    });
  });
  if (plan.length) console.log(`  serials planned: ${plan[0].no} … ${plan[plan.length - 1].no}; next new bill after this: serial ${next}`);
  if (LIST || APPLY) {
    plan.forEach(({ b, bill, no }) =>
      console.log(
        `  ${codeOf.get(b.mediaId)} | ${b.dueMonth} | bill date ${day(b.billDate)} | entered ${b.entryTime ? new Date(b.entryTime).toISOString() : "—"} | ${b.billMode}${bill.owner ? ` | ${bill.owner.landOwnerName}` : ""} → ${no}`,
      ),
    );
  }

  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  // ── apply ──
  await Registry.createIndexes(); // unique: adinn_ooh_bills, serial, groupKey
  const api = createAdinnOohBills({ Media, Registry, Counter });
  const serialOf = new Map(plan.filter((p) => p.serial !== null).map((p) => [p.bill.groupKey, p.serial]));
  const firstRun = !counter;
  let done = 0;
  for (const b of todo) {
    // first run: the planned historical serial; rerun: next serial from the counter
    const numbers = await api.assignBase(b, null, {
      source: "backfill",
      serialFor: firstRun ? (bill) => serialOf.get(bill.groupKey) ?? null : null,
    });
    if (numbers) done++;
  }
  if (firstRun) {
    const top = await Registry.findOne({}, { serial: 1 }).sort({ serial: -1 }).lean();
    await Counter.updateOne({ _id: ADINN_COUNTER_ID }, { $max: { seq: top ? top.serial : 0 } }, { upsert: true });
  }

  // bills approved while this ran (counter now exists → normal next serials)
  const again = (await loadPlan()).bases.filter((b) => b.needRowIds.length);
  for (const b of again) await api.assignBase(b, null, { source: "backfill" });

  const left = (await loadPlan()).bases.filter((b) => b.needRowIds.length).length;
  const c = await Counter.findById(ADINN_COUNTER_ID).lean();
  console.log(`saved: ${done} bill group(s); approved bills still without a number: ${left}; counter now ${c ? c.seq : "—"}`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
