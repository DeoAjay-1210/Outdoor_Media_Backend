// Simple helpers used by the rental due controller.
// Replace with your existing project utils if you already have equivalents.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** e.g. "June 2026" */
function getDueMonthLabel(date) {
  const d = new Date(date);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** e.g. "2026" */
function getYearLabel(date) {
  return String(new Date(date).getFullYear());
}

/** e.g. "June" */
function getMonthLabel(date) {
  return MONTH_NAMES[new Date(date).getMonth()];
}

/** Current time in IST (Asia/Kolkata) as a Date object */
function nowIST() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
}

module.exports = { getDueMonthLabel, getYearLabel, getMonthLabel, nowIST };