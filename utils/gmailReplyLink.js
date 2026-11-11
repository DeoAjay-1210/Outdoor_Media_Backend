/**
 * Reply -> original approval mail, by the reply's own In-Reply-To header. PURE: no network, no database.
 *
 * Used only when ONE Gmail thread holds several approval mails (e.g. the August and the September CMD mail share a subject, so
 * Gmail threads them together). Finance replies carry only a UTR, so the month is never read from the reply text and never
 * guessed from the reply order: the bill is the one printed in the approval message that the In-Reply-To header names.
 *
 * Anything that cannot be tied to exactly one approval message is refused (manual review):
 *   approval_message_not_found | approval_mail_has_several_bills | reply_not_linked_to_approval_mail
 */
const { extractBillNumbers, stripQuoted, findCandidates } = require("./utrExtractor");

const normId = (v) => String(v || "").trim().replace(/^<|>$/g, "").toLowerCase();
const ownBills = (m) => [...new Set(extractBillNumbers(stripQuoted(m.bodyText)))];
const isApprovalMessage = (m) => /Owner Name/i.test(stripQuoted(m.bodyText)) && ownBills(m).length > 0;

/**
 * messages: usable thread messages (oldest first) with { id, bodyText, messageIdHeader, inReplyTo }.
 * -> { status: "scoped", messages: [approval, ...its replies], link } | { status: "unlinked", reason, replyMessageIds }
 * link = { mode: "in_reply_to", approvalMessageId, replyMessageIds }
 */
function scopeThreadToBill(messages, billNumber) {
  const approvals = messages.filter(isApprovalMessage);
  const approval = approvals.find((m) => ownBills(m).some((b) => b.toLowerCase() === billNumber.toLowerCase()));
  if (!approval) return { status: "unlinked", reason: "approval_message_not_found", replyMessageIds: [] };
  if (ownBills(approval).length !== 1) return { status: "unlinked", reason: "approval_mail_has_several_bills", replyMessageIds: [] };

  const approvalIds = new Set(approvals.map((m) => m.id));
  const byHeader = new Map();
  messages.forEach((m) => {
    if (m.messageIdHeader) byHeader.set(normId(m.messageIdHeader), m);
  });

  const linked = [];
  const unlinked = [];
  for (const m of messages) {
    if (approvalIds.has(m.id)) continue;
    if (!findCandidates(stripQuoted(m.bodyText)).length) continue; // no UTR in it: not a payment reply
    const parent = m.inReplyTo ? byHeader.get(normId(m.inReplyTo)) : null;
    if (!parent || !approvalIds.has(parent.id)) {
      unlinked.push(m.id);
      continue;
    }
    if (parent.id === approval.id) linked.push(m);
  }
  if (unlinked.length) return { status: "unlinked", reason: "reply_not_linked_to_approval_mail", replyMessageIds: unlinked };
  return {
    status: "scoped",
    messages: [approval, ...linked],
    link: { mode: "in_reply_to", approvalMessageId: approval.id, replyMessageIds: linked.map((m) => m.id) },
  };
}

module.exports = { scopeThreadToBill, isApprovalMessage, normId };
