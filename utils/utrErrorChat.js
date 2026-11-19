// ─────────────────────────────────────────────────────────────
// UTR ERROR → GOOGLE CHAT
// When the Gmail UTR processor logs a Finance reply that is WRONG (bad UTR,
// landlord name not found, missing line …) a message is posted to the
// Google Chat space of UTR_ERROR_CHAT_URL (.env) so Finance can correct it.
//
//  • Only errors Finance can fix (USER_ERRORS below). System-side problems
//    (gmail / database errors, switches off, registry, no reply yet) are not sent.
//  • ONE message per bill + error + reply mail: a later run that logs the same
//    error for the same reply is not sent again (gmail_utr_logs.chatNotifiedAt).
//  • GOOGLE_CHAT=off (master switch) or UTR_ERROR_CHAT_URL not set → nothing sent.
//  • Never throws and is not awaited by the processor: a chat failure never
//    affects the UTR run. Dry runs write no log, so they send nothing.
// ─────────────────────────────────────────────────────────────
const axios = require("axios");

const USER_ERRORS = new Set([
  "invalid_utr",
  "duplicate_utr",
  "utr_already_used_on_this_site",
  "paid_date_not_determined",
  "landlord_name_not_found",
  "landlord_name_ambiguous",
  "landlord_name_too_short",
  "unnamed_utr_line",
  "no_rent_or_gst_label",
  "no_bill_type_label",
  "bill_type_mismatch",
  "missing_landlord_utr",
  "missing_landlord_cash_line",
  "conflicting_utr_for_landlord",
  "conflicting_utr_for_kind",
  "conflicting_utr_for_landlord_payment",
  "conflicting_cash_paid_date",
  "utrs_in_multiple_replies",
  "reply_not_linked_to_approval_mail",
  "account_mismatch_in_reply",
  "bank_mismatch_in_reply",
  "gst_separate_utr",
  "names_match_no_landlord_of_this_bill",
  "cash_line_not_for_this_landlord",
  "cash_line_not_for_rent",
  "correction_mail_states_two_utrs",
]);

const isChatOn = () =>
  !["off", "false", "0", "no"].includes(String(process.env.GOOGLE_CHAT || "on").trim().toLowerCase());

const IST_OFFSET_MS = 330 * 60000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// a real (UTC) time → "19 Nov 2026, 10:38 AM" IST
const istDateTime = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  if (Number.isNaN(t)) return "";
  const x = new Date(t + IST_OFFSET_MS);
  const h = x.getUTCHours();
  return `${String(x.getUTCDate()).padStart(2, "0")} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}, ${String(h % 12 || 12).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const linesKey = (lines) => [...new Set((lines || []).map(String))].sort().join("\n");
const reasonCode = (reason) => String(reason || "").trim().split(/[\s:]/)[0];

/** Should this log row be posted? */
const isUserError = (log) => !!log && !log.dryRun && USER_ERRORS.has(reasonCode(log.reason));

/**
 * ✅ NEW — the exact reply lines for THIS bill (same format the UTR processor reads, utrTracker.replyFormat):
 *   Online landlord          → "<full name> - UTR : <UTR number>"
 *   + GST hold bill          → "<full name> - GST - UTR : <UTR number>"
 *   Cash landlord            → no line (note: Paid Date = Finance's "Approved thro bank" mail date)
 *   Cash + Online landlord   → the Online line only (Cash part is automatic)
 */
function expectedReplyLines(media, rows) {
  const owners = (media && media.landOwners) || [];
  const hold = (rows || []).some((r) => Number(r.withGst) === 1 && Number(r.gstAmount || 0) > 0);
  const replyLines = [];
  const notes = [];
  owners.forEach((o) => {
    const name = String(o.name || "").trim() || "<Landlord name>";
    const cat = Number(o.paymentCategory || 2);
    if (cat === 1) {
      notes.push(`Note: ${name} (Cash): no line needed – Paid Date = date of Finance's "Approved thro bank" mail. Different date only: ${name} - Cash - Paid Date: 08-Nov-2026`);
      return;
    }
    replyLines.push(`${name} - UTR : <UTR number>`);
    const ownerGst = owners.length === 1 || Number(o.gstApplicable) === 1 || Number(o.gstAmount || 0) > 0;
    if (hold && ownerGst) replyLines.push(`${name} - GST - UTR : <UTR number>`);
    if (cat === 3) notes.push(`Note: ${name}: Cash part is automatic – write only the UTR line.`);
  });
  if (!replyLines.length && !notes.length) replyLines.push("<Landlord full name> - UTR : <UTR number>");
  return { replyLines, notes };
}

