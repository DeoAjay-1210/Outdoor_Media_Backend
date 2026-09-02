// const mongoose = require("mongoose");
// const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
// const XLSX = require("xlsx-js-style");
// const { successResponse, errorResponse } = require("../../../utils/response");

// /**
//  * Normalize month strings (e.g. "Aug 2026" or "August 2026") to "August 2026"
//  */
// const normalizeMonth = (m) => {
//   if (!m) return "";
//   const parts = String(m).trim().split(/\s+/);
//   if (parts.length < 2) return m;
//   const monthNames = [
//     "January", "February", "March", "April", "May", "June",
//     "July", "August", "September", "October", "November", "December"
//   ];
//   const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

//   let monthPart = parts[0];
//   const yearPart = parts[1];

//   let idx = monthNames.findIndex(mn => mn.toLowerCase() === monthPart.toLowerCase());
//   if (idx === -1) {
//     idx = shortMonths.findIndex(sm => sm.toLowerCase() === monthPart.toLowerCase().substring(0, 3));
//   }

//   if (idx !== -1) {
//     return `${monthNames[idx]} ${yearPart}`;
//   }
//   return m;
// };

// /**
//  * Generate a list of months between fromMonth (MM-YYYY) and toMonth (MM-YYYY)
//  */
// function generateMonthList(fromStr, toStr) {
//   const [fromM, fromY] = fromStr.split("-").map(Number);
//   const [toM, toY] = toStr.split("-").map(Number);

//   const start = new Date(Date.UTC(fromY, fromM - 1, 1));
//   const end = new Date(Date.UTC(toY, toM - 1, 1));

//   const result = [];
//   const current = new Date(start);

//   while (current <= end) {
//     const monthName = current.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
//     const year = current.getUTCFullYear();
//     result.push({
//       label: `${monthName} ${year}`,
//       date: new Date(current)
//     });
//     current.setUTCMonth(current.getUTCMonth() + 1);
//   }
//   return result;
// }

// const downloadRentalOOHExcel = async (req, res) => {
//   try {
//     const { fromMonth, toMonth } = req.query;

//     if (!fromMonth || !toMonth) {
//       return errorResponse(res, "fromMonth and toMonth are required (format: MM-YYYY)");
//     }

//     const monthList = generateMonthList(fromMonth, toMonth);
//     const monthLabels = monthList.map(m => m.label);
//     const targetMonthNormalizedList = monthLabels.map(normalizeMonth);

//     // Fetch all media documents
//     const mediaDocs = await Media.find({
//       "mediaDetails.status": 1 // Only active media
//     }).lean();

//     const aoa = [];
//     const merges = [];

//     // --- 1. BUILD COMPACT HEADER ---
//     aoa.push(["LEDGER SUMMARY REPORT", "", "", "", "", "", "", "", ""]);
//     merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } });

//     const startMonth = monthLabels[0];
//     const endMonth = monthLabels[monthLabels.length - 1];
//     const periodText = monthLabels.length > 1 ? `${startMonth} to ${endMonth}` : startMonth;
//     aoa.push([`Report Period: ${periodText}`, "", "", "", "", "", "", "", ""]);
//     merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: 8 } });

//     const colHeaders = [
//       "📅 Month", "🆔 Media Code", "📝 Media Name", "🏗️ Media Type", "👥 Total Landowners", "👤 Landowner Name",
//       "📊 Ledger Amount (₹)", "💰 GST Amount (₹)", "🧾 Total Amount (₹)"
//     ];
//     aoa.push(colHeaders);
//     const headerRowIdx = 2;

//     let grandLedgerTotal = 0;
//     let grandGstTotal = 0;
//     let grandOwnerTotal = 0;

//     // Process each month
//     for (let i = 0; i < monthList.length; i++) {
//       const monthLabel = monthLabels[i];
//       const targetMonthNormalized = targetMonthNormalizedList[i];

//       let monthLedgerTotal = 0;
//       let monthGstTotal = 0;
//       let monthOwnerTotal = 0;
//       let monthDataRows = [];
//       let serialNo = 1;

