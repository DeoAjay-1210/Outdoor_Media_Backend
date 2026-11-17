/**
 * Gmail UTR integration — phase 1 (READ-ONLY).
 *
 * Nothing here reads or writes the RMS database. Endpoints:
 *   GET /api/gmail/oauth/url        (CMD only)  -> { authUrl } to open in the browser
 *   GET /api/gmail/oauth/callback   (Google redirect, validated by a signed `state`)
 *   GET /api/gmail/test-utr?billNumber=<Bill Number>  (CMD only) -> UTR for that Bill Number, no DB update.
 *   GET /api/gmail/pending-utr-bills                  (CMD only, read-only) -> approved+mailed bills still waiting for a UTR.
 *   POST /api/gmail/process-pending-utrs              (CMD only) -> dry run by default; saves only when enabled.
 *       The Bill Number is the only search input; Gmail is searched for the exact code.
 */
const jwt = require("jsonwebtoken");
const Gmail = require("../../../utils/gmailService");
const { lookupUtrByBillNumber, BILL_NUMBER_FORMAT } = require("../../../utils/gmailUtrLookup");
const { getPendingUtrBills } = require("../../../utils/pendingUtrBills");
const { getPendingArrearsUtrBills } = require("../../../utils/pendingArrearsUtrBills");
const { processPendingUtrs, saveEnabled } = require("../../../utils/utrProcessor");
const { successResponse, errorResponse } = require("../../../utils/response");

const CMD_ROLE = 3;
const isCmd = (req) => Number(req.user?.userType) === CMD_ROLE;
// Gmail connection (login / status / disconnect): Rental Executive (1), Rental Manager (2) and CMD (3) may use it
const canConnectGmail = (req) => [1, 2, CMD_ROLE].includes(Number(req.user?.userType));
const STATE_PURPOSE = "gmail-oauth";

const fail = (res, err, fallback) => errorResponse(res, fallback, err.message, err.status || 500);

// GET /api/gmail/oauth/url
const getAuthUrl = (req, res) => {
  if (!canConnectGmail(req)) return errorResponse(res, "Only Rental Executive, Rental Manager or CMD can connect Gmail", null, 403);
  try {
    // stateless CSRF protection: a short-lived signed token the callback must hand back
    const state = jwt.sign({ purpose: STATE_PURPOSE, userId: req.user.userId }, process.env.JWT_SECRET, { expiresIn: "10m" });
    return successResponse(res, "Open authUrl in your browser and sign in with the company Google account", {
      authUrl: Gmail.buildAuthUrl(state),
      scope: Gmail.SCOPES,
    });
  } catch (err) {
    return fail(res, err, "Could not create Gmail authorization URL");
  }
};

// GET /api/gmail/oauth/callback  — opened by Google, so no Bearer token; `state` proves it came from getAuthUrl
const oauthCallback = async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return errorResponse(res, "Google authorization was not granted", String(error), 400);
  let decodedUser = "";
  try {
    const decoded = jwt.verify(String(state || ""), process.env.JWT_SECRET);
    if (decoded.purpose !== STATE_PURPOSE) throw new Error("wrong state");
    decodedUser = String(decoded.userId || "");
  } catch (_) {
    return errorResponse(res, "Invalid or expired state. Start again from /api/gmail/oauth/url", null, 400);
  }
  if (!code) return errorResponse(res, "Authorization code missing", null, 400);

  try {
    const tokens = await Gmail.exchangeCode(String(code));
    if (!tokens.refresh_token) {
      return errorResponse(
        res,
        "Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and authorize again.",
        null,
        409
      );
    }
    // verify the token, then store it ENCRYPTED in MongoDB: every server on this database uses the connected account
    const connected = await Gmail.connectWithRefreshToken(tokens.refresh_token, decodedUser);
    return successResponse(res, "Gmail connected. The login token is saved in the database.", {
      account: connected.email,
      scope: Gmail.SCOPES,
      refreshTokenSaved: true,
    });
  } catch (err) {
    return fail(res, err, "Gmail authorization failed");
  }
};

