const axios = require("axios");
const { getOverallSummaryForCycle } = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
const { getDueMonthLabel } = require("./Datehelpers");

// ─────────────────────────────────────────────────────────────
// GOOGLE CHAT — rental due approval messages.
// Webhook URLs (.env): RENTAL_EXECUTIVE_URL, RENTAL_MANAGER_URL, CMD_URL.
// A space whose URL is not set is skipped. Never throws and is not awaited
// by callers, so a chat failure never affects the approval.
//
// Approval routing (next approver gets the message):
//   Rental Executive approved → Rental Manager space ("waiting for your approval")
//   Rental Manager approved   → CMD space            ("waiting for your approval")
//   CMD approved              → Rental Executive + Rental Manager spaces
// ─────────────────────────────────────────────────────────────
const ROLE_LABEL = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };

const APPROVAL_ROUTES = {
  1: { envKeys: ["RENTAL_MANAGER_URL"], status: "⏳ *Waiting for your approval* (Rental Manager)" },
  2: { envKeys: ["CMD_URL"], status: "⏳ *Waiting for your approval* (CMD)" },
  3: { envKeys: ["RENTAL_EXECUTIVE_URL", "RENTAL_MANAGER_URL"], status: "🎉 *Approved by CMD* — fully approved" },
};

const formatINR = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

// same month-wise amounts as the rental due list (appraisal-aware rent + GST)
function getBillAmounts(mediaPlain, entry, cycleDate) {
  const dueDate = entry?.dueDate || cycleDate;
  let rent = 0;
  let gst = 0;
  if (dueDate) {
    const d = new Date(dueDate);
    try {
      const s = getOverallSummaryForCycle(mediaPlain, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }) || {};
      rent = Math.round(Number(s.currentMonthRentalAmount || 0));
      gst = Math.round(Number(s.currentMonthGstAmount || 0));
    } catch (err) {
      // fall back to the bill's own amounts below
    }
  }
  if (!rent && entry) {
    rent = Math.round(Number(entry.baseAmount || entry.netPayable || 0));
    gst = Math.round(Number(entry.gstAmount || 0));
  }
  return { totalRentalAmount: rent, gstAmount: gst, totalNetPayable: rent + gst };
}

function buildMessage({ media, entry, userType, userName, action, cycleDate, status = "" }) {
  const plain = typeof media?.toObject === "function" ? media.toObject({ virtuals: true }) : media || {};
  const details = plain.mediaDetails || [];
  const activeFaces = details.filter((d) => Number(d.status) === 1);
  // separate bill (siteBillMode 2) → only that face; single bill → the
  // bill covers every active face of the site
  const entryFace = entry?.mediaDetailId
    ? details.find((d) => String(d._id) === String(entry.mediaDetailId))
    : null;
  const faces = entryFace && Number(entryFace.siteBillMode) === 2 ? [entryFace] : activeFaces;
  const shownFaces = faces.length ? faces : entryFace ? [entryFace] : details;
  const siteName = shownFaces.map((d) => d.mediaName).filter(Boolean).join(", ") || "-";
  const siteCode = shownFaces.map((d) => d.mediaCode).filter(Boolean).join(", ") || "-";
  const landOwnerName = (plain.landOwners || []).map((o) => o.name).filter(Boolean).join(", ") || "-";
  const dueMonth = entry?.dueMonth || (cycleDate ? getDueMonthLabel(cycleDate) : "-");
  const amounts = getBillAmounts(plain, entry, cycleDate);

  const title = "✅ *Rental Due Approved*";
  const by = `${ROLE_LABEL[Number(userType)] || "User"}${userName ? ` (${userName})` : ""}`;

  return [
    `${title} — by ${by}`,
    ...(status ? [status] : []),
    `*Site Name:* ${siteName}`,
    `*Site Code:* ${siteCode}`,
    `*Landowner Name:* ${landOwnerName}`,
    `*Due Month:* ${dueMonth}`,
    `*Total Rental Amount:* ${formatINR(amounts.totalRentalAmount)}`,
    `*GST Amount:* ${formatINR(amounts.gstAmount)}`,
    `*Total Net Payable:* ${formatINR(amounts.totalNetPayable)}`,
  ].join("\n");
}

// action: "approved". Message is built immediately (before any
// later change to media), then posted in the background.
function notifyRentalDueChat({ media, entry, userType, userName, action, cycleDate }) {
  if (!media) return;
  if (action !== "approved") return;
  const route = APPROVAL_ROUTES[Number(userType)];
  if (!route) return;
  const urls = [...new Set(route.envKeys.map((k) => process.env[k]).filter(Boolean))];
  if (urls.length === 0) return;

  let text;
  try {
    text = buildMessage({ media, entry, userType, userName, action, cycleDate, status: route.status });
  } catch (err) {
    console.error("[GoogleChat] message build failed:", err.message);
    return;
  }
  urls.forEach((url) => {
    axios
      .post(url, { text }, { timeout: 10000, headers: { "Content-Type": "application/json; charset=UTF-8" } })
      .catch((err) => console.error("[GoogleChat] send failed:", err.response?.status || err.message));
  });
}

