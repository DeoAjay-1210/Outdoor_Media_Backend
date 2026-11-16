// BANK NARRATION of the Finance "Payment Uploaded" table -> the ledger `remark` of the payment saved by the Gmail UTR automation.
// Gmail is stubbed (the real lookup + thread scoping run); saving uses a recording saver for Rental Bills and the REAL ledger engine for
// New Bill / Advance (their payment rows carry the remark). Run: node --test test/gmailNarration.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-narr-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const MediaModel = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const OverDue = require("../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { executeBulkPaymentBatch } = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
const { extractBankRows, collectBankRows, narrationFor } = require("../utils/bankNarration");
const { createUtrProcessor } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const NARR = "Medavakkam Site Unipole Rent For Nov - 2026 (Rent Increased)";
const ROW1 = `04-11-2026 Nov-26 B SIVAKUMAR HOARDING LANDLORD 15000 B SIVAKUMAR INDIAN\r\nBANK  6566930110 <(656)%20693-0110> IDIB000N079 AXIS 9445 NEFT\r\nADINN041161985 Medavakkam Site Unipole Rent For Nov - 2026 (Rent Increased)`;
const HEAD = "Dear Sir,\r\n\r\nPayment Uploaded………\r\nDate Month Ledger Name Amount Account Name Bank Account No IFSC Payment\r\nThrough Type Of Payment Bank Reference Narration\r\n";
const table = (...rows) => `${HEAD}${rows.join("\r\n")}\r\n    Total Amount              15,000.00\r\nThanks & Regards\r\nSathishKumar D`;
const ROW_A = "04-11-2026 Nov-26 Ravi Kumar Hoarding 5000 Ravi Kumar STATE BANK OF INDIA 111111111111 SBIN0001234 AXIS 9445 NEFT ADINN0411001 Nov rent for Ravi Kumar site";
const ROW_B = "04-11-2026 Nov-26 Sita Devi Hoarding 6000 Sita Devi HDFC BANK 222222222222 HDFC0001234 AXIS 9445 NEFT ADINN0411002 Nov rent for Sita Devi site";

// ───────────────────────── extraction ─────────────────────────
test("N1. the real plain-text row: wrapped lines, phone-link artefact, narration kept exactly; the heading is never the value", () => {
  const rows = extractBankRows(table(ROW1));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].narration, NARR);
  assert.deepEqual([rows[0].reference, rows[0].accountNo, rows[0].ifsc, rows[0].paymentThrough, rows[0].type, rows[0].amount], ["ADINN041161985", "6566930110", "IDIB000N079", "AXIS 9445", "NEFT", 15000]);
  assert.notEqual(rows[0].narration, "Narration");
});

test("N2. an HTML table (cells joined by ' | ' via htmlToText) gives the same narration", () => {
  const html = "<p>Payment Uploaded</p><table><tr><th>Date</th><th>Month</th><th>Ledger Name</th><th>Amount</th><th>Account Name</th><th>Bank</th><th>Account No</th><th>IFSC</th><th>Payment Through</th><th>Type Of Payment</th><th>Bank Reference</th><th>Narration</th></tr>" +
    "<tr><td>04-11-2026</td><td>Nov-26</td><td>B SIVAKUMAR HOARDING LANDLORD</td><td>15000</td><td>B SIVAKUMAR</td><td>INDIAN BANK</td><td>6566930110</td><td>IDIB000N079</td><td>AXIS 9445</td><td>NEFT</td><td>ADINN041161985</td><td>Medavakkam Site Unipole Rent For Nov - 2026 (Rent&nbsp;Increased)</td></tr></table><p>Total Amount 15,000.00</p>";
  const text = Gmail.htmlToText(html);
  const rows = extractBankRows(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].narration, NARR);
  assert.equal(rows[0].accountNo, "6566930110");
});

