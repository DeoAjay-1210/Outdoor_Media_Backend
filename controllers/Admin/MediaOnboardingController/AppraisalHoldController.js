// ─────────────────────────────────────────────────────────────
// APPRAISAL HOLD — CMD-only hold of a bill's appraisal amount, and the
// read-only hold remarks list. Moved out of RentalDueNew2Controller; the
// approval-mail part of the hold (sending the held bill without the
// appraisal) stays in RentalDueNew2Controller.sendRentalDueApprovalMail.
// Routes: rentalDueRoutes.js → POST /admin/appraisal-hold,
//         GET|POST /admin/appraisal-hold-remarks
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { ROLE } = require("../../../models/Admin/MediaOnboardingSchema/RentalDueModel");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

// ─────────────────────────────────────────────────────────────
// ✅ NEW — POST /admin/appraisal-hold   (CMD only)
// body: { mediaId, rentalDueId, appraisalHold: 1 | 0, remark? }
// Puts THIS bill's appraisal amount on hold (or releases it). A held bill's
// CMD approval mail is sent at the rent WITHOUT that month's appraisal and
// without the appraisal block (see sendRentalDueApprovalMail). Only the hold
// fields on the bill are written — rent, appraisal history, ledger and every
// other bill are unchanged.
// ─────────────────────────────────────────────────────────────
const appraisalMonthKey = (input) => {
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear() * 12 + d.getUTCMonth();
};

// the applied appraisal that started in this bill's month (null when none)
function findAppraisalForBillMonth(media, entry) {
  const dueKey = entry?.dueDate ? appraisalMonthKey(entry.dueDate) : null;
  if (dueKey === null) return null;
  return (
    (media?.appraisal?.history || [])
      .filter(
        (h) =>
          h &&
          !h.isAnchorEntry &&
          Number(h.appraisalAmount || 0) > 0 &&
          Number(h.previousRent || 0) > 0 &&
          appraisalMonthKey(h.appraisalDate) === dueKey,
      )
      .sort((a, b) => new Date(b.appraisalDate) - new Date(a.appraisalDate))[0] || null
  );
}

// ✅ NEW — amounts reduced while an appraisal is held (restored on release)
const RP_FIELDS = ["totalRentalAmount", "gstAmount", "netPayable", "totalRentalAmountWithGst"];
const OWNER_FIELDS = ["shareAmount", "onlineAmount", "cashAmount", "gstAmount", "tdsAmount", "totalAmountWithGst", "netPayableToOwner", "netPayable"];
const ENTRY_FIELDS = ["netPayable", "baseAmount", "gstAmount"];
const isNum = (v) => v !== undefined && v !== null && v !== "" && !Number.isNaN(Number(v));
const pickNums = (obj, fields) =>
  fields.reduce((acc, f) => {
    if (obj && isNum(obj[f])) acc[f] = Number(obj[f]);
    return acc;
  }, {});
const scaleNums = (values, ratio) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.round(v * ratio)]));
const sumOwners = (list, field) => (list || []).reduce((s, o) => s + Number(o[field] || 0), 0);

// ✅ NEW — the hold that applies to a bill: its own hold, or — for a later
// month's bill that is not approved yet — the hold of an EARLIER month that is
// still on hold (e.g. September held → October shows On Hold at 50k too).
// The inherited copy carries heldDueMonth / heldRentalDueId of that bill.
function effectiveAppraisalHold(media, entry) {
  const own = entry?.appraisalHold;
  if (own && Number(own.hold) === 1) return own;
  if (!entry?.dueDate || Number(entry.approvalStatus) === 3) return own || null;
  const entryKey = appraisalMonthKey(entry.dueDate);
  const ownReleasedAt = own?.releasedAt ? new Date(own.releasedAt).getTime() : 0;
  const held = (media?.rentalDue || [])
    .filter(
      (e) =>
        e &&
        String(e._id) !== String(entry._id) &&
        Number(e.appraisalHold?.hold) === 1 &&
        e.dueDate &&
        appraisalMonthKey(e.dueDate) < entryKey &&
        // a release recorded on this bill AFTER that hold ends it here
        !(ownReleasedAt && ownReleasedAt > new Date(e.appraisalHold.heldAt || 0).getTime()),
    )
    .sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate))[0];
  if (!held) return own || null;
  return { ...held.appraisalHold, heldDueMonth: held.dueMonth || "", heldRentalDueId: held._id };
}

// ✅ NEW — held months, CMD-approval based: the held month first, then each
// next month ONLY after the previous month's bill is CMD-approved
// (approvalStatus 3); stops at the first month not approved yet. e.g. Sep held
// (not approved) → [Sep]; Sep approved → [Sep, Oct]; Oct approved → + Nov.
// endKey (optional) = last month to consider. Same face as the held bill when
// bills are per face. Returns month labels in order.
function cmdApprovedHeldMonths(rentalDue, heldBill, endKey = Infinity) {
  const startKey = heldBill?.dueDate ? appraisalMonthKey(heldBill.dueDate) : null;
  if (startKey === null) return [heldBill?.dueMonth].filter(Boolean);
  const sameFace = (b) =>
    !heldBill.mediaDetailId || !b.mediaDetailId || String(b.mediaDetailId) === String(heldBill.mediaDetailId);
  const byMonth = new Map(); // monthKey → { label, approved }
  (rentalDue || []).filter(sameFace).forEach((b) => {
    const k = b.dueDate ? appraisalMonthKey(b.dueDate) : null;
    if (k === null || k < startKey || k > endKey) return;
    const m = byMonth.get(k) || { label: b.dueMonth, approved: false };
    if (Number(b.approvalStatus) === 3) m.approved = true;
    byMonth.set(k, m);
  });
  if (!byMonth.has(startKey)) byMonth.set(startKey, { label: heldBill.dueMonth, approved: Number(heldBill.approvalStatus) === 3 });
  const months = [];
  let prevApproved = true;
  for (const k of [...byMonth.keys()].sort((a, b) => a - b)) {
    if (!prevApproved) break;
    const m = byMonth.get(k);
    months.push(m.label);
    prevApproved = m.approved;
  }
  return months.filter(Boolean);
}

