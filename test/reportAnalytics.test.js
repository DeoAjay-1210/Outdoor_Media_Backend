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

test("bills: genuine site-level rows (no face / stale face id) keep site-level classification from ACTIVE faces", () => {
  const docs = deepFreeze([
    // no mediaDetailId on a multi-type site: genuinely site-level -> Mixed types, excluded from type filters
    { _id: "A", mediaDetails: [billFace("a1", "Hoarding"), billFace("a2", "Unipole")], rentalDue: [faceBill(null, 70)] },
    // stale face id (face re-created) on a single-type site -> that type (the 52 real rows are all like this)
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
    Unipole: { bills: 1, amount: 30 },
    Hoarding: { bills: 1, amount: 20 },
    Digital: { bills: 1, amount: 10 },
    "Wall Graphics": { bills: 1, amount: 5 },
  });
  const hoarding = RA.computeBills(docs, fy({ mediaType: "Hoarding" }));
  assert.equal(hoarding.summary.total, 20);
  assert.deepEqual(hoarding.meta.excludedMixedSites, { sites: 1, amount: 70 }); // only the genuinely mixed site-level row
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
  assert.equal(RA.computeMedia(docs, fy({ mediaType: "Wall Hoarding" })).summary.total, 1);
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
    appraisal: { rentalMaster: ["appraisal", "mediaDetails"] },
    bills: { rentalMaster: ["mediaDetails", "rentalDue"] },
    gst: {
      ledger: ["appraisal", "gstApplicableFlag", "gstBalanceHistory", "landOwners", "ledger", "ledgerHistory", "mediaDetails", "rentalDue", "rentalPayment"],
      rentalMaster: ["mediaDetails", "rentalDue", "rentalPayment"],
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