/** The chat text for one error log row. `media` (lean, optional) adds site / landlords / amount. */
function buildUtrErrorMessage(log, media = null) {
  let explain = (c) => c;
  try {
    explain = require("./utrTracker").explain || explain; // lazy: avoids loading the tracker at startup
  } catch (err) {
    /* keep the code */
  }
  const code = reasonCode(log.reason);
  const lines = ["*UTR Reply Error – Correction needed*", ""];
  lines.push(`*Bill No:* ${log.billNumber}`);

  if (media) {
    const faces = (media.mediaDetails || []).filter((f) => Number(f.status) === 1);
    const codes = faces.map((f) => f.mediaCode).filter(Boolean).join(", ");
    const name = faces.map((f) => f.mediaName).filter(Boolean)[0] || "";
    const city = [...new Set(faces.map((f) => f.city).filter(Boolean))].join(", ");
    lines.push(`*Site:* ${codes || "-"}${name ? ` – ${name}` : ""}${city ? ` (${city})` : ""}`);
  }
  if (log.dueMonth) lines.push(`*Bill Month:* ${log.dueMonth}${log.billKind ? ` (${log.billKind === "newBill" ? "New Bill" : log.billKind === "advance" ? "Advance" : log.billKind})` : ""}`);

  const ids = new Set((log.rentalDueIds || []).map(String));
  const rows = media ? [...(media.rentalDue || []), ...(media.arrearsDue || [])].filter((r) => r && ids.has(String(r._id))) : [];
  if (media) {
    const amount = rows.reduce((s, r) => s + Number(r.netPayable || 0), 0);
    const owners = (media.landOwners || []).map((o) => `${o.name || "-"}${o.paymentCategory ? ` (${Number(o.paymentCategory) === 1 ? "Cash" : Number(o.paymentCategory) === 3 ? "Cash + Online" : "Online"})` : ""}`);
    if (owners.length) lines.push(`*Landlord(s):* ${owners.join(", ")}`);
    if (amount > 0) lines.push(`*Bill Amount:* ${inr(amount)}`);
  }
  const corrLandlord = log.correction && (log.correction.landlord || "");
  if (corrLandlord) lines.push(`*Landlord in reply:* ${corrLandlord}`);

  // ✅ CHANGED — "You wrote" (Finance's lines) next to "Reply like this" (the exact lines for THIS bill)
  lines.push("");
  const replyLines = Array.isArray(log.replyLines) ? log.replyLines.filter(Boolean).slice(0, 6) : [];
  if (replyLines.length) {
    lines.push("*You wrote:*");
    replyLines.forEach((l) => lines.push(`• ${l}`));
  } else if (log.utr) lines.push(`*UTR in reply:* ${log.utr}`);
  lines.push(`*Error:* ${explain(code)}  (${code})`);

  const { replyLines: correct, notes } = expectedReplyLines(media, rows);
  lines.push("");
  lines.push("*Reply like this* (copy, put the real UTR, one line per landlord):");
  correct.forEach((l) => lines.push(l)); // ✅ CHANGED — plain lines (a ``` code box shows Chat's wrap icon)
  notes.forEach((n) => lines.push(n));

  lines.push("");
  const who = log.senderEmail || "";
  const when = istDateTime(log.messageDate);
  if (who || when) lines.push(`*Replied by:* ${[who, when].filter(Boolean).join(" – ")}`);
  if (log.gmailThreadId) lines.push(`*Mail:* https://mail.google.com/mail/u/0/#all/${log.gmailThreadId}`);
  lines.push("");
  lines.push("Reply again in the SAME mail thread with the corrected line.");
  return lines.join("\n");
}

/**
 * Post one error log row (a gmail_utr_logs document) to the UTR error space.
 * deps (tests): { post(url, body), findMedia(id) }. Returns true when sent.
 */
