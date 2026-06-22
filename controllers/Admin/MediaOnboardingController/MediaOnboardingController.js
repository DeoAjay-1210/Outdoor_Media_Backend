// controllers/Admin/MediaOnboardingController.js

const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
// const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingExcelSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const path = require("path");
const XLSX = require("xlsx");
// ─────────────────────────────────────────────────────────────
// GENERATE MEDIA ID
// ─────────────────────────────────────────────────────────────
async function generateAdminMediaId() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const prefix = `${year}${month}${day}`;

  const lastMedia = await MediaOnboarding.findOne({
    mediaId: { $regex: `^${prefix}MED#` },
  })
    .sort({ mediaId: -1 })
    .limit(1);

  let nextNumber = 1;

  if (lastMedia) {
    const match = lastMedia.mediaId.match(/#(\d+)$/);
    if (match) {
      nextNumber = parseInt(match[1]) + 1;
    }
  }

  let mediaId = `${prefix}MED#${nextNumber}`;
  let exists = await MediaOnboarding.findOne({ mediaId });

  while (exists) {
    nextNumber++;
    mediaId = `${prefix}MED#${nextNumber}`;
    exists = await MediaOnboarding.findOne({ mediaId });
  }

  return mediaId;
}

// ─────────────────────────────────────────────────────────────
// VALIDATE LAND OWNERS SHARE
//
// FIX: Shares must sum to the NET payable amount (after TDS),
//      not the gross totalRentalAmount.
//
// Flow:
//   1. Compute netPayable = totalRentalAmount - (TDS if applicable)
//   2. typeShare=1 owners → their share = netPayable * (sharePercentage / 100)
//   3. typeShare=2 owners → their share = shareAmount (fixed, as given)
//   4. Sum of all owner shares must equal netPayable (±1 tolerance)
// ─────────────────────────────────────────────────────────────
const validateLandOwnerShares = (
  landOwners,
  totalRentalAmount,
  tdsApplicable,
  tdsPercentage,
) => {
  // Step 1 — compute net payable after TDS
  const tdsAmount =
    tdsApplicable === 1 && tdsPercentage > 0
      ? parseFloat(((totalRentalAmount * tdsPercentage) / 100).toFixed(2))
      : 0;

  const netPayable = parseFloat((totalRentalAmount - tdsAmount).toFixed(2));

  let totalComputedAmount = 0;

  for (const owner of landOwners) {
    const typeShare = Number(owner.typeShare);

    if (typeShare === 1) {
      // typeShare=1 → percentage of NET payable
      const sharePercentage = Number(owner.sharePercentage);
      if (
        isNaN(sharePercentage) ||
        sharePercentage < 0 ||
        sharePercentage > 100
      ) {
        return {
          valid: false,
          message: `Owner "${owner.name}": sharePercentage must be between 0 and 100 when typeShare is 1`,
        };
      }
      totalComputedAmount += parseFloat(
        ((netPayable * sharePercentage) / 100).toFixed(2),
      );
    } else if (typeShare === 2) {
      // typeShare=2 → fixed shareAmount
      const shareAmount = Number(owner.shareAmount);
      if (isNaN(shareAmount) || shareAmount < 0) {
        return {
          valid: false,
          message: `Owner "${owner.name}": shareAmount is required and must be >= 0 when typeShare is 2`,
        };
      }
      totalComputedAmount += parseFloat(shareAmount.toFixed(2));
    } else {
      return {
        valid: false,
        message: `Owner "${owner.name}": typeShare must be 1 (percentage) or 2 (fixed amount)`,
      };
    }
  }

  // ±1 tolerance for floating point rounding
  const diff = Math.abs(totalComputedAmount - netPayable);
  if (diff > 1) {
    return {
      valid: false,
      message: `Total owner share  does not match net payable amount (${netPayable.toFixed(2)}) after TDS deduction of ${tdsAmount.toFixed(2)}. Difference: ${diff.toFixed(2)}`,
    };
  }

  return { valid: true };
};