//       const monthHeaderIdx = aoa.length;
//       aoa.push([`🗓️ ${monthLabel.toUpperCase()}`, "", "", "", "", "", "", "", ""]);
//       merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: 8 } });

//       for (const media of mediaDocs) {
//         const mediaDetails = media.mediaDetails || [];
//         const owners = media.landOwners || [];

//         const dueToMediaMap = new Map();
//         (media.rentalDue || []).forEach(d => {
//           if (d.mediaDetailId) dueToMediaMap.set(String(d._id), String(d.mediaDetailId));
//         });
//         (media.rentalDueHistory || []).forEach(yearBucket => {
//           (yearBucket.months || []).forEach(monthBucket => {
//             (monthBucket.entries || []).forEach(d => {
//               if (d.mediaDetailId) dueToMediaMap.set(String(d.rentalDueId || d._id), String(d.mediaDetailId));
//             });
//           });
//         });

//         const allLedgerEntries = [
//           ...(media.ledger || []).map(e => ({ ...e, withGst: e.withGst || 2, status: 1 })),
//           ...(media.withGst1Ledger || []).map(e => ({ ...e, withGst: e.withGst || 1, status: 1 })),
//           ...(media.rentalPayment?.rentalOutstandingHistory || [])
//             .filter(h => h.isPaid)
//             .map(h => ({ ...h, amount: h.baseRentOutstandingAmount, month: h.dueMonth, isOutstanding: true, status: 1 }))
//         ];

//         if (media.ledgerHistory) {
//           media.ledgerHistory.forEach(yb => {
//             yb.months?.forEach(mb => {
//               if (mb.entries) {
//                 mb.entries.forEach(e => {
//                   const historyWithGst = e.withGst !== undefined ? e.withGst : (e.isUtrEntry ? 1 : 2);
//                   allLedgerEntries.push({ ...e, withGst: historyWithGst, isHistory: true, status: 1 });
//                 });
//               }
//             });
//           });
//         }

//         const monthLedgerEntries = allLedgerEntries.filter(e => normalizeMonth(e.month || e.dueMonth) === targetMonthNormalized);
//         const uniqueLedgers = new Map();
//         monthLedgerEntries.forEach(e => {
//           const key = `${e.rentalDueId || e._id || "no-due"}-${e.landOwnerId || e.ownerId || "no-owner"}-${targetMonthNormalized}-${e.amount}-${e.paymentMode || "unknown"}`;
//           if (!uniqueLedgers.has(key)) uniqueLedgers.set(key, e);
//         });

//         const monthGstEntries = [
//           ...(media.gstBalanceHistory || []),
//           ...(media.rentalPayment?.gstOutstandingHistory || [])
//             .filter(g => g.isPaid)
//             .map(g => ({ ...g, gstAmount: g.gstOutStandingAmount }))
//         ].filter(g => normalizeMonth(g.dueMonth) === targetMonthNormalized);

//         const uniqueGst = new Map();
//         Array.from(uniqueLedgers.values()).filter(e => e.isUtrEntry).forEach(g => {
//           uniqueGst.set(`${g.rentalDueId || "no-due"}-${g.landOwnerId || "no-owner"}-${targetMonthNormalized}`, { amount: Number(g.amount) });
//         });
//         monthGstEntries.forEach(g => {
//           const key = `${g.rentalDueId || "no-due"}-${g.ownerId || g.landOwnerId || "rental"}-${targetMonthNormalized}`;
//           if (!uniqueGst.has(key)) uniqueGst.set(key, { amount: Number(g.gstAmount) });
//         });

//         const ledgerByFace = new Map();
//         const gstByFace = new Map();
//         const namesByFace = new Map();
//         let siteWideLedger = 0, siteWideGst = 0;
//         const siteWideNames = new Set();

//         const siteGstPct = media.rentalPayment?.gstPercentage !== undefined ? Number(media.rentalPayment.gstPercentage) : 18;
//         const isSiteGstApplicable = Number(media.rentalPayment?.gstApplicable) === 1;

