// ✅ NEW — ADINN OOH lifetime bill number (media.rentalDue[].adinn_ooh_bills).
//
//   "ADNOOHBILL" + DD MM YYYY (the bill's own bill date, India calendar day)
//              + lifetime serial (min 2 digits, never reset, never reused)
//   e.g. ADNOOHBILL0611202601, ADNOOHBILL05112026366, ADNOOHBILL05092026367
//
// The existing billNo (utils/billNo.js) is NOT touched — this is a separate key.
//
// When: a bill gets its number when it is fully approved (approvalStatus 3).
// Historical approved bills get theirs from scripts/backfillAdinnOohBills.js.
//
// One number per actual bill (8 business cases):
//   • single bill site (no face with siteBillMode 2): all face rows of the same
//     month = ONE bill → one number (cases 1–4)
//   • separate bill site (a face with siteBillMode 2): every face row = its own
//     bill → one number each (cases 5–7)
//   • separate landlord bills (more than one landlord and a landlord with
//     landOwnerBillMode 2): every landlord of that bill gets its own number
//     (case 8); row.adinn_ooh_bills = first landlord's number and
//     row.adinn_ooh_bills_landOwners[] = every landlord's number
//
// Serial order (backfill and same-moment approvals): bill date (calendar day)
// → earliest createdAt of the bill's rows → mediaId → bill key → landlord order.
//
// Safety: the serial comes from Counter "adinn_ooh_bills_global" (atomic $inc,
// no upsert — until the backfill script creates it, approvals simply wait and
// the backfill numbers them). AdinnOohBillRegistry (unique groupKey / number /
// serial) is the authoritative record: a retried / concurrent approval gets
// the SAME number, and a number is never given twice. A number already on a
// row is never changed.

const ADINN_PREFIX = "ADNOOHBILL";
const ADINN_COUNTER_ID = "adinn_ooh_bills_global";
const IST_OFFSET_MS = 330 * 60 * 1000; // bill dates are India calendar days

const pad2 = (n) => String(n).padStart(2, "0");

/** Valid Date for a bill date value (Date / ISO string / "YYYY-MM-DD"), else null. Never defaults to today. */
function toValidDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      // reject rolled-over dates like 2026-02-30
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      return dt;
    }
  }
  const dt = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** { dd, mm, yyyy } of the India calendar day, or null for a missing / invalid date. */
function billDateParts(value) {
  const dt = toValidDate(value);
  if (!dt) return null;
  const ist = new Date(dt.getTime() + IST_OFFSET_MS);
  return { dd: ist.getUTCDate(), mm: ist.getUTCMonth() + 1, yyyy: ist.getUTCFullYear() };
}

/** Sortable day number (YYYYMMDD) of the bill date, null when invalid. */
function billDayKey(value) {
  const p = billDateParts(value);
  return p ? p.yyyy * 10000 + p.mm * 100 + p.dd : null;
}

/** ADNOOHBILL + DDMMYYYY + serial. Throws on an invalid bill date or serial (never guesses). */
function formatAdinnOohBillNo(billDate, serial) {
  const p = billDateParts(billDate);
  if (!p) throw new Error(`adinn_ooh_bills: invalid bill date "${billDate}"`);
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error(`adinn_ooh_bills: invalid serial "${serial}"`);
  return `${ADINN_PREFIX}${pad2(p.dd)}${pad2(p.mm)}${p.yyyy}${pad2(serial)}`;
}

/** Serial of a stored number (prefix + 8 date digits + serial), null if it does not match. */
function parseAdinnSerial(no) {
  const m = new RegExp(`^${ADINN_PREFIX}\\d{8}(\\d{2,})$`).exec(String(no || ""));
  return m ? Number(m[1]) : null;
}

