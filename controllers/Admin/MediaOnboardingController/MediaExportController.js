// ─────────────────────────────────────────────────────────────
// ✅ NEW — Media onboarding Excel download (read only).
// GET/POST /admin/media-export-excel
//   optional filters (same meaning as /admin/media-list):
//   status   1 Active | 2 Inactive | 3 Hold | 4 Agreement expiring | 5 Agreement expired
//            (single value or array)
//   city, mediaType (value or array), search (site name / code / landowner name)
// Sheets: Summary · All Sites · Active Sites · Inactive Sites ·
//         Agreement Expiring Soon · Agreement Expired
// One row per site (faces in the same row). Nothing is written to the database.
// ─────────────────────────────────────────────────────────────
const XLSX = require("xlsx-js-style"); // same API as xlsx, plus cell styles
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { errorResponse } = require("../../../utils/response");

const SITE_STATUS = { 1: "Active", 2: "Inactive", 3: "Hold" };
const AGREEMENT_STATUS = { 1: "Active", 2: "Expiring Soon", 3: "Expired" };
const PAY_FREQ = { 1: "Monthly", 2: "Quarterly", 3: "Half-Yearly", 4: "Yearly", 5: "2 Years" };
const BILL_MODE = { 1: "Single Bill", 2: "Separate Bill" };

const toArray = (v) =>
  v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : String(v).split(",").map((x) => x.trim());
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// dd-mm-yyyy (dates are stored as IST wall time in UTC fields)
const fmtDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
};
const num = (v) => (v === undefined || v === null || v === "" ? "" : Number(v) || 0);
const yesNo = (v) => (Number(v) === 1 ? "Yes" : "No");

const payFrequencyLabel = (rp) => {
  const f = Number(rp?.paymentFrequency || 0);
  if (f === 6) return `Custom (${Number(rp?.customPaymentFrequency || 1)} months)`;
  return PAY_FREQ[f] || "";
};

// agreement expired = status 3, or end date already passed
const isAgreementExpired = (ag) => {
  if (!ag) return false;
  if (Number(ag.status) === 3) return true;
  if (!ag.endDate) return false;
  const end = new Date(ag.endDate);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return !Number.isNaN(end.getTime()) && end < today;
};

function buildFilter(params) {
  const filter = {};
  const and = [];
  const city = toArray(params.city);
  if (city.length) filter["mediaDetails.city"] = { $in: city };
  const mediaType = toArray(params.mediaType);
  if (mediaType.length) filter["mediaDetails.mediaType"] = { $in: mediaType };

  const statuses = toArray(params.status).map(Number).filter(Boolean);
  if (statuses.length) {
    const or = [];
    const plain = statuses.filter((s) => [1, 2, 3].includes(s));
    if (plain.length) or.push({ "mediaDetails.status": { $in: plain } });
    if (statuses.includes(4)) or.push({ "agreement.status": 2 });
    if (statuses.includes(5)) or.push({ "agreement.status": 3 });
    if (or.length) and.push({ $or: or });
  }

  if (params.search && String(params.search).trim()) {
    const rx = new RegExp(escapeRegex(String(params.search).trim()), "i");
    and.push({
      $or: [{ "mediaDetails.mediaName": rx }, { "mediaDetails.mediaCode": rx }, { "landOwners.name": rx }],
    });
  }
  if (and.length) filter.$and = and;
  return filter;
}

// site GST: rentalPayment values when set, otherwise from the landowners
// (each landowner's own entry for THIS site when linked to several sites)
function siteGst(media) {
  const rp = media.rentalPayment || {};
  // ✅ FIXED — the site's own landowner entry first; its linkedSites copy only
  // when the entry itself has no GST (older linkedSites rows default to 0)
  const owners = (media.landOwners || []).map((o) => {
    if (Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0) return o;
    const own = (o.linkedSites || []).find((l) => String(l.mediaId) === String(media._id));
    return own && (Number(own.gstApplicable) === 1 || Number(own.gstAmount) > 0)
      ? { ...o, gstApplicable: own.gstApplicable, gstPercentage: own.gstPercentage, gstAmount: own.gstAmount }
      : o;
  });
  const gstOwners = owners.filter(
    (o) => Number(o.gstApplicable) === 1 || Number(o.gstAmount) > 0 || String(o.gstNumber || "").trim(),
  );
  const ownerAmount = gstOwners.reduce((s, o) => s + Number(o.gstAmount || 0), 0);
  const amount = Number(rp.gstAmount) || ownerAmount;
  const percents = [
    ...new Set(
      [Number(rp.gstPercentage) || 0, ...gstOwners.map((o) => Number(o.gstPercentage) || 0)].filter((p) => p > 0),
    ),
  ];
  return {
    applicable: Number(rp.gstApplicable) === 1 || gstOwners.length > 0 || amount > 0,
    numbers: [...new Set([rp.gstNumber, ...gstOwners.map((o) => o.gstNumber)].filter(Boolean))].join(", "),
    percent: percents.length === 1 ? percents[0] : percents.join(", "),
    amount,
  };
}

