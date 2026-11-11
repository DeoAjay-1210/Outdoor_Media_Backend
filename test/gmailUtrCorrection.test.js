// CORRECTED UTR: a later Finance reply that clearly replaces the stored UTR of a PAID payment overwrites exactly that payment's UTR.
// Real processor + real correction engine; Gmail thread, MongoDB, Registry and the log are in-memory fakes.
// Run: node --test test/gmailUtrCorrection.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-corr-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const { createUtrProcessor } = require("../utils/utrProcessor");
const { lookupUtrByBillNumber } = require("../utils/gmailUtrLookup");
const { CORRECTION_RE, cleanName } = require("../utils/utrCorrection");

const NOW = new Date("2026-11-10T09:00:00Z").getTime();
const BILL = "ADNOOHBILL1011202601";
const NBILL = "ADNOOHBILL1011202602";
const U1 = "HDFC92023012200543116";
const U2 = "SBIN92023012200543117";
const U3 = "ICIC92023012200543118";
const R1 = "RENTUTR1234567890";
const G1 = "GSTUTR12345678901";
const NARR = "Medavakkam Site Unipole Rent For Nov - 2026 (Rent Increased)";
const ROWN = `04-11-2026 Nov-26 Landlord1 Hoarding 5000 Landlord1 STATE BANK OF INDIA 111111111111 SBIN0001234 AXIS 9445 NEFT ADINN0411001 ${NARR}`;
const HEAD = "Dear Sir,\r\n\r\nPayment Uploaded………\r\nDate Month Ledger Name Amount Account Name Bank Account No IFSC Payment\r\nThrough Type Of Payment Bank Reference Narration\r\n";
const table = (...rows) => `${HEAD}${rows.join("\r\n")}\r\n    Total Amount              5,000.00\r\nThanks & Regards\r\nSathishKumar D`;

// ───────────────────────── fixtures ─────────────────────────
const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x) ? new Date(x) : x));
const owner = (id, name, acc, over = {}) => ({ _id: id, landOwnerMasterId: "m" + id, name, accountNumber: acc, paymentCategory: 2, bankName: "SBI", ...over });
const PAID_AT = new Date("2026-11-07T10:00:00.000Z");
const entry = (over = {}) => ({ rentalDueId: "r1", landOwnerId: "o1", paymentMode: "Online", utrNumber: U1, amount: 5000, date: PAID_AT, status: 1, remark: "", updatedBy: "Gmail UTR Auto", isUtrEntry: false, ...over });
const history = (...entries) => [{ year: 2026, months: [{ month: "November", entries }] }];

