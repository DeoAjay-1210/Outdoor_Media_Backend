// Pending-UTR query + automatic UTR processor. No network, no database: Media / Log / Counter / Gmail / the
// ledger saver are all in-memory fakes. Run: node --test test/gmailUtrProcessing.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-utr-test-runs-" + process.pid + ".jsonl");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const { getPendingUtrBills } = require("../utils/pendingUtrBills");
const { createUtrProcessor, acquireLock, releaseLock } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const BILL = "ADNOOHBILL0611202601";
const UTR = "HDFC92023012200543116";
const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "dueDate" && typeof x === "string" ? new Date(x) : x));

const owner = (over = {}) => ({ _id: "o1", landOwnerMasterId: "m1", name: "Landlord 1", paymentCategory: 2, ...over });
const row = (over = {}) => ({ _id: "r1", dueMonth: "November 2026", dueDate: new Date("2026-11-06T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: BILL, withGst: 2, ...over });
const site = (over = {}) => ({
  _id: "s1",
  mediaName: "Site 1",
  mediaDetails: [{ status: 1, mediaCode: "C1", siteBillMode: 1 }],
  landOwners: [owner()],
  rentalDue: [row()],
  ledger: [],
  ledgerHistory: [],
  ...over,
});

const noHelpers = { isOwnerModePaidForCycle: () => false };
const fakeLog = (rows = []) => ({
  find: () => ({ sort: () => ({ select: () => ({ lean: async () => rows }) }) }),
});
const fakeFind = (docs) => ({ find: () => ({ select: () => ({ lean: async () => docs.map(clone) }) }) });
const pending = (docs, opts = {}, helpers = noHelpers) =>
  getPendingUtrBills(opts, { Media: fakeFind(docs), Log: fakeLog(), helpers, now: NOW });

// ───────────────────────── API 1: pending query ─────────────────────────
test("P1. approved + mailed + unpaid Online bill is returned with the ids needed to save it", async () => {
  const r = await pending([site()]);
  assert.equal(r.totalPending, 1);
  const b = r.bills[0];
  assert.equal(b.billNumber, BILL);
  assert.equal(b.mappingSafe, true);
  assert.equal(b.skipReason, null);
  assert.equal(b.mediaId, "s1");
  assert.deepEqual(b.rentalDueIds, ["r1"]);
  assert.deepEqual(b.paymentTypes, ["online_rent"]);
  assert.deepEqual(b.pendingPayments, [
    { paymentType: "online_rent", rentalDueId: "r1", landOwnerId: "o1", landOwnerMasterId: "m1", landOwnerName: "Landlord 1", targetType: "current", entryType: "rental", paymentMode: "Online", utrRequired: true, autoProcess: true },
  ]);
  assert.equal(b.mediaDetails.length, 1);
  assert.equal(r.safeToAutoSave, 1);
});
test("P2. not approved / mail not sent / no usable Bill Number are never returned", async () => {
  const docs = [
    site({ _id: "a", rentalDue: [row({ _id: "ra", approvalStatus: 2, adinn_ooh_bills: "ADNOOHBILL0611202602" })] }),
    site({ _id: "b", rentalDue: [row({ _id: "rb", mailSent: false, adinn_ooh_bills: "ADNOOHBILL0611202603" })] }),
    site({ _id: "c", rentalDue: [row({ _id: "rc", adinn_ooh_bills: null })] }),
    site({ _id: "d", rentalDue: [row({ _id: "rd", adinn_ooh_bills: "x1" })] }), // too short / invalid
    site({ _id: "e", rentalDue: [row({ _id: "re", adinn_ooh_bills: "ADNOOHBILLNODIGITS" })] }),
  ];
  assert.equal((await pending(docs)).totalPending, 0);
});

test("P3. already paid is excluded: live ledger row, ledgerHistory row (by rentalDueId) and the existing paid helper", async () => {
  const live = site({ ledger: [{ rentalDueId: "r1", paymentMode: "Online", utrNumber: UTR, status: 1, isUtrEntry: false }] });
  const hist = site({ ledgerHistory: [{ year: "2026", months: [{ month: "November", entries: [{ rentalDueId: "r1", paymentMode: "Online", utrNumber: UTR, isUtrEntry: false }] }] }] });
  assert.equal((await pending([live])).totalPending, 0);
  assert.equal((await pending([hist])).totalPending, 0);
  assert.equal((await pending([site()], {}, { isOwnerModePaidForCycle: () => true })).totalPending, 0);
});

test("P4. a Cash row does not pay the Online UTR payment; a Cash-only landlord is listed as CASH (no UTR)", async () => {
  const cashPaid = site({ ledger: [{ rentalDueId: "r1", landOwnerId: "o1", paymentMode: "Cash", status: 1 }] });
  const r = await pending([cashPaid]);
  assert.equal(r.totalPending, 1);
  assert.deepEqual(r.bills[0].paymentTypes, ["online_rent"]);
  const cashOnly = await pending([site({ landOwners: [owner({ paymentCategory: 1 })] })]);
  assert.deepEqual(cashOnly.bills[0].paymentTypes, ["cash"]);
  assert.equal(cashOnly.bills[0].pendingPayments[0].utrRequired, false);
});
test("P5. previous months stay in (late replies); currentMonthOnly narrows; there is no hidden age limit", async () => {
  const cur = site();
  const old = site({ _id: "s2", rentalDue: [row({ _id: "r2", dueMonth: "June 2026", dueDate: new Date("2026-06-06T00:00:00Z"), adinn_ooh_bills: "ADNOOHBILL0606202601" })] });
  const all = await pending([cur, old]);
  assert.equal(all.totalPending, 2);
  assert.equal(all.bills[0].pendingPayments[0].targetType, "pastCycle");
  const only = await pending([cur, old], { currentMonthOnly: true });
  assert.deepEqual(only.bills.map((b) => b.billNumber), [BILL]);
});
test("P6. cases outside the safe set are listed but never marked safe", async () => {
  const reason = async (doc) => (await pending([doc])).bills[0];
  assert.equal((await reason(site({ rentalDue: [row({ withGst: 1 })] }))).skipReason, "gst_separate_utr");
  assert.equal((await reason(site({ landOwners: [owner(), owner({ _id: "o2", landOwnerMasterId: "m2" })] }))).skipReason, "multiple_landlords");
  assert.equal((await reason(site({ rentalDue: [row({ adinn_ooh_bills_landOwners: [{ adinn_ooh_bills: BILL }] })] }))).skipReason, "separate_landlord_bills");
  assert.equal((await reason(site({ mediaDetails: [{ status: 0 }] }))).skipReason, "media_inactive");
});
test("P7. the same Bill Number is returned once; the same number on two sites is flagged duplicate_bill_number", async () => {
  const r = await pending([site(), site({ _id: "s2", rentalDue: [row({ _id: "r9" })] })]);
  assert.equal(r.totalPending, 1);
  assert.equal(r.bills[0].skipReason, "duplicate_bill_number");
  assert.equal(r.bills[0].mappingSafe, false);
});

test("P8. GMAIL_UTR_BILL_FIELD=billNo switches the Bill Number source field", async () => {
  const doc = site({ rentalDue: [row({ adinn_ooh_bills: null, billNo: "adinnooh0611202601" })] });
  assert.equal((await pending([doc])).totalPending, 0);
  process.env.GMAIL_UTR_BILL_FIELD = "billNo";
  try {
    const r = await pending([doc]);
    assert.equal(r.totalPending, 1);
    assert.equal(r.bills[0].billNumber, "adinnooh0611202601");
  } finally {
    delete process.env.GMAIL_UTR_BILL_FIELD;
  }
});

test("P9. works with the REAL isOwnerModePaidForCycle (paid in ledgerHistory by month + mode)", async () => {
  const helpers = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
  const paid = site({ ledgerHistory: [{ year: "2026", months: [{ month: "November", entries: [{ landOwnerId: "o1", paymentMode: "Online", utrNumber: UTR, isUtrEntry: false }] }] }] });
  assert.equal((await pending([paid], {}, helpers)).totalPending, 0);
  assert.equal((await pending([site()], {}, helpers)).totalPending, 1);
});

// ── real-data scenarios, all four landlord x site combinations, classification, all-month filtering ──
const faceOf = (id, code, name, over = {}) => ({ _id: id, mediaCode: code, mediaName: name, status: 1, siteBillMode: 1, ...over });
const billRow = (id, face, bill, over = {}) => row({ _id: id, mediaDetailId: face, adinn_ooh_bills: bill, ...over });
const payRow = (rdId, ownerId, mode, over = {}) => ({ rentalDueId: rdId, landOwnerId: ownerId, paymentMode: mode, utrNumber: mode === "Online" ? UTR : null, status: 1, isUtrEntry: false, ...over });
const byBill = (r, bill) => r.bills.find((b) => b.billNumber === bill);

test("S1. MUZZAMMIL: Cash landlord, 2 faces, nothing in the ledger -> pending CASH, safe single slot (first row)", async () => {
  const BILLM = "ADNOOHBILL1510202659";
  const m = site({
    _id: "m1",
    mediaDetails: [faceOf("f34", "ADINCHN0034", "Anna Nagar Roundana Signal Junction (Right)"), faceOf("f35", "ADINCHN0035", "Anna Nagar Roundana Signal Junction (Left)")],
    landOwners: [owner({ _id: "oM", landOwnerMasterId: "mM", name: "MUZZAMMIL MUJIBUR RAHMAN", paymentCategory: 1 })],
    rentalDue: [
      billRow("rA", "f34", BILLM, { dueMonth: "October 2026", dueDate: new Date("2026-10-15T00:00:00Z"), withGst: 0 }),
      billRow("rB", "f35", BILLM, { dueMonth: "October 2026", dueDate: new Date("2026-10-15T00:00:00Z"), withGst: 0 }),
    ],
  });
  const b = byBill(await pending([m]), BILLM);
  assert.ok(b, "cash bill must be listed");
  assert.deepEqual(b.paymentTypes, ["cash"]);
  assert.equal(b.pendingPayments.length, 1);
  const p = b.pendingPayments[0];
  assert.equal(p.paymentType, "cash");
  assert.equal(p.paymentMode, "Cash");
  assert.equal(p.utrRequired, false);
  assert.equal(p.autoProcess, true);
  assert.equal(p.rentalDueId, "rA"); // first row of the bill
  assert.equal(b.mappingSafe, true);
  assert.equal(b.skipReason, null);
  assert.deepEqual(b.mediaDetails.map((d) => d.mediaCode), ["ADINCHN0034", "ADINCHN0035"]);
  assert.deepEqual(b.rentalDueIds, ["rA", "rB"]);
  // a Cash row in the ledger completes it
  const paid = { ...m, ledger: [payRow("rA", "oM", "Cash")] };
  assert.equal(byBill(await pending([paid]), BILLM), undefined);
  // previous-month cash is not hidden: default scope is all months
  assert.equal((await pending([m])).scope, "all months");
});

test("S2. R. DHAMODHARAN: single face Cash landlord -> pending CASH", async () => {
  const BILLD = "ADNOOHBILL0110202626";
  const m = site({
    _id: "d1",
    mediaDetails: [faceOf("fD", "ADINMDU104", "Airport towards city")],
    landOwners: [owner({ _id: "oD", landOwnerMasterId: "mD", name: "R.Dhamodharan", paymentCategory: 1 })],
    rentalDue: [billRow("rD", "fD", BILLD, { dueMonth: "October 2026", dueDate: new Date("2026-10-01T00:00:00Z"), withGst: 0 })],
  });
  const r = await pending([m]);
  const b = byBill(r, BILLD);
  assert.deepEqual(b.paymentTypes, ["cash"]);
  assert.equal(b.pendingPayments[0].targetType, "pastCycle");
  assert.equal(b.pendingPayments[0].landOwnerName, "R.Dhamodharan");
  assert.equal(r.pendingPaymentCounts.cash, 1);
  assert.equal(r.pendingPaymentCounts.online_rent, 0);
});

test("S3. VENKATESAN: rent paid (Online), GST on hold unpaid -> a separate GST item only; GST never mixed with rent", async () => {
  const BILLV = "ADNOOHBILL1110202655";
  const base = {
    _id: "v1",
    mediaDetails: [faceOf("f188", "ADINCHN0188", "Kasi Theatre towards Gunidy & Kathipara Bridge"), faceOf("f189", "ADINCHN0189", "Kasi Theatre towards Ashok Pillars/Vadapalani")],
    landOwners: [owner({ _id: "oV", landOwnerMasterId: "mV", name: "VENKATESAN PRASANNA KUMAR", paymentCategory: 2 })],
    rentalDue: [
      billRow("v17", "f188", BILLV, { dueMonth: "October 2026", dueDate: new Date("2026-10-11T00:00:00Z"), withGst: 1, gstAmount: 5400 }),
      billRow("v23", "f189", BILLV, { dueMonth: "October 2026", dueDate: new Date("2026-10-11T00:00:00Z"), withGst: 1, gstAmount: 5400 }),
    ],
    ledgerHistory: [{ year: "2026", months: [{ month: "October", entries: [payRow("v17", "oV", "Online", { withGst: 1 })] }] }],
    gstBalanceHistory: [{ _id: "g1", rentalDueId: "v17", dueMonth: "October 2026", ownerId: "oV", isPaid: false, utrNumber: "", gstAmount: 10800 }],
  };
  const b = byBill(await pending([site(base)]), BILLV);
  assert.ok(b, "GST pending bill must be listed");
  assert.deepEqual(b.paymentTypes, ["gst"]);
  assert.equal(b.pendingPayments.length, 1);
  const g = b.pendingPayments[0];
  assert.equal(g.paymentType, "gst");
  assert.equal(g.entryType, "gst");
  assert.equal(g.gstBalanceHistoryId, "g1");
  assert.equal(g.gstAmount, 10800);
  assert.equal(g.gstDueMonth, "October 2026");
  assert.equal(g.landOwnerName, "VENKATESAN PRASANNA KUMAR");
  assert.equal(g.autoProcess, false);
  assert.equal(b.mappingSafe, false);
  assert.equal(b.skipReason, "gst_separate_utr");
  assert.ok(!b.pendingPayments.some((p) => p.paymentType === "online_rent"), "rent is paid — no rent item");
  // GST paid (flag, or a UTR) -> gone
  const paidFlag = site({ ...base, gstBalanceHistory: [{ ...base.gstBalanceHistory[0], isPaid: true }] });
  const paidUtr = site({ ...base, gstBalanceHistory: [{ ...base.gstBalanceHistory[0], utrNumber: UTR }] });
  assert.equal(byBill(await pending([paidFlag]), BILLV), undefined);
  assert.equal(byBill(await pending([paidUtr]), BILLV), undefined);
  // GST without hold (withGst 2) is part of the rent amount: no separate GST item
  const folded = site({ ...base, rentalDue: base.rentalDue.map((r) => ({ ...r, withGst: 2 })) });
  assert.equal(byBill(await pending([folded]), BILLV), undefined);
});

test("S4. rent still pending AND GST pending -> two items, rent is NOT auto-safe (the reply could hold both UTRs)", async () => {
  const doc = site({
    rentalDue: [row({ withGst: 1, gstAmount: 100 })],
    gstBalanceHistory: [{ _id: "g9", rentalDueId: "r1", dueMonth: "November 2026", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 100 }],
  });
  const b = (await pending([doc])).bills[0];
  assert.deepEqual([...b.paymentTypes].sort(), ["gst", "online_rent"]);
  assert.equal(b.mappingSafe, false);
  assert.equal(b.pendingPayments.find((p) => p.paymentType === "online_rent").autoProcess, false);
});

// ── all four landlord x site combinations ──
const FACES = [faceOf("fa", "ADINCHN0216", "ECR Injambakkam Towards Panaiyur/Kovalam"), faceOf("fb", "ADINCHN0217", "ECR Injambakkam Towards Thiruvanmiyur/Adyar")];
const OWN2 = [owner({ _id: "oA", landOwnerMasterId: "mA", name: "U.R.Rajha Rathinam" }), owner({ _id: "oB", landOwnerMasterId: "mB", name: "RATHNESWERI" })];

test("C1. one landlord, one site -> safe, one mediaDetails entry", async () => {
  const b = (await pending([site({ mediaDetails: [faceOf("fa", "ADINCHN0216", "ECR Injambakkam Towards Panaiyur/Kovalam")], rentalDue: [billRow("r1", "fa", BILL)] })])).bills[0];
  assert.equal(b.mappingSafe, true);
  assert.deepEqual(b.mediaDetails, [{ mediaId: "s1", mediaDetailId: "fa", mediaCode: "ADINCHN0216", mediaName: "ECR Injambakkam Towards Panaiyur/Kovalam", rentalDueIds: ["r1"] }]);
  assert.equal(b.mediaCode, "ADINCHN0216");
});

test("C2. one landlord, several faces (Option B) -> safe, ALL faces returned, saved against the FIRST row only", async () => {
  const doc = site({ mediaDetails: FACES, rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fb", BILL)] });
  const b = (await pending([doc])).bills[0];
  assert.equal(b.mappingSafe, true);
  assert.equal(b.skipReason, null);
  assert.deepEqual(b.mediaDetails.map((d) => [d.mediaCode, d.mediaName, d.rentalDueIds]), [
    ["ADINCHN0216", "ECR Injambakkam Towards Panaiyur/Kovalam", ["r1"]],
    ["ADINCHN0217", "ECR Injambakkam Towards Thiruvanmiyur/Adyar", ["r2"]],
  ]);
  assert.deepEqual(b.rentalDueIds, ["r1", "r2"]);
  assert.equal(b.pendingPayments.length, 1);
  assert.equal(b.pendingPayments[0].rentalDueId, "r1");
  assert.equal(b.pendingPayments[0].autoProcess, true);
  // the first row is the one first in the array, whichever it is
  const swapped = site({ mediaDetails: FACES, rentalDue: [billRow("r2", "fb", BILL), billRow("r1", "fa", BILL)] });
  assert.equal((await pending([swapped])).bills[0].pendingPayments[0].rentalDueId, "r2");
  // a payment stored on the first row (how ledger-save stores it) closes the whole bill
  const paid = site({ mediaDetails: FACES, rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fb", BILL)], ledger: [payRow("r1", "o1", "Online")] });
  assert.equal((await pending([paid])).totalPending, 0);
});

test("C3. several landlords, one site -> manual review, one open payment per landlord", async () => {
  const doc = site({ mediaDetails: [FACES[0]], landOwners: OWN2, rentalDue: [billRow("r1", "fa", BILL)] });
  const b = (await pending([doc])).bills[0];
  assert.equal(b.mappingSafe, false);
  assert.equal(b.skipReason, "multiple_landlords");
  assert.deepEqual(b.pendingPayments.map((p) => p.landOwnerName), ["U.R.Rajha Rathinam", "RATHNESWERI"]);
  assert.ok(b.pendingPayments.every((p) => p.autoProcess === false));
  // landlord A paid, B still open -> only B listed
  const half = site({ mediaDetails: [FACES[0]], landOwners: OWN2, rentalDue: [billRow("r1", "fa", BILL)], ledger: [payRow("r1", "oA", "Online")] });
  assert.deepEqual((await pending([half])).bills[0].pendingPayments.map((p) => p.landOwnerName), ["RATHNESWERI"]);
});

test("C4. ADNOOHBILL2011202692 shape: two landlords + two faces -> both sites returned, STILL manual review", async () => {
  const B2 = "ADNOOHBILL2011202692";
  const doc = site({
    _id: "6abceac7",
    mediaDetails: FACES,
    landOwners: OWN2,
    rentalDue: [
      billRow("295b4", "fa", B2, { dueMonth: "November 2026", dueDate: new Date("2026-11-20T00:00:00Z") }),
      billRow("295e3", "fb", B2, { dueMonth: "November 2026", dueDate: new Date("2026-11-20T00:00:00Z") }),
    ],
  });
  const b = byBill(await pending([doc]), B2);
  assert.equal(b.mappingSafe, false);
  assert.equal(b.skipReason, "multiple_landlords");
  assert.deepEqual(b.mediaDetails, [
    { mediaId: "6abceac7", mediaDetailId: "fa", mediaCode: "ADINCHN0216", mediaName: "ECR Injambakkam Towards Panaiyur/Kovalam", rentalDueIds: ["295b4"] },
    { mediaId: "6abceac7", mediaDetailId: "fb", mediaCode: "ADINCHN0217", mediaName: "ECR Injambakkam Towards Thiruvanmiyur/Adyar", rentalDueIds: ["295e3"] },
  ]);
  assert.equal(b.landlords.length, 2);
  assert.equal(b.pendingPayments.length, 2);
  assert.equal(b.mediaCode, "ADINCHN0216"); // backward compatible
  assert.ok(b.pendingPayments.every((p) => p.autoProcess === false));
});

test("C5. Option B limits: separate-bill sites, rows in different months, separate-landlord numbers, duplicate numbers stay manual", async () => {
  const sep = site({ mediaDetails: [faceOf("fa", "A", "A", { siteBillMode: 2 }), faceOf("fb", "B", "B", { siteBillMode: 2 })], rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fb", BILL)] });
  assert.equal((await pending([sep])).bills[0].skipReason, "separate_bill_site_rows");
  const months = site({ mediaDetails: FACES, rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fb", BILL, { dueMonth: "October 2026" })] });
  assert.equal((await pending([months])).bills[0].skipReason, "rows_in_different_months");
  const sepLand = site({ mediaDetails: FACES, rentalDue: [billRow("r1", "fa", BILL, { adinn_ooh_bills_landOwners: [{ adinn_ooh_bills: BILL }] }), billRow("r2", "fb", BILL)] });
  assert.equal((await pending([sepLand])).bills[0].skipReason, "separate_landlord_bills");
  const twoDocs = await pending([site({ mediaDetails: [FACES[0]], rentalDue: [billRow("r1", "fa", BILL)] }), site({ _id: "s2", mediaDetails: [FACES[1]], rentalDue: [billRow("r9", "fb", BILL)] })]);
  assert.equal(twoDocs.bills[0].skipReason, "duplicate_bill_number");
  assert.equal(twoDocs.bills[0].mediaDetails.length, 2); // one per site, never duplicated
});

test("C6. mediaDetails never repeats a site and groups every row of a face under it", async () => {
  const doc = site({ mediaDetails: [FACES[0]], rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fa", BILL)] });
  const b = (await pending([doc])).bills[0];
  assert.equal(b.mediaDetails.length, 1);
  assert.deepEqual(b.mediaDetails[0].rentalDueIds, ["r1", "r2"]);
});

test("A1. ALL months are returned by default (no age limit); currentMonthOnly=true keeps this month; sinceDays is opt-in", async () => {
  const mk = (id, bill, month, date) => site({ _id: id, rentalDue: [row({ _id: "x" + id, adinn_ooh_bills: bill, dueMonth: month, dueDate: new Date(date) })] });
  const docs = [mk("a", "ADNOOHBILL0111202601", "November 2026", "2026-11-01T00:00:00Z"), mk("b", "ADNOOHBILL0110202602", "October 2026", "2026-10-01T00:00:00Z"), mk("c", "ADNOOHBILL0101202603", "January 2026", "2026-01-01T00:00:00Z")];
  const all = await pending(docs);
  assert.equal(all.scope, "all months");
  assert.equal(all.totalPending, 3);
  const cur = await pending(docs, { currentMonthOnly: true });
  assert.equal(cur.scope, "current month only (November 2026)");
  assert.deepEqual(cur.bills.map((b) => b.billNumber), ["ADNOOHBILL0111202601"]);
  assert.equal((await pending(docs, { sinceDays: 20 })).totalPending, 1);
});

test("A2. pendingPaymentCounts classify cash / online rent / GST across a mixed set", async () => {
  const cash = site({ _id: "k", landOwners: [owner({ paymentCategory: 1 })], rentalDue: [row({ _id: "rk", adinn_ooh_bills: "ADNOOHBILL0110202610", withGst: 0 })] });
  const online = site({ _id: "n", rentalDue: [row({ _id: "rn", adinn_ooh_bills: "ADNOOHBILL0110202611", withGst: 2 })] });
  const gst = site({
    _id: "g",
    rentalDue: [row({ _id: "rg", adinn_ooh_bills: "ADNOOHBILL0110202612", withGst: 1 })],
    ledger: [payRow("rg", "o1", "Online")],
    gstBalanceHistory: [{ _id: "gg", rentalDueId: "rg", dueMonth: "November 2026", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 50 }],
  });
  const r = await pending([cash, online, gst]);
  assert.deepEqual(r.pendingPaymentCounts, { cash: 1, online_rent: 1, gst: 1 });
  assert.equal(r.safeToAutoSave, 2); // the Cash bill and the Online bill
  assert.equal(r.needsManualReview, 1); // the GST-on-hold bill
});

// ───────────────────────── API 2: processor ─────────────────────────
const foundReply = (over = {}) => ({
  message: "ok",
  data: { billNumber: BILL, extractionStatus: "found", utr: UTR, gmailThreadId: "T1", sourceMessageId: "M1", senderEmail: "fin@x.com", messageDate: "2026-11-09T10:30:00.000Z", paidDateInfo: { explicitDates: [], sentAt: "2026-11-09T10:30:00.000Z", sentDate: "2026-11-09", sourceMessageId: "M1" }, ...over },
});

const fakeCounter = () => {
  const docs = new Map();
  return {
    docs,
    findOneAndUpdate: (q, upd) => ({
      lean: async () => {
        const d = docs.get(q._id);
        if (d && d.seq < q.seq.$lt) { d.seq = upd.$set.seq; return { ...d }; }
        return null;
      },
    }),
    create: async (doc) => {
      if (docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 });
      docs.set(doc._id, { ...doc });
    },
    updateOne: async (q, upd) => { if (docs.has(q._id)) docs.get(q._id).seq = upd.$set.seq; },
  };
};

const fakeProcLog = (existing = []) => {
  const rows = [...existing];
  return {
    rows,
    create: async (d) => { rows.push({ createdAt: new Date(), ...d }); },
    findOne: (q) => ({
      sort: () => ({
        lean: async () => rows.filter((r) => r.billNumber === q.billNumber && r.dryRun === q.dryRun).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
      }),
    }),
    find: fakeLog().find,
  };
};

// bill-number registry fake: by default one record per Bill Number, built from the rows exactly like adinn_ooh_bill_registry
const fakeRegistry = (db, over) => ({
  findOne: (q) => ({
    lean: async () => {
      if (over !== undefined) return over === null ? null : typeof over === "function" ? over(q.adinn_ooh_bills, db) : over;
      for (const m of db.values()) {
        const rows = (m.rentalDue || []).filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills);
        if (rows.length) return { adinn_ooh_bills: q.adinn_ooh_bills, mediaId: m._id, dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) };
      }
      return null;
    },
  }),
});

const setup = ({ docs = [site()], registry, lookup, lookupLandlords, saver, log, counter, saveEnabled = true, cashSave = false, multiSave = false, gstSave = false } = {}) => {
  const db = new Map(docs.map((d) => [d._id, clone(d)]));
  const calls = { lookup: [], lookupLandlords: [], saver: [] };
  const Log = log || fakeProcLog();
  const Counter = counter || fakeCounter();
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => (db.has(id) ? clone(db.get(id)) : null) }) },
    Registry: fakeRegistry(db, registry),
    Log,
    Counter,
    helpers: noHelpers,
    saveEnabled: () => saveEnabled,
    cashSaveEnabled: () => cashSave,
    multiLandlordSaveEnabled: () => multiSave,
    gstSaveEnabled: () => gstSave,
    now: () => NOW,
    lookupLandlords: async (b) => { calls.lookupLandlords.push(b); return lookupLandlords ? lookupLandlords(b, db) : { data: { billNumber: b, extractionStatus: "bill_not_found" } }; },
    logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [...db.values()].map(clone) }) }) }, Log: fakeLog(), helpers: noHelpers, now: NOW },
    lookup: async (b) => { calls.lookup.push(b); return lookup ? lookup(b) : foundReply(); },
    saver: async (batch) => {
      calls.saver.push(batch);
      if (saver) return saver(batch, db);
      // behave like the real engine: the payment row now exists
      const m = db.get(batch.payments[0].mediaId);
      if (batch.entryType === "gst") {
        const g = (m.gstBalanceHistory || []).find((x) => String(x.rentalDueId) === String(batch.payments[0].rentalDueId));
        if (g) { g.isPaid = true; g.utrNumber = batch.payments[0].utrNumber; }
        return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 10800 }] } };
      }
      m.ledger.push({ rentalDueId: batch.payments[0].rentalDueId, landOwnerId: batch.payments[0].landOwnerId, paymentMode: batch.payments[0].paymentMode, utrNumber: batch.payments[0].utrNumber, status: 1, isUtrEntry: false });
      return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 5000 }] } };
    },
  });
  return { p, db, calls, Log, Counter };
};

