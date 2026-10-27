// Appraisal status in Report Analytics. An appraisal row is classified from STORED facts only:
//   Hold (Pending Approval) — CMD hold on its month's bill / the site, OR the bill has not completed approval (or no bill exists)
//   Paid                    — approved AND the Ledger's cycle calculation shows the month's rent fully paid (payment evidence)
//   Unpaid                  — approved but no Ledger evidence of payment: an approved bill is NOT money received
//   Upcoming                — stored future rows
// Synthetic fixtures only (no database); the Ledger helpers are stubbed where the real payment-evidence path is exercised.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const RA = require("../utils/reportAnalytics");

const NOW = new Date(Date.UTC(2026, 9, 21)); // 21 Oct 2026
const f = (extra = {}) => {
  const p = RA.parseFilters({ startDate: "2026-04-01", endDate: "2027-12-31", ...extra }, NOW);
  assert.equal(p.error, undefined);
  return p.filters;
};
const D = (y, m, d = 1) => new Date(Date.UTC(y, m, d));
const row = (date, amount, extra = {}) => ({ appraisalDate: date, appraisalAmount: amount, previousRent: 50000, newRent: 50000 + amount, type: 2, ...extra });
const bill = (y, m, approvalStatus, extra = {}) => ({ dueDate: D(y, m, 5), approvalStatus, ...extra });
const site = (id, history, extra = {}) => ({
  _id: id,
  mediaDetails: [{ _id: `${id}-face`, mediaType: "Hoarding", city: "Chennai", mediaName: `Site ${id}`, mediaCode: `M-${id}`, status: 1 }],
  appraisal: { applicable: 1, appraisalHold: 0, history },
  ...extra,
});
/** Ledger payment evidence per "siteId|YYYY-MM": `unpaid` of `due` rent still open. */
const cycles = (entries) => new Map(Object.entries(entries).map(([k, [due, unpaid]]) => [k, { due, unpaid }]));
const sum = (r) => ({ paid: r.summary.given.amount, unpaid: r.summary.unpaid.amount, held: r.summary.held.amount, upcoming: r.summary.upcoming.amount, total: r.summary.total.amount });
const compute = (docs, opts = {}, extra = {}) => RA.computeAppraisal(docs, f(extra.filters), NOW, opts);

// ── the reported bug ─────────────────────────────────────────────────────────
test("reported bug: a ₹10,000 appraisal whose bill is still pending approval (Executive / Manager / CMD pending) is NOT Paid", () => {
  const steps = [{ role: 1, status: 1 }, { role: 2, status: 1 }, { role: 3, status: 1 }];
  const docs = [site("1", [row(D(2026, 8), 10000)], { rentalDue: [bill(2026, 8, 1, { approvalSteps: steps })] })];
  // even with a Ledger cycle on record, an unapproved bill is never Paid
  for (const payments of [null, cycles({ "1|2026-09": [10000, 0] })]) {
    const r = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments, lib: { pendingRoleOf: (b) => 1 } });
    assert.deepEqual(sum(r), { paid: 0, unpaid: 0, held: 10000, upcoming: 0, total: 10000 });
    assert.equal(r.records[0].status, "pendingApproval");
    assert.equal(r.records[0].approvalStage, "sales", "the stage it waits at comes from the bill's approval steps");
  }
});

test("approval stage of a pending bill (Rental Executive / Manager / CMD), as the dashboard resolves it", () => {
  const { pendingRoleOf } = require("../controllers/Admin/DashboardController/DashboardExtras");
  const mk = (steps) => site("1", [row(D(2026, 8), 500)], { rentalDue: [bill(2026, 8, 2, { approvalSteps: steps })] });
  const stage = (steps) => RA.computeAppraisal([mk(steps)], f({ details: "true" }), NOW, { lib: { pendingRoleOf } }).records[0].approvalStage;
  assert.equal(stage([{ role: 1, status: 2 }, { role: 2, status: 1 }, { role: 3, status: 1 }]), "manager");
  assert.equal(stage([{ role: 1, status: 2 }, { role: 2, status: 2 }, { role: 3, status: 1 }]), "cmd");
  assert.equal(stage([{ role: 1, status: 1 }, { role: 2, status: 1 }, { role: 3, status: 1 }]), "sales");
});

