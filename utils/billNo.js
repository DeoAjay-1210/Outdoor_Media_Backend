// ✅ NEW — bill number for every generated bill (media.rentalDue[]):
//   "adinnooh" + DD (bill dueDate day) + MM + YYYY + running number (min 2 digits)
//   e.g. 1 Nov 2026, 1st bill → adinnooh0111202601; 5 Nov 2026, 23rd bill → adinnooh0511202623;
//   124th bill → adinnooh10112026124
// The running number never resets (Counter _id "billNo", atomic $inc).
// Single bill site (no face with siteBillMode 2): every face row of the same
// month shares ONE number. Separate bills: one number per face bill.
// Given once when the bill is created; never changed afterwards.
const Counter = require("../models/Admin/CounterSchema");

const BILL_NO_PREFIX = "adinnooh"; // ✅ CHANGED — was "adinn"
const BILL_NO_COUNTER_ID = "billNo";
const pad2 = (n) => String(n).padStart(2, "0");

function formatBillNo(dueDate, seq) {
  const d = new Date(dueDate);
  return `${BILL_NO_PREFIX}${pad2(d.getUTCDate())}${pad2(d.getUTCMonth() + 1)}${d.getUTCFullYear()}${pad2(seq)}`;
}

async function nextBillSeq() {
  const c = await Counter.findOneAndUpdate(
    { _id: BILL_NO_COUNTER_ID },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  ).lean();
  return c.seq;
}

const isSingleBillSite = (media) => !(media?.mediaDetails || []).some((d) => Number(d?.siteBillMode) === 2);
const sameFace = (a, b) => String(a || "") === String(b || "");

/**
 * Gives the just-created bill (dueMonth + mediaDetailId) of mediaDoc its billNo
 * and saves it. mediaDoc = the document returned by the $push (its rentalDue
 * row is updated in memory too, so a later media.save() keeps the number).
 * Never throws — a failure only logs (bill creation is not blocked).
 */
async function assignBillNoToNewBill(Media, mediaDoc, newEntry) {
  try {
    if (!mediaDoc) return null;
    const rows = mediaDoc.rentalDue || [];
    const target = rows.find(
      (r) => r && r.dueMonth === newEntry.dueMonth && sameFace(r.mediaDetailId, newEntry.mediaDetailId) && !r.billNo,
    );
    if (!target) return null;
    const shared = isSingleBillSite(mediaDoc)
      ? rows.find((r) => r && r !== target && r.dueMonth === target.dueMonth && r.billNo)
      : null;
    const billNo = shared ? shared.billNo : formatBillNo(target.dueDate || newEntry.dueDate, await nextBillSeq());
    await Media.updateOne(
      { _id: mediaDoc._id },
      { $set: { "rentalDue.$[e].billNo": billNo } },
      { arrayFilters: [{ "e._id": target._id, "e.billNo": null }], timestamps: false },
    );
    target.billNo = billNo;
    return billNo;
  } catch (err) {
    console.error("assignBillNoToNewBill error:", err.message);
    return null;
  }
}

/**
 * Response helper (ledger-list / ledger-history): every row that points to a
 * bill — rentalDueId, or a rentalDue row itself (_id) — gets that bill's
 * billNo (null when the bill has none). Rows that already have billNo are
 * kept. list = sites ({ _id | mediaId, ... }); returns the same list.
 */
async function withBillNos(Media, list) {
  try {
    if (!Array.isArray(list) || !list.length) return list;
    const ids = [...new Set(list.map((m) => String(m?._id || m?.mediaId || "")).filter(Boolean))];
    const docs = await Media.find({ _id: { $in: ids } }).select("rentalDue._id rentalDue.billNo rentalDue.adinn_ooh_bills").lean();
    const billNoById = new Map();
    const adinnById = new Map(); // ✅ NEW — ADINN OOH bill number (utils/adinnOohBills.js)
    docs.forEach((d) =>
      (d.rentalDue || []).forEach((r) => {
        billNoById.set(String(r._id), r.billNo || null);
        adinnById.set(String(r._id), r.adinn_ooh_bills || null);
      }),
    );
    if (!billNoById.size) return list;
    const seen = new WeakSet();
    const walk = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (node instanceof Date || node._bsontype) return;
      const key = node.rentalDueId ? String(node.rentalDueId) : node._id ? String(node._id) : null;
      if (node.billNo === undefined) {
        if (key && billNoById.has(key)) node.billNo = billNoById.get(key);
      }
      // ✅ NEW — adinn_ooh_bills next to billNo (null until the bill is approved)
      if (node.adinn_ooh_bills === undefined && key && adinnById.has(key)) {
        node.adinn_ooh_bills = adinnById.get(key);
      }
      Object.values(node).forEach(walk);
    };
    walk(list);
    return list;
  } catch (err) {
    console.error("withBillNos error:", err.message);
    return list;
  }
}

module.exports = {
  withBillNos,
  BILL_NO_PREFIX,
  BILL_NO_COUNTER_ID,
  formatBillNo,
  nextBillSeq,
  isSingleBillSite,
  assignBillNoToNewBill,
};