test("R1. dry run (the default) reports what would be saved and writes nothing", async () => {
  const { p, calls, Log } = setup();
  const r = await p.processPendingUtrs({});
  assert.equal(r.dryRun, true);
  assert.equal(r.results[0].status, "found_and_saved");
  assert.equal(r.results[0].dryRun, true);
  assert.equal(r.results[0].utr, UTR);
  assert.equal(r.results[0].wouldSave.rentalDueId, "r1");
  assert.equal(calls.saver.length, 0);
  assert.equal(Log.rows.length, 0);
});

test("R2. dryRun:false is still a dry run while GMAIL_UTR_SAVE_ENABLED is off", async () => {
  const { p, calls } = setup({ saveEnabled: false });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.dryRun, true);
  assert.equal(calls.saver.length, 0);
});

test("R3. a valid unambiguous UTR is saved through the ledger engine with the exact payment identity, and logged", async () => {
  const { p, calls, Log, db } = setup();
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(calls.saver.length, 1);
  const b = calls.saver[0];
  assert.equal(b.entryType, "rental");
  assert.equal(b.siteBillMode, 1);
  assert.equal(b.date, "2026-11-09");
  assert.deepEqual(b.payments, [{ mediaId: "s1", landOwnerId: "o1", rentalDueId: "r1", targetType: "current", paymentMode: "Online", utrNumber: UTR }]);
  assert.equal(Log.rows[0].status, "found_and_saved");
  assert.equal(Log.rows[0].utr, UTR);
  assert.equal(Log.rows[0].gmailThreadId, "T1");
  assert.equal(db.get("s1").ledger.length, 1);
  // second run: the bill is no longer pending, so nothing is saved again (no duplicate ledger entry)
  const again = await p.processPendingUtrs({ dryRun: false });
  assert.equal(again.pendingTotal, 0);
  assert.equal(calls.saver.length, 1);
  assert.equal(db.get("s1").ledger.length, 1);
});

