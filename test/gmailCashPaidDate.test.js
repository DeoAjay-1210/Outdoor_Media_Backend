// CASH payments have NO UTR: the Finance reply only says it was paid in cash (optionally with the paid date) and only the paid date
// is stored. Cash line extraction + the RENTAL BILL single-landlord Cash flow through the real Gmail lookup (Gmail stubbed).
// (New Bill / Advance Cash is covered in gmailArrearsUtr.test.js.)  Run: node --test test/gmailCashPaidDate.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-cash-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const { extractCashLines } = require("../utils/utrExtractor");
const { splitCashName } = require("../utils/landlordUtrParser");
const { createUtrProcessor } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const BILL = "ADNOOHBILL0611202601";
const UTR = "HDFC92023012200543116";

// ───────────────────────── extraction ─────────────────────────
test("CL1. Cash lines: the word Cash ends the name part, only a paid-date phrase may follow; amounts / modes / sentences are not payments", () => {
  const t = [
    "Cash",
    "Landlord1 - NewBill - Cash - Paid Date: 10-Nov-2026",
    "Landlord2 - Advance - Cash Paid on 11/11/2026",
    "Cash Amount ₹ 0",
    "Payment Category: Cash Mode",
    "Paid in cash today",
    "We will pay cash tomorrow",
    `Landlord1 - Cash - UTR: ${UTR}`,
  ].join("\n");
  const lines = extractCashLines(t);
  assert.deepEqual(lines.map((l) => l.name), ["Cash", "Landlord1 - NewBill - Cash", "Landlord2 - Advance - Cash"]);
  assert.deepEqual(lines.map((l) => l.dates.map((d) => d.date)), [[], ["2026-11-10"], ["2026-11-11"]]);
  assert.equal(lines.every((l) => l.utr === "" && l.cash === true), true);
});

test("CL2. quoted history and forwarded text never give a Cash line", () => {
  assert.deepEqual(extractCashLines("Thanks\n> Cash\nOn Mon, 9 Nov 2026 at 10:00, X <x@y.com> wrote:\nCash"), []);
  assert.deepEqual(extractCashLines("---------- Forwarded message ---------\nCash"), []);
});

test("CL3. cash names: 'Landlord1 - Cash' -> Landlord1, 'Cash' -> nobody, other endings are not cash", () => {
  assert.deepEqual(splitCashName("Landlord1 - Cash"), { landlord: "Landlord1" });
  assert.deepEqual(splitCashName("Cash"), { landlord: "" });
  assert.equal(splitCashName("Landlord1 - Rent"), null);
});

// ───────────────────────── Rental bill, one landlord, Cash ─────────────────────────
const owner = (over = {}) => ({ _id: "o1", landOwnerMasterId: "m1", name: "Landlord1", paymentCategory: 1, bankName: "SBI", accountNumber: "111111111111", ...over });
const row = (over = {}) => ({ _id: "r1", dueMonth: "November 2026", dueDate: new Date("2026-11-06T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: BILL, withGst: 2, ownerApprovalDate: new Date("2026-11-05T03:00:00.000Z"), ...over });
const site = (over = {}) => ({ _id: "s1", mediaName: "Site 1", mediaDetails: [{ status: 1, mediaCode: "C1", siteBillMode: 1 }], landOwners: [owner()], rentalDue: [row()], ledger: [], ledgerHistory: [], ...over });
const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x) ? new Date(x) : x));
const noHelpers = { isOwnerModePaidForCycle: () => false };
const fakeCounter = () => {
  const docs = new Map();
  return {
    findOneAndUpdate: (q, upd) => ({ lean: async () => { const d = docs.get(q._id); if (d && d.seq < q.seq.$lt) { d.seq = upd.$set.seq; return { ...d }; } return null; } }),
    create: async (doc) => { if (docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 }); docs.set(doc._id, { ...doc }); },
    updateOne: async (q, upd) => { if (docs.has(q._id)) docs.get(q._id).seq = upd.$set.seq; },
  };
};
const msg = (id, mid, text, at, parent = "") => ({ id, labelIds: ["INBOX"], from: "x", sentAt: at, date: at, subject: "CMD Payment Approved", messageIdHeader: `<${mid}@d.com>`, inReplyTo: parent ? `<${parent}@d.com>` : "", bodyText: text });
const approval = () => msg("mA", "midA", `Rental Payment Approved\nMI Media Information Bill No: ${BILL}\nCash Amount ₹ 5,000\nOwner Name Landlord1\nBank Name SBI\nAccount No 111111111111\nPayment Category Cash\n`, "2026-11-10T03:00:00.000Z");
const stubGmail = (messages) => {
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "s", messages: messages.map((m) => ({ ...m })), ignoredMessages: [] });
  return () => { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; };
};
const setup = ({ doc = site(), cash = true } = {}) => {
  const db = new Map([[doc._id, clone(doc)]]);
  const calls = { saver: [] };
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(db.get(id)) }) },
    Registry: { findOne: (q) => ({ lean: async () => { const m = db.get("s1"); const rows = m.rentalDue.filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills); return rows.length ? { mediaId: m._id, dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) } : null; } }) },
    Log: { create: async () => {}, findOne: () => ({ sort: () => ({ lean: async () => null }) }), find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) },
    Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => true, cashSaveEnabled: () => cash, multiLandlordSaveEnabled: () => true, gstSaveEnabled: () => true,
    now: () => NOW, logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [...db.values()].map(clone) }) }) }, Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, helpers: noHelpers, now: NOW },
    saver: async (batch) => {
      calls.saver.push(batch);
      const pay = batch.payments[0];
      db.get(pay.mediaId).ledger.push({ rentalDueId: pay.rentalDueId, landOwnerId: pay.landOwnerId, paymentMode: pay.paymentMode, utrNumber: pay.utrNumber, date: batch.date, status: 1, isUtrEntry: false });
      return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 5000 }] } };
    },
  });
  return { p, db, calls };
};
const run = (x, o = {}) => x.p.processPendingUtrs({ dryRun: false, ...o });
const one = (r) => r.results[0];

