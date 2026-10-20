// ─────────────────────────────────────────────────────────────
// TDS HOLD — CMD-only hold of a landowner's TDS on one site.
// POST /admin/tds-hold
//   single: { mediaId, landOwnerId, tdsHold: 1 | 0, remark }
//   batch : { entries: [ { mediaId, landOwnerId, tdsHold, remark } ], tdsHold?, remark? }
// landOwnerId = the site's landOwners[]._id (landOwnerMasterId also accepted).
// Hold    → landOwners[].tdsHold 1, tdsAmount 0 (the save hook keeps it 0
//           while held), the TDS before the hold is kept in tdsHoldDetail.
// Release → tdsHold 0, tdsAmount recalculated with the same formula as the
//           save hook; remark = the release reason.
// Only that landowner's TDS fields are written (direct $set, no media.save()).
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { ROLE } = require("../../../models/Admin/MediaOnboardingSchema/RentalDueModel");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

// same TDS formula as MediaSchema.pre("save")
function computeOwnerTds(owner) {
  if (Number(owner?.tdsApplicable || 0) !== 1) return 0;
  const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
  const tdsPercentage = envTdsPercent > 0 ? envTdsPercent : Number(owner.tdsPercentage || 10);
  const cat = Number(owner.paymentCategory || 1);
  const base = cat === 2 ? Number(owner.shareAmount || 0) : cat === 3 ? Number(owner.onlineAmount || 0) : 0;
  return tdsPercentage > 0 ? Math.floor((base * tdsPercentage) / 100) : 0;
}

const toObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || "")) ? new mongoose.Types.ObjectId(String(id)) : null;

// one landowner → { success, statusCode, message, data }. Never throws for a business error.
async function processTdsHold({ mediaId, landOwnerId, hold, remark, user }) {
  const fail = (statusCode, message) => ({ success: false, statusCode, message, mediaId: mediaId || null, landOwnerId: landOwnerId || null });
  if (!mongoose.Types.ObjectId.isValid(String(mediaId || "")) || !mongoose.Types.ObjectId.isValid(String(landOwnerId || ""))) {
    return fail(400, "Valid mediaId and landOwnerId are required");
  }
  if (![0, 1].includes(hold)) return fail(400, "tdsHold must be 0 (hold) or 1 (release)");

  const media = await Media.findById(mediaId).select("landOwners").lean();
  if (!media) return fail(404, "Media not found");
  const owner = (media.landOwners || []).find(
    (o) => String(o._id) === String(landOwnerId) || String(o.landOwnerMasterId || "") === String(landOwnerId),
  );
  if (!owner) return fail(404, "Landowner not found on this site");

  const name = owner.name || "landowner";
  const userName = user?.userName || "CMD";
  const existing = owner.tdsHoldDetail || {};
  const isHeld = Number(owner.tdsHold) === 1;
  const $set = {};
  let detail;
  let tdsAmount;

  if (hold === 1) {
    if (isHeld) {
      // already held → only the remark changes (checked BEFORE "not applicable",
      // since a held landowner now shows tdsApplicable 0)
      detail = { ...existing, remark: remark || existing.remark || "" };
      // ✅ NEW — an older hold (before tdsApplicable followed the hold) gets
      // tdsApplicable 0 now, with the values to restore saved
      if (Number(owner.tdsApplicable || 0) === 1) {
        detail.tdsApplicableBefore = 1;
        detail.tdsPercentageBefore = Number(owner.tdsPercentage || 0);
        $set["landOwners.$[o].tdsApplicable"] = 0;
      }
      tdsAmount = 0;
    } else {
      if (Number(owner.tdsApplicable || 0) !== 1) {
        return fail(400, `TDS is not applicable for ${name} — nothing to hold`);
      }
      detail = {
        tdsAmountBeforeHold: Number(owner.tdsAmount || 0) || computeOwnerTds(owner),
        // ✅ NEW — restored on release
        tdsApplicableBefore: 1,
        tdsPercentageBefore: Number(owner.tdsPercentage || 0),
        remark,
        heldBy: userName,
        heldByUserId: toObjectId(user?.userId),
        heldAt: nowIST(),
        releasedBy: "",
        releasedAt: null,
        releaseReason: "",
      };
      tdsAmount = 0;
      // ✅ NEW — the site's landowner shows TDS not applicable while held
      $set["landOwners.$[o].tdsApplicable"] = 0;
    }
    $set["landOwners.$[o].tdsHold"] = 1;
    $set["landOwners.$[o].tdsAmount"] = 0;
  } else {
    detail = { ...existing, releasedBy: userName, releasedAt: nowIST(), releaseReason: remark || "" };
    // ✅ NEW — put back tdsApplicable / tdsPercentage the hold switched off
    // (older holds saved nothing → left as they are)
    const restoreApplicable = isHeld && Number(existing.tdsApplicableBefore) === 1;
    const ownerAfter = restoreApplicable
      ? {
          ...owner,
          tdsApplicable: 1,
          tdsPercentage: Number(existing.tdsPercentageBefore) || Number(owner.tdsPercentage || 0),
        }
      : owner;
    if (restoreApplicable) {
      $set["landOwners.$[o].tdsApplicable"] = 1;
      $set["landOwners.$[o].tdsPercentage"] = ownerAfter.tdsPercentage;
    }
    tdsAmount = computeOwnerTds(ownerAfter); // current share / online amounts
    $set["landOwners.$[o].tdsHold"] = 0;
    $set["landOwners.$[o].tdsAmount"] = tdsAmount;
  }
  $set["landOwners.$[o].tdsHoldDetail"] = detail;

  await Media.updateOne({ _id: media._id }, { $set }, { arrayFilters: [{ "o._id": owner._id }], timestamps: false });

  return {
    success: true,
    statusCode: 200,
    message: hold === 1 ? `TDS put on hold for ${name}` : `TDS hold released for ${name}`,
    data: {
      mediaId: media._id,
      landOwnerId: owner._id,
      landOwnerMasterId: owner.landOwnerMasterId || null,
      landOwnerName: owner.name || "",
      tdsHold: hold === 1 ? 0 : 1, // ✅ CHANGED — API value: 0 = held, 1 = released
      // ✅ NEW — the landowner's tdsApplicable after this call (0 while held)
      tdsApplicable:
        $set["landOwners.$[o].tdsApplicable"] !== undefined
          ? $set["landOwners.$[o].tdsApplicable"]
          : Number(owner.tdsApplicable) === 1 ? 1 : 0,
      tdsPercentage:
        $set["landOwners.$[o].tdsPercentage"] !== undefined
          ? $set["landOwners.$[o].tdsPercentage"]
          : Number(owner.tdsPercentage || 0),
      tdsAmountBeforeHold: Number(detail.tdsAmountBeforeHold || 0),
      tdsAmount,
      remark: detail.remark || "",
      heldBy: detail.heldBy || "",
      heldAt: detail.heldAt || null,
      releasedBy: detail.releasedBy || "",
      releasedAt: detail.releasedAt || null,
      releaseReason: detail.releaseReason || "",
    },
  };
}

