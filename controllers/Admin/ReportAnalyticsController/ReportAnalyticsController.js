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
const { mediaAsOfDate, landOwnersAsOfDate } = require("../../../utils/appraisalRent");

// The ledger's own (pure, read-only) helpers — the Rental Master cycle calculation.
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

// Payments under Rental Master = the Rental Master cycle calculation: ledger rules need owner amounts,
// paid-state rows, bill labels, billing anchors and appraisal history (no bank, PAN or contact fields).
const RM_PAYMENTS = `${FACE} mediaDetails.status ledgerHistory ledger gstApplicableFlag appraisal.history rentalPayment.billingStartDate rentalPayment.lastBillPaidDate rentalPayment.paymentFrequency rentalPayment.customPaymentFrequency rentalPayment.totalRentalAmount rentalPayment.gstAmount rentalPayment.gstApplicable rentalPayment.rentalOutstandingHistory rentalPayment.gstOutstandingHistory gstBalanceHistory.dueMonth gstBalanceHistory.gstAmount gstBalanceHistory.isPaid gstBalanceHistory.utrNumber gstBalanceHistory.ownerId gstBalanceHistory.landOwnerId rentalDue.dueDate rentalDue.dueMonth rentalDue.withGst rentalDue.approvalStatus rentalDue.updatedAt landOwners._id landOwners.landOwnerMasterId landOwners.paymentCategory landOwners.cashAmount landOwners.onlineAmount landOwners.shareAmount landOwners.gstApplicable landOwners.gstAmount landOwners.tdsAmount`;

/**
 * Field projection per chart and data source ("rentalMaster" | "ledger").
 * `both` = the chart is the same for either source (not a ledger/Rental Master record).
 * A missing source means the combination is NOT SUPPORTED: no query is run and the
 * response says so (with the reason) instead of returning misleading zeros.
 */
const SELECT = {
  filters: `${FACE} createdAt`,
  payments: {
    ledger: `${FACE} ledgerHistory`,
    rentalMaster: RM_PAYMENTS,
  },
  media: { both: `${FACE} createdAt` },
  appraisal: { rentalMaster: `${FACE} appraisal` },
  bills: { rentalMaster: `${FACE} rentalDue.dueDate rentalDue.baseAmount rentalDue.gstAmount rentalDue.netPayable rentalDue.approvalStatus rentalDue.status` },
  // GST under Ledger = the Ledger Entry GST calculation (expected GST per bill cycle, paid from
  // gstBalanceHistory / the ledger) + onboarding GST rows — the same fields as the cycle calculation.
  gst: {
    ledger: RM_PAYMENTS,
    rentalMaster: `${FACE} rentalDue.dueDate rentalDue.gstAmount rentalDue.withGst rentalPayment.gstOutstandingHistory`,
  },
  tds: {
    ledger: `${FACE} tdsBalanceHistory`,
    rentalMaster: `${FACE} rentalDue._id rentalDue.dueDate rentalDue.dueMonth rentalDue.approvalStatus rentalDue.status rentalDue.updatedAt landOwners._id landOwners.name landOwners.tdsApplicable landOwners.tdsAmount landOwners.tdsHold rentalPayment.totalRentalAmount appraisal.history`,
  },
};

const UNSUPPORTED = {
  appraisal: { ledger: "Ledger records hold payments only; appraisals are Rental Master records (appraisal history)." },
  bills: { ledger: "Ledger records hold payments only; generated bills are Rental Master records (rentalDue)." },
};

const COMPUTE = {
  payments: {
    ledger: (d, f) => RA.computePayments(d, f),
    rentalMaster: (d, f) => RA.computeRentalMasterPayments(d, f, LEDGER_LIB),
  },
  media: { both: (d, f) => RA.computeMedia(d, f) },
  appraisal: { rentalMaster: (d, f) => RA.computeAppraisal(d, f) },
  bills: { rentalMaster: (d, f) => RA.computeBills(d, f) },
  gst: { ledger: (d, f) => RA.computeLedgerGst(d, f, LEDGER_LIB), rentalMaster: (d, f) => RA.computeGst(d, f) },
  tds: {
    ledger: (d, f) => RA.computeTds(d, f),
    rentalMaster: (d, f) => RA.computeTdsRentalMaster(d, f, { landOwnersAsOfDate }),
  },
};

const load = (select) => MediaOnboarding.find({}).select(select).maxTimeMS(25000).lean();

/** Which projection/aggregation serves a chart for a source; null when unsupported. */
const resolve = (chart, source) => {
  const key = SELECT[chart].both ? "both" : source;
  return SELECT[chart][key] ? { select: SELECT[chart][key], compute: COMPUTE[chart][key], sourceIndependent: key === "both" } : null;
};

const makeHandler = (chart, message) => async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = RA.parseFilters({ ...(req.query || {}), ...(req.body || {}) });
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const f = parsed.filters;
    const route = resolve(chart, f.source);
    if (!route) {
      return successResponse(res, message, {
        filters: { source: f.source },
        supported: false,
        reason: UNSUPPORTED[chart]?.[f.source] || "Not available for this data source.",
        buckets: [],
        summary: {},
        meta: {},
      });
    }
    const docs = await load(route.select);
    const data = route.compute(docs, f);
    return successResponse(res, message, { ...data, supported: true, sourceIndependent: route.sourceIndependent });
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
  SELECT, // field projection per chart and source — the data sources named on the charts
  allowedRole,
  getFilterOptions,
  resolve,
  getPaymentAnalytics: makeHandler("payments", "Payment analytics fetched"),
  getMediaAnalytics: makeHandler("media", "Media analytics fetched"),
  getAppraisalAnalytics: makeHandler("appraisal", "Appraisal analytics fetched"),
  getBillAnalytics: makeHandler("bills", "Upcoming bill analytics fetched"),
  getGstAnalytics: makeHandler("gst", "GST analytics fetched"),
  getTdsAnalytics: makeHandler("tds", "TDS analytics fetched"),
};
