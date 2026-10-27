// ─────────────────────────────────────────────────────────────
// Appraisal AMOUNT REVISIONS.
//
// In this system an appraisal is a scheduled rent increase. Every scheduled / applied increase is its own stored row in
// `media.appraisal.history[]` (appraisalDate, type, percentage, fixedAmount, previousRent, appraisalAmount, newRent). The
// site-level `appraisal.type / percentage / fixedAmount` is only the rule that NEW rows are created from.
//
// A "revision" is the company changing that rule (e.g. fixed ₹2,000 → ₹1,000). It is an audit event stored in
// `media.appraisal.revisionHistory[]`; it is NOT an appraisal transaction and never changes a stored history row by itself.
// Which rows take the new rule is decided here:
//   • rows before the current month ......... never touched (already applied — the existing rule, unchanged)
//   • rows whose bill is APPROVED ............ frozen: keep their stored amount
//   • rows that are on CMD hold (pending) ..... frozen: keep their stored amount
//   • the current month's open row + future rows ... take the new rule (existing behaviour)
// Pure functions only — no database access — so they are unit-tested without a connection.
// ─────────────────────────────────────────────────────────────

const monthKeyOf = (input) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Same formula as computeAppraisalAmount in the onboarding controller / schema (floored). */
const computeAmount = (cfg, rent) => {
  if (Number(cfg?.type) === 1) return Math.floor((num(rent) * num(cfg.percentage)) / 100);
  if (Number(cfg?.type) === 2) return Math.floor(num(cfg.fixedAmount));
  return 0;
};

/** Did the amount rule (type / percentage / fixed amount) change? Frequency-only edits are not an amount revision. */
const amountConfigChanged = (previous, next) =>
  Number(previous?.type) !== Number(next?.type) ||
  num(previous?.percentage) !== num(next?.percentage) ||
  num(previous?.fixedAmount) !== num(next?.fixedAmount);

/** Month keys of the site's bills that are already approved (approvalStatus 3), from `rentalDue[]`. */
const approvedMonthKeys = (rentalDue) => {
  const out = new Set();
  for (const e of rentalDue || []) {
    if (e && Number(e.approvalStatus) === 3 && e.dueDate) {
      const k = monthKeyOf(e.dueDate);
      if (k !== null) out.add(k);
    }
  }
  return out;
};

/**
 * Is this history row protected from a revision? (Rows before the current month are never offered to a revision at all.)
 * ctx: { approvedMonths:Set, held:boolean, holdDate:Date|null, currentMonthKey:number }
 */
const isEntryFrozen = (entry, ctx) => {
  const k = monthKeyOf(entry.appraisalDate);
  if (k === null) return false;
  if (ctx.approvedMonths && ctx.approvedMonths.has(k)) return true;
  if (ctx.held) {
    const hold = ctx.holdDate ? new Date(ctx.holdDate) : null;
    // same definition as the Report Analytics "held" kind: on/after the hold date (no date stored → after this month)
    if (hold && !Number.isNaN(hold.getTime())) return new Date(entry.appraisalDate) >= hold;
    return k > ctx.currentMonthKey;
  }
  return false;
};

/**
 * Applies the revised rule to the rows that may take it (mutates [history]). Returns { affected, frozen } (row references).
 * The current month's open row is flagged `_configEdited` so cascadeHistory recomputes it on the same base — the existing rule.
 */
const applyConfigToHistory = (history, next, ctx, { userName, now } = {}) => {
  const affected = [];
  const frozen = [];
  for (const entry of history) {
    const k = monthKeyOf(entry.appraisalDate);
    if (k === null) continue;
    const takesRule = k > ctx.currentMonthKey || (k === ctx.currentMonthKey && !entry.isAnchorEntry);
    if (!takesRule) continue;
    if (isEntryFrozen(entry, ctx)) {
      frozen.push(entry);
      continue;
    }
    entry.type = next.type;
    entry.percentage = next.percentage || 0;
    entry.fixedAmount = num(next.fixedAmount);
    entry.frequency = Number(next.frequency);
    entry.customFrequencyMonths = num(next.customFrequencyMonths);
    entry.updatedBy = userName;
    entry.updatedAt = now;
    if (k === ctx.currentMonthKey) entry._configEdited = true;
    affected.push(entry);
  }
  return { affected, frozen };
};

/**
 * The audit record of one revision, or null when the amount rule did not change.
 * previousAmount / newAmount are the per-appraisal amounts of the old / new rule on [baseRent] (the rent in force).
 */
const buildRevision = ({ previous, next, baseRent, changedBy, changedAt, reason, effectiveFrom }) => {
  if (!amountConfigChanged(previous, next)) return null;
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return {
    changedAt,
    changedBy: changedBy || "",
    reason: trimmed,
    previousType: previous?.type ?? null,
    previousPercentage: num(previous?.percentage),
    previousFixedAmount: num(previous?.fixedAmount),
    newType: next?.type ?? null,
    newPercentage: num(next?.percentage),
    newFixedAmount: num(next?.fixedAmount),
    baseRent: num(baseRent),
    previousAmount: computeAmount(previous, baseRent),
    newAmount: computeAmount(next, baseRent),
    effectiveFrom: effectiveFrom || null,
  };
};

/** The revision that governs a history row: the latest one whose effectiveFrom is on/before the row's date. */
const revisionForEntry = (revisions, entryDate) => {
  const d = new Date(entryDate);
  if (Number.isNaN(d.getTime())) return null;
  let best = null;
  for (const r of revisions || []) {
    if (!r || !r.effectiveFrom) continue;
    if (new Date(r.effectiveFrom) <= d && (!best || new Date(r.changedAt) > new Date(best.changedAt))) best = r;
  }
  return best;
};

module.exports = {
  amountConfigChanged,
  applyConfigToHistory,
  approvedMonthKeys,
  buildRevision,
  computeAmount,
  isEntryFrozen,
  monthKeyOf,
  revisionForEntry,
};
