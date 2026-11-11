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
const { processPendingUtrs, saveEnabled } = require("../../../utils/utrProcessor");
const { successResponse, errorResponse } = require("../../../utils/response");

const CMD_ROLE = 3;
const isCmd = (req) => Number(req.user?.userType) === CMD_ROLE;
const STATE_PURPOSE = "gmail-oauth";

const fail = (res, err, fallback) => errorResponse(res, fallback, err.message, err.status || 500);

// GET /api/gmail/oauth/url
const getAuthUrl = (req, res) => {
  if (!isCmd(req)) return errorResponse(res, "Only CMD can authorize Gmail", null, 403);
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
  try {
    const decoded = jwt.verify(String(state || ""), process.env.JWT_SECRET);
    if (decoded.purpose !== STATE_PURPOSE) throw new Error("wrong state");
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
    Gmail.saveEnvValue("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
    // verify the new token really works, without exposing it
    const profile = await Gmail.getProfile();
    return successResponse(res, "Gmail authorized. Refresh token saved to the server environment.", {
      account: profile.emailAddress,
      scope: Gmail.SCOPES,
      refreshTokenSaved: true,
    });
  } catch (err) {
    return fail(res, err, "Gmail authorization failed");
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

module.exports = { getAuthUrl, oauthCallback, testUtr, pendingUtrBills, processPendingUtrsApi };