// ── pending approval, hold, release ──────────────────────────────────────────
test("not approved: Pending (1), Partially approved (2) and Overdue (4) bills are all pending approval — never paid, never unpaid", () => {
  for (const st of [1, 2, 4]) {
    const r = RA.computeAppraisal([site("1", [row(D(2026, 8), 700)], { rentalDue: [bill(2026, 8, st)] })], f({ details: "true" }), NOW, { payments: cycles({ "1|2026-09": [700, 0] }) });
    assert.deepEqual(sum(r), { paid: 0, unpaid: 0, held: 700, upcoming: 0, total: 700 }, `approvalStatus ${st}`);
    assert.equal(r.records[0].kind, "held");
  }
});

test("a pending approval is not automatically an appraisal hold: it is a distinct status inside the same card", () => {
  const r = RA.computeAppraisal([
    site("1", [row(D(2026, 8), 100)], { rentalDue: [bill(2026, 8, 1)] }),
    site("2", [row(D(2026, 8), 200)], { rentalDue: [bill(2026, 8, 3, { appraisalHold: { hold: 1 } })] }),
  ], f({ details: "true" }), NOW, { payments: null });
  assert.deepEqual(r.records.map((x) => [x.siteId, x.status]).sort(), [["1", "pendingApproval"], ["2", "onHold"]]);
});

test("active hold (appraisalHold.hold = 1) is Hold even when the bill is otherwise approved and paid", () => {
  const docs = [site("1", [row(D(2026, 8), 900)], { rentalDue: [bill(2026, 8, 3, { appraisalHold: { hold: 1 } })] })];
  const r = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments: cycles({ "1|2026-09": [900, 0] }) });
  assert.deepEqual(sum(r), { paid: 0, unpaid: 0, held: 900, upcoming: 0, total: 900 });
  assert.equal(r.records[0].status, "onHold");
});

test("released hold (hold = 0, releasedAt set) is not a hold: approval and payment decide", () => {
  const released = { hold: 0, heldAt: D(2026, 8, 6), releasedAt: D(2026, 8, 9) };
  const paidIdx = cycles({ "1|2026-09": [900, 0] });
  assert.deepEqual(sum(RA.computeAppraisal([site("1", [row(D(2026, 8), 900)], { rentalDue: [bill(2026, 8, 3, { appraisalHold: released })] })], f(), NOW, { payments: paidIdx })), { paid: 900, unpaid: 0, held: 0, upcoming: 0, total: 900 });
  assert.deepEqual(sum(RA.computeAppraisal([site("1", [row(D(2026, 8), 900)], { rentalDue: [bill(2026, 8, 1, { appraisalHold: released })] })], f(), NOW, { payments: paidIdx })), { paid: 0, unpaid: 0, held: 900, upcoming: 0, total: 900 });
});

test("site-level hold: rows on / after the hold date are Hold; earlier approved + paid rows stay Paid", () => {
  const hist = [row(D(2026, 5), 500), row(D(2026, 8), 600), row(D(2027, 1), 700)];
  const docs = [site("1", hist, { rentalDue: [bill(2026, 5, 3), bill(2026, 8, 3)], appraisal: { applicable: 0, appraisalHold: 1, appraisalHoldDate: D(2026, 8, 1), history: hist } })];
  assert.deepEqual(sum(RA.computeAppraisal(docs, f(), NOW, { payments: cycles({ "1|2026-06": [500, 0], "1|2026-09": [600, 0] }) })), { paid: 500, unpaid: 0, held: 1300, upcoming: 0, total: 1800 });
});

