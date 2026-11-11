// NEW BILL / ADVANCE BILL (media.arrearsDue[]) Gmail UTR automation.
// No network, no database: Gmail, Media, Registry, Log and Counter are in-memory fakes. Saving goes through the REAL ledger-save
// engine (executeBulkPaymentBatch -> payExtraBillInBatch -> applyArrearsPayment) with only the Media model methods and the
// OverDueHistory write stubbed, so every test checks the exact payment records the engine would write.
// Run: node --test test/gmailArrearsUtr.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-arrears-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const MediaModel = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const OverDue = require("../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { executeBulkPaymentBatch } = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
const { applyArrearsPayment } = require("../utils/rentRevisionArrears");
const { extractLandlordUtrLines, splitArrearsName, mapArrearsLines } = require("../utils/landlordUtrParser");
const { getPendingArrearsUtrBills } = require("../utils/pendingArrearsUtrBills");
const { createUtrProcessor, utrAlreadyUsed } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const SITE = "507f1f77bcf86cd799439011";
const O1 = "507f1f77bcf86cd799439021";
const O2 = "507f1f77bcf86cd799439022";
const M1 = "507f1f77bcf86cd799439031";
const M2 = "507f1f77bcf86cd799439032";
const PARENT = "507f1f77bcf86cd799439051";
const REV_NB = "507f1f77bcf86cd799439041";
const REV_AD = "507f1f77bcf86cd799439042";
const B_NB = "507f1f77bcf86cd799439061";
const B_AD = "507f1f77bcf86cd799439062";
const B_OLD = "507f1f77bcf86cd799439063";
const NB = "ADNOOHBILL1111202612";
const AD = "ADNOOHBILL1111202613";
const NB_OLD = "ADNOOHBILL1006202610";
const AD_OLD = "ADNOOHBILL1006202611";
const U = { a: "UTR8432473243", b: "UTR849327432001", c: "UTR853895743002", d: "UTR438432443003", e: "UTR843243484004", f: "UTR849384238005", g: "UTR4893247324006" };

// ── engine harness: the real engine on the in-memory database ──
let DB = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x) ? new Date(x) : x));
MediaModel.findById = (id) => {
  const doc = new MediaModel(clone(DB.get(String(id))));
  doc.save = async () => doc;
  const p = Promise.resolve(doc);
  p.select = () => ({ lean: async () => clone(DB.get(String(id))) });
  p.lean = async () => clone(DB.get(String(id)));
  return p;
};
MediaModel.updateOne = async (q, upd, opts) => {
  const m = DB.get(String(q._id));
  const billId = String(opts.arrayFilters[0]["a._id"]);
  const i = m.arrearsDue.findIndex((b) => String(b._id) === billId);
  m.arrearsDue[i] = clone(upd.$set["arrearsDue.$[a]"]);
};
OverDue.findOneAndUpdate = async () => null;

// ── fixtures ──
const landlords = [
  { _id: O1, landOwnerMasterId: M1, name: "Landlord1", paymentCategory: 2, bankName: "SBI", accountNumber: "111111111111" },
  { _id: O2, landOwnerMasterId: M2, name: "Landlord2", paymentCategory: 2, bankName: "SBI", accountNumber: "222222222222" },
];
const arrOwner = (id, master, name, over = {}) => ({ landOwnerId: id, landOwnerMasterId: master, landOwnerName: name, shareAmount: 2500, cashAmount: 0, onlineAmount: 2500, gstAmount: 0, paidCash: false, paidOnline: false, ...over });
const owners = (n, gst = 0, over = {}) => [arrOwner(O1, M1, "Landlord1", { gstAmount: gst, ...over }), arrOwner(O2, M2, "Landlord2", { gstAmount: gst, ...over })].slice(0, n);
const arrBill = (over = {}) => ({
  _id: B_NB, type: "arrears", label: "New Bill (November 2026)", dueMonth: "November 2026", parentRentalDueId: PARENT, rentRevisionId: REV_NB, adinn_ooh_bills: NB,
  approvalStatus: 3, mailSent: true, withGst: 2, netPayable: 5000, gstAmount: 0, gstPaid: 0, rentPaid: 0, owners: owners(2), payments: [],
  ownerApprovalDate: new Date("2026-11-05T03:00:00.000Z"), createdAt: new Date("2026-11-05T03:00:00.000Z"), ...over,
});
const site = (bills, n = 2, over = {}) => ({
  _id: SITE, mediaName: "Site 1",
  mediaDetails: [{ _id: "f1", status: 1, mediaCode: "C1", siteBillMode: 1 }],
  landOwners: landlords.slice(0, n),
  rentalPayment: { paymentFrequency: 1, nextBillingDate: new Date("2026-12-09T00:00:00.000Z"), gstOutstandingHistory: [], rentalOutstandingHistory: [] },
  rentalDue: [{ _id: PARENT, withGst: 2 }],
  ledger: [], ledgerHistory: [], withGst1Ledger: [], gstBalanceHistory: [],
  arrearsDue: bills, ...over,
});
// the four payment layouts, New Bill or Advance
const kindOf = (isAdvance) => ({ number: isAdvance ? AD : NB, billId: isAdvance ? B_AD : B_NB, rev: isAdvance ? REV_AD : REV_NB, type: isAdvance ? "advance" : "arrears", label: isAdvance ? "Advance (November 2026)" : "New Bill (November 2026)", word: isAdvance ? "Advance" : "NewBill" });
const scenario = ({ isAdvance = false, n = 1, hold = false, over = {} }) => {
  const k = kindOf(isAdvance);
  return arrBill({
    _id: k.billId, type: k.type, label: k.label, adinn_ooh_bills: k.number, rentRevisionId: k.rev,
    withGst: hold ? 1 : 2, gstAmount: hold ? 450 * n : 0, owners: owners(n, hold ? 450 : 0), netPayable: 2500 * n,
    ...(isAdvance ? { adjustInMonth: "December 2026" } : {}), ...over,
  });
};

const reply = (id, text, at = "2026-11-10T04:00:00.000Z") => ({ messageId: id, from: "Finance <f@x.com>", sentAt: at, sentDate: at.slice(0, 10), lines: extractLandlordUtrLines(text) });
const fakeCounter = () => {
  const docs = new Map();
  return {
    findOneAndUpdate: (q, upd) => ({ lean: async () => { const d = docs.get(q._id); if (d && d.seq < q.seq.$lt) { d.seq = upd.$set.seq; return { ...d }; } return null; } }),
    create: async (doc) => { if (docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 }); docs.set(doc._id, { ...doc }); },
    updateOne: async (q, upd) => { if (docs.has(q._id)) docs.get(q._id).seq = upd.$set.seq; },
  };
};
const noHelpers = { isOwnerModePaidForCycle: () => false };

