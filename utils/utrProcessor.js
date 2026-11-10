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
const { lookupUtrByBillNumber, lookupLandlordUtrs } = require("./gmailUtrLookup");
const { mapLandlords, mapLandlordKinds, mapPaymentKinds, validateAgainstMail, matchLandlord } = require("./landlordUtrParser");
const { resolvePaidDate } = require("./utrPaidDate");

const LOCK_ID = "gmail_utr_lock";

// ambiguous_mapping reasons that are decided without reading Gmail (list rules + switches)
const BLOCKED_BEFORE_GMAIL = new Set([
  "duplicate_bill_number", "media_inactive", "multiple_landlords", "separate_landlord_bills", "gst_separate_utr",
  "rows_in_different_months", "separate_bill_site_rows", "no_rent_payment_pending", "no_single_rent_slot",
  "landlord_with_two_open_payments", "mapping_not_safe", "multi_landlord_auto_save_disabled", "cash_auto_save_disabled",
  "gst_split_auto_save_disabled", "no_gst_row", "multiple_gst_rows",
]);

// One run at a time inside this process (dry or live). A LIVE run additionally takes the cross-instance DB lock;
// a DRY run writes nothing to MongoDB at all (no lock row, no log row).
let activeRun = false;

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
function buildRunSummary({ ctx, startedAt, started, scope, pendingTotal, results, aborted, skipped, reason, error }) {
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
    matchedBills: results.filter((r) => r.utr || r.landlordMappings || r.splitPayments).map((r) => ({
      billNumber: r.billNumber, dueMonth: r.dueMonth || "", status: r.status, reason: r.reason || "", utr: r.utr, paidDate: r.paidDate || null, paidDateSource: r.paidDateSource || null,
      paymentType: r.paymentType || null, eligibleForSaving: r.eligibleForSaving ?? null, savingBlockedBy: r.savingBlockedBy || [], gmailThreadId: r.gmailThreadId || "", landlordMappings: r.landlordMappings || undefined, splitPayments: r.splitPayments || undefined,
    })),
    skippedBills: results.filter((r) => !r.utr && !r.landlordMappings && !r.splitPayments).map((r) => ({ billNumber: r.billNumber, dueMonth: r.dueMonth || "", status: r.status, reason: r.reason || "" })),
    errors: results.filter((r) => r.status === "gmail_error" || r.status === "database_error").map((r) => ({ billNumber: r.billNumber, dueMonth: r.dueMonth || "", status: r.status, reason: r.reason || "" })),
  };
}
const UTR_SHAPE = /^[A-Za-z0-9]{12,30}$/;

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
});

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
function utrAlreadyUsed(media, utr) {
  const same = (v) => String(v || "").trim().toLowerCase() === utr.toLowerCase();
  if ((media.ledger || []).some((e) => same(e.utrNumber))) return true;
  if ((media.withGst1Ledger || []).some((e) => same(e.utrNumber))) return true;
  if ((media.gstBalanceHistory || []).some((e) => same(e.utrNumber))) return true;
  for (const y of media.ledgerHistory || []) {
    for (const m of y.months || []) if ((m.entries || []).some((e) => same(e.utrNumber))) return true;
  }
  return false;
}

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
    ((batch) => require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller").executeBulkPaymentBatch({ user: { userName: "Gmail UTR Auto" } }, batch));

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
    if (!last) return false;
    const age = Date.now() - new Date(last.createdAt).getTime();
    // Outcomes that came from READING Gmail (no UTR yet, a reply that could not be matched, several UTRs ...) are re-checked
    // after the SHORT cooldown, because finance corrects replies within minutes. Only blocks decided BEFORE Gmail is touched
    // (GST, several landlords with the switch off, ...) use the long cooldown: they cost no Gmail call and nothing can change soon.
    if (["bill_not_found", "utr_not_found", "gmail_error", "multiple_review_required"].includes(last.status)) return age < c.notFoundCooldownMs;
    if (last.status === "ambiguous_mapping") return BLOCKED_BEFORE_GMAIL.has(last.reason) ? false : age < c.notFoundCooldownMs;
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
    const anyCash = pendingLandlords.some((l) => l.paymentMode === "Cash");

    if (!ctx.dryRun) {
      if (!multiOn) return done("ambiguous_mapping", "multi_landlord_auto_save_disabled");
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
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    if (d.extractionStatus !== "found" || !(d.replies || []).length) return done("utr_not_found");
    // A reply whose lines name NOBODY of this bill (every name is "not found", e.g. a mail pasted from another bill) is not
    // about this bill: it is ignored and reported. Every other reply counts. Finance must send ALL landlords in ONE mail,
    // so UTR lines spread over several relevant replies are never combined.
    const landlordsNow = item.perLandlordMapping.landlords;
    const aboutThisBill = (r) => r.lines.some((l) => matchLandlord(l.name, landlordsNow).error !== "landlord_name_not_found");
    const relevant = d.replies.filter(aboutThisBill);
    const ignored = d.replies.filter((r) => !relevant.includes(r)).map((r) => ({ messageId: r.messageId, reason: "names_match_no_landlord_of_this_bill", names: r.lines.map((l) => l.name) }));
    const used = relevant.length ? relevant : d.replies;
    if (used.length > 1) return done("ambiguous_mapping", "utrs_in_multiple_replies", { gmailThreadId: d.threadId || "", repliesWithLines: used.map((r) => r.messageId), ...(ignored.length ? { ignoredReplies: ignored } : {}) });
    const reply = used[0];
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

    const map = mapLandlords(reply.lines || [], pm.landlords);
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
      if (utrAlreadyUsed(fresh.media, utr)) return done("ambiguous_mapping", "utr_already_used_on_this_site", { ...gm, landlordMappingProblems: [{ reason: "utr_already_used_on_this_site", name: who }] });
      const slot = fresh.current.pendingPayments.find((p) => p.landOwnerId === mp.landlord.landOwnerId && (p.paymentType === "online_rent" || p.paymentType === "cash"));
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
        remark: `UTR auto-saved from Gmail reply (Bill ${item.billNumber}, thread ${d.threadId}, landlord ${p.landlord}). Paid date from ${p.paidDateSource === "email_payment_date" ? "the payment date stated in the email" : "the email sent date — verify"}`,
        payments: [{ mediaId: fresh.current.mediaId, landOwnerId: p.slot.landOwnerId, rentalDueId: p.slot.rentalDueId, targetType: p.slot.targetType, paymentMode: p.slot.paymentMode, utrNumber: p.utr }],
      };
      try {
        const result = await saver(batch);
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
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    if (d.extractionStatus !== "found" || !(d.replies || []).length) return done("utr_not_found");
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

    const map = mapPaymentKinds(d.replies);
    const now = deps.now ? deps.now() : Date.now();
    const plan = [];
    const notYet = [];
    const blocked = [];
    for (const slot of sm.slots) {
      if (map.dupBoth) { blocked.push({ kind: slot.kind, reason: "duplicate_utr" }); continue; }
      if (map.conflicts.includes(slot.kind)) { blocked.push({ kind: slot.kind, reason: "conflicting_utr_for_kind" }); continue; }
      const m = map.byKind[slot.kind];
      if (!m) { notYet.push(slot.kind); continue; } // no labelled line yet: this payment simply stays pending
      if (!UTR_SHAPE.test(m.utr) || !/\d/.test(m.utr)) { blocked.push({ kind: slot.kind, reason: "invalid_utr" }); continue; }
      if (utrAlreadyUsed(fresh.media, m.utr)) { blocked.push({ kind: slot.kind, reason: "utr_already_used_on_this_site" }); continue; }
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
    const extra = { ...gm, ...(notYet.length ? { pendingKinds: notYet } : {}), ...(blocked.length ? { blockedKinds: blocked } : {}), ...(map.ignored.length ? { ignoredLines: map.ignored } : {}) };
    if (!plan.length) {
      if (blocked.length) return done("ambiguous_mapping", blocked[0].reason, extra);
      return done("utr_not_found", "", extra);
    }
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
        remark: `${isGst ? "GST" : "Rent"} UTR auto-saved from Gmail reply (Bill ${item.billNumber}, thread ${d.threadId}). Paid date from ${p.paidDateSource === "email_payment_date" ? "the payment date stated in the email" : "the email sent date — verify"}`,
        payments: [{ mediaId: fresh.current.mediaId, landOwnerId: p.slot.landOwnerId, rentalDueId: p.slot.rentalDueId, targetType: p.slot.targetType, paymentMode: p.slot.paymentMode || "Online", utrNumber: p.utr }],
      };
      try {
        const result = await saver(batch);
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
    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    if (d.extractionStatus !== "found" || !(d.replies || []).length) return done("utr_not_found");
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
    if (map.problems.length) return done("ambiguous_mapping", map.problems[0].reason, { ...gm, landlordMappingProblems: map.problems, ...(map.ignored.length ? { ignoredLines: map.ignored } : {}) });
    // one UTR can pay only one payment: the same UTR on two payments blocks the whole bill
    const owners = new Map();
    for (const [key, list] of map.byKey) for (const u of new Set(list.map((x) => x.utr.toUpperCase()))) owners.set(u, [...(owners.get(u) || []), key]);
    const dup = [...owners.entries()].find(([, keys]) => keys.length > 1);
    if (dup) return done("ambiguous_mapping", "duplicate_utr", { ...gm, landlordMappingProblems: [{ reason: "duplicate_utr", payments: dup[1] }] });

    const now = deps.now ? deps.now() : Date.now();
    const plan = [];
    const notYet = [];
    const blocked = [];
    for (const slot of mg.slots) {
      const key = `${slot.landOwnerId}|${slot.kind}`;
      const who = { landlord: slot.landOwnerName, kind: slot.kind };
      const list = map.byKey.get(key) || [];
      const distinct = [...new Set(list.map((x) => x.utr.toUpperCase()))];
      if (!distinct.length) { notYet.push(who); continue; } // no line yet: this payment simply stays pending
      if (distinct.length > 1) { blocked.push({ ...who, reason: "conflicting_utr_for_landlord_payment" }); continue; }
      const m = list[0];
      if (!UTR_SHAPE.test(m.utr) || !/\d/.test(m.utr)) { blocked.push({ ...who, reason: "invalid_utr" }); continue; }
      if (utrAlreadyUsed(fresh.media, m.utr)) { blocked.push({ ...who, reason: "utr_already_used_on_this_site" }); continue; }
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
    const extra = { ...gm, ...(notYet.length ? { pendingPayments: notYet } : {}), ...(blocked.length ? { blockedPayments: blocked } : {}), ...(map.ignored.length ? { ignoredLines: map.ignored } : {}) };
    if (!plan.length) {
      if (blocked.length) return done("ambiguous_mapping", blocked[0].reason, extra);
      return done("utr_not_found", "", extra);
    }
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
        remark: `${p.landlord} ${isGst ? "GST" : "Rent"} UTR auto-saved from Gmail reply (Bill ${item.billNumber}, thread ${d.threadId}). Paid date from ${p.paidDateSource === "email_payment_date" ? "the payment date stated in the email" : "the email sent date — verify"}`,
        payments: [{ mediaId: fresh.current.mediaId, landOwnerId: p.slot.landOwnerId, rentalDueId: p.slot.rentalDueId, targetType: p.slot.targetType, paymentMode: p.slot.paymentMode || "Online", utrNumber: p.utr }],
      };
      try {
        const result = await saver(batch);
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

  async function processOne(item, ctx, c) {
    const base = { billNumber: item.billNumber, dueMonth: item.dueMonth || "", mediaId: item.mediaId, rentalDueIds: item.rentalDueIds, landOwnerId: (item.pendingPayments || []).find((p) => p.autoProcess)?.landOwnerId || item.pendingPayments?.[0]?.landOwnerId || "" };
    const done = async (status, reason = "", extra = {}) => {
      const entry = { ...base, status, reason, ...extra };
      // A block decided BEFORE Gmail is touched (list rules, switches) is re-evaluated on every run: it costs no Gmail call, so it
      // is neither logged nor put in a cooldown (a stale "blocked" log must never hide a bill after a switch or rule changes).
      if (status === "ambiguous_mapping" && BLOCKED_BEFORE_GMAIL.has(reason)) entry.preGmail = true;
      else await writeLog(entry, ctx);
      return entry;
    };

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
      found = await withTimeout(lookup(item.billNumber), c.gmailTimeoutMs, "Gmail lookup");
    } catch (err) {
      const e = await done("gmail_error", err.message, { httpStatus: err.status || 0 });
      e.fatal = [401, 403].includes(Number(err.status)); // auth problem: every next bill would fail too
      return e;
    }
    const d = found.data || {};
    const gm = { gmailThreadId: d.gmailThreadId || "", ...(d.replyLink ? { replyLink: d.replyLink } : {}), sourceMessageId: d.sourceMessageId || "", senderEmail: d.senderEmail || "", messageDate: d.messageDate || "" };

    if (d.extractionStatus === "bill_not_found") return done("bill_not_found");
    if (d.extractionStatus === "utr_not_found") return done("utr_not_found");
    if (d.extractionStatus === "multiple_review_required") return done("multiple_review_required", "more_than_one_utr_or_conversation");
    if (d.extractionStatus === "ambiguous_bill_numbers") return done("ambiguous_mapping", "thread_mentions_other_bill_numbers");
    if (d.extractionStatus === "reply_not_linked") return done("ambiguous_mapping", d.linkReason || "reply_not_linked_to_approval_mail", { gmailThreadId: d.threadId || "", replyMessageIds: d.replyMessageIds || [] });
    if (d.extractionStatus !== "found" || !d.utr) return done("utr_not_found", "unexpected_lookup_result");

    const utr = String(d.utr).trim();
    if (!UTR_SHAPE.test(utr) || !/\d/.test(utr)) return done("utr_not_found", "invalid_utr", { utr, ...gm });

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
    if (utrAlreadyUsed(fresh.media, utr)) return done("ambiguous_mapping", "utr_already_used_on_this_site", { utr, ...gm });

    const slot = fresh.current.pendingPayments.find((p) => p.autoProcess); // exactly one rent slot (Cash or Online); never GST
    if (!slot) return done("ambiguous_mapping", "no_auto_processable_payment", { utr, ...gm });

    // Paid Date: explicit payment date in the reply, else the reply's sent date — never "now". Same window as the UI date picker.
    const paid = resolvePaidDate(d.paidDateInfo || {}, { approvalDate: fresh.current.approvalDate, now: deps.now ? deps.now() : Date.now() });
    if (!paid.date) return done("ambiguous_mapping", "paid_date_not_determined", { utr, ...gm, paidDateNote: paid.note });
    const dateInfo = { paidDate: paid.date, paidDateSource: paid.source, paidDateNote: paid.note, ...(paid.rejected.length ? { paidDateRejected: paid.rejected } : {}) };

    const batch = {
      siteBillMode: fresh.current.siteBillMode,
      entryType: "rental",
      date: paid.date,
      remark: `UTR auto-saved from Gmail reply (Bill ${item.billNumber}, thread ${d.gmailThreadId}). Paid date from ${paid.source === "email_payment_date" ? "the payment date stated in the email" : "the email sent date — verify"}`,
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
      const result = await saver(batch);
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
      const list = await pending({ billNumbers: opts.billNumbers, limit: 2000, currentMonthOnly }, deps.pendingDeps || {});
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
      const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
      const summary = buildRunSummary({ ctx, startedAt, started, scope: list.scope, pendingTotal: list.totalPending, results, aborted });
      emit(summary);
      logger.log(`[gmail-utr] run ${ctx.runId} ${summary.mode} start=${summary.startedAt} end=${summary.finishedAt} (${summary.durationMs} ms) scope="${list.scope}" pending=${list.totalPending} processed=${results.length} ${JSON.stringify(counts)}${aborted ? ` ABORTED:${aborted}` : ""}`);
      results.filter((r) => !r.preGmail).forEach((r) => logger.log(`[gmail-utr]   ${r.billNumber}${r.dueMonth ? ` [${r.dueMonth}]` : ""} -> ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.utr ? ` utr=${maskUtr(r.utr)} paidDate=${r.paidDate || "-"} [${r.paidDateSource || "-"}] ${r.paymentType || ""}` : ""}${r.landlordMappings ? " " + r.landlordMappings.map((m) => `${m.landlord}=${maskUtr(m.utr)} paid ${m.paidDate} [${m.paidDateSource}] ${m.paymentMode}`).join(" | ") : ""}${r.splitPayments ? " " + r.splitPayments.map((m) => `${m.landlord ? m.landlord + " " : ""}${m.kind}=${maskUtr(m.utr)} paid ${m.paidDate} [${m.paidDateSource}]`).join(" | ") + (r.pendingKinds ? ` (still waiting: ${r.pendingKinds.join(",")})` : "") : ""}`));
      if (Object.keys(summary.blockedBeforeGmail).length) logger.log(`[gmail-utr]   blocked before Gmail (manual review / switches off, re-checked every run, no Gmail call): ${JSON.stringify(summary.blockedBeforeGmail)}`);
      return { runId: ctx.runId, dryRun, triggeredBy: ctx.triggeredBy, startedAt: summary.startedAt, finishedAt: summary.finishedAt, scope: list.scope, pendingTotal: list.totalPending, processed: results.length, counts, aborted, results };
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

  return { processPendingUtrs, processOne, reEvaluate };
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