//         Array.from(uniqueLedgers.values()).filter(e => !e.isUtrEntry).forEach(e => {
//           const mId = dueToMediaMap.get(String(e.rentalDueId));
//           let amt = Number(e.amount) || 0;
//           let gstAmt = 0;

//           const eWithGst = e.withGst !== undefined ? Number(e.withGst) : 2;
//           // IMPORTANT: Only split if it's EXPLICITLY inclusive (2).
//           // If it's "gst hold" (1), keep it as full Ledger amount.
//           const isInclusive = eWithGst === 2;

//           if (isInclusive && isSiteGstApplicable && amt > 0) {
//             const base = amt / (1 + (siteGstPct / 100));
//             gstAmt = Math.round(amt - base);
//             amt = Math.round(base);
//           }

//           if (mId && mId !== "SITE") {
//             ledgerByFace.set(mId, (ledgerByFace.get(mId) || 0) + amt);
//             gstByFace.set(mId, (gstByFace.get(mId) || 0) + gstAmt);
//             if (!namesByFace.has(mId)) namesByFace.set(mId, new Set());
//             if (e.landOwnerName) namesByFace.get(mId).add(e.landOwnerName);
//           } else {
//             siteWideLedger += amt;
//             siteWideGst += gstAmt;
//             if (e.landOwnerName) siteWideNames.add(e.landOwnerName);
//           }
//         });

//         uniqueGst.forEach((g, k) => {
//           const rId = k.split("-")[0];
//           const mId = dueToMediaMap.get(String(rId));
//           if (mId && mId !== "SITE") gstByFace.set(mId, (gstByFace.get(mId) || 0) + (g.amount || 0));
//           else siteWideGst += (g.amount || 0);
//         });

//         const totalLedger = Array.from(ledgerByFace.values()).reduce((a,b) => a+b, 0) + siteWideLedger;
//         const totalGst = Array.from(gstByFace.values()).reduce((a,b) => a+b, 0) + siteWideGst;

//         if (totalLedger > 0 || totalGst > 0) {
//            const isCombined = Number(media.siteBillMode) === 1 ||
//                              (mediaDetails.length > 0 && Number(mediaDetails[0].siteBillMode) === 1) ||
//                              (media.mediaName && (media.mediaName.includes(",") || media.mediaName.includes("+")));

//            if (isCombined) {
//              const combinedCode = media.mediaCode || mediaDetails.map(m => m.mediaCode).join(" / ");
//              const combinedName = (media.mediaName || mediaDetails.map(m => m.mediaName).join(", ")).split(" + ").join(", ").split(" / ").join(", ");
//              const allNames = new Set([...siteWideNames]);
//              Array.from(namesByFace.values()).forEach(s => s.forEach(n => allNames.add(n)));
//              const combinedOwnerNames = Array.from(allNames).join(", ");

//              monthDataRows.push([
//                 serialNo++, combinedCode, combinedName, media.mediaType || mediaDetails[0]?.mediaType, owners.length, combinedOwnerNames,
//                 totalLedger, totalGst, totalLedger + totalGst
//              ]);
//              monthLedgerTotal += totalLedger; monthGstTotal += totalGst; monthOwnerTotal += owners.length;
//            } else {
//              mediaDetails.forEach(mDetail => {
//                const mId = String(mDetail._id);
//                const dLedger = ledgerByFace.get(mId) || (siteWideLedger / mediaDetails.length);
//                const dGst = gstByFace.get(mId) || (siteWideGst / mediaDetails.length);
//                const dNames = Array.from(namesByFace.get(mId) || siteWideNames).join(", ");

//                monthDataRows.push([
//                   serialNo++, mDetail.mediaCode, mDetail.mediaName, mDetail.mediaType, owners.length, dNames,
//                   dLedger, dGst, dLedger + dGst
//                ]);
//                monthLedgerTotal += dLedger; monthGstTotal += dGst; monthOwnerTotal += owners.length;
//              });
//            }
//         }
//       }