const setup = ({ docs, replies, lookupLandlords, saveEnabled = true, multi = true, gst = true, cash = false, registry } = {}) => {
  DB = new Map(docs.map((d) => [String(d._id), clone(d)]));
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
        if (registry !== undefined) return registry === null ? null : registry(q.adinn_ooh_bills);
        for (const m of DB.values()) {
          const bs = (m.arrearsDue || []).filter((b) => b.adinn_ooh_bills === q.adinn_ooh_bills);
          if (bs.length) return { mediaId: m._id, groupKey: `${m._id}|${bs[0].type === "advance" ? "advance" : "newbill"}:${bs[0].rentRevisionId}`, billMode: bs[0].type === "advance" ? "advance" : "new_bill", dueMonth: bs[0].dueMonth, rentalDueIds: bs.map((b) => b._id) };
        }
        return null;
      },
    }),
  };
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(DB.get(String(id))) }) },
    Registry, Log, Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => saveEnabled, cashSaveEnabled: () => cash, multiLandlordSaveEnabled: () => multi, gstSaveEnabled: () => gst,
    now: () => NOW,
    logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [...DB.values()].map(clone) }) }), }, Log: { find: Log.find }, helpers: noHelpers, now: NOW },
    ...(replies !== undefined || lookupLandlords
      ? { lookupLandlords: async (b) => { calls.lookup += 1; return lookupLandlords ? lookupLandlords(b) : { data: { billNumber: b, extractionStatus: "found", threadId: "T1", approvalMailLandlords: [], replies: typeof replies === "function" ? replies(b) : replies } }; } }
      : {}),
    saver: async (batch, actor) => { calls.saver.push(batch); return executeBulkPaymentBatch({ user: { userName: actor || "Gmail UTR Auto" } }, batch); },
  });
  return { p, calls, logRows, bill: (id) => DB.get(SITE).arrearsDue.find((b) => String(b._id) === id) };
};
const run = (x, o = {}) => x.p.processPendingUtrs({ dryRun: false, ...o });
const res = (r, no) => r.results.find((y) => y.billNumber === no);
const pays = (b) => b.payments.map((p) => `${p.type}:${p.landOwnerName || "-"}:${p.amount}:${p.utrNumber}`);

// ───────────────────────── parser ─────────────────────────
test("AP1. reply names: landlord + NewBill|Advance + Rent|GST", () => {
  assert.deepEqual(splitArrearsName("NewBill"), { landlord: "", kind: null, billType: "newBill" });
  assert.deepEqual(splitArrearsName("Landlord1 - NewBill - Rent"), { landlord: "Landlord1", kind: "rent", billType: "newBill" });
  assert.deepEqual(splitArrearsName("Landlord2 - Advance - GST"), { landlord: "Landlord2", kind: "gst", billType: "advance" });
  assert.deepEqual(splitArrearsName("NewBill - GST"), { landlord: "", kind: "gst", billType: "newBill" });
  assert.equal(splitArrearsName("Landlord1 - Rent").billType, null);
});

test("AP2. a line of the OTHER bill type is a problem, a line without any type is ignored", () => {
  const L = [{ landOwnerId: O1, name: "Landlord1" }, { landOwnerId: O2, name: "Landlord2" }];
  const m = (t, billType) => mapArrearsLines([{ messageId: "m", lines: extractLandlordUtrLines(t) }], L, { billType, gstHold: false });
  assert.equal(m(`Landlord1 - Advance - Rent - UTR : ${U.a}`, "newBill").problems[0].reason, "bill_type_mismatch");
  assert.equal(m(`Landlord1 - Rent - UTR : ${U.a}`, "newBill").ignored[0].reason, "no_bill_type_label");
  assert.equal(m(`Landlord1 - NewBill - Rent - UTR : ${U.a}`, "newBill").byKey.get(`${O1}|rent`)[0].utr, U.a);
});

// ───────────────────────── pending list ─────────────────────────
test("AP3. pending list: approved + mailed New Bill and Advance bills, any month, with landlord / GST slots", async () => {
  const docs = [site([scenario({ n: 2, hold: true }), scenario({ isAdvance: true, n: 1 }), arrBill({ _id: B_OLD, adinn_ooh_bills: NB_OLD, dueMonth: "June 2026", rentRevisionId: REV_AD, ownerApprovalDate: new Date("2026-06-10T03:00:00.000Z") })])];
  const r = await getPendingArrearsUtrBills({}, { Media: { find: () => ({ select: () => ({ lean: async () => docs.map(clone) }) }) }, now: NOW });
  assert.equal(r.totalPending, 3);
  const nb = r.bills.find((b) => b.billNumber === NB);
  assert.equal(nb.billKind, "newBill");
  assert.equal(nb.dueMonth, "November 2026");
  assert.deepEqual(nb.slots.map((s) => `${s.landOwnerName}:${s.kind}:${s.scope || "-"}`), ["Landlord1:rent:-", "Landlord2:rent:-", "Landlord1:gst:landlord", "Landlord2:gst:landlord"]);
  assert.equal(r.bills.find((b) => b.billNumber === AD).billKind, "advance");
  assert.equal(r.bills.find((b) => b.billNumber === NB_OLD).dueMonth, "June 2026"); // past month is not skipped
  const cm = await getPendingArrearsUtrBills({ currentMonthOnly: true }, { Media: { find: () => ({ select: () => ({ lean: async () => docs.map(clone) }) }) }, now: NOW });
  assert.equal(cm.bills.some((b) => b.billNumber === NB_OLD), false);
});

test("AP4. not approved / mail not sent / no Bill Number / fully paid bills are not listed", async () => {
  const paid = scenario({ n: 1, over: { owners: owners(1, 0, { paidOnline: true }) } });
  const docs = [site([arrBill({ _id: B_NB, approvalStatus: 1 }), arrBill({ _id: B_AD, adinn_ooh_bills: AD, mailSent: false }), arrBill({ _id: B_OLD, adinn_ooh_bills: "" }), { ...paid, _id: "507f1f77bcf86cd799439071", adinn_ooh_bills: NB_OLD }])];
  const r = await getPendingArrearsUtrBills({}, { Media: { find: () => ({ select: () => ({ lean: async () => docs.map(clone) }) }) }, now: NOW });
  assert.equal(r.totalPending, 0);
});