test("N3. the table quoted again in a later reply is the same row (deduplicated); the approval-mail text has no rows", () => {
  const quoted = "UTR : HDFC92023012200543116\r\n\r\nOn Thu, Nov 5, 2026 at 1:53 PM X <x@y.com> wrote:\r\n\r\n> " + table(ROW1).split("\r\n").join("\r\n> ");
  const { rows } = collectBankRows([{ id: "m1", bodyText: table(ROW1) }, { id: "m2", bodyText: quoted }, { id: "m3", bodyText: "Rental Payment Approved Owner Name X Bank Name SBI Account No 111111111111" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].narration, NARR);
});

test("N4. two bank rows (two landlords) are read as two rows; a row that cannot be parsed is reported, not guessed", () => {
  const rows = extractBankRows(table(ROW_A, ROW_B));
  assert.deepEqual(rows.map((r) => [r.accountNo, r.narration]), [["111111111111", "Nov rent for Ravi Kumar site"], ["222222222222", "Nov rent for Sita Devi site"]]);
  assert.equal(extractBankRows(table("04-11-2026 garbage without bank fields"))[0].unparsed.startsWith("04-11-2026"), true);
});

test("N5. no table / a table without narration -> no narration", () => {
  assert.deepEqual(extractBankRows("UTR : HDFC92023012200543116"), []);
  const empty = extractBankRows(table("04-11-2026 Nov-26 B SIVAKUMAR 15000 B SIVAKUMAR INDIAN BANK 6566930110 IDIB000N079 AXIS 9445 NEFT ADINN041161985"));
  assert.equal(empty[0].narration, "");
  assert.equal(narrationFor(empty, [{ landOwnerId: "o1", name: "B SIVAKUMAR" }], { landOwnerId: "o1" }).narration, "");
});

// ───────────────────────── landlord mapping ─────────────────────────
const L2 = [{ landOwnerId: "o1", name: "Ravi Kumar", accountLast4: "1111" }, { landOwnerId: "o2", name: "Sita Devi", accountLast4: "2222" }];
test("N6. several landlords: each narration goes to the landlord its row names (account / name), never the first row for everybody", () => {
  const rows = collectBankRows([{ id: "m", bodyText: table(ROW_B, ROW_A) }]).rows; // order differs from the landlord order
  assert.equal(narrationFor(rows, L2, { landOwnerId: "o1" }).narration, "Nov rent for Ravi Kumar site");
  assert.equal(narrationFor(rows, L2, { landOwnerId: "o2" }).narration, "Nov rent for Sita Devi site");
});

test("N7. several landlords, a row that names nobody / two landlords / one landlord only: nothing is guessed", () => {
  const stranger = "04-11-2026 Nov-26 Unknown Person 5000 Unknown Person SBI 999999999999 SBIN0009999 AXIS 9445 NEFT ADINN0411003 something";
  const rows = collectBankRows([{ id: "m", bodyText: table(stranger) }]).rows;
  assert.equal(narrationFor(rows, L2, { landOwnerId: "o1" }).narration, "");
  assert.equal(narrationFor(rows, L2, { landOwnerId: "o1" }).reason, "narration_landlord_not_identified");
  // account of one landlord, name of the other -> ambiguous
  const mixed = "04-11-2026 Nov-26 Sita Devi 5000 Sita Devi SBI 111111111111 SBIN0009999 AXIS 9445 NEFT ADINN0411004 mixed row";
  const m = collectBankRows([{ id: "m", bodyText: table(mixed) }]).rows;
  assert.equal(narrationFor(m, L2, { landOwnerId: "o1" }).reason, "narration_landlord_ambiguous");
  // only landlord 1 has a row: landlord 2 gets nothing (and never landlord 1's text)
  const only = collectBankRows([{ id: "m", bodyText: table(ROW_A) }]).rows;
  assert.equal(narrationFor(only, L2, { landOwnerId: "o1" }).narration, "Nov rent for Ravi Kumar site");
  assert.equal(narrationFor(only, L2, { landOwnerId: "o2" }).narration, "");
  // two landlords with the same first name: the full account / name decides, a bare first name does not
  const same = [{ landOwnerId: "o1", name: "Ravi Kumar", accountLast4: null }, { landOwnerId: "o2", name: "Ravi Shankar", accountLast4: null }];
  const sr = collectBankRows([{ id: "m", bodyText: table("04-11-2026 Nov-26 Ravi 5000 Ravi SBI 111111111111 SBIN0009999 AXIS 9445 NEFT ADINN0411005 x") }]).rows;
  assert.equal(narrationFor(sr, same, { landOwnerId: "o1" }).narration, "");
});

test("N8. one landlord with Rent and GST paid together and ONE bank row: the row cannot be attributed, so none is saved; two rows are told apart by amount", () => {
  const one = [{ landOwnerId: "o1", name: "Ravi Kumar", accountLast4: null }];
  const rows = collectBankRows([{ id: "m", bodyText: table(ROW_A) }]).rows;
  assert.equal(narrationFor(rows, one, { landOwnerId: "o1", siblings: 2, amount: 5000 }).reason, "narration_row_not_attributable_to_rent_or_gst");
  const two = collectBankRows([{ id: "m", bodyText: table(ROW_A, ROW_A.replace("5000", "900").replace("ADINN0411001", "ADINN0411009").replace("Nov rent for Ravi Kumar site", "GST for Ravi Kumar site")) }]).rows;
  assert.equal(narrationFor(two, one, { landOwnerId: "o1", siblings: 1, amount: 900 }).narration, "GST for Ravi Kumar site");
  assert.equal(narrationFor(two, one, { landOwnerId: "o1", siblings: 1, amount: 777 }).reason, "narration_rows_ambiguous");
});

// ───────────────────────── Rental Bill, through the real Gmail lookup ─────────────────────────
const BILL = "ADNOOHBILL0611202601";
const UTR = "HDFC92023012200543116";
const owner = (id, name, acc, over = {}) => ({ _id: id, landOwnerMasterId: "m" + id, name, paymentCategory: 2, bankName: "SBI", accountNumber: acc, ...over });
const row = (over = {}) => ({ _id: "r1", dueMonth: "November 2026", dueDate: new Date("2026-11-06T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: BILL, withGst: 2, ownerApprovalDate: new Date("2026-11-05T03:00:00.000Z"), ...over });
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
const msg = (id, mid, text, at, parent = "", from = "x") => ({ id, labelIds: ["INBOX"], from, sentAt: at, date: at, subject: "CMD Payment Approved", messageIdHeader: `<${mid}@d.com>`, inReplyTo: parent ? `<${parent}@d.com>` : "", bodyText: text });
const approvalText = (bill, owners) => `Rental Payment Approved\nBill No: ${bill}\n` + owners.map((o) => `Owner Name | ${o[0]} | Phone | 9 | Bank Name | SBI | IFSC Code | X | Account No | ${o[1]} | PAN Number | P |`).join("\n");
const stubGmail = (messages) => {
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "s", messages: messages.map((m) => ({ ...m })), ignoredMessages: [] });
  return () => { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; };
};
// Finance chain: approval -> "Payment Uploaded" (bank table) -> "Approved" -> "UTR : ..."
const chain = (approvalMsg, tableText, utrText, rootMid = "midA", at = "2026-11-10T04:") => [
  approvalMsg,
  msg("mT", "midT", tableText, at + "00:00.000Z", rootMid),
  msg("mOK", "midOK", "Approved thro axis bank", at + "10:00.000Z", "midT"),
  msg("mU", "midU", utrText, at + "20:00.000Z", "midOK"),
];

const setupRental = ({ doc, saver } = {}) => {
  const db = new Map([[doc._id, clone(doc)]]);
  const calls = { saver: [], actors: [] };
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(db.get(id)) }) },
    Registry: { findOne: (q) => ({ lean: async () => { const m = db.get(doc._id); const rows = m.rentalDue.filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills); return rows.length ? { mediaId: m._id, dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) } : null; } }) },
    Log: { create: async () => {}, findOne: () => ({ sort: () => ({ lean: async () => null }) }), find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) },
    Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => true, cashSaveEnabled: () => true, multiLandlordSaveEnabled: () => true, gstSaveEnabled: () => true,
    now: () => NOW, logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [...db.values()].map(clone) }) }) }, Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, helpers: noHelpers, now: NOW },
    saver: async (batch, actor) => { calls.saver.push(batch); calls.actors.push(actor); return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 5000 }] } }; },
  });
  return { p, calls };
};
const rentalSite = (owners, over = {}) => ({ _id: "s1", mediaName: "Site 1", mediaDetails: [{ status: 1, mediaCode: "C1", siteBillMode: 1 }], landOwners: owners, rentalDue: [row()], ledger: [], ledgerHistory: [], ...over });
const run = (x) => x.p.processPendingUtrs({ dryRun: false });
const A1 = () => msg("mA", "midA", approvalText(BILL, [["B SIVAKUMAR", "6566930110"]]), "2026-11-10T03:00:00.000Z");

