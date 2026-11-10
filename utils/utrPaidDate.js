/**
 * Paid Date for an automatically matched UTR — PURE functions, no network, no database.
 *
 * The Ledger Entry screen asks for UTR Number + Paid Date; the date is sent to the ledger-save API as
 * "YYYY-MM-DD" (a calendar day) and stored in ledger[].date (Date). The screen's date picker only allows
 * days from the bill's CMD approval day up to today, so the same window is enforced here.
 *
 * Source of the date, in this order:
 *   1. email_payment_date  an explicit, LABELLED payment / transaction / transfer date in the reply that
 *                          states the UTR (e.g. "Payment Date: 05-11-2026"). Day-first (India) formats.
 *   2. email_sent_date     the Gmail "Date" header (when the sender sent the reply), as an India calendar day.
 *                          Never the time the API runs or the mail is fetched.
 * An explicit date that is in the future, after the reply was sent, before the approval day, or one of
 * several different dates in the reply is NOT used (it is listed in `rejected`) and the sent date is used.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * Calendar day of a timestamp the RMS stored with nowIST(): the server adds +5:30 BEFORE saving, so the stored UTC value
 * already reads as India wall-clock time (verified: ownerApprovalDate 2026-11-09T18:56Z for an approval at 13:26Z).
 * Its day is therefore the UTC date part — adding +5:30 again would push an evening approval to the next day.
 */
const rmsDay = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

/** India calendar day (YYYY-MM-DD) of a REAL instant (Gmail Date header, "now"). null for an invalid value. */
const istDay = (value) => {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_WORDS = new Set(["jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november", "dec", "december"]);

// Only dates that follow an explicit payment label count. A bare "Date:" is NOT a label (mail headers, bill dates, due dates).
const LABEL =
  "(?:(?:Payment|Paid|Transaction|Txn|Transfer|Transferred|Value|Credit|Credited|Remittance|Settlement)[ \\t]*(?:Date|Dt|On)|Date[ \\t]+of[ \\t]+(?:Payment|Transaction|Txn|Transfer|Credit)|Paid[ \\t]+on|Transferred[ \\t]+on|Credited[ \\t]+on|Payment[ \\t]+made[ \\t]+on)";
const DATE =
  "(?:(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{4}|\\d{2})|(\\d{1,2})(?:st|nd|rd|th)?[ \\t\\-]*([A-Za-z]{3,9})[ \\t,\\-]*(\\d{4}|\\d{2})|([A-Za-z]{3,9})[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?,?[ \\t]+(\\d{4}))";
const LABELLED_DATE = new RegExp(`(?<![A-Za-z])(${LABEL})(?![A-Za-z])[ \\t]*[:=\\-–—]*[ \\t]*${DATE}(?![\\d])`, "gi");

const realDay = (y, m, d) => {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // rejects 31-02-2026
  return dt.toISOString().slice(0, 10);
};
const fullYear = (s) => (s.length === 2 ? 2000 + Number(s) : Number(s));
const monthNo = (w) => (MONTH_WORDS.has(w.toLowerCase()) ? MONTHS[w.slice(0, 3).toLowerCase()] : null);

/** Labelled payment dates in one text: [{ date: "YYYY-MM-DD", label, raw }] (distinct, document order). Never guesses mm/dd. */
function extractExplicitPaymentDates(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(LABELLED_DATE)) {
    let day = null;
    if (m[2]) day = realDay(Number(m[2]), Number(m[3]), Number(m[4]));
    else if (m[5]) day = realDay(fullYear(m[7]), Number(m[6]), Number(m[5])); // DD/MM/YYYY (India): month > 12 is rejected, not swapped
    else if (m[8]) { const mo = monthNo(m[9]); day = mo ? realDay(fullYear(m[10]), mo, Number(m[8])) : null; }
    else if (m[11]) { const mo = monthNo(m[11]); day = mo ? realDay(Number(m[13]), mo, Number(m[12])) : null; }
    if (!day || seen.has(day)) continue;
    seen.add(day);
    out.push({ date: day, label: m[1].replace(/\s+/g, " ").trim(), raw: m[0].trim() });
  }
  return out;
}

/**
 * info: { explicitDates: [{ date }], sentDate: "YYYY-MM-DD" }   (from the Gmail lookup)
 * ctx : { approvalDate, now }  approvalDate = rentalDue.ownerApprovalDate AS STORED (IST wall-clock kept as UTC; the UI
 *         minimum), now = real ms
 * -> { date, source, sentDate, explicitDates, rejected: [{ date, reason }], note }  (date null = undeterminable)
 */
function resolvePaidDate(info = {}, ctx = {}) {
  const today = istDay(ctx.now ?? Date.now());
  const approvalDay = ctx.approvalDate ? rmsDay(ctx.approvalDate) : null; // stored with nowIST(): see rmsDay
  const sentDate = info.sentDate || null;
  const inWindow = (day) => day <= today && (!approvalDay || day >= approvalDay);

  const rejected = [];
  const usable = [];
  for (const e of info.explicitDates || []) {
    const day = e.date;
    let reason = null;
    if (day > today) reason = "in_the_future";
    else if (sentDate && day > sentDate) reason = "after_email_sent_date";
    else if (approvalDay && day < approvalDay) reason = "before_approval_date";
    if (reason) rejected.push({ date: day, reason });
    else usable.push(day);
  }
  const distinct = [...new Set(usable)];
  const explicitDates = distinct;

  if (distinct.length === 1) {
    return { date: distinct[0], source: "email_payment_date", sentDate, explicitDates, rejected, note: "Payment date stated in the email." };
  }
  let note = "";
  if (distinct.length > 1) {
    note = "The reply states several different payment dates; the email sent date is used.";
    distinct.forEach((d) => rejected.push({ date: d, reason: "multiple_payment_dates_in_reply" }));
  } else if (rejected.length) note = "The payment date in the email is not usable; the email sent date is used.";
  else note = "No payment date in the email; the email sent date is used.";

  if (sentDate && inWindow(sentDate)) {
    return { date: sentDate, source: "email_sent_date", sentDate, explicitDates: [], rejected, note: `${note} Check the Paid Date in Ledger Entry and correct it if the money moved on another day.` };
  }
  return { date: null, source: null, sentDate, explicitDates: [], rejected, note: sentDate ? "The email sent date is outside the allowed window (approval day .. today)." : "The email has no usable sent date." };
}

module.exports = { istDay, rmsDay, extractExplicitPaymentDates, resolvePaidDate };