const idStr = (v) => (v === null || v === undefined ? "" : String(v));
const timeOf = (v) => {
  const d = toValidDate(v);
  return d ? d.getTime() : null;
};
/** entry time of a row: createdAt, else the creation time inside its ObjectId */
function rowEntryTime(row) {
  const t = timeOf(row && row.createdAt);
  if (t !== null) return { time: t, fromId: false };
  const hex = idStr(row && row._id);
  if (/^[0-9a-f]{24}$/i.test(hex)) return { time: parseInt(hex.slice(0, 8), 16) * 1000, fromId: true };
  return { time: null, fromId: false };
}

const isSeparateSite = (media) => (media?.mediaDetails || []).some((d) => Number(d?.siteBillMode) === 2);
// Several landlords on one bill ALWAYS share ONE Bill Number: landOwnerBillMode is no longer read (separate-landlord numbers are switched off).
// Bills numbered earlier with one number per landlord keep their numbers (a number is never changed).
function separateLandlords(media) {
  return null;
}

/**
 * Bills of one site that are approved (approvalStatus 3), as base groups:
 * [{ baseKey, mediaId, dueMonth, billMode, billDate, billDateConflict, dates,
 *    entryTime, entryTimeFromId, approvedRowIds, needRowIds, existingNo,
 *    bills: [{ groupKey, ownerIndex, owner }] }]
 * needRowIds = approved rows that do not have adinn_ooh_bills yet.
 */