test("AP5. several arrears bills under ONE Bill Number (months / faces) are one payment per landlord: every bill gets its own open slot", async () => {
  const dec = arrBill({ _id: B_AD, dueMonth: "December 2026", owners: owners(1) });
  const docs = [site([arrBill({ _id: B_NB, owners: owners(1) }), dec], 1)];
  const r = await getPendingArrearsUtrBills({}, { Media: { find: () => ({ select: () => ({ lean: async () => docs.map(clone) }) }) }, now: NOW });
  assert.equal(r.bills.length, 1);
  assert.equal(r.bills[0].eligible, true);
  assert.deepEqual(r.bills[0].dueMonths, ["November 2026", "December 2026"]);
  assert.deepEqual(r.bills[0].slots.map((x) => [x.rentalDueId, x.dueMonth, x.landOwnerName]), [[B_NB, "November 2026", "Landlord1"], [B_AD, "December 2026", "Landlord1"]]);
  // a New Bill and an Advance under one number can never be one payment
  const mixed = [site([arrBill({ _id: B_NB, owners: owners(1) }), arrBill({ _id: B_AD, type: "advance", owners: owners(1) })], 1)];
  const m = await getPendingArrearsUtrBills({}, { Media: { find: () => ({ select: () => ({ lean: async () => mixed.map(clone) }) }) }, now: NOW });
  assert.equal(m.bills[0].eligible, false);
  assert.equal(m.bills[0].skipReason, "bill_kind_mixed");
});

// ───────────────────────── Tests 1-8: four scenarios x New Bill / Advance ─────────────────────────
for (const isAdvance of [false, true]) {
  const k = kindOf(isAdvance);
  const W = k.word;
  const T = isAdvance ? 4 : 0; // test numbers 1-4 New Bill, 5-8 Advance

  test(`T${T + 1}. ${W} - single landlord - no GST: the UTR is saved against that landlord's Rent`, async () => {
    const x = setup({ docs: [site([scenario({ isAdvance, n: 1 })], 1)], replies: [reply("m1", `${W} - UTR: ${U.a}`)] });
    const r = await run(x);
    assert.equal(res(r, k.number).status, "found_and_saved");
    assert.equal(res(r, k.number).billKind, isAdvance ? "advance" : "newBill");
    assert.equal(res(r, k.number).dueMonth, "November 2026");
    assert.equal(x.calls.saver.length, 1);
    assert.deepEqual([x.calls.saver[0].entryType, x.calls.saver[0].payments[0].targetType, x.calls.saver[0].payments[0].rentalDueId, x.calls.saver[0].payments[0].landOwnerId, x.calls.saver[0].date], ["rental", isAdvance ? "advance" : "newBill", k.billId, O1, "2026-11-10"]);
    const b = x.bill(k.billId);
    assert.deepEqual(pays(b), [`rental:Landlord1:2500:${U.a}`]);
    assert.equal(b.payments[0].paymentMode, "Online");
    assert.equal(b.owners[0].paidOnline, true);
    assert.equal(b.rentPaid, 2500);
    assert.equal(b.status, 3);
  });

  test(`T${T + 2}. ${W} - multiple landlords - no GST: each landlord's UTR is saved against its own Rent`, async () => {
    const x = setup({ docs: [site([scenario({ isAdvance, n: 2 })])], replies: [reply("m1", `Landlord1 - ${W} - Rent - UTR: ${U.b}\nLandlord2 - ${W} - Rent - UTR: ${U.c}`)] });
    const r = await run(x);
    assert.equal(res(r, k.number).status, "found_and_saved");
    const b = x.bill(k.billId);
    assert.deepEqual(pays(b), [`rental:Landlord1:2500:${U.b}`, `rental:Landlord2:2500:${U.c}`]);
    assert.deepEqual(b.owners.map((o) => [o.landOwnerName, o.paidOnline]), [["Landlord1", true], ["Landlord2", true]]);
    assert.equal(b.payments[0].landOwnerId, O1);
    assert.equal(b.payments[1].landOwnerId, O2);
  });

  test(`T${T + 3}. ${W} - single landlord - GST on hold: Rent and GST are saved separately`, async () => {
    const x = setup({ docs: [site([scenario({ isAdvance, n: 1, hold: true })], 1)], replies: [reply("m1", `${W} - Rent - UTR: ${U.d}\n${W} - GST - UTR: ${U.e}`)] });
    const r = await run(x);
    assert.equal(res(r, k.number).status, "found_and_saved");
    assert.deepEqual(x.calls.saver.map((c) => c.entryType), ["rental", "gst"]);
    const b = x.bill(k.billId);
    assert.deepEqual(pays(b), [`rental:Landlord1:2500:${U.d}`, `gst:-:450:${U.e}`]);
    assert.equal(b.gstPaid, 450);
    assert.equal(b.status, 3);
  });

  test(`T${T + 4}. ${W} - multiple landlords - GST on hold: landlord-wise Rent AND GST, never combined`, async () => {
    const text = [`Landlord1 - ${W} - Rent - UTR: ${U.d}`, `Landlord2 - ${W} - Rent - UTR: ${U.e}`, `Landlord1 - ${W} - GST - UTR: ${U.f}`, `Landlord2 - ${W} - GST - UTR: ${U.g}`].join("\n");
    const x = setup({ docs: [site([scenario({ isAdvance, n: 2, hold: true })])], replies: [reply("m1", text)] });
    const r = await run(x);
    assert.equal(res(r, k.number).status, "found_and_saved");
    assert.deepEqual(x.calls.saver.map((c) => [c.entryType, c.payments[0].landOwnerId, c.payments[0].utrNumber, c.payments[0].gstScope || ""]), [
      ["rental", O1, U.d, ""], ["rental", O2, U.e, ""], ["gst", O1, U.f, "landlord"], ["gst", O2, U.g, "landlord"],
    ]);
    const b = x.bill(k.billId);
    assert.deepEqual(pays(b), [`rental:Landlord1:2500:${U.d}`, `rental:Landlord2:2500:${U.e}`, `gst:Landlord1:450:${U.f}`, `gst:Landlord2:450:${U.g}`]);
    assert.deepEqual(b.payments.filter((p) => p.type === "gst").map((p) => p.landOwnerId), [O1, O2]); // one GST row per landlord
    assert.deepEqual(b.owners.map((o) => o.paidGst), [true, true]);
    assert.equal(b.gstPaid, 900);
    assert.equal(b.rentPaid, 5000);
    assert.equal(b.status, 3);
  });
}