test("N9. Normal Rental Bill, one landlord: the UTR is saved with the bank narration as the ledger remark (the static text is replaced)", async () => {
  const off = stubGmail(chain(A1(), table(ROW1), `UTR : ${UTR}`));
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")]) });
    const r = await run(x);
    assert.equal(r.results[0].status, "found_and_saved");
    assert.equal(x.calls.saver.length, 1);
    assert.equal(x.calls.saver[0].remark, NARR); // exactly the Finance narration
    assert.equal(x.calls.saver[0].payments[0].utrNumber, UTR);
    assert.equal(r.results[0].narration, NARR);
  } finally { off(); }
});

test("N10. no bank table in the thread: the remark stays empty (no static text)", async () => {
  const off = stubGmail([A1(), msg("mU", "midU", `UTR : ${UTR}`, "2026-11-10T04:20:00.000Z", "midA")]);
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")]) });
    await run(x);
        assert.equal(x.calls.saver[0].remark, "");
  } finally { off(); }
});

test("N11. dry run shows the narration and saves nothing", async () => {
  const off = stubGmail(chain(A1(), table(ROW1), `UTR : ${UTR}`));
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")]) });
    const r = await x.p.processPendingUtrs({});
    assert.equal(r.results[0].narration, NARR);
    assert.equal(x.calls.saver.length, 0);
  } finally { off(); }
});

