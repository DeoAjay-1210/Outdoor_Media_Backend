const mongoose = require("mongoose");
const Media = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const XLSX = require("xlsx-js-style");
const zlib = require("zlib");
const { successResponse, errorResponse } = require("../../../utils/response");

// Helper function to calculate CRC32 of a Buffer
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ -1) >>> 0;
}

/**
 * Injects <pane ySplit="N"/> into sheet1.xml of the generated XLSX ZIP buffer
 * to ensure freeze panes work reliably in MS Excel, Google Sheets, and LibreOffice.
 */
function freezeHeaderInXlsxBuffer(buf, freezeRows = 3) {
  try {
    let eocdPos = buf.length - 22;
    while (eocdPos >= 0) {
      if (buf[eocdPos] === 0x50 && buf[eocdPos+1] === 0x4b && buf[eocdPos+2] === 0x05 && buf[eocdPos+3] === 0x06) {
        break;
      }
      eocdPos--;
    }

    if (eocdPos < 0) return buf;

    const cdCount = buf.readUInt16LE(eocdPos + 10);
    const cdOffset = buf.readUInt32LE(eocdPos + 16);

    const entries = [];
    let cdPos = cdOffset;

    for (let i = 0; i < cdCount; i++) {
      if (buf[cdPos] !== 0x50 || buf[cdPos+1] !== 0x4b || buf[cdPos+2] !== 0x01 || buf[cdPos+3] !== 0x02) {
        break;
      }

      const compMethod = buf.readUInt16LE(cdPos + 10);
      const crc = buf.readUInt32LE(cdPos + 16);
      const compSize = buf.readUInt32LE(cdPos + 20);
      const uncompSize = buf.readUInt32LE(cdPos + 24);
      const fnLen = buf.readUInt16LE(cdPos + 28);
      const extraLen = buf.readUInt16LE(cdPos + 30);
      const commentLen = buf.readUInt16LE(cdPos + 32);
      const localOffset = buf.readUInt32LE(cdPos + 42);

      const fn = buf.toString("utf8", cdPos + 46, cdPos + 46 + fnLen);

      const localFnLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localFnLen + localExtraLen;
      const rawData = buf.subarray(dataStart, dataStart + compSize);

      entries.push({
        fn,
        compMethod,
        crc,
        compSize,
        uncompSize,
        data: rawData,
        extra: buf.subarray(localOffset + 30 + localFnLen, dataStart),
        cdExtra: buf.subarray(cdPos + 46 + fnLen, cdPos + 46 + fnLen + extraLen),
        cdComment: buf.subarray(cdPos + 46 + fnLen + extraLen, cdPos + 46 + fnLen + extraLen + commentLen),
      });

      cdPos += 46 + fnLen + extraLen + commentLen;
    }

    const sheetEntry = entries.find((e) => e.fn === "xl/worksheets/sheet1.xml");
    if (!sheetEntry) return buf;

    let xmlStr;
    if (sheetEntry.compMethod === 8) {
      xmlStr = zlib.inflateRawSync(sheetEntry.data).toString("utf8");
    } else {
      xmlStr = sheetEntry.data.toString("utf8");
    }

    const paneXml = `<pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/>`;
    let modifiedXml;
    if (xmlStr.includes("</sheetView>")) {
      modifiedXml = xmlStr.replace("</sheetView>", `${paneXml}</sheetView>`);
    } else {
      modifiedXml = xmlStr.replace(/<sheetView([^/>]*)\/>/, `<sheetView$1>${paneXml}</sheetView>`);
    }

    const newXmlBuf = Buffer.from(modifiedXml, "utf8");
    const newCompBuf = zlib.deflateRawSync(newXmlBuf);

    sheetEntry.compMethod = 8;
    sheetEntry.crc = crc32(newXmlBuf);
    sheetEntry.compSize = newCompBuf.length;
    sheetEntry.uncompSize = newXmlBuf.length;
    sheetEntry.data = newCompBuf;

    const localParts = [];
    const cdParts = [];
    let currentOffset = 0;

    for (const entry of entries) {
      const fnBuf = Buffer.from(entry.fn, "utf8");
      const localHeader = Buffer.alloc(30);

      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 6);
      localHeader.writeUInt16LE(entry.compMethod, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(entry.crc, 14);
      localHeader.writeUInt32LE(entry.compSize, 18);
      localHeader.writeUInt32LE(entry.uncompSize, 22);
      localHeader.writeUInt16LE(fnBuf.length, 26);
      localHeader.writeUInt16LE(entry.extra.length, 28);

      const entryLocalOffset = currentOffset;
      localParts.push(localHeader, fnBuf, entry.extra, entry.data);
      currentOffset += localHeader.length + fnBuf.length + entry.extra.length + entry.data.length;

      const cdHeader = Buffer.alloc(46);
      cdHeader.writeUInt32LE(0x02014b50, 0);
      cdHeader.writeUInt16LE(20, 4);
      cdHeader.writeUInt16LE(20, 6);
      cdHeader.writeUInt16LE(0, 8);
      cdHeader.writeUInt16LE(entry.compMethod, 10);
      cdHeader.writeUInt16LE(0, 12);
      cdHeader.writeUInt16LE(0, 14);
      cdHeader.writeUInt32LE(entry.crc, 16);
      cdHeader.writeUInt32LE(entry.compSize, 20);
      cdHeader.writeUInt32LE(entry.uncompSize, 24);
      cdHeader.writeUInt16LE(fnBuf.length, 28);
      cdHeader.writeUInt16LE(entry.cdExtra.length, 30);
      cdHeader.writeUInt16LE(entry.cdComment.length, 32);
      cdHeader.writeUInt16LE(0, 34);
      cdHeader.writeUInt16LE(0, 36);
      cdHeader.writeUInt32LE(0, 38);
      cdHeader.writeUInt32LE(entryLocalOffset, 42);

      cdParts.push(cdHeader, fnBuf, entry.cdExtra, entry.cdComment);
    }

    const newCdOffset = currentOffset;
    const cdBuf = Buffer.concat(cdParts);
    const newCdSize = cdBuf.length;

    const newEocd = Buffer.alloc(22);
    newEocd.writeUInt32LE(0x06054b50, 0);
    newEocd.writeUInt16LE(0, 4);
    newEocd.writeUInt16LE(0, 6);
    newEocd.writeUInt16LE(entries.length, 8);
    newEocd.writeUInt16LE(entries.length, 10);
    newEocd.writeUInt32LE(newCdSize, 12);
    newEocd.writeUInt32LE(newCdOffset, 16);
    newEocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, cdBuf, newEocd]);
  } catch (err) {
    console.error("❌ Error freezing header rows in XLSX:", err.message);
    return buf;
  }
}

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
    aoa.push(["LEDGER SUMMARY REPORT", "", "", "", "", "", "", "", "", ""]);
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } });

    const startMonth = monthLabels[0];
    const endMonth = monthLabels[monthLabels.length - 1];
    const periodText = monthLabels.length > 1 ? `${startMonth} to ${endMonth}` : startMonth;
    aoa.push([`Report Period: ${periodText}`, "", "", "", "", "", "", "", "", ""]);
    merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: 9 } });

    const colHeaders = [
      "📅 Month", "🆔 Media Code", "📝 Media Name", "🏗️ Media Type", "👥 Total Landowners", "👤 Landowner Name",
      "📌 GST Applicable", "📊 Rent Amount (₹)", "💰 GST Amount (₹)", "🧾 Total Amount (₹)"
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
      aoa.push([`🗓️ ${monthLabel.toUpperCase()}`, "", "", "", "", "", "", "", "", ""]);
      merges.push({ s: { r: monthHeaderIdx, c: 0 }, e: { r: monthHeaderIdx, c: 9 } });

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
          ...(media.gstBalanceHistory || []).filter(
            (g) =>
              g.isPaid === true ||
              g.isPaid === "true" ||
              Number(g.paidAmount) > 0 ||
              (g.utrNumber && String(g.utrNumber).trim() !== "" && g.date),
          ),
          ...(media.rentalPayment?.gstOutstandingHistory || [])
            .filter(
              (g) =>
                g.isPaid === true ||
                g.isPaid === "true" ||
                Number(g.paidAmount) > 0 ||
                (g.utrNumber && String(g.utrNumber).trim() !== "" && g.date),
            )
            .map((g) => ({ ...g, gstAmount: g.gstOutStandingAmount })),
        ].filter((g) => normalizeMonth(g.dueMonth) === targetMonthNormalized);

        const fallbackOwnerId = (owners && owners[0])
          ? String(owners[0]._id || owners[0].landOwnerMasterId || "no-owner")
          : "no-owner";

        const resolveOwnerId = (obj) => {
          if (!obj) return fallbackOwnerId;
          const id = obj.landOwnerId || obj.ownerId;
          return id ? String(id) : fallbackOwnerId;
        };

        const uniqueGst = new Map();
        Array.from(uniqueLedgers.values())
          .filter((e) => e.isUtrEntry === true)
          .forEach((g) => {
            const oIdStr = resolveOwnerId(g);
            const key = `${oIdStr}-${targetMonthNormalized}`;
            const amt = Number(g.amount || 0);
            const current = uniqueGst.get(key)?.amount || 0;
            uniqueGst.set(key, { amount: Math.max(current, amt) });
          });

        monthGstEntries.forEach((g) => {
          const oIdStr = resolveOwnerId(g);
          const key = `${oIdStr}-${targetMonthNormalized}`;
          const amt = Number(g.gstAmount || g.paidAmount || 0);
          const current = uniqueGst.get(key)?.amount || 0;
          uniqueGst.set(key, { amount: Math.max(current, amt) });
        });

        const ledgerByFace = new Map();
        const gstByFace = new Map();
        const namesByFace = new Map();
        let siteWideLedger = 0, siteWideGst = 0;
        const siteWideNames = new Set();
        const gstProcessedForOwnerMonth = new Set();

        const siteGstPct = media.rentalPayment?.gstPercentage !== undefined ? Number(media.rentalPayment.gstPercentage) : 18;
        const isSiteGstApplicable = Number(media.rentalPayment?.gstApplicable) === 1;

        Array.from(uniqueLedgers.values())
          .filter((e) => !e.isUtrEntry)
          .forEach((e) => {
            const mId = dueToMediaMap.get(String(e.rentalDueId));
            const eWithGst = e.withGst !== undefined ? Number(e.withGst) : 2;

            const oIdStr = resolveOwnerId(e);

            const primaryGstKey = `${oIdStr}-${targetMonthNormalized}`;
            const gstOwnerKey = `${oIdStr}-${targetMonthNormalized}`;
            const alreadyProcessedGst = gstProcessedForOwnerMonth.has(gstOwnerKey);

            let ledgerAmt = Number(e.amount) || 0;
            let gstAmt = 0;

            const owner = owners.find(
              (o) =>
                String(o._id) === oIdStr ||
                String(o.landOwnerMasterId) === oIdStr,
            );

            const isGstApplicableForThisRow =
              Number(media.rentalPayment?.gstApplicable) === 1 ||
              Number(owner?.gstApplicable) === 1 ||
              Number(media.rentalPayment?.gstPercentage) > 0 ||
              (owner && Number(owner.gstPercentage) > 0) ||
              Number(media.rentalPayment?.gstAmount) > 0;

            // Find if an actual GST entry exists for this owner/month
            let existingGst = uniqueGst.get(primaryGstKey);
            if (!existingGst) {
              // Fallback: search for any entry for this owner/month
              for (const [key, val] of uniqueGst.entries()) {
                if (key.endsWith(`-${targetMonthNormalized}`)) {
                  existingGst = val;
                  uniqueGst.delete(key);
                  break;
                }
              }
            } else {
              uniqueGst.delete(primaryGstKey);
            }

            if (existingGst) {
              // If an explicit GST entry was made, use its actual amount
              gstAmt = Math.round(Number(existingGst.amount) || 0);
              if (eWithGst === 2 && ledgerAmt > gstAmt) {
                ledgerAmt = ledgerAmt - gstAmt;
              }
              gstProcessedForOwnerMonth.add(gstOwnerKey);
            } else if (eWithGst === 2 && isGstApplicableForThisRow && !alreadyProcessedGst) {
              // withGst === 2 (Direct GST mode): GST amount is automatically included / calculated from ledger entry ONCE per owner/month
              let baseShare = owner
                ? Number(owner.shareAmount || 0)
                : Number(media.rentalPayment?.totalRentalAmount || 0) /
                  (owners.length || 1);
              let gstShare = owner
                ? Number(owner.gstAmount || 0)
                : Number(media.rentalPayment?.gstAmount || 0) /
                  (owners.length || 1);

              if (gstShare === 0 && siteGstPct > 0) {
                gstShare = baseShare * (siteGstPct / 100);
              }

              const totalWithGst = baseShare + gstShare;

              if (totalWithGst > 0 && Math.abs(ledgerAmt - totalWithGst) < 10) {
                ledgerAmt = Math.round(baseShare);
                gstAmt = Math.round(gstShare);
              } else if (baseShare > 0 && Math.abs(ledgerAmt - baseShare) < 10) {
                ledgerAmt = Math.round(baseShare);
                gstAmt = Math.round(gstShare);
              } else {
                const base = ledgerAmt / (1 + siteGstPct / 100);
                gstAmt = Math.round(ledgerAmt - base);
                ledgerAmt = Math.round(base);
              }
              gstProcessedForOwnerMonth.add(gstOwnerKey);
            } else {
              // withGst === 1 (Hold GST mode) or already processed GST for this owner/month:
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

        // Restore handling for standalone GST entries (e.g. GST-only payments) where GST was NOT consumed by the ledger loop
        uniqueGst.forEach((g, k) => {
          const oIdFromKey = k.split("-")[0];
          const gstOwnerKey = `${oIdFromKey}-${targetMonthNormalized}`;
          if (gstProcessedForOwnerMonth.has(gstOwnerKey)) return;

          const rId = k.split("-")[0];
          const mId = dueToMediaMap.get(String(rId));
          if (mId && mId !== "SITE") gstByFace.set(mId, (gstByFace.get(mId) || 0) + (g.amount || 0));
          else siteWideGst += (g.amount || 0);

          gstProcessedForOwnerMonth.add(gstOwnerKey);
        });

        const totalLedger = Array.from(ledgerByFace.values()).reduce((a,b) => a+b, 0) + siteWideLedger;
        const totalGst = Array.from(gstByFace.values()).reduce((a,b) => a+b, 0) + siteWideGst;

        const isGstApplicableSite =
          Number(media.rentalPayment?.gstApplicable) === 1 ||
          (media.landOwners || []).some(
            (o) =>
              Number(o.gstApplicable) === 1 ||
              Number(o.gstPercentage) > 0 ||
              Number(o.gstAmount) > 0,
          ) ||
          Number(media.rentalPayment?.gstPercentage) > 0 ||
          Number(media.rentalPayment?.gstAmount) > 0 ||
          Number(media.gstApplicableFlag) === 1 ||
          Number(media.gstApplicableFlag) === 2;

        const gstApplyText = isGstApplicableSite ? "Yes" : "No";

        if (totalLedger > 0 || totalGst > 0) {
           const isCombined = Number(media.siteBillMode) === 1 ||
                             (mediaDetails.length > 0 && Number(mediaDetails[0].siteBillMode) === 1) ||
                             (media.mediaName && (media.mediaName.includes(",") || media.mediaName.includes("+")));

           if (isCombined) {
             const rawCode = mediaDetails.length > 0
               ? mediaDetails.map(m => m.mediaCode).filter(Boolean).join(", ")
               : (media.mediaCode || "");
             const combinedCode = String(rawCode).split(" / ").join(", ").split(" + ").join(", ");

             const rawName = mediaDetails.length > 0
               ? mediaDetails.map(m => m.mediaName).filter(Boolean).join(", ")
               : (media.mediaName || "");
             const combinedName = String(rawName).split(" + ").join(", ").split(" / ").join(", ");

             const rawType = mediaDetails.length > 0
               ? mediaDetails.map(m => m.mediaType).filter(Boolean).join(", ")
               : (media.mediaType || "");
             const combinedMediaType = String(rawType).split(" / ").join(", ").split(" + ").join(", ");

             const allNames = new Set([...siteWideNames]);
             Array.from(namesByFace.values()).forEach(s => s.forEach(n => allNames.add(n)));
             let combinedOwnerNames = Array.from(allNames).filter(Boolean).join(", ");
             if (!combinedOwnerNames) {
               combinedOwnerNames = owners.map(o => o.name).filter(Boolean).join(", ");
             }

             monthDataRows.push([
                serialNo++, combinedCode, combinedName, combinedMediaType, owners.length, combinedOwnerNames,
                gstApplyText, totalLedger, totalGst, totalLedger + totalGst
             ]);
             monthLedgerTotal += totalLedger; monthGstTotal += totalGst; monthOwnerTotal += owners.length;
           } else {
             mediaDetails.forEach(mDetail => {
               const mId = String(mDetail._id);
               const dLedger = ledgerByFace.get(mId) || (siteWideLedger / mediaDetails.length);
               const dGst = gstByFace.get(mId) || (siteWideGst / mediaDetails.length);
               let dNames = Array.from(namesByFace.get(mId) || siteWideNames).filter(Boolean).join(", ");
               if (!dNames) {
                 dNames = owners.map(o => o.name).filter(Boolean).join(", ");
               }

               monthDataRows.push([
                  serialNo++, mDetail.mediaCode, mDetail.mediaName, mDetail.mediaType, owners.length, dNames,
                  gstApplyText, dLedger, dGst, dLedger + dGst
               ]);
               monthLedgerTotal += dLedger; monthGstTotal += dGst; monthOwnerTotal += owners.length;
             });
           }
        }
      }

      if (monthDataRows.length > 0) {
        aoa.push(...monthDataRows);
        const totalRowIdx = aoa.length;
        aoa.push([`🏷️ ${monthLabel.toUpperCase()} TOTAL`, "", "", "", monthOwnerTotal, "", "", monthLedgerTotal, monthGstTotal, monthLedgerTotal + monthGstTotal]);
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

    aoa.push([grandTotalLabel, "", "", "", grandOwnerTotal, "", "", grandLedgerTotal, grandGstTotal, grandLedgerTotal + grandGstTotal]);
    merges.push({ s: { r: grandTotalIdx, c: 0 }, e: { r: grandTotalIdx, c: 3 } });

    const wb = XLSX.utils.book_new();
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
      for (let c = 0; c < 10; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) continue;

        if (r === headerRowIdx) ws[addr].s = styleHeader;
        else if (aoa[r][0] && String(aoa[r][0]).startsWith("🗓️")) ws[addr].s = styleMonthHeader;
        else if (aoa[r][0] && String(aoa[r][0]).startsWith("🏷️")) {
          ws[addr].s = styleTotalRow(monthCounter % 2 === 0);
          if (c >= 7) ws[addr].z = numFormat;
          if (c === 9) monthCounter++;
        } else if (aoa[r][0] && String(aoa[r][0]).startsWith("📊")) {
          ws[addr].s = styleGrandTotal;
          if (c >= 7) ws[addr].z = numFormat;
        } else if (r > headerRowIdx && aoa[r].length > 0) {
          ws[addr].s = {
            ...styleData,
            alignment: {
              vertical: "center",
              wrapText: true,
              horizontal: (c === 0 || c === 4 || c === 6 || c >= 7) ? "center" : "left"
            }
          };
          if (c >= 7) ws[addr].z = numFormat;
        }
      }
    }

    ws["!merges"] = merges;
    ws["!freeze"] = {
      xSplit: "0",
      ySplit: "3",
      topLeftCell: "A4",
      activePane: "bottomLeft",
      state: "frozen"
    };
    ws["!views"] = [
      {
        state: "frozen",
        xSplit: 0,
        ySplit: 3,
        topLeftCell: "A4",
        activePane: "bottomLeft"
      }
    ];
    ws["!cols"] = [
      { wch: 15 }, // A: Month #
      { wch: 20 }, // B: Media Code
      { wch: 40 }, // C: Media Name
      { wch: 20 }, // D: Media Type
      { wch: 20 }, // E: Total Landowners
      { wch: 35 }, // F: Landowner Name
      { wch: 18 }, // G: GST Applicable
      { wch: 20 }, // H: Rent Amount
      { wch: 20 }, // I: GST Amount
      { wch: 20 }  // J: Total Amount
    ];
    ws["!rows"] = [{ hpt: 35 }, { hpt: 25 }, { hpt: 35 }];

    XLSX.utils.book_append_sheet(wb, ws, "Rental OOH Report");
    const rawBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const buffer = freezeHeaderInXlsxBuffer(rawBuffer, 3);

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