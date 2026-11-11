/**
 * CORRECTED UTR: Finance sometimes replies again in the same thread "the previous UTR was wrong, the correct one is X".
 * The bill is already paid (so it is not in the pending lists); this module finds such a reply for a PAID payment and replaces
 * the stored UTR of exactly that payment. PURE helpers + one factory that does the I/O (Gmail thread, MongoDB, log).
 *
 * Safety rules (never overwrite on a guess):
 *   - a different UTR is a correction ONLY when its reply says so (CORRECTION_RE: "incorrect", "wrong UTR", "correct UTR", "revised",
 *     "updated UTR", "please consider this UTR" …); a different UTR without such wording -> manual review, nothing changes;
 *   - it must be the LATEST statement about that payment: when a later reply states the stored UTR again, the old value stands;
 *   - the line must map to ONE stored payment (landlord + Rent|GST); anything unclear -> manual review;
 *   - the new UTR must not be used by another payment of the site;
 *   - each correction mail is applied once (log row status correction_applied + sourceMessageId);
 *   - only the UTR (and Paid Date / remark / updatedBy when the correction states them) of that payment's records are written,
 *     with a compare-and-set on the old UTR, so a concurrent manual edit is never overwritten.
 *   - dry run reports everything and writes nothing.
 */
const { stripQuoted, findUtrInLine } = require("./utrExtractor");
const { extractLandlordUtrLines, splitNameKind, splitArrearsName, matchLandlord, classifyPaymentLabel } = require("./landlordUtrParser");
const { extractExplicitPaymentDates, resolvePaidDate, istDay } = require("./utrPaidDate");
const { collectBankRows, narrationFor } = require("./bankNarration");
const { senderName } = require("./senderName");

// wording that says "the UTR sent earlier is wrong / replaced" (checked on the reply's OWN text, quoted history removed)
const CORRECTION_RE = new RegExp(
  [
    "(?:previous|earlier|old|above|last|first|wrong)\\s+(?:utr|transaction\\s+ref\\w*|reference(?:\\s+(?:no|number))?)\\b[^.\\n]{0,40}\\b(?:incorrect|wrong|invalid|mistake|error|cancel+ed|not\\s+(?:correct|valid))",
    "\\b(?:incorrect|wrong|invalid|mistaken)\\s+(?:utr|transaction\\s+ref\\w*|reference)",
    "\\b(?:correct(?:ed)?|revised|updated|new|replacement|right)\\s+(?:utr|transaction\\s+ref\\w*|reference(?:\\s+(?:no|number))?)\\b",
    "\\bplease\\s+(?:consider|use|take|update|replace|change)\\b[^.\\n]{0,40}\\b(?:utr|reference)",
    "\\b(?:utr|reference)\\b[^.\\n]{0,30}\\b(?:was|is|were)\\s+(?:incorrect|wrong|invalid)",
    "\\b(?:utr|reference)\\b[^.\\n]{0,20}\\b(?:correction|corrected|revised|updated)\\b",
    "\\bcorrection\\b[^.\\n]{0,20}\\b(?:utr|reference)",
  ].join("|"),
  "i",
);

// words that may stand before the label in a correction sentence ("Please consider this UTR: X"); they are not landlord names
const FILLER = new Set("PLEASE CONSIDER THIS THE THAT FIND BELOW ABOVE FOLLOWING CORRECT CORRECTED REVISED UPDATED NEW NOW IS ARE WAS WERE KINDLY USE TAKE AS FOR AND OF TO IT HERE PREVIOUS EARLIER OLD WRONG INCORRECT MISTAKE SORRY SIR MADAM DEAR ACTUAL REPLACEMENT RIGHT CORRECTION UTR".split(" "));