// entries[] (or {"0":{...}} from form-data) OR parallel arrays mediaId[] /
// landOwnerId[]. Top-level tdsHold / remark are the defaults for every item.
function parseTdsHoldItems(body) {
  const asArray = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.keys(v).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b).map((k) => v[k]);
    if (typeof v === "string" && v.trim().startsWith("[")) {
      try { return JSON.parse(v); } catch { return null; }
    }
    return null;
  };
  const entries = asArray(body.entries);
  if (entries && entries.length) return entries.map((e) => ({ ...(e || {}) }));
  const mediaIds = asArray(body.mediaId);
  const ownerIds = asArray(body.landOwnerId);
  if (!mediaIds && !ownerIds) return null; // single request
  const count = Math.max(mediaIds?.length || 0, ownerIds?.length || 0);
  return Array.from({ length: count }, (_, i) => ({
    mediaId: mediaIds ? mediaIds[i] ?? mediaIds[0] : body.mediaId,
    landOwnerId: ownerIds ? ownerIds[i] : body.landOwnerId,
  }));
}

// ✅ CHANGED — API value: tdsHold 0 = HOLD, 1 = RELEASE (not hold), same as
// appraisalHold. Converted to the stored value (1 = held, 0 = not held), which
// the save hook relies on to keep a held landowner's TDS at 0.
const apiToInternalHold = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(v);
  return n === 0 ? 1 : n === 1 ? 0 : NaN;
};
// stored value → API value (0 = held, 1 = not held)
const internalToApiHold = (v) => (Number(v) === 1 ? 0 : 1);