// ───────────────────────── Tests 9-10: past pending ─────────────────────────
for (const isAdvance of [false, true]) {
  test(`T${isAdvance ? 10 : 9}. past pending ${isAdvance ? "Advance" : "New Bill"}: saved against ITS month only, the current month's bill is untouched`, async () => {
    const k = kindOf(isAdvance);
    const old = arrBill({ _id: B_OLD, type: isAdvance ? "advance" : "arrears", adinn_ooh_bills: isAdvance ? AD_OLD : NB_OLD, dueMonth: "June 2026", rentRevisionId: REV_AD, label: "old", ownerApprovalDate: new Date("2026-06-10T03:00:00.000Z"), owners: owners(1), netPayable: 2500 });
    const cur = scenario({ isAdvance, n: 1 });
    const x = setup({
      docs: [site([old, cur], 1)],
      replies: (bill) => (bill === (isAdvance ? AD_OLD : NB_OLD) ? [reply("m1", `${k.word} - UTR: ${U.a}`)] : []),
    });
    const r = await run(x);
    assert.equal(res(r, isAdvance ? AD_OLD : NB_OLD).status, "found_and_saved");
    assert.equal(res(r, isAdvance ? AD_OLD : NB_OLD).dueMonth, "June 2026");
    assert.equal(x.calls.saver.length, 1);
    assert.equal(x.calls.saver[0].payments[0].rentalDueId, B_OLD);
    assert.deepEqual(pays(x.bill(B_OLD)), [`rental:Landlord1:2500:${U.a}`]);
    assert.deepEqual(x.bill(k.billId).payments, []);
    assert.equal(x.bill(B_OLD).payments[0].date.toISOString().slice(0, 10), "2026-11-10"); // paid date = the reply date, not June
  });
}

// ───────────────────────── Test 11: New Bill + Advance in ONE Gmail thread ─────────────────────────
const approvalBody = (bill, names) => `New Bill Payment Approved\nMI Media Information Bill No: ${bill}\n` + names.map((n) => `Owner Name ${n.name}\nBank Name SBI\nAccount No ${n.acc}\n`).join("");
const msg = (id, mid, text, at, parent = "") => ({ id, labelIds: ["INBOX"], from: "x", sentAt: at, date: at, subject: "CMD Payment Approved", messageIdHeader: `<${mid}@d.com>`, inReplyTo: parent ? `<${parent}@d.com>` : "", bodyText: text });
const stubGmail = (messages) => {
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "s", messages: messages.map((m) => ({ ...m })), ignoredMessages: [] });
  return () => { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; };
};
const NAMES1 = [{ name: "Landlord1", acc: "111111111111" }];
const twoMails = () => [msg("mA", "midA", approvalBody(NB, NAMES1), "2026-11-10T03:00:00.000Z"), msg("mB", "midB", approvalBody(AD, NAMES1), "2026-11-10T03:02:00.000Z")];

test("T11. New Bill and Advance approval mails in one thread: each reply goes to the bill of the mail it answers", async () => {
  const docs = [site([scenario({ n: 1 }), scenario({ isAdvance: true, n: 1 })], 1)];
  const off = stubGmail([...twoMails(), msg("mR1", "midR1", `NewBill - UTR: ${U.a}`, "2026-11-10T04:00:00.000Z", "midA"), msg("mR2", "midR2", `Advance - UTR: ${U.b}`, "2026-11-10T04:10:00.000Z", "midB")]);
  try {
    const x = setup({ docs });
    const r = await run(x);
    assert.equal(res(r, NB).status, "found_and_saved");
    assert.equal(res(r, AD).status, "found_and_saved");
    assert.equal(res(r, NB).replyLink.approvalMessageId, "mA");
    assert.equal(res(r, AD).replyLink.approvalMessageId, "mB");
    assert.deepEqual(pays(x.bill(B_NB)), [`rental:Landlord1:2500:${U.a}`]); // New Bill UTR only on the New Bill
    assert.deepEqual(pays(x.bill(B_AD)), [`rental:Landlord1:2500:${U.b}`]); // Advance UTR only on the Advance
  } finally { off(); }
});

test("T11b. a reply to the New Bill mail that carries an Advance line is never saved (type mismatch -> manual)", async () => {
  const docs = [site([scenario({ n: 1 }), scenario({ isAdvance: true, n: 1 })], 1)];
  const off = stubGmail([...twoMails(), msg("mR1", "midR1", `Advance - UTR: ${U.a}`, "2026-11-10T04:00:00.000Z", "midA")]);
  try {
    const x = setup({ docs });
    const r = await run(x);
    assert.equal(res(r, NB).status, "ambiguous_mapping");
    assert.equal(res(r, NB).reason, "bill_type_mismatch");
    assert.equal(res(r, AD).status, "utr_not_found"); // the reply is not the Advance mail's
    assert.equal(x.calls.saver.length, 0);
  } finally { off(); }
});

test("T11c. New Bill mail alone: the real mail text layout (Bill No, Owner Name blocks) validates landlords against RMS", async () => {
  const docs = [site([scenario({ n: 2 })])];
  const names = [{ name: "Landlord1", acc: "111111111111" }, { name: "Landlord2", acc: "222222222222" }];
  const off = stubGmail([msg("mA", "midA", approvalBody(NB, names), "2026-11-10T03:00:00.000Z"), msg("mR", "midR", `Landlord1 - NewBill - Rent - UTR: ${U.b}\nLandlord2 - NewBill - Rent - UTR: ${U.c}`, "2026-11-10T04:00:00.000Z", "midA")]);
  try {
    const x = setup({ docs });
    assert.equal(res(await run(x), NB).status, "found_and_saved");
    // wrong account on the approval mail -> blocked
    const bad = [{ name: "Landlord1", acc: "999999999999" }, names[1]];
    off();
    const off2 = stubGmail([msg("mA", "midA", approvalBody(NB, bad), "2026-11-10T03:00:00.000Z"), msg("mR", "midR", `Landlord1 - NewBill - Rent - UTR: ${U.b}\nLandlord2 - NewBill - Rent - UTR: ${U.c}`, "2026-11-10T04:00:00.000Z", "midA")]);
    try {
      const y = setup({ docs });
      assert.equal(res(await run(y), NB).reason, "account_mismatch_approval_mail");
      assert.equal(y.calls.saver.length, 0);
    } finally { off2(); }
  } finally { try { off(); } catch (_) { /* already restored */ } }
});

