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

  const expected = expectedReplyLines(media, rows);
  const notes = expected.notes;
  let correct = expected.replyLines;
  // ✅ NEW — part saved: say what is saved and ask only for the lines still pending
  const pending = Array.isArray(log.partialPending) ? log.partialPending : [];
  if (pending.length) {
    const label = (p) => `${p.landlord ? `${p.landlord} – ` : ""}${p.kind === "gst" ? "GST" : "Rent"}`;
    if ((log.partialSaved || []).length) lines.push(`*Already saved:* ${log.partialSaved.map(label).join(", ")}`);
    lines.push(`*Still pending:* ${pending.map(label).join(", ")}`);
    const wanted = correct.filter((l) => pending.some((p) => /- GST - UTR/.test(l) === (p.kind === "gst") && (!p.landlord || l.startsWith(p.landlord))));
    if (wanted.length) correct = wanted;
  }
  lines.push("");
  lines.push("*Reply like this* (copy, put the real UTR, one line per landlord):");
  correct.forEach((l) => lines.push(l)); // ✅ CHANGED — plain lines (a ``` code box shows Chat's wrap icon)
  notes.forEach((n) => lines.push(n));

  lines.push("");
  const who = log.senderEmail || "";
  const when = istDateTime(log.messageDate);
  if (who || when) lines.push(`*Replied by:* ${[who, when].filter(Boolean).join(" – ")}`);
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
    // deps.resend (old-errors API with resend:true) skips this check
    if (Model && !deps.resend) {
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
    if (typeof deps.onFail === "function") deps.onFail(err.response?.status ? String(err.response.status) : err.message);
    return false;
  }
}

/** ✅ NEW — the UTR error space can be used: URL set and GOOGLE_CHAT not off. */
const isUtrErrorChatReady = () => !!String(process.env.UTR_ERROR_CHAT_URL || "").trim() && isChatOn();

// bills that still wait for a UTR (Rental Bill + New Bill / Advance); a bill paid since the error is not posted
async function stillPendingBills(billNumbers) {
  const { getPendingUtrBills } = require("./pendingUtrBills");
  const { getPendingArrearsUtrBills } = require("./pendingArrearsUtrBills");
  const opts = { billNumbers, limit: 100000 };
  const [rental, arrears] = await Promise.all([getPendingUtrBills(opts), getPendingArrearsUtrBills(opts)]);
  return new Set([...(rental.bills || []), ...(arrears.bills || [])].map((b) => String(b.billNumber)));
}

async function mediaCodesOf(mediaIds) {
  const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const ids = [...new Set(mediaIds.filter(Boolean))];
  const docs = ids.length ? await Media.find({ _id: { $in: ids } }).select("mediaDetails").lean() : [];
  const map = new Map();
  docs.forEach((m) => {
    const faces = (m.mediaDetails || []).filter((f) => Number(f.status) === 1);
    map.set(String(m._id), faces.map((f) => f.mediaCode).filter(Boolean).join(", "));
  });
  return map;
}

/**
 * ✅ NEW — OLD wrong Finance replies → UTR error space (POST /api/gmail/utr-errors/notify-chat).
 * The cron catch-up only covers the last 48 hours; this posts older errors on demand.
 *   opts: { dryRun = true, from, to (YYYY-MM-DD, India date of the error log), billNumbers = [], resend = false, limit = 20 (max 50) }
 * Per bill only its NEWEST log is used, and only when that newest log is still a Finance-fixable error
 * (a later save / other result → skipped) and the bill still waits for a UTR (paid since → skipped).
 * Messages go one by one with a gap (Google Chat allows ~1 message / second per space).
 * deps (tests): { Log, notify, stillPending(billNumbers) -> Set, mediaCodes(ids) -> Map, gapMs }
 */
