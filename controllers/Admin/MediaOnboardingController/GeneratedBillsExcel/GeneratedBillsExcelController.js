// ─────────────────────────────────────────────────────────────
// GENERATED BILLS EXCEL
// GET /admin/rental-ooh/download-bills-excel?fromMonth=08-2026&toMonth=11-2026&city=Chennai
//
// Every generated bill (media.rentalDue) whose month is between fromMonth and
// toMonth (MM-YYYY), grouped by month — same design as the Rental OOH Excel
// (title, period, note, month header rows, month total, grand total, frozen
// header + column A). Amounts: Rent = netPayable, GST = gstAmount,
// Total = Rent + GST. Read only — nothing is written to the database.
// ─────────────────────────────────────────────────────────────
const XLSX = require("xlsx-js-style");
const Media = require("../../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { errorResponse } = require("../../../../utils/response");
const { freezeHeaderInXlsxBuffer } = require("../RentalOOHExcelController");
const { getRentForDueDate, mediaAsOfDate } = require("../../../../utils/appraisalRent");

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const BILL_STATUS = { 1: "Pending", 2: "Partially Approved", 3: "Approved", 4: "Overdue" };

// "MM-YYYY" → { month (1-12), year } or null
const parseMonthYear = (str) => {
  const m = String(str || "").trim().match(/^(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  return month >= 1 && month <= 12 ? { month, year } : null;
};

const monthKey = (year, monthIdx) => year * 12 + monthIdx; // monthIdx 0-11

// "November 2026" / "Nov 2026" → month key, else null
const monthKeyOfLabel = (label) => {
  const parts = String(label || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  const idx = MONTH_NAMES.findIndex((n) => n.slice(0, 3).toLowerCase() === parts[0].slice(0, 3).toLowerCase());
  const year = Number(parts[1]);
  return idx === -1 || !year ? null : monthKey(year, idx);
};

// bill month: its dueMonth label, else its dueDate
const billMonthKey = (bill) => {
  const fromLabel = monthKeyOfLabel(bill.dueMonth);
  if (fromLabel !== null) return fromLabel;
  const d = bill.dueDate ? new Date(bill.dueDate) : null;
  return d && !Number.isNaN(d.getTime()) ? monthKey(d.getUTCFullYear(), d.getUTCMonth()) : null;
};

const formatDMY = (d) => {
  if (!d) return "-";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "-";
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getUTCFullYear()}`;
};

const joinUnique = (arr) => [...new Set(arr.map((v) => String(v || "").trim()).filter(Boolean))].join(", ");

const isGstApplicableSite = (media) =>
  [1, 2].includes(Number(media.gstApplicableFlag)) ||
  Number(media.rentalPayment?.gstApplicable) === 1 ||
  (media.landOwners || []).some((o) => Number(o.gstApplicable) === 1);

// several bills in one row: all approved → Approved, else the lowest stage
const combinedStatus = (bills) => {
  const statuses = bills.map((b) => Number(b.approvalStatus || 1));
  if (statuses.every((s) => s === 3)) return BILL_STATUS[3];
  if (statuses.includes(4)) return BILL_STATUS[4];
  return BILL_STATUS[Math.min(...statuses)] || BILL_STATUS[1];
};

// ✅ NEW — month fully paid by CMD approved advance(s) (rentalPayment.advanceAdjustments of
// that month) → "Paid by Advance (<month the advance was given>)", else null. Used only for a ₹0 row.
const paidByAdvanceStatus = (media, key) => {
  const label = `${MONTH_NAMES[key % 12]} ${Math.floor(key / 12)}`;
  const rows = (media?.rentalPayment?.advanceAdjustments || []).filter((a) => a && a.dueMonth === label && Number(a.amount || 0) > 0);
  if (!rows.length) return null;
  // ✅ CHANGED — the month the advance was given (CMD approved / generated: the
  // adjustment's createdAt, else the advance bill's approval date), not the advance bill month
  const givenMonth = (a) => {
    const bill = (media.arrearsDue || []).find((b) => b && String(b._id) === String(a.advanceBillId)) || {};
    const d = new Date(a.createdAt || bill.ownerApprovalDate || bill.createdAt || 0);
    if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return bill.dueMonth || null;
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  const months = [...new Set(rows.map(givenMonth).filter(Boolean))];
  return months.length ? `Paid by Advance (${months.join(", ")})` : "Paid by Advance";
};

// ✅ NEW — the site's billing frequency (rentalPayment.paymentFrequency): 1 Monthly … 6 Custom (N months)
const FREQUENCY_LABEL = { 1: "Monthly", 2: "Quarterly", 3: "Half Yearly", 4: "Yearly", 5: "2 Years" };
const frequencyLabel = (media) => {
  const freq = Number(media?.rentalPayment?.paymentFrequency || 0);
  if (freq === 6) {
    const n = Number(media?.rentalPayment?.customPaymentFrequency || 0);
    return n > 0 ? `Custom (${n} Month${n > 1 ? "s" : ""})` : "Custom";
  }
  return FREQUENCY_LABEL[freq] || "-";
};

// ✅ NEW — rent of one stored bill (withGst 2: netPayable already includes the GST)
const billRentOf = (b) =>
  Number(b.withGst) === 2 ? Math.max(0, Number(b.netPayable || 0) - Number(b.gstAmount || 0)) : Number(b.netPayable || 0);

// ✅ NEW — a bill (pending OR approved) that was generated at the rent before an
// appraisal applying to its month (the appraisal was added after the bill):
// ratio appraisal rent ÷ stored rent, so the Excel matches site-filter /
// rental-due-list (getRentForDueDate). 1 = keep the stored amounts:
// no appraisal for the month, or the bill is not at the appraisal's previous
// rent (priced some other way — left as stored).
// ✅ CHANGED — approved bills are re-priced too (same rule as site-filter approvedAmountTotal)
function appraisalRepriceRatio(media, bills, dueDate, storedSiteRent) {
  if (!dueDate) return 1;
  const due = new Date(dueDate);
  const dueKey = monthKey(due.getUTCFullYear(), due.getUTCMonth());
  const nowKey = monthKey(new Date().getUTCFullYear(), new Date().getUTCMonth());
  const applied = (media?.appraisal?.history || [])
    .filter((h) => {
      if (!h || !h.appraisalDate || h.isAnchorEntry) return false;
      if (Number(h.appraisalAmount || 0) <= 0 || Number(h.previousRent || 0) <= 0) return false;
      const d = new Date(h.appraisalDate);
      if (Number.isNaN(d.getTime())) return false;
      const k = monthKey(d.getUTCFullYear(), d.getUTCMonth());
      return k <= dueKey && k <= nowKey;
    })
    .sort((a, b) => new Date(b.appraisalDate) - new Date(a.appraisalDate))[0];
  if (!applied) return 1;
  const stored = Number(storedSiteRent || 0);
  if (stored <= 0 || Math.abs(stored - Number(applied.previousRent)) > bills.length) return 1;
  const rentNow = Number(getRentForDueDate(media, dueDate) || 0);
  if (rentNow <= 0 || Math.abs(rentNow - stored) <= bills.length) return 1;
  return rentNow / stored;
}

// ─────────────────────────────────────────────────────────────
// ✅ NEW — Pending Bills / Approved Bills sheets: same rows and design as the
// Generated Bills sheet (generated bills only, no Upcoming rows) + the
// Rental Executive / Manager / CMD approval date of the bill(s) and who it is
// waiting on. approvedAt is stored nowIST-style → read with getUTC* (IST clock).
// ─────────────────────────────────────────────────────────────
const APPROVAL_ROLES = [
  { role: 1, name: "Rental Executive" },
  { role: 2, name: "Manager" },
  { role: 3, name: "CMD" },
];

const formatDateTimeIST = (d) => {
  const date = d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return "-";
  const h = date.getUTCHours();
  const hh = String(h % 12 || 12).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatDMY(date)} ${hh}:${mi} ${h < 12 ? "AM" : "PM"}`;
};

// one role's cell for the bill(s) of a row: latest approval date / Skipped / Pending / - (role not in the flow)
const roleApprovalCell = (bills, role) => {
  const steps = bills.map((b) => (b.approvalSteps || []).find((s) => Number(s.role) === role)).filter(Boolean);
  if (!steps.length) return "-";
  if (steps.some((s) => Number(s.status) === 1 || !s.status)) return "Pending";
  const approved = steps.filter((s) => Number(s.status) === 2);
  if (!approved.length) return "Skipped";
  const latest = approved
    .map((s) => (s.approvedAt ? new Date(s.approvedAt) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => b - a)[0];
  return latest ? formatDateTimeIST(latest) : "Approved";
};

// who the bill(s) of a row are waiting on (earliest role still pending)
const waitingOnCell = (bills) => {
  if (bills.every((b) => Number(b.approvalStatus) === 3)) return "Completed";
  const roles = bills
    .filter((b) => Number(b.approvalStatus) !== 3)
    .map((b) => {
      const cur = Number(b.currentPendingRole || 0);
      if (cur) return cur;
      const step = (b.approvalSteps || []).find((s) => Number(s.status) === 1 || !s.status);
      return step ? Number(step.role) : 1;
    });
  const role = Math.min(...roles);
  return (APPROVAL_ROLES.find((r) => r.role === role) || {}).name || "-";
};

function buildApprovalSheet({ title, periodText, periodLabel, months }) {
  // Generated Bills columns + 4 after Approval Status
  const LAST_COL = 19;
  const COL_OWNERS = 7, COL_FREQUENCY = 9, COL_BILL_DATE = 10, COL_STATUS = 11;
  const COL_EXEC = 12, COL_MANAGER = 13, COL_CMD = 14, COL_WAITING = 15;
  const COL_GST_APPLY = 16, COL_RENT = 17, COL_GST = 18, COL_TOTAL = 19;
  const blankRow = (first) => [first, ...Array(LAST_COL).fill("")];
  const colHeaders = [
    "Month", "Media Code", "Media Name", "Media Type", "State", "City", "District / Town",
    "Total Landowners", "Landowner Name", "Payment Frequency", "Bill Date", "Approval Status",
    "Rental Executive Approved On", "Manager Approved On", "CMD Approved On", "Waiting On",
    "GST Applicable", "Rent Amount (₹)", "GST Amount (₹)", "Total Amount (₹)",
  ];
  const NOTE_TEXT = "Note: Rent Amount is the bill amount (TDS included). Total Amount = Rent Amount + GST Amount. Approved On = date & time (IST) the role approved; Skipped = a higher role approved directly; Pending = not approved yet; - = role not in this bill's approval flow.";
  const noteRowIdx = 2;
  const headerRowIdx = 3;
  const FREEZE_ROWS = 4;
  const FREEZE_COLS = 2;

  const styleHeader = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: { top: { style: "thin" }, bottom: { style: "thin" } } };
  const styleMonthHeader = { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, alignment: { vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
  const styleTotalRow = (isEven) => ({ fill: { fgColor: { rgb: isEven ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
  const styleGrandTotal = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  const styleData = { border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
  const styleNote = { font: { bold: true, italic: true, color: { rgb: "C00000" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } };
  const numFormat = "₹ #,##,##0";

  const aoa = [];
  const merges = [];
  aoa.push(blankRow(title));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST_COL } });
  aoa.push(blankRow(`Report Period: ${periodText}`));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST_COL } });
  aoa.push(blankRow(NOTE_TEXT));
  merges.push({ s: { r: noteRowIdx, c: 0 }, e: { r: noteRowIdx, c: LAST_COL } });
  aoa.push(colHeaders);

  let grandRent = 0, grandGst = 0, grandBills = 0;
  const monthHeaderRows = new Set();
  const monthTotalRows = new Set();
  months.filter((m) => m.rows.length).forEach(({ label, rows }) => {
    const monthHeaderIdx = aoa.length;
    monthHeaderRows.add(monthHeaderIdx);
    aoa.push(blankRow(`🗓️ ${label.toUpperCase()}`));
    merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: LAST_COL } });

    let monthRent = 0, monthGst = 0;
    [...rows]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .forEach((row) => {
        // [_, code … status (0-11), gstApply, rent, gst, total] → + 4 approval columns after status
        const out = [
          "", ...row.slice(1, 12),
          ...APPROVAL_ROLES.map((r) => roleApprovalCell(row.bills, r.role)),
          waitingOnCell(row.bills),
          ...row.slice(12, 16),
        ];
        monthRent += Number(out[COL_RENT] || 0);
        monthGst += Number(out[COL_GST] || 0);
        aoa.push(out);
      });

    const totalRowIdx = aoa.length;
    monthTotalRows.add(totalRowIdx);
    const totalRow = blankRow(`${label.toUpperCase()} TOTAL`);
    totalRow[COL_BILL_DATE] = `${rows.length} bill(s)`;
    totalRow[COL_RENT] = monthRent;
    totalRow[COL_GST] = monthGst;
    totalRow[COL_TOTAL] = monthRent + monthGst;
    aoa.push(totalRow);
    merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 6 } });
    aoa.push([]);

    grandRent += monthRent;
    grandGst += monthGst;
    grandBills += rows.length;
  });

  const grandTotalIdx = aoa.length;
  const grandRow = blankRow(`GRAND TOTAL (${periodLabel})`);
  grandRow[COL_BILL_DATE] = `${grandBills} bill(s)`;
  grandRow[COL_RENT] = grandRent;
  grandRow[COL_GST] = grandGst;
  grandRow[COL_TOTAL] = grandRent + grandGst;
  aoa.push(grandRow);
  merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: 6 } });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["A1"].s = { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  ws["A2"].s = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  ws[XLSX.utils.encode_cell({ r: noteRowIdx, c: 0 })].s = styleNote;

  const centered = new Set([0, COL_OWNERS, COL_FREQUENCY, COL_BILL_DATE, COL_STATUS, COL_EXEC, COL_MANAGER, COL_CMD, COL_WAITING, COL_GST_APPLY, COL_RENT, COL_GST, COL_TOTAL]);
  let monthCounter = 0;
  for (let r = 0; r < aoa.length; r++) {
    for (let c = 0; c <= LAST_COL; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) continue;
      if (r === headerRowIdx) ws[addr].s = styleHeader;
      else if (monthHeaderRows.has(r)) ws[addr].s = styleMonthHeader;
      else if (monthTotalRows.has(r)) {
        ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
        if (c >= COL_RENT) ws[addr].z = numFormat;
        if (c === LAST_COL) monthCounter++;
      } else if (r === grandTotalIdx) {
        ws[addr].s = styleGrandTotal;
        if (c >= COL_RENT) ws[addr].z = numFormat;
      } else if (r > headerRowIdx && aoa[r].length > 0) {
        ws[addr].s = { ...styleData, alignment: { vertical: "center", wrapText: true, horizontal: centered.has(c) ? "center" : "left" } };
        if (c >= COL_RENT) ws[addr].z = numFormat;
      }
    }
  }

  ws["!merges"] = merges;
  ws["!freeze"] = { xSplit: String(FREEZE_COLS), ySplit: String(FREEZE_ROWS), topLeftCell: `C${FREEZE_ROWS + 1}`, activePane: "bottomRight", state: "frozen" };
  ws["!views"] = [{ state: "frozen", xSplit: FREEZE_COLS, ySplit: FREEZE_ROWS, topLeftCell: `C${FREEZE_ROWS + 1}`, activePane: "bottomRight" }];
  ws["!cols"] = [
    { wch: 22 }, { wch: 20 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    { wch: 18 }, { wch: 35 }, { wch: 20 }, { wch: 16 }, { wch: 20 },
    { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, // approval dates + Waiting On
    { wch: 16 }, { wch: 20 }, { wch: 18 }, { wch: 20 },
  ];
  ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 22 }, { hpt: 35 }];
  return ws;
}