// ───────────────────────── Test 12: duplicate UTR ─────────────────────────
test("T12. duplicate UTR protection: a UTR already used on the site (rental ledger, arrears payment) or twice in the reply is never saved", async () => {
  // already in a New Bill payment of another bill
  const used = scenario({ isAdvance: true, n: 1, over: { owners: owners(1, 0, { paidOnline: true }), payments: [{ type: "rental", landOwnerId: O1, landOwnerName: "Landlord1", amount: 2500, paymentMode: "Online", utrNumber: U.a }] } });
  const other = { ...scenario({ n: 1 }) };
  const x = setup({ docs: [site([used, other], 1)], replies: (b) => (b === NB ? [reply("m1", `NewBill - UTR: ${U.a}`)] : []) });
  const r = await run(x);
  assert.equal(res(r, NB).status, "ambiguous_mapping");
  assert.equal(res(r, NB).reason, "utr_already_used_on_this_site");
  assert.equal(x.calls.saver.length, 0);
  // already in the rental ledger history
  const hist = site([scenario({ n: 1 })], 1, { ledgerHistory: [{ year: "2026", months: [{ month: "October", entries: [{ rentalDueId: "x", utrNumber: U.a }] }] }] });
  const y = setup({ docs: [hist], replies: [reply("m1", `NewBill - UTR: ${U.a}`)] });
  assert.equal(res(await run(y), NB).reason, "utr_already_used_on_this_site");
  // the same UTR for two landlords / payments in one reply
  const z = setup({ docs: [site([scenario({ n: 2 })])], replies: [reply("m1", `Landlord1 - NewBill - Rent - UTR: ${U.b}\nLandlord2 - NewBill - Rent - UTR: ${U.b}`)] });
  assert.equal(res(await run(z), NB).reason, "duplicate_utr");
  assert.equal(z.calls.saver.length, 0);
  // the pure check
  assert.equal(utrAlreadyUsed({ arrearsDue: [{ payments: [{ utrNumber: "abc123456789xyz" }] }] }, "ABC123456789XYZ"), true);
  assert.equal(utrAlreadyUsed({ arrearsDue: [{ payments: [{ utrNumber: "OTHER12345678" }] }] }, "ABC123456789XYZ"), false);
});

// ───────────────────────── Test 13: In-Reply-To ─────────────────────────
test("T13. a reply without a valid In-Reply-To match is never saved (manual review)", async () => {
  const docs = [site([scenario({ n: 1 }), scenario({ isAdvance: true, n: 1 })], 1)];
  for (const parent of ["", "midUnknown"]) {
    const off = stubGmail([...twoMails(), msg("mR1", "midR1", `NewBill - UTR: ${U.a}`, "2026-11-10T04:00:00.000Z", parent)]);
    try {
      const x = setup({ docs });
      const r = await run(x);
      assert.equal(res(r, NB).reason, "reply_not_linked_to_approval_mail");
      assert.equal(res(r, AD).reason, "reply_not_linked_to_approval_mail");
      assert.equal(x.calls.saver.length, 0);
    } finally { off(); }
  }
});

// ───────────────────────── Tests 14-15: partial replies ─────────────────────────
test("T14. one landlord's UTR missing while the other is present: only that landlord is saved; the later reply completes it without duplicates", async () => {
  let replies = [reply("m1", `Landlord1 - NewBill - Rent - UTR: ${U.b}`)];
  const x = setup({ docs: [site([scenario({ n: 2 })])], replies: () => replies });
  const a = await run(x);
  assert.equal(res(a, NB).status, "found_and_saved");
  assert.equal(res(a, NB).pendingPayments[0].landlord, "Landlord2");
  assert.deepEqual(pays(x.bill(B_NB)), [`rental:Landlord1:2500:${U.b}`]);
  assert.equal(x.bill(B_NB).owners[1].paidOnline, false);
  assert.equal(x.bill(B_NB).status === 3, false);

  replies = [reply("m1", `Landlord1 - NewBill - Rent - UTR: ${U.b}`), reply("m2", `Landlord2 - NewBill - Rent - UTR: ${U.c}`, "2026-11-10T05:00:00.000Z")];
  const b = await run(x, { force: true });
  assert.equal(res(b, NB).status, "found_and_saved");
  assert.equal(x.calls.saver.length, 2); // Landlord1 was not saved a second time
  assert.deepEqual(pays(x.bill(B_NB)), [`rental:Landlord1:2500:${U.b}`, `rental:Landlord2:2500:${U.c}`]);
  assert.equal(x.bill(B_NB).status, 3);
});

test("T15. Rent UTR present but GST UTR missing: Rent is saved, GST stays pending until its own line arrives", async () => {
  let replies = [reply("m1", `Landlord1 - NewBill - Rent - UTR: ${U.d}\nLandlord2 - NewBill - Rent - UTR: ${U.e}`)];
  const x = setup({ docs: [site([scenario({ n: 2, hold: true })])], replies: () => replies });
  const a = await run(x);
  assert.equal(res(a, NB).status, "found_and_saved");
  assert.deepEqual(x.calls.saver.map((c) => c.entryType), ["rental", "rental"]);
  assert.equal(res(a, NB).pendingPayments.length, 2); // both GST payments wait
  assert.equal(x.bill(B_NB).gstPaid, 0);
  assert.equal(x.bill(B_NB).payments.some((p) => p.type === "gst"), false);

  replies = [...replies, reply("m2", `Landlord2 - NewBill - GST - UTR: ${U.g}`, "2026-11-10T05:00:00.000Z")];
  await run(x, { force: true });
  assert.deepEqual(x.calls.saver.map((c) => c.entryType), ["rental", "rental", "gst"]);
  assert.deepEqual(x.bill(B_NB).payments.filter((p) => p.type === "gst").map((p) => [p.landOwnerName, p.amount]), [["Landlord2", 450]]);
  assert.equal(x.bill(B_NB).gstPaid, 450);
  assert.equal(x.bill(B_NB).status === 3, false); // Landlord1's GST still open
});