// faceStatus (optional): only the faces (mediaDetails) with that status are
// listed in the row (Active / Inactive sheets); no such face → no row
function siteRows(media, faceStatus) {
  const ag = media.agreement || {};
  const rp = media.rentalPayment || {};
  const owners = media.landOwners || [];
  const faces = (media.mediaDetails || []).filter((d) => !faceStatus || Number(d.status) === faceStatus);
  if (faceStatus && !faces.length) return [];
  const expired = isAgreementExpired(ag);
  // ✅ CHANGED — ONE row per site: every face listed in the same row, so the
  // site's rent / GST amounts appear once (not repeated per face)
  const join = (key, sep = ", ") => [...new Set(faces.map((d) => d[key]).filter((v) => v !== undefined && v !== null && v !== ""))].join(sep);
  const statuses = faces.map((d) => Number(d.status));
  const siteStatus = statuses.includes(1) ? 1 : statuses.includes(3) ? 3 : statuses.includes(2) ? 2 : 0;
  const agreementStatus = expired ? "Expired" : AGREEMENT_STATUS[Number(ag.status)] || "";
  const gst = siteGst(media);
  return [{
    siteStatus,
    expired,
    expiring: agreementStatus === "Expiring Soon",
    row: {
      "Site Code": join("mediaCode", " / "),
      "Site Name": join("mediaName"),
      "No. of Faces": faces.length,
      "Media Type": join("mediaType"),
      State: join("state"),
      District: join("district"),
      City: join("city"),
      Location: join("location"),
      Size: faces.map((d) => (d.width || d.height ? `${d.width || 0} x ${d.height || 0}` : "")).filter(Boolean).join(", "),
      "Total Sq.Ft": faces.reduce((s, d) => s + Number(d.totalSqFt || 0), 0) || "",
      "Site Status": SITE_STATUS[siteStatus] || "",
      "Bill Mode": [...new Set(faces.map((d) => BILL_MODE[Number(d.siteBillMode)]).filter(Boolean))].join(", "),
      "No. of Landowners": owners.length,
      "Landowner Name": owners.map((o) => o.name).filter(Boolean).join(", "),
      "Landowner Phone": owners.map((o) => o.phone).filter(Boolean).join(", "),
      "Agreement Start": fmtDate(ag.startDate),
      "Agreement End": fmtDate(ag.endDate),
      "Agreement Status": agreementStatus,
      "Advance Rent": num(ag.advanceRent),
      "Total Rent": num(rp.totalRentalAmount),
      // ✅ FIXED — GST is saved per landowner; the site's GST = its landowners'
      // GST (this site's own amounts for a landowner linked to several sites)
      "GST Applicable": gst.applicable ? "Yes" : "No",
      "GST Number": gst.numbers,
      "GST %": gst.percent,
      "GST Amount": gst.amount,
      "Rent With GST": Number(rp.totalRentalAmountWithGst) || Number(rp.totalRentalAmount || 0) + gst.amount,
      "Net Payable": num(rp.netPayable),
      "Payment Frequency": payFrequencyLabel(rp),
      "Appraisal Applicable": yesNo(media.appraisal?.applicable),
    },
  }];
}

// ── styles ──────────────────────────────────────────────────
const BORDER = { style: "thin", color: { rgb: "BFBFBF" } };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
const HEADER_STYLE = {
  font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: "1F4E78" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: BORDERS,
};
const AMOUNT_HEADERS = /amount|rent|payable|gst amount/i;

