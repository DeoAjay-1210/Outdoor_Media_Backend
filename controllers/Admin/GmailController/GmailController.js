/**
 * Gmail UTR integration — phase 1 (READ-ONLY).
 *
 * Nothing here reads or writes the RMS database. Endpoints:
 *   GET /api/gmail/oauth/url        (CMD only)  -> { authUrl } to open in the browser
 *   GET /api/gmail/oauth/callback   (Google redirect, validated by a signed `state`)
 *   GET /api/gmail/test-utr?billNumber=<Bill Number>  (CMD only) -> UTR for that Bill Number, no DB update.
 *       The Bill Number is the only search input; Gmail is searched for the exact code.
 */
const jwt = require("jsonwebtoken");
const Gmail = require("../../../utils/gmailService");
const { extractUtrFromThread, extractBillNumbers } = require("../../../utils/utrExtractor");
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


const escapeQuotes = (v) => String(v).replace(/"/g, "");
const subjectOf = (thread) => thread.subject || "";

const BILL_NUMBER_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-\/]{5,39}$/;
const regexEscape = (v) => String(v).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
// exact match: not part of a longer code (adinn0511202601 must not match adinn051120260123)
const BILL_CHAR = "[A-Za-z0-9\\-/]";
const containsExactBill = (text, billNumber) =>
  new RegExp(`(?<!${BILL_CHAR})${regexEscape(billNumber)}(?!${BILL_CHAR})`, "i").test(text || "");

// Bill Number -> Gmail. The Bill Number is the ONLY search input: Gmail is searched for the exact code, every hit is
// read in full, and a conversation counts only if the exact Bill Number appears in one of its message bodies.
// Never picks between several candidates; nothing is written anywhere.
const findUtrByBillNumber = async (res, billNumber, maxResults) => {
  const hits = await Gmail.searchThreads(`"${escapeQuotes(billNumber)}"`, maxResults);
  const threads = [];
  for (const id of [...new Set(hits.map((t) => t.id))]) {
    const th = await Gmail.getThread(id);
    // verified: quoted text counts, because a reply quotes the original mail
    if (!th.messages.some((m) => containsExactBill(m.bodyText, billNumber))) continue;
    const otherBills = [...new Set(th.messages.flatMap((m) => extractBillNumbers(m.bodyText)))].filter((b) => b.toLowerCase() !== billNumber.toLowerCase());
    const r = extractUtrFromThread(th.messages);
    threads.push({ threadId: th.id, subject: subjectOf(th), messageCount: th.messages.length, otherBillNumbers: otherBills, extractionStatus: r.status, utr: r.utr, utrSource: r.source, candidates: r.candidates });
  }
  const matchedThreads = threads.map(({ candidates, ...t }) => t);
  const common = { billNumber, matchedThreads };

  if (!threads.length) return successResponse(res, "No Gmail conversation contains this exact Bill Number", { ...common, utr: null, extractionStatus: "bill_not_found" });

  const withUtr = threads.filter((t) => t.candidates.length);
  const allCandidates = withUtr.flatMap((t) => t.candidates.map((c) => ({ ...c, threadId: t.threadId })));
  const distinct = [...new Set(allCandidates.map((c) => c.utr))];

  if (!distinct.length) return successResponse(res, "Bill Number found, but no UTR in any matching conversation", { ...common, utr: null, extractionStatus: "utr_not_found" });
  if (distinct.length > 1 || withUtr.length > 1) {
    return successResponse(res, "More than one UTR / conversation matched; manual review required", { ...common, utr: null, candidates: allCandidates, extractionStatus: "multiple_review_required" });
  }
  // the one UTR sits in a conversation that also talks about another Bill Number: it may belong to that one
  if (withUtr[0].otherBillNumbers.length) {
    return successResponse(res, "The matching conversation mentions other Bill Numbers too; manual review required", { ...common, utr: null, candidates: allCandidates, extractionStatus: "ambiguous_bill_numbers" });
  }
  const src = allCandidates[0];
  return successResponse(res, "UTR extracted for this Bill Number (read-only, no database update)", {
    ...common,
    utr: src.utr,
    gmailThreadId: src.threadId,
    sourceMessageId: src.messageId,
    senderEmail: src.from,
    messageDate: src.date,
    extractionStatus: "found",
  });
};

// GET /api/gmail/test-utr?billNumber=adinn0511202601[&maxResults=10]
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
    return await findUtrByBillNumber(res, billNumber, maxResults);
  } catch (err) {
    return fail(res, err, "Gmail UTR search failed");
  }
};

module.exports = { getAuthUrl, oauthCallback, testUtr };
