// GST ON HOLD + SEVERAL landlords: finance writes one line per payment, naming the landlord AND the payment:
//   Landlord1 - Rent - UTR : ...   Landlord2 - Rent - UTR : ...   Landlord1 - GST - UTR : ...   Landlord2 - GST - UTR : ...
// No network, no database: Gmail, Media, Registry, Log, Counter and the ledger saver are in-memory fakes.
// Run: node --test test/gmailMultiLandlordGst.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-mlg-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const { extractLandlordUtrLines, splitNameKind, mapLandlordKinds } = require("../utils/landlordUtrParser");
const { getPendingUtrBills } = require("../utils/pendingUtrBills");
const { createUtrProcessor } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const BILL = "ADNOOHBILL09102026105";
const U = { r1: "UTR438432443", r2: "UTR843243484", g1: "UTR849384238", g2: "UTR4893247324" };
const FOUR = [
  `Landlord1 - Rent - UTR : ${U.r1},`,
  `Landlord2 - Rent - UTR : ${U.r2},`,
  `Landlord1 - GST  - UTR : ${U.g1},`,
  `Landlord2 - GST - UTR : ${U.g2}`,
].join("\n");

const noHelpers = { isOwnerModePaidForCycle: () => false };
const landlord = (id, name, acc, over = {}) => ({ _id: id, landOwnerMasterId: "m" + id, name, paymentCategory: 2, bankName: "SBI", accountNumber: acc, ...over });
const dueRow = (id, month, date, bill, over = {}) => ({ _id: id, dueMonth: month, dueDate: new Date(date), approvalStatus: 3, mailSent: true, adinn_ooh_bills: bill, withGst: 1, gstAmount: 14400, ...over });
const gstRow = (id, rd, owner, name, over = {}) => ({ _id: id, rentalDueId: rd, dueMonth: "October 2026", ownerId: owner, ownerName: name, isPaid: false, utrNumber: "", gstAmount: 7200, ...over });
const makeSite = (over = {}) => ({
  _id: "s1", mediaName: "Site 1",
  mediaDetails: [{ _id: "f1", status: 1, mediaCode: "C1", siteBillMode: 1 }],
  landOwners: [landlord("o1", "Landlord1", "111111111111"), landlord("o2", "Landlord2", "222222222222")],
  rentalDue: [dueRow("r1", "October 2026", "2026-10-09T00:00:00Z", BILL)],
  gstBalanceHistory: [gstRow("g1", "r1", "o1", "Landlord1"), gstRow("g2", "r1", "o2", "Landlord2")],
  ledger: [], ledgerHistory: [], withGst1Ledger: [],
  ...over,
});
const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "dueDate" && typeof x === "string" ? new Date(x) : x));
const reply = (id, text, at = "2026-11-09T10:30:00.000Z") => ({ messageId: id, from: "Finance <f@x.com>", sentAt: at, sentDate: at.slice(0, 10), lines: extractLandlordUtrLines(text) });

// ───────────────────────── parser ─────────────────────────
test("MG-P1. name + payment label is split from the end of the name", () => {
  assert.deepEqual(splitNameKind("Landlord1 - Rent"), { landlord: "Landlord1", kind: "rent" });
  assert.deepEqual(splitNameKind("Landlord2 GST"), { landlord: "Landlord2", kind: "gst" });
  assert.deepEqual(splitNameKind("K. Jamuna - Base Rent"), { landlord: "K. Jamuna", kind: "rent" });
  assert.deepEqual(splitNameKind("Landlord1"), { landlord: "Landlord1", kind: null });
  assert.deepEqual(splitNameKind("Rent"), { landlord: "Rent", kind: null });
});

test("MG-P2. the four finance lines (trailing commas, double spaces) are read as landlord + payment + UTR", () => {
  const lines = extractLandlordUtrLines(FOUR);
  assert.deepEqual(lines.map((l) => l.utr), [U.r1, U.r2, U.g1, U.g2]);
  const L = [{ landOwnerId: "o1", name: "Landlord1" }, { landOwnerId: "o2", name: "Landlord2" }];
  const m = mapLandlordKinds([{ messageId: "m1", sentDate: "2026-11-09", lines }], L);
  assert.deepEqual(m.problems, []);
  assert.equal(m.byKey.get("o1|rent")[0].utr, U.r1);
  assert.equal(m.byKey.get("o2|rent")[0].utr, U.r2);
  assert.equal(m.byKey.get("o1|gst")[0].utr, U.g1);
  assert.equal(m.byKey.get("o2|gst")[0].utr, U.g2);
});

