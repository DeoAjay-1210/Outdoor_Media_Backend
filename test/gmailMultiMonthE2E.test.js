// END TO END, several months in ONE Gmail thread: ONE reply that names the Bill Numbers ("Landlord 1 - <BillNo> : UTR"), through the real thread scoping,
// the real lookup and the real processor. Gmail, Media, Registry, Log, Counter and the ledger saver are fakes (no network, no database).
// Run: node --test test/gmailMultiMonthE2E.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-multimonth-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const { scopeThreadToBill } = require("../utils/gmailReplyLink");
const { lookupUtrByBillNumber } = require("../utils/gmailUtrLookup");
const { createUtrProcessor } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const AUG = "ADNOOHBILL09082026103";
const SEP = "ADNOOHBILL09092026104";
const UTR1 = "SBIN92023012200543116";
const UTR2 = "HDFC92023012200543117";

// ── thread fixtures (shape of the real inspected thread) ──
const approval = (id, bill, mid, at) => ({
  id, labelIds: ["INBOX"], from: "CMD Approved <noreply@x.com>", sentAt: at, date: at, subject: "CMD Payment Approved - Test1",
  messageIdHeader: `<${mid}@adinndigital.com>`, inReplyTo: "",
  bodyText: `Hello Team, Rental Payment Approved\nBill No: ${bill}\nOwner Name | Landlord 1 | Phone | 9 | Bank Name | SBI | Account No | 123456789012 |`,
});
const reply = (id, utr, parentMid, at) => ({
  id, labelIds: ["INBOX"], from: "Finance <fin@x.com>", sentAt: at, date: at, subject: "Re: CMD Payment Approved - Test1",
  messageIdHeader: `<${id}@mail.gmail.com>`, inReplyTo: parentMid ? `<${parentMid}@adinndigital.com>` : "",
  bodyText: `UTR : ${utr}`,
});
const A = () => approval("mA", AUG, "midA", "2026-11-10T03:54:47.000Z");
const B = () => approval("mB", SEP, "midB", "2026-11-10T03:57:55.000Z");
const R1 = (parent = "midA") => reply("mR1", UTR1, parent, "2026-11-10T04:55:27.000Z"); // Aug reply
const R2 = (parent = "midB") => reply("mR2", UTR2, parent, "2026-11-10T05:10:00.000Z"); // Sep reply

const stubGmail = (messages) => {
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "CMD Payment Approved - Test1", messages: messages.map((m) => ({ ...m })), ignoredMessages: [] });
  return () => { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; };
};

// ───────────────────────── processor end to end ─────────────────────────
const owner = { _id: "o1", landOwnerMasterId: "m1", name: "Landlord 1", paymentCategory: 2 };
const dueRow = (id, month, date, bill) => ({ _id: id, dueMonth: month, dueDate: new Date(date), approvalStatus: 3, mailSent: true, adinn_ooh_bills: bill, withGst: 2 });
const makeSite = () => ({
  _id: "s1", mediaName: "Site 1",
  mediaDetails: [{ status: 1, mediaCode: "C1", siteBillMode: 1 }],
  landOwners: [owner],
  rentalDue: [dueRow("rAug", "August 2026", "2026-08-09T00:00:00Z", AUG), dueRow("rSep", "September 2026", "2026-09-09T00:00:00Z", SEP)],
  ledger: [], ledgerHistory: [],
});
const fakeCounter = () => {
  const docs = new Map();
  return {
    findOneAndUpdate: (q, upd) => ({ lean: async () => { const d = docs.get(q._id); if (d && d.seq < q.seq.$lt) { d.seq = upd.$set.seq; return { ...d }; } return null; } }),
    create: async (doc) => { if (docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 }); docs.set(doc._id, { ...doc }); },
    updateOne: async (q, upd) => { if (docs.has(q._id)) docs.get(q._id).seq = upd.$set.seq; },
  };
};
const setup = (registryOver) => {
  const db = new Map([["s1", makeSite()]]);
  const logRows = [];
  const saves = [];
  const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "dueDate" && typeof x === "string" ? new Date(x) : x));
  const Log = {
    create: async (d) => { logRows.push({ createdAt: new Date(), ...d }); },
    findOne: (q) => ({ sort: () => ({ lean: async () => logRows.filter((r) => r.billNumber === q.billNumber && r.dryRun === q.dryRun)[0] || null }) }),
    find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }),
  };
  const Registry = {
    findOne: (q) => ({
      lean: async () => {
        if (registryOver) return registryOver(q.adinn_ooh_bills);
        const m = db.get("s1");
        const rows = m.rentalDue.filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills);
        return rows.length ? { mediaId: m._id, dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) } : null;
      },
    }),
  };
  const noHelpers = { isOwnerModePaidForCycle: () => false };
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(db.get(id)) }) },
    Registry, Log, Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => true, cashSaveEnabled: () => false, multiLandlordSaveEnabled: () => false, gstSaveEnabled: () => false,
    now: () => NOW,
    logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [clone(db.get("s1"))] }) }) }, Log: { find: Log.find }, helpers: noHelpers, now: NOW },
    saver: async (batch) => {
      saves.push(batch);
      db.get("s1").ledger.push({ rentalDueId: batch.payments[0].rentalDueId, landOwnerId: batch.payments[0].landOwnerId, paymentMode: batch.payments[0].paymentMode, utrNumber: batch.payments[0].utrNumber, status: 1, isUtrEntry: false });
      return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 5000 }] } };
    },
  });
  return { p, db, saves, logRows };
};

