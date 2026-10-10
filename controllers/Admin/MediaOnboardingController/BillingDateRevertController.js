const fs = require("fs");
const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const OverDueHistory = require("../../../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const CmdNotification = require("../../../models/Admin/NotificationSchema/CmdNotificationSchema");
const BillingDateRevertRequest = require("../../../models/Admin/MediaOnboardingSchema/BillingDateRevertRequestSchema");
const { REVERT_STATUS, REVERT_STATUS_LABEL } = BillingDateRevertRequest;
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");
const deleteFromSpaces = require("../../../utils/deleteFromSpaces");
const {
  createBillingDateRevertNotification,
  updateBillingDateRevertNotificationStatus,
} = require("../NotificationController/CmdNotificationController");
const { notifyBillingDateRevertChat } = require("../../../utils/googleChat");

// ─────────────────────────────────────────────────────────────
// PREVIOUS BILLING DATE REVERT (with CMD approval)
//
// Roles (same userType values as UserSchema):
//   1 = Rental Executive  → can raise a request
//   2 = Rental Manager    → can raise a request
//   3 = CMD               → can approve / reject a request
//
// Request status:
//   1 = Pending   (site billing dates NOT changed)
//   2 = Approved  (site billing dates updated)
//   3 = Rejected  (site billing dates NOT changed)
//
// The site's rentalPayment dates are ONLY written on CMD approval, using the
// same rule as a manual lastBillPaidDate edit in MediaOnboardingController:
// billingStartDate (the cycle-walking anchor) follows the new
// lastBillPaidDate, so the existing cycle generation keeps the approved
// billing day instead of walking back to the old one.
// ─────────────────────────────────────────────────────────────
const USER_ROLE = { RENTAL_EXECUTIVE: 1, RENTAL_MANAGER: 2, CMD: 3 };
const REQUESTER_ROLES = [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.RENTAL_MANAGER];
const VIEWER_ROLES = [USER_ROLE.RENTAL_EXECUTIVE, USER_ROLE.RENTAL_MANAGER, USER_ROLE.CMD];

// same mapping as MediaOnboardingSchema / RentalDueNew2Controller
const FREQUENCY_MONTHS_MAP = { 1: 1, 2: 3, 3: 6, 4: 12, 5: 24 };

function getCycleMonthsForFrequency(rentalPayment) {
  const frequency = Number(rentalPayment?.paymentFrequency || 1);
  if (frequency === 6) {
    return Number(rentalPayment?.customPaymentFrequency) || 1;
  }
  return FREQUENCY_MONTHS_MAP[frequency] || 1;
}

// same as syncBillingCycles / generateMissedEntriesForMedia
function addMonthsUTC(date, months) {
  const d = new Date(date);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Handle month-end overflow (e.g., Jan 31 + 1 month -> March 3)
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0);
  }
  return d;
}

const toDateOnly = (input) => {
  const d = new Date(input);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const isSameDay = (a, b) => !!a && !!b && toDateOnly(a).getTime() === toDateOnly(b).getTime();

const formatYMD = (d) => (d ? toDateOnly(d).toISOString().slice(0, 10) : null);

// Accepts "YYYY-MM-DD" (or a full ISO string) and "DD.MM.YYYY" /
// "DD-MM-YYYY" / "DD/MM/YYYY". Returns a UTC-midnight Date or null.
function parseDateOnly(input) {
  if (input === undefined || input === null || input === "") return null;
  const str = String(input).trim();

  const build = (y, m, d) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    const valid =
      date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
    return valid ? date : null;
  };

  let match = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|T)/);
  if (match) return build(Number(match[1]), Number(match[2]), Number(match[3]));

  match = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) return build(Number(match[3]), Number(match[2]), Number(match[1]));

  return null;
}

const toObjectId = (id) =>
  id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;

