/**
 * Automatic UTR processing: pending Bill Number -> Gmail -> UTR -> existing ledger-save logic.
 *
 * Safety rules (never save an uncertain UTR):
 *   - only bills the pending query marks mappingSafe (1 bill = 1 landlord = 1 open Online rent payment, no
 *     GST-on-hold) are looked up and saved; everything else is reported as ambiguous_mapping;
 *   - Cash payments are searched in Gmail like Online rent (dry run included). A Cash row does not exist until
 *     it is saved and a saved Cash row IS the payment, so actual Cash saving needs its own switch
 *     GMAIL_UTR_CASH_SAVE_ENABLED=true on top of GMAIL_UTR_SAVE_ENABLED; otherwise it stays manual;
 *   - GST payments are manual review for now (no way yet to tell a GST UTR from a rent UTR in a thread);
 *   - Gmail must answer `found` (exactly one UTR, one conversation, no other Bill Numbers);
 *   - the UTR must look like a UTR and must not already be used on that site;
 *   - the bill is re-read from MongoDB and must still be pending and still mappingSafe right before saving;
 *   - saving goes through the existing executeBulkPaymentBatch (the manual ledger-save engine), so
 *     ledger / ledgerHistory / GST / overdue-sync behave exactly as for a manual save;
 *   - dry run is the default: nothing is written unless dryRun:false AND GMAIL_UTR_SAVE_ENABLED=true.
 *
 * One run at a time across all server instances: a lock document in the existing `counters` collection.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getPendingUtrBills, evaluateGroup, billField, isValidBill } = require("./pendingUtrBills");
const { lookupUtrByBillNumber, lookupLandlordUtrs, lookupBillThread } = require("./gmailUtrLookup");
const { storedPayments, utrStatements, planCorrections, buildCorrectionWrite } = require("./utrCorrection");
const { getPendingArrearsUtrBills, evaluateArrearsGroup } = require("./pendingArrearsUtrBills");
const { narrationFor } = require("./bankNarration");
const { senderName } = require("./senderName");
// the Finance reply a payment was read from -> its sender name (ledger updatedBy)
const actorOf = (d, messageId) => { const r = [...(d.replies || []), ...(d.cashReplies || [])].find((x) => x.messageId === messageId); return senderName(r ? r.from : d.senderEmail); };
const { splitCashName, splitNameKind, classifyPaymentLabel, mapLandlords, mapLandlordKinds, mapArrearsLines, mapPaymentKinds, validateAgainstMail, matchLandlord } = require("./landlordUtrParser");
const { resolvePaidDate } = require("./utrPaidDate");
/**
 * CASH-ONLY landlords need no "Cash" line any more: Finance's "Approved through this bank" mail of the bill's chain is the approval and
 * its Gmail Date is the Paid Date. For every named Cash-only landlord WITHOUT an explicit Cash line of its own, a "<name> - Cash" line is
 * added to d.cashReplies (dated by that mail), so every flow below reads it exactly like a typed Cash line. An explicit Cash line wins.
 * Normally there is ONE such mail; if there are several, the LAST one (latest Gmail Date) is used.
 */
function addBankApprovedCash(d, names) {
  const ab = d.approvedBank || [];
  if (!ab.length || !names.length) return;
  const first = [...ab].sort((x, y) => new Date(y.sentAt).getTime() - new Date(x.sentAt).getTime())[0]; // the LAST "Approved through this bank" mail
  const lines = [];
  for (const name of [...new Set(names)]) {
    const me = [{ landOwnerId: "x", name }];
    const typed = (d.cashReplies || []).some((r) => (r.cashLines || []).some((cl) => {
      const sc = splitCashName(cl.name); if (!sc) return false;
      const kn = splitNameKind(sc.landlord, me);
      if (kn.kind === "gst") return false;
      return !kn.landlord || !matchLandlord(kn.landlord, me).error;
    }));
    if (!typed) lines.push({ name: `${name} - Cash`, utr: "", cash: true, dates: [], line: "(Approved through this bank)", fromBankApproval: true });
  }
  if (lines.length) d.cashReplies = [...(d.cashReplies || []), { messageId: first.messageId, from: first.from, sentAt: first.sentAt, sentDate: first.sentDate, cashLines: lines }];
}

const LOCK_ID = "gmail_utr_lock";

// ambiguous_mapping reasons that are decided without reading Gmail (list rules + switches)
const BLOCKED_BEFORE_GMAIL = new Set([
  "duplicate_bill_number", "media_inactive", "multiple_landlords", "separate_landlord_bills", "gst_separate_utr",
  "rows_in_different_months", "separate_bill_site_rows", "no_rent_payment_pending", "no_single_rent_slot",
  "landlord_with_two_open_payments", "mapping_not_safe", "multi_landlord_auto_save_disabled", "cash_auto_save_disabled",
  "gst_split_auto_save_disabled", "no_gst_row", "multiple_gst_rows",
  "multiple_arrears_bills", "bill_kind_mixed", "no_landlord_on_bill",
]);

// One run at a time inside this process (dry or live). A LIVE run additionally takes the cross-instance DB lock;
// a DRY run writes nothing to MongoDB at all (no lock row, no log row).
let activeRun = false;

const idStrOf = (v) => (v === null || v === undefined ? "" : String(v));
const maskUtr = (u) => (u ? String(u).slice(0, 4) + "***" + String(u).slice(-3) : u);

