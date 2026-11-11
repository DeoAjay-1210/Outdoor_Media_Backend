/**
 * Bill Number -> Gmail -> UTR lookup (READ-ONLY). Shared by GET /api/gmail/test-utr and the
 * automatic UTR processor, so there is exactly one implementation.
 *
 * The Bill Number is the ONLY search input: Gmail is searched for the exact code, every hit is read
 * in full, and a conversation counts only if the exact Bill Number appears in one of its message
 * bodies. It never picks between several candidates and writes nothing.
 */
const Gmail = require("./gmailService");
const { extractUtrFromThread, extractBillNumbers, findCandidates, stripQuoted } = require("./utrExtractor");
const { extractExplicitPaymentDates, istDay } = require("./utrPaidDate");
const { scopeThreadToBill } = require("./gmailReplyLink");
const { extractLandlordUtrLines, parseApprovalMailLandlords } = require("./landlordUtrParser");

const BILL_NUMBER_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-\/]{5,39}$/;

const escapeQuotes = (v) => String(v).replace(/"/g, "");
const regexEscape = (v) => String(v).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
// exact match: not part of a longer code (adinn0511202601 must not match adinn051120260123)
const BILL_CHAR = "[A-Za-z0-9\\-/]";
const containsExactBill = (text, billNumber) =>
  new RegExp(`(?<!${BILL_CHAR})${regexEscape(billNumber)}(?!${BILL_CHAR})`, "i").test(text || "");

/**
 * Landlord version (bills with several landlords): the same exact-Bill-Number thread search, then the reply lines
 * "<name> - UTR: <value> [- Paid Date: <date>]" of every reply and the landlord blocks of the original approval mail.
 * Returns { message, data } where data.extractionStatus is bill_not_found | multiple_review_required |
 * ambiguous_bill_numbers | utr_not_found | found. Read-only.
 */
const lookupLandlordUtrs = async (billNumber, maxResults = 10) => {
  const hits = await Gmail.searchThreads(`"${escapeQuotes(billNumber)}"`, maxResults);
  const found = [];
  let unlinked = null;
  for (const id of [...new Set(hits.map((t) => t.id))]) {
    const th = await Gmail.getThread(id);
    th.messages = th.messages.filter(Gmail.isUsableMessage); // never a draft / trashed / spam message
    if (!th.messages.some((m) => containsExactBill(m.bodyText, billNumber))) continue;
    const otherBillNumbers = [...new Set(th.messages.flatMap((m) => extractBillNumbers(m.bodyText)))].filter((b) => b.toLowerCase() !== billNumber.toLowerCase());
    let nearBills = otherBillNumbers;
    let replyLink = null;
    if (otherBillNumbers.length) {
      // several approval mails in one thread: the reply is tied to its bill by In-Reply-To, never by order
      const s = scopeThreadToBill(th.messages, billNumber);
      if (s.status === "scoped") {
        th.messages = s.messages;
        replyLink = s.link;
        nearBills = [...new Set(th.messages.flatMap((m) => extractBillNumbers(m.bodyText)))].filter((b) => b.toLowerCase() !== billNumber.toLowerCase());
      } else if (s.reason === "reply_not_linked_to_approval_mail") {
        unlinked = { threadId: th.id, reason: s.reason, replyMessageIds: s.replyMessageIds };
        continue;
      } // else: not an approval-mail layout (one message printing other Bill Numbers): stays ambiguous_bill_numbers as before
    }
    found.push({ th, otherBillNumbers: nearBills, replyLink });
  }
  const common = { billNumber, matchedThreads: found.map((f) => ({ threadId: f.th.id, messageCount: f.th.messages.length, otherBillNumbers: f.otherBillNumbers })) };
  if (unlinked) return { message: "A reply in the conversation cannot be tied to one approval mail; manual review required", data: { ...common, extractionStatus: "reply_not_linked", linkReason: unlinked.reason, replyMessageIds: unlinked.replyMessageIds } };
  if (!found.length) return { message: "No Gmail conversation contains this exact Bill Number", data: { ...common, extractionStatus: "bill_not_found" } };
  if (found.length > 1) return { message: "More than one conversation matched; manual review required", data: { ...common, extractionStatus: "multiple_review_required" } };
  const { th, otherBillNumbers, replyLink } = found[0];
  if (otherBillNumbers.length) return { message: "The conversation mentions other Bill Numbers too; manual review required", data: { ...common, extractionStatus: "ambiguous_bill_numbers" } };

  // the original approval mail = the message that carries the bill's own landlord blocks
  const approval = th.messages.find((m) => /Owner Name/i.test(stripQuoted(m.bodyText)) && containsExactBill(stripQuoted(m.bodyText), billNumber));
  const replies = th.messages
    .filter((m) => m !== approval)
    .map((m) => ({ messageId: m.id, from: m.from, sentAt: m.sentAt || m.date, sentDate: istDay(m.sentAt || m.date), lines: extractLandlordUtrLines(m.bodyText) }))
    .filter((r) => r.lines.length > 0);
  return {
    message: replies.length ? "Landlord UTR lines found (read-only, no database update)" : "Bill Number found, but no landlord UTR line in any reply",
    data: { ...common, threadId: th.id, extractionStatus: replies.length ? "found" : "utr_not_found", ...(replyLink ? { replyLink } : {}), approvalMailLandlords: approval ? parseApprovalMailLandlords(approval.bodyText) : [], replies },
  };
};

/** Returns { message, data } where data.extractionStatus is one of
 *  bill_not_found | utr_not_found | multiple_review_required | ambiguous_bill_numbers | found. */
const lookupUtrByBillNumber = async (billNumber, maxResults = 10) => {
  const hits = await Gmail.searchThreads(`"${escapeQuotes(billNumber)}"`, maxResults);
  const threads = [];
  let unlinked = null;
  for (const id of [...new Set(hits.map((t) => t.id))]) {
    const th = await Gmail.getThread(id);
    th.messages = th.messages.filter(Gmail.isUsableMessage); // never a draft / trashed / spam message
    // verified: quoted text counts, because a reply quotes the original mail
    if (!th.messages.some((m) => containsExactBill(m.bodyText, billNumber))) continue;
    let otherBills = [...new Set(th.messages.flatMap((m) => extractBillNumbers(m.bodyText)))].filter(
      (b) => b.toLowerCase() !== billNumber.toLowerCase()
    );
    let replyLink = null;
    if (otherBills.length) {
      // several approval mails in one thread: the reply is tied to its bill by In-Reply-To, never by order
      const s = scopeThreadToBill(th.messages, billNumber);
      if (s.status === "scoped") {
        th.messages = s.messages;
        replyLink = s.link;
        otherBills = [...new Set(th.messages.flatMap((m) => extractBillNumbers(m.bodyText)))].filter((b) => b.toLowerCase() !== billNumber.toLowerCase());
      } else if (s.reason === "reply_not_linked_to_approval_mail") {
        unlinked = { threadId: th.id, reason: s.reason, replyMessageIds: s.replyMessageIds };
        continue;
      } // else: not an approval-mail layout (one message printing other Bill Numbers): stays ambiguous_bill_numbers as before
    }
    const r = extractUtrFromThread(th.messages);
    threads.push({
      threadId: th.id,
      subject: th.subject || "",
      messageCount: th.messages.length,
      otherBillNumbers: otherBills,
      extractionStatus: r.status,
      utr: r.utr,
      utrSource: r.source,
      replyLink,
      candidates: r.candidates,
      _messages: th.messages, // only used below to find the payment date; never returned
    });
  }
  const matchedThreads = threads.map(({ candidates, _messages, replyLink, ...t }) => t);
  const common = { billNumber, matchedThreads };

  if (unlinked) {
    return { message: "A reply in the conversation cannot be tied to one approval mail; manual review required", data: { ...common, utr: null, extractionStatus: "reply_not_linked", linkReason: unlinked.reason, replyMessageIds: unlinked.replyMessageIds } };
  }

  if (!threads.length) {
    return { message: "No Gmail conversation contains this exact Bill Number", data: { ...common, utr: null, extractionStatus: "bill_not_found" } };
  }

  const withUtr = threads.filter((t) => t.candidates.length);
  const allCandidates = withUtr.flatMap((t) => t.candidates.map((c) => ({ ...c, threadId: t.threadId })));
  const distinct = [...new Set(allCandidates.map((c) => c.utr))];

  if (!distinct.length) {
    return { message: "Bill Number found, but no UTR in any matching conversation", data: { ...common, utr: null, extractionStatus: "utr_not_found" } };
  }
  if (distinct.length > 1 || withUtr.length > 1) {
    return {
      message: "More than one UTR / conversation matched; manual review required",
      data: { ...common, utr: null, candidates: allCandidates, extractionStatus: "multiple_review_required" },
    };
  }
  // the one UTR sits in a conversation that also talks about another Bill Number: it may belong to that one
  if (withUtr[0].otherBillNumbers.length) {
    return {
      message: "The matching conversation mentions other Bill Numbers too; manual review required",
      data: { ...common, utr: null, candidates: allCandidates, extractionStatus: "ambiguous_bill_numbers" },
    };
  }
  const src = allCandidates[0];

  // Paid Date evidence: ONLY the reply message(s) that state this UTR (never the approval mail or an unrelated reply).
  // explicit labelled payment dates from them; sent date = the Date header of the first message that states the UTR.
  const msgs = (withUtr[0]._messages || []).filter((m) => findCandidates(m.bodyText).some((c) => c.utr === src.utr));
  const explicit = [];
  const seenDay = new Set();
  msgs.forEach((m) => {
    extractExplicitPaymentDates(stripQuoted(m.bodyText)).forEach((e) => {
      if (!seenDay.has(e.date)) { seenDay.add(e.date); explicit.push({ date: e.date, label: e.label, messageId: m.id }); }
    });
  });
  const sourceMsg = msgs.find((m) => m.id === src.messageId) || msgs[0];
  const sentAt = sourceMsg?.sentAt || src.sentAt || src.date || "";
  const paidDateInfo = { explicitDates: explicit, sentAt, sentDate: istDay(sentAt), sourceMessageId: src.messageId };

  return {
    message: "UTR extracted for this Bill Number (read-only, no database update)",
    data: {
      ...common,
      utr: src.utr,
      gmailThreadId: src.threadId,
      sourceMessageId: src.messageId,
      senderEmail: src.from,
      messageDate: src.date,
      paidDateInfo,
      ...(withUtr[0].replyLink ? { replyLink: withUtr[0].replyLink } : {}),
      extractionStatus: "found",
    },
  };
};

module.exports = { lookupUtrByBillNumber, lookupLandlordUtrs, BILL_NUMBER_FORMAT, containsExactBill };
