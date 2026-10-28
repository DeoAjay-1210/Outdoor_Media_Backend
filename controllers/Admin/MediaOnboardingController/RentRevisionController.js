// ─────────────────────────────────────────────────────────────
// ✅ NEW — Rent revision (rent changed from a past month, arrears paid separately)
//
//   POST /admin/rent-revision           { mediaId, fromMonth, newRent, reason }
//   POST /admin/rent-revision/approve   { revisionId, action: 1 approve | 2 reject, remark }
//   GET  /admin/rent-revision-list      ?mediaId=&status=&pageNumber=&count=
//
// Approval: Rental Executive (1) → Rental Manager (2) → CMD (3), in order;
// every approval is stored. CMD approval applies the revision (see
// utils/rentRevisionArrears.js) and sends the CMD approval mail for each
// arrears bill. Arrears are paid through POST /admin/ledger-save.
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const RentRevision = require("../../../models/Admin/MediaOnboardingSchema/RentRevisionSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const {
  monthKey,
  monthLabelOfKey,
  parseFromMonth,
  buildRevisionPlan,
  planPreview,
  toArrearsBill,
  arrearsStatus,
} = require("../../../utils/rentRevisionArrears");

const ROLE_NAMES = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const round = (v) => Math.round(Number(v) || 0);

const siteCodeName = (media) => {
  const details = media?.mediaDetails || [];
  return {
    mediaCode: details.map((d) => d.mediaCode).filter(Boolean).join(" / "),
    mediaName: details.map((d) => d.mediaName).filter(Boolean).join(", "),
  };
};

const formatSteps = (steps) =>
  (steps || []).map((s) => ({
    role: s.role,
    roleName: s.roleName || ROLE_NAMES[s.role],
    status: s.status,
    by: s.by || "",
    byUserId: s.byUserId || null,
    at: s.at || null,
    remark: s.remark || "",
  }));

const RENT_REVISION_MEDIA_FIELDS =
  "mediaDetails rentalPayment landOwners appraisal rentalDue arrearsDue gstApplicableFlag agreement status";