// ───────────────────────── safety ─────────────────────────
test("S1. Rent line is rent only: a line without Rent/GST on a GST-on-hold bill is never used", async () => {
  const x = setup({ docs: [site([scenario({ n: 1, hold: true })], 1)], replies: [reply("m1", `NewBill - UTR: ${U.a}`)] });
  const r = await run(x);
  assert.equal(res(r, NB).status, "utr_not_found");
  assert.equal(res(r, NB).ignoredLines[0].reason, "no_rent_or_gst_label");
  assert.equal(x.calls.saver.length, 0);
});

test("S2. landlord names: unknown / unnamed (several landlords) block the bill; amount and order never decide", async () => {
  for (const text of [`Landlord9 - NewBill - Rent - UTR: ${U.a}`, `NewBill - UTR: ${U.a}`]) {
    const x = setup({ docs: [site([scenario({ n: 2 })])], replies: [reply("m1", text)] });
    const r = await run(x);
    assert.equal(res(r, NB).status, "ambiguous_mapping");
    assert.equal(x.calls.saver.length, 0);
  }
  // reversed order of lines
  const y = setup({ docs: [site([scenario({ n: 2 })])], replies: [reply("m1", `Landlord2 - NewBill - Rent - UTR: ${U.c}\nLandlord1 - NewBill - Rent - UTR: ${U.b}`)] });
  await run(y);
  assert.deepEqual(y.bill(B_NB).payments.map((p) => [p.landOwnerName, p.utrNumber]).sort(), [["Landlord1", U.b], ["Landlord2", U.c]]);
});

test("S3. switches: several landlords, GST on hold and Cash each need their own switch, checked BEFORE Gmail", async () => {
  const noMulti = setup({ docs: [site([scenario({ n: 2 })])], replies: [reply("m1", `Landlord1 - NewBill - Rent - UTR: ${U.b}`)], multi: false });
  assert.equal(res(await run(noMulti), NB).reason, "multi_landlord_auto_save_disabled");
  assert.equal(noMulti.calls.lookup, 0);
  const noGst = setup({ docs: [site([scenario({ n: 1, hold: true })], 1)], replies: [reply("m1", `NewBill - Rent - UTR: ${U.b}`)], gst: false });
  assert.equal(res(await run(noGst), NB).reason, "gst_split_auto_save_disabled");
  assert.equal(noGst.calls.lookup, 0);
  const cashOwners = [arrOwner(O1, M1, "Landlord1", { onlineAmount: 0, cashAmount: 2500 })];
  const noCash = setup({ docs: [site([scenario({ n: 1, over: { owners: cashOwners } })], 1)], replies: [reply("m1", `NewBill - UTR: ${U.b}`)], cash: false });
  assert.equal(res(await run(noCash), NB).reason, "cash_auto_save_disabled");
  assert.equal(noCash.calls.lookup, 0);
  assert.equal(noGst.calls.saver.length + noMulti.calls.saver.length + noCash.calls.saver.length, 0);
});

test("S4. dry run shows bill, month, landlord, kind, GST amount, UTR and paid date and saves nothing", async () => {
  const x = setup({ docs: [site([scenario({ n: 2, hold: true })])], saveEnabled: false, multi: false, gst: false, replies: [reply("m1", [`Landlord1 - NewBill - Rent - UTR: ${U.d}`, `Landlord1 - NewBill - GST - UTR: ${U.f}`].join("\n"))] });
  const r = await x.p.processPendingUtrs({});
  assert.equal(r.dryRun, true);
  assert.equal(x.calls.saver.length, 0);
  const row = res(r, NB);
  assert.equal(row.status, "found_and_saved");
  assert.equal(row.billKind, "newBill");
  assert.equal(row.dueMonth, "November 2026");
  assert.equal(row.eligibleForSaving, true);
  assert.deepEqual(row.splitPayments.map((s) => [s.landlord, s.kind, s.paidDate, s.amount, s.gstScope || ""]), [["Landlord1", "rent", "2026-11-10", 2500, ""], ["Landlord1", "gst", "2026-11-10", 450, "landlord"]]);
  assert.ok(row.savingBlockedBy.length >= 3);
  assert.equal(DB.get(SITE).arrearsDue[0].payments.length, 0);
});

test("S5. registry guards the bill: missing record, another site, another bill kind, another month, rows not listed", async () => {
  const docs = [site([scenario({ n: 1 })], 1)];
  const reg = (over) => () => ({ mediaId: SITE, groupKey: `${SITE}|newbill:${REV_NB}`, billMode: "new_bill", dueMonth: "November 2026", rentalDueIds: [B_NB], ...over });
  const cases = [
    [null, "registry_record_missing"],
    [reg({ mediaId: "507f1f77bcf86cd799439099" }), "registry_media_mismatch"],
    [reg({ groupKey: `${SITE}|advance:${REV_NB}`, billMode: "advance" }), "registry_kind_mismatch"],
    [reg({ dueMonth: "October 2026" }), "registry_month_mismatch"],
    [reg({ rentalDueIds: ["507f1f77bcf86cd799439098"] }), "registry_rows_mismatch"],
  ];
  for (const [registry, reason] of cases) {
    const x = setup({ docs, registry, replies: [reply("m1", `NewBill - UTR: ${U.a}`)] });
    const r = await run(x);
    assert.equal(res(r, NB).reason, reason);
    assert.equal(x.calls.saver.length, 0);
  }
});

test("S6. the engine: the whole-bill GST payment is unchanged, a landlord's GST can be paid once only", () => {
  const bill = scenario({ n: 2, hold: true });
  // legacy: no landlord scope -> ONE GST payment for the whole bill
  const legacy = applyArrearsPayment(clone(bill), { entryType: "gst", landOwnerId: null, paymentMode: "Online", utrNumber: U.a, date: new Date(), userName: "t" });
  assert.deepEqual(legacy.bill.payments.map((p) => [p.type, p.amount, p.landOwnerId || null]), [["gst", 900, null]]);
  assert.equal(legacy.bill.gstPaid, 900);
  // landlord scope: own share, own row; a second payment for the same landlord is refused
  const one = applyArrearsPayment(clone(bill), { entryType: "gst", landOwnerId: O1, gstScope: "landlord", paymentMode: "Online", utrNumber: U.a, date: new Date(), userName: "t" });
  assert.deepEqual(one.bill.payments.map((p) => [p.type, p.landOwnerName, p.amount]), [["gst", "Landlord1", 450]]);
  assert.throws(() => applyArrearsPayment(one.bill, { entryType: "gst", landOwnerId: O1, gstScope: "landlord", paymentMode: "Online", utrNumber: U.b, date: new Date(), userName: "t" }), (e) => /GST already paid/.test(e.message));
  // GST included in the rent: no separate landlord GST
  assert.throws(() => applyArrearsPayment(clone(scenario({ n: 2, over: { withGst: 2, gstAmount: 900, owners: owners(2, 450) } })), { entryType: "gst", landOwnerId: O1, gstScope: "landlord", paymentMode: "Online", utrNumber: U.a, date: new Date(), userName: "t" }), (e) => /GST included/.test(e.message));
});

