const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const XLSX = require("xlsx");
const { successResponse, errorResponse } = require("../../../utils/response");
const { getDueMonthLabel } = require("../../../utils/Datehelpers");

const FREQ_LABEL = {
  1: "Monthly",
  2: "Quarterly",
  3: "Half-Yearly",
  4: "Yearly",
  5: "2 Years",
  6: "Custom"
};

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

    const siteDetailsRows = [];
    const monthlySummary = monthLabels.map(label => ({
      Month: label,
      TotalSites: new Set(),
      TotalMedia: new Set(),
      TotalLandowners: new Set(),
      OverallLedger: 0,
      OverallGstLedger: 0,
      OverallNetAmount: 0
    }));

    const ledgerAuditRows = [];

    // Process each month
    for (let i = 0; i < monthList.length; i++) {
      const monthLabel = monthLabels[i];
      const summary = monthlySummary[i];

      for (const media of mediaDocs) {
        const siteCode = media.siteCode || "N/A";
        const mediaDetails = media.mediaDetails || [];
        const owners = media.landOwners || [];

        // Deduplicate ledger entries for this month
        // We look into media.ledger, media.withGst1Ledger, and media.ledgerHistory
        const allLedgerEntries = [
          ...(media.ledger || []),
          ...(media.withGst1Ledger || [])
        ];

        // Also check ledgerHistory
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

        // Filter approved entries for this month
        const monthLedgerEntries = allLedgerEntries.filter(e =>
          (e.month === monthLabel || e.dueMonth === monthLabel) &&
          (e.status === 1 || e.isUtrEntry === true)
        );

        // Deduplicate by rentalDueId + landOwnerId + month + amount (if needed)
        // Use a Map to keep unique entries
        const uniqueLedgers = new Map();
        monthLedgerEntries.forEach(e => {
          const key = `${e.rentalDueId || "no-due"}-${e.landOwnerId || "no-owner"}-${monthLabel}-${e.amount}-${e.paymentMode || "unknown"}`;
          if (!uniqueLedgers.has(key)) {
            uniqueLedgers.set(key, e);
          }
        });

        // GST Balance History
        const monthGstEntries = (media.gstBalanceHistory || []).filter(g =>
          g.dueMonth === monthLabel && (g.isPaid || (g.utrNumber && g.utrNumber.trim() !== ""))
        );
        const uniqueGst = new Map();
        monthGstEntries.forEach(g => {
          const key = `${g.rentalDueId}-${g.ownerId || "rental"}-${monthLabel}-${g.gstAmount}`;
          if (!uniqueGst.has(key)) {
            uniqueGst.set(key, g);
          }
        });

        // Track totals for summary
        let siteLedgerTotal = 0;
        let siteGstTotal = 0;

        // Map data per landowner
        for (const owner of owners) {
          const ownerId = String(owner.ownerId || owner._id);
          const ownerName = owner.name || "Unknown";

          // Calculate Ledger for this owner in this month
          const ownerLedger = Array.from(uniqueLedgers.values())
            .filter(e => String(e.landOwnerId) === ownerId)
            .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

          // Calculate GST for this owner in this month
          const ownerGst = monthGstEntries
            .filter(g => g.source === "owner" && String(g.ownerId) === ownerId)
            .reduce((sum, g) => sum + (Number(g.gstAmount) || 0), 0);

          if (ownerLedger > 0 || ownerGst > 0) {
            summary.TotalSites.add(siteCode);
            summary.TotalLandowners.add(ownerId);

            siteLedgerTotal += ownerLedger;
            siteGstTotal += ownerGst;

            for (const mDetail of mediaDetails) {
              summary.TotalMedia.add(mDetail.mediaCode);

              siteDetailsRows.push({
                Month: monthLabel,
                "Site Code": siteCode,
                "Media Code": mDetail.mediaCode,
                "Media Name": mDetail.mediaName,
                "Media Type": mDetail.mediaType,
                State: mDetail.state,
                City: mDetail.city,
                Location: mDetail.location,
                "Total Sq Ft": mDetail.totalSqFt,
                "Landowner Name": ownerName,
                "Landowner Master ID": owner.landOwnerMasterId || "N/A",
                "Share Percentage": owner.sharePercentage ? `${owner.sharePercentage}%` : "0%",
                "Share Amount": owner.shareAmount || 0,
                "Rental Amount": media.rentalPayment?.totalRentalAmount || 0,
                "Payment Frequency": FREQ_LABEL[media.rentalPayment?.paymentFrequency] || "N/A",
                "Payment Mode": owner.paymentCategory === 1 ? "Cash" : owner.paymentCategory === 2 ? "Online" : "Cash+Online",
                "Online Amount": owner.onlineAmount || 0,
                "Cash Amount": owner.cashAmount || 0,
                "TDS Amount": owner.tdsAmount || 0,
                "GST Amount": ownerGst,
                "Ledger Amount": ownerLedger,
                "Net Payable": ownerLedger + ownerGst,
                "UTR Number": Array.from(uniqueLedgers.values())
                  .filter(e => String(e.landOwnerId) === ownerId)
                  .map(e => e.utrNumber)
                  .filter(u => u)
                  .join(", "),
                "Ledger Status": "Approved",
                "Rental Due Status": "Paid"
              });
            }
          }
        }

        // Handle Rental source GST (site-level)
        const rentalGst = monthGstEntries
          .filter(g => g.source === "rental")
          .reduce((sum, g) => sum + (Number(g.gstAmount) || 0), 0);

        siteGstTotal += rentalGst;

        // If there was only rental GST and no owner-specific ledger/gst,
        // we should still probably show it in the summary.

        summary.OverallLedger += siteLedgerTotal;
        summary.OverallGstLedger += siteGstTotal;
        summary.OverallNetAmount += (siteLedgerTotal + siteGstTotal);

        // Add to audit rows
        uniqueLedgers.forEach(e => {
          ledgerAuditRows.push({
            Month: monthLabel,
            SiteCode: siteCode,
            LandOwner: e.landOwnerName,
            Amount: e.amount,
            UTR: e.utrNumber,
            Date: e.date,
            Mode: e.paymentMode,
            Type: e.withGst === 1 ? "withGST" : "withoutGST"
          });
        });
      }
    }

    // Format summary for sheet
    const summarySheetData = monthlySummary.map(s => ({
      Month: s.Month,
      "Total Sites": s.TotalSites.size,
      "Total Media": s.TotalMedia.size,
      "Total Landowners": s.TotalLandowners.size,
      "Overall Ledger Amount": s.OverallLedger,
      "Overall GST Ledger Amount": s.OverallGstLedger,
      "Overall Net Amount": s.OverallNetAmount
    }));

    // Create Workbook
    const wb = XLSX.utils.book_new();

    // Sheet 1: Monthly Summary
    const wsSummary = XLSX.utils.json_to_sheet(summarySheetData);
    XLSX.utils.book_append_sheet(wb, wsSummary, "Monthly Summary");

    // Sheet 2: Site Monthly Details
    const wsDetails = XLSX.utils.json_to_sheet(siteDetailsRows);
    XLSX.utils.book_append_sheet(wb, wsDetails, "Site Monthly Details");

    // Sheet 3: Ledger Details (Audit)
    const wsAudit = XLSX.utils.json_to_sheet(ledgerAuditRows);
    XLSX.utils.book_append_sheet(wb, wsAudit, "Ledger Details");

    // Generate buffer
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Rental_OOH_Report_${fromMonth}_to_${toMonth}.xlsx`);

    return res.send(buffer);

  } catch (error) {
    console.error("Excel generation error:", error);
    return errorResponse(res, "Failed to generate Excel report");
  }
};

module.exports = {
  downloadRentalOOHExcel
};