// mediaId: array, JSON string array, "a,b" or a single id → [ids]
const parseMediaIds = (value) => {
  if (value === undefined || value === null || value === "") return [];
  let list = value;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("[")) {
      try { list = JSON.parse(t); } catch (e) { list = t.replace(/[[\]"']/g, "").split(","); }
    } else {
      list = t.split(",");
    }
  }
  if (!Array.isArray(list)) list = [list];
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
};

// applyToAllMonths: "" / null / undefined → null (from fromMonth onwards), "0" → 0, "1" → 1; invalid → undefined
const parseApplyToAllMonths = (value) => {
  if (value === undefined || value === null || String(value).trim() === "" || String(value).trim() === "null") return null;
  const n = Number(value);
  return n === 0 || n === 1 ? n : undefined;
};

// one site → { revision } or { error }
async function createOneRevision(mediaId, { fromDate, fromLabel, increaseAmount, applyToAllMonths, reason, invoice, user }) {
  if (!mongoose.Types.ObjectId.isValid(String(mediaId))) return { error: "mediaId is not a valid ObjectId" };
  const media = await Media.findById(mediaId).select(RENT_REVISION_MEDIA_FIELDS).lean();
  if (!media) return { error: "Media not found for given mediaId" };
  if (!(media.mediaDetails || []).some((d) => Number(d.status) === 1)) {
    return { error: "Rent revision can only be created for active media" };
  }
  const hasFromBill = (media.rentalDue || []).some(
    (b) => b && (b.dueMonth === fromLabel || monthKey(b.dueDate) === monthKey(fromDate)),
  );
  if (!hasFromBill) return { error: `No bill for ${fromLabel} on this site` };
  const waiting = await RentRevision.findOne({ mediaId, status: "Pending" }).select("_id").lean();
  if (waiting) return { error: "A rent revision is already waiting for approval", revisionId: waiting._id };

  const oldRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  const newRent = round(oldRent + increaseAmount);
  const onlyFromMonth = applyToAllMonths === 0;
  const plan = buildRevisionPlan(media, fromDate, newRent, applyToAllMonths);
  if (plan.heldMonth) return { error: `${plan.heldMonth} is on appraisal hold — release it first` };

  const { mediaCode, mediaName } = siteCodeName(media);
  const revision = await RentRevision.create({
    mediaId,
    mediaCode,
    mediaName,
    fromMonth: fromLabel,
    fromDate,
    oldRent,
    newRent,
    difference: increaseAmount,
    increaseAmount,
    applyToAllMonths,
    invoice,
    reason,
    status: "Pending",
    currentPendingRole: 1,
    approvalSteps: [1, 2, 3].map((role) => ({ role, roleName: ROLE_NAMES[role], status: "Pending" })),
    preview: planPreview(plan, newRent, onlyFromMonth ? oldRent : newRent),
    requestedBy: user?.userName || "",
    requestedByUserId: mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null,
    requestedByRole: Number(user?.userType) || null,
    requestedAt: nowIST(),
  });
  return { revision };
}

const revisionSummary = (r) => ({
  revisionId: r._id,
  mediaId: r.mediaId,
  mediaCode: r.mediaCode,
  fromMonth: r.fromMonth,
  oldRent: r.oldRent,
  increaseAmount: r.increaseAmount,
  newRent: r.newRent,
  applyToAllMonths: r.applyToAllMonths ?? null,
  invoice: r.invoice || null,
  status: r.status,
  currentPendingRole: r.currentPendingRole ?? null,
  currentPendingRoleName: r.currentPendingRole ? ROLE_NAMES[r.currentPendingRole] : null,
  approvalSteps: formatSteps(r.approvalSteps),
  preview: r.preview,
  requestedBy: r.requestedBy,
  requestedByRole: r.requestedByRole,
  requestedAt: r.requestedAt,
});

// ── POST /admin/rent-revision (form-data) ────────────────────
// mediaId (one or array), fromMonth, increaseAmount, applyToAllMonths, reason, invoice (PDF)
exports.createRentRevision = async (req, res) => {
  try {
    const body = req.body || {};
    const mediaIds = parseMediaIds(body.mediaId);
    if (mediaIds.length === 0) return errorResponse(res, "mediaId is required", null, 400);

    if (body.increaseAmount === undefined || body.increaseAmount === null || String(body.increaseAmount).trim() === "") {
      return errorResponse(res, "increaseAmount is required", null, 400);
    }
    const increaseAmount = Number(body.increaseAmount);
    if (!Number.isFinite(increaseAmount) || increaseAmount <= 0) {
      return errorResponse(res, "increaseAmount must be more than 0", null, 400);
    }
    const applyToAllMonths = parseApplyToAllMonths(body.applyToAllMonths);
    if (applyToAllMonths === undefined) return errorResponse(res, "applyToAllMonths must be 0 or 1", null, 400);

    const fromDate = parseFromMonth(body.fromMonth);
    if (!fromDate) return errorResponse(res, 'fromMonth is invalid — send like "August 2026"', null, 400);
    const fromLabel = monthLabelOfKey(monthKey(fromDate));

    // one invoice PDF for all sites in the request → mail gstInvoiceUrl
    let invoice = null;
    const invoiceFile = (req.files || []).find((f) => f.fieldname === "invoice");
    if (invoiceFile) {
      const isPdf = invoiceFile.mimetype === "application/pdf" || /\.pdf$/i.test(invoiceFile.originalname || "");
      if (!isPdf) return errorResponse(res, "invoice must be a PDF file", null, 400);
      invoice = typeof req.processFile === "function" ? req.processFile(invoiceFile) : null;
    }

    const opts = {
      fromDate,
      fromLabel,
      increaseAmount: round(increaseAmount),
      applyToAllMonths,
      reason: body.reason ? String(body.reason).trim() : "",
      invoice,
      user: req.user,
    };
    const created = [];
    const failed = [];
    for (const id of mediaIds) {
      const r = await createOneRevision(id, opts);
      if (r.error) failed.push({ mediaId: id, message: r.error, ...(r.revisionId ? { revisionId: r.revisionId } : {}) });
      else created.push(revisionSummary(r.revision));
    }

    if (created.length === 0) {
      return errorResponse(res, failed.length === 1 ? failed[0].message : "No rent revision created", { failed }, 400);
    }
    return successResponse(
      res,
      `${created.length} rent revision request(s) created — waiting for Rental Executive approval`,
      { created, failed },
      failed.length ? 207 : 201,
    );
  } catch (error) {
    console.error("createRentRevision error:", error);
    return errorResponse(res, "Something went wrong while creating rent revision", { error: error.message }, 500);
  }
};

// CMD approval mail for one arrears bill — same "cmdapproval" mail, amounts =
// the arrears amounts, plus a rentRevision block
async function sendArrearsMail(media, bill, revision) {
  const { sendRentalDueApprovalMail } = require("./RentalDueNew2Controller");
  const base = JSON.parse(JSON.stringify(media));
  const rp = base.rentalPayment || {};
  delete rp.rentalAmountHistory;
  delete rp.rentRevisionKeptMonths;
  const ownersById = new Map((bill.owners || []).map((o) => [String(o.landOwnerId), o]));
  const mailMedia = {
    ...base,
    rentalDue: [],
    arrearsDue: undefined,
    appraisal: { applicable: 0 },
    rentalPayment: {
      ...rp,
      totalRentalAmount: Number(bill.netPayable || 0),
      gstAmount: Number(bill.gstAmount || 0),
      netPayable: Number(bill.netPayable || 0),
      totalRentalAmountWithGst: Number(bill.netPayable || 0) + Number(bill.gstAmount || 0),
      gstInvoiceUrl: revision.invoice?.filePath || "", // revision invoice PDF
    },
    landOwners: (base.landOwners || []).map((o) => {
      const a = ownersById.get(String(o._id)) || {};
      return {
        ...o,
        shareAmount: Number(a.shareAmount || 0),
        cashAmount: Number(a.cashAmount || 0),
        onlineAmount: Number(a.onlineAmount || 0),
        gstAmount: Number(a.gstAmount || 0),
        tdsAmount: Number(a.tdsAmount || 0),
      };
    }),
  };
  const mailEntry = {
    _id: bill._id,
    dueMonth: bill.dueMonth,
    dueDate: bill.dueDate,
    netPayable: Number(bill.netPayable || 0),
    baseAmount: Number(bill.netPayable || 0),
    gstAmount: Number(bill.gstAmount || 0),
    withGst: Number(bill.withGst || 0),
    mediaDetailId: bill.mediaDetailId || null,
    paymentFrequency: Number(rp.paymentFrequency || 1),
    customPaymentFrequency: rp.customPaymentFrequency,
    approvalStatus: 3,
    ...(revision.invoice?.filePath ? { invoice: revision.invoice } : {}),
  };
  const result = await sendRentalDueApprovalMail(mailMedia, mailEntry, null, {
    rentRevision: {
      billType: "arrears",
      label: bill.label,
      dueMonth: bill.dueMonth,
      rentalDueId: bill._id,
      parentRentalDueId: bill.parentRentalDueId,
      oldRent: Number(revision.oldRent || bill.oldMonthRent || 0),
      increaseAmount: Number(revision.increaseAmount || revision.difference || 0),
      newRent: Number(revision.newRent || 0),
      arrearsAmount: Number(bill.netPayable || 0),
      applyToAllMonths: revision.applyToAllMonths ?? null,
      fromMonth: revision.fromMonth,
      reason: revision.reason || "",
    },
  });
  return {
    rentalDueId: bill._id,
    dueMonth: bill.dueMonth,
    mailtype: result?.mailtype || "cmdapproval",
    to: result?.to,
    ...(result?.cc ? { cc: result.cc } : {}),
    success: !!result?.success,
    sent: !!result?.sent,
    statusCode: result?.statusCode,
    message: result?.message,
  };
}

// Applies an approved revision to the site. Returns the "applied" block + bills.
async function applyRevision(revision, media, userName) {
  const now = nowIST();
  const newRent = Number(revision.newRent);
  const onlyFromMonth = revision.applyToAllMonths === 0;
  const plan = buildRevisionPlan(media, revision.fromDate, newRent, revision.applyToAllMonths ?? null);
  if (plan.heldMonth) {
    throw { message: `${plan.heldMonth} is on appraisal hold — release it first`, statusCode: 400 };
  }
  const oldRent = Number(media.rentalPayment?.totalRentalAmount || 0);
  // only fromMonth → site rent / owners stay (ratio 1)
  const ratio = !onlyFromMonth && oldRent > 0 ? newRent / oldRent : 1;
  const scale = (v) => (v === undefined || v === null ? v : round(Number(v) * ratio));
  const rp = media.rentalPayment || {};

  const arrearsBills = plan.arrearsBills.map((b) => toArrearsBill(b, revision._id, userName, now));

  const landOwners = (media.landOwners || []).map((o) => ({
    ...o,
    shareAmount: scale(o.shareAmount),
    cashAmount: scale(o.cashAmount),
    onlineAmount: scale(o.onlineAmount),
    gstAmount: scale(o.gstAmount),
    tdsAmount: scale(o.tdsAmount),
    totalAmountWithGst: scale(o.totalAmountWithGst),
    netPayableToOwner: scale(o.netPayableToOwner),
    netPayable: scale(o.netPayable),
    linkedSites: Array.isArray(o.linkedSites)
      ? o.linkedSites.map((ls) =>
          String(ls?.mediaId) === String(media._id)
            ? { ...ls, shareAmount: scale(ls.shareAmount), cashAmount: scale(ls.cashAmount), onlineAmount: scale(ls.onlineAmount) }
            : ls,
        )
      : o.linkedSites,
  }));

  const $set = onlyFromMonth
    ? { updatedAt: now }
    : { "rentalPayment.totalRentalAmount": newRent, landOwners, updatedAt: now };
  if (!onlyFromMonth && rp.gstAmount !== undefined && rp.gstAmount !== null) $set["rentalPayment.gstAmount"] = scale(rp.gstAmount);
  if (!onlyFromMonth && rp.totalRentalAmountWithGst !== undefined && rp.totalRentalAmountWithGst !== null) {
    $set["rentalPayment.totalRentalAmountWithGst"] = scale(rp.totalRentalAmountWithGst);
  }
  if (!onlyFromMonth && rp.netPayable !== undefined && rp.netPayable !== null) $set["rentalPayment.netPayable"] = scale(rp.netPayable);
  // site without an applied appraisal → keep the appraisal summary rent in step
  if (!onlyFromMonth && Number(media.appraisal?.applicable) !== 1 && media.appraisal) {
    $set["appraisal.currentRent"] = newRent;
    $set["appraisal.totalAppraisalAmount"] = newRent;
  }

  const arrayFilters = [];
  plan.billsUpdated.forEach((b, i) => {
    $set[`rentalDue.$[u${i}].netPayable`] = b.newAmount;
    $set[`rentalDue.$[u${i}].baseAmount`] = b.baseAmount;
    $set[`rentalDue.$[u${i}].gstAmount`] = b.gstAmount;
    $set[`rentalDue.$[u${i}].updatedBy`] = `${userName} (Rent Revision)`;
    arrayFilters.push({ [`u${i}._id`]: b.rentalDueId });
  });

  const $push = {};
  if (!onlyFromMonth) {
    $push["rentalPayment.rentalAmountHistory"] = {
      $each: [{
        amount: newRent,
        updatedBy: `${userName} (Rent Revision - from ${revision.fromMonth})`,
        updatedAt: now,
        effectiveFrom: revision.fromDate,
        rentRevisionId: revision._id,
      }],
      $sort: { updatedAt: -1 },
    };
  }
  if (plan.keptMonths.length) {
    $push["rentalPayment.rentRevisionKeptMonths"] = {
      $each: plan.keptMonths.map((k) => ({ ...k, rentRevisionId: revision._id })),
    };
  }
  if (arrearsBills.length) $push.arrearsDue = { $each: arrearsBills };

  await Media.updateOne(
    { _id: media._id },
    Object.keys($push).length ? { $set, $push } : { $set },
    arrayFilters.length ? { arrayFilters, strict: false } : { strict: false },
  );

  return {
    arrearsBills,
    applied: {
      arrearsBills: arrearsBills.map((b) => ({
        rentalDueId: b._id,
        type: "arrears",
        parentRentalDueId: b.parentRentalDueId,
        dueMonth: b.dueMonth,
        label: b.label,
        netPayable: b.netPayable,
        gstAmount: b.gstAmount,
        tdsAmount: b.tdsAmount,
        withGst: Number(b.withGst || 0),
        paid: 0,
      })),
      billsUpdated: plan.billsUpdated.map((b) => ({
        dueMonth: b.dueMonth,
        rentalDueId: b.rentalDueId,
        oldAmount: b.oldAmount,
        newAmount: b.newAmount,
      })),
      keptMonths: plan.keptMonths.map((k) => k.dueMonth),
      siteRent: {
        old: oldRent,
        increaseAmount: Number(revision.increaseAmount || newRent - oldRent),
        new: onlyFromMonth ? oldRent : newRent,
      },
    },
    arrearsTotal: arrearsBills.reduce((s, b) => s + Number(b.netPayable || 0), 0),
  };
}

// one revision → { statusCode, message, data } (statusCode >= 400 = not done)
async function approveOneRevision(revisionId, { action, remark, role, user }) {
  const userName = user?.userName || "";
  if (!revisionId || !mongoose.Types.ObjectId.isValid(String(revisionId))) {
    return { statusCode: 400, message: "revisionId is not a valid ObjectId" };
  }
  const revision = await RentRevision.findById(revisionId);
  if (!revision) return { statusCode: 404, message: "Rent revision not found" };
  if (revision.status !== "Pending") {
    return { statusCode: 400, message: `This rent revision is already ${revision.status}` };
  }
  const step = revision.approvalSteps.find((s) => Number(s.role) === role);
  if (step && step.status === "Approved") {
    return { statusCode: 400, message: `${ROLE_NAMES[role]} already approved this revision` };
  }
  // CMD can approve / reject directly (Executive / Manager not done yet → Skipped)
  if (Number(revision.currentPendingRole) !== role && role !== 3) {
    return { statusCode: 403, message: `Waiting on ${ROLE_NAMES[revision.currentPendingRole] || "another role"}` };
  }

  const now = nowIST();
  step.status = action === 1 ? "Approved" : "Rejected";
  step.by = userName;
  step.byUserId = mongoose.Types.ObjectId.isValid(String(user?.userId)) ? user.userId : null;
  step.at = now;
  step.remark = remark ? String(remark).trim() : "";
  if (role === 3) {
    revision.approvalSteps.forEach((st) => {
      if (Number(st.role) < 3 && st.status === "Pending") {
        st.status = "Skipped";
        st.at = now;
        st.remark = "Skipped — CMD decided directly";
      }
    });
  }

  const base = () => ({
    revisionId: revision._id,
    mediaId: revision.mediaId,
    mediaCode: revision.mediaCode,
    oldRent: revision.oldRent,
    increaseAmount: revision.increaseAmount,
    newRent: revision.newRent,
    applyToAllMonths: revision.applyToAllMonths ?? null,
    status: revision.status,
  });

  // ── reject → closed, nothing changes on the site
  if (action === 2) {
    revision.status = "Rejected";
    revision.currentPendingRole = null;
    revision.rejectedAt = now;
    await revision.save();
    return {
      statusCode: 200,
      message: `Rent revision rejected by ${ROLE_NAMES[role]}`,
      data: { ...base(), approvalSteps: formatSteps(revision.approvalSteps) },
    };
  }

  // ── Executive / Manager → next role
  if (role !== 3) {
    revision.currentPendingRole = role + 1;
    await revision.save();
    return {
      statusCode: 200,
      message: `Rent revision approved by ${ROLE_NAMES[role]} — waiting for ${ROLE_NAMES[role + 1]}`,
      data: {
        ...base(),
        currentPendingRole: role + 1,
        currentPendingRoleName: ROLE_NAMES[role + 1],
        approvalSteps: formatSteps(revision.approvalSteps),
      },
    };
  }

  // ── CMD → apply to the site
  const media = await Media.findById(revision.mediaId).select(RENT_REVISION_MEDIA_FIELDS).lean();
  if (!media) return { statusCode: 404, message: "Media not found for this rent revision" };

  let result;
  try {
    result = await applyRevision(revision, media, userName);
  } catch (e) {
    if (e && e.statusCode) return { statusCode: e.statusCode, message: e.message };
    throw e;
  }

  revision.status = "Approved";
  revision.currentPendingRole = null;
  revision.approvedAt = now;
  revision.applied = result.applied;
  revision.arrearsTotal = result.arrearsTotal;
  await revision.save();

  // CMD approval mail per arrears bill (a mail failure does not undo the approval)
  const mails = [];
  if (result.arrearsBills.length) {
    const freshMedia = await Media.findById(revision.mediaId).select(RENT_REVISION_MEDIA_FIELDS).lean();
    for (const bill of result.arrearsBills) {
      let mail;
      try {
        mail = await sendArrearsMail(freshMedia || media, bill, revision);
      } catch (mailErr) {
        mail = { rentalDueId: bill._id, dueMonth: bill.dueMonth, mailtype: "cmdapproval", success: false, sent: false, statusCode: 500, message: mailErr?.message || "Mail error" };
      }
      mails.push(mail);
      await Media.updateOne(
        { _id: revision.mediaId },
        { $set: { "arrearsDue.$[a].mailSent": !!mail.sent, "arrearsDue.$[a].mailSentAt": mail.sent ? nowIST() : null } },
        { arrayFilters: [{ "a._id": bill._id }], strict: false },
      );
    }
    revision.mails = mails;
    await revision.save();
  }

  return {
    statusCode: 200,
    message: `Rent revision approved by CMD and applied from ${revision.fromMonth}`,
    data: {
      ...base(),
      currentPendingRole: null,
      approvalSteps: formatSteps(revision.approvalSteps),
      applied: result.applied,
      mails,
    },
  };
}

// revisionId: array, JSON string array or a single id
const parseRevisionIds = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const t = value === undefined || value === null ? "" : String(value).trim();
  if (t.startsWith("[")) {
    try {
      const list = JSON.parse(t);
      if (Array.isArray(list)) return list.map((v) => String(v).trim()).filter(Boolean);
    } catch (e) {
      // not JSON → treated as a single id below
    }
  }
  return t ? [t] : [];
};

