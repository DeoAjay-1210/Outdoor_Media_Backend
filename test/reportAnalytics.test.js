// Synthetic fixtures only — no database connection is made by this file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const RA = require("../utils/reportAnalytics");
const C = require("../controllers/Admin/ReportAnalyticsController/ReportAnalyticsController");

const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};
const NOW = new Date(Date.UTC(2026, 9, 21)); // 21 Oct 2026 (FY 2026-27)
const fy = (body = {}) => {
  const p = RA.parseFilters({ fy: 2026, ...body }, NOW);
  assert.equal(p.error, undefined);
  return p.filters;
};
const site = (id, faces, extra = {}) => ({
  _id: id,
  mediaDetails: faces.map(([mediaType, city, mediaName]) => ({ mediaType, city, mediaName: mediaName || `S${id}` })),
  ...extra,
});
const entry = (o) => ({
  paymentMode: "Cash", withGst: 2, amount: 1000, date: new Date(Date.UTC(2026, 5, 10)),
  landOwnerId: "o1", month: "June 2026", updatedAt: new Date(Date.UTC(2026, 5, 10)), ...o,
});
const hist = (...entries) => [{ year: "2026", months: [{ month: "June", entries }] }];
const bucket = (res, key) => res.buckets.find((b) => b.key === key);

// ── Financial year / filters ──────────────────────────────────────────────
test("financial year runs 1 Apr to 31 Mar and defaults to the current FY", () => {
  const f = RA.parseFilters({}, NOW).filters;
  assert.equal(f.start.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(f.end.toISOString(), "2027-03-31T23:59:59.999Z");
  assert.equal(f.granularity, "month");
  assert.equal(RA.parseFilters({}, new Date(Date.UTC(2027, 2, 31))).filters.start.getUTCFullYear(), 2026);
  assert.equal(RA.parseFilters({}, new Date(Date.UTC(2027, 3, 1))).filters.start.getUTCFullYear(), 2027);
});

test("custom range: validation, inclusive end, day granularity for short ranges", () => {
  assert.ok(RA.parseFilters({ startDate: "2026-05-10", endDate: "2026-05-01" }).error);
  assert.ok(RA.parseFilters({ startDate: "2026-02-30", endDate: "2026-03-01" }).error);
  assert.ok(RA.parseFilters({ startDate: "2026-05-01" }).error);
  assert.ok(RA.parseFilters({ startDate: "2010-01-01", endDate: "2026-01-01" }).error);
  assert.ok(RA.parseFilters({ fy: "abc" }).error);
  const f = RA.parseFilters({ startDate: "2026-05-01", endDate: "2026-05-31" }).filters;
  assert.equal(f.granularity, "day");
  assert.equal(f.end.toISOString(), "2026-05-31T23:59:59.999Z");
  assert.equal(RA.parseFilters({ startDate: "2026-04-01", endDate: "2026-09-30" }).filters.granularity, "month");
});

test("'all' and blank filters mean no filter; values are trimmed, never case-merged", () => {
  const f = RA.parseFilters({ fy: 2026, mediaType: "all", city: "  " }, NOW).filters;
  assert.equal(f.mediaType, "");
  assert.equal(f.city, "");
  const opts = RA.computeFilterOptions([site("1", [["Hoarding ", "Chennai"]]), site("2", [["hoarding", "chennai"]])], NOW);
  assert.deepEqual([...opts.mediaTypes].sort(), ["Hoarding", "hoarding"].sort());
  assert.deepEqual([...opts.cities].sort(), ["Chennai", "chennai"].sort());
});

test("monthly buckets are continuous and zero-filled across the FY", () => {
  const r = RA.computeMedia([], fy());
  assert.equal(r.buckets.length, 12);
  assert.equal(r.buckets[0].key, "2026-04");
  assert.equal(r.buckets[11].key, "2027-03");
});

// ── Payments ──────────────────────────────────────────────────────────────
test("payments group by payment date, not bill month", () => {
  const docs = deepFreeze([site("1", [["Hoarding", "Chennai"]], {
    ledgerHistory: hist(entry({ date: new Date(Date.UTC(2026, 7, 5)), month: "June 2026", amount: 500 })),
  })]);
  const r = RA.computePayments(docs, fy());
  assert.equal(bucket(r, "2026-08").total, 500);
  assert.equal(bucket(r, "2026-06").total, 0);
});

test("payments read ledgerHistory only: live ledger / withGst1Ledger copies are not double counted", () => {
  const e = entry({ amount: 700 });
  const docs = deepFreeze([site("1", [["Hoarding", "Chennai"]], { ledgerHistory: hist(e), ledger: [e], withGst1Ledger: [e] })]);
  assert.equal(RA.computePayments(docs, fy()).summary.total, 700);
});

test("re-saved payment (duplicate history rows) counts once, latest wins", () => {
  const first = entry({ amount: 400, updatedAt: new Date(Date.UTC(2026, 5, 10)) });
  const second = entry({ amount: 450, updatedAt: new Date(Date.UTC(2026, 5, 12)) });
  const r = RA.computePayments(deepFreeze([site("1", [["Hoarding", "Chennai"]], { ledgerHistory: hist(first, second) })]), fy());
  assert.equal(r.summary.total, 450);
  assert.equal(r.meta.duplicatesIgnored, 1);
});

test("payments: cash/online/GST split; rows without date or amount are reported, not invented", () => {
  const docs = deepFreeze([site("1", [["Hoarding", "Chennai"]], {
    ledgerHistory: hist(
      entry({ paymentMode: "Cash", amount: 100, landOwnerId: "a" }),
      entry({ paymentMode: "Online", amount: 200, landOwnerId: "b" }),
      entry({ paymentMode: "Online", amount: 50, withGst: 1, landOwnerId: "c", rentalDueId: "r1" }),
      entry({ amount: 0, landOwnerId: "d" }),
      entry({ date: null, landOwnerId: "e" }),
      entry({ paymentMode: null, landOwnerId: "f" }),
    ),
  })]);
  const r = RA.computePayments(docs, fy());
  assert.equal(r.summary.total, 350);
  assert.equal(r.summary.cash, 100);
  assert.equal(r.summary.online, 250);
  assert.equal(r.summary.gstPayments, 50);
  assert.equal(r.meta.entriesWithoutAmount, 1);
  assert.equal(r.meta.entriesWithoutDate, 1);
});

test("payment media-type filter: single-type sites match; mixed sites are excluded and reported, never split", () => {
  const led = hist(entry({ amount: 1000 }));
  const docs = deepFreeze([
    site("1", [["Hoarding", "Chennai"]], { ledgerHistory: led }),
    site("2", [["Unipole", "Chennai"]], { ledgerHistory: led }),
    site("3", [["Hoarding", "Chennai"], ["Unipole", "Chennai"]], { ledgerHistory: led }),
  ]);
  const r = RA.computePayments(docs, fy({ mediaType: "Hoarding" }));
  assert.equal(r.summary.total, 1000);
  assert.deepEqual(r.meta.excludedMixedSites, { sites: 1, amount: 1000 });
  assert.equal(RA.computePayments(docs, fy()).summary.total, 3000);
  assert.equal(RA.computePayments(docs, fy({ city: "Mumbai" })).summary.total, 0);
});

test("payments outside the selected range are excluded (FY boundaries)", () => {
  const docs = deepFreeze([site("1", [["H", "C"]], { ledgerHistory: hist(
    entry({ date: new Date(Date.UTC(2026, 2, 31)), landOwnerId: "a" }),
    entry({ date: new Date(Date.UTC(2026, 3, 1)), landOwnerId: "b" }),
    entry({ date: new Date(Date.UTC(2027, 2, 31, 12)), landOwnerId: "c" }),
    entry({ date: new Date(Date.UTC(2027, 3, 1)), landOwnerId: "d" }),
  ) })]);
  assert.equal(RA.computePayments(docs, fy()).summary.entries, 2);
});

// ── Payments: period "to be paid" / "unpaid" cards (real ledger functions, synthetic docs) ──
const Ledger = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
const { computeRentalDueStats } = require("../utils/rentalDueStats");
const { mediaAsOfDate, landOwnersAsOfDate } = require("../utils/appraisalRent");
const LIB = {
  getAllDueCycles: Ledger.getAllDueCycles,
  getOverallSummaryForCycle: Ledger.getOverallSummaryForCycle,
  resolveExpectedGstForCycle: Ledger.resolveExpectedGstForCycle,
  mediaAsOfDate,
};
const D = (y, m, d = 10) => new Date(Date.UTC(y, m, d));
const face = (id, type = "Hoarding", city = "Chennai", status = 1) => ({ _id: `${id}-f`, mediaType: type, city, mediaName: `S${id}`, status, siteBillMode: 1 });
const ownerOnline = (id, amt, extra = {}) => ({ _id: `${id}-o`, paymentCategory: 2, onlineAmount: amt, shareAmount: amt, ...extra });
// A monthly site whose billing starts on `start` (cycles = the months after it), one online owner.
const dsite = (id, rent, { start = D(2026, 3), owners, ...extra } = {}) => ({
  _id: id,
  mediaDetails: [face(id)],
  rentalPayment: { billingStartDate: start, lastBillPaidDate: start, paymentFrequency: 1, totalRentalAmount: rent, gstApplicable: 0, gstAmount: 0 },
  landOwners: owners || [ownerOnline(id, rent)],
  rentalDue: [], ledger: [], ledgerHistory: [], gstBalanceHistory: [],
  ...extra,
});
const withGstRp = (site, gstAmount) => ({ ...site, rentalPayment: { ...site.rentalPayment, gstApplicable: 1, gstAmount } });
const paidHist = (id, monthName, year = "2026", amount = 10000) => [{ year, months: [{ month: monthName, entries: [{ landOwnerId: `${id}-o`, paymentMode: "Online", isUtrEntry: false, amount, date: D(2026, 5, 12), month: `${monthName} ${year}`, withGst: 0 }] }] }];
const bill = (label, withGst, extra = {}) => ({ dueMonth: label, dueDate: D(2026, 9), approvalStatus: 1, withGst, ...extra });
const OCT = { startDate: "2026-10-01", endDate: "2026-10-31" };
const due = (docs, body = {}) => RA.computePeriodDue(docs, fy(body), LIB, NOW).due;
const dueRange = (docs, body) => RA.computePeriodDue(docs, RA.parseFilters(body, NOW).filters, LIB, NOW);

// October 2026 reconciliation fixture: reproduces the Rental Master figures exactly
//   rent 55,83,035 + direct GST 56,160 + hold GST 4,44,830 = 60,84,025; paid 2,54,000
const octFixture = () => {
  const start = D(2026, 8); // billing starts 10 Sep -> the only cycle up to October is October
  const s1 = dsite("S1", 2746000, { start });
  const s4 = dsite("S4", 254000, { start, ledgerHistory: paidHist("S4", "October", "2026", 254000) });
  s4.ledgerHistory[0].months[0].entries[0].date = D(2026, 9, 12);
  const s2 = withGstRp(dsite("S2", 2000000, { start, rentalDue: [bill("October 2026", 1)] }), 444830);
  const s3 = dsite("S3", 583035, { start, owners: [ownerOnline("S3", 583035, { gstApplicable: 1, gstAmount: 56160 })], rentalDue: [bill("October 2026", 2)] });
  return deepFreeze([s1, s2, s3, s4]);
};

test("October 2026 reconciliation: matches Rental Master (60,84,025) and splits rent / direct GST / hold GST", () => {
  const docs = octFixture();
  const rm = computeRentalDueStats(docs, { year: 2026, month: 10 });
  assert.equal(Math.round(rm.dueThisMonthAmount), 6084025); // Rental Master "Total Due This Month"
  const r = RA.computePeriodDue(docs, RA.parseFilters(OCT, NOW).filters, LIB, NOW);
  assert.equal(r.due.toBePaid, 6084025);
  assert.equal(r.due.parts.rentDirect.toBePaid, 5583035 + 56160); // rent 55,83,035 + direct GST 56,160
  assert.equal(r.due.parts.hold.toBePaid, 444830);
  const summary = Ledger.calculateOverallLedgerSummary(docs, { year: 2026, month: 10 });
  assert.equal(summary.overAllCurrentRentalAmount, 5583035);
  assert.equal(r.due.parts.rentDirect.unpaid, summary.currentMonthRentPending); // ledger's rent pending (incl. direct GST)
  assert.equal(r.due.parts.hold.unpaid, summary.currentMonthGstPending); // ledger's GST pending
  assert.equal(r.due.parts.rentDirect.unpaid, 5385195);
  assert.equal(r.due.parts.hold.unpaid, 444830);
  assert.equal(r.due.unpaid, 5830025);
  const pay = RA.withPeriodDue(RA.computePayments(docs, RA.parseFilters(OCT, NOW).filters), docs, RA.parseFilters(OCT, NOW).filters, LIB, NOW);
  assert.equal(pay.summary.total, 254000); // amount paid
  assert.equal(pay.summary.toBePaid, 6084025);
  assert.equal(pay.summary.unpaid, 5830025);
  assert.deepEqual(pay.summary.dueParts.hold, { toBePaid: 444830, unpaid: 444830 });
});

test("withGst classification: bill 0, bill 1 and no bill with expected GST are HOLD; bill 2 is DIRECT", () => {
  const start = D(2026, 8);
  const mk = (id, bills) => withGstRp(dsite(id, 10000, { start, rentalDue: bills }), 1800);
  for (const [bills, hold, rentDirect] of [
    [[bill("October 2026", 0)], 1800, 10000],
    [[bill("October 2026", 1)], 1800, 10000],
    [[], 1800, 10000],
    [[bill("October 2026", 2)], 0, 11800],
  ]) {
    const d = RA.computePeriodDue(deepFreeze([mk("A", bills)]), RA.parseFilters(OCT, NOW).filters, LIB, NOW).due;
    assert.equal(d.parts.hold.toBePaid, hold, JSON.stringify(bills));
    assert.equal(d.parts.rentDirect.toBePaid, rentDirect, JSON.stringify(bills));
  }
});

test("period due: FY and custom ranges sum the due cycles up to the current month (future never projected)", () => {
  const docs = deepFreeze([dsite("1", 10000, { ledgerHistory: paidHist("1", "June") })]);
  const d = due(docs);
  assert.equal(d.toBePaid, 60000); // May..Oct; Nov-Mar are not yet due
  assert.equal(d.unpaid, 50000);
  assert.equal(d.unpaidSites, 1);
  const jul = due(docs, { startDate: "2026-07-01", endDate: "2026-08-31" });
  assert.deepEqual([jul.toBePaid, jul.unpaid], [20000, 20000]);
  const june = due(docs, { startDate: "2026-06-01", endDate: "2026-06-30" });
  assert.deepEqual([june.toBePaid, june.unpaid], [10000, 0]);
  assert.equal(due(docs, { startDate: "2026-10-01", endDate: "2026-10-31" }).toBePaid, 10000); // current month included
  assert.equal(due(docs, { startDate: "2026-11-01", endDate: "2026-12-31" }).toBePaid, 0);
  assert.equal(due(docs, { fy: 2025 }).toBePaid, 0);
});

test("period due: hold GST is the expected GST per cycle; recorded GST balance rows are netted, never added on top", () => {
  const rows = [
    { dueMonth: "July 2026", gstAmount: 1800, isPaid: true, ownerId: "1-o" }, // paid -> July hold GST settled
    { dueMonth: "August 2026", gstAmount: 1800, isPaid: false, ownerId: "1-o" }, // recorded but unpaid -> still just 1,800
  ];
  const docs = deepFreeze([withGstRp(dsite("1", 10000, { gstBalanceHistory: rows }), 1800)]);
  const d = due(docs);
  assert.equal(d.parts.hold.toBePaid, 6 * 1800);
  assert.equal(d.parts.hold.unpaid, 5 * 1800); // 6 cycles minus paid July; August row not double counted
  assert.equal(d.parts.rentDirect.toBePaid, 60000);
  assert.equal(d.toBePaid, 60000 + 10800);
  assert.equal(d.unpaid, 60000 + 9000);
});

test("period due: payments are deducted once (live ledger mirrored in history) and never affect the due total", () => {
  const live = [{ landOwnerId: "1-o", paymentMode: "Online", status: 1, month: "June 2026", amount: 10000 }];
  const docs = deepFreeze([dsite("1", 10000, { ledger: live, ledgerHistory: paidHist("1", "June") })]);
  const d = due(docs);
  assert.equal(d.toBePaid, 60000);
  assert.equal(d.unpaid, 50000);
});

test("period due: duplicate bill rows for a month do not add a second cycle", () => {
  const bills = [bill("July 2026", 0), bill("July 2026", 0, { approvalStatus: 3 })];
  assert.equal(due(deepFreeze([dsite("1", 10000, { rentalDue: bills })])).toBePaid, 60000);
});

test("period due: appraisal-aware, identical to the ledger month by month", () => {
  const appraisal = { applicable: 1, history: [{ appraisalDate: D(2026, 8, 1), previousRent: 10000, newRent: 11000, appraisalAmount: 1000 }] };
  const docs = deepFreeze([dsite("1", 11000, { appraisal })]);
  const d = due(docs);
  assert.equal(d.toBePaid, 4 * 10000 + 2 * 11000); // May-Aug at the old rent, Sep-Oct at the new rent
  let oracle = 0;
  for (let m = 5; m <= 10; m++) {
    const s = Ledger.getOverallSummaryForCycle(docs[0], { year: 2026, month: m });
    oracle += s.currentMonthRentalAmount + s.currentMonthGstAmount;
  }
  assert.equal(d.toBePaid, oracle);
});

test("period due: opening balances (rent + GST) are added once, by dueMonth, and keep their own split", () => {
  const start = D(2026, 8);
  const rp = {
    rentalOutstandingHistory: [
      { dueMonth: "May 2026", baseRentOutstandingAmount: 5000, isPaid: false },
      { dueMonth: "June 2026", baseRentOutstandingAmount: 3000, isPaid: true },
      { dueMonth: "March 2026", baseRentOutstandingAmount: 900, isPaid: false },
      { dueMonth: "unreadable", baseRentOutstandingAmount: 700, isPaid: false },
    ],
    gstOutstandingHistory: [
      { dueMonth: "May 2026", gstOutStandingAmount: 700, isPaid: false },
      { dueMonth: "June 2026", gstOutStandingAmount: 300, utrNumber: "U1" },
    ],
  };
  const site = dsite("1", 10000, { start });
  const docs = deepFreeze([{ ...site, rentalPayment: { ...site.rentalPayment, ...rp } }]);
  const r = dueRange(docs, { fy: 2026 });
  assert.deepEqual(r.due.parts.opening.rent, { toBePaid: 8000, unpaid: 5000 });
  assert.deepEqual(r.due.parts.opening.gst, { toBePaid: 1000, unpaid: 700 });
  assert.equal(r.due.parts.rentDirect.toBePaid, 10000 + 8000); // October cycle + opening rent
  assert.equal(r.due.parts.hold.toBePaid, 1000);
  assert.equal(r.due.toBePaid, 19000);
  assert.equal(r.due.unpaid, 10000 + 5000 + 700);
  assert.equal(r.meta.openingRowsWithoutDate, 1);
  assert.equal(dueRange(docs, OCT).due.toBePaid, 10000); // opening rows are outside October
  assert.equal(dueRange(docs, { fy: 2025 }).due.parts.opening.rent.unpaid, 900);
});

test("period due: media type / city filters, mixed sites, inactive faces and sites without owners", () => {
  const docs = deepFreeze([
    dsite("1", 10000),
    { ...dsite("2", 10000), mediaDetails: [face("2", "Unipole")] },
    { ...dsite("3", 10000), mediaDetails: [face("3", "Hoarding"), face("3b", "Unipole")] },
    { ...dsite("4", 10000), mediaDetails: [face("4", "Hoarding", "Chennai", 0)] },
    dsite("5", 10000, { owners: [] }),
  ]);
  assert.equal(due(docs).toBePaid, 60000 * 3);
  const f = RA.computePeriodDue(docs, fy({ mediaType: "Hoarding" }), LIB, NOW);
  assert.equal(f.due.toBePaid, 60000);
  assert.ok(f.meta.excludedMixedSites.sites >= 1);
  assert.equal(due(docs, { city: "Mumbai" }).toBePaid, 0);
});

test("period due: cash + online owners need both modes paid", () => {
  const owners = [{ _id: "1-o", paymentCategory: 3, cashAmount: 4000, onlineAmount: 6000, shareAmount: 10000 }];
  const d = due(deepFreeze([dsite("1", 10000, { owners, ledgerHistory: paidHist("1", "June") })]), { startDate: "2026-06-01", endDate: "2026-06-30" });
  assert.equal(d.toBePaid, 10000);
  assert.equal(d.unpaid, 4000);
});

test("period due: the paid card (payments by date) is independent and the chart is untouched", () => {
  const docs = deepFreeze([dsite("1", 10000, { ledgerHistory: paidHist("1", "June", "2026", 10000) })]);
  const base = RA.computePayments(docs, fy());
  const merged = RA.withPeriodDue(base, docs, fy(), LIB, NOW);
  assert.equal(merged.summary.total, 10000);
  assert.equal(merged.summary.toBePaid, 60000);
  assert.equal(merged.summary.unpaid, 50000);
  assert.deepEqual(merged.buckets, base.buckets);
  assert.equal(base.summary.unpaid, undefined);
});

// ── Media ─────────────────────────────────────────────────────────────────
const at = (y, m, d = 5) => new Date(Date.UTC(y, m, d));
const mediaDocs = () => deepFreeze([
  site("1", [["Hoarding", "Chennai"]], { createdAt: at(2026, 5) }), // one face
  site("2", [["Hoarding", "Chennai"], ["Hoarding", "Chennai"], ["Hoarding", "Chennai"]], { createdAt: at(2026, 5, 9) }), // same type x3
  site("3", [["Hoarding", "Chennai"], ["Pole Board", "Chennai"]], { createdAt: at(2026, 6) }), // mixed types
  site("4", [["Pole Board", "Madurai"]], { createdAt: at(2026, 6, 20) }),
  site("5", [["Hoarding", "Madurai"], ["Pole Board", "Chennai"]], { createdAt: at(2026, 7) }), // type/city on different faces
  site("6", [["Hoarding", "Chennai"]], { createdAt: at(2026, 2, 31) }), // before FY 2026
  site("7", [["Hoarding", "Chennai"]], { createdAt: at(2027, 3, 1) }), // after FY 2026
  site("8", [["Hoarding", "Chennai"]], { createdAt: null }),
  site("9", [["Hoarding", "Chennai"]], { createdAt: "not-a-date" }),
]);
const monthly = (r) => Object.fromEntries(r.buckets.filter((b) => b.total).map((b) => [b.key, b.total]));
const reconciles = (r) => assert.equal(r.buckets.reduce((a, b) => a + b.total, 0), r.summary.total);

test("media: one site with one face counts as one", () => {
  const r = RA.computeMedia(deepFreeze([site("1", [["Hoarding", "Chennai"]], { createdAt: at(2026, 5) })]), fy());
  assert.equal(r.summary.total, 1);
  assert.equal(bucket(r, "2026-06").total, 1);
});

test("media: every face counts (the dashboard's unit); summary.sites is the distinct documents", () => {
  const r = RA.computeMedia(deepFreeze([site("2", [["Hoarding", "Chennai"], ["Hoarding", "Chennai"], ["Hoarding", "Chennai"]], { createdAt: at(2026, 5) })]), fy());
  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.sites, 1);
  assert.deepEqual(r.summary.byType, { Hoarding: 3 });
});