//       if (monthDataRows.length > 0) {
//         aoa.push(...monthDataRows);
//         const totalRowIdx = aoa.length;
//         aoa.push([`🏷️ ${monthLabel.toUpperCase()} TOTAL`, "", "", "", monthOwnerTotal, "", monthLedgerTotal, monthGstTotal, monthLedgerTotal + monthGstTotal]);
//         merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 3 } });
//         aoa.push([]);

//         grandLedgerTotal += monthLedgerTotal;
//         grandGstTotal += monthGstTotal;
//         grandOwnerTotal += monthOwnerTotal;
//       } else {
//         aoa.pop(); merges.pop();
//       }
//     }

//     const grandTotalIdx = aoa.length;
//     const grandTotalLabel = monthLabels.length > 1
//       ? `📊 GRAND TOTAL (${startMonth} - ${endMonth})`
//       : `📊 GRAND TOTAL (${startMonth})`;

//     aoa.push([grandTotalLabel, "", "", "", grandOwnerTotal, "", grandLedgerTotal, grandGstTotal, grandLedgerTotal + grandGstTotal]);
//     merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: 3 } });

//     const wb = XLSX.utils.book_new();
//     const ws = XLSX.utils.aoa_to_sheet(aoa);

//     const styleHeader = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" }, border: { top: { style: "thin" }, bottom: { style: "thin" } } };
//     const styleMonthHeader = { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
//     const styleTotalRow = (isEven) => ({ fill: { fgColor: { rgb: isEven ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center" } });
//     const styleGrandTotal = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center" } };
//     const styleData = { alignment: { vertical: "center" }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
//     const numFormat = "₹ #,##,##0";

//     ws["A1"].s = { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center" } };
//     ws["A2"].s = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" } };

//     let monthCounter = 0;
//     for (let r = 0; r < aoa.length; r++) {
//       for (let c = 0; c < 9; c++) {
//         const addr = XLSX.utils.encode_cell({ r, c });
//         if (!ws[addr]) continue;

//         if (r === headerRowIdx) ws[addr].s = styleHeader;
//         else if (aoa[r][0] && String(aoa[r][0]).startsWith("🗓️")) ws[addr].s = styleMonthHeader;
//         else if (aoa[r][0] && String(aoa[r][0]).startsWith("🏷️")) {
//           ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
//           if (c >= 6) ws[addr].z = numFormat;
//           if (c === 8) monthCounter++;
//         } else if (aoa[r][0] && String(aoa[r][0]).startsWith("📊")) {
//           ws[addr].s = styleGrandTotal;
//           if (c >= 6) ws[addr].z = numFormat;
//         } else if (r > headerRowIdx && aoa[r].length > 0) {
//           ws[addr].s = { ...styleData, alignment: { horizontal: (c === 0 || c === 4 || c >= 6) ? "center" : "left" } };
//           if (c >= 6) ws[addr].z = numFormat;
//         }
//       }
//     }

//     ws["!merges"] = merges;
//     ws["!cols"] = [{ wch: 15 }, { wch: 20 }, { wch: 40 }, { wch: 20 }, { wch: 25 }, { wch: 35 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];
//     ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 35 }];

//     XLSX.utils.book_append_sheet(wb, ws, "Rental OOH Report");
//     const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

//     res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
//     res.setHeader("Content-Disposition", `attachment; filename=Rental_OOH_Report_${fromMonth}_to_${toMonth}.xlsx`);
//     res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
//     return res.send(buffer);

//   } catch (error) {
//     console.error("Excel generation error:", error);
//     return errorResponse(res, "Failed to generate Excel report");
//   }
// };

// module.exports = {
//   downloadRentalOOHExcel
// };







const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const XLSX = require("xlsx-js-style");
const { successResponse, errorResponse } = require("../../../utils/response");

/**
 * Normalize month strings (e.g. "Aug 2026" or "August 2026") to "August 2026"
 */
