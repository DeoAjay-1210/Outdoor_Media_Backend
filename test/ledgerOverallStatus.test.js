// one overall status per site (filter + chip): 1 Yet, 2 Paid, 3 Partially Paid, 4 Unpaid, 5 Partially Yet
const test = require("node:test");
const assert = require("node:assert");
const { siteOverallStatus, filterLedgerRows } = require("../utils/ledgerPaymentInfo");

const M = (m) => ({ rentalDueApprovalStatus: 3, rentalDueId: m, dueMonth: `${m} 2026` });
const rent = (m, state) => ({ ...M(m), billType: "bill", landOwnerId: "o1", paymentMode: "Online", onlineAmount: 1000, isVirtual: state !== "P",
  utrNumber: state === "P" ? "U" : "", paymentInfo: state === "Y" ? { source: "paymentInfo", paymentInfoStatus: 1 } : null });
const gst = (m, state) => ({ ...M(m), billType: "bill", ownerId: "o1", withGst: 1, gstAmount: 100, isPaid: state === "P", utrNumber: "",
  paymentInfo: state === "Y" ? { source: "paymentInfo", paymentInfoStatus: 1 } : null });
const st = (ledger, g = []) => siteOverallStatus({ ledger, gstBalanceHistory: g }, 2026 * 12 + 11);
const Sep = "September", Oct = "October", Nov = "November";

test("O1 rent: Sep ref, Oct unpaid, Nov paid → Partially Yet to Payment", () => {
  assert.strictEqual(st([rent(Sep, "Y"), rent(Oct, "U"), rent(Nov, "P")]), 5);
});
test("O2 rent+GST: Sep rent ref only, rest unpaid, Nov paid → Partially Yet to Payment", () => {
  assert.strictEqual(st([rent(Sep, "Y"), rent(Oct, "U"), rent(Nov, "P")], [gst(Sep, "U"), gst(Oct, "U"), gst(Nov, "P")]), 5);
});
test("O3 Sep+Oct nothing paid, Nov paid → Unpaid; rent paid but GST unpaid in the pending months → Partially Paid", () => {
  assert.strictEqual(st([rent(Sep, "U"), rent(Oct, "U"), rent(Nov, "P")], [gst(Sep, "U"), gst(Oct, "U"), gst(Nov, "P")]), 4);
  assert.strictEqual(st([rent(Sep, "P"), rent(Oct, "P"), rent(Nov, "P")], [gst(Sep, "U"), gst(Oct, "U"), gst(Nov, "P")]), 3);
});
test("O4 one month: rent ref + GST unpaid → Yet to Payment; both ref → Yet to Payment", () => {
  assert.strictEqual(st([rent(Nov, "Y")], [gst(Nov, "U")]), 1);
  assert.strictEqual(st([rent(Nov, "Y")], [gst(Nov, "Y")]), 1);
});
test("O5 Oct unpaid + Nov paid → Unpaid; old paid months ignored", () => {
  assert.strictEqual(st([rent(Oct, "U"), rent(Nov, "P")]), 4);
  assert.strictEqual(st([rent(Sep, "P"), rent(Oct, "Y")]), 1);
});
test("O6 all paid → Paid; same month rent ref + GST paid → Partially Paid; Sep ref + Nov paid → Partially Paid", () => {
  assert.strictEqual(st([rent(Nov, "P")], [gst(Nov, "P")]), 2);
  assert.strictEqual(st([rent(Nov, "Y")], [gst(Nov, "P")]), 3);
  assert.strictEqual(st([rent(Sep, "Y"), rent(Nov, "P")]), 3);
});
test("O7 filters + chip use the same value; Partially Yet shows in Yet to Payment filter", () => {
  const site = { _id: "s", ledger: [rent(Sep, "Y"), rent(Oct, "U"), rent(Nov, "P")], gstBalanceHistory: [] };
  const refKey = 2026 * 12 + 11;
  assert.strictEqual(filterLedgerRows([site], { paymentInfoStatus: 1, refKey }).sites[0].overallPaymentStatus, 5);
  for (const f of [2, 3, 4]) assert.strictEqual(filterLedgerRows([site], { paymentInfoStatus: f, refKey }).sites.length, 0);
});