/** Rental bill, one landlord, rent paid online with U1 (live ledger + history). */
const rentalSite = (over = {}) => ({
  _id: "s1", mediaName: "Site 1", mediaDetails: [{ status: 1, mediaCode: "C1", siteBillMode: 1 }],
  landOwners: [owner("o1", "Landlord1", "111111111111")],
  rentalDue: [{ _id: "r1", dueMonth: "November 2026", dueDate: new Date("2026-11-06T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: BILL, withGst: 2, ownerApprovalDate: new Date("2026-11-05T03:00:00.000Z") }],
  ledger: [entry()], ledgerHistory: history(entry()), withGst1Ledger: [], gstBalanceHistory: [], ...over,
});
/** GST on hold: rent R1 (withGst1Ledger + history) and GST G1 (gstBalanceHistory + a ledger copy). */
const gstSite = () => rentalSite({
  rentalDue: [{ _id: "r1", dueMonth: "November 2026", dueDate: new Date("2026-11-06T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: BILL, withGst: 1, ownerApprovalDate: new Date("2026-11-05T03:00:00.000Z") }],
  ledger: [entry({ utrNumber: G1, isUtrEntry: true, withGst: 1 })],
  withGst1Ledger: [entry({ utrNumber: R1, withGst: 1 })],
  ledgerHistory: history(entry({ utrNumber: R1 }), entry({ utrNumber: G1, isUtrEntry: true })),
  gstBalanceHistory: [{ rentalDueId: "r1", ownerId: "o1", dueMonth: "November 2026", gstAmount: 900, utrNumber: G1, isPaid: true, isUtrEntry: true, remark: "", updatedBy: "Gmail UTR Auto" }],
});
const multiSite = () => rentalSite({
  landOwners: [owner("o1", "Ravi Kumar", "111111111111"), owner("o2", "Sita Devi", "222222222222")],
  ledger: [entry({ landOwnerId: "o1", utrNumber: "RAVIUTR12345678" }), entry({ landOwnerId: "o2", utrNumber: "SITAUTR12345678" })],
  ledgerHistory: history(entry({ landOwnerId: "o1", utrNumber: "RAVIUTR12345678" }), entry({ landOwnerId: "o2", utrNumber: "SITAUTR12345678" })),
});
/** New Bill / Advance: one arrears bill with a paid online rent payment N1. */
const arrearsSite = (type = "newBill", utr = "NEWUTR1234567890") => ({
  _id: "s1", mediaName: "Site 1", mediaDetails: [{ status: 1, mediaCode: "C1" }], landOwners: [owner("o1", "Landlord1", "111111111111")], rentalDue: [], ledger: [], ledgerHistory: [],
  arrearsDue: [{ _id: "a1", type, adinn_ooh_bills: NBILL, approvalStatus: 3, mailSent: true, dueMonth: "November 2026", owners: [{ landOwnerId: "o1", landOwnerName: "Landlord1", onlineAmount: 5000, paidOnline: true }], payments: [{ _id: "p1", type: "rental", landOwnerId: "o1", landOwnerName: "Landlord1", paymentMode: "Online", utrNumber: utr, amount: 5000, date: PAID_AT, remark: "", createdBy: "Gmail UTR Auto" }] }],
});

const msg = (id, text, at, from = "Pushpitha L R P <fin@adinn.co.in>") => ({ id, labelIds: ["INBOX"], from, sentAt: at, date: at, subject: "CMD Payment Approved", bodyText: text });
const approval = (bill = BILL) => msg("mA", `Rental Payment Approved\nBill No: ${bill}\nOwner Name | Landlord1 | Phone | 9 | Bank Name | SBI | IFSC Code | X | Account No | 111111111111 | PAN Number | P |`, "2026-11-07T03:00:00.000Z", "cmd@adinn.co.in");
const reply = (n, text, hh, from) => msg("m" + n, text, `2026-11-08T${hh}:00:00.000Z`, from);

const getPath = (o, path) => path.split(".").reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);
const setPath = (o, path, v) => { const ks = path.split("."); const last = ks.pop(); const t = ks.reduce((x, k) => x[k], o); t[last] = v; };

const setup = ({ doc = rentalSite(), thread, bill = BILL, logs = [], saveOn = true, corrOn = true, flow = "rental" } = {}) => {
  const db = new Map([[doc._id, clone(doc)]]);
  const logRows = logs.map((l) => ({ ...l }));
  let logSeq = 0;
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    const x = row[k];
    if (v && typeof v === "object" && v.$in) return v.$in.includes(x);
    if (v && typeof v === "object" && v.$gte) return new Date(x) >= v.$gte;
    return x === v;
  });
  const calls = { updates: [], lookups: 0 };
  const p = createUtrProcessor({
    Media: {
      findById: (id) => ({ lean: async () => clone(db.get(id)) }),
      find: () => ({ lean: async () => [...db.values()].map(clone) }),
      updateOne: async (filter, upd) => {
        calls.updates.push({ filter, set: upd.$set });
        const m = db.get(filter._id);
        if (calls.race) calls.race(m); // a concurrent writer between our read and our write
        const guards = Object.entries(filter).filter(([k]) => k !== "_id");
        if (!guards.every(([k, v]) => getPath(m, k) === v)) return { modifiedCount: 0 };
        Object.entries(upd.$set).forEach(([k, v]) => setPath(m, k, v));
        return { modifiedCount: 1 };
      },
    },
    Registry: { findOne: () => ({ lean: async () => { const m = db.get("s1"); return { mediaId: "s1", dueMonth: "November 2026", rentalDueIds: (m.rentalDue || []).map((r) => r._id) }; } }) },
    Log: {
      create: async (e) => { logRows.push({ ...e, createdAt: new Date(NOW + ++logSeq) }); },
      findOne: (q) => ({ sort: () => ({ lean: async () => null }), lean: async () => logRows.find((r) => match(r, q)) || null }),
      find: (q) => ({ sort: () => ({ select: () => ({ lean: async () => logRows.filter((r) => match(r, q)) }), lean: async () => [] }) }),
    },
    Counter: { findOneAndUpdate: () => ({ lean: async () => ({ seq: 1 }) }), create: async () => {}, updateOne: async () => {} },
    helpers: { isOwnerModePaidForCycle: () => false },
    getPending: async () => ({ bills: [], scope: "all months", totalPending: 0 }),
    correctionCheck: true,
    saveEnabled: () => saveOn, correctionSaveEnabled: () => corrOn,
    lookupThread: async () => { calls.lookups += 1; return { status: "ok", threadId: "T1", messages: thread, approval: thread.find((m) => m.id === "mA") || null }; },
    now: () => NOW, logger: { log() {}, error() {} },
  });
  const run = (o = {}) => p.processPendingUtrs({ dryRun: false, billNumbers: [bill], ...o });
  return { p, db, logRows, calls, run, media: () => db.get("s1") };
};
const corrOf = (r) => r.corrections[0];
const history0 = (x) => x.media().ledgerHistory[0].months[0].entries;

// ───────────────────────── wording ─────────────────────────
test("C1. correction wording: the phrases Finance uses are recognised; a plain UTR line is not", () => {
  for (const t of ["Previous UTR was incorrect. Please find the correct UTR below.", "Wrong UTR sent earlier", "Correct UTR: X", "Revised UTR : X", "Please consider this UTR: X", "Updated UTR: X", "Corrected transaction reference: X", "The earlier utr is wrong", "UTR correction: X"]) {
    assert.equal(CORRECTION_RE.test(t), true, t);
  }
  for (const t of ["UTR : HDFC92023012200543116", "Approved thro axis bank", "Payment Uploaded", "Landlord1 - UTR: X", "Please find the UTR below"]) assert.equal(CORRECTION_RE.test(t), false, t);
});

test("C2. cleanName strips correction chatter but keeps real landlord / bill words", () => {
  assert.equal(cleanName("Please consider this"), "");
  assert.equal(cleanName("Correct"), "");
  assert.equal(cleanName("Landlord1 - NewBill - Corrected"), "Landlord1 - NewBill");
  assert.equal(cleanName("Sita - Corrected"), "Sita");
  assert.equal(cleanName("Ravi Kumar"), "Ravi Kumar");
});

// ───────────────────────── Rental bill ─────────────────────────
test("T1. the first UTR reply alone is not a correction (the stored UTR stands, nothing is written)", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04")] });
  const r = await x.run();
  assert.deepEqual(r.corrections, []);
  assert.equal(x.calls.updates.length, 0);
  assert.equal(x.media().ledger[0].utrNumber, U1);
});

test("T2. a later explicit correction replaces the old UTR in the live ledger AND the history, nothing else changes", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Previous UTR was incorrect. Please find the correct UTR below.\n\nUTR: ${U2}`, "06", "Sathishkumar D <srbedev@adinn.co.in>")] });
  const before = clone(x.media());
  const r = await x.run();
  assert.equal(corrOf(r).status, "correction_applied");
  assert.deepEqual([corrOf(r).existingUtr, corrOf(r).correctedUtr], [U1, U2]);
  const m = x.media();
  assert.equal(m.ledger.length, 1);
  assert.equal(m.ledger[0].utrNumber, U2);
  assert.equal(history0(x).length, 1);
  assert.equal(history0(x)[0].utrNumber, U2); // historical record consistent with the live one
  // preserved: amount, landlord, month link, payment mode, paid date
  ["amount", "landOwnerId", "rentalDueId", "paymentMode"].forEach((k) => { assert.equal(m.ledger[0][k], before.ledger[0][k]); assert.equal(history0(x)[0][k], before.ledger[0][k]); });
  assert.equal(new Date(m.ledger[0].date).getTime(), PAID_AT.getTime()); // T11: no Paid Date in the reply -> kept
  assert.equal(new Date(history0(x)[0].date).getTime(), PAID_AT.getTime());
  assert.equal(m.ledger[0].updatedBy, "Sathishkumar D"); // the correction mail's sender
  assert.equal(m.ledger[0].remark, ""); // no narration in the mail -> remark kept
  assert.deepEqual(x.logRows.map((l) => [l.status, l.correction && l.correction.oldUtr, l.correction && l.correction.newUtr, l.sourceMessageId]), [["correction_applied", U1, U2, "m2"]]);
});

test("T3. the same correction processed again (cron every minute) changes nothing and writes no second row", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  await x.run();
  const after = JSON.stringify(x.media());
  const updates = x.calls.updates.length;
  await x.run();
  await x.run({ force: true });
  assert.equal(JSON.stringify(x.media()), after);
  assert.equal(x.calls.updates.length, updates);
  assert.equal(x.logRows.filter((l) => l.status === "correction_applied").length, 1);
});

test("T3b. a correction mail is applied ONCE: if the UTR is edited back by hand, the same mail does not overwrite it again", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  await x.run();
  x.media().ledger[0].utrNumber = U1;
  x.media().ledgerHistory[0].months[0].entries[0].utrNumber = U1;
  const r = await x.run();
  assert.equal(corrOf(r).status, "correction_already_applied");
  assert.equal(x.media().ledger[0].utrNumber, U1);
});

test("T4. a later reply with just a different UTR (no wording at all) overwrites the old UTR; the same UTR again changes nothing", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `UTR : ${U2}`, "06", "Sathishkumar D <srbedev@adinn.co.in>")] });
  const r = await x.run();
  assert.equal(corrOf(r).status, "correction_applied");
  assert.equal(x.media().ledger[0].utrNumber, U2);
  assert.equal(history0(x)[0].utrNumber, U2);
  assert.equal(x.media().ledger[0].updatedBy, "Sathishkumar D");
  await x.run();
  assert.equal(x.logRows.filter((l) => l.status === "correction_applied").length, 1);
});

test("T5. several correction replies: the LATEST clearly identified correction wins", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Wrong UTR. Correct UTR: ${U2}`, "05"), reply(3, `Revised UTR: ${U3}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).correctedUtr, U3);
  assert.equal(x.media().ledger[0].utrNumber, U3);
  // plain UTR lines only: the last one wins
  const y = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `UTR: ${U2}`, "05"), reply(3, `UTR: ${U3}`, "06")] });
  await y.run();
  assert.equal(y.media().ledger[0].utrNumber, U3);
});

test("T5b. an OLDER reply never overwrites: a correction followed by the stored UTR again keeps the stored one", async () => {
  const x = setup({ thread: [approval(), reply(1, `Correct UTR: ${U2}`, "04"), reply(2, `UTR : ${U1}`, "06")] });
  const r = await x.run();
  assert.deepEqual(r.corrections, []);
  assert.equal(x.media().ledger[0].utrNumber, U1);
});

test("T5c. 'Please consider this UTR: X' (chatter before the label) is read as an unnamed correction line", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Please consider this UTR: ${U2}`, "06")] });
  await x.run();
  assert.equal(x.media().ledger[0].utrNumber, U2);
});

