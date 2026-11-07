// Run: npm test   (node:test, no extra dependencies, no database)
// ADINN OOH lifetime bill number — utils/adinnOohBills.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatAdinnOohBillNo,
  parseAdinnSerial,
  toValidDate,
  billDayKey,
  planMediaBills,
  compareBases,
  createAdinnOohBills,
  ADINN_COUNTER_ID,
} = require("../utils/adinnOohBills");

// ── helpers ──────────────────────────────────────────────────────────────
let idSeq = 0;
const oid = (prefix = "a") => (prefix.repeat(8) + String(++idSeq).padStart(16, "0")).slice(0, 24);
const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d)); // stored bill dates: UTC midnight
const tick = () => new Promise((r) => setImmediate(r));
const clone = (v) => JSON.parse(JSON.stringify(v));

const face = (siteBillMode = 1) => ({ _id: oid("f"), mediaCode: `C${idSeq}`, siteBillMode });
const owner = (landOwnerBillMode = 1, name = `Owner${idSeq}`) => ({ _id: oid("b"), name, landOwnerMasterId: oid("c"), landOwnerBillMode });
const row = (faceId, dueMonth, dueDate, extra = {}) => ({
  _id: oid("e"),
  dueMonth,
  dueDate,
  mediaDetailId: faceId,
  approvalStatus: 3,
  billNo: `adinnooh-old-${idSeq}`,
  createdAt: new Date(dueDate.getTime() + 3600 * 1000),
  adinn_ooh_bills: null,
  ...extra,
});
/** site: faces × landlords, one row per face for each given month */
function site({ faces = 1, owners = 1, siteBillMode = 1, landOwnerBillMode = 1, months = [["November 2026", D(2026, 11, 5)]], status = 3 } = {}) {
  const f = Array.from({ length: faces }, () => face(siteBillMode));
  const o = Array.from({ length: owners }, () => owner(landOwnerBillMode));
  const rentalDue = months.flatMap(([m, d]) => f.map((x) => row(x._id, m, d, { approvalStatus: status })));
  return { _id: oid("d"), mediaDetails: f, landOwners: o, rentalDue };
}

// ── in-memory fakes (Mongo-like behaviour that matters here) ─────────────
function fakeDb(sites = [], { counter = 0, counterExists = true } = {}) {
  const docs = new Map(sites.map((s) => [String(s._id), clone(s)]));
  const registry = [];
  const counters = counterExists ? new Map([[ADINN_COUNTER_ID, counter]]) : new Map();
  const dup = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  const q = (v) => ({ lean: async () => (await tick(), v ? clone(v) : null) });

  const Registry = {
    findOne: (f) => q(registry.find((r) => r.groupKey === f.groupKey)),
    updateOne: async () => (await tick(), { acknowledged: true }),
    create: async (doc) => {
      await tick();
      if (registry.some((r) => r.groupKey === doc.groupKey || r.adinn_ooh_bills === doc.adinn_ooh_bills || r.serial === doc.serial)) throw dup();
      registry.push(clone(doc));
      return doc;
    },
  };
  const Counter = {
    findOneAndUpdate: (f, u) => ({
      lean: async () => {
        await tick();
        if (!counters.has(f._id)) return null; // no upsert
        counters.set(f._id, counters.get(f._id) + u.$inc.seq);
        return { _id: f._id, seq: counters.get(f._id) };
      },
    }),
  };
  const Media = {
    updateOne: async (f, u, opts) => {
      await tick();
      const d = docs.get(String(f._id));
      if (!d) return { matchedCount: 0 };
      const af = opts.arrayFilters[0];
      const ids = af["e._id"].$in.map(String);
      d.rentalDue.forEach((r) => {
        if (!ids.includes(String(r._id)) || r.adinn_ooh_bills) return;
        Object.entries(u.$set).forEach(([k, v]) => (r[k.replace("rentalDue.$[e].", "")] = clone(v)));
      });
      return { matchedCount: 1 };
    },
  };
  const api = createAdinnOohBills({ Media, Registry, Counter, logger: { error: () => {} } });
  return { api, docs, registry, counters, get: (s) => docs.get(String(s._id)) };
}
const numbersOf = (doc) => doc.rentalDue.map((r) => r.adinn_ooh_bills);
const uniq = (a) => [...new Set(a.filter(Boolean))];