// ── paid vs unpaid: payment evidence ─────────────────────────────────────────
test("an approved bill is NOT automatically paid: without Ledger payment evidence it is Unpaid", () => {
  const docs = [site("1", [row(D(2026, 8), 1000)], { rentalDue: [bill(2026, 8, 3)] })];
  const none = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments: cycles({}) });
  assert.deepEqual(sum(none), { paid: 0, unpaid: 1000, held: 0, upcoming: 0, total: 1000 });
  assert.equal(none.records[0].status, "approvedNoPaymentEvidence");
  const open = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments: cycles({ "1|2026-09": [1000, 400] }) });
  assert.deepEqual(sum(open), { paid: 0, unpaid: 1000, held: 0, upcoming: 0, total: 1000 }, "the cycle still has rent unpaid");
  assert.equal(open.records[0].status, "approvedUnpaid");
  assert.deepEqual([open.records[0].rentDue, open.records[0].rentUnpaid], [1000, 400]);
  const noData = RA.computeAppraisal(docs, f({ details: "true" }), NOW);
  assert.equal(noData.records[0].status, "approvedNoPaymentData", "no payment data supplied at all: nothing can be Paid");
  assert.equal(noData.summary.given.amount, 0);
  assert.equal(noData.meta.paymentEvidence, "none");
});

test("paid: approved AND the Ledger shows the month's rent fully paid", () => {
  const docs = [site("1", [row(D(2026, 8), 1000)], { rentalDue: [bill(2026, 8, 3)] })];
  const r = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments: cycles({ "1|2026-09": [1000, 0] }) });
  assert.deepEqual(sum(r), { paid: 1000, unpaid: 0, held: 0, upcoming: 0, total: 1000 });
  assert.equal(r.records[0].status, "paid");
  assert.equal(r.meta.paymentEvidence, "ledger");
  // a cycle with nothing due is no evidence of a payment
  assert.equal(RA.computeAppraisal(docs, f(), NOW, { payments: cycles({ "1|2026-09": [0, 0] }) }).summary.given.amount, 0);
});

test("payment evidence is read from the Ledger's own cycle calculation (cyclePaymentIndex), end to end", () => {
  // stub of the two Ledger helpers computePeriodDue calls: September rent 1,000 fully paid, October rent 1,000 with 1,000 pending
  const lib = {
    getAllDueCycles: () => [D(2026, 8, 5), D(2026, 9, 5)],
    getOverallSummaryForCycle: (_doc, { month }) => ({ currentMonthRentalAmount: 1000, currentMonthGstAmount: 0, currentMonthRentPending: month === 9 ? 0 : 1000, currentMonthGstPending: 0 }),
    resolveExpectedGstForCycle: () => ({ expected: 0 }),
    mediaAsOfDate: (d) => d,
  };
  const docs = [site("1", [row(D(2026, 8), 300), row(D(2026, 9), 400)], { rentalDue: [bill(2026, 8, 3), bill(2026, 9, 3)], rentalPayment: { paymentFrequency: 1 } })];
  const idx = RA.cyclePaymentIndex(docs, f(), lib, NOW);
  assert.deepEqual([idx.get("1|2026-09"), idx.get("1|2026-10")], [{ due: 1000, unpaid: 0 }, { due: 1000, unpaid: 1000 }]);
  const r = RA.computeAppraisal(docs, f(), NOW, { payments: idx });
  assert.deepEqual(sum(r), { paid: 300, unpaid: 400, held: 0, upcoming: 0, total: 700 });
});

test("the Rental Master amount never makes an appraisal Paid", () => {
  const docs = [site("1", [row(D(2026, 8), 2000)], { rentalDue: [bill(2026, 8, 1)], rentalPayment: { totalRentalAmount: 99999 } })];
  assert.equal(RA.computeAppraisal(docs, f(), NOW, { payments: cycles({ "1|2026-09": [99999, 0] }) }).summary.given.amount, 0);
});