// ── POST /admin/rent-revision/approve ────────────────────────
// revisionId: one id (single response) or an array (results[] / failed[])
exports.approveRentRevision = async (req, res) => {
  try {
    const { remark } = req.body || {};
    const action = Number(req.body?.action);
    const role = Number(req.user?.userType);
    const isBulk = Array.isArray(req.body?.revisionId) || String(req.body?.revisionId || "").trim().startsWith("[");
    const ids = [...new Set(parseRevisionIds(req.body?.revisionId))];
    if (ids.length === 0) return errorResponse(res, "revisionId is required", null, 400);
    if (![1, 2].includes(action)) {
      return errorResponse(res, "action must be 1 (approve) or 2 (reject)", null, 400);
    }
    if (![1, 2, 3].includes(role)) {
      return errorResponse(res, "Only Rental Executive, Rental Manager or CMD can approve a rent revision", null, 403);
    }
    const opts = { action, remark, role, user: req.user };

    if (!isBulk) {
      const r = await approveOneRevision(ids[0], opts);
      if (r.statusCode >= 400) return errorResponse(res, r.message, null, r.statusCode);
      return successResponse(res, r.message, r.data);
    }

    const results = [];
    const failed = [];
    for (const id of ids) {
      const r = await approveOneRevision(id, opts);
      if (r.statusCode >= 400) failed.push({ revisionId: id, statusCode: r.statusCode, message: r.message });
      else results.push({ ...r.data, message: r.message });
    }
    if (results.length === 0) {
      return errorResponse(res, failed.length === 1 ? failed[0].message : "No rent revision processed", { failed }, 400);
    }
    let verb = `rejected by ${ROLE_NAMES[role]}`;
    if (action === 1) verb = role === 3 ? "approved by CMD and applied" : `approved by ${ROLE_NAMES[role]}`;
    return successResponse(res, `${results.length} rent revision(s) ${verb}`, { results, failed }, failed.length ? 207 : 200);
  } catch (error) {
    console.error("approveRentRevision error:", error);
    return errorResponse(res, "Something went wrong while approving rent revision", { error: error.message }, 500);
  }
};

