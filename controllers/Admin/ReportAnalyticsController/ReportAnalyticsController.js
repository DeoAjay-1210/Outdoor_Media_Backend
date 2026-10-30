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
const { pendingRoleOf } = require("../DashboardController/DashboardExtras");

// The ledger's own (pure, read-only) helpers — the Rental Master cycle calculation.
const LEDGER_LIB = {
  getAllDueCycles: Ledger.getAllDueCycles,
  getOverallSummaryForCycle: Ledger.getOverallSummaryForCycle,
  resolveExpectedGstForCycle: Ledger.resolveExpectedGstForCycle,
  mediaAsOfDate,
  pendingRoleOf, // the dashboard's approval-stage helper (which role a pending bill waits on)
};

// Roles 1-4 (Rental Executive, Rental Manager, CMD, Other/view-only).
// Deliberately stricter than the dashboard's helper, which also admits role 5.
const ALLOWED_ROLES = [1, 2, 3, 4];
const allowedRole = (req) => ALLOWED_ROLES.includes(Number(req.user?.userType));

// face fields every chart reads: names / type / city for filters and labels, status for the site-status filter
const FACE = "siteCode mediaDetails.mediaName mediaDetails.mediaCode mediaDetails.mediaType mediaDetails.city mediaDetails.status";

// Payments under Rental Master = the Rental Master cycle calculation: ledger rules need owner amounts,
// paid-state rows, bill labels, billing anchors and appraisal history (no bank, PAN or contact fields).
const RM_PAYMENTS = `${FACE} mediaDetails.status ledgerHistory ledger gstApplicableFlag appraisal.history rentalPayment.billingStartDate rentalPayment.lastBillPaidDate rentalPayment.paymentFrequency rentalPayment.customPaymentFrequency rentalPayment.totalRentalAmount rentalPayment.gstAmount rentalPayment.gstApplicable rentalPayment.rentalOutstandingHistory rentalPayment.gstOutstandingHistory gstBalanceHistory.dueMonth gstBalanceHistory.gstAmount gstBalanceHistory.isPaid gstBalanceHistory.utrNumber gstBalanceHistory.ownerId gstBalanceHistory.landOwnerId rentalDue.dueDate rentalDue.dueMonth rentalDue.withGst rentalDue.approvalStatus rentalDue.updatedAt landOwners._id landOwners.landOwnerMasterId landOwners.paymentCategory landOwners.cashAmount landOwners.onlineAmount landOwners.shareAmount landOwners.gstApplicable landOwners.gstAmount landOwners.tdsAmount`;

// the site's stored payment cycle (rentalPayment.paymentFrequency, + months when custom): the "Payment Cycle" column of the detail popups
const CYCLE = "rentalPayment.paymentFrequency rentalPayment.customPaymentFrequency";

// the landlords' names (no bank, PAN or contact fields); the media codes come from mediaDetails, already read. Listed by the
// payments / outstanding detail dialogs
const DETAIL_IDS = "landOwners.name";

/**
 * Field projection per chart and data source ("rentalMaster" | "ledger").
 * `both` = the chart is the same for either source (not a ledger/Rental Master record).
 * A missing source means the combination is NOT SUPPORTED: no query is run and the
 * response says so (with the reason) instead of returning misleading zeros.
 */
