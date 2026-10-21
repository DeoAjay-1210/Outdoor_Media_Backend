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
const { mediaAsOfDate } = require("../utils/appraisalRent");
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

test("media: one site with one face counts as one site", () => {
  const r = RA.computeMedia(deepFreeze([site("1", [["Hoarding", "Chennai"]], { createdAt: at(2026, 5) })]), fy());
  assert.equal(r.summary.total, 1);
  assert.equal(bucket(r, "2026-06").total, 1);
});

test("media: multiple faces of the same type count the site once", () => {
  const r = RA.computeMedia(deepFreeze([site("2", [["Hoarding", "Chennai"], ["Hoarding", "Chennai"], ["Hoarding", "Chennai"]], { createdAt: at(2026, 5) })]), fy());
  assert.equal(r.summary.total, 1);
  assert.deepEqual(r.summary.byType, { Hoarding: 1 });
});

test("media: a mixed-media site counts once in the overall total", () => {
  const r = RA.computeMedia(deepFreeze([site("3", [["Hoarding", "Chennai"], ["Pole Board", "Chennai"]], { createdAt: at(2026, 6) })]), fy());
  assert.equal(r.summary.total, 1);
  assert.equal(bucket(r, "2026-07").total, 1);
});

test("media: a mixed-media site matches each applicable type filter once per result", () => {
  const docs = deepFreeze([site("3", [["Hoarding", "Chennai"], ["Hoarding", "Chennai"], ["Pole Board", "Chennai"]], { createdAt: at(2026, 6) })]);
  for (const mediaType of ["Hoarding", "Pole Board"]) {
    const r = RA.computeMedia(docs, fy({ mediaType }));
    assert.equal(r.summary.total, 1, mediaType);
    assert.equal(bucket(r, "2026-07").total, 1, mediaType);
    reconciles(r);
  }
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Unipole" })).summary.total, 0);
});

test("media: several sites in the same month are all counted", () => {
  assert.equal(bucket(RA.computeMedia(mediaDocs(), fy()), "2026-06").total, 2); // sites 1 and 2
});

test("media: sites in different months land in the right buckets", () => {
  assert.deepEqual(monthly(RA.computeMedia(mediaDocs(), fy())), { "2026-06": 2, "2026-07": 2, "2026-08": 1 });
});

test("media: monthly counts reconcile with summary.total (unfiltered and filtered)", () => {
  for (const body of [{}, { mediaType: "Hoarding" }, { mediaType: "Pole Board" }, { city: "Chennai" }, { mediaType: "Hoarding", city: "Madurai" }]) {
    reconciles(RA.computeMedia(mediaDocs(), fy(body)));
  }
  assert.equal(RA.computeMedia(mediaDocs(), fy()).summary.total, 5);
});

test("media: media type and city filters work together on the same face", () => {
  const docs = mediaDocs();
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding" })).summary.total, 4); // sites 1,2,3,5
  assert.equal(RA.computeMedia(docs, fy({ city: "Madurai" })).summary.total, 2); // sites 4,5
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Pole Board", city: "Madurai" })).summary.total, 1); // site 4 only
  assert.deepEqual(monthly(RA.computeMedia(docs, fy({ mediaType: "Pole Board", city: "Madurai" }))), { "2026-07": 1 });
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding", city: "Madurai" })).summary.total, 1); // site 5
});

test("media: sites outside the financial year or custom range are excluded", () => {
  const docs = mediaDocs();
  assert.equal(RA.computeMedia(docs, fy({ fy: 2025 })).summary.total, 1); // site 6 only (31 Mar 2026)
  const custom = RA.computeMedia(docs, RA.parseFilters({ startDate: "2026-07-01", endDate: "2026-07-31" }, NOW).filters);
  assert.equal(custom.summary.total, 2);
  assert.equal(custom.buckets.length, 31);
  reconciles(custom);
});

test("media: missing or invalid createdAt is reported, never given a date", () => {
  const docs = mediaDocs();
  const r = RA.computeMedia(docs, fy());
  assert.equal(r.meta.sitesWithoutOnboardingDate, 2);
  assert.equal(r.summary.total, 5);
  // metadata honours filters: both undated sites are Hoarding / Chennai
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Pole Board" })).meta.sitesWithoutOnboardingDate, 0);
  assert.equal(RA.computeMedia(docs, fy({ city: "Chennai" })).meta.sitesWithoutOnboardingDate, 2);
});

test("media: a site without faces counts once unfiltered and never under a filter", () => {
  const docs = deepFreeze([{ _id: "x", mediaDetails: [], createdAt: at(2026, 5) }]);
  assert.equal(RA.computeMedia(docs, fy()).summary.total, 1);
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Hoarding" })).summary.total, 0);
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

// ── GST ───────────────────────────────────────────────────────────────────
test("GST: Hold / Paid / Unpaid / Future stay distinct and are not double counted", () => {
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
      { _id: "b1", dueDate: new Date(Date.UTC(2026, 4, 1)), gstAmount: 180 },
      { _id: "f1", dueDate: new Date(Date.UTC(2026, 11, 1)), gstAmount: 200 },
      { _id: "f2", dueDate: new Date(Date.UTC(2026, 11, 1)), gstAmount: 300, gstAddedToBalance: true },
      { _id: "f3", dueDate: new Date(Date.UTC(2026, 8, 1)), gstAmount: 700 },
    ],
  })]);
  const r = RA.computeGst(docs, fy(), NOW);
  assert.equal(r.summary.paid.amount, 270);
  assert.equal(r.summary.hold.amount, 280);
  assert.equal(r.summary.unpaid.amount, 250);
  assert.equal(r.summary.future.amount, 200);
  assert.equal(bucket(r, "2026-08").paid.amount, 270);
  assert.equal(bucket(r, "2026-06").paid.amount, 0);
  assert.equal(bucket(r, "2026-05").hold.amount, 180);
});

// ── TDS ───────────────────────────────────────────────────────────────────
test("TDS: tdsBalanceHistory only; tdsAmount not added to paidAmount; duplicates collapse; owner standing amounts ignored", () => {
  const row = (o) => ({ landOwnerId: "o1", dueMonth: "June 2026", tdsAmount: 100, paidAmount: 100, paidAt: new Date(Date.UTC(2026, 5, 20)), ...o });
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