test("media: a mixed-media site counts one per face and byType sums to the total", () => {
  const r = RA.computeMedia(deepFreeze([site("3", [["Hoarding", "Chennai"], ["Pole Board", "Chennai"]], { createdAt: at(2026, 6) })]), fy());
  assert.equal(r.summary.total, 2);
  assert.equal(bucket(r, "2026-07").total, 2);
  assert.deepEqual(r.summary.byType, { Hoarding: 1, "Pole Board": 1 });
});

test("media: a media type filter counts only the matching faces of a mixed site", () => {
  const docs = deepFreeze([site("3", [["Hoarding", "Chennai"], ["Hoarding", "Chennai"], ["Pole Board", "Chennai"]], { createdAt: at(2026, 6) })]);
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding" })).summary.total, 2);
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Pole Board" })).summary.total, 1);
  for (const mediaType of ["Hoarding", "Pole Board"]) reconciles(RA.computeMedia(docs, fy({ mediaType })));
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Unipole" })).summary.total, 0);
});

test("media: several sites in the same month are all counted", () => {
  assert.equal(bucket(RA.computeMedia(mediaDocs(), fy()), "2026-06").total, 4); // sites 1 (1 face) and 2 (3 faces)
});

test("media: sites in different months land in the right buckets", () => {
  assert.deepEqual(monthly(RA.computeMedia(mediaDocs(), fy())), { "2026-06": 4, "2026-07": 3, "2026-08": 2 });
});

test("media: monthly counts reconcile with summary.total (unfiltered and filtered)", () => {
  for (const body of [{}, { mediaType: "Hoarding" }, { mediaType: "Pole Board" }, { city: "Chennai" }, { mediaType: "Hoarding", city: "Madurai" }]) {
    reconciles(RA.computeMedia(mediaDocs(), fy(body)));
  }
  assert.equal(RA.computeMedia(mediaDocs(), fy()).summary.total, 9);
});

test("media: media type and city filters work together on the same face", () => {
  const docs = mediaDocs();
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding" })).summary.total, 6); // 1 + 3 + 1 + 1
  assert.equal(RA.computeMedia(docs, fy({ city: "Madurai" })).summary.total, 2); // site 4, site 5's Hoarding face
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Pole Board", city: "Madurai" })).summary.total, 1); // site 4 only
  assert.deepEqual(monthly(RA.computeMedia(docs, fy({ mediaType: "Pole Board", city: "Madurai" }))), { "2026-07": 1 });
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding", city: "Madurai" })).summary.total, 1); // site 5's face
});

test("media: sites outside the financial year or custom range are excluded", () => {
  const docs = mediaDocs();
  assert.equal(RA.computeMedia(docs, fy({ fy: 2025 })).summary.total, 1); // site 6 only (31 Mar 2026)
  const custom = RA.computeMedia(docs, RA.parseFilters({ startDate: "2026-07-01", endDate: "2026-07-31" }, NOW).filters);
  assert.equal(custom.summary.total, 3);
  assert.equal(custom.buckets.length, 31);
  reconciles(custom);
});

test("media: missing or invalid createdAt is reported, never given a date", () => {
  const docs = mediaDocs();
  const r = RA.computeMedia(docs, fy());
  assert.equal(r.meta.sitesWithoutOnboardingDate, 2);
  assert.equal(r.meta.facesWithoutOnboardingDate, 2);
  assert.equal(r.summary.total, 9);
  // metadata honours filters: both undated sites are Hoarding / Chennai
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Pole Board" })).meta.sitesWithoutOnboardingDate, 0);
  assert.equal(RA.computeMedia(docs, fy({ city: "Chennai" })).meta.sitesWithoutOnboardingDate, 2);
});

test("media: a face-less document counts once (inactive) unfiltered and never under a media type / city filter", () => {
  const docs = deepFreeze([{ _id: "x", mediaDetails: [], createdAt: at(2026, 5) }]);
  assert.equal(RA.computeMedia(docs, fy()).summary.total, 1);
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding" })).summary.total, 0);
  assert.equal(RA.computeMedia(docs, fy({ city: "Chennai" })).summary.total, 0);
  assert.equal(RA.computeMedia(docs, fy({ siteStatus: "inactive" })).summary.total, 1);
  assert.equal(RA.computeMedia(docs, fy({ siteStatus: "active" })).summary.total, 0);
  assert.deepEqual(RA.computeMedia(docs, fy()).summary.byType, { Unspecified: 1 });
});

test("media: Active / Inactive / All count faces with the dashboard's rule (status 1 = active, else inactive)", () => {
  const mk = (id, statuses, extra = {}) => ({ _id: id, createdAt: at(2026, 5), mediaDetails: statuses.map((st, i) => ({ _id: `${id}${i}`, mediaType: "Hoarding", city: "Chennai", status: st })), ...extra });
  const docs = deepFreeze([mk("A", [1]), mk("AB", [2, 1, 3]), mk("I", [2]), mk("H", [3, 3]), { _id: "N", mediaDetails: [], createdAt: at(2026, 5) }, mk("U", [undefined, "1"])]);
  const total = (siteStatus, extra = {}) => RA.computeMedia(docs, fy({ siteStatus, ...extra })).summary.total;
  // faces: A 1 | AB 3 (1 active) | I 1 | H 2 | N (face-less) | U 2 (status "1" is active like Number(), undefined is not)
  assert.deepEqual([total("active"), total("inactive"), total("all")], [3, 7, 10]);
  assert.equal(total("active") + total("inactive"), total("all"));
  assert.equal(RA.computeMedia(docs, fy()).summary.total, 10, "default (absent) is all");
  // the status filter combines with media type / city and the buckets still reconcile
  assert.deepEqual([total("active", { mediaType: "Hoarding" }), total("inactive", { mediaType: "Hoarding" })], [3, 6]);
  assert.equal(total("active", { city: "Madurai" }), 0);
  for (const s of ["active", "inactive", "all"]) reconciles(RA.computeMedia(docs, fy({ siteStatus: s })));
  assert.equal(RA.computeMedia(docs, fy({ siteStatus: "all" })).summary.sites, 6);
  assert.equal(RA.computeMedia(docs, fy({ siteStatus: "active" })).summary.sites, 3, "A, AB and U each have an active face");
});

test("media endpoint passes unfiltered documents (status is applied per face); other charts stay site-level", () => {
  const src = fs.readFileSync(path.join(__dirname, "../controllers/Admin/ReportAnalyticsController/ReportAnalyticsController.js"), "utf8");
  assert.ok(src.includes('chart === "media" ? loaded : RA.applySiteStatus(loaded, f)'));
});

// ── Appraisal ─────────────────────────────────────────────────────────────
const appraisal = (history, extra = {}) => ({ applicable: 1, appraisalHold: 0, history, ...extra });

test("appraisal separates given from upcoming using stored rows only (no projection)", () => {
  const docs = deepFreeze([site("1", [["H", "C"]], { appraisal: appraisal([
    { appraisalDate: new Date(Date.UTC(2026, 3, 1)), appraisalAmount: 1000 },
    { appraisalDate: new Date(Date.UTC(2026, 11, 1)), appraisalAmount: 1100 },
    { appraisalDate: new Date(Date.UTC(2026, 3, 1)), appraisalAmount: 9999, isAnchorEntry: true },
    { appraisalDate: new Date(Date.UTC(2026, 6, 1)), appraisalAmount: 0 },
  ]) })]);
  const r = RA.computeAppraisal(docs, fy(), NOW);
  assert.deepEqual(r.summary.given, { sites: 1, amount: 1000, entries: 1 });
  assert.deepEqual(r.summary.upcoming, { sites: 1, amount: 1100, entries: 1 });
  assert.equal(r.summary.held.entries, 0);
  assert.equal(bucket(r, "2026-12").upcoming.amount, 1100);
  assert.equal(bucket(r, "2027-01").upcoming.entries, 0);
});

test("appraisal hold: entries from the hold date are 'held'; not-applicable sites are skipped", () => {
  const docs = deepFreeze([
    site("1", [["H", "C"]], { appraisal: appraisal([
      { appraisalDate: new Date(Date.UTC(2025, 9, 1)), appraisalAmount: 500 },
      { appraisalDate: new Date(Date.UTC(2026, 9, 1)), appraisalAmount: 600 },
      { appraisalDate: new Date(Date.UTC(2027, 9, 1)), appraisalAmount: 700 },
    ], { applicable: 0, appraisalHold: 1, appraisalHoldDate: new Date(Date.UTC(2026, 9, 5)) }) }),
    site("2", [["H", "C"]], { appraisal: appraisal([{ appraisalDate: new Date(Date.UTC(2026, 5, 1)), appraisalAmount: 100 }], { applicable: 0 }) }),
  ]);
  const wide = RA.computeAppraisal(docs, RA.parseFilters({ startDate: "2025-04-01", endDate: "2027-12-31" }, NOW).filters, NOW);
  assert.equal(wide.summary.given.amount, 1100);
  assert.equal(wide.summary.held.amount, 700);
  assert.equal(wide.meta.sitesNotApplicable, 1);
});

// ── Bills ─────────────────────────────────────────────────────────────────
test("bills: generated rentalDue only, grouped by dueDate, existing status meanings, no 'paid' inferred", () => {
  const docs = deepFreeze([site("1", [["Hoarding", "Chennai"]], { rentalDue: [
    { dueDate: new Date(Date.UTC(2026, 10, 1)), baseAmount: 11800, gstAmount: 1800, netPayable: 10000, approvalStatus: 1 },
    { dueDate: new Date(Date.UTC(2026, 10, 15)), baseAmount: 5000, gstAmount: 0, netPayable: 5000, approvalStatus: 3 },
    { dueDate: new Date(Date.UTC(2027, 4, 1)), baseAmount: 9999, approvalStatus: 1 },
    { dueDate: null, baseAmount: 1 },
  ] })]);
  const r = RA.computeBills(docs, fy());
  const nov = bucket(r, "2026-11");
  assert.equal(nov.bills, 2);
  assert.equal(nov.total, 16800);
  assert.equal(nov.gst, 1800);
  assert.equal(nov.payable, 15000);
  assert.deepEqual(nov.byStatus, { Pending: { bills: 1, amount: 11800 }, Approved: { bills: 1, amount: 5000 } });
  assert.deepEqual(nov.byType, { Hoarding: { bills: 2, amount: 16800 } });
  assert.equal(r.meta.billsWithoutDueDate, 1);
  assert.equal(RA.computeBills(docs, fy({ mediaType: "Unipole" })).summary.bills, 0);
});