// a bill's hold / release list (oldest first). Bills without the stored list
// get it built from their latest hold + release fields.
function buildAppraisalHoldHistory(h) {
  if (!h) return [];
  if (Array.isArray(h.history) && h.history.length) return h.history.map((e) => ({ ...e }));
  const events = [];
  if (h.heldAt) {
    events.push({ action: "hold", reason: h.remark || "", by: h.heldBy || "", byUserId: h.heldByUserId || null, at: h.heldAt });
  }
  if (h.releasedAt) {
    events.push({ action: "release", reason: h.releaseReason || "", by: h.releasedBy || "", byUserId: null, at: h.releasedAt });
  }
  return events.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

// one bill → { success, statusCode, message, data }. Never throws for a business error.
async function processAppraisalHold({ mediaId, rentalDueId, hold, remark, user, releaseAmount = null }) {
  const fail = (statusCode, message) => ({ success: false, statusCode, message, mediaId: mediaId || null, rentalDueId: rentalDueId || null });
  if (!mongoose.Types.ObjectId.isValid(String(mediaId || "")) || !mongoose.Types.ObjectId.isValid(String(rentalDueId || ""))) {
    return fail(400, "Valid mediaId and rentalDueId are required");
  }
  if (![0, 1].includes(hold)) return fail(400, "appraisalHold must be 0 (hold) or 1 (release)");
  // ✅ NEW — release only: the appraisal amount applied from this release
  // (e.g. 6000 → rent 50k + 6k = 56k from the release bill on). Not sent → the
  // held appraisal amount, same as before.
  const relAmt =
    hold === 0 && releaseAmount !== null && releaseAmount !== undefined && releaseAmount !== ""
      ? Number(releaseAmount)
      : null;
  if (relAmt !== null && (!Number.isFinite(relAmt) || relAmt < 0)) {
    return fail(400, "releaseAmount must be 0 or more");
  }

  const media = await Media.findById(mediaId).select("rentalDue appraisal rentalPayment landOwners").lean();
  if (!media) return fail(404, "Media not found");
  const entry = (media.rentalDue || []).find((e) => String(e._id) === String(rentalDueId));
  if (!entry) return fail(404, "Rental due entry not found");
  // ✅ CHANGED — only PUTTING a bill on hold needs it to be not yet approved;
  // a held bill that got approved can still be released
  if (hold === 1 && Number(entry.approvalStatus) === 3) {
    return fail(400, "This bill is already fully approved — hold must be set before CMD approval");
  }

  const userName = user?.userName || "CMD";
  const existingHold = entry.appraisalHold || {};
  const rp = media.rentalPayment || {};
  const owners = media.landOwners || [];
  const $set = {};
  const $pull = {}; // ✅ NEW — only used by the re-raised repair
  let holdData;
  let appraisalDateShift = null; // ✅ NEW — release moved the appraisal date (response only)
  const $push = {}; // ✅ NEW — releaseAmount: rent history row
  let releaseInfo = null; // ✅ NEW — releaseAmount result (response only)
  let releaseMeta = null; // ✅ NEW — saved on the release event (remarks API)

  if (hold === 1) {
    // already on hold AND the site already reduced (by this hold or another) →
    // only the remark changes; amounts are never reduced twice. A hold saved
    // before the reduce logic existed (no siteReduced, site flag 0) falls
    // through and gets its reduction now.
    const alreadyReduced = existingHold.siteReduced || Number(media.appraisal?.appraisalHold) === 1;
    const snap = existingHold.amountsSnapshot;
    // ✅ NEW — the hold reduced the site, but something raised it back (e.g. a
    // server still on old code re-applied the appraisal): rent is back at the
    // "with appraisal" amount → write the held amounts again.
    const reRaised =
      Number(existingHold.hold) === 1 &&
      existingHold.siteReduced &&
      snap?.before?.rentalPayment &&
      Number(rp.totalRentalAmount || 0) === Number(snap.before.rentalPayment.totalRentalAmount || 0) &&
      Number(snap.after?.rentalPayment?.totalRentalAmount || 0) !== Number(rp.totalRentalAmount || 0);
    if (reRaised) {
      holdData = { ...existingHold, remark: remark || existingHold.remark || "" };
      Object.entries(snap.after.rentalPayment || {}).forEach(([k, v]) => { $set[`rentalPayment.${k}`] = v; });
      owners.forEach((o, i) => {
        const a = (snap.after.landOwners || []).find((x) => String(x._id) === String(o._id));
        if (!a) return;
        const { _id, ...vals } = a;
        Object.entries(vals).forEach(([k, v]) => { $set[`landOwners.${i}.${k}`] = v; });
      });
      Object.entries(snap.after.entry || {}).forEach(([k, v]) => { $set[`rentalDue.$[e].${k}`] = v; });
      $set["appraisal.appraisalHold"] = 1;
      // the wrong "(Appraisal applied - …)" rent-history rows written after the
      // hold by the re-apply are removed (they never really applied)
      $pull["rentalPayment.rentalAmountHistory"] = {
        updatedBy: { $regex: "\\(Appraisal applied - " },
        updatedAt: { $gt: new Date(existingHold.heldAt || 0) },
      };
      // ✅ CHANGED — appraisal applicable stays 1 while held (appraisalHold 1
      // already stops the save hook re-applying it)
    } else if (Number(existingHold.hold) === 1 && alreadyReduced) {
      holdData = { ...existingHold, remark: remark || existingHold.remark || "" };
    } else {
      const appraisal = findAppraisalForBillMonth(media, entry);
      if (!appraisal) {
        return fail(400, `No appraisal is applied in ${entry.dueMonth || "this month"} for this site — nothing to hold`);
      }
      const rentWithoutAppraisal = Math.round(Number(appraisal.previousRent || 0));
      const appraisalAmount = Math.round(Number(appraisal.appraisalAmount || 0));
      holdData = {
        hold: 1,
        appraisalAmount,
        rentWithAppraisal: Math.round(Number(appraisal.newRent || 0)) || rentWithoutAppraisal + appraisalAmount,
        rentWithoutAppraisal,
        remark: remark || (Number(existingHold.hold) === 1 ? existingHold.remark || "" : ""),
        // an old (pre-reduce) hold keeps its original hold time / user
        heldBy: Number(existingHold.hold) === 1 && existingHold.heldBy ? existingHold.heldBy : userName,
        heldByUserId:
          Number(existingHold.hold) === 1 && existingHold.heldByUserId
            ? existingHold.heldByUserId
            : mongoose.Types.ObjectId.isValid(String(user?.userId || "")) ? new mongoose.Types.ObjectId(String(user.userId)) : null,
        heldAt: Number(existingHold.hold) === 1 && existingHold.heldAt ? existingHold.heldAt : nowIST(),
        releasedBy: "",
        releasedAt: null,
        siteReduced: false,
        amountsSnapshot: null,
      };

      // ✅ NEW — reduce the STORED site amounts to the pre-appraisal rent
      // (rent, site GST, every landowner's share / cash / online / GST / TDS,
      // and this bill's own amounts). Skipped when another held bill already
      // reduced the site, or when the appraisal is not in the rent yet.
      const siteAlreadyHeld = Number(media.appraisal?.appraisalHold) === 1;
      const currentRent = Number(rp.totalRentalAmount || 0);
      if (!siteAlreadyHeld && currentRent > rentWithoutAppraisal && rentWithoutAppraisal > 0) {
        const ratio = rentWithoutAppraisal / currentRent;
        const before = {
          rentalPayment: pickNums(rp, RP_FIELDS),
          landOwners: owners.map((o) => ({ _id: o._id, ...pickNums(o, OWNER_FIELDS) })),
          entry: pickNums(entry, ENTRY_FIELDS),
        };
        const after = {
          rentalPayment: { ...scaleNums(before.rentalPayment, ratio), totalRentalAmount: rentWithoutAppraisal },
          landOwners: before.landOwners.map(({ _id, ...vals }) => ({ _id, ...scaleNums(vals, ratio) })),
          entry: scaleNums(before.entry, ratio),
        };
        Object.entries(after.rentalPayment).forEach(([k, v]) => { $set[`rentalPayment.${k}`] = v; });
        after.landOwners.forEach(({ _id, ...vals }, i) => {
          Object.entries(vals).forEach(([k, v]) => { $set[`landOwners.${i}.${k}`] = v; });
        });
        Object.entries(after.entry).forEach(([k, v]) => { $set[`rentalDue.$[e].${k}`] = v; });
        holdData.siteReduced = true;
        holdData.amountsSnapshot = { before, after };

        // ✅ NEW — bills of LATER months already generated (e.g. October, when
        // August–October were generated together), not held and not approved,
        // still at the full amount → the held amount too (52k → 50k). The
        // release puts them back (same exact-match rule).
        const heldKey = entry.dueDate ? appraisalMonthKey(entry.dueDate) : null;
        if (heldKey !== null) {
          (media.rentalDue || []).forEach((e, i) => {
            if (String(e._id) === String(entry._id)) return;
            if (Number(e.appraisalHold?.hold) === 1 || Number(e.approvalStatus) === 3) return;
            const k = e.dueDate ? appraisalMonthKey(e.dueDate) : null;
            if (k === null || k <= heldKey) return;
            Object.keys(after.entry).forEach((f) => {
              if (isNum(e[f]) && Number(e[f]) === Number(before.entry[f]) && Number(e[f]) !== Number(after.entry[f])) {
                $set[`rentalDue.${i}.${f}`] = Number(after.entry[f]);
              }
            });
          });
        }
      }
      // the existing auto-apply checks skip a held appraisal → rent stays reduced
      $set["appraisal.appraisalHold"] = 1;
      // ✅ CHANGED — appraisal applicable stays 1 in media onboarding while held
      // (the hold date is still stored). An older hold that had switched it off
      // keeps its value, so its release still turns it back to 1.
      holdData.appraisalApplicableBefore = existingHold.appraisalApplicableBefore ?? null;
      $set["appraisal.appraisalHoldDate"] = holdData.heldAt || nowIST();
    }
  } else {
    // ✅ NEW — the remark sent with the release is its own reason (releaseReason);
    // the hold's remark is kept as it was
    holdData = { ...existingHold, hold: 0, releasedBy: userName, releasedAt: nowIST(), releaseReason: remark || "" };

    // ✅ NEW — release sent on a bill that is NOT held (e.g. October) while
    // another bill of the site is held (e.g. September, maybe approved already)
    // → that site hold is released: site + this bill + later bills back to the
    // full rent. The held bill is marked released too.
    const heldBill =
      Number(existingHold.hold) === 1
        ? entry
        : (media.rentalDue || [])
            .filter((e) => String(e._id) !== String(entry._id) && Number(e.appraisalHold?.hold) === 1)
            .sort(
              (a, b) =>
                (b.appraisalHold.siteReduced ? 1 : 0) - (a.appraisalHold.siteReduced ? 1 : 0) ||
                new Date(b.dueDate || 0) - new Date(a.dueDate || 0),
            )[0] || null;
    const heldHold = heldBill?.appraisalHold || {};
    const viaOtherBill = !!heldBill && String(heldBill._id) !== String(entry._id);

    // ✅ NEW — UPDATE an already-released amount: nothing is on hold any more,
    // but the site's appraisal was released before (e.g. with 6000 → 56k) and
    // a release comes again with releaseAmount (e.g. 5000) → the rent becomes
    // rent without appraisal + new amount (55k): site rent / GST, landowner
    // amounts, bills from that release month on (not approved, at the old rent),
    // and the released appraisal in the history (+ later ones cascade).
    if (relAmt !== null && !(heldBill && Number(heldHold.hold) === 1)) {
      const lastRelease = (media.rentalDue || [])
        .flatMap((b) =>
          buildAppraisalHoldHistory(b.appraisalHold || {})
            .filter((ev) => ev.action === "release")
            .map((ev) => ({ b, ev })),
        )
        .filter(({ b }) => Number(b.appraisalHold?.rentWithoutAppraisal || 0) > 0)
        .sort(
          (a, c) =>
            new Date(c.ev.at || 0) - new Date(a.ev.at || 0) || new Date(c.b.dueDate || 0) - new Date(a.b.dueDate || 0),
        )[0];
      if (!lastRelease) {
        return fail(400, "No released appraisal on this site to update — hold the appraisal first");
      }
      const prevHold = lastRelease.b.appraisalHold;
      const prevEv = lastRelease.ev;
      const baseRent = Number(prevHold.rentWithoutAppraisal || 0);
      const oldRent = Number(rp.totalRentalAmount || 0);
      const newRent = Math.round(baseRent + relAmt);
      if (oldRent <= 0) return fail(400, "Site rent is 0 — nothing to update");
      const ratio = newRent / oldRent;
      if (ratio !== 1) {
        Object.entries(pickNums(rp, RP_FIELDS)).forEach(([k, v]) => {
          $set[`rentalPayment.${k}`] = k === "totalRentalAmount" ? newRent : Math.round(v * ratio);
        });
        owners.forEach((o, i) => {
          Object.entries(pickNums(o, OWNER_FIELDS)).forEach(([k, v]) => { $set[`landOwners.${i}.${k}`] = Math.round(v * ratio); });
        });
        // bills from the release month on, not approved, still at the old rent
        const startKey = appraisalMonthKey(prevEv.at);
        (media.rentalDue || []).forEach((b, i) => {
          if (Number(b.approvalStatus) === 3 || Number(b.appraisalHold?.hold) === 1) return;
          const k = b.dueDate ? appraisalMonthKey(b.dueDate) : null;
          if (k === null || startKey === null || k < startKey) return;
          if (Number(b.netPayable) !== oldRent && Number(b.baseAmount) !== oldRent) return;
          Object.entries(pickNums(b, ENTRY_FIELDS)).forEach(([f, v]) => { $set[`rentalDue.${i}.${f}`] = Math.round(v * ratio); });
        });
        // the released appraisal (latest one due, at the old rent) → new amount
        const nowKeyU = appraisalMonthKey(nowIST());
        const hist = (media.appraisal?.history || []).map((h) => ({ ...h }));
        const idx = hist
          .map((h, i) => ({ h, i }))
          .filter(({ h }) => h.appraisalDate && !h.isAnchorEntry && appraisalMonthKey(h.appraisalDate) <= nowKeyU)
          .sort((a, c) => new Date(c.h.appraisalDate) - new Date(a.h.appraisalDate))
          .find(({ h }) => Number(h.newRent) === oldRent)?.i;
        if (idx !== undefined) {
          hist[idx] = {
            ...hist[idx],
            previousRent: baseRent,
            appraisalAmount: relAmt,
            newRent,
            updatedBy: `${userName} (Appraisal release amount updated - ${relAmt})`,
            updatedAt: nowIST(),
          };
          const releasedTime = new Date(hist[idx].appraisalDate).getTime();
          let prev = newRent;
          hist
            .map((h, i) => ({ h, i }))
            .filter(({ h, i }) => i !== idx && h.appraisalDate && !h.isAnchorEntry && new Date(h.appraisalDate).getTime() > releasedTime)
            .sort((a, c) => new Date(a.h.appraisalDate) - new Date(c.h.appraisalDate))
            .forEach(({ h, i }) => {
              const amount =
                Number(h.type) === 1
                  ? Math.floor((prev * Number(h.percentage || 0)) / 100)
                  : Number(h.type) === 2
                    ? Math.floor(Number(h.fixedAmount || 0))
                    : Number(h.appraisalAmount || 0);
              hist[i] = { ...h, previousRent: prev, appraisalAmount: amount, newRent: Math.floor(prev + amount) };
              prev = hist[i].newRent;
            });
          const { recomputeAppraisalSummary } = require("./MediaOnboardingController");
          const summary = recomputeAppraisalSummary({ ...(media.appraisal || {}), history: hist }, newRent);
          $set["appraisal.history"] = hist;
          ["lastAppraisalDate", "nextAppraisalDate", "currentRent", "appraisalAmount", "totalAppraisalAmount"].forEach((k) => {
            if (summary[k] !== undefined) $set[`appraisal.${k}`] = summary[k];
          });
        }
        $push["rentalPayment.rentalAmountHistory"] = {
          amount: newRent,
          updatedBy: `${userName} (Appraisal release amount updated - appraisal ${relAmt})`,
          updatedAt: nowIST(),
          isAppraisal: true,
          isManualChange: false,
          isInitial: false,
        };
      }
      // this bill shows the appraisal it belongs to
      ["appraisalAmount", "rentWithAppraisal", "rentWithoutAppraisal"].forEach((k) => {
        if (holdData[k] === undefined || !Number(holdData[k])) holdData[k] = prevHold[k];
      });
      const prevMonths = Array.isArray(prevEv.heldMonths) ? prevEv.heldMonths : [lastRelease.b.dueMonth].filter(Boolean);
      const amt = Number(prevEv.appraisalAmount ?? prevHold.appraisalAmount ?? 0);
      releaseMeta = {
        appraisalAmount: amt,
        heldMonths: prevMonths,
        heldMonthsCount: prevMonths.length,
        heldAppraisalTotal: amt * prevMonths.length,
        releaseAmount: relAmt,
        rentAfterRelease: newRent,
        previousReleaseAmount: prevEv.releaseAmount ?? (oldRent - baseRent),
      };
      releaseInfo = {
        originalAppraisalAmount: amt,
        previousReleaseAmount: releaseMeta.previousReleaseAmount,
        releaseAmount: relAmt,
        appraisalAmount: relAmt,
        rentWithoutAppraisal: baseRent,
        rentWithAppraisal: newRent,
        approvalAmount: newRent,
        nextBillRent: newRent,
        heldMonths: prevMonths,
      };
    }

    if (viaOtherBill) {
      // this bill shows the appraisal it was released for
      ["appraisalAmount", "rentWithAppraisal", "rentWithoutAppraisal"].forEach((k) => {
        if (holdData[k] === undefined || !Number(holdData[k])) holdData[k] = heldHold[k];
      });
      const hIdx = media.rentalDue.findIndex((e) => String(e._id) === String(heldBill._id));
      const heldHistory = buildAppraisalHoldHistory(heldHold);
      heldHistory.push({
        action: "release",
        reason: remark || "",
        by: userName,
        byUserId: mongoose.Types.ObjectId.isValid(String(user?.userId || "")) ? new mongoose.Types.ObjectId(String(user.userId)) : null,
        at: holdData.releasedAt,
      });
      $set[`rentalDue.${hIdx}.appraisalHold`] = {
        ...heldHold,
        hold: 0,
        releasedBy: userName,
        releasedAt: holdData.releasedAt,
        releaseReason: remark || "",
        history: heldHistory,
      };
    }

    // ✅ NEW — released in a LATER month than the held appraisal (e.g. held
    // August, released September) → the appraisal moves to the release month
    // (see the date shift below); bills before it keep the held amount (50k)
    // ✅ CHANGED — the release month = the month of the BILL the release is
    // sent on (not today's date): released on the September bill → stays
    // September; released on the October bill → moves to October.
    const heldAppraisal = heldBill && Number(heldHold.hold) === 1 ? findAppraisalForBillMonth(media, heldBill) : null;
    const releaseKey = entry?.dueDate ? appraisalMonthKey(entry.dueDate) : appraisalMonthKey(holdData.releasedAt);
    const fromKey = heldAppraisal ? appraisalMonthKey(heldAppraisal.appraisalDate) : null;
    const shift = fromKey !== null && releaseKey !== null ? releaseKey - fromKey : 0;

    if (heldBill && Number(heldHold.hold) === 1 && heldHold.siteReduced && heldHold.amountsSnapshot) {
      // ✅ NEW — restore what this hold reduced. A value still equal to what the
      // hold wrote goes back exactly; a value edited since is scaled back up.
      const { before, after } = heldHold.amountsSnapshot;
      const upRatio =
        Number(after?.rentalPayment?.totalRentalAmount) > 0
          ? Number(before?.rentalPayment?.totalRentalAmount || 0) / Number(after.rentalPayment.totalRentalAmount)
          : 1;
      const restore = (current, b, a) =>
        Object.keys(b || {}).reduce((acc, k) => {
          if (!isNum(current?.[k])) return acc;
          // still the held value → original; already back at the original
          // (raised by something else) → keep; edited since → scale back up
          if (Number(current[k]) === Number(b[k])) return acc;
          acc[k] = Number(current[k]) === Number(a?.[k]) ? Number(b[k]) : Math.round(Number(current[k]) * upRatio);
          return acc;
        }, {});
      Object.entries(restore(rp, before.rentalPayment, after.rentalPayment)).forEach(([k, v]) => { $set[`rentalPayment.${k}`] = v; });
      owners.forEach((o, i) => {
        const b = (before.landOwners || []).find((x) => String(x._id) === String(o._id));
        const a = (after.landOwners || []).find((x) => String(x._id) === String(o._id));
        if (!b) return; // landowner added after the hold → left as is
        Object.entries(restore(o, b, a)).forEach(([k, v]) => { $set[`landOwners.${i}.${k}`] = v; });
      });
      // the held bill itself — unless it was already approved at the held amount,
      // or the appraisal moved past its month (shift) → it stays at 50k
      if (Number(heldBill.approvalStatus) !== 3 && shift <= 0) {
        const heldPath = viaOtherBill
          ? `rentalDue.${media.rentalDue.findIndex((e) => String(e._id) === String(heldBill._id))}`
          : "rentalDue.$[e]";
        Object.entries(restore(heldBill, before.entry, after.entry)).forEach(([k, v]) => { $set[`${heldPath}.${k}`] = v; });
      }

      // ✅ NEW — bills of LATER months created while the site was on hold (e.g.
      // November at 50k), not held themselves and not fully approved yet, get the
      // full amounts back too (52k) — the appraisal is enabled again on release
      const heldKey = heldBill.dueDate ? appraisalMonthKey(heldBill.dueDate) : null;
      const afterEntry = after?.entry || {};
      if (heldKey !== null && Object.keys(afterEntry).length) {
        (media.rentalDue || []).forEach((e, i) => {
          if (String(e._id) === String(heldBill._id)) return;
          if (Number(e.appraisalHold?.hold) === 1 || Number(e.approvalStatus) === 3) return;
          const k = e.dueDate ? appraisalMonthKey(e.dueDate) : null;
          if (k === null || k <= heldKey) return;
          if (shift > 0 && k < releaseKey) return; // ✅ NEW — before the moved appraisal month
          // the bill this release was sent on is addressed by its array filter
          const ePath = String(e._id) === String(entry._id) ? "rentalDue.$[e]" : `rentalDue.${i}`;
          // only values still exactly at the held amount (e.g. 50000 → 52000)
          Object.keys(afterEntry).forEach((f) => {
            if (isNum(e[f]) && isNum(before.entry?.[f]) && Number(e[f]) === Number(afterEntry[f]) && Number(e[f]) !== Number(before.entry[f])) {
              $set[`${ePath}.${f}`] = Number(before.entry[f]);
            }
          });
        });
      }
    }
    // ✅ NEW — releaseAmount: the amount entered on release IS the appraisal
    // from now on (e.g. 50k + 6k = 56k). Site rent, site GST, every landowner's
    // share / cash / online / GST / TDS, and the bills from the release month on
    // (not approved, still at the held or full amount) → the new rent. Scaled
    // from the full ("with appraisal") values the hold saved.
    if (relAmt !== null && heldBill && Number(heldHold.hold) === 1) {
      const snapBefore = heldHold.amountsSnapshot?.before || null;
      const snapAfter = heldHold.amountsSnapshot?.after || null;
      const baseRent = Number(heldHold.rentWithoutAppraisal || 0);
      const fullRent = Number(snapBefore?.rentalPayment?.totalRentalAmount || heldHold.rentWithAppraisal || rp.totalRentalAmount || 0);
      const targetRent = Math.round(baseRent + relAmt);
      if (baseRent > 0 && fullRent > 0) {
        const ratio = targetRent / fullRent;
        const fullRp = snapBefore?.rentalPayment || pickNums(rp, RP_FIELDS);
        Object.entries(fullRp).forEach(([k, v]) => {
          $set[`rentalPayment.${k}`] = k === "totalRentalAmount" ? targetRent : Math.round(Number(v) * ratio);
        });
        owners.forEach((o, i) => {
          const full = (snapBefore?.landOwners || []).find((x) => String(x._id) === String(o._id));
          const vals = full ? (({ _id, ...rest }) => rest)(full) : pickNums(o, OWNER_FIELDS);
          Object.entries(vals).forEach(([k, v]) => { $set[`landOwners.${i}.${k}`] = Math.round(Number(v) * ratio); });
        });
        // bills from the release month on (held month too when released in it)
        const heldBillKey = heldBill.dueDate ? appraisalMonthKey(heldBill.dueDate) : null;
        const startKey = Math.max(releaseKey ?? -Infinity, fromKey ?? heldBillKey ?? -Infinity);
        const fullEntry = snapBefore?.entry || pickNums(heldBill, ENTRY_FIELDS);
        (media.rentalDue || []).forEach((e, i) => {
          if (Number(e.approvalStatus) === 3) return;
          const isThisRelease = String(e._id) === String(heldBill._id) || String(e._id) === String(entry._id);
          if (!isThisRelease && Number(e.appraisalHold?.hold) === 1) return;
          const k = e.dueDate ? appraisalMonthKey(e.dueDate) : null;
          if (k === null || k < startKey) return;
          Object.keys(fullEntry).forEach((f) => {
            const cur = Number(e[f]);
            const atHeldOrFull =
              isNum(e[f]) && (cur === Number(fullEntry[f]) || (snapAfter?.entry && cur === Number(snapAfter.entry[f])));
            if (atHeldOrFull) $set[`rentalDue.${i}.${f}`] = Math.round(Number(fullEntry[f]) * ratio);
          });
        });
        $push["rentalPayment.rentalAmountHistory"] = {
          amount: targetRent,
          updatedBy: `${userName} (Appraisal hold released - appraisal ${relAmt})`,
          updatedAt: nowIST(),
          isAppraisal: true,
          isManualChange: false,
          isInitial: false,
        };
        releaseInfo = {
          originalAppraisalAmount: Number(heldHold.appraisalAmount || 0),
          releaseAmount: relAmt,
          appraisalAmount: relAmt,
          rentWithoutAppraisal: baseRent,
          rentWithAppraisal: targetRent,
          approvalAmount: targetRent,
          nextBillRent: targetRent,
          // ✅ CHANGED — CMD-approval based held months (see cmdApprovedHeldMonths)
          heldMonths: cmdApprovedHeldMonths(
            media.rentalDue,
            heldBill,
            Math.max(appraisalMonthKey(entry.dueDate) ?? -Infinity, releaseKey ?? -Infinity),
          ),
        };
      }
    }

    // ✅ NEW — the appraisal takes effect in the RELEASE month: the held
    // appraisal (e.g. 10.08.2026, held in August) and every later scheduled
    // appraisal move forward by the same months (released in September →
    // 10.09.2026, next 10.09.2027). lastAppraisalDate / nextAppraisalDate are
    // recomputed from the shifted history.
    // ✅ NEW — with releaseAmount, that appraisal's amount becomes the entered
    // amount and the later scheduled appraisals cascade from the new rent.
    if (heldBill && Number(heldHold.hold) === 1 && (shift > 0 || releaseInfo)) {
      {
        const addMonths = (d, n) => {
          const x = new Date(d);
          const day = x.getUTCDate();
          const lastDay = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n + 1, 0)).getUTCDate();
          return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, Math.min(day, lastDay)));
        };
        const heldIdx = heldAppraisal ? (media.appraisal?.history || []).indexOf(heldAppraisal) : -1;
        const fromTime = heldAppraisal ? new Date(heldAppraisal.appraisalDate).getTime() : Infinity;
        let history = (media.appraisal?.history || []).map((h) =>
          shift > 0 && h && h.appraisalDate && !h.isAnchorEntry && new Date(h.appraisalDate).getTime() >= fromTime
            ? { ...h, appraisalDate: addMonths(h.appraisalDate, shift), updatedBy: `${userName} (Appraisal hold released)`, updatedAt: nowIST() }
            : h,
        );
        if (releaseInfo && heldIdx !== -1) {
          // the released appraisal = the entered amount; later ones cascade
          const releasedTime = new Date(history[heldIdx].appraisalDate).getTime();
          history[heldIdx] = {
            ...history[heldIdx],
            previousRent: releaseInfo.rentWithoutAppraisal,
            appraisalAmount: releaseInfo.appraisalAmount,
            newRent: releaseInfo.rentWithAppraisal,
            updatedBy: `${userName} (Appraisal hold released - appraisal ${releaseInfo.appraisalAmount})`,
            updatedAt: nowIST(),
          };
          let prev = releaseInfo.rentWithAppraisal;
          history = history
            .map((h, i) => ({ h, i }))
            .sort((a, b) => new Date(a.h.appraisalDate) - new Date(b.h.appraisalDate))
            .map(({ h, i }) => {
              if (i === heldIdx || !h?.appraisalDate || h.isAnchorEntry) return { h, i };
              if (new Date(h.appraisalDate).getTime() <= releasedTime) return { h, i };
              const amount =
                Number(h.type) === 1
                  ? Math.floor((prev * Number(h.percentage || 0)) / 100)
                  : Number(h.type) === 2
                    ? Math.floor(Number(h.fixedAmount || 0))
                    : Number(h.appraisalAmount || 0);
              const next = { ...h, previousRent: prev, appraisalAmount: amount, newRent: Math.floor(prev + amount) };
              prev = next.newRent;
              return { h: next, i };
            })
            .sort((a, b) => a.i - b.i)
            .map(({ h }) => h);
        }
        // lazy require: avoids a circular import
        const { recomputeAppraisalSummary } = require("./MediaOnboardingController");
        const summary = recomputeAppraisalSummary(
          { ...(media.appraisal || {}), history },
          releaseInfo ? releaseInfo.rentWithAppraisal : Number(media.rentalPayment?.totalRentalAmount || 0),
        );
        $set["appraisal.history"] = history;
        ["lastAppraisalDate", "nextAppraisalDate", "currentRent", "appraisalAmount", "totalAppraisalAmount"].forEach((k) => {
          if (summary[k] !== undefined) $set[`appraisal.${k}`] = summary[k];
        });
        if (shift > 0) {
          appraisalDateShift = { from: heldAppraisal.appraisalDate, to: summary.lastAppraisalDate || null, nextAppraisalDate: summary.nextAppraisalDate || null }; // ✅ NEW — response only
        }
      }
    }

    // ✅ NEW — what this release covered, saved on the release event so the
    // remarks API can show it: the held months (held bill's month up to the
    // release bill / release month), held appraisal total, releaseAmount and
    // the rent after release
    if (heldBill && Number(heldHold.hold) === 1) {
      const endKey = Math.max(appraisalMonthKey(entry.dueDate) ?? -Infinity, releaseKey ?? -Infinity);
      // ✅ CHANGED — CMD-approval based held months (see cmdApprovedHeldMonths)
      const heldMonths = cmdApprovedHeldMonths(media.rentalDue, heldBill, endKey);
      const amt = Number(heldHold.appraisalAmount || 0);
      releaseMeta = {
        appraisalAmount: amt,
        heldMonths,
        heldMonthsCount: heldMonths.length,
        heldAppraisalTotal: amt * heldMonths.length,
        releaseAmount: relAmt,
        rentAfterRelease: releaseInfo ? releaseInfo.rentWithAppraisal : Number(heldHold.rentWithAppraisal || 0) || null,
        // ✅ NEW — the appraisal date this release moved (media onboarding uses it
        // to ignore the old date re-sent by a stale form)
        ...(appraisalDateShift
          ? { appraisalDateFrom: appraisalDateShift.from || null, appraisalDateTo: appraisalDateShift.to || null }
          : {}),
      };
      // the held bill's own release event (release sent on another bill)
      if (viaOtherBill) {
        const hIdx = media.rentalDue.findIndex((e) => String(e._id) === String(heldBill._id));
        const evs = $set[`rentalDue.${hIdx}.appraisalHold`]?.history;
        if (Array.isArray(evs) && evs.length) Object.assign(evs[evs.length - 1], releaseMeta);
      }
    }

    const otherHeld = (media.rentalDue || []).some(
      (e) =>
        String(e._id) !== String(entry._id) &&
        String(e._id) !== String(heldBill?._id) && // ✅ NEW — released here too
        Number(e.appraisalHold?.hold) === 1,
    );
    if (!otherHeld) {
      $set["appraisal.appraisalHold"] = 0;
      // ✅ NEW — appraisal applicable back to 1 (with the release date) when
      // the hold had switched it off
      if (Number(heldHold.hold) === 1 && Number(heldHold.appraisalApplicableBefore) === 1) {
        $set["appraisal.applicable"] = 1;
        $set["appraisal.appraisalReleaseDate"] = holdData.releasedAt;
      }
    }
  }

  // ✅ NEW — every hold / release with its reason is kept (oldest first)
  {
    const wasHeld = Number(existingHold.hold) === 1;
    const history = buildAppraisalHoldHistory(existingHold);
    const addEvent = hold === 1 ? !wasHeld || !!remark : true; // re-hold without a new remark adds nothing
    if (addEvent) {
      history.push({
        action: hold === 1 ? "hold" : "release",
        reason: remark || (hold === 1 ? holdData.remark || "" : ""),
        by: userName,
        byUserId: mongoose.Types.ObjectId.isValid(String(user?.userId || "")) ? new mongoose.Types.ObjectId(String(user.userId)) : null,
        at: nowIST(),
        ...(hold === 0 && releaseMeta ? releaseMeta : {}), // ✅ NEW — release details
      });
    }
    holdData.history = history;
  }
  $set["rentalDue.$[e].appraisalHold"] = holdData;
  // direct $set — no media.save(), so no pre-save recalculation runs
  // ✅ FIXED — MongoDB rejects one update that uses both "rentalDue.$[e].x" and
  // "rentalDue.2.x" ("would create a conflict at 'rentalDue'"). Every
  // rentalDue.<index> path is written through an array filter instead (the
  // held bill's own index → $[e]).
  const arrayFilters = [{ "e._id": entry._id }];
  const entryIdx = (media.rentalDue || []).findIndex((x) => String(x._id) === String(entry._id));
  const usedIdx = new Set();
  Object.keys($set).forEach((path) => {
    const mIdx = path.match(/^rentalDue\.(\d+)\.(.+)$/);
    if (!mIdx) return;
    const i = Number(mIdx[1]);
    const id = i === entryIdx ? "e" : `r${i}`;
    if (id !== "e" && !usedIdx.has(i)) {
      usedIdx.add(i);
      arrayFilters.push({ [`${id}._id`]: media.rentalDue[i]._id });
    }
    $set[`rentalDue.$[${id}].${mIdx[2]}`] = $set[path];
    delete $set[path];
  });
  const update = { $set };
  if (Object.keys($pull).length) update.$pull = $pull;
  if (Object.keys($push).length) update.$push = $push; // ✅ NEW
  await Media.updateOne({ _id: media._id }, update, { arrayFilters, timestamps: false });

  const snapshot = holdData.amountsSnapshot;
  return {
    success: true,
    statusCode: 200,
    message: hold === 1 ? `Appraisal amount put on hold for ${entry.dueMonth || "this bill"}` : `Appraisal hold released for ${entry.dueMonth || "this bill"}`,
    data: {
      mediaId: media._id,
      rentalDueId: entry._id,
      dueMonth: entry.dueMonth || "",
      appraisalHold: hold === 1 ? 0 : 1, // ✅ CHANGED — API value: 0 = held, 1 = released
      rentWithAppraisal: holdData.rentWithAppraisal || 0,
      appraisalAmount: holdData.appraisalAmount || 0,
      rentWithoutAppraisal: holdData.rentWithoutAppraisal || 0,
      approvalAmount: hold === 1 ? holdData.rentWithoutAppraisal : holdData.rentWithAppraisal || null,
      // ✅ NEW — release: the appraisal now takes effect in the release month
      appraisalDateShift,
      // ✅ NEW — release with releaseAmount: entered amount = the appraisal from now on
      ...(releaseInfo || {}),
      remark: holdData.remark || "",
      heldBy: holdData.heldBy || "",
      heldAt: holdData.heldAt || null,
      releasedBy: holdData.releasedBy || "",
      releasedAt: holdData.releasedAt || null,
      releaseReason: holdData.releaseReason || "", // ✅ NEW — entered on release
      // ✅ NEW — the site's appraisal applicable after this call (0 while held)
      appraisalApplicable:
        $set["appraisal.applicable"] !== undefined ? $set["appraisal.applicable"] : Number(media.appraisal?.applicable || 0),
      // ✅ NEW — what the hold changed on the site (with appraisal → on hold)
      siteReduced: !!holdData.siteReduced,
      amounts: snapshot
        ? {
            totalRentalAmount: {
              withAppraisal: snapshot.before.rentalPayment.totalRentalAmount ?? null,
              onHold: snapshot.after.rentalPayment.totalRentalAmount ?? null,
            },
            gstAmount: {
              withAppraisal: sumOwners(snapshot.before.landOwners, "gstAmount") || snapshot.before.rentalPayment.gstAmount || 0,
              onHold: sumOwners(snapshot.after.landOwners, "gstAmount") || snapshot.after.rentalPayment.gstAmount || 0,
            },
            tdsAmount: {
              withAppraisal: sumOwners(snapshot.before.landOwners, "tdsAmount"),
              onHold: sumOwners(snapshot.after.landOwners, "tdsAmount"),
            },
          }
        : null,
    },
  };
}