// ── bills: several per month, stale, none ────────────────────────────────────
test("several bills in the month (one per face): all approved + paid → Paid; any unapproved → pending; any held → Hold", () => {
  const paid = cycles({ "1|2026-09": [1000, 0] });
  const month = (bills) => sum(RA.computeAppraisal([site("1", [row(D(2026, 8), 1000)], { rentalDue: bills })], f(), NOW, { payments: paid }));
  assert.equal(month([bill(2026, 8, 3), bill(2026, 8, 3)]).paid, 1000);
  assert.deepEqual([month([bill(2026, 8, 3), bill(2026, 8, 1)]).paid, month([bill(2026, 8, 3), bill(2026, 8, 1)]).held], [0, 1000]);
  assert.equal(month([bill(2026, 8, 3), bill(2026, 8, 3, { appraisalHold: { hold: 1 } })]).held, 1000);
});

test("stale bills (a face that no longer exists) are ignored, as in Outstanding payments", () => {
  const paid = cycles({ "1|2026-09": [1000, 0] });
  const live = bill(2026, 8, 3, { mediaDetailId: "1-face" });
  const stalePending = bill(2026, 8, 1, { mediaDetailId: "deleted-face" });
  const r = RA.computeAppraisal([site("1", [row(D(2026, 8), 1000)], { rentalDue: [live, stalePending] })], f(), NOW, { payments: paid });
  assert.deepEqual(sum(r), { paid: 1000, unpaid: 0, held: 0, upcoming: 0, total: 1000 });
  const onlyStale = RA.computeAppraisal([site("1", [row(D(2026, 8), 1000)], { rentalDue: [stalePending] })], f({ details: "true" }), NOW, { payments: paid });
  assert.equal(onlyStale.records[0].status, "noBill");
});

test("no bill for an applied month: awaiting approval (not Paid), counted in meta.appraisalsWithoutBill", () => {
  const r = RA.computeAppraisal([site("1", [row(D(2026, 8), 800)], { rentalDue: [] })], f({ details: "true" }), NOW, { payments: cycles({ "1|2026-09": [800, 0] }) });
  assert.deepEqual(sum(r), { paid: 0, unpaid: 0, held: 800, upcoming: 0, total: 800 });
  assert.equal(r.records[0].status, "noBill");
  assert.equal(r.meta.appraisalsWithoutBill, 1);
});

// ── upcoming, history, duplicates ────────────────────────────────────────────
test("upcoming: stored rows dated after today; historical rows keep their stored amount and status", () => {
  const docs = [site("1", [row(D(2026, 5), 100), row(D(2026, 8), 150), row(D(2027, 2), 300), row(D(2027, 8), 400)], { rentalDue: [bill(2026, 5, 3), bill(2026, 8, 1)] })];
  const r = RA.computeAppraisal(docs, f(), NOW, { payments: cycles({ "1|2026-06": [100, 0] }) });
  assert.deepEqual(sum(r), { paid: 100, unpaid: 0, held: 150, upcoming: 700, total: 950 });
  assert.equal(r.summary.upcoming.entries, 2);
});

test("duplicates: the same appraisal stored twice (site + day + amount) is counted once; a site is never counted twice in Total", () => {
  const dup = row(D(2026, 8), 1000);
  const docs = [
    site("1", [dup, { ...dup }, row(D(2027, 2), 300)], { rentalDue: [bill(2026, 8, 3)] }),
    site("2", [row(D(2026, 8), 400)], { rentalDue: [bill(2026, 8, 1)] }),
  ];
  const r = RA.computeAppraisal(docs, f(), NOW, { payments: cycles({ "1|2026-09": [1000, 0] }) });
  assert.deepEqual(sum(r), { paid: 1000, unpaid: 0, held: 400, upcoming: 300, total: 1700 });
  assert.equal(r.meta.duplicateEntries, 1);
  assert.equal(r.summary.total.sites, 2, "site 1 is in two categories but is ONE site");
});