// Generated bills: media type per bill (its own face), not per site
const billFace = (id, mediaType, extra = {}) => ({ _id: id, mediaType, city: "Chennai", mediaName: id, status: 1, ...extra });
const faceBill = (faceId, amount, extra = {}) => ({ mediaDetailId: faceId, dueDate: new Date(Date.UTC(2026, 8, 15)), baseAmount: amount, approvalStatus: 3, ...extra });
const typeTotals = (r) => {
  const out = {};
  for (const b of r.buckets) for (const [k, v] of Object.entries(b.byType)) {
    out[k] ||= { bills: 0, amount: 0 };
    out[k].bills += v.bills; out[k].amount += v.amount;
  }
  return out;
};
// the shape of the real multi-type site: 12 faces, 4 types, one row per face per month (single-bill mode)
const multiTypeSite = () => ({
  _id: "MT",
  mediaDetails: [
    billFace("h1", "Hoarding", { siteBillMode: 1 }), billFace("h2", "Hoarding", { siteBillMode: 1 }),
    billFace("d1", "Digital", { siteBillMode: 1 }), billFace("d2", "Digital", { siteBillMode: 1 }),
    billFace("u1", "Unipole", { siteBillMode: 1 }), billFace("w1", "Wall Hoarding", { siteBillMode: 1 }),
  ],
  rentalDue: [
    faceBill("h1", 100), faceBill("h2", 100), faceBill("d1", 200), faceBill("d2", 200), faceBill("u1", 300), faceBill("w1", 400),
    faceBill("h1", 100, { dueDate: new Date(Date.UTC(2026, 9, 15)), approvalStatus: 1 }),
    faceBill("d1", 200, { dueDate: new Date(Date.UTC(2026, 9, 15)), approvalStatus: 1 }),
  ],
});

test("bills by type: each face-level bill takes its own face's type — no 'Mixed types', Digital is visible", () => {
  const docs = deepFreeze([multiTypeSite()]);
  const r = RA.computeBills(docs, fy());
  assert.deepEqual(typeTotals(r), {
    Hoarding: { bills: 3, amount: 300 },
    Digital: { bills: 3, amount: 600 },
    Unipole: { bills: 1, amount: 300 },
    "Wall Hoarding": { bills: 1, amount: 400 },
  });
  assert.equal(r.buckets.some((b) => b.byType["Mixed types"]), false);
  // counts, amounts and statuses are unchanged by the classification
  assert.equal(r.summary.bills, 8);
  assert.equal(r.summary.total, 1600);
  assert.equal(r.summary.sites, 1);
  assert.deepEqual(r.summary.byStatus, { Approved: { bills: 6, amount: 1300 }, Pending: { bills: 2, amount: 300 } });
  assert.equal(Object.values(typeTotals(r)).reduce((x, v) => x + v.bills, 0), r.summary.bills);
});

test("bills media-type filter uses the same per-bill type: matching faces of a multi-type site are included", () => {
  const docs = deepFreeze([multiTypeSite(), site("S2", [["Hoarding", "Chennai"]], { rentalDue: [faceBill(null, 50)] })]);
  const all = RA.computeBills(docs, fy());
  const by = (t) => RA.computeBills(docs, fy({ mediaType: t }));
  assert.deepEqual([by("Hoarding").summary.bills, by("Hoarding").summary.total], [4, 350]); // 3 face bills + the single-type site
  assert.deepEqual([by("Digital").summary.bills, by("Digital").summary.total], [3, 600]);
  assert.deepEqual(typeTotals(by("Digital")), { Digital: { bills: 3, amount: 600 } });
  assert.deepEqual(by("Digital").meta.excludedMixedSites, { sites: 0, amount: 0 });
  // the per-type views partition the unfiltered total exactly
  const parts = ["Hoarding", "Digital", "Unipole", "Wall Hoarding"].map(by);
  assert.equal(parts.reduce((x, r) => x + r.summary.bills, 0), all.summary.bills);
  assert.equal(parts.reduce((x, r) => x + r.summary.total, 0), all.summary.total);
  // city filtering is unchanged (site-level)
  assert.equal(RA.computeBills(docs, fy({ city: "Chennai", mediaType: "Digital" })).summary.bills, 3);
  assert.equal(RA.computeBills(docs, fy({ city: "Madurai" })).summary.bills, 0);
});

test("bills: site-level rows keep site-level classification from ACTIVE faces; stale face rows are excluded", () => {
  const docs = deepFreeze([
    // no mediaDetailId on a multi-type site: genuinely site-level -> Mixed types, excluded from type filters
    { _id: "A", mediaDetails: [billFace("a1", "Hoarding"), billFace("a2", "Unipole")], rentalDue: [faceBill(null, 70)] },
    // stale face id (face re-created): excluded and reported, never classified (the 52 real rows are all like this)
    { _id: "B", mediaDetails: [billFace("b1", "Unipole"), billFace("b2", "Unipole")], rentalDue: [faceBill("gone", 30)] },
    // site-level row: the inactive Unipole face no longer makes it mixed
    { _id: "C", mediaDetails: [billFace("c1", "Hoarding"), billFace("c2", "Unipole", { status: 2 })], rentalDue: [faceBill(null, 20)] },
    // a face-level row on a face that is inactive now still keeps that face's type
    { _id: "D", mediaDetails: [billFace("d1", "Digital", { status: 2 }), billFace("d2", "Hoarding")], rentalDue: [faceBill("d1", 10)] },
    // no active face at all: all faces count
    { _id: "E", mediaDetails: [billFace("e1", "Wall Graphics", { status: 3 })], rentalDue: [faceBill(null, 5)] },
  ]);
  assert.deepEqual(typeTotals(RA.computeBills(docs, fy())), {
    "Mixed types": { bills: 1, amount: 70 },
    Hoarding: { bills: 1, amount: 20 },
    Digital: { bills: 1, amount: 10 },
    "Wall Graphics": { bills: 1, amount: 5 },
  });
  const hoarding = RA.computeBills(docs, fy({ mediaType: "Hoarding" }));
  assert.equal(hoarding.summary.total, 20);
  assert.deepEqual(hoarding.meta.excludedMixedSites, { sites: 1, amount: 70 }); // only the genuinely mixed site-level row
  assert.deepEqual(RA.computeBills(docs, fy()).meta.staleRowsExcluded, { bills: 1, amount: 30, sites: 1 });
  assert.equal(RA.billMediaType(docs[0], { mediaDetailId: "a2" }), "Unipole");
  assert.equal(RA.billMediaType(docs[0], {}), RA.MIXED);
  assert.equal(RA.billMediaType({ mediaDetails: [] }, {}), null);
});

test("media types are compared trimmed with inner spaces collapsed (case kept) — faces, bills, filter options and the filter", () => {
  const docs = deepFreeze([{
    _id: "N",
    createdAt: new Date(Date.UTC(2026, 5, 1)),
    mediaDetails: [billFace("n1", " Wall   Hoarding "), billFace("n2", "Wall Hoarding"), billFace("n3", "hoarding")],
    rentalDue: [faceBill("n1", 10), faceBill("n2", 20), faceBill("n3", 40)],
  }]);
  assert.deepEqual(typeTotals(RA.computeBills(docs, fy())), { "Wall Hoarding": { bills: 2, amount: 30 }, hoarding: { bills: 1, amount: 40 } });
  assert.equal(RA.computeBills(docs, fy({ mediaType: "  Wall  Hoarding" })).summary.total, 30);
  assert.equal(RA.computeBills(docs, fy({ mediaType: "Hoarding" })).summary.total, 0, "case is not merged");
  assert.deepEqual(RA.computeFilterOptions(docs, NOW).mediaTypes, ["hoarding", "Wall Hoarding"]);
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Wall Hoarding" })).summary.total, 2); // two faces of the site match (faces are counted)
});

