/**
 * Multi-landlord UTR parsing and mapping — PURE functions, no network, no database.
 *
 * Finance replies to the CMD approval thread with ONE mail, one line per landlord:
 *     Jamuna - UTR: SBIN92023012200543116 - Paid Date: 10-Nov-2026
 * A first name is enough. Nothing is guessed: a landlord is matched only when the words of the reply name are
 * whole words of EXACTLY ONE landlord of the bill. Order and amount are never used.
 *
 * Manual-review reasons (nothing is saved for the bill when any of them is raised):
 *   unnamed_utr_line | landlord_name_too_short | landlord_name_not_found | landlord_name_ambiguous |
 *   conflicting_utr_for_landlord | duplicate_utr | missing_landlord_utr | settled_landlord_utr_mismatch |
 *   account_mismatch_in_reply | bank_mismatch_in_reply | not_listed_in_approval_mail |
 *   account_mismatch_approval_mail | bank_mismatch_approval_mail
 */
const { findUtrInLine, stripQuoted } = require("./utrExtractor");
const { extractExplicitPaymentDates } = require("./utrPaidDate");

const alnum = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Whole words of a name, upper-case; text in (brackets) is ignored — "K.Thilagam (Kingads)" -> K, THILAGAM. */
const nameTokens = (name) =>
  String(name || "")
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

/** Account number / bank typed after the UTR on a reply line (both optional extra checks). */
function replyExtras(rest) {
  const acc = String(rest || "").match(/(?<![\d])(\d{9,18})(?![\d])/);
  const bank = String(rest || "").match(/\bBank\s*[:=]\s*([A-Za-z][A-Za-z .&]*?)(?=\s*(?:[-–—|,;]|$))/i);
  return { accountLast4: acc ? acc[1].slice(-4) : null, bank: bank ? bank[1].trim() : null };
}

/**
 * Landlord lines of ONE reply text (quoted history ignored):
 * [{ name, utr, dates: [{ date }], accountLast4, bank, line }]. A line without a name has name "".
 */
function extractLandlordUtrLines(text) {
  const out = [];
  for (const raw of stripQuoted(text).split("\n")) {
    const hit = findUtrInLine(raw);
    if (!hit) continue;
    const name = raw
      .slice(0, hit.labelStart)
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/[\s\-–—:|,]+$/, "")
      .trim();
    const rest = raw.slice(hit.end);
    const extras = replyExtras(rest);
    out.push({ name, utr: hit.utr, dates: extractExplicitPaymentDates(rest).map((d) => ({ date: d.date, label: d.label })), accountLast4: extras.accountLast4, bank: extras.bank, line: raw.trim() });
  }
  return out;
}

/** "Rent", "Base Rent", "Rental", "Rent Amount" -> "rent"; "GST", "GST Amount" -> "gst"; anything else -> null. */
function classifyPaymentLabel(name) {
  const t = nameTokens(name).join(" ");
  if (/^(BASE )?RENT(AL)?( AMOUNT)?$/.test(t)) return "rent";
  if (/^GST( AMOUNT)?$/.test(t)) return "gst";
  return null;
}

/**
 * GST-on-hold bills: the rent UTR and the GST UTR are separate payments and may arrive in different replies (days apart).
 * replies: [{ messageId, sentDate, lines }] of the whole thread, oldest first.
 * Only lines labelled Rent / GST count; an unlabelled "UTR : X" is never used (it could be either) and is reported.
 * -> { byKind: { rent, gst }  (each { utr, line, reply } | null), conflicts: [kind], dupBoth, ignored: [...] }
 */
