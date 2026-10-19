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

// one bill → { success, statusCode, message, data }. Never throws for a business error.
async function processAppraisalHold({ mediaId, rentalDueId, hold, remark, user }) {
  const fail = (statusCode, message) => ({ success: false, statusCode, message, mediaId: mediaId || null, rentalDueId: rentalDueId || null });
  if (!mongoose.Types.ObjectId.isValid(String(mediaId || "")) || !mongoose.Types.ObjectId.isValid(String(rentalDueId || ""))) {
    return fail(400, "Valid mediaId and rentalDueId are required");
  }
  if (![0, 1].includes(hold)) return fail(400, "appraisalHold must be 0 (hold) or 1 (release)");

  const media = await Media.findById(mediaId).select("rentalDue appraisal rentalPayment landOwners").lean();
  if (!media) return fail(404, "Media not found");
  const entry = (media.rentalDue || []).find((e) => String(e._id) === String(rentalDueId));
  if (!entry) return fail(404, "Rental due entry not found");
  if (Number(entry.approvalStatus) === 3) {
    return fail(400, "This bill is already fully approved — hold must be set before CMD approval");
  }

  const userName = user?.userName || "CMD";
  const existingHold = entry.appraisalHold || {};
  const rp = media.rentalPayment || {};
  const owners = media.landOwners || [];
  const $set = {};
  const $pull = {}; // ✅ NEW — only used by the re-raised repair
  let holdData;

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
      if (holdData.appraisalApplicableBefore === null || holdData.appraisalApplicableBefore === undefined) {
        holdData.appraisalApplicableBefore = Number(media.appraisal?.applicable) === 1 ? 1 : 0;
      }
      if (Number(media.appraisal?.applicable) === 1) {
        $set["appraisal.applicable"] = 0; // also stops the save hook re-applying it
        $set["appraisal.appraisalHoldDate"] = nowIST();
      }
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
      }
      // the existing auto-apply checks skip a held appraisal → rent stays reduced
      $set["appraisal.appraisalHold"] = 1;
      // ✅ NEW — the site shows appraisal applicable 0 while held (date stored);
      // the release turns it back to 1 only if this hold turned it off
      holdData.appraisalApplicableBefore = Number(media.appraisal?.applicable) === 1 ? 1 : 0;
      if (Number(media.appraisal?.applicable) === 1) {
        $set["appraisal.applicable"] = 0;
        $set["appraisal.appraisalHoldDate"] = holdData.heldAt || nowIST();
      }
    }
  } else {
    // ✅ NEW — the remark sent with the release is its own reason (releaseReason);
    // the hold's remark is kept as it was
    holdData = { ...existingHold, hold: 0, releasedBy: userName, releasedAt: nowIST(), releaseReason: remark || "" };
    if (Number(existingHold.hold) === 1 && existingHold.siteReduced && existingHold.amountsSnapshot) {
      // ✅ NEW — restore what this hold reduced. A value still equal to what the
      // hold wrote goes back exactly; a value edited since is scaled back up.
      const { before, after } = existingHold.amountsSnapshot;
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
      Object.entries(restore(entry, before.entry, after.entry)).forEach(([k, v]) => { $set[`rentalDue.$[e].${k}`] = v; });
    }
    const otherHeld = (media.rentalDue || []).some(
      (e) => String(e._id) !== String(entry._id) && Number(e.appraisalHold?.hold) === 1,
    );
    if (!otherHeld) {
      $set["appraisal.appraisalHold"] = 0;
      // ✅ NEW — appraisal applicable back to 1 (with the release date) when
      // the hold had switched it off
      if (Number(existingHold.hold) === 1 && Number(existingHold.appraisalApplicableBefore) === 1) {
        $set["appraisal.applicable"] = 1;
        $set["appraisal.appraisalReleaseDate"] = holdData.releasedAt;
      }
    }
  }

  $set["rentalDue.$[e].appraisalHold"] = holdData;
  // direct $set — no media.save(), so no pre-save recalculation runs
  const update = Object.keys($pull).length ? { $set, $pull } : { $set };
  await Media.updateOne({ _id: media._id }, update, { arrayFilters: [{ "e._id": entry._id }], timestamps: false });

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
    if (Number(req.user?.userType) !== ROLE.OWNER) {
      return errorResponse(res, "Only CMD can hold the appraisal amount", null, 403);
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
      });
      return r.success ? successResponse(res, r.message, r.data) : errorResponse(res, r.message, null, r.statusCode);
    }

    // ── several bills ──
    if (items.length === 0) return errorResponse(res, "No bills sent", null, 400);
    const results = [];
    for (const item of items) {
      const hold = item.appraisalHold !== undefined && item.appraisalHold !== "" ? apiToInternalHold(item.appraisalHold) : defaultHold;
      const remark = typeof item.remark === "string" && item.remark.trim() ? item.remark.trim() : defaultRemark;
      const r = await processAppraisalHold({ mediaId: item.mediaId, rentalDueId: item.rentalDueId, hold, remark, user: req.user });
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
    const holds = (media.rentalDue || [])
      .filter((e) => e.appraisalHold && (e.appraisalHold.heldAt || Number(e.appraisalHold.hold) === 1))
      .filter((e) => !rentalDueId || String(e._id) === rentalDueId)
      .map((e) => {
        const h = e.appraisalHold || {};
        const face = (media.mediaDetails || []).find((d) => String(d._id) === String(e.mediaDetailId));
        return {
          rentalDueId: e._id,
          mediaDetailId: e.mediaDetailId || null,
          mediaCode: face?.mediaCode || faces.map((d) => d.mediaCode).filter(Boolean).join(" / "),
          mediaName: face?.mediaName || faces.map((d) => d.mediaName).filter(Boolean).join(", "),
          dueMonth: e.dueMonth || "",
          dueDate: e.dueDate || null,
          approvalStatus: e.approvalStatus ?? null,
          hold: internalToApiHold(h.hold), // ✅ CHANGED — 0 = on hold, 1 = released
          holdStatus: Number(h.hold) === 1 ? "On Hold" : "Released",
          appraisalAmount: Number(h.appraisalAmount || 0),
          rentWithAppraisal: Number(h.rentWithAppraisal || 0),
          rentWithoutAppraisal: Number(h.rentWithoutAppraisal || 0),
          remark: h.remark || "",
          heldBy: h.heldBy || "",
          heldAt: h.heldAt || null,
          releasedBy: h.releasedBy || "",
          releasedAt: h.releasedAt || null,
          releaseReason: h.releaseReason || "", // ✅ NEW — entered on release
        };
      })
      .sort((a, b) => new Date(b.heldAt || 0) - new Date(a.heldAt || 0));

    return successResponse(res, "Appraisal hold remarks fetched successfully", {
      mediaId: media._id,
      mediaCode: faces.map((d) => d.mediaCode).filter(Boolean).join(" / "),
      mediaName: faces.map((d) => d.mediaName).filter(Boolean).join(", "),
      // ✅ NEW — the site's appraisal applicable (0 while the appraisal is held)
      appraisalApplicable: Number(media.appraisal?.applicable) === 1 ? 1 : 0,
      totalCount: holds.length,
      onHoldCount: holds.filter((h) => h.holdStatus === "On Hold").length,
      holds,
    });
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};
