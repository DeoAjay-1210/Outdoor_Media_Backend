/**
 * Report Analytics — pure, read-only aggregation helpers.
 *
 * Nothing in this file touches the database or mutates its inputs; every
 * function takes already-loaded (lean) MediaOnboarding documents and returns
 * plain objects. See docs/REPORT_ANALYTICS.md for the verified field mappings
 * and the documented limitations.
 *
 * Date convention: stored dates are read with UTC getters. The codebase stores
 * many timestamps as "IST wall-clock in a UTC Date" (nowIST()), so UTC getters
 * give the calendar day/month users see. "Today" uses the same convention.
 */

const IST_OFFSET_MS = 330 * 60000;
const MS_DAY = 86400000;
const MIXED = "__mixed__";
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MAX_SPAN_DAYS = 366 * 5;
// Data source filter. "rentalMaster" = Rental Master records (bills, landowner
// configuration, the Rental Master cycle calculation); "ledger" = recorded
// ledger rows (ledgerHistory, gstBalanceHistory, tdsBalanceHistory).
const SOURCES = ["rentalMaster", "ledger"];
const DEFAULT_SOURCE = "rentalMaster";
const DAY_GRANULARITY_MAX_DAYS = 62;

const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toDate = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const pad = (n) => String(n).padStart(2, "0");
const monthKeyOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const dayKeyOf = (d) => `${monthKeyOf(d)}-${pad(d.getUTCDate())}`;
const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const idOf = (v) => (v === null || v === undefined ? "" : String(v));
const text = (v) => (typeof v === "string" ? v.trim() : "");
/**
 * Media type as compared everywhere (faces, bills, filter options, the filter
 * value): trimmed with inner whitespace collapsed. Case is kept on purpose —
 * distinct stored values are listed separately (see docs).
 */
const mediaTypeText = (v) => text(v).replace(/\s+/g, " ");

// ── Filters ────────────────────────────────────────────────────────────────

/** Financial year N runs 1 Apr N → 31 Mar N+1. */
const fyBounds = (startYear) => ({
  start: new Date(Date.UTC(startYear, 3, 1)),
  end: new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999)),
});
const currentFyStartYear = (now) => (now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

const parseYmd = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
};

/**
 * Validates the request filters. Returns { error } or
 * { filters: { start, end, granularity, mediaType, city, fy } }.
 * Body: { fy?: 2026, startDate?: "YYYY-MM-DD", endDate?: "YYYY-MM-DD", mediaType?, city? }
 * A custom range wins over fy; with neither, the current financial year is used.
 */
const parseFilters = (input = {}, now = nowIST()) => {
  const body = input || {};
  let start;
  let end;
  let fy = null;
  const hasCustom = body.startDate || body.endDate;
  if (hasCustom) {
    const s = parseYmd(body.startDate);
    const e = parseYmd(body.endDate);
    if (!s || !e) return { error: "startDate and endDate must both be valid YYYY-MM-DD dates" };
    if (e < s) return { error: "endDate must be on or after startDate" };
    start = s;
    end = new Date(e.getTime() + MS_DAY - 1);
  } else {
    fy = body.fy === undefined || body.fy === null || body.fy === "" ? currentFyStartYear(now) : Number(body.fy);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) return { error: "fy must be a four-digit financial-year start year" };
    ({ start, end } = fyBounds(fy));
  }
  const spanDays = Math.floor((end.getTime() - start.getTime()) / MS_DAY) + 1;
  if (spanDays > MAX_SPAN_DAYS) return { error: "Selected period is too long (maximum 5 years)" };
  const pick = (v, norm = text) => {
    const t = norm(v);
    return t && t.toLowerCase() !== "all" ? t : "";
  };
  const source = body.source === undefined || body.source === null || body.source === "" ? DEFAULT_SOURCE : body.source;
  if (!SOURCES.includes(source)) return { error: `source must be one of: ${SOURCES.join(", ")}` };
  return {
    filters: {
      fy,
      start,
      end,
      granularity: spanDays <= DAY_GRANULARITY_MAX_DAYS ? "day" : "month",
      mediaType: pick(body.mediaType, mediaTypeText),
      city: pick(body.city),
      source,
    },
  };
};

const publicFilters = (f) => ({
  source: f.source || DEFAULT_SOURCE,
  fy: f.fy,
  startDate: dayKeyOf(f.start),
  endDate: dayKeyOf(f.end),
  granularity: f.granularity,
  mediaType: f.mediaType || null,
  city: f.city || null,
});

// ── Buckets ────────────────────────────────────────────────────────────────

const bucketKey = (d, granularity) => (granularity === "day" ? dayKeyOf(d) : monthKeyOf(d));
const inRange = (d, f) => d >= f.start && d <= f.end;