// ─────────────────────────────────────────────────────────────
// VALIDATE PAYMENT MODE
// ─────────────────────────────────────────────────────────────
const validatePaymentMode = (rentalPayment, landOwners) => {
  const globalMode = rentalPayment?.paymentMode;

  if (!globalMode) {
    for (const owner of landOwners) {
      if (!owner.paymentMode) {
        return {
          valid: false,
          message: `Owner "${owner.name}": paymentMode is required when rentalPayment.paymentMode is not set`,
        };
      }
    }
  }

  return { valid: true };
};
const APPRAISAL_FREQUENCY_MONTHS = { 1: 6, 2: 12, 3: 24 };
const APPRAISAL_FREQUENCY_LABEL = {
  1: "6 Months",
  2: "Yearly (12 Months)",
  3: "2 Years (24 Months)",
};
const validateAppraisalFrequency = (agreement, appraisal) => {
  if (Number(appraisal?.applicable) !== 1) {
    return { valid: true };
  }
  const startDate = agreement?.startDate ? new Date(agreement.startDate) : null;
  const endDate = agreement?.endDate ? new Date(agreement.endDate) : null;
  const frequency = Number(appraisal?.frequency);
  if (!startDate || !endDate) {
    return {
      valid: false,
      message: "agreement.startDate and agreement.endDate are required when appraisal.applicable is 1",
    };
  }
  const months = APPRAISAL_FREQUENCY_MONTHS[frequency];
  if (!months) {
    return {
      valid: false,
      message: "appraisal.frequency must be 1 (6 Months), 2 (Yearly) or 3 (2 Years)",
    };
  }
  const candidateDate = new Date(startDate);
  candidateDate.setMonth(candidateDate.getMonth() + months);
  if (candidateDate >= endDate) {
    const label = APPRAISAL_FREQUENCY_LABEL[frequency];
    return {
      valid: false,
      message: `Appraisal frequency "${label}" is not applicable for this agreement. Agreement runs from ${startDate.toLocaleDateString("en-GB")} to ${endDate.toLocaleDateString("en-GB")}, but the next appraisal (${candidateDate.toLocaleDateString("en-GB")}) would fall on or after the agreement end date. Choose a shorter appraisal frequency or extend the agreement.`,
    };
  }
  return { valid: true };
};
// ─────────────────────────────────────────────────────────────
// PROCESS FILES HELPER
// ─────────────────────────────────────────────────────────────
const processUploadedFile = (uploadedFile, documentData, req) => {
  if (uploadedFile) {
    const { getFileUrl } = require("../../../middleware/dynamicFileUpload");

    let fileType = "other";

    if (uploadedFile.mimetype.startsWith("image/")) {
      fileType = "image";
    } else if (uploadedFile.mimetype === "application/pdf") {
      fileType = "pdf";
    }

    return {
      originalName: uploadedFile.originalname,
      fileName: uploadedFile.filename || uploadedFile.key?.split("/").pop(),
      filePath: getFileUrl(uploadedFile),
      mimeType: uploadedFile.mimetype,
      size: uploadedFile.size,
      fileType,
      uploadedAt: new Date(),
    };
  }

  return documentData || null;
};

