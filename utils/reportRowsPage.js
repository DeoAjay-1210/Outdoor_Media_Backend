// ─────────────────────────────────────────────────────────────
// ✅ NEW — Report Analytics popups: server-side rows, search, sort and scroll pages (one file for every popup)
//   • Outstanding payments (upcoming-bills, data.billRows): buildBillRowsPage
//   • Payment analytics (payments) / GST (gst), data.detailRows: buildPaymentRowsPage / buildGstRowsPage
// ─────────────────────────────────────────────────────────────

// ── Outstanding payments popup
// (POST /report-analytics/upcoming-bills with body.rows).
//
// Input: the bill records computeRentalMasterApprovals builds with `details` (one per bill / face).
// The popup shows ONE row per landlord (the frontend's _mergeRecs rule for bill tables: a landlord's
// sites, faces and months become one row; a bill without a landlord name stays one row per site).
// Here the same groups are formed, searched, sorted and cut into pages; the response carries the bill
// records of the page's groups only, so the popup draws them exactly as before (Combined Sites, View
// Approval, months) and its totals / cards come from ALL rows.
// Pure: no DB access.
// ─────────────────────────────────────────────────────────────

// ✅ NEW — "sites" = faces (mediaDetails): a record of one face (a bill: faceId) counts 1, a campaign part counts its faces
// (faceIds), any other record counts its site's faces (reportAnalytics.siteCount, noted on every chart load).
const { siteCount } = require("./reportAnalytics");
const siteKeysOf = (r) => {
  const sid = r && r.siteId !== undefined && r.siteId !== null ? String(r.siteId).trim() : "";
  if (!sid) return [];
  if (r.faceId) return [`${sid}#${r.faceId}`];
  if (Array.isArray(r.faceIds) && r.faceIds.length) return r.faceIds.map((fid) => `${sid}#${fid}`);
  return [sid];
};
const sitesOf = (rows) => siteCount(new Set((rows || []).flatMap(siteKeysOf)));

const CATEGORIES = [
  { key: "generated", label: "Bill Generated" },
  { key: "approved", label: "Approved" },
  { key: "pending", label: "Pending Approval" },
  { key: "pastDue", label: "Past Due / Overdue" },
  { key: "advance", label: "Advance Bill" },
];
const STAGE_LABELS = { sales: "Rental Executive", manager: "Rental Manager", cmd: "CMD", unknown: "Stage unavailable" };
const STAGE_ORDER = ["Rental Executive", "Rental Manager", "CMD"];
const SORT_KEYS = ["landlordName", "mediaCode", "siteName", "city", "paymentCycle", "rental", "gst", "holdGst", "total", "dueDate", "approvalStatus", "pendingAt", "mediaType"];
const NUMERIC = new Set(["rental", "gst", "holdGst", "total"]);
const DEFAULT_LIMIT = 25; // rows per page (scroll loading)
const MAX_LIMIT = 100;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(num(n) * 100) / 100;

/** same as the popup's billInCategory: generated unless explicitly false, the others when true */
const inCategory = (r, key) => (key === "generated" ? r.generated !== false : r[key] === true);

/** the popup's "Landlord Name" cell: names in order, a nameless one "—", nothing when none has a name */
const landlordNames = (r) => {
  const names = (Array.isArray(r.landlords) ? r.landlords : []).map((l) => str(l && l.name));
  return names.every((n) => !n) ? "" : names.map((n) => n || "—").join(", ");
};
const codesOf = (r) => (Array.isArray(r.mediaCodes) ? r.mediaCodes : []).map(str).filter(Boolean);