// GET /api/gmail/status  (CMD only) -> which Gmail account is connected (never the token)
const connectionStatusApi = async (req, res) => {
  if (!canConnectGmail(req)) return errorResponse(res, "Only Rental Executive, Rental Manager or CMD can see the Gmail connection", null, 403);
  try {
    return successResponse(res, "Gmail connection", await Gmail.connectionStatus());
  } catch (err) {
    return fail(res, err, "Could not read the Gmail connection");
  }
};

// DELETE /api/gmail/disconnect  (CMD only) -> removes the stored login token
const disconnectApi = async (req, res) => {
  if (!canConnectGmail(req)) return errorResponse(res, "Only Rental Executive, Rental Manager or CMD can disconnect Gmail", null, 403);
  try {
    await Gmail.disconnect();
    return successResponse(res, "Gmail disconnected. The stored token was deleted.", { connected: false });
  } catch (err) {
    return fail(res, err, "Could not disconnect Gmail");
  }
};

// GET /api/gmail/test-utr?billNumber=adinnooh0511202601[&maxResults=10]
const testUtr = async (req, res) => {
  if (!isCmd(req)) return errorResponse(res, "Only CMD can use this test API", null, 403);
  const billNumber = String(req.query.billNumber || "").trim();
  if (!billNumber) return errorResponse(res, "billNumber is required, e.g. ?billNumber=adinn0511202601", null, 400);
  if (!BILL_NUMBER_FORMAT.test(billNumber) || !/\d/.test(billNumber)) {
    return errorResponse(res, "billNumber must be 6-40 letters/digits (may include - or /) and contain a digit", null, 400);
  }
  // subject / query / threadId searching was removed: the Bill Number is the only search input
  const removed = ["subject", "query", "threadId", "approvedThreadId"].filter((k) => req.query[k] !== undefined);
  if (removed.length) return errorResponse(res, `Unsupported parameter(s): ${removed.join(", ")}. Only billNumber is supported.`, null, 400);

  const maxResults = Math.min(Math.max(Number(req.query.maxResults) || 10, 1), 25);
  try {
    const r = await lookupUtrByBillNumber(billNumber, maxResults);
    return successResponse(res, r.message, r.data);
  } catch (err) {
    return fail(res, err, "Gmail UTR search failed");
  }
};

// GET /api/gmail/pending-utr-bills[?limit=500][&currentMonthOnly=true][&sinceDays=90]   (CMD only, READ-ONLY)
// Default: ALL months (late replies / old pending payments are never hidden). currentMonthOnly=true keeps this month only.
const pendingUtrBills = async (req, res) => {
  if (!isCmd(req)) return errorResponse(res, "Only CMD can use this API", null, 403);
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    const sinceDays = req.query.sinceDays !== undefined ? Number(req.query.sinceDays) : null;
    if (sinceDays !== null && (!Number.isFinite(sinceDays) || sinceDays < 1)) {
      return errorResponse(res, "sinceDays must be a positive number", null, 400);
    }
    const currentMonthOnly = String(req.query.currentMonthOnly || "").toLowerCase() === "true";
    const out = await getPendingUtrBills({ limit, sinceDays, currentMonthOnly });
    // New Bill / Advance Bill (media.arrearsDue[]) — a separate block, the Rental Bill list above is unchanged
    let ar = { bills: [], totalPending: 0 };
    let arrearsError;
    try {
      ar = await getPendingArrearsUtrBills({ limit, sinceDays, currentMonthOnly });
    } catch (e) {
      arrearsError = e.message;
    }
    out.newBillAdvance = {
      totalPending: ar.totalPending,
      returned: ar.bills.length,
      safeToAutoSave: ar.bills.filter((b) => b.eligible).length,
      needsManualReview: ar.bills.filter((b) => !b.eligible).length,
      ...(arrearsError ? { error: arrearsError } : {}),
      bills: ar.bills,
    };
    return successResponse(res, "Pending UTR bills (read-only, nothing was changed)", out);
  } catch (err) {
    return fail(res, err, "Could not read pending UTR bills");
  }
};

