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
// Site status filter. A site is ACTIVE when at least one of its faces has
// status 1 (the dashboard's / ledger's rule: find({ "mediaDetails.status": 1 }));
// otherwise (faces inactive = 2 or on hold = 3, or no faces) it is INACTIVE.
// "all" (the default when the parameter is absent) keeps every site, as before.
const SITE_STATUSES = ["active", "inactive", "all"];
const DEFAULT_SITE_STATUS = "all";
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
  const siteStatus = body.siteStatus === undefined || body.siteStatus === null || body.siteStatus === "" ? DEFAULT_SITE_STATUS : body.siteStatus;
  if (!SITE_STATUSES.includes(siteStatus)) return { error: `siteStatus must be one of: ${SITE_STATUSES.join(", ")}` };
  return {
    filters: {
      fy,
      start,
      end,
      granularity: spanDays <= DAY_GRANULARITY_MAX_DAYS ? "day" : "month",
      mediaType: pick(body.mediaType, mediaTypeText),
      city: pick(body.city),
      source,
      siteStatus,
      // opt-in detail rows for the report export (same calculation, same filters)
      details: body.details === true || body.details === "true",
    },
  };
};

const publicFilters = (f) => ({
  source: f.source || DEFAULT_SOURCE,
  siteStatus: f.siteStatus || DEFAULT_SITE_STATUS,
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

/** The site's landlords for the detail dialogs: their names, as stored on the site. */
const landlordsOf = (doc) => (Array.isArray(doc.landOwners) ? doc.landOwners.filter(Boolean) : []).map((o) => ({ name: text(o.name) }));

/**
 * The media codes of the site's faces, exactly as stored (mediaDetails[].mediaCode). A site can have several; a
 * face without one is simply not listed (the dialogs show "—" when none is) — never the document id.
 */
const mediaCodesOf = (doc) => uniq(faceList(doc).map((fc) => (typeof fc.mediaCode === "string" ? fc.mediaCode.trim() : "")));

/** What every detail row says about its site: name, the faces' media codes and the landlords' names. */
/** The site's city for detail rows: the faces' stored city, "Multiple cities" when they disagree, null when none is stored. */
const cityOf = (doc) => {
  const c = siteAttr(doc).city;
  return c === MIXED ? "Multiple cities" : c || null;
};
/**
 * The site's payment cycle, as stored (rentalPayment.paymentFrequency: 1 Monthly, 2 Quarterly, 3 Half-Yearly, 4 Yearly, 5 every 2 years,
 * 6 custom = customPaymentFrequency months). null when none is stored — the dialogs then show "—", never a guessed value.
 */
const PAYMENT_CYCLE_LABELS = { 1: "Monthly", 2: "Quarterly", 3: "Once in 6 Months", 4: "Yearly", 5: "Once in 2 Years" };
const paymentCycleOf = (doc) => {
  const rp = (doc && doc.rentalPayment) || {};
  const f = num(rp.paymentFrequency);
  if (f === 6) {
    const n = num(rp.customPaymentFrequency);
    return n > 0 ? (n === 1 ? "Monthly" : `Every ${n} Months`) : null;
  }
  return PAYMENT_CYCLE_LABELS[f] || null;
};

const detailBase = (doc) => ({ siteId: idOf(doc._id), siteName: siteName(doc), city: cityOf(doc), paymentCycle: paymentCycleOf(doc), mediaCodes: mediaCodesOf(doc), landlords: landlordsOf(doc) });
const byDateThenName = (a, z) => a.date.localeCompare(z.date) || a.siteName.localeCompare(z.siteName);

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

/** Active site = at least one face with status 1 (see SITE_STATUSES). */
const isActiveSite = (doc) => faceList(doc).some((fc) => num(fc.status) === 1);

/** The sites selected by the site-status filter (applied before every chart). */
const applySiteStatus = (docs, f) => {
  const status = (f && f.siteStatus) || DEFAULT_SITE_STATUS;
  if (status === "all") return docs;
  return docs.filter((doc) => isActiveSite(doc) === (status === "active"));
};

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
const cycleBill = (doc, cycleDate) => {
  const label = `${MONTH_NAMES[cycleDate.getUTCMonth()]} ${cycleDate.getUTCFullYear()}`;
  return (doc.rentalDue || [])
    .filter((d) => d && d.dueMonth === label)
    .sort((a, b) => {
      const sA = num(a.approvalStatus);
      const sB = num(b.approvalStatus);
      if (sA === 3 && sB !== 3) return -1;
      if (sB === 3 && sA !== 3) return 1;
      return (toDate(b.updatedAt)?.getTime() ?? 0) - (toDate(a.updatedAt)?.getTime() ?? 0);
    })[0];
};

const isDirectGstCycle = (doc, cycleDate, lib) => {
  const bill = cycleBill(doc, cycleDate);
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
  const months = buildBuckets({ ...f, granularity: "month" }, () => ({ toBePaid: 0, unpaid: 0, sites: new Set(), unpaidSites: new Set(), paidSites: new Set() }));
  const paidSites = new Set(); // sites with something paid in the period (paid = to be paid − unpaid, per site cycle)
  const siteTotals = new Map(); // sid -> { due, unpaid }
  // per site and month: the rent / GST behind the figures above (only when asked for: `details`)
  const rows = f.details ? new Map() : null;
  let curDoc = null;
  // x = the same figures split by component: rental, direct GST (withGst 2, paid with the rent), hold GST
  const COMPONENTS = ["rentalDue", "directGstDue", "holdGstDue", "rentalUnpaid", "directGstUnpaid", "holdGstUnpaid"];
  const addRow = (d, sid, rentDue, gstDue, rentUnpaid, gstUnpaid, x = {}) => {
    if (!rows) return;
    const month = monthKeyOf(d);
    const key = `${sid}|${month}`;
    const r = rows.get(key) || { siteId: sid, paymentCycle: paymentCycleOf(curDoc), mediaCodes: mediaCodesOf(curDoc), landlords: landlordsOf(curDoc), siteName: siteName(curDoc), city: cityOf(curDoc), month, rentDue: 0, gstDue: 0, rentUnpaid: 0, gstUnpaid: 0, ...Object.fromEntries(COMPONENTS.map((c) => [c, 0])) };
    r.rentDue += rentDue;
    r.gstDue += gstDue;
    r.rentUnpaid += rentUnpaid;
    r.gstUnpaid += gstUnpaid;
    for (const c of COMPONENTS) r[c] += x[c] || 0;
    rows.set(key, r);
  };
  const addMonth = (d, sid, toBePaid, unpaid) => {
    const m = months.get(monthKeyOf(d));
    if (!m) return;
    m.toBePaid += toBePaid;
    m.unpaid += unpaid;
    m.sites.add(sid);
    if (unpaid > 0) m.unpaidSites.add(sid);
    if (toBePaid - unpaid > 0.005) { m.paidSites.add(sid); paidSites.add(sid); }
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
    curDoc = doc;

    // opening balances
    const addOpening = (openingRows, amountField, bucket, hold) => {
      for (const o of openingRows || []) {
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
        const open = isPaidRow(o) ? 0 : amount;
        addRow(d, sid, hold ? 0 : amount, hold ? amount : 0, hold ? 0 : open, hold ? open : 0, hold ? { holdGstDue: amount, holdGstUnpaid: open } : { rentalDue: amount, rentalUnpaid: open });
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
      // direct GST rides with the rent: its unpaid part is the pending rent share in proportion to GST / (rent + GST)
      // (the ledger pays rent + direct GST together, per landlord share); hold GST is paid separately (currentMonthGstPending)
      const rentPending = num(s.currentMonthRentPending);
      const directUnpaid = direct && rentTarget + gstTarget > 0 ? r2(Math.min(rentPending, (rentPending * gstTarget) / (rentTarget + gstTarget))) : 0;
      addRow(cycleDate, sid, rentTarget, gstTarget, rentPending, num(s.currentMonthGstPending), {
        rentalDue: rentTarget,
        directGstDue: direct ? gstTarget : 0,
        holdGstDue: direct ? 0 : gstTarget,
        rentalUnpaid: rentPending - directUnpaid,
        directGstUnpaid: directUnpaid,
        holdGstUnpaid: num(s.currentMonthGstPending),
      });
      // the cycle's stored bill (the ledger's best match) and its approval status, for the Unpaid popup; no bill → none stated
      const bill = rows && cycleBill(doc, cycleDate);
      if (bill) rows.get(`${sid}|${monthKeyOf(cycleDate)}`).approvalStatus = BILL_STATUS[num(bill.approvalStatus ?? bill.status)] || "Unknown";
      if (num(s.currentMonthRentPending) > 0 || num(s.currentMonthGstPending) > 0) unpaidSites.add(sid);
    }
  }
  const part = (p) => ({ toBePaid: r2(p.toBePaid), unpaid: r2(p.unpaid) });
  const due = {
    toBePaid: r2(acc.rentDirect.toBePaid + acc.hold.toBePaid),
    unpaid: r2(acc.rentDirect.unpaid + acc.hold.unpaid),
    sites: sites.size,
    unpaidSites: unpaidSites.size,
    paidSites: paidSites.size,
    parts: {
      rentDirect: part(acc.rentDirect), // rent + direct GST (opening rent included)
      hold: part(acc.hold), // expected hold GST (opening GST included)
      opening: { rent: part(acc.openingRent), gst: part(acc.openingGst) }, // already inside the two lines above
    },
  };
  const buckets = [...months].map(([key, m]) => ({
    key, toBePaid: r2(m.toBePaid), unpaid: r2(m.unpaid), paid: r2(m.toBePaid - m.unpaid), sites: m.sites.size, unpaidSites: m.unpaidSites.size, paidSites: m.paidSites.size,
  }));
  const records = rows
    ? [...rows.values()]
        .map((r) => ({ ...r, rentDue: r2(r.rentDue), gstDue: r2(r.gstDue), rentUnpaid: r2(r.rentUnpaid), gstUnpaid: r2(r.gstUnpaid), ...Object.fromEntries(COMPONENTS.map((c) => [c, r2(r[c])])) }))
        .sort((a, z) => a.siteName.localeCompare(z.siteName) || a.month.localeCompare(z.month))
    : null;
  return { due, buckets, ...(records ? { records } : {}), meta: { ...meta, excludedMixedSites: exclusionMeta(excl) } };
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
  const { due, buckets, records, meta } = computePeriodDue(docs, f, lib, now);
  const peak = buckets.reduce((m, b) => (b.toBePaid > (m?.toBePaid ?? 0) ? b : m), null);
  return {
    filters: publicFilters({ ...f, granularity: "month" }),
    buckets,
    summary: {
      toBePaid: due.toBePaid, unpaid: due.unpaid, paid: r2(due.toBePaid - due.unpaid),
      dueSites: due.sites, unpaidSites: due.unpaidSites, paidSites: due.paidSites, dueParts: due.parts, peakKey: peak ? peak.key : null,
    },
    ...(records ? { records } : {}),
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
 * Counts media FACES (MediaOnboarding.mediaDetails[]) by the parent document's
 * createdAt — the same unit as the dashboard's totalSites / activeSites /
 * inactiveSites (DashboardController: every face counts once; status 1 = active,
 * anything else = inactive; a document with no faces counts once, as inactive).
 * `createdAt` belongs to the site document, not to the face, so a face added to
 * an existing site later is dated with the site's onboarding: the trend shows
 * when site records were created, not when each face went live.
 *
 * Site status (active / inactive / all) is applied HERE per face, not per site
 * (callers must pass the unfiltered documents). Media type / city filter faces:
 * a face counts when it satisfies every selected filter itself; a face-less
 * document never passes a media type / city filter.
 * `byType` counts faces per media type ("Unspecified" when blank), so it sums to
 * `total`. `summary.sites` is the number of distinct site documents behind the
 * counted faces (informational).
 */
const computeMedia = (docs, f) => {
  const buckets = buildBuckets(f, () => ({ total: 0, byType: {} }));
  const rows = f.details ? [] : null; // per counted face, behind the monthly totals (only when asked for)
  const meta = { sitesWithoutOnboardingDate: 0, facesWithoutOnboardingDate: 0 };
  let total = 0;
  const byType = {};
  const sites = new Set();
  const filtered = !!(f.mediaType || f.city);
  const status = f.siteStatus || DEFAULT_SITE_STATUS;
  for (const doc of docs) {
    const faces = faceList(doc);
    // a face-less document is one record, inactive (the dashboard's rule)
    const items = faces.length ? faces : [null];
    const counted = items.filter((fc) => {
      if (fc === null) return !filtered && status !== "active";
      if (f.mediaType && mediaTypeText(fc.mediaType) !== f.mediaType) return false;
      if (f.city && text(fc.city) !== f.city) return false;
      const active = num(fc.status) === 1;
      return status === "all" || active === (status === "active");
    });
    if (!counted.length) continue;
    const created = toDate(doc.createdAt);
    if (!created) { meta.sitesWithoutOnboardingDate += 1; meta.facesWithoutOnboardingDate += counted.length; continue; }
    if (!inRange(created, f)) continue;
    const b = buckets.get(bucketKey(created, f.granularity));
    if (!b) continue;
    sites.add(idOf(doc._id));
    for (const fc of counted) {
      const t = (fc && mediaTypeText(fc.mediaType)) || "Unspecified";
      if (rows) {
        const code = fc && typeof fc.mediaCode === "string" ? fc.mediaCode.trim() : "";
        rows.push({
          siteId: idOf(doc._id),
          siteName: (fc && (text(fc.mediaName) || code)) || siteName(doc),
          paymentCycle: paymentCycleOf(doc),
          mediaCodes: code ? [code] : [],
          mediaType: t,
          city: (fc && text(fc.city)) || "",
          date: dayKeyOf(created),
          bucket: bucketKey(created, f.granularity),
        });
      }
      b.total += 1;
      total += 1;
      b.byType[t] = (b.byType[t] || 0) + 1;
      byType[t] = (byType[t] || 0) + 1;
    }
  }
  const list = [...buckets].map(([key, b]) => ({ key, total: b.total, byType: b.byType }));
  const peak = list.reduce((m, b) => (b.total > (m?.total ?? 0) ? b : m), null);
  return { filters: publicFilters(f), buckets: list, summary: { total, sites: sites.size, byType, peakKey: peak && peak.total ? peak.key : null }, ...(rows ? { records: rows.sort(byDateThenName) } : {}), meta };
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
  const buckets = buildBuckets(f, () => ({ given: mk(), upcoming: mk(), held: mk(), total: mk() }));
  const excl = newExclusions();
  const meta = { sitesNotApplicable: 0, entriesWithoutDate: 0 };
  const totals = { given: mk(), upcoming: mk(), held: mk(), total: mk() }; // total = given + held + upcoming (each entry is in exactly one kind); its sites are distinct across them
  const today = now;
  const rows = f.details ? [] : null; // per counted entry, behind the monthly totals (only when asked for)

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
      for (const t of [b[kind], totals[kind], b.total, totals.total]) {
        t.sites.add(idOf(doc._id));
        t.amount += amount;
        t.entries += 1;
      }
      if (rows) {
        rows.push({
          ...detailBase(doc),
          kind,
          bucket: bucketKey(d, f.granularity),
          date: dayKeyOf(d),
          amount: r2(amount),
          previousRent: r2(num(h.previousRent)),
          newRent: r2(num(h.newRent)),
          type: num(h.type) === 1 ? "percentage" : num(h.type) === 2 ? "fixed" : null,
          percentage: num(h.type) === 1 ? num(h.percentage) : null,
        });
      }
    }
  }
  const fin = (t) => ({ sites: t.sites.size, amount: r2(t.amount), entries: t.entries });
  const list = [...buckets].map(([key, b]) => ({ key, given: fin(b.given), upcoming: fin(b.upcoming), held: fin(b.held), total: fin(b.total) }));
  return {
    filters: publicFilters(f),
    buckets: list,
    summary: { given: fin(totals.given), upcoming: fin(totals.upcoming), held: fin(totals.held), total: fin(totals.total) },
    ...(rows ? { records: rows.sort(byDateThenName) } : {}),
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

// ── Chart 7 — Agreements ───────────────────────────────────────────────────

/**
 * Source: the site's CURRENT agreement (`agreement`, the record Agreement Master and the Dashboard classify) and every filed version of
 * it (`agreementHistory[]`, one entry per filed agreement; the current agreement is always one of them — matched by start + end day).
 * A "record" is one distinct agreement (start day + end day) of a site.
 *
 * Classified by DATES only, the rule the app already uses (computeAgreementStatus / the Dashboard / the agreement pre-save): the stored
 * `status` fields are refreshed only when a site is saved (history entries keep a stale "Active" for years), so they are not read.
 *   expired    — end day before today (IST)
 *   live       — the site's current agreement, started on or before today and not expired (the end day itself is still live)
 *   upcoming   — the site's current agreement whose start day is after today
 *   superseded — an earlier filed version that has not ended but is not the site's current agreement (never counted as live)
 * total = live + expired + upcoming + superseded. "Expiring soon" is a live agreement within its own reminderBeforeExpiry days of the end.
 * A record without a start or end date cannot be classified: it is left out of every figure and counted in meta.recordsWithoutDates.
 *
 * Cards = every record of the matching sites as of today (the period does not apply).
 *
 * ONE monthly chart (the period's months; the counts look back over every filed agreement, whatever the period). For a month M, among the
 * agreements that have started by M's last day (start day <= last day of M; superseded versions are never counted — they are not the site's
 * agreement), each is in exactly ONE of:
 *   expired  — ended before M began (end day < first day of M)
 *   expiring — ends inside M (first day <= end day <= last day)
 *   live     — still running after M (end day > last day of M)
 * total = expired + expiring + live. The chart stacks the three and draws total as the line, so nothing is counted twice. Always monthly.
 */
const computeAgreements = (docs, filters, now = nowIST()) => {
  const f = { ...filters, granularity: "month" };
  const todayKey = dayKeyOf(startOfUtcDay(now));
  const dayMs = 86400000;
  const keyMs = (k) => Date.parse(`${k}T00:00:00Z`);
  const mk = () => ({ records: 0, sites: new Set() });
  const mkStates = () => ({ live: mk(), expired: mk(), upcoming: mk(), superseded: mk() });
  const mkMonth = () => ({ total: mk(), live: mk(), expiring: mk(), expired: mk() });
  const buckets = buildBuckets(f, mkMonth);
  const monthRange = (key) => { const [y, m] = key.split("-").map(Number); return [`${key}-01`, `${key}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`]; };
  const total = mk();
  const states = mkStates();
  const expiringSoon = mk();
  const excl = newExclusions();
  const meta = { recordsWithoutDates: 0, sitesWithoutAgreement: 0, currentNotInHistory: 0, historyEntriesCurrentDiffers: 0 };
  const rows = f.details ? [] : null;
  const bump = (t, sid) => { t.records += 1; t.sites.add(sid); };

  for (const doc of docs) {
    const cur = doc.agreement || {};
    const history = Array.isArray(doc.agreementHistory) ? doc.agreementHistory.filter(Boolean) : [];
    if (!cur.startDate && !cur.endDate && !history.length) { meta.sitesWithoutAgreement += 1; continue; }
    const attr = siteAttr(doc);
    if (!siteMatches(doc, attr, f, excl, 0)) continue;
    const sid = idOf(doc._id);

    const recs = new Map(); // "start|end" -> record (one per distinct filed agreement)
    const add = (a, isCurrent) => {
      const s0 = toDate(a.startDate), e0 = toDate(a.endDate);
      if (!s0 || !e0) { meta.recordsWithoutDates += 1; return; }
      const key = `${dayKeyOf(s0)}|${dayKeyOf(e0)}`;
      const prev = recs.get(key);
      if (prev) { prev.isCurrent = prev.isCurrent || isCurrent; return; }
      recs.set(key, { start: s0, end: e0, reminder: num(a.reminderBeforeExpiry) || 30, docType: num(a.agreementStatus), isCurrent });
    };
    history.forEach((h) => add(h, false));
    const hadCurrent = (cur.startDate || cur.endDate) ? (toDate(cur.startDate) && toDate(cur.endDate) ? `${dayKeyOf(toDate(cur.startDate))}|${dayKeyOf(toDate(cur.endDate))}` : null) : null;
    if (hadCurrent && !recs.has(hadCurrent)) meta.currentNotInHistory += 1;
    if (cur.startDate || cur.endDate) add(cur, true);

    for (const r of recs.values()) {
      const startKey = dayKeyOf(r.start), endKey = dayKeyOf(r.end);
      const state = endKey < todayKey ? "expired" : !r.isCurrent ? "superseded" : startKey > todayKey ? "upcoming" : "live";
      const daysToExpiry = Math.round((keyMs(endKey) - keyMs(todayKey)) / dayMs);
      const soon = state === "live" && daysToExpiry <= r.reminder;
      bump(total, sid);
      bump(states[state], sid);
      if (soon) bump(expiringSoon, sid);
      if (state !== "superseded") {
        for (const [key, bm] of buckets) {
          const [first, last] = monthRange(key);
          if (startKey > last) continue; // not started by the end of the month
          const cat = endKey < first ? "expired" : endKey <= last ? "expiring" : "live";
          bump(bm.total, sid);
          bump(bm[cat], sid);
        }
      }
      if (rows) {
        rows.push({
          ...detailBase(doc),
          date: startKey,
          startDate: startKey,
          endDate: endKey,
          state,
          expiringSoon: soon,
          isCurrent: r.isCurrent,
          reminderDays: r.reminder,
          daysToExpiry,
          document: r.docType === 1 ? "Original" : r.docType === 2 ? "Draft" : null,
        });
      }
    }
  }
  const fin = (t) => ({ agreements: t.records, sites: t.sites.size });
  const finStates = (o) => ({ live: fin(o.live), expired: fin(o.expired), upcoming: fin(o.upcoming), superseded: fin(o.superseded) });
  const list = [...buckets].map(([key, b]) => ({ key, total: fin(b.total), live: fin(b.live), expiring: fin(b.expiring), expired: fin(b.expired) }));
  return {
    filters: publicFilters(f),
    asOf: todayKey,
    buckets: list,
    summary: { total: fin(total), ...finStates(states), expiringSoon: fin(expiringSoon) },
    ...(rows ? { records: rows.sort(byDateThenName) } : {}),
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
 * A row without a face (site-level bill) is classified at site level: the
 * site's ACTIVE faces (all faces if none is active), "mixed" when they
 * disagree. (Rows whose face no longer exists are stale — isStaleBill — and are
 * excluded by computeBills before any classification.)
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
 * A bill row is STALE when it names a face (mediaDetailId) that no longer exists
 * on the site — a face deleted or re-created with a new id during a site edit.
 * Such rows are left behind when the face changes; the billing code then creates
 * a row for the current face, so the old one only duplicates it. Rental Master
 * (utils/rentalDueStats.js pickFaceEntry) already ignores them. Rows WITHOUT a
 * mediaDetailId are site-level bills (they apply to every face) and are never
 * stale; rows of a face that still exists but is inactive are not stale either.
 */
const isStaleBill = (doc, bill) =>
  !!(bill && bill.mediaDetailId) && !faceList(doc).some((fc) => idOf(fc._id) === idOf(bill.mediaDetailId));

/**
 * Source: rentalDue[] (bills that already exist). Verified in
 * RentalDueNew2Controller.computeGstSplit: baseAmount = rent + GST (gross),
 * gstAmount = the GST part, netPayable = amount payable to the owner now
 * (rent only for withGst 0/1; rent + GST for withGst 2). Grouped by dueDate.
 * Status labels are the existing approvalStatus meanings; no "paid" state is
 * inferred. No bill is ever generated or updated.
 * Media type (byType and the media-type filter) is per bill — billMediaType;
 * the city filter stays site-level.
 * Stale rows (isStaleBill) are excluded before everything else, so the total,
 * counts, sites, monthly buckets and status / type breakdowns all use the same
 * rows; those in the period are reported in meta.staleRowsExcluded.
 *
 * Timing (Upcoming Payments), against TODAY = the IST calendar day (nowIST, the
 * same convention as the stored dueDates and as rentalDueStats' overdue rule):
 *  upcoming — dueDate after today (from tomorrow on): buckets[].upcoming and
 *             summary.upcoming, with the same fields and status / type breakdowns
 *  dueToday — dueDate today: neither upcoming nor overdue yet
 *  overdue  — dueDate before today AND not fully approved (approvalStatus ≠ 3) —
 *             the Rental Master / dashboard overdue rule
 *  past, approved — dueDate before today and approved: in the stored totals only
 * The top-level bucket / summary fields stay "all stored bills in the period".
 */
const computeBills = (docs, f, now = nowIST()) => {
  const today = startOfUtcDay(now);
  const tomorrow = new Date(today.getTime() + MS_DAY);
  const mkPart = () => ({ bills: 0, sites: new Set(), total: 0, gst: 0, payable: 0, byStatus: {}, byType: {} });
  const buckets = buildBuckets(f, () => ({ ...mkPart(), upcoming: mkPart() }));
  const excl = newExclusions();
  const meta = { billsWithoutAmount: 0, billsWithoutDueDate: 0 };
  const stale = { bills: 0, amount: 0, sites: new Set() };
  const sum = mkPart();
  const upcoming = mkPart();
  const timing = { dueToday: mkPart(), overdue: mkPart(), pastApproved: mkPart() };
  const add = (part, sid, status, tl, total, gst, payable) => {
    part.bills += 1; part.sites.add(sid); part.total += total; part.gst += gst; part.payable += payable;
    const st = (part.byStatus[status] ||= { bills: 0, amount: 0 });
    st.bills += 1; st.amount += total;
    const ty = (part.byType[tl] ||= { bills: 0, amount: 0 });
    ty.bills += 1; ty.amount += total;
  };
  for (const doc of docs) {
    const attr = siteAttr(doc);
    for (const bill of doc.rentalDue || []) {
      if (!bill) continue;
      const d = toDate(bill.dueDate);
      if (!d) { meta.billsWithoutDueDate += 1; continue; }
      if (!inRange(d, f)) continue;
      const total = num(bill.baseAmount);
      if (isStaleBill(doc, bill)) { stale.bills += 1; stale.amount += total; stale.sites.add(idOf(doc._id)); continue; }
      const type = billMediaType(doc, bill);
      if (f.mediaType) {
        if (type === MIXED) { excl.sites.add(idOf(doc._id)); excl.amount += total; continue; }
        if (type !== f.mediaType) continue;
      }
      if (!siteMatches(doc, attr, { ...f, mediaType: "" }, excl, total)) continue; // city: site-level, as before
      if (total <= 0) meta.billsWithoutAmount += 1;
      const b = buckets.get(bucketKey(d, f.granularity));
      if (!b) continue;
      const approvalStatus = num(bill.approvalStatus ?? bill.status);
      const status = BILL_STATUS[approvalStatus] || "Unknown";
      const gst = num(bill.gstAmount);
      const payable = num(bill.netPayable);
      const sid = idOf(doc._id);
      const tl = typeLabel({ mediaType: type });
      add(b, sid, status, tl, total, gst, payable);
      add(sum, sid, status, tl, total, gst, payable);
      if (d >= tomorrow) {
        add(b.upcoming, sid, status, tl, total, gst, payable);
        add(upcoming, sid, status, tl, total, gst, payable);
      } else if (d >= today) {
        add(timing.dueToday, sid, status, tl, total, gst, payable);
      } else if (approvalStatus !== 3) {
        add(timing.overdue, sid, status, tl, total, gst, payable);
      } else {
        add(timing.pastApproved, sid, status, tl, total, gst, payable);
      }
    }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { bills: v.bills, amount: r2(v.amount) }]));
  const fin = (p) => ({
    bills: p.bills, sites: p.sites.size, total: r2(p.total), gst: r2(p.gst), payable: r2(p.payable),
    byStatus: round(p.byStatus), byType: round(p.byType),
  });
  const list = [...buckets].map(([key, b]) => ({ key, ...fin(b), upcoming: fin(b.upcoming) }));
  return {
    filters: publicFilters(f),
    today: dayKeyOf(today),
    buckets: list,
    summary: {
      // all stored bills in the period (any timing), as before
      bills: sum.bills, sites: sum.sites.size, total: r2(sum.total), gst: r2(sum.gst), payable: r2(sum.payable), byStatus: round(sum.byStatus),
      upcoming: fin(upcoming),
      dueToday: fin(timing.dueToday),
      overdue: fin(timing.overdue),
      pastApproved: fin(timing.pastApproved),
    },
    meta: { ...meta, staleRowsExcluded: { bills: stale.bills, amount: r2(stale.amount), sites: stale.sites.size }, excludedMixedSites: exclusionMeta(excl) },
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
  // the GST cards: generated = paid + unpaid + hold. Every remaining amount lands in exactly ONE of three places (the cycle's stored
  // bill decides, approval is never taken as payment):
  //   pending — the cycle has no approved bill yet (bill awaiting approval, or not billed): unpaid, "Pending Approval"
  //   hold    — approved bill with held GST (withGst 0 / 1): retained until the landlord's tax-payment receipt (released = paid, so gone)
  //   ledger  — approved bill with direct GST, or an onboarding GST due: unpaid by the Ledger's own balance, "Ledger Entry"
  // unpaid = pending + ledger (its two cases are also reported on their own).
  const mkCard = () => ({ generated: mk(), paid: mk(), unpaid: mk(), unpaidPending: mk(), unpaidLedger: mk(), hold: mk() });
  const cardTotals = mkCard();
  const bucketCards = new Map();
  const cardsOf = (key) => { if (!bucketCards.has(key)) bucketCards.set(key, mkCard()); return bucketCards.get(key); };
  const excl = newExclusions();
  const meta = { cyclesCounted: 0, openingRowsWithoutDate: 0 };
  const startKey = f.start.getUTCFullYear() * 12 + f.start.getUTCMonth();
  const capEnd = f.end < now ? f.end : now; // never beyond the current month
  const capKey = capEnd.getUTCFullYear() * 12 + capEnd.getUTCMonth();
  const rows = f.details ? [] : null; // per site cycle / opening row, behind the monthly totals (only when asked for)
  let curDoc = null;
  const remainingAsOf = (kind, approved) => (kind === "opening" ? "ledger" : !approved ? "pending" : kind === "hold" ? "hold" : "ledger");
  const add = (sid, d, kind, paid, remaining, billMonth, approved = true, bill = null) => {
    const b = buckets.get(monthKeyOf(d));
    if (!b) return;
    const as = remaining > 0 ? remainingAsOf(kind, approved) : null;
    if (rows && (paid > 0 || remaining > 0)) {
      rows.push({ ...detailBase(curDoc), kind, remainingAs: as, approvalStatus: bill ? BILL_STATUS[num(bill.approvalStatus ?? bill.status)] || "Unknown" : null, approvalSteps: bill ? approvalStepsOf(bill) : [], bucket: monthKeyOf(d), date: dayKeyOf(d), billMonth: billMonth || `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`, paid: r2(paid), remaining: r2(remaining) });
    }
    for (const [cat, amount] of [["paid", paid], ["remaining", remaining]]) {
      if (amount <= 0) continue;
      for (const t of [b[cat], totals[cat]]) { t.amount += amount; t.sites.add(sid); t.records += 1; }
    }
    for (const p of [b.parts[kind], parts[kind]]) { p.due += paid + remaining; p.paid += paid; p.remaining += remaining; }
    for (const c of [cardsOf(monthKeyOf(d)), cardTotals]) {
      const rest = as === "hold" ? ["hold"] : as === "pending" ? ["unpaid", "unpaidPending"] : ["unpaid", "unpaidLedger"];
      for (const [cat, amount] of [["generated", paid + remaining], ["paid", paid], ...rest.map((k) => [k, remaining])]) {
        if (amount <= 0) continue;
        c[cat].amount += amount; c[cat].sites.add(sid); c[cat].records += 1;
      }
    }
  };

  for (const doc of docs) {
    if (!faceList(doc).some((fc) => num(fc.status) === 1)) continue; // the ledger skips sites with no active face
    const attr = siteAttr(doc);
    const tmp = newExclusions();
    if (!siteMatches(doc, attr, f, tmp)) { tmp.sites.forEach((x) => excl.sites.add(x)); continue; }
    const sid = idOf(doc._id);
    curDoc = doc;

    for (const o of (doc.rentalPayment && doc.rentalPayment.gstOutstandingHistory) || []) {
      if (!o) continue;
      const amount = num(o.gstOutStandingAmount);
      if (amount <= 0) continue;
      const d = parseMonthLabel(o.dueMonth);
      if (!d) { meta.openingRowsWithoutDate += 1; continue; }
      const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (k < startKey || k > capKey) continue;
      const paid = !!(o.isPaid || text(o.utrNumber));
      add(sid, d, "opening", paid ? amount : 0, paid ? 0 : amount, text(o.dueMonth));
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
      const bill = cycleBill(doc, cycleDate);
      const approved = !!bill && num(bill.approvalStatus ?? bill.status) === 3;
      add(sid, cycleDate, isDirectGstCycle(doc, cycleDate, lib) ? "direct" : "hold", num(sm.splitCurGstPaid), num(sm.splitCurGstRemaining), undefined, approved, bill);
    }
  }
  const fin = (t) => ({ amount: r2(t.amount), sites: t.sites.size, records: t.records });
  const finPart = (p) => ({ due: r2(p.due), paid: r2(p.paid), remaining: r2(p.remaining) });
  const finParts = (ps) => ({ hold: finPart(ps.hold), direct: finPart(ps.direct), opening: finPart(ps.opening) });
  const finCards = (c) => ({ generated: fin(c.generated), paid: fin(c.paid), unpaid: fin(c.unpaid), unpaidPending: fin(c.unpaidPending), unpaidLedger: fin(c.unpaidLedger), hold: fin(c.hold) });
  const list = [...buckets].map(([key, b]) => ({ key, paid: fin(b.paid), remaining: fin(b.remaining), due: r2(b.paid.amount + b.remaining.amount), parts: finParts(b.parts), cards: finCards(cardsOf(key)) }));
  return {
    filters: publicFilters(f),
    categories: GST_CATEGORIES.ledger,
    buckets: list,
    summary: { paid: fin(totals.paid), remaining: fin(totals.remaining), due: r2(totals.paid.amount + totals.remaining.amount), parts: finParts(parts), cards: finCards(cardTotals) },
    ...(rows ? { records: rows.sort(byDateThenName) } : {}),
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
  const rows = f.details ? [] : null; // per bill GST / onboarding due, behind the monthly totals (only when asked for)
  const add = (doc, attr, kind, d, amount, info = {}) => {
    if (amount <= 0) return;
    if (!d) { meta.recordsWithoutDate += 1; return; }
    if (!inRange(d, f)) return;
    if (!siteMatches(doc, attr, f, excl, amount)) return;
    const b = buckets.get(bucketKey(d, f.granularity));
    if (!b) return;
    for (const t of [b[kind], totals[kind]]) { t.amount += amount; t.sites.add(idOf(doc._id)); t.records += 1; }
    if (rows) rows.push({ ...detailBase(doc), category: kind, bucket: bucketKey(d, f.granularity), date: dayKeyOf(d), billMonth: info.billMonth || null, status: info.status || null, amount: r2(amount) });
  };

  for (const doc of docs) {
    const attr = siteAttr(doc);
    for (const bill of doc.rentalDue || []) {
      if (!bill) continue;
      add(doc, attr, num(bill.withGst) === 2 ? "direct" : "hold", toDate(bill.dueDate), num(bill.gstAmount), {
        billMonth: text(bill.dueMonth),
        status: BILL_STATUS[num(bill.approvalStatus ?? bill.status)] || "Unknown",
      });
    }
    for (const o of (doc.rentalPayment && doc.rentalPayment.gstOutstandingHistory) || []) {
      if (!o || o.isPaid) continue;
      const settled = (o.paymentBreakup || []).reduce((sum, p) => sum + num(p && p.amount), 0);
      add(doc, attr, "unpaid", parseMonthLabel(o.dueMonth), Math.max(num(o.gstOutStandingAmount) - settled, 0), { billMonth: text(o.dueMonth), status: "Onboarding due" });
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
    ...(rows ? { records: rows.sort(byDateThenName) } : {}),
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

// ── Chart 6 — TDS ──────────────────────────────────────────────────────────

// The Ledger shows and takes dates as dd/mm/yyyy; new Date("09/10/2026") would read that as 10 Sep, so such strings are parsed day-first.
const toLedgerDate = (v) => {
  const m = typeof v === "string" ? /^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s*$/.exec(v) : null;
  if (!m) return toDate(v);
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[1]) ? d : null;
};
const tdsPaymentDate = (entry) => toLedgerDate(entry?.paidAt) || toLedgerDate(entry?.date);
// isUtrEntry is a Boolean in the schema; tolerate the string/number forms older imports stored
const isTdsRecorded = (entry) => {
  const v = entry?.isUtrEntry;
  return !(!v || v === "false" || v === "0" || v === 0);
};
/**
 * The Ledger records a landlord's TDS deduction together with the rent payment: every rent ledger entry (ledger[] and
 * ledgerHistory[]) shows the landlord's TDS beside the payment date, and the current Ledger screens write nothing to
 * tdsBalanceHistory. So a saved rent payment (not GST-only, not virtual) for a TDS-applicable landlord is a recorded
 * deduction of that landlord's TDS (as of the bill month; none while on a CMD TDS hold) on the payment date. For a
 * Cash + Online split landlord the TDS comes off the Online part only (as in the Ledger screens), so only that payment counts.
 * A stored tdsBalanceHistory row for the same landlord + bill month always wins, so nothing is counted twice.
 * Returns tdsBalanceHistory-shaped rows: the stored ones plus the derived ones.
 */
const tdsRecordedRows = (doc, lib) => {
  const stored = Array.isArray(doc.tdsBalanceHistory) ? doc.tdsBalanceHistory : [];
  if (!lib || typeof lib.landOwnersAsOfDate !== "function") return stored;
  const identity = tdsOwnerIdentity(doc);
  const monthOf = (label, fallback) => parseMonthLabel(label) || fallback;
  const covered = new Set();
  stored.forEach((t, index) => {
    if (!t || !isTdsRecorded(t)) return;
    const bm = monthOf(t.dueMonth, toDate(t.cycle));
    covered.add(`${identity.forEntry(t, index).key}|${bm ? monthKeyOf(bm) : text(t.dueMonth)}`);
  });
  const payments = [
    ...(doc.ledger || []),
    ...(doc.ledgerHistory || []).flatMap((y) => (y?.months || []).flatMap((mo) => (mo?.entries || []).map((e) => ({ ...e, month: e.month || `${mo.month} ${y.year}` })))),
  ];
  const derived = [];
  for (const e of payments) {
    if (!e || !e.paymentMode || e.isUtrEntry === true || e.isVirtual) continue;
    if (e.status !== undefined && e.status !== null && num(e.status) !== 1) continue;
    const paidOn = toLedgerDate(e.date);
    if (!paidOn) continue;
    const bm = monthOf(e.month || e.dueMonth, new Date(Date.UTC(paidOn.getUTCFullYear(), paidOn.getUTCMonth(), 1)));
    const owners = lib.landOwnersAsOfDate(doc, bm) || [];
    const ownerId = idOf(e.landOwnerId);
    const owner = ownerId
      ? owners.find((o) => idOf(o?._id) === ownerId || idOf(o?.landOwnerMasterId) === ownerId)
      : owners.length === 1 ? owners[0] : null;
    if (!owner || num(owner.tdsHold) === 1 || num(owner.tdsApplicable) !== 1) continue;
    if (num(owner.paymentCategory) === 3 && e.paymentMode !== "Online") continue;
    const amount = num(owner.tdsAmount);
    if (amount <= 0) continue;
    const row = {
      _id: e._id ? `rent:${idOf(e._id)}` : undefined,
      landOwnerId: owner._id, landOwnerName: owner.name,
      dueMonth: `${MONTH_NAMES[bm.getUTCMonth()]} ${bm.getUTCFullYear()}`, cycle: bm,
      isUtrEntry: true, tdsAmount: amount, paidAmount: amount, paidAt: paidOn, date: paidOn, utrNumber: text(e.utrNumber),
    };
    if (covered.has(`${identity.forEntry(row, 0).key}|${monthKeyOf(bm)}`)) continue;
    derived.push(row);
  }
  return derived.length ? [...stored, ...derived] : stored;
};

const tdsPaidAmount = (entry) => num(entry?.paidAmount) || num(entry?.tdsAmount);
const normalizeOwnerName = (name) => text(name).toLowerCase().replace(/\s+/g, " ");

const tdsOwnerIdentity = (doc) => {
  const owners = (Array.isArray(doc.landOwners) ? doc.landOwners : []).filter(Boolean);
  const aliases = new Map();
  const ambiguousAliases = new Set();
  const names = new Map();
  const ambiguousNames = new Set();
  const ownerKeys = new Map();

  const addAlias = (map, ambiguous, alias, key) => {
    if (!alias || ambiguous.has(alias)) return;
    const previous = map.get(alias);
    if (previous && previous !== key) {
      map.delete(alias);
      ambiguous.add(alias);
    } else {
      map.set(alias, key);
    }
  };

  owners.forEach((owner, index) => {
    const localId = idOf(owner._id);
    const masterId = idOf(owner.landOwnerMasterId);
    const key = localId ? `owner:${localId}` : masterId ? `master:${masterId}` : `owner-index:${index}`;
    ownerKeys.set(owner, key);
    addAlias(aliases, ambiguousAliases, localId, key);
    addAlias(aliases, ambiguousAliases, masterId, key);
    addAlias(names, ambiguousNames, normalizeOwnerName(owner.name), key);
  });

  return {
    ownerKey(owner) {
      const localId = idOf(owner?._id);
      const masterId = idOf(owner?.landOwnerMasterId);
      const nameKey = normalizeOwnerName(owner?.name);
      return ownerKeys.get(owner)
        || aliases.get(localId)
        || aliases.get(masterId)
        || names.get(nameKey)
        || (localId ? `owner:${localId}` : masterId ? `master:${masterId}` : "");
    },
    forEntry(entry, index) {
      const ownerId = idOf(entry.landOwnerId);
      const ownerName = text(entry.landOwnerName);
      const nameKey = normalizeOwnerName(ownerName);
      const key = aliases.get(ownerId)
        || names.get(nameKey)
        || (ownerId
          ? `id:${ownerId}`
          : nameKey && ambiguousNames.has(nameKey)
            ? `ambiguous-name:${nameKey}:${idOf(entry._id) || index}`
            : nameKey
              ? `name:${nameKey}`
              : `record:${idOf(entry._id) || index}`);
      const owner = owners.find((candidate) => ownerKeys.get(candidate) === key);
      return { key, ownerName: ownerName || text(owner?.name) || null };
    },
  };
};

/**
 * Source: tdsBalanceHistory[] — ledger-save (withTds=1) upserts ONE row per
 * owner + bill month holding the TDS deducted for that bill (tdsAmount ===
 * paidAmount; they are the same amount and are NOT summed). Each row is an
 * individual deduction, never a running balance. landOwners[].tdsAmount is a
 * standing per-bill figure, not a deduction event, so it is not added.
 * - Only recorded deductions count: rows with isUtrEntry falsy are what the
 *   ledger itself treats as pending/unpaid TDS, so they are skipped (meta).
 * - De-duplicated per owner + bill month (dueMonth normalised, so "Jun 2026"
 *   and "June 2026" collide); local and master owner IDs resolve to the same
 *   site landlord, with a unique landlord name as a legacy fallback.
 * - Uses paidAmount (the amount recorded as paid), falling back to tdsAmount
 *   for older rows. Dated by paidAt, then date; cycle is the bill cycle, not
 *   the deduction date, and is never used to filter Paid TDS.
 * - Always bucketed by MONTH, whatever the range length; rows outside the
 *   selected range (also inside a partially covered month) are excluded.
 * Each bucket carries `deductions[]` — the exact rows behind its amount — so a
 * month's breakdown always matches the chart under the same filters.
 */
const computeTds = (docs, filters, lib) => {
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
    const ownerIdentity = tdsOwnerIdentity(doc);
    const seen = new Map();
    for (const [index, t] of tdsRecordedRows(doc, lib).entries()) {
      if (!t) continue;
      if (!isTdsRecorded(t)) { meta.pendingIgnored += 1; continue; }
      const identity = ownerIdentity.forEntry(t, index);
      const billMonth = parseMonthLabel(t.dueMonth) || toDate(t.cycle);
      const monthPart = billMonth ? monthKeyOf(billMonth) : text(t.dueMonth) || `row:${idOf(t._id)}`;
      const key = `${identity.key}|${monthPart}`;
      const prev = seen.get(key);
      if (prev) {
        meta.duplicatesIgnored += 1;
        const previous = prev.entry;
        const previousDate = tdsPaymentDate(previous) || toDate(previous.createdAt);
        const entryDate = tdsPaymentDate(t) || toDate(t.createdAt);
        if ((entryDate?.getTime() ?? 0) >= (previousDate?.getTime() ?? 0)) seen.set(key, { entry: t, identity });
      } else {
        seen.set(key, { entry: t, identity });
      }
    }
    for (const { entry: t, identity } of seen.values()) {
      const amount = tdsPaidAmount(t);
      if (amount <= 0) continue;
      const d = tdsPaymentDate(t);
      if (!d) { meta.recordsWithoutDate += 1; continue; }
      if (!inRange(d, f)) continue;
      if (!siteMatches(doc, attr, f, excl, amount)) continue;
      const b = buckets.get(monthKeyOf(d));
      if (!b) continue;
      const ownerKey = `${sid}|${identity.key}`;
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
        paymentCycle: paymentCycleOf(doc),
        siteName: name,
        mediaCodes: codes,
        mediaType: typeLabel(attr),
        city: cityLabel(attr),
        ownerName: identity.ownerName,
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
          paymentCycle: paymentCycleOf(doc),
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

/**
 * TDS — Total / Paid / Upcoming (the TDS analytics cards and chart). Source-independent: it combines the two stored TDS records, each used
 * for what it is the record of, and never estimates anything.
 *
 * A TDS UNIT is one landlord's TDS for one generated bill month:
 *  - the bills are rentalDue[] (one per site per due month — several faces of a site count once: the approved row, else the latest updated),
 *    dated by the bill's due date; nothing is projected, a future month only exists when its bill is already stored;
 *  - the landlord's TDS is the configured amount in Rental Master as of the due date (lib.landOwnersAsOfDate); only landlords with
 *    tdsApplicable = 1 and a configured amount count, those on a CMD TDS hold (tdsHold = 1) are skipped (reported in meta);
 *  - PAID = the Ledger recorded the deduction: a tdsBalanceHistory row with isUtrEntry for the same landlord and bill month (the key the
 *    ledger save upserts by; duplicates collapse, the latest paidAt/date wins). Such a unit counts the deducted amount, its UTR and paid date.
 *    A recorded deduction whose bill month has no stored bill unit is still paid TDS (meta.deductionsWithoutBill), placed in its bill month;
 *  - otherwise UPCOMING when the bill's due date is after today (IST day) — a stored future bill, not a projection —, else DUE (due on or
 *    before today, no deduction recorded yet).
 * total = paid + due + upcoming, each unit exactly once; sites are distinct across them. The period applies to the unit's month.
 * @param lib { landOwnersAsOfDate }
 */
const computeTdsStatus = (docs, filters, lib, now = nowIST()) => {
  const f = { ...filters, granularity: "month" };
  const todayKey = dayKeyOf(startOfUtcDay(now));
  const CATS = ["paid", "due", "upcoming"];
  const mk = () => ({ amount: 0, entries: 0, sites: new Set() });
  const mkAll = () => ({ total: mk(), paid: mk(), due: mk(), upcoming: mk() });
  const buckets = buildBuckets(f, mkAll);
  const totals = mkAll();
  const excl = newExclusions();
  const meta = { billsWithoutDate: 0, duplicateBillsIgnored: 0, heldOwnersSkipped: 0, applicableWithoutAmount: 0, deductionsWithoutBill: 0, duplicateDeductionsIgnored: 0, pendingDeductionRowsIgnored: 0 };
  const rows = f.details ? [] : null;
  const cityLabel = (attr) => (attr.city === MIXED ? "Multiple cities" : attr.city || null);

  for (const doc of docs) {
    const attr = siteAttr(doc);
    const name = siteName(doc);
    const sid = idOf(doc._id);
    const codes = uniq(faceList(doc).map((fc) => text(fc.mediaCode)));
    const ownerIdentity = tdsOwnerIdentity(doc);

    // recorded deductions: landlord + bill month -> the latest row
    const ded = new Map();
    for (const [index, t] of tdsRecordedRows(doc, lib).entries()) {
      if (!t) continue;
      if (!isTdsRecorded(t)) { meta.pendingDeductionRowsIgnored += 1; continue; }
      const identity = ownerIdentity.forEntry(t, index);
      const bm = parseMonthLabel(t.dueMonth) || toDate(t.cycle);
      const key = `${identity.key}|${bm ? monthKeyOf(bm) : text(t.dueMonth) || `row:${idOf(t._id)}`}`;
      const prev = ded.get(key);
      if (prev) {
        meta.duplicateDeductionsIgnored += 1;
        const previousDate = tdsPaymentDate(prev.entry) || toDate(prev.entry.createdAt);
        const entryDate = tdsPaymentDate(t) || toDate(t.createdAt);
        if ((entryDate?.getTime() ?? 0) >= (previousDate?.getTime() ?? 0)) ded.set(key, { entry: t, identity });
      } else ded.set(key, { entry: t, identity });
    }

    // one bill per month
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

    const used = new Set();
    const emit = (monthDate, status, amount, info) => {
      if (!inRange(monthDate, f)) return;
      if (!siteMatches(doc, attr, f, excl, amount)) return;
      const b = buckets.get(monthKeyOf(monthDate));
      if (!b) return;
      for (const part of [b, totals]) for (const c of ["total", status]) { const t = part[c]; t.amount += amount; t.entries += 1; t.sites.add(sid); }
      if (rows) {
        rows.push({
          ...detailBase(doc),
          mediaType: typeLabel(attr),
          city: cityLabel(attr),
          mediaCodes: codes,
          siteName: name,
          date: info.date,
          bucket: monthKeyOf(monthDate),
          status,
          amount: r2(amount),
          billMonth: info.billMonth,
          ownerName: info.ownerName,
          dueDate: info.dueDate,
          paidAt: info.paidAt,
          utrNumber: info.utrNumber,
          billStatus: info.billStatus,
        });
      }
    };

    for (const [mkey, bill] of perMonth) {
      const d = toDate(bill.dueDate);
      if (!inRange(d, f)) continue;
      for (const o of lib.landOwnersAsOfDate(doc, d) || []) {
        if (!o) continue;
        if (num(o.tdsHold) === 1) { meta.heldOwnersSkipped += 1; continue; }
        if (num(o.tdsApplicable) !== 1) continue;
        const configured = num(o.tdsAmount);
        if (configured <= 0) { meta.applicableWithoutAmount += 1; continue; }
        const key = `${ownerIdentity.ownerKey(o)}|${mkey}`;
        const deduction = ded.get(key);
        const dueKey = dayKeyOf(d);
        const billMonth = text(bill.dueMonth) || `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
        const common = { billMonth, ownerName: text(o.name) || null, dueDate: dueKey, billStatus: BILL_STATUS[num(bill.approvalStatus ?? bill.status)] || "Unknown" };
        if (deduction) {
          used.add(key);
          const t = deduction.entry;
          const paidOn = tdsPaymentDate(t);
          const amount = tdsPaidAmount(t) || configured;
          emit(d, "paid", amount, { ...common, date: paidOn ? dayKeyOf(paidOn) : dueKey, paidAt: paidOn ? dayKeyOf(paidOn) : null, utrNumber: text(t.utrNumber) || null });
        } else {
          emit(d, dueKey > todayKey ? "upcoming" : "due", configured, { ...common, date: dueKey, paidAt: null, utrNumber: null });
        }
      }
    }
    // a recorded deduction with no stored bill unit is still TDS paid: counted in its bill month
    for (const [key, deduction] of ded) {
      if (used.has(key)) continue;
      const t = deduction.entry;
      const bm = parseMonthLabel(t.dueMonth) || toDate(t.cycle);
      const amount = tdsPaidAmount(t);
      if (!bm || amount <= 0) continue;
      meta.deductionsWithoutBill += 1;
      const paidOn = tdsPaymentDate(t);
      emit(bm, "paid", amount, { billMonth: text(t.dueMonth) || `${MONTH_NAMES[bm.getUTCMonth()]} ${bm.getUTCFullYear()}`, ownerName: deduction.identity.ownerName, dueDate: null, date: paidOn ? dayKeyOf(paidOn) : dayKeyOf(bm), paidAt: paidOn ? dayKeyOf(paidOn) : null, utrNumber: text(t.utrNumber) || null, billStatus: null });
    }
  }
  const fin = (t) => ({ amount: r2(t.amount), entries: t.entries, sites: t.sites.size });
  const finAll = (o) => ({ total: fin(o.total), paid: fin(o.paid), due: fin(o.due), upcoming: fin(o.upcoming) });
  return {
    filters: publicFilters(f),
    asOf: todayKey,
    buckets: [...buckets].map(([key, b]) => ({ key, ...finAll(b) })),
    summary: finAll(totals),
    ...(rows ? { records: rows.sort((a, z) => a.date.localeCompare(z.date) || a.siteName.localeCompare(z.siteName) || (a.ownerName || "").localeCompare(z.ownerName || "")) } : {}),
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

/**
 * TDS chart: use the existing source-specific calculations for Total and Paid,
 * while retaining the generated-bill status calculation for Due and Upcoming.
 * Rental Master buckets by bill due date; Ledger buckets by deduction date.
 */
const computeTdsOverview = (docs, filters, lib, now = nowIST()) => {
  const status = computeTdsStatus(docs, filters, lib, now);
  const rentalMaster = computeTdsRentalMaster(docs, { ...filters, source: "rentalMaster" }, lib);
  const ledger = computeTds(docs, { ...filters, source: "ledger" }, lib);
  const metric = (amount, entries, sites) => ({ amount, entries, sites });
  const rentalMasterBuckets = new Map(rentalMaster.buckets.map((b) => [b.key, b]));
  const ledgerBuckets = new Map(ledger.buckets.map((b) => [b.key, b]));
  const bySource = (sourceBuckets, key) => {
    const bucket = sourceBuckets.get(key);
    return metric(bucket?.amount ?? 0, bucket?.entries ?? 0, bucket?.sites ?? 0);
  };
  const details = filters.details
    ? {
        rentalMasterBuckets: rentalMaster.buckets,
        ledgerBuckets: ledger.buckets,
      }
    : undefined;

  // Paid detail rows are the Ledger deductions behind the Paid card/chart (same paidAt/date month and
  // amount), not the bill-month rows of the status calculation; Due / Upcoming rows stay as they were.
  let records = status.records;
  if (records) {
    const docById = new Map(docs.map((doc) => [idOf(doc._id), doc]));
    const paidRecords = ledger.buckets.flatMap((bucket) => bucket.deductions.map((x) => ({
      ...detailBase(docById.get(x.siteId) || { _id: x.siteId }),
      mediaType: x.mediaType,
      city: x.city,
      mediaCodes: x.mediaCodes,
      siteName: x.siteName,
      date: x.date,
      bucket: bucket.key,
      status: "paid",
      amount: x.amount,
      billMonth: x.billMonth,
      ownerName: x.ownerName,
      dueDate: null,
      paidAt: x.date,
      utrNumber: x.utrNumber,
      billStatus: null,
    })));
    records = [...records.filter((r) => r.status !== "paid"), ...paidRecords]
      .sort((a, z) => a.date.localeCompare(z.date) || a.siteName.localeCompare(z.siteName) || (a.ownerName || "").localeCompare(z.ownerName || ""));
  }

  return {
    ...status,
    ...(records ? { records } : {}),
    meta: { ...status.meta, ledgerPaid: ledger.meta },
    summary: {
      ...status.summary,
      total: metric(rentalMaster.summary.total, rentalMaster.summary.entries, rentalMaster.summary.sites),
      paid: metric(ledger.summary.total, ledger.summary.entries, ledger.summary.sites),
    },
    buckets: status.buckets.map((bucket) => ({
      ...bucket,
      total: bySource(rentalMasterBuckets, bucket.key),
      paid: bySource(ledgerBuckets, bucket.key),
    })),
    ...(details ? { sourceDetails: details } : {}),
  };
};

/**
 * Outstanding Payments — one unit per site × billing-month cycle (never per face
 * bill, so several faces of a site never repeat its amount), from the existing
 * Rental Master / Ledger cycle calculation:
 *  - cycles: lib.getAllDueCycles (billing start + frequency, plus months of existing
 *    bill rows) on the site WITHOUT its stale rows (isStaleBill), one per month;
 *    the cycle date is the due date; only cycles due within [start, end] count
 *  - remaining = getOverallSummaryForCycle(site, cycle month):
 *      currentMonthRentPending  (unpaid landlord shares — the ledger's paid rule:
 *                                a landlord + mode is paid once a ledger entry
 *                                exists for that month; direct GST rides with rent)
 *    + currentMonthGstPending   (held GST not yet released via gstBalanceHistory)
 *    A cycle with remaining = 0 is settled and excluded. Approval status plays no part.
 *  - category against TODAY (IST calendar day, nowIST — the stored-date convention):
 *      upcoming = due after today · dueToday = due today · overdue = due before today
 *    Overdue here is PAYMENT-based (remaining > 0), unlike the approval-based overdue
 *    of Rental Master / the dashboard (not fully approved and past due).
 *  - unallocated: a cycle of a site with no landlord (rent cannot be computed — the
 *    ledger would report only GST) or no active face is NOT counted as paid or
 *    outstanding; it is listed in summary.unallocated with the ledger's remaining
 *    and the configured rent, outside the total.
 *  - status of a cycle: the LEAST advanced approval status of its current-face bill
 *    rows (fully approved only when every row is), "Not billed yet" without rows.
 *  - media type / city: site-level (siteMatches; mixed sites leave filtered views,
 *    as in the other money charts), because the unit is the site.
 *  Opening balances (onboarding outstanding history) are not billing cycles and are
 *  not included. Nothing is written.
 * @param lib { getAllDueCycles, getOverallSummaryForCycle, mediaAsOfDate }
 */
const computeOutstanding = (docs, f, lib, now = nowIST()) => {
  const base = computeOutstandingCycles(docs, f, lib, now);
  const { records: billRecords, ...approvals } = computeBillApprovals(docs, f, lib, now);
  return { ...base, approvals, ...(billRecords ? { billRecords } : {}) };
};

const computeOutstandingCycles = (docs, f, lib, now = nowIST()) => {
  const today = startOfUtcDay(now);
  const tomorrow = new Date(today.getTime() + MS_DAY);
  const endYM = { year: f.end.getUTCFullYear(), month: f.end.getUTCMonth() + 1 };
  const CATS = ["upcoming", "dueToday", "overdue"];
  const mk = () => ({ cycles: 0, sites: new Set(), amount: 0, rent: 0, gst: 0, notYetBilled: 0, byStatus: {}, byType: {} });
  const mkAll = () => Object.fromEntries(CATS.map((c) => [c, mk()]));
  const buckets = buildBuckets(f, mkAll);
  const totals = mkAll();
  const excl = newExclusions();
  const unallocated = { cycles: 0, sites: new Set(), ledgerRemaining: 0, configuredRent: 0, records: [] };
  const meta = { cyclesChecked: 0, settledCycles: 0, staleRowsIgnored: 0 };
  const records = f.details ? [] : null; // per-cycle rows for the export, only when asked for

  for (const doc of docs) {
    const faces = faceList(doc);
    const rows = (doc.rentalDue || []).filter(Boolean);
    const clean = { ...doc, rentalDue: rows.filter((b) => !isStaleBill(doc, b)) };
    meta.staleRowsIgnored += rows.length - clean.rentalDue.length;
    const attr = siteAttr(doc);
    const sid = idOf(doc._id);
    const seen = new Set();
    let matched = null; // site filter decided once, only when the site has a cycle in range
    for (const c of lib.getAllDueCycles(clean, endYM) || []) {
      const d = toDate(c);
      if (!d || !inRange(d, f)) continue;
      const mkey = monthKeyOf(d);
      if (seen.has(mkey)) continue;
      seen.add(mkey);
      if (matched === null) matched = siteMatches(doc, attr, f, excl, 0);
      if (!matched) continue;
      meta.cyclesChecked += 1;
      const ym = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
      const s = lib.getOverallSummaryForCycle(clean, ym);
      const rent = num(s.currentMonthRentPending);
      const gst = num(s.currentMonthGstPending);
      const noLandlord = !(doc.landOwners || []).length;
      const noActiveFace = !faces.some((fc) => num(fc.status) === 1);
      if (noLandlord || noActiveFace) {
        const configured = num((lib.mediaAsOfDate(clean, d) || {}).rentalPayment?.totalRentalAmount);
        unallocated.cycles += 1;
        unallocated.sites.add(sid);
        unallocated.ledgerRemaining += rent + gst;
        unallocated.configuredRent += configured;
        unallocated.records.push({
          siteId: sid, siteName: siteName(doc), dueDate: dayKeyOf(d), month: mkey,
          reason: noLandlord ? "no landlord" : "no active face", ledgerRemaining: r2(rent + gst), configuredRent: r2(configured),
        });
        continue;
      }
      const remaining = rent + gst;
      if (remaining <= 0) { meta.settledCycles += 1; continue; }
      const cat = d >= tomorrow ? "upcoming" : d >= today ? "dueToday" : "overdue";
      const monthRows = clean.rentalDue.filter((b) => { const bd = toDate(b.dueDate); return bd && monthKeyOf(bd) === mkey; });
      const status = monthRows.length
        ? BILL_STATUS[Math.min(...monthRows.map((b) => num(b.approvalStatus ?? b.status) || 1))] || "Unknown"
        : "Not billed yet";
      const tl = typeLabel(attr);
      if (records) {
        const codeOf = (id) => (faces.find((fc) => idOf(fc._id) === idOf(id)) || {}).mediaCode || null;
        records.push({
          siteId: sid,
          paymentCycle: paymentCycleOf(doc),
          landlords: landlordsOf(doc),
          siteName: siteName(doc),
          mediaCodes: uniq(faces.map((fc) => text(fc.mediaCode))),
          city: attr.city === MIXED ? "Multiple cities" : attr.city || null,
          mediaType: tl,
          dueDate: dayKeyOf(d),
          month: mkey,
          category: cat,
          status,
          rent: r2(rent),
          gst: r2(gst),
          remaining: r2(remaining),
          // the cycle's current-face bill rows (amounts as stored; the remaining comes from the ledger)
          bills: monthRows.map((row) => ({
            billId: idOf(row._id) || null,
            mediaCode: row.mediaDetailId ? codeOf(row.mediaDetailId) : null,
            siteLevel: !row.mediaDetailId,
            dueDate: toDate(row.dueDate) ? dayKeyOf(toDate(row.dueDate)) : null,
            dueMonth: text(row.dueMonth) || null,
            baseAmount: r2(num(row.baseAmount)),
            gstAmount: r2(num(row.gstAmount)),
            netPayable: r2(num(row.netPayable)),
            approvalStatus: BILL_STATUS[num(row.approvalStatus ?? row.status)] || "Unknown",
          })),
        });
      }
      const b = buckets.get(bucketKey(d, f.granularity));
      for (const part of [b && b[cat], totals[cat]]) {
        if (!part) continue;
        part.cycles += 1; part.sites.add(sid); part.amount += remaining; part.rent += rent; part.gst += gst;
        if (!monthRows.length) part.notYetBilled += 1;
        const st = (part.byStatus[status] ||= { cycles: 0, amount: 0 });
        st.cycles += 1; st.amount += remaining;
        const ty = (part.byType[tl] ||= { cycles: 0, amount: 0 });
        ty.cycles += 1; ty.amount += remaining;
      }
    }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { cycles: v.cycles, amount: r2(v.amount) }]));
  const fin = (p) => ({ cycles: p.cycles, sites: p.sites.size, amount: r2(p.amount), rent: r2(p.rent), gst: r2(p.gst), notYetBilled: p.notYetBilled, byStatus: round(p.byStatus), byType: round(p.byType) });
  const totalOf = (parts) => {
    const sites = new Set(CATS.flatMap((c) => [...parts[c].sites]));
    return { cycles: CATS.reduce((x, c) => x + parts[c].cycles, 0), sites: sites.size, amount: r2(CATS.reduce((x, c) => x + parts[c].amount, 0)) };
  };
  return {
    filters: publicFilters(f),
    today: dayKeyOf(today),
    unit: "siteCycle",
    buckets: [...buckets].map(([key, b]) => ({ key, ...Object.fromEntries(CATS.map((c) => [c, fin(b[c])])), total: totalOf(b) })),
    summary: {
      ...Object.fromEntries(CATS.map((c) => [c, fin(totals[c])])),
      total: totalOf(totals),
      unallocated: { cycles: unallocated.cycles, sites: unallocated.sites.size, ledgerRemaining: r2(unallocated.ledgerRemaining), configuredRent: r2(unallocated.configuredRent), records: unallocated.records },
    },
    ...(records ? { records: records.sort((a, z) => a.dueDate.localeCompare(z.dueDate) || a.siteName.localeCompare(z.siteName)) } : {}),
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
  };
};

/**
 * Outstanding Payments — bill approvals (additive: nothing above is changed; computeOutstanding adds this as
 * `approvals` and, with details, `billRecords`). One unit per stored bill row (rentalDue), the rows computeBills
 * already reads: stale rows (isStaleBill) are left out, a bill's media type is its own face's (billMediaType), the city
 * filter is site-level, and a bill belongs to the period by its dueDate.
 *
 *  generated — every such bill                                    (amount = baseAmount = rent + GST, gross)
 *  approved  — approvalStatus 3                                   (the rule of rentalDueStats / Rental Master)
 *  pending   — approvalStatus 1 (Pending) or 2 (Partially approved)
 *  pastDue   — dueDate before today (IST calendar day) AND approvalStatus ≠ 3 — the overdue rule of
 *              rentalDueStats / the dashboard; a SUBSET of pending (approval status and due date are different
 *              concepts: a pending bill can be past due, an approved bill never is)
 *  generated = approved + pending (+ `other`: a stored status outside 1-3, reported in meta, never silently dropped).
 *  Each bill is counted once per category; categories are views of the same bills, not parts to be added.
 *
 * Pending bills by stage: the dashboard's own helper (DashboardExtras.pendingRoleOf, passed in as lib.pendingRoleOf) —
 * the earliest open approvalSteps entry above any approved step, else currentPendingRole. Roles are the stored
 * ROLE numbers: 1 = Staff (the app's "Rental Executive"), 2 = Team Lead ("Rental Manager"), 3 = Owner ("CMD").
 * A pending bill whose stage cannot be resolved is counted under `unknown`, never assigned to a stage.
 *
 * Rental / GST / Hold GST of a bill (the computeGstSplit rules): rental = baseAmount − gstAmount; the GST is
 * "direct" (withGst 2: paid with the rent) or "hold" (withGst 0 / 1: held until the receipt), never both;
 * total = rental + GST + hold GST = baseAmount.
 */
const STAGE_KEY = { 1: "sales", 2: "manager", 3: "cmd" };

/**
 * The bill's approval chain exactly as stored (rentalDue[].approvalSteps): per role the step's status (1 pending, 2 approved,
 * 3 skipped), approver name and approval time, ordered Staff → Team Lead → Owner. Nothing is inferred; a bill without stored
 * steps ships an empty list and the popup shows no chain for it.
 */
const approvalStepsOf = (bill) =>
  (Array.isArray(bill.approvalSteps) ? bill.approvalSteps.filter(Boolean) : [])
    .map((st) => ({ role: num(st.role), status: num(st.status), userName: text(st.userName) || null, approvedAt: toDate(st.approvedAt) ? toDate(st.approvedAt).toISOString() : null }))
    .sort((a, z) => a.role - z.role);
const computeBillApprovals = (docs, f, lib, now = nowIST()) => {
  const today = startOfUtcDay(now);
  const mkCat = () => ({ bills: 0, sites: new Set(), amount: 0 });
  const mkStage = () => ({ sales: { bills: 0, amount: 0 }, manager: { bills: 0, amount: 0 }, cmd: { bills: 0, amount: 0 }, unknown: { bills: 0, amount: 0 } });
  const mk = () => ({ generated: mkCat(), approved: mkCat(), pending: mkCat(), pastDue: mkCat(), pendingByStage: mkStage(), pendingByType: {}, generatedByType: {} });
  const buckets = buildBuckets(f, mk);
  const total = mk();
  const excl = newExclusions();
  const meta = { billsWithoutDueDate: 0, statusOutsideKnown: 0, pendingStageUnknown: 0 };
  const records = f.details ? [] : null;
  const bump = (c, sid, amount) => { c.bills += 1; c.sites.add(sid); c.amount += amount; };
  const bumpType = (map, type, amount) => { const t = (map[type] ||= { bills: 0, amount: 0 }); t.bills += 1; t.amount += amount; };

  for (const doc of docs) {
    const attr = siteAttr(doc);
    const sid = idOf(doc._id);
    const faces = faceList(doc);
    for (const bill of doc.rentalDue || []) {
      if (!bill) continue;
      const d = toDate(bill.dueDate);
      if (!d) { meta.billsWithoutDueDate += 1; continue; }
      if (!inRange(d, f)) continue;
      const base = num(bill.baseAmount);
      if (isStaleBill(doc, bill)) continue;
      const type = billMediaType(doc, bill);
      if (f.mediaType) {
        if (type === MIXED) { excl.sites.add(sid); excl.amount += base; continue; }
        if (type !== f.mediaType) continue;
      }
      if (!siteMatches(doc, attr, { ...f, mediaType: "" }, excl, base)) continue;
      const b = buckets.get(bucketKey(d, f.granularity));
      if (!b) continue;
      const status = num(bill.approvalStatus ?? bill.status);
      const approved = status === 3;
      const pending = status === 1 || status === 2;
      if (!approved && !pending) meta.statusOutsideKnown += 1;
      const pastDue = !approved && d < today;
      const tl = typeLabel({ mediaType: type });
      let stage = null;
      if (pending) {
        const role = lib && lib.pendingRoleOf ? lib.pendingRoleOf(bill) : null;
        stage = STAGE_KEY[role] || "unknown";
        if (stage === "unknown") meta.pendingStageUnknown += 1;
      }
      for (const part of [b, total]) {
        bump(part.generated, sid, base);
        bumpType(part.generatedByType, tl, base);
        if (approved) bump(part.approved, sid, base);
        if (pending) {
          bump(part.pending, sid, base);
          bumpType(part.pendingByType, tl, base);
          part.pendingByStage[stage].bills += 1;
          part.pendingByStage[stage].amount += base;
        }
        if (pastDue) bump(part.pastDue, sid, base);
      }
      if (records) {
        const gst = num(bill.gstAmount);
        const direct = num(bill.withGst) === 2;
        const face = bill.mediaDetailId ? faces.find((fc) => idOf(fc._id) === idOf(bill.mediaDetailId)) : null;
        records.push({
          billId: idOf(bill._id) || null,
          siteId: sid,
          paymentCycle: paymentCycleOf(doc),
          siteName: siteName(doc),
          city: cityOf(doc),
          landlords: landlordsOf(doc),
          mediaCodes: face && text(face.mediaCode) ? [text(face.mediaCode)] : mediaCodesOf(doc),
          mediaType: tl,
          dueDate: dayKeyOf(d),
          month: monthKeyOf(d),
          bucket: bucketKey(d, f.granularity),
          billMonth: text(bill.dueMonth) || null,
          approvalStatus: BILL_STATUS[status] || "Unknown",
          stage, // sales | manager | cmd | unknown (pending bills only)
          approvalSteps: approvalStepsOf(bill),
          approved, pending, pastDue,
          rental: r2(base - gst),
          gst: r2(direct ? gst : 0),
          holdGst: r2(direct ? 0 : gst),
          total: r2(base),
        });
      }
    }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { bills: v.bills, amount: r2(v.amount) }]));
  const fin = (c) => ({ bills: c.bills, sites: c.sites.size, amount: r2(c.amount) });
  const finAll = (x) => ({
    generated: fin(x.generated), approved: fin(x.approved), pending: fin(x.pending), pastDue: fin(x.pastDue),
    pendingByStage: round(x.pendingByStage), pendingByType: round(x.pendingByType), generatedByType: round(x.generatedByType),
  });
  return {
    today: dayKeyOf(today),
    unit: "bill",
    buckets: [...buckets].map(([key, x]) => ({ key, ...finAll(x) })),
    summary: finAll(total),
    meta: { ...meta, excludedMixedSites: exclusionMeta(excl) },
    ...(records ? { records: records.sort((a, z) => a.dueDate.localeCompare(z.dueDate) || a.siteName.localeCompare(z.siteName)) } : {}),
  };
};

module.exports = {
  computeBillApprovals,
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
  computeAgreements,
  computeBills,
  computeOutstanding,
  computeGst,
  computeLedgerGst,
  computeTds,
  computeTdsRentalMaster,
  computeTdsStatus,
  computeTdsOverview,
  SOURCES,
  DEFAULT_SOURCE,
  SITE_STATUSES,
  DEFAULT_SITE_STATUS,
  isActiveSite,
  applySiteStatus,
  siteAttr,
  billMediaType,
  isStaleBill,
};
