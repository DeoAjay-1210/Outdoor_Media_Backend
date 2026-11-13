/**
 * UTR extraction from Gmail thread messages — PURE functions, no network, no database.
 *
 * A UTR is only accepted when it sits right after an explicit label (UTR, UTR Number,
 * Transaction Reference Number ...). Free-floating numbers (invoice no, amount, account no)
 * are never picked up. Quoted history of earlier messages is stripped first so a reply that
 * quotes the UTR does not count as a second source.
 */

// UTR / Transaction Reference labels (case-insensitive). "Reference Number" alone is NOT a label:
// invoice and bill references use it.
const LABEL =
  "(?:UTR(?:\\s*(?:No\\.?|Number|Num|Ref(?:erence)?(?:\\s*(?:No\\.?|Number))?|#))?|Transaction\\s+Ref(?:erence)?(?:\\s*(?:No\\.?|Number|Num|ID))?|Txn\\s*Ref(?:erence)?(?:\\s*(?:No\\.?|Number))?|Bank\\s+Ref(?:erence)?\\s*(?:No\\.?|Number))";
// separator between label and value: ":", "-", "–", "=", "|" or just spaces / tab
const SEP = "[ \\t]*(?:[:=|\\-–—]+)?[ \\t]*";
// ANY value Finance writes after the UTR label: 3-30 alphanumerics with at least one digit (SBIN92023012200543116, 412345678901, UTR7843274, jfiew4343, 1325ASD)
const VALUE = "([A-Za-z0-9]{3,30})";
const SAME_LINE = new RegExp(`\\b${LABEL}(?![A-Za-z0-9])${SEP}${VALUE}(?![A-Za-z0-9])`, "gi");
const LABEL_ONLY_LINE = new RegExp(`^\\W*${LABEL}\\W*$`, "i");
const VALUE_ONLY_LINE = new RegExp(`^\\W*${VALUE}\\W*$`);

const hasDigits = (s) => /\d/.test(s); // letters only ("UTR : pending", "UTR: NA") is never a UTR

/** Drops quoted history: ">" lines and everything after an "On ... wrote:" / "From:" header. */
const stripQuoted = (text) => {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^>/.test(t)) continue;
    if (/^On .{5,200}wrote:?$/i.test(t)) break;
    // "On Mon, 5 Jan 2026 at 10:00, X <x@y.com>" wrapped over two lines, "wrote:" on the next
    if (/^On .{5,200}$/i.test(t) && /wrote:?$/i.test((lines[i + 1] || "").trim())) break;
    if (/^-{2,}\s*(Forwarded|Original) message\s*-{2,}$/i.test(t)) break;
    if (/^From:\s.+/i.test(t) && /^(Sent|Date):/i.test((lines[i + 1] || "").trim())) break;
    kept.push(line);
  }
  return kept.join("\n");
};

/**
 * Reply text, tidied so that a line that Gmail / the mail client broke is read as the ONE line Finance typed:
 *   - odd spaces (no-break, narrow no-break, zero-width) become normal spaces / nothing
 *   - "Name - <BillNo> :"  + next line "UTR1111111111111,"       (value wrapped to the next line)
 *   - "Name - UTR :"       + next line "UTR1111111111111"        (same, with the label on the first line)
 *   - "Name -"             + next line "UTR : UTR1111111111111"  (label wrapped to the next line)
 *   - "Name"               + next line "- UTR : UTR1111111111111" (separator + label start the next line)
 * Only a continuation that is JUST a UTR value / starts with the UTR label is joined; signatures, bullets of other landlords and ordinary text are not.
 */
