/**
 * BANK NARRATION of a Finance payment confirmation ("Payment Uploaded" mail). PURE: no network, no database.
 *
 * The accounts team's mail carries a bank table:
 *   Date | Month | Ledger Name | Amount | Account Name | Bank | Account No | IFSC | Payment Through | Type Of Payment | Bank Reference | Narration
 * Gmail's text/plain turns a row into ONE flat (line-wrapped) string, e.g.
 *   04-11-2026 Nov-26 B SIVAKUMAR HOARDING LANDLORD 15000 B SIVAKUMAR INDIAN BANK 6566930110 IDIB000N079 AXIS 9445 NEFT ADINN041161985 <narration>
 * so a row is read from the anchors that never change: the date at the start, the account number + IFSC, the payment type word and the
 * single-token Bank Reference; the narration is everything after the Bank Reference up to "Total Amount". HTML tables (cells joined by
 * " | " or tabs) are flattened the same way. The narration text is kept exactly as written (only whitespace / line wraps are joined).
 */
const { matchLandlord, nameTokens } = require("./landlordUtrParser");

const TYPES = "NEFT|RTGS|IMPS|UPI|CHEQUE|CHECK|CASH|DD|ACH|ECS|TRANSFER|CARD";
const ROW = new RegExp(
  "^(\\d{2}[-/.]\\d{2}[-/.]\\d{4})\\s+(?:([A-Za-z]{3,9}[-\\s]\\d{2,4})\\s+)?(.+?)\\s+([\\d,]+(?:\\.\\d{1,2})?)\\s+(.+?)\\s+(\\d{6,20})\\s+([A-Za-z]{4}0[A-Za-z0-9]{6})\\s+(.+?)\\s+(" + TYPES + ")\\s+(\\S+)(?:\\s+(.+))?$",
  "i",
);
const HEADER = /Bank\s+Reference\s*[|\s]*Narration/i;
const END = /Total\s+Amount|Thanks\s*(?:&|and)\s*Regards|Regards,|\bOn\s+\w{3},\s+\w{3}\s+\d{1,2},\s+\d{4}\b/i;

/** Flatten a message text: quote marks, phone-link artefacts, cell separators and line wraps become single spaces. */
function flatten(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[>\s]+/gm, "") // reply quoting (a later reply quotes the table again)
    .replace(/<[^>\n]*>/g, " ") // "<(656)%20693-0110>" phone links, <mailto:...>
    .replace(/[|\t]+/g, " ")
    .replace(/\*/g, "") // bold markers of text/plain
    .replace(/\s+/g, " ")
    .trim();
}

/** -> [{ date, month, ledgerName, amount, payee, accountNo, ifsc, paymentThrough, type, reference, narration }] */
function extractBankRows(text) {
  const flat = flatten(text);
  const out = [];
  let from = 0;
  for (;;) {
    const h = HEADER.exec(flat.slice(from));
    if (!h) break;
    const start = from + h.index + h[0].length;
    const rest = flat.slice(start);
    const e = END.exec(rest);
    const region = (e ? rest.slice(0, e.index) : rest.slice(0, 1500)).trim();
    from = start;
    // a row starts at every DD-MM-YYYY
    const starts = [...region.matchAll(/\b\d{2}[-/.]\d{2}[-/.]\d{4}\b/g)].map((m) => m.index);
    starts.forEach((s, i) => {
      const chunk = region.slice(s, starts[i + 1] ?? region.length).trim();
      const m = ROW.exec(chunk);
      if (!m) { out.push({ unparsed: chunk.slice(0, 160) }); return; }
      out.push({
        date: m[1], month: m[2] || "", ledgerName: m[3].trim(), amount: Number(m[4].replace(/,/g, "")),
        payee: m[5].trim(), accountNo: m[6], ifsc: m[7].toUpperCase(), paymentThrough: m[8].trim(), type: m[9].toUpperCase(),
        reference: m[10], narration: (m[11] || "").trim(),
      });
    });
  }
  return out;
}

/** Rows of every message (own text or quoted), duplicates (the same table quoted again) removed. -> { rows, unparsed } */
function collectBankRows(messages) {
  const seen = new Set();
  const rows = [];
  const unparsed = [];
  for (const m of messages || []) {
    for (const r of extractBankRows(m.bodyText)) {
      if (r.unparsed) { unparsed.push(r.unparsed); continue; }
      const key = [r.reference, r.accountNo, r.amount, r.narration].join("|").toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...r, messageId: m.id });
    }
  }
  return { rows, unparsed };
}

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const last4 = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length >= 4 ? d.slice(-4) : null; };