test("R4. Gmail results that are not a single clear UTR are never saved", async () => {
  const cases = [
    [{ extractionStatus: "bill_not_found", utr: null }, "bill_not_found"],
    [{ extractionStatus: "utr_not_found", utr: null }, "utr_not_found"],
    [{ extractionStatus: "multiple_review_required", utr: null }, "multiple_review_required"],
    [{ extractionStatus: "ambiguous_bill_numbers", utr: null }, "ambiguous_mapping"],
    [{ utr: "SHORT1" }, "utr_not_found"], // invalid UTR
    [{ utr: "ABCDEFGHIJKLMNOP" }, "utr_not_found"], // no digit
  ];
  for (const [data, status] of cases) {
    const { p, calls, Log } = setup({ lookup: () => foundReply(data) });
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(r.results[0].status, status, JSON.stringify(data));
    assert.equal(calls.saver.length, 0);
    assert.equal(Log.rows[0].status, status);
  }
});

test("R5. a bill whose mapping is not safe is skipped WITHOUT searching Gmail", async () => {
  const { p, calls } = setup({ docs: [site({ rentalDue: [row({ withGst: 1 })] })] });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.results[0].status, "ambiguous_mapping");
  assert.equal(r.results[0].reason, "gst_separate_utr");
  assert.equal(calls.lookup.length, 0);
  assert.equal(calls.saver.length, 0);
});

test("R6. re-check right before saving: paid in the meantime -> already_processed; UTR already on the site -> not saved", async () => {
  // paid between the pending list and the save
  let s1 = setup({
    lookup: (b) => {
      s1.db.get("s1").ledger.push({ rentalDueId: "r1", paymentMode: "Online", utrNumber: "OTHER9999999999", status: 1, isUtrEntry: false });
      return foundReply();
    },
  });
  const r1 = await s1.p.processPendingUtrs({ dryRun: false });
  assert.equal(r1.results[0].status, "already_processed");
  assert.equal(s1.calls.saver.length, 0);

  // the same UTR is already stored for something else on this site
  const s2 = setup({ docs: [site({ ledgerHistory: [{ year: "2026", months: [{ month: "October", entries: [{ rentalDueId: "old", paymentMode: "Online", utrNumber: UTR }] }] }] })] });
  const r2 = await s2.p.processPendingUtrs({ dryRun: false });
  assert.equal(r2.results[0].status, "ambiguous_mapping");
  assert.equal(r2.results[0].reason, "utr_already_used_on_this_site");
  assert.equal(s2.calls.saver.length, 0);
});

test("R7. database problems become database_error and never claim a save", async () => {
  const failed = setup({ saver: () => ({ statusCode: 207, data: { sitesFailed: 1, savedEntries: [{ status: "failed", error: "rentalDue record not found" }] } }) });
  const a = await failed.p.processPendingUtrs({ dryRun: false });
  assert.equal(a.results[0].status, "database_error");
  assert.match(a.results[0].reason, /rentalDue record not found/);

  const thrown = setup({ saver: () => { throw new Error("mongo down"); } });
  const b = await thrown.p.processPendingUtrs({ dryRun: false });
  assert.equal(b.results[0].status, "database_error");
  assert.equal(b.results[0].reason, "mongo down");
});

const two = () => [
  site({ _id: "s1", rentalDue: [row({ _id: "r1", adinn_ooh_bills: "ADNOOHBILL0611202601" })] }),
  site({ _id: "s2", rentalDue: [row({ _id: "r2", adinn_ooh_bills: "ADNOOHBILL0611202602" })] }),
];

test("R8. one failing bill does not stop the batch; a Gmail auth failure stops it", async () => {
  const mixed = setup({
    docs: two(),
    lookup: (b) => { if (b.endsWith("01")) throw Object.assign(new Error("socket hang up"), { status: 502 }); return foundReply({ billNumber: b, utr: "HDFC92023012200543999" }); },
  });
  const r = await mixed.p.processPendingUtrs({ dryRun: false });
  assert.deepEqual(r.results.map((x) => x.status), ["gmail_error", "found_and_saved"]);
  assert.equal(r.aborted, null);

  const auth = setup({ docs: two(), lookup: () => { throw Object.assign(new Error("invalid_grant"), { status: 401 }); } });
  const a = await auth.p.processPendingUtrs({ dryRun: false });
  assert.equal(a.results.length, 1);
  assert.equal(a.aborted, "gmail_authentication_failed");
  assert.equal(auth.calls.lookup.length, 1);
});

test("R9. Gmail lookups that hang are cut off with a gmail_error", async () => {
  process.env.GMAIL_UTR_GMAIL_TIMEOUT_MS = "30";
  try {
    const { p } = setup({ lookup: () => new Promise(() => {}) });
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(r.results[0].status, "gmail_error");
    assert.match(r.results[0].reason, /timed out/);
  } finally {
    delete process.env.GMAIL_UTR_GMAIL_TIMEOUT_MS;
  }
});

test("R10. overlap protection: a second run while one is active is skipped; the lock is released afterwards and expired locks are taken over", async () => {
  const counter = fakeCounter();
  let release;
  const gate = new Promise((res) => (release = res));
  const first = setup({ counter, lookup: async () => { await gate; return foundReply(); } });
  const running = first.p.processPendingUtrs({ dryRun: false });
  await new Promise((r) => setTimeout(r, 20));
  const second = setup({ counter });
  const skipped = await second.p.processPendingUtrs({ dryRun: false });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "another_run_in_progress");
  release();
  await running;
  const third = await setup({ counter }).p.processPendingUtrs({});
  assert.equal(third.skipped, undefined);

  // expired lock is taken over, a live one is not
  const c = fakeCounter();
  assert.equal(await acquireLock(c, 1000, 1000), true);
  assert.equal(await acquireLock(c, 1000, 1500), false);
  assert.equal(await acquireLock(c, 1000, 2500), true);
  await releaseLock(c);
  assert.equal(await acquireLock(c, 1000, 2600), true);
});

test("R11. the lock is released even when the run throws", async () => {
  const counter = fakeCounter();
  const { p } = setup({ counter });
  const boom = createUtrProcessor({ Counter: counter, Log: fakeProcLog(), saveEnabled: () => true, logger: { log() {}, error() {} }, getPending: async () => { throw new Error("db down"); } });
  await assert.rejects(() => boom.processPendingUtrs({ dryRun: false }), /db down/);
  const ok = await p.processPendingUtrs({});
  assert.equal(ok.skipped, undefined);
});

test("R12. cooldown: a recently 'not found' bill is not searched again; force overrides it; review cases wait longer", async () => {
  const recent = (status, minutesAgo) => ({ billNumber: BILL, status, dryRun: false, createdAt: new Date(Date.now() - minutesAgo * 60000) });
  const cool = setup({ log: fakeProcLog([recent("bill_not_found", 5)]) });
  assert.equal((await cool.p.processPendingUtrs({ dryRun: false })).processed, 0);
  assert.equal(cool.calls.lookup.length, 0);

  const forced = setup({ log: fakeProcLog([recent("bill_not_found", 5)]) });
  assert.equal((await forced.p.processPendingUtrs({ dryRun: false, force: true })).processed, 1);

  const old = setup({ log: fakeProcLog([recent("bill_not_found", 90)]) });
  assert.equal((await old.p.processPendingUtrs({ dryRun: false })).processed, 1);

  // blocked BEFORE Gmail (e.g. GST): long cooldown. Decided from Gmail (reply names do not match, several UTRs): short cooldown.
  const logOf = (status, reason, minutesAgo) => ({ billNumber: BILL, status, reason, dryRun: false, createdAt: new Date(Date.now() - minutesAgo * 60000) });
  // blocked BEFORE Gmail (e.g. GST): no cooldown at all any more — re-evaluated every run (no Gmail call, no log), so a stale log can never hide the bill
  const blocked = setup({ docs: [site({ rentalDue: [row({ withGst: 1 })] })], log: fakeProcLog([logOf("ambiguous_mapping", "gst_separate_utr", 1)]) });
  const br = await blocked.p.processPendingUtrs({ dryRun: false });
  assert.equal(br.results[0].reason, "gst_separate_utr");
  assert.equal(blocked.calls.lookup.length, 0);
  assert.equal(blocked.Log.rows.length, 1); // only the old seeded row, nothing new
  const fromGmail = setup({ log: fakeProcLog([logOf("ambiguous_mapping", "landlord_name_not_found", 90)]) });
  assert.equal((await fromGmail.p.processPendingUtrs({ dryRun: false })).processed, 1);
  const fromGmailRecent = setup({ log: fakeProcLog([logOf("ambiguous_mapping", "landlord_name_not_found", 5)]) });
  assert.equal((await fromGmailRecent.p.processPendingUtrs({ dryRun: false })).processed, 0); // still inside the short cooldown
  const severalUtrs = setup({ log: fakeProcLog([logOf("multiple_review_required", "more_than_one_utr_or_conversation", 90)]) });
  assert.equal((await severalUtrs.p.processPendingUtrs({ dryRun: false })).processed, 1);
});

test("R13. maxBills and billNumbers limit what one run touches", async () => {
  const some = setup({ docs: two() });
  assert.equal((await some.p.processPendingUtrs({ maxBills: 1 })).processed, 1);
  const only = setup({ docs: two() });
  const r = await only.p.processPendingUtrs({ billNumbers: ["ADNOOHBILL0611202602"] });
  assert.deepEqual(r.results.map((x) => x.billNumber), ["ADNOOHBILL0611202602"]);
});

