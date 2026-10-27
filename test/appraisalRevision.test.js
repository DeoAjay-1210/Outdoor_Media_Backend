// Appraisal amount revisions. Synthetic fixtures only — no database connection is made by this file.
// The update-flow tests run the REAL handleAppraisalLogic / recordAppraisalRevision of the onboarding controller (clock = now), the
// analytics tests run the REAL computeAppraisal.
const test = require("node:test");
const assert = require("node:assert/strict");
const RA = require("../utils/reportAnalytics");
const AR = require("../utils/appraisalRevision");
const C = require("../controllers/Admin/MediaOnboardingController/MediaOnboardingController");

const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Update-flow scenario (relative to today) ─────────────────────────────────
const today = new Date();
const d = (months, day = 15) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + months, day));
const iso = (v) => new Date(v).toISOString().slice(0, 10);
const row = (date, previousRent, amount, fixedAmount = amount) => ({
  appraisalDate: date, type: 2, percentage: 0, fixedAmount, frequency: 1, customFrequencyMonths: 0,
  previousRent, appraisalAmount: amount, newRent: previousRent + amount, isAnchorEntry: false,
});
const cfg = (fixedAmount) => ({ applicable: 1, type: 2, percentage: 0, fixedAmount, frequency: 1, customFrequencyMonths: 0 });

/** A site with a past applied appraisal, this month's appraisal and the next scheduled one, all at [amount]. */
const siteWith = (amount, { approved = false, rent = 54000, revisionHistory = [], extra = {} } = {}) => {
  const history = [row(d(-12), rent - 2 * amount, amount), row(d(0), rent - amount, amount), row(d(12), rent, amount)];
  return {
    rentalPayment: { totalRentalAmount: rent },
    agreement: { startDate: d(-30), endDate: d(30) },
    rentalDue: approved ? [{ dueDate: d(0, 1), approvalStatus: 3 }] : [{ dueDate: d(0, 1), approvalStatus: 1 }],
    ledgerHistory: [{ year: "2026", months: [{ month: "June", entries: [{ amount: 1000, paymentMode: "Cash" }] }] }],
    appraisal: { ...cfg(amount), currentRent: rent, appraisalAmount: amount, lastAppraisalDate: d(0), nextAppraisalDate: d(12), history, revisionHistory, ...extra },
  };
};

/** One "update the appraisal amount" save, exactly like the update controller: handleAppraisalLogic then recordAppraisalRevision. */
const update = async (existing, nextAppraisal, userName = "tester") => {
  const incoming = {
    rentalPayment: { totalRentalAmount: existing.rentalPayment.totalRentalAmount },
    agreement: existing.agreement,
    appraisal: { lastAppraisalDate: existing.appraisal.lastAppraisalDate, nextAppraisalDate: existing.appraisal.nextAppraisalDate, ...nextAppraisal },
  };
  await C.handleAppraisalLogic(incoming, existing, userName, existing.rentalPayment.totalRentalAmount, false);
  C.recordAppraisalRevision(incoming, existing, userName);
  return incoming;
};
const amounts = (incoming) => incoming.appraisal.history.map((h) => [iso(h.appraisalDate), h.appraisalAmount]);

// quiet the controller's trace logging in this file
const realLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = realLog; });

// ── A. decrease ──────────────────────────────────────────────────────────────
test("A: decrease ₹2,000 → ₹1,000 — new rows use ₹1,000, the past approved row keeps ₹2,000, one revision is recorded", async () => {
  const existing = siteWith(2000, { approved: true });
  const out = await update(existing, { ...cfg(1000), revisionReason: "Updated appraisal rate" });
  assert.deepEqual(amounts(out), [[iso(d(-12)), 2000], [iso(d(0)), 2000], [iso(d(12)), 1000]]);
  assert.equal(Number(out.appraisal.history[2].fixedAmount), 1000, "the rule new rows are built from is now ₹1,000");
  assert.equal(out.appraisal.fixedAmount, 1000, "the site's current amount rule is ₹1,000");
  assert.equal(out.appraisal.revisionHistory.length, 1);
  const r = out.appraisal.revisionHistory[0];
  assert.deepEqual([r.previousFixedAmount, r.newFixedAmount, r.previousAmount, r.newAmount], [2000, 1000, 2000, 1000]);
  assert.equal(r.changedBy, "tester");
  assert.equal(r.reason, "Updated appraisal rate");
  assert.equal(iso(r.effectiveFrom), iso(d(12)), "first row that took the new amount");
  assert.ok(!("revisionReason" in out.appraisal) && !("_revisionMeta" in out.appraisal), "transient fields never persist");
});

