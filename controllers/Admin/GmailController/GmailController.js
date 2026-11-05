/**
 * Gmail UTR integration — phase 1 (READ-ONLY).
 *
 * Nothing here reads or writes the RMS database. Endpoints:
 *   GET /api/gmail/oauth/url        (CMD only)  -> { authUrl } to open in the browser
 *   GET /api/gmail/oauth/callback   (Google redirect, validated by a signed `state`)
 *   GET /api/gmail/test-utr         (CMD only)  -> thread + extracted UTR, no DB update
 *       ?subject=<CMD Approved subject>  Bill Number flow (approved mail -> Bill Number -> payment thread -> UTR)
 *       ?billNumber=<Bill Number>        direct Bill Number search (no subject lookup); cannot be combined with the others
 *       ?query= / ?threadId=             plain thread read + UTR extraction
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
const brief = (m) => ({ id: m.id, from: m.from, date: m.date, subject: m.subject, bodySource: m.bodySource });

const BILL_NUMBER_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-\/]{5,39}$/;
const regexEscape = (v) => String(v).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
// exact match: not part of a longer code (adinn0511202601 must not match adinn051120260123)
const BILL_CHAR = "[A-Za-z0-9\\-/]";
const containsExactBill = (text, billNumber) =>
  new RegExp(`(?<!${BILL_CHAR})${regexEscape(billNumber)}(?!${BILL_CHAR})`, "i").test(text || "");

// Shared by both modes. Finds the conversations that really contain this exact Bill Number and extracts the UTR.
// Never picks between several candidates. `approved` (optional) is the already-read CMD Approved thread.
const resolveBill = async (res, billNumber, maxResults, ctx, approved) => {
  const hits = await Gmail.searchThreads(`"${escapeQuotes(billNumber)}"`, maxResults);
  const ids = [...new Set([...(approved ? [approved.id] : []), ...hits.map((t) => t.id)])];
  const threads = [];
  for (const id of ids) {
    const th = approved && id === approved.id ? approved : await Gmail.getThread(id);
    // verified: the exact Bill Number appears in a message body (quoted text counts, a reply quotes the approval)
    const verified = th.messages.some((m) => containsExactBill(m.bodyText, billNumber));
    if (!verified) continue;
    const otherBills = [...new Set(th.messages.flatMap((m) => extractBillNumbers(m.bodyText)))].filter((b) => b.toLowerCase() !== billNumber.toLowerCase());
    const r = extractUtrFromThread(th.messages);
    threads.push({ threadId: th.id, subject: subjectOf(th), messageCount: th.messages.length, isApprovedThread: !!approved && th.id === approved.id, otherBillNumbers: otherBills, extractionStatus: r.status, utr: r.utr, utrSource: r.source, candidates: r.candidates });
  }
  const matchedThreads = threads.map(({ candidates, ...t }) => t);
  const common = { ...ctx, billNumber, matchedThreads };

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

// ?subject=Test CMD Approved[&approvedThreadId=...][&maxResults=10]
// 1 find the CMD Approved mail  2 read its Bill Number  3 find conversations containing that exact Bill Number
// 4 extract the labelled UTR. Read-only; never picks between several candidates.
const testUtrByBill = async (req, res, subject, maxResults) => {
  const approvedThreadId = String(req.query.approvedThreadId || "").trim();
  const base = { subject };

  // step 1: CMD Approved mail
  let approvedId = approvedThreadId;
  if (!approvedId) {
    const found = await Gmail.searchThreads(`subject:"${escapeQuotes(subject)}"`, maxResults);
    if (!found.length) return successResponse(res, "No CMD Approved mail matched the subject", { ...base, extractionStatus: "approved_mail_not_found" });
    if (found.length > 1) {
      const matches = await Promise.all(
        found.map(async (t) => {
          const th = await Gmail.getThread(t.id);
          return { threadId: th.id, subject: subjectOf(th), messageCount: th.messages.length, date: th.messages[0]?.date, billNumbers: extractBillNumbers(th.messages[0]?.bodyText) };
        })
      );
      return successResponse(res, "More than one CMD Approved mail matched. Re-run with &approvedThreadId=<one of these>", { ...base, extractionStatus: "multiple_approved_mails", matches });
    }
    approvedId = found[0].id;
  }
  const approved = await Gmail.getThread(approvedId);

  // step 2: Bill Number (from the approval mail itself)
  const billNumbers = [...new Set(approved.messages.flatMap((m) => extractBillNumbers(m.bodyText)))];
  const approvedInfo = { threadId: approved.id, subject: subjectOf(approved), messageCount: approved.messages.length, messages: approved.messages.map(brief) };
  if (!billNumbers.length) return successResponse(res, "No Bill Number found in the CMD Approved mail", { ...base, approvedMail: approvedInfo, extractionStatus: "bill_number_not_found" });
  if (billNumbers.length > 1) return successResponse(res, "More than one Bill Number in the CMD Approved mail; nothing chosen", { ...base, approvedMail: approvedInfo, billNumbers, extractionStatus: "multiple_bill_numbers" });
  const billNumber = billNumbers[0];

  return resolveBill(res, billNumber, maxResults, { ...base, approvedMail: approvedInfo }, approved);
};

// ?billNumber=adinn0511202601[&maxResults=10]  — no subject / CMD Approved lookup at all
const testUtrByBillNumber = (res, billNumber, maxResults) => resolveBill(res, billNumber, maxResults, {}, null);

// GET /api/gmail/test-utr?query=subject:"Get UTR Number"[&threadId=...][&maxResults=10]
const testUtr = async (req, res) => {
  if (!isCmd(req)) return errorResponse(res, "Only CMD can use this test API", null, 403);
  const query = String(req.query.query || "").trim();
  const pickedThreadId = String(req.query.threadId || "").trim();
  const directBill = String(req.query.billNumber || "").trim();
  const maxResults = Math.min(Math.max(Number(req.query.maxResults) || 10, 1), 25);

  if (directBill) {
    // validation rule: billNumber is its own search mode; combining it with another mode is rejected, never silently resolved
    if (req.query.subject || query || pickedThreadId || req.query.approvedThreadId) {
      return errorResponse(res, "billNumber cannot be combined with subject, query, threadId or approvedThreadId. Use one search mode per request.", null, 400);
    }
    if (!BILL_NUMBER_FORMAT.test(directBill) || !/\d/.test(directBill)) {
      return errorResponse(res, "billNumber must be 6-40 letters/digits (may include - or /) and contain a digit", null, 400);
    }
    try {
      return await testUtrByBillNumber(res, directBill, maxResults);
    } catch (err) {
      return fail(res, err, "Gmail test failed");
    }
  }

  const subject = String(req.query.subject || process.env.GMAIL_CMD_APPROVED_SUBJECT || "").trim();
  if (!query && !pickedThreadId && !subject) {
    return errorResponse(res, "Provide ?subject=<CMD Approved subject> (Bill Number flow), ?billNumber=<Bill Number> (direct search) or ?query=... (plain thread read)", null, 400);
  }

  try {
    if (!query && !pickedThreadId) return await testUtrByBill(req, res, subject, maxResults);
    let threadId = pickedThreadId;
    if (!threadId) {
      const found = await Gmail.searchThreads(query, maxResults);
      if (!found.length) {
        return successResponse(res, "No conversation matched the query", { extractionStatus: "no_thread_found", query });
      }
      if (found.length > 1) {
        // never pick one automatically
        const matches = await Promise.all(found.map((t) => Gmail.getThreadSummary(t.id)));
        return successResponse(res, "More than one conversation matched. Re-run with &threadId=<one of these>", {
          extractionStatus: "multiple_threads",
          query,
          matches,
        });
      }
      threadId = found[0].id;
    }

    const thread = await Gmail.getThread(threadId);
    const result = extractUtrFromThread(thread.messages);
    return successResponse(res, "Thread read (read-only, no database update)", {
      threadId: thread.id,
      subject: thread.subject,
      messageCount: thread.messages.length,
      messages: thread.messages.map((m) => ({
        id: m.id,
        from: m.from,
        date: m.date,
        subject: m.subject,
        bodySource: m.bodySource,
        bodyPreview: m.bodyText.slice(0, 300),
      })),
      extractionStatus: result.status,
      utr: result.utr,
      utrSource: result.source,
      candidates: result.candidates,
    });
  } catch (err) {
    return fail(res, err, "Gmail test failed");
  }
};

module.exports = { getAuthUrl, oauthCallback, testUtr };