// ── GST ───────────────────────────────────────────────────────────────────
test("GST Rental Master: generated-bill GST (direct / hold type) + onboarding dues; never gstBalanceHistory", () => {
  const docs = deepFreeze([site("1", [["H", "C"]], {
    gstBalanceHistory: [
      { rentalDueId: "b1", dueMonth: "May 2026", cycle: new Date(Date.UTC(2026, 4, 1)), gstAmount: 180, isPaid: false },
      { rentalDueId: "b2", dueMonth: "June 2026", cycle: new Date(Date.UTC(2026, 5, 1)), gstAmount: 270, isPaid: true, paidAmount: 270, paidAt: new Date(Date.UTC(2026, 7, 9)) },
      { rentalDueId: "b3", dueMonth: "July 2026", cycle: new Date(Date.UTC(2026, 6, 1)), gstAmount: 100, isPaid: false, source: "rental" },
      { rentalDueId: "b3", dueMonth: "July 2026", cycle: new Date(Date.UTC(2026, 6, 1)), gstAmount: 60, isPaid: false, source: "owner", ownerId: "o1" },
      { rentalDueId: "b3", dueMonth: "July 2026", cycle: new Date(Date.UTC(2026, 6, 1)), gstAmount: 40, isPaid: false, source: "owner", ownerId: "o2" },
    ],
    rentalPayment: { gstOutstandingHistory: [
      { dueMonth: "March 2026", gstOutStandingAmount: 500, isPaid: false },
      { dueMonth: "August 2026", gstOutStandingAmount: 400, isPaid: false, paymentBreakup: [{ amount: 150 }] },
      { dueMonth: "September 2026", gstOutStandingAmount: 999, isPaid: true },
    ] },
    rentalDue: [
      { _id: "b1", dueDate: new Date(Date.UTC(2026, 4, 1)), gstAmount: 180, withGst: 1 },
      { _id: "f1", dueDate: new Date(Date.UTC(2026, 11, 1)), gstAmount: 200, withGst: 2 },
      { _id: "f2", dueDate: new Date(Date.UTC(2026, 11, 1)), gstAmount: 300, withGst: 1, gstAddedToBalance: true },
      { _id: "f3", dueDate: new Date(Date.UTC(2026, 8, 1)), gstAmount: 700 },
      { _id: "x0", dueDate: new Date(Date.UTC(2026, 8, 1)), gstAmount: 0, withGst: 2 },
    ],
  })]);
  const rm = RA.computeGst(docs, fy({ source: "rentalMaster" }));
  assert.deepEqual(rm.categories, ["direct", "hold", "unpaid"]);
  assert.equal(rm.filters.source, "rentalMaster");
  assert.equal(rm.summary.direct.amount, 200); // withGst 2
  assert.equal(rm.summary.hold.amount, 180 + 300 + 700); // withGst 1 / not set — the ledger's classification
  assert.equal(rm.summary.unpaid.amount, 250); // Aug 400 - 150 part-paid; Mar 2026 is before FY 2026; Sep is paid
  assert.equal(rm.summary.paid, undefined, "no ledger paid rows in the Rental Master view");
  assert.equal(bucket(rm, "2026-12").direct.amount, 200);
  assert.equal(bucket(rm, "2026-12").hold.amount, 300);
  for (const r of [rm]) {
    for (const c of r.categories) assert.equal(r.buckets.reduce((x, b) => x + b[c].amount, 0), r.summary[c].amount, c);
  }
  // the calendar year moves the onboarding due of March 2026 in, and December out of nothing
  const cy = RA.computeGst(docs, RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31", source: "rentalMaster" }, NOW).filters);
  assert.equal(cy.summary.unpaid.amount, 750);
});

// ── GST, Ledger: must equal Ledger Entry's "GST Hold" cards ─────────────────
// Ledger Entry (calculateNewOverallLedgerSummary) derives GST per bill cycle:
// expected GST, paid from gstBalanceHistory rows (paid or UTR) — not from rows alone.
const gstLedgerFixture = () => {
  const start = D(2026, 5); // billing from 10 Jun -> cycles Jul, Aug, Sep, Oct up to today (21 Oct)
  // A: GST-hold site with NO gstBalanceHistory rows (bills never approved) — the reported mismatch
  const a = withGstRp(dsite("GA", 10000, { start }), 1800);
  // B: Aug GST paid via a UTR (isPaid still false — the ledger counts it), Sep paid flag, Jul/Oct still held
  const b = withGstRp(dsite("GB", 10000, { start, gstBalanceHistory: [
    { rentalDueId: "x1", dueMonth: "August 2026", cycle: D(2026, 7), gstAmount: 1800, isPaid: false, utrNumber: "UTR-AUG", ownerId: "GB-o" },
    { rentalDueId: "x2", dueMonth: "September 2026", cycle: D(2026, 8), gstAmount: 1800, isPaid: true, ownerId: "GB-o" },
  ] }), 1800);
  // C: direct GST (withGst 2) in October, owner GST 500, rent not paid
  const c = dsite("GC", 5000, { start, owners: [ownerOnline("GC", 5000, { gstApplicable: 1, gstAmount: 500 })], rentalDue: [bill("October 2026", 2)] });
  // D: onboarding GST dues: May unpaid, January paid via UTR
  const d = dsite("GD", 3000, { start, rentalPayment: { ...dsite("GD", 3000, { start }).rentalPayment, gstOutstandingHistory: [
    { dueMonth: "May 2026", gstOutStandingAmount: 700, isPaid: false },
    { dueMonth: "January 2026", gstOutStandingAmount: 300, isPaid: false, utrNumber: "UTR-JAN" },
  ] } });
  // E: inactive site — the ledger ignores it
  const e = withGstRp(dsite("GE", 10000, { start, mediaDetails: [face("GE", "Hoarding", "Chennai", 0)] }), 999);
  return deepFreeze([a, b, c, d, e]);
};
const ledGst = (docs, body) => RA.computeLedgerGst(docs, RA.parseFilters({ source: "ledger", ...body }, NOW).filters, LIB, NOW);

test("GST Ledger: GST held for cycles without any gstBalanceHistory row is reported (the Ledger Entry / analytics mismatch)", () => {
  const onlyA = deepFreeze([gstLedgerFixture()[0]]);
  const r = ledGst(onlyA, { fy: 2026 });
  assert.equal(r.filters.source, "ledger");
  assert.deepEqual(r.categories, ["paid", "remaining"]);
  assert.equal(r.summary.remaining.amount, 4 * 1800); // Jul–Oct cycles, nothing paid
  assert.equal(r.summary.paid.amount, 0);
  assert.equal(r.summary.parts.hold.due, 4 * 1800);
  // the Rental Master view of the same site has no generated bills, so it shows nothing — sources are not mixed
  assert.equal(RA.computeGst(onlyA, fy({ source: "rentalMaster" })).buckets.every((b) => b.hold.amount === 0), true);
});

test("GST Ledger: reconciles exactly with Ledger Entry's GST Hold (This Month) and (Past Months) cards", () => {
  const docs = gstLedgerFixture();
  const le = Ledger.calculateNewOverallLedgerSummary(docs, { year: 2026, month: 10 });
  // whole history up to today (Ledger Entry's "Past Months" spans every earlier cycle)
  const r = ledGst(docs, { startDate: "2026-01-01", endDate: "2026-12-31" });
  const oct = bucket(r, "2026-10");
  assert.equal(Math.floor(oct.due), le.newOverAllCurrentMonthGstAmount);
  assert.equal(Math.floor(oct.paid.amount), le.newCurrentMonthGstAmountPaid);
  assert.equal(Math.floor(oct.remaining.amount), le.newCurrentMonthGstRemaining);
  const past = r.buckets.filter((b) => b.key < "2026-10");
  const sum = (fn) => Math.floor(past.reduce((x, b) => x + fn(b), 0));
  assert.equal(sum((b) => b.due), le.newOverAllPastGstAmount);
  assert.equal(sum((b) => b.paid.amount), le.newPastGstAmountPaid);
  assert.equal(sum((b) => b.remaining.amount), le.newPastGstRemaining);
  // the concrete figures behind those cards
  assert.deepEqual([oct.due, oct.paid.amount, oct.remaining.amount], [1800 + 1800 + 500, 0, 4100]); // A + B held, C direct unpaid
  assert.deepEqual(oct.parts.direct, { due: 500, paid: 0, remaining: 500 });
  assert.deepEqual([bucket(r, "2026-08").paid.amount, bucket(r, "2026-09").paid.amount], [1800, 1800]); // UTR row + paid row
  assert.deepEqual(bucket(r, "2026-05").parts.opening, { due: 700, paid: 0, remaining: 700 });
  assert.deepEqual(bucket(r, "2026-01").parts.opening, { due: 300, paid: 300, remaining: 0 });
  // future months (after today) are never projected
  for (const k of ["2026-11", "2026-12"]) assert.equal(bucket(r, k).due, 0, k);
  // no double counting: per-month categories add up to the summary, and due = paid + remaining
  assert.equal(r.summary.due, r.summary.paid.amount + r.summary.remaining.amount);
  assert.equal(r.buckets.reduce((x, b) => x + b.due, 0), r.summary.due);
  assert.equal(r.summary.parts.hold.due + r.summary.parts.direct.due + r.summary.parts.opening.due, r.summary.due);
});

test("GST Ledger: calendar year, financial year and custom ranges select whole bill-cycle months", () => {
  const docs = gstLedgerFixture();
  const cy = ledGst(docs, { startDate: "2026-01-01", endDate: "2026-12-31" });
  const fyR = ledGst(docs, { fy: 2026 }); // Apr 2026 – Mar 2027: drops the January onboarding row
  assert.equal(cy.buckets[0].key, "2026-01");
  assert.equal(fyR.buckets[0].key, "2026-04");
  assert.equal(cy.summary.due - fyR.summary.due, 300);
  const prevFy = ledGst(docs, { fy: 2025 }); // Apr 2025 – Mar 2026: only the January onboarding row
  assert.equal(prevFy.summary.due, 300);
  const aug = ledGst(docs, { startDate: "2026-08-15", endDate: "2026-09-05" }); // cycles fall on the 10th
  assert.equal(aug.filters.granularity, "month");
  assert.deepEqual(aug.buckets.map((b) => b.key), ["2026-08", "2026-09"]);
  // A + B held 1,800 each; C has owner GST 500, held in months without a direct-GST bill (the ledger's rule)
  assert.equal(aug.summary.due, 2 * (1800 + 1800 + 500));
  const city = ledGst(docs, { fy: 2026, city: "Madurai" });
  assert.equal(city.summary.due, 0); // every fixture site is in Chennai
});

test("GST Ledger: sites without GST give an empty (all-zero) result, not an error", () => {
  const r = ledGst(deepFreeze([dsite("N1", 10000), dsite("N2", 5000)]), { fy: 2026 });
  assert.equal(r.summary.due, 0);
  assert.equal(r.buckets.length, 12);
  assert.ok(r.buckets.every((b) => b.paid.amount === 0 && b.remaining.amount === 0));
});

// ── TDS ───────────────────────────────────────────────────────────────────
test("TDS: tdsBalanceHistory only; tdsAmount not added to paidAmount; duplicates collapse; owner standing amounts ignored", () => {
  const row = (o) => ({ landOwnerId: "o1", dueMonth: "June 2026", tdsAmount: 100, paidAmount: 100, isUtrEntry: true, paidAt: new Date(Date.UTC(2026, 5, 20)), ...o });
  const docs = deepFreeze([site("1", [["H", "C", "Alpha"]], {
    tdsBalanceHistory: [
      row({}),
      row({ tdsAmount: 120, paidAmount: 120, paidAt: new Date(Date.UTC(2026, 5, 22)) }),
      row({ landOwnerId: "o2", tdsAmount: 50 }),
      row({ dueMonth: "May 2026", tdsAmount: 0 }),
      row({ dueMonth: "Apr 2026", paidAt: null, date: null, cycle: null }),
    ],
    landOwners: [{ tdsAmount: 99999 }],
  })]);
  const r = RA.computeTds(docs, fy());
  assert.equal(r.summary.total, 170);
  assert.equal(bucket(r, "2026-06").amount, 170);
  assert.equal(bucket(r, "2026-06").sites, 1);
  assert.deepEqual(bucket(r, "2026-06").topSites, [{ name: "Alpha", amount: 170 }]);
  assert.equal(r.meta.duplicatesIgnored, 1);
  assert.equal(r.meta.recordsWithoutDate, 1);
});

const tdsRow = (o) => ({
  landOwnerId: "o1", landOwnerName: "Ravi", dueMonth: "June 2026", tdsAmount: 100, paidAmount: 100,
  isUtrEntry: true, utrNumber: "UTR1", paidAt: new Date(Date.UTC(2026, 5, 20, 10)), ...o,
});
const tdsSum = (r) => r.buckets.reduce((s, b) => s + b.amount, 0);

test("TDS: monthly aggregation in chronological order; buckets, breakdowns and summary agree", () => {
  const docs = deepFreeze([
    site("1", [["Hoarding", "Chennai", "Alpha"]], { tdsBalanceHistory: [
      tdsRow({ dueMonth: "May 2026", paidAt: new Date(Date.UTC(2026, 4, 5)) }),
      tdsRow({ dueMonth: "June 2026", tdsAmount: 150, paidAmount: 150 }),
      tdsRow({ landOwnerId: "o2", landOwnerName: "Mala", dueMonth: "June 2026", tdsAmount: 40, paidAmount: 40, paidAt: new Date(Date.UTC(2026, 5, 3)) }),
    ] }),
    site("2", [["Unipole", "Madurai", "Beta"]], { tdsBalanceHistory: [tdsRow({ dueMonth: "January 2027", tdsAmount: 75, paidAt: new Date(Date.UTC(2027, 0, 15)) })] }),
  ]);
  const r = RA.computeTds(docs, fy());
  assert.deepEqual(r.buckets.map((b) => b.key), ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  assert.equal(r.filters.granularity, "month");
  assert.equal(r.summary.total, 365);
  assert.equal(tdsSum(r), r.summary.total);
  assert.equal(r.summary.entries, 4);
  assert.equal(r.summary.sites, 2);
  assert.equal(r.summary.owners, 3);
  assert.equal(r.summary.peakKey, "2026-06");
  const jun = bucket(r, "2026-06");
  assert.equal(jun.amount, 190);
  assert.equal(jun.entries, 2);
  assert.equal(jun.owners, 2);
  // breakdown: one line per deduction, sorted by date, with site/owner details; amounts add up to the bar
  assert.deepEqual(jun.deductions.map((d) => [d.date, d.amount, d.ownerName]), [["2026-06-03", 40, "Mala"], ["2026-06-20", 150, "Ravi"]]);
  assert.equal(jun.deductions.reduce((s, d) => s + d.amount, 0), jun.amount);
  assert.deepEqual(
    { siteId: jun.deductions[0].siteId, siteName: jun.deductions[0].siteName, mediaType: jun.deductions[0].mediaType, city: jun.deductions[0].city, billMonth: jun.deductions[0].billMonth, utrNumber: jun.deductions[0].utrNumber },
    { siteId: "1", siteName: "Alpha", mediaType: "Hoarding", city: "Chennai", billMonth: "June 2026", utrNumber: "UTR1" },
  );
  for (const b of r.buckets) assert.equal(b.deductions.length, b.entries, b.key);
  assert.deepEqual(bucket(r, "2026-07").deductions, []);
});

test("TDS: short custom ranges still plot months; breakdown never includes rows outside the range", () => {
  const docs = deepFreeze([site("1", [["H", "C", "Alpha"]], { tdsBalanceHistory: [
    tdsRow({ dueMonth: "May 2026", tdsAmount: 10, paidAt: new Date(Date.UTC(2026, 5, 9)) }),  // 9 Jun — before range
    tdsRow({ dueMonth: "June 2026", tdsAmount: 20, paidAt: new Date(Date.UTC(2026, 5, 15)) }), // in range
    tdsRow({ dueMonth: "July 2026", tdsAmount: 30, paidAt: new Date(Date.UTC(2026, 6, 10)) }), // in range
    tdsRow({ dueMonth: "August 2026", tdsAmount: 40, paidAt: new Date(Date.UTC(2026, 6, 11)) }), // 11 Jul — after range
  ] })]);
  const f = RA.parseFilters({ startDate: "2026-06-10", endDate: "2026-07-10" }, NOW).filters;
  assert.equal(f.granularity, "day"); // shared filter would be daily for other charts…
  const r = RA.computeTds(docs, f);
  assert.equal(r.filters.granularity, "month"); // …TDS is always monthly
  assert.equal(r.filters.startDate, "2026-06-10");
  assert.equal(r.filters.endDate, "2026-07-10");
  assert.deepEqual(r.buckets.map((b) => [b.key, b.amount]), [["2026-06", 20], ["2026-07", 30]]);
  assert.deepEqual(r.buckets.flatMap((b) => b.deductions.map((d) => d.date)), ["2026-06-15", "2026-07-10"]);
  assert.equal(r.summary.total, 50);
  // the input filters object is not mutated
  assert.equal(f.granularity, "day");
});

test("TDS: financial year, media type and city filters change chart, totals and breakdown together", () => {
  const docs = deepFreeze([
    site("1", [["Hoarding", "Chennai", "Alpha"]], { tdsBalanceHistory: [tdsRow({ tdsAmount: 100 }), tdsRow({ dueMonth: "May 2025", tdsAmount: 9, paidAt: new Date(Date.UTC(2025, 4, 2)) })] }),
    site("2", [["Unipole", "Chennai", "Beta"]], { tdsBalanceHistory: [tdsRow({ tdsAmount: 50 })] }),
    site("3", [["Hoarding", "Madurai", "Gamma"]], { tdsBalanceHistory: [tdsRow({ tdsAmount: 25 })] }),
    site("4", [["Hoarding", "Chennai", "Mixed"], ["Unipole", "Chennai", "Mixed 2"]], { tdsBalanceHistory: [tdsRow({ tdsAmount: 7 })] }),
  ]);
  const check = (r, total, siteNames) => {
    assert.equal(r.summary.total, total);
    assert.equal(tdsSum(r), total);
    const lines = r.buckets.flatMap((b) => b.deductions);
    assert.equal(lines.reduce((s, d) => s + d.amount, 0), total);
    assert.deepEqual(lines.map((d) => d.siteName).sort(), siteNames);
  };
  check(RA.computeTds(docs, fy()), 182, ["Alpha", "Beta", "Gamma", "Mixed, Mixed 2"]);
  check(RA.computeTds(docs, fy({ fy: 2025 })), 9, ["Alpha"]);
  check(RA.computeTds(docs, fy({ mediaType: "Hoarding" })), 125, ["Alpha", "Gamma"]);
  check(RA.computeTds(docs, fy({ city: "Chennai" })), 157, ["Alpha", "Beta", "Mixed, Mixed 2"]);
  const both = RA.computeTds(docs, fy({ mediaType: "Hoarding", city: "Chennai" }));
  check(both, 100, ["Alpha"]);
  assert.deepEqual(both.meta.excludedMixedSites, { sites: 1, amount: 7 });
  assert.equal(RA.computeTds(docs, fy()).buckets.flatMap((b) => b.deductions).find((d) => d.siteId === "4").mediaType, "Mixed types");
});

test("TDS: de-duplication — re-saved rows, month-label variants, pending rows and paidAmount never double count", () => {
  const docs = deepFreeze([site("1", [["H", "C", "Alpha"]], { tdsBalanceHistory: [
    tdsRow({ tdsAmount: 100, paidAmount: 100, paidAt: new Date(Date.UTC(2026, 5, 20)) }),
    tdsRow({ dueMonth: "Jun 2026", tdsAmount: 110, paidAmount: 110, paidAt: new Date(Date.UTC(2026, 5, 25)) }), // same bill, latest wins
    tdsRow({ landOwnerId: "o1", dueMonth: "July 2026", tdsAmount: 100, paidAt: new Date(Date.UTC(2026, 6, 20)) }), // same owner, next bill: separate deduction
    tdsRow({ dueMonth: "August 2026", isUtrEntry: false, tdsAmount: 500, paidAt: null }), // pending, not deducted
    tdsRow({ dueMonth: "September 2026", isUtrEntry: undefined, tdsAmount: 500 }), // legacy, ledger treats as unpaid
  ] })]);
  const r = RA.computeTds(docs, fy());
  assert.equal(r.summary.total, 210);
  assert.equal(r.summary.entries, 2);
  assert.equal(bucket(r, "2026-06").amount, 110);
  assert.equal(bucket(r, "2026-06").deductions.length, 1);
  assert.equal(bucket(r, "2026-06").deductions[0].date, "2026-06-25");
  assert.equal(bucket(r, "2026-07").amount, 100);
  assert.equal(bucket(r, "2026-08").amount, 0);
  assert.equal(r.meta.duplicatesIgnored, 1);
  assert.equal(r.meta.pendingIgnored, 2);
});

test("TDS: rows are dated by paidAt, then date, then cycle", () => {
  const docs = deepFreeze([site("1", [["H", "C", "Alpha"]], { tdsBalanceHistory: [
    tdsRow({ dueMonth: "May 2026", paidAt: new Date(Date.UTC(2026, 7, 1)), date: new Date(Date.UTC(2026, 4, 1)), cycle: new Date(Date.UTC(2026, 4, 1)) }),
    tdsRow({ dueMonth: "June 2026", paidAt: null, date: "2026-09-02T00:00:00.000Z", cycle: new Date(Date.UTC(2026, 5, 1)) }),
    tdsRow({ dueMonth: "July 2026", paidAt: null, date: null, cycle: new Date(Date.UTC(2026, 9, 1)) }),
  ] })]);
  const r = RA.computeTds(docs, fy());
  assert.deepEqual(r.buckets.filter((b) => b.amount).map((b) => [b.key, b.deductions[0].date]), [["2026-08", "2026-08-01"], ["2026-09", "2026-09-02"], ["2026-10", "2026-10-01"]]);
});

// ── Calendar year (sent by the frontend as an inclusive custom range) ──────
test("calendar year: 1 Jan–31 Dec, inclusive to the last millisecond, monthly, separate from the FY", () => {
  const cy = RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31" }, NOW).filters;
  assert.equal(cy.start.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(cy.end.toISOString(), "2026-12-31T23:59:59.999Z");
  assert.equal(cy.granularity, "month");
  assert.equal(cy.fy, null);
  const fyF = fy();
  assert.equal(fyF.start.toISOString(), "2026-04-01T00:00:00.000Z");
  const docs = deepFreeze([site("1", [["H", "C", "Alpha"]], { tdsBalanceHistory: [
    tdsRow({ dueMonth: "December 2025", tdsAmount: 1, paidAt: new Date(Date.UTC(2025, 11, 31, 23, 59)) }),
    tdsRow({ dueMonth: "January 2026", tdsAmount: 10, paidAt: new Date(Date.UTC(2026, 0, 1)) }),
    tdsRow({ dueMonth: "March 2026", tdsAmount: 20, paidAt: new Date(Date.UTC(2026, 2, 31, 12)) }),
    tdsRow({ dueMonth: "December 2026", tdsAmount: 30, paidAt: new Date(Date.UTC(2026, 11, 31, 23, 59)) }),
    tdsRow({ dueMonth: "January 2027", tdsAmount: 40, paidAt: new Date(Date.UTC(2027, 0, 1)) }),
  ] })]);
  const r = RA.computeTds(docs, cy);
  assert.deepEqual(r.buckets.map((b) => b.key), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
  assert.equal(r.summary.total, 60);
  assert.deepEqual(r.buckets.flatMap((b) => b.deductions.map((d) => d.date)), ["2026-01-01", "2026-03-31", "2026-12-31"]);
  // the same rows under FY 2026-27 (Apr 2026–Mar 2027): Dec 2026 and Jan 2027 only
  assert.equal(RA.computeTds(docs, fyF).summary.total, 70);
});

// ── Data-source labels ────────────────────────────────────────────────────
// The chart labels in the frontend (AnalyticsSources) name these stored fields.
// If a projection gains or loses a top-level source, this fails so the label is
// re-checked instead of silently going stale.
test("data sources: each chart + source reads exactly the top-level fields its label names", () => {
  const roots = (sel) => [...new Set(sel.split(/\s+/).filter(Boolean).map((p) => p.split(".")[0]))].sort();
  const expected = {
    payments: {
      ledger: ["ledgerHistory", "mediaDetails"],
      rentalMaster: ["appraisal", "gstApplicableFlag", "gstBalanceHistory", "landOwners", "ledger", "ledgerHistory", "mediaDetails", "rentalDue", "rentalPayment"],
    },
    media: { both: ["createdAt", "mediaDetails"] },
    appraisal: { rentalMaster: ["appraisal", "landOwners", "mediaDetails"] },
    // Outstanding payments: the Rental Master cycle calculation's fields (as Payments)
    bills: { rentalMaster: ["appraisal", "gstApplicableFlag", "gstBalanceHistory", "landOwners", "ledger", "ledgerHistory", "mediaDetails", "rentalDue", "rentalPayment"] },
    gst: {
      ledger: ["appraisal", "gstApplicableFlag", "gstBalanceHistory", "landOwners", "ledger", "ledgerHistory", "mediaDetails", "rentalDue", "rentalPayment"],
      rentalMaster: ["landOwners", "mediaDetails", "rentalDue", "rentalPayment"],
    },
    tds: { ledger: ["mediaDetails", "tdsBalanceHistory"], rentalMaster: ["appraisal", "landOwners", "mediaDetails", "rentalDue", "rentalPayment"] },
  };
  for (const [chart, bySource] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(C.SELECT[chart]).sort(), Object.keys(bySource).sort(), chart);
    for (const [src, v] of Object.entries(bySource)) assert.deepEqual(roots(C.SELECT[chart][src]), v, `${chart}/${src}`);
  }
  assert.ok(C.SELECT.gst.rentalMaster.includes("rentalPayment.gstOutstandingHistory"));
  assert.ok(!/rentalPayment\.(?!gstOutstandingHistory)/.test(C.SELECT.gst.rentalMaster), "GST reads only onboarding GST dues from rentalPayment");
  assert.ok(!/tdsBalanceHistory/.test(C.SELECT.tds.rentalMaster), "Rental Master TDS never reads recorded deductions");
  assert.ok(!/landOwners/.test(C.SELECT.tds.ledger), "Ledger TDS never reads configured landowner TDS");
  assert.ok(/landOwners\.tdsApplicable/.test(C.SELECT.tds.rentalMaster) && /landOwners\.tdsHold/.test(C.SELECT.tds.rentalMaster));
  // which combinations exist at all
  assert.equal(C.resolve("appraisal", "ledger"), null);
  assert.equal(C.resolve("bills", "ledger"), null);
  assert.equal(C.resolve("media", "ledger").sourceIndependent, true);
  assert.equal(C.resolve("media", "rentalMaster").select, C.resolve("media", "ledger").select);
  assert.ok(!/gstBalanceHistory/.test(C.SELECT.gst.rentalMaster), "Rental Master GST never reads the GST balance ledger");
  for (const chart of ["payments", "gst", "tds"]) assert.notEqual(C.resolve(chart, "ledger").select, C.resolve(chart, "rentalMaster").select, chart);
});

test("detail dialogs: the Rental Master payments and outstanding reads add only the landlord name (media codes come from mediaDetails)", () => {
  for (const sel of [C.SELECT.payments.rentalMaster, C.SELECT.bills.rentalMaster, C.SELECT.gst.rentalMaster, C.SELECT.gst.ledger, C.SELECT.appraisal.rentalMaster]) {
    assert.match(sel, /mediaDetails\.mediaCode/, "the media code of each face");
    assert.match(sel, /landOwners\.name/);
    assert.doesNotMatch(sel, /siteCode|landlordCode/);
    assert.doesNotMatch(sel, /panNumber|aadhar|bankName|ifsc|accountNumber|upiId|landOwners\.phone/);
  }
  assert.ok(!/landOwners/.test(C.SELECT.tds.ledger + C.SELECT.media.both), "the media and ledger-TDS charts read no landlord field");
});

test("data sources: each aggregation ignores records that are not its source", () => {
  const d = new Date(Date.UTC(2026, 5, 10));
  const everything = deepFreeze([site("1", [["H", "C", "Alpha"]], {
    createdAt: d,
    ledger: [{ paymentMode: "Cash", amount: 500, date: d, status: 1 }],
    withGst1Ledger: [{ paymentMode: "Online", amount: 500, date: d }],
    landOwners: [{ tdsAmount: 900, gstAmount: 900, shareAmount: 900 }],
    rentalDue: [{ _id: "b1", dueDate: d, baseAmount: 1000, gstAmount: 180, netPayable: 820, approvalStatus: 1 }],
    tdsBalanceHistory: [tdsRow({ tdsAmount: 50 })],
  })]);
  const f = fy();
  assert.equal(RA.computePayments(everything, f).summary.total, 0, "live ledger rows are not payments history");
  assert.equal(RA.computeTds(everything, f).summary.total, 50, "only tdsBalanceHistory, not landOwners.tdsAmount");
  assert.equal(RA.computeBills(everything, f).summary.total, 1000);
  assert.equal(RA.computeMedia(everything, f).summary.total, 1);
  assert.equal(RA.computeAppraisal(everything, f).summary.given.amount, 0);
});

// ── Data-source filter ────────────────────────────────────────────────────
test("source filter: rentalMaster (default) or ledger, echoed back; anything else is rejected", () => {
  assert.equal(RA.parseFilters({}, NOW).filters.source, "rentalMaster");
  assert.equal(RA.parseFilters({ source: "ledger" }, NOW).filters.source, "ledger");
  assert.equal(RA.parseFilters({ source: "rentalMaster", startDate: "2026-01-01", endDate: "2026-12-31" }, NOW).filters.source, "rentalMaster");
  for (const bad of ["Ledger", "rental", "both", 1]) assert.match(RA.parseFilters({ source: bad }, NOW).error, /source must be/);
  assert.equal(RA.computeTds([], fy({ source: "ledger" })).filters.source, "ledger");
  assert.equal(RA.computeMedia([], fy({ source: "ledger" })).filters.source, "ledger");
});

test("unsupported source combinations answer 'not supported' with a reason, without touching the database", async () => {
  for (const name of ["getAppraisalAnalytics", "getBillAnalytics"]) {
    const res = fakeRes();
    await C[name]({ user: { userType: 1 }, body: { source: "ledger" } }, res);
    assert.equal(res.statusCode, 200, name);
    assert.equal(res.body.data.supported, false, name);
    assert.equal(res.body.data.filters.source, "ledger");
    assert.match(res.body.data.reason, /Rental Master/);
    assert.deepEqual(res.body.data.buckets, []);
  }
  const bad = fakeRes();
  await C.getTdsAnalytics({ user: { userType: 2 }, body: { source: "everything" } }, bad);
  assert.equal(bad.statusCode, 400);
});

test("Rental Master payments: monthly Rental Master cycle figures only; buckets add up to the cards", () => {
  const docs = octFixture();
  const f = RA.parseFilters({ ...OCT, source: "rentalMaster" }, NOW).filters;
  const r = RA.computeRentalMasterPayments(docs, f, LIB, NOW);
  assert.equal(r.filters.source, "rentalMaster");
  assert.equal(r.filters.granularity, "month"); // a 31-day range is still one month bar
  assert.deepEqual(r.buckets.map((b) => b.key), ["2026-10"]);
  assert.deepEqual(
    { toBePaid: r.summary.toBePaid, unpaid: r.summary.unpaid, paid: r.summary.paid },
    { toBePaid: 6084025, unpaid: 5830025, paid: 254000 }, // Rental Master "Total Due This Month" and pending
  );
  assert.deepEqual(
    { toBePaid: r.buckets[0].toBePaid, unpaid: r.buckets[0].unpaid, paid: r.buckets[0].paid },
    { toBePaid: 6084025, unpaid: 5830025, paid: 254000 },
  );
  assert.equal(r.summary.total, undefined, "no ledgerHistory payment total in the Rental Master view");

  // FY: months after today are never projected; buckets always sum to the cards
  const year = RA.computeRentalMasterPayments(docs, fy({ source: "rentalMaster" }), LIB, NOW);
  assert.equal(year.buckets.length, 12);
  for (const k of ["2026-11", "2026-12", "2027-01"]) assert.equal(bucket(year, k).toBePaid, 0, k);
  const sum = (field) => year.buckets.reduce((x, b) => x + b[field], 0);
  assert.equal(Math.round(sum("toBePaid")), year.summary.toBePaid);
  assert.equal(Math.round(sum("unpaid")), year.summary.unpaid);

  // Ledger view of the same sites: payment amounts by payment date, no due/unpaid cards
  const led = RA.computePayments(docs, RA.parseFilters({ ...OCT, source: "ledger" }, NOW).filters);
  assert.equal(led.filters.source, "ledger");
  assert.equal(led.summary.total, 254000);
  assert.equal(led.summary.toBePaid, undefined);
});

// Rental Master TDS fixture: current rent 12,000 after an August 2026 appraisal (previous rent 10,000)
const rmTdsSite = (id, extra = {}) => site(id, [["Hoarding", "Chennai", `Site ${id}`]], {
  rentalPayment: { totalRentalAmount: 12000 },
  appraisal: { history: [{ appraisalDate: new Date(Date.UTC(2026, 7, 1)), appraisalAmount: 2000, previousRent: 10000 }] },
  landOwners: [
    { _id: `${id}-a`, name: "Applicable", tdsApplicable: 1, tdsAmount: 600 },
    { _id: `${id}-b`, name: "Not applicable", tdsApplicable: 0, tdsAmount: 999 },
    { _id: `${id}-c`, name: "Held", tdsApplicable: 1, tdsHold: 1, tdsAmount: 300 },
    { _id: `${id}-d`, name: "No amount", tdsApplicable: 1, tdsAmount: 0 },
  ],
  rentalDue: [
    { _id: `${id}-may`, dueMonth: "May 2026", dueDate: new Date(Date.UTC(2026, 4, 5)), approvalStatus: 3 },
    { _id: `${id}-jun1`, dueMonth: "June 2026", dueDate: new Date(Date.UTC(2026, 5, 5)), approvalStatus: 1, updatedAt: new Date(Date.UTC(2026, 5, 9)) },
    { _id: `${id}-jun2`, dueMonth: "June 2026", dueDate: new Date(Date.UTC(2026, 5, 7)), approvalStatus: 3, updatedAt: new Date(Date.UTC(2026, 5, 6)) },
    { _id: `${id}-sep`, dueMonth: "September 2026", dueDate: new Date(Date.UTC(2026, 8, 5)), approvalStatus: 1 },
  ],
  // recorded ledger deductions with different amounts — must never appear in the Rental Master view
  tdsBalanceHistory: [tdsRow({ landOwnerId: `${id}-a`, dueMonth: "May 2026", tdsAmount: 77, paidAt: new Date(Date.UTC(2026, 4, 20)) })],
  ...extra,
});
const OWNERS = { landOwnersAsOfDate };

test("TDS Rental Master: only TDS-applicable, non-held owners with a configured amount, once per generated bill month", () => {
  const docs = deepFreeze([rmTdsSite("1")]);
  const r = RA.computeTdsRentalMaster(docs, fy({ source: "rentalMaster" }), OWNERS);
  assert.equal(r.filters.source, "rentalMaster");
  const lines = r.buckets.flatMap((b) => b.deductions);
  assert.ok(lines.every((d) => d.ownerName === "Applicable"), "only the applicable owner");
  // before the August appraisal the configured 600 is scaled to the rent then in force (10,000 / 12,000)
  assert.deepEqual(lines.map((d) => [d.date, d.amount, d.billMonth, d.billStatus]), [
    ["2026-05-05", 500, "May 2026", "Approved"],
    ["2026-06-07", 500, "June 2026", "Approved"], // the approved June row; the other June row is not counted again
    ["2026-09-05", 600, "September 2026", "Pending"],
  ]);
  assert.equal(r.summary.total, 1600);
  assert.equal(r.summary.entries, 3);
  assert.equal(r.summary.owners, 1);
  assert.equal(r.meta.duplicateBillsIgnored, 1);
  assert.equal(r.meta.heldOwnersSkipped, 3);
  assert.equal(r.meta.applicableWithoutAmount, 3);
  for (const b of r.buckets) assert.equal(b.deductions.reduce((x, d) => x + d.amount, 0), b.amount, b.key);
  // months without a generated bill stay empty — nothing is projected
  for (const k of ["2026-04", "2026-07", "2026-08", "2026-10", "2027-03"]) assert.equal(bucket(r, k).amount, 0, k);
  assert.equal(lines.some((d) => d.amount === 77), false, "recorded ledger deductions are not mixed in");

  // the Ledger view of the same site uses the recorded deduction only
  const led = RA.computeTds(docs, fy({ source: "ledger" }));
  assert.equal(led.summary.total, 77);
  assert.equal(led.buckets.flatMap((b) => b.deductions).length, 1);
});

test("TDS Rental Master: a site where no landlord is TDS-applicable contributes nothing", () => {
  const none = rmTdsSite("2", { landOwners: [{ _id: "x", name: "Owner", tdsApplicable: 0, tdsAmount: 450 }] });
  const r = RA.computeTdsRentalMaster(deepFreeze([none]), fy(), OWNERS);
  assert.equal(r.summary.total, 0);
  assert.equal(r.summary.entries, 0);
});

test("TDS Rental Master: date filters (calendar year, custom range) and media type / city filters", () => {
  const docs = deepFreeze([rmTdsSite("1"), rmTdsSite("3", { mediaDetails: [{ mediaType: "Unipole", city: "Madurai", mediaName: "Site 3" }] })]);
  const cy = RA.computeTdsRentalMaster(docs, RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31" }, NOW).filters, OWNERS);
  assert.equal(cy.buckets[0].key, "2026-01");
  assert.equal(cy.summary.total, 3200);
  const june = RA.computeTdsRentalMaster(docs, RA.parseFilters({ startDate: "2026-06-06", endDate: "2026-06-30" }, NOW).filters, OWNERS);
  assert.deepEqual(june.buckets.map((b) => [b.key, b.amount]), [["2026-06", 1000]]); // approved June bills, due 7 Jun
  const early = RA.computeTdsRentalMaster(docs, RA.parseFilters({ startDate: "2026-06-01", endDate: "2026-06-06" }, NOW).filters, OWNERS);
  assert.equal(early.summary.total, 0, "the counted June bill is due 7 Jun, outside 1–6 Jun");
  const uni = RA.computeTdsRentalMaster(docs, fy({ mediaType: "Unipole" }), OWNERS);
  assert.equal(uni.summary.total, 1600);
  assert.deepEqual([...new Set(uni.buckets.flatMap((b) => b.deductions.map((d) => d.siteName)))], ["Site 3"]);
  const madurai = RA.computeTdsRentalMaster(docs, fy({ city: "Chennai" }), OWNERS);
  assert.deepEqual([...new Set(madurai.buckets.flatMap((b) => b.deductions.map((d) => d.siteName)))], ["Site 1"]);
});

// ── Generated bills: stale rows of deleted / replaced faces ──────────────
// Rule: a row is stale when its mediaDetailId names no face of the site. Rows without a
// mediaDetailId are site-level bills and always count. Rental Master ignores stale rows too.
const staleSite = () => ({
  _id: "ST",
  mediaDetails: [billFace("cur1", "Hoarding"), billFace("cur2", "Unipole")],
  rentalDue: [
    // current faces, one per status
    faceBill("cur1", 1000, { approvalStatus: 1 }),
    faceBill("cur2", 2000, { approvalStatus: 3 }),
    faceBill("cur1", 500, { approvalStatus: 2, dueDate: new Date(Date.UTC(2026, 9, 15)) }),
    faceBill("cur2", 700, { approvalStatus: 4, dueDate: new Date(Date.UTC(2026, 9, 15)) }),
    // left behind when the faces were re-created: same month, same amounts, old face ids
    faceBill("old1", 1000, { approvalStatus: 1 }),
    faceBill("old2", 2000, { approvalStatus: 1 }),
    faceBill("old1", 500, { approvalStatus: 1, dueDate: new Date(Date.UTC(2026, 9, 15)) }),
  ],
});

test("stale bills: rows of deleted / replaced faces are excluded from every output; current-face rows of every status count", () => {
  const docs = deepFreeze([staleSite()]);
  const r = RA.computeBills(docs, fy());
  assert.equal(r.summary.bills, 4);
  assert.equal(r.summary.total, 4200);
  assert.equal(r.summary.sites, 1);
  assert.deepEqual(r.summary.byStatus, {
    Pending: { bills: 1, amount: 1000 },
    Approved: { bills: 1, amount: 2000 },
    "Partially approved": { bills: 1, amount: 500 },
    Overdue: { bills: 1, amount: 700 },
  });
  assert.deepEqual(typeTotals(r), { Hoarding: { bills: 2, amount: 1500 }, Unipole: { bills: 2, amount: 2700 } });
  assert.deepEqual(r.meta.staleRowsExcluded, { bills: 3, amount: 3500, sites: 1 });
  // monthly buckets carry the same rows: Sep = 1000 + 2000, Oct = 500 + 700
  assert.deepEqual([bucket(r, "2026-09").bills, bucket(r, "2026-09").total], [2, 3000]);
  assert.deepEqual([bucket(r, "2026-10").bills, bucket(r, "2026-10").total], [2, 1200]);
  // every summary reconciles with the buckets
  assert.equal(r.buckets.reduce((x, b) => x + b.bills, 0), r.summary.bills);
  assert.equal(r.buckets.reduce((x, b) => x + b.total, 0), r.summary.total);
  for (const b of r.buckets) {
    assert.equal(Object.values(b.byStatus).reduce((x, v) => x + v.bills, 0), b.bills, b.key);
    assert.equal(Object.values(b.byType).reduce((x, v) => x + v.amount, 0), b.total, b.key);
  }
  assert.equal(RA.isStaleBill(docs[0], { mediaDetailId: "old1" }), true);
  assert.equal(RA.isStaleBill(docs[0], { mediaDetailId: "cur1" }), false);
  assert.equal(RA.isStaleBill(docs[0], { mediaDetailId: null }), false);
});

test("stale bills: site-level rows count; a site with no faces keeps its site-level rows; inactive faces are not stale", () => {
  const docs = deepFreeze([
    { _id: "SL", mediaDetails: [billFace("s1", "Hoarding"), billFace("s2", "Hoarding")], rentalDue: [faceBill(null, 900), faceBill(undefined, 100)] },
    { _id: "NF", mediaDetails: [], rentalDue: [faceBill(null, 50), faceBill("ghost", 999)] },
    { _id: "IN", mediaDetails: [billFace("i1", "Unipole", { status: 2 })], rentalDue: [faceBill("i1", 40)] },
  ]);
  const r = RA.computeBills(docs, fy());
  assert.equal(r.summary.total, 900 + 100 + 50 + 40);
  assert.equal(r.summary.bills, 4);
  assert.equal(r.summary.sites, 3);
  assert.deepEqual(r.meta.staleRowsExcluded, { bills: 1, amount: 999, sites: 1 });
  assert.deepEqual(typeTotals(r), { Hoarding: { bills: 2, amount: 1000 }, Unspecified: { bills: 1, amount: 50 }, Unipole: { bills: 1, amount: 40 } });
});

test("stale bills: date range, city, media type, site status and source keep their behaviour and never count stale rows", () => {
  const madurai = { _id: "MD", mediaDetails: [billFace("m1", "Hoarding", { city: "Madurai" })], rentalDue: [faceBill("m1", 300), faceBill("mOld", 300)] };
  const docs = deepFreeze([staleSite(), madurai]);
  const bills = (body) => RA.computeBills(RA.applySiteStatus(docs, fy(body)), fy(body));
  // date range: only October -> the Oct current rows; the Oct stale row is reported for that range
  const oct = RA.parseFilters({ startDate: "2026-10-01", endDate: "2026-10-31", siteStatus: "all" }, NOW).filters;
  const ro = RA.computeBills(docs, oct);
  assert.deepEqual([ro.summary.bills, ro.summary.total], [2, 1200]);
  assert.deepEqual(ro.meta.staleRowsExcluded, { bills: 1, amount: 500, sites: 1 });
  // city (site-level) and media type (per bill)
  assert.equal(bills({ city: "Madurai" }).summary.total, 300);
  assert.equal(bills({ city: "Chennai" }).summary.total, 4200);
  assert.equal(bills({ mediaType: "Hoarding" }).summary.total, 1500 + 300);
  assert.equal(bills({ mediaType: "Unipole" }).summary.total, 2700);
  // site status: both sites are active; "inactive" leaves nothing, "all" = "active"
  assert.equal(bills({ siteStatus: "active" }).summary.total, 4500);
  assert.equal(bills({ siteStatus: "inactive" }).summary.total, 0);
  assert.equal(bills({ siteStatus: "all" }).summary.total, 4500);
  // source: bills exist only under Rental Master (Ledger is "not supported", unchanged)
  assert.equal(C.resolve("bills", "ledger"), null);
  assert.equal(bills({ source: "rentalMaster" }).summary.total, 4500);
});

// Apply a MongoDB inclusion projection ("a.b c") to a plain document the way the server does:
// only listed paths survive; inside arrays of sub-documents only the listed sub-fields survive —
// a nested _id is NOT kept unless listed (only the top-level _id is).
const projectLikeMongo = (doc, select) => {
  const paths = select.split(/\s+/).filter(Boolean).map((p) => p.split("."));
  const pick = (value, rest) => {
    if (Array.isArray(value)) return value.map((v) => pick(v, rest));
    if (!rest.length || value === null || typeof value !== "object" || value instanceof Date) return value;
    return value;
  };
  const build = (src, groups) => {
    if (Array.isArray(src)) return src.map((v) => build(v, groups));
    if (src === null || typeof src !== "object" || src instanceof Date) return src;
    const out = {};
    for (const [key, subs] of groups) {
      if (!(key in src)) continue;
      out[key] = subs.some((s) => s.length === 0) ? pick(src[key], []) : build(src[key], group(subs));
    }
    return out;
  };
  const group = (ps) => {
    const m = new Map();
    for (const [head, ...rest] of ps) m.set(head, [...(m.get(head) || []), rest]);
    return m;
  };
  return { _id: doc._id, ...build(doc, group(paths)) };
};

test("live projection: the outstanding-payments query loads every field the cycle calculation and stale detection need (regression)", () => {
  const docs = [
    { ...dsite("LP1", 10000, { start: D(2026, 7), ledgerHistory: paidHist("LP1", "October") }), rentalDue: [faceBill("LP1-f", 10000, { dueDate: D(2026, 9) }), faceBill("gone", 10000, { dueDate: D(2026, 9) })] },
    withGstRp(dsite("LP2", 20000, { start: D(2026, 7) }), 3600),
  ];
  const projected = deepFreeze(docs.map((d) => projectLikeMongo(d, C.SELECT.bills.rentalMaster)));
  assert.ok(projected[0].mediaDetails.every((fc) => fc._id), "mediaDetails._id must be projected");
  assert.ok(projected[0].rentalDue.every((b) => b.mediaDetailId), "rentalDue.mediaDetailId must be projected");
  const f = fy();
  const full = RA.computeOutstanding(deepFreeze(docs), f, LIB, NOW);
  const live = RA.computeOutstanding(projected, f, LIB, NOW);
  assert.deepEqual(live.summary, full.summary);
  assert.deepEqual(live.buckets, full.buckets);
  assert.equal(live.meta.staleRowsIgnored, 1);
  assert.ok(live.summary.total.amount > 0);
});

// ── Stored bills by timing (computeBills: upcoming / due today / overdue / past approved) ──
// NOW = 21 Oct 2026 (an IST-wall-clock Date, like nowIST()); "today" is that calendar day.
const dueOn = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const upcomingDocs = () => deepFreeze([
  {
    _id: "U",
    mediaDetails: [billFace("u1", "Hoarding")],
    rentalDue: [
      faceBill("u1", 100, { dueDate: dueOn(2026, 10, 20), approvalStatus: 1 }), // yesterday, not approved -> overdue
      faceBill("u1", 110, { dueDate: dueOn(2026, 10, 20), approvalStatus: 3 }), // yesterday, approved -> past, not overdue
      faceBill("u1", 120, { dueDate: dueOn(2026, 10, 21), approvalStatus: 1 }), // today -> neither
      faceBill("u1", 1180, { dueDate: dueOn(2026, 10, 22), approvalStatus: 1, gstAmount: 180 }), // tomorrow -> upcoming
      faceBill("u1", 500, { dueDate: dueOn(2026, 11, 30), approvalStatus: 2 }), // upcoming, partially approved
      faceBill("u1", 700, { dueDate: dueOn(2026, 12, 31), approvalStatus: 3, gstAmount: 100 }), // upcoming, last day of the year
      faceBill("u1", 900, { dueDate: dueOn(2027, 1, 1), approvalStatus: 1 }), // after the calendar year
      faceBill("u1", 50, { dueDate: dueOn(2025, 12, 31), approvalStatus: 1 }), // before the calendar year
    ],
  },
  { _id: "V", mediaDetails: [billFace("v1", "Unipole", { city: "Madurai" })], rentalDue: [faceBill("v1", 300, { dueDate: dueOn(2026, 11, 15), approvalStatus: 1 })] },
  // a stale row (face re-created) and a legitimate site-level row
  { _id: "W", mediaDetails: [billFace("w1", "Hoarding")], rentalDue: [faceBill("gone", 999, { dueDate: dueOn(2026, 11, 10) }), faceBill(null, 400, { dueDate: dueOn(2026, 12, 1), approvalStatus: 1 })] },
]);
const billsAt = (body, now = NOW) => RA.computeBills(upcomingDocs(), RA.parseFilters({ source: "rentalMaster", ...body }, NOW).filters, now);
const CY = { startDate: "2026-01-01", endDate: "2026-12-31" };

test("stored bills by timing: only bills due AFTER today are upcoming; due today and past bills are separated; overdue = past and not approved", () => {
  const r = billsAt(CY);
  assert.equal(r.today, "2026-10-21");
  const up = r.summary.upcoming;
  assert.deepEqual([up.bills, up.total, up.gst, up.sites], [5, 1180 + 500 + 700 + 300 + 400, 280, 3]);
  assert.deepEqual([r.summary.dueToday.bills, r.summary.dueToday.total], [1, 120]);
  assert.deepEqual([r.summary.overdue.bills, r.summary.overdue.total], [1, 100]);
  assert.deepEqual([r.summary.pastApproved.bills, r.summary.pastApproved.total], [1, 110]);
  assert.equal(r.summary.bills, 8);
  assert.equal(r.summary.bills, up.bills + r.summary.dueToday.bills + r.summary.overdue.bills + r.summary.pastApproved.bills);
  assert.equal(r.summary.total, up.total + r.summary.dueToday.total + r.summary.overdue.total + r.summary.pastApproved.total);
  assert.deepEqual(r.meta.staleRowsExcluded, { bills: 1, amount: 999, sites: 1 }, "stale rows never count");
  assert.equal(r.buckets.reduce((x, b) => x + b.upcoming.bills, 0), up.bills);
  assert.equal(r.buckets.reduce((x, b) => x + b.upcoming.total, 0), up.total);
  assert.deepEqual(bucket(r, "2026-10").upcoming.bills, 1, "October: only the bill due tomorrow");
  assert.deepEqual([bucket(r, "2026-10").bills, bucket(r, "2026-10").upcoming.total], [4, 1180]);
  for (const k of ["2026-01", "2026-09"]) assert.deepEqual([bucket(r, k).upcoming.bills, bucket(r, k).upcoming.total], [0, 0], `${k} empty -> zeros`);
});

test("stored bills by timing: status and media-type breakdowns use the same upcoming rows", () => {
  const up = billsAt(CY).summary.upcoming;
  assert.deepEqual(up.byStatus, {
    Pending: { bills: 3, amount: 1180 + 300 + 400 },
    "Partially approved": { bills: 1, amount: 500 },
    Approved: { bills: 1, amount: 700 },
  });
  assert.deepEqual(up.byType, { Hoarding: { bills: 4, amount: 1180 + 500 + 700 + 400 }, Unipole: { bills: 1, amount: 300 } });
  const sum = (o, k) => Object.values(o).reduce((x, v) => x + v[k], 0);
  assert.equal(sum(up.byStatus, "bills"), up.bills);
  assert.equal(sum(up.byType, "amount"), up.total);
  for (const b of billsAt(CY).buckets) {
    assert.equal(sum(b.upcoming.byStatus, "bills"), b.upcoming.bills, b.key);
    assert.equal(sum(b.upcoming.byType, "amount"), b.upcoming.total, b.key);
  }
});

test("stored bills by timing: inclusive range boundaries; month, calendar year, financial year and custom ranges", () => {
  const n = (body) => billsAt(body).summary.upcoming.bills;
  assert.equal(n({ startDate: "2026-10-22", endDate: "2026-11-30" }), 3, "both boundary days included");
  assert.equal(n({ startDate: "2026-10-23", endDate: "2026-11-29" }), 1, "just inside excludes both boundary bills");
  assert.equal(n({ startDate: "2026-10-01", endDate: "2026-10-31" }), 1, "a single month");
  assert.equal(n(CY), 5);
  assert.equal(n({ fy: 2026 }), 6, "FY Apr 2026 – Mar 2027 adds 1 Jan 2027");
  assert.equal(n({ startDate: "2027-01-01", endDate: "2027-12-31" }), 1, "next calendar year");
  const past = billsAt({ fy: 2025 });
  assert.deepEqual([past.summary.upcoming.bills, past.summary.upcoming.total], [0, 0]);
  assert.deepEqual([past.summary.overdue.bills, past.summary.overdue.total], [1, 50]);
  assert.ok(past.buckets.every((b) => b.upcoming.bills === 0 && b.upcoming.total === 0));
  assert.notEqual(n({ startDate: "2026-12-01", endDate: "2026-12-31" }), n(CY));
});

test("stored bills by timing: 'today' moves with the clock (a bill due today is not upcoming, the day after it is overdue)", () => {
  const at = (y, m, d) => billsAt(CY, new Date(Date.UTC(y, m - 1, d, 15, 30)));
  const nov30 = at(2026, 11, 30);
  assert.equal(nov30.today, "2026-11-30");
  assert.deepEqual([nov30.summary.dueToday.bills, nov30.summary.dueToday.total], [1, 500]);
  assert.deepEqual([nov30.summary.upcoming.bills, nov30.summary.upcoming.total], [2, 700 + 400]);
  const dec1 = at(2026, 12, 1);
  assert.equal(dec1.summary.overdue.bills, 5, "20 Oct, 21 Oct, 22 Oct, 15 Nov (pending) and 30 Nov (only partially approved) — all before today and not fully approved");
  assert.equal(dec1.summary.pastApproved.bills, 1, "20 Oct approved: past its due date but not overdue");
});

test("stored bills by timing: city, media type, site status and source filters apply to the upcoming rows", () => {
  const n = (body) => billsAt({ ...CY, ...body }).summary.upcoming;
  assert.deepEqual([n({ city: "Madurai" }).bills, n({ city: "Madurai" }).total], [1, 300]);
  assert.deepEqual([n({ mediaType: "Unipole" }).bills, n({ mediaType: "Hoarding" }).bills], [1, 4]);
  const f = (st) => RA.parseFilters({ ...CY, siteStatus: st }, NOW).filters;
  assert.equal(RA.computeBills(RA.applySiteStatus(upcomingDocs(), f("active")), f("active"), NOW).summary.upcoming.bills, 5);
  assert.equal(RA.computeBills(RA.applySiteStatus(upcomingDocs(), f("inactive")), f("inactive"), NOW).summary.upcoming.bills, 0);
  assert.equal(C.resolve("bills", "ledger"), null, "Ledger source stays 'not supported'");
});

// ── Outstanding payments (site × billing-month cycles, Rental Master / Ledger calculation) ──
// NOW = 21 Oct 2026. dsite(id, rent, { start }) bills monthly from the month after `start` (day 10).
const outAt = (docs, body = {}, now = NOW) => RA.computeOutstanding(deepFreeze(docs), RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31", ...body }, NOW).filters, LIB, now);
const sumCats = (r, k) => ["upcoming", "dueToday", "overdue"].reduce((x, c) => x + r.summary[c][k], 0);
const owner2 = (id, amt) => ({ _id: `${id}-o2`, paymentCategory: 2, onlineAmount: amt, shareAmount: amt });

test("outstanding: unpaid cycles by due date — overdue before today, upcoming after; one unit per site × month", () => {
  const r = outAt([dsite("A", 10000, { start: D(2026, 7) })]); // cycles 10 Sep, 10 Oct, 10 Nov, 10 Dec
  assert.equal(r.unit, "siteCycle");
  assert.deepEqual([r.summary.overdue.cycles, r.summary.overdue.amount], [2, 20000]);
  assert.deepEqual([r.summary.upcoming.cycles, r.summary.upcoming.amount], [2, 20000]);
  assert.deepEqual([r.summary.dueToday.cycles, r.summary.dueToday.amount], [0, 0]);
  assert.deepEqual(r.summary.total, { cycles: 4, sites: 1, amount: 40000 });
  assert.equal(r.summary.upcoming.notYetBilled, 2, "Nov / Dec have no bill row yet (the ledger computes them from the schedule)");
  assert.deepEqual([bucket(r, "2026-09").overdue.amount, bucket(r, "2026-11").upcoming.amount, bucket(r, "2026-05").total.amount], [10000, 10000, 0]);
});

test("outstanding: a paid landlord share settles its cycle; with two landlords only the unpaid share remains", () => {
  const paidOct = dsite("P", 10000, { start: D(2026, 7), ledgerHistory: paidHist("P", "October", "2026", 10000) });
  const r = outAt([paidOct]);
  assert.equal(r.summary.total.cycles, 3, "October paid -> excluded");
  assert.equal(r.meta.settledCycles, 1);
  assert.equal(r.summary.overdue.amount, 10000, "only September is overdue");
  const two = dsite("T", 10000, { start: D(2026, 7), owners: [ownerOnline("T", 6000), owner2("T", 4000)], ledgerHistory: paidHist("T", "October", "2026", 6000) });
  const r2 = outAt([two], { startDate: "2026-10-01", endDate: "2026-10-31" });
  assert.deepEqual([r2.summary.overdue.cycles, r2.summary.overdue.amount, r2.summary.overdue.rent], [1, 4000, 4000], "only the second landlord's 4,000 is still to be paid");
});

test("outstanding: held GST stays outstanding until released through the GST balance", () => {
  const held = withGstRp(dsite("G", 10000, { start: D(2026, 7), ledgerHistory: paidHist("G", "October", "2026", 10000), rentalDue: [bill("October 2026", 1)] }), 1800);
  const oct = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const r = outAt([held], oct);
  assert.deepEqual([r.summary.overdue.rent, r.summary.overdue.gst, r.summary.overdue.amount], [0, 1800, 1800], "rent paid, GST still held");
  const released = { ...held, gstBalanceHistory: [{ rentalDueId: "x", dueMonth: "October 2026", gstAmount: 1800, isPaid: true }] };
  assert.equal(outAt([released], oct).summary.total.amount, 0, "released GST -> settled");
  assert.equal(outAt([released], oct).meta.settledCycles, 1);
});

test("outstanding: approval status is not payment status", () => {
  const oct = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const approvedUnpaid = dsite("AU", 10000, { start: D(2026, 7), rentalDue: [bill("October 2026", 0, { approvalStatus: 3 })] });
  const pendingPaid = dsite("PP", 10000, { start: D(2026, 7), rentalDue: [bill("October 2026", 0, { approvalStatus: 1 })], ledgerHistory: paidHist("PP", "October", "2026", 10000) });
  const r = outAt([approvedUnpaid, pendingPaid], oct);
  assert.deepEqual([r.summary.overdue.cycles, r.summary.overdue.amount], [1, 10000], "approved but unpaid is outstanding; pending but paid is not");
  assert.deepEqual(r.summary.overdue.byStatus, { Approved: { cycles: 1, amount: 10000 } });
});

test("outstanding: due today is its own category; the boundaries of the range are inclusive", () => {
  const today = dsite("DT", 5000, { start: D(2026, 8, 21) }); // cycles 21 Oct (= today), 21 Nov, 21 Dec
  const r = outAt([today]);
  assert.deepEqual([r.summary.dueToday.cycles, r.summary.dueToday.amount], [1, 5000]);
  assert.equal(r.today, "2026-10-21");
  assert.equal(outAt([today], { startDate: "2026-10-21", endDate: "2026-10-21" }).summary.total.amount, 5000, "single-day range = today");
  assert.equal(outAt([today], { startDate: "2026-10-22", endDate: "2026-11-21" }).summary.upcoming.cycles, 1, "21 Nov included (end), 21 Oct excluded (before start)");
  assert.equal(outAt([today], { startDate: "2026-10-22", endDate: "2026-11-20" }).summary.total.cycles, 0, "nothing due inside");
  const tomorrow = outAt([today], {}, new Date(Date.UTC(2026, 9, 22, 9)));
  assert.deepEqual([tomorrow.summary.dueToday.cycles, tomorrow.summary.overdue.cycles], [0, 1], "the next day it is overdue");
});

test("outstanding: several face bills of one site count the site's cycle once; stale-only months add no cycle", () => {
  const two = { ...dsite("MF", 20000, { start: D(2026, 7) }), mediaDetails: [face("MF"), { ...face("MF2"), _id: "MF-f2" }],
    rentalDue: [faceBill("MF-f", 12000, { dueDate: D(2026, 9) }), faceBill("MF-f2", 8000, { dueDate: D(2026, 9) })] };
  const r = outAt([two], { startDate: "2026-10-01", endDate: "2026-10-31" });
  assert.deepEqual([r.summary.overdue.cycles, r.summary.overdue.sites, r.summary.overdue.amount], [1, 1, 20000]);
  // quarterly site: a stale row in a month with no cycle must not create one
  const q = { ...dsite("Q", 30000, { start: D(2026, 3) }), rentalDue: [faceBill("gone", 30000, { dueDate: D(2026, 8, 5) })] };
  q.rentalPayment = { ...q.rentalPayment, paymentFrequency: 2 };
  const rq = outAt([q]);
  assert.deepEqual(rq.buckets.filter((b) => b.total.cycles).map((b) => b.key), ["2026-07", "2026-10"], "quarterly cycles only; no September cycle from the stale row");
  assert.equal(rq.meta.staleRowsIgnored, 1);
});

test("outstanding: a site without a landlord is unallocated — never counted as paid, never in the total", () => {
  const noOwner = dsite("NO", 131250, { start: D(2026, 7), owners: [] });
  const r = outAt([noOwner, dsite("A", 10000, { start: D(2026, 7) })]);
  assert.equal(r.summary.total.amount, 40000, "only the site with a landlord");
  assert.deepEqual([r.summary.unallocated.cycles, r.summary.unallocated.sites, r.summary.unallocated.configuredRent], [4, 1, 4 * 131250]);
  assert.ok(r.summary.unallocated.records.every((x) => x.reason === "no landlord" && x.siteId === "NO"));
  assert.equal(r.meta.settledCycles, 0, "not counted as settled either");
});

test("outstanding: totals reconcile — categories, months, statuses, media types; filters keep their behaviour", () => {
  const docs = [
    dsite("A", 10000, { start: D(2026, 7) }),
    { ...dsite("B", 6000, { start: D(2026, 8, 21) }), mediaDetails: [face("B", "Unipole", "Madurai")] },
    dsite("C", 4000, { start: D(2026, 7), rentalDue: [bill("September 2026", 0, { dueDate: D(2026, 8), approvalStatus: 2 })] }),
  ];
  const r = outAt(docs);
  assert.equal(r.summary.total.amount, sumCats(r, "amount"));
  assert.equal(r.summary.total.cycles, sumCats(r, "cycles"));
  assert.equal(r.summary.total.sites, 3);
  assert.equal(r.buckets.reduce((x, b) => x + b.total.amount, 0), r.summary.total.amount);
  for (const c of ["upcoming", "dueToday", "overdue"]) {
    const s = r.summary[c];
    assert.equal(Object.values(s.byStatus).reduce((x, v) => x + v.amount, 0), s.amount, `${c} by status`);
    assert.equal(Object.values(s.byType).reduce((x, v) => x + v.cycles, 0), s.cycles, `${c} by type`);
  }
  assert.deepEqual(r.summary.overdue.byStatus["Partially approved"], { cycles: 1, amount: 4000 });
  assert.ok(r.summary.upcoming.byStatus["Not billed yet"].cycles > 0);
  // filters: city / media type (site level), site status, source
  assert.equal(outAt(docs, { city: "Madurai" }).summary.total.sites, 1);
  assert.equal(outAt(docs, { mediaType: "Unipole" }).summary.total.amount, outAt(docs, { city: "Madurai" }).summary.total.amount);
  const fa = (st) => RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31", siteStatus: st }, NOW).filters;
  assert.equal(RA.computeOutstanding(RA.applySiteStatus(deepFreeze(docs), fa("inactive")), fa("inactive"), LIB, NOW).summary.total.cycles, 0);
  assert.equal(C.resolve("bills", "ledger"), null);
  // an empty period is all zeros
  const empty = outAt(docs, { startDate: "2025-01-01", endDate: "2025-12-31" });
  assert.deepEqual(empty.summary.total, { cycles: 0, sites: 0, amount: 0 });
  assert.ok(empty.buckets.every((b) => b.total.amount === 0));
});

test("outstanding: October 2026 reconciles with the Rental Master unpaid figure for the same cycles", () => {
  const docs = octFixture(); // Rental Master: due 60,84,025, unpaid 58,30,025 for October
  const r = outAt(docs, { startDate: "2026-10-01", endDate: "2026-10-31" });
  const rm = RA.computePeriodDue(docs, RA.parseFilters(OCT, NOW).filters, LIB, NOW).due;
  assert.equal(r.summary.total.amount, rm.unpaid);
  assert.equal(r.summary.total.amount, 5830025);
  assert.equal(r.summary.overdue.amount, 5830025, "all October cycles fall on the 10th, before 21 Oct");
});

test("outstanding export details: opt-in per-cycle rows (with their bill rows) that reconcile with the summary", () => {
  const docs = [
    { ...dsite("DX", 20000, { start: D(2026, 7) }), mediaDetails: [{ ...face("DX"), mediaCode: "DX-1" }, { ...face("DX2"), _id: "DX-f2", mediaCode: "DX-2" }],
      rentalDue: [faceBill("DX-f", 12000, { dueDate: D(2026, 9), gstAmount: 0, netPayable: 12000 }), faceBill("DX-f2", 8000, { dueDate: D(2026, 9) }), faceBill("gone", 999, { dueDate: D(2026, 9) })] },
    dsite("NO", 5000, { start: D(2026, 7), owners: [] }),
  ];
  const plain = outAt(docs);
  assert.equal(plain.records, undefined, "no detail rows unless asked for (the UI does not ask)");
  const r = outAt(docs, { details: true });
  assert.equal(RA.parseFilters({ details: true }, NOW).filters.details, true);
  assert.equal(r.records.length, r.summary.total.cycles, "one row per outstanding cycle");
  assert.equal(r.records.reduce((x, c) => x + c.remaining, 0), r.summary.total.amount);
  for (const c of ["upcoming", "dueToday", "overdue"]) {
    assert.equal(r.records.filter((x) => x.category === c).reduce((a, x) => a + x.remaining, 0), r.summary[c].amount, c);
  }
  const oct = r.records.find((x) => x.month === "2026-10");
  assert.deepEqual([oct.siteId, oct.dueDate, oct.category, oct.remaining, oct.status], ["DX", "2026-10-10", "overdue", 20000, "Approved"], "approved but unpaid: still outstanding");
  assert.deepEqual(oct.bills.map((b) => [b.mediaCode, b.baseAmount]), [["DX-1", 12000], ["DX-2", 8000]], "current-face bill rows only (stale row left out)");
  assert.ok(r.records.every((x) => x.siteId !== "NO"), "unallocated cycles stay in summary.unallocated, not in the detail rows");
  // the live endpoint query carries every field the detail rows read
  const live = RA.computeOutstanding(deepFreeze(docs.map((d) => projectLikeMongo(d, C.SELECT.bills.rentalMaster))), RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31", details: true }, NOW).filters, LIB, NOW);
  assert.deepEqual(live.records, r.records);
});

// ── Site status filter ────────────────────────────────────────────────────
const statusSite = (id, statuses, extra = {}) => ({
  _id: id,
  createdAt: new Date(Date.UTC(2026, 5, 1)),
  mediaDetails: statuses.map((st, i) => ({ _id: `${id}-f${i}`, mediaType: "Hoarding", city: "Chennai", mediaName: `${id}${i}`, status: st })),
  rentalDue: [{ dueDate: new Date(Date.UTC(2026, 8, 15)), baseAmount: 100, approvalStatus: 1 }],
  ...extra,
});

test("site status: active = at least one face with status 1; inactive = none (inactive / hold / no faces); all = everything", () => {
  assert.equal(RA.parseFilters({}, NOW).filters.siteStatus, "all", "absent -> all (unchanged API behaviour)");
  for (const s of ["active", "inactive", "all"]) assert.equal(RA.parseFilters({ siteStatus: s }, NOW).filters.siteStatus, s);
  for (const bad of ["Active", "on", 1, "hold"]) assert.match(RA.parseFilters({ siteStatus: bad }, NOW).error, /siteStatus must be/);
  const docs = deepFreeze([
    statusSite("A", [1]), statusSite("AB", [2, 1, 3]), // active
    statusSite("I", [2]), statusSite("H", [3, 3]), statusSite("N", []), // inactive
  ]);
  const ids = (st) => RA.applySiteStatus(docs, fy({ siteStatus: st })).map((d) => d._id);
  assert.deepEqual(ids("active"), ["A", "AB"]);
  assert.deepEqual(ids("inactive"), ["I", "H", "N"]);
  assert.deepEqual(ids("all"), ["A", "AB", "I", "H", "N"]);
  assert.deepEqual(RA.applySiteStatus(docs, fy()).length, 5);
  // the partition is exact: active + inactive = all, for any chart
  const bills = (st) => RA.computeBills(RA.applySiteStatus(docs, fy({ siteStatus: st })), fy({ siteStatus: st }));
  assert.equal(bills("active").summary.bills + bills("inactive").summary.bills, bills("all").summary.bills);
  assert.deepEqual([bills("active").summary.bills, bills("inactive").summary.bills], [2, 3]);
  assert.equal(bills("inactive").filters.siteStatus, "inactive", "echoed back");
  // media counts faces (A 1, AB 3 of which 1 active, I 1, H 2, N face-less 1) on the unfiltered documents
  const media = (st) => RA.computeMedia(docs, fy({ siteStatus: st })).summary.total;
  assert.deepEqual([media("active"), media("inactive"), media("all")], [2, 6, 8]);
});

test("site status: every chart's projection loads face status; invalid values are a 400; unsupported answers echo it", async () => {
  for (const [chart, bySource] of Object.entries(C.SELECT)) {
    if (chart === "filters") continue;
    for (const [src, sel] of Object.entries(bySource)) assert.match(sel, /mediaDetails\.status/, `${chart}/${src}`);
  }
  const bad = fakeRes();
  await C.getBillAnalytics({ user: { userType: 1 }, body: { siteStatus: "sometimes" } }, bad);
  assert.equal(bad.statusCode, 400);
  const res = fakeRes();
  await C.getBillAnalytics({ user: { userType: 1 }, body: { source: "ledger", siteStatus: "inactive" } }, res);
  assert.deepEqual(res.body.data.filters, { source: "ledger", siteStatus: "inactive" });
});

// ── Robustness / read-only ────────────────────────────────────────────────
test("malformed or empty source data never throws", () => {
  const junk = deepFreeze([
    {},
    {
      _id: "x", mediaDetails: null,
      ledgerHistory: [null, { months: null }, { months: [null, { entries: [null, {}] }] }],
      rentalDue: [null, {}], gstBalanceHistory: [null], tdsBalanceHistory: [null, {}],
      appraisal: { applicable: 1, history: [null, {}] }, rentalPayment: { gstOutstandingHistory: [null, {}] },
    },
  ]);
  const f = fy();
  for (const fn of [RA.computePayments, RA.computeMedia, RA.computeAppraisal, RA.computeBills, RA.computeGst, RA.computeTds]) {
    assert.equal(fn(junk, f).buckets.length, 12);
  }
  assert.deepEqual(RA.computeFilterOptions([], NOW).mediaTypes, []);
});

test("aggregation does not mutate its (deep-frozen) input", () => {
  const docs = deepFreeze([site("1", [["H", "C"]], {
    createdAt: new Date(Date.UTC(2026, 5, 3)), ledgerHistory: hist(entry({})),
    rentalDue: [{ dueDate: new Date(Date.UTC(2026, 6, 1)), baseAmount: 1 }],
    tdsBalanceHistory: [], gstBalanceHistory: [], appraisal: appraisal([]),
  })]);
  const before = JSON.stringify(docs);
  for (const fn of [RA.computePayments, RA.computeMedia, RA.computeAppraisal, RA.computeBills, RA.computeGst, RA.computeTds]) fn(docs, fy());
  assert.equal(JSON.stringify(docs), before);
});

// ── Authorization / error handling (no DB reached) ────────────────────────
const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const handlers = ["getFilterOptions", "getPaymentAnalytics", "getMediaAnalytics", "getAppraisalAnalytics", "getBillAnalytics", "getGstAnalytics", "getTdsAnalytics"];

test("roles outside 1-4 (including 5, missing, garbage) get 403 on every endpoint", async () => {
  for (const name of handlers) {
    for (const userType of [5, 0, undefined, "x", null]) {
      const res = fakeRes();
      await C[name]({ user: { userType }, body: {} }, res);
      assert.equal(res.statusCode, 403, `${name} userType=${userType}`);
    }
    const res = fakeRes();
    await C[name]({ body: {} }, res);
    assert.equal(res.statusCode, 403, `${name} no user`);
  }
});

test("roles 1-4 pass the guard; invalid filters return 400 before any DB access", async () => {
  assert.deepEqual(C.ALLOWED_ROLES, [1, 2, 3, 4]);
  for (const name of handlers.slice(1)) {
    for (const userType of [1, 2, 3, 4]) {
      const res = fakeRes();
      await C[name]({ user: { userType }, body: { startDate: "bad", endDate: "worse" } }, res);
      assert.equal(res.statusCode, 400, `${name} role ${userType}`);
      assert.equal(res.body.success, false);
    }
  }
});

test("controller, routes and aggregation module contain no write operations", () => {
  const files = [
    "../controllers/Admin/ReportAnalyticsController/ReportAnalyticsController.js",
    "../utils/reportAnalytics.js",
    "../routes/Admin/ReportAnalyticsRoutes/ReportAnalyticsRoutes.js",
  ];
  const src = files
    .map((p) => fs.readFileSync(path.join(__dirname, p), "utf8")
      .split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n"))
    .join("\n");
  assert.doesNotMatch(src, /\.(save|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|insertMany|deleteOne|deleteMany|bulkWrite|create|remove|replaceOne)\s*\(/);
  assert.doesNotMatch(src, /ensureRentalDueForCycles|generateMissedEntries|syncBillingCycles/);
});

// ── Detail dialogs: per-site rows behind the Payments and Outstanding figures ──────────────────────────────
const detailRange = (docs, body) => RA.computePeriodDue(docs, RA.parseFilters({ details: true, ...body }, NOW).filters, LIB, NOW);
const sumOf = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

test("payments detail rows: reconcile with the summary (to be paid, unpaid, paid) and carry the stored media codes and the landlord names", () => {
  const withCodes = { S1: ["ADN-MEDIA-001"], S2: ["ADN-MEDIA-002", "ADN-MEDIA-003"] }; // S2 has two faces; S3 / S4 have none stored
  const docs = octFixture().map((d) => ({
    ...d,
    mediaDetails: d.mediaDetails.map((f, i) => ({ ...f, mediaCode: withCodes[d._id]?.[i] })).concat((withCodes[d._id] || []).slice(d.mediaDetails.length).map((c) => ({ ...face(d._id), _id: `${d._id}-f2`, mediaCode: c }))),
    landOwners: d.landOwners.map((o, i) => ({ ...o, name: `Owner ${d._id}${i}` })),
  }));
  const { due, records } = detailRange(docs, OCT);
  assert.equal(records.length, 4, "one row per site and month");
  assert.equal(sumOf(records, "rentDue") + sumOf(records, "gstDue"), due.toBePaid);
  assert.equal(sumOf(records, "rentUnpaid") + sumOf(records, "gstUnpaid"), due.unpaid);
  assert.equal(sumOf(records, "rentDue") + sumOf(records, "gstDue") - sumOf(records, "rentUnpaid") - sumOf(records, "gstUnpaid"), due.toBePaid - due.unpaid, "paid = to be paid - unpaid");
  const byId = Object.fromEntries(records.map((r) => [r.siteId, r]));
  assert.deepEqual([byId.S2.rentDue, byId.S2.gstDue], [2000000, 444830], "hold GST is the GST column");
  assert.deepEqual([byId.S3.rentDue, byId.S3.gstDue], [583035, 56160], "direct GST is the GST column too");
  assert.deepEqual([byId.S4.rentUnpaid, byId.S4.gstUnpaid], [0, 0], "S4 is fully paid");
  assert.deepEqual(byId.S1.mediaCodes, ["ADN-MEDIA-001"], "the stored media code, exactly as stored");
  assert.deepEqual(byId.S2.mediaCodes, ["ADN-MEDIA-002", "ADN-MEDIA-003"], "a site with two faces lists both");
  assert.deepEqual(byId.S3.mediaCodes, [], "no media code stored: empty, never the document id");
  assert.deepEqual(byId.S4.mediaCodes, []);
  assert.deepEqual(byId.S3.landlords, [{ name: "Owner S30" }], "the landlord name only");
  for (const r of records) {
    assert.ok(!("siteCode" in r), "no site code");
    assert.ok(!JSON.stringify(r.landlords).includes("master"), "no landlord id");
    assert.ok(!JSON.stringify(r.mediaCodes).includes("S3-f"), "never an id in place of a code");
  }
  // sites / unpaid sites / fully paid sites agree with the summary cards
  const sites = new Set(records.map((r) => r.siteId));
  const unpaid = new Set(records.filter((r) => r.rentUnpaid + r.gstUnpaid > 0).map((r) => r.siteId));
  assert.equal(sites.size, due.sites);
  assert.equal(unpaid.size, due.unpaidSites);
  assert.deepEqual([...sites].filter((s) => !unpaid.has(s)), ["S4"]);
});

test("payments detail rows: a site due in several months has one row per month that matches that month's bucket", () => {
  const docs = [dsite("A", 10000, { start: D(2026, 3), siteCode: "A-1" }), dsite("B", 5000, { start: D(2026, 3), ledgerHistory: paidHist("B", "October", "2026", 5000) })];
  const r = detailRange(docs, { fy: 2026 });
  for (const b of r.buckets) {
    const rows = r.records.filter((x) => x.month === b.key);
    assert.equal(sumOf(rows, "rentDue") + sumOf(rows, "gstDue"), b.toBePaid, b.key);
    assert.equal(sumOf(rows, "rentUnpaid") + sumOf(rows, "gstUnpaid"), b.unpaid, b.key);
    assert.equal(new Set(rows.map((x) => x.siteId)).size, b.sites, `${b.key} sites`);
    assert.equal(new Set(rows.filter((x) => x.rentUnpaid + x.gstUnpaid > 0).map((x) => x.siteId)).size, b.unpaidSites, `${b.key} unpaid sites`);
  }
  assert.ok(r.records.filter((x) => x.siteId === "A").length >= 3, "site A repeats across months");
  assert.equal(sumOf(r.records, "rentDue") + sumOf(r.records, "gstDue"), r.due.toBePaid);
});

test("payments detail rows: opening balances are included (rent and GST columns) and only on request", () => {
  const open = dsite("O", 10000, { start: D(2026, 7) });
  open.rentalPayment.rentalOutstandingHistory = [{ dueMonth: "October 2026", baseRentOutstandingAmount: 900 }];
  open.rentalPayment.gstOutstandingHistory = [{ dueMonth: "October 2026", gstOutStandingAmount: 160, isPaid: true }];
  const r = detailRange([open], OCT);
  assert.equal(sumOf(r.records, "rentDue") + sumOf(r.records, "gstDue"), r.due.toBePaid);
  assert.equal(sumOf(r.records, "rentUnpaid") + sumOf(r.records, "gstUnpaid"), r.due.unpaid);
  assert.equal(sumOf(r.records, "gstDue"), 160);
  assert.equal(sumOf(r.records, "gstUnpaid"), 0, "a paid opening GST row is not unpaid");
  assert.equal(dueRange([open], OCT).records, undefined, "no details flag: no rows");
  const payments = RA.computeRentalMasterPayments([open], RA.parseFilters({ details: true, ...OCT }, NOW).filters, LIB, NOW);
  assert.equal(payments.records.length, r.records.length);
  assert.equal(RA.computeRentalMasterPayments([open], RA.parseFilters(OCT, NOW).filters, LIB, NOW).records, undefined);
});

test("outstanding records carry the stored media codes and the landlord names for the detail dialog", () => {
  const two = { ...dsite("A", 10000, { start: D(2026, 7), owners: [{ ...ownerOnline("A", 6000), name: "Asha" }, { ...owner2("A", 4000), name: "Ravi" }] }) };
  two.mediaDetails = [{ ...face("A"), mediaCode: "ADN-MEDIA-010" }, { ...face("A"), _id: "A-f2", mediaCode: "ADN-MEDIA-011" }];
  const noCode = dsite("N", 10000, { start: D(2026, 7), owners: [{ ...ownerOnline("N", 10000), name: "Meena" }] });
  const r = outAt([two, noCode], { details: true });
  assert.ok(r.records.length > 0);
  for (const rec of r.records.filter((x) => x.siteId === "A")) {
    assert.deepEqual(rec.mediaCodes, ["ADN-MEDIA-010", "ADN-MEDIA-011"], "exactly as stored, one per face");
    assert.deepEqual(rec.landlords, [{ name: "Asha" }, { name: "Ravi" }]);
    assert.ok(!("siteCode" in rec));
  }
  for (const rec of r.records.filter((x) => x.siteId === "N")) {
    assert.deepEqual(rec.mediaCodes, [], "no stored media code: empty, never the document id");
    assert.deepEqual(rec.landlords, [{ name: "Meena" }]);
  }
  assert.equal(sumOf(r.records, "remaining"), sumCats(r, "amount"), "records add up to the category totals");
  assert.equal(sumOf(r.records, "rent"), sumCats(r, "rent"));
  assert.equal(sumOf(r.records, "gst"), sumCats(r, "gst"));
  for (const c of ["upcoming", "dueToday", "overdue"]) {
    assert.equal(sumOf(r.records.filter((x) => x.category === c), "remaining"), r.summary[c].amount, c);
  }
});

// ── Detail rows behind the GST, Sites onboarded and Appraisals charts (opt-in: `details`) ─────────────────

const named = (d, mediaCode) => ({ ...d, mediaDetails: d.mediaDetails.map((f) => ({ ...f, mediaCode })), landOwners: (d.landOwners || []).map((o, i) => ({ ...o, name: `Owner ${d._id}${i}` })) });
const rmBills = (id, gst, extra = {}) => dsite(id, 10000, { start: D(2026, 3), rentalDue: gst, ...extra });
const gstDetail = (docs, body = {}) => RA.computeGst(docs, RA.parseFilters({ details: true, startDate: "2026-01-01", endDate: "2026-12-31", ...body }, NOW).filters);

test("GST (Rental Master) detail rows: one per bill GST / onboarding due, reconcile with each category and month", () => {
  const docs = [
    named(rmBills("G1", [
      { _id: "b1", dueMonth: "August 2026", dueDate: D(2026, 7), approvalStatus: 3, withGst: 2, gstAmount: 1800 },
      { _id: "b2", dueMonth: "September 2026", dueDate: D(2026, 8), approvalStatus: 1, withGst: 1, gstAmount: 900 },
      { _id: "b3", dueMonth: "September 2026", dueDate: D(2026, 8), approvalStatus: 1, withGst: 0, gstAmount: 100 },
    ]), "ADN-MEDIA-1"),
    named(rmBills("G2", [{ _id: "b4", dueMonth: "September 2026", dueDate: D(2026, 8), approvalStatus: 3, withGst: 2, gstAmount: 500 }], {
      rentalPayment: { billingStartDate: D(2026, 3), paymentFrequency: 1, totalRentalAmount: 10000, gstOutstandingHistory: [{ dueMonth: "September 2026", gstOutStandingAmount: 300, paymentBreakup: [{ amount: 50 }] }] },
    }), "ADN-MEDIA-2"),
  ];
  const r = gstDetail(docs);
  assert.ok(r.records.length > 0);
  for (const c of ["direct", "hold", "unpaid"]) {
    const rows = r.records.filter((x) => x.category === c);
    assert.equal(sumOf(rows, "amount"), r.summary[c].amount, `${c} total`);
    assert.equal(rows.length, r.summary[c].records, `${c} rows`);
    assert.equal(new Set(rows.map((x) => x.siteId)).size, r.summary[c].sites, `${c} sites`);
    for (const b of r.buckets) {
      assert.equal(sumOf(rows.filter((x) => x.bucket === b.key), "amount"), b[c].amount, `${c} ${b.key}`);
    }
  }
  const direct = r.records.filter((x) => x.category === "direct");
  assert.deepEqual(direct.map((x) => x.mediaCodes), [["ADN-MEDIA-1"], ["ADN-MEDIA-2"]]);
  assert.equal(direct[0].status, "Approved");
  assert.equal(direct[0].billMonth, "August 2026");
  assert.deepEqual(direct[0].landlords, [{ name: "Owner G10" }]);
  const unpaid = r.records.find((x) => x.category === "unpaid");
  assert.equal(unpaid.amount, 250, "onboarding due net of what was settled");
  assert.equal(unpaid.status, "Onboarding due");
  assert.equal(RA.computeGst(docs, RA.parseFilters({ startDate: "2026-01-01", endDate: "2026-12-31" }, NOW).filters).records, undefined, "no rows unless asked");
});

test("GST (Ledger) detail rows: per site cycle / opening row; paid and remaining rows reconcile with the summary", () => {
  const docs = gstLedgerFixture().map((d) => named(d, "ADN-MEDIA-L"));
  const r = RA.computeLedgerGst(docs, RA.parseFilters({ details: true, source: "ledger", fy: 2026 }, NOW).filters, LIB, NOW);
  assert.ok(r.records.length > 0);
  assert.equal(sumOf(r.records, "paid"), r.summary.paid.amount);
  assert.equal(sumOf(r.records, "remaining"), r.summary.remaining.amount);
  for (const b of r.buckets) {
    const rows = r.records.filter((x) => x.bucket === b.key);
    assert.equal(sumOf(rows, "paid"), b.paid.amount, `${b.key} paid`);
    assert.equal(sumOf(rows, "remaining"), b.remaining.amount, `${b.key} remaining`);
  }
  for (const k of ["hold", "direct", "opening"]) {
    assert.equal(sumOf(r.records.filter((x) => x.kind === k), "paid") + sumOf(r.records.filter((x) => x.kind === k), "remaining"), r.summary.parts[k].due, k);
  }
  for (const rec of r.records) assert.deepEqual(rec.mediaCodes, ["ADN-MEDIA-L"]);
});

test("Sites onboarded detail rows: one per counted face, with the stored media code, type, city and onboarding date", () => {
  const docs = deepFreeze([
    { ...site("M1", [["Hoarding", "Chennai", "Alpha"], ["Unipole", "Chennai", "Beta"]], { createdAt: at(2026, 5, 3) }), mediaDetails: [{ _id: "m1-a", mediaType: "Hoarding", city: "Chennai", mediaName: "Alpha", mediaCode: "ADN-MEDIA-001", status: 1 }, { _id: "m1-b", mediaType: "Unipole", city: "Chennai", mediaName: "Beta", status: 1 }] },
    { ...site("M2", [["Hoarding", "Madurai", "Gamma"]], { createdAt: at(2026, 6, 9) }), mediaDetails: [{ _id: "m2-a", mediaType: "Hoarding", city: "Madurai", mediaName: "Gamma", mediaCode: "ADN-MEDIA-002", status: 1 }] },
  ]);
  const r = RA.computeMedia(docs, RA.parseFilters({ details: true, fy: 2026 }, NOW).filters);
  assert.equal(r.records.length, r.summary.total, "one row per counted face");
  for (const b of r.buckets) {
    const rows = r.records.filter((x) => x.bucket === b.key);
    assert.equal(rows.length, b.total, b.key);
    for (const [t, n] of Object.entries(b.byType)) assert.equal(rows.filter((x) => x.mediaType === t).length, n, `${b.key} ${t}`);
  }
  const june = r.records.filter((x) => x.bucket === "2026-06");
  assert.deepEqual(june.map((x) => [x.siteName, x.mediaCodes, x.mediaType, x.city, x.date]), [["Alpha", ["ADN-MEDIA-001"], "Hoarding", "Chennai", "2026-06-03"], ["Beta", [], "Unipole", "Chennai", "2026-06-03"]], "a face without a stored code lists none");
  assert.equal(RA.computeMedia(docs, RA.parseFilters({ fy: 2026 }, NOW).filters).records, undefined);
  const filtered = RA.computeMedia(docs, RA.parseFilters({ details: true, fy: 2026, mediaType: "Hoarding" }, NOW).filters);
  assert.equal(filtered.records.length, filtered.summary.total);
  assert.ok(filtered.records.every((x) => x.mediaType === "Hoarding"), "the media-type filter narrows the rows too");
});

test("Appraisal detail rows: one per counted entry, split given / upcoming / held, reconciling with each category", () => {
  const entry = (date, amount, extra = {}) => ({ appraisalDate: date, appraisalAmount: amount, previousRent: 10000, newRent: 10000 + amount, type: 1, percentage: 5, ...extra });
  const docs = deepFreeze([
    named(site("A1", [["Hoarding", "Chennai", "Alpha"]], { landOwners: [{ _id: "A1-o" }], appraisal: appraisal([entry(at(2026, 5, 10), 500), entry(at(2026, 10, 10), 700, { type: 2 }), { isAnchorEntry: true, appraisalDate: at(2026, 4, 1), appraisalAmount: 999 }]) }), "ADN-MEDIA-A1"),
    named(site("A2", [["Hoarding", "Chennai", "Beta"]], { appraisal: appraisal([entry(at(2026, 10, 15), 300)], { appraisalHold: 1, appraisalHoldDate: at(2026, 9, 1) }) }), "ADN-MEDIA-A2"),
  ]);
  const r = RA.computeAppraisal(docs, RA.parseFilters({ details: true, fy: 2026 }, NOW).filters, NOW);
  assert.ok(r.records.length >= 3);
  for (const k of ["given", "upcoming", "held"]) {
    const rows = r.records.filter((x) => x.kind === k);
    assert.equal(sumOf(rows, "amount"), r.summary[k].amount, `${k} amount`);
    assert.equal(rows.length, r.summary[k].entries, `${k} entries`);
    assert.equal(new Set(rows.map((x) => x.siteId)).size, r.summary[k].sites, `${k} sites`);
    for (const b of r.buckets) assert.equal(sumOf(rows.filter((x) => x.bucket === b.key), "amount"), b[k].amount, `${k} ${b.key}`);
  }
  const given = r.records.find((x) => x.kind === "given");
  assert.deepEqual([given.mediaCodes, given.landlords, given.date, given.previousRent, given.newRent, given.type, given.percentage], [["ADN-MEDIA-A1"], [{ name: "Owner A10" }], "2026-06-10", 10000, 10500, "percentage", 5]);
  assert.equal(r.records.find((x) => x.type === "fixed").percentage, null);
  assert.ok(!r.records.some((x) => x.amount === 999), "the baseline (anchor) entry is not an appraisal");
  assert.equal(RA.computeAppraisal(docs, RA.parseFilters({ fy: 2026 }, NOW).filters, NOW).records, undefined);
});