/** The name part of a reply line without correction chatter; "" when only chatter was there. */
function cleanName(name) {
  const parts = String(name || "").split(/([\s\-–—:|,.]+)/); // keep separators
  const words = parts.filter((p, i) => i % 2 === 0 && p);
  if (!words.length) return "";
  const real = words.filter((w) => !FILLER.has(w.toUpperCase().replace(/[^A-Z]/g, "")));
  if (real.length === words.length) return String(name || "").trim(); // nothing but real words: unchanged
  if (!real.length) return "";
  // a mix: keep the original text from the first real word to the last (a separator-joined landlord name stays intact)
  const lower = String(name);
  const first = lower.indexOf(real[0]);
  const last = lower.lastIndexOf(real[real.length - 1]) + real[real.length - 1].length;
  return lower.slice(first, last).replace(/^[\s\-–—:|,]+|[\s\-–—:|,]+$/g, "").trim();
}

const idStr = (v) => (v === null || v === undefined ? "" : String(v));
const hasText = (v) => idStr(v).trim() !== "";
const ownerMatches = (o, id) => { const s = idStr(id); return s !== "" && (s === idStr(o.landOwnerId || o._id) || s === idStr(o._id) || s === idStr(o.landOwnerMasterId)); };
const sameUtr = (a, b) => idStr(a).trim().toUpperCase() === idStr(b).trim().toUpperCase();

/**
 * Every PAID payment of the bill that has a stored UTR, grouped by landlord + kind.
 * -> { flow: "rental"|"newBill"|"advance", landlords: [{ landOwnerId, name }], slots: Map(key -> { key, kind, landOwnerId, landlord, utrs:[...], locs:[{ path, kind }], months }) }
 * locs: every stored record of the payment (live ledger, history, GST row ...) as a MongoDB path to the record.
 */
function storedPayments(media, billNumber, billField = "adinn_ooh_bills") {
  const slots = new Map();
  const landlords = new Map();
  const add = (owner, kind, utr, path, month) => {
    const key = `${owner ? idStr(owner.landOwnerId || owner._id) : ""}|${kind}`;
    if (!slots.has(key)) slots.set(key, { key, kind, landOwnerId: owner ? idStr(owner.landOwnerId || owner._id) : "", landlord: owner ? owner.name || owner.landOwnerName || "" : "", utrs: [], locs: [], months: new Set() });
    const s = slots.get(key);
    if (!s.utrs.some((u) => sameUtr(u, utr))) s.utrs.push(String(utr).trim());
    s.locs.push({ path, kind, utr: String(utr).trim() });
    if (month) s.months.add(month);
    if (owner) landlords.set(idStr(owner.landOwnerId || owner._id), { landOwnerId: idStr(owner.landOwnerId || owner._id), name: owner.name || owner.landOwnerName || "", accountLast4: (String(owner.accountNumber || "").replace(/D/g, "").slice(-4)) || null });
  };

  const arrears = (media.arrearsDue || []).map((b, i) => ({ b, i })).filter(({ b }) => idStr(b[billField]).trim() === billNumber);
  if (arrears.length) {
    const flow = arrears[0].b.type === "advance" ? "advance" : "newBill";
    arrears.forEach(({ b, i }) => {
      const owners = b.owners || [];
      (b.payments || []).forEach((p, j) => {
        if (!hasText(p.utrNumber)) return;
        const kind = p.type === "gst" ? "gst" : "rent";
        let owner = owners.find((o) => ownerMatches(o, p.landOwnerId)) || null;
        if (!owner && !hasText(p.landOwnerId) && owners.length === 1) owner = owners[0];
        add(owner, kind, p.utrNumber, `arrearsDue.${i}.payments.${j}`, b.dueMonth);
      });
    });
    return { flow, landlords: [...landlords.values()], slots };
  }

  const field = billField;
  const rows = (media.rentalDue || []).filter((r) => r && idStr(r[field]).trim() === billNumber);
  const rowIds = new Set(rows.map((r) => idStr(r._id)));
  const owners = media.landOwners || [];
  const ownerOf = (id) => owners.find((o) => ownerMatches(o, id)) || (!hasText(id) && owners.length === 1 ? owners[0] : null);
  const month = rows[0] ? rows[0].dueMonth : "";
  const scan = (list, base) => (list || []).forEach((e, i) => {
    if (!e || !hasText(e.utrNumber) || !rowIds.has(idStr(e.rentalDueId))) return;
    if (e.isUtrEntry === true) add(ownerOf(e.landOwnerId), "gst", e.utrNumber, `${base}.${i}`, month);
    else if (e.paymentMode === "Online") add(ownerOf(e.landOwnerId), "rent", e.utrNumber, `${base}.${i}`, month);
  });
  scan(media.ledger, "ledger");
  scan(media.withGst1Ledger, "withGst1Ledger");
  (media.ledgerHistory || []).forEach((y, yi) => (y.months || []).forEach((m, mi) => scan(m.entries, `ledgerHistory.${yi}.months.${mi}.entries`)));
  (media.gstBalanceHistory || []).forEach((g, i) => {
    if (!g || !hasText(g.utrNumber) || !rowIds.has(idStr(g.rentalDueId))) return;
    add(ownerOf(g.ownerId || g.landOwnerId), "gst", g.utrNumber, `gstBalanceHistory.${i}`, g.dueMonth || month);
  });
  return { flow: "rental", landlords: [...landlords.values()], slots };
}