const setTdsHold = async (req, res) => {
  try {
    if (Number(req.user?.userType) !== ROLE.OWNER) {
      return errorResponse(res, "Only CMD can hold TDS", null, 403);
    }
    const body = { ...(req.query || {}), ...(req.body || {}) };
    const defaultHold = apiToInternalHold(body.tdsHold);
    const defaultRemark = typeof body.remark === "string" ? body.remark.trim() : "";
    const items = parseTdsHoldItems(body);

    if (!items) {
      const r = await processTdsHold({ mediaId: body.mediaId, landOwnerId: body.landOwnerId, hold: defaultHold, remark: defaultRemark, user: req.user });
      return r.success ? successResponse(res, r.message, r.data) : errorResponse(res, r.message, null, r.statusCode);
    }

    if (items.length === 0) return errorResponse(res, "No landowners sent", null, 400);
    const results = [];
    for (const item of items) {
      const hold = item.tdsHold !== undefined && item.tdsHold !== "" ? apiToInternalHold(item.tdsHold) : defaultHold;
      const remark = typeof item.remark === "string" && item.remark.trim() ? item.remark.trim() : defaultRemark;
      const r = await processTdsHold({ mediaId: item.mediaId, landOwnerId: item.landOwnerId, hold, remark, user: req.user });
      results.push(
        r.success
          ? { success: true, message: r.message, ...r.data }
          : { success: false, statusCode: r.statusCode, message: r.message, mediaId: r.mediaId, landOwnerId: r.landOwnerId },
      );
    }
    const successCount = results.filter((r) => r.success).length;
    const message = `TDS hold updated for ${successCount} of ${results.length} landowner(s)`;
    if (successCount === 0) return errorResponse(res, message, { results }, 400);
    return successResponse(res, message, { totalCount: results.length, successCount, failedCount: results.length - successCount, results });
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW — TDS hold list of one site (read only): every landowner whose TDS
// was ever held (current hold or released), with its remark — newest first.
// landOwnerId (optional, landOwners[]._id or landOwnerMasterId) → just that one.
// Used by GET /admin/tds-hold-remarks (getTdsHoldRemarks below).
// ─────────────────────────────────────────────────────────────
function buildTdsHoldList(media, landOwnerId = "") {
  return (media?.landOwners || [])
    .filter((o) => o && o.tdsHoldDetail && (o.tdsHoldDetail.heldAt || Number(o.tdsHold) === 1))
    .filter(
      (o) => !landOwnerId || String(o._id) === String(landOwnerId) || String(o.landOwnerMasterId || "") === String(landOwnerId),
    )
    .map((o) => {
      const t = o.tdsHoldDetail || {};
      const held = Number(o.tdsHold) === 1;
      return {
        landOwnerId: o._id,
        landOwnerMasterId: o.landOwnerMasterId || null,
        landOwnerName: o.name || "",
        tdsApplicable: Number(o.tdsApplicable) === 1 ? 1 : 0,
        tdsPercentage: Number(o.tdsPercentage || 0),
        hold: held ? 0 : 1, // ✅ CHANGED — API value: 0 = on hold, 1 = released
        holdStatus: held ? "On Hold" : "Released",
        tdsAmountBeforeHold: Number(t.tdsAmountBeforeHold || 0),
        tdsAmount: Number(o.tdsAmount || 0),
        remark: t.remark || "",
        heldBy: t.heldBy || "",
        heldAt: t.heldAt || null,
        releasedBy: t.releasedBy || "",
        releasedAt: t.releasedAt || null,
        releaseReason: t.releaseReason || "",
      };
    })
    .sort((a, b) => new Date(b.heldAt || 0) - new Date(a.heldAt || 0));
}

// ─────────────────────────────────────────────────────────────
// ✅ NEW — GET /admin/tds-hold-remarks?mediaId=&landOwnerId=
// Read only, any logged-in role — separate from appraisal-hold-remarks.
// landOwnerId (optional, landOwners[]._id or landOwnerMasterId) → just that one.
// ─────────────────────────────────────────────────────────────
const getTdsHoldRemarks = async (req, res) => {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const mediaId = String(params.mediaId || "").trim();
    const landOwnerId = params.landOwnerId ? String(params.landOwnerId).trim() : "";
    if (!mongoose.Types.ObjectId.isValid(mediaId)) {
      return errorResponse(res, "A valid mediaId is required", null, 400);
    }
    if (landOwnerId && !mongoose.Types.ObjectId.isValid(landOwnerId)) {
      return errorResponse(res, "Invalid landOwnerId", null, 400);
    }

    const media = await Media.findById(mediaId).select("mediaDetails landOwners").lean();
    if (!media) return errorResponse(res, "Media not found", null, 404);

    const faces = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);
    const holds = buildTdsHoldList(media, landOwnerId);
    // ✅ NEW — TDS applicable status, shown even when nothing was ever held
    const siteOwners = (media.landOwners || []).filter(
      (o) => !landOwnerId || String(o._id) === landOwnerId || String(o.landOwnerMasterId || "") === landOwnerId,
    );
    const landOwners = siteOwners.map((o) => ({
      landOwnerId: o._id,
      landOwnerMasterId: o.landOwnerMasterId || null,
      landOwnerName: o.name || "",
      tdsApplicable: Number(o.tdsApplicable) === 1 ? 1 : 0,
      tdsPercentage: Number(o.tdsPercentage || 0),
      tdsAmount: Number(o.tdsAmount || 0),
      tdsHold: internalToApiHold(o.tdsHold), // ✅ CHANGED — 0 = on hold, 1 = not held
    }));
    return successResponse(res, "TDS hold remarks fetched successfully", {
      mediaId: media._id,
      mediaCode: faces.map((d) => d.mediaCode).filter(Boolean).join(" / "),
      mediaName: faces.map((d) => d.mediaName).filter(Boolean).join(", "),
      tdsApplicable: landOwners.some((o) => o.tdsApplicable === 1) ? 1 : 0, // 1 = any landowner has TDS
      landOwners,
      totalCount: holds.length,
      onHoldCount: holds.filter((h) => h.holdStatus === "On Hold").length,
      holds,
    });
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};

module.exports = { setTdsHold, buildTdsHoldList, getTdsHoldRemarks };