async function notifyUtrErrorChat(logDoc, deps = {}) {
  try {
    const url = String(process.env.UTR_ERROR_CHAT_URL || "").trim();
    if (!url || !isChatOn()) return false;
    const log = logDoc && typeof logDoc.toObject === "function" ? logDoc.toObject() : logDoc;
    if (!isUserError(log)) return false;

    // one message per bill + error + reply mail (no reply id → per bill + error)
    const Model = logDoc && logDoc.constructor && typeof logDoc.constructor.find === "function" ? logDoc.constructor : null;
    if (Model) {
      const q = { billNumber: log.billNumber, reason: log.reason, chatNotifiedAt: { $ne: null }, _id: { $ne: log._id } };
      if (log.sourceMessageId) q.sourceMessageId = log.sourceMessageId;
      const hits = await Model.find(q).select("replyLines").lean();
      // ✅ CHANGED — no reply id: a NEW (still wrong) reply = other lines -> posted again; the same lines -> not
      const key = linesKey(log.replyLines);
      if ((hits || []).some((h) => log.sourceMessageId || linesKey(h.replyLines) === key)) return false;
    }

    let media = null;
    try {
      if (deps.findMedia) media = await deps.findMedia(log.mediaId);
      else if (log.mediaId) {
        const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
        media = await Media.findById(log.mediaId).select("mediaDetails landOwners rentalDue arrearsDue").lean();
      }
    } catch (err) {
      media = null; // message still goes out without the site details
    }

    const text = buildUtrErrorMessage(log, media);
    const post = deps.post || ((u, body) => axios.post(u, body, { timeout: 10000, headers: { "Content-Type": "application/json; charset=UTF-8" } }));
    await post(url, { text });
    if (Model && log._id) await Model.updateOne({ _id: log._id }, { $set: { chatNotifiedAt: new Date() } });
    return true;
  } catch (err) {
    console.error("[utr-error-chat] not sent:", err.message); // never the URL (it holds the key / token)
    return false;
  }
}

/**
 * ✅ NEW — catch-up: error logs of the last UTR_ERROR_CHAT_CATCHUP_HOURS (default 48) that were never posted
 * (chatNotifiedAt null, e.g. written while GOOGLE_CHAT was off) are posted now. Only the NEWEST log of a bill is
 * considered (a bill saved / re-checked since then is never posted with an old error). Called after every live
 * UTR run; never throws. deps (tests): { Log, notify }. Returns how many were sent.
 */
async function notifyPendingUtrErrors(deps = {}) {
  try {
    if (!String(process.env.UTR_ERROR_CHAT_URL || "").trim() || !isChatOn()) return 0;
    const Log = deps.Log || require("../models/Admin/GmailUtrLogSchema");
    const notify = deps.notify || notifyUtrErrorChat;
    const hours = Number(process.env.UTR_ERROR_CHAT_CATCHUP_HOURS);
    const since = new Date(Date.now() - (Number.isFinite(hours) && hours > 0 ? hours : 48) * 3600000);
    const codes = new RegExp(`^(${[...USER_ERRORS].join("|")})(?![A-Za-z0-9_])`);
    const q = { dryRun: false, createdAt: { $gte: since }, chatNotifiedAt: null, reason: codes };
    if (deps.excludeRunId) q.runId = { $ne: deps.excludeRunId }; // this run's own logs are posted by writeLog (no double post)
    const unsent = await Log.find(q)
      .sort({ createdAt: -1 })
      .limit(50);
    let sent = 0;
    const seenBills = new Set();
    for (const doc of unsent) {
      if (seenBills.has(doc.billNumber)) continue; // older unsent rows of the same bill: the newest one stands for them
      seenBills.add(doc.billNumber);
      const newest = await Log.findOne({ billNumber: doc.billNumber, dryRun: false }).sort({ createdAt: -1 }).select("_id").lean();
      if (!newest || String(newest._id) !== String(doc._id)) continue; // bill moved on since this error
      if (await notify(doc)) sent += 1;
      if (sent >= 20) break;
    }
    return sent;
  } catch (err) {
    console.error("[utr-error-chat] catch-up skipped:", err.message);
    return 0;
  }
}

module.exports = { notifyUtrErrorChat, notifyPendingUtrErrors, buildUtrErrorMessage, expectedReplyLines, isUserError, USER_ERRORS };