// ✅ NEW — S.No column on a finished sheet: every cell from column B moves one
// column right (styles, merges, widths, freeze follow); ✅ CHANGED — S.No is
// column A and Month column B; data rows (no label in column A, a Media Code)
// are numbered 1, 2, 3 … restarting at every 🗓️ month row. Title / month /
// total labels stay in column A (merged across).
const SERIAL_HEADER_ROW = 3;
function addSerialColumn(ws) {
  const enc = (r, c) => XLSX.utils.encode_cell({ r, c });
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.e.c; c >= 1; c--) {
      if (ws[enc(r, c)]) ws[enc(r, c + 1)] = ws[enc(r, c)];
      else delete ws[enc(r, c + 1)];
      delete ws[enc(r, c)];
    }
  }
  const styleOf = (cell) => (cell && cell.s ? JSON.parse(JSON.stringify(cell.s)) : undefined);
  let n = 0;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = ws[enc(r, 0)];
    const first = a && a.v !== undefined ? String(a.v) : "";
    if (first.startsWith("🗓️")) n = 0;
    const code = ws[enc(r, 2)];
    const isData = r > SERIAL_HEADER_ROW && !first && code && String(code.v || "").trim() !== "";
    // ✅ CHANGED — S.No in column A, Month in column B (title / month / total labels stay in A, merged across)
    if (r === SERIAL_HEADER_ROW) {
      ws[enc(r, 1)] = { t: "s", v: "Month", s: styleOf(a) };
      ws[enc(r, 0)] = { t: "s", v: "S.No", s: styleOf(a) };
    } else if (isData) {
      const s = styleOf(code) || {};
      ws[enc(r, 1)] = { t: "s", v: "", s: styleOf(a) || styleOf(code) };
      ws[enc(r, 0)] = { t: "n", v: ++n, s: { ...s, alignment: { ...(s.alignment || {}), horizontal: "center" } } };
    } else if (a) ws[enc(r, 1)] = { t: "s", v: "", s: styleOf(a) }; // title / month / total rows keep their fill
  }
  range.e.c += 1;
  ws["!ref"] = XLSX.utils.encode_range(range);
  (ws["!merges"] || []).forEach((m) => {
    if (m.s.c >= 1) m.s.c += 1;
    if (m.e.c >= 1) m.e.c += 1;
  });
  if (Array.isArray(ws["!cols"])) ws["!cols"].splice(0, 0, { wch: 8 }); // ✅ CHANGED — A: S.No (narrow), B: Month
  const FREEZE_ROWS = 4;
  ws["!freeze"] = { xSplit: "3", ySplit: String(FREEZE_ROWS), topLeftCell: `D${FREEZE_ROWS + 1}`, activePane: "bottomRight", state: "frozen" };
  ws["!views"] = [{ state: "frozen", xSplit: 3, ySplit: FREEZE_ROWS, topLeftCell: `D${FREEZE_ROWS + 1}`, activePane: "bottomRight" }];
  return ws;
}