/**
 * Which stored payment a reply line speaks about. -> { slot } | { error }
 * An unnamed / unlabelled line is accepted only when exactly one stored payment is left.
 */
function mapLineToSlot(line, stored) {
  const name = cleanName(line.name);
  let landlordName;
  let kind = null;
  const only = classifyPaymentLabel(name); // "GST" / "Rent" alone (no landlord named)
  if (only) { landlordName = ""; kind = only; }
  else if (stored.flow === "rental") {
    const k = splitNameKind(name);
    landlordName = k.landlord;
    kind = k.kind;
  } else {
    const k = splitArrearsName(name);
    if (k.billType && k.billType !== stored.flow) return { error: "bill_type_mismatch" };
    landlordName = k.landlord;
    kind = k.kind === "cash" ? "cash" : k.kind;
    if (kind === "cash") return { error: "cash_line_has_no_utr" };
  }
  let pool = [...stored.slots.values()];
  if (landlordName) {
    const m = matchLandlord(landlordName, stored.landlords);
    if (m.error) return { error: m.error };
    pool = pool.filter((s) => s.landOwnerId === m.landlord.landOwnerId);
  } else if (new Set(pool.map((s) => s.landOwnerId)).size > 1) return { error: "unnamed_utr_line_with_several_landlords" };
  if (kind) pool = pool.filter((s) => s.kind === kind);
  if (pool.length !== 1) return { error: pool.length ? "line_matches_several_payments" : "line_matches_no_paid_payment" };
  return { slot: pool[0] };
}

/**
 * Statements of the thread about a UTR: [{ messageId, at, from, wording, utr, name, dates, line, bankRows }] oldest first.
 * messages: scoped Gmail messages of the bill; approval = its approval mail (never a statement).
 */
function utrStatements(messages, approval) {
  const out = [];
  (messages || []).forEach((m, idx) => {
    if (m === approval) return;
    const own = stripQuoted(m.bodyText);
    if (/Owner Name/i.test(own)) return;
    const lines = extractLandlordUtrLines(m.bodyText);
    if (!lines.length) return;
    const wording = CORRECTION_RE.test(own);
    const at = m.sentAt || m.date || "";
    lines.forEach((l) => out.push({ messageId: m.id, at, idx, from: m.from || "", wording, utr: l.utr, name: l.name, dates: l.dates || [], sentDate: istDay(at), line: l.line, message: m }));
  });
  return out.sort((a, b) => (new Date(a.at).getTime() || 0) - (new Date(b.at).getTime() || 0) || a.idx - b.idx);
}

/**
 * Decide, for every stored payment, whether a later reply corrects its UTR.
 * -> { corrections: [{ slot, from, to, statement }], review: [{ slot|null, reason, ... }], unchanged: n }
 */