// ── number format ────────────────────────────────────────────────────────
test("format: ADNOOHBILL + DDMMYYYY + serial, min 2 digits, no upper limit", () => {
  const d = D(2026, 11, 6);
  assert.equal(formatAdinnOohBillNo(d, 1), "ADNOOHBILL0611202601");
  assert.equal(formatAdinnOohBillNo(d, 9), "ADNOOHBILL0611202609");
  assert.equal(formatAdinnOohBillNo(d, 10), "ADNOOHBILL0611202610");
  assert.equal(formatAdinnOohBillNo(d, 99), "ADNOOHBILL0611202699");
  assert.equal(formatAdinnOohBillNo(d, 100), "ADNOOHBILL06112026100");
  assert.equal(formatAdinnOohBillNo(D(2026, 9, 5), 367), "ADNOOHBILL05092026367");
  assert.equal(formatAdinnOohBillNo(d, 123456), "ADNOOHBILL06112026123456");
});

test("format: India calendar day (no timezone day shift), leap year, ISO string", () => {
  assert.equal(formatAdinnOohBillNo(new Date("2026-11-04T18:30:00.000Z"), 5), "ADNOOHBILL0511202605"); // IST midnight
  assert.equal(formatAdinnOohBillNo(D(2028, 2, 29), 2), "ADNOOHBILL2902202802");
  assert.equal(formatAdinnOohBillNo("2026-12-31", 3), "ADNOOHBILL3112202603");
  assert.equal(formatAdinnOohBillNo(D(2027, 1, 1), 4), "ADNOOHBILL0101202704");
});

test("format: invalid / missing dates and serials are rejected, never replaced by today", () => {
  for (const bad of [null, undefined, "", "not a date", "2026-02-30", "2027-02-29"]) {
    assert.throws(() => formatAdinnOohBillNo(bad, 1), /invalid bill date/);
  }
  for (const bad of [0, -1, 1.5, NaN, "7", null]) {
    assert.throws(() => formatAdinnOohBillNo(D(2026, 1, 1), bad), /invalid serial/);
  }
  assert.equal(toValidDate("2028-02-29").toISOString().slice(0, 10), "2028-02-29");
  assert.equal(billDayKey(D(2026, 9, 5)), 20260905);
});

test("parseAdinnSerial reads the serial back", () => {
  assert.equal(parseAdinnSerial("ADNOOHBILL05092026367"), 367);
  assert.equal(parseAdinnSerial("ADNOOHBILL0611202601"), 1);
  assert.equal(parseAdinnSerial("adinnooh0611202601"), null);
});

// ── the eight business cases ────────────────────────────────────────────
const CASES = [
  { n: 1, faces: 3, owners: 1, siteBillMode: 1, landOwnerBillMode: 1, expected: 1, mode: "single" },
  { n: 2, faces: 3, owners: 2, siteBillMode: 1, landOwnerBillMode: 1, expected: 1, mode: "single" },
  { n: 3, faces: 1, owners: 1, siteBillMode: 1, landOwnerBillMode: 1, expected: 1, mode: "single" },
  { n: 4, faces: 1, owners: 3, siteBillMode: 1, landOwnerBillMode: 1, expected: 1, mode: "single" },
  { n: 5, faces: 3, owners: 1, siteBillMode: 2, landOwnerBillMode: 1, expected: 3, mode: "separate_site" },
  { n: 6, faces: 3, owners: 2, siteBillMode: 2, landOwnerBillMode: 1, expected: 3, mode: "separate_site" },
  { n: 7, faces: 1, owners: 1, siteBillMode: 2, landOwnerBillMode: 2, expected: 1, mode: "separate_site" },
  { n: 8, faces: 1, owners: 3, siteBillMode: 1, landOwnerBillMode: 2, expected: 3, mode: "separate_landlord" },
];