// ✅ NEW — final (CMD) approval date of a fully approved bill: the latest step
// approval date (same rule as landowner/site-filter pastMonthApprovedThisMonth)
function finalApprovalDate(bill) {
  if (Number(bill?.approvalStatus) !== 3) return null;
  let at = null;
  (bill.approvalSteps || []).forEach((s) => {
    if ((Number(s.status) === 2 || Number(s.status) === 3) && s.approvedAt) {
      const d = new Date(s.approvedAt);
      if (!Number.isNaN(d.getTime()) && (!at || d > at)) at = d;
    }
  });
  return at;
}

// ✅ NEW — Past Bills Approved sheet: grouped by approval month, then bill month
// (sub-total per bill month), with each role's approval date
function buildPastApprovedSheet({ periodText, periodLabel, months }) {
  const LAST_COL = 19;
  const COL_OWNERS = 7, COL_FREQUENCY = 9, COL_BILL_MONTH = 10, COL_BILL_DATE = 11, COL_STATUS = 12;
  const COL_EXEC = 13, COL_MANAGER = 14, COL_CMD = 15;
  const COL_GST_APPLY = 16, COL_RENT = 17, COL_GST = 18, COL_TOTAL = 19;
  const blankRow = (first) => [first, ...Array(LAST_COL).fill("")];
  const colHeaders = [
    "Month", "Media Code", "Media Name", "Media Type", "State", "City", "District / Town",
    "Total Landowners", "Landowner Name", "Payment Frequency", "Bill Month", "Bill Date", "Approval Status",
    "Rental Executive Approved On", "Manager Approved On", "CMD Approved On",
    "GST Applicable", "Rent Amount (₹)", "GST Amount (₹)", "Total Amount (₹)",
  ];
  const NOTE_TEXT = "Note: Every bill CMD approved in the month shown — earlier months' bills (e.g. October bill approved in November) and that month's own bills. Amounts are the bill month's amounts. Rent Amount is the bill amount (TDS included). Total Amount = Rent Amount + GST Amount. Approved On = date & time (IST); Skipped = a higher role approved directly; - = role not in this bill's approval flow.";
  const noteRowIdx = 2;
  const headerRowIdx = 3;
  const FREEZE_ROWS = 4;
  const FREEZE_COLS = 2;

  const styleHeader = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: { top: { style: "thin" }, bottom: { style: "thin" } } };
  const styleMonthHeader = { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, alignment: { vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
  const styleSubTotal = { fill: { fgColor: { rgb: "F2F2F2" } }, font: { color: { rgb: "002D62" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
  const styleTotalRow = (isEven) => ({ fill: { fgColor: { rgb: isEven ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
  const styleGrandTotal = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  const styleData = { border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
  const styleNote = { font: { bold: true, italic: true, color: { rgb: "C00000" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } };
  const numFormat = "₹ #,##,##0";

  const aoa = [];
  const merges = [];
  aoa.push(blankRow("THIS MONTH APPROVED REPORT"));
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST_COL } });
  aoa.push(blankRow(`Approved In: ${periodText}`));
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST_COL } });
  aoa.push(blankRow(NOTE_TEXT));
  merges.push({ s: { r: noteRowIdx, c: 0 }, e: { r: noteRowIdx, c: LAST_COL } });
  aoa.push(colHeaders);

  let grandRent = 0, grandGst = 0, grandBills = 0;
  const monthHeaderRows = new Set();
  const subTotalRows = new Set();
  const monthTotalRows = new Set();
  const amountRow = (first, billsText, rent, gst) => {
    const row = blankRow(first);
    row[COL_BILL_DATE] = billsText;
    row[COL_RENT] = rent;
    row[COL_GST] = gst;
    row[COL_TOTAL] = rent + gst;
    return row;
  };

  months.filter((m) => m.rows.length).forEach(({ label, rows }) => {
    const monthHeaderIdx = aoa.length;
    monthHeaderRows.add(monthHeaderIdx);
    aoa.push(blankRow(`🗓️ ${label.toUpperCase()} — APPROVED IN`));
    merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: LAST_COL } });

    const sorted = [...rows].sort((a, b) => a.billKey - b.billKey || String(a[1]).localeCompare(String(b[1])));
    let monthRent = 0, monthGst = 0;
    sorted.forEach((row) => {
      aoa.push(row);
      monthRent += Number(row[COL_RENT] || 0);
      monthGst += Number(row[COL_GST] || 0);
    });

    // sub-total per bill month (oldest first)
    const billKeys = [...new Set(sorted.map((r) => r.billKey))].sort((a, b) => a - b);
    billKeys.forEach((bk) => {
      const part = sorted.filter((r) => r.billKey === bk);
      const idx = aoa.length;
      subTotalRows.add(idx);
      aoa.push(amountRow(
        `${String(part[0][COL_BILL_MONTH]).toUpperCase()} BILLS`,
        `${part.length} bill(s)`,
        part.reduce((s, r) => s + Number(r[COL_RENT] || 0), 0),
        part.reduce((s, r) => s + Number(r[COL_GST] || 0), 0),
      ));
      merges.push({ s: { r: idx, c: 0 }, e: { r: idx, c: 6 } });
    });

    const totalRowIdx = aoa.length;
    monthTotalRows.add(totalRowIdx);
    aoa.push(amountRow(`${label.toUpperCase()} TOTAL`, `${rows.length} bill(s)`, monthRent, monthGst));
    merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 6 } });
    aoa.push([]);

    grandRent += monthRent;
    grandGst += monthGst;
    grandBills += rows.length;
  });

  const grandTotalIdx = aoa.length;
  aoa.push(amountRow(`GRAND TOTAL (${periodLabel})`, `${grandBills} bill(s)`, grandRent, grandGst));
  merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: 6 } });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["A1"].s = { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  ws["A2"].s = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  ws[XLSX.utils.encode_cell({ r: noteRowIdx, c: 0 })].s = styleNote;

  const centered = new Set([0, COL_OWNERS, COL_FREQUENCY, COL_BILL_MONTH, COL_BILL_DATE, COL_STATUS, COL_EXEC, COL_MANAGER, COL_CMD, COL_GST_APPLY, COL_RENT, COL_GST, COL_TOTAL]);
  let monthCounter = 0;
  for (let r = 0; r < aoa.length; r++) {
    for (let c = 0; c <= LAST_COL; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) continue;
      if (r === headerRowIdx) ws[addr].s = styleHeader;
      else if (monthHeaderRows.has(r)) ws[addr].s = styleMonthHeader;
      else if (subTotalRows.has(r)) {
        ws[addr].s = styleSubTotal;
        if (c >= COL_RENT) ws[addr].z = numFormat;
      } else if (monthTotalRows.has(r)) {
        ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
        if (c >= COL_RENT) ws[addr].z = numFormat;
        if (c === LAST_COL) monthCounter++;
      } else if (r === grandTotalIdx) {
        ws[addr].s = styleGrandTotal;
        if (c >= COL_RENT) ws[addr].z = numFormat;
      } else if (r > headerRowIdx && aoa[r].length > 0) {
        ws[addr].s = { ...styleData, alignment: { vertical: "center", wrapText: true, horizontal: centered.has(c) ? "center" : "left" } };
        if (c >= COL_RENT) ws[addr].z = numFormat;
      }
    }
  }

  ws["!merges"] = merges;
  ws["!freeze"] = { xSplit: String(FREEZE_COLS), ySplit: String(FREEZE_ROWS), topLeftCell: `C${FREEZE_ROWS + 1}`, activePane: "bottomRight", state: "frozen" };
  ws["!views"] = [{ state: "frozen", xSplit: FREEZE_COLS, ySplit: FREEZE_ROWS, topLeftCell: `C${FREEZE_ROWS + 1}`, activePane: "bottomRight" }];
  ws["!cols"] = [
    { wch: 24 }, { wch: 20 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    { wch: 18 }, { wch: 35 }, { wch: 20 }, { wch: 18 }, { wch: 16 }, { wch: 20 },
    { wch: 24 }, { wch: 24 }, { wch: 24 },
    { wch: 16 }, { wch: 20 }, { wch: 18 }, { wch: 20 },
  ];
  ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 30 }, { hpt: 35 }];
  return ws;
}

