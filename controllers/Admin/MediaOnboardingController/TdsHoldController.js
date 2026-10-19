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
  if (![0, 1].includes(hold)) return fail(400, "tdsHold must be 1 (hold) or 0 (release)");

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
    if (Number(owner.tdsApplicable || 0) !== 1) {
      return fail(400, `TDS is not applicable for ${name} — nothing to hold`);
    }
    if (isHeld) {
      // already held → only the remark changes
      detail = { ...existing, remark: remark || existing.remark || "" };
      tdsAmount = 0;
    } else {
      detail = {
        tdsAmountBeforeHold: Number(owner.tdsAmount || 0) || computeOwnerTds(owner),
        remark,
        heldBy: userName,
        heldByUserId: toObjectId(user?.userId),
        heldAt: nowIST(),
        releasedBy: "",
        releasedAt: null,
        releaseReason: "",
      };
      tdsAmount = 0;
    }
    $set["landOwners.$[o].tdsHold"] = 1;
    $set["landOwners.$[o].tdsAmount"] = 0;
  } else {
    detail = { ...existing, releasedBy: userName, releasedAt: nowIST(), releaseReason: remark || "" };
    tdsAmount = computeOwnerTds(owner); // current share / online amounts
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
      tdsHold: hold,
      tdsPercentage: Number(owner.tdsPercentage || 0),
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

const setTdsHold = async (req, res) => {
  try {
    if (Number(req.user?.userType) !== ROLE.OWNER) {
      return errorResponse(res, "Only CMD can hold TDS", null, 403);
    }
    const body = { ...(req.query || {}), ...(req.body || {}) };
    const defaultHold = Number(body.tdsHold);
    const defaultRemark = typeof body.remark === "string" ? body.remark.trim() : "";
    const items = parseTdsHoldItems(body);

    if (!items) {
      const r = await processTdsHold({ mediaId: body.mediaId, landOwnerId: body.landOwnerId, hold: defaultHold, remark: defaultRemark, user: req.user });
      return r.success ? successResponse(res, r.message, r.data) : errorResponse(res, r.message, null, r.statusCode);
    }

    if (items.length === 0) return errorResponse(res, "No landowners sent", null, 400);
    const results = [];
    for (const item of items) {
      const hold = item.tdsHold !== undefined && item.tdsHold !== "" ? Number(item.tdsHold) : defaultHold;
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

module.exports = { setTdsHold };