test("N12. Rental Bill, two landlords: each landlord's UTR is saved with ITS OWN narration", async () => {
  const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
  const off = stubGmail(chain(msg("mA", "midA", approvalText(BILL, names), "2026-11-10T03:00:00.000Z"), table(ROW_B, ROW_A), "Ravi - UTR: UTRRAVI12345678\nSita - UTR: UTRSITA12345678"));
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "Ravi Kumar", "111111111111"), owner("o2", "Sita Devi", "222222222222")]) });
    const r = await run(x);
    assert.equal(r.results[0].status, "found_and_saved");
    const by = (id) => x.calls.saver.find((b) => b.payments[0].landOwnerId === id);
    assert.deepEqual([by("o1").payments[0].utrNumber, by("o1").remark], ["UTRRAVI12345678", "Nov rent for Ravi Kumar site"]);
    assert.deepEqual([by("o2").payments[0].utrNumber, by("o2").remark], ["UTRSITA12345678", "Nov rent for Sita Devi site"]);
  } finally { off(); }
});

test("N13. Rental Bill, two landlords, narration rows that cannot be mapped: the UTRs are still saved but NO narration is guessed", async () => {
  const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
  const stranger = "04-11-2026 Nov-26 Unknown Person 5000 Unknown Person SBI 999999999999 SBIN0009999 AXIS 9445 NEFT ADINN0411003 something else";
  const off = stubGmail(chain(msg("mA", "midA", approvalText(BILL, names), "2026-11-10T03:00:00.000Z"), table(stranger), "Ravi - UTR: UTRRAVI12345678\nSita - UTR: UTRSITA12345678"));
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "Ravi Kumar", "111111111111"), owner("o2", "Sita Devi", "222222222222")]) });
    const r = await run(x);
    assert.equal(r.results[0].status, "found_and_saved");
    assert.equal(x.calls.saver.length, 2);
        assert.ok(x.calls.saver.every((b) => b.remark === ""));
    assert.equal(r.results[0].landlordMappings[0].narrationNote, "narration_landlord_not_identified");
  } finally { off(); }
});

test("N14. past pending bill in a thread with TWO approval mails: the chain approval -> table -> Approved -> UTR still ends at its own approval", async () => {
  const OLD = "ADNOOHBILL1006202610";
  const site = rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")], { rentalDue: [row(), row({ _id: "r0", dueMonth: "June 2026", dueDate: new Date("2026-06-06T00:00:00Z"), adinn_ooh_bills: OLD, ownerApprovalDate: new Date("2026-06-05T03:00:00.000Z") })] });
  const mails = [msg("mO", "midO", approvalText(OLD, [["B SIVAKUMAR", "6566930110"]]), "2026-06-10T03:00:00.000Z"), msg("mA", "midA", approvalText(BILL, [["B SIVAKUMAR", "6566930110"]]), "2026-11-10T03:00:00.000Z")];
  const chainOld = [msg("mT", "midT", table(ROW1), "2026-11-10T04:00:00.000Z", "midO"), msg("mOK", "midOK", "Approved thro axis bank", "2026-11-10T04:10:00.000Z", "midT"), msg("mU", "midU", `UTR : ${UTR}`, "2026-11-10T04:20:00.000Z", "midOK")];
  const off = stubGmail([...mails, ...chainOld]);
  try {
    const x = setupRental({ doc: site });
    const r = await run(x);
    const old = r.results.find((y) => y.billNumber === OLD);
    assert.equal(old.status, "found_and_saved");
    assert.equal(x.calls.saver.length, 1);
    assert.equal(x.calls.saver[0].remark, NARR);
    assert.equal(x.calls.saver[0].payments[0].rentalDueId, "r0");
    assert.equal(r.results.find((y) => y.billNumber === BILL).status, "utr_not_found"); // the June chain is not the November bill's
  } finally { off(); }
});

