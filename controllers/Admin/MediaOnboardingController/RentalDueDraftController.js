// ─────────────────────────────────────────────────────────────
// RENTAL DUE — SAVE AS DRAFT
// POST /admin/rental-due-save-draft   (multipart/form-data, same keys as
// /admin/rental-due-save)
//   single: mediaId, rentalDueId, campaignName, campaignStatus (0 / 1), reason, withGst,
//           gstApplicableFlag, pastgstApplicableFlag, proofOfCampaign (file),
//           invoice (file)
//   batch : entries[i][...] (+ files entries[i][proofOfCampaign] / [invoice])
// Saves the values in rentalDue[].draft ONLY — no approval step, no status
// change, no notification / Google Chat / mail; the bill's real fields are
// not touched. One draft per bill (fields not sent keep their draft value).
// The draft is cleared when the bill is saved with /admin/rental-due-save.
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { ROLE } = require("../../../models/Admin/MediaOnboardingSchema/RentalDueModel");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

const ROLE_NAME = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
const hasValue = (v) => v !== undefined && v !== null && v !== "";
const toObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || "")) ? new mongoose.Types.ObjectId(String(id)) : null;

// same file rules as /admin/rental-due-save
function fileError(field, file) {
  if (!file) return null;
  if (field === "proofOfCampaign" && !file.mimetype?.startsWith("image/")) {
    return "Proof of campaign must be an image file";
  }
  if (field === "invoice" && file.mimetype !== "application/pdf" && !file.mimetype?.startsWith("image/")) {
    return "Invoice must be a PDF or image file";
  }
  return null;
}

// entries[] — array, {"0":{...}} object, or flat "entries[0][field]" keys
function parseEntries(body) {
  const { entries } = body;
  if (Array.isArray(entries)) return entries;
  if (entries && typeof entries === "object") {
    const keys = Object.keys(entries).filter((k) => /^\d+$/.test(k));
    if (keys.length) return keys.sort((a, b) => a - b).map((k) => entries[k]);
  }
  const manual = {};
  Object.keys(body).forEach((key) => {
    const m = key.match(/^entries\[(\d+)\]\[(\w+)\]$/);
    if (m) {
      manual[m[1]] = manual[m[1]] || {};
      manual[m[1]][m[2]] = body[key];
    }
  });
  const idx = Object.keys(manual).sort((a, b) => a - b);
  return idx.length ? idx.map((i) => manual[i]) : null;
}

// one bill → { success, statusCode, message, data }. Never throws for a business error.
async function saveOneDraft({ item, proofOfCampaign, invoice, user }) {
  const { mediaId, rentalDueId } = item;
  const fail = (statusCode, message) => ({ success: false, statusCode, message, mediaId: mediaId || null, rentalDueId: rentalDueId || null });
  if (!mongoose.Types.ObjectId.isValid(String(mediaId || "")) || !mongoose.Types.ObjectId.isValid(String(rentalDueId || ""))) {
    return fail(400, "Valid mediaId and rentalDueId are required");
  }
  const media = await Media.findById(mediaId).select("rentalDue").lean();
  if (!media) return fail(404, "Media not found");
  const entry = (media.rentalDue || []).find((e) => String(e._id) === String(rentalDueId));
  if (!entry) return fail(404, "Rental due entry not found");
  if (Number(entry.approvalStatus) === 3) {
    return fail(400, "This bill is already fully approved — draft not allowed");
  }

  // ✅ NEW — campaignStatus: only 0 or 1 (not sent / "" → the draft's value is kept)
  if (hasValue(item.campaignStatus) && ![0, 1].includes(Number(item.campaignStatus))) {
    return fail(400, "campaignStatus must be 0 or 1");
  }

  const prev = entry.draft && Number(entry.draft.isDraft) === 1 ? entry.draft : {};
  const num = (v, fallback) => (hasValue(v) && !Number.isNaN(Number(v)) ? Number(v) : fallback ?? null);
  const draft = {
    isDraft: 1,
    campaignName: hasValue(item.campaignName) ? String(item.campaignName).trim() : prev.campaignName || "",
    campaignStatus: num(item.campaignStatus, prev.campaignStatus), // ✅ NEW
    reason: hasValue(item.reason) ? String(item.reason).trim() : prev.reason || "",
    withGst: num(item.withGst, prev.withGst),
    gstApplicableFlag: num(item.gstApplicableFlag, prev.gstApplicableFlag),
    pastgstApplicableFlag: num(item.pastgstApplicableFlag, prev.pastgstApplicableFlag),
    proofOfCampaign: proofOfCampaign || prev.proofOfCampaign || null,
    invoice: invoice || prev.invoice || null,
    savedBy: { userId: toObjectId(user?.userId), userName: user?.userName || "", role: Number(user?.userType) || null },
    savedAt: nowIST(),
  };

  // only this bill's draft — no media.save(), so nothing else is recalculated
  await Media.updateOne(
    { _id: media._id },
    { $set: { "rentalDue.$[e].draft": draft } },
    { arrayFilters: [{ "e._id": entry._id }], timestamps: false },
  );

  return {
    success: true,
    statusCode: 200,
    message: `Draft saved for ${entry.dueMonth || "this bill"}`,
    data: {
      mediaId: media._id,
      rentalDueId: entry._id,
      dueMonth: entry.dueMonth || "",
      draft: { ...draft, savedBy: { ...draft.savedBy, roleName: ROLE_NAME[draft.savedBy.role] || "" } },
    },
  };
}