const SELECT = {
  filters: `${FACE} createdAt`,
  payments: {
    ledger: `${FACE} ledgerHistory ${CYCLE}`,
    rentalMaster: `${RM_PAYMENTS} ${DETAIL_IDS}`,
  },
  media: { both: `${FACE} createdAt ${CYCLE}` },
  // Agreements: the current agreement and every filed version (dates, reminder days, document type) + the site's payment cycle / landlords for the popup rows
  agreements: { both: `${FACE} agreement.startDate agreement.endDate agreement.reminderBeforeExpiry agreement.agreementStatus agreement.agreementPDF.filePath agreement.agreementPDF.originalName agreement.agreementPDF.fileName agreementHistory.startDate agreementHistory.endDate agreementHistory.reminderBeforeExpiry agreementHistory.agreementStatus agreementHistory.agreementPDF.filePath agreementHistory.agreementPDF.originalName agreementHistory.agreementPDF.fileName ${CYCLE} ${DETAIL_IDS}` },
  appraisal: { rentalMaster: "" }, // set below: the bills query + the appraisal subdocument
  // Outstanding payments = the Rental Master / Ledger cycle calculation (same fields as Payments) plus
  // the face ids on BOTH sides — a projection keeps a nested _id only when listed — so stale rows
  // (rentalDue.mediaDetailId not on a current face) can be left out before cycles are walked.
  // (bill amounts feed the optional export detail rows, `details: true`)
  bills: { rentalMaster: `${RM_PAYMENTS} ${DETAIL_IDS} mediaDetails._id mediaDetails.siteBillMode rentalPayment.status rentalDue._id rentalDue.mediaDetailId rentalDue.status rentalDue.baseAmount rentalDue.gstAmount rentalDue.netPayable rentalDue.currentPendingRole rentalDue.approvalSteps.role rentalDue.approvalSteps.status rentalDue.approvalSteps.userName rentalDue.approvalSteps.approvedAt` },
  // GST under Ledger = the Ledger Entry GST calculation (expected GST per bill cycle, paid from
  // gstBalanceHistory / the ledger) + onboarding GST rows — the same fields as the cycle calculation.
  gst: {
    // (+ the bill's approval steps: the Pending Approval rows show who approved and who is pending)
    ledger: `${RM_PAYMENTS} ${DETAIL_IDS} rentalDue.approvalFlow rentalDue.approvalSteps.role rentalDue.approvalSteps.status rentalDue.approvalSteps.userName rentalDue.approvalSteps.approvedAt`,
    // (the bill month and status label the optional per-bill detail rows)
    rentalMaster: `${FACE} rentalDue.dueDate rentalDue.dueMonth rentalDue.approvalStatus rentalDue.status rentalDue.gstAmount rentalDue.withGst rentalPayment.gstOutstandingHistory ${CYCLE} ${DETAIL_IDS}`,
  },
  tds: {
    // + the rent ledger rows (the Ledger records the TDS deduction with the rent payment) and the owner TDS settings they are priced with
    ledger: `${FACE} tdsBalanceHistory ledger ledgerHistory landOwners._id landOwners.landOwnerMasterId landOwners.name landOwners.paymentCategory landOwners.tdsApplicable landOwners.tdsAmount landOwners.tdsHold rentalPayment.totalRentalAmount appraisal.history ${CYCLE}`,
    rentalMaster: `${FACE} rentalDue._id rentalDue.dueDate rentalDue.dueMonth rentalDue.approvalStatus rentalDue.status rentalDue.updatedAt landOwners._id landOwners.name landOwners.tdsApplicable landOwners.tdsAmount landOwners.tdsHold rentalPayment.totalRentalAmount ${CYCLE} appraisal.history`,
  },
};

// Appraisals: each appraisal's status comes from the stored bill of its month (approval status / steps, CMD appraisal hold — the fields
// /admin/appraisal-hold-remarks reads) and from the Ledger's payment calculation (the same cycle projection as Payment analytics / Outstanding).
// = the bills projection, with the whole `appraisal` subdocument (history + revisions) instead of its `appraisal.history` part, plus the hold fields.
SELECT.appraisal.rentalMaster = [
  ...new Set([
    ...SELECT.bills.rentalMaster.split(/\s+/).filter((t) => t && !t.startsWith("appraisal.")),
    "appraisal",
    "rentalDue.dueDate", "rentalDue.approvalStatus", "rentalDue.status", "rentalDue.approvalFlow", "rentalDue.currentPendingRole",
    "rentalDue.appraisalHold.hold", "rentalDue.appraisalHold.heldAt", "rentalDue.appraisalHold.releasedAt",
  ]),
].join(" ");