// ───────────────────────── HTTP (CMD login) ─────────────────────────
test("H1. HTTP: pending-utr-bills and process-pending-utrs are CMD-only; saving needs the server switch; GET writes nothing", async () => {
  const express = require("express");
  const jwt = require("jsonwebtoken");
  const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const Log = require("../models/Admin/GmailUtrLogSchema");
  const Counter = require("../models/Admin/CounterSchema");
  const ledger = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
  const Gmail = require("../utils/gmailService");

  const saved = { Media: { find: Media.find, findById: Media.findById }, Log: { find: Log.find, findOne: Log.findOne, create: Log.create }, Counter: { f: Counter.findOneAndUpdate, c: Counter.create, u: Counter.updateOne }, exec: ledger.executeBulkPaymentBatch, search: Gmail.searchThreads, get: Gmail.getThread };
  const docs = [site()];
  let writes = 0;
  Media.find = fakeFind(docs).find;
  Media.findById = (id) => ({ lean: async () => clone(docs.find((d) => d._id === id)) });
  Log.find = fakeLog().find;
  Log.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  Log.create = async () => { writes += 1; };
  const cnt = fakeCounter();
  Counter.findOneAndUpdate = cnt.findOneAndUpdate;
  Counter.create = cnt.create;
  Counter.updateOne = cnt.updateOne;
  Gmail.searchThreads = async () => [];

  const app = express();
  app.use(express.json());
  app.use("/api/gmail", require("../routes/Admin/GmailRoutes/GmailRoutes"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/gmail`;
  const tok = (userType) => jwt.sign({ id: "u1", userType, userName: "T" }, process.env.JWT_SECRET);
  const call = (path, userType, method = "GET", body) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(userType)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const previousFlag = process.env.GMAIL_UTR_SAVE_ENABLED;
  delete process.env.GMAIL_UTR_SAVE_ENABLED;
  try {
    assert.equal((await call("/pending-utr-bills", 1)).status, 403);
    assert.equal((await call("/process-pending-utrs", 1, "POST", {})).status, 403);

    const ok = await call("/pending-utr-bills", 3);
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.data.totalPending, 1);
    assert.equal(j.data.bills[0].billNumber, BILL);
    assert.equal(writes, 0);

    const blocked = await call("/process-pending-utrs", 3, "POST", { dryRun: false });
    assert.equal(blocked.status, 409);

    const dry = await call("/process-pending-utrs", 3, "POST", {});
    assert.equal(dry.status, 200);
    const d = await dry.json();
    assert.equal(d.data.dryRun, true);
    assert.equal(d.data.results[0].status, "bill_not_found"); // Gmail mock returns no thread
    assert.equal(writes, 0);

    assert.equal((await call("/process-pending-utrs", 3, "POST", { billNumbers: "x" })).status, 400);
    assert.equal((await call("/pending-utr-bills?sinceDays=abc", 3)).status, 400);
  } finally {
    if (previousFlag !== undefined) process.env.GMAIL_UTR_SAVE_ENABLED = previousFlag;
    await new Promise((r) => server.close(r));
    Object.assign(Media, saved.Media);
    Object.assign(Log, saved.Log);
    Counter.findOneAndUpdate = saved.Counter.f;
    Counter.create = saved.Counter.c;
    Counter.updateOne = saved.Counter.u;
    ledger.executeBulkPaymentBatch = saved.exec;
    Gmail.searchThreads = saved.search;
    Gmail.getThread = saved.get;
  }
});

// ───────────────────────── processor: new payment types ─────────────────────────
test("N1. GST-on-hold bills stay blocked until the GST switch is on: no Gmail search, no save, a rent/cash UTR never goes to GST", async () => {
  const gstDoc = site({
    _id: "g",
    rentalDue: [row({ _id: "rg", adinn_ooh_bills: "ADNOOHBILL0110202612", withGst: 1 })],
    ledger: [payRow("rg", "o1", "Online")],
    gstBalanceHistory: [{ _id: "gg", rentalDueId: "rg", dueMonth: "November 2026", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 50 }],
  });
  const { p, calls } = setup({ docs: [gstDoc], cashSave: true });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(calls.lookup.length, 0);
  assert.equal(calls.saver.length, 0);
  assert.deepEqual(r.results.map((x) => [x.status, x.reason]), [["ambiguous_mapping", "gst_split_auto_save_disabled"]]);
  // Cash landlord with GST on hold: the cash payment is NOT auto-saved either (the reply may carry the GST UTR)
  const cashGst = site({
    _id: "cg",
    landOwners: [owner({ paymentCategory: 1 })],
    rentalDue: [row({ _id: "rc", adinn_ooh_bills: "ADNOOHBILL0110202613", withGst: 1 })],
    gstBalanceHistory: [{ _id: "gc", rentalDueId: "rc", dueMonth: "November 2026", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 50 }],
  });
  const c = setup({ docs: [cashGst], cashSave: true });
  const rc = await c.p.processPendingUtrs({ dryRun: false });
  assert.equal(c.calls.lookup.length, 0);
  assert.equal(c.calls.saver.length, 0);
  assert.equal(rc.results[0].reason, "gst_split_auto_save_disabled");
});
test("N2. processor: single landlord with two faces is saved against the FIRST row; multi-landlord bills are never saved", async () => {
  const faces = [faceOf("fa", "ADINCHN0216", "A"), faceOf("fb", "ADINCHN0217", "B")];
  const one = setup({ docs: [site({ mediaDetails: faces, rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fb", BILL)] })] });
  const a = await one.p.processPendingUtrs({ dryRun: false });
  assert.equal(a.counts.found_and_saved, 1);
  assert.equal(one.calls.saver[0].payments[0].rentalDueId, "r1");
  assert.equal(one.calls.saver[0].payments.length, 1);

  const two = setup({ docs: [site({ mediaDetails: faces, landOwners: OWN2, rentalDue: [billRow("r1", "fa", BILL), billRow("r2", "fb", BILL)] })] });
  const b = await two.p.processPendingUtrs({ dryRun: false });
  assert.equal(b.results[0].status, "ambiguous_mapping");
  assert.equal(b.results[0].reason, "multi_landlord_auto_save_disabled"); // blocked until its own switch is on
  assert.equal(two.calls.lookup.length, 0);
  assert.equal(two.calls.lookupLandlords.length, 0);
  assert.equal(two.calls.saver.length, 0);
});

test("N3. processor default is ALL months; currentMonthOnly narrows it", async () => {
  const old = site({ _id: "o", rentalDue: [row({ _id: "ro", dueMonth: "June 2026", dueDate: new Date("2026-06-06T00:00:00Z"), adinn_ooh_bills: "ADNOOHBILL0606202601" })] });
  const all = setup({ docs: [site(), old] });
  assert.equal((await all.p.processPendingUtrs({})).scope, "all months");
  const cur = setup({ docs: [site(), old] });
  const r = await cur.p.processPendingUtrs({ currentMonthOnly: true });
  assert.equal(r.pendingTotal, 1);
  assert.match(r.scope, /current month only/);
});

// ───────────────────────── Cash payments are processed too ─────────────────────────
const CASH_BILL = "ADNOOHBILL0110202610";
const cashDocT = (over = {}) => site({ _id: "k", landOwners: [owner({ _id: "oK", landOwnerMasterId: "mK", name: "Cash Landlord", paymentCategory: 1 })], rentalDue: [row({ _id: "rk", adinn_ooh_bills: CASH_BILL, withGst: 0 })], ...over });

test("K1. API 1: a pending Cash payment is listed, safe, with the Cash slot identity", async () => {
  const r = await pending([cashDocT()]);
  const b = byBill(r, CASH_BILL);
  assert.equal(b.mappingSafe, true);
  assert.deepEqual(b.pendingPayments, [
    { paymentType: "cash", rentalDueId: "rk", landOwnerId: "oK", landOwnerMasterId: "mK", landOwnerName: "Cash Landlord", targetType: "current", entryType: "rental", paymentMode: "Cash", utrRequired: false, autoProcess: true },
  ]);
  assert.equal(r.pendingPaymentCounts.cash, 1);
});

test("K2. API 2 DRY RUN: the Cash bill IS searched in Gmail, nothing is saved or logged", async () => {
  const { p, calls, Log } = setup({ docs: [cashDocT()] });
  const r = await p.processPendingUtrs({});
  assert.equal(r.dryRun, true);
  assert.deepEqual(calls.lookup, [CASH_BILL]);
  assert.equal(r.results[0].status, "found_and_saved");
  assert.equal(r.results[0].dryRun, true);
  assert.equal(r.results[0].utr, UTR);
  assert.equal(r.results[0].wouldSave.paymentMode, "Cash");
  assert.equal(r.results[0].wouldSave.rentalDueId, "rk");
  assert.equal(calls.saver.length, 0);
  assert.equal(Log.rows.length, 0);
});

test("K3. real save of Cash needs its OWN switch: with GMAIL_UTR_SAVE_ENABLED only, Cash stays manual (no Gmail search, no save)", async () => {
  const { p, calls, Log } = setup({ docs: [cashDocT()], cashSave: false });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.dryRun, false);
  assert.equal(r.results[0].status, "ambiguous_mapping");
  assert.equal(r.results[0].reason, "cash_auto_save_disabled");
  assert.equal(calls.lookup.length, 0);
  assert.equal(calls.saver.length, 0);
  assert.equal(Log.rows.length, 0); // a block decided before Gmail is not logged (it is re-checked every run)
});

test("K4. with both switches on, the Cash UTR is saved through the ledger engine as a Cash payment on the first row; no second entry", async () => {
  const faces = [faceOf("fa", "A", "A"), faceOf("fb", "B", "B")];
  const doc = cashDocT({ mediaDetails: faces, rentalDue: [billRow("rk", "fa", CASH_BILL, { withGst: 0 }), billRow("rk2", "fb", CASH_BILL, { withGst: 0 })] });
  const { p, calls, db, Log } = setup({ docs: [doc], cashSave: true });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(calls.saver.length, 1);
  const b = calls.saver[0];
  assert.equal(b.entryType, "rental"); // never "gst"
  assert.deepEqual(b.payments, [{ mediaId: "k", landOwnerId: "oK", rentalDueId: "rk", targetType: "current", paymentMode: "Cash", utrNumber: UTR }]);
  assert.equal(Log.rows[0].status, "found_and_saved");
  assert.equal(db.get("k").ledger.length, 1);
  const again = await p.processPendingUtrs({ dryRun: false });
  assert.equal(again.pendingTotal, 0);
  assert.equal(calls.saver.length, 1);
});

test("K5. Cash mapping that cannot be proven stays manual: two open rent payments (cat 3), several landlords, GST on hold", async () => {
  const both = setup({ docs: [cashDocT({ landOwners: [owner({ _id: "oK", paymentCategory: 3 })] })], cashSave: true });
  const a = await both.p.processPendingUtrs({ dryRun: false });
  assert.equal(a.results[0].status, "ambiguous_mapping");
  assert.equal(a.results[0].reason, "no_single_rent_slot");
  assert.equal(both.calls.lookup.length, 0);

  const two = setup({ docs: [cashDocT({ landOwners: [owner({ _id: "oK", paymentCategory: 1 }), owner({ _id: "oL", landOwnerMasterId: "mL", paymentCategory: 1 })] })], cashSave: true });
  const b = await two.p.processPendingUtrs({ dryRun: false });
  assert.equal(b.results[0].reason, "multi_landlord_auto_save_disabled");

  const gst = setup({
    docs: [cashDocT({ rentalDue: [row({ _id: "rk", adinn_ooh_bills: CASH_BILL, withGst: 1 })], gstBalanceHistory: [{ _id: "gc", rentalDueId: "rk", dueMonth: "November 2026", ownerId: "oK", isPaid: false, utrNumber: "", gstAmount: 50 }] })],
    cashSave: true,
  });
  const c = await gst.p.processPendingUtrs({ dryRun: false });
  assert.equal(c.results[0].reason, "gst_split_auto_save_disabled");
  assert.equal(gst.calls.lookup.length, 0);
  assert.equal(gst.calls.saver.length, 0);
});

test("K6. a category-3 landlord whose Online part is already paid has ONE open slot: Cash -> safe; and the reverse", async () => {
  const cat3 = (ledger) => cashDocT({ landOwners: [owner({ _id: "oK", paymentCategory: 3 })], ledger });
  const cashOpen = (await pending([cat3([payRow("rk", "oK", "Online")])])).bills[0];
  assert.deepEqual(cashOpen.pendingPayments.map((x) => x.paymentType), ["cash"]);
  assert.equal(cashOpen.mappingSafe, true);
  const onlineOpen = (await pending([cat3([payRow("rk", "oK", "Cash")])])).bills[0];
  assert.deepEqual(onlineOpen.pendingPayments.map((x) => x.paymentType), ["online_rent"]);
  assert.equal(onlineOpen.mappingSafe, true);
});

test("K7. duplicate protection holds for Cash: a Cash row already saved excludes the bill; a UTR already on the site is not reused", async () => {
  assert.equal((await pending([cashDocT({ ledger: [payRow("rk", "oK", "Cash")] })])).totalPending, 0);
  const used = setup({ docs: [cashDocT({ ledgerHistory: [{ year: "2026", months: [{ month: "October", entries: [{ rentalDueId: "old", paymentMode: "Online", utrNumber: UTR }] }] }] })], cashSave: true });
  const r = await used.p.processPendingUtrs({ dryRun: false });
  assert.equal(r.results[0].status, "ambiguous_mapping");
  assert.equal(r.results[0].reason, "utr_already_used_on_this_site");
  assert.equal(used.calls.saver.length, 0);
});

test("K8. Online rent is unchanged by the Cash switch: it saves with SAVE_ENABLED only", async () => {
  const { p, calls } = setup({ cashSave: false });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(calls.saver[0].payments[0].paymentMode, "Online");
});

// ───────────────────────── Paid Date in the processor ─────────────────────────
const dated = (info) => () => foundReply({ paidDateInfo: { sentAt: "2026-11-09T10:30:00.000Z", sentDate: "2026-11-09", sourceMessageId: "M1", explicitDates: [], ...info } });

test("T1. dry run reports UTR, Paid Date, date source, payment type, mapping status and eligibility — and writes nothing", async () => {
  const { p, calls, Log } = setup({ lookup: dated({ explicitDates: [{ date: "2026-11-05" }] }), saveEnabled: false });
  const r = await p.processPendingUtrs({});
  const x = r.results[0];
  assert.equal(x.billNumber, BILL);
  assert.equal(x.utr, UTR);
  assert.equal(x.paidDate, "2026-11-05");
  assert.equal(x.paidDateSource, "email_payment_date");
  assert.equal(x.paymentType, "online_rent");
  assert.equal(x.mappingStatus, "safe");
  assert.equal(x.eligibleForSaving, true);
  assert.deepEqual(x.savingBlockedBy, ["GMAIL_UTR_SAVE_ENABLED is off"]);
  assert.equal(x.wouldSave.date, "2026-11-05");
  assert.equal(x.dryRun, true);
  assert.equal(calls.saver.length, 0);
  assert.equal(Log.rows.length, 0);
});

test("T2. email sent date fallback is labelled email_sent_date with a note to verify; Cash reports its own switch", async () => {
  const { p } = setup({ docs: [cashDocT()], lookup: dated({}) });
  const x = (await p.processPendingUtrs({})).results[0];
  assert.equal(x.paidDate, "2026-11-09");
  assert.equal(x.paidDateSource, "email_sent_date");
  assert.match(x.paidDateNote, /Check the Paid Date/);
  assert.equal(x.paymentType, "cash");
  assert.ok(x.savingBlockedBy.includes("GMAIL_UTR_CASH_SAVE_ENABLED is off"));
});

test("T3. real save sends the resolved Paid Date to the ledger engine and records the source in the remark and the log", async () => {
  const exp = setup({ lookup: dated({ explicitDates: [{ date: "2026-11-05" }] }) });
  await exp.p.processPendingUtrs({ dryRun: false });
  assert.equal(exp.calls.saver[0].date, "2026-11-05");
  assert.match(exp.calls.saver[0].remark, /payment date stated in the email/);
  assert.equal(exp.Log.rows[0].paidDate, "2026-11-05");
  assert.equal(exp.Log.rows[0].paidDateSource, "email_payment_date");

  const sent = setup({ lookup: dated({}) });
  await sent.p.processPendingUtrs({ dryRun: false });
  assert.equal(sent.calls.saver[0].date, "2026-11-09");
  assert.match(sent.calls.saver[0].remark, /email sent date — verify/);
  assert.equal(sent.Log.rows[0].paidDateSource, "email_sent_date");
});

test("T4. the sent date is an India calendar day: 01:00 IST on the 10th is the 10th, not the 9th", async () => {
  const { p, calls } = setup({ lookup: dated({ sentAt: "2026-11-09T19:30:00.000Z", sentDate: "2026-11-10" }) });
  await p.processPendingUtrs({ dryRun: false });
  assert.equal(calls.saver[0].date, "2026-11-10");
});

test("T5. the UI window is enforced: a Paid Date before the CMD approval day is never saved; unusable explicit dates fall back", async () => {
  const approvedDoc = (iso) => site({ rentalDue: [row({ ownerApprovalDate: new Date(iso) })] });
  // ownerApprovalDate is stored by RMS with nowIST(): its UTC date part IS the India day
  // explicit 2026-11-01, approval day 2026-11-07 -> explicit rejected, sent date 2026-11-09 used
  const a = setup({ docs: [approvedDoc("2026-11-07T11:30:00Z")], lookup: dated({ explicitDates: [{ date: "2026-11-01" }] }) });
  const ra = (await a.p.processPendingUtrs({ dryRun: false })).results[0];
  assert.equal(ra.paidDate, "2026-11-09");
  assert.equal(ra.paidDateSource, "email_sent_date");
  assert.deepEqual(ra.paidDateRejected, [{ date: "2026-11-01", reason: "before_approval_date" }]);
  // approval day 2026-11-10, reply sent on the 9th -> not saved at all
  const b = setup({ docs: [approvedDoc("2026-11-10T01:00:00Z")], lookup: dated({}) });
  const rb = (await b.p.processPendingUtrs({ dryRun: false })).results[0];
  assert.equal(rb.status, "ambiguous_mapping");
  assert.equal(rb.reason, "paid_date_not_determined");
  assert.equal(b.calls.saver.length, 0);
  // REGRESSION: evening approval on the 9th (stored 18:56Z) and a same-day reply is saved
  const c = setup({ docs: [approvedDoc("2026-11-09T18:56:51.960Z")], lookup: dated({}) });
  const rc = (await c.p.processPendingUtrs({ dryRun: false })).results[0];
  assert.equal(rc.status, "found_and_saved");
  assert.equal(rc.paidDate, "2026-11-09");
});
test("T6. missing / invalid dates never save: no evidence at all, a future sent date", async () => {
  for (const info of [{ sentDate: null, sentAt: "" }, { sentDate: "2026-12-30", sentAt: "2026-12-30T05:00:00Z" }]) {
    const { p, calls } = setup({ lookup: dated(info) });
    const r = (await p.processPendingUtrs({ dryRun: false })).results[0];
    assert.equal(r.reason, "paid_date_not_determined", JSON.stringify(info));
    assert.equal(calls.saver.length, 0);
  }
});

test("T7. Paid Date never reaches GST: a GST item is untouched and entryType stays rental", async () => {
  const gstDoc = site({
    rentalDue: [row({ withGst: 1 })],
    ledger: [payRow("r1", "o1", "Online")],
    gstBalanceHistory: [{ _id: "g", rentalDueId: "r1", dueMonth: "November 2026", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 10 }],
  });
  const g = setup({ docs: [gstDoc], lookup: dated({ explicitDates: [{ date: "2026-11-05" }] }), cashSave: true });
  const r = await g.p.processPendingUtrs({ dryRun: false });
  assert.equal(g.calls.lookup.length, 0);
  assert.equal(g.calls.saver.length, 0);
  assert.equal(r.results[0].reason, "gst_split_auto_save_disabled");
  const ok = setup({ lookup: dated({}) });
  await ok.p.processPendingUtrs({ dryRun: false });
  assert.equal(ok.calls.saver[0].entryType, "rental");
});

test("T8. multi-landlord and ambiguous bills stay blocked whatever the date says", async () => {
  const two = setup({ docs: [site({ landOwners: OWN2 })], lookup: dated({ explicitDates: [{ date: "2026-11-05" }] }), cashSave: true });
  const r = await two.p.processPendingUtrs({ dryRun: false });
  assert.equal(r.results[0].reason, "multi_landlord_auto_save_disabled");
  assert.equal(two.calls.saver.length, 0);
  const amb = setup({ lookup: () => foundReply({ extractionStatus: "ambiguous_bill_numbers", utr: null }) });
  assert.equal((await amb.p.processPendingUtrs({ dryRun: false })).results[0].status, "ambiguous_mapping");
});

// ───────────────────────── cron dry run: no MongoDB writes, run log, overlap ─────────────────────────
const { startGmailUtrCron, cronDryRun } = require("../utils/gmailUtrCron");
const noDb = { findOneAndUpdate: () => { throw new Error("Counter must not be touched by a dry run"); }, create: () => { throw new Error("Counter must not be touched by a dry run"); }, updateOne: () => { throw new Error("Counter must not be touched by a dry run"); } };
const noLogDb = { create: () => { throw new Error("Log must not be written by a dry run"); }, findOne: () => ({ sort: () => ({ lean: async () => null }) }), find: fakeLog().find };

test("Z1. a dry run writes NOTHING to MongoDB: no lock row, no log row, no payment call", async () => {
  const { p, calls } = setup({ counter: noDb, log: noLogDb });
  const r = await p.processPendingUtrs({});
  assert.equal(r.dryRun, true);
  assert.equal(r.results[0].status, "found_and_saved");
  assert.equal(calls.saver.length, 0);
});

test("Z2. dry-run overlap is prevented inside the process: a second dry run is skipped until the first ends", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const first = setup({ counter: noDb, lookup: async () => { await gate; return foundReply(); } });
  const running = first.p.processPendingUtrs({});
  await new Promise((r) => setTimeout(r, 20));
  const second = await setup({ counter: noDb }).p.processPendingUtrs({});
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "another_run_in_progress");
  release();
  assert.equal((await running).processed, 1);
  assert.equal((await setup({ counter: noDb }).p.processPendingUtrs({})).processed, 1); // free again
});

test("Z3. a LIVE run still takes the cross-instance DB lock and releases it", async () => {
  const counter = fakeCounter();
  let during = null;
  const { p } = setup({ counter, lookup: async () => { during = counter.docs.get("gmail_utr_lock")?.seq; return foundReply(); } });
  await p.processPendingUtrs({ dryRun: false });
  assert.ok(during > Date.now(), "lock held while running");
  assert.equal(counter.docs.get("gmail_utr_lock").seq, 0, "lock released afterwards");
});

test("Z4. every run is logged with runId, start/end time, matched bills (UTR, Paid Date), skipped bills and errors", async () => {
  const docs = [
    site({ _id: "s1", rentalDue: [row({ _id: "r1", adinn_ooh_bills: "ADNOOHBILL0611202601" })] }),
    site({ _id: "s2", rentalDue: [row({ _id: "r2", adinn_ooh_bills: "ADNOOHBILL0611202602" })] }),
    site({ _id: "s3", rentalDue: [row({ _id: "r3", adinn_ooh_bills: "ADNOOHBILL0611202603" })] }),
    site({ _id: "s4", landOwners: OWN2, rentalDue: [row({ _id: "r4", adinn_ooh_bills: "ADNOOHBILL0611202604" })] }),
  ];
  const lookup = (b) => {
    if (b.endsWith("01")) return dated({ explicitDates: [{ date: "2026-11-05" }] })();
    if (b.endsWith("02")) return { data: { billNumber: b, extractionStatus: "bill_not_found", utr: null } };
    throw Object.assign(new Error("socket hang up"), { status: 502 });
  };
  const logs = [];
  const { p } = setup({ docs, lookup });
  // capture through the file writer
  const file = process.env.GMAIL_UTR_RUN_LOG_FILE;
  try { fs.unlinkSync(file); } catch (_) { /* none yet */ }
  const r = await p.processPendingUtrs({});
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const log = lines[0];
  assert.equal(log.runId, r.runId);
  assert.equal(log.mode, "dry-run");
  assert.equal(log.triggeredBy, "api");
  assert.ok(!Number.isNaN(Date.parse(log.startedAt)) && !Number.isNaN(Date.parse(log.finishedAt)));
  assert.ok(typeof log.durationMs === "number" && log.durationMs >= 0);
  assert.equal(log.pendingTotal, 4);
  assert.deepEqual(log.matchedBills.map((m) => [m.billNumber, m.utr, m.paidDate, m.paidDateSource, m.paymentType, m.eligibleForSaving]), [["ADNOOHBILL0611202601", UTR, "2026-11-05", "email_payment_date", "online_rent", true]]);
  assert.deepEqual(log.skippedBills.map((x) => [x.billNumber, x.status]).sort(), [["ADNOOHBILL0611202602", "bill_not_found"], ["ADNOOHBILL0611202603", "gmail_error"], ["ADNOOHBILL0611202604", "bill_not_found"]]);
  assert.deepEqual(log.errors.map((x) => [x.billNumber, x.status]), [["ADNOOHBILL0611202603", "gmail_error"]]);
  assert.equal(logs.length, 0);
});

test("Z5. a skipped (overlapping) run is logged too, and a failed run is logged with its error", async () => {
  const file = process.env.GMAIL_UTR_RUN_LOG_FILE;
  try { fs.unlinkSync(file); } catch (_) { /* none yet */ }
  const boom = createUtrProcessor({ Counter: noDb, Log: noLogDb, logger: { log() {}, error() {} }, getPending: async () => { throw new Error("db down"); } });
  await assert.rejects(() => boom.processPendingUtrs({}), /db down/);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].error, "db down");
  assert.equal(lines[0].mode, "dry-run");
});

test("Z6. the cron schedule: off by default, never starts under SKIP_STARTUP_MAINTENANCE, every 10 minutes when on", () => {
  const cronStub = () => { const c = { jobs: [], schedule: (e, f) => c.jobs.push({ e, f }) }; return c; };
  const quiet = { log() {}, error() {} };
  const a = cronStub();
  assert.equal(startGmailUtrCron(a, { env: {}, logger: quiet }), null);
  assert.equal(a.jobs.length, 0);
  const b = cronStub();
  assert.equal(startGmailUtrCron(b, { env: { GMAIL_UTR_CRON_ENABLED: "true" }, skipMaintenance: true, logger: quiet }), null);
  assert.equal(b.jobs.length, 0);
  const c = cronStub();
  const h = startGmailUtrCron(c, { env: { GMAIL_UTR_CRON_ENABLED: "true" }, logger: quiet, processor: { processPendingUtrs: async () => ({}) } });
  assert.equal(c.jobs.length, 1);
  assert.equal(c.jobs[0].e, "*/10 * * * *");
  assert.equal(h.dryRun, true);
});

test("Z7. the cron is a DRY RUN by default even when GMAIL_UTR_SAVE_ENABLED=true; only the word false turns it live", async () => {
  assert.equal(cronDryRun({}), true);
  assert.equal(cronDryRun({ GMAIL_UTR_SAVE_ENABLED: "true" }), true);
  assert.equal(cronDryRun({ GMAIL_UTR_CRON_DRY_RUN: "true" }), true);
  assert.equal(cronDryRun({ GMAIL_UTR_CRON_DRY_RUN: "" }), true);
  assert.equal(cronDryRun({ GMAIL_UTR_CRON_DRY_RUN: "no" }), true);
  assert.equal(cronDryRun({ GMAIL_UTR_CRON_DRY_RUN: "false" }), false);
  const seen = [];
  const cron = { schedule: (e, f) => seen.push(f) };
  startGmailUtrCron(cron, { env: { GMAIL_UTR_CRON_ENABLED: "true", GMAIL_UTR_SAVE_ENABLED: "true" }, logger: { log() {}, error() {} }, processor: { processPendingUtrs: async (o) => { seen.push(o); return {}; } } });
  await seen[0](); // the scheduled function
  assert.deepEqual(seen[1], { triggeredBy: "cron", dryRun: true });
});

test("Z8. a failing cron run never throws into the scheduler", async () => {
  let fn;
  const errors = [];
  startGmailUtrCron({ schedule: (e, f) => (fn = f) }, { env: { GMAIL_UTR_CRON_ENABLED: "true" }, logger: { log() {}, error: (...a) => errors.push(a.join(" ")) }, processor: { processPendingUtrs: async () => { throw new Error("boom"); } } });
  assert.equal(await fn(), null);
  assert.match(errors[0], /boom/);
});

test("Z9. cron-driven dry run end to end: reads, finds, would save, and a spy proves no payment write and no DB write", async () => {
  const counter = fakeCounter();
  const { p, calls, Log } = setup({ counter, log: fakeProcLog(), saveEnabled: true, cashSave: true });
  let fn;
  startGmailUtrCron({ schedule: (e, f) => (fn = f) }, { env: { GMAIL_UTR_CRON_ENABLED: "true", GMAIL_UTR_SAVE_ENABLED: "true" }, logger: { log() {}, error() {} }, processor: p });
  const r = await fn();
  assert.equal(r.dryRun, true);
  assert.equal(r.results[0].eligibleForSaving, true);
  assert.equal(calls.saver.length, 0);
  assert.equal(Log.rows.length, 0);
  assert.equal(counter.docs.size, 0);
});

// ───────────────────────── several landlords: finance replies in ONE mail, one line per landlord ─────────────────────────
const { extractLandlordUtrLines } = require("../utils/landlordUtrParser");
const MULTI_BILL = "ADNOOHBILL1811202695";
const U = { J: "SBIN92023012200543116", S: "HDFC92023012200543117", M: "ICIC92023012200543118" };
const LL = () => [
  owner({ _id: "oJ", landOwnerMasterId: "mJ", name: "K. Jamuna", paymentCategory: 2, bankName: "SBI", accountNumber: "43765128647", onlineAmount: 10000 }),
  owner({ _id: "oS", landOwnerMasterId: "mS", name: "K. Suresh", paymentCategory: 2, bankName: "HDFC", accountNumber: "50100779876355", onlineAmount: 10000 }),
  owner({ _id: "oM", landOwnerMasterId: "mM", name: "K. Murali", paymentCategory: 2, bankName: "ICICI", accountNumber: "240801506039", onlineAmount: 10000 }),
];
const multiDoc = (over = {}) => site({ _id: "mm", landOwners: LL(), rentalDue: [row({ _id: "rm", adinn_ooh_bills: MULTI_BILL, dueMonth: "November 2026", dueDate: new Date("2026-11-18T00:00:00Z"), withGst: 0 })], ...over });
const MAIL = () => [{ name: "K. Jamuna", bank: "SBI", accountLast4: "8647" }, { name: "K. Suresh", bank: "HDFC", accountLast4: "6355" }, { name: "K. Murali", bank: "ICICI", accountLast4: "6039" }];
const reply = (text, over = {}, sentAt = "2026-11-09T10:30:00.000Z") => () => ({
  data: { billNumber: MULTI_BILL, extractionStatus: "found", threadId: "T9", approvalMailLandlords: MAIL(), replies: [{ messageId: "M9", from: "Finance <f@x.com>", sentAt, sentDate: sentAt.slice(0, 10), lines: extractLandlordUtrLines(text) }], ...over },
});
const THREE = `Jamuna - UTR: ${U.J}\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`;
const run = (o, opts = {}) => { const x = setup({ docs: [multiDoc(o.doc)], multiSave: true, ...o }); return x.p.processPendingUtrs({ dryRun: false, ...opts }).then((r) => ({ ...x, r })); };
const one = (r) => r.results[0];
const ids = (calls) => calls.saver.map((b) => [b.payments[0].landOwnerId, b.payments[0].utrNumber]);

test("M1. three landlords, three different UTRs (first names only): each UTR saved to its own landlord, once", async () => {
  const x = await run({ lookupLandlords: reply(THREE) });
  assert.equal(one(x.r).status, "found_and_saved");
  assert.deepEqual(ids(x.calls), [["oJ", U.J], ["oS", U.S], ["oM", U.M]]);
  assert.ok(x.calls.saver.every((b) => b.entryType === "rental" && b.payments[0].rentalDueId === "rm" && b.payments[0].paymentMode === "Online" && b.payments.length === 1));
  assert.equal(x.calls.lookup.length, 0); // the single-landlord lookup is not used
  assert.equal(x.Log.rows[0].status, "found_and_saved");
  assert.equal(x.Log.rows[0].landlordMappings.length, 3);
  const again = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(again.pendingTotal, 0); // nothing pending any more: no duplicate entries
  assert.equal(x.calls.saver.length, 3);
});

test("M2. three landlords with IDENTICAL amounts: mapping is by name, never by amount", async () => {
  const x = await run({ lookupLandlords: reply(`Murali - UTR: ${U.M}\nJamuna - UTR: ${U.J}\nSuresh - UTR: ${U.S}`) });
  assert.deepEqual(ids(x.calls).sort(), [["oJ", U.J], ["oM", U.M], ["oS", U.S]]);
});

test("M3. reply order differs from the approval-mail order: the name decides, not the position", async () => {
  const x = await run({ lookupLandlords: reply(`Murali - UTR: ${U.M}\nSuresh - UTR: ${U.S}\nJamuna - UTR: ${U.J}`) });
  const byOwner = Object.fromEntries(ids(x.calls));
  assert.equal(byOwner.oJ, U.J);
  assert.equal(byOwner.oS, U.S);
  assert.equal(byOwner.oM, U.M);
});

test("M4. a line without a landlord name (or only an initial) is never used", async () => {
  const a = await run({ lookupLandlords: reply(`UTR: ${U.J}\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(a.r).reason, "unnamed_utr_line");
  assert.equal(a.calls.saver.length, 0);
  const b = await run({ lookupLandlords: reply(`K - UTR: ${U.J}\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(b.r).reason, "landlord_name_too_short");
  assert.equal(b.calls.saver.length, 0);
});

test("M5. duplicate / ambiguous names: a first name shared by two landlords, or one landlord named twice with different UTRs", async () => {
  const shared = [owner({ _id: "o1", name: "K. Suresh", bankName: "SBI" }), owner({ _id: "o2", name: "R. Suresh", bankName: "HDFC" }), owner({ _id: "o3", name: "K. Murali" })];
  const a = await run({ doc: { landOwners: shared }, lookupLandlords: reply(`Suresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`, { approvalMailLandlords: [] }) });
  assert.equal(one(a.r).reason, "landlord_name_ambiguous");
  assert.equal(a.calls.saver.length, 0);
  // the full name (initial + name) is unique again
  const b = await run({ doc: { landOwners: shared }, lookupLandlords: reply(`K. Suresh - UTR: ${U.S}\nR. Suresh - UTR: SBIN92023012200543999\nMurali - UTR: ${U.M}`, { approvalMailLandlords: [] }) });
  assert.equal(one(b.r).status, "found_and_saved");
  assert.deepEqual(ids(b.calls).map((x) => x[0]), ["o1", "o2", "o3"]);
  // the same landlord twice with two different UTRs
  const c = await run({ lookupLandlords: reply(`${THREE}\nJamuna - UTR: SBIN92023012200543555`) });
  assert.equal(one(c.r).reason, "conflicting_utr_for_landlord");
  assert.equal(c.calls.saver.length, 0);
  // the same line repeated is harmless
  const d = await run({ lookupLandlords: reply(`${THREE}\nJamuna - UTR: ${U.J}`) });
  assert.equal(one(d.r).status, "found_and_saved");
});

test("M6. a UTR missing for one landlord: nothing is saved (no partial save)", async () => {
  const x = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J}\nSuresh - UTR: ${U.S}`) });
  assert.equal(one(x.r).status, "ambiguous_mapping");
  assert.equal(one(x.r).reason, "missing_landlord_utr");
  assert.equal(one(x.r).landlordMappingProblems[0].name, "K. Murali");
  assert.equal(x.calls.saver.length, 0);
});

test("M7. the same UTR given for two landlords, or a UTR already stored on the site: blocked", async () => {
  const a = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J}\nSuresh - UTR: ${U.J}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(a.r).reason, "duplicate_utr");
  assert.equal(a.calls.saver.length, 0);
  const used = multiDoc({ ledgerHistory: [{ year: "2026", months: [{ month: "October", entries: [{ rentalDueId: "old", landOwnerId: "oJ", paymentMode: "Online", utrNumber: U.S }] }] }] });
  const b = await run({ doc: used, lookupLandlords: reply(THREE) });
  assert.equal(one(b.r).reason, "utr_already_used_on_this_site");
  assert.equal(b.calls.saver.length, 0);
});