// ── B. increase ──────────────────────────────────────────────────────────────
test("B: increase ₹1,000 → ₹3,000 — earlier approved row unchanged, new rows use ₹3,000", async () => {
  const existing = siteWith(1000, { approved: true, rent: 53000 });
  const out = await update(existing, cfg(3000));
  assert.deepEqual(amounts(out).map((x) => x[1]), [1000, 1000, 3000]);
  assert.equal(out.appraisal.revisionHistory.length, 1);
  assert.equal(out.appraisal.revisionHistory[0].newAmount, 3000);
});

// ── C. approved history ──────────────────────────────────────────────────────
test("C: an approved appraisal keeps ₹2,000 and the historical chart does not move", async () => {
  const existing = siteWith(2000, { approved: true });
  const doc = (appraisal) => ({ _id: "s1", mediaDetails: [{ mediaType: "Hoarding", city: "Chennai", mediaName: "Site A", status: 1 }], rentalDue: [{ dueDate: d(-12, 5), approvalStatus: 3 }, ...existing.rentalDue], appraisal });
  const f = RA.parseFilters({ startDate: iso(d(-18)), endDate: iso(d(24)) }, today).filters;
  const key = (m) => `s1|${new Date(m).toISOString().slice(0, 7)}`;
  const payments = paidCycles(key(d(-12)), key(d(0))); // both applied cycles are approved and paid in the Ledger
  const before = RA.computeAppraisal([doc(clone(existing.appraisal))], f, today, { payments });
  const out = await update(existing, cfg(1000));
  const after = RA.computeAppraisal([doc(out.appraisal)], f, today, { payments });
  assert.equal(after.summary.given.amount, before.summary.given.amount, "given (past + this month's approved) is unchanged by the revision");
  assert.equal(after.summary.given.amount, 4000);
  assert.equal(after.summary.upcoming.amount, 1000, "only the not-yet-due row follows the new amount");
  assert.equal(before.summary.upcoming.amount, 2000);
});

// ── D. pending (held) ────────────────────────────────────────────────────────
test("D: rows on hold (pending approval) keep ₹2,000 and their dates; the revision skips them", () => {
  const history = [row(d(0), 52000, 2000), row(d(12), 54000, 2000), row(d(24), 56000, 2000)];
  const ctx = { currentMonthKey: AR.monthKeyOf(today), approvedMonths: new Set(), held: true, holdDate: d(1, 1) };
  const { affected, frozen } = AR.applyConfigToHistory(history, cfg(1000), ctx, { userName: "u", now: today });
  assert.deepEqual(frozen.map((e) => iso(e.appraisalDate)), [iso(d(12)), iso(d(24))], "rows on/after the hold date are frozen");
  assert.deepEqual(affected.map((e) => iso(e.appraisalDate)), [iso(d(0))], "the open current row (before the hold date) takes the rule");
  for (const e of frozen) assert.deepEqual([e.fixedAmount, e.appraisalAmount, e.updatedBy], [2000, 2000, undefined]);
});

test("D2: through the real update flow a held site's upcoming rows are not rewritten", async () => {
  const existing = siteWith(2000, { extra: { appraisalHold: 1, appraisalHoldDate: d(0, 1) } });
  const out = await update(existing, cfg(1000));
  assert.deepEqual(amounts(out).map((x) => x[1]), [2000, 2000, 2000]);
  assert.equal(out.appraisal.revisionHistory.length, 1, "the rule change itself is still recorded");
  assert.equal(out.appraisal.revisionHistory[0].effectiveFrom, null, "…but no row took it");
});

// ── E. multiple revisions ────────────────────────────────────────────────────
test("E: 2,000 → 1,000 → 3,000 — both revisions are kept in order, the rule is 3,000, past rows keep their amounts", async () => {
  const existing = siteWith(2000, { approved: true });
  const first = await update(existing, cfg(1000), "alice");
  // the stored document after the first save, then the second save on top of it
  const stored = clone({ ...existing, appraisal: { ...existing.appraisal, ...first.appraisal } });
  const second = await update(stored, { ...cfg(3000), lastAppraisalDate: stored.appraisal.lastAppraisalDate, nextAppraisalDate: stored.appraisal.nextAppraisalDate }, "bob");
  const hist = second.appraisal.revisionHistory;
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((r) => [r.changedBy, r.previousFixedAmount, r.newFixedAmount]), [["alice", 2000, 1000], ["bob", 1000, 3000]]);
  assert.equal(second.appraisal.fixedAmount, 3000);
  const amts = amounts(second).map((x) => x[1]);
  assert.deepEqual(amts.slice(0, 2), [2000, 2000], "approved / past rows never change across revisions");
  assert.equal(amts[2], 3000, "the new row uses the latest rule");
  assert.ok(new Date(hist[0].changedAt) <= new Date(hist[1].changedAt));
});