function planMediaBills(media) {
  const mediaId = idStr(media?._id);
  const rows = (media?.rentalDue || []).filter((r) => r && r._id);
  const sepSite = isSeparateSite(media);
  const owners = separateLandlords(media);

  const byKey = new Map();
  rows.forEach((r) => {
    const key = sepSite || !r.dueMonth ? `${mediaId}|row:${idStr(r._id)}` : `${mediaId}|${r.dueMonth}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  });

  const bases = [];
  byKey.forEach((groupRows, baseKey) => {
    const approved = groupRows.filter((r) => Number(r.approvalStatus) === 3);
    if (!approved.length) return;

    const validDates = groupRows.map((r) => toValidDate(r.dueDate)).filter(Boolean);
    const dayKeys = [...new Set(validDates.map((d) => billDayKey(d)))];
    const billDate = validDates.length ? validDates.reduce((a, b) => (b < a ? b : a)) : null;

    const times = approved.map(rowEntryTime).filter((t) => t.time !== null);
    const first = times.length ? times.reduce((a, b) => (b.time < a.time ? b : a)) : { time: null, fromId: false };

    const existing = groupRows.find((r) => r.adinn_ooh_bills);
    const bills = owners
      ? owners.map((o, i) => ({
          groupKey: `${baseKey}|owner:${idStr(o._id)}`,
          ownerIndex: i,
          owner: {
            landOwnerId: o._id || null,
            landOwnerMasterId: o.landOwnerMasterId || null,
            landOwnerName: o.name || "",
          },
        }))
      : [{ groupKey: baseKey, ownerIndex: 0, owner: null }];

    bases.push({
      baseKey,
      mediaId,
      dueMonth: groupRows[0].dueMonth || "",
      billMode: owners ? "separate_landlord" : sepSite ? "separate_site" : "single",
      billDate,
      billDateConflict: dayKeys.length > 1,
      dates: dayKeys,
      entryTime: first.time,
      entryTimeFromId: first.fromId,
      approvedRowIds: approved.map((r) => r._id),
      needRowIds: approved.filter((r) => !r.adinn_ooh_bills).map((r) => r._id),
      existingNo: existing ? existing.adinn_ooh_bills : null,
      bills,
    });
  });
  return bases;
}

/** Serial order: bill day → first entry time → mediaId → bill key. Stable, never query order. */
function compareBases(a, b) {
  const da = billDayKey(a.billDate);
  const db = billDayKey(b.billDate);
  if (da !== db) return (da ?? Infinity) - (db ?? Infinity);
  const ta = a.entryTime ?? Infinity;
  const tb = b.entryTime ?? Infinity;
  if (ta !== tb) return ta - tb;
  if (a.mediaId !== b.mediaId) return a.mediaId < b.mediaId ? -1 : 1;
  if (a.baseKey !== b.baseKey) return a.baseKey < b.baseKey ? -1 : 1;
  return 0;
}

const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

function createAdinnOohBills(deps = {}) {
  const getMedia = () => deps.Media || require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const getRegistry = () => deps.Registry || require("../models/Admin/AdinnOohBillRegistrySchema");
  const getCounter = () => deps.Counter || require("../models/Admin/CounterSchema");
  const log = deps.logger || console;

  /** next lifetime serial; null while the counter does not exist yet (backfill not run) */
  async function nextSerial() {
    const c = await getCounter()
      .findOneAndUpdate({ _id: ADINN_COUNTER_ID }, { $inc: { seq: 1 } }, { returnDocument: "after" })
      .lean();
    return c && Number.isSafeInteger(c.seq) ? c.seq : null;
  }

  /**
   * Number of one bill: the registered one if this bill already has a number,
   * else a new one (explicitSerial from the backfill, or the next lifetime serial).
   * Returns null when no number can be given (counter not set up / invalid date).
   */
  async function obtainNumber(base, bill, { explicitSerial = null, source = "approval" } = {}) {
    const Registry = getRegistry();
    const found = await Registry.findOne({ groupKey: bill.groupKey }).lean();
    if (found) {
      await Registry.updateOne({ _id: found._id }, { $addToSet: { rentalDueIds: { $each: base.approvedRowIds } } });
      return found.adinn_ooh_bills;
    }
    if (!toValidDate(base.billDate)) return null;

    const doc = {
      groupKey: bill.groupKey,
      mediaId: base.mediaId,
      dueMonth: base.dueMonth,
      billDate: base.billDate,
      rentalDueIds: base.approvedRowIds,
      landOwnerId: bill.owner?.landOwnerId || null,
      landOwnerMasterId: bill.owner?.landOwnerMasterId || null,
      landOwnerName: bill.owner?.landOwnerName || "",
      billMode: base.billMode,
      source,
      assignedAt: new Date(),
    };

    // a number already on the bill's row (and not registered) is kept as it is
    if (bill.ownerIndex === 0 && base.existingNo && parseAdinnSerial(base.existingNo)) {
      try {
        await Registry.create({ ...doc, adinn_ooh_bills: base.existingNo, serial: parseAdinnSerial(base.existingNo) });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
      return base.existingNo;
    }

    const serial = explicitSerial ?? (await nextSerial());
    if (serial === null) return null;
    const number = formatAdinnOohBillNo(base.billDate, serial);
    try {
      await Registry.create({ ...doc, adinn_ooh_bills: number, serial });
      return number;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // another request numbered this bill at the same moment → use that number
      // (this serial stays unused — a gap, never a duplicate)
      const winner = await Registry.findOne({ groupKey: bill.groupKey }).lean();
      if (winner) return winner.adinn_ooh_bills;
      throw err;
    }
  }

  /** Writes the numbers on the bill's approved rows that have none (DB + in-memory doc). */
  async function writeRows(base, numbers, mediaDoc) {
    const first = numbers[0];
    const ownerList =
      base.bills[0].owner !== null
        ? base.bills.map((b, i) => ({ ...b.owner, adinn_ooh_bills: numbers[i] }))
        : null;
    const set = { "rentalDue.$[e].adinn_ooh_bills": first };
    if (ownerList) set["rentalDue.$[e].adinn_ooh_bills_landOwners"] = ownerList;

    await getMedia().updateOne(
      { _id: base.mediaId },
      { $set: set },
      {
        arrayFilters: [{ "e._id": { $in: base.needRowIds }, "e.adinn_ooh_bills": null }],
        timestamps: false,
      },
    );

    // keep the loaded document in step, so a later media.save() keeps the number
    if (mediaDoc && Array.isArray(mediaDoc.rentalDue)) {
      const need = new Set(base.needRowIds.map(idStr));
      mediaDoc.rentalDue.forEach((r) => {
        if (r && need.has(idStr(r._id)) && !r.adinn_ooh_bills) {
          r.adinn_ooh_bills = first;
          if (ownerList) r.adinn_ooh_bills_landOwners = ownerList;
        }
      });
    }
  }

  /** Numbers one base group (all its landlord bills). Returns the numbers, or null if skipped. */
  async function assignBase(base, mediaDoc, opts = {}) {
    const numbers = [];
    for (const bill of base.bills) {
      const explicitSerial = opts.serialFor ? opts.serialFor(bill) : null;
      const no = await obtainNumber(base, bill, { explicitSerial, source: opts.source });
      if (!no) return null;
      numbers.push(no);
    }
    if (base.needRowIds.length) await writeRows(base, numbers, mediaDoc);
    return numbers;
  }

  /**
   * After a save that may have fully approved bills: every approved bill of
   * this site without adinn_ooh_bills gets its number. Idempotent; never
   * throws (a failure only logs — approval is never blocked).
   * mediaDoc = the saved Mongoose document (or a plain object with _id).
   */
  async function ensureAdinnOohBills(mediaDoc) {
    try {
      if (!mediaDoc || !mediaDoc._id) return [];
      const plain = typeof mediaDoc.toObject === "function" ? mediaDoc.toObject() : mediaDoc;
      const bases = planMediaBills(plain)
        .filter((b) => b.needRowIds.length)
        .sort(compareBases);
      const assigned = [];
      for (const base of bases) {
        const numbers = await assignBase(base, mediaDoc, { source: "approval" });
        if (numbers) assigned.push({ baseKey: base.baseKey, numbers });
      }
      return assigned;
    } catch (err) {
      log.error("ensureAdinnOohBills error:", err.message);
      return [];
    }
  }

  /**
   * ✅ NEW — rent revision New Bill / Advance (media.arrearsDue[]): ONE number
   * per revision (all its New Bill rows share it). Same counter / format, bill
   * date = CMD approval date. groupKey "<mediaId>|newbill:<revisionId>" or
   * "<mediaId>|advance:<revisionId>" → the same revision always gets the same
   * number. The number is written on those arrearsDue rows. Never throws;
   * returns the number or null.
   */
  async function ensureRevisionAdinnOohBill({ mediaId, revisionId, kind = "newbill", dueMonth = "", billIds = [], billDate = new Date() }) {
    try {
      if (!mediaId || !revisionId || !billIds.length) return null;
      const base = {
        mediaId: idStr(mediaId),
        dueMonth,
        billDate,
        billMode: kind === "advance" ? "advance" : "new_bill",
        approvedRowIds: billIds,
        existingNo: null,
      };
      const bill = { groupKey: `${idStr(mediaId)}|${kind}:${idStr(revisionId)}`, ownerIndex: 0, owner: null };
      const no = await obtainNumber(base, bill, { source: "approval" });
      if (!no) return null;
      await getMedia().updateOne(
        { _id: mediaId },
        { $set: { "arrearsDue.$[a].adinn_ooh_bills": no } },
        { arrayFilters: [{ "a._id": { $in: billIds } }], strict: false },
      );
      return no;
    } catch (err) {
      log.error("ensureRevisionAdinnOohBill error:", err.message);
      return null;
    }
  }

  return { nextSerial, obtainNumber, assignBase, ensureAdinnOohBills, ensureRevisionAdinnOohBill };
}

let defaultInstance = null;
const instance = () => (defaultInstance = defaultInstance || createAdinnOohBills());

module.exports = {
  ADINN_PREFIX,
  ADINN_COUNTER_ID,
  toValidDate,
  billDateParts,
  billDayKey,
  formatAdinnOohBillNo,
  parseAdinnSerial,
  rowEntryTime,
  isSeparateSite,
  separateLandlords,
  planMediaBills,
  compareBases,
  createAdinnOohBills,
  ensureAdinnOohBills: (mediaDoc) => instance().ensureAdinnOohBills(mediaDoc),
  ensureRevisionAdinnOohBill: (opts) => instance().ensureRevisionAdinnOohBill(opts), // ✅ NEW — New Bill / Advance
};