// TDS Total / Paid / Upcoming: Rental Master's configured TDS of the generated bills + the Ledger's recorded deductions (source-independent)
SELECT.tdsStatus = { both: `${FACE} rentalDue._id rentalDue.dueDate rentalDue.dueMonth rentalDue.approvalStatus rentalDue.status rentalDue.updatedAt landOwners._id landOwners.landOwnerMasterId landOwners.name landOwners.tdsApplicable landOwners.tdsAmount landOwners.tdsHold landOwners.paymentCategory rentalPayment.totalRentalAmount appraisal.history tdsBalanceHistory ledger ledgerHistory ${CYCLE}` };

// Campaign Live Status: the stored bills (campaignStatus is per bill) + the site's face / landlord / city labels for the popup rows
SELECT.campaign = { both: `${FACE} mediaDetails._id rentalDue._id rentalDue.mediaDetailId rentalDue.dueDate rentalDue.dueMonth rentalDue.baseAmount rentalDue.gstAmount rentalDue.campaignStatus rentalDue.campaignName rentalDue.updatedAt ${CYCLE} ${DETAIL_IDS}` };

const UNSUPPORTED = {
  appraisal: { ledger: "Ledger records hold payments only; appraisals are Rental Master records (appraisal history)." },
  bills: { ledger: "Outstanding payments come from the Rental Master cycle calculation; the ledger alone has no bills to be paid." },
};

const COMPUTE = {
  payments: {
    ledger: (d, f) => RA.computePayments(d, f),
    rentalMaster: (d, f) => RA.computeRentalMasterPayments(d, f, LEDGER_LIB),
  },
  media: { both: (d, f) => RA.computeMedia(d, f) },
  agreements: { both: (d, f) => RA.computeAgreements(d, f) },
  appraisal: { rentalMaster: (d, f) => RA.computeAppraisal(d, f, undefined, { payments: RA.cyclePaymentIndex(d, f, LEDGER_LIB), lib: LEDGER_LIB }) },
  bills: { rentalMaster: (d, f) => RA.computeOutstanding(d, f, LEDGER_LIB) },
  gst: { ledger: (d, f) => RA.computeLedgerGst(d, f, LEDGER_LIB), rentalMaster: (d, f) => RA.computeGst(d, f) },
  campaign: { both: (d, f) => RA.computeCampaign(d, f) },
  tdsStatus: { both: (d, f) => RA.computeTdsOverview(d, f, { landOwnersAsOfDate }) },
  tds: {
    ledger: (d, f) => RA.computeTds(d, f, { landOwnersAsOfDate }),
    rentalMaster: (d, f) => RA.computeTdsRentalMaster(d, f, { landOwnersAsOfDate }),
  },
};

const load = (select) => MediaOnboarding.find({}).select(select).maxTimeMS(25000).lean();

/** Which projection/aggregation serves a chart for a source; null when unsupported. */
const resolve = (chart, source) => {
  const key = SELECT[chart].both ? "both" : source;
  return SELECT[chart][key] ? { select: SELECT[chart][key], compute: COMPUTE[chart][key], sourceIndependent: key === "both" } : null;
};

/**
 * One chart's payload for already-parsed filters (shared by the single-chart endpoints and /overview, so the
 * calculation exists once). `db.load` is the only DB access; tests may replace it.
 */
const db = { load };
const buildSection = async (chart, f) => {
  const route = resolve(chart, f.source);
  if (!route) {
    return {
      filters: { source: f.source, siteStatus: f.siteStatus },
      supported: false,
      reason: UNSUPPORTED[chart]?.[f.source] || "Not available for this data source.",
      buckets: [],
      summary: {},
      meta: {},
    };
  }
  // site-status filter (active / inactive / all) narrows the sites before any chart is computed;
  // the media chart counts faces like the dashboard, so it applies the status per face itself
  const loaded = await db.load(route.select);
  const docs = chart === "media" ? loaded : RA.applySiteStatus(loaded, f);
  const data = route.compute(docs, f);
  return { ...data, supported: true, sourceIndependent: route.sourceIndependent };
};

