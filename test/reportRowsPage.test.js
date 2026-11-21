// Report Analytics popup pages (utils/reportRowsPage.js): one row per landlord, the app's card rules, search, sort, pages. Pure, no DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBillRowsPage, buildPaymentRowsPage, buildGstRowsPage, parseRowsQuery } = require("../utils/reportRowsPage");

const rec = (o) => ({
  siteId: o.siteId, siteName: o.siteName || `Site ${o.siteId}`, city: o.city || "Chennai", paymentCycle: "Monthly", mediaType: "Hoarding",
  mediaCodes: [o.code], faces: [], landlords: (o.landlords || []).map((name) => ({ name })),
  rental: o.total, gst: 0, holdGst: 0, total: o.total, dueDate: o.dueDate || "2026-10-05", bucket: o.bucket || "2026-10",
  billMonth: "October 2026", approvalStatus: o.approved ? "Approved" : "Pending", stage: o.approved ? null : "sales",
  generated: true, approved: !!o.approved, pending: !o.approved, pastDue: !!o.pastDue,
});
const RECS = [
  rec({ siteId: "s1", code: "A1", landlords: ["RAVI"], total: 100, approved: true }),
  rec({ siteId: "s2", code: "A2", landlords: ["RAVI"], total: 200, approved: true }), // same landlord → same row
  rec({ siteId: "s3", code: "A3", landlords: ["MALA"], total: 50, approved: true, city: "Madurai" }),
  rec({ siteId: "s4", code: "A4", landlords: [], total: 70, approved: true }), // no landlord → a row of its own
  rec({ siteId: "s5", code: "A5", landlords: ["KUMAR"], total: 30, pastDue: true, bucket: "2026-09" }),
];

test("P1. one row per landlord; cards and totals count every bill; records = the page's bills", () => {
  const p = buildBillRowsPage(RECS, { category: "approved" });
  assert.equal(p.allRows, 3); // RAVI (2 bills), MALA, no-landlord site
  assert.equal(p.totalRows, 3);
  assert.equal(p.limit, 25); // default page size
  assert.deepEqual(p.totals, { bills: 4, sites: 4, rental: 420, gst: 0, holdGst: 0, total: 420 });
  assert.deepEqual(p.cards.map((c) => [c.key, c.bills, c.amount]), [["generated", 5, 450], ["approved", 4, 420], ["pending", 1, 30], ["pastDue", 1, 30]]);
  assert.equal(p.records.length, 4);
});

test("P2. pages cut whole rows (a landlord's bills never split), page clamps to the last", () => {
  const p1 = buildBillRowsPage(RECS, { category: "approved", limit: 1, page: 1 });
  assert.equal(p1.totalPages, 3);
  assert.deepEqual(p1.records.map((r) => r.siteId), ["s1", "s2"]); // RAVI's both bills on one page
  const last = buildBillRowsPage(RECS, { category: "approved", limit: 1, page: 99 });
  assert.equal(last.page, 3);
  assert.equal(last.from, 3);
});

test("P3. search (text, amount with commas / ₹) and sort (numbers, nulls last) run over all rows", () => {
  assert.deepEqual(buildBillRowsPage(RECS, { category: "approved", search: "madurai" }).records.map((r) => r.siteId), ["s3"]);
  const byAmount = buildBillRowsPage(RECS, { category: "approved", search: "₹300" }); // RAVI's row total
  assert.equal(byAmount.totalRows, 1);
  assert.equal(byAmount.matching.total, 300);
  const desc = buildBillRowsPage(RECS, { category: "approved", sortBy: "total", sortDir: "desc" });
  assert.deepEqual([...new Set(desc.records.map((r) => r.siteId))], ["s1", "s2", "s4", "s3"]); // 300, 70, 50
  const byName = buildBillRowsPage(RECS, { category: "approved", sortBy: "landlordName" });
  assert.equal(byName.records.at(-1).siteId, "s4"); // no landlord: last
});

test("P4. bucket scopes cards and rows; bad options fall back to defaults", () => {
  const p = buildBillRowsPage(RECS, { category: "pastDue", bucket: "2026-09" });
  assert.equal(p.cards.find((c) => c.key === "generated").bills, 1);
  assert.equal(p.totals.total, 30);
  const o = parseRowsQuery({ category: "x", limit: 5000, page: -2, sortBy: "nope", sortDir: "DESC" });
  assert.deepEqual([o.category, o.limit, o.page, o.sortBy, o.sortDir], ["generated", 100, 1, null, "desc"]);
});

const base = (siteId, landlord, extra = {}) => ({ siteId, siteName: `Site ${siteId}`, city: "Chennai", paymentCycle: "Monthly", mediaCodes: [`C-${siteId}`], faces: [], landlords: landlord ? [{ name: landlord }] : [], ...extra });

