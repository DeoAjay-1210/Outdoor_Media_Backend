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
// 12-30 alphanumerics with at least one digit (HDFC92023012200543116, 412345678901, SBIN...)
const VALUE = "([A-Za-z0-9]{12,30})";
const SAME_LINE = new RegExp(`\\b${LABEL}(?![A-Za-z0-9])${SEP}${VALUE}(?![A-Za-z0-9])`, "gi");
const LABEL_ONLY_LINE = new RegExp(`^\\W*${LABEL}\\W*$`, "i");
const VALUE_ONLY_LINE = new RegExp(`^\\W*${VALUE}\\W*$`);

const hasDigits = (s) => /\d/.test(s) && /\d{6,}/.test(s);

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

/** All labelled UTR candidates in one text: [{ utr, label }] (document order, may repeat). */
const findCandidates = (text) => {
  const out = [];
  const body = stripQuoted(text);
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
      candidates.push({ utr: c.utr, label: c.label, messageId: msg.id, from: msg.from, date: msg.date });
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

module.exports = { extractUtrFromThread, extractBillNumbers, findCandidates, stripQuoted };