// ── reconciliation ───────────────────────────────────────────────────────────
test("Total = Paid + Unpaid + Hold + Upcoming in every month and overall; the details reconcile with every card, bucket and site count", () => {
  const docs = [
    site("1", [row(D(2026, 5), 100), row(D(2026, 8), 200), row(D(2026, 11), 300), row(D(2026, 6), 50)], { rentalDue: [bill(2026, 5, 3), bill(2026, 8, 1), bill(2026, 6, 3)] }),
    site("2", [row(D(2026, 8), 400)], { rentalDue: [bill(2026, 8, 3, { appraisalHold: { hold: 1 } })] }),
    site("3", [row(D(2026, 5), 70)], { rentalDue: [bill(2026, 5, 3)] }),
  ];
  const r = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments: cycles({ "1|2026-06": [100, 0], "3|2026-06": [70, 70] }) });
  assert.deepEqual(sum(r), { paid: 100, unpaid: 120, held: 600, upcoming: 300, total: 1120 });
  assert.equal(r.summary.total.amount, r.summary.given.amount + r.summary.unpaid.amount + r.summary.held.amount + r.summary.upcoming.amount);
  assert.equal(r.summary.total.entries, ["given", "unpaid", "held", "upcoming"].reduce((a, k) => a + r.summary[k].entries, 0));
  for (const b of r.buckets) assert.equal(b.total.amount, ["given", "unpaid", "held", "upcoming"].reduce((a, k) => a + b[k].amount, 0), b.key);
  for (const k of ["given", "unpaid", "held", "upcoming"]) {
    const rows = r.records.filter((x) => x.kind === k);
    assert.equal(rows.reduce((a, x) => a + x.amount, 0), r.summary[k].amount, k);
    assert.equal(rows.length, r.summary[k].entries, k);
    assert.equal(new Set(rows.map((x) => x.siteId)).size, r.summary[k].sites, k);
    for (const b of r.buckets) assert.equal(rows.filter((x) => x.bucket === b.key).reduce((a, x) => a + x.amount, 0), b[k].amount, `${k} ${b.key}`);
  }
  assert.equal(r.records.find((x) => x.siteId === "1" && x.status === "pendingApproval").billStatus, "Pending");
});

test("filters keep applying (period, site, media type, city) over the same classification", () => {
  const docs = [site("1", [row(D(2026, 5), 100), row(D(2026, 8), 200)], { rentalDue: [bill(2026, 5, 3), bill(2026, 8, 1)] })];
  const paid = cycles({ "1|2026-06": [100, 0] });
  const jun = RA.computeAppraisal(docs, f({ startDate: "2026-06-01", endDate: "2026-06-30" }), NOW, { payments: paid });
  assert.deepEqual(sum(jun), { paid: 100, unpaid: 0, held: 0, upcoming: 0, total: 100 });
  const sep = RA.computeAppraisal(docs, f({ startDate: "2026-09-01", endDate: "2026-09-30" }), NOW, { payments: paid });
  assert.deepEqual(sum(sep), { paid: 0, unpaid: 0, held: 200, upcoming: 0, total: 200 });
  assert.deepEqual(sum(RA.computeAppraisal(docs, f({ city: "Madurai" }), NOW, { payments: paid })), { paid: 0, unpaid: 0, held: 0, upcoming: 0, total: 0 });
});

test("empty and malformed input: zeros, never a wrong figure", () => {
  const zero = { paid: 0, unpaid: 0, held: 0, upcoming: 0, total: 0 };
  assert.deepEqual(sum(RA.computeAppraisal([], f(), NOW, { payments: cycles({}) })), zero);
  assert.deepEqual(sum(RA.computeAppraisal([site("1", [])], f(), NOW)), zero);
  const odd = [
    site("1", [row(D(2026, 8), 100)], { rentalDue: [{ approvalStatus: 3 }, null, { dueDate: "not a date", approvalStatus: 3 }, { dueDate: D(2026, 8, 5) }] }),
    { _id: "2", appraisal: { applicable: 1, history: [null, { appraisalAmount: 5 }, { appraisalDate: D(2026, 8), appraisalAmount: "x" }] }, mediaDetails: [] },
    { _id: "3" },
  ];
  assert.deepEqual(sum(RA.computeAppraisal(odd, f(), NOW, { payments: cycles({}) })), { paid: 0, unpaid: 0, held: 100, upcoming: 0, total: 100 }, "a bill without a status is not approved; broken rows are skipped");
});