/** Continuous, zero-filled bucket list for the selected period. */
const buildBuckets = (f, make) => {
  const out = new Map();
  if (f.granularity === "day") {
    for (let t = startOfUtcDay(f.start).getTime(); t <= f.end.getTime(); t += MS_DAY) out.set(dayKeyOf(new Date(t)), make());
  } else {
    let y = f.start.getUTCFullYear();
    let m = f.start.getUTCMonth();
    const ey = f.end.getUTCFullYear();
    const em = f.end.getUTCMonth();
    while (y < ey || (y === ey && m <= em)) {
      out.set(`${y}-${pad(m + 1)}`, make());
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
  }
  return out;
};

// ── Site attributes (media type / city) ────────────────────────────────────

const faceList = (doc) => (Array.isArray(doc.mediaDetails) ? doc.mediaDetails.filter(Boolean) : []);
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/**
 * A site (document) holds one or more faces. Money is stored per site, never
 * per face, so a site-level amount can be tied to a media type / city ONLY when
 * all of its faces agree. Otherwise it is "mixed" and is excluded from any
 * filtered view (and reported in meta) instead of being split by guesswork.
 */
const siteAttr = (doc) => {
  const faces = faceList(doc);
  const types = uniq(faces.map((fc) => mediaTypeText(fc.mediaType)));
  const cities = uniq(faces.map((fc) => text(fc.city)));
  return {
    mediaType: types.length === 1 ? types[0] : types.length === 0 ? null : MIXED,
    city: cities.length === 1 ? cities[0] : cities.length === 0 ? null : MIXED,
  };
};

const siteName = (doc) => {
  const names = uniq(faceList(doc).map((fc) => text(fc.mediaName) || text(fc.mediaCode)));
  if (!names.length) return "Unnamed site";
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
};

/** Tracks sites dropped from filtered views because their faces disagree. */
const newExclusions = () => ({ sites: new Set(), amount: 0 });

/** @returns true when the site passes the media-type/city filter. */
const siteMatches = (doc, attr, f, excl, amount = 0) => {
  const needType = f.mediaType;
  const needCity = f.city;
  if (!needType && !needCity) return true;
  const mixed = (needType && attr.mediaType === MIXED) || (needCity && attr.city === MIXED);
  if (mixed) {
    if (excl) {
      excl.sites.add(idOf(doc._id));
      excl.amount += amount;
    }
    return false;
  }
  if (needType && attr.mediaType !== needType) return false;
  if (needCity && attr.city !== needCity) return false;
  return true;
};

const typeLabel = (attr) => (attr.mediaType === MIXED ? "Mixed types" : attr.mediaType || "Unspecified");

const exclusionMeta = (excl) => ({ sites: excl.sites.size, amount: r2(excl.amount) });

const topList = (map, n = 5) =>
  [...map.values()].sort((a, b) => b.amount - a.amount).slice(0, n).map((x) => ({ name: x.name, amount: r2(x.amount) }));

// ── Filter options ─────────────────────────────────────────────────────────

/** Distinct, trimmed (case-preserving, NOT merged) face values. */
const computeFilterOptions = (docs, now = nowIST()) => {
  const types = new Set();
  const cities = new Set();
  let earliest = null;
  for (const doc of docs) {
    for (const fc of faceList(doc)) {
      if (mediaTypeText(fc.mediaType)) types.add(mediaTypeText(fc.mediaType));
      if (text(fc.city)) cities.add(text(fc.city));
    }
    const c = toDate(doc.createdAt);
    if (c && (!earliest || c < earliest)) earliest = c;
  }
  const cur = currentFyStartYear(now);
  const first = earliest ? Math.min(currentFyStartYear(earliest), cur) : cur;
  const years = [];
  for (let y = cur + 1; y >= Math.max(first, cur - 9); y--) years.push(y);
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b));
  return { mediaTypes: sort(types), cities: sort(cities), financialYears: years, currentFinancialYear: cur };
};

// ── Chart 1 — Payments ─────────────────────────────────────────────────────

/**
 * Source: ledgerHistory (append-only archive). Every ledger-save writes the
 * payment to the live `ledger` / `withGst1Ledger` AND appends it to
 * `ledgerHistory`; the live arrays are cleared when the cycle advances. Reading
 * the live arrays as well would therefore double-count, so they are ignored.
 * A re-save of the same owner+mode+bill upserts the live row but appends a new
 * history row, so history rows are de-duplicated (latest wins).
 */