test("MG-P3. unknown / ambiguous / initial-only landlord names are problems; an unlabelled line is ignored", () => {
  const L = [{ landOwnerId: "o1", name: "Ravi Kumar" }, { landOwnerId: "o2", name: "Ravi Shankar" }];
  const run = (t) => mapLandlordKinds([{ messageId: "m", lines: extractLandlordUtrLines(t) }], L);
  assert.equal(run("Ravi - Rent - UTR : UTR438432443").problems[0].reason, "landlord_name_ambiguous");
  assert.equal(run("Zed - Rent - UTR : UTR438432443").problems[0].reason, "landlord_name_not_found");
  assert.equal(run("R - GST - UTR : UTR438432443").problems[0].reason, "landlord_name_too_short");
  const u = run("Ravi Kumar - UTR : UTR438432443");
  assert.equal(u.problems.length, 0);
  assert.equal(u.ignored.length, 0); // a NAMED line without the GST word is the Rent UTR
});

// ───────────────────────── pending list ─────────────────────────
const pending = (docs) => getPendingUtrBills({}, { Media: { find: () => ({ select: () => ({ lean: async () => docs.map(clone) }) }) }, Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, helpers: noHelpers, now: NOW });

test("MG-B1. the bill stays mappingSafe:false but exposes one rent and one GST slot per landlord", async () => {
  const r = await pending([makeSite()]);
  const b = r.bills[0];
  assert.equal(b.mappingSafe, false);
  assert.equal(b.landlordGstMapping.eligible, true);
  assert.deepEqual(b.landlordGstMapping.slots.map((s) => `${s.landOwnerName}:${s.kind}`), ["Landlord1:rent", "Landlord2:rent", "Landlord1:gst", "Landlord2:gst"]);
  assert.equal(b.landlordGstMapping.slots.find((s) => s.kind === "gst" && s.landOwnerId === "o2").gstAmount, 7200);
  assert.equal(b.perLandlordMapping.eligible, false); // the plain multi-landlord flow never takes a GST-hold bill
  assert.equal(b.dueMonth, "October 2026");
});

test("MG-B2. a site-level (landlord-less) GST row, or two GST rows for one landlord, is not eligible", async () => {
  const noOwner = makeSite({ gstBalanceHistory: [gstRow("g1", "r1", null, "", { gstAmount: 14400 })] });
  assert.equal((await pending([noOwner])).bills[0].landlordGstMapping.eligible, false);
  const two = makeSite({ gstBalanceHistory: [gstRow("g1", "r1", "o1", "Landlord1"), gstRow("g1b", "r1", "o1", "Landlord1"), gstRow("g2", "r1", "o2", "Landlord2")] });
  assert.equal((await pending([two])).bills[0].landlordGstMapping.eligible, false);
});

test("MG-B3. a Cash+Online landlord (two open rent payments) is a payment pair: eligible", async () => {
  const s = makeSite({ landOwners: [landlord("o1", "Landlord1", "111111111111", { paymentCategory: 3 }), landlord("o2", "Landlord2", "222222222222")] });
  assert.equal((await pending([s])).bills[0].landlordGstMapping.eligible, true);
});