// ───────────────────────── New Bill / Advance through the REAL ledger engine ─────────────────────────
let DB = new Map();
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
  const i = m.arrearsDue.findIndex((b) => String(b._id) === String(opts.arrayFilters[0]["a._id"]));
  m.arrearsDue[i] = clone(upd.$set["arrearsDue.$[a]"]);
};
OverDue.findOneAndUpdate = async () => null;

const SITE = "507f1f77bcf86cd799439011";
const O1 = "507f1f77bcf86cd799439021";
const O2 = "507f1f77bcf86cd799439022";
const arrOwner = (id, name) => ({ landOwnerId: id, landOwnerMasterId: "m" + id, landOwnerName: name, shareAmount: 2500, cashAmount: 0, onlineAmount: 2500, gstAmount: 0, paidCash: false, paidOnline: false });
const arrSite = (isAdvance, n) => {
  const names = [[O1, "Ravi Kumar", "111111111111"], [O2, "Sita Devi", "222222222222"]].slice(0, n);
  return {
    _id: SITE, mediaName: "S", mediaDetails: [{ status: 1, mediaCode: "C", siteBillMode: 1 }],
    landOwners: names.map(([id, nm, acc]) => ({ _id: id, landOwnerMasterId: "m" + id, name: nm, paymentCategory: 2, bankName: "SBI", accountNumber: acc })),
    rentalPayment: { paymentFrequency: 1, nextBillingDate: new Date("2026-12-09T00:00:00.000Z"), gstOutstandingHistory: [], rentalOutstandingHistory: [] },
    rentalDue: [], ledger: [], ledgerHistory: [], withGst1Ledger: [], gstBalanceHistory: [],
    arrearsDue: [{ _id: "507f1f77bcf86cd799439061", type: isAdvance ? "advance" : "arrears", label: "Bill (November 2026)", dueMonth: "November 2026", rentRevisionId: "507f1f77bcf86cd799439041", adinn_ooh_bills: isAdvance ? "ADNOOHBILL1111202613" : "ADNOOHBILL1111202612", approvalStatus: 3, mailSent: true, withGst: 2, netPayable: 2500 * n, gstAmount: 0, gstPaid: 0, rentPaid: 0, owners: names.map(([id, nm]) => arrOwner(id, nm)), payments: [], ownerApprovalDate: new Date("2026-11-05T03:00:00.000Z"), createdAt: new Date("2026-11-05T03:00:00.000Z") }],
  };
};
const setupArrears = (isAdvance, n) => {
  DB = new Map([[SITE, arrSite(isAdvance, n)]]);
  return createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(DB.get(String(id))) }) },
    Registry: { findOne: (q) => ({ lean: async () => { const m = DB.get(SITE); const b = m.arrearsDue[0]; return b.adinn_ooh_bills === q.adinn_ooh_bills ? { mediaId: SITE, groupKey: `${SITE}|${isAdvance ? "advance" : "newbill"}:${b.rentRevisionId}`, billMode: isAdvance ? "advance" : "new_bill", dueMonth: b.dueMonth, rentalDueIds: [b._id] } : null; } }) },
    Log: { create: async () => {}, findOne: () => ({ sort: () => ({ lean: async () => null }) }), find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) },
    Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => true, cashSaveEnabled: () => true, multiLandlordSaveEnabled: () => true, gstSaveEnabled: () => true,
    now: () => NOW, logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [...DB.values()].map(clone) }) }) }, Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }) }, helpers: noHelpers, now: NOW },
    saver: (batch, actor) => executeBulkPaymentBatch({ user: { userName: actor || "Gmail UTR Auto" } }, batch),
  });
};

for (const isAdvance of [false, true]) {
  const bill = isAdvance ? "ADNOOHBILL1111202613" : "ADNOOHBILL1111202612";
  const word = isAdvance ? "Advance" : "NewBill";
  test(`N15. ${isAdvance ? "Advance" : "New Bill"}, two landlords: each payment row in MongoDB carries its own bank narration; an existing remark is not replaced by empty`, async () => {
    const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
    const approval = msg("mA", "midA", approvalText(bill, names), "2026-11-10T03:00:00.000Z");
    const off = stubGmail(chain(approval, table(ROW_B, ROW_A), `Ravi - ${word} - Rent - UTR: UTRRAVI12345678\nSita - ${word} - Rent - UTR: UTRSITA12345678`));
    try {
      const p = setupArrears(isAdvance, 2);
      const r = await p.processPendingUtrs({ dryRun: false });
      assert.equal(r.results[0].status, "found_and_saved");
      const pays = DB.get(SITE).arrearsDue[0].payments;
      assert.deepEqual(pays.map((x) => [x.landOwnerName, x.utrNumber, x.remark]), [["Ravi Kumar", "UTRRAVI12345678", "Nov rent for Ravi Kumar site"], ["Sita Devi", "UTRSITA12345678", "Nov rent for Sita Devi site"]]);
    } finally { off(); }
  });
}

