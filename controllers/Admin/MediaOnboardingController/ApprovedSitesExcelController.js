const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const XLSX = require("xlsx-js-style");
const { errorResponse } = require("../../../utils/response");
const { freezeHeaderInXlsxBuffer } = require("./RentalOOHExcelController");

// approvalSteps[].role → name used in the report
const ROLE_NAMES = { 1: "Rental Executive", 2: "Rental Manager", 3: "CMD" };
// approvalSteps[].status: 1=Pending 2=Approved 3=Skipped
const STEP_APPROVED = 2;
const STEP_STATUS_LABEL = { 1: "Pending", 2: "Approved", 3: "Skipped" };
// rentalDue.approvalStatus: 1=Pending 2=PartiallyApproved 3=Approved 4=Overdue
const APPROVAL_STATUS_LABEL = { 1: "Pending", 2: "Partially Approved", 3: "Approved", 4: "Overdue" };
const PAYMENT_CATEGORY_LABEL = { 1: "Cash", 2: "Online", 3: "Cash + Online" };
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parse "YYYY-MM-DD". approvedAt is saved with nowIST() (IST clock time held in
 * the UTC fields), so the range is built on the UTC fields as well.
 */
const parseDateParam = (value, endOfDay) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  // reject impossible dates such as 2026-02-31
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
};

// "21 Sep 2026" from an IST-held date
const formatDate = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const joinUnique = (arr) => [...new Set(arr.filter((v) => v !== undefined && v !== null && v !== ""))].join(", ");

// "Approved – 21 Sep 2026 (cmd)" / "Skipped" / "Pending" / "-"
const stepText = (step) => {
  if (!step) return "-";
  if (Number(step.status) === STEP_APPROVED) {
    const by = step.userName ? ` (${step.userName})` : "";
    return `Approved – ${formatDate(step.approvedAt)}${by}`;
  }
  return STEP_STATUS_LABEL[Number(step.status)] || "-";
};

// Same "GST Applicable" rule as the Rental OOH report
const isGstApplicableSite = (media) =>
  Number(media.rentalPayment?.gstApplicable) === 1 ||
  (media.landOwners || []).some(
    (o) => Number(o.gstApplicable) === 1 || Number(o.gstPercentage) > 0 || Number(o.gstAmount) > 0,
  ) ||
  Number(media.rentalPayment?.gstPercentage) > 0 ||
  Number(media.rentalPayment?.gstAmount) > 0 ||
  Number(media.gstApplicableFlag) === 1 ||
  Number(media.gstApplicableFlag) === 2;