function mapPaymentKinds(replies, landlord) {
  const found = { rent: [], gst: [] };
  const ignored = [];
  for (const r of replies || []) {
    for (const l of r.lines || []) {
      let kind = classifyPaymentLabel(l.name);
      if (!kind && !r.billExplicit && landlord && l.name) {
        const k0 = splitNameKind(l.name, [landlord]);
        if (k0.kind && k0.landlord && !matchLandlord(k0.landlord, [landlord]).error) kind = k0.kind; // "L1 with gst - Rent", "L1 with gst - GST"
      }
      if (!kind && r.billExplicit) {
        // a line that names its Bill Number: "<landlord>" = Rent, "<landlord> - GST" = GST; the landlord must be the bill's landlord
        const k = splitNameKind(l.name, landlord ? [landlord] : null);
        if (k.landlord && landlord && matchLandlord(k.landlord, [landlord]).error) { ignored.push({ messageId: r.messageId, name: l.name, reason: "landlord_name_not_found" }); continue; }
        kind = k.kind || "rent";
      }
      if (!kind) { ignored.push({ messageId: r.messageId, name: l.name, reason: l.name ? "label_is_not_rent_or_gst" : "unlabelled_utr_line" }); continue; }
      found[kind].push({ line: l, reply: r });
    }
  }
  const byKind = { rent: null, gst: null };
  const conflicts = [];
  for (const kind of ["rent", "gst"]) {
    const distinct = [...new Set(found[kind].map((x) => x.line.utr.toUpperCase()))];
    if (distinct.length > 1) conflicts.push(kind);
    else if (distinct.length === 1) byKind[kind] = { utr: distinct[0], line: found[kind][0].line, reply: found[kind][0].reply }; // earliest reply that states it
  }
  const dupBoth = !!(byKind.rent && byKind.gst && byKind.rent.utr === byKind.gst.utr);
  return { byKind, conflicts, dupBoth, ignored };
}

/**
 * "Landlord1 - Rent", "Landlord2 GST", "K. Jamuna - Base Rent" -> { landlord: "Landlord1", kind: "rent" }.
 * The payment label is the LAST part of the name; without it kind is null (the line could be rent or GST).
 */
const NAME_KIND = /^(.*?)[\s\-–—:|,]+((?:base\s+)?rent(?:al)?(?:\s+amount)?|gst(?:\s+amount)?)\s*$/i;
function splitNameKind(name, landlords) {
  // a landlord whose OWN name ends in "gst" / "rent" ("L1 with gst"): when the whole text is exactly a landlord of the bill, it is that landlord (no label)
  if (landlords && landlords.length && String(name || "").trim()) {
    const w = matchLandlord(name, landlords);
    if (!w.error && w.matchedBy === "full_name") return { landlord: String(name).trim(), kind: null };
  }
  const m = String(name || "").match(NAME_KIND);
  if (!m || !m[1].trim()) return { landlord: String(name || "").trim(), kind: null };
  return { landlord: m[1].trim(), kind: classifyPaymentLabel(m[2]) };
}

/** The landlord a reply name refers to: { landlord, matchedBy } or { error }. */
function matchLandlord(replyName, landlords) {
  const rt = nameTokens(replyName);
  if (!rt.length) return { error: "unnamed_utr_line" };
  if (!rt.some((t) => t.length >= 2)) return { error: "landlord_name_too_short" }; // only initials
  const candidates = landlords.filter((l) => {
    const lt = new Set(nameTokens(l.name));
    return rt.every((t) => lt.has(t));
  });
  if (!candidates.length) return { error: "landlord_name_not_found" };
  if (candidates.length === 1) {
    const lt = nameTokens(candidates[0].name);
    return { landlord: candidates[0], matchedBy: lt.length === rt.length ? "full_name" : "first_name" };
  }
  // several landlords contain these words: only an exact full-name match can still be unique
  const exact = candidates.filter((l) => { const lt = nameTokens(l.name); return lt.length === rt.length && rt.every((t) => lt.includes(t)); });
  if (exact.length === 1) return { landlord: exact[0], matchedBy: "full_name" };
  return { error: "landlord_name_ambiguous" };
}

