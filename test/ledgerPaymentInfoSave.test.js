// /admin/ledger-payment-info-save — single + bulk (items[]). Media stubbed, no DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { saveLedgerPaymentInfo } = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");

const oid = () => new mongoose.Types.ObjectId();
const s1 = { _id: oid(), owner: oid(), oct: oid(), nov: oid(), adv: oid() };
const s2 = { _id: oid(), owner: oid(), owner2: oid(), oct: oid(), gstRow: oid() };
const sites = new Map();
const reset = () => {
  sites.set(String(s1._id), {
    _id: s1._id,
    landOwners: [{ _id: s1.owner, name: "land 1" }],
    rentalDue: [{ _id: s1.oct, dueMonth: "October 2026" }, { _id: s1.nov, dueMonth: "November 2026" }],
    arrearsDue: [{ _id: s1.adv, type: "advance", dueMonth: "September 2026", owners: [] }],
    gstBalanceHistory: [],
    ledgerPaymentInfo: [],
  });
  sites.set(String(s2._id), {
    _id: s2._id,
    landOwners: [{ _id: s2.owner, name: "MUTHU" }, { _id: s2.owner2, name: "RAVI" }],
    rentalDue: [{ _id: s2.oct, dueMonth: "October 2026" }],
    arrearsDue: [],
    gstBalanceHistory: [{ _id: s2.gstRow, rentalDueId: s2.oct, dueMonth: "October 2026" }],
    ledgerPaymentInfo: [],
  });
};
// stub: findById(...).select(...).lean() and updateOne($push / $set on ledgerPaymentInfo)
Media.findById = (id) => ({ select: () => ({ lean: async () => JSON.parse(JSON.stringify(sites.get(String(id)) || null)) }) });
Media.updateOne = async (filter, update, opts) => {
  const m = sites.get(String(filter._id));
  if (update.$push && update.$push.ledgerPaymentInfo) m.ledgerPaymentInfo.push(update.$push.ledgerPaymentInfo);
  if (update.$set && opts && opts.arrayFilters) {
    const row = m.ledgerPaymentInfo.find((r) => String(r._id) === String(opts.arrayFilters[0]["p._id"]));
    Object.entries(update.$set).forEach(([k, v]) => {
      if (k.startsWith("ledgerPaymentInfo.$[p].")) row[k.slice("ledgerPaymentInfo.$[p].".length)] = v;
    });
  }
  return { acknowledged: true };
};
const call = (body) =>
  new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); return this; } };
    saveLedgerPaymentInfo({ body, user: { userName: "Ajay" } }, res);
  });
const fields = (n) => ({ paymentThrough: "HDFC Current A/c", typeOfPayment: "NEFT", bankRefNo: "REF" + n, narration: "row " + n });

test("B1 bulk: 2 sites, 2 landowners, Oct / Nov / advance rent + GST rows → all saved", async () => {
  reset();
  const r = await call({
    items: [
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.oct, landOwnerId: s1.owner, paymentMode: "Online", billType: "bill", ...fields(1) },
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.nov, landOwnerId: s1.owner, paymentMode: "Online", billType: "bill", ...fields(2) },
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.adv, landOwnerId: s1.owner, paymentMode: "Online", billType: "advance", ...fields(3) },
      { mediaId: s2._id, entryType: "rent", rentalDueId: s2.oct, landOwnerId: s2.owner2, paymentMode: "Cash", billType: "bill", ...fields(4) },
      { mediaId: s2._id, entryType: "gst", rentalDueId: s2.oct, landOwnerId: s2.owner, paymentMode: null, gstBalanceHistoryId: null, ...fields(5) },
      { mediaId: s1._id, entryType: "gst", rentalDueId: s1.adv, landOwnerId: null, gstBalanceHistoryId: s1.adv, billType: "advance", ...fields(6) },
    ],
  });
  assert.equal(r.code, 200);
  const d = r.body.data;
  assert.equal(d.total, 6);
  assert.equal(d.savedCount, 6);
  assert.equal(d.failedCount, 0);
  assert.deepEqual(d.saved.map((x) => [x.index, x.action, x.dueMonth]), [
    [0, "created", "October 2026"], [1, "created", "November 2026"], [2, "created", "September 2026"],
    [3, "created", "October 2026"], [4, "created", "October 2026"], [5, "created", "September 2026"],
  ]);
  assert.equal(d.saved[0].paymentInfoStatusLabel, "Yet to Payment");
  assert.equal(d.saved[0].updatedBy, "Ajay");
  assert.equal(sites.get(String(s1._id)).ledgerPaymentInfo.length, 4);
  assert.equal(sites.get(String(s2._id)).ledgerPaymentInfo.length, 2);
});