// ─────────────────────────────────────────────────────────────
// MEDIA ONBOARDING — CREATE / UPDATE
// ─────────────────────────────────────────────────────────────
const mediaOnboarding = async (req, res) => {
  try {
    const { id } = req.body;
    const mediaData = req.body;

    // ── Parse JSON strings from FormData ──────────────────
    const jsonFields = [
      "landOwners",
      "rentalPayment",
      "agreement",
      "appraisal",
    ];

    jsonFields.forEach((field) => {
      if (mediaData[field] && typeof mediaData[field] === "string") {
        try {
          mediaData[field] = JSON.parse(mediaData[field]);
        } catch {
          // leave as-is if parse fails
        }
      }
    });

    // ── Convert numeric values ─────────────────────────────
    if (mediaData.rentalPayment) {
      if (mediaData.rentalPayment.totalRentalAmount) {
        mediaData.rentalPayment.totalRentalAmount = Number(
          mediaData.rentalPayment.totalRentalAmount,
        );
      }
      if (mediaData.rentalPayment.paymentFrequency) {
        mediaData.rentalPayment.paymentFrequency = Number(
          mediaData.rentalPayment.paymentFrequency,
        );
      }
      // NOTE: tdsApplicable can be 0, so check for existence not truthiness
      if (mediaData.rentalPayment.tdsApplicable !== undefined) {
        mediaData.rentalPayment.tdsApplicable = Number(
          mediaData.rentalPayment.tdsApplicable,
        );
      }
      if (mediaData.rentalPayment.paymentMode) {
        mediaData.rentalPayment.paymentMode = Number(
          mediaData.rentalPayment.paymentMode,
        );
      }
    }

    // Convert landOwners data
    if (mediaData.landOwners && Array.isArray(mediaData.landOwners)) {
      mediaData.landOwners = mediaData.landOwners.map((owner) => ({
        ...owner,
        typeShare: Number(owner.typeShare),
        sharePercentage: owner.sharePercentage
          ? Number(owner.sharePercentage)
          : undefined,
        shareAmount: owner.shareAmount ? Number(owner.shareAmount) : undefined,
        paymentMode: owner.paymentMode ? Number(owner.paymentMode) : undefined,
      }));
    }

    // Convert agreement dates
    if (mediaData.agreement) {
      if (mediaData.agreement.startDate) {
        mediaData.agreement.startDate = new Date(mediaData.agreement.startDate);
      }
      if (mediaData.agreement.endDate) {
        mediaData.agreement.endDate = new Date(mediaData.agreement.endDate);
      }
      if (mediaData.agreement.reminderBeforeExpiry) {
        mediaData.agreement.reminderBeforeExpiry = Number(
          mediaData.agreement.reminderBeforeExpiry,
        );
      }
    }

    // Convert rentalPayment dates
    if (mediaData.rentalPayment) {
      if (mediaData.rentalPayment.lastBillPaidDate) {
        mediaData.rentalPayment.lastBillPaidDate = new Date(
          mediaData.rentalPayment.lastBillPaidDate,
        );
      }
    }

    // Convert appraisal
    if (mediaData.appraisal) {
      if (mediaData.appraisal.applicable !== undefined) {
        mediaData.appraisal.applicable = Number(mediaData.appraisal.applicable);
      }
      if (mediaData.appraisal.type) {
        mediaData.appraisal.type = Number(mediaData.appraisal.type);
      }
      if (mediaData.appraisal.percentage) {
        mediaData.appraisal.percentage = Number(mediaData.appraisal.percentage);
      }
      if (mediaData.appraisal.fixedAmount) {
        mediaData.appraisal.fixedAmount = Number(
          mediaData.appraisal.fixedAmount,
        );
      }
      if (mediaData.appraisal.frequency) {
        mediaData.appraisal.frequency = Number(mediaData.appraisal.frequency);
      }
      if (mediaData.appraisal.nextAppraisalDate) {
        mediaData.appraisal.nextAppraisalDate = new Date(
          mediaData.appraisal.nextAppraisalDate,
        );
      }
    }
// ── Validate appraisal frequency against agreement duration ──
  if (mediaData.appraisal && mediaData.agreement) {
      const appraisalCheck = validateAppraisalFrequency(
        mediaData.agreement,
        mediaData.appraisal,
      );
      if (!appraisalCheck.valid) {
        return errorResponse(res, appraisalCheck.message, null, 400);
      }
    }
    // Convert other numeric fields
    if (mediaData.width) mediaData.width = Number(mediaData.width);
    if (mediaData.height) mediaData.height = Number(mediaData.height);
    if (mediaData.status) mediaData.status = Number(mediaData.status);
    if (mediaData.numberOfLandOwners)
      mediaData.numberOfLandOwners = Number(mediaData.numberOfLandOwners);

    // ── Validate paymentMode ───────────────────────────────
    if (mediaData.landOwners?.length && mediaData.rentalPayment) {
      const pmCheck = validatePaymentMode(
        mediaData.rentalPayment,
        mediaData.landOwners,
      );
      if (!pmCheck.valid) {
        return errorResponse(res, pmCheck.message, null, 400);
      }
    }

    // ── Validate land owner shares ─────────────────────────
    // FIX: Pass tdsApplicable and tdsPercentage so validation uses netPayable
    if (
      mediaData.landOwners?.length &&
      mediaData.rentalPayment?.totalRentalAmount
    ) {
      const tdsApplicable = Number(mediaData.rentalPayment.tdsApplicable) || 0;

      // Read TDS % from .env (same logic as pre-save hook)
      const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");
      const tdsPercentage =
        tdsApplicable === 1
          ? envTdsPercent > 0
            ? envTdsPercent
            : Number(mediaData.rentalPayment.tdsPercentage || 0)
          : 0;

      const shareCheck = validateLandOwnerShares(
        mediaData.landOwners,
        Number(mediaData.rentalPayment.totalRentalAmount),
        tdsApplicable,
        tdsPercentage,
      );

      if (!shareCheck.valid) {
        return errorResponse(res, shareCheck.message, null, 400);
      }
    }

    // ── File Uploads ───────────────────────────────────────
    // Agreement PDF
    const uploadedAgreementPDF = req.files?.agreementPDF?.[0];

    if (uploadedAgreementPDF) {
      if (!mediaData.agreement) {
        mediaData.agreement = {};
      }
      mediaData.agreement.agreementPDF = req.processFile(uploadedAgreementPDF);
    }

    // Front View
    const uploadedFrontView = req.files?.frontView?.[0];
    if (uploadedFrontView) {
      mediaData.frontView = req.processFile(uploadedFrontView);
    }

    // Side View
    const uploadedSideView = req.files?.sideView?.[0];
    if (uploadedSideView) {
      mediaData.sideView = req.processFile(uploadedSideView);
    }

    // Location View
    const uploadedLocationView = req.files?.locationView?.[0];
    if (uploadedLocationView) {
      mediaData.locationView = req.processFile(uploadedLocationView);
    }

    // Additional Images — FIX: was incorrectly using locationView key
    const uploadedAdditionalView = req.files?.additionalImages?.[0];
    if (uploadedAdditionalView) {
      mediaData.additionalImages = req.processFile(uploadedAdditionalView);
    }

    // ── Create or Update ───────────────────────────────────
    let media;
    let isNew = false;

    if (id) {
      // UPDATE
      media = await MediaOnboarding.findById(id);

      if (!media) {
        return errorResponse(res, "Media not found with this ID", null, 404);
      }

      delete mediaData.id;

      Object.keys(mediaData).forEach((key) => {
        if (!["_id", "__v", "createdAt", "mediaId"].includes(key)) {
          media[key] = mediaData[key];
        }
      });

      await media.save();
    } else {
      // CREATE
      delete mediaData.id;

      mediaData.mediaId = await generateAdminMediaId();

      media = new MediaOnboarding(mediaData);
      await media.save();

      isNew = true;
    }

    const message = isNew
      ? "Media created successfully"
      : "Media updated successfully";

    return successResponse(res, message, media, isNew ? 201 : 200);
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};

const mediaList = async (req, res) => {
  try {
    const { pageNumber = 1, count = 10, mediaType, city, status } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    // Build filter query
    const filter = {};

    if (city) {
      filter.city = Array.isArray(city) ? { $in: city } : city;
    }

    if (mediaType) {
      filter.mediaType = Array.isArray(mediaType)
        ? { $in: mediaType }
        : mediaType;
    }

    if (status) {
      filter.status = Array.isArray(status) ? { $in: status } : status;
    }

    // Total count based on filter
    const totalCount = await MediaOnboarding.countDocuments(filter);

    // Data with pagination
    const mediaList = await MediaOnboarding.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNumbers - 1) * pageSize)
      .limit(pageSize)
      .lean();

    // Filter dropdown values
    const allData = await MediaOnboarding.find(
      {},
      "city mediaType status",
    ).lean();

    const cityFilter = [...new Set(allData.map((item) => item.city))].filter(
      Boolean,
    );

    const mediaTypeFilter = [
      ...new Set(allData.map((item) => item.mediaType)),
    ].filter(Boolean);

    const statusFilter = [
      ...new Set(allData.map((item) => item.status)),
    ].filter(Boolean);

    return successResponse(
      res,
      "Media list fetched successfully",
      {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),

        cityFilter,
        mediaTypeFilter,
        statusFilter,

        mediaList,
      },
      200,
    );
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};