/** One JSON line per run: logs/gmail-utr-runs.jsonl (or GMAIL_UTR_RUN_LOG_FILE). Never throws. */
function writeRunLog(summary) {
  try {
    const file = process.env.GMAIL_UTR_RUN_LOG_FILE || path.join(__dirname, "..", "logs", "gmail-utr-runs.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(summary) + "\n");
  } catch (err) {
    console.error("[gmail-utr] could not write run log file:", err.message);
  }
}

/** The run summary that goes to the log file: matched bills (UTR, Paid Date), skipped bills, errors. */
function buildRunSummary({ ctx, startedAt, started, scope, pendingTotal, results, aborted, skipped, reason, error, corrections }) {
  const finished = Date.now();
  const base = { runId: ctx.runId, mode: ctx.dryRun ? "dry-run" : "live", triggeredBy: ctx.triggeredBy, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started };
  if (skipped) return { ...base, skipped: true, reason };
  if (error) return { ...base, error };
  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  return {
    ...base,
    scope,
    pendingTotal,
    processed: results.length,
    counts,
    blockedBeforeGmail: results.filter((r) => r.preGmail).reduce((a, r) => ((a[r.reason] = (a[r.reason] || 0) + 1), a), {}),
    aborted: aborted || null,
    ...(corrections && corrections.length ? { corrections: corrections.map((x) => ({ billNumber: x.billNumber, status: x.status, reason: x.reason || "", landlord: x.landlord || "", paymentKind: x.paymentKind || "", existingUtr: maskUtr(x.existingUtr), correctedUtr: maskUtr(x.correctedUtr), eligible: x.eligible ?? null, gmailThreadId: x.gmailThreadId || "", sourceMessageId: x.sourceMessageId || "" })) } : {}),
    matchedBills: results.filter((r) => r.utr || r.landlordMappings || r.splitPayments).map((r) => ({
      billNumber: r.billNumber, dueMonth: r.dueMonth || "", status: r.status, reason: r.reason || "", utr: r.utr, paidDate: r.paidDate || null, paidDateSource: r.paidDateSource || null,
      paymentType: r.paymentType || null, eligibleForSaving: r.eligibleForSaving ?? null, savingBlockedBy: r.savingBlockedBy || [], gmailThreadId: r.gmailThreadId || "", landlordMappings: r.landlordMappings || undefined, splitPayments: r.splitPayments || undefined,
    })),
    skippedBills: results.filter((r) => !r.utr && !r.landlordMappings && !r.splitPayments).map((r) => ({ billNumber: r.billNumber, dueMonth: r.dueMonth || "", status: r.status, reason: r.reason || "" })),
    errors: results.filter((r) => r.status === "gmail_error" || r.status === "database_error").map((r) => ({ billNumber: r.billNumber, dueMonth: r.dueMonth || "", status: r.status, reason: r.reason || "" })),
  };
}
const UTR_SHAPE = /^[A-Za-z0-9]{3,30}$/;

/**
 * Bank Narration of the Finance "Payment Uploaded" table -> p.narration (saved as the ledger remark instead of the static text).
 * Only what is certain: one landlord = the thread's one narration; several landlords = a row that names the landlord (account / name).
 * When nothing is certain p.narration stays "" (the default remark is kept) and p.narrationNote says why.
 */
function attachNarration(plan, d, landlords) {
  const idOf = (p) => (p.slot ? p.slot.landOwnerId : p.slots && p.slots[0] ? p.slots[0].landOwnerId : "");
  const count = new Map();
  plan.forEach((p) => count.set(idOf(p), (count.get(idOf(p)) || 0) + 1));
  for (const p of plan) {
    if (p.companion) { p.narration = ""; continue; } // Cash part of a Cash + Online pair: no bank narration
    const n = narrationFor(d.bankRows || [], landlords || [], { landOwnerId: idOf(p), amount: p.amount ?? p.gstAmount ?? p.rentAmount ?? null, siblings: count.get(idOf(p)) });
    p.narration = n.narration;
    if (!n.narration && n.reason && n.reason !== "no_narration_in_thread") p.narrationNote = n.reason;
  }
}

const saveEnabled = () => String(process.env.GMAIL_UTR_SAVE_ENABLED || "").toLowerCase() === "true";
const gstSaveEnabledEnv = () => String(process.env.GMAIL_UTR_GST_SAVE_ENABLED || "").toLowerCase() === "true";
const multiSaveEnabledEnv = () => String(process.env.GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED || "").toLowerCase() === "true";
const cashSaveEnabledEnv = () => String(process.env.GMAIL_UTR_CASH_SAVE_ENABLED || "").toLowerCase() === "true";
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const cfg = () => ({
  maxBills: num(process.env.GMAIL_UTR_MAX_BILLS_PER_RUN, 50),
  notFoundCooldownMs: num(process.env.GMAIL_UTR_NOT_FOUND_COOLDOWN_MIN, 30) * 60000,
  reviewCooldownMs: num(process.env.GMAIL_UTR_REVIEW_COOLDOWN_MIN, 360) * 60000,
  gmailTimeoutMs: num(process.env.GMAIL_UTR_GMAIL_TIMEOUT_MS, 30000),
  runBudgetMs: num(process.env.GMAIL_UTR_RUN_BUDGET_MS, 8 * 60000),
  lockTtlMs: num(process.env.GMAIL_UTR_LOCK_TTL_MIN, 15) * 60000,
  // Retry policy. A bill whose approval mail EXISTS in Gmail (utr_not_found) is waiting for Finance's reply: it is re-read on EVERY run
  // (0 = no wait; GMAIL_UTR_THREAD_RETRY_SEC can throttle it) so a new reply is found in the next cron run. A bill whose approval mail
  // is NOT in Gmail (bill_not_found) backs off with the age of the bill: every run for a freshly approved one (mail delay / indexing),
  // GMAIL_UTR_NOT_FOUND_COOLDOWN_MIN up to 6 hours, GMAIL_UTR_OLD_NOT_FOUND_COOLDOWN_MIN after that. A reply that could not be matched
  // (ambiguous) is re-read after GMAIL_UTR_REVIEW_RETRY_SEC because Finance corrects within minutes.
  threadRetryMs: num(process.env.GMAIL_UTR_THREAD_RETRY_SEC, 0) * 1000,
  newBillWindowMs: num(process.env.GMAIL_UTR_NEW_BILL_WINDOW_MIN, 30) * 60000,
  oldNotFoundMs: num(process.env.GMAIL_UTR_OLD_NOT_FOUND_COOLDOWN_MIN, 60) * 60000,
  reviewRetryMs: num(process.env.GMAIL_UTR_REVIEW_RETRY_SEC, 60) * 1000,
});

// age of a bill since its CMD approval (ownerApprovalDate is stored as IST wall-clock in a UTC field); Infinity when unknown
const billAgeMs = (item) => {
  const t = item && item.approvalDate ? new Date(item.approvalDate).getTime() - 330 * 60000 : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity;
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms} ms`), { status: 504 })), ms).unref?.()),
  ]);

/** Atomic lock: true if this run owns it. Expired locks are taken over. */
async function acquireLock(Counter, ttlMs, now = Date.now()) {
  const taken = await Counter.findOneAndUpdate(
    { _id: LOCK_ID, seq: { $lt: now } },
    { $set: { seq: now + ttlMs } },
    { returnDocument: "after" },
  ).lean();
  if (taken) return true;
  try {
    await Counter.create({ _id: LOCK_ID, seq: now + ttlMs });
    return true;
  } catch (err) {
    if (err && (err.code === 11000 || err.code === 11001)) return false;
    throw err;
  }
}
const releaseLock = (Counter) => Counter.updateOne({ _id: LOCK_ID }, { $set: { seq: 0 } });

const istDate = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
};

/** Is this UTR already stored anywhere on the site (ledger, history, GST, outstanding)? */
function utrAlreadyUsed(media, utr, opts = {}) {
  const same = (v) => String(v || "").trim().toLowerCase() === utr.toLowerCase();
  // ONE UTR listed by Finance for several Bill Numbers of the same thread ("Landlord1 - <BillNo1> : X", "Landlord1 - <BillNo2> : X"):
  // a stored copy of it is not a duplicate when it sits on one of THOSE bills (opts.allowBills = their Bill Numbers, lower-case).
  const allow = opts.allowBills && opts.allowBills.length ? new Set(opts.allowBills.map((b) => String(b).toLowerCase())) : null;
  const billOfDue = new Map();
  if (allow) for (const r of media.rentalDue || []) billOfDue.set(String(r._id), String(r.adinn_ooh_bills || "").toLowerCase());
  const used = (e) => same(e.utrNumber) && !(allow && allow.has(billOfDue.get(String(e.rentalDueId)) || "\u0000"));
  if ((media.ledger || []).some(used)) return true;
  if ((media.withGst1Ledger || []).some(used)) return true;
  if ((media.gstBalanceHistory || []).some(used)) return true;
  for (const y of media.ledgerHistory || []) {
    for (const m of y.months || []) if ((m.entries || []).some(used)) return true;
  }
  // New Bill / Advance Bill payments live in arrearsDue[].payments[]
  for (const b of media.arrearsDue || []) {
    if ((b.payments || []).some((p) => same(p.utrNumber) && !(opts.except && opts.except(b, p)) && !(allow && allow.has(String(b.adinn_ooh_bills || "").toLowerCase())))) return true;
  }
  return false;
}
/** The reply lines of a thread as Finance wrote them (name - UTR / Cash), for the manual-review report. */
function replyLinesOf(d) {
  const out = [];
  for (const r of d.replies || []) for (const l of r.lines || []) out.push(l.line ? String(l.line) : `${l.name ? l.name + " - " : ""}UTR : ${l.utr}`);
  for (const r of d.cashReplies || []) for (const l of r.cashLines || []) if (!l.fromBankApproval) out.push(String(l.line || l.name));
  if (!out.length && d.utr) { const names = d.utrLineNames && d.utrLineNames.length ? d.utrLineNames : [""]; names.forEach((n) => out.push(`${n ? n + " - " : ""}UTR : ${d.utr}`)); }
  if (!out.length) (d.wrongNames || []).forEach((w) => out.push(`${w.name ? w.name + " - " : ""}UTR : ${w.utr}`));
  return [...new Set(out)].slice(0, 12);
}
/** Bill Numbers the reply lists together with this UTR (empty when it was not listed for several bills). */
const commonBillsOf = (d, utr) => ((d && d.commonUtrBills) || {})[String(utr || "").toUpperCase()] || [];

function createUtrProcessor(deps = {}) {
  const getMedia = () => deps.Media || require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
  const getLog = () => deps.Log || require("../models/Admin/GmailUtrLogSchema");
  const getRegistry = () => deps.Registry || require("../models/Admin/AdinnOohBillRegistrySchema");
  const getCounter = () => deps.Counter || require("../models/Admin/CounterSchema");
  const getHelpers = () => deps.helpers || require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
  const lookup = deps.lookup || lookupUtrByBillNumber;
  const lookupLandlords = deps.lookupLandlords || lookupLandlordUtrs;
  const pending = deps.getPending || getPendingUtrBills;
  const logger = deps.logger || console;
  const saver =
    deps.saver ||
    ((batch, actor) => require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller").executeBulkPaymentBatch({ user: { userName: actor || "Gmail UTR Auto" } }, batch));

  /** Fresh read of one bill from MongoDB, evaluated with the same rules as the pending list. */
  async function reEvaluate(item) {
    const media = await getMedia().findById(item.mediaId).lean();
    if (!media) return { media: null, current: null };
    const field = billField();
    const entries = (media.rentalDue || [])
      .filter((r) => r && String(r[field] || "").trim() === item.billNumber && Number(r.approvalStatus) === 3 && r.mailSent === true)
      .map((row) => ({ media, row }));
    if (!entries.length) return { media, current: null };
    const current = evaluateGroup(item.billNumber, entries, getHelpers());
    if (!current) return { media, current: null };
    // read-only cross-check against the bill-number registry; the rentalDue rows (dueMonth) stay the source of truth
    const registryProblem = await registryCheck(item.billNumber, media, entries.map((e) => e.row));
    return { media, current, ...(registryProblem ? { registryProblem } : {}) };
  }

  /**
   * adinn_ooh_bill_registry must agree with the rows that carry the Bill Number: same site, same dueMonth, and every row of
   * the bill listed in rentalDueIds. The DDMMYYYY inside the number is never used. Returns a reason, or null when it matches.
   */
  async function registryCheck(billNumber, media, rows) {
    const reg = await getRegistry().findOne({ adinn_ooh_bills: billNumber }).lean();
    if (!reg) return "registry_record_missing";
    if (String(reg.mediaId) !== String(media._id)) return "registry_media_mismatch";
    const months = new Set(rows.map((r) => String(r.dueMonth || "").trim()));
    if (months.size !== 1 || !months.has(String(reg.dueMonth || "").trim())) return "registry_month_mismatch";
    const listed = new Set((reg.rentalDueIds || []).map(String));
    if (!rows.every((r) => listed.has(String(r._id)))) return "registry_rows_mismatch";
    return null;
  }

  async function writeLog(entry, ctx) {
    if (ctx.dryRun) return;
    try {
      await getLog().create({ runId: ctx.runId, triggeredBy: ctx.triggeredBy, dryRun: false, ...entry });
    } catch (err) {
      logger.error("[gmail-utr] could not write log:", err.message);
    }
  }

  /** Skip bills whose last non-dry-run result is recent (saves Gmail quota). */
  async function inCooldown(item, c) {
    const last = await getLog().findOne({ billNumber: item.billNumber, dryRun: false }).sort({ createdAt: -1 }).lean();
    item._last = last ? { status: last.status, reason: last.reason || "" } : null; // lets done() skip a log row that says nothing new
    if (!last) return false;
    const age = Date.now() - new Date(last.createdAt).getTime();
    // utr_not_found: the approval mail is in Gmail and Finance has not replied yet -> look again on every run (cheap: one thread).
    if (last.status === "utr_not_found") return age < c.threadRetryMs;
    // bill_not_found: no approval mail in Gmail -> a fresh bill is looked for on every run, an old one backs off (see cfg).
    if (last.status === "bill_not_found") {
      const billAge = billAgeMs(item);
      const wait = billAge < c.newBillWindowMs ? 0 : billAge < 6 * 3600000 ? c.notFoundCooldownMs : c.oldNotFoundMs;
      return age < wait;
    }
    if (["gmail_error", "multiple_review_required"].includes(last.status)) return age < c.notFoundCooldownMs;
    // a reply that could not be matched: Finance corrects within minutes. Blocks decided BEFORE Gmail are re-evaluated every run.
    if (last.status === "ambiguous_mapping") return BLOCKED_BEFORE_GMAIL.has(last.reason) ? false : age < c.reviewRetryMs;
    return false;
  }

  /**
   * One bill with SEVERAL landlords: the finance reply (ONE mail, one line per landlord) is mapped to the landlords by
   * name, everything is validated first, and only then each landlord's UTR + Paid Date is saved with the same ledger
   * engine (one call per landlord, because the engine's date is per call). All-or-nothing: any doubt -> manual review.
   * Real saving needs GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED=true (and the Cash switch for Cash landlords);
   * a dry run always shows the landlord -> UTR mapping.
   */
  async function processMulti(item, ctx, c, done) {
    const multiOn = deps.multiLandlordSaveEnabled ? deps.multiLandlordSaveEnabled() : multiSaveEnabledEnv();
    const cashOn = deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv();
    const pendingLandlords = item.perLandlordMapping.landlords.filter((l) => l.state === "pending");
    const anyCash = pendingLandlords.some((l) => l.paymentMode === "Cash" || l.cashCompanion);

    if (!ctx.dryRun) {
      if (!multiOn && item.perLandlordMapping.landlords.length > 1) return done("ambiguous_mapping", "multi_landlord_auto_save_disabled");
      if (anyCash && !cashOn) return done("ambiguous_mapping", "cash_auto_save_disabled");
    }

    let found;
    try {
      found = await withTimeout(lookupLandlords(item.billNumber), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status));
      return e;
    }
    const d = found.data || {};
    item._d = d;
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    addBankApprovedCash(d, item.perLandlordMapping.landlords.filter((l) => l.state === "pending" && l.paymentMode === "Cash" && !l.cashCompanion).map((l) => l.name));
    const cashReps = d.cashReplies || [];
    if (!(d.replies || []).length && !cashReps.length) return done("utr_not_found");
    // A reply whose lines name NOBODY of this bill (every name is "not found", e.g. a mail pasted from another bill) is not
    // about this bill: it is ignored and reported. Every other reply counts. Finance must send ALL landlords in ONE mail,
    // so UTR lines spread over several relevant replies are never combined.
    const landlordsNow = item.perLandlordMapping.landlords;
    // ONE landlord (Cash + Online pair): a line without a name ("UTR : X") can only be his
    if (landlordsNow.length === 1) for (const r of d.replies || []) for (const l of r.lines || []) if (!l.name) l.name = landlordsNow[0].name;
    const aboutThisBill = (r) => r.lines.some((l) => matchLandlord(l.name, landlordsNow).error !== "landlord_name_not_found");
    const relevant = (d.replies || []).filter(aboutThisBill);
    const ignored = (d.replies || []).filter((r) => !relevant.includes(r)).map((r) => ({ messageId: r.messageId, reason: "names_match_no_landlord_of_this_bill", names: r.lines.map((l) => l.name) }));
    const used = relevant.length ? relevant : (d.replies || []);
    if (used.length > 1) return done("ambiguous_mapping", "utrs_in_multiple_replies", { gmailThreadId: d.threadId || "", repliesWithLines: used.map((r) => r.messageId), ...(ignored.length ? { ignoredReplies: ignored } : {}) });
    const reply = used[0] || { lines: [], messageId: cashReps[0].messageId, from: cashReps[0].from, sentAt: cashReps[0].sentAt, sentDate: cashReps[0].sentDate }; // Cash-only bill: the Cash lines carry the date
    const gm = { gmailThreadId: d.threadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}), sourceMessageId: reply.messageId || "", senderEmail: reply.from || "", messageDate: reply.sentAt || "", ...(ignored.length ? { ignoredReplies: ignored } : {}) };

    // ── re-check against MongoDB immediately before saving ──
    let fresh;
    try {
      fresh = await reEvaluate(item);
    } catch (err) {
      return done("database_error", `recheck_failed: ${err.message}`, gm);
    }
    if (!fresh.current) return done("already_processed", "no_longer_pending", gm);
    if (fresh.registryProblem) return done("ambiguous_mapping", fresh.registryProblem, gm);
    const pm = fresh.current.perLandlordMapping;
    if (!pm || !pm.eligible) return done("ambiguous_mapping", (pm && pm.reasons && pm.reasons[0]) || fresh.current.skipReason || "mapping_not_safe", gm);

    // a landlord whose ONLY open payment is Cash must be named in a Cash line ("Landlord - Cash"); a UTR line for him is manual review
    const isCashOnly = (l) => l.state === "pending" && l.paymentMode === "Cash" && !l.cashCompanion;
    const map = mapLandlords(reply.lines || [], pm.landlords.map((l) => (isCashOnly(l) ? { ...l, state: "settled", storedUtr: null } : l)));
    if (!map.ok) return done("ambiguous_mapping", map.reasons[0].reason, { ...gm, landlordMappingProblems: map.reasons });
    const mail = validateAgainstMail(d.approvalMailLandlords, pm.landlords);
    if (mail.status === "mismatch") return done("ambiguous_mapping", mail.problems[0].reason, { ...gm, landlordMappingProblems: mail.problems });

    // per landlord: UTR shape, duplicate check, own Paid Date, own payment slot
    const now = deps.now ? deps.now() : Date.now();
    const plan = [];
    for (const mp of map.mappings.filter((m) => m.landlord.state === "pending")) {
      const utr = mp.line.utr;
      const who = mp.landlord.name;
      if (!UTR_SHAPE.test(utr) || !/\d/.test(utr)) return done("utr_not_found", "invalid_utr", { ...gm, landlordMappingProblems: [{ reason: "invalid_utr", name: who }] });
      if (utrAlreadyUsed(fresh.media, utr, { allowBills: commonBillsOf(d, utr) })) return done("ambiguous_mapping", "utr_already_used_on_this_site", { ...gm, landlordMappingProblems: [{ reason: "utr_already_used_on_this_site", name: who }] });
      const slot = fresh.current.pendingPayments.find((p) => p.landOwnerId === mp.landlord.landOwnerId && p.paymentType === "online_rent") || fresh.current.pendingPayments.find((p) => p.landOwnerId === mp.landlord.landOwnerId && p.paymentType === "cash");
      if (!slot) return done("ambiguous_mapping", "no_auto_processable_payment", { ...gm, landlordMappingProblems: [{ reason: "no_open_payment", name: who }] });
      const paid = resolvePaidDate({ explicitDates: mp.line.dates, sentDate: reply.sentDate }, { approvalDate: fresh.current.approvalDate, now });
      if (!paid.date) return done("ambiguous_mapping", "paid_date_not_determined", { ...gm, landlordMappingProblems: [{ reason: "paid_date_not_determined", name: who }] });
      const mailOk = mail.status === "ok";
      plan.push({
        landlord: who,
        landOwnerId: mp.landlord.landOwnerId,
        utr,
        paymentType: slot.paymentType,
        paymentMode: slot.paymentMode,
        matchedBy: mp.matchedBy,
        validation: { name: mp.matchedBy, bank: mp.validation.bank !== "n/a" ? mp.validation.bank : mailOk ? "ok" : "n/a", account: mp.validation.account !== "n/a" ? mp.validation.account : mailOk ? "ok" : "n/a" },
        paidDate: paid.date,
        paidDateSource: paid.source,
        paidDateNote: paid.note,
        slot,
      });
    }
    // Cash + Online landlord: the UTR line paid the Online part; the Cash part takes the Paid Date of the mail that carries that UTR
    for (const mp of map.mappings.filter((m) => m.landlord.state === "pending" && m.landlord.cashCompanion)) {
      const cs = fresh.current.pendingPayments.find((p) => p.landOwnerId === mp.landlord.landOwnerId && p.paymentType === "cash");
      if (!cs) continue;
      const pd = resolvePaidDate({ explicitDates: [], sentDate: reply.sentDate }, { approvalDate: fresh.current.approvalDate, now });
      if (!pd.date) return done("ambiguous_mapping", "paid_date_not_determined", { ...gm, landlordMappingProblems: [{ reason: "paid_date_not_determined", name: mp.landlord.name }] });
      plan.push({ landlord: mp.landlord.name, landOwnerId: mp.landlord.landOwnerId, utr: "", paymentType: "cash", paymentMode: "Cash", companion: true, paidDate: pd.date, paidDateSource: pd.source, paidDateNote: "cash_date_from_rent_utr_mail", sourceMessageId: reply.messageId, slot: cs });
    }
    // Cash-only landlords: a Cash line naming them is required (all landlords of the bill are saved together, or none)
    for (const l of pm.landlords.filter(isCashOnly)) {
      const found = [];
      for (const r of d.cashReplies || []) for (const cl of r.cashLines || []) {
        const sc = splitCashName(cl.name); if (!sc) continue;
        const kn = splitNameKind(sc.landlord, pm.landlords); if (kn.kind === "gst" || !kn.landlord) continue;
        const m = matchLandlord(kn.landlord, pm.landlords);
        if (!m.error && m.landlord.landOwnerId === l.landOwnerId) found.push({ line: cl, reply: r });
      }
      if (!found.length) return done("ambiguous_mapping", "missing_landlord_cash_line", { ...gm, landlordMappingProblems: [{ reason: "missing_landlord_cash_line", name: l.name }] });
      const ds = found.map((x) => resolvePaidDate({ explicitDates: x.line.dates, sentDate: x.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now }));
      if (ds.some((x) => !x.date)) return done("ambiguous_mapping", "paid_date_not_determined", { ...gm, landlordMappingProblems: [{ reason: "paid_date_not_determined", name: l.name }] });
      if (new Set(ds.map((x) => x.date)).size > 1) return done("ambiguous_mapping", "conflicting_cash_paid_date", { ...gm, landlordMappingProblems: [{ reason: "conflicting_cash_paid_date", name: l.name }] });
      const cs = fresh.current.pendingPayments.find((p) => p.landOwnerId === l.landOwnerId && p.paymentType === "cash");
      if (!cs) return done("ambiguous_mapping", "no_auto_processable_payment", { ...gm, landlordMappingProblems: [{ reason: "no_open_payment", name: l.name }] });
      plan.push({ landlord: l.name, landOwnerId: l.landOwnerId, utr: "", paymentType: "cash", paymentMode: "Cash", paidDate: ds[0].date, paidDateSource: ds[0].source, paidDateNote: ds[0].note, sourceMessageId: found[0].reply.messageId, slot: cs });
    }
    attachNarration(plan, d, pm.landlords); // Bank Narration of the Finance payment mail -> the ledger remark (never guessed)
    const summary = plan.map(({ slot, ...rest }) => rest);

    if (ctx.dryRun) {
      const blockedBy = [];
      if (!(deps.saveEnabled ? deps.saveEnabled() : saveEnabled())) blockedBy.push("GMAIL_UTR_SAVE_ENABLED is off");
      if (!multiOn) blockedBy.push("GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED is off");
      if (anyCash && !cashOn) blockedBy.push("GMAIL_UTR_CASH_SAVE_ENABLED is off");
      return {
        ...base0(item),
        status: "found_and_saved",
        dryRun: true,
        reason: "dry_run_nothing_saved",
        ...gm,
        paymentType: "multi_landlord",
        mappingStatus: "per_landlord_verified",
        eligibleForSaving: true,
        savingBlockedBy: blockedBy,
        landlordMappings: summary,
      };
    }

    // live: one engine call per landlord (sequential). Everything was validated above, so a failure here is a database problem;
    // saved landlords are then no longer pending, which makes the next run's retry of the rest safe.
    const savedNames = [];
    for (const p of plan) {
      const batch = {
        siteBillMode: fresh.current.siteBillMode,
        entryType: "rental",
        date: p.paidDate,
        remark: p.narration || "", // Bank Narration only; no narration -> empty remark
        payments: [{ mediaId: fresh.current.mediaId, landOwnerId: p.slot.landOwnerId, rentalDueId: p.slot.rentalDueId, targetType: p.slot.targetType, paymentMode: p.slot.paymentMode, utrNumber: p.utr }],
      };
      try {
        const result = await saver(batch, p.sourceMessageId ? actorOf(d, p.sourceMessageId) : senderName(reply.from));
        const saved = (result?.data?.savedEntries || []).filter((e) => e.status === "saved");
        if (Number(result?.data?.sitesFailed || 0) > 0 || saved.length !== 1) {
          const why = (result?.data?.savedEntries || []).find((e) => e.status === "failed")?.error || "save_not_confirmed";
          return done("database_error", `partial_save ${savedNames.length}/${plan.length} (${p.landlord}: ${why}); saved landlords are skipped on retry`, { ...gm, landlordMappings: summary });
        }
        p.savedAmount = Number(saved[0].amount || 0);
        savedNames.push(p.landlord);
      } catch (err) {
        return done("database_error", `partial_save ${savedNames.length}/${plan.length} (${p.landlord}: ${err.message || "save_failed"}); saved landlords are skipped on retry`, { ...gm, landlordMappings: summary });
      }
    }
    return done("found_and_saved", "", { ...gm, paymentType: "multi_landlord", landlordMappings: plan.map(({ slot, ...rest }) => rest), savedAmount: plan.reduce((s, p) => s + (p.savedAmount || 0), 0) });
  }

  const base0 = (item) => ({ billNumber: item.billNumber, dueMonth: item.dueMonth || "", mediaId: item.mediaId, rentalDueIds: item.rentalDueIds, landOwnerId: "" });

  /**
   * GST ON HOLD, one landlord: the rent and the GST are two payments with two UTRs. Finance sends them as labelled lines
   *     Rent - UTR: <value>      GST - UTR: <value>
   * in the SAME thread — together in one mail, or the rent first and the GST days / weeks later. Every payment is saved on
   * its own as soon as ITS labelled line exists; nothing is ever assigned across kinds, and an unlabelled "UTR : X" is
   * never used (it could be either). Real saving needs GMAIL_UTR_GST_SAVE_ENABLED=true (and the Cash switch for Cash rent).
   */
  async function processSplit(item, ctx, c, done) {
    const gstOn = deps.gstSaveEnabled ? deps.gstSaveEnabled() : gstSaveEnabledEnv();
    const cashOn = deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv();
    if (!ctx.dryRun) {
      if (!gstOn) return done("ambiguous_mapping", "gst_split_auto_save_disabled");
      if (item.gstSplitMapping.slots.some((s) => s.paymentMode === "Cash") && !cashOn) return done("ambiguous_mapping", "cash_auto_save_disabled");
    }

    let found;
    try {
      found = await withTimeout(lookupLandlords(item.billNumber), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status));
      return e;
    }
    const d = found.data || {};
    item._d = d;
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    // a Cash rent has no UTR: "Cash" / "Rent - Cash [- Paid Date: ..]" lines are enough for the rent payment
    if (item.gstSplitMapping.slots.some((x) => x.kind === "rent" && x.paymentMode === "Cash") && !item.gstSplitMapping.slots.some((x) => x.kind === "rent" && x.paymentMode === "Online") && item.gstSplitMapping.landlord) addBankApprovedCash(d, [item.gstSplitMapping.landlord.name]);
    const cashSlotOpen = item.gstSplitMapping.slots.some((x) => x.kind === "rent" && x.paymentMode === "Cash");
    const cashAvail = cashSlotOpen && (d.cashReplies || []).length > 0;
    if (!cashAvail && (d.extractionStatus !== "found" || !(d.replies || []).length)) return done("utr_not_found");
    const gm = { gmailThreadId: d.threadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}) };

    // ── re-check against MongoDB immediately before saving ──
    let fresh;
    try {
      fresh = await reEvaluate(item);
    } catch (err) {
      return done("database_error", `recheck_failed: ${err.message}`, gm);
    }
    if (!fresh.current) return done("already_processed", "no_longer_pending", gm);
    if (fresh.registryProblem) return done("ambiguous_mapping", fresh.registryProblem, gm);
    const sm = fresh.current.gstSplitMapping;
    if (!sm || !sm.eligible) return done("ambiguous_mapping", (sm && sm.reasons && sm.reasons[0]) || fresh.current.skipReason || "mapping_not_safe", gm);
    const mail = validateAgainstMail(d.approvalMailLandlords, sm.landlord ? [sm.landlord] : []);
    if (mail.status === "mismatch") return done("ambiguous_mapping", mail.problems[0].reason, { ...gm, splitProblems: mail.problems });

    const map = mapPaymentKinds(d.replies, sm.landlord);
    // Cash lines of the thread that belong to the RENT payment: "Cash", "Rent - Cash", "<landlord> - Cash", "<landlord> - Rent - Cash".
    // "GST - Cash" (or any other label) is never a payment: GST is always an Online UTR.
    const cashRent = [];
    const cashIgnored = [];
    for (const r of d.cashReplies || []) {
      for (const l of r.cashLines || []) {
        const sc = splitCashName(l.name);
        const part = sc ? sc.landlord : null;
        let ok = false;
        if (part !== null) {
          if (part === "" || classifyPaymentLabel(part) === "rent") ok = true;
          else if (classifyPaymentLabel(part) !== "gst") {
            const kn = splitNameKind(part, sm.landlord ? [sm.landlord] : null);
            ok = (kn.kind === null || kn.kind === "rent") && !!sm.landlord && !matchLandlord(kn.landlord, [sm.landlord]).error;
          }
        }
        if (ok) cashRent.push({ line: l, reply: r }); else cashIgnored.push({ messageId: r.messageId, name: l.name, reason: "cash_line_not_for_rent" });
      }
    }
    const now = deps.now ? deps.now() : Date.now();
    const plan = [];
    const notYet = [];
    const blocked = [];
    const deferred = []; // Cash part of a Cash + Online pair
    for (const slot of sm.slots) {
      if (map.dupBoth) { blocked.push({ kind: slot.kind, reason: "duplicate_utr" }); continue; }
      if (map.conflicts.includes(slot.kind)) { blocked.push({ kind: slot.kind, reason: "conflicting_utr_for_kind" }); continue; }
      // paymentCategory 3 (Cash + Online both open): the "Rent - UTR" line is the ONLINE payment; the Cash part has no UTR, so it takes
      // its Paid Date from the mail that carries that Rent UTR (date and time of the mail). An explicit "Rent - Cash" line wins.
      const onlineSibling = sm.slots.some((x) => x.kind === "rent" && x.paymentMode === "Online");
      if (slot.kind === "rent" && slot.paymentMode === "Cash" && onlineSibling && !cashRent.length) {
        if (!map.byKind.rent) { notYet.push("rent"); continue; }
        deferred.push(slot); // decided after the loop, only when the Online rent itself is going to be saved
        continue;
      }
      if (slot.kind === "rent" && slot.paymentMode === "Cash" && cashRent.length) {
        const ds = cashRent.map((x) => resolvePaidDate({ explicitDates: x.line.dates, sentDate: x.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now }));
        if (ds.some((x) => !x.date)) { blocked.push({ kind: "rent", reason: "paid_date_not_determined" }); continue; }
        if (new Set(ds.map((x) => x.date)).size > 1) { blocked.push({ kind: "rent", reason: "conflicting_cash_paid_date" }); continue; }
        plan.push({ kind: "rent", landlord: (sm.landlord && sm.landlord.name) || slot.landOwnerName, utr: "", paymentType: "cash", paymentMode: "Cash", paidDate: ds[0].date, paidDateSource: ds[0].source, paidDateNote: ds[0].note, sourceMessageId: cashRent[0].reply.messageId, slot });
        continue;
      }
      if (slot.kind === "rent" && slot.paymentMode === "Cash" && !onlineSibling) { notYet.push("rent"); continue; } // Cash only: a "Cash" line is required (a UTR line is never a Cash payment)
      const m = map.byKind[slot.kind];
      if (!m) { notYet.push(slot.kind); continue; } // no labelled line yet: this payment simply stays pending
      if (!UTR_SHAPE.test(m.utr) || !/\d/.test(m.utr)) { blocked.push({ kind: slot.kind, reason: "invalid_utr" }); continue; }
      if (utrAlreadyUsed(fresh.media, m.utr, { allowBills: commonBillsOf(d, m.utr) })) { blocked.push({ kind: slot.kind, reason: "utr_already_used_on_this_site" }); continue; }
      const paid = resolvePaidDate({ explicitDates: m.line.dates, sentDate: m.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now });
      if (!paid.date) { blocked.push({ kind: slot.kind, reason: "paid_date_not_determined" }); continue; }
      plan.push({
        kind: slot.kind,
        landlord: (sm.landlord && sm.landlord.name) || slot.landOwnerName,
        utr: m.utr,
        paymentType: slot.paymentType,
        paymentMode: slot.paymentMode,
        paidDate: paid.date,
        paidDateSource: paid.source,
        paidDateNote: paid.note,
        sourceMessageId: m.reply.messageId,
        ...(slot.kind === "gst" ? { gstAmount: slot.gstAmount, gstDueMonth: slot.gstDueMonth } : {}),
        slot,
      });
    }
    for (const slot of deferred) {
      if (!plan.some((p) => p.kind === "rent" && p.paymentMode === "Online")) { blocked.push({ kind: "rent", reason: "online_rent_not_saved_so_cash_waits" }); continue; }
      const rm = map.byKind.rent;
      const pd = resolvePaidDate({ explicitDates: [], sentDate: rm.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now });
      if (!pd.date) { blocked.push({ kind: "rent", reason: "paid_date_not_determined" }); continue; }
      plan.push({ kind: "rent", landlord: (sm.landlord && sm.landlord.name) || slot.landOwnerName, utr: "", paymentType: "cash", paymentMode: "Cash", companion: true, paidDate: pd.date, paidDateSource: pd.source, paidDateNote: "cash_date_from_rent_utr_mail", sourceMessageId: rm.reply.messageId, slot });
    }
    const extra = { ...gm, ...(notYet.length ? { pendingKinds: notYet } : {}), ...(blocked.length ? { blockedKinds: blocked } : {}), ...(map.ignored.length || cashIgnored.length ? { ignoredLines: [...map.ignored, ...cashIgnored] } : {}) };
    if (!plan.length) {
      if (blocked.length) return done("ambiguous_mapping", blocked[0].reason, extra);
      // only lines naming somebody who is not this bill's landlord: nothing is saved, and it is reported (a later reply with the right name still saves)
      const wrongNames = map.ignored.filter((x) => x.reason === "landlord_name_not_found");
      if (wrongNames.length) return done("ambiguous_mapping", "landlord_name_not_found", { ...extra, landlordMappingProblems: wrongNames });
      return done("utr_not_found", "", extra);
    }
    attachNarration(plan, d, [sm.landlord]); // Bank Narration of the Finance payment mail -> the ledger remark (never guessed)
    const summary = plan.map(({ slot, ...rest }) => rest);

    if (ctx.dryRun) {
      const blockedBy = [];
      if (!(deps.saveEnabled ? deps.saveEnabled() : saveEnabled())) blockedBy.push("GMAIL_UTR_SAVE_ENABLED is off");
      if (!gstOn) blockedBy.push("GMAIL_UTR_GST_SAVE_ENABLED is off");
      if (plan.some((p) => p.paymentMode === "Cash") && !cashOn) blockedBy.push("GMAIL_UTR_CASH_SAVE_ENABLED is off");
      return { ...base0(item), status: "found_and_saved", dryRun: true, reason: "dry_run_nothing_saved", ...extra, paymentType: "rent_gst_split", mappingStatus: "per_payment_verified", eligibleForSaving: true, savingBlockedBy: blockedBy, splitPayments: summary };
    }

    // live: rent first, then GST — each its own ledger-save call (entryType is per call); a failure is reported and the
    // payments already saved are no longer pending, so the retry only does the rest.
    const savedKinds = [];
    for (const p of plan) {
      const isGst = p.kind === "gst";
      const batch = {
        siteBillMode: fresh.current.siteBillMode,
        entryType: isGst ? "gst" : "rental",
        date: p.paidDate,
        remark: p.narration || "", // Bank Narration only; no narration -> empty remark
        payments: [{ mediaId: fresh.current.mediaId, landOwnerId: p.slot.landOwnerId, rentalDueId: p.slot.rentalDueId, targetType: p.slot.targetType, paymentMode: p.slot.paymentMode || "Online", utrNumber: p.utr }],
      };
      try {
        const result = await saver(batch, actorOf(d, p.sourceMessageId));
        const saved = (result?.data?.savedEntries || []).filter((e) => e.status === "saved");
        if (Number(result?.data?.sitesFailed || 0) > 0 || saved.length !== 1) {
          const why = (result?.data?.savedEntries || []).find((e) => e.status === "failed")?.error || "save_not_confirmed";
          return done("database_error", `partial_save ${savedKinds.length}/${plan.length} (${p.kind}: ${why}); saved payments are skipped on retry`, { ...extra, splitPayments: summary });
        }
        p.savedAmount = Number(saved[0].amount || 0);
        savedKinds.push(p.kind);
      } catch (err) {
        return done("database_error", `partial_save ${savedKinds.length}/${plan.length} (${p.kind}: ${err.message || "save_failed"}); saved payments are skipped on retry`, { ...extra, splitPayments: summary });
      }
    }
    return done("found_and_saved", "", { ...extra, paymentType: "rent_gst_split", splitPayments: plan.map(({ slot, ...rest }) => rest), savedAmount: plan.reduce((s, p) => s + (p.savedAmount || 0), 0) });
  }

  /**
   * GST ON HOLD, SEVERAL landlords: every landlord has his own Rent payment and his own GST payment. Finance writes one line per
   * payment, naming the landlord AND the payment:
   *     Landlord1 - Rent - UTR : <value>      Landlord1 - GST - UTR : <value>
   * in the SAME thread (one mail, or rent first and GST days later). Every payment is saved on its own as soon as ITS line
   * exists; a landlord is matched by name only (never by amount or order), a line without a rent / GST label is never used, and
   * any doubt (unknown / ambiguous name, same UTR twice, two UTRs for one payment) keeps the payment — or the bill — in manual
   * review. Real saving needs BOTH GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED and GMAIL_UTR_GST_SAVE_ENABLED (and the Cash switch
   * for a Cash rent).
   */
  async function processMultiGst(item, ctx, c, done) {
    const multiOn = deps.multiLandlordSaveEnabled ? deps.multiLandlordSaveEnabled() : multiSaveEnabledEnv();
    const gstOn = deps.gstSaveEnabled ? deps.gstSaveEnabled() : gstSaveEnabledEnv();
    const cashOn = deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv();
    if (!ctx.dryRun) {
      if (!multiOn) return done("ambiguous_mapping", "multi_landlord_auto_save_disabled");
      if (!gstOn) return done("ambiguous_mapping", "gst_split_auto_save_disabled");
      if (item.landlordGstMapping.slots.some((s) => s.paymentMode === "Cash") && !cashOn) return done("ambiguous_mapping", "cash_auto_save_disabled");
    }

    let found;
    try {
      found = await withTimeout(lookupLandlords(item.billNumber), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status));
      return e;
    }
    const d = found.data || {};
    item._d = d;
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    addBankApprovedCash(d, item.landlordGstMapping.slots.filter((s) => s.kind === "rent" && s.paymentMode === "Cash" && !item.landlordGstMapping.slots.some((x) => x.kind === "rent" && x.landOwnerId === s.landOwnerId && x.paymentMode === "Online")).map((s) => s.landOwnerName));
    if (!(d.replies || []).length && !(d.cashReplies || []).length) return done("utr_not_found");
    const gm = { gmailThreadId: d.threadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}) };

    // ── re-check against MongoDB immediately before saving ──
    let fresh;
    try {
      fresh = await reEvaluate(item);
    } catch (err) {
      return done("database_error", `recheck_failed: ${err.message}`, gm);
    }
    if (!fresh.current) return done("already_processed", "no_longer_pending", gm);
    if (fresh.registryProblem) return done("ambiguous_mapping", fresh.registryProblem, gm);
    const mg = fresh.current.landlordGstMapping;
    if (!mg || !mg.eligible) return done("ambiguous_mapping", (mg && mg.reasons && mg.reasons[0]) || fresh.current.skipReason || "mapping_not_safe", gm);
    const mail = validateAgainstMail(d.approvalMailLandlords, mg.landlords);
    if (mail.status === "mismatch") return done("ambiguous_mapping", mail.problems[0].reason, { ...gm, landlordMappingProblems: mail.problems });

    const map = mapLandlordKinds(d.replies, mg.landlords);
    // a line naming nobody of this bill (a wrong name, a later reply may carry the right one) never blocks the correct lines; it only decides when NOTHING can be saved
    const nameOnly = map.problems.filter((p) => p.reason === "landlord_name_not_found");
    const hardProblems = map.problems.filter((p) => p.reason !== "landlord_name_not_found");
    if (hardProblems.length) return done("ambiguous_mapping", hardProblems[0].reason, { ...gm, landlordMappingProblems: hardProblems, ...(map.ignored.length ? { ignoredLines: map.ignored } : {}) });
    // one UTR can pay only one payment: the same UTR on two payments blocks the whole bill
    const owners = new Map();
    for (const [key, list] of map.byKey) for (const u of new Set(list.map((x) => x.utr.toUpperCase()))) owners.set(u, [...(owners.get(u) || []), key]);
    const dup = [...owners.entries()].find(([, keys]) => keys.length > 1);
    if (dup) return done("ambiguous_mapping", "duplicate_utr", { ...gm, landlordMappingProblems: [{ reason: "duplicate_utr", payments: dup[1] }] });

    // Cash lines per landlord ("Landlord - Cash", "Landlord - Rent - Cash"); "GST - Cash" is never a payment
    const cashBy = new Map();
    for (const r of d.cashReplies || []) for (const cl of r.cashLines || []) {
      const sc = splitCashName(cl.name); if (!sc) continue;
      const kn = splitNameKind(sc.landlord, mg.landlords); if (kn.kind === "gst" || !kn.landlord) continue;
      const m = matchLandlord(kn.landlord, mg.landlords);
      if (m.error) continue;
      cashBy.set(m.landlord.landOwnerId, [...(cashBy.get(m.landlord.landOwnerId) || []), { line: cl, reply: r }]);
    }
    const deferred = []; // Cash part of a Cash + Online pair
    const now = deps.now ? deps.now() : Date.now();
    const plan = [];
    const notYet = [];
    const blocked = [];
    for (const slot of mg.slots) {
      const key = `${slot.landOwnerId}|${slot.kind}`;
      const who = { landlord: slot.landOwnerName, kind: slot.kind };
      if (slot.kind === "rent" && slot.paymentMode === "Cash") {
        const cl = cashBy.get(slot.landOwnerId) || [];
        const sibling = mg.slots.some((x) => x.kind === "rent" && x.landOwnerId === slot.landOwnerId && x.paymentMode === "Online");
        if (cl.length) {
          const ds = cl.map((x) => resolvePaidDate({ explicitDates: x.line.dates, sentDate: x.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now }));
          if (ds.some((x) => !x.date)) { blocked.push({ ...who, reason: "paid_date_not_determined" }); continue; }
          if (new Set(ds.map((x) => x.date)).size > 1) { blocked.push({ ...who, reason: "conflicting_cash_paid_date" }); continue; }
          plan.push({ kind: "rent", landlord: slot.landOwnerName, utr: "", paymentType: "cash", paymentMode: "Cash", paidDate: ds[0].date, paidDateSource: ds[0].source, paidDateNote: ds[0].note, sourceMessageId: cl[0].reply.messageId, slot });
          continue;
        }
        if (sibling && (map.byKey.get(`${slot.landOwnerId}|rent`) || []).length) { deferred.push(slot); continue; }
        notYet.push(who); // Cash only: a "Cash" line is required; Cash + Online: waits for the Rent UTR line
        continue;
      }
      const list = map.byKey.get(key) || [];
      const distinct = [...new Set(list.map((x) => x.utr.toUpperCase()))];
      if (!distinct.length) { notYet.push(who); continue; } // no line yet: this payment simply stays pending
      if (distinct.length > 1) { blocked.push({ ...who, reason: "conflicting_utr_for_landlord_payment" }); continue; }
      const m = list[0];
      if (!UTR_SHAPE.test(m.utr) || !/\d/.test(m.utr)) { blocked.push({ ...who, reason: "invalid_utr" }); continue; }
      if (utrAlreadyUsed(fresh.media, m.utr, { allowBills: commonBillsOf(d, m.utr) })) { blocked.push({ ...who, reason: "utr_already_used_on_this_site" }); continue; }
      const paid = resolvePaidDate({ explicitDates: m.line.dates, sentDate: m.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now });
      if (!paid.date) { blocked.push({ ...who, reason: "paid_date_not_determined" }); continue; }
      plan.push({
        kind: slot.kind,
        landlord: slot.landOwnerName,
        utr: m.utr,
        paymentType: slot.paymentType,
        paymentMode: slot.paymentMode,
        paidDate: paid.date,
        paidDateSource: paid.source,
        paidDateNote: paid.note,
        sourceMessageId: m.reply.messageId,
        ...(slot.kind === "gst" ? { gstAmount: slot.gstAmount, gstDueMonth: slot.gstDueMonth } : {}),
        slot,
      });
    }
    for (const slot of deferred) {
      const who = { landlord: slot.landOwnerName, kind: "rent" };
      if (!plan.some((p) => p.kind === "rent" && p.paymentMode === "Online" && p.slot.landOwnerId === slot.landOwnerId)) { blocked.push({ ...who, reason: "online_rent_not_saved_so_cash_waits" }); continue; }
      const rm = map.byKey.get(`${slot.landOwnerId}|rent`)[0];
      const pd = resolvePaidDate({ explicitDates: [], sentDate: rm.reply.sentDate }, { approvalDate: fresh.current.approvalDate, now });
      if (!pd.date) { blocked.push({ ...who, reason: "paid_date_not_determined" }); continue; }
      plan.push({ kind: "rent", landlord: slot.landOwnerName, utr: "", paymentType: "cash", paymentMode: "Cash", companion: true, paidDate: pd.date, paidDateSource: pd.source, paidDateNote: "cash_date_from_rent_utr_mail", sourceMessageId: rm.reply.messageId, slot });
    }
    const extra = { ...gm, ...(notYet.length ? { pendingPayments: notYet } : {}), ...(blocked.length ? { blockedPayments: blocked } : {}), ...(map.ignored.length ? { ignoredLines: map.ignored } : {}) };
    if (!plan.length) {
      if (blocked.length) return done("ambiguous_mapping", blocked[0].reason, extra);
      if (nameOnly.length) return done("ambiguous_mapping", "landlord_name_not_found", { ...extra, landlordMappingProblems: nameOnly });
      return done("utr_not_found", "", extra);
    }
    attachNarration(plan, d, mg.landlords); // Bank Narration of the Finance payment mail -> the ledger remark (never guessed)
    const summary = plan.map(({ slot, ...rest }) => rest);

    if (ctx.dryRun) {
      const blockedBy = [];
      if (!(deps.saveEnabled ? deps.saveEnabled() : saveEnabled())) blockedBy.push("GMAIL_UTR_SAVE_ENABLED is off");
      if (!multiOn) blockedBy.push("GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED is off");
      if (!gstOn) blockedBy.push("GMAIL_UTR_GST_SAVE_ENABLED is off");
      if (plan.some((p) => p.paymentMode === "Cash") && !cashOn) blockedBy.push("GMAIL_UTR_CASH_SAVE_ENABLED is off");
      return { ...base0(item), status: "found_and_saved", dryRun: true, reason: "dry_run_nothing_saved", ...extra, paymentType: "multi_landlord_rent_gst", mappingStatus: "per_landlord_payment_verified", eligibleForSaving: true, savingBlockedBy: blockedBy, splitPayments: summary };
    }

    // live: every rent first, then every GST — each its own ledger-save call (entryType and date are per call). A failure is
    // reported; the payments already saved are no longer pending, so the retry only does the rest.
    const ordered = [...plan.filter((p) => p.kind === "rent"), ...plan.filter((p) => p.kind === "gst")];
    let savedCount = 0;
    for (const p of ordered) {
      const isGst = p.kind === "gst";
      const batch = {
        siteBillMode: fresh.current.siteBillMode,
        entryType: isGst ? "gst" : "rental",
        date: p.paidDate,
        remark: p.narration || "", // Bank Narration only; no narration -> empty remark
        payments: [{ mediaId: fresh.current.mediaId, landOwnerId: p.slot.landOwnerId, rentalDueId: p.slot.rentalDueId, targetType: p.slot.targetType, paymentMode: p.slot.paymentMode || "Online", utrNumber: p.utr }],
      };
      try {
        const result = await saver(batch, actorOf(d, p.sourceMessageId));
        const saved = (result?.data?.savedEntries || []).filter((e) => e.status === "saved");
        if (Number(result?.data?.sitesFailed || 0) > 0 || saved.length !== 1) {
          const why = (result?.data?.savedEntries || []).find((e) => e.status === "failed")?.error || "save_not_confirmed";
          return done("database_error", `partial_save ${savedCount}/${ordered.length} (${p.landlord} ${p.kind}: ${why}); saved payments are skipped on retry`, { ...extra, splitPayments: summary });
        }
        p.savedAmount = Number(saved[0].amount || 0);
        savedCount += 1;
      } catch (err) {
        return done("database_error", `partial_save ${savedCount}/${ordered.length} (${p.landlord} ${p.kind}: ${err.message || "save_failed"}); saved payments are skipped on retry`, { ...extra, splitPayments: summary });
      }
    }
    return done("found_and_saved", "", { ...extra, paymentType: "multi_landlord_rent_gst", splitPayments: ordered.map(({ slot, ...rest }) => rest), savedAmount: ordered.reduce((s, p) => s + (p.savedAmount || 0), 0) });
  }

  /**
   * NEW BILL / ADVANCE BILL (media.arrearsDue[]). The Finance reply is tied to the approval mail by In-Reply-To (same lookup as
   * the Rental flow); the Bill Number of THAT mail picks the bill(s), the registry + the bills' own dueMonth confirm it. Lines are
   *     [Landlord - ]NewBill|Advance [- Rent|GST] - UTR : <value>          (Online rent, GST)
   *     [Landlord - ]NewBill|Advance - Cash [- Paid Date: <date>]           (Cash rent: NO UTR, only the paid date is stored)
   * One payment per landlord and kind: Rent (Online or Cash) and, when GST is on hold, GST (landlord-wise for several
   * landlords, one for a single landlord). Several arrears bills under ONE Bill Number (months / faces) are covered by that one
   * payment, like the faces of a Rental Bill: the same UTR (or Cash paid date) is saved on each of them. A New Bill line is never
   * an Advance payment and vice versa. Every payment is saved as soon as ITS line exists; any doubt keeps the payment (or the
   * bill) in manual review. Real saving: GMAIL_UTR_SAVE_ENABLED + the multi-landlord switch (several landlords) + the GST switch
   * (GST on hold) + the Cash switch (Cash rent).
   */
  async function registryCheckArrears(billNumber, media, bills, kind) {
    const reg = await getRegistry().findOne({ adinn_ooh_bills: billNumber }).lean();
    if (!reg) return "registry_record_missing";
    if (String(reg.mediaId) !== String(media._id)) return "registry_media_mismatch";
    const want = kind === "advance" ? "advance" : "newbill";
    if (!String(reg.groupKey || "").includes(`|${want}:`) || (reg.billMode && reg.billMode !== (kind === "advance" ? "advance" : "new_bill"))) return "registry_kind_mismatch";
    // the registry month is the first bill's month: it must be the month of one of this Bill Number's own bills
    if (!bills.some((b) => String(b.dueMonth || "").trim() === String(reg.dueMonth || "").trim())) return "registry_month_mismatch";
    const listed = new Set((reg.rentalDueIds || []).map(String));
    if (!bills.every((b) => listed.has(String(b._id)))) return "registry_rows_mismatch";
    return null;
  }

  async function reEvaluateArrears(item) {
    const media = await getMedia().findById(item.mediaId).lean();
    if (!media) return { media: null, current: null };
    const entries = (media.arrearsDue || [])
      .filter((b) => b && String(b.adinn_ooh_bills || "").trim() === item.billNumber && Number(b.approvalStatus) === 3 && b.mailSent === true)
      .map((bill) => ({ media, bill }));
    if (!entries.length) return { media, current: null };
    const current = evaluateArrearsGroup(item.billNumber, entries);
    if (!current) return { media, current: null };
    const registryProblem = await registryCheckArrears(item.billNumber, media, entries.map((e) => e.bill), current.billKind);
    return { media, current, ...(registryProblem ? { registryProblem } : {}) };
  }

  async function processArrears(item, ctx, c, done) {
    if (!item.eligible) return done("ambiguous_mapping", item.skipReason || "mapping_not_safe");
    const multiOn = deps.multiLandlordSaveEnabled ? deps.multiLandlordSaveEnabled() : multiSaveEnabledEnv();
    const gstOn = deps.gstSaveEnabled ? deps.gstSaveEnabled() : gstSaveEnabledEnv();
    const cashOn = deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv();
    if (!ctx.dryRun) {
      if (item.landlords.length > 1 && !multiOn) return done("ambiguous_mapping", "multi_landlord_auto_save_disabled");
      if (item.slots.some((s) => s.kind === "gst") && !gstOn) return done("ambiguous_mapping", "gst_split_auto_save_disabled");
      if (item.slots.some((s) => s.paymentMode === "Cash") && !cashOn) return done("ambiguous_mapping", "cash_auto_save_disabled");
    }

    let found;
    try {
      found = await withTimeout(lookupLandlords(item.billNumber), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status));
      return e;
    }
    const d = found.data || {};
    item._d = d;
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    const replies = d.extractionStatus === "found" ? d.replies || [] : [];
    addBankApprovedCash(d, item.slots.filter((s) => s.kind !== "gst" && s.paymentMode === "Cash" && !item.slots.some((x) => x.kind !== "gst" && x.landOwnerId === s.landOwnerId && x.paymentMode !== "Cash")).map((s) => s.landOwnerName));
    const cashReplies = d.cashReplies || [];
    if (!replies.length && !cashReplies.length) return done("utr_not_found");
    const gm = { gmailThreadId: d.threadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}) };

    // ── re-check against MongoDB immediately before saving ──
    let fresh;
    try {
      fresh = await reEvaluateArrears(item);
    } catch (err) {
      return done("database_error", `recheck_failed: ${err.message}`, gm);
    }
    if (!fresh.current) return done("already_processed", "no_longer_pending", gm);
    if (fresh.registryProblem) return done("ambiguous_mapping", fresh.registryProblem, gm);
    const cur = fresh.current;
    if (!cur.eligible) return done("ambiguous_mapping", cur.skipReason || "mapping_not_safe", gm);
    if (cur.billKind !== item.billKind) return done("ambiguous_mapping", "bill_kind_mismatch", gm);
    const mail = validateAgainstMail(d.approvalMailLandlords, cur.landlords);
    if (mail.status === "mismatch") return done("ambiguous_mapping", mail.problems[0].reason, { ...gm, landlordMappingProblems: mail.problems });

    // UTR replies and Cash replies of the thread, side by side (a reply can carry both kinds of lines)
    const merged = new Map();
    replies.forEach((r) => merged.set(r.messageId, { ...r }));
    cashReplies.forEach((r) => merged.set(r.messageId, { ...(merged.get(r.messageId) || r), cashLines: r.cashLines }));
    const map = mapArrearsLines([...merged.values()], cur.landlords, { billType: cur.billKind, gstHold: cur.gstHold });
    // same rule as the other flows: a wrong name never blocks the lines that carry the right name
    const nameOnly = map.problems.filter((p) => p.reason === "landlord_name_not_found");
    const hardProblems = map.problems.filter((p) => p.reason !== "landlord_name_not_found");
    if (hardProblems.length) return done("ambiguous_mapping", hardProblems[0].reason, { ...gm, landlordMappingProblems: hardProblems, ...(map.ignored.length ? { ignoredLines: map.ignored } : {}) });
    // one UTR can pay only one payment: the same UTR on two payments blocks the whole bill (Cash lines have no UTR)
    const byUtr = new Map();
    for (const [key, list] of map.byKey) for (const u of new Set(list.map((x) => x.utr.toUpperCase()).filter(Boolean))) byUtr.set(u, [...(byUtr.get(u) || []), key]);
    const dup = [...byUtr.entries()].find(([, keys]) => keys.length > 1);
    if (dup) return done("ambiguous_mapping", "duplicate_utr", { ...gm, landlordMappingProblems: [{ reason: "duplicate_utr", payments: dup[1] }] });

    const now = deps.now ? deps.now() : Date.now();
    const keyOf = (s) => `${s.landOwnerId}|${s.kind === "gst" ? "gst" : s.paymentMode === "Cash" ? "cash" : "rent"}`;
    const groups = new Map(); // one payment per landlord and kind; every bill of the Bill Number that still owes it is a part
    for (const s of cur.slots) {
      const k = keyOf(s);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    const plan = [];
    const notYet = [];
    const blocked = [];
    const deferredCash = []; // Cash part of a Cash + Online pair
    for (const [key, gslots] of groups) {
      const first = gslots[0];
      const isCash = key.endsWith("|cash");
      const who = { landlord: first.landOwnerName, kind: first.kind, ...(isCash ? { cash: true } : {}) };
      const list = map.byKey.get(key) || [];
      if (!list.length && isCash && groups.has(`${first.landOwnerId}|rent`)) { deferredCash.push({ first, gslots, who }); continue; } // Cash + Online: decided below
      if (!list.length) { notYet.push(who); continue; } // no line yet: this payment simply stays pending
      const parts = gslots.map((s) => ({ billId: s.rentalDueId, dueMonth: s.dueMonth, amount: s.amount }));
      const common = { kind: first.kind, landlord: first.landOwnerName, paymentType: first.paymentType, paymentMode: first.paymentMode, bills: parts, amount: gslots.reduce((t, s) => t + Number(s.amount || 0), 0), ...(first.kind === "gst" ? { gstScope: first.scope } : {}), slots: gslots };

      if (isCash) {
        // Cash: NO UTR. Only the paid date is taken (the line's explicit date, else the reply's sent date); lines must agree.
        const dates = list.map((m) => ({ m, paid: resolvePaidDate({ explicitDates: m.line.dates, sentDate: m.reply.sentDate }, { approvalDate: cur.approvalDate, now }) }));
        if (dates.some((x) => !x.paid.date)) { blocked.push({ ...who, reason: "paid_date_not_determined" }); continue; }
        if (new Set(dates.map((x) => x.paid.date)).size > 1) { blocked.push({ ...who, reason: "conflicting_cash_paid_date" }); continue; }
        const { m, paid } = dates[0];
        plan.push({ ...common, utr: "", paidDate: paid.date, paidDateSource: paid.source, paidDateNote: paid.note, sourceMessageId: m.reply.messageId });
        continue;
      }

      const distinct = [...new Set(list.map((x) => x.utr.toUpperCase()))];
      if (distinct.length > 1) { blocked.push({ ...who, reason: "conflicting_utr_for_landlord_payment" }); continue; }
      const m = list[0];
      if (!UTR_SHAPE.test(m.utr) || !/\d/.test(m.utr)) { blocked.push({ ...who, reason: "invalid_utr" }); continue; }
      // a UTR already stored by THIS payment on another bill of the same Bill Number (earlier partial save) is not a duplicate
      const groupIds = new Set(cur.arrearsBillIds);
      const ownPart = (b, p) =>
        groupIds.has(String(b._id)) && p.type === (first.kind === "gst" ? "gst" : "rental") &&
        (idStrOf(p.landOwnerId) === first.landOwnerId || (!p.landOwnerId && first.scope === "bill"));
      if (utrAlreadyUsed(fresh.media, m.utr, { except: ownPart, allowBills: commonBillsOf(d, m.utr) })) { blocked.push({ ...who, reason: "utr_already_used_on_this_site" }); continue; }
      const paid = resolvePaidDate({ explicitDates: m.line.dates, sentDate: m.reply.sentDate }, { approvalDate: cur.approvalDate, now });
      if (!paid.date) { blocked.push({ ...who, reason: "paid_date_not_determined" }); continue; }
      plan.push({ ...common, utr: m.utr, paidDate: paid.date, paidDateSource: paid.source, paidDateNote: paid.note, sourceMessageId: m.reply.messageId });
    }
    for (const dc of deferredCash) {
      const rl = map.byKey.get(`${dc.first.landOwnerId}|rent`) || [];
      if (!rl.length) { notYet.push(dc.who); continue; }
      if (!plan.some((p) => p.kind === "rent" && p.paymentMode !== "Cash" && p.slots[0].landOwnerId === dc.first.landOwnerId)) { blocked.push({ ...dc.who, reason: "online_rent_not_saved_so_cash_waits" }); continue; }
      const pd = resolvePaidDate({ explicitDates: [], sentDate: rl[0].reply.sentDate }, { approvalDate: cur.approvalDate, now });
      if (!pd.date) { blocked.push({ ...dc.who, reason: "paid_date_not_determined" }); continue; }
      plan.push({ kind: "rent", landlord: dc.first.landOwnerName, paymentType: dc.first.paymentType, paymentMode: dc.first.paymentMode, bills: dc.gslots.map((s) => ({ billId: s.rentalDueId, dueMonth: s.dueMonth, amount: s.amount })), amount: dc.gslots.reduce((t, s) => t + Number(s.amount || 0), 0), slots: dc.gslots, utr: "", companion: true, paidDate: pd.date, paidDateSource: pd.source, paidDateNote: "cash_date_from_rent_utr_mail", sourceMessageId: rl[0].reply.messageId });
    }
    const unused = [...map.byKey.keys()].filter((k) => !groups.has(k));
    const ignoredLines = [...map.ignored, ...unused.map((k) => ({ key: k, reason: "no_open_payment_for_line" }))];
    const extra = { ...gm, billKind: cur.billKind, ...(notYet.length ? { pendingPayments: notYet } : {}), ...(blocked.length ? { blockedPayments: blocked } : {}), ...(ignoredLines.length ? { ignoredLines } : {}) };
    if (!plan.length) {
      if (blocked.length) return done("ambiguous_mapping", blocked[0].reason, extra);
      if (nameOnly.length) return done("ambiguous_mapping", "landlord_name_not_found", { ...extra, landlordMappingProblems: nameOnly });
      return done("utr_not_found", "", extra);
    }
    attachNarration(plan, d, cur.landlords); // Bank Narration of the Finance payment mail -> the ledger remark (never guessed)
    const summary = plan.map(({ slots, ...rest }) => rest);
    const paymentType = cur.billKind === "advance" ? "advance_rent_gst" : "new_bill_rent_gst";

    if (ctx.dryRun) {
      const blockedBy = [];
      if (!(deps.saveEnabled ? deps.saveEnabled() : saveEnabled())) blockedBy.push("GMAIL_UTR_SAVE_ENABLED is off");
      if (cur.landlords.length > 1 && !multiOn) blockedBy.push("GMAIL_UTR_MULTI_LANDLORD_SAVE_ENABLED is off");
      if (plan.some((p) => p.kind === "gst") && !gstOn) blockedBy.push("GMAIL_UTR_GST_SAVE_ENABLED is off");
      if (plan.some((p) => p.paymentMode === "Cash") && !cashOn) blockedBy.push("GMAIL_UTR_CASH_SAVE_ENABLED is off");
      return { ...base0(item), status: "found_and_saved", dryRun: true, reason: "dry_run_nothing_saved", ...extra, paymentType, mappingStatus: "per_landlord_payment_verified", eligibleForSaving: true, savingBlockedBy: blockedBy, splitPayments: summary };
    }

    // live: every rent first, then every GST — one ledger-save call per bill part (entryType and date are per call). A failure is
    // reported; parts already saved are no longer open, so the retry only does the rest.
    const ordered = [...plan.filter((p) => p.kind === "rent"), ...plan.filter((p) => p.kind === "gst")];
    const total = ordered.reduce((t, p) => t + p.slots.length, 0);
    let savedCount = 0;
    for (const p of ordered) {
      const isGst = p.kind === "gst";
      for (const s of p.slots) {
        const batch = {
          siteBillMode: 1,
          entryType: isGst ? "gst" : "rental",
          date: p.paidDate,
          remark: p.narration || "", // Bank Narration only; no narration -> empty remark
          payments: [{
            mediaId: cur.mediaId,
            landOwnerId: s.landOwnerId,
            rentalDueId: s.rentalDueId, // the arrears / advance bill's own id (the engine routes it to media.arrearsDue[])
            targetType: cur.billKind, // "newBill" | "advance"
            paymentMode: s.paymentMode || "Online",
            utrNumber: p.utr, // "" for Cash
            ...(isGst && s.scope === "landlord" ? { gstScope: "landlord" } : {}),
          }],
        };
        try {
          const result = await saver(batch, actorOf(d, p.sourceMessageId));
          const saved = (result?.data?.savedEntries || []).filter((e) => e.status === "saved");
          if (Number(result?.data?.sitesFailed || 0) > 0 || saved.length !== 1) {
            const why = (result?.data?.savedEntries || []).find((e) => e.status === "failed")?.error || "save_not_confirmed";
            return done("database_error", `partial_save ${savedCount}/${total} (${p.landlord} ${p.kind} ${s.dueMonth}: ${why}); saved payments are skipped on retry`, { ...extra, splitPayments: summary });
          }
          p.savedAmount = (p.savedAmount || 0) + Number(saved[0].amount || 0);
          savedCount += 1;
        } catch (err) {
          return done("database_error", `partial_save ${savedCount}/${total} (${p.landlord} ${p.kind} ${s.dueMonth}: ${err.message || "save_failed"}); saved payments are skipped on retry`, { ...extra, splitPayments: summary });
        }
      }
    }
    return done("found_and_saved", "", { ...extra, paymentType, splitPayments: ordered.map(({ slots, ...rest }) => rest), savedAmount: ordered.reduce((t, p) => t + (p.savedAmount || 0), 0) });
  }

  /**
   * RENTAL BILL, one landlord paid in CASH: a Cash payment has no UTR. When the thread has no UTR (the normal Cash case) a line
   * "Cash [- Paid Date: ...]" / "<landlord> - Cash [- Paid Date: ...]" of a reply says it was paid; only the paid date is stored.
   * Same checks as the UTR path: registry, mapping still safe, Paid Date window, Cash switch.
   */
  async function processCashLine(item, ctx, c, done) {
    let found;
    try {
      found = await withTimeout(lookupLandlords(item.billNumber), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status));
      return e;
    }
    const d = found.data || {};
    item._d = d;
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_utr_or_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    const landlord = item.landlords[0];
    addBankApprovedCash(d, [landlord.name]);
    const lines = [];
    const ignored = [];
    for (const r of d.cashReplies || []) {
      for (const l of r.cashLines || []) {
        const sc = splitCashName(l.name);
        // a name before "Cash" must be this landlord's; anything else is not a payment line
        if (!sc || (sc.landlord && matchLandlord(sc.landlord, [{ landOwnerId: landlord.landOwnerId, name: landlord.name }]).error)) { ignored.push({ messageId: r.messageId, name: l.name, reason: "cash_line_not_for_this_landlord" }); continue; }
        lines.push({ l, r });
      }
    }
    if (!lines.length) return done("utr_not_found", "", ignored.length ? { ignoredLines: ignored } : {});
    const gm = { gmailThreadId: d.threadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}), sourceMessageId: lines[0].r.messageId || "" };

    let fresh;
    try {
      fresh = await reEvaluate(item);
    } catch (err) {
      return done("database_error", `recheck_failed: ${err.message}`, gm);
    }
    if (!fresh.current) return done("already_processed", "no_longer_pending", gm);
    if (fresh.registryProblem) return done("ambiguous_mapping", fresh.registryProblem, gm);
    if (!fresh.current.mappingSafe) return done("ambiguous_mapping", fresh.current.skipReason, gm);
    const slot = fresh.current.pendingPayments.find((p) => p.autoProcess);
    if (!slot || slot.paymentType !== "cash") return done("ambiguous_mapping", "no_auto_processable_payment", gm);

    const now = deps.now ? deps.now() : Date.now();
    const dates = lines.map((x) => resolvePaidDate({ explicitDates: x.l.dates, sentDate: x.r.sentDate }, { approvalDate: fresh.current.approvalDate, now }));
    if (dates.some((x) => !x.date)) return done("ambiguous_mapping", "paid_date_not_determined", gm);
    if (new Set(dates.map((x) => x.date)).size > 1) return done("ambiguous_mapping", "conflicting_cash_paid_date", gm);
    const paid = dates[0];
    const nar = narrationFor(d.bankRows || [], item.landlords || [], { landOwnerId: slot.landOwnerId });
    const dateInfo = { paidDate: paid.date, paidDateSource: paid.source, paidDateNote: paid.note, narration: nar.narration };
    const summary = [{ kind: "rent", landlord: slot.landOwnerName, utr: "", paymentType: "cash", paymentMode: "Cash", ...dateInfo, sourceMessageId: lines[0].r.messageId }];
    const batch = {
      siteBillMode: fresh.current.siteBillMode,
      entryType: "rental",
      date: paid.date,
      remark: nar.narration || "", // Bank Narration only; no narration -> empty remark
      payments: [{ mediaId: fresh.current.mediaId, landOwnerId: slot.landOwnerId, rentalDueId: slot.rentalDueId, targetType: slot.targetType, paymentMode: "Cash", utrNumber: "" }],
    };
    if (ctx.dryRun) {
      const blockedBy = [];
      if (!(deps.saveEnabled ? deps.saveEnabled() : saveEnabled())) blockedBy.push("GMAIL_UTR_SAVE_ENABLED is off");
      if (!(deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv())) blockedBy.push("GMAIL_UTR_CASH_SAVE_ENABLED is off");
      return { ...base0(item), status: "found_and_saved", dryRun: true, reason: "dry_run_nothing_saved", ...gm, paymentType: "cash", mappingStatus: "safe", eligibleForSaving: true, savingBlockedBy: blockedBy, ...dateInfo, splitPayments: summary, wouldSave: { ...batch.payments[0], date: paid.date } };
    }
    try {
      const result = await saver(batch, actorOf(d, lines[0].r.messageId));
      const saved = (result?.data?.savedEntries || []).filter((e) => e.status === "saved");
      if (Number(result?.data?.sitesFailed || 0) > 0 || saved.length !== 1) {
        const why = (result?.data?.savedEntries || []).find((e) => e.status === "failed")?.error || "save_not_confirmed";
        return done("database_error", why, gm);
      }
      return done("found_and_saved", "", { ...gm, ...dateInfo, paymentType: "cash", splitPayments: summary, savedAmount: Number(saved[0].amount || 0) });
    } catch (err) {
      return done("database_error", err.message || "save_failed", gm);
    }
  }

  async function processOne(item, ctx, c) {
    const base = { billNumber: item.billNumber, ...(item.billKind ? { billKind: item.billKind } : {}), dueMonth: item.dueMonth || "", mediaId: item.mediaId, rentalDueIds: item.rentalDueIds, landOwnerId: (item.pendingPayments || []).find((p) => p.autoProcess)?.landOwnerId || item.pendingPayments?.[0]?.landOwnerId || "" };
    const done = async (status, reason = "", extra = {}) => {
      const entry = { ...base, status, reason, ...extra };
      if (["ambiguous_mapping", "multiple_review_required"].includes(status) && item._d) { const rl = replyLinesOf(item._d); if (rl.length) entry.replyLines = rl; }
      // A block decided BEFORE Gmail is touched (list rules, switches) is re-evaluated on every run: it costs no Gmail call, so it
      // is neither logged nor put in a cooldown (a stale "blocked" log must never hide a bill after a switch or rule changes).
      if (status === "ambiguous_mapping" && BLOCKED_BEFORE_GMAIL.has(reason)) entry.preGmail = true;
      else if (item._last && ["utr_not_found", "ambiguous_mapping"].includes(status) && item._last.status === status && item._last.reason === (reason || "")) {
        // re-read on every run and still the same answer: no new log row (bill_not_found is always logged: its backoff reads the log time)
      } else await writeLog(entry, ctx);
      return entry;
    };

    // New Bill / Advance Bill (media.arrearsDue[]): its own pending source, lookup mapping and save payload
    if (item.source === "arrears") return processArrears(item, ctx, c, done);

    // several landlords: per-landlord matching (dry run always, real save only behind its own switch)
    if (item.perLandlordMapping && item.perLandlordMapping.eligible) return processMulti(item, ctx, c, done);

    // GST on hold, one landlord: labelled "Rent - UTR" / "GST - UTR" lines, each payment saved on its own
    if (item.gstSplitMapping && item.gstSplitMapping.eligible) return processSplit(item, ctx, c, done);

    // GST on hold, SEVERAL landlords: "<landlord> - Rent|GST - UTR" lines, each payment saved on its own
    if (item.landlordGstMapping && item.landlordGstMapping.eligible) return processMultiGst(item, ctx, c, done);

    if (!item.mappingSafe) return done("ambiguous_mapping", item.skipReason || "mapping_not_safe");

    // Cash: the row only exists once saved and saving it marks it paid -> separate, explicit switch (real saves only)
    const planned = item.pendingPayments.find((p) => p.autoProcess);
    const cashSaveOn = deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv();
    if (!ctx.dryRun && planned?.paymentType === "cash" && !cashSaveOn) return done("ambiguous_mapping", "cash_auto_save_disabled");

    let found;
    try {
      found = await withTimeout(lookup(item.billNumber, undefined, { landlords: (item.landlords || []).map((l) => ({ landOwnerId: l.landOwnerId, name: l.name })) }), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status)); // auth problem: every next bill would fail too
      return e;
    }
    const d = found.data || {};
    item._d = d;
    const gm = { gmailThreadId: d.gmailThreadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}), sourceMessageId: d.sourceMessageId || "", senderEmail: d.senderEmail || "", messageDate: d.messageDate || "" };

    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "wrong_landlord_name") return done("ambiguous_mapping", "landlord_name_not_found", { landlordMappingProblems: (d.wrongNames || []).map((w) => ({ reason: "landlord_name_not_found", name: w.name })) });
    if (d.extractionStatus === "utr_not_found") {
      // a Cash payment has NO UTR: look for "Cash [- Paid Date: ..]" in the thread (only the paid date is stored)
      if (planned?.paymentType === "cash") return processCashLine(item, ctx, c, done);
      return done("utr_not_found");
    }
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_utr_or_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    if (d.extractionStatus !== "found" || !d.utr) return done("utr_not_found", "unexpected_lookup_result");

    const utr = String(d.utr).trim();
    if (!UTR_SHAPE.test(utr) || !/\d/.test(utr)) return done("utr_not_found", "invalid_utr", { utr, ...gm });
    // a landlord name written on the UTR line must be THE landlord of this bill, otherwise nothing is saved (no name = old format, accepted)
    // (a wrong-name line is simply ignored when a line with the RIGHT name, or no name, states the same UTR)
    const nameErrors = [];
    let nameOk = !(d.utrLineNames || []).length;
    for (const nm of d.utrLineNames || []) {
      const who = splitNameKind(nm, item.landlords || []).landlord;
      if (!who || classifyPaymentLabel(who)) { nameOk = true; continue; }
      const mm = matchLandlord(who, (item.landlords || []).map((l) => ({ landOwnerId: l.landOwnerId, name: l.name })));
      if (mm.error) nameErrors.push({ reason: mm.error, name: nm }); else nameOk = true;
    }
    if (!nameOk && nameErrors.length) return done("ambiguous_mapping", nameErrors[0].reason, { utr, ...gm, landlordMappingProblems: nameErrors });

    // ── re-check against MongoDB immediately before saving ──
    let fresh;
    try {
      fresh = await reEvaluate(item);
    } catch (err) {
      return done("database_error", `recheck_failed: ${err.message}`, { utr, ...gm });
    }
    if (!fresh.current) return done("already_processed", "no_longer_pending", { utr, ...gm });
    if (fresh.registryProblem) return done("ambiguous_mapping", fresh.registryProblem, { utr, ...gm });
    if (!fresh.current.mappingSafe) return done("ambiguous_mapping", fresh.current.skipReason, { utr, ...gm });
    if (utrAlreadyUsed(fresh.media, utr, { allowBills: commonBillsOf(d, utr) })) return done("ambiguous_mapping", "utr_already_used_on_this_site", { utr, ...gm });

    const slot = fresh.current.pendingPayments.find((p) => p.autoProcess); // exactly one rent slot (Cash or Online); never GST
    if (!slot) return done("ambiguous_mapping", "no_auto_processable_payment", { utr, ...gm });

    // Paid Date: explicit payment date in the reply, else the reply's sent date — never "now". Same window as the UI date picker.
    const paid = resolvePaidDate(d.paidDateInfo || {}, { approvalDate: fresh.current.approvalDate, now: deps.now ? deps.now() : Date.now() });
    if (!paid.date) return done("ambiguous_mapping", "paid_date_not_determined", { utr, ...gm, paidDateNote: paid.note });
    const nar = narrationFor(d.bankRows || [], fresh.current.landlords || item.landlords || [], { landOwnerId: slot.landOwnerId });
    const dateInfo = { paidDate: paid.date, paidDateSource: paid.source, paidDateNote: paid.note, narration: nar.narration, ...(nar.narration || !nar.reason || nar.reason === "no_narration_in_thread" ? {} : { narrationNote: nar.reason }), ...(paid.rejected.length ? { paidDateRejected: paid.rejected } : {}) };

    const batch = {
      siteBillMode: fresh.current.siteBillMode,
      entryType: "rental",
      date: paid.date,
      remark: nar.narration || "", // Bank Narration only; no narration -> empty remark
      payments: [
        {
          mediaId: fresh.current.mediaId,
          landOwnerId: slot.landOwnerId,
          rentalDueId: slot.rentalDueId,
          targetType: slot.targetType,
          paymentMode: slot.paymentMode,
          utrNumber: utr,
        },
      ],
    };

    if (ctx.dryRun) {
      const blockedBy = [];
      if (!(deps.saveEnabled ? deps.saveEnabled() : saveEnabled())) blockedBy.push("GMAIL_UTR_SAVE_ENABLED is off");
      if (slot.paymentType === "cash" && !(deps.cashSaveEnabled ? deps.cashSaveEnabled() : cashSaveEnabledEnv())) blockedBy.push("GMAIL_UTR_CASH_SAVE_ENABLED is off");
      return {
        ...base,
        status: "found_and_saved",
        dryRun: true,
        reason: "dry_run_nothing_saved",
        utr,
        ...gm,
        paymentType: slot.paymentType,
        mappingStatus: "safe",
        eligibleForSaving: true, // mapping, UTR, duplicate check and Paid Date are all fine
        savingBlockedBy: blockedBy, // server switches that still stop a real save
        ...dateInfo,
        wouldSave: { ...batch.payments[0], date: paid.date },
      };
    }

    try {
      const result = await saver(batch, senderName(d.senderEmail));
      const saved = (result?.data?.savedEntries || []).filter((e) => e.status === "saved");
      if (Number(result?.data?.sitesFailed || 0) > 0 || saved.length !== 1) {
        const why = (result?.data?.savedEntries || []).find((e) => e.status === "failed")?.error || "save_not_confirmed";
        return done("database_error", why, { utr, ...gm });
      }
      return done("found_and_saved", "", { utr, ...gm, ...dateInfo, paymentType: slot.paymentType, savedAmount: Number(saved[0].amount || 0) });
    } catch (err) {
      return done("database_error", err.message || "save_failed", { utr, ...gm });
    }
  }

  /**
   * CORRECTED UTR (see utrCorrection.js): bills the Gmail automation saved in the last GMAIL_UTR_CORRECTION_WINDOW_DAYS days (or the
   * bills named in opts.billNumbers) are read again; a later reply that clearly replaces the stored UTR of ONE payment overwrites
   * that payment's UTR. Dry run reports it and writes nothing. Real writes need GMAIL_UTR_SAVE_ENABLED and
   * GMAIL_UTR_CORRECTION_SAVE_ENABLED. Same engine for the API, the cron and the individual bill test.
   */
  const corrChecked = new Map();
  const correctionSwitch = () => (deps.correctionSaveEnabled ? deps.correctionSaveEnabled() : String(process.env.GMAIL_UTR_CORRECTION_SAVE_ENABLED || "").toLowerCase() === "true");
  async function processCorrections(ctx, opts, c, started) {
    const now = deps.now ? deps.now() : Date.now();
    const explicit = Array.isArray(opts.billNumbers) && opts.billNumbers.length ? opts.billNumbers.map(String) : null;
    const days = num(process.env.GMAIL_UTR_CORRECTION_WINDOW_DAYS, 7);
    const recheckMs = num(process.env.GMAIL_UTR_CORRECTION_RECHECK_MIN, 10) * 60000;
    const maxBills = num(opts.maxCorrectionBills, num(process.env.GMAIL_UTR_CORRECTION_MAX_BILLS, 20));
    const saveOn = deps.saveEnabled ? deps.saveEnabled() : saveEnabled();
    const switchOn = saveOn && correctionSwitch();
    const out = [];

    // candidate bills: the ones this automation saved recently (distinct, newest first), or the named ones
    const cand = new Map();
    if (explicit) explicit.forEach((b) => cand.set(b, ""));
    const rows = await getLog()
      .find({ status: { $in: ["found_and_saved", "correction_applied"] }, dryRun: false, ...(explicit ? { billNumber: { $in: explicit } } : { createdAt: { $gte: new Date(now - days * 86400000) } }) })
      .sort({ createdAt: -1 })
      .select("billNumber mediaId")
      .lean();
    rows.forEach((r) => { if (r.billNumber && !cand.get(r.billNumber)) cand.set(r.billNumber, r.mediaId || ""); });

    let handled = 0;
    for (const [billNumber, logMediaId] of cand) {
      if (handled >= maxBills || Date.now() - started > c.runBudgetMs) break;
      if (!explicit && !opts.force && now - (corrChecked.get(billNumber) || 0) < recheckMs) continue;
      corrChecked.set(billNumber, now);
      handled += 1;
      try {
        let media = null;
        if (logMediaId) media = await getMedia().findById(logMediaId).lean();
        if (!media && explicit && getMedia().find) {
          const found = await getMedia().find({ $or: [{ rentalDue: { $elemMatch: { [billField()]: billNumber } } }, { arrearsDue: { $elemMatch: { adinn_ooh_bills: billNumber } } }] }).lean();
          media = found && found.length === 1 ? found[0] : null;
        }
        if (!media) { out.push({ billNumber, status: "correction_skipped", reason: "bill_not_found_in_database" }); continue; }
        const stored = storedPayments(media, billNumber, billField());
        if (!stored.slots.size) continue; // nothing paid with a UTR on this bill: nothing to correct
        const th = await withTimeout((deps.lookupThread || lookupBillThread)(billNumber), c.gmailTimeoutMs, "Gmail lookup");
        if (th.status !== "ok") { out.push({ billNumber, status: "correction_skipped", reason: th.status, gmailThreadId: th.threadId || "" }); continue; }
        const rowOfBill = (media.rentalDue || []).filter((r) => r && String(r[billField()] || "").trim() === billNumber);
        if (stored.flow === "rental") {
          const problem = await registryCheck(billNumber, media, rowOfBill);
          if (problem) { out.push({ billNumber, status: "correction_skipped", reason: problem, gmailThreadId: th.threadId || "" }); continue; }
        }
        const plan = planCorrections(utrStatements(th.messages, th.approval), stored);
        const approvalDate = stored.flow === "rental"
          ? (rowOfBill[0] || {}).ownerApprovalDate
          : ((media.arrearsDue || []).find((b) => String(b.adinn_ooh_bills || "").trim() === billNumber) || {}).ownerApprovalDate;
        const head = { billNumber, mediaId: String(media._id), billKind: stored.flow === "rental" ? "" : stored.flow, dueMonth: (rowOfBill[0] || {}).dueMonth || "", gmailThreadId: th.threadId || "" };

        for (const rv of plan.review) {
          out.push({ ...head, status: "correction_review", reason: rv.reason, landlord: rv.landlord || rv.name || "", paymentKind: rv.kind || "", sourceMessageId: rv.messageId || "", eligible: false });
          if (!ctx.dryRun && rv.messageId && !(await getLog().findOne({ billNumber, status: "correction_review", sourceMessageId: rv.messageId, reason: rv.reason }).lean())) {
            await writeLog({ billNumber, status: "correction_review", reason: rv.reason, mediaId: head.mediaId, billKind: head.billKind, gmailThreadId: head.gmailThreadId, sourceMessageId: rv.messageId, correction: { landlord: rv.landlord || rv.name || "", kind: rv.kind || "" } }, ctx);
          }
        }
        for (const corr of plan.corrections) {
          const st = corr.statement;
          const r = {
            ...head, dueMonth: [...corr.slot.months][0] || head.dueMonth, landlord: corr.slot.landlord, landOwnerId: corr.slot.landOwnerId, paymentKind: corr.slot.kind,
            existingUtr: corr.from, correctedUtr: corr.to, sourceMessageId: st.messageId, senderEmail: st.from, messageDate: st.at,
          };
          if (!UTR_SHAPE.test(corr.to) || !/\d/.test(corr.to)) { out.push({ ...r, status: "correction_review", reason: "invalid_utr", eligible: false }); continue; }
          if (!ctx.dryRun && (await getLog().findOne({ billNumber, status: "correction_applied", sourceMessageId: st.messageId, landOwnerId: corr.slot.landOwnerId }).lean())) {
            out.push({ ...r, status: "correction_already_applied", reason: "same_mail_already_processed", eligible: false });
            continue;
          }
          if (utrAlreadyUsed(media, corr.to)) { out.push({ ...r, status: "correction_review", reason: "utr_already_used_on_this_site", eligible: false }); continue; }
          const w = buildCorrectionWrite(corr, stored, { approvalDate, now });
          const info = { ...r, eligible: true, wouldUpdate: { records: w.records, paidDate: w.paidDate || "kept", remark: w.narration ? "narration" : "kept", updatedBy: w.updatedBy } };
          if (ctx.dryRun || !switchOn) {
            const blocked = [];
            if (!saveOn) blocked.push("GMAIL_UTR_SAVE_ENABLED is off");
            if (!correctionSwitch()) blocked.push("GMAIL_UTR_CORRECTION_SAVE_ENABLED is off");
            out.push({ ...info, status: "correction_found", dryRun: ctx.dryRun, reason: ctx.dryRun ? "dry_run_nothing_saved" : "correction_save_disabled", savingBlockedBy: blocked });
            continue;
          }
          const res = await getMedia().updateOne({ _id: media._id, ...w.filter }, { $set: w.set }, { strict: false });
          const changed = Number(res && (res.modifiedCount ?? res.nModified ?? 0));
          if (!changed) { out.push({ ...info, status: "database_error", reason: "changed_concurrently_nothing_written", eligible: false }); continue; }
          await writeLog({ billNumber, status: "correction_applied", mediaId: head.mediaId, billKind: head.billKind, dueMonth: r.dueMonth, landOwnerId: corr.slot.landOwnerId, utr: corr.to, gmailThreadId: th.threadId || "", sourceMessageId: st.messageId, senderEmail: st.from, messageDate: st.at, paymentType: corr.slot.kind, paidDate: w.paidDate || "", correction: { kind: corr.slot.kind, landlord: corr.slot.landlord, oldUtr: corr.from, newUtr: corr.to, records: w.records, paidDateChanged: !!w.paidDate, remarkChanged: !!w.narration, updatedBy: w.updatedBy } }, ctx);
          out.push({ ...info, status: "correction_applied", reason: "" });
        }
      } catch (err) {
        out.push({ billNumber, status: "correction_error", reason: err.message || "failed" });
        if ([401, 403].includes(Number(err.status))) break;
      }
    }
    return out;
  }

  async function processPendingUtrs(opts = {}) {
    const c = cfg();
    const dryRun = opts.dryRun !== false || !(deps.saveEnabled ? deps.saveEnabled() : saveEnabled());
    const ctx = { dryRun, triggeredBy: opts.triggeredBy || "api", runId: crypto.randomBytes(6).toString("hex") };
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const emit = deps.runLog || writeRunLog;

    const skipRun = (reason) => {
      emit(buildRunSummary({ ctx, startedAt, started, skipped: true, reason }));
      logger.log(`[gmail-utr] run ${ctx.runId} SKIPPED (${reason})`);
      return { runId: ctx.runId, dryRun, skipped: true, reason, results: [] };
    };
    if (activeRun) return skipRun("another_run_in_progress");
    activeRun = true;

    let Counter = null;
    if (!dryRun) {
      try {
        Counter = getCounter();
        if (!(await acquireLock(Counter, c.lockTtlMs))) { activeRun = false; return skipRun("another_run_in_progress"); }
      } catch (err) {
        activeRun = false;
        throw err;
      }
    }

    const results = [];
    let aborted = null;
    let consecutiveGmailErrors = 0;
    try {
      // all months by default; current month only when asked (body currentMonthOnly:true, or env GMAIL_UTR_CURRENT_MONTH_ONLY=true)
      const currentMonthOnly = opts.currentMonthOnly === true || String(process.env.GMAIL_UTR_CURRENT_MONTH_ONLY || "").toLowerCase() === "true";
      let list = await pending({ billNumbers: opts.billNumbers, limit: 2000, currentMonthOnly }, deps.pendingDeps || {});
      // New Bill / Advance Bill (media.arrearsDue[]) are processed in the same run; a failure here never stops the Rental Bills
      if (deps.getPendingArrears || !deps.getPending) {
        try {
          const ar = await (deps.getPendingArrears || getPendingArrearsUtrBills)({ billNumbers: opts.billNumbers, limit: 2000, currentMonthOnly }, deps.pendingDeps || {});
          if (ar && ar.bills && ar.bills.length) list = { ...list, bills: [...list.bills, ...ar.bills], totalPending: Number(list.totalPending || 0) + Number(ar.totalPending || 0) };
        } catch (err) {
          logger.error("[gmail-utr] New Bill / Advance list failed:", err.message);
        }
      }
      const maxBills = Math.min(num(opts.maxBills, c.maxBills), 500);
      let handled = 0;
      for (const item of list.bills) {
        if (handled >= maxBills) break;
        if (Date.now() - started > c.runBudgetMs) {
          aborted = "run_time_budget_reached";
          break;
        }
        if (!opts.force && (await inCooldown(item, c))) continue;
        const r = await processOne(item, ctx, c);
        if (!r.preGmail) handled += 1; // blocks that never touched Gmail do not use up the per-run limit
        results.push(r);
        if (r.status === "gmail_error") {
          consecutiveGmailErrors += 1;
          if (r.fatal) { aborted = "gmail_authentication_failed"; break; }
          if (consecutiveGmailErrors >= 3) { aborted = "too_many_gmail_errors"; break; }
        } else {
          consecutiveGmailErrors = 0;
        }
      }
      // paid bills: a later Finance reply may correct the stored UTR (same engine for API / cron / single-bill test); never stops the run
      let corrections = [];
      if (opts.corrections !== false && deps.correctionCheck !== false && (deps.correctionCheck || !deps.getPending) && String(process.env.GMAIL_UTR_CORRECTION_CHECK_ENABLED ?? "true").toLowerCase() !== "false" && !aborted) {
        try { corrections = await processCorrections(ctx, opts, c, started); } catch (err) { logger.error("[gmail-utr] correction check failed:", err.message); }
      }
      const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
      const summary = buildRunSummary({ ctx, startedAt, started, scope: list.scope, pendingTotal: list.totalPending, results, aborted, corrections });
      emit(summary);
      logger.log(`[gmail-utr] run ${ctx.runId} ${summary.mode} start=${summary.startedAt} end=${summary.finishedAt} (${summary.durationMs} ms) scope="${list.scope}" pending=${list.totalPending} processed=${results.length} ${JSON.stringify(counts)}${aborted ? ` ABORTED:${aborted}` : ""}`);
      results.filter((r) => !r.preGmail).forEach((r) => logger.log(`[gmail-utr]   ${r.billNumber}${r.dueMonth ? ` [${r.dueMonth}]` : ""} -> ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.utr ? ` utr=${maskUtr(r.utr)} paidDate=${r.paidDate || "-"} [${r.paidDateSource || "-"}] ${r.paymentType || ""}` : ""}${r.landlordMappings ? " " + r.landlordMappings.map((m) => `${m.landlord}=${maskUtr(m.utr)} paid ${m.paidDate} [${m.paidDateSource}] ${m.paymentMode}`).join(" | ") : ""}${r.splitPayments ? " " + r.splitPayments.map((m) => `${m.landlord ? m.landlord + " " : ""}${m.kind}=${maskUtr(m.utr)} paid ${m.paidDate} [${m.paidDateSource}]`).join(" | ") + (r.pendingKinds ? ` (still waiting: ${r.pendingKinds.join(",")})` : "") : ""}`));
      corrections.filter((x) => x.status !== "correction_skipped").forEach((x) => logger.log(`[gmail-utr]   CORRECTION ${x.billNumber} -> ${x.status}${x.reason ? ` (${x.reason})` : ""}${x.correctedUtr ? ` ${x.landlord} ${x.paymentKind} ${maskUtr(x.existingUtr)} => ${maskUtr(x.correctedUtr)}` : ""}`));
      if (Object.keys(summary.blockedBeforeGmail).length) logger.log(`[gmail-utr]   blocked before Gmail (manual review / switches off, re-checked every run, no Gmail call): ${JSON.stringify(summary.blockedBeforeGmail)}`);
      return { runId: ctx.runId, dryRun, triggeredBy: ctx.triggeredBy, startedAt: summary.startedAt, finishedAt: summary.finishedAt, scope: list.scope, pendingTotal: list.totalPending, processed: results.length, counts, aborted, results, corrections };
    } catch (err) {
      emit(buildRunSummary({ ctx, startedAt, started, error: err.message }));
      logger.error(`[gmail-utr] run ${ctx.runId} FAILED: ${err.message}`);
      throw err;
    } finally {
      activeRun = false;
      if (Counter) {
        try { await releaseLock(Counter); } catch (err) { logger.error("[gmail-utr] could not release lock:", err.message); }
      }
    }
  }

  return { processPendingUtrs, processOne, reEvaluate, processCorrections };
}

let instance = null;
const proc = () => (instance = instance || createUtrProcessor());

module.exports = {
  createUtrProcessor,
  processPendingUtrs: (opts) => proc().processPendingUtrs(opts),
  saveEnabled,
  writeRunLog,
  buildRunSummary,
  acquireLock,
  releaseLock,
  utrAlreadyUsed,
  LOCK_ID,
};
