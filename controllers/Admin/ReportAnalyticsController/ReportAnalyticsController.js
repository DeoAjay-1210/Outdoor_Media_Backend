/**
 * Report Analytics — READ-ONLY endpoints.
 * Every handler only runs find().lean() with a field projection and feeds the
 * result to the pure aggregations in utils/reportAnalytics.js. Nothing here
 * calls a function that creates or updates bills, ledgers or any other record.
 */
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const RA = require("../../../utils/reportAnalytics");
const Ledger = require("../MediaOnboardingController/LedgerNew2Controller");
const { mediaAsOfDate } = require("../../../utils/appraisalRent");

// The ledger's own (pure, read-only) helpers, reused for the period due / unpaid cards.
const LEDGER_LIB = {
  getAllDueCycles: Ledger.getAllDueCycles,
  getOverallSummaryForCycle: Ledger.getOverallSummaryForCycle,
  resolveExpectedGstForCycle: Ledger.resolveExpectedGstForCycle,
  mediaAsOfDate,
};

// Roles 1-4 (Rental Executive, Rental Manager, CMD, Other/view-only).
// Deliberately stricter than the dashboard's helper, which also admits role 5.
const ALLOWED_ROLES = [1, 2, 3, 4];
const allowedRole = (req) => ALLOWED_ROLES.includes(Number(req.user?.userType));

const FACE = "mediaDetails.mediaName mediaDetails.mediaCode mediaDetails.mediaType mediaDetails.city";

const SELECT = {
  filters: `${FACE} createdAt`,
  // payments also feeds the due/unpaid cards: ledger rules need owner amounts, ledger rows, bill labels,
  // billing anchors and appraisal history (no names, bank, PAN or contact fields are read)
  payments: `${FACE} mediaDetails.status ledgerHistory ledger gstApplicableFlag appraisal.history rentalPayment.billingStartDate rentalPayment.lastBillPaidDate rentalPayment.paymentFrequency rentalPayment.customPaymentFrequency rentalPayment.totalRentalAmount rentalPayment.gstAmount rentalPayment.gstApplicable rentalPayment.rentalOutstandingHistory rentalPayment.gstOutstandingHistory gstBalanceHistory.dueMonth gstBalanceHistory.gstAmount gstBalanceHistory.isPaid gstBalanceHistory.utrNumber gstBalanceHistory.ownerId gstBalanceHistory.landOwnerId rentalDue.dueDate rentalDue.dueMonth rentalDue.withGst rentalDue.approvalStatus rentalDue.updatedAt landOwners._id landOwners.landOwnerMasterId landOwners.paymentCategory landOwners.cashAmount landOwners.onlineAmount landOwners.shareAmount landOwners.gstApplicable landOwners.gstAmount landOwners.tdsAmount`,
  media: `${FACE} createdAt`,
  appraisal: `${FACE} appraisal`,
  bills: `${FACE} rentalDue.dueDate rentalDue.baseAmount rentalDue.gstAmount rentalDue.netPayable rentalDue.approvalStatus rentalDue.status`,
  gst: `${FACE} gstBalanceHistory rentalPayment.gstOutstandingHistory rentalDue._id rentalDue.dueDate rentalDue.gstAmount rentalDue.gstAddedToBalance rentalDue.ownerGstAddedToBalance`,
  tds: `${FACE} tdsBalanceHistory`,
};

const load = (select) => MediaOnboarding.find({}).select(select).maxTimeMS(25000).lean();

const makeHandler = (selectKey, compute, message) => async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = RA.parseFilters({ ...(req.query || {}), ...(req.body || {}) });
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const docs = await load(SELECT[selectKey]);
    return successResponse(res, message, compute(docs, parsed.filters));
  } catch (error) {
    return errorResponse(res, "Failed to build analytics", error.message, 500);
  }
};

const getFilterOptions = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const docs = await load(SELECT.filters);
    return successResponse(res, "Analytics filters fetched", RA.computeFilterOptions(docs));
  } catch (error) {
    return errorResponse(res, "Failed to load filter options", error.message, 500);
  }
};

module.exports = {
  ALLOWED_ROLES,
  allowedRole,
  getFilterOptions,
  getPaymentAnalytics: makeHandler("payments", (d, f) => RA.withPeriodDue(RA.computePayments(d, f), d, f, LEDGER_LIB), "Payment analytics fetched"),
  getMediaAnalytics: makeHandler("media", RA.computeMedia, "Media analytics fetched"),
  getAppraisalAnalytics: makeHandler("appraisal", (d, f) => RA.computeAppraisal(d, f), "Appraisal analytics fetched"),
  getBillAnalytics: makeHandler("bills", RA.computeBills, "Upcoming bill analytics fetched"),
  getGstAnalytics: makeHandler("gst", (d, f) => RA.computeGst(d, f), "GST analytics fetched"),
  getTdsAnalytics: makeHandler("tds", RA.computeTds, "TDS analytics fetched"),
};