const normalizeMonth = (m) => {
  if (!m) return "";
  const parts = String(m).trim().split(/\s+/);
  if (parts.length < 2) return m;
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let monthPart = parts[0];
  const yearPart = parts[1];

  let idx = monthNames.findIndex(mn => mn.toLowerCase() === monthPart.toLowerCase());
  if (idx === -1) {
    idx = shortMonths.findIndex(sm => sm.toLowerCase() === monthPart.toLowerCase().substring(0, 3));
  }

  if (idx !== -1) {
    return `${monthNames[idx]} ${yearPart}`;
  }
  return m;
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
    const targetMonthNormalizedList = monthLabels.map(normalizeMonth);

    // Fetch all media documents
    const mediaDocs = await Media.find({
      "mediaDetails.status": 1 // Only active media
    }).lean();

    const aoa = [];
    const merges = [];

    // --- 1. BUILD COMPACT HEADER ---
    aoa.push(["LEDGER SUMMARY REPORT", "", "", "", "", "", "", "", ""]);
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } });

    const startMonth = monthLabels[0];
    const endMonth = monthLabels[monthLabels.length - 1];
    const periodText = monthLabels.length > 1 ? `${startMonth} to ${endMonth}` : startMonth;
    aoa.push([`Report Period: ${periodText}`, "", "", "", "", "", "", "", ""]);
    merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: 8 } });

    const colHeaders = [
      "📅 Month", "🆔 Media Code", "📝 Media Name", "🏗️ Media Type", "👥 Total Landowners", "👤 Landowner Name",
      "📊 Ledger Amount (₹)", "💰 GST Amount (₹)", "🧾 Total Amount (₹)"
    ];
    aoa.push(colHeaders);
    const headerRowIdx = 2;

    let grandLedgerTotal = 0;
    let grandGstTotal = 0;
    let grandOwnerTotal = 0;

    // Process each month
    for (let i = 0; i < monthList.length; i++) {
      const monthLabel = monthLabels[i];
      const targetMonthNormalized = targetMonthNormalizedList[i];

      let monthLedgerTotal = 0;
      let monthGstTotal = 0;
      let monthOwnerTotal = 0;
      let monthDataRows = [];
      let serialNo = 1;

      const monthHeaderIdx = aoa.length;
      aoa.push([`🗓️ ${monthLabel.toUpperCase()}`, "", "", "", "", "", "", "", ""]);
      merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: 8 } });

      for (const media of mediaDocs) {
        const mediaDetails = media.mediaDetails || [];
        const owners = media.landOwners || [];

        const dueToMediaMap = new Map();
        (media.rentalDue || []).forEach(d => {
          if (d.mediaDetailId) dueToMediaMap.set(String(d._id), String(d.mediaDetailId));
        });
        (media.rentalDueHistory || []).forEach(yearBucket => {
          (yearBucket.months || []).forEach(monthBucket => {
            (monthBucket.entries || []).forEach(d => {
              if (d.mediaDetailId) dueToMediaMap.set(String(d.rentalDueId || d._id), String(d.mediaDetailId));
            });
          });
        });

        const allLedgerEntries = [
          ...(media.ledger || []).map(e => ({ ...e, withGst: e.withGst || 2, status: 1 })),
          ...(media.withGst1Ledger || []).map(e => ({ ...e, withGst: e.withGst || 1, status: 1 })),
          ...(media.rentalPayment?.rentalOutstandingHistory || [])
            .filter(h => h.isPaid)
            .map(h => ({ ...h, amount: h.baseRentOutstandingAmount, month: h.dueMonth, isOutstanding: true, status: 1, withGst: 1 }))
        ];

        if (media.ledgerHistory) {
          media.ledgerHistory.forEach(yb => {
            yb.months?.forEach(mb => {
              if (mb.entries) {
                mb.entries.forEach(e => {
                  const historyWithGst = e.withGst !== undefined ? e.withGst : (e.isUtrEntry ? 1 : 2);
                  allLedgerEntries.push({ ...e, withGst: historyWithGst, isHistory: true, status: 1 });
                });
              }
            });
          });
        }

        const monthLedgerEntries = allLedgerEntries.filter(e => normalizeMonth(e.month || e.dueMonth) === targetMonthNormalized);
        const uniqueLedgers = new Map();
        monthLedgerEntries.forEach(e => {
          const key = `${e.rentalDueId || e._id || "no-due"}-${e.landOwnerId || e.ownerId || "no-owner"}-${targetMonthNormalized}-${e.amount}-${e.paymentMode || "unknown"}`;
          if (!uniqueLedgers.has(key)) uniqueLedgers.set(key, e);
        });

        const monthGstEntries = [
          ...(media.gstBalanceHistory || []),
          ...(media.rentalPayment?.gstOutstandingHistory || [])
            .filter(g => g.isPaid)
            .map(g => ({ ...g, gstAmount: g.gstOutStandingAmount }))
        ].filter(g => normalizeMonth(g.dueMonth) === targetMonthNormalized);

        const uniqueGst = new Map();
        Array.from(uniqueLedgers.values()).filter(e => e.isUtrEntry).forEach(g => {
          const key = `${g.rentalDueId || "no-due"}-${g.landOwnerId || g.ownerId || "no-owner"}-${targetMonthNormalized}`;
          const current = uniqueGst.get(key)?.amount || 0;
          uniqueGst.set(key, { amount: current + Number(g.amount) });
        });
        monthGstEntries.forEach(g => {
          const key = `${g.rentalDueId || "no-due"}-${g.landOwnerId || g.ownerId || "no-owner"}-${targetMonthNormalized}`;
          if (!uniqueGst.has(key)) {
            uniqueGst.set(key, { amount: Number(g.gstAmount) });
          }
        });

        const ledgerByFace = new Map();
        const gstByFace = new Map();
        const namesByFace = new Map();
        let siteWideLedger = 0, siteWideGst = 0;
        const siteWideNames = new Set();

        const siteGstPct = media.rentalPayment?.gstPercentage !== undefined ? Number(media.rentalPayment.gstPercentage) : 18;
        const isSiteGstApplicable = Number(media.rentalPayment?.gstApplicable) === 1;

        Array.from(uniqueLedgers.values()).filter(e => !e.isUtrEntry).forEach(e => {
          const mId = dueToMediaMap.get(String(e.rentalDueId));
          const eWithGst = e.withGst !== undefined ? Number(e.withGst) : 2;

          const rIdStr = e.rentalDueId ? String(e.rentalDueId) : "no-due";
          const oIdStr = (e.landOwnerId || e.ownerId) ? String(e.landOwnerId || e.ownerId) : "no-owner";

          const primaryGstKey = `${rIdStr}-${oIdStr}-${targetMonthNormalized}`;
          const fallbackGstKey = `fallback-${oIdStr}-${targetMonthNormalized}`;

          let ledgerAmt = Number(e.amount) || 0;
          let gstAmt = 0;

          // Find the owner configuration to get the canonical base/gst split
          const owner = owners.find(o => String(o._id) === oIdStr);

          // Improved applicability check: check flags OR check if config has GST values
          const isGstApplicableForThisRow =
            (media.rentalPayment?.gstApplicable === 1) ||
            (owner?.gstApplicable === 1) ||
            (Number(media.rentalPayment?.gstPercentage) > 0) ||
            (owner && Number(owner.gstPercentage) > 0) ||
            (Number(media.rentalPayment?.gstAmount) > 0);

          // 1. Check if a corresponding GST entry exists in the ledger (PRIORITY to prevent doubling)
          let existingGst = uniqueGst.get(primaryGstKey);
          if (!existingGst) {
            // Fallback: search for any entry for this owner/month if rId mismatch
            for (const [key, val] of uniqueGst.entries()) {
              if (key.includes(`-${oIdStr}-${targetMonthNormalized}`)) {
                existingGst = val;
                uniqueGst.delete(key);
                break;
              }
            }
          } else {
            uniqueGst.delete(primaryGstKey);
          }

          if (existingGst) {
            // If an explicit GST entry exists, use its actual amount
            gstAmt = Math.round(Number(existingGst.amount) || 0);
            if (eWithGst === 2 && isGstApplicableForThisRow) {
              // If the main entry was inclusive, subtract the real GST entry amount to get the base
              ledgerAmt = ledgerAmt - gstAmt;
            }
          } else if (isGstApplicableForThisRow) {
            // Configuration values
            let baseShare = owner ? Number(owner.shareAmount || 0) : (Number(media.rentalPayment?.totalRentalAmount || 0) / (owners.length || 1));
            let gstShare = owner ? Number(owner.gstAmount || 0) : (Number(media.rentalPayment?.gstAmount || 0) / (owners.length || 1));

            // Fallback: If gstShare is 0 but percentage exists, calculate it
            if (gstShare === 0 && siteGstPct > 0) {
               gstShare = baseShare * (siteGstPct / 100);
            }

            const totalWithGst = baseShare + gstShare;

            if (totalWithGst > 0 && Math.abs(ledgerAmt - totalWithGst) < 10) {
              // It's the total amount. Split it into configured base and gst.
              ledgerAmt = Math.round(baseShare);
              gstAmt = Math.round(gstShare);
            } else if (baseShare > 0 && Math.abs(ledgerAmt - baseShare) < 10) {
              // It's the base amount. Use config base and show config gst.
              ledgerAmt = Math.round(baseShare);
              gstAmt = Math.round(gstShare);
            } else {
              // Fallback for partials or non-standard amounts
              if (eWithGst === 2) {
                const base = ledgerAmt / (1 + (siteGstPct / 100));
                gstAmt = Math.round(ledgerAmt - base);
                ledgerAmt = Math.round(base);
              } else {
                gstAmt = Math.round(ledgerAmt * (siteGstPct / 100));
              }
            }
          } else {
            gstAmt = 0;
            ledgerAmt = Math.round(ledgerAmt);
          }

          if (mId && mId !== "SITE") {
            ledgerByFace.set(mId, (ledgerByFace.get(mId) || 0) + ledgerAmt);
            gstByFace.set(mId, (gstByFace.get(mId) || 0) + gstAmt);
            if (!namesByFace.has(mId)) namesByFace.set(mId, new Set());
            if (e.landOwnerName) namesByFace.get(mId).add(e.landOwnerName);
          } else {
            siteWideLedger += ledgerAmt;
            siteWideGst += gstAmt;
            if (e.landOwnerName) siteWideNames.add(e.landOwnerName);
          }
        });

        // Restore handling for standalone GST entries (e.g. GST-only payments)
        uniqueGst.forEach((g, k) => {
          const rId = k.split("-")[0];
          const mId = dueToMediaMap.get(String(rId));
          if (mId && mId !== "SITE") gstByFace.set(mId, (gstByFace.get(mId) || 0) + (g.amount || 0));
          else siteWideGst += (g.amount || 0);
        });

        const totalLedger = Array.from(ledgerByFace.values()).reduce((a,b) => a+b, 0) + siteWideLedger;
        const totalGst = Array.from(gstByFace.values()).reduce((a,b) => a+b, 0) + siteWideGst;

        if (totalLedger > 0 || totalGst > 0) {
           const isCombined = Number(media.siteBillMode) === 1 ||
                             (mediaDetails.length > 0 && Number(mediaDetails[0].siteBillMode) === 1) ||
                             (media.mediaName && (media.mediaName.includes(",") || media.mediaName.includes("+")));

           if (isCombined) {
             const combinedCode = media.mediaCode || mediaDetails.map(m => m.mediaCode).join(" / ");
             const combinedName = (media.mediaName || mediaDetails.map(m => m.mediaName).join(", ")).split(" + ").join(", ").split(" / ").join(", ");
             const allNames = new Set([...siteWideNames]);
             Array.from(namesByFace.values()).forEach(s => s.forEach(n => allNames.add(n)));
             const combinedOwnerNames = Array.from(allNames).join(", ");

             monthDataRows.push([
                serialNo++, combinedCode, combinedName, media.mediaType || mediaDetails[0]?.mediaType, owners.length, combinedOwnerNames,
                totalLedger, totalGst, totalLedger + totalGst
             ]);
             monthLedgerTotal += totalLedger; monthGstTotal += totalGst; monthOwnerTotal += owners.length;
           } else {
             mediaDetails.forEach(mDetail => {
               const mId = String(mDetail._id);
               const dLedger = ledgerByFace.get(mId) || (siteWideLedger / mediaDetails.length);
               const dGst = gstByFace.get(mId) || (siteWideGst / mediaDetails.length);
               const dNames = Array.from(namesByFace.get(mId) || siteWideNames).join(", ");

               monthDataRows.push([
                  serialNo++, mDetail.mediaCode, mDetail.mediaName, mDetail.mediaType, owners.length, dNames,
                  dLedger, dGst, dLedger + dGst
               ]);
               monthLedgerTotal += dLedger; monthGstTotal += dGst; monthOwnerTotal += owners.length;
             });
           }
        }
      }

      if (monthDataRows.length > 0) {
        aoa.push(...monthDataRows);
        const totalRowIdx = aoa.length;
        aoa.push([`🏷️ ${monthLabel.toUpperCase()} TOTAL`, "", "", "", monthOwnerTotal, "", monthLedgerTotal, monthGstTotal, monthLedgerTotal + monthGstTotal]);
        merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 3 } });
        aoa.push([]);

        grandLedgerTotal += monthLedgerTotal;
        grandGstTotal += monthGstTotal;
        grandOwnerTotal += monthOwnerTotal;
      } else {
        aoa.pop(); merges.pop();
      }
    }

    const grandTotalIdx = aoa.length;
    const grandTotalLabel = monthLabels.length > 1
      ? `📊 GRAND TOTAL (${startMonth} - ${endMonth})`
      : `📊 GRAND TOTAL (${startMonth})`;

    aoa.push([grandTotalLabel, "", "", "", grandOwnerTotal, "", grandLedgerTotal, grandGstTotal, grandLedgerTotal + grandGstTotal]);
    merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: 3 } });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    const styleHeader = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" }, border: { top: { style: "thin" }, bottom: { style: "thin" } } };
    const styleMonthHeader = { fill: { fgColor: { rgb: "E9F0FD" } }, font: { color: { rgb: "002D62" }, bold: true }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
    const styleTotalRow = (isEven) => ({ fill: { fgColor: { rgb: isEven ? "003399" : "38761D" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center" } });
    const styleGrandTotal = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center" } };
    const styleData = { alignment: { vertical: "center" }, border: { bottom: { style: "thin", color: { rgb: "D1D4D7" } } } };
    const numFormat = "₹ #,##,##0";

    ws["A1"].s = { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center" } };
    ws["A2"].s = { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" } };

    let monthCounter = 0;
    for (let r = 0; r < aoa.length; r++) {
      for (let c = 0; c < 9; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) continue;

        if (r === headerRowIdx) ws[addr].s = styleHeader;
        else if (aoa[r][0] && String(aoa[r][0]).startsWith("🗓️")) ws[addr].s = styleMonthHeader;
        else if (aoa[r][0] && String(aoa[r][0]).startsWith("🏷️")) {
          ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
          if (c >= 6) ws[addr].z = numFormat;
          if (c === 8) monthCounter++;
        } else if (aoa[r][0] && String(aoa[r][0]).startsWith("📊")) {
          ws[addr].s = styleGrandTotal;
          if (c >= 6) ws[addr].z = numFormat;
        } else if (r > headerRowIdx && aoa[r].length > 0) {
          ws[addr].s = { ...styleData, alignment: { horizontal: (c === 0 || c === 4 || c >= 6) ? "center" : "left" } };
          if (c >= 6) ws[addr].z = numFormat;
        }
      }
    }

    ws["!merges"] = merges;
    ws["!cols"] = [{ wch: 15 }, { wch: 20 }, { wch: 40 }, { wch: 20 }, { wch: 25 }, { wch: 35 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];
    ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 35 }];

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