const saveRentalDueDraft = async (req, res) => {
  try {
    const userType = Number(req.user?.userType);
    if (![ROLE.STAFF, ROLE.TEAM_LEAD, ROLE.OWNER].includes(userType)) {
      return errorResponse(res, "Invalid or missing user role", null, 403);
    }
    const body = req.body || {};
    const files = req.files || [];
    const processFile = typeof req.processFile === "function" ? req.processFile : null;
    const entries = parseEntries(body);

    // ── single bill ──
    if (!entries || entries.length === 0) {
      const proofFile = files.find((f) => f.fieldname === "proofOfCampaign");
      const invoiceFile = files.find((f) => f.fieldname === "invoice");
      const bad = fileError("proofOfCampaign", proofFile) || fileError("invoice", invoiceFile);
      if (bad) return errorResponse(res, bad, null, 400);
      const r = await saveOneDraft({
        item: body,
        proofOfCampaign: proofFile && processFile ? processFile(proofFile) : null,
        invoice: invoiceFile && processFile ? processFile(invoiceFile) : null,
        user: req.user,
      });
      return r.success ? successResponse(res, r.message, r.data) : errorResponse(res, r.message, null, r.statusCode);
    }

    // ── several bills ──
    const results = [];
    for (let i = 0; i < entries.length; i++) {
      const proofFile = files.find((f) => f.fieldname === `entries[${i}][proofOfCampaign]`);
      const invoiceFile = files.find((f) => f.fieldname === `entries[${i}][invoice]`);
      const bad = fileError("proofOfCampaign", proofFile) || fileError("invoice", invoiceFile);
      if (bad) {
        results.push({ success: false, statusCode: 400, message: bad, mediaId: entries[i]?.mediaId || null, rentalDueId: entries[i]?.rentalDueId || null });
        continue;
      }
      const r = await saveOneDraft({
        item: entries[i] || {},
        proofOfCampaign: proofFile && processFile ? processFile(proofFile) : null,
        invoice: invoiceFile && processFile ? processFile(invoiceFile) : null,
        user: req.user,
      });
      results.push(
        r.success
          ? { success: true, message: r.message, ...r.data }
          : { success: false, statusCode: r.statusCode, message: r.message, mediaId: r.mediaId, rentalDueId: r.rentalDueId },
      );
    }
    const successCount = results.filter((r) => r.success).length;
    const message = `Draft saved for ${successCount} of ${results.length} bill(s)`;
    if (successCount === 0) return errorResponse(res, message, { results }, 400);
    return successResponse(res, message, { totalCount: results.length, successCount, failedCount: results.length - successCount, results });
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};

// response helper for /admin/rental-due-list → rentalDueEntries[].draft
function formatDraft(draft) {
  if (!draft || Number(draft.isDraft) !== 1) return { isDraft: 0 };
  const role = Number(draft.savedBy?.role) || null;
  return {
    isDraft: 1,
    campaignName: draft.campaignName || "",
    campaignStatus: draft.campaignStatus ?? null, // ✅ NEW
    reason: draft.reason || "",
    withGst: draft.withGst ?? null,
    gstApplicableFlag: draft.gstApplicableFlag ?? null,
    pastgstApplicableFlag: draft.pastgstApplicableFlag ?? null,
    proofOfCampaign: draft.proofOfCampaign || null,
    invoice: draft.invoice || null,
    savedBy: { userName: draft.savedBy?.userName || "", role, roleName: ROLE_NAME[role] || "" },
    savedAt: draft.savedAt || null,
  };
}

module.exports = { saveRentalDueDraft, formatDraft };