for (const c of CASES) {
  test(`case ${c.n}: ${c.owners} landlord(s), ${c.faces} site(s), ${c.mode} → ${c.expected} bill number(s)`, async () => {
    const s = site(c);
    const oldBillNos = s.rentalDue.map((r) => r.billNo);
    const db = fakeDb([s], { counter: 365 });
    const plan = planMediaBills(s);
    assert.equal(plan.reduce((n, b) => n + b.bills.length, 0), c.expected, "number of bills");
    assert.ok(plan.every((b) => b.billMode === c.mode));

    await db.api.ensureAdinnOohBills(db.get(s));
    const doc = db.get(s);
    assert.equal(db.registry.length, c.expected, "numbers issued");
    assert.equal(uniq(db.registry.map((r) => r.adinn_ooh_bills)).length, c.expected, "unique");
    assert.deepEqual(db.registry.map((r) => r.serial).sort((a, b) => a - b), Array.from({ length: c.expected }, (_, i) => 366 + i), "serials continue");
    assert.ok(db.registry.every((r) => r.adinn_ooh_bills.startsWith("ADNOOHBILL05112026")), "bill date in number");
    assert.ok(doc.rentalDue.every((r) => r.adinn_ooh_bills), "every approved row has a number");
    assert.deepEqual(doc.rentalDue.map((r) => r.billNo), oldBillNos, "billNo unchanged");

    if (c.mode === "single") assert.equal(uniq(numbersOf(doc)).length, 1, "all faces share the one bill number");
    if (c.mode === "separate_site") assert.equal(uniq(numbersOf(doc)).length, c.faces, "one per site");
    if (c.mode === "separate_landlord") {
      const list = doc.rentalDue[0].adinn_ooh_bills_landOwners;
      assert.equal(list.length, c.owners);
      assert.equal(uniq(list.map((x) => x.adinn_ooh_bills)).length, c.owners, "one per landlord");
      assert.equal(doc.rentalDue[0].adinn_ooh_bills, list[0].adinn_ooh_bills, "row number = first landlord");
      assert.deepEqual(list.map((x) => x.landOwnerName), s.landOwners.map((o) => o.name));
    } else {
      assert.ok(doc.rentalDue.every((r) => r.adinn_ooh_bills_landOwners === undefined));
    }
  });
}

// ── eligibility ──────────────────────────────────────────────────────────
test("pending / partially approved bills get no number; approved later → numbered then", async () => {
  const s = site({ faces: 2, status: 1 });
  s.rentalDue[1].approvalStatus = 2;
  const db = fakeDb([s], { counter: 0 });
  assert.equal(planMediaBills(s).length, 0);
  await db.api.ensureAdinnOohBills(db.get(s));
  assert.deepEqual(numbersOf(db.get(s)), [null, null]);

  // single bill site: first face approved → number; second face approved later → SAME number
  db.get(s).rentalDue[0].approvalStatus = 3;
  await db.api.ensureAdinnOohBills(db.get(s));
  db.get(s).rentalDue[1].approvalStatus = 3;
  await db.api.ensureAdinnOohBills(db.get(s));
  assert.equal(uniq(numbersOf(db.get(s))).length, 1);
  assert.equal(db.registry.length, 1);
  assert.equal(db.registry[0].serial, 1);
});

test("no number until the backfill has created the counter (approval is not blocked)", async () => {
  const s = site();
  const db = fakeDb([s], { counterExists: false });
  const res = await db.api.ensureAdinnOohBills(db.get(s));
  assert.deepEqual(res, []);
  assert.equal(db.registry.length, 0);
  assert.equal(db.get(s).rentalDue[0].adinn_ooh_bills, null);
});

test("invalid bill date → bill skipped, nothing invented", async () => {
  const s = site();
  s.rentalDue[0].dueDate = "garbage";
  const db = fakeDb([s], { counter: 0 });
  await db.api.ensureAdinnOohBills(db.get(s));
  assert.equal(db.registry.length, 0);
  assert.equal(db.counters.get(ADINN_COUNTER_ID), 0, "no serial used");
});