const bankMatches = (a, b) => { const x = alnum(a); const y = alnum(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

/**
 * lines    : extractLandlordUtrLines() of the (single) reply
 * landlords: [{ landOwnerId, name, state: "pending" | "settled", storedUtr, bankName, accountLast4 }]
 * -> { ok, reasons: [{ reason, ... }], mappings: [{ landlord, line, matchedBy, validation }] }   (all-or-nothing)
 */
function mapLandlords(lines, landlords) {
  const reasons = [];
  const byLandlord = new Map();

  for (const l of lines) {
    const m = matchLandlord(l.name, landlords);
    if (m.error) { reasons.push({ reason: m.error, name: l.name }); continue; }
    const id = m.landlord.landOwnerId;
    const prev = byLandlord.get(id);
    if (prev) {
      if (prev.line.utr !== l.utr) reasons.push({ reason: "conflicting_utr_for_landlord", name: m.landlord.name });
      continue; // the same line repeated is harmless
    }
    // optional extra checks typed on the reply line
    const validation = { bank: "n/a", account: "n/a" };
    if (l.accountLast4 && m.landlord.accountLast4) {
      if (l.accountLast4 === m.landlord.accountLast4) validation.account = "ok";
      else { validation.account = "mismatch"; reasons.push({ reason: "account_mismatch_in_reply", name: m.landlord.name }); }
    }
    if (l.bank && m.landlord.bankName) {
      if (bankMatches(l.bank, m.landlord.bankName)) validation.bank = "ok";
      else { validation.bank = "mismatch"; reasons.push({ reason: "bank_mismatch_in_reply", name: m.landlord.name }); }
    }
    byLandlord.set(id, { line: l, landlord: m.landlord, matchedBy: m.matchedBy, validation });
  }

  const seen = new Map();
  for (const [id, v] of byLandlord) {
    const key = v.line.utr.toUpperCase();
    if (seen.has(key)) reasons.push({ reason: "duplicate_utr", utr: key });
    else seen.set(key, id);
  }

  for (const l of landlords) {
    const v = byLandlord.get(l.landOwnerId);
    if (l.state === "pending" && !v) reasons.push({ reason: "missing_landlord_utr", name: l.name });
    if (l.state === "settled" && v && (!l.storedUtr || String(l.storedUtr).toLowerCase() !== v.line.utr.toLowerCase())) {
      reasons.push({ reason: "settled_landlord_utr_mismatch", name: l.name });
    }
  }
  return { ok: reasons.length === 0, reasons, mappings: [...byLandlord.values()] };
}

/**
 * GST-on-hold bill with SEVERAL landlords: every line names a landlord AND a payment ("Landlord1 - Rent - UTR : X").
 * replies : [{ messageId, sentDate, lines }] of the whole (scoped) thread, oldest first
 * landlords: [{ landOwnerId, name, bankName, accountLast4 }]
 * -> { byKey: Map("<landOwnerId>|rent|gst" -> [{ utr, line, reply, landlord }]), problems: [{ reason, name }], ignored: [...] }
 * A line whose landlord name matches nobody / several / only an initial is a PROBLEM (nothing is saved for the bill);
 * a line without a rent / GST label is never used (ignored + reported).
 */
function mapLandlordKinds(replies, landlords) {
  const problems = [];
  const ignored = [];
  const byKey = new Map();
  for (const r of replies || []) {
    for (const l of r.lines || []) {
      const sk = splitNameKind(l.name, landlords);
      const nm = sk.landlord;
      const kind = sk.kind || (r.billExplicit && nm ? "rent" : null); // a line naming its Bill Number without GST = the Rent UTR
      if (!kind) { ignored.push({ messageId: r.messageId, name: l.name, reason: nm ? "no_rent_or_gst_label" : "unnamed_utr_line" }); continue; }
      const m = matchLandlord(nm, landlords);
      if (m.error) { problems.push({ reason: m.error, name: l.name }); continue; }
      if (l.accountLast4 && m.landlord.accountLast4 && l.accountLast4 !== m.landlord.accountLast4) problems.push({ reason: "account_mismatch_in_reply", name: m.landlord.name });
      if (l.bank && m.landlord.bankName && !bankMatches(l.bank, m.landlord.bankName)) problems.push({ reason: "bank_mismatch_in_reply", name: m.landlord.name });
      const key = `${m.landlord.landOwnerId}|${kind}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ utr: l.utr, line: l, reply: r, landlord: m.landlord, matchedBy: m.matchedBy });
    }
  }
  return { byKey, problems, ignored };
}

/**
 * NEW BILL / ADVANCE reply lines: "<landlord> - NewBill|Advance - Rent|GST - UTR : X".
 * name -> { landlord, kind: "rent"|"gst"|null, billType: "newBill"|"advance"|null }.
 *   "NewBill"                   -> landlord "",          kind null,  billType newBill
 *   "NewBill - Rent"            -> landlord "",          kind rent,  billType newBill
 *   "Landlord1 - NewBill - GST" -> landlord "Landlord1", kind gst,   billType newBill
 *   "Landlord1 - Advance"       -> landlord "Landlord1", kind null,  billType advance
 * A name without NewBill / Advance has billType null (such a line is never used for these bills).
 */
const BILL_TOKEN = /^(.*?)(?:[\s\-–—:|,]+|^)(new\s*bill|advance)\s*$/i;
/** "Landlord1 - Cash" / "Cash" -> { landlord: "Landlord1" | "" }, anything not ending in Cash -> null */
function splitCashName(name) {
  const m = String(name || "").match(/^(.*?)(?:[\s\-–—:|,]+|^)cash\s*$/i);
  return m ? { landlord: m[1].trim() } : null;
}

function splitArrearsName(name, landlords) {
  const k = splitNameKind(name, landlords);
  let landlord = k.landlord;
  let kind = k.kind;
  if (!kind) {
    const c = splitCashName(k.landlord); // "Landlord1 - NewBill - Cash" -> kind "cash" (no UTR)
    if (c) { landlord = c.landlord; kind = "cash"; }
  }
  const m = String(landlord || "").match(BILL_TOKEN);
  if (!m) return { landlord, kind, billType: null };
  return { landlord: m[1].trim(), kind, billType: /^advance$/i.test(m[2]) ? "advance" : "newBill" };
}

/**
 * Reply lines of a New Bill / Advance bill -> payments.
 * replies  : [{ messageId, sentDate, lines }] of the (In-Reply-To scoped) thread
 * landlords: [{ landOwnerId, name, bankName, accountLast4 }]
 * opts     : { billType: "newBill"|"advance", gstHold: bool }
 * -> { byKey: Map("<landOwnerId>|rent|gst" -> [{ utr, line, reply, landlord }]), problems, ignored }
 *  - the line must carry the SAME bill type as the bill (a New Bill UTR is never an Advance UTR): another type = problem,
 *    none = ignored (reported)
 *  - a line without a landlord name is accepted only when the bill has ONE landlord
 *  - a line without Rent / GST is rent when the bill has no GST on hold, otherwise ignored (it could be either)
 *  - unknown / ambiguous / initial-only landlord names are problems (nothing is saved for the bill)
 */
function mapArrearsLines(replies, landlords, { billType, gstHold }) {
  const problems = [];
  const ignored = [];
  const byKey = new Map();
  for (const r of replies || []) {
    // UTR lines and Cash lines ("<landlord> - NewBill - Cash [- Paid Date: ..]", no UTR) of the same reply
    for (const l of [...(r.lines || []), ...(r.cashLines || [])]) {
      const p = splitArrearsName(l.name, landlords);
      if (l.cash && p.kind !== "cash") { ignored.push({ messageId: r.messageId, name: l.name, reason: "cash_line_without_cash_label" }); continue; }
      if (!l.cash && p.kind === "cash") { ignored.push({ messageId: r.messageId, name: l.name, reason: "cash_line_with_utr" }); continue; } // a Cash payment has no UTR
      // the NewBill / Advance word is OPTIONAL: the bill type comes from the bill itself; a word naming the OTHER type is still a problem
      if (p.billType && p.billType !== billType) { problems.push({ reason: "bill_type_mismatch", name: l.name }); continue; }
      let landlord;
      if (!p.landlord) {
        if (landlords.length !== 1) { problems.push({ reason: "unnamed_utr_line", name: l.name }); continue; }
        landlord = landlords[0];
      } else {
        const m = matchLandlord(p.landlord, landlords);
        if (m.error) { problems.push({ reason: m.error, name: l.name }); continue; }
        landlord = m.landlord;
      }
      const kind = p.kind || (gstHold && !r.billExplicit ? null : "rent");
      if (!kind) { ignored.push({ messageId: r.messageId, name: l.name, reason: "no_rent_or_gst_label" }); continue; }
      if (l.accountLast4 && landlord.accountLast4 && l.accountLast4 !== landlord.accountLast4) problems.push({ reason: "account_mismatch_in_reply", name: landlord.name });
      if (l.bank && landlord.bankName && !bankMatches(l.bank, landlord.bankName)) problems.push({ reason: "bank_mismatch_in_reply", name: landlord.name });
      const key = `${landlord.landOwnerId}|${kind}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ utr: l.utr, line: l, reply: r, landlord });
    }
  }
  return { byKey, problems, ignored };
}

