// /admin/ledger-list payment details + cmdApproval / paymentInfoStatus row filters (utils/ledgerPaymentInfo.js). Pure, no DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../utils/ledgerPaymentInfo");

const info = (o) => ({ entryType: "rent", paymentMode: "Online", billType: "bill", paymentThrough: "HDFC", typeOfPayment: "NEFT", bankRefNo: "R1", narration: "n", updatedBy: "Ajay", updatedAt: "2026-11-23", ...o });
const cmdSteps = [{ role: 1, status: 2 }, { role: 2, status: 2 }, { role: 3, status: 2 }];

test("L1 rent row: matched by rentalDueId + landowner + mode; UTR entered → Completed", () => {
  const infos = [info({ rentalDueId: "b1", landOwnerId: "o1" })];
  const rows = L.withRentPaymentInfo(
    [
      { rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Online", utrNumber: "", isVirtual: true },
      { rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Online", utrNumber: "UTR9" },
      { rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Cash", isVirtual: true },
      { rentalDueId: "b2", landOwnerId: "o1", paymentMode: "Online", isVirtual: true },
    ],
    infos,
  );
  assert.equal(rows[0].paymentInfo.paymentInfoStatus, 1);
  assert.equal(rows[0].paymentInfo.paymentInfoStatusLabel, "Yet to Payment");
  assert.equal(rows[0].paymentInfo.bankRefNo, "R1");
  assert.equal(rows[1].paymentInfo.paymentInfoStatus, 2);
  assert.equal(rows[2].paymentInfo, null); // other mode
  assert.equal(rows[3].paymentInfo, null); // other bill
});

test("L2 GST row: by _id, else rentalDueId + owner (virtual row, then paid row)", () => {
  const infos = [{ ...info({ entryType: "gst", rentalDueId: "b1", landOwnerId: "o1" }) }, { ...info({ entryType: "gst", gstBalanceHistoryId: "g9" }) }];
  const rows = L.withGstPaymentInfo(
    [
      { rentalDueId: "b1", landOwnerId: "o1", isPaid: false, isVirtual: true },
      { _id: "g5", rentalDueId: "b1", ownerId: "o1", isPaid: true, utrNumber: "U" },
      { _id: "g9", isPaid: false },
      { rentalDueId: "b1", landOwnerId: "o2", isPaid: false },
    ],
    infos,
  );
  assert.equal(rows[0].paymentInfo.paymentInfoStatus, 1);
  assert.equal(rows[1].paymentInfo.paymentInfoStatus, 2);
  assert.equal(rows[2].paymentInfo.paymentInfoStatus, 1);
  assert.equal(rows[3].paymentInfo, null);
});

test("L3 cmdApproval = site-filter bills: open CMD approved rentalDue bills, unpaid rows; GST only when held (withGst 1)", () => {
  const due = (id, o = {}) => ({ _id: id, approvalStatus: 3, approvalSteps: cmdSteps, withGst: 0, ...o });
  const cmd = {
    approved: new Set(["b1", "b3", "b4", "b5", "b6"]), // CMD approved up to the month
    open: new Set(["b1", "b3", "b5", "b6"]), // b4 settled
    bills: new Map([["b1", due("b1")], ["b3", due("b3", { approvedVia: "advance" })], ["b4", due("b4")], ["b5", due("b5", { withGst: 2 })], ["b6", due("b6", { withGst: 1 })]]),
  };
  const infos = [info({ rentalDueId: "b1", landOwnerId: "o1" }), info({ rentalDueId: "b4", landOwnerId: "o1" })];
  const site = {
    _id: "s1",
    ledger: L.withRentPaymentInfo(
      [
        { rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Online", isVirtual: true, onlineAmount: 10000 },
        { rentalDueId: "b2", landOwnerId: "o1", paymentMode: "Online", isVirtual: true, onlineAmount: 5000 }, // not CMD approved
        { rentalDueId: "b3", landOwnerId: "o1", paymentMode: "Online", isVirtual: true, onlineAmount: 0 }, // ₹0 advance bill
        { rentalDueId: "b4", landOwnerId: "o1", paymentMode: "Online", utrNumber: "U4", onlineAmount: 7000 }, // settled
        { rentalDueId: "a1", billType: "advance", landOwnerId: "o1", paymentMode: "Online", isVirtual: true, rentalDueApprovalStatus: 3 }, // not in site-filter
      ],
      infos,
    ),
    gstBalanceHistory: [
      { rentalDueId: "b5", landOwnerId: "o1", gstAmount: 9450, isPaid: false, isVirtual: true }, // direct GST (withGst 2) → out
      { rentalDueId: "b6", landOwnerId: "o1", gstAmount: 1800, isPaid: false, isVirtual: true }, // GST hold → in
    ],
  };
  const cmdBySite = new Map([["s1", cmd]]);
  const r = L.filterLedgerRows([site], { cmdApproval: true, cmdBySite });
  assert.deepEqual(r.sites[0].ledger.map((x) => x.rentalDueId), ["b1"]);
  assert.deepEqual(r.sites[0].gstBalanceHistory.map((x) => x.rentalDueId), ["b6"]);
  assert.deepEqual(r.counts.yetToPayment, { sites: 1, landOwners: 1, rows: 1, amount: 10000 });
  assert.deepEqual(r.counts.completed, { sites: 1, landOwners: 1, rows: 1, amount: 7000 });

  const yet = L.filterLedgerRows([site], { cmdApproval: true, paymentInfoStatus: 1, cmdBySite });
  assert.deepEqual(yet.sites[0].ledger.map((x) => x.rentalDueId), ["b1"]);
  const done = L.filterLedgerRows([site], { cmdApproval: true, paymentInfoStatus: 2, cmdBySite });
  assert.deepEqual(done.sites[0].ledger.map((x) => x.rentalDueId), ["b4"]);
  const onlyGstDirect = { _id: "s1", ledger: [], gstBalanceHistory: [site.gstBalanceHistory[0]] };
  assert.equal(L.filterLedgerRows([onlyGstDirect], { cmdApproval: true, cmdBySite }).sites.length, 0); // ADINCHN0070 case
  const none = L.filterLedgerRows([{ _id: "s2", ledger: [{ rentalDueId: "x", isVirtual: true }], gstBalanceHistory: [] }], { paymentInfoStatus: 1 });
  assert.equal(none.sites.length, 0);
});

test("L4 save body: validation + same-row key", () => {
  assert.match(L.parsePaymentInfoBody({ rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Online" }).error, /at least one/);
  assert.match(L.parsePaymentInfoBody({ landOwnerId: "o1", paymentMode: "Online", narration: "x" }).error, /rentalDueId/);
  assert.match(L.parsePaymentInfoBody({ entryType: "gst", narration: "x" }).error, /gstBalanceHistoryId/);
  const p = L.parsePaymentInfoBody({ rentalDueId: "b1", landOwnerId: "o1", paymentMode: "online", narration: " Oct rent " });
  assert.equal(p.values.narration, "Oct rent");
  assert.equal(p.key.paymentMode, "Online");
  assert.equal(L.findInfoIndex([info({ rentalDueId: "b1", landOwnerId: "o1" })], p.key), 0);
  assert.equal(L.findInfoIndex([info({ rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Cash" })], p.key), -1);
});