const downloadApprovedSitesExcel = async (req, res) => {
  try {
    const { fromDate, toDate, role } = req.query;

    // ── Validation ──
    if (!fromDate || !toDate) {
      return errorResponse(res, "fromDate and toDate are required (format: YYYY-MM-DD)", null, 400);
    }
    const from = parseDateParam(fromDate, false);
    const to = parseDateParam(toDate, true);
    if (!from || !to) {
      return errorResponse(res, "fromDate and toDate must be valid dates (format: YYYY-MM-DD)", null, 400);
    }
    if (from > to) {
      return errorResponse(res, "fromDate must not be greater than toDate", null, 400);
    }
    const roleNum = Number(role);
    if (![1, 2, 3].includes(roleNum)) {
      return errorResponse(res, "role must be 1 (Rental Executive), 2 (Rental Manager) or 3 (CMD)", null, 400);
    }
    const roleName = ROLE_NAMES[roleNum];

    // ── Fetch: rental due entries where this role APPROVED within the range ──
    const approvedStepMatch = {
      role: roleNum,
      status: STEP_APPROVED,
      approvedAt: { $gte: from, $lte: to },
    };
    const mediaDocs = await Media.find({
      rentalDue: { $elemMatch: { approvalSteps: { $elemMatch: approvedStepMatch } } },
    }).lean();

    const isRoleApprovedInRange = (step) =>
      step &&
      Number(step.role) === roleNum &&
      Number(step.status) === STEP_APPROVED &&
      step.approvedAt &&
      new Date(step.approvedAt) >= from &&
      new Date(step.approvedAt) <= to;

    // One record per approved rental due entry
    const records = [];
    for (const media of mediaDocs) {
      const mediaDetails = media.mediaDetails || [];
      const owners = media.landOwners || [];
      const gstApplyText = isGstApplicableSite(media) ? "Yes" : "No";
      const tdsApplyText = owners.some((o) => Number(o.tdsApplicable) === 1) ? "Yes" : "No";

      // Landowner columns (several owners → comma separated)
      const ownerNames = joinUnique(owners.map((o) => o.name));
      const ownerPhones = joinUnique(owners.map((o) => o.phone));
      const ownerPaymentCategories = joinUnique(owners.map((o) => PAYMENT_CATEGORY_LABEL[Number(o.paymentCategory)]));
      const ownerBankDetails = owners
        .map((o) => [o.bankName, o.ifsc, o.accountNumber, o.upiId].filter(Boolean).join(" / "))
        .filter(Boolean)
        .join("; ");
      const ownerPans = joinUnique(owners.map((o) => o.panNumber));

      for (const due of media.rentalDue || []) {
        const steps = due.approvalSteps || [];
        const roleStep = steps.find(isRoleApprovedInRange);
        if (!roleStep) continue;

        // Separate bill → the face of this entry; single bill → all faces
        const faces = due.mediaDetailId
          ? mediaDetails.filter((d) => String(d._id) === String(due.mediaDetailId))
          : mediaDetails;
        const sizes = faces.map((d) => `${d.width || 0} × ${d.height || 0} (${d.totalSqFt || 0} Sq Ft)`);

        // Existing calculated values on the rental due entry
        const rentalAmount = Number(due.baseAmount || due.netPayable || 0);
        const gstAmount = Number(due.gstAmount || 0);

        records.push({
          dueDate: due.dueDate ? new Date(due.dueDate) : null,
          approvedAt: new Date(roleStep.approvedAt),
          row: [
            due.dueMonth || "",
            formatDate(roleStep.approvedAt),
            joinUnique(faces.map((d) => d.mediaCode)),
            joinUnique(faces.map((d) => d.mediaName)),
            joinUnique(faces.map((d) => d.mediaType)),
            joinUnique(faces.map((d) => d.state)),
            joinUnique(faces.map((d) => d.city)),
            joinUnique(faces.map((d) => d.location)),
            sizes.join(", "),
            ownerNames,
            ownerPhones,
            ownerPaymentCategories,
            ownerBankDetails,
            ownerPans,
            gstApplyText,
            tdsApplyText,
            rentalAmount,
            gstAmount,
            rentalAmount + gstAmount,
            stepText(steps.find((s) => Number(s.role) === 1)),
            stepText(steps.find((s) => Number(s.role) === 2)),
            stepText(steps.find((s) => Number(s.role) === 3)),
            APPROVAL_STATUS_LABEL[Number(due.approvalStatus)] || "-",
          ],
        });
      }
    }

    // No matching records → still download the Excel, with a "no records" row
    const noRecordsText = `No sites approved by ${roleName} between ${formatDate(from)} and ${formatDate(to)}`;

    // Group by month (due date order), newest approvals last inside a month
    records.sort((a, b) => (a.dueDate - b.dueDate) || (a.approvedAt - b.approvedAt));
    const months = [];
    for (const rec of records) {
      const label = rec.row[0] || "-";
      let group = months.find((m) => m.label === label);
      if (!group) {
        group = { label, rows: [] };
        months.push(group);
      }
      group.rows.push(rec.row);
    }

    // ── Build sheet (same design as the Rental OOH report) ──
    const colHeaders = [
      "📅 Month", "✅ Approval Date", "🆔 Media Code", "📝 Media Name", "🏗️ Media Type", "🗺️ State", "🏙️ City",
      "📍 Location", "📐 Size", "👤 Landowner Name", "📞 Landowner Phone", "💳 Payment Category",
      "🏦 Bank / IFSC / Account / UPI", "🪪 PAN", "📌 GST Applicable", "🧮 TDS Applicable",
      "🏠 Total Rental Amount (₹)", "💰 GST Amount (₹)", "🧾 Total Amount (₹)",
      "👤 Rental Executive", "👔 Rental Manager", "🏛️ CMD", "📋 Overall Approval Status",
    ];
    const LAST_COL = colHeaders.length - 1;
    const COL_RENTAL = 16, COL_GST = 17, COL_TOTAL = 18;
    const CENTER_COLS = new Set([0, 1, 14, 15, COL_RENTAL, COL_GST, COL_TOTAL, 22]);
    const blankRow = (first) => [first, ...Array(LAST_COL).fill("")];
    const headerRowIdx = 2;
    const FREEZE_ROWS = 3;

    const aoa = [];
    const merges = [];
    aoa.push(blankRow(`APPROVED SITES REPORT - ${roleName.toUpperCase()}`));
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST_COL } });
    aoa.push(blankRow(`Approval Period: ${formatDate(from)} to ${formatDate(to)}`));
    merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST_COL } });
    aoa.push(colHeaders);

    const totalRow = (label, rental, gst) => {
      const row = blankRow(label);
      row[COL_RENTAL] = rental;
      row[COL_GST] = gst;
      row[COL_TOTAL] = rental + gst;
      return row;
    };

    let grandRental = 0;
    let grandGst = 0;
    for (const { label, rows } of months) {
      const monthHeaderIdx = aoa.length;
      aoa.push(blankRow(`🗓️ ${label.toUpperCase()}`));
      merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: LAST_COL } });

      let monthRental = 0;
      let monthGst = 0;
      rows.forEach((row) => {
        monthRental += row[COL_RENTAL];
        monthGst += row[COL_GST];
      });
      aoa.push(...rows);

      const totalRowIdx = aoa.length;
      aoa.push(totalRow(`🏷️ ${label.toUpperCase()} TOTAL (${rows.length} ${rows.length === 1 ? "entry" : "entries"})`, monthRental, monthGst));
      merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: COL_RENTAL - 1 } });
      aoa.push([]);

      grandRental += monthRental;
      grandGst += monthGst;
    }

    let noRecordsRowIdx = -1;
    if (records.length) {
      const grandTotalIdx = aoa.length;
      aoa.push(totalRow(`📊 GRAND TOTAL (${records.length} ${records.length === 1 ? "entry" : "entries"})`, grandRental, grandGst));
      merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: COL_RENTAL - 1 } });
    } else {
      noRecordsRowIdx = aoa.length;
      aoa.push(blankRow(noRecordsText));
      merges.push({ s: { r: noRecordsRowIdx, c: 0 }, e: { r: noRecordsRowIdx, c: LAST_COL } });
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    const styleHeader = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: { top: { style: "thin" }, bottom: { style: "thin" } } };
    const styleMonthHeader = { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, alignment: { vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
    const styleTotalRow = (isEven) => ({ fill: { fgColor: { rgb: isEven ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
    const styleGrandTotal = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
    const styleData = { border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
    const numFormat = "₹ #,##,##0";

    ws["A1"].s = { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
    ws["A2"].s = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };

    let monthCounter = 0;
    for (let r = 0; r < aoa.length; r++) {
      const first = String(aoa[r][0] || "");
      for (let c = 0; c <= LAST_COL; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) continue;
        const isAmount = c >= COL_RENTAL && c <= COL_TOTAL;

        if (r === headerRowIdx) ws[addr].s = styleHeader;
        else if (first.startsWith("🗓️")) ws[addr].s = styleMonthHeader;
        else if (first.startsWith("🏷️")) {
          ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
          if (isAmount) ws[addr].z = numFormat;
          if (c === LAST_COL) monthCounter++;
        } else if (first.startsWith("📊")) {
          ws[addr].s = styleGrandTotal;
          if (isAmount) ws[addr].z = numFormat;
        } else if (r > headerRowIdx && aoa[r].length > 0) {
          ws[addr].s = {
            ...styleData,
            alignment: { vertical: "center", wrapText: true, horizontal: CENTER_COLS.has(c) ? "center" : "left" },
          };
          if (isAmount) ws[addr].z = numFormat;
          // Approval columns: approved in green
          if (c >= 19 && c <= 21 && String(aoa[r][c]).startsWith("Approved")) {
            ws[addr].s.font = { bold: true, color: { rgb: "38761D" } };
          }
        }
      }
    }

    if (noRecordsRowIdx !== -1) {
      ws[XLSX.utils.encode_cell({ r: noRecordsRowIdx, c: 0 })].s = {
        font: { bold: true, italic: true, color: { rgb: "C00000" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }

    ws["!merges"] = merges;
    ws["!views"] = [{ state: "frozen", xSplit: 0, ySplit: FREEZE_ROWS, topLeftCell: `A${FREEZE_ROWS + 1}`, activePane: "bottomLeft" }];
    ws["!cols"] = [
      { wch: 18 }, // Month
      { wch: 16 }, // Approval Date
      { wch: 20 }, // Media Code
      { wch: 30 }, // Media Name
      { wch: 20 }, // Media Type
      { wch: 18 }, // State
      { wch: 18 }, // City
      { wch: 30 }, // Location
      { wch: 24 }, // Size
      { wch: 28 }, // Landowner Name
      { wch: 18 }, // Landowner Phone
      { wch: 18 }, // Payment Category
      { wch: 40 }, // Bank / IFSC / Account / UPI
      { wch: 16 }, // PAN
      { wch: 16 }, // GST Applicable
      { wch: 16 }, // TDS Applicable
      { wch: 22 }, // Total Rental Amount
      { wch: 18 }, // GST Amount
      { wch: 18 }, // Total Amount
      { wch: 30 }, // Rental Executive
      { wch: 30 }, // Rental Manager
      { wch: 30 }, // CMD
      { wch: 22 }, // Overall Approval Status
    ];
    ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 35 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Approved Sites");
    const rawBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const buffer = freezeHeaderInXlsxBuffer(rawBuffer, FREEZE_ROWS);

    const fileRole = roleName.replace(/\s+/g, "_");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Approved_Sites_${fileRole}_${fromDate}_to_${toDate}.xlsx`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    return res.send(buffer);
  } catch (error) {
    console.error("Approved sites Excel generation error:", error);
    return errorResponse(res, "Failed to generate approved sites Excel report", null, 500);
  }
};

module.exports = {
  downloadApprovedSitesExcel,
};