// ── lifetime serial ──────────────────────────────────────────────────────
test("serial never resets across months / years and continues past 99", async () => {
  const months = [
    ["December 2026", D(2026, 12, 5)],
    ["January 2027", D(2027, 1, 5)],
    ["February 2027", D(2027, 2, 5)],
  ];
  const s = site({ months });
  const db = fakeDb([s], { counter: 98 });
  await db.api.ensureAdinnOohBills(db.get(s));
  assert.deepEqual(numbersOf(db.get(s)), ["ADNOOHBILL0512202699", "ADNOOHBILL05012027100", "ADNOOHBILL05022027101"]);
});

test("counter persists: a new api instance (restart) continues the same serial", async () => {
  const a = site();
  const b = site({ months: [["December 2026", D(2026, 12, 5)]] });
  const db = fakeDb([a, b], { counter: 365 });
  await db.api.ensureAdinnOohBills(db.get(a));
  const restarted = createAdinnOohBills({
    Media: { updateOne: async () => ({}) },
    Registry: { findOne: () => ({ lean: async () => null }), create: async (d) => d, updateOne: async () => ({}) },
    Counter: { findOneAndUpdate: (f, u) => ({ lean: async () => ({ seq: (db.counters.set(f._id, db.counters.get(f._id) + u.$inc.seq), db.counters.get(f._id)) }) }) },
  });
  assert.equal(await restarted.nextSerial(), 367);
});

// ── idempotency / concurrency ────────────────────────────────────────────
test("retried approval returns the same number, no second serial", async () => {
  const s = site();
  const db = fakeDb([s], { counter: 10 });
  await db.api.ensureAdinnOohBills(db.get(s));
  const first = db.get(s).rentalDue[0].adinn_ooh_bills;
  // retry with a stale copy that does not have the number yet
  const stale = clone(db.get(s));
  stale.rentalDue[0].adinn_ooh_bills = null;
  await db.api.ensureAdinnOohBills(stale);
  assert.equal(db.get(s).rentalDue[0].adinn_ooh_bills, first);
  assert.equal(stale.rentalDue[0].adinn_ooh_bills, first, "in-memory doc restored with the SAME number");
  assert.equal(db.registry.length, 1);
  assert.equal(db.counters.get(ADINN_COUNTER_ID), 11);
});

test("concurrent approvals of the same bill → one number (loser's serial is a gap, never a duplicate)", async () => {
  const s = site({ faces: 2 });
  const db = fakeDb([s], { counter: 0 });
  await Promise.all([db.api.ensureAdinnOohBills(clone(db.get(s))), db.api.ensureAdinnOohBills(clone(db.get(s))), db.api.ensureAdinnOohBills(clone(db.get(s)))]);
  assert.equal(db.registry.length, 1);
  assert.equal(uniq(numbersOf(db.get(s))).length, 1);
});