test("M8. wrong bank / account: in the reply line, or in the original approval mail, blocks the bill", async () => {
  const acct = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J} - A/c: 99999999999\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(acct.r).reason, "account_mismatch_in_reply");
  const bank = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J} - Bank: HDFC\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(bank.r).reason, "bank_mismatch_in_reply");
  const mailAcct = await run({ lookupLandlords: reply(THREE, { approvalMailLandlords: [{ name: "K. Jamuna", bank: "SBI", accountLast4: "0000" }, ...MAIL().slice(1)] }) });
  assert.equal(one(mailAcct.r).reason, "account_mismatch_approval_mail");
  const mailMissing = await run({ lookupLandlords: reply(THREE, { approvalMailLandlords: MAIL().slice(0, 2) }) });
  assert.equal(one(mailMissing.r).reason, "not_listed_in_approval_mail");
  for (const x of [acct, bank, mailAcct, mailMissing]) assert.equal(x.calls.saver.length, 0);
  // correct extras are accepted and shown as validated
  const good = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J} - A/c: 43765128647 - Bank: SBI\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(good.r).status, "found_and_saved");
  assert.deepEqual(one(good.r).landlordMappings[0].validation, { name: "first_name", bank: "ok", account: "ok" });
});

test("M9. Paid Date given separately for each landlord is saved separately", async () => {
  const text = `Jamuna - UTR: ${U.J} - Paid Date: 05-Nov-2026\nSuresh - UTR: ${U.S} - Paid Date: 06-Nov-2026\nMurali - UTR: ${U.M} - Paid Date: 07-Nov-2026`;
  const x = await run({ lookupLandlords: reply(text) });
  assert.deepEqual(x.calls.saver.map((b) => [b.payments[0].landOwnerId, b.date]), [["oJ", "2026-11-05"], ["oS", "2026-11-06"], ["oM", "2026-11-07"]]);
  assert.deepEqual(one(x.r).landlordMappings.map((m) => m.paidDateSource), ["email_payment_date", "email_payment_date", "email_payment_date"]);
});