// ── GET /admin/rent-revision-list ────────────────────────────
exports.getRentRevisionList = async (req, res) => {
  try {
    const q = { ...(req.body || {}), ...(req.query || {}) };
    const pageNumber = Math.max(1, parseInt(q.pageNumber, 10) || 1);
    const count = Math.max(1, parseInt(q.count, 10) || 10);
    const filter = {};
    if (q.mediaId) {
      if (!mongoose.Types.ObjectId.isValid(String(q.mediaId))) {
        return errorResponse(res, "mediaId is not a valid ObjectId", null, 400);
      }
      filter.mediaId = new mongoose.Types.ObjectId(String(q.mediaId));
    }
    if (q.status && ["Pending", "Approved", "Rejected"].includes(String(q.status))) filter.status = String(q.status);
    if (q.currentPendingRole && [1, 2, 3].includes(Number(q.currentPendingRole))) {
      filter.currentPendingRole = Number(q.currentPendingRole);
    }

    const [rows, totalCount] = await Promise.all([
      RentRevision.find(filter).sort({ createdAt: -1 }).skip((pageNumber - 1) * count).limit(count).lean(),
      RentRevision.countDocuments(filter),
    ]);

    // arrears paid / pending from the site's arrears bills
    const mediaIds = [...new Set(rows.map((r) => String(r.mediaId)))];
    const medias = mediaIds.length
      ? await Media.find({ _id: { $in: mediaIds } }).select("arrearsDue").lean()
      : [];
    const billsByRevision = new Map();
    medias.forEach((m) =>
      (m.arrearsDue || []).forEach((b) => {
        const k = String(b.rentRevisionId);
        if (!billsByRevision.has(k)) billsByRevision.set(k, []);
        billsByRevision.get(k).push(b);
      }),
    );

    const list = rows.map((r) => {
      const bills = billsByRevision.get(String(r._id)) || [];
      const arrearsPaid = bills.reduce((s, b) => s + Number(b.rentPaid || 0), 0);
      const arrearsTotal = Number(r.arrearsTotal || 0);
      return {
        revisionId: r._id,
        mediaId: r.mediaId,
        mediaCode: r.mediaCode,
        mediaName: r.mediaName,
        fromMonth: r.fromMonth,
        oldRent: r.oldRent,
        newRent: r.newRent,
        difference: r.difference,
        increaseAmount: r.increaseAmount ?? r.difference,
        applyToAllMonths: r.applyToAllMonths ?? null,
        invoice: r.invoice || null,
        reason: r.reason,
        status: r.status,
        currentPendingRole: r.currentPendingRole ?? null,
        currentPendingRoleName: r.currentPendingRole ? ROLE_NAMES[r.currentPendingRole] : null,
        approvalSteps: formatSteps(r.approvalSteps),
        preview: r.preview,
        applied: r.applied || null,
        arrearsTotal,
        arrearsPaid,
        arrearsPending: Math.max(0, arrearsTotal - arrearsPaid),
        arrearsBills: bills.map((b) => ({
          rentalDueId: b._id,
          label: b.label,
          dueMonth: b.dueMonth,
          netPayable: b.netPayable,
          gstAmount: b.gstAmount,
          tdsAmount: b.tdsAmount,
          rentPaid: b.rentPaid || 0,
          gstPaid: b.gstPaid || 0,
          status: arrearsStatus(b),
          mailSent: !!b.mailSent,
          mailSentAt: b.mailSentAt || null,
        })),
        mails: r.mails || [],
        requestedBy: r.requestedBy,
        requestedByRole: r.requestedByRole,
        requestedAt: r.requestedAt,
        approvedAt: r.approvedAt || null,
        rejectedAt: r.rejectedAt || null,
      };
    });

    return successResponse(res, "Rent revision list fetched successfully", {
      pageNumber,
      count,
      totalCount,
      totalPages: Math.ceil(totalCount / count),
      list,
    });
  } catch (error) {
    console.error("getRentRevisionList error:", error);
    return errorResponse(res, "Something went wrong while fetching rent revisions", { error: error.message }, 500);
  }
};
