// ✅ NEW — one .env switch for every CMD approval mail (normal bill "cmdapproval",
// New Bill / Advance "newbillcmdapproval"): CMD_APPROVAL_MAIL=on → sent (MAIL_MODE
// production still needed); off / missing → not sent (the approval itself is unchanged).
const ON_VALUES = new Set(["on", "1", "true", "yes"]);

const isCmdApprovalMailOn = () => ON_VALUES.has(String(process.env.CMD_APPROVAL_MAIL || "").trim().toLowerCase());

const CMD_APPROVAL_MAIL_OFF_MESSAGE = "Mail skipped (CMD_APPROVAL_MAIL off) — not sent";

module.exports = { isCmdApprovalMailOn, CMD_APPROVAL_MAIL_OFF_MESSAGE };
