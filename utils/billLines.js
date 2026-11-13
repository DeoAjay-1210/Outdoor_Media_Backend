/**
 * REPLY LINES THAT NAME A BILL NUMBER - PURE functions, no network, no database.
 *
 * When one Gmail thread holds the approval mails of SEVERAL months (one Bill Number each) Finance may pay them with ONE transfer and
 * reply once, listing every bill:
 *     Landlord1 - ADNOOHBILL0911202691 : UTR432423443
 *     Landlord1 - GST - ADNOOHBILL0911202691 : UTR873247343        (GST on hold)
 *     Landlord2 - ADNOOHBILL1011202692 : Cash - Paid Date: 10-Nov-2026
 * The Bill Number is the primary key: a line belongs to a bill ONLY when it contains that exact Bill Number, and only Bill Numbers of the
 * approval mails of the same thread are recognised (so an unrelated code is never taken). The same UTR may be listed for several bills.
 * The text before the Bill Number is "<landlord>" or "<landlord> - GST" (or "<landlord> - Rent"): it is kept and validated later by the
 * normal landlord / Rent / GST mapping, so a wrong landlord name or component is still skipped for manual review.
 */
const { stripQuoted, extractCashLines, joinWrappedValues } = require("./utrExtractor");

const regexEscape = (v) => String(v).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
// a Bill Number (ADNOOHBILL + digits) has no dash: a dash next to it is the line separator ("Aran-<BillNo>:UTR..."), not part of a longer code
const BILL_CHAR = "[A-Za-z0-9/]";
const billRegex = (b) => new RegExp(`(?<!${BILL_CHAR})${regexEscape(b)}(?!${BILL_CHAR})`, "i");
const SEPS = "(?:[:=|\\-–—]+\\s*)*";
const UTR_AFTER_BILL = new RegExp(`^\\s*${SEPS}(?:UTR(?:\\s*(?:No\\.?|Number|Num|Ref(?:erence)?|#))?(?=[\\s:=|#\\-\u2013\u2014])\\s*${SEPS})?([A-Za-z0-9]{3,30})(?![A-Za-z0-9])`, "i");
const CASH_AFTER_BILL = new RegExp(`^\\s*${SEPS}cash\\b(.*)$`, "i");

/**
 * -> [{ bill, kind: "utr"|"cash", name, utr, tail, line }]   (document order)
 * name = the text before the Bill Number ("Landlord1", "Landlord1 - GST", "" ...); tail = what follows the UTR (a Paid Date phrase).
 */
function extractBillLines(text, knownBills) {
  const bills = [...new Set((knownBills || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  const out = [];
  if (!bills.length) return out;
  for (const raw of joinWrappedValues(stripQuoted(text)).split("\n")) {
    let hit = null;
    for (const b of bills) {
      const m = billRegex(b).exec(raw);
      if (m) { hit = { bill: b, index: m.index, end: m.index + m[0].length }; break; }
    }
    if (!hit) continue;
    const name = raw
      .slice(0, hit.index)
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/[\s\-–—:|,]*bill\s*(?:number|no\.?|#)?[\s\-–—:|,]*$/i, "")
      .replace(/[\s\-–—:|,]+$/, "")
      .trim();
    const rest = raw.slice(hit.end);
    const c = CASH_AFTER_BILL.exec(rest);
    if (c) {
      if (extractCashLines(`${name ? name + " - " : ""}Cash${c[1]}`).length) out.push({ bill: hit.bill, kind: "cash", name, utr: "", tail: c[1], line: raw.trim() });
      continue;
    }
    const m = UTR_AFTER_BILL.exec(rest);
    if (!m || !/\d/.test(m[1])) continue;
    if (bills.some((b) => b.toLowerCase() === m[1].toLowerCase())) continue; // another Bill Number, not a UTR
    out.push({ bill: hit.bill, kind: "utr", name, utr: m[1].toUpperCase(), tail: rest.slice(m[0].length), line: raw.trim() });
  }
  return out;
}

/** The lines of ONE bill rewritten as ordinary reply lines ("Landlord1 - UTR : X", "Landlord1 - GST - UTR : X", "Landlord2 - Cash - Paid Date: ..."). */
function billLinesAsReply(lines) {
  return lines
    .map((l) => (l.kind === "cash" ? `${l.name ? l.name + " - " : ""}Cash${l.tail}` : `${l.name ? l.name + " - " : ""}UTR : ${l.utr}${l.tail}`))
    .join("\n");
}

/** UTR -> the distinct Bill Numbers (lower-case) that ONE reply lists with it; only UTRs listed for 2+ bills. */
function commonUtrBills(lines) {
  const by = new Map();
  for (const l of lines) {
    if (l.kind !== "utr") continue;
    if (!by.has(l.utr)) by.set(l.utr, new Set());
    by.get(l.utr).add(l.bill.toLowerCase());
  }
  const out = {};
  for (const [u, s] of by) if (s.size > 1) out[u] = [...s];
  return out;
}

module.exports = { extractBillLines, billLinesAsReply, commonUtrBills };