test("D1. payments: one row per site (months summed), Paid = Total - Unpaid per component, cards from every row", () => {
  const recs = [
    base("s1", "RAVI", { month: "2026-09", rentalDue: 100, directGstDue: 18, holdGstDue: 0, rentalUnpaid: 0, directGstUnpaid: 0, holdGstUnpaid: 0 }),
    base("s1", "RAVI", { month: "2026-10", rentalDue: 100, directGstDue: 18, holdGstDue: 0, rentalUnpaid: 100, directGstUnpaid: 18, holdGstUnpaid: 0, approvalStatus: "Pending" }),
    base("s2", "RAVI", { month: "2026-10", rentalDue: 50, directGstDue: 0, holdGstDue: 9, rentalUnpaid: 0, directGstUnpaid: 0, holdGstUnpaid: 9, approvalStatus: "Approved" }),
    base("s3", "MALA", { month: "2026-10", rentalDue: 70, directGstDue: 0, holdGstDue: 0, rentalUnpaid: 0, directGstUnpaid: 0, holdGstUnpaid: 0 }),
  ];
  const p = buildPaymentRowsPage(recs, { category: "paid" });
  assert.deepEqual(p.cards.map((c) => [c.key, c.sites, c.amount]), [["total", 3, 365], ["paid", 3, 238], ["unpaid", 2, 127]]);
  assert.deepEqual(p.totals, { sites: 3, rental: 220, gst: 18, holdGst: 0, total: 238 });
  assert.equal(p.allRows, 2); // RAVI (s1 + s2), MALA
  assert.equal(p.records.length, 4); // every month record of the page's sites
  const oct = buildPaymentRowsPage(recs, { category: "unpaid", bucket: "2026-10", sortBy: "total", sortDir: "desc", limit: 1 });
  assert.equal(oct.totalPages, 2); // only RAVI is unpaid in October, but his two sites differ in Approval Status (Pending / Approved): two rows, as the popup shows
  assert.equal(oct.matching.total, 127);
  assert.equal(buildPaymentRowsPage(recs, { category: "total", search: "mala" }).totalRows, 1);
});

test("D2. GST: one row per bill cycle; paid / unpaid (pending or ledger) / hold by remainingAs; Unpaid summary; sites distinct", () => {
  const recs = [
    base("s1", "RAVI", { bucket: "2026-10", paid: 18, remaining: 0 }),
    base("s1", "RAVI", { bucket: "2026-09", paid: 0, remaining: 18, remainingAs: "pending", approvalStatus: "Pending" }),
    base("s2", "MALA", { bucket: "2026-10", paid: 0, remaining: 9, remainingAs: "hold" }),
    base("s3", null, { bucket: "2026-10", paid: 0, remaining: 5, kind: "direct" }), // older row: no remainingAs → ledger
  ];
  const p = buildGstRowsPage(recs, { category: "unpaid" });
  assert.deepEqual(p.cards.map((c) => [c.key, c.sites, c.amount]), [["generated", 3, 50], ["paid", 1, 18], ["unpaid", 2, 23], ["hold", 1, 9]]);
  assert.deepEqual(p.totals, { bills: 2, total: 23 });
  assert.deepEqual(p.summary.map((s) => [s.label, s.amount, s.sites]), [["Pending Approval", 18, 1], ["Ledger Entry", 5, 1]]);
  assert.equal(p.allRows, 2); // RAVI, the no-landlord site
  const hold = buildGstRowsPage(recs, { category: "hold", bucket: "2026-09" });
  assert.equal(hold.totalRows, 0);
  assert.equal(buildGstRowsPage(recs, { category: "generated", search: "₹18" }).totalRows, 1);
});

test("A1. appraisal: one row per entry by kind; cards = distinct sites + amount; Total = every kind; amount sorts", () => {
  const { buildAppraisalRowsPage } = require("../utils/reportRowsPage");
  const e = (siteId, landlord, kind, amount, extra = {}) => base(siteId, landlord, { bucket: "2026-10", date: "2026-10-05", kind, amount, previousRent: 1000, newRent: 1000 + amount, ...extra });
  const recs = [e("s1", "RAVI", "given", 100), e("s1", "RAVI", "held", 50), e("s2", "MALA", "given", 300), e("s3", "KUMAR", "upcoming", 20, { bucket: "2026-11" })];
  const p = buildAppraisalRowsPage(recs, { category: "given" });
  assert.deepEqual(p.cards.map((c) => [c.key, c.sites, c.amount]), [["total", 3, 470], ["given", 2, 400], ["unpaid", 0, 0], ["held", 1, 50], ["upcoming", 1, 20]]);
  assert.deepEqual(p.totals, { entries: 2, total: 400 });
  assert.equal(p.limit, 25);
  const desc = buildAppraisalRowsPage(recs, { category: "total", sortBy: "amount", sortDir: "desc" });
  assert.deepEqual([...new Set(desc.records.map((r) => r.siteId))], ["s2", "s1", "s3"]); // MALA 300, RAVI 150, KUMAR 20
  assert.equal(buildAppraisalRowsPage(recs, { category: "total", bucket: "2026-11" }).totals.total, 20);
  assert.equal(buildAppraisalRowsPage(recs, { category: "total", search: "hold (pending" }).totalRows, 1); // status text
});