test("classification and bill index (pure)", () => {
  const idx = RA.appraisalBillIndex({ mediaDetails: [{ _id: "x" }], rentalDue: [bill(2026, 8, 3), bill(2026, 8, 1), bill(2026, 9, 3, { appraisalHold: { hold: 1 } })] });
  assert.deepEqual([idx.get("2026-09").total, idx.get("2026-09").approved, idx.get("2026-09").held, [...idx.get("2026-09").statuses]], [2, 1, 0, ["Approved", "Pending"]]);
  const c = (o) => RA.classifyAppraisalRow({ d: D(2026, 8), today: NOW, siteHeld: false, holdDate: null, bill: null, payment: undefined, ...o });
  const ok = { total: 1, approved: 1, held: 0 };
  assert.equal(c({ bill: ok, payment: { due: 5, unpaid: 0 } }).status, "paid");
  assert.equal(c({ bill: ok, payment: { due: 5, unpaid: 2 } }).status, "approvedUnpaid");
  assert.equal(c({ bill: ok, payment: null }).status, "approvedNoPaymentEvidence");
  assert.equal(c({ bill: ok }).status, "approvedNoPaymentData");
  assert.equal(c({ bill: { total: 1, approved: 0, held: 0 }, payment: { due: 5, unpaid: 0 } }).status, "pendingApproval");
  assert.equal(c({ bill: { total: 1, approved: 1, held: 1 } }).status, "onHold");
  assert.equal(c({}).status, "noBill");
  assert.equal(c({ d: D(2027, 1) }).status, "upcoming");
  assert.equal(c({ siteHeld: true, holdDate: D(2026, 7), bill: ok }).status, "onHold");
});

test("the appraisal endpoint loads the bill fields (approval status / steps, hold, face ids) and uses the Ledger payment calculation", () => {
  const C = require("../controllers/Admin/ReportAnalyticsController/ReportAnalyticsController");
  const tokens = C.SELECT.appraisal.rentalMaster.split(/\s+/);
  for (const t of ["appraisal", "rentalDue.dueDate", "rentalDue.approvalStatus", "rentalDue.approvalSteps.status", "rentalDue.appraisalHold.hold", "rentalDue.mediaDetailId", "mediaDetails._id", "ledgerHistory"]) {
    assert.ok(tokens.includes(t), t);
  }
  assert.ok(!tokens.some((t) => t.startsWith("appraisal.")), "no appraisal.* child next to `appraisal` (a MongoDB path collision)");
  const src = fs.readFileSync(path.join(__dirname, "../controllers/Admin/ReportAnalyticsController/ReportAnalyticsController.js"), "utf8");
  assert.ok(src.includes("RA.cyclePaymentIndex(d, f, LEDGER_LIB)"));
});

// ── CMD approval is the gate for Paid ────────────────────────────────────────
const steps = (a, b, c) => [{ role: 1, status: a }, { role: 2, status: b }, { role: 3, status: c }]; // 1 pending, 2 approved, 3 skipped
const paidIdx = cycles({ "1|2026-09": [2500, 0] });
const run = (b, extra = {}) => RA.computeAppraisal([site("1", [row(D(2026, 8), 2500)], { rentalDue: [b], ...extra })], f({ details: "true" }), NOW, { payments: paidIdx });

test("CMD pending is never Paid: Executive approved + Manager approved + CMD pending", () => {
  const r = run(bill(2026, 8, 2, { approvalSteps: steps(2, 2, 1) }));
  assert.deepEqual(sum(r), { paid: 0, unpaid: 0, held: 2500, upcoming: 0, total: 2500 });
  assert.equal(r.records[0].status, "pendingApproval");
});

test("Executive alone / Manager alone is not enough", () => {
  for (const s of [steps(2, 1, 1), steps(3, 2, 1)]) assert.equal(run(bill(2026, 8, 2, { approvalSteps: s })).summary.given.amount, 0);
});

