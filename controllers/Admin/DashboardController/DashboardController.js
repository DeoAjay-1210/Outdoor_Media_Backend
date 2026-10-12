const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const OverDueHistory = require("../../../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema");
const { generateMissedEntriesForMedia } = require("../MediaOnboardingController/RentalDueNew2Controller");
const {
  calculateOverallLedgerSummary,
  isOwnerModePaidForCycle,
  getAllDueCycles,
  getRequiredModesShared,
} = require("../MediaOnboardingController/LedgerNew2Controller");
const { successResponse, errorResponse } = require("../../../utils/response");
const { computeRentalDueStats } = require("../../../utils/rentalDueStats");
const mongoose = require("mongoose");

const IST_OFFSET_MS = 330 * 60000; // 5h 30m
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

const FULL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Format Date to IST MM-YYYY
 */
const getCurrentMonthMMYYYY = () => {
  const d = nowIST();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const y = d.getUTCFullYear();
  return `${m}-${y}`;
};

/**
 * Main Admin Dashboard Controller
 * POST /admin/dashboard
 * GET /admin/dashboard
 */
const getAdminDashboard = async (req, res) => {
  try {
    const { month, selectedMonth: reqSelectedMonth, approvalRole, gst } = { ...(req.query || {}), ...(req.body || {}) };
    const roleFilter = [1, 2, 3].includes(Number(approvalRole)) ? Number(approvalRole) : null; // null = All
    const gstFilter = ["with", "without"].includes(gst) ? gst : "all";

    // 1. Resolve Selected Month parameter (supports "month" or "selectedMonth", format MM-YYYY e.g. "08-2026")
    let rawMonthParam = month || reqSelectedMonth;
    let selectedMonth = (rawMonthParam && typeof rawMonthParam === "string" && rawMonthParam.trim())
      ? rawMonthParam.trim()
      : getCurrentMonthMMYYYY();

    if (!selectedMonth.match(/^\d{2}-\d{4}$/)) {
      return errorResponse(res, "Invalid month format. Please use MM-YYYY (e.g. 08-2026)", null, 400);
    }

    const [mStr, yStr] = selectedMonth.split("-");
    const monthNum = parseInt(mStr, 10); // 1-12
    const yearNum = parseInt(yStr, 10);  // e.g. 2026

    if (monthNum < 1 || monthNum > 12 || isNaN(yearNum)) {
      return errorResponse(res, "Invalid month or year values in selectedMonth", null, 400);
    }

    const monthStart = new Date(Date.UTC(yearNum, monthNum - 1, 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));

    const today = nowIST();
    today.setUTCHours(0, 0, 0, 0);

    // ==========================================
    // 1. MEDIA DASHBOARD OBJECT
    // - totalSites, activeSites, inactiveSites & sitesByMediaType are mediaDetails (face) based
    // - agreement counts are document (site) level based
    // ==========================================
    // Fetch all MediaOnboarding docs
    const allMediaDocs = await MediaOnboarding.find({}).lean();

    let totalSitesCount = 0;
    let activeSitesCount = 0;
    let inactiveSitesCount = 0;

    let activeAgreementCount = 0;
    let expiredAgreementCount = 0;
    let expireSoonAgreementCount = 0;

    const sitesByMediaType = {};

    allMediaDocs.forEach((site) => {
      // 1. Evaluate agreement status at Document / Site level (old logic)
      const agreement = site.agreement || {};
      if (agreement.startDate && agreement.endDate) {
        const endDate = new Date(agreement.endDate);
        const reminderDays = Number(agreement.reminderBeforeExpiry || 30);
        const daysUntilExpiry = Math.ceil((endDate.getTime() - monthEnd.getTime()) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry < 0) {
          expiredAgreementCount++;
        } else if (daysUntilExpiry <= reminderDays) {
          expireSoonAgreementCount++;
        } else {
          activeAgreementCount++;
        }
      }

      // 2. Calculate site counts & media types at mediaDetails (face) level
      const details = site.mediaDetails || [];

      if (details.length > 0) {
        details.forEach((detail) => {
          totalSitesCount++;

          // Active vs Inactive face count (1 = Active)
          if (Number(detail.status) === 1) {
            activeSitesCount++;
          } else {
            inactiveSitesCount++;
          }

          // Sites by Media Type breakdown
          if (detail.mediaType && typeof detail.mediaType === "string" && detail.mediaType.trim()) {
            const t = detail.mediaType.trim();
            sitesByMediaType[t] = (sitesByMediaType[t] || 0) + 1;
          }
        });
      } else {
        totalSitesCount++;
        inactiveSitesCount++;
      }
    });

    const mediaObj = {
      totalSites: totalSitesCount,
      activeSites: activeSitesCount,
      inactiveSites: inactiveSitesCount,
      activeAgreement: activeAgreementCount,
      expiredAgreement: expiredAgreementCount,
      expireSoonAgreement: expireSoonAgreementCount,
      sitesByMediaType,
    };

    // ==========================================
    // 2. RENTAL DASHBOARD OBJECT (RentalDueNew2Controller logic)
    // ==========================================
    // Sweep active sites to generate missed billing cycle entries (same as RentalDueNew2Controller)
    const activeSitesForSweep = await MediaOnboarding.find({ "mediaDetails.status": 1 });
    for (const siteDoc of activeSitesForSweep) {
      const result = await generateMissedEntriesForMedia(siteDoc, "");
      const generatedCount = result?.generatedEntries?.length || 0;
      if (generatedCount > 0 || siteDoc.isModified()) {
        await siteDoc.save({ timestamps: false });
      }
    }

    // ✅ FIXED — shared Rental Due stats (same rule as admin/rental-due-list and
    // landowner/site-filter): ledger cycle amounts, appraisal-aware; overdue =
    // not approved after its due date (current + past months), 1 day after (IST).
    const allStatsDocs = await MediaOnboarding.find({ "mediaDetails.status": 1 }).lean();
    const siteHasGst = (m) => Number(m.gstApplicableFlag) > 0;
    const statsDocs = gstFilter === "all"
      ? allStatsDocs
      : allStatsDocs.filter((m) => (gstFilter === "with" ? siteHasGst(m) : !siteHasGst(m)));
    const stats = computeRentalDueStats(statsDocs, { year: yearNum, month: monthNum, targetRole: roleFilter });

    // Extra monthly figures from the stored rentalDue entries of the selected month
    // (GST amount, TDS from landowner tdsAmount, GST hold = existing withGst === 1 marker)
    const extra = { gstAmount: 0, tdsAmount: 0, gstHoldCount: 0, gstHoldAmount: 0 };
    for (const m of statsDocs) {
      const entries = (m.rentalDue || []).filter((e) => e.dueDate && new Date(e.dueDate) >= monthStart && new Date(e.dueDate) <= monthEnd);
      if (!entries.length) continue;
      const best = entries.sort((a, b) => Number(b.approvalStatus === 3) - Number(a.approvalStatus === 3))[0];
      extra.gstAmount += Number(best.gstAmount || 0);
      extra.tdsAmount += (m.landOwners || []).reduce((t, o) => t + (Number(o.tdsApplicable) ? Number(o.tdsAmount || 0) : 0), 0);
      if (Number(best.withGst) === 1) { extra.gstHoldCount += 1; extra.gstHoldAmount += Number(best.gstAmount || 0); }
    }

    const rentalObj = {
      gstThisMonth: { amount: Math.round(extra.gstAmount) },
      tdsThisMonth: { amount: Math.round(extra.tdsAmount) },
      gstHold: { amount: Math.round(extra.gstHoldAmount), sites: extra.gstHoldCount },
      totalDueThisMonth: {
        amount: Math.round(stats.dueThisMonthAmount),
        sites: stats.dueThisMonthCount,
      },
      overdue: {
        amount: Math.round(stats.overdueAmountTotal),
        sites: stats.overdueCount,
      },
      pendingThisMonth: {
        amount: Math.round(stats.pendingAmountTotal),
        sites: stats.pendingCount,
      },
      approvalThisMonth: {
        amount: Math.round(stats.approvedAmountTotal),
        sites: stats.approvedCount,
      },
    };

    // ==========================================
    // 3. LEDGER DASHBOARD OBJECT (LedgerNew2Controller logic)
    // ==========================================
    const activeMediaDocs = await MediaOnboarding.find({ "mediaDetails.status": 1 }).lean();
    const parsedMonthYearObj = { month: monthNum, year: yearNum };
    const ledgerSummary = calculateOverallLedgerSummary(activeMediaDocs, parsedMonthYearObj);

    const ledgerObj = {
      currentMonthBaseRent: {
        amount: Math.floor(
          ledgerSummary.overAllCurrentRentalAmount !== undefined && ledgerSummary.overAllCurrentRentalAmount > 0
            ? ledgerSummary.overAllCurrentRentalAmount
            : (ledgerSummary.currentMonthRentPaid || 0)
        ),
        sites:
          ledgerSummary.overAllCurrentRentalAmountSites !== undefined && ledgerSummary.overAllCurrentRentalAmountSites > 0
            ? ledgerSummary.overAllCurrentRentalAmountSites
            : (ledgerSummary.currentMonthRentPaidSites || 0),
      },
      currentMonthGst: {
        amount: Math.floor(
          ledgerSummary.overAllCurrentMonthGstAmount !== undefined && ledgerSummary.overAllCurrentMonthGstAmount > 0
            ? ledgerSummary.overAllCurrentMonthGstAmount
            : (ledgerSummary.currentMonthGstPaid || 0)
        ),
        sites:
          ledgerSummary.overAllCurrentMonthGstAmountSites !== undefined && ledgerSummary.overAllCurrentMonthGstAmountSites > 0
            ? ledgerSummary.overAllCurrentMonthGstAmountSites
            : (ledgerSummary.currentMonthGstPaidSites || 0),
      },
      pastRentPending: {
        amount: Math.floor(ledgerSummary.pastRentPending || 0),
        sites: ledgerSummary.pastRentPendingSites || 0,
      },
      pastGstPending: {
        amount: Math.floor(ledgerSummary.pastGstPending || 0),
        sites: ledgerSummary.pastGstPendingSites || 0,
      },
    };

    // ==========================================
    // 4. DISBURSEMENT SPLIT OBJECT (Cash vs Online Breakdown for selectedMonth)
    // ==========================================
    let cashTotalDue = 0;
    let cashPaid = 0;
    let cashPending = 0;

    let onlineTotalDue = 0;
    let onlinePaid = 0;
    let onlinePending = 0;

    const onlineByMode = {
      bankTransfer: 0,
      upi: 0,
      cheque: 0,
    };

    const targetKey = `${yearNum}-${monthNum - 1}`;

    for (const site of activeMediaDocs) {
      const cycles = getAllDueCycles(site, parsedMonthYearObj);

      cycles.forEach((cycleDate) => {
        const cycleKey = `${cycleDate.getUTCFullYear()}-${cycleDate.getUTCMonth()}`;
        if (cycleKey !== targetKey) return;

        const landowners = site.landOwners || [];
        landowners.forEach((owner) => {
          const paymentCategory = Number(owner.paymentCategory || 1);
          const requiredModes = getRequiredModesShared(paymentCategory);

          requiredModes.forEach((mode) => {
            let rentAmount = (mode === "Cash"
              ? Number(owner.cashAmount || owner.shareAmount || 0)
              : Number(owner.onlineAmount || owner.shareAmount || 0));

            if (rentAmount <= 0) return;

            const isPaid = isOwnerModePaidForCycle(site, owner, mode, cycleDate);

            if (mode === "Cash") {
              cashTotalDue += rentAmount;
              if (isPaid) {
                cashPaid += rentAmount;
              } else {
                cashPending += rentAmount;
              }
            } else if (mode === "Online") {
              onlineTotalDue += rentAmount;
              if (isPaid) {
                onlinePaid += rentAmount;
              } else {
                onlinePending += rentAmount;
              }

              const modeVal = Number(owner.onlineMode);
              if (modeVal === 2) {
                onlineByMode.upi += rentAmount;
              } else if (modeVal === 3) {
                onlineByMode.cheque += rentAmount;
              } else {
                onlineByMode.bankTransfer += rentAmount;
              }
            }
          });
        });
      });
    }

    const disbursementSplitObj = {
      cash: {
        totalDue: Math.round(cashTotalDue),
        paid: Math.round(cashPaid),
        pending: Math.round(cashPending),
      },
      online: {
        totalDue: Math.round(onlineTotalDue),
        paid: Math.round(onlinePaid),
        pending: Math.round(onlinePending),
        byMode: {
          bankTransfer: Math.round(onlineByMode.bankTransfer),
          // upi: Math.round(onlineByMode.upi),
          cheque: Math.round(onlineByMode.cheque),
        },
      },
    };

    // ==========================================
    // 5. LATEST UPDATED LANDOWNER SECTION (LandOwnerMaster relationship)
    // ==========================================
    const recentLandownersRaw = await LandOwnerMaster.find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(5)
      .lean();

    const recentLandownerIds = recentLandownersRaw.map((l) => l._id);

    const linkedMediaDocs = await MediaOnboarding.find({
      "landOwners.landOwnerMasterId": { $in: recentLandownerIds },
    }).lean();

    const landownersList = recentLandownersRaw.map((owner) => {
      const ownerIdStr = String(owner._id);
      const sitesArray = [];

      linkedMediaDocs.forEach((media) => {
        const isLinked = (media.landOwners || []).some(
          (lo) => String(lo.landOwnerMasterId) === ownerIdStr
        );

        if (isLinked) {
          const details = media.mediaDetails || [];
          if (details.length > 0) {
            details.forEach((detail) => {
              const name = detail.mediaName || detail.mediaCode || media.siteCode || String(media._id);
              const code = detail.mediaCode || media.siteCode || String(media._id);
              sitesArray.push({
                siteName: name,
                mediaCode: code,
                mediaName: name,
              });
            });
          } else {
            const siteCodeStr = media.siteCode || String(media._id);
            sitesArray.push({
              siteName: siteCodeStr,
              mediaCode: siteCodeStr,
              mediaName: siteCodeStr,
            });
          }
        }
      });

      return {
        landOwnerName: owner.name || "Unknown Landowner",
        lastUpdatedDate: owner.updatedAt || owner.createdAt || nowIST(),
        totalSites: sitesArray.length,
        sites: sitesArray,
      };
    });

    const latestUpdatesObj = {
      landowners: landownersList,
    };

    // ==========================================
    // FINAL RESPONSE
    // ==========================================
    return successResponse(res, "Admin dashboard data fetched successfully", {
      selectedMonth,
      media: mediaObj,
      rental: rentalObj,
      ledger: ledgerObj,
      disbursementSplit: disbursementSplitObj,
      latestUpdates: latestUpdatesObj,
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

// ─────────────────────────────────────────────────────────────
// Dashboard v2 (POST /admin/dashboard/v2 and sub-resources). The legacy
// getAdminDashboard above is unchanged for existing clients.
// ─────────────────────────────────────────────────────────────
const X = require("./DashboardExtras");

const DRAFT_AGREEMENTS_STATIC = { count: 0, amount: 0, isStatic: true }; // explicitly static for now

// roles 1/2/3 are the only valid userTypes; backend is the final authority
const allowedRole = (req) => [1, 2, 3].includes(Number(req.user?.userType));

const loadDocs = () => MediaOnboarding.find({}).lean();


const SHIFT = 330 * 60000; // LandOwnerMaster.createdAt is real UTC; site createdAt is already stored as IST wall-clock
const MODE_BY_CAT = { 1: "Cash", 2: "Online", 3: "Cash + Online" };
const modeOfOwners = (owners) => {
  const set = new Set();
  for (const o of owners || []) {
    const m = MODE_BY_CAT[Number(o.paymentCategory)] || "";
    m.split(" + ").filter(Boolean).forEach((x) => set.add(x));
  }
  return ["Cash", "Online"].filter((m) => set.has(m)).join(" + ");
};
const ownerInfo = (o) => ({
  name: o.name || "",
  splitType: Number(o.typeShare) === 2 ? "amount" : "percentage",
  splitValue: Number(o.typeShare) === 2 ? Number(o.shareAmount) || 0 : Number(o.sharePercentage) || 0,
  allocated: Math.round(Number(o.shareAmount) || 0),
  paymentMode: MODE_BY_CAT[Number(o.paymentCategory)] || "",
});
/** Remarks, landlord-added and site-added events (real history only). */
const loadExtraEvents = async (docs) => {
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const out = [];
  const siteInfo = (d) => ({
    siteName: (d.mediaDetails || []).map((f) => f.mediaName).filter(Boolean).join(", "),
    siteCode: (d.mediaDetails || []).map((f) => f.mediaCode).filter(Boolean).join(" / "),
    sites: (d.mediaDetails || []).map((f) => ({ mediaName: f.mediaName, mediaCode: f.mediaCode, mediaType: f.mediaType, city: f.city, state: f.state, location: f.location, width: f.width, height: f.height, totalSqFt: f.totalSqFt })),
    landlords: (d.landOwners || []).map(ownerInfo),
    landlordName: (d.landOwners || []).map((o) => o.name).filter(Boolean).join(", "),
    paymentMode: modeOfOwners(d.landOwners),
  });
  const rem = await OverDueHistory.find({}, "mediaId dueMonth remarks overDueRemarks").lean();
  for (const h of rem) {
    const d = byId.get(String(h.mediaId));
    if (!d) continue;
    for (const r of h.overDueRemarks || []) {
      if (!r.remarks || !r.addedAt) continue;
      out.push({ mediaId: String(d._id), ...siteInfo(d), activityType: "remarks", action: "Remarks Added", status: "Added", actorName: r.addedBy || "", actorRole: "", occurredAt: r.addedAt, dueMonth: h.dueMonth || null,
        ctx: { label: "Remarks", value: String(r.remarks) }, sentence: `${r.addedBy || "User"} added remarks.` });
    }
  }
  for (const d of docs) {
    if (d.createdAt) out.push({ mediaId: String(d._id), ...siteInfo(d), activityType: "site", action: "Site Added", status: "Added", actorName: d.createdBy || "", actorRole: "", occurredAt: d.createdAt,
      ctx: { label: "Sites", value: `${(d.mediaDetails || []).length} site(s)` }, sentence: `${d.createdBy || "User"} added the site${(d.mediaDetails || []).length > 1 ? "s" : ""}.` });
  }
  const lords = await LandOwnerMaster.find({}).sort({ createdAt: -1 }).limit(20).lean();
  for (const l of lords) {
    if (!l.createdAt) continue;
    const linked = docs.filter((d) => (d.landOwners || []).some((o) => String(o.landOwnerMasterId) === String(l._id)));
    out.push({
      mediaId: `landlord-${l._id}`, activityType: "landlord", action: "Landlord Added", status: "Added", actorName: l.createdBy || "", actorRole: "",
      siteName: linked.map((d) => (d.mediaDetails || []).map((f) => f.mediaName).filter(Boolean).join(", ")).join(", "),
      siteCode: "",
      sites: linked.flatMap((d) => (d.mediaDetails || []).map((f) => ({ mediaName: f.mediaName, mediaCode: f.mediaCode, mediaType: f.mediaType, city: f.city, state: f.state, location: f.location }))),
      landlords: [l.typeShare || Number(l.sharePercentage) > 0 || Number(l.shareAmount) > 0 ? ownerInfo(l) : { name: l.name || "" }], // split lives on the site; none yet → name only
      landlordName: l.name || "", paymentMode: MODE_BY_CAT[Number(l.paymentCategory)] || "",
      occurredAt: new Date(new Date(l.createdAt).getTime() + SHIFT),
      ctx: { label: "Landlord", value: l.name || "" }, sentence: `Landlord ${l.name || ""} was added.`,
    });
  }
  return out;
};


const UserModel = require("../../../models/Admin/UserSchema/UserSchema");
/** Recent activity feed: real events + actor roles resolved from the users collection (names are unique usernames). */
const activityFeed = async (docs, { limit = 10, loginRole = null } = {}) => {
  const [extra, users] = await Promise.all([loadExtraEvents(docs), UserModel.find({}, "userName userType").lean()]);
  const roleByName = new Map(users.map((u) => [String(u.userName).trim().toLowerCase(), X.ROLE_LABEL[Number(u.userType)] || ""]));
  let list = X.computeActivity(docs, 150, extra).map((e) => ({
    ...e,
    actorRole: e.actorRole || roleByName.get(String(e.actorName || "").trim().toLowerCase()) || "",
  }));
  if (loginRole) list = list.filter((e) => e.actorRole === X.ROLE_LABEL[loginRole]);
  return list.slice(0, Math.min(Math.max(Number(limit) || 10, 1), 100));
};

const getDashboardV2 = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = X.parseFilters({ ...(req.query || {}), ...(req.body || {}) });
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const { range, filters } = parsed;

    const all = await loadDocs();
    const active = all.filter((d) => (d.mediaDetails || []).some((f) => Number(f.status) === 1));

    // media (same meaning of active/inactive & agreement thresholds as the legacy dashboard)
    const gAll = X.applyGst(all, filters.gst);
    const media = { totalSites: 0, activeSites: 0, inactiveSites: 0, activeAgreements: 0, expiringAgreements: 0, expiredAgreements: 0, sitesByMediaType: {} };
    let draftSites = 0;
    for (const site of gAll) {
      const ag = site.agreement || {};
      if (Number(ag.agreementStatus) === 2) draftSites += Math.max((site.mediaDetails || []).length, 1); // 1=Original 2=Draft; counted in sites
      if (ag.startDate && ag.endDate) {
        const days = Math.ceil((new Date(ag.endDate).getTime() - range.end.getTime()) / 86400000);
        if (days < 0) media.expiredAgreements++;
        else if (days <= Number(ag.reminderBeforeExpiry || 30)) media.expiringAgreements++;
        else media.activeAgreements++;
      }
      const details = site.mediaDetails || [];
      if (!details.length) { media.totalSites++; media.inactiveSites++; continue; }
      for (const f of details) {
        media.totalSites++;
        Number(f.status) === 1 ? media.activeSites++ : media.inactiveSites++;
        const t = typeof f.mediaType === "string" && f.mediaType.trim() ? f.mediaType.trim() : "Unspecified";
        media.sitesByMediaType[t] = (media.sitesByMediaType[t] || 0) + 1;
      }
    }

    const rental = X.computeRental(active, range, filters);
    // Past pending = outstanding before the selected period (existing ledger definition, evaluated at the period start)
    const past = calculateOverallLedgerSummary(X.applyGst(active, filters.gst), { month: range.first.month, year: range.first.year });
    rental.cards.pastRent = { sites: past.pastRentPendingSites || 0, amount: Math.floor(past.pastRentPending || 0) };
    rental.cards.pastGst = { sites: past.pastGstPendingSites || 0, amount: Math.floor(past.pastGstPending || 0) };

    const ledgerEntries = X.computeLedgerEntries(active, range, filters.gst);
    rental.cards.pastRent.landlords = ledgerEntries.pastRentPending.count;
    rental.cards.pastGst.landlords = ledgerEntries.pastGstPending.count;
    return successResponse(res, "Dashboard fetched", {
      period: { months: range.months, start: range.start, end: range.end },
      filters,
      media: { ...media, draftAgreements: { count: draftSites, amount: 0 } },
      rental: rental.cards,
      donut: rental.donut,
      disbursement: X.computeDisbursement(active, range, filters.gst),
      ledgerEntries,
      activity: await activityFeed(all, { limit: 10, loginRole: filters.loginRole }),
    });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

const getRentalDetailsV2 = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = X.parseFilters(req.body || {});
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const docs = await MediaOnboarding.find({ "mediaDetails.status": 1 }).lean();
    // remarks are stored per rental due in OverDueHistory (same source as Rental Master) — one batched query
    const remarksByDue = new Map();
    const hist = await OverDueHistory.find({ mediaId: { $in: docs.map((d) => d._id) } }, "rentalDueId remarks overDueRemarks").lean();
    for (const h of hist) {
      const items = [{ text: h.remarks }, ...(h.overDueRemarks || []).map((r) => ({ text: r.remarks, by: r.addedBy, at: r.addedAt }))].filter((t) => t.text && String(t.text).trim());
      if (h.rentalDueId && items.length) remarksByDue.set(String(h.rentalDueId), items[items.length - 1]);
    }
    const rows = X.buildRentalRows(docs, parsed.range, parsed.filters, remarksByDue);
    const { search, sortBy, sortDir, page, limit } = req.body || {};
    const out = X.searchSortPage(rows, { search, sortBy, sortDir, page, limit });
    return successResponse(res, "Rental details fetched", out);
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

const getLedgerMismatchV2 = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = X.parseFilters(req.body || {});
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const docs = await MediaOnboarding.find({ "mediaDetails.status": 1 }).lean();
    const m = X.computeLedgerMismatch(docs, parsed.range, parsed.filters.gst);
    const type = ["missing", "short", "excess"].includes(req.body?.type) ? req.body.type : null;
    const rows = type ? m.rows.filter((r) => r.type === type) : m.rows;
    return successResponse(res, "Ledger mismatch fetched", { summary: m.summary, rows, mediaIds: [...new Set(rows.map((r) => r.mediaId))] });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

const getActivityV2 = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const docs = await loadDocs();
    return successResponse(res, "Activity fetched", await activityFeed(docs, { limit: req.body?.limit || 50 }));
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

/** Site ids behind one donut bucket, so the destination screen lists exactly what the dashboard counted. */
const getDrillV2 = async (req, res) => {
  try {
    if (!allowedRole(req)) return errorResponse(res, "Forbidden", null, 403);
    const parsed = X.parseFilters(req.body || {});
    if (parsed.error) return errorResponse(res, parsed.error, null, 400);
    const role = Number(req.body?.role), kind = req.body?.kind;
    if (![1, 2, 3].includes(role) || !["pending", "approved"].includes(kind)) return errorResponse(res, "role (1-3) and kind (pending|approved) are required", null, 400);
    const active = await MediaOnboarding.find({ "mediaDetails.status": 1 }).lean();
    const r = X.computeRental(active, parsed.range, parsed.filters);
    return successResponse(res, "Drilldown fetched", { mediaIds: r.drill[role][kind] });
  } catch (error) {
    return errorResponse(res, error.message, null, 500);
  }
};

module.exports = {
  getAdminDashboard,
  getDrillV2,
  getDashboardV2,
  getRentalDetailsV2,
  getLedgerMismatchV2,
  getActivityV2,
};