// ✅ NEW — batch input: entries[] (or {"0":{...}} from form-data) OR parallel
// arrays mediaId[] / rentalDueId[] (one mediaId string + rentalDueId[] = same
// site). Top-level appraisalHold / remark are the defaults for every item.
function parseAppraisalHoldItems(body) {
  const asArray = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.keys(v).filter((k) => /^d+$/.test(k)).sort((a, b) => a - b).map((k) => v[k]);
    if (typeof v === "string" && v.trim().startsWith("[")) {
      try { return JSON.parse(v); } catch { return null; }
    }
    return null;
  };
  const entries = asArray(body.entries);
  if (entries && entries.length) return entries.map((e) => ({ ...(e || {}) }));
  const mediaIds = asArray(body.mediaId);
  const rentalDueIds = asArray(body.rentalDueId);
  if (!mediaIds && !rentalDueIds) return null; // single request
  const count = Math.max(mediaIds?.length || 0, rentalDueIds?.length || 0);
  return Array.from({ length: count }, (_, i) => ({
    mediaId: mediaIds ? mediaIds[i] ?? mediaIds[0] : body.mediaId,
    rentalDueId: rentalDueIds ? rentalDueIds[i] : body.rentalDueId,
  }));
}

// ✅ CHANGED — API value: appraisalHold 0 = HOLD, 1 = RELEASE (not hold).
// Converted here to the internal / stored value (1 = held, 0 = not held),
// which the save hook, applyDueAppraisals and syncBillingCycles rely on.
const apiToInternalHold = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(v);
  return n === 0 ? 1 : n === 1 ? 0 : NaN;
};
// internal / stored value → API value (0 = held, 1 = not held)
const internalToApiHold = (v) => (Number(v) === 1 ? 0 : 1);


