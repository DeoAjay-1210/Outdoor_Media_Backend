const axios = require("axios");
const { getOverallSummaryForCycle } = require("../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
const { getDueMonthLabel } = require("./Datehelpers");
const { landOwnersAsOfDate } = require("./appraisalRent");

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

// ✅ NEW — master switch for ALL Google Chat messages: GOOGLE_CHAT=on | off
// (.env). "off" / "false" / "0" / "no" → nothing is sent. Not set → on.
const isGoogleChatEnabled = () =>
  !["off", "false", "0", "no"].includes(String(process.env.GOOGLE_CHAT || "on").trim().toLowerCase());

const APPROVAL_ROUTES = {
  1: { envKeys: ["RENTAL_MANAGER_URL"], status: "*Awaiting your approval* (Rental Manager)" },
  2: { envKeys: ["CMD_URL"], status: "*Awaiting your approval* (CMD)" },
  3: { envKeys: ["RENTAL_EXECUTIVE_URL", "RENTAL_MANAGER_URL"], status: "*Approved by CMD* — fully approved" },
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

// ✅ NEW — total TDS of the site's landowners for the bill's month (owner TDS
// is stored against the current rent; scaled to the rent in force for the due
// date, same as the ledger). TDS is part of the Total Rental Amount, not extra.
function getBillTds(mediaPlain, dueDate) {
  let owners = mediaPlain.landOwners || [];
  if (dueDate) {
    try {
      owners = landOwnersAsOfDate(mediaPlain, dueDate) || owners;
    } catch (err) {
      // fall back to the stored owner amounts
    }
  }
  const withTds = owners.filter((o) => Number(o.tdsApplicable) === 1 && Number(o.tdsAmount || 0) > 0);
  const amount = withTds.reduce((sum, o) => sum + Number(o.tdsAmount || 0), 0);
  const rates = [...new Set(withTds.map((o) => Number(o.tdsPercentage || 0)))];
  return { amount: Math.round(amount), percentage: rates.length === 1 && rates[0] > 0 ? rates[0] : null };
}

// same cycle length / month-end handling as the rental due list
const FREQUENCY_MONTHS = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };
const cycleMonthsOf = (rentalPayment) => {
  const f = Number(rentalPayment?.paymentFrequency || 1);
  return f === 6 ? Number(rentalPayment?.customPaymentFrequency) || 1 : FREQUENCY_MONTHS[f] || 1;
};
function addMonthsUTC(date, months) {
  const d = new Date(date);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== originalDay) d.setUTCDate(0);
  return d;
}

// ✅ NEW — payment frequency label for the message
const FREQUENCY_LABEL = { 1: "Monthly", 2: "Quarterly", 3: "Half Yearly", 4: "Yearly", 5: "2 Years" };
const frequencyLabelOf = (rentalPayment) => {
  const f = Number(rentalPayment?.paymentFrequency || 1);
  if (f === 6) {
    const months = Number(rentalPayment?.customPaymentFrequency) || 1;
    return `Custom (${months} month${months === 1 ? "" : "s"})`;
  }
  return FREQUENCY_LABEL[f] || "Monthly";
};

// faces a bill covers: separate bill (siteBillMode 2) → only its face;
// single bill → every active face of the site
function billFacesOf(plain, entry) {
  const details = plain.mediaDetails || [];
  const activeFaces = details.filter((d) => Number(d.status) === 1);
  const entryFace = entry?.mediaDetailId
    ? details.find((d) => String(d._id) === String(entry.mediaDetailId))
    : null;
  const isSeparateBill = !!entryFace && Number(entryFace.siteBillMode) === 2;
  const faces = isSeparateBill ? [entryFace] : activeFaces;
  return { faces: faces.length ? faces : entryFace ? [entryFace] : details, entryFace, isSeparateBill };
}

// ✅ NEW — one chat message per bill: a single-bill site's per-face rows of the
// same month build the SAME message, so they share one key (callers send once
// per key); a separate-bill face keeps its own key.
function rentalDueChatKey(media, entry) {
  const plain = typeof media?.toObject === "function" ? media.toObject() : media || {};
  const { entryFace, isSeparateBill } = billFacesOf(plain, entry);
  const month = entry?.dueMonth || (entry?.dueDate ? getDueMonthLabel(entry.dueDate) : "");
  return `${String(plain._id || "")}:${month}${isSeparateBill ? `:${String(entryFace._id)}` : ""}`;
}