test("T6. several landlords: only the landlord named in the correction is updated", async () => {
  const x = setup({ doc: multiSite(), thread: [approval(), reply(1, "Ravi - UTR: RAVIUTR12345678\nSita - UTR: SITAUTR12345678", "04"), reply(2, `Sita - Corrected UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).landlord, "Sita Devi");
  const m = x.media();
  assert.deepEqual(m.ledger.map((e) => [e.landOwnerId, e.utrNumber]), [["o1", "RAVIUTR12345678"], ["o2", U2]]);
  assert.deepEqual(history0(x).map((e) => [e.landOwnerId, e.utrNumber]), [["o1", "RAVIUTR12345678"], ["o2", U2]]);
});

test("T6b. a correction line naming nobody with several landlords is manual review, nothing changes", async () => {
  const x = setup({ doc: multiSite(), thread: [approval(), reply(1, "Ravi - UTR: RAVIUTR12345678\nSita - UTR: SITAUTR12345678", "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).status, "correction_review");
  assert.equal(x.calls.updates.length, 0);
});

test("T7. GST on hold: a GST correction updates the GST records only (GST row + its ledger copies), never the Rent UTR", async () => {
  const x = setup({ doc: gstSite(), thread: [approval(), reply(1, `Rent - UTR: ${R1}\nGST - UTR: ${G1}`, "04"), reply(2, `GST - Correct UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).paymentKind, "gst");
  const m = x.media();
  assert.equal(m.gstBalanceHistory[0].utrNumber, U2);
  assert.equal(m.ledger[0].utrNumber, U2); // GST copy in the live ledger
  assert.deepEqual(history0(x).map((e) => e.utrNumber), [R1, U2]);
  assert.equal(m.withGst1Ledger[0].utrNumber, R1); // rent untouched
});

test("T8. GST on hold: a Rent correction updates the Rent records only", async () => {
  const x = setup({ doc: gstSite(), thread: [approval(), reply(1, `Rent - UTR: ${R1}\nGST - UTR: ${G1}`, "04"), reply(2, `Rent - Wrong UTR, correct UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).paymentKind, "rent");
  const m = x.media();
  assert.equal(m.withGst1Ledger[0].utrNumber, U2);
  assert.deepEqual(history0(x).map((e) => e.utrNumber), [U2, G1]);
  assert.equal(m.gstBalanceHistory[0].utrNumber, G1);
  assert.equal(m.ledger[0].utrNumber, G1);
});

test("T8b. GST on hold: an unlabelled correction could be Rent or GST -> manual review", async () => {
  const x = setup({ doc: gstSite(), thread: [approval(), reply(1, `Rent - UTR: ${R1}\nGST - UTR: ${G1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).status, "correction_review");
  assert.equal(x.calls.updates.length, 0);
});

for (const [type, word] of [["newBill", "NewBill"], ["advance", "Advance"]]) {
  test(`T9/T10. ${word}: the correction replaces the payment's UTR on the arrears bill (other fields kept)`, async () => {
    const x = setup({ doc: arrearsSite(type), bill: NBILL, thread: [approval(NBILL), reply(1, `${word} - UTR: NEWUTR1234567890`, "04"), reply(2, `Landlord1 - ${word} - Corrected UTR: ${U2}`, "06", "Accounts Lead <acc@adinn.co.in>")] });
    const r = await x.run();
    assert.equal(corrOf(r).status, "correction_applied");
    assert.equal(corrOf(r).billKind, type);
    const p = x.media().arrearsDue[0].payments[0];
    assert.deepEqual([p.utrNumber, p.amount, p.paymentMode, p.landOwnerId, p.createdBy, p.updatedBy], [U2, 5000, "Online", "o1", "Gmail UTR Auto", "Accounts Lead"]);
    assert.equal(x.media().arrearsDue[0].payments.length, 1);
  });
}

test("T9b. a New Bill UTR is never corrected by an Advance line (bill type mismatch -> manual review)", async () => {
  const x = setup({ doc: arrearsSite("newBill"), bill: NBILL, thread: [approval(NBILL), reply(1, "NewBill - UTR: NEWUTR1234567890", "04"), reply(2, `Advance - Corrected UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).status, "correction_review");
  assert.equal(x.media().arrearsDue[0].payments[0].utrNumber, "NEWUTR1234567890");
});

test("T11/T12. Paid Date: kept when the correction gives none; replaced when it states a valid one", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2} - Paid Date: 07-Nov-2026`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).wouldUpdate.paidDate, "2026-11-07");
  assert.equal(istDay(x.media().ledger[0].date), "2026-11-07");
  assert.equal(istDay(history0(x)[0].date), "2026-11-07");
  // a date in the future / before approval is not used
  const y = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2} - Paid Date: 01-Nov-2026`, "06")] });
  await y.run();
  assert.equal(new Date(y.media().ledger[0].date).getTime(), PAID_AT.getTime());
});
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);

test("T13. Bank Narration of the correction mail updates the remark; without a narration the old remark stays", async () => {
  const doc = rentalSite({ ledger: [entry({ remark: "old remark" })], ledgerHistory: history(entry({ remark: "old remark" })) });
  const x = setup({ doc, thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}\r\n\r\n${table(ROWN)}`, "06")] });
  await x.run();
  assert.equal(x.media().ledger[0].remark, NARR);
  assert.equal(history0(x)[0].remark, NARR);
  const y = setup({ doc, thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  await y.run();
  assert.equal(y.media().ledger[0].remark, "old remark");
});

test("T14. dry run: the correction is reported (existing / corrected UTR, eligibility, component) and NOTHING is written", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  const before = JSON.stringify(x.media());
  const r = await x.run({ dryRun: true });
  const c = corrOf(r);
  assert.equal(c.status, "correction_found");
  assert.equal(c.dryRun, true);
  assert.equal(c.eligible, true);
  assert.deepEqual([c.existingUtr, c.correctedUtr, c.landlord, c.paymentKind, c.dueMonth], [U1, U2, "Landlord1", "rent", "November 2026"]);
  assert.equal(c.wouldUpdate.records, 2);
  assert.equal(JSON.stringify(x.media()), before);
  assert.equal(x.calls.updates.length, 0);
  assert.equal(x.logRows.length, 0);
});

test("T14b. the save switches are respected: SAVE off or CORRECTION switch off -> reported, nothing written", async () => {
  for (const o of [{ saveOn: false }, { corrOn: false }]) {
    const x = setup({ ...o, thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
    const r = await x.run();
    assert.equal(corrOf(r).status, "correction_found");
    assert.ok(corrOf(r).savingBlockedBy.length >= 1 || o.saveOn === false);
    assert.equal(x.media().ledger[0].utrNumber, U1);
    assert.equal(x.calls.updates.length, 0);
  }
});

test("T15. a correction to a UTR already used by another payment of the site is manual review", async () => {
  const x = setup({ doc: gstSite(), thread: [approval(), reply(1, `Rent - UTR: ${R1}\nGST - UTR: ${G1}`, "04"), reply(2, `GST - Correct UTR: ${R1}`, "06")] });
  const r = await x.run();
  assert.equal(corrOf(r).reason, "utr_already_used_on_this_site");
  assert.equal(x.media().gstBalanceHistory[0].utrNumber, G1);
});

test("T16. a concurrent manual edit is never overwritten (compare-and-set on the old UTR): nothing is written, error reported", async () => {
  const x = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  x.calls.race = (m) => { m.ledger[0].utrNumber = "MANUALUTR123456789"; };
  const r = await x.run();
  assert.equal(corrOf(r).status, "database_error");
  assert.equal(corrOf(r).reason, "changed_concurrently_nothing_written");
  assert.equal(x.media().ledger[0].utrNumber, "MANUALUTR123456789");
  assert.equal(history0(x)[0].utrNumber, U1); // all-or-nothing: the history record was not touched either
  assert.equal(x.logRows.filter((l) => l.status === "correction_applied").length, 0);
});

test("T17. only recently auto-saved bills are checked by the scheduled run; a bill with no paid UTR is ignored", async () => {
  const x = setup({ doc: rentalSite({ ledger: [], ledgerHistory: [] }), thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")] });
  const r = await x.run();
  assert.deepEqual(r.corrections, []);
  assert.equal(x.calls.lookups, 0); // nothing paid -> Gmail not even called
  const old = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")], logs: [{ billNumber: BILL, status: "found_and_saved", dryRun: false, mediaId: "s1", createdAt: new Date(NOW - 30 * 86400000) }] });
  const r2 = await old.p.processPendingUtrs({ dryRun: false });
  assert.deepEqual(r2.corrections, []); // saved 30 days ago: outside the window
  const fresh = setup({ thread: [approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Correct UTR: ${U2}`, "06")], logs: [{ billNumber: BILL, status: "found_and_saved", dryRun: false, mediaId: "s1", createdAt: new Date(NOW - 3600000) }] });
  const r3 = await fresh.p.processPendingUtrs({ dryRun: false });
  assert.equal(r3.corrections[0].status, "correction_applied");
});

// ───────────────────────── first-time save: the corrected UTR is the one ─────────────────────────
const stubGmail = (messages) => {
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "s", messages: messages.map((m) => ({ ...m })), ignoredMessages: [] });
  return () => { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; };
};
test("T18. nothing saved yet and the thread has two UTRs in one conversation: the last reply's UTR is the one (wording or not)", async () => {
  const off = stubGmail([approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `Previous UTR was incorrect.\nUTR: ${U2}`, "06")]);
  try {
    const r = await lookupUtrByBillNumber(BILL);
    assert.equal(r.data.extractionStatus, "found");
    assert.equal(r.data.utr, U2);
    assert.equal(r.data.correctedFromEarlier, true);
  } finally { off(); }
  const off2 = stubGmail([approval(), reply(1, `UTR : ${U1}`, "04"), reply(2, `UTR: ${U2}`, "06")]);
  try {
    assert.equal((await lookupUtrByBillNumber(BILL)).data.utr, U2);
  } finally { off2(); }
});
