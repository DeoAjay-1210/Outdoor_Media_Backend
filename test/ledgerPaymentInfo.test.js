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

test("L3 cmdApproval = site-filter sites (open CMD bill, unpaid row; GST only when held) with all rows; tabs = sites with that status, all rows", () => {
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
        { rentalDueId: "b1", landOwnerId: "o1", paymentMode: "Online", isVirtual: true, onlineAmount: 10000, rentalDueApprovalStatus: 3 },
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
  // cmdApproval → the site (b1 open + unpaid) with ALL its rows, like the normal list
  const r = L.filterLedgerRows([site], { cmdApproval: true, cmdBySite });
  assert.equal(r.sites.length, 1);
  assert.equal(r.sites[0].ledger.length, 5);
  assert.equal(r.sites[0].gstBalanceHistory.length, 2);
  assert.deepEqual(r.counts.yetToPayment, { sites: 1, landOwners: 1, rows: 1, amount: 10000 });
  // ✅ CHANGED — Completed counts only sites where every month is paid (b1 still unpaid)
  assert.deepEqual(r.counts.completed, { sites: 0, landOwners: 0, rows: 0, amount: 0 });

  // tabs → sites with a row in that state, ALL rows kept (each row has its paymentInfo)
  const yet = L.filterLedgerRows([site], { cmdApproval: true, paymentInfoStatus: 1, cmdBySite });
  assert.equal(yet.sites.length, 1);
  assert.equal(yet.sites[0].ledger.length, 5);
  assert.equal(yet.sites[0].gstBalanceHistory.length, 2);
  // ✅ CHANGED — Paid tab: a site with a month still unpaid (b1) is not listed
  const done = L.filterLedgerRows([site], { cmdApproval: true, paymentInfoStatus: 2, cmdBySite });
  assert.equal(done.sites.length, 0);
  const gstOnlySaved = { _id: "s9", ledger: [{ rentalDueId: "b1", isVirtual: true, paymentInfo: null, rentalDueApprovalStatus: 3, onlineAmount: 100 }], gstBalanceHistory: [{ rentalDueId: "b1", rentalDueApprovalStatus: 3, paymentInfo: { paymentInfoStatus: 1, source: "paymentInfo" } }] };
  const g1 = L.filterLedgerRows([gstOnlySaved], { paymentInfoStatus: 1 });
  assert.equal(g1.sites[0].ledger.length, 1); // i32423u4 case: rent row shown though only GST saved
  assert.equal(L.filterLedgerRows([gstOnlySaved], { paymentInfoStatus: 2 }).sites.length, 0);

  // a site whose only unpaid CMD row is direct GST (withGst 2) is not a cmdApproval site (ADINCHN0070 case)
  const onlyGstDirect = { _id: "s1", ledger: [site.ledger[3]], gstBalanceHistory: [site.gstBalanceHistory[0]] };
  assert.equal(L.filterLedgerRows([onlyGstDirect], { cmdApproval: true, cmdBySite }).sites.length, 0);
  // a site with only an unpaid GST hold row is (rows all kept)
  const gstHoldOnly = { _id: "s1", ledger: [site.ledger[3]], gstBalanceHistory: [site.gstBalanceHistory[1]] };
  const g = L.filterLedgerRows([gstHoldOnly], { cmdApproval: true, cmdBySite });
  assert.equal(g.sites.length, 1);
  assert.equal(g.sites[0].ledger.length, 1);
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