// ✅ NEW — "ADNOOHBILL…" of the bill; separate landlord bills → each landlord's
// number with the landlord name. "" when the bill has no number yet.
function adinnBillNoText(entry) {
  const perOwner = (entry?.adinn_ooh_bills_landOwners || []).filter((o) => o && o.adinn_ooh_bills);
  if (perOwner.length > 1) {
    return perOwner.map((o) => `${o.adinn_ooh_bills}${o.landOwnerName ? ` (${o.landOwnerName})` : ""}`).join(", ");
  }
  return entry?.adinn_ooh_bills || "";
}

function buildMessage({ media, entry, userType, userName, action, cycleDate, status = "" }) {
  const plain = typeof media?.toObject === "function" ? media.toObject({ virtuals: true }) : media || {};
  // separate bill (siteBillMode 2) → only that face; single bill → the
  // bill covers every active face of the site
  const { faces: shownFaces } = billFacesOf(plain, entry);
  const siteName = shownFaces.map((d) => d.mediaName).filter(Boolean).join(", ") || "-";
  const siteCode = shownFaces.map((d) => d.mediaCode).filter(Boolean).join(", ") || "-";
  const landOwnerName = (plain.landOwners || []).map((o) => o.name).filter(Boolean).join(", ") || "-";
  const dueMonth = entry?.dueMonth || (cycleDate ? getDueMonthLabel(cycleDate) : "-");
  const amounts = getBillAmounts(plain, entry, cycleDate);
  // this bill's previous / own / following billing date (its due date ± one cycle)
  const billDate = entry?.dueDate || cycleDate;
  const cycleMonths = cycleMonthsOf(plain.rentalPayment);
  const billDates = billDate
    ? [
        `*Last Bill Date:* ${formatDMY(addMonthsUTC(billDate, -cycleMonths))}`,
        `*Current Bill Date:* ${formatDMY(billDate)}`, // ✅ NEW
        `*Next Bill Date:* ${formatDMY(addMonthsUTC(billDate, cycleMonths))}`,
      ]
    : [];

  const tds = getBillTds(plain, billDate);
  const tdsLine =
    tds.amount > 0
      ? [
          `*TDS Amount${tds.percentage ? ` (${tds.percentage}%)` : ""}:* ${formatINR(tds.amount)} (already included in the Total Rental Amount)`,
        ]
      : [];

  const title = "*Rental Due Approved*";
  const by = `${ROLE_LABEL[Number(userType)] || "User"}${userName ? ` (${userName})` : ""}`;

  // ✅ NEW — ADINN OOH bill number (adinn_ooh_bills), given when the bill is
  // fully approved; shown on CMD-approved messages and whenever the bill has one
  const billNoText = adinnBillNoText(entry);
  const billNoLine =
    billNoText || (Number(userType) === 3 && action === "approved") ? [`*Bill No:* ${billNoText || "-"}`] : [];

  return [
    `${title} — by ${by}`,
    ...(status ? [status] : []),
    `*Site Name:* ${siteName}`,
    ...billNoLine,
    `*Site Code:* ${siteCode}`,
    `*Landowner Name:* ${landOwnerName}`,
    `*Due Month:* ${dueMonth}`,
    `*Payment Frequency:* ${frequencyLabelOf(plain.rentalPayment)}`, // ✅ NEW
    ...billDates,
    `*Total Rental Amount:* ${formatINR(amounts.totalRentalAmount)}`,
    ...tdsLine,
    `*GST Amount:* ${formatINR(amounts.gstAmount)}`,
    `*Total Net Payable:* ${formatINR(amounts.totalNetPayable)}`,
  ].join("\n");
}