// ─────────────────────────────────────────────────────────────
// BILLING DATE REVERT — request raised / CMD approved / CMD rejected.
//   raised by Rental Executive → Rental Manager + CMD spaces
//   raised by Rental Manager   → Rental Executive + CMD spaces
//   CMD approved / rejected    → Rental Executive + Rental Manager spaces
// ─────────────────────────────────────────────────────────────
const REVERT_REQUEST_ROUTES = {
  1: ["RENTAL_MANAGER_URL", "CMD_URL"],
  2: ["RENTAL_EXECUTIVE_URL", "CMD_URL"],
};
const REVERT_DECISION_ROUTE = ["RENTAL_EXECUTIVE_URL", "RENTAL_MANAGER_URL"];

// DD.MM.YYYY (billing dates are stored at UTC midnight)
const formatDMY = (d) => {
  if (!d) return "-";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "-";
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
};

const actorLabel = (actor) =>
  `${ROLE_LABEL[Number(actor?.role)] || "User"}${actor?.userName ? ` (${actor.userName})` : ""}`;

function buildBillingDateRevertMessage(request, event) {
  const faces = request.siteDetails || [];
  const activeFaces = faces.filter((f) => Number(f.status) === 1);
  const shownFaces = activeFaces.length ? activeFaces : faces;
  const siteName = shownFaces.map((f) => f.mediaName).filter(Boolean).join(", ") || request.siteName || "-";
  const siteCode = shownFaces.map((f) => f.mediaCode).filter(Boolean).join(", ") || request.siteCode || "-";
  const site = [
    `*Site Name:* ${siteName}`,
    `*Site Code:* ${siteCode}`,
    `*Landowner Name:* ${request.landOwnerName || "-"}`,
  ];
  const original = request.originalDates || {};
  const requested = request.requestedDates || {};
  const remark = request.remark || "-";
  const imageLine = request.image?.filePath ? [`*Request Image:* ${request.image.filePath}`] : [];

  if (event === "requested") {
    return [
      `📅 *Billing Date Change Requested* — by ${actorLabel(request.requestedBy)}`,
      "⏳ *Waiting for CMD approval*",
      ...site,
      `*Current Last Bill Date:* ${formatDMY(original.lastBillPaidDate)}`,
      `*Current Next Bill Date:* ${formatDMY(original.nextBillingDate)}`,
      `*Requested Last Bill Date:* ${formatDMY(requested.lastBillPaidDate)}`,
      `*Requested Next Bill Date:* ${formatDMY(requested.nextBillingDate)}`,
      `*Remark:* ${remark}`,
      ...imageLine,
    ].join("\n");
  }

  const cmdRemark = request.cmdAction?.remark || "";

  if (event === "approved") {
    const before = request.datesBeforeApproval || original;
    const applied = request.appliedDates || requested;
    const removed = (request.removedBills || [])
      .map((b) => `${b.dueMonth || formatDMY(b.dueDate)} (${formatINR(b.netPayable)})`)
      .join(", ");
    return [
      `✅ *Billing Date Change Approved* — by ${actorLabel(request.cmdAction)}`,
      "🎉 *New billing dates applied*",
      ...site,
      `*Requested By:* ${actorLabel(request.requestedBy)}`,
      `*Previous Last Bill Date:* ${formatDMY(before.lastBillPaidDate)}`,
      `*Previous Next Bill Date:* ${formatDMY(before.nextBillingDate)}`,
      `*New Last Bill Date:* ${formatDMY(applied.lastBillPaidDate)}`,
      `*New Next Bill Date:* ${formatDMY(applied.nextBillingDate)}`,
      `*Request Remark:* ${remark}`,
      ...imageLine,
      ...(cmdRemark ? [`*CMD Remark:* ${cmdRemark}`] : []),
      ...(removed ? [`*Removed Bills:* ${removed}`] : []),
    ].join("\n");
  }

  // rejected
  return [
    `❌ *Billing Date Change Rejected* — by ${actorLabel(request.cmdAction)}`,
    "Billing dates not changed",
    ...site,
    `*Requested By:* ${actorLabel(request.requestedBy)}`,
    `*Current Last Bill Date:* ${formatDMY(original.lastBillPaidDate)}`,
    `*Current Next Bill Date:* ${formatDMY(original.nextBillingDate)}`,
    `*Requested Last Bill Date:* ${formatDMY(requested.lastBillPaidDate)}`,
    `*Requested Next Bill Date:* ${formatDMY(requested.nextBillingDate)}`,
    `*Request Remark:* ${remark}`,
    ...imageLine,
    `*Reject Reason:* ${cmdRemark || "-"}`,
  ].join("\n");
}