test("B2 same rows again → updated (no new rows); GST row saved before paid, then by its _id → same entry", async () => {
  const r = await call({
    items: [
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.oct, landOwnerId: s1.owner, paymentMode: "Online", narration: "edited" },
      { mediaId: s2._id, entryType: "gst", rentalDueId: s2.oct, landOwnerId: s2.owner, gstBalanceHistoryId: s2.gstRow, bankRefNo: "PAIDREF" },
    ],
  });
  assert.equal(r.body.data.savedCount, 2);
  assert.deepEqual(r.body.data.saved.map((x) => x.action), ["updated", "updated"]);
  assert.equal(r.body.data.saved[0].narration, "edited");
  assert.equal(r.body.data.saved[0].bankRefNo, "REF1"); // not sent → kept
  assert.equal(sites.get(String(s1._id)).ledgerPaymentInfo.length, 4);
  const gst = sites.get(String(s2._id)).ledgerPaymentInfo.find((x) => x.entryType === "gst");
  assert.equal(String(gst.gstBalanceHistoryId), String(s2.gstRow)); // row _id learnt
  assert.equal(sites.get(String(s2._id)).ledgerPaymentInfo.length, 2);
});

test("B3 partial: bad items in errors[] with index, valid ones saved; duplicate → later item used", async () => {
  reset();
  const r = await call({
    items: [
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.oct, landOwnerId: s1.owner, paymentMode: "Online", narration: "first" },
      { mediaId: s1._id, entryType: "rent", rentalDueId: oid(), landOwnerId: s1.owner, paymentMode: "Online", narration: "x" },
      { mediaId: s2._id, entryType: "rent", rentalDueId: s2.oct, landOwnerId: oid(), paymentMode: "Online", narration: "x" },
      { mediaId: s2._id, entryType: "gst", rentalDueId: s2.oct, narration: "no owner" },
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.oct, landOwnerId: s1.owner, paymentMode: "online", narration: "second" },
      { mediaId: "bad", narration: "x" },
      { mediaId: s1._id, entryType: "rent", rentalDueId: s1.nov, landOwnerId: s1.owner, paymentMode: "Online" },
    ],
  });
  assert.equal(r.code, 200);
  const d = r.body.data;
  assert.equal(d.savedCount, 1);
  assert.equal(d.saved[0].index, 4);
  assert.equal(d.saved[0].narration, "second");
  assert.deepEqual(
    d.errors.map((e) => [e.index, e.message]),
    [
      [0, "duplicate row in this request — later item used"],
      [1, "rentalDueId not found on this site"],
      [2, "landOwnerId is not a landowner of this bill"],
      [3, "landOwnerId is required for a GST row without gstBalanceHistoryId (send the row's ownerId / landOwnerId)"],
      [5, "mediaId is not a valid ObjectId"],
      [6, "Send at least one of paymentThrough, typeOfPayment, bankRefNo, narration"],
    ],
  );
});

test("B4 all fail → 400 with errors; bad items array → 400; single object → old response", async () => {
  reset();
  const all = await call({ items: [{ mediaId: "bad", narration: "x" }] });
  assert.equal(all.code, 400);
  assert.equal(all.body.data.failedCount, 1);
  assert.equal((await call({ items: [] })).code, 400);
  assert.equal((await call({ items: new Array(201).fill({}) })).code, 400);
  const one = await call({ mediaId: s1._id, rentalDueId: s1.oct, landOwnerId: s1.owner, paymentMode: "Online", narration: "single" });
  assert.equal(one.code, 200);
  assert.equal(one.body.data.narration, "single");
  assert.equal(one.body.data.total, undefined); // single response shape unchanged
});