test("a bill marked fully approved whose CMD step is still pending is not CMD-approved", () => {
  const r = run(bill(2026, 8, 3, { approvalSteps: steps(2, 2, 1) }));
  assert.equal(r.summary.given.amount, 0);
  assert.equal(r.records[0].status, "pendingApproval");
  assert.ok(!RA.isCmdApproved(bill(2026, 8, 3, { approvalSteps: steps(2, 2, 1) })));
});

test("CMD approved (also when CMD approved directly and lower steps were skipped) + no hold → eligible for Paid (with Ledger payment evidence)", () => {
  for (const s of [steps(2, 2, 2), steps(3, 3, 2)]) {
    const r = run(bill(2026, 8, 3, { approvalSteps: s }));
    assert.deepEqual(sum(r), { paid: 2500, unpaid: 0, held: 0, upcoming: 0, total: 2500 });
  }
  // CMD approved but no payment evidence: Unpaid, not Paid
  const noPay = RA.computeAppraisal([site("1", [row(D(2026, 8), 2500)], { rentalDue: [bill(2026, 8, 3, { approvalSteps: steps(3, 3, 2) })] })], f(), NOW, { payments: cycles({}) });
  assert.deepEqual(sum(noPay), { paid: 0, unpaid: 2500, held: 0, upcoming: 0, total: 2500 });
});

test("CMD approved + active hold → not Paid (Hold)", () => {
  const r = run(bill(2026, 8, 3, { approvalSteps: steps(2, 2, 2), appraisalHold: { hold: 1, heldAt: D(2026, 8, 6) } }));
  assert.deepEqual(sum(r), { paid: 0, unpaid: 0, held: 2500, upcoming: 0, total: 2500 });
  assert.equal(r.records[0].status, "onHold");
});

test("released hold + CMD approved → Paid; released hold + CMD pending → pending approval", () => {
  const rel = { hold: 0, heldAt: D(2026, 8, 6), releasedAt: D(2026, 8, 9) };
  assert.equal(run(bill(2026, 8, 3, { approvalSteps: steps(2, 2, 2), appraisalHold: rel })).summary.given.amount, 2500);
  const pend = run(bill(2026, 8, 2, { approvalSteps: steps(2, 2, 1), appraisalHold: rel }));
  assert.deepEqual([pend.summary.given.amount, pend.summary.held.amount], [0, 2500]);
});

test("an earlier month's active hold carries to a later bill that is not CMD-approved (Rental Master rule); an approved later bill is unaffected", () => {
  const held = bill(2026, 7, 2, { appraisalHold: { hold: 1, heldAt: D(2026, 7, 6) } });
  const hist = [row(D(2026, 8), 2500)];
  const pending = RA.computeAppraisal([site("1", hist, { rentalDue: [held, bill(2026, 8, 2, { approvalSteps: steps(2, 2, 1) })] })], f(), NOW, { payments: paidIdx });
  assert.equal(pending.summary.held.amount, 2500);
  const approved = RA.computeAppraisal([site("1", hist, { rentalDue: [held, bill(2026, 8, 3, { approvalSteps: steps(2, 2, 2) })] })], f(), NOW, { payments: paidIdx });
  assert.equal(approved.summary.given.amount, 2500);
});

test("upcoming stays upcoming and the categories reconcile with CMD rules in play", () => {
  const docs = [site("1", [row(D(2026, 5), 100), row(D(2026, 8), 200), row(D(2027, 2), 300)], { rentalDue: [bill(2026, 5, 3, { approvalSteps: steps(2, 2, 2) }), bill(2026, 8, 2, { approvalSteps: steps(2, 2, 1) })] })];
  const r = RA.computeAppraisal(docs, f({ details: "true" }), NOW, { payments: cycles({ "1|2026-06": [100, 0] }) });
  assert.deepEqual(sum(r), { paid: 100, unpaid: 0, held: 200, upcoming: 300, total: 600 });
  assert.equal(r.records.length, 3, "each appraisal appears once");
  for (const b of r.buckets) assert.equal(b.total.amount, b.given.amount + b.unpaid.amount + b.held.amount + b.upcoming.amount);
  assert.equal(r.summary.total.sites, 1);
});