// POST /api/gmail/process-pending-utrs  { dryRun?: true, force?: false, maxBills?: 25, billNumbers?: [] }   (CMD only)
// dryRun defaults to TRUE. Saving needs BOTH dryRun:false in the body AND GMAIL_UTR_SAVE_ENABLED=true.
const processPendingUtrsApi = async (req, res) => {
  if (!isCmd(req)) return errorResponse(res, "Only CMD can use this API", null, 403);
  const body = req.body || {};
  const dryRun = body.dryRun !== false;
  if (!dryRun && !saveEnabled()) {
    return errorResponse(res, "Saving is disabled on this server (GMAIL_UTR_SAVE_ENABLED is not true). Use dryRun:true.", null, 409);
  }
  if (body.billNumbers !== undefined && !Array.isArray(body.billNumbers)) {
    return errorResponse(res, "billNumbers must be an array", null, 400);
  }
  try {
    const summary = await processPendingUtrs({
      dryRun,
      force: body.force === true,
      currentMonthOnly: body.currentMonthOnly === true,
      maxBills: body.maxBills,
      billNumbers: body.billNumbers,
      triggeredBy: "api",
    });
    return successResponse(res, dryRun ? "Dry run complete — nothing was saved" : "Processing complete", summary);
  } catch (err) {
    return fail(res, err, "UTR processing failed");
  }
};

/** GET /api/gmail/utr-corrections?billNumber=X — CMD only. READ-ONLY inspection: does a later Finance reply correct the UTR already stored for this Bill Number? */
const utrCorrectionsApi = async (req, res) => {
  if (!isCmd(req)) return errorResponse(res, "Only CMD can use this API", null, 403);
  const billNumber = String(req.query.billNumber || "").trim();
  if (!billNumber) return errorResponse(res, "billNumber is required", null, 400);
  try {
    const summary = await processPendingUtrs({ dryRun: true, billNumbers: [billNumber], triggeredBy: "api", maxBills: 1 });
    return successResponse(res, "Correction inspection complete — nothing was saved", { billNumber, corrections: summary.corrections || [] });
  } catch (err) {
    return fail(res, err, "UTR correction inspection failed");
  }
};

/** GET /api/gmail/utr-tracker/export?from=YYYY-MM-DD&to=YYYY-MM-DD — CMD only. READ-ONLY Excel: every bill CMD-approved in the range, per landlord and payment part, with the UTR (or "-"), status, error and the exact reply format. */
const utrTrackerExport = async (req, res) => {
  // read-only report: any logged-in user (CMD, Rental Executive, Rental Manager ...) may download it; the route still needs a valid token (protect)
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  // from / to are optional (no date = all dates); when given they must be YYYY-MM-DD
  if ((from && (!ymd.test(from) || Number.isNaN(Date.parse(from)))) || (to && (!ymd.test(to) || Number.isNaN(Date.parse(to))))) return errorResponse(res, "from and to must be YYYY-MM-DD", null, 400);
  if (from && to && from > to) return errorResponse(res, "from must not be after to", null, 400);
  try {
    const { buildUtrTracker, trackerWorkbook, byBillMonth } = require("../../../utils/utrTracker");
    // ✅ CHANGED — from / to select the BILL month (e.g. 2026-11-01..2026-11-30 → November 2026 bills only),
    // whatever day CMD approved them (was: bills CMD-approved between from and to, of any bill month)
    const data = byBillMonth(await buildUtrTracker({}), from || undefined, to || undefined);
    const buffer = trackerWorkbook(data);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${from || to ? `utr-tracker-${from || "start"}_to_${to || "latest"}` : "utr-tracker-all"}.xlsx"`);
    res.setHeader("X-Tracker-Summary", JSON.stringify(data.summary));
    return res.status(200).send(buffer);
  } catch (err) {
    return fail(res, err, "UTR tracker export failed");
  }
};

module.exports = { getAuthUrl, oauthCallback, connectionStatusApi, disconnectApi, testUtr, pendingUtrBills, processPendingUtrsApi, utrCorrectionsApi, utrTrackerExport };