const makeHandler = (chart, message) => async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = RA.parseFilters({ ...(req.query || {}), ...(req.body || {}) });
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    return successResponse(res, message, await buildSection(chart, parsed.filters));
  } catch (error) {
    return errorResponse(res, "Failed to build analytics", error.message, 500);
  }
};

const getFilterOptions = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const docs = await db.load(SELECT.filters);
    return successResponse(res, "Analytics filters fetched", RA.computeFilterOptions(docs));
  } catch (error) {
    return errorResponse(res, "Failed to load filter options", error.message, 500);
  }
};

// response key -> internal chart name
const OVERVIEW_SECTIONS = {
  filters: "filters",
  payments: "payments",
  media: "media",
  appraisal: "appraisal",
  upcomingBills: "bills",
  gst: "gst",
  tds: "tds",
  agreements: "agreements",
  tdsStatus: "tdsStatus",
  campaign: "campaign", // appended: the keys above keep their order
};
const OVERVIEW_CONCURRENCY = 3; // each section reads the collection once: bounded, not 9 at once

/**
 * POST /report-analytics/overview — every section above in one response, each exactly as its own endpoint
 * returns it. A section that fails is null with its message under data.errors (never zeros / empty data);
 * if every section fails the normal 500 is returned. Auth, role and filter validation are the same as the
 * single endpoints (403 / 400 for the whole request).
 */
const getOverview = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = RA.parseFilters({ ...(req.query || {}), ...(req.body || {}) });
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const f = parsed.filters;
    const keys = Object.keys(OVERVIEW_SECTIONS);
    // optional per-section data source (body.sections = { gst: { source: "ledger" } }): some charts pin their own
    // source (e.g. GST = Ledger) while the rest follow the selected one. Same parse and validation as a single call.
    const base = { ...(req.query || {}), ...(req.body || {}) };
    const own = {};
    for (const [key, o] of Object.entries(base.sections && typeof base.sections === "object" ? base.sections : {})) {
      if (!OVERVIEW_SECTIONS[key] || !o || o.source === undefined) continue;
      const p = RA.parseFilters({ ...base, source: o.source });
      if (p.error) return errorResponse(res, p.error, null, 400);
      own[key] = p.filters;
    }
    const data = {};
    const errors = {};
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++];
        try {
          const chart = OVERVIEW_SECTIONS[key];
          data[key] = chart === "filters" ? RA.computeFilterOptions(await db.load(SELECT.filters)) : await buildSection(chart, own[key] || f);
        } catch (error) {
          data[key] = null;
          errors[key] = error.message || "Failed to build analytics";
        }
      }
    };
    await Promise.all(Array.from({ length: OVERVIEW_CONCURRENCY }, worker));
    const failed = Object.keys(errors);
    if (failed.length === keys.length) return errorResponse(res, "Failed to build analytics", errors[failed[0]], 500);
    const ordered = Object.fromEntries(keys.map((k) => [k, data[k]]));
    return successResponse(res, "Report analytics overview fetched", failed.length ? { ...ordered, errors } : ordered);
  } catch (error) {
    return errorResponse(res, "Failed to build analytics", error.message, 500);
  }
};

module.exports = {
  ALLOWED_ROLES,
  SELECT, // field projection per chart and source — the data sources named on the charts
  allowedRole,
  getFilterOptions,
  getOverview,
  db, // DB access seam (tests only)
  resolve,
  getPaymentAnalytics: makeHandler("payments", "Payment analytics fetched"),
  getMediaAnalytics: makeHandler("media", "Media analytics fetched"),
  getAgreementAnalytics: makeHandler("agreements", "Agreement analytics fetched"),
  getAppraisalAnalytics: makeHandler("appraisal", "Appraisal analytics fetched"),
  getBillAnalytics: makeHandler("bills", "Upcoming bill analytics fetched"),
  getGstAnalytics: makeHandler("gst", "GST analytics fetched"),
  getTdsAnalytics: makeHandler("tds", "TDS analytics fetched"),
  getTdsStatusAnalytics: makeHandler("tdsStatus", "TDS status analytics fetched"),
  getCampaignAnalytics: makeHandler("campaign", "Campaign live status analytics fetched"),
};