// ───────────────────────── several arrears bills under one Bill Number ─────────────────────────
const twoBills = (extra = {}, ownersFn = (n) => owners(n)) => [
  arrBill({ _id: B_NB, dueMonth: "November 2026", owners: ownersFn(extra.n || 1), netPayable: 2500 * (extra.n || 1), ...(extra.bill || {}) }),
  arrBill({ _id: B_AD, dueMonth: "December 2026", owners: ownersFn(extra.n || 1), netPayable: 2500 * (extra.n || 1), ...(extra.bill || {}) }),
];

test("T16. one New Bill revision over TWO months: the one UTR is saved on both bills (grouping rule), once each", async () => {
  const x = setup({ docs: [site(twoBills(), 1)], replies: [reply("m1", `NewBill - UTR: ${U.a}`)] });
  const r = await run(x);
  assert.equal(res(r, NB).status, "found_and_saved");
  assert.deepEqual(x.calls.saver.map((c) => c.payments[0].rentalDueId), [B_NB, B_AD]);
  assert.deepEqual(pays(x.bill(B_NB)), [`rental:Landlord1:2500:${U.a}`]);
  assert.deepEqual(pays(x.bill(B_AD)), [`rental:Landlord1:2500:${U.a}`]);
  assert.equal(x.bill(B_NB).status, 3);
  assert.equal(x.bill(B_AD).status, 3);
  // nothing more to do on the next run
  const again = await run(x, { force: true });
  assert.equal(again.results.length, 0);
  assert.equal(x.calls.saver.length, 2);
});

test("T17. several months + a failure on the second bill: the retry saves ONLY the second bill, the same UTR is not a duplicate of its own earlier part", async () => {
  const x = setup({ docs: [site(twoBills(), 1)], replies: [reply("m1", `NewBill - UTR: ${U.a}`)] });
  const real = x.calls.saver;
  let failSecond = true;
  const oldFind = MediaModel.updateOne;
  MediaModel.updateOne = async (q, upd, opts) => {
    if (failSecond && String(opts.arrayFilters[0]["a._id"]) === B_AD) { failSecond = false; throw new Error("boom"); }
    return oldFind(q, upd, opts);
  };
  try {
    const a = await run(x);
    assert.equal(res(a, NB).status, "database_error");
    assert.match(res(a, NB).reason, /partial_save 1\/2/);
    assert.deepEqual(pays(x.bill(B_NB)), [`rental:Landlord1:2500:${U.a}`]);
    assert.deepEqual(x.bill(B_AD).payments, []);
    const b = await run(x, { force: true });
    assert.equal(res(b, NB).status, "found_and_saved");
    assert.deepEqual(real.map((c) => c.payments[0].rentalDueId), [B_NB, B_AD, B_AD]); // the first bill was NOT paid again
    assert.deepEqual(pays(x.bill(B_AD)), [`rental:Landlord1:2500:${U.a}`]);
  } finally { MediaModel.updateOne = oldFind; }
});

test("T18. two landlords, GST on hold, TWO months: each landlord's Rent and GST UTR covers both bills", async () => {
  const text = [`Landlord1 - NewBill - Rent - UTR: ${U.d}`, `Landlord2 - NewBill - Rent - UTR: ${U.e}`, `Landlord1 - NewBill - GST - UTR: ${U.f}`, `Landlord2 - NewBill - GST - UTR: ${U.g}`].join("\n");
  const bills = twoBills({ n: 2, bill: { withGst: 1, gstAmount: 900 } }, (n) => owners(n, 450));
  const x = setup({ docs: [site(bills)], replies: [reply("m1", text)] });
  const r = await run(x);
  assert.equal(res(r, NB).status, "found_and_saved");
  assert.equal(x.calls.saver.length, 8); // 4 payments x 2 bills
  for (const id of [B_NB, B_AD]) {
    assert.deepEqual(pays(x.bill(id)), [`rental:Landlord1:2500:${U.d}`, `rental:Landlord2:2500:${U.e}`, `gst:Landlord1:450:${U.f}`, `gst:Landlord2:450:${U.g}`]);
    assert.equal(x.bill(id).status, 3);
  }
});

// ───────────────────────── CASH: no UTR, only the paid date is stored ─────────────────────────
const cashOwner = (id, master, name, over = {}) => arrOwner(id, master, name, { onlineAmount: 0, cashAmount: 2500, ...over });

test("C1. Cash New Bill / Advance: the reply has NO UTR; the Cash payment is stored with the paid date of the line", async () => {
  for (const isAdvance of [false, true]) {
    const k = kindOf(isAdvance);
    const bill = scenario({ isAdvance, n: 1, over: { owners: [cashOwner(O1, M1, "Landlord1")] } });
    const x = setup({ docs: [site([bill], 1)], cash: true, replies: [], lookupLandlords: async (b) => ({ data: { billNumber: b, extractionStatus: "utr_not_found", threadId: "T1", approvalMailLandlords: [], replies: [], cashReplies: [{ messageId: "m1", sentAt: "2026-11-10T04:00:00.000Z", sentDate: "2026-11-10", cashLines: [{ name: `${k.word} - Cash`, utr: "", cash: true, dates: [{ date: "2026-11-09" }], line: "x" }] }] } }) });
    const r = await run(x);
    assert.equal(res(r, k.number).status, "found_and_saved");
    assert.equal(x.calls.saver.length, 1);
    assert.deepEqual([x.calls.saver[0].payments[0].paymentMode, x.calls.saver[0].payments[0].utrNumber, x.calls.saver[0].date], ["Cash", "", "2026-11-09"]);
    const b = x.bill(k.billId);
    assert.equal(b.payments.length, 1);
    assert.deepEqual([b.payments[0].paymentMode, b.payments[0].utrNumber, b.payments[0].amount, b.payments[0].date.toISOString().slice(0, 10)], ["Cash", "", 2500, "2026-11-09"]);
    assert.equal(b.owners[0].paidCash, true);
    assert.equal(b.status, 3);
  }
});