test("M10. Paid Date missing -> the existing fallback (reply sent date) per landlord; a mix works too; bad dates fall back", async () => {
  const none = await run({ lookupLandlords: reply(THREE) });
  assert.deepEqual(none.calls.saver.map((b) => b.date), ["2026-11-09", "2026-11-09", "2026-11-09"]);
  assert.ok(one(none.r).landlordMappings.every((m) => m.paidDateSource === "email_sent_date"));
  const mix = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J} - Paid Date: 05-Nov-2026\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M} - Paid Date: 31-Feb-2026`) });
  assert.deepEqual(mix.calls.saver.map((b) => [b.date, mix.calls.saver.length]), [["2026-11-05", 3], ["2026-11-09", 3], ["2026-11-09", 3]]);
  // a future Paid Date is not used for that landlord
  const future = await run({ lookupLandlords: reply(`Jamuna - UTR: ${U.J} - Paid Date: 25-Dec-2026\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(future.calls.saver[0].date, "2026-11-09");
  assert.deepEqual(one(future.r).landlordMappings[0].paidDateSource, "email_sent_date");
});

test("M11. a landlord is matched by first name or by full name, whole words only", async () => {
  const x = await run({ lookupLandlords: reply(`K. Jamuna - UTR: ${U.J}\nSuresh - UTR: ${U.S}\nMUR - UTR: ${U.M}`) });
  assert.equal(one(x.r).reason, "landlord_name_not_found"); // "MUR" is not a whole word of Murali
  const y = await run({ lookupLandlords: reply(`K. Jamuna - UTR: ${U.J}\nsuresh - UTR: ${U.S}\nMURALI - UTR: ${U.M}`) });
  assert.deepEqual(one(y.r).landlordMappings.map((m) => m.matchedBy), ["full_name", "first_name", "first_name"]);
  const z = await run({ lookupLandlords: reply(`Ramesh - UTR: ${U.J}\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(z.r).reason, "landlord_name_not_found");
});

test("M12. ALL landlords must come in ONE mail: UTR lines spread over two replies are never combined", async () => {
  const two = () => ({ data: { billNumber: MULTI_BILL, extractionStatus: "found", threadId: "T9", approvalMailLandlords: MAIL(), replies: [
    { messageId: "M1", from: "f", sentAt: "2026-11-09T10:00:00.000Z", sentDate: "2026-11-09", lines: extractLandlordUtrLines(`Jamuna - UTR: ${U.J}\nSuresh - UTR: ${U.S}`) },
    { messageId: "M2", from: "f", sentAt: "2026-11-09T11:00:00.000Z", sentDate: "2026-11-09", lines: extractLandlordUtrLines(`Murali - UTR: ${U.M}`) },
  ] } });
  const x = await run({ lookupLandlords: two });
  assert.equal(one(x.r).reason, "utrs_in_multiple_replies");
  assert.equal(x.calls.saver.length, 0);
});

test("M13. dry run shows every landlord -> UTR mapping and saves nothing; real save needs its own switch", async () => {
  const dry = setup({ docs: [multiDoc()], lookupLandlords: reply(THREE), saveEnabled: false });
  const r = (await dry.p.processPendingUtrs({})).results[0];
  assert.equal(r.dryRun, true);
  assert.equal(r.paymentType, "multi_landlord");
  assert.equal(r.mappingStatus, "per_landlord_verified");
  assert.equal(r.eligibleForSaving, true);
  assert.deepEqual(r.landlordMappings.map((m) => [m.landlord, m.utr, m.paidDate, m.paymentMode]), [["K. Jamuna", U.J, "2026-11-09", "Online"], ["K. Suresh", U.S, "2026-11-09", "Online"], ["K. Murali", U.M, "2026-11-09", "Online"]]);
  assert.ok(r.savingBlockedBy.includes("GMAIL_UTR_SAVE_ENABLED is off"));
  assert.ok(r.savingBlockedBy.includes("GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED is off"));
  assert.equal(dry.calls.saver.length, 0);
  assert.equal(dry.Log.rows.length, 0);
  // real run, multi switch off: blocked BEFORE Gmail is searched
  const off = setup({ docs: [multiDoc()], lookupLandlords: reply(THREE), multiSave: false });
  const o = (await off.p.processPendingUtrs({ dryRun: false })).results[0];
  assert.equal(o.reason, "multi_landlord_auto_save_disabled");
  assert.equal(off.calls.lookupLandlords.length, 0);
  assert.equal(off.calls.saver.length, 0);
  // a Cash landlord needs the Cash switch as well
  const cashDoc = multiDoc({ landOwners: [owner({ _id: "oJ", name: "K. Jamuna", paymentCategory: 1 }), ...LL().slice(1)] });
  const c = setup({ docs: [cashDoc], lookupLandlords: reply(THREE), multiSave: true, cashSave: false });
  assert.equal((await c.p.processPendingUtrs({ dryRun: false })).results[0].reason, "cash_auto_save_disabled");
  assert.equal(c.calls.saver.length, 0);
});

test("M14. single landlord keeps the simple 'UTR : value' path (no landlord lookup)", async () => {
  const x = setup({ docs: [site()] });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(x.calls.lookup.length, 1);
  assert.equal(x.calls.lookupLandlords.length, 0);
});

test("M15. GST on hold on a multi-landlord bill is held back before Gmail while the GST switch is off: no lookup, no save", async () => {
  const doc = multiDoc({
    rentalDue: [row({ _id: "rm", adinn_ooh_bills: MULTI_BILL, withGst: 1 })],
    gstBalanceHistory: [{ _id: "g", rentalDueId: "rm", dueMonth: "November 2026", ownerId: "oJ", isPaid: false, utrNumber: "", gstAmount: 10 }],
  });
  const x = setup({ docs: [doc], lookupLandlords: reply(THREE), multiSave: true });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "ambiguous_mapping");
  assert.equal(one(r).reason, "gst_split_auto_save_disabled");
  assert.equal(x.calls.lookupLandlords.length, 0);
  assert.equal(x.calls.saver.length, 0);
});

test("M16. a landlord who is already paid: his line must repeat the stored UTR; only the open landlords are saved", async () => {
  const paidJ = multiDoc({ ledger: [payRow("rm", "oJ", "Online", { utrNumber: U.J })] });
  const ok = await run({ doc: paidJ, lookupLandlords: reply(THREE) });
  assert.deepEqual(ids(ok.calls), [["oS", U.S], ["oM", U.M]]);
  const without = await run({ doc: paidJ, lookupLandlords: reply(`Suresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.deepEqual(ids(without.calls), [["oS", U.S], ["oM", U.M]]);
  const wrong = await run({ doc: paidJ, lookupLandlords: reply(`Jamuna - UTR: SBIN92023012200543999\nSuresh - UTR: ${U.S}\nMurali - UTR: ${U.M}`) });
  assert.equal(one(wrong.r).reason, "settled_landlord_utr_mismatch");
  assert.equal(wrong.calls.saver.length, 0);
});

test("M17. a database failure in the middle is reported, and the retry saves only the landlords still open", async () => {
  let failOnce = true;
  const saver = (batch, db) => {
    const pay = batch.payments[0];
    if (pay.landOwnerId === "oS" && failOnce) { failOnce = false; return { statusCode: 207, data: { sitesFailed: 1, savedEntries: [{ status: "failed", error: "rentalDue record not found" }] } }; }
    db.get("mm").ledger.push({ rentalDueId: pay.rentalDueId, landOwnerId: pay.landOwnerId, paymentMode: pay.paymentMode, utrNumber: pay.utrNumber, status: 1, isUtrEntry: false });
    return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 10000 }] } };
  };
  const x = setup({ docs: [multiDoc()], lookupLandlords: reply(THREE), saver, multiSave: true });
  const first = await x.p.processPendingUtrs({ dryRun: false, force: true });
  assert.equal(one(first).status, "database_error");
  assert.match(one(first).reason, /partial_save 1\/3/);
  assert.equal(x.calls.saver.length, 2); // Jamuna saved, Suresh failed, Murali never attempted
  const retry = await x.p.processPendingUtrs({ dryRun: false, force: true });
  assert.equal(one(retry).status, "found_and_saved");
  assert.deepEqual(x.calls.saver.slice(2).map((b) => b.payments[0].landOwnerId), ["oS", "oM"]); // Jamuna is not saved twice
});