const UC = "SBIN92023012200543900"; // ONE payment for both months
const multi = (text, parent = "midB") => reply("mM", "x", parent, "2026-11-10T05:30:00.000Z") && { ...reply("mM", "x", parent, "2026-11-10T05:30:00.000Z"), bodyText: text };

test("ME1. ONE reply, ONE common UTR for August and September: each bill is saved against ITS month, same UTR, both once", async () => {
  const off = stubGmail([A(), B(), multi(`Landlord 1 - ${AUG} : ${UC}\nLandlord 1 - ${SEP} : ${UC}`)]);
  try {
    const { p, saves, db } = setup();
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(r.results.filter((x) => x.status === "found_and_saved").length, 2);
    assert.deepEqual(saves.map((b) => [b.payments[0].rentalDueId, b.payments[0].utrNumber]).sort(), [["rAug", UC], ["rSep", UC]]);
    assert.equal(db.get("s1").ledger.length, 2);
    const again = await p.processPendingUtrs({ dryRun: false, force: true });
    assert.equal(saves.length, 2); // reprocessing the same mail creates nothing
    assert.equal(again.pendingTotal, 0);
  } finally { off(); }
});

test("ME2. the same, with the mail client's line wrapping and no spaces (the UTR on the next line)", async () => {
  const off = stubGmail([A(), B(), multi(`Landlord 1 -  ${AUG}   :\n${UC},\nLandlord 1-${SEP}:${UC}`, "midA")]);
  try {
    const { p, saves } = setup();
    await p.processPendingUtrs({ dryRun: false });
    assert.deepEqual(saves.map((b) => b.payments[0].rentalDueId).sort(), ["rAug", "rSep"]);
  } finally { off(); }
});

test("ME3. two months, TWO different UTRs in one reply: each month gets its own UTR", async () => {
  const U2 = "HDFC92023012200543901";
  const off = stubGmail([A(), B(), multi(`Landlord 1 - ${AUG} : ${UC}\nLandlord 1 - ${SEP} : ${U2}`)]);
  try {
    const { p, saves } = setup();
    await p.processPendingUtrs({ dryRun: false });
    assert.deepEqual(saves.map((b) => [b.payments[0].rentalDueId, b.payments[0].utrNumber]).sort(), [["rAug", UC], ["rSep", U2]]);
  } finally { off(); }
});

test("ME4. the reply names ONLY September: August is not touched (a UTR is never spread over every pending month)", async () => {
  const off = stubGmail([A(), B(), multi(`Landlord 1 - ${SEP} : ${UC}`)]);
  try {
    const { p, saves } = setup();
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.deepEqual(saves.map((b) => b.payments[0].rentalDueId), ["rSep"]);
    assert.equal(r.results.find((x) => x.billNumber === AUG).status, "utr_not_found");
  } finally { off(); }
});

test("ME5. a WRONG landlord name on the bill-numbered lines: nothing is saved for either month", async () => {
  const off = stubGmail([A(), B(), multi(`Dhoni - ${AUG} : ${UC}\nDhoni - ${SEP} : ${UC}`)]);
  try {
    const { p, saves } = setup();
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(saves.length, 0);
    assert.ok(r.results.every((x) => x.status !== "found_and_saved"));
  } finally { off(); }
});

test("ME6. the common UTR is already stored on an UNRELATED payment: both months are blocked (duplicate protection stays)", async () => {
  const off = stubGmail([A(), B(), multi(`Landlord 1 - ${AUG} : ${UC}\nLandlord 1 - ${SEP} : ${UC}`)]);
  try {
    const { p, saves, db } = setup();
    db.get("s1").rentalDue.push({ _id: "rOld", dueMonth: "June 2026", dueDate: new Date("2026-06-09T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: "ADNOOHBILL09062026100", withGst: 2 });
    db.get("s1").ledger.push({ rentalDueId: "rOld", landOwnerId: "o1", paymentMode: "Online", utrNumber: UC, status: 1 });
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(saves.length, 0);
    assert.ok(r.results.every((x) => x.status !== "found_and_saved"));
  } finally { off(); }
});
