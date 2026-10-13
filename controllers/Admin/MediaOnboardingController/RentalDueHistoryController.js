const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const RentalDueChangeHistory = require("../../../models/Admin/MediaOnboardingSchema/RentalDueChangeHistorySchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

// ─────────────────────────────────────────────────────────────
// RENTAL DUE CHANGE HISTORY
// saveRentalDue records every change of campaignName / reason /
// proofOfCampaign / invoice here (after a successful save); the history API
// returns them per site, grouped by due month.
// ─────────────────────────────────────────────────────────────
const ROLE_LABEL = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
const FIELD_ORDER = ["campaignName", "reason", "proofOfCampaign", "invoice"];

const toObjectId = (id) =>
  id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;

// Compares the incoming saveRentalDue values with the bill BEFORE they are
// applied. Returns [] when nothing changes. Text: only a non-empty value that
// differs; files: every newly uploaded file.
function collectRentalDueChanges(entry, { campaignName, reason, proofOfCampaign, invoice }) {
  const changes = [];
  const text = (v) => (v === undefined || v === null ? "" : String(v));
  if (campaignName && text(campaignName) !== text(entry?.campaignName)) {
    changes.push({ fieldName: "campaignName", oldValue: text(entry?.campaignName), newValue: text(campaignName) });
  }
  if (reason && text(reason) !== text(entry?.reason)) {
    changes.push({ fieldName: "reason", oldValue: text(entry?.reason), newValue: text(reason) });
  }
  const fileChange = (fieldName, oldFile, newFile) => {
    if (!newFile) return;
    changes.push({
      fieldName,
      oldValue: oldFile?.fileName || null,
      newValue: newFile.fileName || null,
      oldFilePath: oldFile?.filePath || null,
      newFilePath: newFile.filePath || null,
    });
  };
  fileChange("proofOfCampaign", entry?.proofOfCampaign, proofOfCampaign);
  fileChange("invoice", entry?.invoice, invoice);
  return changes;
}

// Writes one history record. Never throws and is not awaited by callers, so
// the rental due save is never affected.
function recordRentalDueChanges({ media, entry, changes, userId, userName, userType }) {
  if (!media || !entry || !Array.isArray(changes) || changes.length === 0) return;
  RentalDueChangeHistory.create({
    mediaId: media._id,
    rentalDueId: entry._id,
    mediaDetailId: entry.mediaDetailId || null,
    dueMonth: entry.dueMonth || "",
    dueDate: entry.dueDate || null,
    changes,
    updatedBy: userName || "",
    updatedByUserId: toObjectId(userId),
    updatedByRole: ROLE_LABEL[Number(userType)] ? Number(userType) : null,
    createdAt: nowIST(),
  }).catch((err) => console.error("[RentalDueChangeHistory] record failed:", err.message));
}

// ─────────────────────────────────────────────────────────────
// POST /admin/rental-due-history
// body: { mediaId, pageNumber?, count? } — count = due months per page
// mediaId: one id (string) or an array of ids. One site → site details at the
// top (unchanged shape); several sites → each month block carries its site.
// ─────────────────────────────────────────────────────────────
const siteInfoOf = (media) => {
  const details = media.mediaDetails || [];
  const activeFaces = details.filter((d) => Number(d.status) === 1);
  const shownFaces = activeFaces.length ? activeFaces : details;
  return {
    mediaId: media._id,
    siteName: shownFaces.map((d) => d.mediaName).filter(Boolean).join(", "),
    siteCode: shownFaces.map((d) => d.mediaCode).filter(Boolean).join(", "),
    landOwnerName: (media.landOwners || []).map((o) => o.name).filter(Boolean).join(", "),
  };
};

const getRentalDueHistory = async (req, res) => {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const rawIds = (Array.isArray(params.mediaId) ? params.mediaId : [params.mediaId])
      .map((id) => (typeof id === "string" ? id.trim() : id))
      .filter((id) => id !== undefined && id !== null && id !== "");
    const uniqueIds = [...new Set(rawIds.map(String))];
    const mediaObjectIds = uniqueIds.map(toObjectId);
    if (mediaObjectIds.length === 0 || mediaObjectIds.some((id) => !id)) {
      return errorResponse(res, "A valid mediaId is required", null, 400);
    }
    const isMulti = mediaObjectIds.length > 1;

    const pageNumber = Math.max(parseInt(params.pageNumber) || 1, 1);
    const count = Math.max(parseInt(params.count) || 10, 1);

    const medias = await Media.find({ _id: { $in: mediaObjectIds } }).select("mediaDetails landOwners").lean();
    if (medias.length === 0) return errorResponse(res, "Media not found", null, 404);
    const siteById = new Map(medias.map((m) => [String(m._id), siteInfoOf(m)]));
    const foundIds = medias.map((m) => m._id);

    // one group per bill (rentalDueId), newest due month first (latest change
    // first when several sites share a month)
    const [grouped] = await RentalDueChangeHistory.aggregate([
      { $match: { mediaId: { $in: foundIds } } },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: "$rentalDueId",
          mediaId: { $last: "$mediaId" },
          dueMonth: { $last: "$dueMonth" },
          dueDate: { $last: "$dueDate" },
          lastChangedAt: { $max: "$createdAt" },
        },
      },
      { $sort: { dueDate: -1, lastChangedAt: -1, _id: -1 } },
      {
        $facet: {
          total: [{ $count: "n" }],
          page: [{ $skip: (pageNumber - 1) * count }, { $limit: count }],
        },
      },
    ]);
    const totalMonths = grouped?.total?.[0]?.n || 0;
    const pageGroups = grouped?.page || [];

    const records = pageGroups.length
      ? await RentalDueChangeHistory.find({
          mediaId: { $in: foundIds },
          rentalDueId: { $in: pageGroups.map((g) => g._id) },
        })
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const history = pageGroups.map((g) => {
      const updates = records
        .filter((r) => String(r.rentalDueId) === String(g._id))
        .flatMap((r) =>
          (r.changes || []).map((c) => ({
            fieldName: c.fieldName,
            oldValue: c.oldValue ?? null,
            newValue: c.newValue ?? null,
            // file rows (proofOfCampaign / invoice) also carry the full links
            ...(c.fieldName === "proofOfCampaign" || c.fieldName === "invoice"
              ? { oldUrl: c.oldFilePath ?? null, newUrl: c.newFilePath ?? null }
              : {}),
            updatedBy: r.updatedBy || "",
            role: ROLE_LABEL[r.updatedByRole] || "",
            updatedAt: r.createdAt,
          })),
        )
        // field by field (campaignName, reason, proofOfCampaign, invoice), oldest first
        .sort(
          (a, b) =>
            FIELD_ORDER.indexOf(a.fieldName) - FIELD_ORDER.indexOf(b.fieldName) ||
            new Date(a.updatedAt) - new Date(b.updatedAt),
        );
      const block = { dueMonth: g.dueMonth, rentalDueId: g._id, updates };
      return isMulti ? { ...siteById.get(String(g.mediaId)), ...block } : block;
    });

    const pagination = {
      pageNumber,
      count,
      totalMonths,
      totalPages: Math.ceil(totalMonths / count),
    };

    return successResponse(
      res,
      "Rental history fetched successfully",
      isMulti ? { pagination, history } : { ...siteById.get(String(medias[0]._id)), pagination, history },
    );
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

module.exports = { collectRentalDueChanges, recordRentalDueChanges, getRentalDueHistory };
