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
const { extractBillNumbers, stripQuoted, findCandidates, extractCashLines } = require("./utrExtractor");

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

  // The approval mail a message answers: its In-Reply-To parent, or the parent's parent ... (Finance's chain is approval -> "Payment
  // Uploaded" -> "Approved" -> "UTR : ..."). The chain must END at an approval mail of this thread, otherwise it is not linked.
  const rootApproval = (m) => {
    let cur = m;
    for (let i = 0; i < 25 && cur; i++) {
      const parent = cur.inReplyTo ? byHeader.get(normId(cur.inReplyTo)) : null;
      if (!parent) return null;
      if (approvalIds.has(parent.id)) return parent;
      cur = parent;
    }
    return null;
  };

  const linked = [];
  const unlinked = [];
  const bankMessages = []; // every message of THIS approval's chain (the bank table is in the "Payment Uploaded" mail, not in the UTR reply)
  for (const m of messages) {
    if (approvalIds.has(m.id)) continue;
    const root = rootApproval(m);
    if (root && root.id === approval.id) bankMessages.push(m);
    if (!findCandidates(stripQuoted(m.bodyText)).length && !extractCashLines(m.bodyText).length) continue; // no UTR / Cash line in it: not a payment reply
    if (!root) {
      unlinked.push(m.id);
      continue;
    }
    if (root.id === approval.id) linked.push(m);
  }
  if (unlinked.length) return { status: "unlinked", reason: "reply_not_linked_to_approval_mail", replyMessageIds: unlinked };
  return {
    status: "scoped",
    messages: [approval, ...linked],
    bankMessages,
    link: { mode: "in_reply_to", approvalMessageId: approval.id, replyMessageIds: linked.map((m) => m.id) },
  };
}

module.exports = { scopeThreadToBill, isApprovalMessage, normId };
