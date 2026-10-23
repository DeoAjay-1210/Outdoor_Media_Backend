// ─────────────────────────────────────────────────────────────
// ✅ NEW — site bill date slot (rentalPayment.billDate): 5, 10, 15, 20, 25, 30.
// Not used for bill generation — only for overdue / filtering
// (POST /admin/landowner/site-filter { billDate }).
// Not set on the site → 5 (schema default).
// ─────────────────────────────────────────────────────────────
const BILL_DATES = [5, 10, 15, 20, 25, 30];

const isValidBillDate = (v) => BILL_DATES.includes(Number(v));

// the site's slot: saved value, otherwise the default 5 (same as the schema)
const DEFAULT_BILL_DATE = 5;
const siteBillDate = (media) => {
  const rp = media?.rentalPayment || {};
  return isValidBillDate(rp.billDate) ? Number(rp.billDate) : DEFAULT_BILL_DATE;
};

// that slot's date in a month (UTC midnight, same shape as stored due dates);
// 30 in February → last day of February
const billDateInMonth = (year, month, billDate) => {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(Number(billDate), lastDay)));
};

// request value → [10, 15] (number, array or "10,15"); [] = no filter
const parseBillDateFilter = (v) => {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : String(v).split(",");
  return [...new Set(list.map((x) => Number(String(x).trim())).filter(isValidBillDate))];
};

module.exports = {
  BILL_DATES,
  isValidBillDate,
  siteBillDate,
  billDateInMonth,
  parseBillDateFilter,
};