async function notifyOldUtrErrors(opts = {}, deps = {}) {
  const dryRun = opts.dryRun !== false;
  const resend = opts.resend === true;
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
  const billNumbers = (Array.isArray(opts.billNumbers) ? opts.billNumbers : []).map((b) => String(b).trim()).filter(Boolean);
  const Log = deps.Log || require("../models/Admin/GmailUtrLogSchema");
  const notify = deps.notify || notifyUtrErrorChat;
  const pendingOf = deps.stillPending || stillPendingBills;
  const codesOf = deps.mediaCodes || mediaCodesOf;
  const gapMs = deps.gapMs ?? 1100;
  let explain = (c) => c;
  try {
    explain = require("./utrTracker").explain || explain;
  } catch (err) {
    /* keep the code */
  }

  const q = { dryRun: false, reason: new RegExp(`^(${[...USER_ERRORS].join("|")})(?![A-Za-z0-9_])`) };
  if (opts.from || opts.to) {
    q.createdAt = {};
    if (opts.from) q.createdAt.$gte = new Date(`${opts.from}T00:00:00.000+05:30`);
    if (opts.to) q.createdAt.$lte = new Date(`${opts.to}T23:59:59.999+05:30`);
  }
  if (billNumbers.length) q.billNumber = { $in: billNumbers };

  // newest error log of each bill inside the range
  const errorLogs = await Log.find(q).sort({ createdAt: -1 }).limit(5000);
  const newestError = new Map();
  for (const doc of errorLogs) if (!newestError.has(doc.billNumber)) newestError.set(doc.billNumber, doc);

  const bills = [];
  const candidates = [];
  for (const [billNumber, doc] of newestError) {
    const log = typeof doc.toObject === "function" ? doc.toObject() : doc;
    const code = reasonCode(log.reason);
    const item = {
      billNumber,
      mediaId: log.mediaId || "",
      siteCode: "",
      dueMonth: log.dueMonth || "",
      billKind: log.billKind || "",
      reason: code,
      explanation: explain(code),
      replyLines: log.replyLines || [],
      repliedBy: log.senderEmail || "",
      repliedAt: istDateTime(log.messageDate),
      loggedAt: istDateTime(log.createdAt),
      chatNotifiedAt: log.chatNotifiedAt ? istDateTime(log.chatNotifiedAt) : null,
      status: "",
    };
    bills.push(item);
    const newest = await Log.findOne({ billNumber, dryRun: false }).sort({ createdAt: -1 }).select("_id status reason").lean();
    if (newest && String(newest._id) !== String(log._id)) {
      item.status = "skipped_newer_result";
      item.newerResult = { status: newest.status, reason: newest.reason || "" };
    } else if (log.chatNotifiedAt && !resend) {
      item.status = "skipped_already_sent";
    } else {
      candidates.push({ item, doc });
    }
  }

  // bills paid since the error (manual UTR entry etc.) are not posted
  const pending = candidates.length ? await pendingOf(candidates.map((c) => c.item.billNumber)) : new Set();
  const toSend = [];
  for (const c of candidates) {
    if (!pending.has(c.item.billNumber)) c.item.status = "skipped_already_paid";
    else if (toSend.length >= limit) c.item.status = "over_limit";
    else {
      c.item.status = "will_send";
      toSend.push(c);
    }
  }

  try {
    const codes = await codesOf(bills.map((b) => b.mediaId));
    bills.forEach((b) => (b.siteCode = codes.get(String(b.mediaId)) || ""));
  } catch (err) {
    /* site code is display only */
  }

  if (!dryRun) {
    for (let i = 0; i < toSend.length; i += 1) {
      const { item, doc } = toSend[i];
      let failReason = "";
      const ok = await notify(doc, { resend, onFail: (r) => (failReason = r) });
      if (ok) item.status = "sent";
      else if (failReason) {
        item.status = "failed";
        item.error = failReason;
      } else item.status = "skipped_already_sent"; // the same reply was already posted from another log row
      if (i < toSend.length - 1 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  const count = (s) => bills.filter((b) => b.status === s).length;
  bills.forEach((b) => delete b.mediaId);
  return {
    dryRun,
    range: { from: opts.from || null, to: opts.to || null },
    totalErrorBills: bills.length,
    willSend: toSend.length,
    sent: count("sent"),
    failed: count("failed"),
    overLimit: count("over_limit"),
    skipped: {
      alreadySent: count("skipped_already_sent"),
      newerResult: count("skipped_newer_result"),
      alreadyPaid: count("skipped_already_paid"),
    },
    bills,
  };
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

module.exports = { notifyUtrErrorChat, notifyPendingUtrErrors, notifyOldUtrErrors, isUtrErrorChatReady, buildUtrErrorMessage, expectedReplyLines, isUserError, USER_ERRORS };