test("M18. Gmail outcomes for a multi-landlord bill: not found, no UTR lines, several conversations, other Bill Numbers", async () => {
  const st = async (data) => one((await run({ lookupLandlords: () => ({ data: { billNumber: MULTI_BILL, ...data } }) })).r);
  assert.equal((await st({ extractionStatus: "bill_not_found" })).status, "bill_not_found");
  assert.equal((await st({ extractionStatus: "utr_not_found", replies: [] })).status, "utr_not_found");
  assert.equal((await st({ extractionStatus: "multiple_review_required" })).status, "multiple_review_required");
  const amb = await st({ extractionStatus: "ambiguous_bill_numbers" });
  assert.equal(amb.status, "ambiguous_mapping");
  assert.equal(amb.reason, "thread_mentions_other_bill_numbers");
});

test("M19. API 1: a multi-landlord bill stays mappingSafe:false (multiple_landlords) and exposes the per-landlord mapping", async () => {
  const b = (await pending([multiDoc({ ledger: [payRow("rm", "oJ", "Online", { utrNumber: U.J })] })])).bills[0];
  assert.equal(b.mappingSafe, false);
  assert.equal(b.skipReason, "multiple_landlords");
  assert.equal(b.perLandlordMapping.eligible, true);
  assert.deepEqual(b.perLandlordMapping.landlords.map((l) => [l.name, l.state, l.accountLast4, l.storedUtr]), [["K. Jamuna", "settled", "8647", U.J], ["K. Suresh", "pending", "6355", null], ["K. Murali", "pending", "6039", null]]);
  const gst = (await pending([multiDoc({ rentalDue: [row({ _id: "rm", adinn_ooh_bills: MULTI_BILL, withGst: 1 })], gstBalanceHistory: [{ _id: "g", rentalDueId: "rm", dueMonth: "November 2026", ownerId: "oJ", isPaid: false, utrNumber: "", gstAmount: 10 }] })])).bills[0];
  assert.equal(gst.perLandlordMapping.eligible, false);
  const single = (await pending([site()])).bills[0];
  assert.equal(single.perLandlordMapping, null);
  const twice = (await pending([multiDoc({ landOwners: [owner({ _id: "oJ", name: "K. Jamuna", paymentCategory: 3 }), ...LL().slice(1)] })])).bills[0];
  assert.equal(twice.perLandlordMapping.eligible, false);
  assert.ok(twice.perLandlordMapping.reasons.includes("landlord_with_two_open_payments"));
});

test("M20. a reply naming nobody of THIS bill (pasted from another bill) is ignored and reported; two relevant replies still block", async () => {
  const MALA = [owner({ _id: "oMa", landOwnerMasterId: "mMa", name: "MALA M", paymentCategory: 2, bankName: "INDIAN BANK", accountNumber: "1111111111838" }), owner({ _id: "oAn", landOwnerMasterId: "mAn", name: "ANANDAN JOTHI S", paymentCategory: 2, bankName: "LAXMI VILAS BANK", accountNumber: "2222222221022" })];
  const doc = () => multiDoc({ landOwners: MALA });
  const mail = [{ name: "MALA M", bank: "INDIAN BANK", accountLast4: "1838" }, { name: "ANANDAN JOTHI S", bank: "LAXMI VILAS BANK", accountLast4: "1022" }];
  const rep = (id, text, sentAt) => ({ messageId: id, from: "f", sentAt, sentDate: sentAt.slice(0, 10), lines: extractLandlordUtrLines(text) });
  const wrong = rep("M1", THREE, "2026-11-10T05:39:28.000Z"); // K. Jamuna / K. Suresh / K. Murali: none of them is on this bill
  const right = rep("M2", `Mala M - UTR: ${U.J}\nAnandan Jothi S - UTR: ${U.S}`, "2026-11-10T05:43:25.000Z");
  const lk = (...replies) => () => ({ data: { billNumber: MULTI_BILL, extractionStatus: "found", threadId: "T9", approvalMailLandlords: mail, replies } });

  const ok = await run({ doc: doc(), lookupLandlords: lk(wrong, right) });
  assert.equal(one(ok.r).status, "found_and_saved");
  assert.deepEqual(ids(ok.calls), [["oMa", U.J], ["oAn", U.S]]);
  assert.deepEqual(one(ok.r).ignoredReplies.map((x) => [x.messageId, x.reason]), [["M1", "names_match_no_landlord_of_this_bill"]]);
  assert.equal(one(ok.r).sourceMessageId, "M2");

  // the same, in the dry run
  const dry = setup({ docs: [doc()], lookupLandlords: lk(wrong, right) });
  const d = (await dry.p.processPendingUtrs({})).results[0];
  assert.equal(d.ignoredReplies[0].messageId, "M1");
  assert.deepEqual(d.landlordMappings.map((m) => m.landlord), ["MALA M", "ANANDAN JOTHI S"]);
  assert.equal(dry.calls.saver.length, 0);

  // two replies that BOTH name this bill's landlords: still never combined
  const twice = await run({ doc: doc(), lookupLandlords: lk(right, rep("M3", `Mala M - UTR: ${U.M}`, "2026-11-10T06:00:00.000Z")) });
  assert.equal(one(twice.r).reason, "utrs_in_multiple_replies");
  assert.equal(twice.calls.saver.length, 0);
  // a reply with an unnamed UTR line is still "about this bill" (it needs a human), so it blocks too
  const unnamed = await run({ doc: doc(), lookupLandlords: lk(rep("M4", `UTR: ${U.M}`, "2026-11-10T05:50:00.000Z"), right) });
  assert.equal(one(unnamed.r).reason, "utrs_in_multiple_replies");
  // only the wrong mail exists: nothing to save, names not found
  const only = await run({ doc: doc(), lookupLandlords: lk(wrong) });
  assert.equal(one(only.r).reason, "landlord_name_not_found");
  assert.equal(only.calls.saver.length, 0);
  // two wrong mails and nothing else stay blocked (nothing is chosen between them)
  const bothWrong = await run({ doc: doc(), lookupLandlords: lk(wrong, rep("M5", `Ramesh - UTR: ${U.M}`, "2026-11-10T05:50:00.000Z")) });
  assert.equal(one(bothWrong.r).reason, "utrs_in_multiple_replies");
});

// ───────────────────────── GST on hold, one landlord: "Rent - UTR" and "GST - UTR", usually days apart ─────────────────────────
const SPLIT_BILL = "ADNOOHBILL11112026101";
const RU = "RENT92023012200543116";
const GU = "GSTX92023012200543117";
const splitDoc = (over = {}) => site({
  _id: "sp",
  mediaDetails: [faceOf("fa", "ADINCHN0188", "Kasi Theatre towards Gunidy"), faceOf("fb", "ADINCHN0189", "Kasi Theatre towards Ashok Pillars")],
  landOwners: [owner({ _id: "oV", landOwnerMasterId: "mV", name: "VENKATESAN PRASANNA KUMAR", paymentCategory: 2, bankName: "INDIAN OVERSEAS BANK", accountNumber: "1400000004565" })],
  rentalDue: [
    billRow("s1", "fa", SPLIT_BILL, { dueMonth: "November 2026", dueDate: new Date("2026-11-11T00:00:00Z"), withGst: 1, gstAmount: 5400 }),
    billRow("s2", "fb", SPLIT_BILL, { dueMonth: "November 2026", dueDate: new Date("2026-11-11T00:00:00Z"), withGst: 1, gstAmount: 5400 }),
  ],
  gstBalanceHistory: [{ _id: "gx", rentalDueId: "s1", dueMonth: "November 2026", ownerId: "oV", isPaid: false, utrNumber: "", gstAmount: 10800 }],
  ...over,
});
const MAILV = () => [{ name: "VENKATESAN PRASANNA KUMAR", bank: "INDIAN OVERSEAS BANK", accountLast4: "4565" }];
const rep2 = (id, text, sentAt) => ({ messageId: id, from: "Finance <f@x.com>", sentAt, sentDate: sentAt.slice(0, 10), lines: extractLandlordUtrLines(text) });
const lkS = (replies, mail = MAILV()) => () => ({ data: { billNumber: SPLIT_BILL, extractionStatus: "found", threadId: "TS", approvalMailLandlords: mail, replies: typeof replies === "function" ? replies() : replies } });
const RENT_AT = "2026-11-03T05:00:00.000Z";
const GST_AT = "2026-11-09T05:00:00.000Z";
const runS = (o = {}) => { const x = setup({ docs: [splitDoc(o.doc)], gstSave: true, ...o }); return x.p.processPendingUtrs({ dryRun: false, force: true }).then((r) => ({ ...x, r })); };
const kinds = (calls) => calls.saver.map((b) => [b.entryType, b.payments[0].utrNumber, b.payments[0].paymentMode, b.payments[0].rentalDueId, b.date]);

test("G1. API 1: a GST-on-hold bill (one landlord) stays mappingSafe:false but exposes the Rent / GST slots", async () => {
  const b = (await pending([splitDoc()])).bills[0];
  assert.equal(b.mappingSafe, false);
  assert.equal(b.skipReason, "gst_separate_utr");
  assert.equal(b.gstSplitMapping.eligible, true);
  assert.deepEqual(b.gstSplitMapping.slots.map((x) => [x.kind, x.paymentMode, x.rentalDueId]), [["rent", "Online", "s1"], ["gst", "Online", "s1"]]);
  assert.equal(b.gstSplitMapping.slots[1].gstAmount, 10800);
  // rent already paid -> only the GST slot; GST already paid -> only the rent slot
  const rentPaid = (await pending([splitDoc({ ledger: [payRow("s1", "oV", "Online")] })])).bills[0];
  assert.deepEqual(rentPaid.gstSplitMapping.slots.map((x) => x.kind), ["gst"]);
  const gstPaid = (await pending([splitDoc({ gstBalanceHistory: [{ _id: "gx", rentalDueId: "s1", dueMonth: "November 2026", ownerId: "oV", isPaid: true, utrNumber: GU, gstAmount: 10800 }] })])).bills[0];
  assert.deepEqual(gstPaid.gstSplitMapping.slots.map((x) => x.kind), ["rent"]);
  // not eligible: no GST row, several landlords, a landlord with two open rent payments; GST included (withGst 2) has no split at all
  assert.equal((await pending([splitDoc({ gstBalanceHistory: [] })])).bills[0].gstSplitMapping.eligible, false);
  assert.equal((await pending([splitDoc({ landOwners: [owner({ _id: "oV", name: "A" }), owner({ _id: "oW", name: "B" })] })])).bills[0].gstSplitMapping.eligible, false);
  assert.equal((await pending([splitDoc({ landOwners: [owner({ _id: "oV", name: "A", paymentCategory: 3 })] })])).bills[0].gstSplitMapping.eligible, false);
  assert.equal((await pending([site({ rentalDue: [row({ withGst: 2 })] })])).bills[0].gstSplitMapping, null);
});

test("G2. rent first, GST weeks later in the SAME thread: each is saved when ITS labelled line appears, with its own Paid Date", async () => {
  const replies = [rep2("R1", `Rent - UTR : ${RU}`, RENT_AT)];
  const x = setup({ docs: [splitDoc()], gstSave: true, lookupLandlords: lkS(() => replies) });
  const first = (await x.p.processPendingUtrs({ dryRun: false, force: true })).results[0];
  assert.equal(first.status, "found_and_saved");
  assert.deepEqual(first.pendingKinds, ["gst"]); // GST still waiting
  assert.deepEqual(kinds(x.calls), [["rental", RU, "Online", "s1", "2026-11-03"]]);
  assert.equal((await pending([...x.db.values()])).bills[0].gstSplitMapping.slots.length, 1); // the bill is still pending (GST)

  replies.push(rep2("R2", `GST - UTR: ${GU}`, GST_AT)); // days later
  const second = (await x.p.processPendingUtrs({ dryRun: false, force: true })).results[0];
  assert.equal(second.status, "found_and_saved");
  assert.deepEqual(kinds(x.calls), [["rental", RU, "Online", "s1", "2026-11-03"], ["gst", GU, "Online", "s1", "2026-11-09"]]);
  assert.equal((await x.p.processPendingUtrs({ dryRun: false, force: true })).pendingTotal, 0); // nothing left, nothing saved twice
  assert.equal(x.calls.saver.length, 2);
});

test("G3. rent and GST in ONE mail: two saves, rent first, then GST (separate ledger calls)", async () => {
  const x = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}\nGST - UTR: ${GU}`, RENT_AT)]) });
  assert.equal(one(x.r).status, "found_and_saved");
  assert.deepEqual(kinds(x.calls), [["rental", RU, "Online", "s1", "2026-11-03"], ["gst", GU, "Online", "s1", "2026-11-03"]]);
  assert.deepEqual(one(x.r).splitPayments.map((q) => [q.kind, q.utr]), [["rent", RU], ["gst", GU]]);
  assert.equal(x.Log.rows[0].splitPayments.length, 2);
});

test("G4. only the GST reply exists (rent still open): GST is saved on its own, the rent waits", async () => {
  const x = await runS({ lookupLandlords: lkS([rep2("R1", `GST - UTR: ${GU}`, GST_AT)]) });
  assert.deepEqual(kinds(x.calls), [["gst", GU, "Online", "s1", "2026-11-09"]]);
  assert.deepEqual(one(x.r).pendingKinds, ["rent"]);
});

test("G5. an unlabelled 'UTR : X' is never used (it could be rent or GST) but is reported", async () => {
  const a = await runS({ lookupLandlords: lkS([rep2("R1", `UTR : ${RU}`, RENT_AT)]) });
  assert.equal(one(a.r).status, "utr_not_found");
  assert.equal(a.calls.saver.length, 0);
  assert.deepEqual(one(a.r).ignoredLines.map((l) => l.reason), ["unlabelled_utr_line"]);
  // the later labelled lines still work; the old unlabelled mail stays ignored
  const b = await runS({ lookupLandlords: lkS([rep2("R1", `UTR : ${RU}`, RENT_AT), rep2("R2", `Rent - UTR: HDFC92023012200543999`, GST_AT)]) });
  assert.deepEqual(kinds(b.calls), [["rental", "HDFC92023012200543999", "Online", "s1", "2026-11-09"]]);
});

test("G6. two different UTRs for the same kind block THAT kind only; the other kind is still saved", async () => {
  const x = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}`, RENT_AT), rep2("R2", `Rent - UTR: HDFC92023012200543999\nGST - UTR: ${GU}`, GST_AT)]) });
  assert.equal(one(x.r).status, "found_and_saved");
  assert.deepEqual(kinds(x.calls).map((k) => k[0]), ["gst"]);
  assert.deepEqual(one(x.r).blockedKinds, [{ kind: "rent", reason: "conflicting_utr_for_kind" }]);
});