/**
 * Landlord blocks of the ORIGINAL approval mail (HTML turned into text):
 *   "Owner Name | NAME | Phone | … | Bank Name | BANK | IFSC Code | … | Account No | 0123456789 | PAN Number | …"
 * -> [{ name, bank, accountLast4 }]  ([] when the mail has no such block)
 */
function parseApprovalMailLandlordsPlain(text) {
  // text/plain layout: "Owner Name new 1" / "Bank Name JF" / "Account No 5676..." on their own lines (New Bill / Advance mail)
  const out = [];
  let cur = null;
  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const o = line.match(/^Owner Name\s*[:|]?\s*(.+)$/i);
    if (o) { cur = { name: o[1].replace(/\s*\|.*$/, "").trim(), bank: "", accountLast4: null }; out.push(cur); continue; }
    if (/^LAND OWNER \d+/i.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const b = line.match(/^Bank Name\s*[:|]?\s*(.+)$/i);
    if (b && !cur.bank) cur.bank = b[1].replace(/\s*\|.*$/, "").trim();
    const a = line.match(/^Account No\.?\s*[:|]?\s*([0-9Xx*\- ]+)$/i);
    if (a && !cur.accountLast4) { const d = a[1].replace(/\D/g, ""); if (d.length >= 4) cur.accountLast4 = d.slice(-4); }
  }
  return out.filter((l) => l.name);
}

