// ✅ NEW — view-only logins (live): users whose phone is in READ_ONLY_PHONES
// cannot save through the APIs below (every other API works as usual).
//
//   READ_ONLY_PHONES=9876543210,9123456789   (comma separated)
//   READ_ONLY_PHONES_ENABLED=true             (live only; local → leave unset / false)
//
// Blocked (exact path only — e.g. /overdue-remark/edit is NOT blocked):
// /admin/ledger-save, /admin/media-onboarding, /admin/overdue-remark,
// /admin/rental-due-save, /admin/rental-due-save-draft, /admin/verify-agreement.
// Used by protect (authMiddleware).
const User = require("../models/Admin/UserSchema/UserSchema");

const isTrue = (v) => ["true", "1"].includes(String(v ?? "").trim().toLowerCase());
const lastTen = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const BLOCKED_PATHS = new Set([
  "/admin/ledger-save",
  "/admin/media-onboarding",
  "/admin/overdue-remark",
  "/admin/rental-due-save",
  "/admin/rental-due-save-draft",
  "/admin/verify-agreement",
]);
const READ_ONLY_MESSAGE = "This login is view-only on live — changes are not saved";

const readOnlyPhones = () =>
  new Set(String(process.env.READ_ONLY_PHONES || "").split(",").map(lastTen).filter(Boolean));

// old tokens have no userPhone → read once from the user record (cached)
const phoneCache = new Map();
async function phoneOfUser(user) {
  if (user?.userPhone) return user.userPhone;
  const id = String(user?.userId || "");
  if (!id) return "";
  if (phoneCache.has(id)) return phoneCache.get(id);
  const doc = await User.findById(id).select("userPhone").lean().catch(() => null);
  const phone = doc?.userPhone || "";
  phoneCache.set(id, phone);
  return phone;
}

// true → request blocked (403 already sent)
async function blockReadOnlyPhone(req, res) {
  if (!isTrue(process.env.READ_ONLY_PHONES_ENABLED)) return false;
  if (String(req.method).toUpperCase() === "GET") return false;
  const path = String(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  if (!BLOCKED_PATHS.has(path)) return false;
  const phones = readOnlyPhones();
  if (!phones.size) return false;
  const phone = lastTen(await phoneOfUser(req.user));
  if (!phone || !phones.has(phone)) return false;
  res.status(403).json({ success: false, statusCode: 403, message: READ_ONLY_MESSAGE });
  return true;
}

module.exports = { blockReadOnlyPhone };