const downloadGeneratedBillsExcel = async (req, res) => {
  try {
    const { fromMonth, toMonth } = req.query;
    const from = parseMonthYear(fromMonth);
    const to = parseMonthYear(toMonth);
    if (!from || !to) {
      return errorResponse(res, "fromMonth and toMonth are required (format: MM-YYYY)", null, 400);
    }
    const fromKey = monthKey(from.year, from.month - 1);
    const toKey = monthKey(to.year, to.month - 1);
    if (fromKey > toKey) return errorResponse(res, "fromMonth must be on or before toMonth", null, 400);

    // optional single-city filter (?city=Chennai), case / space insensitive
    const cityRaw = Array.isArray(req.query.city) ? req.query.city[0] : req.query.city;
    const cityName = cityRaw ? String(cityRaw).trim() : "";
    const cityKey = cityName.toLowerCase();
    const faceMatchesCity = (face) => !cityKey || String(face?.city || "").trim().toLowerCase() === cityKey;

    const months = [];
    for (let k = fromKey; k <= toKey; k++) {
      months.push({ key: k, label: `${MONTH_NAMES[k % 12]} ${Math.floor(k / 12)}`, rows: [] });
    }
    const monthByKey = new Map(months.map((m) => [m.key, m]));

    // ✅ CHANGED — every active site (full document): sites without a bill yet can have an upcoming cycle
    const mediaDocs = await Media.find({ "mediaDetails.status": 1 }).lean();
    const { getAllDueCycles, resolveExpectedGstForCycle } = require("../LedgerNew2Controller"); // lazy: avoids a circular import
    const now = new Date();

    // single-bill multi-face site: its bill is stored per face (site rent split by sqft) — the face rows can be
    // ₹1 off the whole bill after rounding, so the whole bill (same as rental-due-list) is used when the
    // difference is only rounding (≤ 1 per stored row). Full documents loaded only for those sites.
    const { siteBillForOverdue } = require("../RentalDueNew2Controller"); // lazy: avoids a circular import
    const fullDocCache = new Map();
    const wholeBillOf = async (mediaId, dueDate) => {
      const id = String(mediaId);
      if (!fullDocCache.has(id)) fullDocCache.set(id, mediaDocs.find((d) => String(d._id) === id) || (await Media.findById(mediaId).lean()));
      return siteBillForOverdue(fullDocCache.get(id), dueDate);
    };
    const roundOff = (stored, whole, rows) => (whole !== null && Math.abs(whole - stored) <= rows ? whole : stored);
    const pastApprovedByMonth = new Map(); // ✅ NEW — approval month key → Past Bills Approved rows

    // [serial, code, name, type, state, city, district, owners, ownerNames, frequency, billDate, status, gstApply, rent, gst, total]
    for (const media of mediaDocs) {
      const faces = media.mediaDetails || [];
      const owners = media.landOwners || [];
      const ownerNames = joinUnique(owners.map((o) => o.name)) || "-";
      const gstApply = isGstApplicableSite(media) ? "Yes" : "No";
      const frequency = frequencyLabel(media); // ✅ NEW
      const isCombined = Number(media.siteBillMode) === 1 || (faces.length > 0 && Number(faces[0].siteBillMode) === 1);

      // bills of this site in the period, by month → by row (combined site: one row; else one row per face)
      const groups = new Map();
      (media.rentalDue || []).forEach((bill) => {
        const key = billMonthKey(bill);
        if (key === null || !monthByKey.has(key)) return;
        const face = bill.mediaDetailId ? faces.find((f) => String(f._id) === String(bill.mediaDetailId)) : null;
        if (bill.mediaDetailId && !face) return; // stale bill of a removed face
        const rowKey = `${key}|${isCombined || !face ? "site" : String(face._id)}`;
        if (!groups.has(rowKey)) groups.set(rowKey, { key, face: isCombined ? null : face, bills: [] });
        groups.get(rowKey).bills.push(bill);
      });

      // ✅ NEW — stored rent of each month's bills (whole site) — for the appraisal re-price below
      const storedMonthRent = new Map();
      groups.forEach((grp) => {
        const sum = grp.bills.reduce((s, b) => s + billRentOf(b), 0);
        storedMonthRent.set(grp.key, (storedMonthRent.get(grp.key) || 0) + sum);
      });

      for (const { key, face, bills } of groups.values()) {
        const shownFaces = face ? [face] : faces.filter(faceMatchesCity);
        if (!shownFaces.length) continue; // city filter
        // combined site with faces in other cities → that share of the bill
        const share = face || !cityKey ? 1 : shownFaces.length / (faces.length || 1);
        // ✅ CHANGED — withGst 2 (Direct GST): netPayable already includes the GST → rent = netPayable − gstAmount
        const rentOf = (b) =>
          Number(b.withGst) === 2 ? Math.max(0, Number(b.netPayable || 0) - Number(b.gstAmount || 0)) : Number(b.netPayable || 0);
        let rentSum = bills.reduce((s, b) => s + rentOf(b), 0);
        let gstSum = bills.reduce((s, b) => s + Number(b.gstAmount || 0), 0);
        const dueDates = bills.map((b) => b.dueDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
        if (!face && bills.length > 1) {
          const whole = await wholeBillOf(media._id, dueDates[0]);
          if (whole) {
            rentSum = roundOff(rentSum, whole.rent, bills.length);
            gstSum = roundOff(gstSum, whole.gst, bills.length);
          }
        }
        // ✅ NEW — bill (pending or approved) generated at the rent BEFORE an appraisal that applies to its
        // month (appraisal added after the bill) → the appraisal rent (same as site-filter / rental-due-list)
        const ratio = appraisalRepriceRatio(media, bills, dueDates[0], storedMonthRent.get(key));
        if (ratio !== 1) {
          rentSum *= ratio;
          gstSum *= ratio;
        }
        const rent = Math.round(rentSum * share);
        const gst = Math.round(gstSum * share);
        // ✅ NEW — ₹0 bill fully paid by advance → "Paid by Advance (<month>)"
        const advanceStatus = rent === 0 && gst === 0 ? paidByAdvanceStatus(media, key) : null;
        monthByKey.get(key).rows.push([
          0,
          joinUnique(shownFaces.map((f) => f.mediaCode)) || "-",
          joinUnique(shownFaces.map((f) => f.mediaName)) || "-",
          joinUnique(shownFaces.map((f) => f.mediaType)) || "-",
          joinUnique(shownFaces.map((f) => f.state)) || "-",
          joinUnique(shownFaces.map((f) => f.city)) || "-",
          joinUnique(shownFaces.map((f) => f.district)) || "-",
          owners.length,
          ownerNames,
          frequency, // ✅ NEW — Payment Frequency
          formatDMY(dueDates[0]),
          advanceStatus || combinedStatus(bills), // ✅ CHANGED — + Paid by Advance
          gstApply,
          rent,
          gst,
          rent + gst,
        ]);
        monthByKey.get(key).rows[monthByKey.get(key).rows.length - 1].bills = bills; // ✅ NEW — not a cell: for the Pending / Approved sheets
      }

      // ✅ NEW — Past Bills Approved sheet: CMD-approved bills of a month BEFORE their approval month,
      // approved inside the period (e.g. October bill approved in November). Amounts: same rules as above.
      {
        const pastGroups = new Map();
        const allMonthRent = new Map(); // stored rent of every month's bills (active faces) — for the re-price
        (media.rentalDue || []).forEach((bill) => {
          const key = billMonthKey(bill);
          if (key === null || key > toKey) return; // ✅ CHANGED — this month's bills too (bill month ≤ approval month)
          const face = bill.mediaDetailId ? faces.find((f) => String(f._id) === String(bill.mediaDetailId)) : null;
          if (bill.mediaDetailId && !face) return; // stale bill of a removed face
          allMonthRent.set(key, (allMonthRent.get(key) || 0) + billRentOf(bill));
          if (Number(bill.approvalStatus) !== 3) return;
          const rowKey = `${key}|${isCombined || !face ? "site" : String(face._id)}`;
          if (!pastGroups.has(rowKey)) pastGroups.set(rowKey, { key, face: isCombined ? null : face, bills: [] });
          pastGroups.get(rowKey).bills.push(bill);
        });
        for (const { key, face, bills } of pastGroups.values()) {
          const approvedAt = bills
            .map(finalApprovalDate)
            .filter(Boolean)
            .sort((a, b) => b - a)[0];
          if (!approvedAt) continue;
          const approvedKey = monthKey(approvedAt.getUTCFullYear(), approvedAt.getUTCMonth());
          if (approvedKey < fromKey || approvedKey > toKey || key > approvedKey) continue; // ✅ CHANGED — + bills of the approval month
          const shownFaces = face ? [face] : faces.filter(faceMatchesCity);
          if (!shownFaces.length) continue; // city filter
          const share = face || !cityKey ? 1 : shownFaces.length / (faces.length || 1);
          let rentSum = bills.reduce((s, b) => s + billRentOf(b), 0);
          let gstSum = bills.reduce((s, b) => s + Number(b.gstAmount || 0), 0);
          const dueDates = bills.map((b) => b.dueDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
          if (!face && bills.length > 1) {
            const whole = await wholeBillOf(media._id, dueDates[0]);
            if (whole) {
              rentSum = roundOff(rentSum, whole.rent, bills.length);
              gstSum = roundOff(gstSum, whole.gst, bills.length);
            }
          }
          const ratio = appraisalRepriceRatio(media, bills, dueDates[0], allMonthRent.get(key));
          if (ratio !== 1) {
            rentSum *= ratio;
            gstSum *= ratio;
          }
          const rent = Math.round(rentSum * share);
          const gst = Math.round(gstSum * share);
          const row = [
            "",
            joinUnique(shownFaces.map((f) => f.mediaCode)) || "-",
            joinUnique(shownFaces.map((f) => f.mediaName)) || "-",
            joinUnique(shownFaces.map((f) => f.mediaType)) || "-",
            joinUnique(shownFaces.map((f) => f.state)) || "-",
            joinUnique(shownFaces.map((f) => f.city)) || "-",
            joinUnique(shownFaces.map((f) => f.district)) || "-",
            owners.length,
            ownerNames,
            frequency,
            `${MONTH_NAMES[key % 12]} ${Math.floor(key / 12)}`, // Bill Month
            formatDMY(dueDates[0]),
            combinedStatus(bills),
            ...APPROVAL_ROLES.map((r) => roleApprovalCell(bills, r.role)),
            gstApply,
            rent,
            gst,
            rent + gst,
          ];
          row.billKey = key; // not a cell
          if (!pastApprovedByMonth.has(approvedKey)) pastApprovedByMonth.set(approvedKey, []);
          pastApprovedByMonth.get(approvedKey).push(row);
        }
      }

      // ✅ NEW — a month with a billing cycle but no generated bill yet (e.g. a future month): the bill that WILL
      // be generated — same cycles as rental-due-list / ledger (getAllDueCycles), rent as of the cycle date
      // (appraisal-aware), expected GST of the cycle
      const billedKeys = new Set([...groups.values()].map((grp) => grp.key));
      const activeFaces = faces.filter((f) => Number(f.status) === 1);
      const projectedFaces = activeFaces.filter(faceMatchesCity);
      if (projectedFaces.length) {
        const share = cityKey ? projectedFaces.length / (activeFaces.length || 1) : 1;
        for (const m of months) {
          if (billedKeys.has(m.key)) continue;
          const year = Math.floor(m.key / 12);
          const monthIdx = m.key % 12;
          let cycles = [];
          try {
            cycles = getAllDueCycles(media, { year, month: monthIdx + 1 }) || [];
          } catch (err) {
            cycles = [];
          }
          const cycle = cycles[cycles.length - 1];
          if (!cycle || cycle.getUTCFullYear() !== year || cycle.getUTCMonth() !== monthIdx) continue;
          const rent = Math.round(Number(getRentForDueDate(media, cycle) || 0) * share);
          const gst = Math.round(Number(resolveExpectedGstForCycle(mediaAsOfDate(media, cycle)) || 0) * share);
          // ✅ CHANGED — ₹0 month fully paid by advance → still shown ("Paid by Advance (<month>)")
          const advanceStatus = rent <= 0 && gst <= 0 ? paidByAdvanceStatus(media, m.key) : null;
          if (rent <= 0 && gst <= 0 && !advanceStatus) continue;
          const row = [
            0,
            joinUnique(projectedFaces.map((f) => f.mediaCode)) || "-",
            joinUnique(projectedFaces.map((f) => f.mediaName)) || "-",
            joinUnique(projectedFaces.map((f) => f.mediaType)) || "-",
            joinUnique(projectedFaces.map((f) => f.state)) || "-",
            joinUnique(projectedFaces.map((f) => f.city)) || "-",
            joinUnique(projectedFaces.map((f) => f.district)) || "-",
            owners.length,
            ownerNames,
            frequency, // ✅ NEW — Payment Frequency
            formatDMY(cycle),
            advanceStatus || (cycle.getTime() > now.getTime() ? "Upcoming (Not Generated)" : "Not Generated"), // ✅ CHANGED — + Paid by Advance
            gstApply,
            rent,
            gst,
            rent + gst,
          ];
          row.projected = true; // not a cell — counted in the total rows
          m.rows.push(row);
        }
      }
    }

    // ── sheet (same design as the Rental OOH Excel) ──
    // ✅ CHANGED — + Payment Frequency (column J) after Landowner Name
    const LAST_COL = 15;
    const COL_OWNERS = 7;
    const COL_FREQUENCY = 9;
    const COL_BILL_DATE = 10;
    const COL_STATUS = 11;
    const COL_GST_APPLY = 12;
    const COL_RENT = 13, COL_GST = 14, COL_TOTAL = 15;
    const blankRow = (first) => [first, ...Array(LAST_COL).fill("")];
    const colHeaders = [
      "Month", "Media Code", "Media Name", "Media Type", "State", "City", "District / Town",
      "Total Landowners", "Landowner Name", "Payment Frequency", "Bill Date", "Approval Status", "GST Applicable",
      "Rent Amount (₹)", "GST Amount (₹)", "Total Amount (₹)",
    ];
    const NOTE_TEXT = "Note: Rent Amount is the bill amount (TDS included). Total Amount = Rent Amount + GST Amount. Upcoming (Not Generated) = bill of that month not generated yet — expected amounts.";
    const noteRowIdx = 2;
    const headerRowIdx = 3;
    const FREEZE_ROWS = 4; // title, period, note, column headers
    const FREEZE_COLS = 2; // ✅ CHANGED — columns A (month) + B (Media Code) stay on the left while scrolling right

    const startLabel = months[0].label;
    const endLabel = months[months.length - 1].label;
    const periodLabel = months.length > 1 ? `${startLabel} - ${endLabel}` : startLabel;
    const periodText = (months.length > 1 ? `${startLabel} to ${endLabel}` : startLabel) + (cityName ? ` | City: ${cityName}` : "");

    const styleHeader = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: { top: { style: "thin" }, bottom: { style: "thin" } } };
    const styleMonthHeader = { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, alignment: { vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
    const styleTotalRow = (isEven) => ({ fill: { fgColor: { rgb: isEven ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
    const styleGrandTotal = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
    const styleData = { border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
    const styleNote = { font: { bold: true, italic: true, color: { rgb: "C00000" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } };
    const numFormat = "₹ #,##,##0";

    const aoa = [];
    const merges = [];
    aoa.push(blankRow("GENERATED BILLS REPORT"));
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST_COL } });
    aoa.push(blankRow(`Report Period: ${periodText}`));
    merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST_COL } });
    aoa.push(blankRow(NOTE_TEXT));
    merges.push({ s: { r: noteRowIdx, c: 0 }, e: { r: noteRowIdx, c: LAST_COL } });
    aoa.push(colHeaders);

    let grandRent = 0, grandGst = 0, grandBills = 0, grandUpcoming = 0;
    const monthTotalRows = new Set(); // ✅ NEW
    months.filter((m) => m.rows.length).forEach(({ label, rows }) => {
      const monthHeaderIdx = aoa.length;
      aoa.push(blankRow(`🗓️ ${label.toUpperCase()}`));
      merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: LAST_COL } });

      rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      let monthRent = 0, monthGst = 0;
      rows.forEach((row, idx) => {
        row[0] = ""; // ✅ CHANGED — no S.No (column A stays for the month / total labels)
        monthRent += row[COL_RENT];
        monthGst += row[COL_GST];
      });
      aoa.push(...rows);

      const totalRowIdx = aoa.length;
      monthTotalRows.add(totalRowIdx); // ✅ NEW — styled by index (no icon)
      const upcoming = rows.filter((r) => r.projected).length; // ✅ NEW
      aoa.push([`${label.toUpperCase()} TOTAL`, "", "", "", "", "", "", "", "", "", `${rows.length} bill(s) (Generated ${rows.length - upcoming} · Upcoming ${upcoming})`, "", "", monthRent, monthGst, monthRent + monthGst]);
      merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 6 } });
      aoa.push([]);

      grandRent += monthRent;
      grandGst += monthGst;
      grandBills += rows.length;
      grandUpcoming += upcoming;
    });

    const grandTotalIdx = aoa.length;
    aoa.push([`GRAND TOTAL (${periodLabel})`, "", "", "", "", "", "", "", "", "", `${grandBills} bill(s) (Generated ${grandBills - grandUpcoming} · Upcoming ${grandUpcoming})`, "", "", grandRent, grandGst, grandRent + grandGst]);
    merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: 6 } });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["A1"].s = { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
    ws["A2"].s = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
    ws[XLSX.utils.encode_cell({ r: noteRowIdx, c: 0 })].s = styleNote;

    const centered = new Set([0, COL_OWNERS, COL_FREQUENCY, COL_BILL_DATE, COL_STATUS, COL_GST_APPLY, COL_RENT, COL_GST, COL_TOTAL]);
    let monthCounter = 0;
    for (let r = 0; r < aoa.length; r++) {
      for (let c = 0; c <= LAST_COL; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) continue;
        const first = aoa[r][0] ? String(aoa[r][0]) : "";
        if (r === headerRowIdx) ws[addr].s = styleHeader;
        else if (first.startsWith("🗓️")) ws[addr].s = styleMonthHeader;
        else if (monthTotalRows.has(r)) {
          ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
          if (c >= COL_RENT) ws[addr].z = numFormat;
          if (c === LAST_COL) monthCounter++;
        } else if (r === grandTotalIdx) {
          ws[addr].s = styleGrandTotal;
          if (c >= COL_RENT) ws[addr].z = numFormat;
        } else if (r > headerRowIdx && aoa[r].length > 0) {
          ws[addr].s = { ...styleData, alignment: { vertical: "center", wrapText: true, horizontal: centered.has(c) ? "center" : "left" } };
          if (c >= COL_RENT) ws[addr].z = numFormat;
        }
      }
    }

    ws["!merges"] = merges;
    ws["!freeze"] = { xSplit: String(FREEZE_COLS), ySplit: String(FREEZE_ROWS), topLeftCell: `C${FREEZE_ROWS + 1}`, activePane: "bottomRight", state: "frozen" };
    ws["!views"] = [{ state: "frozen", xSplit: FREEZE_COLS, ySplit: FREEZE_ROWS, topLeftCell: `C${FREEZE_ROWS + 1}`, activePane: "bottomRight" }];
    ws["!cols"] = [
      { wch: 22 }, // A: Month #
      { wch: 20 }, // B: Media Code
      { wch: 40 }, // C: Media Name
      { wch: 20 }, // D: Media Type
      { wch: 18 }, // E: State
      { wch: 18 }, // F: City
      { wch: 18 }, // G: District
      { wch: 18 }, // H: Total Landowners
      { wch: 35 }, // I: Landowner Name
      { wch: 20 }, // J: Payment Frequency ✅ NEW
      { wch: 16 }, // K: Bill Date
      { wch: 20 }, // L: Approval Status
      { wch: 16 }, // M: GST Applicable
      { wch: 20 }, // N: Rent Amount
      { wch: 18 }, // O: GST Amount
      { wch: 20 }, // P: Total Amount
    ];
    ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 22 }, { hpt: 35 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, addSerialColumn(ws), "Generated Bills"); // ✅ CHANGED — + S.No column
    // ✅ NEW — Pending Bills / Approved Bills sheets (generated bills only, with each role's approval date)
    const generatedRowsOf = (pick) =>
      months.map((m) => ({ label: m.label, rows: m.rows.filter((r) => !r.projected && Array.isArray(r.bills) && pick(r.bills)) }));
    const isAllApproved = (bills) => bills.every((b) => Number(b.approvalStatus) === 3);
    XLSX.utils.book_append_sheet(
      wb,
      addSerialColumn(buildApprovalSheet({ title: "PENDING BILLS REPORT", periodText, periodLabel, months: generatedRowsOf((b) => !isAllApproved(b)) })),
      "Pending Bills",
    );
    XLSX.utils.book_append_sheet(
      wb,
      addSerialColumn(buildApprovalSheet({ title: "APPROVED BILLS REPORT", periodText, periodLabel, months: generatedRowsOf(isAllApproved) })),
      "Approved Bills",
    );
    // ✅ CHANGED — every bill CMD-approved inside the period (earlier months + this month), approval month → bill month
    XLSX.utils.book_append_sheet(
      wb,
      addSerialColumn(buildPastApprovedSheet({
        periodText,
        periodLabel,
        months: months.map((m) => ({ label: m.label, rows: pastApprovedByMonth.get(m.key) || [] })),
      })),
      "This Month Approved",
    );
    const rawBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const buffer = freezeHeaderInXlsxBuffer(rawBuffer, FREEZE_ROWS, FREEZE_COLS + 1); // ✅ CHANGED — Month + S.No + Media Code

    const fileCity = cityName ? `_${cityName.replace(/[^a-zA-Z0-9-]+/g, "_")}` : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Rental_OOH_Bills_${fromMonth}_to_${toMonth}${fileCity}.xlsx`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    return res.send(buffer);
  } catch (error) {
    console.error("Generated bills Excel error:", error);
    return errorResponse(res, "Failed to generate the generated bills Excel", error.message, 500);
  }
};

module.exports = { downloadGeneratedBillsExcel };
