/**
 * Who sent a Gmail message, as a name for the ledger's `updatedBy`: the display name of the From header
 * ("Sathishkumar D <fin@x.com>" / "\"Finance Team\" <fin@x.com>"), else a readable name made from the address
 * ("finance.team@x.com" -> "Finance Team"). Never empty: "Gmail UTR Auto" only when there is no From header at all.
 */
const FALLBACK = "Gmail UTR Auto";
function senderName(from) {
  const raw = String(from || "").trim();
  if (!raw) return FALLBACK;
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]*)>/);
  const display = m ? m[1].replace(/\s+/g, " ").trim() : "";
  if (display && !display.includes("@")) return display;
  const addr = (m ? m[2] : raw).trim();
  const local = addr.split("@")[0].replace(/[._\-+]+/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  if (!local) return addr || FALLBACK;
  return local.replace(/\b\w/g, (c) => c.toUpperCase());
}
module.exports = { senderName, FALLBACK };