test("E2: revisionHistory always comes from the stored document — a client-sent copy cannot drop or forge rows", async () => {
  const kept = [{ changedAt: d(-1), changedBy: "old", reason: "", previousType: 2, previousFixedAmount: 500, newType: 2, newFixedAmount: 2000, previousAmount: 500, newAmount: 2000, effectiveFrom: d(-1) }];
  const existing = siteWith(2000, { approved: true, revisionHistory: kept });
  const out = await update(existing, { ...cfg(2000), revisionHistory: [{ changedBy: "forged" }] }); // no rule change
  assert.equal(out.appraisal.revisionHistory.length, 1);
  assert.equal(out.appraisal.revisionHistory[0].changedBy, "old");
});

test("E3: no revision for a frequency-only edit, for first-time setup, or when the amount is unchanged", async () => {
  const existing = siteWith(2000, { approved: true });
  assert.equal((await update(existing, { ...cfg(2000), frequency: 2 })).appraisal.revisionHistory.length, 0);
  assert.equal((await update(existing, cfg(2000))).appraisal.revisionHistory.length, 0);
  const first = siteWith(2000);
  first.appraisal.applicable = 0;
  assert.equal((await update(first, cfg(1000))).appraisal.revisionHistory.length, 0);
  assert.equal(AR.buildRevision({ previous: cfg(2000), next: cfg(2000), baseRent: 1, changedAt: today }), null);
});

// ── F. payments untouched ────────────────────────────────────────────────────
test("F: a revision never touches payment / ledger / bill data", async () => {
  const existing = siteWith(2000, { approved: true });
  deepFreeze(existing.ledgerHistory);
  deepFreeze(existing.rentalDue);
  const before = clone({ l: existing.ledgerHistory, r: existing.rentalDue, rent: existing.rentalPayment });
  const out = await update(existing, cfg(1000));
  assert.deepEqual(clone({ l: existing.ledgerHistory, r: existing.rentalDue, rent: existing.rentalPayment }), before);
  for (const k of ["ledgerHistory", "rentalDue"]) assert.equal(out[k], undefined, `${k} is not part of what the revision writes`);
});

// ── G / H / I. Report Analytics (summary cards, popup data, filters) ─────────
const paidCycles = (...keys) => new Map(keys.map((k) => [k, { due: 1000, unpaid: 0 }])); // Ledger payment evidence per "siteId|YYYY-MM"
const NOW = new Date(Date.UTC(2026, 9, 21));
const fy = (body = {}) => RA.parseFilters({ fy: 2026, ...body }, NOW).filters;
const aRow = (date, amount, extra = {}) => ({ appraisalDate: new Date(date), appraisalAmount: amount, previousRent: 50000, newRent: 50000 + amount, type: 2, ...extra });
const rev = (changedAt, prev, next, extra = {}) => ({
  changedAt: new Date(changedAt), changedBy: "alice", reason: "Updated appraisal rate", previousType: 2, newType: 2,
  previousFixedAmount: prev, newFixedAmount: next, previousAmount: prev, newAmount: next, baseRent: 50000, effectiveFrom: new Date("2026-11-01"), ...extra,
});
// the bills of the months whose appraisals have been applied (approved): only an approved bill makes an appraisal "given"
const approvedIn = (...months) => months.map((m) => ({ dueDate: new Date(`${m}-05`), approvalStatus: 3 }));
const doc = (id, city, appraisal, bills = []) => ({ _id: id, mediaDetails: [{ mediaType: "Hoarding", city, mediaName: `Site ${id}`, status: 1 }], rentalDue: bills, appraisal });
const PAID = paidCycles("1|2026-05", "1|2026-09", "2|2026-06", "3|2026-06", "9|2026-06");
const fixtures = () => deepFreeze([
  doc("1", "Chennai", {
    applicable: 1, appraisalHold: 0,
    history: [aRow("2026-05-01", 2000), aRow("2026-09-01", 2000), aRow("2026-11-01", 1000), aRow("2027-02-01", 1000)],
    revisionHistory: [rev("2026-10-05", 2000, 1000)],
  }, approvedIn("2026-05", "2026-09")),
  doc("2", "Madurai", {
    applicable: 1, appraisalHold: 0,
    history: [aRow("2026-06-01", 1000), aRow("2026-12-01", 3000)],
    revisionHistory: [rev("2026-07-10", 2000, 1000, { effectiveFrom: new Date("2026-08-01") }), rev("2026-10-12", 1000, 3000, { effectiveFrom: new Date("2026-12-01") })],
  }, approvedIn("2026-06")),
  doc("3", "Chennai", { applicable: 1, appraisalHold: 0, history: [aRow("2026-06-01", 500)], revisionHistory: [] }, approvedIn("2026-06")),
]);

