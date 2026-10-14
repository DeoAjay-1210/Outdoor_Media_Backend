const mongoose = require("mongoose");
const XLSX = require("xlsx-js-style");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { errorResponse } = require("../../../utils/response");
const { freezeHeaderInXlsxBuffer } = require("../MediaOnboardingController/RentalOOHExcelController");

// ─────────────────────────────────────────────────────────────
// LANDOWNER EXCEL (site first)
// GET /admin/landowner/download-excel?landOwnerMasterId=&search=
// One block per active site (A → Z): S.No / Site Name / Site Code are shown
// once (merged) and every landowner of the site gets one row. A site total
// row is added only when the site has 2+ landowners; grand total at the end.
// Read-only — nothing is saved.
//   Total Rental Amount = landowner's share of the site rent (shareAmount)
//   TDS Amount          = landowner's TDS — ALREADY INCLUDED in Total Rental
//                         Amount (shown for reference, not added again)
//   GST Amount          = landowner's own GST, or — when GST is charged at
//                         site level — the landowner's share of the site GST
//   Total Amount        = Total Rental Amount + GST Amount
// ─────────────────────────────────────────────────────────────
const AGREEMENT_MODE_LABEL = { 1: "Single Agreement", 2: "Separate Agreement" };
const BILL_MODE_LABEL = { 1: "Single Bill", 2: "Separate Bill" };

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const downloadLandOwnerExcel = async (req, res) => {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const landOwnerMasterId =
      typeof params.landOwnerMasterId === "string" ? params.landOwnerMasterId.trim() : "";
    const search = typeof params.search === "string" ? params.search.trim() : "";

    if (landOwnerMasterId && !mongoose.Types.ObjectId.isValid(landOwnerMasterId)) {
      return errorResponse(res, "Invalid landOwnerMasterId", null, 400);
    }

    const filter = { "mediaDetails.status": 1 };
    if (landOwnerMasterId) {
      filter["landOwners.landOwnerMasterId"] = new mongoose.Types.ObjectId(landOwnerMasterId);
    }

    const medias = await Media.find(filter).select("mediaDetails rentalPayment landOwners").lean();
    const searchRegex = search ? new RegExp(escapeRegex(search), "i") : null;

    // ── one block per site, one row per landowner of that site ──
    const sites = [];
    for (const media of medias) {
      const activeFaces = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);
      const siteName = activeFaces.map((d) => d.mediaName).filter(Boolean).join(", ") || "-";
      const siteCode = activeFaces.map((d) => d.mediaCode).filter(Boolean).join(", ") || "-";
      const rp = media.rentalPayment || {};
      const siteRent = Number(rp.totalRentalAmount || 0);
      const siteGstOn = Number(rp.gstApplicable) === 1;
      const siteGst = Number(rp.gstAmount || 0);
      const faceBillMode = activeFaces.some((d) => Number(d.siteBillMode) === 2) ? 2 : activeFaces.length ? 1 : null;
      const siteMatches = searchRegex ? searchRegex.test(siteName) || searchRegex.test(siteCode) : true;

      const owners = [];
      for (const owner of media.landOwners || []) {
        if (landOwnerMasterId && String(owner.landOwnerMasterId || "") !== landOwnerMasterId) continue;
        const ownerName = owner.name || "-";
        if (searchRegex && !siteMatches && !searchRegex.test(ownerName)) continue;

        const rental = Math.round(Number(owner.shareAmount || 0));
        let gst = 0;
        if (siteGstOn && siteGst > 0) {
          gst = siteRent > 0 ? Math.round((siteGst * rental) / siteRent) : 0;
        } else if (Number(owner.gstApplicable) === 1) {
          gst = Math.round(Number(owner.gstAmount || 0));
        }

        const tds = Number(owner.tdsApplicable) === 1 ? Math.round(Number(owner.tdsAmount || 0)) : 0;

        // typeShare 1 = percentage of the site rent, 2 = fixed amount
        const shareText =
          Number(owner.typeShare) === 1
            ? `${Number(owner.sharePercentage || 0)}%`
            : Number(owner.typeShare) === 2
              ? `Fixed ₹${Math.round(Number(owner.shareAmount || 0)).toLocaleString("en-IN")}`
              : "-";

        owners.push({
          name: ownerName,
          shareText,
          tds,
          agreementMode: AGREEMENT_MODE_LABEL[Number(owner.agreementBillMode)] || "-",
          billMode: BILL_MODE_LABEL[Number(owner.landOwnerBillMode) || faceBillMode] || "-",
          rental,
          gst,
        });
      }
      if (owners.length) sites.push({ siteName, siteCode, owners });
    }
    sites.sort(
      (a, b) =>
        a.siteName.localeCompare(b.siteName, "en", { sensitivity: "base" }) ||
        a.siteCode.localeCompare(b.siteCode, "en", { sensitivity: "base" }),
    );

    // ── sheet ──
    const colHeaders = [
      "S.No", "Site Name", "Site Code", "Landowner Name", "Share (% / Fixed)", "Agreement Mode", "Bill Mode",
      "Total Rental Amount (₹)", "TDS Amount (₹)\n(included in Total Rental)", "GST Amount (₹)", "Total Amount (₹)",
    ];
    const LAST_COL = colHeaders.length - 1;
    const COL_RENTAL = 7, COL_TDS = 8, COL_GST = 9, COL_TOTAL = 10;
    const CENTER_COLS = new Set([0, 4, 5, 6]);
    const blankRow = (first) => [first, ...Array(LAST_COL).fill("")];
    const FREEZE_ROWS = 4; // title, summary, note, header

    const aoa = [];
    const merges = [];
    const rowKind = []; // per aoa row: "title" | "sub" | "header" | "data" | "siteTotal" | "grand" | "empty"
    const rowShade = []; // per aoa row: true → light grey site block

    const push = (row, kind, shade = false) => {
      aoa.push(row);
      rowKind.push(kind);
      rowShade.push(shade);
    };

    push(blankRow("LANDOWNER REPORT"), "title");
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST_COL } });
    const generatedOn = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
    const ownerCount = new Set(sites.flatMap((s) => s.owners.map((o) => o.name.toLowerCase()))).size;
    push(blankRow(`${sites.length} active ${sites.length === 1 ? "site" : "sites"} • ${ownerCount} ${ownerCount === 1 ? "landowner" : "landowners"} • Generated on ${generatedOn}`), "sub");
    merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST_COL } });
    push(blankRow("Note: TDS Amount is already included in the Total Rental Amount — it is shown for reference only and is not added again. Total Amount = Total Rental Amount + GST Amount."), "note");
    merges.push({ s: { r: 2, c: 0 }, e: { r: 2, c: LAST_COL } });
    push(colHeaders, "header");

    let grandRental = 0;
    let grandTds = 0;
    let grandGst = 0;
    sites.forEach((site, i) => {
      const shade = i % 2 === 1;
      const firstRowIdx = aoa.length;
      let siteRental = 0;
      let siteTds = 0;
      let siteGst = 0;
      site.owners.forEach((o, j) => {
        push(
          [
            j === 0 ? i + 1 : "",
            j === 0 ? site.siteName : "",
            j === 0 ? site.siteCode : "",
            o.name,
            o.shareText,
            o.agreementMode,
            o.billMode,
            o.rental,
            o.tds,
            o.gst,
            o.rental + o.gst,
          ],
          "data",
          shade,
        );
        siteRental += o.rental;
        siteTds += o.tds;
        siteGst += o.gst;
      });
      // S.No / Site Name / Site Code shown once for the whole site block
      if (site.owners.length > 1) {
        const lastRowIdx = aoa.length - 1;
        [0, 1, 2].forEach((c) => merges.push({ s: { r: firstRowIdx, c }, e: { r: lastRowIdx, c } }));
        const totalRow = blankRow("");
        totalRow[3] = `Site Total (${site.owners.length} landowners)`;
        totalRow[COL_RENTAL] = siteRental;
        totalRow[COL_TDS] = siteTds;
        totalRow[COL_GST] = siteGst;
        totalRow[COL_TOTAL] = siteRental + siteGst;
        push(totalRow, "siteTotal", shade);
        merges.push({ s: { r: aoa.length - 1, c: 3 }, e: { r: aoa.length - 1, c: COL_RENTAL - 1 } });
      }
      grandRental += siteRental;
      grandTds += siteTds;
      grandGst += siteGst;
    });

    let noRecordsRowIdx = -1;
    if (sites.length) {
      const grand = blankRow(`GRAND TOTAL (${sites.length} ${sites.length === 1 ? "site" : "sites"})`);
      grand[COL_RENTAL] = grandRental;
      grand[COL_TDS] = grandTds;
      grand[COL_GST] = grandGst;
      grand[COL_TOTAL] = grandRental + grandGst;
      push(grand, "grand");
      merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: COL_RENTAL - 1 } });
    } else {
      noRecordsRowIdx = aoa.length;
      push(blankRow("No landowners found for the selected filters"), "empty");
      merges.push({ s: { r: noRecordsRowIdx, c: 0 }, e: { r: noRecordsRowIdx, c: LAST_COL } });
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    const thin = { style: "thin", color: { rgb: "D1D4D7" } };
    const allBorders = { top: thin, bottom: thin, left: thin, right: thin };
    const numFormat = "₹ #,##,##0";
    const styles = {
      title: { fill: { fgColor: { rgb: "FFFFFF" } }, font: { size: 18, bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center" } },
      note: { fill: { fgColor: { rgb: "FFF8E1" } }, font: { italic: true, bold: true, color: { rgb: "8A5300" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } },
      sub: { fill: { fgColor: { rgb: "E9F0FD" } }, font: { bold: true, color: { rgb: "002D62" } }, alignment: { horizontal: "center", vertical: "center" } },
      header: { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: allBorders },
      grand: { fill: { fgColor: { rgb: "002D62" } }, font: { color: { rgb: "FFFFFF" }, bold: true }, alignment: { horizontal: "center", vertical: "center" }, border: allBorders },
    };

    for (let r = 0; r < aoa.length; r++) {
      const kind = rowKind[r];
      for (let c = 0; c <= LAST_COL; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) continue;
        const isAmount = c >= COL_RENTAL && c <= COL_TOTAL;

        if (kind === "title" || kind === "sub" || kind === "note" || kind === "header" || kind === "grand") {
          ws[addr].s = styles[kind];
          if (kind === "grand" && isAmount) {
            ws[addr].z = numFormat;
            ws[addr].s = { ...styles.grand, alignment: { horizontal: "right", vertical: "center" } };
          }
        } else if (kind === "data" || kind === "siteTotal") {
          const isTotal = kind === "siteTotal";
          ws[addr].s = {
            fill: { fgColor: { rgb: rowShade[r] ? "F3F6FA" : "FFFFFF" } },
            border: allBorders,
            font: isTotal ? { bold: true, color: { rgb: "002D62" } } : c === 1 || c === 2 ? { bold: true } : {},
            alignment: {
              vertical: "center",
              wrapText: true,
              horizontal: isAmount ? "right" : isTotal && c === 3 ? "right" : CENTER_COLS.has(c) ? "center" : "left",
            },
          };
          if (isAmount) ws[addr].z = numFormat;
          if (c === COL_TDS) ws[addr].s.font = { ...(ws[addr].s.font || {}), italic: true, color: { rgb: "8A5300" } };
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
      { wch: 7 }, // S.No
      { wch: 34 }, // Site Name
      { wch: 20 }, // Site Code
      { wch: 32 }, // Landowner Name
      { wch: 18 }, // Share (% / Fixed)
      { wch: 20 }, // Agreement Mode
      { wch: 15 }, // Bill Mode
      { wch: 22 }, // Total Rental Amount
      { wch: 24 }, // TDS Amount (included in Total Rental)
      { wch: 16 }, // GST Amount
      { wch: 18 }, // Total Amount
    ];
    ws["!rows"] = [{ hpt: 30 }, { hpt: 20 }, { hpt: 30 }, { hpt: 34 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Landowners");
    const rawBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const buffer = freezeHeaderInXlsxBuffer(rawBuffer, FREEZE_ROWS);

    const fileDate = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Landowner_Report_${fileDate}.xlsx`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    return res.send(buffer);
  } catch (error) {
    console.error("Landowner Excel generation error:", error);
    return errorResponse(res, "Failed to generate landowner Excel report", null, 500);
  }
};

module.exports = { downloadLandOwnerExcel };