const COLUMN_MAP = {
  "State":        "state",
  "City":         "city",
  "Media Name":   "mediaType",   // e.g. Hoarding, Unipole, Wall Graphics
  "Media Code":   "mediaCode",
  " Full address":"fullAddress",
  "Full address": "fullAddress",
  "Width":        "width",
  "Hight":        "height",      // note: typo in Excel kept as-is
  "Height":       "height",
};
 
/**
 * POST /api/media/upload-excel
 * Body: multipart/form-data  →  field name "file"  →  .xlsx file
 */
const uploadExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded." });
    }
 
    // Parse workbook from buffer
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
 
    if (!rows.length) {
      return res.status(400).json({ success: false, message: "Excel sheet is empty." });
    }
 
    const results = { inserted: 0, skipped: 0, errors: [] };
    const bulkOps = [];
 
    rows.forEach((row, index) => {
      const excelRow = index + 2; // Excel rows start at 2 (row 1 = header)
 
      // Map Excel columns to schema fields
      const mapped = {};
      for (const [excelCol, schemaField] of Object.entries(COLUMN_MAP)) {
        if (row[excelCol] !== undefined && row[excelCol] !== null) {
          mapped[schemaField] = row[excelCol];
        }
      }
 
      // Derive mediaName from mediaCode prefix or use mediaType as name
      // In the Excel "Media Name" column actually holds the media type (Hoarding etc.)
      // We treat it as mediaType; mediaName gets the fullAddress or a derived label.
      mapped.mediaName = mapped.mediaCode || `Media-${excelRow}`;
 
      // Validate minimum required fields
      const missing = [];
      if (!mapped.mediaCode)   missing.push("Media Code");
      if (!mapped.state)       missing.push("State");
      if (!mapped.city)        missing.push("City");
      if (!mapped.fullAddress) missing.push("Full address");
      if (!mapped.width)       missing.push("Width");
      if (!mapped.height)      missing.push("Height (Hight)");
      if (!mapped.mediaType)   missing.push("Media Name (type)");
 
      if (missing.length) {
        results.errors.push({ row: excelRow, reason: `Missing: ${missing.join(", ")}` });
        results.skipped++;
        return;
      }
 
      // Sanitise numeric fields
      mapped.width  = parseFloat(mapped.width);
      mapped.height = parseFloat(mapped.height);
      mapped.totalSqFt = parseFloat((mapped.width * mapped.height).toFixed(2));
      mapped.excelRowNumber = excelRow;
 
      // Upsert by mediaCode so re-uploads don't duplicate
      bulkOps.push({
        updateOne: {
          filter: { mediaCode: mapped.mediaCode },
          update:  { $setOnInsert: mapped },
          upsert:  true,
        },
      });
    });
 
    if (bulkOps.length) {
      const bulkResult = await MediaOnboarding.bulkWrite(bulkOps, { ordered: false });
      results.inserted = bulkResult.upsertedCount;
      results.skipped += bulkResult.matchedCount; // already existed
    }
 
    return res.status(200).json({
      success: true,
      message: `Upload complete. Inserted: ${results.inserted}, Skipped (duplicate/error): ${results.skipped}`,
      details: results,
    });
 
  } catch (err) {
    console.error("Excel upload error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
module.exports = { mediaOnboarding, mediaList, uploadExcel };