// ───────────────────────── processor ─────────────────────────
const fakeCounter = () => {
  const docs = new Map();
  return {
    findOneAndUpdate: (q, upd) => ({ lean: async () => { const d = docs.get(q._id); if (d && d.seq < q.seq.$lt) { d.seq = upd.$set.seq; return { ...d }; } return null; } }),
    create: async (doc) => { if (docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 }); docs.set(doc._id, { ...doc }); },
    updateOne: async (q, upd) => { if (docs.has(q._id)) docs.get(q._id).seq = upd.$set.seq; },
  };
};
const setup = ({ docs = [makeSite()], replies, saveEnabled = true, multi = true, gst = true, cash = false, saver, lookupLandlords } = {}) => {
  const db = new Map(docs.map((d) => [d._id, clone(d)]));
  const calls = { lookup: 0, saver: [] };
  const logRows = [];
  const Log = {
    create: async (d) => { logRows.push({ createdAt: new Date(), ...d }); },
    findOne: (q) => ({ sort: () => ({ lean: async () => logRows.filter((r) => r.billNumber === q.billNumber && r.dryRun === q.dryRun)[0] || null }) }),
    find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }),
  };
  const Registry = {
    findOne: (q) => ({
      lean: async () => {
        for (const m of db.values()) {
          const rows = m.rentalDue.filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills);
          if (rows.length) return { mediaId: m._id, dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) };
        }
        return null;
      },
    }),
  };
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(db.get(id)) }) },
    Registry, Log, Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => saveEnabled, cashSaveEnabled: () => cash, multiLandlordSaveEnabled: () => multi, gstSaveEnabled: () => gst,
    now: () => NOW,
    logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [...db.values()].map(clone) }) }) }, Log: { find: Log.find }, helpers: noHelpers, now: NOW },
    lookupLandlords: async (b) => {
      calls.lookup += 1;
      if (lookupLandlords) return lookupLandlords(b);
      return { data: { billNumber: b, extractionStatus: "found", threadId: "T1", approvalMailLandlords: [], replies: typeof replies === "function" ? replies() : replies } };
    },
    saver: async (batch) => {
      calls.saver.push(batch);
      if (saver) return saver(batch, db);
      const pay = batch.payments[0];
      const m = db.get(pay.mediaId);
      if (batch.entryType === "gst") {
        const g = m.gstBalanceHistory.find((x) => x.rentalDueId === pay.rentalDueId && String(x.ownerId) === String(pay.landOwnerId));
        g.isPaid = true; g.utrNumber = pay.utrNumber;
        return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: g.gstAmount }] } };
      }
      m.ledger.push({ rentalDueId: pay.rentalDueId, landOwnerId: pay.landOwnerId, paymentMode: pay.paymentMode, utrNumber: pay.utrNumber, status: 1, isUtrEntry: false });
      return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 40000 }] } };
    },
  });
  return { p, db, calls, logRows };
};
const one = (r) => r.results[0];
const simple = (b) => b.payments[0];