// rows → sheet: S.No, styled header, borders, ₹ number format on amounts,
// frozen header row and column widths fitted to the content
function toSheet(rows, emptyHeaders) {
  const data = rows.map((r, i) => ({ "S.No": i + 1, ...r }));
  const headers = data.length ? Object.keys(data[0]) : ["S.No", ...emptyHeaders];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data.map((r) => headers.map((h) => r[h] ?? ""))]);

  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const ref = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[ref]) ws[ref] = { t: "s", v: "" };
      if (R === 0) {
        ws[ref].s = HEADER_STYLE;
        continue;
      }
      const isAmount = AMOUNT_HEADERS.test(headers[C]) && !/%/.test(headers[C]) && ws[ref].t === "n";
      ws[ref].s = {
        border: BORDERS,
        alignment: { vertical: "center", horizontal: ws[ref].t === "n" ? "right" : "left" },
        fill: R % 2 === 0 ? { patternType: "solid", fgColor: { rgb: "F2F6FA" } } : undefined,
      };
      if (isAmount) ws[ref].z = "#,##0";
    }
  }
  ws["!cols"] = headers.map((h) => ({
    wch: Math.min(60, Math.max(h.length, ...data.map((r) => String(r[h] ?? "").length)) + 3),
  }));
  ws["!rows"] = [{ hpt: 28 }];
  return ws;
}

// header row always visible while scrolling (frozen pane). SheetJS does not
// write freeze panes, so the sheet XML gets the pane added here.
function freezeHeaderRow(buffer) {
  try {
    const zip = XLSX.CFB.read(buffer, { type: "buffer" });
    zip.FullPaths.forEach((p, i) => {
      if (!/xl\/worksheets\/sheet\d+\.xml$/.test(p)) return;
      const entry = zip.FileIndex[i];
      const xml = Buffer.from(entry.content).toString("utf8");
      const frozen = xml.replace(
        /<sheetView workbookViewId="0"\s*\/>/,
        '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>',
      );
      if (frozen !== xml) {
        entry.content = Buffer.from(frozen, "utf8");
        entry.size = entry.content.length;
      }
    });
    return Buffer.from(XLSX.CFB.write(zip, { fileType: "zip", type: "buffer" }));
  } catch (err) {
    return buffer; // never fail the download over the freeze
  }
}

exports.exportMediaExcel = async (req, res) => {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const medias = await Media.find(buildFilter(params))
      .select("mediaDetails landOwners agreement rentalPayment appraisal.applicable createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const all = medias.flatMap((m) => siteRows(m));
    const siteHeaders = Object.keys(siteRows({ mediaDetails: [{}] })[0].row);

    // ✅ CHANGED — Active / Inactive sheets list only the faces with that status
    const active = medias.flatMap((m) => siteRows(m, 1));
    const inactive = medias.flatMap((m) => siteRows(m, 2));
    const expired = all.filter((x) => x.expired);
    const expiring = all.filter((x) => x.expiring);

    // ✅ CHANGED — Total / Active / Inactive counted from mediaDetails (faces)
    const faces = medias.flatMap((m) => m.mediaDetails || []);
    const summary = [
      { Particular: "Total Sites", Count: faces.length },
      { Particular: "Active Sites", Count: faces.filter((d) => Number(d.status) === 1).length },
      { Particular: "Inactive Sites", Count: faces.filter((d) => Number(d.status) === 2).length },
      { Particular: "Agreement Expiring Soon", Count: expiring.length },
      { Particular: "Agreement Expired", Count: expired.length },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, toSheet(summary, ["Particular", "Count"]), "Summary");
    XLSX.utils.book_append_sheet(wb, toSheet(all.map((x) => x.row), siteHeaders), "All Sites");
    XLSX.utils.book_append_sheet(wb, toSheet(active.map((x) => x.row), siteHeaders), "Active Sites");
    XLSX.utils.book_append_sheet(wb, toSheet(inactive.map((x) => x.row), siteHeaders), "Inactive Sites");
    XLSX.utils.book_append_sheet(wb, toSheet(expiring.map((x) => x.row), siteHeaders), "Agreement Expiring Soon");
    XLSX.utils.book_append_sheet(wb, toSheet(expired.map((x) => x.row), siteHeaders), "Agreement Expired");

    const buffer = freezeHeaderRow(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const d = new Date(Date.now() + 330 * 60000);
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Media_Sites_${stamp}.xlsx"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    return res.status(200).send(buffer);
  } catch (err) {
    return errorResponse(res, err.message, null, 500);
  }
};