test("N16. New Bill, one landlord, no table: the payment keeps the default remark; the narration column heading / bank reference is never used", async () => {
  const approval = msg("mA", "midA", approvalText("ADNOOHBILL1111202612", [["Ravi Kumar", "111111111111"]]), "2026-11-10T03:00:00.000Z");
  const off = stubGmail([approval, msg("mU", "midU", "NewBill - UTR: UTRRAVI12345678", "2026-11-10T04:20:00.000Z", "midA")]);
  try {
    const p = setupArrears(false, 1);
    await p.processPendingUtrs({ dryRun: false });
    const pay = DB.get(SITE).arrearsDue[0].payments[0];
    assert.equal(pay.utrNumber, "UTRRAVI12345678");
        assert.equal(pay.remark, "");
  } finally { off(); }
});

test("N17. the ledger-list response is built from the stored remark: the engine keeps `remark` on the ledger row exactly as passed", async () => {
  const x = setupRental({ doc: rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")]) });
  assert.ok(x); // the Rental ledger row is written by the engine with remark: itemRemark (LedgerNew2Controller) and ledger-list returns it as-is
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "controllers", "Admin", "MediaOnboardingController", "LedgerNew2Controller.js"), "utf8");
  assert.ok(/isUtrEntry: false, remark: itemRemark/.test(src));
  assert.ok(/remark: itemRemark/.test(src.slice(src.indexOf("mBucket.entries.push"))));
});

// ───────────────────────── updatedBy = the Finance sender, not "Gmail UTR Auto" ─────────────────────────
const { senderName } = require("../utils/senderName");

test("U1. sender name: display name, quoted display name, readable fallback from the address, never empty", () => {
  assert.equal(senderName("Sathishkumar D <srbedev@adinn.co.in>"), "Sathishkumar D");
  assert.equal(senderName('"Finance Team" <finance@example.com>'), "Finance Team");
  assert.equal(senderName("<sakthi.vel@adinn.co.in>"), "Sakthi Vel");
  assert.equal(senderName("finance@adinn.co.in"), "Finance");
  assert.equal(senderName("srbedev@adinn.co.in <srbedev@adinn.co.in>"), "Srbedev"); // a display name that is just the address
  assert.equal(senderName(""), "Gmail UTR Auto");
});

test("U2. Rental Bill: the ledger is saved by the Finance reply sender, together with the narration", async () => {
  const mails = chain(A1(), table(ROW1), `UTR : ${UTR}`);
  mails[3].from = "Sathishkumar D <srbedev@adinn.co.in>";
  const off = stubGmail(mails);
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")]) });
    await run(x);
    assert.deepEqual(x.calls.actors, ["Sathishkumar D"]);
    assert.equal(x.calls.saver[0].remark, NARR);
  } finally { off(); }
});

test("U3. no display name -> a readable name from the address; a dry run saves nothing", async () => {
  const mails = [A1(), msg("mU", "midU", `UTR : ${UTR}`, "2026-11-10T04:20:00.000Z", "midA", "finance.team@adinn.co.in")];
  const off = stubGmail(mails);
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "B SIVAKUMAR", "6566930110")]) });
    await x.p.processPendingUtrs({});
    assert.equal(x.calls.saver.length, 0);
    await run(x);
    assert.deepEqual(x.calls.actors, ["Finance Team"]);
  } finally { off(); }
});

test("U4. several landlords in one thread: every payment is saved by the sender of the reply it came from (never a landlord name)", async () => {
  const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
  const mails = chain(msg("mA", "midA", approvalText(BILL, names), "2026-11-10T03:00:00.000Z"), table(ROW_B, ROW_A), "Ravi - UTR: UTRRAVI12345678\nSita - UTR: UTRSITA12345678");
  mails[3].from = "Accounts Lead <acc@adinn.co.in>";
  const off = stubGmail(mails);
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "Ravi Kumar", "111111111111"), owner("o2", "Sita Devi", "222222222222")]) });
    await run(x);
    assert.deepEqual(x.calls.actors, ["Accounts Lead", "Accounts Lead"]);
  } finally { off(); }
});