const VALUE_LINE = /^\s*(?:UTR(?:\s*(?:No\.?|Number|Num|Ref(?:erence)?|#))?\s*[:=|\-\u2013\u2014]*\s*)?[A-Za-z0-9]{3,30}\s*[,;.]?\s*$/i;
const LABEL_START = /^\s*[:=|\-\u2013\u2014]*\s*(?:UTR|Transaction\s+Ref)/i;
function joinWrappedValues(text) {
  const src = String(text || "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "").split("\n");
  const out = [];
  const nextIdx = (i) => { let j = i + 1; while (j < src.length && !src[j].trim()) j++; return j; };
  const hasValue = (l) => /\bUTR[A-Za-z0-9 .#:=|\-\u2013\u2014]*[A-Za-z0-9]{3,30}\s*[,;.]?\s*$/i.test(l) && /\d/.test(l.split(/UTR/i).pop() || "");
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const j = nextIdx(i);
    if (line.trim() && j < src.length) {
      const next = src[j];
      const endsSep = /[:=|\-\u2013\u2014]\s*$/.test(line);
      const joinValue = endsSep && /\d/.test(next) && VALUE_LINE.test(next);
      const joinLabel = endsSep && LABEL_START.test(next) && /\d/.test(next);
      const joinLead = !endsSep && !hasValue(line) && /^\s*[:=|\-\u2013\u2014]+\s*(?:UTR|Transaction\s+Ref)/i.test(next) && /\d/.test(next);
      const joinBill = endsSep && /^\s*ADNOOHBILL\d/i.test(next); // "Name -" + next line "<BillNo> : UTR ..."
      if (joinValue || joinLabel || joinLead || joinBill) { out.push(line.replace(/\s+$/, "") + " " + next.trim()); i = j; continue; }
    }
    out.push(line);
  }
  return out.join("\n");
}

// the first labelled UTR on ONE line: { utr, labelStart, end } | null  (used for "Jamuna - UTR: X" landlord lines)
const LINE_UTR = new RegExp(`\\b(${LABEL})(?![A-Za-z0-9])${SEP}${VALUE}(?![A-Za-z0-9])`, "i");
const findUtrInLine = (line) => {
  const m = LINE_UTR.exec(String(line || ""));
  if (!m || !hasDigits(m[2])) return null;
  return { utr: m[2].toUpperCase(), labelStart: m.index, end: m.index + m[0].length };
};

/** All labelled UTR candidates in one text: [{ utr, label }] (document order, may repeat). */
const findCandidates = (text) => {
  const out = [];
  const body = joinWrappedValues(stripQuoted(text)); // a line the mail client broke is read as the one line Finance typed
  for (const m of body.matchAll(SAME_LINE)) {
    if (hasDigits(m[1])) out.push({ utr: m[1].toUpperCase(), label: m[0].slice(0, m[0].length - m[1].length).trim() });
  }
  // "UTR Number" on its own line, value alone on the next non-empty line
  const lines = body.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!LABEL_ONLY_LINE.test(lines[i].trim())) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const v = j < lines.length ? lines[j].trim().match(VALUE_ONLY_LINE) : null;
    if (v && hasDigits(v[1])) out.push({ utr: v[1].toUpperCase(), label: lines[i].trim().replace(/[\W]+$/, "") });
  }
  return out;
};

/**
 * Extracts the UTR from the messages of one thread (oldest first).
 * messages: [{ id, from, date, bodyText }]
 * Result: { status, utr, source, candidates }
 *   status "found"                    -> exactly one distinct UTR in the thread (utr + source set)
 *   status "multiple_review_required" -> more than one distinct UTR, nothing picked (utr null)
 *   status "not_found"                -> no labelled UTR anywhere
 */
const extractUtrFromThread = (messages) => {
  const candidates = [];
  for (const msg of messages || []) {
    const seen = new Set();
    for (const c of findCandidates(msg.bodyText)) {
      if (seen.has(c.utr)) continue;
      seen.add(c.utr);
      candidates.push({ utr: c.utr, label: c.label, messageId: msg.id, from: msg.from, date: msg.date, sentAt: msg.sentAt || msg.date });
    }
  }
  const distinct = [...new Set(candidates.map((c) => c.utr))];
  if (!distinct.length) return { status: "not_found", utr: null, source: null, candidates: [] };
  if (distinct.length > 1) return { status: "multiple_review_required", utr: null, source: null, candidates };
  // same UTR repeated across messages: the first message that states it is the source
  return { status: "found", utr: distinct[0], source: candidates[0], candidates };
};

// "Bill Number : adinn0511202601" (also "Bill No.", "Bill #"); value needs 6-40 chars incl. a digit
const BILL_NUMBER = /\bBill\s*(?:Number|No\.?|Num|#)[ \t]*(?:[:=|\-–—]+)?[ \t]*([A-Za-z0-9][A-Za-z0-9\-\/]{5,39})(?![A-Za-z0-9\-\/])/gi;

/** Distinct Bill Numbers stated in one text (quoted history ignored), original case kept. */
const extractBillNumbers = (text) => {
  const found = new Set();
  for (const m of stripQuoted(text).matchAll(BILL_NUMBER)) {
    if (/\d/.test(m[1])) found.add(m[1]);
  }
  return [...found];
};

// ── CASH payments have NO UTR: the reply only says the payment was made in cash (and, optionally, the paid date) ──
// "Cash", "Cash - Paid Date: 10-Nov-2026", "Landlord1 - NewBill - Cash - Paid Date: 10-Nov-2026". The word Cash must END the
// name part and only a paid-date phrase (or nothing) may follow, so "Cash Amount ₹ 0" / "Payment Category: Cash Mode" of an
// approval mail are never a payment. A line that carries a UTR is a UTR line, never a Cash line.
const { extractExplicitPaymentDates } = require("./utrPaidDate");
const CASH_WORD = /\bcash\b/i;
const CASH_REST = /^\s*(?:[-–—:|,;]\s*)*(?:(?:paid|payment|done|completed|received)\b.*|\d{1,2}[-\/. ][A-Za-z0-9]{1,9}[-\/. ]\d{2,4}\s*)?$/i;
function extractCashLines(text) {
  const out = [];
  for (const raw of stripQuoted(text).split("\n")) {
    if (findUtrInLine(raw)) continue;
    const m = CASH_WORD.exec(raw);
    if (!m) continue;
    const rest = raw.slice(m.index + m[0].length);
    if (!CASH_REST.test(rest)) continue;
    const name = raw.slice(0, m.index + m[0].length).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    out.push({ name, utr: "", cash: true, dates: extractExplicitPaymentDates(rest).map((d) => ({ date: d.date, label: d.label })), line: raw.trim() });
  }
  return out;
}

module.exports = { joinWrappedValues, extractUtrFromThread, extractBillNumbers, findCandidates, findUtrInLine, stripQuoted, extractCashLines };