test("MG1. the four lines: each landlord's Rent and GST UTR is saved to that landlord only (rents first, then GST)", async () => {
  const x = setup({ replies: [reply("m1", FOUR)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "found_and_saved");
  assert.equal(one(r).dueMonth, "October 2026");
  assert.deepEqual(x.calls.saver.map((b) => [b.entryType, simple(b).landOwnerId, simple(b).utrNumber, simple(b).rentalDueId, simple(b).targetType]), [
    ["rental", "o1", U.r1, "r1", "pastCycle"],
    ["rental", "o2", U.r2, "r1", "pastCycle"],
    ["gst", "o1", U.g1, "r1", "pastCycle"],
    ["gst", "o2", U.g2, "r1", "pastCycle"],
  ]);
  assert.ok(x.calls.saver.every((b) => b.siteBillMode === 1 && simple(b).paymentMode === "Online" && b.date === "2026-11-09"));
  const m = x.db.get("s1");
  assert.deepEqual(m.gstBalanceHistory.map((g) => [g.ownerId, g.utrNumber]), [["o1", U.g1], ["o2", U.g2]]);
  assert.equal(one(r).paymentType, "multi_landlord_rent_gst");
  assert.equal(one(r).splitPayments.length, 4);
});

test("MG2. line order and the landlord order of the bill never decide: the name and the label do", async () => {
  const swapped = [`Landlord2 - GST - UTR : ${U.g2}`, `Landlord1 - GST - UTR : ${U.g1}`, `Landlord2 - Rent - UTR : ${U.r2}`, `Landlord1 - Rent - UTR : ${U.r1}`].join("\n");
  const x = setup({ replies: [reply("m1", swapped)] });
  await x.p.processPendingUtrs({ dryRun: false });
  const pairs = x.calls.saver.map((b) => `${b.entryType}:${simple(b).landOwnerId}:${simple(b).utrNumber}`).sort();
  assert.deepEqual(pairs, [`gst:o1:${U.g1}`, `gst:o2:${U.g2}`, `rental:o1:${U.r1}`, `rental:o2:${U.r2}`].sort());
});

test("MG3. rent lines first, GST lines in a later reply: each payment is saved when ITS line appears", async () => {
  const first = `Landlord1 - Rent - UTR : ${U.r1}\nLandlord2 - Rent - UTR : ${U.r2}`;
  const later = `Landlord1 - GST - UTR : ${U.g1}\nLandlord2 - GST - UTR : ${U.g2}`;
  let replies = [reply("m1", first)];
  const x = setup({ replies: () => replies });
  const a = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(a).status, "found_and_saved");
  assert.deepEqual(x.calls.saver.map((b) => b.entryType), ["rental", "rental"]);
  assert.equal(one(a).pendingPayments.length, 2); // both GST payments still waiting

  replies = [reply("m1", first), reply("m2", later, "2026-11-10T04:00:00.000Z")];
  const b = await x.p.processPendingUtrs({ dryRun: false, force: true });
  assert.equal(one(b).status, "found_and_saved");
  assert.deepEqual(x.calls.saver.map((c) => c.entryType), ["rental", "rental", "gst", "gst"]); // rents were not saved twice
});

test("MG4. only Landlord2's GST line exists: that payment alone is saved, the others wait", async () => {
  const x = setup({ replies: [reply("m1", `Landlord2 - GST - UTR : ${U.g2}`)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "found_and_saved");
  assert.equal(x.calls.saver.length, 1);
  assert.equal(simple(x.calls.saver[0]).landOwnerId, "o2");
  assert.equal(x.calls.saver[0].entryType, "gst");
});

test("MG5. a line with an unknown landlord name never blocks the lines that carry the right names; a wrong name ALONE saves nothing and is reported; the right name later saves", async () => {
  // every payment has its own correct line + one stranger line: the stranger is ignored, nothing else is affected
  const x = setup({ replies: [reply("m1", `${FOUR}
Landlord9 - Rent - UTR : UTR999999999999`)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "found_and_saved");
  assert.ok(x.calls.saver.every((b) => b.payments.every((p) => p.utrNumber !== "UTR999999999999")));
  // only a wrong name: nothing is saved, reported as landlord_name_not_found
  const y = setup({ replies: [reply("m1", `Landlord9 - Rent - UTR : UTR999999999999`)] });
  const ry = await y.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(ry).status, "ambiguous_mapping");
  assert.equal(one(ry).reason, "landlord_name_not_found");
  assert.equal(y.calls.saver.length, 0);
});

test("MG6. a NAMED line without the GST word is the RENT UTR; a line with no name at all is never used (it could be anyone / either)", async () => {
  const y = setup({ replies: [reply("m1", `UTR : ${U.r1}`)] });
  const ry = await y.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(ry).status, "utr_not_found");
  assert.equal(y.calls.saver.length, 0);
  const x = setup({ replies: [reply("m1", `Landlord1 - UTR : ${U.r1}`)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "found_and_saved");
  assert.ok(x.calls.saver.every((b) => b.payments.every((p) => p.utrNumber !== undefined)));
});

test("MG7. the same UTR on two payments blocks the whole bill", async () => {
  const x = setup({ replies: [reply("m1", `Landlord1 - Rent - UTR : ${U.r1}\nLandlord2 - Rent - UTR : ${U.r1}`)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).reason, "duplicate_utr");
  assert.equal(x.calls.saver.length, 0);
});

test("MG8. two different UTRs for ONE payment block that payment only; the other payments are saved", async () => {
  const text = `${FOUR}\nLandlord1 - GST - UTR : UTR111111111111`;
  const x = setup({ replies: [reply("m1", text)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "found_and_saved");
  assert.equal(x.calls.saver.length, 3);
  assert.equal(x.calls.saver.some((b) => b.entryType === "gst" && simple(b).landOwnerId === "o1"), false);
  assert.equal(one(r).blockedPayments[0].reason, "conflicting_utr_for_landlord_payment");
});

test("MG9. a UTR already stored on the site blocks that payment (existing duplicate-UTR rule)", async () => {
  const d = makeSite({ ledgerHistory: [{ year: "2026", months: [{ month: "September", entries: [{ rentalDueId: "old", landOwnerId: "o1", utrNumber: U.r1 }] }] }] });
  const x = setup({ docs: [d], replies: [reply("m1", FOUR)] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(x.calls.saver.length, 3);
  assert.equal(one(r).blockedPayments[0].reason, "utr_already_used_on_this_site");
});

test("MG10. switches: the multi-landlord and the GST switch are both required, checked BEFORE Gmail", async () => {
  const noMulti = setup({ replies: [reply("m1", FOUR)], multi: false });
  const a = await noMulti.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(a).reason, "multi_landlord_auto_save_disabled");
  assert.equal(noMulti.calls.lookup, 0);
  const noGst = setup({ replies: [reply("m1", FOUR)], gst: false });
  const b = await noGst.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(b).reason, "gst_split_auto_save_disabled");
  assert.equal(noGst.calls.lookup, 0);
  assert.equal(noGst.calls.saver.length + noMulti.calls.saver.length, 0);
});

test("MG11. dry run shows every landlord / payment / UTR and saves nothing", async () => {
  const x = setup({ replies: [reply("m1", FOUR)], saveEnabled: false, multi: false, gst: false });
  const r = await x.p.processPendingUtrs({});
  assert.equal(r.dryRun, true);
  assert.equal(x.calls.saver.length, 0);
  const row = one(r);
  assert.equal(row.status, "found_and_saved");
  assert.equal(row.eligibleForSaving, true);
  assert.equal(row.splitPayments.length, 4);
  assert.deepEqual(row.splitPayments.map((s) => `${s.landlord}:${s.kind}`), ["Landlord1:rent", "Landlord2:rent", "Landlord1:gst", "Landlord2:gst"]);
  assert.ok(row.savingBlockedBy.length >= 3);
});

test("MG12. a failure in the middle is reported and the retry saves only what is still open", async () => {
  let failOnce = true;
  const x = setup({
    replies: [reply("m1", FOUR)],
    saver: async (batch, db) => {
      const pay = batch.payments[0];
      if (failOnce && batch.entryType === "gst" && pay.landOwnerId === "o1") { failOnce = false; return { statusCode: 500, data: { sitesFailed: 1, savedEntries: [{ status: "failed", error: "boom" }] } }; }
      const m = db.get(pay.mediaId);
      if (batch.entryType === "gst") {
        const g = m.gstBalanceHistory.find((y) => String(y.ownerId) === String(pay.landOwnerId));
        g.isPaid = true; g.utrNumber = pay.utrNumber;
      } else m.ledger.push({ rentalDueId: pay.rentalDueId, landOwnerId: pay.landOwnerId, paymentMode: pay.paymentMode, utrNumber: pay.utrNumber, status: 1, isUtrEntry: false });
      return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 1 }] } };
    },
  });
  const a = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(a).status, "database_error");
  assert.match(one(a).reason, /partial_save 2\/4/);
  const b = await x.p.processPendingUtrs({ dryRun: false, force: true });
  assert.equal(one(b).status, "found_and_saved");
  assert.equal(b.results[0].splitPayments.length, 2); // only the two GST payments were still open
});

test("MG13. registry month check still applies (registry says another month -> nothing saved)", async () => {
  const x = setup({ replies: [reply("m1", FOUR)] });
  const p2 = createUtrProcessor({ ...{}, Media: { findById: () => ({ lean: async () => clone(makeSite()) }) }, Registry: { findOne: () => ({ lean: async () => ({ mediaId: "s1", dueMonth: "July 2026", rentalDueIds: ["r1"] }) }) }, Log: { create: async () => {}, findOne: () => ({ sort: () => ({ lean: async () => null }) }), find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, Counter: fakeCounter(), helpers: noHelpers, saveEnabled: () => true, multiLandlordSaveEnabled: () => true, gstSaveEnabled: () => true, now: () => NOW, logger: { log() {}, error() {} }, pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [clone(makeSite())] }) }) }, Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, helpers: noHelpers, now: NOW }, lookupLandlords: async (b) => ({ data: { billNumber: b, extractionStatus: "found", threadId: "T", approvalMailLandlords: [], replies: [reply("m1", FOUR)] } }), saver: async () => { throw new Error("must not save"); } });
  const r = await p2.processPendingUtrs({ dryRun: false });
  assert.equal(r.results[0].reason, "registry_month_mismatch");
  assert.ok(x);
});

