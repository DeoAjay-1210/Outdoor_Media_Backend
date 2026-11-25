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

const NOV = 2026 * 12 + 10;
const ap = { rentalDueApprovalStatus: 3 };

test("U1. rent + held GST both unpaid → unpaid (rentAndGst); no GST row → rentOnly", () => {
  const a = { _id: "a", ledger: [rent(ap)], gstBalanceHistory: [gst(ap)] };
  const b = { _id: "b", ledger: [rent({ ...ap, rentalDueId: "b2" })], gstBalanceHistory: [] };
  const c = { _id: "c", ledger: [rent({ ...ap, rentalDueId: "b3" })], gstBalanceHistory: [gst({ ...ap, rentalDueId: "b3", withGst: 2 })] };
  const r = filterLedgerRows([a, b, c], { paymentInfoStatus: 4, refKey: NOV });
  assert.strictEqual(r.sites.length, 3);
  assert.strictEqual(r.sites[0].ledger[0].isUnpaid, true);
  assert.strictEqual(r.sites[0].gstBalanceHistory[0].isUnpaid, true);
  assert.strictEqual(r.sites[2].gstBalanceHistory[0].isUnpaid, undefined); // direct GST row not marked
  assert.deepStrictEqual(r.counts.unpaid, { sites: 3, landOwners: 1, bills: 3, rentAndGst: 1, rentOnly: 2, rentAmount: 210000, gstAmount: 12600, amount: 222600 });
});

test("U2. not unpaid: rent paid / GST paid / not approved / future month / ₹0 rent / one of Cash+Online paid", () => {
  const sites = [
    { _id: "1", ledger: [rent({ ...ap, utrNumber: "u" })], gstBalanceHistory: [gst(ap)] },
    { _id: "2", ledger: [rent(ap)], gstBalanceHistory: [gst({ ...ap, isPaid: true })] },
    { _id: "3", ledger: [rent({ rentalDueApprovalStatus: 1 })], gstBalanceHistory: [] },
    { _id: "4", ledger: [rent({ ...ap, dueMonth: "December 2026" })], gstBalanceHistory: [] },
    { _id: "5", ledger: [rent({ ...ap, onlineAmount: 0 })], gstBalanceHistory: [] },
    { _id: "6", ledger: [rent({ ...ap, utrNumber: "u" }), rent({ ...ap, paymentMode: "Cash", cashAmount: 5000 })], gstBalanceHistory: [] },
  ];
  const r = filterLedgerRows(sites, { paymentInfoStatus: 4, refKey: NOV });
  assert.strictEqual(r.sites.length, 0);
  assert.strictEqual(r.counts.unpaid.bills, 0);
});

test("U3. New Bill site-level GST shared by two owners is counted once", () => {
  const nb = { billType: "newBill", rentalDueId: "nb" };
  const site = { _id: "s", ledger: [rent(nb), rent({ ...nb, landOwnerId: "o2" })], gstBalanceHistory: [gst({ ...nb, ownerId: null })] };
  const r = filterLedgerRows([site], { paymentInfoStatus: 4, refKey: NOV });
  assert.strictEqual(r.counts.unpaid.bills, 2);
  assert.strictEqual(r.counts.unpaid.gstAmount, 12600);
});

test("D1. Paid tab: only sites where every approved month up to the reference month is paid", () => {
  const pi2 = { paymentInfo: { paymentInfoStatus: 2 } };
  const oct = { ...ap, dueMonth: "October 2026", rentalDueId: "oct" };
  // M.Vidya case: Oct paid, Nov Yet to Payment → not Paid (stays in Yet to Payment)
  const half = { _id: "h", ledger: [rent({ ...oct, utrNumber: "u", ...pi2 }), rent({ ...ap, paymentInfo: { paymentInfoStatus: 1 } })], gstBalanceHistory: [] };
  // every month paid; Dec bill (later month) and a not approved bill do not block; direct GST ignored
  const full = {
    _id: "f",
    ledger: [rent({ ...oct, utrNumber: "u1", ...pi2 }), rent({ ...ap, utrNumber: "u2", ...pi2 }), rent({ ...ap, dueMonth: "December 2026", rentalDueId: "dec" }), rent({ rentalDueApprovalStatus: 1, rentalDueId: "x" })],
    gstBalanceHistory: [gst({ ...oct, withGst: 2 })],
  };
  // rent paid but held GST unpaid → not Paid
  const gstOpen = { _id: "g", ledger: [rent({ ...ap, utrNumber: "u", ...pi2 })], gstBalanceHistory: [gst(ap)] };
  const r = filterLedgerRows([half, full, gstOpen], { paymentInfoStatus: 2, refKey: NOV });
  assert.deepStrictEqual(r.sites.map((s) => s._id), ["f"]);
  assert.strictEqual(r.counts.completed.sites, 1);
  assert.strictEqual(r.counts.completed.rows, 2);
  assert.strictEqual(filterLedgerRows([half], { paymentInfoStatus: 1, refKey: NOV }).sites.length, 1);
});

test("P5. New Bill site-level GST (ownerId null) vs all rent rows of the bill; status 1/2 tabs keep counts + isPartialPaid", () => {
  const site = {
    _id: "s1",
    ledger: [rent({ billType: "newBill", rentalDueId: "nb", utrNumber: "u1", paymentInfo: { paymentInfoStatus: 2 } })],
    gstBalanceHistory: [gst({ billType: "newBill", rentalDueId: "nb", ownerId: null })],
  };
  // ✅ CHANGED — GST still unpaid → not in the Paid tab / Completed count; Partial tab marks it
  const r = filterLedgerRows([site], { paymentInfoStatus: 2 });
  assert.strictEqual(r.sites.length, 0);
  assert.strictEqual(r.counts.completed.rows, 0);
  assert.strictEqual(r.counts.partialPaid.rentPaidGstPending, 1);
  const r3 = filterLedgerRows([site], { paymentInfoStatus: 3 });
  assert.strictEqual(r3.sites[0].ledger[0].isPartialPaid, true);
  // without paymentInfoStatus rows are not marked
  const r2 = filterLedgerRows([site], { cmdApproval: false });
  assert.strictEqual(r2.sites[0].ledger[0].isPartialPaid, undefined);
});
