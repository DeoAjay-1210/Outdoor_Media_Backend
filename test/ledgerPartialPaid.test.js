// ledger-list paymentInfoStatus 3 — Partial Paid (rent OR GST paid, not both)
const test = require("node:test");
const assert = require("node:assert");
const { filterLedgerRows, partialPaidOf } = require("../utils/ledgerPaymentInfo");

const rent = (o) => ({ billType: "bill", rentalDueId: "b1", dueMonth: "November 2026", landOwnerId: "o1", paymentMode: "Online", isVirtual: true, utrNumber: "", onlineAmount: 70000, ...o });
const gst = (o) => ({ billType: "bill", rentalDueId: "b1", dueMonth: "November 2026", ownerId: "o1", withGst: 1, isPaid: false, utrNumber: "", gstAmount: 12600, ...o });

test("P1. GST paid, rent not → partial (gstPaidRentPending)", () => {
  const site = { _id: "s1", ledger: [rent()], gstBalanceHistory: [gst({ isPaid: true, utrNumber: "g1" })] };
  const r = filterLedgerRows([site], { paymentInfoStatus: 3 });
  assert.strictEqual(r.sites.length, 1);
  assert.strictEqual(r.sites[0].ledger[0].isPartialPaid, true);
  assert.strictEqual(r.sites[0].gstBalanceHistory[0].isPartialPaid, true);
  assert.deepStrictEqual(r.counts.partialPaid, { sites: 1, landOwners: 1, bills: 1, rentPaidGstPending: 0, gstPaidRentPending: 1, paidAmount: 12600, pendingAmount: 70000 });
});

test("P2. rent paid, GST not → partial (rentPaidGstPending)", () => {
  const site = { _id: "s1", ledger: [rent({ utrNumber: "u1", isVirtual: false })], gstBalanceHistory: [gst()] };
  const r = filterLedgerRows([site], { paymentInfoStatus: 3 });
  assert.strictEqual(r.counts.partialPaid.rentPaidGstPending, 1);
  assert.strictEqual(r.counts.partialPaid.paidAmount, 70000);
});

test("P3. both paid / none paid / direct GST (withGst 2) → not partial", () => {
  const both = { _id: "a", ledger: [rent({ utrNumber: "u" })], gstBalanceHistory: [gst({ isPaid: true })] };
  const none = { _id: "b", ledger: [rent()], gstBalanceHistory: [gst()] };
  const direct = { _id: "c", ledger: [rent({ utrNumber: "u" })], gstBalanceHistory: [gst({ withGst: 2 })] };
  const r = filterLedgerRows([both, none, direct], { paymentInfoStatus: 3 });
  assert.strictEqual(r.sites.length, 0);
  assert.strictEqual(r.counts.partialPaid.bills, 0);
});

test("P4. Cash + Online: rent paid only when both modes done; other owner's rows not mixed", () => {
  const site = {
    _id: "s1",
    ledger: [rent({ utrNumber: "u1" }), rent({ paymentMode: "Cash", cashAmount: 5000 }), rent({ landOwnerId: "o2", utrNumber: "u2" })],
    gstBalanceHistory: [gst({ isPaid: true })],
  };
  const pp = partialPaidOf(site);
  assert.strictEqual(pp.pairs.length, 1); // o1: GST paid, cash rent pending
  assert.strictEqual(pp.pairs[0].gstDone, true);
  assert.strictEqual(pp.rows.has(site.ledger[2]), false);
});

test("P5. New Bill site-level GST (ownerId null) vs all rent rows of the bill; status 1/2 tabs keep counts + isPartialPaid", () => {
  const site = {
    _id: "s1",
    ledger: [rent({ billType: "newBill", rentalDueId: "nb", utrNumber: "u1", paymentInfo: { paymentInfoStatus: 2 } })],
    gstBalanceHistory: [gst({ billType: "newBill", rentalDueId: "nb", ownerId: null })],
  };
  const r = filterLedgerRows([site], { paymentInfoStatus: 2 });
  assert.strictEqual(r.sites.length, 1);
  assert.strictEqual(r.sites[0].ledger[0].isPartialPaid, true);
  assert.strictEqual(r.counts.completed.rows, 1);
  assert.strictEqual(r.counts.partialPaid.rentPaidGstPending, 1);
  // without paymentInfoStatus rows are not marked
  const r2 = filterLedgerRows([site], { cmdApproval: false });
  assert.strictEqual(r2.sites[0].ledger[0].isPartialPaid, undefined);
});