const snapshotDates = (rp) => ({
  lastBillPaidDate: rp?.lastBillPaidDate || null,
  nextBillingDate: rp?.nextBillingDate || null,
  previousBillGenerateDate: rp?.previousBillGenerateDate || null,
  billingStartDate: rp?.billingStartDate || null,
});

// Removes an uploaded image when the request is not saved. Never throws.
async function cleanupUploadedFile(req) {
  const file = req.file;
  if (!file) return;
  try {
    if (file.path) {
      await fs.promises.unlink(file.path);
    } else if (file.key && typeof req.processFile === "function") {
      await deleteFromSpaces(req.processFile(file).filePath);
    }
  } catch (err) {
    console.error("[BillingDateRevert] uploaded file cleanup failed:", err.message);
  }
}

const formatRequest = (r) => ({
  requestId: r._id,
  mediaId: r.mediaId,
  siteCode: r.siteCode,
  siteName: r.siteName,
  landOwnerName: r.landOwnerName,
  siteDetails: r.siteDetails || [],
  paymentFrequency: r.paymentFrequency,
  customPaymentFrequency: r.customPaymentFrequency,
  cycleMonths: r.cycleMonths,
  originalDates: r.originalDates || null,
  requestedDates: r.requestedDates || null,
  datesBeforeApproval: r.datesBeforeApproval || null,
  appliedDates: r.appliedDates || null,
  removedBills: r.removedBills || [],
  remark: r.remark,
  image: r.image?.filePath ? r.image : null,
  status: r.status,
  statusLabel: REVERT_STATUS_LABEL[r.status] || "",
  requestedBy: r.requestedBy || null,
  cmdAction: r.cmdAction || null,
  notificationId: r.notificationId || null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const actorFromReq = (req, remark = "") => ({
  userId: toObjectId(req.user?.userId),
  userName: req.user?.userName || "",
  role: Number(req.user?.userType) || null,
  remark,
  actionAt: nowIST(),
});

// Requested dates must sit on the site's billing frequency and go BACK from
// the current lastBillPaidDate. Returns { error } or the resolved dates.
function validateRequestedDates(media, requestedLastBill, requestedNextBill) {
  const rp = media.rentalPayment || {};
  if (!rp.lastBillPaidDate) {
    return { error: "This site has no lastBillPaidDate yet — billing date revert is not possible" };
  }

  const cycleMonths = getCycleMonthsForFrequency(rp);
  const expectedNext = addMonthsUTC(requestedLastBill, cycleMonths);

  if (requestedNextBill && !isSameDay(requestedNextBill, expectedNext)) {
    return {
      error: `nextBillDate must be ${formatYMD(expectedNext)} (lastBillDate + ${cycleMonths} month(s) as per the site's billing frequency)`,
    };
  }

  // past (revert) and future (move forward) dates are both allowed
  if (isSameDay(requestedLastBill, rp.lastBillPaidDate)) {
    return {
      error: `lastBillDate is the same as the current lastBillDate (${formatYMD(rp.lastBillPaidDate)})`,
    };
  }

  if (
    media.agreement?.startDate &&
    toDateOnly(requestedLastBill).getTime() < toDateOnly(media.agreement.startDate).getTime()
  ) {
    return {
      error: `lastBillDate cannot be before the agreement start date (${formatYMD(media.agreement.startDate)})`,
    };
  }

  return { cycleMonths, lastBillPaidDate: toDateOnly(requestedLastBill), nextBillingDate: expectedNext };
}

// ─────────────────────────────────────────────────────────────
// POST /admin/billing-date-revert/request   (multipart/form-data)
// Roles: Rental Executive (1), Rental Manager (2)
// body: mediaId, lastBillDate, nextBillDate (optional — computed from the
//       billing frequency when omitted), remark; file field: image (optional)
// Saves a PENDING request and notifies CMD. Site billing dates are NOT changed.
// ─────────────────────────────────────────────────────────────
exports.createBillingDateRevertRequest = async (req, res) => {
  try {
    const role = Number(req.user?.userType);
    if (!REQUESTER_ROLES.includes(role)) {
      await cleanupUploadedFile(req);
      return errorResponse(res, "Only Rental Executive / Rental Manager can request a billing date revert", null, 403);
    }

    const { mediaId, lastBillDate, nextBillDate, remark } = req.body || {};

    const fail = async (message, statusCode = 400, error = null) => {
      await cleanupUploadedFile(req);
      return errorResponse(res, message, error, statusCode);
    };

    const mediaObjectId = toObjectId(typeof mediaId === "string" ? mediaId.trim() : mediaId);
    if (!mediaObjectId) return fail("A valid mediaId is required");

    const remarkText = typeof remark === "string" ? remark.trim() : "";
    if (!remarkText) return fail("remark is required");

    // image is optional; when sent it must be an image file
    if (req.file && !String(req.file.mimetype || "").startsWith("image/")) {
      return fail("image must be an image file");
    }

    const requestedLastBill = parseDateOnly(lastBillDate);
    if (!requestedLastBill) {
      return fail("A valid lastBillDate is required (YYYY-MM-DD or DD.MM.YYYY)");
    }
    let requestedNextBill = null;
    if (nextBillDate !== undefined && nextBillDate !== null && nextBillDate !== "") {
      requestedNextBill = parseDateOnly(nextBillDate);
      if (!requestedNextBill) return fail("nextBillDate is not a valid date (YYYY-MM-DD or DD.MM.YYYY)");
    }

    const media = await Media.findById(mediaObjectId)
      .select("siteCode mediaDetails landOwners rentalPayment agreement")
      .lean();
    if (!media) return fail("Media not found", 404);

    const validation = validateRequestedDates(media, requestedLastBill, requestedNextBill);
    if (validation.error) return fail(validation.error);

    const pending = await BillingDateRevertRequest.findOne({
      mediaId: mediaObjectId,
      status: REVERT_STATUS.PENDING,
    })
      .select("_id")
      .lean();
    if (pending) {
      return fail("A billing date revert request is already pending for this site", 409, {
        requestId: pending._id,
      });
    }

    const details = media.mediaDetails || [];
    const activeFaces = details.filter((d) => Number(d.status) === 1);
    const facesForLabel = activeFaces.length ? activeFaces : details;
    const rp = media.rentalPayment || {};
    const now = nowIST();

    let request;
    try {
      request = await BillingDateRevertRequest.create({
        mediaId: media._id,
        siteCode: media.siteCode || facesForLabel.map((d) => d.mediaCode).filter(Boolean).join(" / "),
        siteName: facesForLabel.map((d) => d.mediaName).filter(Boolean).join(", "),
        landOwnerName: (media.landOwners || []).map((o) => o.name).filter(Boolean).join(", "),
        siteDetails: details.map((d) => ({
          mediaDetailId: d._id,
          mediaCode: d.mediaCode,
          mediaName: d.mediaName,
          mediaType: d.mediaType,
          state: d.state,
          city: d.city,
          district: d.district,
          location: d.location,
          status: d.status,
        })),
        paymentFrequency: rp.paymentFrequency,
        customPaymentFrequency: Number(rp.paymentFrequency) === 6 ? Number(rp.customPaymentFrequency) || 1 : null,
        cycleMonths: validation.cycleMonths,
        originalDates: snapshotDates(rp),
        requestedDates: {
          lastBillPaidDate: validation.lastBillPaidDate,
          nextBillingDate: validation.nextBillingDate,
        },
        remark: remarkText,
        ...(req.file ? { image: req.processFile(req.file) } : {}),
        status: REVERT_STATUS.PENDING,
        requestedBy: actorFromReq(req, remarkText),
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // E11000 = another pending request for this site was saved concurrently
      if (err?.code === 11000) {
        return fail("A billing date revert request is already pending for this site", 409);
      }
      throw err;
    }

    const notificationId = await createBillingDateRevertNotification({ request });
    if (notificationId) {
      request.notificationId = notificationId;
      await BillingDateRevertRequest.updateOne({ _id: request._id }, { $set: { notificationId } });
    }
    notifyBillingDateRevertChat({ request, event: "requested" });

    return successResponse(
      res,
      "Billing date revert request submitted for CMD approval",
      formatRequest(request.toObject()),
      201,
    );
  } catch (error) {
    await cleanupUploadedFile(req);
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// STALE REVERT BILLS
// An earlier revert to an older date makes the cycle generation backfill
// bills for the months in between. When a later revert moves lastBillPaidDate
// forward again, bills for months up to the new lastBillPaidDate are no
// longer due. Only bills that are ALL of the following are removed:
//   • created after an earlier approved revert of this site
//   • for a month on/before the new lastBillPaidDate month
//   • auto-generated by the system and untouched (nobody approved / edited,
//     no proof / invoice, no GST balance, not referenced anywhere else)
//   • no overdue remark added on it
// Real / approved / edited bills are never removed.
// ─────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 330 * 60000; // nowIST() values are shifted by this
const AUTO_GENERATED_BY = "System (auto-generated)";
const monthKeyUTC = (d) => {
  const date = new Date(d);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};

async function findStaleRevertBills(media, requestedLastBill, currentRequestId) {
  const priorApprovals = await BillingDateRevertRequest.find({
    mediaId: media._id,
    status: REVERT_STATUS.APPROVED,
    _id: { $ne: currentRequestId },
    "cmdAction.actionAt": { $ne: null },
  })
    .select("cmdAction.actionAt")
    .lean();
  if (priorApprovals.length === 0) return [];

  // cmdAction.actionAt is an IST-shifted nowIST(); ObjectId timestamps are real UTC
  const firstApprovalAt = Math.min(
    ...priorApprovals.map((r) => new Date(r.cmdAction.actionAt).getTime() - IST_OFFSET_MS),
  );
  const lastBillMonth = monthKeyUTC(requestedLastBill);

  const plain = media.toObject({ virtuals: false });
  const { rentalDue: _rentalDue, rentalDueHistory: _rentalDueHistory, ...rest } = plain;
  const otherData = JSON.stringify(rest);

  const candidates = (plain.rentalDue || []).filter((entry) => {
    if (!entry?._id || !entry.dueDate) return false;
    if (entry._id.getTimestamp().getTime() < firstApprovalAt) return false;
    if (monthKeyUTC(entry.dueDate) > lastBillMonth) return false;
    if ([2, 3].includes(Number(entry.approvalStatus)) || [2, 3].includes(Number(entry.status))) return false;
    if ((entry.approvalSteps || []).some((s) => [2, 3].includes(Number(s.status)) || s.approvedAt)) return false;
    if (entry.savedBy?.userName !== AUTO_GENERATED_BY) return false;
    if (entry.proofOfCampaign?.filePath || entry.invoice?.filePath || entry.campaignName) return false;
    if (entry.ownerApprovalDate || entry.gstAddedToBalance || entry.ownerGstAddedToBalance) return false;
    if (otherData.includes(String(entry._id))) return false; // ledger / GST / verification refs
    return true;
  });
  if (candidates.length === 0) return [];

  const withOverdueRemarks = await OverDueHistory.find({
    rentalDueId: { $in: candidates.map((e) => e._id) },
    $or: [{ remarks: { $nin: ["", null] } }, { "overDueRemarks.0": { $exists: true } }],
  })
    .select("rentalDueId")
    .lean();
  const blocked = new Set(withOverdueRemarks.map((o) => String(o.rentalDueId)));

  return candidates
    .filter((e) => !blocked.has(String(e._id)))
    .map((e) => ({
      rentalDueId: e._id,
      mediaDetailId: e.mediaDetailId || null,
      dueMonth: e.dueMonth,
      dueDate: e.dueDate,
      netPayable: Number(e.netPayable || 0),
    }));
}

// ─────────────────────────────────────────────────────────────
// BILLS SKIPPED BY A FORWARD MOVE
// When lastBillPaidDate moves FORWARD (e.g. 18.10 → 20.11), every cycle up to
// the new lastBillPaidDate month counts as already billed. Bills for those
// months that CMD has NOT fully approved are removed. Kept always:
//   • fully approved bills (approvalStatus / status 3)
//   • bills linked to a payment (ledger, GST / TDS balance) or GST balance
// A full copy of each removed bill is stored on the request.
// ─────────────────────────────────────────────────────────────
function findBillsSkippedByForwardMove(media, requestedLastBill) {
  const lastBillMonth = monthKeyUTC(requestedLastBill);
  const plain = media.toObject({ virtuals: false });
  const paymentData = JSON.stringify([
    plain.ledger,
    plain.withGst1Ledger,
    plain.ledgerHistory,
    plain.gstBalanceHistory,
    plain.tdsBalanceHistory,
  ]);

  return (plain.rentalDue || [])
    .filter((entry) => {
      if (!entry?._id || !entry.dueDate) return false;
      if (monthKeyUTC(entry.dueDate) > lastBillMonth) return false;
      if (Number(entry.approvalStatus) === 3 || Number(entry.status) === 3) return false;
      if (entry.gstAddedToBalance || entry.ownerGstAddedToBalance) return false;
      if (paymentData.includes(String(entry._id))) return false;
      return true;
    })
    .map((e) => ({
      rentalDueId: e._id,
      mediaDetailId: e.mediaDetailId || null,
      dueMonth: e.dueMonth,
      dueDate: e.dueDate,
      netPayable: Number(e.netPayable || 0),
      approvalStatus: e.approvalStatus,
      bill: e, // full copy for audit
    }));
}

exports.findBillsSkippedByForwardMove = findBillsSkippedByForwardMove;

// Removes the bills from rentalDue / rentalDueHistory on the (unsaved) media doc.
function removeBillsFromMedia(media, bills) {
  const ids = new Set(bills.map((b) => String(b.rentalDueId)));
  bills.forEach((b) => media.rentalDue.pull({ _id: b.rentalDueId }));

  media.rentalDueHistory = (media.rentalDueHistory || [])
    .map((year) => ({
      year: year.year,
      months: (year.months || [])
        .map((month) => ({
          month: month.month,
          entries: (month.entries || []).filter((h) => !ids.has(String(h.rentalDueId))),
        }))
        .filter((month) => month.entries.length > 0),
    }))
    .filter((year) => year.months.length > 0);
  media.markModified("rentalDueHistory");
}

// overdue rows + CMD approval / reminder notifications of the removed bills
async function removeOverdueRowsForBills(bills) {
  if (!bills.length) return;
  const ids = bills.map((b) => b.rentalDueId);
  await OverDueHistory.deleteMany({ rentalDueId: { $in: ids } });
  await CmdNotification.deleteMany({
    rentalDueId: { $in: ids },
    notificationType: { $ne: "billingDateRevert" },
  });
}

exports.findStaleRevertBills = findStaleRevertBills;
exports.removeBillsFromMedia = removeBillsFromMedia;
exports.removeOverdueRowsForBills = removeOverdueRowsForBills;

// ─────────────────────────────────────────────────────────────
// POST /admin/billing-date-revert/approve
// Role: CMD (3)
// body: { requestId, remark? }
// Applies the requested dates to the site. A request can be approved once.
// ─────────────────────────────────────────────────────────────
exports.approveBillingDateRevertRequest = async (req, res) => {
  try {
    if (Number(req.user?.userType) !== USER_ROLE.CMD) {
      return errorResponse(res, "Only CMD can approve a billing date revert request", null, 403);
    }

    const { requestId, remark } = req.body || {};
    const requestObjectId = toObjectId(requestId);
    if (!requestObjectId) return errorResponse(res, "A valid requestId is required", null, 400);

    const request = await BillingDateRevertRequest.findById(requestObjectId).lean();
    if (!request) return errorResponse(res, "Billing date revert request not found", null, 404);
    if (request.status !== REVERT_STATUS.PENDING) {
      return errorResponse(
        res,
        `This request is already ${REVERT_STATUS_LABEL[request.status] || "processed"}`,
        { status: request.status, statusLabel: REVERT_STATUS_LABEL[request.status] },
        409,
      );
    }

    const media = await Media.findById(request.mediaId);
    if (!media) return errorResponse(res, "Media not found", null, 404);

    // re-check against the site's CURRENT frequency / dates — they may have
    // changed while the request was pending
    const validation = validateRequestedDates(
      media,
      request.requestedDates.lastBillPaidDate,
      request.requestedDates.nextBillingDate,
    );
    if (validation.error) {
      return errorResponse(
        res,
        `Request can no longer be applied: ${validation.error}. Reject it and raise a new request.`,
        null,
        409,
      );
    }

    const remarkText = typeof remark === "string" ? remark.trim() : "";
    const datesBeforeApproval = snapshotDates(media.rentalPayment);
    // moving BACK → remove untouched bills an earlier revert created;
    // moving FORWARD → remove not-fully-approved bills up to the new date
    const isMovingBack =
      toDateOnly(validation.lastBillPaidDate).getTime() < toDateOnly(datesBeforeApproval.lastBillPaidDate).getTime();
    const removedBills = isMovingBack
      ? await findStaleRevertBills(media, validation.lastBillPaidDate, requestObjectId)
      : findBillsSkippedByForwardMove(media, validation.lastBillPaidDate);

    // claim the request atomically — a second approve/reject gets null here
    const claimed = await BillingDateRevertRequest.findOneAndUpdate(
      { _id: requestObjectId, status: REVERT_STATUS.PENDING },
      {
        $set: {
          status: REVERT_STATUS.APPROVED,
          cmdAction: actorFromReq(req, remarkText),
          datesBeforeApproval,
          updatedAt: nowIST(),
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      return errorResponse(res, "This request has already been processed", null, 409);
    }

    try {
      // same handling as a manual lastBillPaidDate edit: the anchor follows
      // the new lastBillPaidDate; pre-save hooks recompute the rest
      media.rentalPayment.billingStartDate = validation.lastBillPaidDate;
      media.rentalPayment.previousBillGenerateDate = datesBeforeApproval.lastBillPaidDate;
      media.rentalPayment.lastBillPaidDate = validation.lastBillPaidDate;
      media.rentalPayment.nextBillingDate = validation.nextBillingDate;
      if (removedBills.length) removeBillsFromMedia(media, removedBills);
      media.updatedAt = nowIST();
      await media.save({ timestamps: false });
    } catch (err) {
      // site not updated → put the request back to Pending
      await BillingDateRevertRequest.updateOne(
        { _id: requestObjectId, status: REVERT_STATUS.APPROVED },
        {
          $set: { status: REVERT_STATUS.PENDING, cmdAction: null, datesBeforeApproval: null, updatedAt: nowIST() },
        },
      );
      return errorResponse(res, `Failed to update site billing dates: ${err.message}`, null, 500);
    }

    await removeOverdueRowsForBills(removedBills);

    const appliedDates = snapshotDates(media.rentalPayment);
    claimed.appliedDates = appliedDates;
    claimed.removedBills = removedBills;
    await BillingDateRevertRequest.updateOne({ _id: requestObjectId }, { $set: { appliedDates, removedBills } });
    await updateBillingDateRevertNotificationStatus(requestObjectId, REVERT_STATUS.APPROVED);
    notifyBillingDateRevertChat({ request: claimed, event: "approved" });

    return successResponse(res, "Billing date revert approved and site billing dates updated", formatRequest(claimed.toObject()));
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /admin/billing-date-revert/reject
// Role: CMD (3)
// body: { requestId, remark }
// Site billing dates are NOT changed.
// ─────────────────────────────────────────────────────────────
exports.rejectBillingDateRevertRequest = async (req, res) => {
  try {
    if (Number(req.user?.userType) !== USER_ROLE.CMD) {
      return errorResponse(res, "Only CMD can reject a billing date revert request", null, 403);
    }

    const { requestId, remark } = req.body || {};
    const requestObjectId = toObjectId(requestId);
    if (!requestObjectId) return errorResponse(res, "A valid requestId is required", null, 400);

    const remarkText = typeof remark === "string" ? remark.trim() : "";
    if (!remarkText) return errorResponse(res, "remark is required to reject a request", null, 400);

    const updated = await BillingDateRevertRequest.findOneAndUpdate(
      { _id: requestObjectId, status: REVERT_STATUS.PENDING },
      {
        $set: {
          status: REVERT_STATUS.REJECTED,
          cmdAction: actorFromReq(req, remarkText),
          updatedAt: nowIST(),
        },
      },
      { returnDocument: "after" },
    ).lean();

    if (!updated) {
      const existing = await BillingDateRevertRequest.findById(requestObjectId).select("status").lean();
      if (!existing) return errorResponse(res, "Billing date revert request not found", null, 404);
      return errorResponse(
        res,
        `This request is already ${REVERT_STATUS_LABEL[existing.status] || "processed"}`,
        { status: existing.status, statusLabel: REVERT_STATUS_LABEL[existing.status] },
        409,
      );
    }

    await updateBillingDateRevertNotificationStatus(requestObjectId, REVERT_STATUS.REJECTED);
    notifyBillingDateRevertChat({ request: updated, event: "rejected" });
    return successResponse(res, "Billing date revert request rejected", formatRequest(updated));
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// POST/GET /admin/billing-date-revert/list
// Roles: Rental Executive (1), Rental Manager (2), CMD (3)
// body/query: pageNumber, count, status (1|2|3), mediaId, search
// ─────────────────────────────────────────────────────────────
exports.getBillingDateRevertRequests = async (req, res) => {
  try {
    if (!VIEWER_ROLES.includes(Number(req.user?.userType))) {
      return errorResponse(res, "You are not allowed to view billing date revert requests", null, 403);
    }

    const params = { ...(req.query || {}), ...(req.body || {}) };
    const pageNumber = Math.max(parseInt(params.pageNumber) || 1, 1);
    const count = Math.max(parseInt(params.count) || 10, 1);

    const filter = {};
    const status = Number(params.status);
    if (Object.values(REVERT_STATUS).includes(status)) filter.status = status;
    if (params.mediaId) {
      const mediaObjectId = toObjectId(params.mediaId);
      if (!mediaObjectId) return errorResponse(res, "mediaId is not valid", null, 400);
      filter.mediaId = mediaObjectId;
    }
    if (typeof params.search === "string" && params.search.trim()) {
      const escaped = params.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      filter.$or = [{ siteCode: regex }, { siteName: regex }, { landOwnerName: regex }];
    }

    const [totalCount, statusCounts, rows] = await Promise.all([
      BillingDateRevertRequest.countDocuments(filter),
      BillingDateRevertRequest.aggregate([
        { $match: { ...filter, status: { $exists: true } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      BillingDateRevertRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * count)
        .limit(count)
        .lean(),
    ]);

    const countFor = (s) => statusCounts.find((c) => c._id === s)?.count || 0;

    return successResponse(res, "Billing date revert requests fetched successfully", {
      pendingCount: countFor(REVERT_STATUS.PENDING),
      approvedCount: countFor(REVERT_STATUS.APPROVED),
      rejectedCount: countFor(REVERT_STATUS.REJECTED),
      pagination: {
        pageNumber,
        count,
        totalCount,
        totalPages: Math.ceil(totalCount / count),
      },
      requests: rows.map(formatRequest),
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};