test("G7. the same UTR given for rent AND GST: neither is saved (a UTR cannot pay both)", async () => {
  const x = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}\nGST - UTR: ${RU}`, RENT_AT)]) });
  assert.equal(one(x.r).status, "ambiguous_mapping");
  assert.equal(one(x.r).reason, "duplicate_utr");
  assert.equal(x.calls.saver.length, 0);
});

test("G8. a UTR already stored on the site is not reused; invalid and future dates fall back as usual", async () => {
  const used = splitDoc({ ledgerHistory: [{ year: "2026", months: [{ month: "October", entries: [{ rentalDueId: "old", paymentMode: "Online", utrNumber: RU }] }] }] });
  const a = await runS({ doc: used, lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}\nGST - UTR: ${GU}`, RENT_AT)]) });
  assert.deepEqual(one(a.r).blockedKinds, [{ kind: "rent", reason: "utr_already_used_on_this_site" }]);
  assert.deepEqual(kinds(a.calls).map((k) => k[0]), ["gst"]);
  const b = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU} - Paid Date: 25-Dec-2026\nGST - UTR: ${GU} - Paid Date: 31-Feb-2026`, RENT_AT)]) });
  assert.deepEqual(kinds(b.calls).map((k) => k[4]), ["2026-11-03", "2026-11-03"]); // both fall back to the reply's sent date
});

test("G9. the GST switch is required for a real save (checked BEFORE Gmail); a dry run shows both payments", async () => {
  const off = setup({ docs: [splitDoc()], lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}`, RENT_AT)]), gstSave: false });
  const o = (await off.p.processPendingUtrs({ dryRun: false })).results[0];
  assert.equal(o.reason, "gst_split_auto_save_disabled");
  assert.equal(off.calls.lookupLandlords.length, 0);
  assert.equal(off.calls.saver.length, 0);
  const dry = setup({ docs: [splitDoc()], lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}`, RENT_AT), rep2("R2", `GST - UTR: ${GU}`, GST_AT)]), saveEnabled: false });
  const d = (await dry.p.processPendingUtrs({})).results[0];
  assert.equal(d.dryRun, true);
  assert.equal(d.paymentType, "rent_gst_split");
  assert.equal(d.mappingStatus, "per_payment_verified");
  assert.deepEqual(d.splitPayments.map((q) => [q.kind, q.utr, q.paidDate, q.paidDateSource, q.paymentMode]), [["rent", RU, "2026-11-03", "email_sent_date", "Online"], ["gst", GU, "2026-11-09", "email_sent_date", "Online"]]);
  assert.ok(d.savingBlockedBy.includes("GMAIL_UTR_GST_SAVE_ENABLED is off"));
  assert.equal(dry.calls.saver.length, 0);
  assert.equal(dry.Log.rows.length, 0);
  // Cash rent needs the Cash switch as well
  const cashDoc = splitDoc({ landOwners: [owner({ _id: "oV", name: "VENKATESAN PRASANNA KUMAR", paymentCategory: 1 })] });
  const c = setup({ docs: [cashDoc], lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}`, RENT_AT)]), gstSave: true, cashSave: false });
  assert.equal((await c.p.processPendingUtrs({ dryRun: false })).results[0].reason, "cash_auto_save_disabled");
});

test("G10. label spellings: Rent / Base Rent / Rental / Rent Amount and GST / GST Amount, any case; other labels are ignored", async () => {
  for (const [rentLabel, gstLabel] of [["rent", "gst"], ["Base Rent", "GST Amount"], ["RENTAL", "Gst"], ["Rent Amount", "GST (18%)"]]) {
    const x = await runS({ lookupLandlords: lkS([rep2("R1", `${rentLabel} - UTR: ${RU}\n${gstLabel} - UTR: ${GU}`, RENT_AT)]) });
    assert.deepEqual(kinds(x.calls).map((k) => [k[0], k[1]]), [["rental", RU], ["gst", GU]], rentLabel);
  }
  const other = await runS({ lookupLandlords: lkS([rep2("R1", `TDS - UTR: ${RU}\nSuresh - UTR: ${GU}`, RENT_AT)]) });
  assert.equal(one(other.r).status, "utr_not_found");
  assert.equal(other.calls.saver.length, 0);
  assert.deepEqual(one(other.r).ignoredLines.map((l) => l.reason), ["label_is_not_rent_or_gst", "label_is_not_rent_or_gst"]);
});

test("G11. a Paid Date written on a line wins; the other payment uses its own reply's sent date", async () => {
  const x = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU} - Paid Date: 02-Nov-2026`, RENT_AT), rep2("R2", `GST - UTR: ${GU}`, GST_AT)]) });
  assert.deepEqual(kinds(x.calls).map((k) => k[4]), ["2026-11-02", "2026-11-09"]);
  assert.deepEqual(one(x.r).splitPayments.map((q) => q.paidDateSource), ["email_payment_date", "email_sent_date"]);
});

test("G12. the GST save is a GST entry on the GST row's bill row, Online; rent stays a rental entry — never mixed", async () => {
  const x = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}\nGST - UTR: ${GU}`, RENT_AT)]) });
  assert.deepEqual(x.calls.saver.map((b) => [b.entryType, b.siteBillMode, b.payments.length, b.payments[0].landOwnerId, b.payments[0].targetType]), [["rental", 1, 1, "oV", "current"], ["gst", 1, 1, "oV", "current"]]);
  assert.match(x.calls.saver[1].remark, /^GST UTR auto-saved/);
  assert.match(x.calls.saver[0].remark, /^Rent UTR auto-saved/);
});

test("G13. the approval mail must still match RMS (name / bank / account)", async () => {
  const bad = await runS({ lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}`, RENT_AT)], [{ name: "VENKATESAN PRASANNA KUMAR", bank: "INDIAN OVERSEAS BANK", accountLast4: "0000" }]) });
  assert.equal(one(bad.r).reason, "account_mismatch_approval_mail");
  assert.equal(bad.calls.saver.length, 0);
});

test("G14. GST INCLUDED (withGst 2): rent + GST share one UTR and the simple 'UTR : X' path is unchanged", async () => {
  const x = setup({ docs: [site({ rentalDue: [row({ withGst: 2 })] })], gstSave: false });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(x.calls.lookup.length, 1);
  assert.equal(x.calls.lookupLandlords.length, 0);
  assert.equal(x.calls.saver[0].entryType, "rental");
});

test("G15. a failure on the second payment is reported; the retry saves only what is still open", async () => {
  let failGst = true;
  const saver = (batch, db) => {
    const pay = batch.payments[0];
    if (batch.entryType === "gst" && failGst) { failGst = false; return { statusCode: 207, data: { sitesFailed: 1, savedEntries: [{ status: "failed", error: "gst row not found" }] } }; }
    const m = db.get("sp");
    if (batch.entryType === "gst") { const g = m.gstBalanceHistory.find((x) => x.rentalDueId === pay.rentalDueId); g.isPaid = true; g.utrNumber = pay.utrNumber; }
    else m.ledger.push({ rentalDueId: pay.rentalDueId, landOwnerId: pay.landOwnerId, paymentMode: pay.paymentMode, utrNumber: pay.utrNumber, status: 1, isUtrEntry: false });
    return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 1 }] } };
  };
  const x = setup({ docs: [splitDoc()], gstSave: true, saver, lookupLandlords: lkS([rep2("R1", `Rent - UTR: ${RU}\nGST - UTR: ${GU}`, RENT_AT)]) });
  const first = (await x.p.processPendingUtrs({ dryRun: false, force: true })).results[0];
  assert.equal(first.status, "database_error");
  assert.match(first.reason, /partial_save 1\/2 \(gst:/);
  const retry = (await x.p.processPendingUtrs({ dryRun: false, force: true })).results[0];
  assert.equal(retry.status, "found_and_saved");
  assert.deepEqual(x.calls.saver.slice(2).map((b) => b.entryType), ["gst"]); // the rent is not saved twice
});

test("G16. a GST-hold bill with several landlords and a landlord-less (site level) GST row stays blocked; Gmail outcomes are reported like the other flows", async () => {
  const multi = setup({ docs: [splitDoc({ landOwners: [owner({ _id: "oV", name: "A K" }), owner({ _id: "oW", name: "B K" })], gstBalanceHistory: [{ _id: "gx", rentalDueId: "s1", dueMonth: "November 2026", ownerId: null, isPaid: false, utrNumber: "", gstAmount: 10800 }] })], gstSave: true, multiSave: true });
  const m = (await multi.p.processPendingUtrs({ dryRun: false })).results[0];
  assert.equal(m.status, "ambiguous_mapping");
  assert.equal(multi.calls.saver.length, 0);
  const st = async (data) => one((await runS({ lookupLandlords: () => ({ data: { billNumber: SPLIT_BILL, ...data } }) })).r);
  assert.equal((await st({ extractionStatus: "bill_not_found" })).status, "bill_not_found");
  assert.equal((await st({ extractionStatus: "utr_not_found", replies: [] })).status, "utr_not_found");
  assert.equal((await st({ extractionStatus: "multiple_review_required" })).status, "multiple_review_required");
  assert.equal((await st({ extractionStatus: "ambiguous_bill_numbers" })).reason, "thread_mentions_other_bill_numbers");
});

test("PG1. a stale \"blocked before Gmail\" log never hides a bill: when the switch is turned on it is processed at once", async () => {
  const stale = { billNumber: MULTI_BILL, status: "ambiguous_mapping", reason: "multi_landlord_auto_save_disabled", dryRun: false, createdAt: new Date(Date.now() - 2 * 60000) };
  const x = setup({ docs: [multiDoc()], log: fakeProcLog([stale]), lookupLandlords: reply(THREE), multiSave: true });
  const r = await x.p.processPendingUtrs({ dryRun: false });
  assert.equal(one(r).status, "found_and_saved");
  assert.equal(x.calls.saver.length, 3);
});

test("PG2. blocks that never touch Gmail are summarised (not listed per bill), logged nowhere, and do not use up the per-run limit", async () => {
  const file = process.env.GMAIL_UTR_RUN_LOG_FILE;
  try { fs.unlinkSync(file); } catch (_) { /* none yet */ }
  const gst = (id, bill) => site({ _id: id, rentalDue: [row({ _id: "r" + id, adinn_ooh_bills: bill, withGst: 1 })] });
  const docs = [gst("a", "ADNOOHBILL0611202691"), gst("b", "ADNOOHBILL0611202692"), site({ _id: "c", rentalDue: [row({ _id: "rc", adinn_ooh_bills: "ADNOOHBILL0611202693" })] })];
  const x = setup({ docs });
  const r = await x.p.processPendingUtrs({ dryRun: false, maxBills: 1 });
  assert.equal(r.counts.ambiguous_mapping, 2);
  assert.equal(r.counts.found_and_saved, 1); // maxBills 1 was spent on the one bill that needed Gmail, not on the two blocked ones
  assert.equal(x.Log.rows.length, 1);
  const log = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop());
  assert.deepEqual(log.blockedBeforeGmail, { gst_separate_utr: 2 });
});

// ───────────────────────── Registry cross-check + dueMonth visibility ─────────────────────────
test("REG1. registry record matches site, dueMonth and rows -> saved against that row's month", async () => {
  const { p, calls } = setup();
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(calls.saver[0].payments[0].rentalDueId, "r1");
  assert.equal(r.results[0].dueMonth, "November 2026");
});

test("REG2. registry says another site -> nothing saved, registry_media_mismatch", async () => {
  const { p, calls } = setup({ registry: (n) => ({ mediaId: "other-site", dueMonth: "November 2026", rentalDueIds: ["r1"] }) });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(calls.saver.length, 0);
  assert.equal(r.results[0].status, "ambiguous_mapping");
  assert.equal(r.results[0].reason, "registry_media_mismatch");
});

test("REG3. registry month differs from the row's dueMonth -> nothing saved, registry_month_mismatch (row stays the truth)", async () => {
  const d = site();
  const { p, calls } = setup({ docs: [d], registry: () => ({ mediaId: d._id, dueMonth: "October 2026", rentalDueIds: ["r1"] }) });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(calls.saver.length, 0);
  assert.equal(r.results[0].reason, "registry_month_mismatch");
});

test("REG4. registry does not list the bill's row -> nothing saved, registry_rows_mismatch", async () => {
  const d = site();
  const { p, calls } = setup({ docs: [d], registry: () => ({ mediaId: d._id, dueMonth: "November 2026", rentalDueIds: ["some-other-row"] }) });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(calls.saver.length, 0);
  assert.equal(r.results[0].reason, "registry_rows_mismatch");
});

test("REG5. no registry record for the Bill Number -> nothing saved, registry_record_missing", async () => {
  const { p, calls } = setup({ registry: null });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(calls.saver.length, 0);
  assert.equal(r.results[0].status, "ambiguous_mapping");
  assert.equal(r.results[0].reason, "registry_record_missing");
});

test("REG6. a dry run shows the registry problem too, and the pending list / run log carry dueMonth", async () => {
  const { p } = setup({ registry: null });
  const r = await p.processPendingUtrs({});
  assert.equal(r.dryRun, true);
  assert.equal(r.results[0].reason, "registry_record_missing");
  const list = await getPendingUtrBills({}, { Media: { find: () => ({ select: () => ({ lean: async () => [site()] }) }) }, Log: fakeLog(), helpers: noHelpers, now: NOW });
  assert.equal(list.bills[0].dueMonth, "November 2026");
  const log = JSON.parse(fs.readFileSync(process.env.GMAIL_UTR_RUN_LOG_FILE, "utf8").trim().split(String.fromCharCode(10)).pop());
  assert.equal([...log.matchedBills, ...log.skippedBills][0].dueMonth, "November 2026");
});

test("REG7. the Bill Number's DDMMYYYY is never used: a number whose date is another month still maps by the row's dueMonth", async () => {
  const odd = "ADNOOHBILL0108202601"; // date says August, the row is November 2026
  const d = site({ rentalDue: [row({ adinn_ooh_bills: odd })] });
  const { p, calls } = setup({ docs: [d], lookup: async () => foundReply({ billNumber: odd }) });
  const r = await p.processPendingUtrs({ dryRun: false });
  assert.equal(r.counts.found_and_saved, 1);
  assert.equal(r.results[0].dueMonth, "November 2026");
  assert.equal(calls.saver[0].payments[0].rentalDueId, "r1");
});