for (const isAdvance of [false, true]) {
  test(`U5. ${isAdvance ? "Advance" : "New Bill"}: the saved payment row carries the Finance sender (createdBy) and the narration (remark)`, async () => {
    const bill = isAdvance ? "ADNOOHBILL1111202613" : "ADNOOHBILL1111202612";
    const word = isAdvance ? "Advance" : "NewBill";
    const mails = chain(msg("mA", "midA", approvalText(bill, [["Ravi Kumar", "111111111111"]]), "2026-11-10T03:00:00.000Z"), table(ROW_A), `${word} - UTR: UTRRAVI12345678`);
    mails[3].from = "Sathishkumar D <srbedev@adinn.co.in>";
    const off = stubGmail(mails);
    try {
      const p = setupArrears(isAdvance, 1);
      await p.processPendingUtrs({ dryRun: false });
      const pay = DB.get(SITE).arrearsDue[0].payments[0];
      assert.deepEqual([pay.utrNumber, pay.remark, pay.createdBy], ["UTRRAVI12345678", "Nov rent for Ravi Kumar site", "Sathishkumar D"]);
    } finally { off(); }
  });
}

test("U6. manual ledger saves are unchanged: the engine still uses the logged-in user; the default actor only applies to the Gmail saver", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "utils", "utrProcessor.js"), "utf8");
  assert.ok(/userName: actor \|\| "Gmail UTR Auto"/.test(src));
  const eng = require("fs").readFileSync(require("path").join(__dirname, "..", "controllers", "Admin", "MediaOnboardingController", "LedgerNew2Controller.js"), "utf8");
  assert.ok(/const updatedBy = req\.user\?\.userName \|\| "Admin"/.test(eng));
});

test("N20. the bank writes the landlord without a space ('land1' for 'land 1'): each landlord still gets ITS OWN narration (never the other's)", () => {
  const { narrationFor } = require("../utils/bankNarration");
  const L = [{ landOwnerId: "a", name: "land 1", accountLast4: "4654" }, { landOwnerId: "b", name: "land 2", accountLast4: "8687" }];
  const row = (ledger, amount, ref, narration) => ({ date: "13-11-2026", month: "Oct-26", ledgerName: ledger, amount, payee: ledger.split(" ")[0], accountNo: "418601838", reference: ref, narration });
  const rows = [row("land1 Hoarding Landlord", 37760, "R1", "Rent for land1"), row("land2 Hoarding Landlord", 56640, "R2", "Rent for land2")];
  assert.equal(narrationFor(rows, L, { landOwnerId: "a" }).narration, "Rent for land1");
  assert.equal(narrationFor(rows, L, { landOwnerId: "b" }).narration, "Rent for land2");
  // Rent row and GST row of one landlord with different narrations are told apart by the amount
  const two = [...rows, row("land1 GST", 6800, "R3", "GST for land1")];
  assert.equal(narrationFor(two, L, { landOwnerId: "a", amount: 37760 }).narration, "Rent for land1");
  assert.equal(narrationFor(two, L, { landOwnerId: "a", amount: 6800 }).narration, "GST for land1");
  // "land10" is never "land 1"
  assert.equal(narrationFor([row("land10 Hoarding", 1000, "R9", "x")], L, { landOwnerId: "a" }).reason, "narration_landlord_not_identified");
});

// ───────────────────────── Bank Reference (bankRefNo): the unique reference of the bank row of a payment ─────────────────────────
test("N21. Rental Bill, two landlords: each payment carries the Bank Reference of ITS OWN bank row next to its narration (remark and bankRefNo are separate keys)", async () => {
  const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
  const off = stubGmail(chain(msg("mA", "midA", approvalText(BILL, names), "2026-11-10T03:00:00.000Z"), table(ROW_B, ROW_A), "Ravi - UTR: UTRRAVI12345678\nSita - UTR: UTRSITA12345678"));
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "Ravi Kumar", "111111111111"), owner("o2", "Sita Devi", "222222222222")]) });
    await run(x);
    const by = (id) => x.calls.saver.find((b) => b.payments[0].landOwnerId === id);
    assert.deepEqual([by("o1").bankRefNo, by("o1").remark], ["ADINN0411001", "Nov rent for Ravi Kumar site"]);
    assert.deepEqual([by("o2").bankRefNo, by("o2").remark], ["ADINN0411002", "Nov rent for Sita Devi site"]);
  } finally { off(); }
});