test("concurrent approvals of different bills → different numbers", async () => {
  const sites = Array.from({ length: 6 }, () => site());
  const db = fakeDb(sites, { counter: 0 });
  await Promise.all(sites.map((s) => db.api.ensureAdinnOohBills(clone(db.get(s)))));
  const all = sites.flatMap((s) => numbersOf(db.get(s)));
  assert.equal(uniq(all).length, 6);
  assert.deepEqual(db.registry.map((r) => r.serial).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test("a number already on a row is kept and never renumbered", async () => {
  const s = site({ faces: 2 });
  s.rentalDue[0].adinn_ooh_bills = "ADNOOHBILL0511202642";
  const db = fakeDb([s], { counter: 100 });
  await db.api.ensureAdinnOohBills(db.get(s));
  assert.deepEqual(numbersOf(db.get(s)), ["ADNOOHBILL0511202642", "ADNOOHBILL0511202642"]);
  assert.equal(db.counters.get(ADINN_COUNTER_ID), 100, "no serial used");
  assert.equal(db.registry[0].serial, 42);
});

test("bill mode changed after issuance → issued numbers stay as they are", async () => {
  const s = site({ faces: 2 });
  const db = fakeDb([s], { counter: 0 });
  await db.api.ensureAdinnOohBills(db.get(s));
  const before = numbersOf(db.get(s));
  db.get(s).mediaDetails.forEach((f) => (f.siteBillMode = 2));
  await db.api.ensureAdinnOohBills(db.get(s));
  assert.deepEqual(numbersOf(db.get(s)), before);
  assert.equal(db.registry.length, 1);
});

test("ensure never throws (approval flow is never blocked)", async () => {
  const api = createAdinnOohBills({
    Media: {},
    Registry: { findOne: () => ({ lean: async () => { throw new Error("db down"); } }) },
    Counter: {},
    logger: { error: () => {} },
  });
  assert.deepEqual(await api.ensureAdinnOohBills(site()), []);
  assert.deepEqual(await api.ensureAdinnOohBills(null), []);
});

// ── ordering (backfill + simultaneous approvals) ─────────────────────────
const IST = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60 * 1000);

test("same bill date → serial by entry time (09:15, 11:30, 15:45), whatever the read order", () => {
  const mk = (time) => {
    const s = site({ months: [["November 2026", D(2026, 11, 5)]] });
    s.rentalDue[0].createdAt = time;
    return s;
  };
  const a = mk(IST(2026, 11, 5, 9, 15));
  const b = mk(IST(2026, 11, 5, 11, 30));
  const c = mk(IST(2026, 11, 5, 15, 45));
  const bases = [c, a, b].flatMap(planMediaBills).sort(compareBases);
  assert.deepEqual(bases.map((x) => x.mediaId), [a, b, c].map((s) => String(s._id)));
  const nos = bases.map((x, i) => formatAdinnOohBillNo(x.billDate, 365 + i));
  assert.deepEqual(nos, ["ADNOOHBILL05112026365", "ADNOOHBILL05112026366", "ADNOOHBILL05112026367"]);
});

test("identical bill date and entry time → stable id order", () => {
  const t = IST(2026, 11, 5, 10, 0);
  const sites = [site(), site(), site()];
  sites.forEach((s) => (s.rentalDue[0].createdAt = t));
  const order1 = sites.flatMap(planMediaBills).sort(compareBases).map((x) => x.mediaId);
  const order2 = [...sites].reverse().flatMap(planMediaBills).sort(compareBases).map((x) => x.mediaId);
  assert.deepEqual(order1, order2);
  assert.deepEqual(order1, sites.map((s) => String(s._id)).sort());
});

test("different bill dates → earlier bill date first (July bill = 01)", () => {
  const july = site({ months: [["July 2026", D(2026, 7, 1)]] });
  const sep = site({ months: [["September 2026", D(2026, 9, 5)]] });
  sep.rentalDue[0].createdAt = D(2026, 6, 1); // entered before the July bill
  const order = [sep, july].flatMap(planMediaBills).sort(compareBases).map((x) => x.mediaId);
  assert.deepEqual(order, [String(july._id), String(sep._id)]);
});

test("missing createdAt → entry time from the record id, flagged", () => {
  const s = site();
  delete s.rentalDue[0].createdAt;
  s.rentalDue[0]._id = "650000000000000000000001";
  const [b] = planMediaBills(s);
  assert.equal(b.entryTime, 0x65000000 * 1000);
  assert.equal(b.entryTimeFromId, true);
});

test("single bill with different face bill dates → flagged, earliest date used", () => {
  const s = site({ faces: 2 });
  s.rentalDue[1].dueDate = D(2026, 11, 15);
  const [b] = planMediaBills(s);
  assert.equal(b.billDateConflict, true);
  assert.deepEqual(b.dates.sort(), [20261105, 20261115]);
  assert.equal(billDayKey(b.billDate), 20261105);
});

test("explicit backfill serials keep historical order", async () => {
  const sites = [site({ months: [["September 2026", D(2026, 9, 5)]] }), site({ months: [["July 2026", D(2026, 7, 1)]] })];
  const db = fakeDb(sites, { counterExists: false });
  const bases = sites.flatMap((s) => planMediaBills(db.get(s))).sort(compareBases);
  let n = 1;
  for (const b of bases) await db.api.assignBase(b, null, { source: "backfill", serialFor: () => n++ });
  assert.deepEqual(sites.map((s) => db.get(s).rentalDue[0].adinn_ooh_bills), ["ADNOOHBILL0509202602", "ADNOOHBILL0107202601"]);
  // rerun: everything already numbered → nothing changes
  for (const b of sites.flatMap((s) => planMediaBills(db.get(s)))) assert.equal(b.needRowIds.length, 0);
});