function planCorrections(statements, stored) {
  const per = new Map(); // slot key -> statements
  const review = [];
  for (const st of statements) {
    const m = mapLineToSlot(st, stored);
    if (m.error) { if (m.error !== "line_matches_no_paid_payment") review.push({ reason: m.error, messageId: st.messageId, name: st.name }); continue; }
    if (!per.has(m.slot.key)) per.set(m.slot.key, []);
    per.get(m.slot.key).push(st);
  }
  const corrections = [];
  let unchanged = 0;
  for (const slot of stored.slots.values()) {
    const list = per.get(slot.key) || [];
    if (slot.utrs.length !== 1) { review.push({ slot, reason: "stored_utr_not_unique", landlord: slot.landlord, kind: slot.kind }); continue; }
    const current = slot.utrs[0];
    const other = list.filter((s) => !sameUtr(s.utr, current));
    if (!other.length) { unchanged += 1; continue; }
    const latest = other[other.length - 1];
    const restated = list.some((s) => sameUtr(s.utr, current) && (new Date(s.at).getTime() > new Date(latest.at).getTime() || (s.at === latest.at && s.idx > latest.idx)));
    if (restated) { unchanged += 1; continue; } // the stored UTR was stated again after it: it stands
    if (!latest.wording) { review.push({ slot, reason: "different_utr_without_correction_wording", landlord: slot.landlord, kind: slot.kind, messageId: latest.messageId, to: latest.utr }); continue; }
    // every statement of the same landlord / kind in the SAME message that differs must agree
    const sameMsg = other.filter((s) => s.messageId === latest.messageId && !sameUtr(s.utr, latest.utr));
    if (sameMsg.length) { review.push({ slot, reason: "correction_mail_states_two_utrs", landlord: slot.landlord, kind: slot.kind, messageId: latest.messageId }); continue; }
    corrections.push({ slot, from: current, to: latest.utr.toUpperCase(), statement: latest });
  }
  return { corrections, review, unchanged };
}

const combineDate = (day) => { // same stamp the ledger engine uses for a typed Paid Date
  const d = new Date(day);
  const now = new Date(Date.now() + 330 * 60000);
  if (!Number.isNaN(d.getTime())) d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return d;
};

/**
 * Fields to write for one correction. -> { filter: { path: oldUtr }, set: { path: value }, paidDate, narration, records }
 * Paid Date only when the reply itself states a usable one; remark only when the correction mail carries a narration row of this landlord.
 */
function buildCorrectionWrite(corr, stored, { approvalDate, now = Date.now() } = {}) {
  const { slot, statement: st } = corr;
  const by = senderName(st.from);
  const paid = resolvePaidDate({ explicitDates: st.dates, sentDate: st.sentDate }, { approvalDate, now });
  const paidDate = paid.source === "email_payment_date" ? paid.date : null;
  const rows = collectBankRows([st.message]).rows;
  const siblings = [...stored.slots.values()].filter((s) => s.landOwnerId === slot.landOwnerId).length;
  const nar = narrationFor(rows, stored.landlords.length ? stored.landlords : [{ landOwnerId: slot.landOwnerId, name: slot.landlord, accountLast4: null }], { landOwnerId: slot.landOwnerId, siblings: stored.landlords.length > 1 ? siblings : 1 });
  const narration = nar.narration || "";
  const filter = {};
  const set = {};
  const nowIst = new Date(now + 330 * 60000);
  slot.locs.forEach((loc) => {
    filter[`${loc.path}.utrNumber`] = loc.utr;
    set[`${loc.path}.utrNumber`] = corr.to;
    set[`${loc.path}.updatedBy`] = by;
    set[`${loc.path}.updatedAt`] = nowIst;
    if (paidDate) set[`${loc.path}.date`] = combineDate(paidDate);
    if (narration) set[`${loc.path}.remark`] = narration;
  });
  return { filter, set, paidDate, narration, updatedBy: by, records: slot.locs.length };
}

module.exports = { CORRECTION_RE, cleanName, storedPayments, mapLineToSlot, utrStatements, planCorrections, buildCorrectionWrite, sameUtr };