test("T1. agreements / campaign / TDS: the popup's cards, rows merged only when the popup merges them, month bars", () => {
  const { buildAgreementRowsPage, buildCampaignRowsPage, buildTdsRowsPage } = require("../utils/reportRowsPage");
  const ag = (siteId, landlord, state, start, end, extra = {}) => base(siteId, landlord, { state, startDate: start, endDate: end, ...extra });
  const agreements = [
    ag("s1", "RAVI", "live", "2026-01-01", "2027-01-01"),
    ag("s2", "RAVI", "live", "2026-01-01", "2027-01-01"), // same dates + status → one row with s1
    ag("s3", "RAVI", "live", "2026-02-01", "2027-02-01", { expiringSoon: true }), // other dates → its own row
    ag("s4", "MALA", "expired", "2025-01-01", "2026-01-15", { document: "Draft" }),
  ];
  const live = buildAgreementRowsPage(agreements, { category: "live" });
  assert.deepEqual(live.cards.map((c) => [c.key, c.agreements, c.sites]), [["total", 4, 4], ["live", 3, 3], ["expiringSoon", 1, 1], ["expired", 1, 1], ["draft", 1, 1]]);
  assert.equal(live.totalRows, 2);
  const jan = buildAgreementRowsPage(agreements, { category: "expiring", bucket: "2026-01" });
  assert.deepEqual(jan.cards.map((c) => c.key), ["total", "live", "expiring", "expired"]);
  assert.equal(jan.totals.agreements, 1); // MALA ends 15 Jan 2026

  const camp = [base("s1", "RAVI", { status: "live", bucket: "2026-10", rent: 100, gst: 18, total: 118 }), base("s1", "RAVI", { status: "live", bucket: "2026-11", rent: 100, gst: 18, total: 118 }), base("s2", "MALA", { status: "notLive", bucket: "2026-10", rent: 50, gst: 0, total: 50 })];
  const c = buildCampaignRowsPage(camp, { category: "live" });
  assert.deepEqual(c.totals, { sites: 1, siteMonths: 2, rental: 200, gst: 36, total: 236 });
  assert.deepEqual(c.cards.map((x) => [x.key, x.sites, x.amount]), [["live", 1, 236], ["notLive", 1, 50]]);
  assert.equal(buildCampaignRowsPage(camp, { category: "live", bucket: "2026-11" }).totals.total, 118);

  const line = (siteId, owner, amount, extra = {}) => ({ siteId, siteName: `Site ${siteId}`, ownerName: owner, mediaCodes: [siteId], amount, date: "2026-10-07", billMonth: "October 2026", ...extra });
  const data = {
    sourceDetails: {
      rentalMasterBuckets: [{ key: "2026-10", deductions: [line("s1", "RAVI", 100, { billStatus: "Approved" }), line("s2", "MALA", 50, { billStatus: "Pending" })] }],
      ledgerBuckets: [{ key: "2026-10", deductions: [line("s1", "RAVI", 60, { utrNumber: "U1" }), line("s1", "RAVI", 40, { utrNumber: "U2" })] }],
    },
  };
  const tdsRecords = [line("s3", "KUMAR", 25, { status: "upcoming", bucket: "2026-12" }), line("s1", "RAVI", 10, { status: "due", bucket: "2026-10" })];
  const paid = buildTdsRowsPage(tdsRecords, { category: "paid" }, data);
  assert.deepEqual(paid.cards.map((x) => [x.key, x.sites, x.amount]), [["total", 2, 150], ["paid", 1, 100], ["upcoming", 1, 25]]);
  assert.equal(paid.totalRows, 2); // RAVI's two UTRs stay two rows (the UTR column is not combined)
  assert.deepEqual(paid.totals, { lines: 2, sites: 1, total: 100 });
  assert.equal(buildTdsRowsPage(tdsRecords, { category: "upcoming", bucket: "2026-10" }, data).totals.lines, 0);
});
