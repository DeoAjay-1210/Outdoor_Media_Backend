// ─────────────────────────────────────────────────────────────
// ✅ NEW — CAMPAIGN STATUS UPDATE (one bill)
// POST /admin/rental-due/campaign-status
//   { mediaCode, dueMonth: "October 2026" (or "10-2026" / "Oct 2026"), campaignStatus: 0 | 1 }
// mediaCode = mediaDetails[].mediaCode (case-insensitive) → that face's bill of
// dueMonth (a site-wide / single bill of that month when the face has none).
// Only rentalDue[].campaignStatus (+ updatedBy / updatedAt) is written — direct
// $set, no media.save(): amount, approval, payment, mail and draft unchanged.
// ─────────────────────────────────────────────────────────────
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const monthKey = (d) => {
  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt.getUTCFullYear() * 12 + dt.getUTCMonth() : null;
};
const monthLabelOfKey = (k) => `${MONTHS[k % 12]} ${Math.floor(k / 12)}`;

// "October 2026" / "Oct 2026" / "2026-10" / "10-2026" → month key, null when invalid
function parseDueMonthKey(value) {
  const s = String(value || "").trim();
  let m = s.match(/^(\d{1,2})-(\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    return month >= 1 && month <= 12 ? Number(m[2]) * 12 + (month - 1) : null;
  }
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? Number(m[1]) * 12 + (month - 1) : null;
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const idx = MONTHS.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
    return idx >= 0 ? Number(m[2]) * 12 + idx : null;
  }
  return null;
}

exports.updateCampaignStatus = async (req, res) => {
  try {
    const { mediaCode, dueMonth, campaignStatus } = req.body || {};

    if (!mediaCode || String(mediaCode).trim() === "") return errorResponse(res, "mediaCode is required", null, 400);
    if (!dueMonth || String(dueMonth).trim() === "") return errorResponse(res, "dueMonth is required", null, 400);
    const key = parseDueMonthKey(dueMonth);
    if (key === null) return errorResponse(res, 'dueMonth is invalid — send like "October 2026"', null, 400);
    if (campaignStatus === undefined || campaignStatus === null || String(campaignStatus).trim() === "" || ![0, 1].includes(Number(campaignStatus))) {
      return errorResponse(res, "campaignStatus must be 0 or 1", null, 400);
    }
    const status = Number(campaignStatus);
    const code = String(mediaCode).trim();
    const monthLabel = monthLabelOfKey(key);

    const codeRegex = new RegExp(`^\\s*${escapeRegex(code)}\\s*$`, "i");
    const media = await Media.findOne({ "mediaDetails.mediaCode": codeRegex }).select("mediaDetails rentalDue").lean();
    if (!media) return errorResponse(res, `Media not found for mediaCode ${code}`, null, 404);
    const face = (media.mediaDetails || []).find((d) => codeRegex.test(String(d?.mediaCode || "")));

    // bills of that month → this face's bills, else the site-wide ones, else the only bill.
    // ✅ FIXED — a face can hold MORE than one bill for the same month (duplicate
    // rows); all of them are updated, so the CMD approved one is never missed.
    const monthBills = (media.rentalDue || []).filter(
      (b) => b && (monthKey(b.dueDate) === key || String(b.dueMonth || "").trim().toLowerCase() === monthLabel.toLowerCase()),
    );
    const faceBills = face ? monthBills.filter((b) => b.mediaDetailId && String(b.mediaDetailId) === String(face._id)) : [];
    const siteBills = monthBills.filter((b) => !b.mediaDetailId);
    // single-face site → every bill of the month is that face's (even with an old face id)
    const singleFace = (media.mediaDetails || []).length <= 1;
    // ✅ CHANGED — only the sent mediaCode's face is updated (a combined site's
    // other faces are not touched)
    const targets = faceBills.length
      ? faceBills
      : siteBills.length
        ? siteBills
        : monthBills.length === 1 || singleFace
          ? monthBills
          : [];
    if (!targets.length) return errorResponse(res, `No bill for ${monthLabel} on ${code}`, null, 404);
    // the bill shown in the response: the most approved one (same rule as the ledger)
    const bill = [...targets].sort((a, b) => Number(b.approvalStatus || 0) - Number(a.approvalStatus || 0))[0];

    const userName = req.user?.userName || "";
    const now = nowIST();
    await Media.updateOne(
      { _id: media._id },
      {
        $set: {
          "rentalDue.$[d].campaignStatus": status,
          "rentalDue.$[d].updatedBy": userName,
          "rentalDue.$[d].updatedAt": now,
        },
      },
      { arrayFilters: [{ "d._id": { $in: targets.map((b) => b._id) } }] },
    );

    return successResponse(res, "Campaign status updated", {
      mediaId: media._id,
      mediaCode: face?.mediaCode || code,
      mediaName: face?.mediaName || (media.mediaDetails || []).map((d) => d.mediaName).filter(Boolean).join(", "),
      rentalDueId: bill._id,
      updatedRentalDueIds: targets.map((b) => b._id), // ✅ NEW — every bill of that month updated
      dueMonth: bill.dueMonth || monthLabel,
      oldCampaignStatus: bill.campaignStatus ?? null,
      campaignStatus: status,
      approvalStatus: bill.approvalStatus ?? null,
      updatedBy: userName,
      updatedAt: now,
    });
  } catch (error) {
    console.error("updateCampaignStatus error:", error);
    return errorResponse(res, "Something went wrong while updating campaign status", { error: error.message }, 500);
  }
};