/** the popup's date cell "5 Oct 2026" */
const dayText = (iso) => {
  const d = iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
};
/** "123456.5" / "123456" and "1,23,456.50" — how an amount can be typed in the search */
const amountTexts = (n) => {
  const v = r2(n);
  const plain = v % 1 === 0 ? String(v) : v.toFixed(2);
  const grouped = v.toLocaleString("en-IN", { minimumFractionDigits: v % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return [plain, grouped, `₹${grouped}`];
};

/** the least advanced approval status of a group (rejected, pending, partly approved, then the rest) */
const statusRank = (v) => {
  const t = v.toLowerCase();
  return t.includes("reject") ? 0 : t.includes("pending") ? 1 : t.includes("partial") ? 2 : 3;
};

/** One popup row = one landlord (or one site when the bill has no landlord name), its bills in source order. */
function groupRecords(records) {
  const groups = new Map();
  records.forEach((r) => {
    const landlord = landlordNames(r);
    const key = landlord && landlord !== "—" ? `L\u0001${landlord}` : `S\u0001${str(r.siteId) || `${str(r.siteName)}|${codesOf(r).join(", ")}`}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  return [...groups.values()].map(summarizeGroup);
}

function summarizeGroup(recs) {
  const first = recs[0];
  const uniq = (vals) => [...new Set(vals.map(str).filter((v) => v && v !== "—"))];
  // the sites behind the row (a multi-face site lists its faces), as the popup's Combined Sites
  const sites = [];
  const seen = new Set();
  recs.forEach((r) => {
    const codes = codesOf(r).join(", ");
    const faces = Array.isArray(r.faces) ? r.faces : [];
    const faceCodes = faces.map((f) => str(f && f.mediaCode)).filter(Boolean).join(", ");
    const list = faces.length > 1 && faceCodes && faceCodes === codes
      ? faces.map((f) => ({ mediaName: str(f.mediaName) || str(r.siteName), mediaCode: str(f.mediaCode) }))
      : [{ mediaName: str(r.siteName), mediaCode: codes }];
    list.forEach((s) => {
      const k = `${str(r.siteId)}|${s.mediaCode}|${s.mediaName}`;
      if (!seen.has(k)) { seen.add(k); sites.push(s); }
    });
  });
  const combined = sites.length > 1;
  const statuses = uniq(recs.map((r) => r.approvalStatus)).sort((a, z) => statusRank(a) - statusRank(z));
  const stages = uniq(recs.map((r) => STAGE_LABELS[str(r.stage)] || "")).sort((a, z) => (STAGE_ORDER.includes(a) ? STAGE_ORDER.indexOf(a) : 9) - (STAGE_ORDER.includes(z) ? STAGE_ORDER.indexOf(z) : 9));
  const dues = recs.map((r) => str(r.dueDate)).filter(Boolean).sort();
  const sum = (k) => r2(recs.reduce((s, r) => s + num(r[k]), 0));
  const sortValues = {
    landlordName: landlordNames(first).toLowerCase() || null,
    mediaCode: (combined ? uniq(sites.map((s) => s.mediaCode)) : uniq(recs.flatMap(codesOf))).join(", ").toLowerCase() || null,
    siteName: (combined ? sites[0].mediaName : str(first.siteName)).toLowerCase() || null,
    city: uniq(recs.map((r) => r.city)).join(", ").toLowerCase() || null,
    paymentCycle: uniq(recs.map((r) => r.paymentCycle)).join(", ").toLowerCase() || null,
    mediaType: uniq(recs.map((r) => r.mediaType)).join(", ").toLowerCase() || null,
    rental: sum("rental"),
    gst: sum("gst"),
    holdGst: sum("holdGst"),
    total: sum("total"),
    dueDate: dues[0] || null,
    approvalStatus: (statuses[0] || "").toLowerCase() || null,
    pendingAt: (stages[0] || "").toLowerCase() || null,
  };
  // everything a row can be found by (lower case): every cell of every bill, plus the row's own sums
  const hay = [];
  recs.forEach((r) => {
    hay.push(landlordNames(r), codesOf(r).join(", "), str(r.siteName), str(r.city), str(r.paymentCycle), str(r.mediaType), str(r.approvalStatus), STAGE_LABELS[str(r.stage)] || "", str(r.dueDate), dayText(r.dueDate), str(r.billMonth));
    (Array.isArray(r.faces) ? r.faces : []).forEach((f) => hay.push(str(f && f.mediaName), str(f && f.mediaCode)));
    ["rental", "gst", "holdGst", "total"].forEach((k) => hay.push(...amountTexts(r[k])));
  });
  ["rental", "gst", "holdGst", "total"].forEach((k) => hay.push(...amountTexts(sortValues[k])));
  if (combined) hay.push(`combined sites (${sites.length})`);
  return { recs, sortValues, haystack: hay.join("\u0001").toLowerCase(), total: sortValues.total };
}

const matches = (g, q) => {
  const plain = q.replace(/[,₹]/g, "");
  return g.haystack.includes(q) || (plain && plain !== q && g.haystack.includes(plain));
};

/** nulls last in both directions (as the popup's own sort) */
function compare(a, z, key, asc) {
  const av = a.sortValues[key];
  const zv = z.sortValues[key];
  if (av === null && zv === null) return 0;
  if (av === null) return 1;
  if (zv === null) return -1;
  const d = NUMERIC.has(key) ? av - zv : String(av).localeCompare(String(zv));
  return asc ? d : -d;
}

/** body.rows → clean options (unknown values fall back to the defaults) */
function parseRowsQuery(q = {}) {
  const category = CATEGORIES.some((c) => c.key === q.category) ? q.category : "generated";
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return {
    category,
    bucket: str(q.bucket) || null,
    stage: str(q.stage) || null,
    pendingMediaType: str(q.pendingMediaType) || null,
    search: str(q.search).toLowerCase(),
    sortBy: SORT_KEYS.includes(q.sortBy) ? q.sortBy : null,
    sortDir: String(q.sortDir).toLowerCase() === "desc" ? "desc" : "asc",
    page: Math.max(parseInt(q.page, 10) || 1, 1),
    limit,
    newBill: Boolean(q.newBill === true || q.newBill === "true"),
  };
}

/**
 * The popup's page. records = billRecords (all of the period).
 * -> { category, page, limit, totalRows, totalPages, allRows, cards, totals, matching, records }
 *    totalRows = rows after the search; allRows = rows of the category before it; records = the page's bills
 */
function buildBillRowsPage(records, rowsQuery = {}) {
  const o = parseRowsQuery(rowsQuery);
  const all = Array.isArray(records) ? records : [];
  const scoped = all.filter((r) => (!o.bucket || str(r.bucket) === o.bucket) && (!o.newBill || str(r.billKind) === "newBill"));

  const cards = CATEGORIES.map(({ key, label }) => {
    const list = scoped.filter((r) => inCategory(r, key));
    return { key, label, bills: list.length, sites: sitesOf(list), amount: r2(list.reduce((s, r) => s + num(r.total), 0)) };
  });

  const inCat = scoped.filter((r) => inCategory(r, o.category) && (!o.stage || str(r.stage) === o.stage) && (!o.pendingMediaType || str(r.mediaType) === o.pendingMediaType));
  const sum = (k) => r2(inCat.reduce((s, r) => s + num(r[k]), 0));
  const totals = { bills: inCat.length, sites: inCat.length, rental: sum("rental"), gst: sum("gst"), holdGst: sum("holdGst"), total: sum("total") };

  let groups = groupRecords(inCat);
  const allRows = groups.length;
  if (o.search) groups = groups.filter((g) => matches(g, o.search));
  if (o.sortBy) groups = groups.map((g, i) => ({ g, i })).sort((a, z) => compare(a.g, z.g, o.sortBy, o.sortDir === "asc") || a.i - z.i).map((x) => x.g);

  const totalRows = groups.length;
  const totalPages = Math.max(Math.ceil(totalRows / o.limit), 1);
  const page = Math.min(o.page, totalPages);
  const slice = groups.slice((page - 1) * o.limit, page * o.limit);

  return {
    category: o.category,
    bucket: o.bucket,
    search: o.search,
    sortBy: o.sortBy,
    sortDir: o.sortDir,
    page,
    limit: o.limit,
    totalRows,
    totalPages,
    allRows,
    from: totalRows ? (page - 1) * o.limit + 1 : 0,
    to: (page - 1) * o.limit + slice.length,
    cards,
    totals,
    matching: { rows: totalRows, bills: groups.reduce((s, g) => s + g.recs.length, 0), total: r2(groups.reduce((s, g) => s + g.total, 0)) },
    records: slice.flatMap((g) => g.recs),
  };
}

// ─────────────────────────────────────────────────────────────
// Payment analytics / GST popups (POST /report-analytics/payments and /gst with body.rows): the popup rows (Payments = one per
// site, its months summed; GST = one per site bill cycle) grouped per landlord, searched, sorted and paged; cards / totals /
// summary from ALL rows (the app's paymentChoices / gstChoices rules); only the page's raw records are returned.
// ─────────────────────────────────────────────────────────────

const DETAIL_SORT_KEYS = ["landlordName", "mediaCode", "siteName", "city", "paymentCycle", "rental", "gst", "holdGst", "total", "amount", "approvalStatus", "unpaidType", "status", "date", "previousRent", "newRent", "endDate", "billMonth", "mediaType", "dueDate"];
const DETAIL_NUMERIC = new Set(["rental", "gst", "holdGst", "total", "amount", "previousRent", "newRent"]);
const AMOUNT_KEYS = ["rental", "gst", "holdGst", "total", "amount", "previousRent", "newRent"];

/** "October 2026" / "Oct 2026" / "2026-10" → "2026-10" (sorts by month); "" when not a month */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthKey = (v) => {
  const t = str(v);
  if (/^d{4}-d{2}/.test(t)) return t.slice(0, 7);
  const m = t.match(/^([A-Za-z]{3})[a-z]*s+(d{4})$/);
  const i = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return i < 0 ? "" : `${m[2]}-${String(i + 1).padStart(2, "0")}`;
};

function parseQuery(q, categories, fallback) {
  const category = categories.includes(q.category) ? q.category : fallback;
  return {
    category,
    bucket: str(q.bucket) || null,
    search: str(q.search).toLowerCase(),
    sortBy: DETAIL_SORT_KEYS.includes(q.sortBy) ? q.sortBy : null,
    sortDir: String(q.sortDir).toLowerCase() === "desc" ? "desc" : "asc",
    page: Math.max(parseInt(q.page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT),
    newBill: Boolean(q.newBill === true || q.newBill === "true"),
  };
}

/**
 * units: the popup's rows in their default order — { recs, values: {rental,gst,holdGst,total,amount}, texts: { approvalStatus, unpaidType } }.
 * Grouped per landlord (a row without a landlord name stays per site), searched, sorted, paged.
 */
function pageUnits(units, o) {
  const groups = new Map();
  units.forEach((u) => {
    const r = u.recs[0] || {};
    const landlord = u.landlord !== undefined ? str(u.landlord) : landlordNames(r); // a unit may name its own landlord (TDS lines: ownerName)
    // + groupExtra: the cells the popup does not combine (an agreement's dates / status, a TDS line's UTR …) — rows merge only
    // when they match, as the popup merges them, so the row count is the popup's
    const own = landlord && landlord !== "—" ? `L\u0001${landlord}` : `S\u0001${str(r.siteId) || `${str(r.siteName)}|${codesOf(r).join(", ")}`}`;
    const key = u.groupExtra ? `${own}\u0002${u.groupExtra.map(str).join("\u0001")}` : own;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  });
  let list = [...groups.values()].map((us) => {
    const recs = us.flatMap((u) => u.recs);
    const first = recs[0] || {};
    const uniq = (vals) => [...new Set(vals.map(str).filter((v) => v && v !== "—"))];
    const sites = uniq(us.map((u) => str(u.recs[0] && u.recs[0].siteId)));
    const sum = (k) => r2(us.reduce((s, u) => s + num(u.values[k]), 0));
    const statuses = uniq(us.map((u) => u.texts.approvalStatus || "")).sort((a, z) => statusRank(a) - statusRank(z));
    const sortValues = {
      landlordName: (us[0].landlord !== undefined ? str(us[0].landlord) : landlordNames(first)).toLowerCase() || null,
      mediaCode: uniq(recs.flatMap(codesOf)).join(", ").toLowerCase() || null,
      siteName: str(first.siteName).toLowerCase() || null,
      city: uniq(recs.map((r) => r.city)).join(", ").toLowerCase() || null,
      paymentCycle: uniq(recs.map((r) => r.paymentCycle)).join(", ").toLowerCase() || null,
      approvalStatus: (statuses[0] || "").toLowerCase() || null,
      unpaidType: uniq(us.map((u) => u.texts.unpaidType || "")).join(", ").toLowerCase() || null,
      status: uniq(us.map((u) => u.texts.status || "")).join(", ").toLowerCase() || null,
      date: us.map((u) => u.texts.date || "").filter(Boolean).sort()[0] || null, // the earliest
      endDate: us.map((u) => u.texts.endDate || "").filter(Boolean).sort()[0] || null,
      billMonth: us.map((u) => monthKey(u.texts.billMonth)).filter(Boolean).sort()[0] || null, // chronological (YYYY-MM)
      mediaType: uniq(us.map((u) => u.texts.mediaType || "")).join(", ").toLowerCase() || null,
      rental: sum("rental"), gst: sum("gst"), holdGst: sum("holdGst"), total: sum("total"), amount: sum("amount"), previousRent: sum("previousRent"), newRent: sum("newRent"),
    };
    const hay = [];
    us.forEach((u) => {
      const r = u.recs[0] || {};
      hay.push(landlordNames(r), codesOf(r).join(", "), str(r.siteName), str(r.city), str(r.paymentCycle), u.texts.approvalStatus || "", u.texts.unpaidType || "", u.texts.status || "", u.texts.date || "", dayText(u.texts.date), u.texts.endDate || "", dayText(u.texts.endDate), u.texts.billMonth || "", u.texts.mediaType || "", u.landlord !== undefined ? str(u.landlord) : "", ...(u.texts.extra || []));
      (Array.isArray(r.faces) ? r.faces : []).forEach((f) => hay.push(str(f && f.mediaName), str(f && f.mediaCode)));
      u.recs.forEach((x) => hay.push(str(x.dueDate), dayText(x.dueDate), str(x.billMonth)));
      AMOUNT_KEYS.forEach((k) => { if (num(u.values[k])) hay.push(...amountTexts(u.values[k])); });
    });
    AMOUNT_KEYS.forEach((k) => { if (sortValues[k]) hay.push(...amountTexts(sortValues[k])); });
    if (sites.length > 1) hay.push(`combined sites (${sites.length})`);
    return { units: us, recs, sortValues, haystack: hay.join("\u0001").toLowerCase(), headline: sortValues.amount || sortValues.total };
  });
  const allRows = list.length;
  if (o.search) {
    const plain = o.search.replace(/[,₹]/g, "");
    list = list.filter((g) => g.haystack.includes(o.search) || (plain && plain !== o.search && g.haystack.includes(plain)));
  }
  if (o.sortBy) {
    const asc = o.sortDir === "asc";
    list = list
      .map((g, i) => ({ g, i }))
      .sort((a, z) => {
        const av = a.g.sortValues[o.sortBy];
        const zv = z.g.sortValues[o.sortBy];
        if (av === null && zv === null) return a.i - z.i;
        if (av === null) return 1;
        if (zv === null) return -1;
        const d = DETAIL_NUMERIC.has(o.sortBy) ? av - zv : String(av).localeCompare(String(zv));
        return (asc ? d : -d) || a.i - z.i;
      })
      .map((x) => x.g);
  }
  const totalRows = list.length;
  const totalPages = Math.max(Math.ceil(totalRows / o.limit), 1);
  const page = Math.min(o.page, totalPages);
  const slice = list.slice((page - 1) * o.limit, page * o.limit);
  return {
    category: o.category, bucket: o.bucket, search: o.search, sortBy: o.sortBy, sortDir: o.sortDir,
    page, limit: o.limit, totalRows, totalPages, allRows,
    from: totalRows ? (page - 1) * o.limit + 1 : 0,
    to: (page - 1) * o.limit + slice.length,
    matching: { rows: totalRows, total: r2(list.reduce((s, g) => s + g.headline, 0)) },
    records: slice.flatMap((g) => g.recs),
  };
}

// ── Payment analytics: Total Amount to Be Paid / Paid / Unpaid — one row per site, its months summed (paymentChoices) ──
const PAY_CATS = [
  { key: "total", label: "Total Amount to Be Paid" },
  { key: "paid", label: "Paid" },
  { key: "unpaid", label: "Unpaid" },
];
const DUE = ["rentalDue", "directGstDue", "holdGstDue"];
const UNP = ["rentalUnpaid", "directGstUnpaid", "holdGstUnpaid"];

function buildPaymentRowsPage(records, rowsQuery = {}) {
  const o = parseQuery(rowsQuery, PAY_CATS.map((c) => c.key), "total");
  const bySite = new Map();
  (records || []).forEach((r) => {
    if (o.bucket && str(r.month) !== o.bucket) return;
    if (o.newBill && r.kind !== "newBill") return;
    const id = str(r.siteId);
    const s = bySite.get(id) || { recs: [], due: [0, 0, 0], unpaid: [0, 0, 0], approvals: new Set() };
    s.recs.push(r);
    for (let i = 0; i < 3; i++) { s.due[i] += num(r[DUE[i]]); s.unpaid[i] += num(r[UNP[i]]); }
    if (str(r.approvalStatus) && UNP.reduce((a, k) => a + num(r[k]), 0) > 0.005) s.approvals.add(str(r.approvalStatus));
    bySite.set(id, s);
  });
  // the app's order: by site name, then media codes
  const sites = [...bySite.values()].sort((a, z) => str(a.recs[0].siteName).toLowerCase().localeCompare(str(z.recs[0].siteName).toLowerCase()) || codesOf(a.recs[0]).join(", ").localeCompare(codesOf(z.recs[0]).join(", ")));
  const values = (key, s) => [0, 1, 2].map((i) => r2(key === "total" ? s.due[i] : key === "unpaid" ? s.unpaid[i] : Math.max(s.due[i] - s.unpaid[i], 0)));
  const rowsOf = (key) => sites.map((s) => ({ s, v: values(key, s) })).filter((x) => x.v[0] + x.v[1] + x.v[2] > 0.005);

  const cards = PAY_CATS.map(({ key, label }) => {
    const rows = rowsOf(key);
    const amount = r2(rows.reduce((a, x) => a + x.v[0] + x.v[1] + x.v[2], 0));
    return { key, label, bills: rows.length, sites: sitesOf(rows.map((x) => x.s.recs[0])), amount };
  });
  const rows = rowsOf(o.category);
  const sum = (i) => r2(rows.reduce((a, x) => a + x.v[i], 0));
  const totals = { sites: sitesOf(rows.map((x) => x.s.recs[0])), rental: sum(0), gst: sum(1), holdGst: sum(2), total: r2(sum(0) + sum(1) + sum(2)) };
  const units = rows.map(({ s, v }) => ({
    recs: s.recs,
    values: { rental: v[0], gst: v[1], holdGst: v[2], total: r2(v[0] + v[1] + v[2]) },
    texts: { approvalStatus: o.category === "unpaid" ? [...s.approvals].sort().join(" / ") : "" },
    groupExtra: o.category === "unpaid" ? [[...s.approvals].sort().join(" / ")] : undefined,
  }));
  return { ...pageUnits(units, o), cards, totals };
}

// ── GST: Total GST / Paid / Unpaid / Hold — one row per site bill cycle (gstChoices) ──
const GST_CATS = [
  { key: "generated", label: "Total GST" },
  { key: "paid", label: "Paid" },
  { key: "unpaid", label: "Unpaid" },
  { key: "hold", label: "Hold GST" },
];
/** where a row's remaining GST sits (the app's _gstRemainingAs; an older row without remainingAs: held = hold, the rest ledger) */
const remainingAs = (r) => str(r.remainingAs) || (num(r.remaining) > 0.005 ? (str(r.kind) === "hold" ? "hold" : "ledger") : "");
const gstAmountOf = (key, r) => {
  const paid = num(r.paid);
  const remaining = num(r.remaining);
  const as = remainingAs(r);
  if (key === "generated") return paid + remaining;
  if (key === "paid") return paid;
  if (key === "unpaid") return as === "pending" || as === "ledger" ? remaining : 0;
  return as === "hold" ? remaining : 0;
};
const UNPAID_TYPE = { pending: "Pending Approval", ledger: "Ledger Entry" };

function buildGstRowsPage(records, rowsQuery = {}) {
  const o = parseQuery(rowsQuery, GST_CATS.map((c) => c.key), "generated");
  if (o.sortBy === "gst") o.sortBy = "amount"; // the GST popup's amount column is titled "GST" on the Total GST card
  const scoped = (records || []).filter((r) => (!o.bucket || str(r.bucket) === o.bucket) && (!o.newBill || r.kind === "newBill"));
  const cards = GST_CATS.map(({ key, label }) => {
    const rows = scoped.filter((r) => gstAmountOf(key, r) > 0.005);
    const sites = sitesOf(rows);
    return { key, label, bills: sites, sites, records: rows.length, amount: r2(rows.reduce((a, r) => a + gstAmountOf(key, r), 0)) };
  });
  const rows = scoped.filter((r) => gstAmountOf(o.category, r) > 0.005);
  const totals = { bills: rows.length, total: r2(rows.reduce((a, r) => a + gstAmountOf(o.category, r), 0)) };
  // the Unpaid card's two cases (summary strip): Pending Approval / Ledger Entry
  const summary = o.category === "unpaid"
    ? ["pending", "ledger"].map((k) => {
        const part = rows.filter((r) => remainingAs(r) === k);
        return { key: k, label: UNPAID_TYPE[k], amount: r2(part.reduce((a, r) => a + gstAmountOf("unpaid", r), 0)), sites: sitesOf(part) };
      })
    : null;
  const units = rows.map((r) => ({
    recs: [r],
    values: { amount: r2(gstAmountOf(o.category, r)) },
    texts: { approvalStatus: o.category === "unpaid" ? str(r.approvalStatus) : "", unpaidType: o.category === "unpaid" ? UNPAID_TYPE[remainingAs(r)] || "" : "" },
    groupExtra: o.category === "unpaid" ? [UNPAID_TYPE[remainingAs(r)] || "", str(r.approvalStatus)] : undefined,
  }));
  return { ...pageUnits(units, o), cards, totals, ...(summary ? { summary } : {}) };
}

// ── Rent: Total Rent / Paid / Unpaid / Hold — one row per site bill cycle (rentChoices); the GST page's rules on the rent rows ──
const RENT_LABELS = { generated: "Total Rent", hold: "Hold Rent" };
function buildRentRowsPage(records, rowsQuery = {}) {
  const q = { ...(rowsQuery || {}) };
  if (q.sortBy === "rent") q.sortBy = "amount"; // the Rent popup's amount column is titled "Rent" on the Total Rent card
  const page = buildGstRowsPage(records, q);
  return { ...page, cards: page.cards.map((c) => (RENT_LABELS[c.key] ? { ...c, label: RENT_LABELS[c.key] } : c)) };
}

// ── Appraisals: Total Appraisal / Paid / Unpaid / Hold (Pending Approval) / Upcoming — one row per appraisal entry (appraisalChoices) ──
const APPRAISAL_CATS = [
  { key: "total", label: "Total Appraisal", kind: null },
  { key: "given", label: "Paid", kind: "given" },
  { key: "unpaid", label: "Unpaid", kind: "unpaid" },
  { key: "held", label: "Hold (Pending Approval)", kind: "held" },
  { key: "upcoming", label: "Upcoming", kind: "upcoming" },
];
const APPRAISAL_STATUS = { given: "Paid", unpaid: "Unpaid", upcoming: "Upcoming", held: "Hold (Pending Approval)" };

/** POST /report-analytics/appraisal with body.rows → data.detailRows (rows = the appraisal entries; cards = distinct sites + amount). */
function buildAppraisalRowsPage(records, rowsQuery = {}) {
  const o = parseQuery(rowsQuery, APPRAISAL_CATS.map((c) => c.key), "total");
  if (o.sortBy === "total") o.sortBy = "amount";
  const scoped = (records || []).filter((r) => !o.bucket || str(r.bucket) === o.bucket);
  const kindOf = (key) => APPRAISAL_CATS.find((c) => c.key === key).kind;
  const inCat = (key) => scoped.filter((r) => !kindOf(key) || str(r.kind) === kindOf(key));
  const cards = APPRAISAL_CATS.map(({ key, label }) => {
    const rows = inCat(key);
    const sites = sitesOf(rows);
    return { key, label, bills: sites, sites, records: rows.length, amount: r2(rows.reduce((a, r) => a + num(r.amount), 0)) };
  });
  const rows = inCat(o.category);
  const totals = { entries: rows.length, total: r2(rows.reduce((a, r) => a + num(r.amount), 0)) };
  const units = rows.map((r) => ({
    recs: [r],
    values: { amount: num(r.amount), previousRent: num(r.previousRent), newRent: num(r.newRent) },
    texts: { status: `${APPRAISAL_STATUS[str(r.kind)] || ""}${r.changed === true ? " · Changed" : ""}`, date: str(r.date).slice(0, 10) },
    groupExtra: [str(r.date).slice(0, 10), `${APPRAISAL_STATUS[str(r.kind)] || ""}${r.changed === true ? " · Changed" : ""}`],
  }));
  return { ...pageUnits(units, o), cards, totals };
}

// ── Agreements: Total / Live / Expiring Soon / Expired / Draft — one row per filed agreement (agreementChoices);
//    a month bar (rows.bucket = YYYY-MM): Total / Currently Live / Expiring in the month / Expired (agreementMonthChoices) ──
const AGREEMENT_STATE = { live: "Live", expired: "Expired", upcoming: "Upcoming", superseded: "Superseded" };
const agreementStatus = (r) => (str(r.state) === "live" && r.expiringSoon === true ? "Expiring soon" : AGREEMENT_STATE[str(r.state)] || "");
/** the chart's month snapshot (the app's agreementMonthCategory): expired / expiring / live, null = not counted that month */
function agreementMonthCategory(r, month) {
  if (str(r.state) === "superseded") return null;
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return null;
  const first = `${month}-01`;
  const last = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const start = str(r.startDate).slice(0, 10);
  const end = str(r.endDate).slice(0, 10);
  if (!start || !end || start > last) return null;
  return end < first ? "expired" : end <= last ? "expiring" : "live";
}

/** POST /report-analytics/agreements with body.rows → data.detailRows (cards: agreements + distinct sites). */
function buildAgreementRowsPage(records, rowsQuery = {}) {
  const month = str(rowsQuery.bucket);
  const cats = month
    ? [
        { key: "total", label: "Total Agreements", test: (r) => agreementMonthCategory(r, month) !== null },
        { key: "live", label: "Currently Live", test: (r) => agreementMonthCategory(r, month) === "live" },
        { key: "expiring", label: "Expiring in the month", test: (r) => agreementMonthCategory(r, month) === "expiring" },
        { key: "expired", label: "Expired", test: (r) => agreementMonthCategory(r, month) === "expired" },
      ]
    : [
        { key: "total", label: "Total Agreements Filed", test: () => true },
        { key: "live", label: "Live Agreements", test: (r) => str(r.state) === "live" },
        { key: "expiringSoon", label: "Expiring Soon", test: (r) => str(r.state) === "live" && r.expiringSoon === true },
        { key: "expired", label: "Expired Agreements", test: (r) => str(r.state) === "expired" },
        { key: "draft", label: "Draft Agreements", test: (r) => str(r.document) === "Draft" },
      ];
  const o = parseQuery({ ...rowsQuery, bucket: null }, cats.map((c) => c.key), "total");
  o.bucket = month || null;
  const all = records || [];
  const cards = cats.map(({ key, label, test }) => {
    const rows = all.filter(test);
    const sites = sitesOf(rows);
    return { key, label, bills: rows.length, agreements: rows.length, sites, amount: rows.length };
  });
  const rows = all.filter(cats.find((c) => c.key === o.category).test);
  const totals = { sites: sitesOf(rows), agreements: rows.length };
  const units = rows.map((r) => ({
    recs: [r],
    values: {},
    texts: { status: agreementStatus(r), date: str(r.startDate).slice(0, 10), endDate: str(r.endDate).slice(0, 10), extra: [str(r.document)] },
    groupExtra: [str(r.startDate).slice(0, 10), str(r.endDate).slice(0, 10), agreementStatus(r), r.daysToExpiry ?? "", r.reminderDays ?? "", str(r.document), str(r.documentPath)],
  }));
  return { ...pageUnits(units, o), cards, totals };
}

// ── Campaign Live Status: Live / Not Live — one row per site and bill month (campaignChoices) ──
const CAMPAIGN_CATS = [{ key: "live", label: "Live" }, { key: "notLive", label: "Not Live" }];

/** POST /report-analytics/campaign with body.rows → data.detailRows (cards: distinct sites + rent + GST). */
function buildCampaignRowsPage(records, rowsQuery = {}) {
  const o = parseQuery(rowsQuery, CAMPAIGN_CATS.map((c) => c.key), "live");
  if (o.sortBy === "amount") o.sortBy = "total";
  const scoped = (records || []).filter((r) => !o.bucket || str(r.bucket) === o.bucket);
  const sumOf = (rows, k) => r2(rows.reduce((a, r) => a + num(r[k]), 0));
  const cards = CAMPAIGN_CATS.map(({ key, label }) => {
    const rows = scoped.filter((r) => str(r.status) === key);
    const sites = sitesOf(rows);
    return { key, label, bills: sites, sites, records: rows.length, amount: sumOf(rows, "total") };
  });
  const rows = scoped.filter((r) => str(r.status) === o.category);
  const totals = { sites: sitesOf(rows), siteMonths: rows.length, rental: sumOf(rows, "rent"), gst: sumOf(rows, "gst"), total: sumOf(rows, "total") };
  const label = CAMPAIGN_CATS.find((c) => c.key === o.category).label;
  const units = rows.map((r) => ({
    recs: [r],
    values: { rental: num(r.rent), gst: num(r.gst), total: num(r.total) },
    texts: { status: label, billMonth: str(r.billMonth) || str(r.bucket), mediaType: str(r.mediaType) },
  }));
  return { ...pageUnits(units, o), cards, totals };
}

// ── TDS: Total (Rental Master configured TDS) / Paid (Ledger deductions) / Upcoming (stored bills) — one row per line (tdsSourceChoices) ──
const TDS_CATS = [{ key: "total", label: "Total TDS" }, { key: "paid", label: "Paid TDS" }, { key: "upcoming", label: "Upcoming TDS" }];

/** POST /report-analytics/tds-status with body.rows → data.detailRows. data = the whole tds-status section (sourceDetails + records). */
function buildTdsRowsPage(records, rowsQuery = {}, data = {}) {
  const o = parseQuery(rowsQuery, TDS_CATS.map((c) => c.key), "total");
  if (o.sortBy === "dueDate") o.sortBy = "date"; // the Total card's date column is titled "Due Date"
  const src = (data && data.sourceDetails) || {};
  const lines = (buckets) => (buckets || []).filter((b) => !o.bucket || str(b.key) === o.bucket).flatMap((b) => b.deductions || []);
  const linesOf = {
    total: lines(src.rentalMasterBuckets),
    paid: lines(src.ledgerBuckets),
    upcoming: (records || []).filter((r) => (!o.bucket || str(r.bucket) === o.bucket) && str(r.status) === "upcoming"),
  };
  const cards = TDS_CATS.map(({ key, label }) => ({ key, label, bills: sitesOf(linesOf[key]), sites: sitesOf(linesOf[key]), records: linesOf[key].length, amount: r2(linesOf[key].reduce((a, r) => a + num(r.amount), 0)) }));
  const rows = linesOf[o.category];
  const totals = { lines: rows.length, sites: sitesOf(rows), total: r2(rows.reduce((a, r) => a + num(r.amount), 0)) };
  const units = rows.map((r) => ({
    recs: [r],
    landlord: str(r.ownerName),
    values: { amount: num(r.amount) },
    texts: { date: str(r.date).slice(0, 10), billMonth: str(r.billMonth), status: o.category === "paid" ? str(r.utrNumber) : o.category === "total" ? str(r.billStatus) : "Upcoming", extra: [str(r.utrNumber)] },
    groupExtra: o.category === "paid" ? [str(r.utrNumber)] : o.category === "total" ? [str(r.billStatus)] : [str(r.status), str(r.utrNumber)],
  }));
  return { ...pageUnits(units, o), cards, totals };
}

module.exports = {
  buildAgreementRowsPage,
  buildCampaignRowsPage,
  buildTdsRowsPage,
  buildAppraisalRowsPage,
  buildBillRowsPage,
  buildPaymentRowsPage,
  buildGstRowsPage,
  buildRentRowsPage,
  parseRowsQuery,
  groupRecords,
  pageUnits,
  landlordNames,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SORT_KEYS,
  DETAIL_SORT_KEYS,
};
