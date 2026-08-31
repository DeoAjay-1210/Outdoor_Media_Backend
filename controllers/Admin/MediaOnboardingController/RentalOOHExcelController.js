const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const XLSX = require("xlsx-js-style");
const { successResponse, errorResponse } = require("../../../utils/response");

/**
 * Generate a list of months between fromMonth (MM-YYYY) and toMonth (MM-YYYY)
 */
function generateMonthList(fromStr, toStr) {
  const [fromM, fromY] = fromStr.split("-").map(Number);
  const [toM, toY] = toStr.split("-").map(Number);

  const start = new Date(Date.UTC(fromY, fromM - 1, 1));
  const end = new Date(Date.UTC(toY, toM - 1, 1));

  const result = [];
  const current = new Date(start);

  while (current <= end) {
    const monthName = current.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const year = current.getUTCFullYear();
    result.push({
      label: `${monthName} ${year}`,
      date: new Date(current)
    });
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return result;
}

const downloadRentalOOHExcel = async (req, res) => {
  try {
    const { fromMonth, toMonth } = req.query;

    if (!fromMonth || !toMonth) {
      return errorResponse(res, "fromMonth and toMonth are required (format: MM-YYYY)");
    }

    const monthList = generateMonthList(fromMonth, toMonth);
    const monthLabels = monthList.map(m => m.label);

    // Fetch all media documents
    const mediaDocs = await Media.find({
      "mediaDetails.status": 1 // Only active media
    }).lean();

    const reportRows = [];
    const merges = [];

    // Process each month
    for (let i = 0; i < monthList.length; i++) {
      const monthLabel = monthLabels[i];

      let monthLedgerTotal = 0;
      let monthGstTotal = 0;
      let monthDataFound = false;

      // 1. Add a visual Month Header
      const headerRowIndex = reportRows.length;
      reportRows.push({
        "Month": `--- ${monthLabel.toUpperCase()} ---`,
        "Media Code": "",
        "Media Name": "",
        "Media Type": "",
        "Total Landowners": "",
        "Ledger Amount": "",
        "GST Amount": "",
        "Total Amount": ""
      });

      // Merge the month header across all 8 columns
      merges.push({ s: { r: headerRowIndex + 1, c: 0 }, e: { r: headerRowIndex + 1, c: 7 } });

      for (const media of mediaDocs) {
        const mediaDetails = media.mediaDetails || [];
        const owners = media.landOwners || [];

        // Build mapping of rentalDueId -> mediaDetailId
        const dueToMediaMap = new Map();
        (media.rentalDue || []).forEach(d => {
          if (d.mediaDetailId) {
            dueToMediaMap.set(String(d._id), String(d.mediaDetailId));
          }
        });

        // Collect all ledger entries
        const allLedgerEntries = [
          ...(media.ledger || []),
          ...(media.withGst1Ledger || [])
        ];

        if (media.ledgerHistory) {
          media.ledgerHistory.forEach(yearBucket => {
            if (yearBucket.months) {
              yearBucket.months.forEach(monthBucket => {
                if (monthBucket.entries) {
                  allLedgerEntries.push(...monthBucket.entries);
                }
              });
            }
          });
        }

        // Filter and deduplicate
        const monthLedgerEntries = allLedgerEntries.filter(e =>
          (e.month === monthLabel || e.dueMonth === monthLabel) &&
          (e.status === 1 || e.isUtrEntry === true)
        );

        const uniqueLedgers = new Map();
        monthLedgerEntries.forEach(e => {
          const key = `${e.rentalDueId || "no-due"}-${e.landOwnerId || "no-owner"}-${monthLabel}-${e.amount}-${e.paymentMode || "unknown"}`;
          if (!uniqueLedgers.has(key)) {
            uniqueLedgers.set(key, e);
          }
        });

        const monthGstEntries = (media.gstBalanceHistory || []).filter(g =>
          g.dueMonth === monthLabel && (g.isPaid || (g.utrNumber && g.utrNumber.trim() !== ""))
        );

        // Deduplicate GST entries
        const uniqueGst = new Map();
        const ledgerEntriesBase = Array.from(uniqueLedgers.values()).filter(e => e.isUtrEntry !== true);
        const gstEntriesFromLedger = Array.from(uniqueLedgers.values()).filter(e => e.isUtrEntry === true);

        gstEntriesFromLedger.forEach(g => {
          const key = `${g.rentalDueId || "no-due"}-${g.landOwnerId || "no-owner"}-${monthLabel}-${g.amount}`;
          uniqueGst.set(key, { amount: Number(g.amount), rentalDueId: g.rentalDueId });
        });
        monthGstEntries.forEach(g => {
          const key = `${g.rentalDueId || "no-due"}-${g.ownerId || "rental"}-${monthLabel}-${g.gstAmount}`;
          if (!uniqueGst.has(key)) {
            uniqueGst.set(key, { amount: Number(g.gstAmount), rentalDueId: g.rentalDueId, source: g.source });
          }
        });

        // Tracking per Site/Media in this month
        const ledgerByFace = new Map();
        const gstByFace = new Map();
        let siteWideLedger = 0;
        let siteWideGst = 0;

        ledgerEntriesBase.forEach(e => {
          const mId = dueToMediaMap.get(String(e.rentalDueId));
          if (mId && mId !== "SITE") {
            ledgerByFace.set(mId, (ledgerByFace.get(mId) || 0) + (Number(e.amount) || 0));
          } else {
            siteWideLedger += (Number(e.amount) || 0);
          }
        });

        uniqueGst.forEach(g => {
          const mId = dueToMediaMap.get(String(g.rentalDueId));
          if (mId && mId !== "SITE") {
            gstByFace.set(mId, (gstByFace.get(mId) || 0) + (g.amount || 0));
          } else {
            siteWideGst += (g.amount || 0);
          }
        });

        const totalLedger = Array.from(ledgerByFace.values()).reduce((a,b) => a+b, 0) + siteWideLedger;
        const totalGst = Array.from(gstByFace.values()).reduce((a,b) => a+b, 0) + siteWideGst;

        if (totalLedger > 0 || totalGst > 0) {
           monthLedgerTotal += totalLedger;
           monthGstTotal += totalGst;

           // Robust check for Single Bill Mode (Common Billing)
           // Check top-level, inside mediaDetails, or if name already suggests combined sites
           const isCombined = Number(media.siteBillMode) === 1 ||
                             (mediaDetails.length > 0 && Number(mediaDetails[0].siteBillMode) === 1) ||
                             (media.mediaName && (media.mediaName.includes(",") || media.mediaName.includes("+") || media.mediaName.includes("/")));

           if (isCombined) {
             // Show ONE combined row for all faces (e.g., site 1 + site 2)
             const combinedCode = media.mediaCode || mediaDetails.map(m => m.mediaCode).filter(c => c).join(" / ");
             let combinedName = media.mediaName || mediaDetails.map(m => m.mediaName).join(" + ");

             // Normalize separators to " + " to match your UI request
             combinedName = combinedName.split(", ").join(" + ").split(" / ").join(" + ").split(",").join(" + ");

             reportRows.push({
                "Month": monthLabel,
                "Media Code": combinedCode,
                "Media Name": combinedName,
                "Media Type": media.mediaType || (mediaDetails[0] && mediaDetails[0].mediaType),
                "Total Landowners": owners.length,
                "Ledger Amount": Math.round(totalLedger * 100) / 100,
                "GST Amount": Math.round(totalGst * 100) / 100,
                "Total Amount": Math.round((totalLedger + totalGst) * 100) / 100
             });
             monthDataFound = true;
           } else {
             // For Separate Bill, show each face individually
             mediaDetails.forEach(mDetail => {
               const mId = String(mDetail._id);
               let dLedger = ledgerByFace.get(mId) || (siteWideLedger / mediaDetails.length);
               let dGst = gstByFace.get(mId) || (siteWideGst / mediaDetails.length);

               reportRows.push({
                  "Month": monthLabel,
                  "Media Code": mDetail.mediaCode,
                  "Media Name": mDetail.mediaName,
                  "Media Type": mDetail.mediaType,
                  "Total Landowners": owners.length,
                  "Ledger Amount": Math.round(dLedger * 100) / 100,
                  "GST Amount": Math.round(dGst * 100) / 100,
                  "Total Amount": Math.round((dLedger + dGst) * 100) / 100
               });
               monthDataFound = true;
             });
           }
        }
      }

      // Add Monthly Total row
      if (monthDataFound) {
        const totalRowIdx = reportRows.length;
        reportRows.push({
          "Month": `${monthLabel.toUpperCase()} TOTAL`,
          "Media Code": "",
          "Media Name": "",
          "Media Type": "",
          "Total Landowners": "",
          "Ledger Amount": Math.round(monthLedgerTotal * 100) / 100,
          "GST Amount": Math.round(monthGstTotal * 100) / 100,
          "Total Amount": Math.round((monthLedgerTotal + monthGstTotal) * 100) / 100
        });

        // Merge total label across columns A to E
        merges.push({ s: { r: totalRowIdx + 1, c: 0 }, e: { r: totalRowIdx + 1, c: 4 } });
        reportRows.push({}); // Spacing
      } else {
        reportRows.pop();
        merges.pop();
      }
    }

    // Create Workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(reportRows);

    // Apply header styling (Teal background, White bold text)
    const headerRange = { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }; // A1 to H1
    for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
      if (ws[cellAddress]) {
        ws[cellAddress].s = {
          fill: {
            fgColor: { rgb: "31869B" }, // Teal color from screenshot
          },
          font: {
            bold: true,
            color: { rgb: "FFFFFF" }, // White text
          },
          alignment: {
            vertical: "center",
            horizontal: "center",
          },
        };
      }
    }

    ws["!merges"] = merges;

    // Column widths
    ws["!cols"] = [
      { wch: 25 }, // Month
      { wch: 20 }, // Media Code
      { wch: 40 }, // Media Name
      { wch: 15 }, // Media Type
      { wch: 15 }, // Total Landowners
      { wch: 15 }, // Ledger
      { wch: 15 }, // GST
      { wch: 15 }, // Total
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Rental OOH Report");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Rental_OOH_Report_${fromMonth}_to_${toMonth}.xlsx`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    return res.send(buffer);

  } catch (error) {
    console.error("Excel generation error:", error);
    return errorResponse(res, "Failed to generate Excel report");
  }
};

module.exports = {
  downloadRentalOOHExcel
};