test("C2. Cash without a date on the line: the paid date is the reply's sent date; with the Cash switch off nothing is saved (checked before Gmail)", async () => {
  const bill = scenario({ n: 1, over: { owners: [cashOwner(O1, M1, "Landlord1")] } });
  const lookup = async (b) => ({ data: { billNumber: b, extractionStatus: "utr_not_found", threadId: "T1", approvalMailLandlords: [], replies: [], cashReplies: [{ messageId: "m1", sentAt: "2026-11-10T04:00:00.000Z", sentDate: "2026-11-10", cashLines: [{ name: "NewBill - Cash", utr: "", cash: true, dates: [], line: "x" }] }] } });
  const on = setup({ docs: [site([bill], 1)], cash: true, replies: [], lookupLandlords: lookup });
  await run(on);
  assert.equal(on.calls.saver[0].date, "2026-11-10");
  assert.equal(on.bill(B_NB).payments[0].utrNumber, "");
  const off = setup({ docs: [site([bill], 1)], cash: false, replies: [], lookupLandlords: lookup });
  assert.equal(res(await run(off), NB).reason, "cash_auto_save_disabled");
  assert.equal(off.calls.lookup, 0);
  assert.equal(off.calls.saver.length, 0);
  // dry run shows it and saves nothing
  const dry = setup({ docs: [site([bill], 1)], cash: false, replies: [], lookupLandlords: lookup });
  const d = res(await dry.p.processPendingUtrs({}), NB);
  assert.equal(d.status, "found_and_saved");
  assert.equal(d.splitPayments[0].paymentMode, "Cash");
  assert.equal(d.splitPayments[0].utr, "");
  assert.deepEqual(d.savingBlockedBy, ["GMAIL_UTR_CASH_SAVE_ENABLED is off"]);
});

test("C3. a UTR line for a Cash landlord is never a Cash payment, and a Cash line of the OTHER bill type is a problem", async () => {
  const bill = scenario({ n: 1, over: { owners: [cashOwner(O1, M1, "Landlord1")] } });
  const x = setup({ docs: [site([bill], 1)], cash: true, replies: [reply("m1", `NewBill - UTR: ${U.a}`)] });
  const r = await run(x);
  assert.notEqual(res(r, NB).status, "found_and_saved");
  assert.equal(x.calls.saver.length, 0);
  const y = setup({ docs: [site([bill], 1)], cash: true, replies: [], lookupLandlords: async (b) => ({ data: { billNumber: b, extractionStatus: "utr_not_found", threadId: "T", approvalMailLandlords: [], replies: [], cashReplies: [{ messageId: "m1", sentDate: "2026-11-10", cashLines: [{ name: "Advance - Cash", utr: "", cash: true, dates: [], line: "x" }] }] } }) });
  assert.equal(res(await run(y), NB).reason, "bill_type_mismatch");
  assert.equal(y.calls.saver.length, 0);
});

test("C4. two landlords, one Online (UTR line) one Cash (Cash line): each is saved its own way", async () => {
  const bill = scenario({ n: 2, over: { owners: [arrOwner(O1, M1, "Landlord1"), cashOwner(O2, M2, "Landlord2")] } });
  const x = setup({ docs: [site([bill])], cash: true, replies: [], lookupLandlords: async (b) => ({ data: { billNumber: b, extractionStatus: "found", threadId: "T", approvalMailLandlords: [], replies: [reply("m1", `Landlord1 - NewBill - Rent - UTR: ${U.b}`)], cashReplies: [{ messageId: "m2", sentDate: "2026-11-10", sentAt: "2026-11-10T05:00:00.000Z", cashLines: [{ name: "Landlord2 - NewBill - Cash", utr: "", cash: true, dates: [{ date: "2026-11-09" }], line: "x" }] }] } }) });
  const r = await run(x);
  assert.equal(res(r, NB).status, "found_and_saved");
  const b = x.bill(B_NB);
  assert.deepEqual(b.payments.map((p) => [p.landOwnerName, p.paymentMode, p.utrNumber]), [["Landlord1", "Online", U.b], ["Landlord2", "Cash", ""]]);
  assert.equal(b.payments[1].date.toISOString().slice(0, 10), "2026-11-09");
  assert.equal(b.status, 3);
});

test("C5. two Cash lines with different paid dates block that payment (never guessed)", async () => {
  const bill = scenario({ n: 1, over: { owners: [cashOwner(O1, M1, "Landlord1")] } });
  const lines = [{ name: "NewBill - Cash", utr: "", cash: true, dates: [{ date: "2026-11-08" }], line: "a" }, { name: "NewBill - Cash", utr: "", cash: true, dates: [{ date: "2026-11-09" }], line: "b" }];
  const x = setup({ docs: [site([bill], 1)], cash: true, replies: [], lookupLandlords: async (b) => ({ data: { billNumber: b, extractionStatus: "utr_not_found", threadId: "T", approvalMailLandlords: [], replies: [], cashReplies: [{ messageId: "m1", sentDate: "2026-11-10", cashLines: lines }] } }) });
  assert.equal(res(await run(x), NB).reason, "conflicting_cash_paid_date");
  assert.equal(x.calls.saver.length, 0);
});

test("C6. the real Gmail path: a Cash reply linked by In-Reply-To to the New Bill mail is saved, the Advance mail of the same thread is untouched", async () => {
  const bills = [scenario({ n: 1, over: { owners: [cashOwner(O1, M1, "Landlord1")] } }), scenario({ isAdvance: true, n: 1, over: { owners: [cashOwner(O1, M1, "Landlord1")] } })];
  const off = stubGmail([...twoMails(), msg("mR1", "midR1", "NewBill - Cash - Paid Date: 09-Nov-2026", "2026-11-10T04:00:00.000Z", "midA")]);
  try {
    const x = setup({ docs: [site(bills, 1)], cash: true });
    const r = await run(x);
    assert.equal(res(r, NB).status, "found_and_saved");
    assert.equal(res(r, NB).replyLink.approvalMessageId, "mA");
    assert.equal(res(r, AD).status, "utr_not_found");
    assert.deepEqual([x.bill(B_NB).payments[0].paymentMode, x.bill(B_NB).payments[0].utrNumber], ["Cash", ""]);
    assert.equal(x.bill(B_NB).payments[0].date.toISOString().slice(0, 10), "2026-11-09");
    assert.deepEqual(x.bill(B_AD).payments, []);
  } finally { off(); }
});