function parseApprovalMailLandlords(text) {
  const piped = parseApprovalMailLandlordsPiped(text);
  return piped.length ? piped : parseApprovalMailLandlordsPlain(text);
}

function parseApprovalMailLandlordsPiped(text) {
  const flat = String(text || "").replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ");
  const parts = flat.split(/Owner Name\s*\|/i).slice(1);
  return parts.map((p) => {
    const seg = p.split(/Media Details|LAND OWNER \d+/i)[0];
    const name = (seg.split("|")[0] || "").trim();
    const bank = (seg.match(/Bank Name\s*\|\s*([^|]*?)\s*\|/i) || [])[1] || "";
    const acc = (seg.match(/Account No\.?\s*\|\s*([0-9Xx*\- ]+?)\s*\|/i) || [])[1] || "";
    const digits = acc.replace(/\D/g, "");
    return { name, bank: bank.trim(), accountLast4: digits.length >= 4 ? digits.slice(-4) : null };
  }).filter((l) => l.name);
}

/** The approval mail must list every landlord of the bill with the same bank / account as RMS has. */
function validateAgainstMail(mailLandlords, landlords) {
  if (!mailLandlords || !mailLandlords.length) return { status: "n/a", problems: [] };
  const problems = [];
  for (const l of landlords) {
    const m = mailLandlords.find((x) => alnum(x.name) === alnum(l.name));
    if (!m) { problems.push({ reason: "not_listed_in_approval_mail", name: l.name }); continue; }
    if (l.accountLast4 && m.accountLast4 && l.accountLast4 !== m.accountLast4) problems.push({ reason: "account_mismatch_approval_mail", name: l.name });
    if (l.bankName && m.bank && !bankMatches(l.bankName, m.bank)) problems.push({ reason: "bank_mismatch_approval_mail", name: l.name });
  }
  return { status: problems.length ? "mismatch" : "ok", problems };
}

module.exports = { splitCashName, splitArrearsName, mapArrearsLines, splitNameKind, mapLandlordKinds, classifyPaymentLabel, mapPaymentKinds, nameTokens, matchLandlord, extractLandlordUtrLines, mapLandlords, parseApprovalMailLandlords, validateAgainstMail, replyExtras };