const computePayments = (docs, f) => {
  const buckets = buildBuckets(f, () => ({ total: 0, cash: 0, online: 0, gstPayments: 0, entries: 0, sites: new Set() }));
  const excl = newExclusions();
  const meta = { entriesWithoutAmount: 0, entriesWithoutDate: 0, duplicatesIgnored: 0 };
  const allSites = new Set();
  let total = 0;
  let cash = 0;
  let online = 0;
  let gstPayments = 0;
  let entries = 0;

  for (const doc of docs) {
    const attr = siteAttr(doc);
    const seen = new Map();
    for (const yb of doc.ledgerHistory || []) {
      for (const mb of (yb && yb.months) || []) {
        for (const e of (mb && mb.entries) || []) {
          if (!e) continue;
          const mode = e.paymentMode;
          if (mode !== "Cash" && mode !== "Online") continue;
          const key = [
            idOf(e.landOwnerId), mode, num(e.withGst), idOf(e.rentalDueId),
            text(e.month) || `${yb.year}-${mb.month}`, e.index ?? "",
          ].join("|");
          const prev = seen.get(key);
          if (prev) {
            meta.duplicatesIgnored += 1;
            const pu = toDate(prev.updatedAt)?.getTime() ?? 0;
            const eu = toDate(e.updatedAt)?.getTime() ?? 0;
            if (eu >= pu) seen.set(key, e);
          } else {
            seen.set(key, e);
          }
        }
      }
    }
    for (const e of seen.values()) {
      const d = toDate(e.date);
      if (!d) { meta.entriesWithoutDate += 1; continue; }
      if (!inRange(d, f)) continue;
      const amount = num(e.amount);
      if (amount <= 0) { meta.entriesWithoutAmount += 1; continue; }
      if (!siteMatches(doc, attr, f, excl, amount)) continue;
      const b = buckets.get(bucketKey(d, f.granularity));
      if (!b) continue;
      b.total += amount;
      b.entries += 1;
      b.sites.add(idOf(doc._id));
      if (e.paymentMode === "Cash") b.cash += amount; else b.online += amount;
      if (num(e.withGst) === 1) b.gstPayments += amount;
      total += amount;
      entries += 1;
      if (e.paymentMode === "Cash") cash += amount; else online += amount;
      if (num(e.withGst) === 1) gstPayments += amount;
      allSites.add(idOf(doc._id));
    }
  }

  const list = [...buckets].map(([key, b]) => ({
    key, total: r2(b.total), cash: r2(b.cash), online: r2(b.online), gstPayments: r2(b.gstPayments),
    entries: b.entries, sites: b.sites.size,
  }));
  const peak = list.reduce((m, b) => (b.total > (m?.total ?? 0) ? b : m), null);
  return {
    filters: publicFilters(f),
    buckets: list,
    summary: { total: r2(total), cash: r2(cash), online: r2(online), gstPayments: r2(gstPayments), entries, sites: allSites.size, peakKey: peak ? peak.key : null },
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

// ── Chart 1 (cards) — amount due / unpaid for the period ────────────────────

/**
 * Period-specific "to be paid" and "unpaid" for the Payment cards. It REUSES the
 * ledger's authoritative per-month calculation (getOverallSummaryForCycle — the
 * same function Rental Master / the dashboard use) for every bill cycle whose month
 * is inside the period, so the numbers reconcile with Rental Master by construction.
 *
 * For each cycle month in [start, min(end, today)] of a site that has an active face:
 *   target rent  = currentMonthRentalAmount          (owner shares, appraisal-aware)
 *   target GST   = currentMonthGstAmount
 *   - bill is direct GST (withGst 2): the GST is paid WITH the rent → "rent + direct GST"
 *   - otherwise (withGst 0 or 1, or no bill row with GST expected): the GST is held and
 *     paid after the landlord's receipt → "hold GST" (the cycle's EXPECTED GST)
 *   unpaid rent + direct GST = currentMonthRentPending
 *   unpaid hold GST          = currentMonthGstPending  (= expected GST minus paid
 *     gstBalanceHistory rows for that month; recorded rows are netted, never added on
 *     top of the expected amount, so nothing is counted twice)
 * Future months are not yet due: never projected.
 *
 * Opening balances (pre-onboarding debt) are added once, by dueMonth: unpaid rent rows
 * to "rent + direct GST", GST rows (gstOutstandingHistory) to "hold GST"; paid = isPaid
 * or a UTR, as in the ledger. They sit before the first bill cycle so they never overlap.
 *
 * "Amount paid" on the chart is cash received by payment date and need NOT equal
 * toBePaid - unpaid (payments in a period can settle earlier cycles).
 *
 * @param lib { getAllDueCycles, getOverallSummaryForCycle, resolveExpectedGstForCycle,
 *              mediaAsOfDate } — the ledger's helpers.
 */
/**
 * Direct (withGst 2: GST paid with the rent) vs hold (withGst 0/1 or none) for a
 * bill cycle — the ledger's own rule: the cycle's best-matching rentalDue
 * (approved first, then latest updated), else hold when GST is expected.
 */
const isDirectGstCycle = (doc, cycleDate, lib) => {
  const label = `${MONTH_NAMES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;
  const bill = (doc.rentalDue || [])
    .filter((d) => d && d.dueMonth === label)
    .sort((a, b) => {
      const sA = num(a.approvalStatus);
      const sB = num(b.approvalStatus);
      if (sA === 3 && sB !== 3) return -1;
      if (sB === 3 && sA !== 3) return 1;
      return (toDate(b.updatedAt)?.getTime() ?? 0) - (toDate(a.updatedAt)?.getTime() ?? 0);
    })[0];
  const expected = lib.resolveExpectedGstForCycle(lib.mediaAsOfDate(doc, cycleDate));
  const withGst = bill && bill.withGst !== undefined && bill.withGst !== null ? bill.withGst : (expected > 0 ? 1 : 0);
  return num(withGst) === 2;
};

const computePeriodDue = (docs, f, lib, now = nowIST()) => {
  const excl = newExclusions();
  const meta = { cyclesCounted: 0, openingRowsWithoutDate: 0 };
  const zero = () => ({ toBePaid: 0, unpaid: 0 });
  const acc = { rentDirect: zero(), hold: zero(), openingRent: zero(), openingGst: zero() };
  const sites = new Set();
  const unpaidSites = new Set();
  // monthly view of the same figures (by bill-cycle / opening-due month)
  const months = buildBuckets({ ...f, granularity: "month" }, () => ({ toBePaid: 0, unpaid: 0, sites: new Set(), unpaidSites: new Set() }));
  const addMonth = (d, sid, toBePaid, unpaid) => {
    const m = months.get(monthKeyOf(d));
    if (!m) return;
    m.toBePaid += toBePaid;
    m.unpaid += unpaid;
    m.sites.add(sid);
    if (unpaid > 0) m.unpaidSites.add(sid);
  };
  const startKey = f.start.getUTCFullYear() * 12 + f.start.getUTCMonth();
  const capEnd = f.end < now ? f.end : now; // never beyond the current month
  const capKey = capEnd.getUTCFullYear() * 12 + capEnd.getUTCMonth();
  const inPeriod = (d) => {
    const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
    return k >= startKey && d <= f.end;
  };
  const isPaidRow = (o) => !!(o.isPaid || text(o.utrNumber));

  for (const doc of docs) {
    if (!faceList(doc).some((fc) => num(fc.status) === 1)) continue; // the ledger skips sites with no active face
    const attr = siteAttr(doc);
    const tmp = newExclusions();
    if (!siteMatches(doc, attr, f, tmp)) { tmp.sites.forEach((x) => excl.sites.add(x)); continue; }
    const sid = idOf(doc._id);

    // opening balances
    const addOpening = (rows, amountField, bucket, hold) => {
      for (const o of rows || []) {
        if (!o) continue;
        const amount = num(o[amountField]);
        if (amount <= 0) continue;
        const d = parseMonthLabel(o.dueMonth);
        if (!d) { meta.openingRowsWithoutDate += 1; continue; }
        if (!inPeriod(d)) continue;
        bucket.toBePaid += amount;
        (hold ? acc.hold : acc.rentDirect).toBePaid += amount;
        sites.add(sid);
        addMonth(d, sid, amount, isPaidRow(o) ? 0 : amount);
        if (!isPaidRow(o)) {
          bucket.unpaid += amount;
          (hold ? acc.hold : acc.rentDirect).unpaid += amount;
          unpaidSites.add(sid);
        }
      }
    };
    const rp = doc.rentalPayment || {};
    addOpening(rp.rentalOutstandingHistory, "baseRentOutstandingAmount", acc.openingRent, false);
    addOpening(rp.gstOutstandingHistory, "gstOutStandingAmount", acc.openingGst, true);

    // bill cycles in the period
    const cycles = lib.getAllDueCycles(doc, { year: capEnd.getUTCFullYear(), month: capEnd.getUTCMonth() + 1 });
    const seen = new Set();
    for (const cycleDate of cycles) {
      const ck = cycleDate.getUTCFullYear() * 12 + cycleDate.getUTCMonth();
      if (ck < startKey || ck > capKey || seen.has(ck)) continue;
      seen.add(ck);
      const s = lib.getOverallSummaryForCycle(doc, { year: cycleDate.getUTCFullYear(), month: cycleDate.getUTCMonth() + 1 });
      const rentTarget = num(s.currentMonthRentalAmount);
      const gstTarget = num(s.currentMonthGstAmount);
      if (rentTarget <= 0 && gstTarget <= 0) continue;

      const direct = isDirectGstCycle(doc, cycleDate, lib);

      acc.rentDirect.toBePaid += rentTarget + (direct ? gstTarget : 0);
      acc.hold.toBePaid += direct ? 0 : gstTarget;
      acc.rentDirect.unpaid += num(s.currentMonthRentPending);
      acc.hold.unpaid += num(s.currentMonthGstPending);
      meta.cyclesCounted += 1;
      sites.add(sid);
      addMonth(cycleDate, sid, rentTarget + gstTarget, num(s.currentMonthRentPending) + num(s.currentMonthGstPending));
      if (num(s.currentMonthRentPending) > 0 || num(s.currentMonthGstPending) > 0) unpaidSites.add(sid);
    }
  }
  const part = (p) => ({ toBePaid: r2(p.toBePaid), unpaid: r2(p.unpaid) });
  const due = {
    toBePaid: r2(acc.rentDirect.toBePaid + acc.hold.toBePaid),
    unpaid: r2(acc.rentDirect.unpaid + acc.hold.unpaid),
    sites: sites.size,
    unpaidSites: unpaidSites.size,
    parts: {
      rentDirect: part(acc.rentDirect), // rent + direct GST (opening rent included)
      hold: part(acc.hold), // expected hold GST (opening GST included)
      opening: { rent: part(acc.openingRent), gst: part(acc.openingGst) }, // already inside the two lines above
    },
  };
  const buckets = [...months].map(([key, m]) => ({
    key, toBePaid: r2(m.toBePaid), unpaid: r2(m.unpaid), paid: r2(m.toBePaid - m.unpaid), sites: m.sites.size, unpaidSites: m.unpaidSites.size,
  }));
  return { due, buckets, meta: { ...meta, excludedMixedSites: exclusionMeta(excl) } };
};

/**
 * Payments — source "rentalMaster": the Rental Master cycle calculation only
 * (computePeriodDue, i.e. getOverallSummaryForCycle per bill cycle + onboarding
 * opening balances). Monthly by bill-cycle month; paid = to be paid - unpaid,
 * i.e. the paid status Rental Master itself shows for those cycles. No
 * ledgerHistory payment amounts or payment dates are used. Cycles after today
 * are never projected, so future months stay 0.
 */
const computeRentalMasterPayments = (docs, f, lib, now = nowIST()) => {
  const { due, buckets, meta } = computePeriodDue(docs, f, lib, now);
  const peak = buckets.reduce((m, b) => (b.toBePaid > (m?.toBePaid ?? 0) ? b : m), null);
  return {
    filters: publicFilters({ ...f, granularity: "month" }),
    buckets,
    summary: {
      toBePaid: due.toBePaid, unpaid: due.unpaid, paid: r2(due.toBePaid - due.unpaid),
      dueSites: due.sites, unpaidSites: due.unpaidSites, dueParts: due.parts, peakKey: peak ? peak.key : null,
    },
    meta,
  };
};

/** Adds the period due/unpaid cards to a computePayments result (additive fields only). */
const withPeriodDue = (payments, docs, f, lib, now) => {
  const { due, meta } = computePeriodDue(docs, f, lib, now);
  return {
    ...payments,
    summary: { ...payments.summary, toBePaid: due.toBePaid, unpaid: due.unpaid, dueSites: due.sites, unpaidSites: due.unpaidSites, dueParts: due.parts },
    meta: { ...payments.meta, due: meta },
  };
};

// ── Chart 2 — Sites onboarded ──────────────────────────────────────────────

/**
 * Counts distinct MediaOnboarding documents (sites) by MediaOnboarding.createdAt
 * (never invented). A site is counted once however many faces it has.
 * Filters: with a media type and/or city selected, a site is eligible when at
 * least one single face satisfies every selected filter (type AND city on the
 * same face). With no filter every site is eligible (even one with no faces).
 * `byType` is informational: distinct sites having a (matching) face of each
 * type; a mixed-type site appears under each of its types, so those numbers can
 * overlap and are NOT meant to sum to `total`. Chart values use `total`.
 */
const computeMedia = (docs, f) => {
  const buckets = buildBuckets(f, () => ({ total: 0, byType: {} }));
  const meta = { sitesWithoutOnboardingDate: 0 };
  let total = 0;
  const byType = {};
  const filtered = !!(f.mediaType || f.city);
  for (const doc of docs) {
    const faces = faceList(doc);
    const matching = faces.filter((fc) => {
      if (f.mediaType && mediaTypeText(fc.mediaType) !== f.mediaType) return false;
      if (f.city && text(fc.city) !== f.city) return false;
      return true;
    });
    if (filtered && !matching.length) continue;
    const created = toDate(doc.createdAt);
    if (!created) { meta.sitesWithoutOnboardingDate += 1; continue; }
    if (!inRange(created, f)) continue;
    const b = buckets.get(bucketKey(created, f.granularity));
    if (!b) continue;
    b.total += 1;
    total += 1;
    const types = uniq((filtered ? matching : faces).map((fc) => mediaTypeText(fc.mediaType) || "Unspecified"));
    for (const t of types.length ? types : ["Unspecified"]) {
      b.byType[t] = (b.byType[t] || 0) + 1;
      byType[t] = (byType[t] || 0) + 1;
    }
  }
  const list = [...buckets].map(([key, b]) => ({ key, total: b.total, byType: b.byType }));
  const peak = list.reduce((m, b) => (b.total > (m?.total ?? 0) ? b : m), null);
  return { filters: publicFilters(f), buckets: list, summary: { total, byType, peakKey: peak && peak.total ? peak.key : null }, meta };
};

// ── Chart 3 — Appraisal ────────────────────────────────────────────────────

/**
 * Source: appraisal.history[]. The onboarding/update code pre-schedules future
 * entries (autoScheduleFutureAppraisalEntries), so upcoming obligations are
 * STORED rows — nothing is projected here.
 * - Anchor entries (isAnchorEntry) are rent baselines, not increments → skipped.
 * - given   : appraisalDate <= today
 * - upcoming: appraisalDate  > today
 * - held    : site.appraisal.appraisalHold === 1 and the entry falls on/after the
 *             hold date (no hold date stored → only entries after today).
 * - A site with appraisal.applicable !== 1 is skipped unless it is held (a hold
 *   switches `applicable` off by design).
 */
const computeAppraisal = (docs, f, now = nowIST()) => {
  const mk = () => ({ sites: new Set(), amount: 0, entries: 0 });
  const buckets = buildBuckets(f, () => ({ given: mk(), upcoming: mk(), held: mk() }));
  const excl = newExclusions();
  const meta = { sitesNotApplicable: 0, entriesWithoutDate: 0 };
  const totals = { given: mk(), upcoming: mk(), held: mk() };
  const today = now;

  for (const doc of docs) {
    const ap = doc.appraisal;
    if (!ap || !Array.isArray(ap.history) || !ap.history.length) continue;
    const held = num(ap.appraisalHold) === 1;
    if (num(ap.applicable) !== 1 && !held) { meta.sitesNotApplicable += 1; continue; }
    const holdDate = toDate(ap.appraisalHoldDate);
    const attr = siteAttr(doc);
    for (const h of ap.history) {
      if (!h || h.isAnchorEntry) continue;
      const amount = num(h.appraisalAmount);
      if (amount <= 0) continue;
      const d = toDate(h.appraisalDate);
      if (!d) { meta.entriesWithoutDate += 1; continue; }
      if (!inRange(d, f)) continue;
      if (!siteMatches(doc, attr, f, excl, amount)) continue;
      let kind = d <= today ? "given" : "upcoming";
      if (held && (holdDate ? d >= holdDate : d > today)) kind = "held";
      const b = buckets.get(bucketKey(d, f.granularity));
      if (!b) continue;
      for (const t of [b[kind], totals[kind]]) {
        t.sites.add(idOf(doc._id));
        t.amount += amount;
        t.entries += 1;
      }
    }
  }
  const fin = (t) => ({ sites: t.sites.size, amount: r2(t.amount), entries: t.entries });
  const list = [...buckets].map(([key, b]) => ({ key, given: fin(b.given), upcoming: fin(b.upcoming), held: fin(b.held) }));
  return {
    filters: publicFilters(f),
    buckets: list,
    summary: { given: fin(totals.given), upcoming: fin(totals.upcoming), held: fin(totals.held) },
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

// ── Chart 4 — Generated bills ──────────────────────────────────────────────

const BILL_STATUS = { 1: "Pending", 2: "Partially approved", 3: "Approved", 4: "Overdue" };

/**
 * Media type of ONE bill. rentalDue rows are stored per face (mediaDetailId):
 * a separate-bill face has its own bill, and a single-bill multi-face site
 * stores one row per face holding that face's sqft share of the site bill
 * (RentalDueNew2Controller: computeGstSplit(media, …, faceId, …) /
 * siteBillForOverdue). So a row whose mediaDetailId matches a face takes THAT
 * face's type — whatever other types the site has, and even if the face is
 * inactive now (it was billed for that face).
 * Only a row without a face, or whose mediaDetailId matches no current face
 * (stale ids after a site edit), is classified at site level: the site's ACTIVE
 * faces (all faces if none is active), "mixed" when they disagree.
 * @returns a media type string, MIXED or null (no type at all)
 */
const billMediaType = (doc, bill) => {
  const faces = faceList(doc);
  const face = bill && bill.mediaDetailId ? faces.find((fc) => idOf(fc._id) === idOf(bill.mediaDetailId)) : null;
  const own = face ? mediaTypeText(face.mediaType) : "";
  if (own) return own;
  const active = faces.filter((fc) => num(fc.status) === 1);
  const types = uniq((active.length ? active : faces).map((fc) => mediaTypeText(fc.mediaType)));
  return types.length === 1 ? types[0] : types.length === 0 ? null : MIXED;
};

/**
 * Source: rentalDue[] (bills that already exist). Verified in
 * RentalDueNew2Controller.computeGstSplit: baseAmount = rent + GST (gross),
 * gstAmount = the GST part, netPayable = amount payable to the owner now
 * (rent only for withGst 0/1; rent + GST for withGst 2). Grouped by dueDate.
 * Status labels are the existing approvalStatus meanings; no "paid" state is
 * inferred. No bill is ever generated or updated.
 * Media type (byType and the media-type filter) is per bill — billMediaType;
 * the city filter stays site-level.
 */
const computeBills = (docs, f) => {
  const buckets = buildBuckets(f, () => ({ bills: 0, sites: new Set(), total: 0, gst: 0, payable: 0, byStatus: {}, byType: {} }));
  const excl = newExclusions();
  const meta = { billsWithoutAmount: 0, billsWithoutDueDate: 0 };
  const sum = { bills: 0, sites: new Set(), total: 0, gst: 0, payable: 0, byStatus: {} };
  for (const doc of docs) {
    const attr = siteAttr(doc);
    for (const bill of doc.rentalDue || []) {
      if (!bill) continue;
      const d = toDate(bill.dueDate);
      if (!d) { meta.billsWithoutDueDate += 1; continue; }
      if (!inRange(d, f)) continue;
      const total = num(bill.baseAmount);
      const type = billMediaType(doc, bill);
      if (f.mediaType) {
        if (type === MIXED) { excl.sites.add(idOf(doc._id)); excl.amount += total; continue; }
        if (type !== f.mediaType) continue;
      }
      if (!siteMatches(doc, attr, { ...f, mediaType: "" }, excl, total)) continue; // city: site-level, as before
      if (total <= 0) meta.billsWithoutAmount += 1;
      const b = buckets.get(bucketKey(d, f.granularity));
      if (!b) continue;
      const status = BILL_STATUS[num(bill.approvalStatus ?? bill.status)] || "Unknown";
      const gst = num(bill.gstAmount);
      const payable = num(bill.netPayable);
      b.bills += 1; b.sites.add(idOf(doc._id)); b.total += total; b.gst += gst; b.payable += payable;
      const s = (b.byStatus[status] ||= { bills: 0, amount: 0 });
      s.bills += 1; s.amount += total;
      const tl = typeLabel({ mediaType: type });
      const t = (b.byType[tl] ||= { bills: 0, amount: 0 });
      t.bills += 1; t.amount += total;
      sum.bills += 1; sum.sites.add(idOf(doc._id)); sum.total += total; sum.gst += gst; sum.payable += payable;
      const ss = (sum.byStatus[status] ||= { bills: 0, amount: 0 });
      ss.bills += 1; ss.amount += total;
    }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { bills: v.bills, amount: r2(v.amount) }]));
  const list = [...buckets].map(([key, b]) => ({
    key, bills: b.bills, sites: b.sites.size, total: r2(b.total), gst: r2(b.gst), payable: r2(b.payable),
    byStatus: round(b.byStatus), byType: round(b.byType),
  }));
  return {
    filters: publicFilters(f),
    buckets: list,
    summary: { bills: sum.bills, sites: sum.sites.size, total: r2(sum.total), gst: r2(sum.gst), payable: r2(sum.payable), byStatus: round(sum.byStatus) },
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

// ── Chart 5 — GST ──────────────────────────────────────────────────────────

const parseMonthLabel = (label) => {
  const m = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/.exec(label || "");
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase() || n.slice(0, 3).toLowerCase() === m[1].toLowerCase());
  return idx < 0 ? null : new Date(Date.UTC(Number(m[2]), idx, 1));
};

/**
 * GST by data source (never mixed):
 *
 * source "ledger" — exactly what Ledger Entry shows on its "GST Hold (This Month)"
 * and "GST Hold (Past Months)" cards (LedgerNew2Controller
 * calculateNewOverallLedgerSummary), month by month — see computeLedgerGst.
 *
 * source "rentalMaster" — Rental Master records only:
 *  direct — rentalDue[].gstAmount of generated bills with withGst=2 (GST paid
 *           together with the rent), by due date.
 *  hold   — rentalDue[].gstAmount of generated bills with withGst 0/1 (GST held
 *           until the receipt — the same classification the ledger uses), by due date.
 *  unpaid — rentalPayment.gstOutstandingHistory rows not yet paid (GST dues carried
 *           in at onboarding), less any recorded paymentBreakup, by dueMonth.
 *  Only bills that already exist are counted (future-dated generated bills
 *  included); no cycles are projected. Paid status is not inferred.
 */
const GST_CATEGORIES = { ledger: ["paid", "remaining"], rentalMaster: ["direct", "hold", "unpaid"] };

/**
 * GST — source "ledger": the Ledger Entry GST calculation, per month.
 * Ledger Entry does NOT read gstBalanceHistory as a list of amounts: for every
 * bill cycle it takes the EXPECTED GST of the cycle (resolveExpectedGstForCycle,
 * appraisal-aware; owner GST for direct-GST bills) and marks it paid from the
 * ledger records (gstBalanceHistory rows that are paid or carry a UTR, capped at
 * the expected amount; for direct GST, the owner's rent payment). So a cycle with
 * no gstBalanceHistory row (bill not yet approved/added to the GST balance) still
 * has GST to hold — the reason the old row-only view showed nothing.
 * For each bill-cycle month in the period, up to the current month (Ledger Entry
 * never shows future cycles), the cycle's split values from
 * getOverallSummaryForCycle(doc, cycle month): total / paid / remaining
 * (= splitCurGst*, i.e. "This Month" when that month is the current one).
 * Plus onboarding GST outstanding rows (rentalPayment.gstOutstandingHistory) by
 * their dueMonth, paid = isPaid or a UTR — as Ledger Entry adds them.
 * Sites without an active face are skipped, as in the ledger. Always monthly.
 * Summing every month before the current one reproduces "GST Hold (Past
 * Months)", which covers ALL earlier cycles — pick a range from the first billing
 * month to reconcile; a calendar / financial year shows only its own months.
 */
const computeLedgerGst = (docs, filters, lib, now = nowIST()) => {
  const f = { ...filters, granularity: "month" };
  const mk = () => ({ amount: 0, sites: new Set(), records: 0 });
  const part = () => ({ due: 0, paid: 0, remaining: 0 });
  const buckets = buildBuckets(f, () => ({ paid: mk(), remaining: mk(), parts: { hold: part(), direct: part(), opening: part() } }));
  const totals = { paid: mk(), remaining: mk() };
  const parts = { hold: part(), direct: part(), opening: part() };
  const excl = newExclusions();
  const meta = { cyclesCounted: 0, openingRowsWithoutDate: 0 };
  const startKey = f.start.getUTCFullYear() * 12 + f.start.getUTCMonth();
  const capEnd = f.end < now ? f.end : now; // never beyond the current month
  const capKey = capEnd.getUTCFullYear() * 12 + capEnd.getUTCMonth();
  const add = (sid, d, kind, paid, remaining) => {
    const b = buckets.get(monthKeyOf(d));
    if (!b) return;
    for (const [cat, amount] of [["paid", paid], ["remaining", remaining]]) {
      if (amount <= 0) continue;
      for (const t of [b[cat], totals[cat]]) { t.amount += amount; t.sites.add(sid); t.records += 1; }
    }
    for (const p of [b.parts[kind], parts[kind]]) { p.due += paid + remaining; p.paid += paid; p.remaining += remaining; }
  };

  for (const doc of docs) {
    if (!faceList(doc).some((fc) => num(fc.status) === 1)) continue; // the ledger skips sites with no active face
    const attr = siteAttr(doc);
    const tmp = newExclusions();
    if (!siteMatches(doc, attr, f, tmp)) { tmp.sites.forEach((x) => excl.sites.add(x)); continue; }
    const sid = idOf(doc._id);

    for (const o of (doc.rentalPayment && doc.rentalPayment.gstOutstandingHistory) || []) {
      if (!o) continue;
      const amount = num(o.gstOutStandingAmount);
      if (amount <= 0) continue;
      const d = parseMonthLabel(o.dueMonth);
      if (!d) { meta.openingRowsWithoutDate += 1; continue; }
      const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (k < startKey || k > capKey) continue;
      const paid = !!(o.isPaid || text(o.utrNumber));
      add(sid, d, "opening", paid ? amount : 0, paid ? 0 : amount);
    }

    const cycles = lib.getAllDueCycles(doc, { year: capEnd.getUTCFullYear(), month: capEnd.getUTCMonth() + 1 });
    const seen = new Set();
    for (const cycleDate of cycles) {
      const ck = cycleDate.getUTCFullYear() * 12 + cycleDate.getUTCMonth();
      if (ck < startKey || ck > capKey || seen.has(ck)) continue;
      seen.add(ck);
      const sm = lib.getOverallSummaryForCycle(doc, { year: cycleDate.getUTCFullYear(), month: cycleDate.getUTCMonth() + 1 });
      if (num(sm.splitCurGstTotal) <= 0) continue;
      meta.cyclesCounted += 1;
      add(sid, cycleDate, isDirectGstCycle(doc, cycleDate, lib) ? "direct" : "hold", num(sm.splitCurGstPaid), num(sm.splitCurGstRemaining));
    }
  }
  const fin = (t) => ({ amount: r2(t.amount), sites: t.sites.size, records: t.records });
  const finPart = (p) => ({ due: r2(p.due), paid: r2(p.paid), remaining: r2(p.remaining) });
  const finParts = (ps) => ({ hold: finPart(ps.hold), direct: finPart(ps.direct), opening: finPart(ps.opening) });
  const list = [...buckets].map(([key, b]) => ({ key, paid: fin(b.paid), remaining: fin(b.remaining), due: r2(b.paid.amount + b.remaining.amount), parts: finParts(b.parts) }));
  return {
    filters: publicFilters(f),
    categories: GST_CATEGORIES.ledger,
    buckets: list,
    summary: { paid: fin(totals.paid), remaining: fin(totals.remaining), due: r2(totals.paid.amount + totals.remaining.amount), parts: finParts(parts) },
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

/** GST — source "rentalMaster" (see the definitions above). */
const computeGst = (docs, f) => {
  const cats = GST_CATEGORIES.rentalMaster;
  const mk = () => ({ amount: 0, sites: new Set(), records: 0 });
  const mkAll = () => Object.fromEntries(cats.map((c) => [c, mk()]));
  const buckets = buildBuckets(f, mkAll);
  const excl = newExclusions();
  const totals = mkAll();
  const meta = { recordsWithoutDate: 0 };
  const add = (doc, attr, kind, d, amount) => {
    if (amount <= 0) return;
    if (!d) { meta.recordsWithoutDate += 1; return; }
    if (!inRange(d, f)) return;
    if (!siteMatches(doc, attr, f, excl, amount)) return;
    const b = buckets.get(bucketKey(d, f.granularity));
    if (!b) return;
    for (const t of [b[kind], totals[kind]]) { t.amount += amount; t.sites.add(idOf(doc._id)); t.records += 1; }
  };

  for (const doc of docs) {
    const attr = siteAttr(doc);
    for (const bill of doc.rentalDue || []) {
      if (!bill) continue;
      add(doc, attr, num(bill.withGst) === 2 ? "direct" : "hold", toDate(bill.dueDate), num(bill.gstAmount));
    }
    for (const o of (doc.rentalPayment && doc.rentalPayment.gstOutstandingHistory) || []) {
      if (!o || o.isPaid) continue;
      const settled = (o.paymentBreakup || []).reduce((sum, p) => sum + num(p && p.amount), 0);
      add(doc, attr, "unpaid", parseMonthLabel(o.dueMonth), Math.max(num(o.gstOutStandingAmount) - settled, 0));
    }
  }
  const fin = (t) => ({ amount: r2(t.amount), sites: t.sites.size, records: t.records });
  const finAll = (o) => Object.fromEntries(cats.map((c) => [c, fin(o[c])]));
  const list = [...buckets].map(([key, b]) => ({ key, ...finAll(b) }));
  return {
    filters: publicFilters({ ...f, source: "rentalMaster" }),
    categories: cats,
    buckets: list,
    summary: finAll(totals),
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

// ── Chart 6 — TDS ──────────────────────────────────────────────────────────

/**
 * Source: tdsBalanceHistory[] — ledger-save (withTds=1) upserts ONE row per
 * owner + bill month holding the TDS deducted for that bill (tdsAmount ===
 * paidAmount; they are the same amount and are NOT summed). Each row is an
 * individual deduction, never a running balance. landOwners[].tdsAmount is a
 * standing per-bill figure, not a deduction event, so it is not added.
 * - Only recorded deductions count: rows with isUtrEntry falsy are what the
 *   ledger itself treats as pending/unpaid TDS, so they are skipped (meta).
 * - De-duplicated per owner + bill month (dueMonth normalised, so "Jun 2026"
 *   and "June 2026" collide); latest paidAt/createdAt wins.
 * - Dated by paidAt (the entry date), fallback date, then cycle.
 * - Always bucketed by MONTH, whatever the range length; rows outside the
 *   selected range (also inside a partially covered month) are excluded.
 * Each bucket carries `deductions[]` — the exact rows behind its amount — so a
 * month's breakdown always matches the chart under the same filters.
 */
const computeTds = (docs, filters) => {
  const f = { ...filters, granularity: "month" };
  const buckets = buildBuckets(f, () => ({ amount: 0, sites: new Map(), owners: new Set(), deductions: [] }));
  const excl = newExclusions();
  const meta = { recordsWithoutDate: 0, duplicatesIgnored: 0, pendingIgnored: 0 };
  const allSites = new Set();
  const allOwners = new Set();
  let total = 0;
  let entries = 0;
  const cityLabel = (attr) => (attr.city === MIXED ? "Multiple cities" : attr.city || null);
  for (const doc of docs) {
    const attr = siteAttr(doc);
    const name = siteName(doc);
    const sid = idOf(doc._id);
    const codes = uniq(faceList(doc).map((fc) => text(fc.mediaCode)));
    const seen = new Map();
    for (const t of doc.tdsBalanceHistory || []) {
      if (!t) continue;
      if (!t.isUtrEntry || t.isUtrEntry === "false") { meta.pendingIgnored += 1; continue; }
      const billMonth = parseMonthLabel(t.dueMonth) || toDate(t.cycle);
      const monthPart = billMonth ? monthKeyOf(billMonth) : text(t.dueMonth) || `row:${idOf(t._id)}`;
      const key = `${idOf(t.landOwnerId)}|${monthPart}`;
      const prev = seen.get(key);
      if (prev) {
        meta.duplicatesIgnored += 1;
        const pu = toDate(prev.paidAt || prev.createdAt)?.getTime() ?? 0;
        const tu = toDate(t.paidAt || t.createdAt)?.getTime() ?? 0;
        if (tu >= pu) seen.set(key, t);
      } else {
        seen.set(key, t);
      }
    }
    for (const t of seen.values()) {
      const amount = num(t.tdsAmount);
      if (amount <= 0) continue;
      const d = toDate(t.paidAt) || toDate(t.date) || toDate(t.cycle);
      if (!d) { meta.recordsWithoutDate += 1; continue; }
      if (!inRange(d, f)) continue;
      if (!siteMatches(doc, attr, f, excl, amount)) continue;
      const b = buckets.get(monthKeyOf(d));
      if (!b) continue;
      const ownerKey = `${sid}|${idOf(t.landOwnerId) || text(t.landOwnerName)}`;
      b.amount += amount;
      const s = b.sites.get(sid) || { name, amount: 0 };
      s.amount += amount;
      b.sites.set(sid, s);
      b.owners.add(ownerKey);
      b.deductions.push({
        id: idOf(t._id) || null,
        date: dayKeyOf(d),
        amount: r2(amount),
        billMonth: text(t.dueMonth) || null,
        siteId: sid,
        siteName: name,
        mediaCodes: codes,
        mediaType: typeLabel(attr),
        city: cityLabel(attr),
        ownerName: text(t.landOwnerName) || null,
        utrNumber: text(t.utrNumber) || null,
      });
      total += amount; entries += 1; allSites.add(sid); allOwners.add(ownerKey);
    }
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.siteName.localeCompare(b.siteName) || (a.ownerName || "").localeCompare(b.ownerName || "");
  const list = [...buckets].map(([key, b]) => ({
    key, amount: r2(b.amount), entries: b.deductions.length, sites: b.sites.size, owners: b.owners.size,
    topSites: topList(b.sites), deductions: b.deductions.sort(byDate),
  }));
  const peak = list.reduce((m, b) => (b.amount > (m?.amount ?? 0) ? b : m), null);
  return {
    filters: publicFilters(f),
    buckets: list,
    summary: { total: r2(total), entries, sites: allSites.size, owners: allOwners.size, peakKey: peak && peak.amount ? peak.key : null },
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

/**
 * TDS — source "rentalMaster": the TDS configured in Rental Master for the bills
 * that were actually generated. Never mixed with tdsBalanceHistory.
 * - Bills: rentalDue[] (one per site per due month — a site billed per face can
 *   have several rows for a month, but landowner TDS is per site, so the month
 *   counts once: the approved row, else the latest updated). Dated by the bill's
 *   dueDate; bills that do not exist are never projected.
 * - Landowners: landOwners[] as of that due date (lib.landOwnersAsOfDate scales
 *   the stored amounts back to the rent in force before a later appraisal).
 *   Only owners with tdsApplicable === 1 count, with their configured tdsAmount;
 *   owners on a CMD TDS hold (tdsHold === 1) are skipped, and applicable owners
 *   with no amount are reported in meta, not computed from a percentage.
 * The landowner configuration is the CURRENT one (Rental Master keeps no history
 * of TDS settings), so a bill from before a TDS change shows today's setting.
 */
const computeTdsRentalMaster = (docs, filters, lib) => {
  const f = { ...filters, granularity: "month" };
  const buckets = buildBuckets(f, () => ({ amount: 0, sites: new Map(), owners: new Set(), deductions: [] }));
  const excl = newExclusions();
  const meta = { billsWithoutDate: 0, duplicateBillsIgnored: 0, heldOwnersSkipped: 0, applicableWithoutAmount: 0 };
  const allSites = new Set();
  const allOwners = new Set();
  let total = 0;
  let entries = 0;
  const cityLabel = (attr) => (attr.city === MIXED ? "Multiple cities" : attr.city || null);
  for (const doc of docs) {
    const attr = siteAttr(doc);
    const name = siteName(doc);
    const sid = idOf(doc._id);
    const codes = uniq(faceList(doc).map((fc) => text(fc.mediaCode)));
    const perMonth = new Map();
    for (const bill of doc.rentalDue || []) {
      if (!bill) continue;
      const d = toDate(bill.dueDate);
      if (!d) { meta.billsWithoutDate += 1; continue; }
      const k = monthKeyOf(d);
      const prev = perMonth.get(k);
      if (!prev) { perMonth.set(k, bill); continue; }
      meta.duplicateBillsIgnored += 1;
      const better = (num(bill.approvalStatus) === 3) !== (num(prev.approvalStatus) === 3)
        ? num(bill.approvalStatus) === 3
        : (toDate(bill.updatedAt)?.getTime() ?? 0) > (toDate(prev.updatedAt)?.getTime() ?? 0);
      if (better) perMonth.set(k, bill);
    }
    for (const bill of perMonth.values()) {
      const d = toDate(bill.dueDate);
      if (!inRange(d, f)) continue;
      for (const o of lib.landOwnersAsOfDate(doc, d) || []) {
        if (!o) continue;
        if (num(o.tdsHold) === 1) { meta.heldOwnersSkipped += 1; continue; }
        if (num(o.tdsApplicable) !== 1) continue;
        const amount = num(o.tdsAmount);
        if (amount <= 0) { meta.applicableWithoutAmount += 1; continue; }
        if (!siteMatches(doc, attr, f, excl, amount)) continue;
        const b = buckets.get(monthKeyOf(d));
        if (!b) continue;
        const ownerKey = `${sid}|${idOf(o._id) || text(o.name)}`;
        b.amount += amount;
        const st = b.sites.get(sid) || { name, amount: 0 };
        st.amount += amount;
        b.sites.set(sid, st);
        b.owners.add(ownerKey);
        b.deductions.push({
          id: `${idOf(bill._id)}|${idOf(o._id)}`,
          date: dayKeyOf(d),
          amount: r2(amount),
          billMonth: text(bill.dueMonth) || `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
          siteId: sid,
          siteName: name,
          mediaCodes: codes,
          mediaType: typeLabel(attr),
          city: cityLabel(attr),
          ownerName: text(o.name) || null,
          utrNumber: null,
          billStatus: BILL_STATUS[num(bill.approvalStatus ?? bill.status)] || "Unknown",
        });
        total += amount; entries += 1; allSites.add(sid); allOwners.add(ownerKey);
      }
    }
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.siteName.localeCompare(b.siteName) || (a.ownerName || "").localeCompare(b.ownerName || "");
  const list = [...buckets].map(([key, b]) => ({
    key, amount: r2(b.amount), entries: b.deductions.length, sites: b.sites.size, owners: b.owners.size,
    topSites: topList(b.sites), deductions: b.deductions.sort(byDate),
  }));
  const peak = list.reduce((m, b) => (b.amount > (m?.amount ?? 0) ? b : m), null);
  return {
    filters: publicFilters(f),
    buckets: list,
    summary: { total: r2(total), entries, sites: allSites.size, owners: allOwners.size, peakKey: peak && peak.amount ? peak.key : null },
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

module.exports = {
  MIXED,
  parseFilters,
  fyBounds,
  currentFyStartYear,
  computeFilterOptions,
  computePayments,
  computePeriodDue,
  withPeriodDue,
  computeRentalMasterPayments,
  computeMedia,
  computeAppraisal,
  computeBills,
  computeGst,
  computeLedgerGst,
  computeTds,
  computeTdsRentalMaster,
  SOURCES,
  DEFAULT_SOURCE,
  siteAttr,
  billMediaType,
};