test("G: cards — given/held/upcoming/total reconcile; changed counts distinct sites and events and is not part of the total", () => {
  const r = RA.computeAppraisal(fixtures(), fy(), NOW, { payments: PAID });
  const { given, upcoming, held, total, changed } = r.summary;
  assert.deepEqual([given.amount, upcoming.amount, held.amount], [2000 + 2000 + 1000 + 500, 1000 + 1000 + 3000, 0]);
  assert.equal(total.amount, given.amount + upcoming.amount + held.amount, "no double count");
  assert.equal(total.entries, given.entries + upcoming.entries + held.entries);
  assert.deepEqual(changed, { sites: 2, revisions: 3 }, "site 2 revised twice → one site, two events");
  assert.equal(r.buckets.reduce((s, b) => s + b.changed.revisions, 0), 3);
  assert.equal(r.buckets.find((b) => b.key === "2026-10").changed.sites, 2);
  assert.equal(r.buckets.find((b) => b.key === "2026-07").changed.revisions, 1);
});

test("G2: amounts come from the stored rows — a different current rule cannot change them", () => {
  const docs = fixtures();
  const a = RA.computeAppraisal(docs, fy(), NOW, { payments: PAID });
  const changedRule = clone(docs);
  changedRule[0].appraisal.fixedAmount = 99999;
  changedRule[0].appraisal.type = 2;
  const b = RA.computeAppraisal(deepFreeze(changedRule), fy(), NOW, { payments: PAID });
  assert.deepEqual(b.summary.total, a.summary.total);
});

test("H: popup data — each revision with previous / new amount, time, user, reason, effective date and its number", () => {
  const r = RA.computeAppraisal(fixtures(), fy({ details: "true" }), NOW, { payments: PAID });
  assert.equal(r.revisions.length, 3);
  const s2 = r.revisions.filter((x) => x.siteName === "Site 2");
  assert.deepEqual(s2.map((x) => [x.revisionNumber, x.siteRevisionCount, x.previousAmount, x.newAmount, x.effectiveFrom]), [[1, 2, 2000, 1000, "2026-08-01"], [2, 2, 1000, 3000, "2026-12-01"]]);
  const one = r.revisions.find((x) => x.siteName === "Site 1");
  assert.equal(one.changedAt, "2026-10-05T00:00:00.000Z");
  assert.deepEqual([one.changedBy, one.reason, one.previousType, one.newType, one.date], ["alice", "Updated appraisal rate", "fixed", "fixed", "2026-10-05"]);
  // rows: only rows that took a revised rule are flagged; earlier rows keep their amount and carry no Changed flag
  const rows = r.records.filter((x) => x.siteName === "Site 1");
  assert.deepEqual(rows.map((x) => [x.date, x.amount, x.changed]), [["2026-05-01", 2000, false], ["2026-09-01", 2000, false], ["2026-11-01", 1000, true], ["2027-02-01", 1000, true]]);
  assert.equal(r.records.find((x) => x.siteName === "Site 3").changed, false, "no Changed indicator on unrelated records");
  assert.equal(r.records.every((x) => x.kind !== "changed"), true, "a revision is not an appraisal row");
  assert.equal(RA.computeAppraisal(fixtures(), fy(), NOW, { payments: PAID }).revisions, undefined, "popup data only when details are asked for");
});

test("I: filters — period and site filters apply to revisions too; stored amounts stay as stored", () => {
  // period: only the July revision of site 2
  const jul = RA.computeAppraisal(fixtures(), RA.parseFilters({ startDate: "2026-07-01", endDate: "2026-07-31" }, NOW).filters, NOW, { payments: PAID });
  assert.deepEqual(jul.summary.changed, { sites: 1, revisions: 1 });
  // city filter
  const madurai = RA.computeAppraisal(fixtures(), fy({ city: "Madurai" }), NOW, { payments: PAID });
  assert.deepEqual(madurai.summary.changed, { sites: 1, revisions: 2 });
  assert.equal(madurai.summary.given.amount, 1000);
  assert.equal(madurai.summary.upcoming.amount, 3000);
  const none = RA.computeAppraisal(fixtures(), RA.parseFilters({ startDate: "2025-01-01", endDate: "2025-01-31" }, NOW).filters, NOW, { payments: PAID });
  assert.deepEqual(none.summary.changed, { sites: 0, revisions: 0 });
});

test("a site without revisions behaves exactly as before (changed = 0, same response shape plus the new fields)", () => {
  const docs = deepFreeze([doc("9", "Chennai", { applicable: 1, appraisalHold: 0, history: [aRow("2026-06-01", 700)] }, approvedIn("2026-06"))]);
  const r = RA.computeAppraisal(docs, fy(), NOW, { payments: PAID });
  assert.deepEqual(r.summary.given, { sites: 1, amount: 700, entries: 1 });
  assert.deepEqual(r.summary.changed, { sites: 0, revisions: 0 });
});