// ───────────────────────── with the In-Reply-To thread matching ─────────────────────────
test("MG14. Aug + Sep approval mails in one thread: the four lines replying to the August mail save the August bill only", async () => {
  const BILL_A = "ADNOOHBILL09082026103";
  const BILL_B = "ADNOOHBILL09092026104";
  const site = makeSite({
    rentalDue: [dueRow("rA", "August 2026", "2026-08-09T00:00:00Z", BILL_A), dueRow("rB", "September 2026", "2026-09-09T00:00:00Z", BILL_B)],
    gstBalanceHistory: [
      gstRow("gA1", "rA", "o1", "Landlord1", { dueMonth: "August 2026" }), gstRow("gA2", "rA", "o2", "Landlord2", { dueMonth: "August 2026" }),
      gstRow("gB1", "rB", "o1", "Landlord1", { dueMonth: "September 2026" }), gstRow("gB2", "rB", "o2", "Landlord2", { dueMonth: "September 2026" }),
    ],
  });
  const body = (bill) => `Rental Payment Approved\nBill No: ${bill}\nOwner Name | Landlord1 | Phone | 9 | Bank Name | SBI | IFSC Code | X | Account No | 111111111111 | PAN Number | P |\nOwner Name | Landlord2 | Phone | 9 | Bank Name | SBI | IFSC Code | X | Account No | 222222222222 | PAN Number | P |`;
  const msg = (id, mid, text, at, parent = "") => ({ id, labelIds: ["INBOX"], from: "x", sentAt: at, date: at, subject: "CMD Payment Approved", messageIdHeader: `<${mid}@d.com>`, inReplyTo: parent ? `<${parent}@d.com>` : "", bodyText: text });
  const thread = [
    msg("mA", "midA", body(BILL_A), "2026-11-10T03:54:47.000Z"),
    msg("mB", "midB", body(BILL_B), "2026-11-10T03:57:55.000Z"),
    msg("mR", "midR", FOUR, "2026-11-10T04:55:27.000Z", "midA"),
  ];
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "s", messages: thread.map((m) => ({ ...m })), ignoredMessages: [] });
  try {
    const x = setup({ docs: [site], lookupLandlords: undefined, replies: undefined });
    // use the real Gmail lookup (not the stub of setup)
    const real = require("../utils/gmailUtrLookup").lookupLandlordUtrs;
    const p = createUtrProcessor({
      Media: { findById: (id) => ({ lean: async () => clone(x.db.get(id)) }) },
      Registry: { findOne: (q) => ({ lean: async () => { const rows = x.db.get("s1").rentalDue.filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills); return rows.length ? { mediaId: "s1", dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) } : null; } }) },
      Log: { create: async () => {}, findOne: () => ({ sort: () => ({ lean: async () => null }) }), find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) },
      Counter: fakeCounter(), helpers: noHelpers, saveEnabled: () => true, cashSaveEnabled: () => false, multiLandlordSaveEnabled: () => true, gstSaveEnabled: () => true,
      now: () => NOW, logger: { log() {}, error() {} },
      pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [clone(x.db.get("s1"))] }) }) }, Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, helpers: noHelpers, now: NOW },
      lookupLandlords: real,
      saver: async (batch) => {
        x.calls.saver.push(batch);
        const pay = batch.payments[0];
        const m = x.db.get("s1");
        if (batch.entryType === "gst") { const g = m.gstBalanceHistory.find((y) => y.rentalDueId === pay.rentalDueId && String(y.ownerId) === String(pay.landOwnerId)); g.isPaid = true; g.utrNumber = pay.utrNumber; }
        else m.ledger.push({ rentalDueId: pay.rentalDueId, landOwnerId: pay.landOwnerId, paymentMode: pay.paymentMode, utrNumber: pay.utrNumber, status: 1, isUtrEntry: false });
        return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 1 }] } };
      },
    });
    const r = await p.processPendingUtrs({ dryRun: false });
    const a = r.results.find((y) => y.billNumber === BILL_A);
    const b = r.results.find((y) => y.billNumber === BILL_B);
    assert.equal(a.status, "found_and_saved");
    assert.equal(a.dueMonth, "August 2026");
    assert.equal(a.replyLink.approvalMessageId, "mA");
    assert.equal(b.status, "utr_not_found"); // the same reply does not belong to September
    assert.equal(x.calls.saver.length, 4);
    assert.ok(x.calls.saver.every((c) => simple(c).rentalDueId === "rA"));
  } finally { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; }
});