test("N22. narration rows that cannot be mapped: no Bank Reference is guessed either (bankRefNo stays empty)", async () => {
  const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
  const stranger = "04-11-2026 Nov-26 Unknown Person 5000 Unknown Person SBI 999999999999 SBIN0009999 AXIS 9445 NEFT ADINN0411003 something else";
  const off = stubGmail(chain(msg("mA", "midA", approvalText(BILL, names), "2026-11-10T03:00:00.000Z"), table(stranger), "Ravi - UTR: UTRRAVI12345678\nSita - UTR: UTRSITA12345678"));
  try {
    const x = setupRental({ doc: rentalSite([owner("o1", "Ravi Kumar", "111111111111"), owner("o2", "Sita Devi", "222222222222")]) });
    await run(x);
    assert.ok(x.calls.saver.every((b) => b.remark === "" && b.bankRefNo === ""));
  } finally { off(); }
});

for (const isAdvance of [false, true]) {
  const bill = isAdvance ? "ADNOOHBILL1111202613" : "ADNOOHBILL1111202612";
  const word = isAdvance ? "Advance" : "NewBill";
  test(`N23. ${isAdvance ? "Advance" : "New Bill"}, two landlords: each payment row in MongoDB stores its bankRefNo and its narration (remark) separately`, async () => {
    const names = [["Ravi Kumar", "111111111111"], ["Sita Devi", "222222222222"]];
    const off = stubGmail(chain(msg("mA", "midA", approvalText(bill, names), "2026-11-10T03:00:00.000Z"), table(ROW_B, ROW_A), `Ravi - ${word} - Rent - UTR: UTRRAVI12345678\nSita - ${word} - Rent - UTR: UTRSITA12345678`));
    try {
      const p = setupArrears(isAdvance, 2);
      assert.equal((await p.processPendingUtrs({ dryRun: false })).results[0].status, "found_and_saved");
      const pays = DB.get(SITE).arrearsDue[0].payments;
      assert.deepEqual(pays.map((x) => [x.landOwnerName, x.bankRefNo, x.remark]), [["Ravi Kumar", "ADINN0411001", "Nov rent for Ravi Kumar site"], ["Sita Devi", "ADINN0411002", "Nov rent for Sita Devi site"]]);
    } finally { off(); }
  });
}

test("N24. a Bank Reference that is already stored on a payment of the site is never given to another payment", () => {
  const { pickBankRow, usedBankRefs, narrationByRef } = require("../utils/bankNarration");
  const L = [{ landOwnerId: "a", name: "land 1", accountLast4: "4654" }, { landOwnerId: "b", name: "land 2", accountLast4: "8687" }];
  const row = (ledger, amount, ref, narration) => ({ ledgerName: ledger, payee: ledger.split(" ")[0], amount, accountNo: "418601838", reference: ref, narration });
  const rows = [row("land1 Hoarding Landlord", 37760, "ADINN121162291", "Oct narration"), row("Land1", 40000, "ADINN121162293", "Nov narration"), row("land2 Hoarding Landlord", 56640, "ADINN121162292", "Oct narration L2")];
  assert.equal(pickBankRow(rows, L, { landOwnerId: "a", amount: 37760 }).row.reference, "ADINN121162291");
  assert.equal(pickBankRow(rows, L, { landOwnerId: "a", amount: 40000 }).row.reference, "ADINN121162293");
  assert.equal(pickBankRow(rows, L, { landOwnerId: "a" }).reason, "bank_rows_ambiguous"); // two rows, amount unknown: nothing is guessed
  const used = usedBankRefs({ ledger: [{ bankRefNo: "adinn121162291" }], gstBalanceHistory: [{ bankRefNo: "X2" }], ledgerHistory: [{ months: [{ entries: [{ bankRefNo: "X3" }] }] }], arrearsDue: [{ payments: [{ bankRefNo: "X4" }] }], withGst1Ledger: [{ bankRefNo: "X5" }] });
  assert.deepEqual([...used].sort(), ["ADINN121162291", "X2", "X3", "X4", "X5"]);
  assert.equal(pickBankRow(rows, L, { landOwnerId: "a", usedRefs: used }).row.reference, "ADINN121162293"); // the Oct row is taken: only the Nov row is left
  assert.equal(pickBankRow(rows, L, { landOwnerId: "a", amount: 37760, usedRefs: used }).row.reference, "ADINN121162293");
  assert.equal(narrationByRef(rows, "adinn121162292"), "Oct narration L2");
});