test("RC1. Rental bill, Cash landlord: 'Cash - Paid Date: ...' in the reply stores the Cash payment with that date and NO UTR", async () => {
  const off = stubGmail([approval(), msg("mR", "midR", "Cash - Paid Date: 08-Nov-2026", "2026-11-10T04:00:00.000Z")]);
  try {
    const x = setup();
    const r = await run(x);
    assert.equal(one(r).status, "found_and_saved");
    assert.equal(one(r).paymentType, "cash");
    assert.equal(one(r).dueMonth, "November 2026");
    assert.deepEqual(x.calls.saver.map((b) => [b.entryType, b.date, b.payments[0].paymentMode, b.payments[0].utrNumber, b.payments[0].rentalDueId, b.payments[0].landOwnerId]), [["rental", "2026-11-08", "Cash", "", "r1", "o1"]]);
    assert.deepEqual(x.db.get("s1").ledger.map((e) => [e.paymentMode, e.utrNumber]), [["Cash", ""]]);
  } finally { off(); }
});

test("RC2. no date on the Cash line -> the reply's sent date; 'landlord - Cash' naming this landlord is accepted", async () => {
  const off = stubGmail([approval(), msg("mR", "midR", "Landlord1 - Cash", "2026-11-10T04:00:00.000Z")]);
  try {
    const x = setup();
    assert.equal(one(await run(x)).status, "found_and_saved");
    assert.equal(x.calls.saver[0].date, "2026-11-10");
  } finally { off(); }
});

test("RC3. the approval mail's own 'Cash Amount' / 'Payment Category Cash' text is never a payment; no reply -> not found", async () => {
  const off = stubGmail([approval()]);
  try {
    const x = setup();
    assert.equal(one(await run(x)).status, "utr_not_found");
    assert.equal(x.calls.saver.length, 0);
  } finally { off(); }
});

test("RC4. a Cash line naming another person, or a sentence with 'cash', is not a payment", async () => {
  for (const text of ["Landlord9 - Cash", "Paid in cash today", "Cash Amount ₹ 5,000"]) {
    const off = stubGmail([approval(), msg("mR", "midR", text, "2026-11-10T04:00:00.000Z")]);
    try {
      const x = setup();
      assert.equal(one(await run(x)).status, "utr_not_found", text);
      assert.equal(x.calls.saver.length, 0, text);
    } finally { off(); }
  }
});

test("RC5. the Cash switch is still required (no Gmail search, no save when it is off); an ONLINE landlord is never paid by a Cash line", async () => {
  const off = stubGmail([approval(), msg("mR", "midR", "Cash - Paid Date: 08-Nov-2026", "2026-11-10T04:00:00.000Z")]);
  try {
    const x = setup({ cash: false });
    assert.equal(one(await run(x)).reason, "cash_auto_save_disabled");
    assert.equal(x.calls.saver.length, 0);
    const online = setup({ doc: site({ landOwners: [owner({ paymentCategory: 2 })] }) });
    assert.equal(one(await run(online)).status, "utr_not_found"); // no UTR -> an Online payment is never saved from a Cash line
    assert.equal(online.calls.saver.length, 0);
  } finally { off(); }
});

test("RC6. two Cash lines with different dates block (never guessed); the same date twice is fine", async () => {
  const off = stubGmail([approval(), msg("mR1", "midR1", "Cash - Paid Date: 07-Nov-2026", "2026-11-10T04:00:00.000Z"), msg("mR2", "midR2", "Cash - Paid Date: 08-Nov-2026", "2026-11-10T04:30:00.000Z")]);
  try {
    const x = setup();
    assert.equal(one(await run(x)).reason, "conflicting_cash_paid_date");
    assert.equal(x.calls.saver.length, 0);
  } finally { off(); }
  const off2 = stubGmail([approval(), msg("mR1", "midR1", "Cash - Paid Date: 08-Nov-2026", "2026-11-10T04:00:00.000Z"), msg("mR2", "midR2", "Cash paid on 08-Nov-2026", "2026-11-10T04:30:00.000Z")]);
  try {
    const y = setup();
    assert.equal(one(await run(y)).status, "found_and_saved");
    assert.equal(y.calls.saver[0].date, "2026-11-08");
  } finally { off2(); }
});

test("RC7. the existing UTR path for a Cash bill is unchanged: a UTR in the thread is still saved with its UTR (existing behaviour)", async () => {
  const off = stubGmail([approval(), msg("mR", "midR", `UTR : ${UTR}`, "2026-11-10T04:00:00.000Z")]);
  try {
    const x = setup();
    assert.equal(one(await run(x)).status, "found_and_saved");
    assert.equal(x.calls.saver[0].payments[0].utrNumber, UTR);
  } finally { off(); }
});