exports.setAppraisalHold = async (req, res) => {
  try {
    // ✅ CHANGED — Rental Executive, Rental Manager and CMD (was CMD only)
    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(Number(req.user?.userType))) {
      return errorResponse(res, "Only Rental Executive, Rental Manager or CMD can hold the appraisal amount", null, 403);
    }
    const body = { ...(req.query || {}), ...(req.body || {}) };
    const defaultHold = apiToInternalHold(body.appraisalHold);
    const defaultRemark = typeof body.remark === "string" ? body.remark.trim() : "";
    const items = parseAppraisalHoldItems(body);

    // ── single bill: same request / response as before ──
    if (!items) {
      const r = await processAppraisalHold({
        mediaId: body.mediaId,
        rentalDueId: body.rentalDueId,
        hold: defaultHold,
        remark: defaultRemark,
        user: req.user,
        releaseAmount: body.releaseAmount ?? null, // ✅ NEW — release only
      });
      return r.success ? successResponse(res, r.message, r.data) : errorResponse(res, r.message, null, r.statusCode);
    }

    // ── several bills ──
    if (items.length === 0) return errorResponse(res, "No bills sent", null, 400);
    const results = [];
    for (const item of items) {
      const hold = item.appraisalHold !== undefined && item.appraisalHold !== "" ? apiToInternalHold(item.appraisalHold) : defaultHold;
      const remark = typeof item.remark === "string" && item.remark.trim() ? item.remark.trim() : defaultRemark;
      const releaseAmount = item.releaseAmount ?? body.releaseAmount ?? null; // ✅ NEW
      const r = await processAppraisalHold({ mediaId: item.mediaId, rentalDueId: item.rentalDueId, hold, remark, user: req.user, releaseAmount });
      results.push(r.success ? { success: true, message: r.message, ...r.data } : { success: false, statusCode: r.statusCode, message: r.message, mediaId: r.mediaId, rentalDueId: r.rentalDueId });
    }
    const successCount = results.filter((r) => r.success).length;
    const message = `Appraisal hold updated for ${successCount} of ${results.length} bill(s)`;
    if (successCount === 0) return errorResponse(res, message, { results }, 400);
    return successResponse(res, message, { totalCount: results.length, successCount, failedCount: results.length - successCount, results });
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW — GET/POST /admin/appraisal-hold-remarks?mediaId=&rentalDueId=
// Read only, any logged-in role: every bill of the site that was ever
// appraisal-held (current hold or released), with its remark — newest first.
// rentalDueId (optional) → just that bill.
// ─────────────────────────────────────────────────────────────
exports.buildAppraisalHoldHistory = buildAppraisalHoldHistory; // used by media onboarding auto-release
exports.effectiveAppraisalHold = effectiveAppraisalHold; // ✅ NEW — rental-due-list + approval mail

exports.getAppraisalHoldRemarks = async (req, res) => {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const mediaId = String(params.mediaId || "").trim();
    const rentalDueId = params.rentalDueId ? String(params.rentalDueId).trim() : "";
    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "A valid mediaId is required", null, 400);
    }
    if (rentalDueId && !mongoose.Types.ObjectId.isValid(rentalDueId)) {
      return errorResponse(res, "Invalid rentalDueId", null, 400);
    }

    const media = await Media.findById(mediaId).select("mediaDetails rentalDue appraisal.applicable").lean();
    if (!media) return errorResponse(res, "Media not found", null, 404);

    const faces = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);

    // ✅ NEW — held months / totals for the rows and the summary
    const totals = (amt, months) => ({
      appraisalAmount: amt,
      heldMonths: months,
      heldMonthsCount: months.length,
      heldAppraisalTotal: amt * months.length,
    });
    // a hold row: the month it was put on hold
    const holdRowMeta = (bill, base) => ({
      heldMonths: [bill.dueMonth].filter(Boolean),
      heldMonthsCount: 1,
      heldAppraisalTotal: base.appraisalAmount,
      releaseAmount: null,
      rentAfterRelease: null,
    });
    // a release row: saved with the release; releases saved before this was
    // added → months worked out from the bills (latest hold before it up to
    // this bill / the release month), rent after release = full rent
    const releaseRowMeta = (bill, ev, base) => {
      if (Array.isArray(ev.heldMonths)) {
        return {
          heldMonths: ev.heldMonths,
          heldMonthsCount: ev.heldMonthsCount ?? ev.heldMonths.length,
          heldAppraisalTotal: ev.heldAppraisalTotal ?? Number(ev.appraisalAmount ?? base.appraisalAmount) * ev.heldMonths.length,
          releaseAmount: ev.releaseAmount ?? null,
          rentAfterRelease: ev.rentAfterRelease ?? (base.rentWithAppraisal || null),
          appraisalAmount: ev.appraisalAmount ?? base.appraisalAmount,
        };
      }
      const relTime = new Date(ev.at || 0).getTime();
      const holdBefore = (media.rentalDue || [])
        .flatMap((x) => buildAppraisalHoldHistory(x.appraisalHold || {}).filter((h) => h.action === "hold").map((h) => ({ x, h })))
        .filter(({ h }) => new Date(h.at || 0).getTime() <= relTime)
        .sort((a, b) => new Date(b.h.at || 0) - new Date(a.h.at || 0))[0];
      const endKey = Math.max(appraisalMonthKey(bill.dueDate) ?? -Infinity, appraisalMonthKey(ev.at) ?? -Infinity);
      const amt = Number((holdBefore?.x.appraisalHold || {}).appraisalAmount || base.appraisalAmount || 0);
      // ✅ CHANGED — CMD-approval based held months
      const months = cmdApprovedHeldMonths(media.rentalDue, holdBefore?.x || bill, endKey);
      return {
        ...totals(amt, months),
        releaseAmount: null,
        rentAfterRelease: Number((holdBefore?.x.appraisalHold || {}).rentWithAppraisal || base.rentWithAppraisal || 0) || null,
      };
    };
    // summary while still on hold — ✅ CHANGED: CMD-approval based held months
    // (held month, then each next month only after the previous one is CMD-approved)
    const holdSummaryMeta = (bill, base) => {
      const months = cmdApprovedHeldMonths(media.rentalDue, bill);
      return { ...totals(base.appraisalAmount, months), releaseAmount: null, rentAfterRelease: null };
    };

    const heldBills = (media.rentalDue || [])
      // ✅ CHANGED — also a bill with only a release on record (released via
      // that bill, e.g. October releasing September's hold)
      .filter(
        (e) =>
          e.appraisalHold &&
          (e.appraisalHold.heldAt ||
            Number(e.appraisalHold.hold) === 1 ||
            e.appraisalHold.releasedAt ||
            (Array.isArray(e.appraisalHold.history) && e.appraisalHold.history.length)),
      )
      .filter((e) => !rentalDueId || String(e._id) === rentalDueId);

    // ✅ CHANGED — one row per hold / release action (its own remark + status), newest first
    const holds = heldBills
      .flatMap((e) => {
        const h = e.appraisalHold || {};
        const face = (media.mediaDetails || []).find((d) => String(d._id) === String(e.mediaDetailId));
        const base = {
          rentalDueId: e._id,
          mediaDetailId: e.mediaDetailId || null,
          mediaCode: face?.mediaCode || faces.map((d) => d.mediaCode).filter(Boolean).join(" / "),
          mediaName: face?.mediaName || faces.map((d) => d.mediaName).filter(Boolean).join(", "),
          dueMonth: e.dueMonth || "",
          dueDate: e.dueDate || null,
          approvalStatus: e.approvalStatus ?? null,
          appraisalAmount: Number(h.appraisalAmount || 0),
          rentWithAppraisal: Number(h.rentWithAppraisal || 0),
          rentWithoutAppraisal: Number(h.rentWithoutAppraisal || 0),
        };
        return buildAppraisalHoldHistory(h).map((ev) => {
          const isHold = ev.action === "hold";
          return {
            ...base,
            hold: isHold ? 0 : 1, // 0 = on hold, 1 = released
            holdStatus: isHold ? "On Hold" : "Released",
            remark: ev.reason || "",
            by: ev.by || "",
            at: ev.at || null,
            // ✅ NEW — held months, held appraisal total, releaseAmount, rent after release
            ...(isHold ? holdRowMeta(e, base) : releaseRowMeta(e, ev, base)),
          };
        });
      })
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    // ✅ NEW — the site's latest hold / release (all its bills)
    const latest = (media.rentalDue || [])
      .flatMap((e) => buildAppraisalHoldHistory(e.appraisalHold || {}).map((ev) => ({ e, ev })))
      .sort((a, b) => new Date(b.ev.at || 0) - new Date(a.ev.at || 0))[0];
    let appraisalSummary = null;
    if (latest) {
      const h = latest.e.appraisalHold || {};
      const base = {
        appraisalAmount: Number(h.appraisalAmount || 0),
        rentWithAppraisal: Number(h.rentWithAppraisal || 0),
        rentWithoutAppraisal: Number(h.rentWithoutAppraisal || 0),
        dueMonth: latest.e.dueMonth || "",
      };
      const isHold = latest.ev.action === "hold";
      const meta = isHold ? holdSummaryMeta(latest.e, base) : releaseRowMeta(latest.e, latest.ev, base);
      appraisalSummary = {
        appraisalAmount: meta.appraisalAmount ?? base.appraisalAmount,
        heldMonths: meta.heldMonths,
        heldMonthsCount: meta.heldMonthsCount,
        heldAppraisalTotal: meta.heldAppraisalTotal,
        releaseAmount: meta.releaseAmount,
        rentWithoutAppraisal: base.rentWithoutAppraisal,
        rentAfterRelease: meta.rentAfterRelease,
        holdStatus: isHold ? "On Hold" : "Released",
      };
    }

    return successResponse(res, "Appraisal hold remarks fetched successfully", {
      mediaId: media._id,
      mediaCode: faces.map((d) => d.mediaCode).filter(Boolean).join(" / "),
      mediaName: faces.map((d) => d.mediaName).filter(Boolean).join(", "),
      // ✅ NEW — the site's appraisal applicable (0 while the appraisal is held)
      appraisalApplicable: Number(media.appraisal?.applicable) === 1 ? 1 : 0,
      totalCount: holds.length,
      // bills currently on hold
      onHoldCount: heldBills.filter((e) => Number(e.appraisalHold?.hold) === 1).length,
      appraisalSummary, // ✅ NEW
      holds,
    });
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};