const { extractCashLines } = require("../utils/utrExtractor");
const cashLn = (id, text, at = "2026-11-09T10:30:00.000Z") => ({ messageId: id, from: "Finance <f@x.com>", sentAt: at, sentDate: at.slice(0, 10), cashLines: extractCashLines(text) });
test("MG-C1. GST hold, several landlords: Landlord1 Cash + Online (Rent UTR -> Online, Cash takes the mail date), Landlord2 Online; GST UTRs as usual", async () => {
  const s = makeSite({ landOwners: [landlord("o1", "Landlord1", "111111111111", { paymentCategory: 3 }), landlord("o2", "Landlord2", "222222222222")] });
  const x = setup({ docs: [s], cash: true, replies: [reply("m1", FOUR)] });
  assert.equal(one(await x.p.processPendingUtrs({ dryRun: false })).status, "found_and_saved");
  const got = x.calls.saver.map((b) => [b.entryType, simple(b).landOwnerId, simple(b).paymentMode, simple(b).utrNumber, b.date].join("|"));
  assert.equal(got.length, 5);
  assert.ok(got.includes("rental|o1|Cash||2026-11-09"));
  assert.ok(got.includes("rental|o1|Online|" + U.r1 + "|2026-11-09"));
  assert.ok(got.includes("gst|o2|Online|" + U.g2 + "|2026-11-09"));
  const off = setup({ docs: [s], cash: false, replies: [reply("m1", FOUR)] });
  assert.equal(one(await off.p.processPendingUtrs({ dryRun: false })).reason, "cash_auto_save_disabled");
  assert.equal(off.calls.saver.length, 0);
});
test("MG-C2. GST hold, several landlords: a Cash-ONLY landlord needs a Cash line (his UTR line is never used)", async () => {
  const s = makeSite({ landOwners: [landlord("o1", "Landlord1", "111111111111", { paymentCategory: 1 }), landlord("o2", "Landlord2", "222222222222")] });
  const noLine = setup({ docs: [s], cash: true, replies: [reply("m1", FOUR)] });
  await noLine.p.processPendingUtrs({ dryRun: false });
  assert.ok(!noLine.calls.saver.some((b) => b.entryType === "rental" && simple(b).landOwnerId === "o1"), "no rent saved for the Cash landlord from a UTR line");
  const text = `Landlord2 - Rent - UTR : ${U.r2}\nLandlord1 - GST - UTR : ${U.g1}\nLandlord2 - GST - UTR : ${U.g2}`;
  const withLine = setup({ docs: [s], cash: true, lookupLandlords: async (b) => ({ data: { billNumber: b, extractionStatus: "found", threadId: "T1", approvalMailLandlords: [], replies: [reply("m1", text)], cashReplies: [cashLn("c1", "Landlord1 - Cash - Paid Date: 08-Nov-2026")] } }) });
  assert.equal(one(await withLine.p.processPendingUtrs({ dryRun: false })).status, "found_and_saved");
  assert.ok(withLine.calls.saver.some((b) => simple(b).landOwnerId === "o1" && simple(b).paymentMode === "Cash" && simple(b).utrNumber === "" && b.date === "2026-11-08"));
});