/** Which landlord a bank row pays: by account number (last 4) and by name words in Ledger Name / Account Name. -> landlord | null | "ambiguous" */
function landlordOfRow(row, landlords) {
  const byAcc = row.accountNo ? landlords.filter((l) => l.accountLast4 && l.accountLast4 === last4(row.accountNo)) : [];
  const wordList = norm(`${row.ledgerName} ${row.payee}`).split(" ").filter(Boolean);
  const words = new Set(wordList);
  // the bank may write "land1" for the landlord "land 1": consecutive words joined together are candidates too (whole words only, never a part of a word)
  const joined = new Set(wordList);
  for (let i = 0; i < wordList.length; i++) for (let k = 2; k <= 3 && i + k <= wordList.length; k++) joined.add(wordList.slice(i, i + k).join(""));
  const byName = landlords.filter((l) => {
    const t = nameTokens(l.name).filter((x) => x.length >= 2);
    if (t.length > 0 && t.every((x) => words.has(x))) return true;
    const compact = nameTokens(l.name).join("");
    return compact.length >= 3 && joined.has(compact);
  });
  if (byAcc.length > 1) return "ambiguous";
  if (byAcc.length === 1) {
    if (byName.length && !byName.some((l) => l.landOwnerId === byAcc[0].landOwnerId)) return "ambiguous"; // account says one landlord, name another
    return byAcc[0];
  }
  if (byName.length === 1) return byName[0];
  return byName.length > 1 ? "ambiguous" : null;
}

/**
 * Narration of ONE payment.
 * rows      : collectBankRows().rows
 * landlords : [{ landOwnerId, name, accountLast4 }] of the bill
 * opts      : { landOwnerId, amount?, siblings } — siblings = how many payments of this landlord are saved in the same run (Rent + GST)
 * -> { narration, reason, via }  narration "" when nothing can be said for sure (the caller keeps its default remark)
 *
 * One landlord: the thread's one distinct narration. Several landlords: only a row that names ITS landlord (account / name); never
 * the first row, never the same narration for everybody. A landlord with two rows (Rent and GST paid separately) is told apart by the
 * amount of the payment only after the landlord itself is known; otherwise nothing is guessed.
 */
function narrationFor(rows, landlords, { landOwnerId, amount = null, siblings = 1 }) {
  const usable = (rows || []).filter((r) => r.narration);
  if (!usable.length) return { narration: "", reason: "no_narration_in_thread" };
  let mine;
  let via;
  if (landlords.length === 1) {
    mine = usable;
    via = "single_landlord";
  } else {
    const mapped = usable.map((r) => ({ r, l: landlordOfRow(r, landlords) }));
    if (mapped.some((x) => x.l === "ambiguous") && !mapped.some((x) => x.l && x.l !== "ambiguous" && x.l.landOwnerId === landOwnerId)) return { narration: "", reason: "narration_landlord_ambiguous" };
    mine = mapped.filter((x) => x.l && x.l !== "ambiguous" && x.l.landOwnerId === landOwnerId).map((x) => x.r);
    via = "landlord_match";
    if (!mine.length) return { narration: "", reason: mapped.some((x) => !x.l) ? "narration_landlord_not_identified" : "no_narration_for_landlord" };
  }
  const distinct = [...new Set(mine.map((r) => r.narration))];
  if (distinct.length === 1 && siblings <= 1) return { narration: distinct[0], reason: "", via, reference: mine[0].reference };
  if (distinct.length === 1 && siblings > 1) {
    // Rent and GST of one landlord, one row: it cannot be told which payment it belongs to
    return { narration: "", reason: "narration_row_not_attributable_to_rent_or_gst" };
  }
  const byAmount = mine.filter((r) => amount !== null && Number(r.amount) === Number(amount));
  const one = [...new Set(byAmount.map((r) => r.narration))];
  if (one.length === 1) return { narration: one[0], reason: "", via: via + "+amount", reference: byAmount[0].reference };
  return { narration: "", reason: "narration_rows_ambiguous" };
}

module.exports = { extractBankRows, collectBankRows, narrationFor, landlordOfRow, flatten };