// event: "requested" | "approved" | "rejected". Built immediately, posted in
// the background; never throws.
function notifyBillingDateRevertChat({ request, event }) {
  if (!request) return;
  const envKeys =
    event === "requested"
      ? REVERT_REQUEST_ROUTES[Number(request.requestedBy?.role)]
      : ["approved", "rejected"].includes(event)
        ? REVERT_DECISION_ROUTE
        : null;
  if (!envKeys) return;
  const urls = [...new Set(envKeys.map((k) => process.env[k]).filter(Boolean))];
  if (urls.length === 0) return;

  let text;
  try {
    const plain = typeof request.toObject === "function" ? request.toObject() : request;
    text = buildBillingDateRevertMessage(plain, event);
  } catch (err) {
    console.error("[GoogleChat] billing date revert message build failed:", err.message);
    return;
  }
  urls.forEach((url) => {
    axios
      .post(url, { text }, { timeout: 10000, headers: { "Content-Type": "application/json; charset=UTF-8" } })
      .catch((err) => console.error("[GoogleChat] send failed:", err.response?.status || err.message));
  });
}

// ─────────────────────────────────────────────────────────────
// OVERDUE REMARK — sent to the two roles other than the one who added it:
//   Rental Executive → Rental Manager + CMD spaces
//   Rental Manager   → Rental Executive + CMD spaces
//   CMD              → Rental Executive + Rental Manager spaces
// ─────────────────────────────────────────────────────────────
const OVERDUE_REMARK_ROUTES = {
  1: ["RENTAL_MANAGER_URL", "CMD_URL"],
  2: ["RENTAL_EXECUTIVE_URL", "CMD_URL"],
  3: ["RENTAL_EXECUTIVE_URL", "RENTAL_MANAGER_URL"],
};

function buildOverdueRemarkMessage({ media, mediaDetailId, landOwnerId, dueMonth, remark, userType, userName }) {
  const plain = typeof media?.toObject === "function" ? media.toObject() : media || {};
  const details = plain.mediaDetails || [];
  // remark for one face → that face; otherwise every active face of the site
  const face = mediaDetailId ? details.find((d) => String(d._id) === String(mediaDetailId)) : null;
  const activeFaces = details.filter((d) => Number(d.status) === 1);
  const shownFaces = face ? [face] : activeFaces.length ? activeFaces : details;
  // remark for one landowner (landOwners[]._id or landOwnerMasterId) → that one; otherwise all
  const owners = plain.landOwners || [];
  const owner = landOwnerId
    ? owners.find(
        (o) => String(o._id) === String(landOwnerId) || String(o.landOwnerMasterId || "") === String(landOwnerId),
      )
    : null;
  const shownOwners = owner ? [owner] : owners;

  return [
    `📝 *Overdue Remark Added* — by ${ROLE_LABEL[Number(userType)] || "User"}${userName ? ` (${userName})` : ""}`,
    `*Site Name:* ${shownFaces.map((d) => d.mediaName).filter(Boolean).join(", ") || "-"}`,
    `*Site Code:* ${shownFaces.map((d) => d.mediaCode).filter(Boolean).join(", ") || "-"}`,
    `*Landowner Name:* ${shownOwners.map((o) => o.name).filter(Boolean).join(", ") || "-"}`,
    `*Due Month:* ${dueMonth || "-"}`,
    `*Remark:* ${remark || "-"}`,
  ].join("\n");
}

// Built immediately, posted in the background; never throws.
function notifyOverdueRemarkChat({ media, mediaDetailId, landOwnerId, dueMonth, remark, userType, userName }) {
  if (!media) return;
  const envKeys = OVERDUE_REMARK_ROUTES[Number(userType)];
  if (!envKeys) return;
  const urls = [...new Set(envKeys.map((k) => process.env[k]).filter(Boolean))];
  if (urls.length === 0) return;

  let text;
  try {
    text = buildOverdueRemarkMessage({ media, mediaDetailId, landOwnerId, dueMonth, remark, userType, userName });
  } catch (err) {
    console.error("[GoogleChat] overdue remark message build failed:", err.message);
    return;
  }
  urls.forEach((url) => {
    axios
      .post(url, { text }, { timeout: 10000, headers: { "Content-Type": "application/json; charset=UTF-8" } })
      .catch((err) => console.error("[GoogleChat] send failed:", err.response?.status || err.message));
  });
}

module.exports = {
  notifyOverdueRemarkChat,
  buildOverdueRemarkMessage,
  notifyRentalDueChat,
  buildMessage,
  APPROVAL_ROUTES,
  notifyBillingDateRevertChat,
  buildBillingDateRevertMessage,
};