// action: "approved". Message is built immediately (before any
// later change to media), then posted in the background.
function notifyRentalDueChat({ media, entry, userType, userName, action, cycleDate }) {
  if (!isGoogleChatEnabled() || !media) return;
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

// "10 October 2026" (billing dates are stored at UTC midnight)
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const formatDMY = (d) => {
  if (!d) return "-";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
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
      `*Billing Date Change ${Number(request.editCount) > 0 ? "Request Updated" : "Requested"}* — by ${actorLabel(request.requestedBy)}`,
      "*Waiting for CMD approval*",
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
      `*Billing Date Change Approved* — by ${actorLabel(request.cmdAction)}`,
      " *New billing dates applied*",
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
    `*Billing Date Change Rejected* — by ${actorLabel(request.cmdAction)}`,
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
  if (!isGoogleChatEnabled() || !request) return;
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

function buildOverdueRemarkMessage({ media, mediaDetailId, landOwnerId, dueMonth, remark, userType, userName, attachments = [], replyTo = null }) {
  const plain = typeof media?.toObject === "function" ? media.toObject() : media || {};
  const details = plain.mediaDetails || [];
  const face = mediaDetailId ? details.find((d) => String(d._id) === String(mediaDetailId)) : null;
  const activeFaces = details.filter((d) => Number(d.status) === 1);
  const shownFaces = face ? [face] : activeFaces.length ? activeFaces : details;
  const owners = plain.landOwners || [];
  const owner = landOwnerId
    ? owners.find(
        (o) => String(o._id) === String(landOwnerId) || String(o.landOwnerMasterId || "") === String(landOwnerId),
      )
    : null;
  const shownOwners = owner ? [owner] : owners;

  let replyContext = "";
  if (replyTo && (replyTo.addedBy || replyTo.remarks)) {
    const replySender = replyTo.addedBy || "User";
    const replyText = replyTo.remarks || "Attachment";
    replyContext = `*Replying to:* ${replySender} ("${replyText}")`;
  }

  const attLines = [];
  if (Array.isArray(attachments) && attachments.length > 0) {
    attachments.forEach((a) => {
      if (!a) return;
      if (a.audioUrl || a.mimeType?.startsWith('audio/') || a.fileName?.includes('voice')) {
        attLines.push(`*Voice Message:* ${a.audioUrl || a.fileUrl || ""}`); // ✅ CHANGED — no icon / duration
      } else if (a.fileType === 'image' || a.mimeType?.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif)$/i.test(a.fileName || '')) {
        attLines.push(`🖼 *Image (${a.fileName || 'Photo'}):* ${a.fileUrl || ""}`);
      } else if (a.fileType === 'pdf' || a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.fileName || '')) {
        attLines.push(`📄 *PDF (${a.fileName || 'Document'}):* ${a.fileUrl || ""}`);
      } else if (a.fileUrl) {
        attLines.push(`📁 *Document (${a.fileName || 'File'}):* ${a.fileUrl}`);
      }
    });
  }

  const lines = [
    `*Overdue Remark Added* — by ${ROLE_LABEL[Number(userType)] || "User"}${userName ? ` (${userName})` : ""}`,
    `*Site Name:* ${shownFaces.map((d) => d.mediaName).filter(Boolean).join(", ") || "-"}`,
    `*Site Code:* ${shownFaces.map((d) => d.mediaCode).filter(Boolean).join(", ") || "-"}`,
    `*Landowner Name:* ${shownOwners.map((o) => o.name).filter(Boolean).join(", ") || "-"}`,
    `*Due Month:* ${dueMonth || "-"}`,
    replyContext,
    `*Remark:* ${remark || (attLines.length ? "Attachment uploaded" : "-")}`,
  ].filter(Boolean);

  if (attLines.length > 0) {
    lines.push(`*Attachments:*\n${attLines.join("\n")}`);
  }

  return lines.join("\n");
}

function notifyOverdueRemarkChat({ media, mediaDetailId, landOwnerId, dueMonth, remark, userType, userName, attachments = [], replyTo = null }) {
  if (!isGoogleChatEnabled() || !media) return;
  const envKeys = OVERDUE_REMARK_ROUTES[Number(userType)];
  if (!envKeys) return;
  const urls = [...new Set(envKeys.map((k) => process.env[k]).filter(Boolean))];
  if (urls.length === 0) return;

  let text;
  try {
    text = buildOverdueRemarkMessage({ media, mediaDetailId, landOwnerId, dueMonth, remark, userType, userName, attachments, replyTo });
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

// ─────────────────────────────────────────────────────────────
// ✅ NEW — APPROVAL REMINDER (POST /admin/cmd-notifications/reminder), sent
// right when the reminder is given. Same bill details as "Rental Due
// Approved", to the space of the role the bill is waiting on:
//   waiting on Rental Manager → Rental Manager space
//   waiting on CMD            → CMD space
// ─────────────────────────────────────────────────────────────
const REMINDER_ROUTES = { 2: "RENTAL_MANAGER_URL", 3: "CMD_URL" };

function notifyApprovalReminderChat({ media, entry, userType, userName, remarks = "", reminderCount = null }) {
  if (!isGoogleChatEnabled() || !media || !entry) return;
  const pendingRole = Number(entry.currentPendingRole);
  const url = process.env[REMINDER_ROUTES[pendingRole]];
  if (!url) return;

  let text;
  try {
    const lines = buildMessage({ media, entry, userType, userName, action: "reminder" }).split("\n");
    const by = `${ROLE_LABEL[Number(userType)] || "User"}${userName ? ` (${userName})` : ""}`;
    lines[0] = `*Approval Reminder* — by ${by}`;
    lines.splice(1, 0, `*Awaiting your approval* (${ROLE_LABEL[pendingRole]})`);
    if (remarks) lines.push(`*Remarks:* ${remarks}`);
    text = lines.join("\n");
  } catch (err) {
    console.error("[GoogleChat] approval reminder message build failed:", err.message);
    return;
  }
  axios
    .post(url, { text }, { timeout: 10000, headers: { "Content-Type": "application/json; charset=UTF-8" } })
    .catch((err) => console.error("[GoogleChat] send failed:", err.response?.status || err.message));
}

// ─────────────────────────────────────────────────────────────
// ✅ NEW — NEW BILL / ADVANCE (rent revision BILL / ADVANCE) messages.
//   entered            → space of the role it waits on (Rental Executive)
//   approved by Exec   → Rental Manager space ("Awaiting your approval")
//   approved by Mgr    → CMD space
//   approved by CMD    → Rental Executive + Rental Manager spaces
//   rejected           → the other roles' spaces (Exec → Mgr, Mgr → Exec, CMD → Exec + Mgr)
// NORMAL_BILL / CANCEL (auto approved) → no message. Same GOOGLE_CHAT switch;
// built at once, posted in the background, never throws.
// ─────────────────────────────────────────────────────────────
const ROLE_URL_KEY = { 1: "RENTAL_EXECUTIVE_URL", 2: "RENTAL_MANAGER_URL", 3: "CMD_URL" };
const REVISION_REJECT_ROUTES = {
  1: ["RENTAL_MANAGER_URL"],
  2: ["RENTAL_EXECUTIVE_URL"],
  3: ["RENTAL_EXECUTIVE_URL", "RENTAL_MANAGER_URL"],
};

const revisionKindLabel = (r) =>
  r.billType === "ADVANCE" ? "Advance" : r.revisionAction === "decrease" ? "Bill Decrease" : "New Bill";

function buildRentRevisionMessage({ revision, media, event, role, userName, remark = "" }) {
  const r = typeof revision?.toObject === "function" ? revision.toObject() : revision || {};
  const plain = typeof media?.toObject === "function" ? media.toObject() : media || {};
  const isAdvance = r.billType === "ADVANCE";
  const kind = revisionKindLabel(r);
  const eventLabel = event === "created" ? "Entered" : event === "rejected" ? "Rejected" : "Approved";
  const actorRole = event === "created" ? r.requestedByRole : role;
  const actorName = event === "created" ? r.requestedBy : userName;
  const by = `${ROLE_LABEL[Number(actorRole)] || "User"}${actorName ? ` (${actorName})` : ""}`;

  let status = "";
  if (event === "created") {
    const p = Number(r.currentPendingRole);
    status = p ? `*Awaiting your approval* (${ROLE_LABEL[p]})` : "";
  } else if (event === "rejected") {
    status = `*Rejected by ${ROLE_LABEL[Number(role)] || "User"}*`;
  } else {
    status = APPROVAL_ROUTES[Number(role)]?.status || "";
  }

  const faces = (plain.mediaDetails || []).filter((d) => Number(d.status) === 1);
  const siteName = r.mediaName || faces.map((d) => d.mediaName).filter(Boolean).join(", ") || "-";
  const siteCode = r.mediaCode || faces.map((d) => d.mediaCode).filter(Boolean).join(", ") || "-";
  const landOwnerName = (plain.landOwners || []).map((o) => o.name).filter(Boolean).join(", ") || "-";

  const lines = [
    `*${kind} ${eventLabel}* — by ${by}`,
    ...(status ? [status] : []),
    `*Site Name:* ${siteName}`,
    `*Site Code:* ${siteCode}`,
    `*Landowner Name:* ${landOwnerName}`,
    ...(plain.rentalPayment ? [`*Payment Frequency:* ${frequencyLabelOf(plain.rentalPayment)}`] : []),
  ];

  let amount = 0;
  let gstAmount = 0;
  if (isAdvance) {
    amount = Number(r.advanceAmount || 0);
    gstAmount = Number(r.advanceGstAmount || 0);
    lines.push(`*Advance Month:* ${r.fromMonth || "-"}`);
    lines.push(`*Advance Amount:* ${formatINR(amount)}`);
  } else {
    const detail = Array.isArray(r.monthsDetail) ? r.monthsDetail.filter(Boolean) : [];
    const first = detail[0]?.month || r.fromMonth || "-";
    const last = detail.length ? detail[detail.length - 1].month : r.toMonth || first;
    lines.push(`*Bill Months:* ${first === last || !last ? first : `${first} to ${last}`}`);
    if (Number(r.newRent || 0) > 0) {
      lines.push(`*Old Rent:* ${formatINR(r.oldRent)}`);
      lines.push(`*New Rent:* ${formatINR(r.newRent)}`);
    }
    if (detail.length) {
      amount = detail.reduce((s, d) => s + Number(d.amount || 0), 0);
      gstAmount = detail.reduce((s, d) => s + Number(d.gstAmount || 0), 0);
      if (detail.length > 1) {
        lines.push("*Month-wise:*");
        detail.forEach((d) => {
          const g = Number(d.gstAmount || 0);
          lines.push(`   • ${d.month} — ${formatINR(d.amount)}${g ? ` + GST ${formatINR(g)}` : ""}`);
        });
      }
    } else {
      amount = Number(r.increaseAmount ?? r.difference ?? 0);
      gstAmount = Number(r.increaseGstAmount || 0);
    }
    lines.push(`*Total Amount:* ${formatINR(amount)}`);
  }
  const gstPct = Number(r.gstPercentage || 0);
  if (gstAmount) lines.push(`*GST Amount${gstPct ? ` (${gstPct}%)` : ""}:* ${formatINR(gstAmount)}`);
  lines.push(`*Total Net Payable:* ${formatINR(amount + gstAmount)}`);
  if (isAdvance && r.adjustInMonth) lines.push(`*Adjust In Month:* ${r.adjustInMonth}`);
  if (!isAdvance && r.nextBillFromMonth) lines.push(`*Next Bill From:* ${r.nextBillFromMonth}`);
  if (r.reason) lines.push(`*Reason:* ${r.reason}`);
  if (r.invoice?.filePath) lines.push(`*Invoice:* ${r.invoice.filePath}`);
  if (event !== "created" && r.requestedBy) {
    lines.push(`*Requested By:* ${ROLE_LABEL[Number(r.requestedByRole)] || "User"} (${r.requestedBy})`);
  }
  if (remark && String(remark).trim()) lines.push(`*Remark:* ${String(remark).trim()}`);
  if (r.adinn_ooh_bills && typeof r.adinn_ooh_bills !== "object") lines.push(`*Bill No:* ${r.adinn_ooh_bills}`);
  return lines.join("\n");
}

// event: "created" | "approved" | "rejected"; role = who approved / rejected
// webhook URLs for this event ([] → nothing to send: chat off, NORMAL_BILL / CANCEL, URL not set)
function rentRevisionChatUrls({ revision, event, role }) {
  if (!isGoogleChatEnabled() || !revision) return [];
  if (revision.billType !== "BILL" && revision.billType !== "ADVANCE") return []; // NORMAL_BILL / CANCEL → no message
  let envKeys = [];
  if (event === "created") envKeys = ROLE_URL_KEY[Number(revision.currentPendingRole)] ? [ROLE_URL_KEY[Number(revision.currentPendingRole)]] : [];
  else if (event === "approved") envKeys = APPROVAL_ROUTES[Number(role)]?.envKeys || [];
  else if (event === "rejected") envKeys = REVISION_REJECT_ROUTES[Number(role)] || [];
  return [...new Set(envKeys.map((k) => process.env[k]).filter(Boolean))];
}

function notifyRentRevisionChat({ revision, media, event, role, userName, remark = "" }) {
  const urls = rentRevisionChatUrls({ revision, event, role });
  if (urls.length === 0) return;

  let text;
  try {
    text = buildRentRevisionMessage({ revision, media, event, role, userName, remark });
  } catch (err) {
    console.error("[GoogleChat] rent revision message build failed:", err.message);
    return;
  }
  urls.forEach((url) => {
    axios
      .post(url, { text }, { timeout: 10000, headers: { "Content-Type": "application/json; charset=UTF-8" } })
      .catch((err) => console.error("[GoogleChat] rent revision send failed:", err.response?.status || err.message));
  });
}

module.exports = {
  notifyRentRevisionChat, // ✅ NEW — New Bill / Advance
  buildRentRevisionMessage, // ✅ NEW
  rentRevisionChatUrls, // ✅ NEW
  notifyApprovalReminderChat, // ✅ NEW
  notifyOverdueRemarkChat,
  buildOverdueRemarkMessage,
  notifyRentalDueChat,
  rentalDueChatKey, // ✅ NEW — one message per bill (see saveRentalDue batch)
  buildMessage,
  APPROVAL_ROUTES,
  notifyBillingDateRevertChat,
  buildBillingDateRevertMessage,
};
