const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema");
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const { computeRentalDueStats, getFaceRoleStatus, roleStatus } = require("../../../utils/rentalDueStats");
const { parseBillDateFilter, siteBillDate, billDateInMonth } = require("../../../utils/billDate"); // ✅ NEW — billDate filter
const mongoose = require("mongoose");
const {
  computeOutstandingSummary,
  dedupeGstBalanceHistory,
  getOwnerWiseOutstanding,
  calculateOverallLedgerSummary,
  calculateNewOverallLedgerSummary, // ✅ NEW
  getOverallSummaryForCycle,
  ensureRentalDueForCycles,
isOwnerModePaidForCycle,
isGstPaidForCycle,
getRequiredModesShared,
} = require("../../../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
// ─────────────────────────────────────────────────────────────
// IST HELPER — same pattern as mediaOnboardingController.js.
// updatedAt is stamped manually with this, NOT mongoose's
// { timestamps: true } (which stores UTC).
// ─────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 330 * 60000; // 5h30m
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

const escapeRegex = (str) => (str ? String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "");

// ─────────────────────────────────────────────────────────────
// FIND MASTER BY PRIORITY — phone, then panNumber, then aadhaar.
// Only used on CREATE (no id in owner payload) to avoid creating
// a duplicate Master when the same owner is being saved again.
// ─────────────────────────────────────────────────────────────
const findMasterByPriority = async (owner, session) => {
  if (owner.phone && owner.phone.trim() !== "") {
    const byPhone = await LandOwnerMaster.findOne({
      phone: owner.phone.trim(),
      // isDeleted: false,
    }).session(session || null);
    if (byPhone) return byPhone;
  }

  if (owner.panNumber && owner.panNumber.trim() !== "") {
    const byPan = await LandOwnerMaster.findOne({
      panNumber: owner.panNumber.trim().toUpperCase(),
      // isDeleted: false,
    }).session(session || null);
    if (byPan) return byPan;
  }

  if (owner.aadharCardNumber && owner.aadharCardNumber.trim() !== "") {
    const byAadhar = await LandOwnerMaster.findOne({
      aadharCardNumber: owner.aadharCardNumber.trim(),
      isDeleted: false,
    }).session(session || null);
    if (byAadhar) return byAadhar;
  }

  return null;
};

// ─────────────────────────────────────────────────────────────
// FIND EXACT DUPLICATE — check if panNumber OR aadharCardNumber already exists.
// Used in landOwnerSave to block save if either matches another record.
// ─────────────────────────────────────────────────────────────
const findExactDuplicate = async (owner, session, excludeId = null) => {
  const pan = (owner.panNumber || "").trim().toUpperCase();
  const aadhar = (owner.aadharCardNumber || "").trim();

  // Only perform check if at least one field is provided
  if (!pan && !aadhar) {
    return null;
  }

  const conditions = [];
  if (pan) conditions.push({ panNumber: pan });
  if (aadhar) conditions.push({ aadharCardNumber: aadhar });

  const query = { $or: conditions };

  if (excludeId) {
    const excStr = String(excludeId);
    const neList = [excStr];
    if (mongoose.Types.ObjectId.isValid(excStr)) {
      neList.push(new mongoose.Types.ObjectId(excStr));
    }
    query._id = { $nin: neList };
  }

  return await LandOwnerMaster.findOne(query).session(session || null);
};

// ─────────────────────────────────────────────────────────────
// PUSH UPDATED PROFILE FIELDS INTO EVERY MEDIA DOC THAT
// REFERENCES THIS MASTER — matched via
// media.landOwners[].landOwnerMasterId === landOwner._id
// ─────────────────────────────────────────────────────────────
const syncLandOwnerToMedia = async (landOwner, session) => {
  const mediaDocs = await MediaOnboarding.find({
    landOwnerMasterIds: landOwner._id,
  }).session(session || null);

  for (const media of mediaDocs) {
    let changed = false;

    media.landOwners.forEach((owner) => {
      if (
        owner.landOwnerMasterId &&
        String(owner.landOwnerMasterId) === String(landOwner._id)
      ) {
        // ✅ NEW — a site that picked a bank account gets THAT account's
        // details; every other site keeps the old top-level (primary) copy.
        const siteAccount = owner.bankAccountId
          ? (landOwner.bankAccounts || []).find(
              (a) => String(a._id) === String(owner.bankAccountId),
            )
          : null;
        owner.name = landOwner.name;
        owner.phone = landOwner.phone;
        if (!siteAccount) {
          owner.bankName = landOwner.bankName;
          owner.ifsc = landOwner.ifsc;
          owner.accountNumber = landOwner.accountNumber;
        }
        owner.upiId = landOwner.upiId;
        owner.panNumber = landOwner.panNumber;
        owner.panCardImage = landOwner.panCardImage;
        owner.aadharCardNumber = landOwner.aadharCardNumber;
        owner.aadharCardImage = landOwner.aadharCardImage;
        owner.paymentCategory = landOwner.paymentCategory;
        if (siteAccount) {
          applyAccountToMediaOwner(owner, siteAccount);
        } else {
          owner.bankPassbook = landOwner.bankPassbook;
          owner.cancelCheckLeaf = landOwner.cancelCheckLeaf;
        }
        owner.onlineMode = landOwner.onlineMode;
        changed = true;
      }
    });

    if (changed) {
      await media.save({ session, timestamps: false });
    }
  }
};

const upsertLinkedSite = (landOwnerMaster, mediaInfo, owner) => {
  if (!mediaInfo || !mediaInfo.mediaId) return; // no site context — nothing to record

  if (!Array.isArray(landOwnerMaster.linkedSites)) {
    landOwnerMaster.linkedSites = [];
  }

  const now = nowIST();
  const mediaIdStr = String(mediaInfo.mediaId);
  const incomingFaces = Array.isArray(mediaInfo.faces) ? mediaInfo.faces : [];

  // ✅ 1. Remove entries for this mediaId that are no longer in the incoming faces list
  const validFaceIds = new Set(incomingFaces.map(f => String(f._id)));
  landOwnerMaster.linkedSites = landOwnerMaster.linkedSites.filter(site => {
    if (String(site.mediaId) !== mediaIdStr) return true; // keep other properties
    return site.mediaDetailId && validFaceIds.has(String(site.mediaDetailId)); // only keep existing faces that are still present
  });

  // ✅ 2. Upsert each face
  incomingFaces.forEach(face => {
    const faceIdStr = String(face._id);
    const existingIdx = landOwnerMaster.linkedSites.findIndex(
      (site) => String(site.mediaId) === mediaIdStr && String(site.mediaDetailId) === faceIdStr,
    );

    const siteData = {
      mediaId: mediaInfo.mediaId,
      mediaDetailId: face._id,
      mediaCode: face.mediaCode,
      mediaName: face.mediaName,
      mediaDetailsCount: 1, // Individual face
      siteBillMode: mediaInfo.siteBillMode || face.siteBillMode || null,
      paymentCategory: Number(owner.paymentCategory || 1),
      shareAmount: Number(owner.shareAmount || 0),
      cashAmount: Number(owner.cashAmount || 0),
      onlineAmount: Number(owner.onlineAmount || 0),
      tdsApplicable: Number(owner.tdsApplicable || 0),
      tdsPercentage: Number(owner.tdsPercentage || 0),
      tdsAmount: Number(owner.tdsAmount || 0),
      gstApplicable: Number(owner.gstApplicable || 0),
      gstPercentage: Number(owner.gstPercentage || 0),
      gstAmount: Number(owner.gstAmount || 0),
      netPayableToOwner: Number(owner.netPayableToOwner || 0),
      updatedAt: now,
    };

    if (existingIdx !== -1) {
      // Update existing face entry
      Object.assign(landOwnerMaster.linkedSites[existingIdx], siteData);
    } else {
      // Push new face entry
      landOwnerMaster.linkedSites.push(siteData);
    }
  });

  // ✅ 3. Update Master-level aggregates
  const uniqueMediaIds = new Set(landOwnerMaster.linkedSites.map(s => String(s.mediaId)));
  landOwnerMaster.linkedMediaCount = uniqueMediaIds.size;

  // Re-calculate totals from unique documents to avoid doubling (since each face currently carries doc-level amounts)
  const uniqueDocEntries = [];
  const seen = new Set();
  landOwnerMaster.linkedSites.forEach(s => {
      const mid = String(s.mediaId);
      if (!seen.has(mid)) {
          uniqueDocEntries.push(s);
          seen.add(mid);
      }
  });

  landOwnerMaster.totalShareAmount = uniqueDocEntries.reduce((sum, s) => sum + Number(s.shareAmount || 0), 0);
  landOwnerMaster.totalGstAmount = uniqueDocEntries.reduce((sum, s) => sum + Number(s.gstAmount || 0), 0);
  landOwnerMaster.totalNetPayableToOwner = uniqueDocEntries.reduce((sum, s) => sum + Number(s.netPayableToOwner || 0), 0);
};

const syncOrLinkMediaOwnerToMaster = async (
  owner,
  userName,
  session,
  mediaInfo,
) => {
  sanitizeOwnerFileFields(owner);

  let landOwnerMaster = null;

  if (owner.landOwnerMasterId) {
    landOwnerMaster = await LandOwnerMaster.findOne({
      _id: owner.landOwnerMasterId,
      // isDeleted: false,
    }).session(session || null);
  }

  // First-time onboarding — no id sent (or it pointed at nothing
  // valid). Try to find an existing Master by phone/pan/aadhaar
  // before creating a new one, so the same real-world person doesn't
  // get duplicated just because they were re-typed on a new site.
  if (!landOwnerMaster) {
    landOwnerMaster = await findMasterByPriority(owner, session);
  }

  if (!landOwnerMaster) {
    landOwnerMaster = new LandOwnerMaster({
      name: owner.name,
      phone: owner.phone,
      bankName: owner.bankName,
      ifsc: owner.ifsc,
      accountNumber: owner.accountNumber,
      upiId: owner.upiId,
      panNumber: owner.panNumber,
      panCardImage: owner.panCardImage,
      aadharCardNumber: owner.aadharCardNumber,
      aadharCardImage: owner.aadharCardImage,
      paymentCategory: owner.paymentCategory,
      eligibleMode: owner.eligibleMode,
      landOwnerBillMode: owner.landOwnerBillMode,
      agreementBillMode: owner.agreementBillMode,
      bankPassbook: owner.bankPassbook,
      cancelCheckLeaf: owner.cancelCheckLeaf,
      onlineMode: owner.onlineMode,
    });
    syncPrimaryFromTopLevel(landOwnerMaster); // ✅ NEW — first bank account
  } else {
    // ✅ NEW — a site paying into a chosen bank account must not overwrite
    // the master's primary bank details with that account.
    const usesBankAccount = !!owner.bankAccountId;
    // reuse the same complete field list as landOwnerSave's UPDATE
    // branch — guarantees this stays in sync with that logic.
    OWNER_UPDATABLE_FIELDS.forEach((field) => {
      if (usesBankAccount && BANK_TEXT_FIELDS.includes(field)) return;
      if (owner[field] !== undefined) {
        landOwnerMaster[field] = owner[field];
      }
    });
    if (!usesBankAccount) syncPrimaryFromTopLevel(landOwnerMaster);
  }

  // ✅ per-site record — THIS is what lets one landowner have
  // Cash on Site A, Online on Site B, Cash+Online on Site C.
  upsertLinkedSite(landOwnerMaster, mediaInfo, owner);

  // ✅ same GST/TDS/netPayable calculation as landOwnerSave() —
  // paymentCategory-driven base amount, .env-priority percentages.
  computeFinancialFields(landOwnerMaster);

  landOwnerMaster.updatedBy = userName;
  landOwnerMaster.updatedAt = nowIST();

  await landOwnerMaster.save({ session });

  // ── OPTION B would go here if you want full cascade instead ──
  // await syncLandOwnerToMedia(landOwnerMaster, session);

  // write the resolved id back onto the Media-side owner object so
  // the caller can persist it onto landOwners[i].landOwnerMasterId
  owner.landOwnerMasterId = landOwnerMaster._id;

  return landOwnerMaster;
};

const removeLinkedSiteFromMaster = async (masterId, mediaId, session) => {
  if (!masterId || !mediaId) return;

  const landOwnerMaster = await LandOwnerMaster.findOne({
    _id: masterId,
  }).session(session || null);

  if (!landOwnerMaster) return;

  if (Array.isArray(landOwnerMaster.linkedSites)) {
    const mediaIdStr = String(mediaId);
    landOwnerMaster.linkedSites = landOwnerMaster.linkedSites.filter(
      (site) => String(site.mediaId) !== mediaIdStr,
    );

    // Recalculate Master-level aggregates
    const uniqueMediaIds = new Set(
      landOwnerMaster.linkedSites.map((s) => String(s.mediaId)),
    );
    landOwnerMaster.linkedMediaCount = uniqueMediaIds.size;

    const uniqueDocEntries = [];
    const seen = new Set();
    landOwnerMaster.linkedSites.forEach((s) => {
      const mid = String(s.mediaId);
      if (!seen.has(mid)) {
        uniqueDocEntries.push(s);
        seen.add(mid);
      }
    });

    landOwnerMaster.totalShareAmount = uniqueDocEntries.reduce(
      (sum, s) => sum + Number(s.shareAmount || 0),
      0,
    );
    landOwnerMaster.totalGstAmount = uniqueDocEntries.reduce(
      (sum, s) => sum + Number(s.gstAmount || 0),
      0,
    );
    landOwnerMaster.totalNetPayableToOwner = uniqueDocEntries.reduce(
      (sum, s) => sum + Number(s.netPayableToOwner || 0),
      0,
    );

    landOwnerMaster.updatedAt = nowIST();
    await landOwnerMaster.save({ session });
  }
};

const correctLinkedSiteAmounts = async (
  masterId,
  mediaId,
  savedOwner,
  session,
) => {
  if (!masterId || !mediaId) return null;

  const landOwnerMaster = await LandOwnerMaster.findOne({
    _id: masterId,
    // isDeleted: false,
  }).session(session || null);

  if (!landOwnerMaster) return null;

  if (!Array.isArray(landOwnerMaster.linkedSites)) {
    landOwnerMaster.linkedSites = [];
  }

  const site = landOwnerMaster.linkedSites.find(
    (s) => String(s.mediaId) === String(mediaId),
  );

  if (site) {
    site.shareAmount = Number(savedOwner.shareAmount || 0);
    site.cashAmount = Number(savedOwner.cashAmount || 0);
    site.onlineAmount = Number(savedOwner.onlineAmount || 0);
    site.tdsApplicable = Number(savedOwner.tdsApplicable || 0);
    site.tdsPercentage = Number(savedOwner.tdsPercentage || 0);
    site.tdsAmount = Number(savedOwner.tdsAmount || 0);
    site.gstApplicable = Number(savedOwner.gstApplicable || 0);
    site.gstPercentage = Number(savedOwner.gstPercentage || 0);
    site.gstAmount = Number(savedOwner.gstAmount || 0); // ← ADDED
    site.netPayableToOwner = Number(savedOwner.netPayableToOwner || 0); // ← ADDED
    site.paymentCategory = Number(
      savedOwner.paymentCategory || site.paymentCategory || 1,
    );
    site.updatedAt = nowIST();
  }

  const uniqueDocEntries = [];
  const seenMedia = new Set();
  landOwnerMaster.linkedSites.forEach((s) => {
    const mid = String(s.mediaId);
    if (!seenMedia.has(mid)) {
      uniqueDocEntries.push(s);
      seenMedia.add(mid);
    }
  });

  landOwnerMaster.totalShareAmount = uniqueDocEntries.reduce(
    (sum, s) => sum + Number(s.shareAmount || 0),
    0,
  );
  landOwnerMaster.totalGstAmount = uniqueDocEntries.reduce(
    (sum, s) => sum + Number(s.gstAmount || 0),
    0,
  );
  landOwnerMaster.totalNetPayableToOwner = uniqueDocEntries.reduce(
    (sum, s) => sum + Number(s.netPayableToOwner || 0),
    0,
  );
  // also refresh the Master's own "last known" amount snapshot with
  // the same final figures, then recompute GST/TDS/netPayable so
  // those aren't stuck at the stale pre-save values either.
  landOwnerMaster.shareAmount = Number(savedOwner.shareAmount || 0);
  landOwnerMaster.cashAmount = Number(savedOwner.cashAmount || 0);
  landOwnerMaster.onlineAmount = Number(savedOwner.onlineAmount || 0);
  landOwnerMaster.paymentCategory = Number(
    savedOwner.paymentCategory || landOwnerMaster.paymentCategory || 1,
  );

  computeFinancialFields(landOwnerMaster);
  landOwnerMaster.updatedAt = nowIST();

  await landOwnerMaster.save({ session });

  return landOwnerMaster;
};

const computeFinancialFields = (landOwner) => {
  const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
  const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");

  const shareAmount = Number(landOwner.shareAmount || 0);
  const onlineAmount = Number(landOwner.onlineAmount || 0);
  const paymentCategory = Number(landOwner.paymentCategory || 1);

  // ── TDS base amount — same paymentCategory rule as MediaSchema ──
  let tdsBaseAmount = 0;
  if (paymentCategory === 1) {
    tdsBaseAmount = 0; // cash only — no TDS
  } else if (paymentCategory === 2) {
    tdsBaseAmount = shareAmount; // online only — full share
  } else if (paymentCategory === 3) {
    tdsBaseAmount = onlineAmount; // split — ONLY the online portion
  }

  const tdsApplicable = Number(landOwner.tdsApplicable || 0);
  const tdsPercentage =
    tdsApplicable === 1
      ? envTdsPercent > 0
        ? envTdsPercent
        : Number(landOwner.tdsPercentage || 0)
      : 0;
  landOwner.tdsPercentage = tdsPercentage;

  landOwner.tdsAmount =
    tdsApplicable === 1 && tdsPercentage > 0
      ? Math.floor((tdsBaseAmount * tdsPercentage) / 100)
      : 0;

  // ── GST base amount — same paymentCategory rule as MediaSchema ──
  let gstBaseAmount = 0;
  if (paymentCategory === 1) {
    gstBaseAmount = 0;
  } else if (paymentCategory === 2) {
    gstBaseAmount = shareAmount;
  } else if (paymentCategory === 3) {
    gstBaseAmount = onlineAmount;
  }

  const gstApplicable = Number(landOwner.gstApplicable || 0);
  const gstPct = Number(landOwner.gstPercentage || 0) || envGstPct;

  const gstAmount =
    gstApplicable === 1 && gstBaseAmount > 0
      ? Math.floor((gstBaseAmount * gstPct) / 100)
      : 0;

  landOwner.gstPercentage =
    gstApplicable === 1 && gstBaseAmount > 0 ? gstPct : 0;
  landOwner.gstAmount = gstAmount;

  // ── NET PAYABLE ──────────────────────────────────────────
  // owner.totalAmountWithGst / netPayableToOwner / netPayable are
  // ALWAYS derived here now — they no longer silently stay 0 just
  // because the client didn't send them.
  landOwner.totalAmountWithGst = shareAmount + gstAmount;
  landOwner.netPayableToOwner = landOwner.totalAmountWithGst;
  landOwner.netPayable = landOwner.totalAmountWithGst;
};

// ─────────────────────────────────────────────────────────────
// ATTACH UPLOADED FILES FOR THE (single) OWNER FROM req.files.
// Supports plain, flat fieldnames only, e.g. "panCardImage".
// ─────────────────────────────────────────────────────────────
const OWNER_FILE_FIELDS = [
  "panCardImage",
  "bankPassbook",
  "cancelCheckLeaf",
  "aadharCardImage",
];

const attachFilesToOwner = (owner, files, processFile) => {
  OWNER_FILE_FIELDS.forEach((field) => {
    const matchedFile = files.find((f) => f.fieldname === field);
    if (matchedFile) {
      owner[field] = processFile(matchedFile);
    }
  });
};

// ✅ ADDED — infers a fileType from a raw URL/path's extension, so a
// string value gets normalized into the same object shape the rest
// of the codebase (and the schema's fileType enum) expects.
const inferFileTypeFromPath = (pathOrUrl) => {
  const ext = String(pathOrUrl).split(".").pop()?.toLowerCase().split("?")[0];
  if (ext === "pdf") return "pdf";
  return "image";
};

const sanitizeOwnerFileFields = (owner) => {
  OWNER_FILE_FIELDS.forEach((field) => {
    if (owner[field] === undefined) return;

    const val = owner[field];

    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed === "") {
        delete owner[field];
        return;
      }
      owner[field] = {
        fileType: inferFileTypeFromPath(trimmed),
        filePath: trimmed,
        uploadedAt: nowIST(),
      };
      return; // already normalized + guaranteed valid — skip the object checks below
    }

    const isPlainNonEmptyObject =
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      Object.keys(val).length > 0;

    const hasAnyNonEmptyStringValue =
      isPlainNonEmptyObject &&
      Object.values(val).some((v) => typeof v === "string" && v.trim() !== "");

    const isValidFileObject =
      isPlainNonEmptyObject && hasAnyNonEmptyStringValue;

    if (!isValidFileObject) {
      delete owner[field];
    }
  });
};

const OWNER_UPDATABLE_FIELDS = [
  // profile
  "name",
  "phone",
  "bankName",
  "ifsc",
  "accountNumber",
  "upiId",
  "panNumber",
  "aadharCardNumber",
  "paymentCategory",
  "eligibleMode",
  "landOwnerBillMode",
  "agreementBillMode",
  "onlineMode",
  // financial inputs
  "typeShare",
  "sharePercentage",
  "shareAmount",
  "onlineAmount",
  "cashAmount",
  "gstApplicable",
  "gstNumber",
  "gstPercentage", // used as fallback input inside computeFinancialFields
  "tdsApplicable",
  "tdsPercentage", // used as fallback input inside computeFinancialFields
  // ⚠️ file fields (panCardImage, bankPassbook, cancelCheckLeaf,
  // aadharCardImage) are intentionally NOT in this list — they are
  // handled separately by applyOwnerFileFields() below so that not
  // re-sending a file on update never wipes out the existing one.
];

const applyOwnerFileFields = (landOwner, owner) => {
  OWNER_FILE_FIELDS.forEach((field) => {
    if (owner[field] !== undefined) {
      landOwner[field] = owner[field]; // new file provided — overwrite
    } else {
      landOwner[field] = undefined; // not sent this time — remove from DB
    }
  });
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW — MULTIPLE BANK ACCOUNTS PER LANDOWNER
// master.bankAccounts[] holds every account; the top-level bank fields
// mirror the PRIMARY one. A Media site picks an account through
// landOwners[].bankAccountId and gets that account's details copied in.
// Without bankAccountId every flow behaves exactly as before.
// ─────────────────────────────────────────────────────────────
const BANK_TEXT_FIELDS = ["bankName", "ifsc", "accountNumber"];
const BANK_FILE_FIELDS = ["bankPassbook", "cancelCheckLeaf"];

const badRequest = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
};
const cleanStr = (v) => (v === undefined || v === null ? "" : String(v).trim());
const bankKey = (accountNumber, ifsc) =>
  `${cleanStr(accountNumber)}|${cleanStr(ifsc).toUpperCase()}`;
const hasFile = (f) => !!(f && typeof f === "object" && f.filePath);
const plainCopy = (v) => JSON.parse(JSON.stringify(v));
const isPrimaryAccount = (a) => Number(a?.isPrimary) === 1;
const getPrimaryAccount = (accounts) =>
  (accounts || []).find(isPrimaryAccount) || (accounts || [])[0] || null;

// file object / URL string → file object valid for the master schema
const toMasterFile = (val) => {
  if (hasFile(val)) {
    const file = plainCopy(val);
    if (!["image", "other"].includes(file.fileType)) {
      file.fileType = inferFileTypeFromPath(file.filePath) === "pdf" ? "other" : "image";
    }
    return file;
  }
  if (typeof val === "string" && val.trim() !== "") {
    const filePath = val.trim();
    return {
      originalName: filePath.split("/").pop(),
      fileName: filePath.split("/").pop(),
      filePath,
      fileType: inferFileTypeFromPath(filePath) === "pdf" ? "other" : "image",
      uploadedAt: nowIST(),
    };
  }
  return null;
};

// master file → Media landOwners[] file (that schema only allows "image")
const toMediaFile = (val) => {
  if (!hasFile(val)) return null;
  const file = plainCopy(val);
  return {
    originalName: file.originalName,
    fileName: file.fileName,
    filePath: file.filePath,
    mimeType: file.mimeType,
    size: file.size,
    fileType: "image",
    uploadedAt: file.uploadedAt || null,
  };
};

// copy one master bank account onto a Media-side owner (plain object or subdoc)
const applyAccountToMediaOwner = (owner, account) => {
  owner.bankAccountId = account._id;
  BANK_TEXT_FIELDS.forEach((field) => {
    owner[field] = account[field] || "";
  });
  BANK_FILE_FIELDS.forEach((field) => {
    const file = toMediaFile(account[field]);
    if (file) owner[field] = file;
    else if (typeof owner.set === "function") owner[field] = undefined;
    else delete owner[field];
  });
};

// bankAccounts from multipart (array / {"0":{}} object) or a JSON string.
// undefined = not sent → old flow.
const parseIncomingBankAccounts = (raw) => {
  if (raw === undefined || raw === null) return undefined;
  let list = raw;
  if (typeof list === "string") {
    if (list.trim() === "") return undefined;
    try {
      list = JSON.parse(list);
    } catch {
      throw badRequest("bankAccounts must be a valid JSON array");
    }
  }
  if (list && !Array.isArray(list) && typeof list === "object") {
    list = Object.keys(list)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => list[k]);
  }
  if (!Array.isArray(list)) throw badRequest("bankAccounts must be an array");
  return list.map((item) => (item && typeof item === "object" ? { ...item } : {}));
};

// uploads named "bankAccounts[0][bankPassbook]" / "bankAccounts[0][cancelCheckLeaf]"
const attachBankAccountFiles = (list, files, processFile) => {
  (files || []).forEach((f) => {
    const match = f.fieldname.match(/^bankAccounts\[(\d+)\]\[(bankPassbook|cancelCheckLeaf)\]$/);
    if (match && list[Number(match[1])]) {
      list[Number(match[1])][match[2]] = processFile(f);
    }
  });
};

// top-level bank fields ← primary account
const syncTopLevelFromPrimary = (landOwner) => {
  const primary = getPrimaryAccount(landOwner.bankAccounts);
  BANK_TEXT_FIELDS.forEach((field) => {
    landOwner[field] = primary ? primary[field] : undefined;
  });
  BANK_FILE_FIELDS.forEach((field) => {
    landOwner[field] = primary && hasFile(primary[field]) ? plainCopy(primary[field]) : undefined;
  });
};

// OLD FLOW (no bankAccounts / bankAccountId sent): keep bankAccounts[] in
// line with the top-level bank fields — seed it the first time, otherwise
// update the primary account (or make the matching account primary).
const syncPrimaryFromTopLevel = (landOwner) => {
  if (!cleanStr(landOwner.accountNumber)) return; // never blank out an account
  const now = nowIST();
  const accounts = landOwner.bankAccounts || [];
  const topFiles = {};
  BANK_FILE_FIELDS.forEach((field) => {
    if (hasFile(landOwner[field])) topFiles[field] = toMasterFile(landOwner[field]);
  });

  if (accounts.length === 0) {
    landOwner.bankAccounts = [
      {
        bankName: landOwner.bankName,
        ifsc: landOwner.ifsc,
        accountNumber: landOwner.accountNumber,
        ...topFiles,
        isPrimary: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    return;
  }

  const topKey = bankKey(landOwner.accountNumber, landOwner.ifsc);
  const target =
    accounts.find((a) => bankKey(a.accountNumber, a.ifsc) === topKey) ||
    getPrimaryAccount(accounts);
  BANK_TEXT_FIELDS.forEach((field) => {
    if (landOwner[field] !== undefined) target[field] = landOwner[field];
  });
  Object.assign(target, topFiles);
  target.updatedAt = now;
  accounts.forEach((a) => {
    a.isPrimary = a === target ? 1 : 0;
  });
};

// NEW FLOW: replace bankAccounts[] with the sent list — _id = update,
// no _id = add, left out = remove (blocked while a site still uses it).
const applyIncomingBankAccounts = async (landOwner, list, session) => {
  const now = nowIST();
  const existing = Array.isArray(landOwner.bankAccounts) ? landOwner.bankAccounts : [];
  const existingById = new Map(existing.map((a) => [String(a._id), a]));
  const seenKeys = new Set();
  // an account sent with isPrimary = 1 wins; else the existing primary stays
  const primarySent = list.some((item) => Number(item.isPrimary) === 1);

  const next = list.map((item, idx) => {
    const id = cleanStr(item._id || item.id || item.bankAccountId);
    const base = id ? existingById.get(id) : null;
    if (id && !base) throw badRequest(`Bank account ${id} not found for this landowner`);

    const account = base
      ? plainCopy(base)
      : { _id: new mongoose.Types.ObjectId(), createdAt: now };
    BANK_TEXT_FIELDS.forEach((field) => {
      if (item[field] !== undefined) account[field] = cleanStr(item[field]);
    });
    if (account.ifsc) account.ifsc = account.ifsc.toUpperCase();
    BANK_FILE_FIELDS.forEach((field) => {
      const file = toMasterFile(item[field]);
      if (file) account[field] = file; // not sent → keep the existing file
    });

    // ✅ CHANGED — accountNumber is optional (no "accountNumber is required").
    // The duplicate check needs a number, so it runs only when one is sent.
    if (cleanStr(account.accountNumber)) {
      const key = bankKey(account.accountNumber, account.ifsc);
      if (seenKeys.has(key)) {
        throw badRequest(`Bank account ${account.accountNumber} is added more than once`);
      }
      seenKeys.add(key);
    }

    account.isPrimary =
      Number(primarySent ? item.isPrimary : account.isPrimary) === 1 ? 1 : 0;
    account.updatedAt = now;
    return account;
  });

  // exactly ONE primary — the first one marked, else the first account
  let primaryIdx = next.findIndex(isPrimaryAccount);
  if (primaryIdx === -1) primaryIdx = 0;
  next.forEach((a, i) => {
    a.isPrimary = i === primaryIdx ? 1 : 0;
  });

  const keptIds = new Set(next.map((a) => String(a._id)));
  const removed = existing.filter((a) => !keptIds.has(String(a._id)));
  if (removed.length) {
    const usedBy = await MediaOnboarding.find({
      "landOwners.bankAccountId": { $in: removed.map((a) => a._id) },
    })
      .select("siteCode mediaDetails.mediaCode landOwners.bankAccountId")
      .session(session || null)
      .lean();
    if (usedBy.length) {
      const usedAccount = removed.find((a) =>
        usedBy.some((m) =>
          (m.landOwners || []).some((lo) => String(lo.bankAccountId) === String(a._id)),
        ),
      );
      const siteCodes = usedBy.map(
        (m) => m.siteCode || m.mediaDetails?.[0]?.mediaCode || String(m._id),
      );
      throw badRequest(
        `Bank account ${usedAccount?.bankName || ""} (${usedAccount?.accountNumber || ""}) is used by ${usedBy.length} site(s): ${siteCodes.join(", ")}. Change the site's bank account first.`,
      );
    }
  }

  landOwner.bankAccounts = next;
  syncTopLevelFromPrimary(landOwner);
};

// response helper — how many sites pay into each account
const withBankAccountSiteCounts = async (bankAccounts, mediaDocs = null) => {
  const accounts = (bankAccounts || []).map((a) =>
    typeof a?.toObject === "function" ? a.toObject() : { ...a },
  );
  if (accounts.length === 0) return accounts;
  const docs =
    mediaDocs ||
    (await MediaOnboarding.find({
      "landOwners.bankAccountId": { $in: accounts.map((a) => a._id) },
    })
      .select("landOwners.bankAccountId")
      .lean());
  return accounts.map((a) => ({
    ...a,
    linkedSiteCount: docs.filter((m) =>
      (m.landOwners || []).some((lo) => String(lo.bankAccountId) === String(a._id)),
    ).length,
  }));
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW — Media save: resolve landOwners[].bankAccountId BEFORE anything
// is saved. Valid id → that account's bank details are copied onto the
// site's owner. No id → old flow; when the typed account number + IFSC
// equal one of the master's accounts, the site is linked to it.
// Throws a 400 error for an unknown / unusable bankAccountId.
// ─────────────────────────────────────────────────────────────
const resolveMediaOwnerBankAccounts = async (landOwners) => {
  if (!Array.isArray(landOwners) || landOwners.length === 0) return;

  const masterIds = [
    ...new Set(
      landOwners
        .map((o) => cleanStr(o?.landOwnerMasterId))
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
  const masters = masterIds.length
    ? await LandOwnerMaster.find({ _id: { $in: masterIds } }).select("name bankAccounts").lean()
    : [];
  const masterById = new Map(masters.map((m) => [String(m._id), m]));

  for (const owner of landOwners) {
    if (!owner || typeof owner !== "object") continue;
    const accountId = cleanStr(owner.bankAccountId);
    const master = masterById.get(cleanStr(owner.landOwnerMasterId));
    const label = owner.name || master?.name || "";

    if (!accountId || accountId === "null" || accountId === "undefined") {
      owner.bankAccountId = null;
      if (master && cleanStr(owner.accountNumber)) {
        const match = (master.bankAccounts || []).find(
          (a) => bankKey(a.accountNumber, a.ifsc) === bankKey(owner.accountNumber, owner.ifsc),
        );
        if (match) owner.bankAccountId = match._id;
      }
      continue;
    }

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      throw badRequest(`Invalid bankAccountId for landowner ${label}`);
    }
    if (!master) {
      throw badRequest(`bankAccountId needs landOwnerMasterId for landowner ${label}`);
    }
    const account = (master.bankAccounts || []).find((a) => String(a._id) === accountId);
    if (!account) {
      throw badRequest(`Bank account not found for landowner ${label}`);
    }
    applyAccountToMediaOwner(owner, account);
  }
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW — one-time backfill (run at startup): landowners saved before
// bankAccounts[] existed get their current bank details as the primary
// account. Only touches owners whose bankAccounts is empty.
// ─────────────────────────────────────────────────────────────
const seedLandOwnerBankAccounts = async () => {
  const emptyAccounts = {
    $or: [{ bankAccounts: { $exists: false } }, { bankAccounts: { $size: 0 } }],
  };
  const owners = await LandOwnerMaster.find({
    ...emptyAccounts,
    accountNumber: { $nin: [null, ""] },
  })
    .select("bankName ifsc accountNumber bankPassbook cancelCheckLeaf")
    .lean();
  if (owners.length === 0) return { seeded: 0 };

  const now = nowIST();
  const result = await LandOwnerMaster.bulkWrite(
    owners.map((o) => {
      const account = {
        _id: new mongoose.Types.ObjectId(),
        bankName: o.bankName,
        ifsc: o.ifsc ? String(o.ifsc).toUpperCase() : o.ifsc,
        accountNumber: o.accountNumber,
        isPrimary: 1,
        createdAt: now,
        updatedAt: now,
      };
      BANK_FILE_FIELDS.forEach((field) => {
        const file = hasFile(o[field]) ? toMasterFile(o[field]) : null;
        if (file) account[field] = file;
      });
      return {
        updateOne: {
          filter: { _id: o._id, ...emptyAccounts },
          update: { $set: { bankAccounts: [account] } },
        },
      };
    }),
  );
  return { seeded: result.modifiedCount || 0 };
};

// ─────────────────────────────────────────────────────────────
// SAVE OR UPDATE THE (single) OWNER PAYLOAD.
// Returns the saved LandOwnerMaster document.
// ─────────────────────────────────────────────────────────────
// incomingBankAccounts: parsed bankAccounts[] (new flow) or undefined (old flow)
const saveSingleLandOwner = async (owner, userName, session, incomingBankAccounts) => {
  // ✅ safety net — strips empty-string/junk values from the 4 file
  // fields BEFORE anything is assigned onto a Mongoose document.
  // Fixes "fileType: `` is not a valid enum value" when a file field
  // is sent but no actual file was uploaded for it.
  sanitizeOwnerFileFields(owner);

  let landOwner;
  const targetId = owner.id || owner._id || owner.landOwnerMasterId;

  if (targetId) {
    // ── UPDATE ──────────────────────────────────────────────
    landOwner = await LandOwnerMaster.findOne({
      _id: targetId,
      // isDeleted: false,
    }).session(session);

    if (!landOwner) {
      const err = new Error(`LandOwner not found with id ${targetId}`);
      err.statusCode = 404;
      throw err;
    }

    // ✅ ALL updatable owner fields, copied generically from a single
    // list — every field in the schema is guaranteed to be
    // updatable, and adding a new schema field later only requires
    // adding it here once.
    //
    // EXCLUDED on purpose (always DERIVED by computeFinancialFields()
    // below, never taken from the client): gstAmount,
    // totalAmountWithGst, tdsAmount, netPayableToOwner, netPayable.
    OWNER_UPDATABLE_FIELDS.forEach((field) => {
      if (owner[field] !== undefined) {
        landOwner[field] = owner[field];
      }
    });

    // ✅ file fields handled separately — preserves the existing DB
    // value (e.g. bankPassbook) whenever it isn't re-sent on this
    // update, instead of being overwritten/cleared.
    applyOwnerFileFields(landOwner, owner);

    // ✅ NEW — multiple bank accounts (top-level fields follow the primary)
    if (incomingBankAccounts !== undefined) {
      await applyIncomingBankAccounts(landOwner, incomingBankAccounts, session);
    } else {
      syncPrimaryFromTopLevel(landOwner);
    }

    // ✅ DUPLICATE CHECK — ensure the updated PAN/Aadhaar don't conflict with another record
    const duplicate = await findExactDuplicate(landOwner, session, landOwner._id);
    if (duplicate) {
      const err = new Error(
        `Another LandOwner already exists with the same PAN or Aadhaar Card Number`,
      );
      err.statusCode = 400;
      throw err;
    }

    // client-sent gstPercentage/tdsPercentage above are used only as
    // FALLBACK inputs inside computeFinancialFields() — see that
    // function for the exact .env-priority logic.

    // ✅ gstPercentage/gstAmount/totalAmountWithGst/tdsAmount/
    // netPayableToOwner/netPayable are ALL derived here.
    computeFinancialFields(landOwner);

    // ✅ IST audit stamp — same nowIST() pattern as
    // mediaOnboardingController.js. Set on EVERY update.
    landOwner.updatedBy = userName;
    landOwner.updatedAt = nowIST();

    await landOwner.save({ session });

    // ✅ CASCADE — push the same profile fields into every Media
    // document's embedded landOwners[] that references this Master.
    await syncLandOwnerToMedia(landOwner, session);
  } else {
    // ── CREATE ──────────────────────────────────────────────
    const existingExact = await findExactDuplicate(owner, session);
    if (existingExact) {
      const err = new Error(
        `LandOwner already exists with the same PAN or Aadhaar Card Number`,
      );
      err.statusCode = 400;
      throw err;
    }

    landOwner = new LandOwnerMaster(owner);

    // ✅ NEW — multiple bank accounts (top-level fields follow the primary)
    if (incomingBankAccounts !== undefined) {
      await applyIncomingBankAccounts(landOwner, incomingBankAccounts, session);
    } else {
      syncPrimaryFromTopLevel(landOwner);
    }

    // ✅ same paymentCategory-based GST + TDS + netPayable computation
    // as UPDATE — mirrors MediaSchema.pre("save") owner block exactly.
    computeFinancialFields(landOwner);

    // ✅ IST audit stamp on first-ever save too, so updatedBy/updatedAt
    // are never null right after create.
    landOwner.updatedBy = userName;
    landOwner.updatedAt = nowIST();

    await landOwner.save({ session });
  }

  return landOwner;
};

const buildResponsePayload = (savedOwner, owner, isNew) => {
  const data =
    typeof savedOwner.toObject === "function"
      ? savedOwner.toObject()
      : { ...savedOwner };

  if (!isNew) {
    OWNER_FILE_FIELDS.forEach((field) => {
      if (owner[field] === undefined) {
        delete data[field];
      }
    });
  }

  // ✅ Add summary fields for consistency with landOwnerList
  const sites = Array.isArray(data.linkedSites) ? data.linkedSites : [];
  data.sites = sites;
  data.totalSites = sites.reduce(
    (sum, s) => sum + (Number(s.mediaDetailsCount) || 1),
    0,
  );

  return data;
};

// ✅ NEW — transactions need a replica set / mongos (Atlas, Render). A local
// standalone MongoDB rejects them ("Transaction numbers are only allowed on a
// replica set member or mongos"), so there the save runs without one.
// Checked once per connection.
let transactionSupport = null;
const supportsTransactions = async () => {
  if (transactionSupport !== null) return transactionSupport;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    transactionSupport = !!(hello.setName || hello.msg === "isdbgrid");
  } catch (err) {
    return true; // unknown → keep the old behaviour (use a transaction)
  }
  return transactionSupport;
};

const landOwnerSave = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (await supportsTransactions()) session.startTransaction();

    const owner = req.body;
    const files = req.files || [];
    const processFile =
      typeof req.processFile === "function" ? req.processFile : null;

    // same pattern as mediaOnboardingController.js
    const userName = req.user?.userName || "Admin";

    const targetId = owner.id || owner._id || owner.landOwnerMasterId;
    const isNew = !targetId;

    if (processFile) {
      attachFilesToOwner(owner, files, processFile);
    }

    // ✅ NEW — bankAccounts[] is handled on its own, never cast raw
    const incomingBankAccounts = parseIncomingBankAccounts(owner.bankAccounts);
    delete owner.bankAccounts;
    if (incomingBankAccounts && processFile) {
      attachBankAccountFiles(incomingBankAccounts, files, processFile);
    }

    const savedOwner = await saveSingleLandOwner(owner, userName, session, incomingBankAccounts);

    if (session.inTransaction()) await session.commitTransaction();

    const message = isNew
      ? "LandOwner created successfully"
      : "LandOwner updated successfully";

    // ✅ response-only shaping — DB already has bankPassbook (etc.)
    // safely preserved via applyOwnerFileFields; this just keeps it
    // OUT of the response body when it wasn't part of this request.
    const responsePayload = buildResponsePayload(savedOwner, owner, isNew);
    responsePayload.bankAccounts = await withBankAccountSiteCounts(responsePayload.bankAccounts);

    return successResponse(res, message, responsePayload, isNew ? 201 : 200);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    return errorResponse(res, error.message, null, error.statusCode || 400);
  } finally {
    session.endSession();
  }
};
const landOwnerList = async (req, res) => {
  try {
    const {
      pageNumber = 1,
      count = 10,
      search,
      landOwnerName,
      landOwnerMasterId, // ✅ ADDED — exact-id filter, takes priority over landOwnerName
    } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
      filter.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { panNumber: searchRegex },
        { aadharCardNumber: searchRegex },
      ];
    }

    // ✅ ADDED — exact match by _id. Preferred over landOwnerName since
    // an id unambiguously targets ONE owner, even when two different
    // owners share the same name (e.g. "Land 1", "Land 1").
    if (
      landOwnerMasterId &&
      mongoose.Types.ObjectId.isValid(landOwnerMasterId)
    ) {
      if (!filter.$and) filter.$and = [];
      filter.$and.push({ _id: new mongoose.Types.ObjectId(landOwnerMasterId) });
    } else if (landOwnerName && landOwnerName.trim() !== "") {
      // ✅ UNCHANGED — kept for backward compatibility with any caller
      // still sending the old name-based filter.
      const nameRegex = new RegExp(escapeRegex(landOwnerName.trim()), "i");
      if (!filter.$and) filter.$and = [];
      filter.$and.push({ name: nameRegex });
    }

    // ✅ CHANGED — landOwnerNameFilter now returns { id, name } pairs
    // instead of plain name strings, so the frontend can send back an
    // unambiguous landOwnerMasterId instead of a name that might match
    // more than one owner. Duplicate names still both appear since
    // they carry different ids.
    const allLandOwnersForNameFilter = await LandOwnerMaster.find({})
      .select("name updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    const landOwnerNameFilter = allLandOwnersForNameFilter.map((item) => ({
      id: item._id,
      name: item.name,
    }));

    const totalCount = await LandOwnerMaster.countDocuments(filter);

    const landOwnerListRaw = await LandOwnerMaster.aggregate([
      { $match: filter },
      {
        $addFields: {
          latestActivityAt: {
            $max: [
              "$updatedAt",
              {
                $max: {
                  $map: {
                    input: { $ifNull: ["$linkedSites", []] },
                    as: "site",
                    in: "$$site.updatedAt",
                  },
                },
              },
            ],
          },
        },
      },
      { $sort: { updatedAt: -1, _id: -1 } },
      { $skip: (pageNumbers - 1) * pageSize },
      { $limit: pageSize },
    ]);

    const ownerIds = landOwnerListRaw.map((o) => o._id);

    // ✅ FETCH LIVE DATA — query MediaOnboarding directly to ensure all faces/sites
    // are counted correctly, even if the cache in LandOwnerMaster is old.
    const liveMediaDocs = await MediaOnboarding.find({
      "landOwners.landOwnerMasterId": { $in: ownerIds },
    }).lean();

    const landOwnerListData = landOwnerListRaw.map((owner) => {
      const ownerIdStr = String(owner._id);

      // Rebuild the sites array from the live Media documents
      const liveFaces = [];
      const ownerMediaDocs = liveMediaDocs.filter((media) =>
        (media.landOwners || []).some(
          (lo) => String(lo.landOwnerMasterId) === ownerIdStr,
        ),
      );

      let liveTotalShareAmount = 0;
      let liveTotalGstAmount = 0;
      let liveTotalNetPayableToOwner = 0;

      ownerMediaDocs.forEach((media) => {
        const ownerEntry = (media.landOwners || []).find(
          (lo) => String(lo.landOwnerMasterId) === ownerIdStr,
        );

        if (ownerEntry) {
          liveTotalShareAmount += Number(ownerEntry.shareAmount || 0);
          liveTotalGstAmount += Number(ownerEntry.gstAmount || 0);
          liveTotalNetPayableToOwner += Number(
            ownerEntry.netPayableToOwner || ownerEntry.totalAmountWithGst || ownerEntry.shareAmount || 0,
          );

          (media.mediaDetails || []).filter(d => Number(d.status) === 1).forEach((face) => {
            liveFaces.push({
              mediaId: media._id,
              mediaDetailId: face._id,
              mediaCode: face.mediaCode,
              mediaName: face.mediaName,
              siteBillMode: face.siteBillMode,
              paymentCategory: ownerEntry.paymentCategory,
              shareAmount: ownerEntry.shareAmount,
              cashAmount: ownerEntry.cashAmount,
              onlineAmount: ownerEntry.onlineAmount,
              tdsApplicable: ownerEntry.tdsApplicable,
              tdsPercentage: ownerEntry.tdsPercentage,
              tdsAmount: ownerEntry.tdsAmount,
              gstApplicable: ownerEntry.gstApplicable,
              gstPercentage: ownerEntry.gstPercentage,
              gstAmount: ownerEntry.gstAmount,
              netPayableToOwner: ownerEntry.netPayableToOwner,
              updatedAt: media.updatedAt,
            });
          });
        }
      });

      const uniqueMediaCount = new Set(liveFaces.map((f) => String(f.mediaId))).size;

      // ✅ FIXED — site totals always come from the live sites. An owner with
      // no live site (e.g. its site was deleted) has 0, instead of the stale
      // totals still cached on the LandOwnerMaster record.
      return {
        ...owner,
        totalShareAmount: liveTotalShareAmount,
        totalGstAmount: liveTotalGstAmount,
        totalNetPayableToOwner: liveTotalNetPayableToOwner,
        linkedMediaCount: uniqueMediaCount,
        linkedSites: liveFaces, // Update the cache-based field in the response
        sites: liveFaces, // Provide the alias for the frontend
        totalSites: liveFaces.length, // Live count of individual faces
        // ✅ NEW — every bank account + how many sites pay into it
        bankAccounts: (owner.bankAccounts || []).map((acc) => ({
          ...acc,
          linkedSiteCount: ownerMediaDocs.filter((media) =>
            (media.landOwners || []).some(
              (lo) => String(lo.bankAccountId) === String(acc._id),
            ),
          ).length,
        })),
      };
    });

    return successResponse(
      res,
      "LandOwner list fetched successfully",
      {
        pageNumber: pageNumbers,
        count: pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        landOwnerList: landOwnerListData,
        landOwnerNameFilter,
      },
      200,
    );
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};

const SITE_FILTER_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseSiteFilterMonthParam(monthYearStr) {
  if (!monthYearStr) return null;
  const match = /^([0-9]{1,2})-([0-9]{4})$/.exec(monthYearStr);
  if (!match) return null;
  return { month: Number(match[1]), year: Number(match[2]) };
}

function parseSiteFilterDueMonthLabel(label) {
  if (!label) return null;
  const parts = String(label).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const monthIdx = SITE_FILTER_MONTH_NAMES.findIndex(
    (m) => m.toLowerCase() === parts[0].toLowerCase(),
  );
  const year = Number(parts[1]);
  if (monthIdx === -1 || Number.isNaN(year)) return null;
  return { monthIdx, year };
}
// ✅ NEW — "CMD Approval" filter: ONLY dues the CMD has approved (fully
// approved with the CMD step approved, status 2). Dues still waiting on CMD
// are NOT included. Combined with isCmdDueFullySettled below, the filter
// shows CMD-approved months whose ledger / GST entry is not done yet.
const isDueApprovedByCmd = (due) =>
  Number(due?.approvalStatus) === 3 &&
  (due?.approvalSteps || []).some((s) => Number(s.role) === 3 && Number(s.status) === 2);
const isDueInCmdApproval = (due) => isDueApprovedByCmd(due);

// ✅ NEW — a CMD-approval month drops out of the filter / counts once it is
// fully settled: every owner's required rent mode(s) entered in the ledger
// for that cycle AND, when GST is held (withGst 1), every GST balance row of
// that month paid. Direct GST (withGst 2) is paid together with the rent.
// mediaLike needs ledger, ledgerHistory, gstBalanceHistory.
const isCmdDueFullySettled = (mediaLike, owners, due) => {
  const ownerList = owners || [];
  if (!due?.dueDate || ownerList.length === 0) return false;
  const cycleDate = new Date(due.dueDate);
  if (Number.isNaN(cycleDate.getTime())) return false;

  const isRentPaid = ownerList.every((owner) =>
    getRequiredModesShared(Number(owner.paymentCategory || 1)).every((mode) =>
      isOwnerModePaidForCycle(mediaLike, owner, mode, cycleDate),
    ),
  );
  if (!isRentPaid) return false;

  if (Number(due.withGst) === 1) {
    const gstRows = (mediaLike.gstBalanceHistory || []).filter((r) => r.dueMonth === due.dueMonth);
    return gstRows.every((r) => r.isPaid || (r.utrNumber && String(r.utrNumber).trim() !== ""));
  }
  return true;
};

const landOwnerSiteFilter = async (req, res) => {
  try {
      const {
        landOwnerMasterIds,
        search,
        pageNumber = 1,
        count = 10,
        city: cityParam,
        cityFilter: cityFilterParam, // ✅ NEW — alias of `city` (same name as the response list)
        // ✅ ADDED — new request params
        monthFilter,
        currentMonthLedgerEntries: wantCurrentMonthLedger,
        pastMonthLedgerEntries: wantPastMonthLedger,
        currentGst: wantCurrentGst,
        pastGst: wantPastGst,
        // ✅ NEW: Rental Status Filters
        approvalSite: wantApprovalSite,
        pendingSite: wantPendingSite,
        overDue: wantOverDue,
        cmdApproval: wantCmdApproval, // ✅ NEW — waiting on CMD (current + past months)
        dueThisMonth: wantDueThisMonth, // ✅ NEW — filter for current month dues
        // ✅ NEW: Pending Payment Filters
      currentPendingRent: wantCurrentPendingRent,
      pastRentalPending: wantPastRentalPending,
      currentGstPending: wantCurrentGstPending,
      pastGstPending: wantPastGstPending,
      // ✅ NEW: Overall Summary Filter Flags
      totalLedgerAmount: wantTotalLedgerAmount,
      totalLedgerGstAmount: wantTotalLedgerGstAmount,
      totalLedgerPendingAmount: wantTotalLedgerPendingAmount,
      totalGstPendingAmount: wantTotalGstPendingAmount,
      // ✅ NEW: Individual category pending flags
      currentMonthRentPendingSites: wantCurrentMonthRentPendingSites,
      currentMonthGstPendingSites: wantCurrentMonthGstPendingSites,
      currentMonthRentPaidSites: wantCurrentMonthRentPaidSites,
      currentMonthGstPaidSites: wantCurrentMonthGstPaidSites,
      pastRentPendingSites: wantPastRentPendingSites,
      pastGstPendingSites: wantPastGstPendingSites,
      currentMonthOverallDueAmountSites: wantCurrentMonthOverallDueAmount,
      totalOutstandingSites: wantTotalOutstanding,
      roleType, // ✅ NEW
    } = req.body || {};

    // ✅ FIXED — city filter: accepts `city` or `cityFilter`, as a string,
    // an array, or a comma-separated string ("Chennai,Gaya"). Empty → no filter.
    const cityRaw = cityParam ?? cityFilterParam;
    const cityList = (Array.isArray(cityRaw) ? cityRaw : cityRaw ? String(cityRaw).split(",") : [])
      .map((c) => String(c).trim())
      .filter(Boolean);
    const city = cityList.length ? cityList : null;

    const today = nowIST();
    today.setUTCHours(0, 0, 0, 0);
    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    // ✅ FIXED — use getUTC* methods on the shifted IST date to ensure
    // consistent month detection regardless of the server's local timezone.
    const parsedMonthFilter = parseSiteFilterMonthParam(monthFilter);
    const referenceDate = parsedMonthFilter
      ? new Date(Date.UTC(parsedMonthFilter.year, parsedMonthFilter.month - 1, 1))
      : nowIST();
    const referenceYear = referenceDate.getUTCFullYear();
    const referenceMonthIdx = referenceDate.getUTCMonth();
    const monthFilterApplied = parsedMonthFilter
      ? monthFilter
      : `${String(referenceMonthIdx + 1).padStart(2, "0")}-${referenceYear}`;

    const includeCurrentLedger = Number(wantCurrentMonthLedger) === 1;
    const includePastLedger = Number(wantPastMonthLedger) === 1;
    const includeCurrentGst = Number(wantCurrentGst) === 1;
    const includePastGst = Number(wantPastGst) === 1;

      const includeApprovalSite = Number(wantApprovalSite) === 1;
      const includePendingSites = Number(wantPendingSite) === 1;
      // const includePastPending = Number(wantPastPending) === 1; // Removed per user request
      const includeOverDue = Number(wantOverDue) === 1;
      const includeCmdApproval = Number(wantCmdApproval) === 1; // ✅ NEW
      const includeDueThisMonth = Number(wantDueThisMonth) === 1; // ✅ NEW
      // ✅ NEW — GST Cannot Hold filters (bill withGst 2, or 0 = not marked as
      // hold, with GST): currentMonthGstCannotHold / pastMonthGstCannotHold.
      // Key name read case-insensitively (e.g. currentMonthgstcannotHold).
      const bodyFlag = (name) => {
        const key = Object.keys(req.body || {}).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? Number(req.body[key]) === 1 : false;
      };
      const includeCurrentGstCannotHold = bodyFlag("currentMonthGstCannotHold");
      const includePastGstCannotHold = bodyFlag("pastMonthGstCannotHold");

    const includeCurrentPendingRent = Number(wantCurrentPendingRent) === 1;
    const includePastRentalPending = Number(wantPastRentalPending) === 1;
    const includeCurrentGstPending = Number(wantCurrentGstPending) === 1;
    const includePastGstPending = Number(wantPastGstPending) === 1;

    const includeTotalLedgerAmount = Number(wantTotalLedgerAmount) === 1;
    const includeTotalLedgerGstAmount = Number(wantTotalLedgerGstAmount) === 1;
    const includeTotalLedgerPendingAmount = Number(wantTotalLedgerPendingAmount) === 1;
    const includeTotalGstPendingAmount = Number(wantTotalGstPendingAmount) === 1;

    const includeCurrentMonthRentPendingSites = Number(wantCurrentMonthRentPendingSites) === 1;
    const includeCurrentMonthGstPendingSites = Number(wantCurrentMonthGstPendingSites) === 1;
    const includeCurrentMonthRentPaidSites = Number(wantCurrentMonthRentPaidSites) === 1;
    const includeCurrentMonthGstPaidSites = Number(wantCurrentMonthGstPaidSites) === 1;
    const includePastRentPendingSites = Number(wantPastRentPendingSites) === 1;
    const includePastGstPendingSites = Number(wantPastGstPendingSites) === 1;
    const includeCurrentMonthOverallDueAmountSites = Number(wantCurrentMonthOverallDueAmount) === 1;
    const includeTotalOutstandingSites = Number(wantTotalOutstanding) === 1;

    const needsLedgerFields =
      includeCurrentLedger ||
      includePastLedger ||
      includeCurrentGst ||
      includePastGst ||
      includeCurrentPendingRent ||
      includePastRentalPending ||
      includeCurrentGstPending ||
      includePastGstPending ||
      includeTotalLedgerAmount ||
      includeTotalLedgerGstAmount ||
      includeTotalLedgerPendingAmount ||
      includeTotalGstPendingAmount ||
      includeCurrentMonthRentPendingSites ||
      includeCurrentMonthGstPendingSites ||
      includeCurrentMonthRentPaidSites ||
      includeCurrentMonthGstPaidSites ||
      includePastRentPendingSites ||
      includePastGstPendingSites ||
      includeCurrentMonthOverallDueAmountSites ||
      includeTotalOutstandingSites;

    const needsRentalStatusFields =
      includeApprovalSite ||
      includePendingSites ||
      includeOverDue ||
      includeCmdApproval ||
      includeDueThisMonth ||
      includeCurrentGstCannotHold || // ✅ NEW
      includePastGstCannotHold; // ✅ NEW
    const isAnyFilterActive = needsLedgerFields || needsRentalStatusFields;

    // let ownerFilter = {};
    const genericSearchRegex =
      search && search.trim() !== "" ? new RegExp(escapeRegex(search.trim()), "i") : null;
    const mediaSearchRegex =
      req.body?.mediaSearch && req.body.mediaSearch.trim() !== ""
        ? new RegExp(escapeRegex(req.body.mediaSearch.trim()), "i")
        : null;
    // combined regex used against media docs — either explicit
    // mediaSearch, or fall back to the generic `search` term
    const effectiveMediaSearchRegex = mediaSearchRegex || genericSearchRegex;

    const targetRole = roleType ? parseInt(roleType) : null;
    const [statsMonth, statsYear] = monthFilterApplied.split("-").map(Number);
    const statsMonthStart = new Date(statsYear, statsMonth - 1, 1);
    const statsMonthEnd = new Date(statsYear, statsMonth, 0, 23, 59, 59);
const restrictMediaIds = (Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : []).filter((id) => mongoose.Types.ObjectId.isValid(id));
    let ownerFilter = {};
    if (restrictMediaIds.length > 0) {
      const restrictDocs = await MediaOnboarding.find({ _id: { $in: restrictMediaIds } }, "landOwners.landOwnerMasterId").lean();
      const restrictOwners = new Set();
      restrictDocs.forEach((m) => (m.landOwners || []).forEach((o) => o.landOwnerMasterId && restrictOwners.add(String(o.landOwnerMasterId))));
      ownerFilter._id = { $in: Array.from(restrictOwners) };
    } else if (Array.isArray(landOwnerMasterIds) && landOwnerMasterIds.length > 0) {
      ownerFilter._id = { $in: landOwnerMasterIds };
    } else if (genericSearchRegex) {
      // ✅ ADDED — first, find owner ids matching mediaName/mediaCode
      // (the "apprisal 11" case), so a media-name search still
      // resolves to the correct owner(s) instead of coming back empty.
      const mediaMatchDocs = await MediaOnboarding.find(
        {
          $or: [
            { "mediaDetails.mediaName": genericSearchRegex },
            { "mediaDetails.mediaCode": genericSearchRegex },
            { "landOwners.name": genericSearchRegex },
          ],
        },
        "landOwners.landOwnerMasterId",
      ).lean();
      const ownerIdsFromMediaMatch = new Set();
      mediaMatchDocs.forEach((m) => {
        (m.landOwners || []).forEach((o) => {
          if (o.landOwnerMasterId)
            ownerIdsFromMediaMatch.add(String(o.landOwnerMasterId));
        });
      });

      ownerFilter.$or = [
        { name: genericSearchRegex },
        { panNumber: genericSearchRegex },
        { aadharCardNumber: genericSearchRegex },
        ...(ownerIdsFromMediaMatch.size > 0
          ? [{ _id: { $in: Array.from(ownerIdsFromMediaMatch) } }]
          : []),
      ];
    }

    const requestedOwners = await LandOwnerMaster.find(ownerFilter)
      .select("name phone updatedAt")
      .lean();

    if (requestedOwners.length === 0) {
      // ✅ NEW — Even when no owners match the search, we continue execution
      // to calculate and return the global system totals (Outstanding, Ledger,
      // and Status counts). This ensures the dashboard headers remain
      // populated.
    }

    const requestedOwnerIds = requestedOwners.map((o) => String(o._id));
    const ownerNameById = {};
    // ✅ ADDED — lookup for each owner's own updatedAt, used by the
    // latestActivityAt sort below.
    const ownerUpdatedAtById = {};
    requestedOwners.forEach((o) => {
      ownerNameById[String(o._id)] = o.name;
      ownerUpdatedAtById[String(o._id)] = o.updatedAt;
    });

    // ✅ CHANGED — always include ledger fields for overall summaries
    const mediaProjection =
      "gstApplicableFlag mediaDetails updatedAt rentalPayment landOwners._id landOwners.landOwnerMasterId landOwners.name landOwners.paymentCategory landOwners.gstApplicable landOwners.shareAmount landOwners.gstAmount landOwners.netPayableToOwner landOwners.onlineAmount landOwners.cashAmount landOwners.tdsAmount rentalDue rentalDueEntries ledger ledgerHistory gstBalanceHistory agreementDocVerification";

   let mediaQuery = {
      "landOwners.landOwnerMasterId": { $in: requestedOwnerIds },
      // ✅ CHANGED — uses effectiveMediaSearchRegex so a plain
      // `search` term (matched to media name/code) also narrows
      // which sites show up under the resolved owner(s), not just
      // an explicit `mediaSearch` param.
      ...(effectiveMediaSearchRegex
        ? {
            $or: [
              { "mediaDetails.mediaName": effectiveMediaSearchRegex },
              { "mediaDetails.mediaCode": effectiveMediaSearchRegex },
              { "landOwners.name": effectiveMediaSearchRegex },

            ],
          }
        : {}),
    };

    if (city) {
      if (Array.isArray(city)) {
        mediaQuery["mediaDetails.city"] = {
          $in: city.map((c) => new RegExp(`^${escapeRegex(String(c).trim())}$`, "i")),
        };
      } else {
        mediaQuery["mediaDetails.city"] = new RegExp(`^${escapeRegex(String(city).trim())}$`, "i");
      }
    }

    let relatedMediaDocs = await MediaOnboarding.find(
      mediaQuery,
      mediaProjection,
    ).lean();

    // ✅ NEW — billDate (5 / 10 / 15 / 20 / 25 / 30) also filters the SITE LIST:
    // only sites with that bill date are listed, together with pendingSite /
    // approvalSite / overDue / the other filters (AND). Not sent → all sites.
    const listBillDateFilter = parseBillDateFilter(req.body?.billDate);
    if (listBillDateFilter.length) {
      relatedMediaDocs = relatedMediaDocs.filter((m) => listBillDateFilter.includes(siteBillDate(m)));
    }

    // roleType does NOT reduce landowners or sites by itself; it changes the header
    // summary totals AND the approvalSite / pendingSite / overDue filters (role rule).

    // ✅ Ensure all site cycles are processed for the requested month
    for (const media of relatedMediaDocs) {
      await ensureRentalDueForCycles(
        media,
        { year: referenceYear, month: referenceMonthIdx + 1 },
        req.user?.userName || "Admin",
      );
    }

    const allOwnerIdsFromMedia = new Set();
    relatedMediaDocs.forEach((mediaDoc) => {
      (mediaDoc.landOwners || []).forEach((o) => {
        if (o.landOwnerMasterId) {
          allOwnerIdsFromMedia.add(String(o.landOwnerMasterId));
        }
      });
    });

    const allOwnersFromMedia = await LandOwnerMaster.find(
      { _id: { $in: Array.from(allOwnerIdsFromMedia) } },
      "name",
    ).lean();

    allOwnersFromMedia.forEach((o) => {
      const id = String(o._id);
      if (!ownerNameById[id]) {
        ownerNameById[id] = o.name;
      }
    });

    // ✅ ADDED — per-owner, per-media ledger/GST buckets, computed
    // ONCE up front (keyed by "mediaId_ownerId") and reused wherever
    // an owner appears (sole-owned or shared sites), instead of
    // recomputing per entry.
    const ledgerDataByMediaOwner = new Map();

    if (needsLedgerFields) {
      relatedMediaDocs.forEach((mediaDoc) => {
        const mediaId = String(mediaDoc._id);

        // ✅ ADDED — Build a map from sub-document landOwnerId to LandOwnerMasterId
        // because ledger entries and GST history often store the sub-doc _id.
        const subToMasterMap = {};
        (mediaDoc.landOwners || []).forEach((lo) => {
          if (lo._id && lo.landOwnerMasterId) {
            subToMasterMap[String(lo._id)] = String(lo.landOwnerMasterId);
          }
        });

        // ✅ ADDED — the SAME cycle-walking numbers that feed
        // overallCurrentBaseRentDue / overallCurrentGSTDue /
        // overallPreviousBaseRentDue / overallPreviousGSTDue in
        // listMediaByLedger, sliced per owner. This is now the
        // authoritative source for the 4 pending numeric totals below —
        // the manual ledger/gstBalanceHistory scan is kept only for
        // building the displayable entries[] list, not for the totals.
        const ownerWiseOutstanding = getOwnerWiseOutstanding(mediaDoc, {
          year: referenceYear,
          month: referenceMonthIdx + 1,
        });

        // real ledger rows saved this cycle (live "ledger" array,
        // withGst:2 rows = rental Cash/Online payments)
        const liveLedgerEntries = Array.isArray(mediaDoc.ledger)
          ? mediaDoc.ledger
          : [];

        // historical ledger rows, bucketed by year/month
        const historyEntries = [];
        (mediaDoc.ledgerHistory || []).forEach((yearBucket) => {
          (yearBucket.months || []).forEach((monthBucket) => {
            (monthBucket.entries || []).forEach((entry) => {
              if (
                (Number(entry.withGst) === 2 || Number(entry.withGst) === 0) &&
                entry.paymentMode
              ) {
                historyEntries.push({
                  ...entry,
                  dueMonth: entry.month,
                  yearFromBucket: yearBucket.year,
                });
              }
            });
          });
        });

        const allLedgerEntries = [...liveLedgerEntries, ...historyEntries];

        allLedgerEntries.forEach((entry) => {
          if (!entry.landOwnerId) return;
          const rawOwnerId = String(entry.landOwnerId);
          const ownerId = subToMasterMap[rawOwnerId] || rawOwnerId; // ✅ Translate to Master ID
          const key = `${mediaId}_${ownerId}`;
          if (!ledgerDataByMediaOwner.has(key)) {
            ledgerDataByMediaOwner.set(key, {
              currentMonthEntries: [],
              pastMonthEntries: [],
              currentPendingRentEntries: [],
              pastRentalPendingEntries: [],
              currentGst: 0,
              pastGst: 0,
              currentGstPending: 0,
              pastGstPending: 0,
            });
          }
          const bucket = ledgerDataByMediaOwner.get(key);

          // classify this entry's month against referenceYear/referenceMonthIdx
          let entryYear = null;
          let entryMonthIdx = null;
          const entryCycle = entry.cycle || entry.date;
          if (entry.dueMonth) {
            const parsed = parseSiteFilterDueMonthLabel(entry.dueMonth);
            if (parsed) {
              entryYear = parsed.year;
              entryMonthIdx = parsed.monthIdx;
            }
          }
          if (entryYear === null && entryCycle) {
            const d = new Date(entryCycle);
            if (!Number.isNaN(d.getTime())) {
              entryYear = d.getFullYear();
              entryMonthIdx = d.getMonth();
            }
          }
          if (entryYear === null) return; // can't classify — skip

          const isCurrentMonth =
            entryYear === referenceYear && entryMonthIdx === referenceMonthIdx;
          const isPastMonth =
            entryYear < referenceYear ||
            (entryYear === referenceYear && entryMonthIdx < referenceMonthIdx);

          // ✅ FIXED — "pending" must be driven by payment status, not UTR
          // presence. Cash entries legitimately have NO utrNumber even when
          // fully paid (utrNumber is only ever set for "Online"), so using
          // !entry.utrNumber was flagging every paid Cash row as pending.
          const isPending = Number(entry.status) !== 1;

          const shapedEntry = {
            mediaId: mediaDoc._id,
            mediaName: mediaDoc.mediaName,
            landOwnerMasterId: ownerId,
            paymentMode: entry.paymentMode,
            amount: Number(entry.amount || 0),
            status: entry.status,
            date: entry.date,
            utrNumber: entry.utrNumber,
            dueMonth: entry.dueMonth || entry.month || null,
          };

          if (isCurrentMonth) {
            bucket.currentMonthEntries.push(shapedEntry);
            if (isPending) bucket.currentPendingRentEntries.push(shapedEntry);
          } else if (isPastMonth) {
            bucket.pastMonthEntries.push(shapedEntry);
            if (isPending) bucket.pastRentalPendingEntries.push(shapedEntry);
          }
        });

        // GST — currentGst from rentalDue's cycle matching referenceMonth,
        // pastGst from unpaid gstBalanceHistory rows before referenceMonth
        // PLUS legacy rentalPayment.gstOutstandingHistory (merged, per
        // your instruction — same key, summed together, not separated).
        const gstBalanceHistory = dedupeGstBalanceHistory(
          Array.isArray(mediaDoc.gstBalanceHistory)
            ? mediaDoc.gstBalanceHistory
            : [],
        );
        const gstOutstandingHistory = Array.isArray(
          mediaDoc.rentalPayment?.gstOutstandingHistory,
        )
          ? mediaDoc.rentalPayment.gstOutstandingHistory
          : [];
        const rentalDueEntries = Array.isArray(mediaDoc.rentalDue)
          ? mediaDoc.rentalDue
          : [];

        // group GST rows by owner where possible (source:"owner" rows
        // carry ownerId; source:"rental"/legacy rows are site-level and
        // get attributed to every owner on this site)
        const ownerIdsOnSite = (mediaDoc.landOwners || [])
          .map((o) => o.landOwnerMasterId && String(o.landOwnerMasterId))
          .filter(Boolean);

        gstBalanceHistory.forEach((row) => {
          const parsed = parseSiteFilterDueMonthLabel(row.dueMonth);
          if (!parsed) return;
          const isCurrentMonth =
            parsed.year === referenceYear &&
            parsed.monthIdx === referenceMonthIdx;
          const isPastMonth =
            parsed.year < referenceYear ||
            (parsed.year === referenceYear &&
              parsed.monthIdx < referenceMonthIdx);
          if (!isCurrentMonth && !isPastMonth) return;

          const rowOwnerId = row.ownerId ? String(row.ownerId) : null;
          const targetOwnerIds = rowOwnerId
            ? [subToMasterMap[rowOwnerId] || rowOwnerId]
            : ownerIdsOnSite;

          targetOwnerIds.forEach((ownerId) => {
            const key = `${mediaId}_${ownerId}`;
            if (!ledgerDataByMediaOwner.has(key)) {
              ledgerDataByMediaOwner.set(key, {
                currentMonthEntries: [],
                pastMonthEntries: [],
                currentPendingRentEntries: [],
                pastRentalPendingEntries: [],
                currentGst: 0,
                pastGst: 0,
                currentGstPending: 0,
                pastGstPending: 0,
              });
            }
            const bucket = ledgerDataByMediaOwner.get(key);
            const amt = Number(row.gstAmount || 0);

            // ✅ IMPROVED: Robust check for paid status
            const isGstPaid =
              row.isPaid === true ||
              row.isPaid === "true" ||
              (row.utrNumber &&
                String(row.utrNumber).trim() !== "" &&
                row.date);

            if (isCurrentMonth) {
              bucket.currentGst += amt;
              if (!isGstPaid) bucket.currentGstPending += amt;
            } else if (isPastMonth && !isGstPaid) {
              // ✅ pastGst = unpaid past-cycle ledger GST only
              bucket.pastGst += amt;
              bucket.pastGstPending += amt;
            }
          });
        });

        // legacy pre-onboarding outstanding GST — merged into the SAME
        // pastGst key, attributed to every owner on this site, unpaid rows only
        gstOutstandingHistory.forEach((row) => {
          // ✅ FIXED — same robust "paid" check as the gstBalanceHistory loop
          // above (isPaid flag OR a real UTR+date), instead of trusting
          // isPaid alone, which can be left stale/false even after a UTR was
          // recorded against this row.
          const isRowPaid =
            row.isPaid === true ||
            row.isPaid === "true" ||
            (row.utrNumber && String(row.utrNumber).trim() !== "" && row.date);
          if (isRowPaid) return;

          const amt = Number(row.gstOutStandingAmount || 0);
          ownerIdsOnSite.forEach((ownerId) => {
            const key = `${mediaId}_${ownerId}`;
            if (!ledgerDataByMediaOwner.has(key)) {
              ledgerDataByMediaOwner.set(key, {
                currentMonthEntries: [],
                pastMonthEntries: [],
                currentPendingRentEntries: [],
                pastRentalPendingEntries: [],
                currentGst: 0,
                pastGst: 0,
                currentGstPending: 0,
                pastGstPending: 0,
              });
            }
            const bucket = ledgerDataByMediaOwner.get(key);
            bucket.pastGst += amt;
            bucket.pastGstPending += amt;
          });
        });

        // fallback — if no gstBalanceHistory row exists yet for the
        // current cycle, derive currentGst from rentalDue directly
        const resolveGstForOwnerThisCycle = (ownerId) => {
          let gstFlag = Number(mediaDoc.gstApplicableFlag || 0);
          const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");

          const calcOwnerGst = (o) => {
            const pc = Number(o.paymentCategory || 1);
            let base = 0;
            if (pc === 2) base = Number(o.shareAmount || 0);
            else if (pc === 3) base = Number(o.onlineAmount || 0);
            return Math.floor((base * envGstPct) / 100);
          };

          const rentalGst =
            Number(mediaDoc.rentalPayment?.gstApplicable) === 1
              ? Number(mediaDoc.rentalPayment?.gstAmount || 0) ||
                Math.floor(
                  (Number(mediaDoc.rentalPayment?.totalRentalAmount || 0) *
                    envGstPct) /
                    100,
                )
              : 0;

          const owner = (mediaDoc.landOwners || []).find(
            (o) =>
              o.landOwnerMasterId && String(o.landOwnerMasterId) === ownerId,
          );
          const ownerGst =
            owner && Number(owner.gstApplicable) === 1
              ? Number(owner.gstAmount || 0) || calcOwnerGst(owner)
              : 0;

          if (gstFlag === 1) return rentalGst / (ownerIdsOnSite.length || 1);
          if (gstFlag === 2) return ownerGst;

          // Flag 0: sum them (usually one is likely 0, but "cannot reduce" implies we want all applicable GST)
          return rentalGst / (ownerIdsOnSite.length || 1) + ownerGst;
        };

        rentalDueEntries.forEach((due) => {
          const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
          if (!parsed) return;
          const isCurrentMonth =
            parsed.year === referenceYear &&
            parsed.monthIdx === referenceMonthIdx;
          if (!isCurrentMonth) return;

          // ✅ FIXED: Only separated (1) or pending (0) GST cycles show in GST bucket.
          // Included (2) GST is already folded into Rent buckets.
          if (Number(due.withGst) !== 1 && Number(due.withGst) !== 0) return;
          const hasGstRowAlready = gstBalanceHistory.some(
            (g) =>
              String(g.dueMonth || "")
                .trim()
                .toLowerCase() ===
              String(due.dueMonth || "")
                .trim()
                .toLowerCase(),
          );
          if (hasGstRowAlready) return; // already counted above

          ownerIdsOnSite.forEach((ownerId) => {
            const key = `${mediaId}_${ownerId}`;
            if (!ledgerDataByMediaOwner.has(key)) {
              ledgerDataByMediaOwner.set(key, {
                currentMonthEntries: [],
                pastMonthEntries: [],
                currentPendingRentEntries: [],
                pastRentalPendingEntries: [],
                currentGst: 0,
                pastGst: 0,
                currentGstPending: 0,
                pastGstPending: 0,
              });
            }
            // ✅ CHANGED — was Number(due.gstAmount || 0), now uses the
            // properly resolved amount.
            const resolvedGst = resolveGstForOwnerThisCycle(ownerId);
            const bucket = ledgerDataByMediaOwner.get(key);
            bucket.currentGst += resolvedGst;
            bucket.currentGstPending += resolvedGst;
          });
        });

        // ✅ ADDED — pastMonthEntries was ONLY ever populated from real
        // saved ledger rows (mediaDoc.ledger/ledgerHistory), so a site
        // that's genuinely behind on rent — never paid at all, so
        // nothing exists in ledger/ledgerHistory for that cycle —
        // showed up correctly in overallPreviousBaseRentDue (which
        // reads unpaid rentalDue cycles directly via
        // computeOutstandingSummary) but produced ZERO rows here,
        // silently filtering the owner out of entries entirely. This
        // walks every PAST rentalDue cycle and pushes a virtual "still
        // owed" entry into pastMonthEntries for any owner+mode that
        // has no matching real payment recorded — same source of
        // truth as the overall totals, so entries[] and the summary
        // numbers now agree on which owners actually have past-due
        // amounts.
        const getRequiredModesForPastCheck = (paymentCategory) => {
          if (paymentCategory === 1) return ["Cash"];
          if (paymentCategory === 2) return ["Online"];
          if (paymentCategory === 3) return ["Cash", "Online"];
          return ["Cash"];
        };

        rentalDueEntries.forEach((due) => {
          const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
          if (!parsed) return;
          const isPastMonth =
            parsed.year < referenceYear ||
            (parsed.year === referenceYear &&
              parsed.monthIdx < referenceMonthIdx);
          if (!isPastMonth) return;
          if (Number(due.withGst) !== 2) return;
          (mediaDoc.landOwners || []).forEach((owner) => {
            const ownerId =
              owner.landOwnerMasterId && String(owner.landOwnerMasterId);
            if (!ownerId) return;
            const paymentCategory = Number(owner.paymentCategory || 1);
            const requiredModes = getRequiredModesForPastCheck(paymentCategory);

            requiredModes.forEach((mode) => {
              // did a REAL entry already cover this owner+mode+month?
              const keyMaster = `${mediaId}_${ownerId}`;
              const keySubDoc = (mediaDoc.landOwners || []).find(
                (lo) => String(lo.landOwnerMasterId) === ownerId,
              )?._id;
              const keySub = keySubDoc
                ? `${mediaId}_${String(keySubDoc)}`
                : null;

              let bucket =
                ledgerDataByMediaOwner.get(keyMaster) ||
                (keySub ? ledgerDataByMediaOwner.get(keySub) : null);

              // ✅ Robust check: look for any entry matching month and mode
              const alreadyCoveredByRealEntry = bucket?.pastMonthEntries.some(
                (e) =>
                  String(e.paymentMode).toLowerCase() ===
                    String(mode).toLowerCase() &&
                  String(e.dueMonth || "")
                    .trim()
                    .toLowerCase() ===
                    String(due.dueMonth || "")
                      .trim()
                      .toLowerCase(),
              );
              if (alreadyCoveredByRealEntry) return;

              const modeAmount =
                mode === "Cash"
                  ? Number(owner.cashAmount || owner.shareAmount || 0)
                  : Number(owner.onlineAmount || owner.shareAmount || 0);
              if (modeAmount <= 0) return;

              if (!bucket) {
                bucket = {
                  currentMonthEntries: [],
                  pastMonthEntries: [],
                  currentPendingRentEntries: [],
                  pastRentalPendingEntries: [],
                  currentGst: 0,
                  pastGst: 0,
                  currentGstPending: 0,
                  pastGstPending: 0,
                  hasCurrentMonthRentPaid: false,
                  hasCurrentMonthGstPaid: false,
                };
                ledgerDataByMediaOwner.set(keyMaster, bucket);
              }
              const virtualEntry = {
                mediaId: mediaDoc._id,
                mediaName: mediaDoc.mediaName,
                landOwnerMasterId: ownerId,
                paymentMode: mode,
                amount: modeAmount,
                status: 0, // unpaid/virtual
                date: null,
                utrNumber: null,
                dueMonth: due.dueMonth,
                isVirtual: true,
              };
              bucket.pastMonthEntries.push(virtualEntry);
              bucket.pastRentalPendingEntries.push(virtualEntry);
            });
          });
        });

        // ✅ ADDED — same gap, current month. currentMonthEntries was
        // ONLY ever populated from real saved ledger rows, so a site
        // whose CURRENT-month rent isn't paid yet (contributing to
        // overallCurrentBaseRentDue) produced zero rows here — an
        // owner genuinely due this month silently disappeared from
        // entries[] when filtering on currentMonthLedgerEntries.
        // Mirrors the past-month fix above, just for isCurrentMonth
        // instead of isPastMonth.
        rentalDueEntries.forEach((due) => {
          const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
          if (!parsed) return;
          const isCurrentDueMonth =
            parsed.year === referenceYear &&
            parsed.monthIdx === referenceMonthIdx;
          if (!isCurrentDueMonth) return;

          (mediaDoc.landOwners || []).forEach((owner) => {
            const ownerId =
              owner.landOwnerMasterId && String(owner.landOwnerMasterId);
            if (!ownerId) return;
            const paymentCategory = Number(owner.paymentCategory || 1);
            const requiredModes = getRequiredModesForPastCheck(paymentCategory);

            requiredModes.forEach((mode) => {
              const keyMaster = `${mediaId}_${ownerId}`;
              const keySubDoc = (mediaDoc.landOwners || []).find(
                (lo) => String(lo.landOwnerMasterId) === ownerId,
              )?._id;
              const keySub = keySubDoc
                ? `${mediaId}_${String(keySubDoc)}`
                : null;

              let bucket =
                ledgerDataByMediaOwner.get(keyMaster) ||
                (keySub ? ledgerDataByMediaOwner.get(keySub) : null);

              // ✅ Robust check: look for any entry matching month and mode
              const alreadyCoveredByRealEntry =
                bucket?.currentMonthEntries.some(
                  (e) =>
                    String(e.paymentMode).toLowerCase() ===
                      String(mode).toLowerCase() &&
                    String(e.dueMonth || "")
                      .trim()
                      .toLowerCase() ===
                      String(due.dueMonth || "")
                        .trim()
                        .toLowerCase(),
                );
              if (alreadyCoveredByRealEntry) return;

              const modeAmount =
                mode === "Cash"
                  ? Number(owner.cashAmount || owner.shareAmount || 0)
                  : Number(owner.onlineAmount || owner.shareAmount || 0);
              if (modeAmount <= 0) return;

              if (!bucket) {
                bucket = {
                  currentMonthEntries: [],
                  pastMonthEntries: [],
                  currentPendingRentEntries: [],
                  pastRentalPendingEntries: [],
                  currentGst: 0,
                  pastGst: 0,
                  currentGstPending: 0,
                  pastGstPending: 0,
                  hasCurrentMonthRentPaid: false,
                  hasCurrentMonthGstPaid: false,
                };
                ledgerDataByMediaOwner.set(keyMaster, bucket);
              }
              const virtualEntry = {
                mediaId: mediaDoc._id,
                mediaName: mediaDoc.mediaName,
                landOwnerMasterId: ownerId,
                paymentMode: mode,
                amount: modeAmount,
                status: 0, // unpaid/virtual
                date: null,
                utrNumber: null,
                dueMonth: due.dueMonth,
                isVirtual: true,
              };
              bucket.currentMonthEntries.push(virtualEntry);
              bucket.currentPendingRentEntries.push(virtualEntry);
            });
          });
        });

        // ✅ FIXED — this must run INSIDE the relatedMediaDocs.forEach
        // callback since it references mediaId/subToMasterMap/
        // ownerWiseOutstanding, all declared inside that callback. It
        // was previously placed after the callback's closing "});",
        // pushing it out of scope → "ownerWiseOutstanding is not defined".
        Object.entries(ownerWiseOutstanding).forEach(
          ([subOwnerId, amounts]) => {
            const masterOwnerId = subToMasterMap[subOwnerId] || subOwnerId;
            const key = `${mediaId}_${masterOwnerId}`;
            if (!ledgerDataByMediaOwner.has(key)) {
              ledgerDataByMediaOwner.set(key, {
                currentMonthEntries: [],
                pastMonthEntries: [],
                currentPendingRentEntries: [],
                pastRentalPendingEntries: [],
                currentGst: 0,
                pastGst: 0,
                currentGstPending: 0,
                pastGstPending: 0,
              });
            }
            const bucket = ledgerDataByMediaOwner.get(key);
            bucket.currentRentPending = amounts.currentRentPending;
            bucket.pastRentPending = amounts.pastRentPending;
            bucket.currentGstPending = amounts.currentGstPending;
            bucket.pastGstPending = amounts.pastGstPending;
          },
        );
      }); // ✅ MOVED — this now closes relatedMediaDocs.forEach((mediaDoc) => {...})
    }

    // ✅ ADDED — aggregate a site's ledger data across all its owners,
    // used for "shared" entries where multiple owners split one site.
    const getLedgerBucketsForSite = (mediaId, ownerIds) => {
      const merged = {
        currentMonthEntries: [],
        pastMonthEntries: [],
        currentPendingRentEntries: [],
        pastRentalPendingEntries: [],
        currentGst: 0,
        pastGst: 0,
        currentGstPending: 0,
        pastGstPending: 0,
        currentRentPending: 0, // ✅ ADDED — reconciled numeric total
        pastRentPending: 0, // ✅ ADDED — reconciled numeric total
      };
      ownerIds.forEach((ownerId) => {
        const key = `${mediaId}_${ownerId}`;
        const bucket = ledgerDataByMediaOwner.get(key);
        if (!bucket) return;
        merged.currentMonthEntries.push(...bucket.currentMonthEntries);
        merged.pastMonthEntries.push(...bucket.pastMonthEntries);
        merged.currentPendingRentEntries.push(
          ...bucket.currentPendingRentEntries,
        );
        merged.pastRentalPendingEntries.push(
          ...bucket.pastRentalPendingEntries,
        );
        merged.currentGst += bucket.currentGst;
        merged.pastGst += bucket.pastGst;
        merged.currentGstPending += bucket.currentGstPending;
        merged.pastGstPending += bucket.pastGstPending;
        merged.currentRentPending += bucket.currentRentPending || 0; // ✅ ADDED
        merged.pastRentPending += bucket.pastRentPending || 0; // ✅ ADDED
      });
      return merged;
    };

    const siteMap = new Map();
    relatedMediaDocs.forEach((mediaDoc) => {
      const ownersOnThisSite = (mediaDoc.landOwners || []).filter(
        (o) => o.landOwnerMasterId,
      );
      const ownerIdsOnThisSite = ownersOnThisSite.map((o) =>
        String(o.landOwnerMasterId),
      );

      const siteGstFlag = Number(mediaDoc.gstApplicableFlag || 0);
      const ownerLevelGstTotal = ownersOnThisSite.reduce(
        (sum, o) => sum + Number(o.gstAmount || 0),
        0,
      );
      const rentalLevelGstAmount =
        Number(mediaDoc.rentalPayment?.gstApplicable) === 1
          ? Number(mediaDoc.rentalPayment?.gstAmount || 0)
          : 0;

      const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
      // ✅ IMPROVED — calculate if 0 but applicable
      const calcRentalGst = () =>
        Math.floor(
          (Number(mediaDoc.rentalPayment?.totalRentalAmount || 0) * envGstPct) /
            100,
        );
      const calcOwnerGst = (o) => {
        const pc = Number(o.paymentCategory || 1);
        let base = 0;
        if (pc === 2) base = Number(o.shareAmount || 0);
        else if (pc === 3) base = Number(o.onlineAmount || 0);
        return Math.floor((base * envGstPct) / 100);
      };

      // ✅ NEW: compute rental status for this site relative to reference month
      const rawRentalDue = Array.isArray(mediaDoc.rentalDue)
        ? mediaDoc.rentalDue
        : Array.isArray(mediaDoc.rentalDueEntries)
          ? mediaDoc.rentalDueEntries
          : [];

      const rentalDue = rawRentalDue.map((due) => {
        if (due.dueMonth) return due;
        return {
          ...due,
          dueMonth: due.dueDate
            ? `${SITE_FILTER_MONTH_NAMES[new Date(due.dueDate).getMonth()]} ${new Date(due.dueDate).getFullYear()}`
            : null,
        };
      });

      // ✅ DISCOVERY: Check if any cycle in rentalDue indicates GST is present
      let cycleGstAmount = 0;
      let cycleWithGst = 0;
      const currentCycle = (rentalDue || []).find((due) => {
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        return (
          parsed &&
          parsed.year === referenceYear &&
          parsed.monthIdx === referenceMonthIdx
        );
      });

      if (currentCycle) {
        cycleWithGst = Number(currentCycle.withGst || 0);
        if (Number(currentCycle.gstAmount) > 0) {
          cycleGstAmount = Number(currentCycle.gstAmount);
        } else if (
          Number(currentCycle.withGst) === 1 ||
          Number(currentCycle.withGst) === 2
        ) {
          const net = Number(currentCycle.netPayable || 0);
          const base = Number(currentCycle.baseAmount || 0);
          if (net > base && base > 0) {
            cycleGstAmount = net - base;
          } else if (net > 0) {
            cycleGstAmount = Math.floor(net - net / (1 + envGstPct / 100));
          }
        }
      }

      const rentalGst =
        rentalLevelGstAmount ||
        (Number(mediaDoc.rentalPayment?.gstApplicable) === 1
          ? calcRentalGst()
          : 0);
      const ownersGst =
        ownerLevelGstTotal ||
        ownersOnThisSite.reduce((sum, o) => {
          if (Number(o.gstApplicable) !== 1) return sum;
          return sum + (Number(o.gstAmount || 0) || calcOwnerGst(o));
        }, 0);

      // ✅ AGGREGATE: Take the maximum or discovered amount to ensure it "cannot reduce"
      let resolvedSiteGstAmount = Math.max(
        rentalGst,
        ownersGst,
        cycleGstAmount,
      );

      // If still 0 but we have evidence from siteGstFlag or any cycle flag, force calculation
      if (resolvedSiteGstAmount === 0) {
        if (
          siteGstFlag === 1 ||
          Number(mediaDoc.rentalPayment?.gstApplicable) === 1
        ) {
          resolvedSiteGstAmount = calcRentalGst();
        } else if (
          siteGstFlag === 2 ||
          ownersOnThisSite.some((o) => Number(o.gstApplicable) === 1)
        ) {
          resolvedSiteGstAmount = ownersOnThisSite.reduce((sum, o) => {
            return (
              sum +
              (Number(o.gstApplicable) === 1
                ? Number(o.gstAmount || 0) || calcOwnerGst(o)
                : 0)
            );
          }, 0);
        }
      }

      const hasApprovedSite = rentalDue.some((due) => {
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        return (
          parsed &&
          parsed.year === referenceYear &&
          parsed.monthIdx === referenceMonthIdx &&
          due.approvalStatus === 3
        );
      });
      const hasPendingSite = rentalDue.some((due) => {
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        const status = due.approvalStatus ?? 1;
        return (
          parsed &&
          parsed.year === referenceYear &&
          parsed.monthIdx === referenceMonthIdx &&
          (status === 1 || status === 2)
        );
      });
      // ✅ CHANGED — Merged into isOverDueSite per user request
      const hasPastPendingSite = rentalDue.some((due) => {
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        const isPast =
          parsed &&
          (parsed.year < referenceYear ||
            (parsed.year === referenceYear &&
              parsed.monthIdx < referenceMonthIdx));
        const status = due.approvalStatus ?? 1;
        return isPast && (status === 1 || status === 2);
      });
      const isOverDueSite =
        Number(mediaDoc.rentalPayment?.status) === 3 ||
        hasPastPendingSite || // ✅ Merged
        rentalDue.some((due) => {
          const status = due.approvalStatus ?? due.status ?? 1;
          const isPastDueDate = due.dueDate && new Date(due.dueDate) < today;
          return status === 4 || (isPastDueDate && status !== 3);
        });

      const overallSummary = getOverallSummaryForCycle(mediaDoc, {
        year: referenceYear,
        month: referenceMonthIdx + 1,
      });
// ✅ Compute the "real" latest activity across this site and its sub-docs
      // (approval steps, verification records, etc.) since Mongoose updatedAt
      // might be bypassed with { timestamps: false }.
      let siteLatestActivityAt = mediaDoc.updatedAt;

      if (Array.isArray(mediaDoc.agreementDocVerification)) {
        mediaDoc.agreementDocVerification.forEach((v) => {
          if (
            v.verifiedAt &&
            (!siteLatestActivityAt ||
              new Date(v.verifiedAt) > new Date(siteLatestActivityAt))
          ) {
            siteLatestActivityAt = v.verifiedAt;
          }
        });
      }

      if (Array.isArray(rentalDue)) {
        rentalDue.forEach((e) => {
          if (
            e.updatedAt &&
            (!siteLatestActivityAt ||
              new Date(e.updatedAt) > new Date(siteLatestActivityAt))
          ) {
            siteLatestActivityAt = e.updatedAt;
          }
          if (
            e.ownerApprovalDate &&
            (!siteLatestActivityAt ||
              new Date(e.ownerApprovalDate) > new Date(siteLatestActivityAt))
          ) {
            siteLatestActivityAt = e.ownerApprovalDate;
          }
          if (Array.isArray(e.approvalSteps)) {
            e.approvalSteps.forEach((s) => {
              if (
                s.approvedAt &&
                (!siteLatestActivityAt ||
                  new Date(s.approvedAt) > new Date(siteLatestActivityAt))
              ) {
                siteLatestActivityAt = s.approvedAt;
              }
            });
          }
        });
      }
      const details = (mediaDoc.mediaDetails || []).filter((d) => {
  if (Number(d.status) !== 1) return false;
  if (city) {
    const cities = Array.isArray(city)
      ? city.map((c) => String(c).trim().toLowerCase())
      : [String(city).trim().toLowerCase()];
    const faceCity = (d.city || "").trim().toLowerCase();
    const matchesCity = cities.includes(faceCity);
    if (!matchesCity) return false;
  }
  return true;
});
      // ✅ NEW — with roleType, approved / pending / overDue per face follow the
      // same role rule as the header counts (waiting on that role)
      const roleFaceFlags = targetRole
        ? getFaceRoleStatus(mediaDoc, { year: referenceYear, month: referenceMonthIdx + 1, targetRole, pendingAtRoleOnly: true, singleBillAsSite: true, overdueByRole: true })
        : null;
      details.forEach((face) => {
        const faceId = String(face._id);
        const uniqueFaceKey = `${String(mediaDoc._id)}_${faceId}`;
        const roleFlags = roleFaceFlags ? roleFaceFlags.get(faceId) : null;

        // ✅ NEW — this face has a due (current or any past month) waiting on CMD or approved by CMD
        const hasCmdApprovalSite = rentalDue.some((due) => {
          if (due.mediaDetailId && String(due.mediaDetailId) !== faceId) return false;
          const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
          const isUpToReference =
            parsed &&
            (parsed.year < referenceYear ||
              (parsed.year === referenceYear && parsed.monthIdx <= referenceMonthIdx));
          return isUpToReference && isDueInCmdApproval(due) && !isCmdDueFullySettled(mediaDoc, mediaDoc.landOwners, due); // ✅ paid months drop out
        });

        const hasDueThisMonthSite = rentalDue.some((due) => {
          if (due.mediaDetailId && String(due.mediaDetailId) !== faceId) return false;
          const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
          return (
            parsed &&
            parsed.year === referenceYear &&
            parsed.monthIdx === referenceMonthIdx
          );
        });

        // ✅ NEW — GST Cannot Hold: this face's bill with withGst 2 (or 0 = not
        // marked as hold) and GST on it — current month / past months
        const cannotHoldMonths = rentalDue
          .filter((due) => {
            if (due.mediaDetailId && String(due.mediaDetailId) !== faceId) return false;
            if (Number(due.withGst || 0) === 1) return false;
            return Number(due.gstAmount || 0) > 0 || Number(resolvedSiteGstAmount || 0) > 0;
          })
          .map((due) => parseSiteFilterDueMonthLabel(due.dueMonth))
          .filter(Boolean);
        const hasCurrentGstCannotHoldSite = cannotHoldMonths.some(
          (p) => p.year === referenceYear && p.monthIdx === referenceMonthIdx,
        );
        const hasPastGstCannotHoldSite = cannotHoldMonths.some(
          (p) => p.year < referenceYear || (p.year === referenceYear && p.monthIdx < referenceMonthIdx),
        );

        // ✅ Resolve final GST applicability (1=Hold, 2=Direct)
        let finalGstApplicable = 0;
        if (cycleWithGst === 1 || cycleWithGst === 2) {
          finalGstApplicable = cycleWithGst;
        } else if (resolvedSiteGstAmount > 0) {
          // Fallback if not in cycle record
          finalGstApplicable = 1; // Default to hold if amount exists but flag is missing
        }

        siteMap.set(uniqueFaceKey, {
          mediaId: mediaDoc._id,
          mediaDetailId: face._id,
          mediaCode: face.mediaCode,
          mediaName: face.mediaName,
          mediaDetailsCount: 1,
          totalRentalAmount: mediaDoc.rentalPayment?.totalRentalAmount || 0,
          gstAmount: resolvedSiteGstAmount,
          gstApplicable: finalGstApplicable,
          updatedAt: siteLatestActivityAt,
          ownerIds: ownerIdsOnThisSite,
          _overallSummary: overallSummary,
          // ✅ NEW — internal: the site's pre-onboarding GST outstanding rows
          // (on its first listed face only, so they are not repeated per face)
          _gstOutstanding: face === details[0] ? mediaDoc.rentalPayment?.gstOutstandingHistory || [] : [],
          // ✅ NEW — internal: single bill site (no face on separate bill)
          _isSingleBill: !(mediaDoc.mediaDetails || []).some((d) => Number(d.siteBillMode) === 2),
          rentalStatus: {
            hasApprovedSite: roleFaceFlags ? !!roleFlags?.approved : hasApprovedSite,
            hasPendingSite: roleFaceFlags ? !!roleFlags?.pending : hasPendingSite,
            isOverDueSite: roleFaceFlags ? !!roleFlags?.overdue : isOverDueSite,
            hasCmdApprovalSite, // ✅ NEW
            // ✅ CHANGED — every site with a bill this month (any roleType)
            hasDueThisMonthSite,
            hasCurrentGstCannotHoldSite, // ✅ NEW
            hasPastGstCannotHoldSite, // ✅ NEW
          },
          ownersDetail: ownersOnThisSite.map((o) => {
            const pc = Number(o.paymentCategory || 1);
            const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
            const calcOwnerGst = (owner) => {
              let base = 0;
              if (pc === 2) base = Number(owner.shareAmount || 0);
              else if (pc === 3) base = Number(owner.onlineAmount || 0);
              return Math.floor((base * envGstPct) / 100);
            };

            let oGst = Number(o.gstAmount || 0);

            if (oGst === 0 && Number(o.gstApplicable) === 1) {
              oGst = calcOwnerGst(o);
            }

            if (oGst === 0 && resolvedSiteGstAmount > 0) {
              if (siteGstFlag === 1 || siteGstFlag === 0) {
                oGst = Math.floor(
                  resolvedSiteGstAmount / (ownersOnThisSite.length || 1),
                );
              } else if (siteGstFlag === 2 && Number(o.gstApplicable) === 1) {
                oGst = calcOwnerGst(o);
              }
            }

            return {
              _id: o._id,
              landOwnerMasterId: String(o.landOwnerMasterId),
              paymentCategory: o.paymentCategory,
              shareAmount: o.shareAmount || 0,
              gstAmount: oGst,
              netPayableToOwner: (o.shareAmount || 0) + oGst,
              onlineAmount: o.onlineAmount || 0,
              cashAmount: o.cashAmount || 0,
              tdsAmount: o.tdsAmount || 0,
            };
          }),
          rentalDue: rentalDue,
          ledger: mediaDoc.ledger,
ledgerHistory: mediaDoc.ledgerHistory,
gstBalanceHistory: mediaDoc.gstBalanceHistory,
          isFaceEntry: true,
        });
      });
    });

    // ✅ NEW — the site has an unpaid pre-onboarding GST outstanding row of a
    // PAST month (counts as GST Hold, same rule as the rows listed below)
    const siteHasPastGstOutstanding = (site) =>
      (site._gstOutstanding || []).some((row) => {
        const amt = Number(row?.gstOutStandingAmount || 0);
        const paid = row?.isPaid || (row?.utrNumber && String(row.utrNumber).trim() !== "");
        if (amt <= 0 || paid) return false;
        const [mStr, yStr] = String(row.dueMonth || "").trim().split(/\s+/);
        const mIdx = SITE_FILTER_MONTH_NAMES.findIndex(
          (m) => m.slice(0, 3).toLowerCase() === String(mStr || "").slice(0, 3).toLowerCase(),
        );
        const year = Number(yStr);
        if (mIdx === -1 || !year) return false;
        return year < referenceYear || (year === referenceYear && mIdx < referenceMonthIdx);
      });

    const toSiteResponseShape = (site, targetOwnerId = null) => {
      // ✅ Filter rentalDue entries based on requested filters (supporting multiple select)
      const duesMap = new Map();

      const hasRentalStatusFilter =
        includeApprovalSite ||
        includePendingSites ||
        includeOverDue ||
        includeCmdApproval ||
        includeCurrentGstCannotHold || // ✅ NEW
        includePastGstCannotHold; // ✅ NEW

      const hasLedgerCategoryFilter =
        includePastRentPendingSites ||
        includePastRentalPending ||
        includePastGstPendingSites ||
        includeCurrentMonthRentPendingSites ||
        includeCurrentMonthGstPendingSites ||
        includeCurrentMonthRentPaidSites ||
        includeCurrentMonthGstPaidSites ||
        includeCurrentPendingRent ||
        includeCurrentLedger ||
        includeCurrentGst ||
        includeCurrentGstPending ||
        includePastLedger ||
        includePastGst ||
        includePastGstPending ||
        includeTotalLedgerAmount ||
        includeTotalLedgerGstAmount ||
        includeTotalLedgerPendingAmount ||
        includeTotalGstPendingAmount ||
        includeCurrentMonthOverallDueAmountSites ||
        includeTotalOutstandingSites;

      const hasOtherFilters = hasRentalStatusFilter || hasLedgerCategoryFilter;

      // ✅ FIXED — a single bill site can hold one bill PER FACE for the same
      // month; CMD approving one of them left the others pending, and that
      // untouched pending copy made a CMD-approved site show under pending.
      // For single bill sites only the most-approved bill of each month counts
      // (3 Approved > 2 Partially > others) — same rule as the ledger list.
      // Separate bill sites: unchanged.
      let siteDues = site.rentalDue || [];
      if (site._isSingleBill && siteDues.length > 1) {
        const rank = (d) => (Number(d.approvalStatus) === 3 ? 3 : Number(d.approvalStatus) === 2 ? 2 : 1);
        const bestRankByMonth = new Map();
        siteDues.forEach((d) => {
          const r = rank(d);
          if (r > (bestRankByMonth.get(d.dueMonth) || 0)) bestRankByMonth.set(d.dueMonth, r);
        });
        siteDues = siteDues.filter((d) => rank(d) === bestRankByMonth.get(d.dueMonth));
      }

      siteDues.forEach((due) => {
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        if (!parsed) return;

        const isCurrent =
          parsed.year === referenceYear && parsed.monthIdx === referenceMonthIdx;
        const isPast =
          parsed.year < referenceYear ||
          (parsed.year === referenceYear && parsed.monthIdx < referenceMonthIdx);

        // Calculate payment status for this cycle
        const cycleDate = due.dueDate ? new Date(due.dueDate) : null;
        let isPaidForRent = false;
        let isPaidForGst = false;

        if (cycleDate) {
          const ownersToCheck = targetOwnerId
            ? (site.ownersDetail || []).filter(
                (o) => String(o.landOwnerMasterId) === String(targetOwnerId),
              )
            : site.ownersDetail || [];

          if (ownersToCheck.length > 0) {
            isPaidForRent = ownersToCheck.every((owner) => {
              const modes = getRequiredModesShared(owner.paymentCategory);
              return modes.every((mode) =>
                isOwnerModePaidForCycle(site, owner, mode, cycleDate),
              );
            });

            const withGst = Number(due.withGst || 0);
            if (withGst === 2) {
              isPaidForGst = isPaidForRent;
            } else if (withGst === 1) {
              isPaidForGst = ownersToCheck.every((owner) =>
                isGstPaidForCycle(site, owner, due.dueMonth),
              );
            }
          }
        }

        const isPending = !isPaidForRent;

        let matchesApproved = due.approvalStatus === 3;
        let matchesPending = due.approvalStatus === 1 || due.approvalStatus === 2;
        let matchesOverDue =
          due.approvalStatus === 4 ||
          (due.dueDate && new Date(due.dueDate) < today && due.approvalStatus !== 3) ||
          (isPast && isPending);
        // ✅ NEW — with roleType, approved / pending dues follow the role rule
        // (approved = role step approved; pending = waiting on that role — the
        // earlier roles approved, this role not yet).
        if (targetRole) {
          const { isApproved: roleApproved, isOpen: roleOpen } = roleStatus(due, targetRole, { pendingAtRoleOnly: true });
          matchesApproved = roleApproved;
          matchesPending = roleOpen;
          // ✅ NEW — overDue also follows the role: only dues waiting on that role
          // (e.g. CMD: Executive + Manager approved, CMD not yet)
          // ✅ NEW — and only on sites counted in overDue.siteCount (same per-site
          // rule as the header: a single bill site uses its most advanced bill,
          // so a lagging face copy no longer brings the site / its landowner in)
          matchesOverDue = matchesOverDue && roleOpen && !!site.rentalStatus?.isOverDueSite;
        }
        const matchesCmdApproval =
          (!due.mediaDetailId || String(due.mediaDetailId) === String(site.mediaDetailId)) &&
          isDueInCmdApproval(due) &&
          !isCmdDueFullySettled(site, site.ownersDetail, due);

        let matchesOtherFilters = false;

        if (includePastRentPendingSites && isPast && isPending) matchesOtherFilters = true;
        if (includePastRentalPending && isPast && isPending) matchesOtherFilters = true;
        // ✅ CHANGED — GST Hold bills only (withGst 1); Cannot Hold has its own filter
        if (includePastGstPendingSites && isPast && !isPaidForGst && Number(due.withGst || 0) === 1) matchesOtherFilters = true;

        if (includeCurrentMonthRentPendingSites && isCurrent && isPending) matchesOtherFilters = true;
        // ✅ CHANGED — GST Hold bills only (withGst 1)
        if (includeCurrentMonthGstPendingSites && isCurrent && !isPaidForGst && Number(due.withGst || 0) === 1) matchesOtherFilters = true;
        if (includeCurrentMonthRentPaidSites && isCurrent && isPaidForRent) matchesOtherFilters = true;
        if (includeCurrentMonthGstPaidSites && isCurrent && isPaidForGst) matchesOtherFilters = true;

        if (includeApprovalSite && isCurrent && matchesApproved) matchesOtherFilters = true;
        if (includePendingSites && isCurrent && matchesPending) matchesOtherFilters = true;
        if (includeOverDue && matchesOverDue) matchesOtherFilters = true;
        if (includeCmdApproval && matchesCmdApproval) matchesOtherFilters = true;
        // ✅ NEW — GST Cannot Hold bills (withGst 2 / 0 with GST), paid or not
        {
          const isCannotHold =
            Number(due.withGst || 0) !== 1 && (Number(due.gstAmount || 0) > 0 || Number(site.gstAmount || 0) > 0);
          if (includeCurrentGstCannotHold && isCurrent && isCannotHold) matchesOtherFilters = true;
          if (includePastGstCannotHold && isPast && isCannotHold) matchesOtherFilters = true;
        }

        if ((includeCurrentMonthOverallDueAmountSites || includeTotalOutstandingSites) && (isCurrent || (isPast && isPending))) {
          matchesOtherFilters = true;
        }

        let shouldInclude = false;
        if (includeDueThisMonth) {
          // ✅ CHANGED — dueThisMonth lists EVERY bill of this month (any roleType),
          // same as its header count; pendingSite / approvalSite / overDue (role
          // based) narrow it when sent together
          if (isCurrent) {
            if (hasOtherFilters) {
              shouldInclude = matchesOtherFilters;
            } else {
              shouldInclude = true;
            }
          } else {
            shouldInclude = false;
          }
        } else if (hasOtherFilters) {
          shouldInclude = matchesOtherFilters;
        } else {
          // Default: Current Month + Past Pending
          shouldInclude = isCurrent || (isPast && isPending);
        }

        if (shouldInclude) {
          const isDirect = Number(due.withGst) === 2;

          // Deduplicate by month (prefer approved entries if duplicates exist)
          const existing = duesMap.get(due.dueMonth);
          if (
            !existing ||
            (due.approvalStatus === 3 && existing.approvalStatus !== 3)
          ) {
            duesMap.set(due.dueMonth, {
              dueMonth: due.dueMonth,
              dueDate: due.dueDate,
              approvalStatus: due.approvalStatus,
              ownerApprovalDate: due.ownerApprovalDate,
              netPayable: due.netPayable,
              withGst: due.withGst,
              gstAmount: due.gstAmount,
              baseAmount: due.baseAmount,
              isPaidForRent,
              isPaidForGst,
            });
          }
        }
      });

      // ✅ NEW — past GST pending that comes from the pre-onboarding GST
      // outstanding rows (no bill for those months, e.g. "Jun 2026" 2000) is
      // listed too, so the site is not dropped from pastGstPendingSites.
      // Marked isGstOutstanding: true. A month that already has a bill listed
      // keeps the bill.
      if (includePastGstPendingSites || includePastGstPending) {
        (site._gstOutstanding || []).forEach((row) => {
          const amt = Number(row?.gstOutStandingAmount || 0);
          const paid = row?.isPaid || (row?.utrNumber && String(row.utrNumber).trim() !== "");
          if (amt <= 0 || paid) return;
          const [mStr, yStr] = String(row.dueMonth || "").trim().split(/\s+/);
          const mIdx = SITE_FILTER_MONTH_NAMES.findIndex(
            (m) => m.slice(0, 3).toLowerCase() === String(mStr || "").slice(0, 3).toLowerCase(),
          );
          const year = Number(yStr);
          if (mIdx === -1 || !year) return;
          const isPastMonth = year < referenceYear || (year === referenceYear && mIdx < referenceMonthIdx);
          if (!isPastMonth) return;
          const label = `${SITE_FILTER_MONTH_NAMES[mIdx]} ${year}`;
          if (duesMap.has(label)) return;
          duesMap.set(label, {
            dueMonth: label,
            dueDate: new Date(Date.UTC(year, mIdx, 1)),
            approvalStatus: null,
            ownerApprovalDate: null,
            netPayable: 0,
            withGst: 1,
            gstAmount: amt,
            baseAmount: 0,
            isPaidForRent: true,
            isPaidForGst: false,
            isGstOutstanding: true,
          });
        });
      }

      const filteredDues = Array.from(duesMap.values()).sort((a, b) => {
        const dA = a.dueDate ? new Date(a.dueDate) : new Date(0);
        const dB = b.dueDate ? new Date(b.dueDate) : new Date(0);
        return dA - dB;
      });

      return {
        mediaId: site.mediaId,
        mediaDetailId: site.mediaDetailId,
        mediaCode: site.mediaCode,
        mediaName: site.mediaName,
        baseRent: site.totalRentalAmount || 0,
        gstAmount: site.gstAmount || 0,
        tdsAmount: (site.ownersDetail || []).reduce(
          (sum, od) => sum + (od.tdsAmount || 0),
          0,
        ),
        gstApplicable: site.gstApplicable,
        rentalDueEntries: filteredDues,
      };
    };

    const buildAmounts = (sites) => {
      // ✅ Use unique Media IDs for financial totals to avoid doubling amounts for multi-face docs
      const uniqueDocs = [];
      const seenIds = new Set();
      sites.forEach((s) => {
        if (!seenIds.has(String(s.mediaId))) {
          uniqueDocs.push(s);
          seenIds.add(String(s.mediaId));
        }
      });

      const totalBaseRent = uniqueDocs.reduce((s, site) => {
        return s + (site.totalRentalAmount || 0);
      }, 0);

      const gstHoldTotal = uniqueDocs.reduce((s, site) => {
        return s + (site.gstAmount || 0);
      }, 0);

      const tdsHoldTotal = uniqueDocs.reduce((s, site) => {
        return (
          s +
          (site.ownersDetail || []).reduce(
            (sum, od) => sum + (od.tdsAmount || 0),
            0,
          )
        );
      }, 0);

      return {
        totalBaseRent,
        gstHoldTotal,
        tdsHoldTotal,
        consolidatedPayable: totalBaseRent + gstHoldTotal,
      };
    };

    const soleOwnedSitesByOwner = new Map();
    const multiOwnerSites = [];

    siteMap.forEach((site) => {
      if (site.ownerIds.length <= 1) {
        const soloOwnerId = site.ownerIds[0];
        if (soloOwnerId) {
          if (!soleOwnedSitesByOwner.has(soloOwnerId)) {
            soleOwnedSitesByOwner.set(soloOwnerId, []);
          }
          soleOwnedSitesByOwner.get(soloOwnerId).push(site);
        }
      } else {
        multiOwnerSites.push(site);
      }
    });

    const signatureGroups = new Map();

    multiOwnerSites.forEach((site) => {
      const signature = [...site.ownerIds].sort().join(",");
      if (!signatureGroups.has(signature)) {
        signatureGroups.set(signature, { ownerIds: site.ownerIds, sites: [] });
      }
      signatureGroups.get(signature).sites.push(site);
    });

    const entries = [];

    requestedOwnerIds.forEach((ownerId) => {
      const sites = soleOwnedSitesByOwner.get(ownerId);
      if (!sites || sites.length === 0) return;
      let totalShareAmount = 0;
      let totalGstAmount = 0;
      let totalNetPayableToOwner = 0;
      let totalOnlineAmount = 0;
      let totalCashAmount = 0;
      let totalTdsAmount = 0;
      let lastPaymentCategory = null;
      // ✅ ADDED — tracks max(owner.updatedAt, every site.updatedAt),
      // used to sort entries by most-recent activity before pagination.
      let latestActivityAt = ownerUpdatedAtById[ownerId] || null;

      // ✅ ADDED — accumulate ledger/GST data across this owner's sole-owned sites
      const combinedLedger = {
        currentMonthEntries: [],
        pastMonthEntries: [],
        currentPendingRentEntries: [],
        pastRentalPendingEntries: [],
        currentGst: 0,
        pastGst: 0,
        currentGstPending: 0,
        pastGstPending: 0,
        currentRentPending: 0, // ✅ ADDED
        pastRentPending: 0, // ✅ ADDED
        hasTotalLedger: false, // ✅ NEW
        hasTotalGst: false,    // ✅ NEW
        hasPendingLedger: false, // ✅ NEW
        hasPendingGst: false,    // ✅ NEW
        hasCurrentMonthRentPending: false,
        hasCurrentMonthGstPending: false,
        hasCurrentMonthRentPaid: false,
        hasCurrentMonthGstPaid: false,
        hasPastRentPending: false,
        hasPastGstPending: false,
        hasCurrentGstHoldPending: false, // ✅ NEW
        hasPastGstHoldPending: false, // ✅ NEW
        hasCurrentMonthOverallDueAmount: false,
        hasTotalOutstanding: false
      };
      // ✅ NEW: Rental Status accumulation
      const rentalStatusMatch = {
        hasApproved: false,
        hasPending: false,
        isOverDue: false,
        hasCmdApproval: false, // ✅ NEW
        hasDueThisMonth: false, // ✅ NEW
        hasCurrentGstCannotHold: false, // ✅ NEW
        hasPastGstCannotHold: false, // ✅ NEW
      };

      const processedDocIds = new Set();
      sites.forEach((site) => {
        const docIdStr = String(site.mediaId);
        // ✅ FIXED — capture before marking processed; the id was added here
        // first, so the _overallSummary / ledger checks below were always
        // skipped and every ledger filter (e.g. pastGstPendingSites) failed.
        const isFirstVisit = !processedDocIds.has(docIdStr);
        if (isFirstVisit) {
          processedDocIds.add(docIdStr);
          const ownerDetail = site.ownersDetail?.find(
            (od) => od.landOwnerMasterId === ownerId,
          );
          if (ownerDetail) {
            totalShareAmount += ownerDetail.shareAmount;
            totalGstAmount += ownerDetail.gstAmount;
            totalNetPayableToOwner += ownerDetail.netPayableToOwner;
            totalOnlineAmount += ownerDetail.onlineAmount;
            totalCashAmount += ownerDetail.cashAmount;
            totalTdsAmount += ownerDetail.tdsAmount;
            lastPaymentCategory = ownerDetail.paymentCategory;
          }
        }

        if (
          site.updatedAt &&
          (!latestActivityAt ||
            new Date(site.updatedAt) > new Date(latestActivityAt))
        ) {
          latestActivityAt = site.updatedAt;
        }

        if (site.rentalStatus.hasApprovedSite)
          rentalStatusMatch.hasApproved = true;
        if (site.rentalStatus.hasPendingSite)
          rentalStatusMatch.hasPending = true;
        if (site.rentalStatus.isOverDueSite) rentalStatusMatch.isOverDue = true;
        if (site.rentalStatus.hasCmdApprovalSite) rentalStatusMatch.hasCmdApproval = true; // ✅ NEW
        if (site.rentalStatus.hasDueThisMonthSite) rentalStatusMatch.hasDueThisMonth = true; // ✅ NEW
        if (site.rentalStatus.hasCurrentGstCannotHoldSite) rentalStatusMatch.hasCurrentGstCannotHold = true; // ✅ NEW
        if (site.rentalStatus.hasPastGstCannotHoldSite) rentalStatusMatch.hasPastGstCannotHold = true; // ✅ NEW

        if (site._overallSummary && isFirstVisit) {
          if (site._overallSummary.hasTotalLedger) combinedLedger.hasTotalLedger = true;
          if (site._overallSummary.hasTotalGst) combinedLedger.hasTotalGst = true;
          if (site._overallSummary.hasPendingLedger) combinedLedger.hasPendingLedger = true;
          if (site._overallSummary.hasPendingGst) combinedLedger.hasPendingGst = true;
          if (site._overallSummary.hasCurrentMonthRentPending) combinedLedger.hasCurrentMonthRentPending = true;
          if (site._overallSummary.hasCurrentMonthGstPending) combinedLedger.hasCurrentMonthGstPending = true;
          if (site._overallSummary.hasCurrentMonthRentPaid) combinedLedger.hasCurrentMonthRentPaid = true;
          if (site._overallSummary.hasCurrentMonthGstPaid) combinedLedger.hasCurrentMonthGstPaid = true;
          if (site._overallSummary.hasPastRentPending) combinedLedger.hasPastRentPending = true;
          if (site._overallSummary.hasPastGstPending) combinedLedger.hasPastGstPending = true;
          // ✅ NEW — GST Hold pending only (current / past), for the *GstPendingSites filters
          if (Number(site._overallSummary.splitCurGstHoldRemaining || 0) > 0) combinedLedger.hasCurrentGstHoldPending = true;
          if (Number(site._overallSummary.splitPastGstHoldRemaining || 0) > 0 || siteHasPastGstOutstanding(site)) combinedLedger.hasPastGstHoldPending = true;
          if (site._overallSummary.hasCurrentMonthOverallDueAmount) combinedLedger.hasCurrentMonthOverallDueAmount = true;
          if (site._overallSummary.hasTotalOutstanding) combinedLedger.hasTotalOutstanding = true;
        }

        if (needsLedgerFields && isFirstVisit) {
          const siteBucket = getLedgerBucketsForSite(docIdStr, [
            ownerId,
          ]);
          combinedLedger.currentMonthEntries.push(
            ...siteBucket.currentMonthEntries,
          );
          combinedLedger.pastMonthEntries.push(...siteBucket.pastMonthEntries);
          combinedLedger.currentPendingRentEntries.push(
            ...siteBucket.currentPendingRentEntries,
          );
          combinedLedger.pastRentalPendingEntries.push(
            ...siteBucket.pastRentalPendingEntries,
          );
          combinedLedger.currentGst += siteBucket.currentGst;
          combinedLedger.pastGst += siteBucket.pastGst;
          combinedLedger.currentGstPending += siteBucket.currentGstPending;
          combinedLedger.pastGstPending += siteBucket.pastGstPending;
          combinedLedger.currentRentPending +=
            siteBucket.currentRentPending || 0;
          combinedLedger.pastRentPending += siteBucket.pastRentPending || 0;
        }
        processedDocIds.add(docIdStr);
      });

      const entryPayload = {
        entryType: "single",
        landOwnerMasterId: ownerId,
        totalSites: sites.reduce((sum, s) => sum + (s.mediaDetailsCount || 0), 0), // ✅ CHANGED
        totalLandOwners: 1,
        ...buildAmounts(sites),
        landOwners: [
          {
            landOwnerMasterId: ownerId,
            name: ownerNameById[ownerId] || "Unknown",
            paymentCategory: lastPaymentCategory,
            totalShareAmount,
            totalGstAmount,
            totalNetPayableToOwner,
            totalOnlineAmount,
            totalCashAmount,
            totalTdsAmount,
          },
        ],
        sites: sites.map((site) => toSiteResponseShape(site, ownerId)),
        latestActivityAt, // ✅ ADDED — internal sort key, stripped before response
        hasApproved: rentalStatusMatch.hasApproved, // ✅ ADDED — internal sort key

      };

      // ✅ ADDED — attach requested ledger/GST fields, conditionally
      if (includeCurrentLedger || includeCurrentPendingRent) {
        entryPayload.currentMonthLedgerEntries = includeCurrentPendingRent
          ? combinedLedger.currentPendingRentEntries
          : combinedLedger.currentMonthEntries;
      }
      if (includePastLedger || includePastRentalPending) {
        entryPayload.pastMonthLedgerEntries = includePastRentalPending
          ? combinedLedger.pastRentalPendingEntries
          : combinedLedger.pastMonthEntries;
      }
      if (
        includeCurrentGst ||
        includePastGst ||
        includeCurrentGstPending ||
        includePastGstPending
      ) {
        entryPayload.gstSummary = {};
        if (includeCurrentGst || includeCurrentGstPending)
          entryPayload.gstSummary.currentGst = includeCurrentGstPending
            ? combinedLedger.currentGstPending
            : combinedLedger.currentGst;
        if (includePastGst || includePastGstPending)
          entryPayload.gstSummary.pastGst = includePastGstPending
            ? combinedLedger.pastGstPending
            : combinedLedger.pastGst;
      }

      // ✅ ADDED — reconciled rent-pending numeric totals, same source
      // as overallCurrentBaseRentDue / overallPreviousBaseRentDue.
      if (includeCurrentPendingRent || includePastRentalPending) {
        entryPayload.rentPendingSummary = {};
        if (includeCurrentPendingRent)
          entryPayload.rentPendingSummary.currentRentPending =
            combinedLedger.currentRentPending;
        if (includePastRentalPending)
          entryPayload.rentPendingSummary.pastRentPending =
            combinedLedger.pastRentPending;
      }

      if (isAnyFilterActive) {
        // ✅ CHANGED — match against the reconciled numeric totals,
        // not the (separately-sourced) virtual-entry array length
        const ledgerMatch = needsLedgerFields
          ? (includeCurrentLedger &&
              combinedLedger.currentMonthEntries.length > 0) ||
            (includePastLedger && combinedLedger.pastMonthEntries.length > 0) ||
            (includeCurrentGst && combinedLedger.currentGst > 0) ||
            (includePastGst && combinedLedger.pastGst > 0) ||
            (includeCurrentPendingRent &&
              combinedLedger.currentRentPending > 0) ||
            (includePastRentalPending && combinedLedger.pastRentPending > 0) ||
            (includeCurrentGstPending &&
              combinedLedger.currentGstPending > 0) ||
            (includePastGstPending && combinedLedger.pastGstPending > 0) ||
            (includeTotalLedgerAmount && combinedLedger.hasTotalLedger) ||
            (includeTotalLedgerGstAmount && combinedLedger.hasTotalGst) ||
            (includeTotalLedgerPendingAmount && combinedLedger.hasPendingLedger) ||
            (includeTotalGstPendingAmount && combinedLedger.hasPendingGst) ||
            (includeCurrentMonthRentPendingSites && combinedLedger.hasCurrentMonthRentPending) ||
            (includeCurrentMonthGstPendingSites && combinedLedger.hasCurrentGstHoldPending) || // ✅ CHANGED — GST Hold only
            (includeCurrentMonthRentPaidSites && combinedLedger.hasCurrentMonthRentPaid) ||
            (includeCurrentMonthGstPaidSites && combinedLedger.hasCurrentMonthGstPaid) ||
            (includePastRentPendingSites && combinedLedger.hasPastRentPending) ||
            (includePastGstPendingSites && combinedLedger.hasPastGstHoldPending) || // ✅ CHANGED — GST Hold only
            (includeCurrentMonthOverallDueAmountSites && combinedLedger.hasCurrentMonthOverallDueAmount) ||
            (includeTotalOutstandingSites && combinedLedger.hasTotalOutstanding)
          : false;

        const rentalMatch = needsRentalStatusFields
          ? (includeApprovalSite && rentalStatusMatch.hasApproved) ||
            (includePendingSites && rentalStatusMatch.hasPending) ||
            (includeOverDue && rentalStatusMatch.isOverDue) || // ✅ isOverDue now includes past pending
            (includeCmdApproval && rentalStatusMatch.hasCmdApproval) || // ✅ NEW
            (includeDueThisMonth && rentalStatusMatch.hasDueThisMonth) ||
            (includeCurrentGstCannotHold && rentalStatusMatch.hasCurrentGstCannotHold) || // ✅ NEW
            (includePastGstCannotHold && rentalStatusMatch.hasPastGstCannotHold) // ✅ NEW
          : false;

        if (!ledgerMatch && !rentalMatch) return; // skip this owner — nothing to show for the requested flag(s)

        // Filter out sites that have no matching rental due entries under the active filter(s)
        entryPayload.sites = entryPayload.sites.filter(
          (s) => s.rentalDueEntries && s.rentalDueEntries.length > 0,
        );
        if (entryPayload.sites.length === 0 && !needsLedgerFields) return;
      }

      entries.push(entryPayload);
    });

    signatureGroups.forEach((group) => {
      // ✅ ADDED — same latest-activity tracking across all owners +
      // all sites in this group.
      let latestActivityAt = null;
      group.ownerIds.forEach((id) => {
        const ownerUpdatedAt = ownerUpdatedAtById[id];
        if (
          ownerUpdatedAt &&
          (!latestActivityAt ||
            new Date(ownerUpdatedAt) > new Date(latestActivityAt))
        ) {
          latestActivityAt = ownerUpdatedAt;
        }
      });

      const landOwners = group.ownerIds.map((id) => {
        let totalShareAmount = 0;
        let totalGstAmount = 0;
        let totalNetPayableToOwner = 0;
        let totalOnlineAmount = 0;
        let totalCashAmount = 0;
        let totalTdsAmount = 0;
        let lastPaymentCategory = null;

        const processedDocIds = new Set();
        group.sites.forEach((site) => {
          const docIdStr = String(site.mediaId);
          if (!processedDocIds.has(docIdStr)) {
            processedDocIds.add(docIdStr);
            const ownerDetail = site.ownersDetail?.find(
              (od) => od.landOwnerMasterId === id,
            );
            if (ownerDetail) {
              totalShareAmount += ownerDetail.shareAmount;
              totalGstAmount += ownerDetail.gstAmount;
              totalNetPayableToOwner += ownerDetail.netPayableToOwner;
              totalOnlineAmount += ownerDetail.onlineAmount;
              totalCashAmount += ownerDetail.cashAmount;
              totalTdsAmount += ownerDetail.tdsAmount;
              lastPaymentCategory = ownerDetail.paymentCategory;
            }
          }
        });

        return {
          landOwnerMasterId: id,
          name: ownerNameById[id] || "Unknown",
          paymentCategory: lastPaymentCategory,
          totalShareAmount,
          totalGstAmount,
          totalNetPayableToOwner,
          totalOnlineAmount,
          totalCashAmount,
          totalTdsAmount,
        };
      });

      // ✅ ADDED — fold in every site's own updatedAt too
      group.sites.forEach((site) => {
        if (
          site.updatedAt &&
          (!latestActivityAt ||
            new Date(site.updatedAt) > new Date(latestActivityAt))
        ) {
          latestActivityAt = site.updatedAt;
        }
      });

      const amounts = buildAmounts(group.sites);
      const anyGstApplicable = group.sites.some((s) => s.gstApplicable === 1);

      // ✅ ADDED — accumulate ledger/GST across ALL owners + ALL sites in this group
      const combinedLedger = {
        currentMonthEntries: [],
        pastMonthEntries: [],
        currentPendingRentEntries: [],
        pastRentalPendingEntries: [],
        currentGst: 0,
        pastGst: 0,
        currentGstPending: 0,
        pastGstPending: 0,
        currentRentPending: 0, // ✅ ADDED — was missing, left rentPendingSummary undefined for shared entries
        pastRentPending: 0, // ✅ ADDED
        hasTotalLedger: false, // ✅ NEW
        hasTotalGst: false,    // ✅ NEW
        hasPendingLedger: false, // ✅ NEW
        hasPendingGst: false,    // ✅ NEW
        hasCurrentMonthRentPending: false,
        hasCurrentMonthGstPending: false,
        hasCurrentMonthRentPaid: false,
        hasCurrentMonthGstPaid: false,
        hasPastRentPending: false,
        hasPastGstPending: false,
        hasCurrentGstHoldPending: false, // ✅ NEW
        hasPastGstHoldPending: false, // ✅ NEW
        hasCurrentMonthOverallDueAmount: false,
        hasTotalOutstanding: false
      };
      // ✅ NEW: Rental Status accumulation
      const rentalStatusMatch = {
        hasApproved: false,
        hasPending: false,
        isOverDue: false,
        hasCmdApproval: false, // ✅ NEW
        hasDueThisMonth: false, // ✅ NEW
        hasCurrentGstCannotHold: false, // ✅ NEW
        hasPastGstCannotHold: false, // ✅ NEW
      };

      // if (needsLedgerFields || needsRentalStatusFields) {
      const processedDocIds = new Set();
        group.sites.forEach((site) => {
          const docIdStr = String(site.mediaId);
          if (site.rentalStatus.hasApprovedSite)
            rentalStatusMatch.hasApproved = true;
          if (site.rentalStatus.hasPendingSite)
            rentalStatusMatch.hasPending = true;
          if (site.rentalStatus.isOverDueSite)
            rentalStatusMatch.isOverDue = true;
          if (site.rentalStatus.hasCmdApprovalSite) rentalStatusMatch.hasCmdApproval = true; // ✅ NEW
          if (site.rentalStatus.hasDueThisMonthSite) rentalStatusMatch.hasDueThisMonth = true; // ✅ NEW
          if (site.rentalStatus.hasCurrentGstCannotHoldSite) rentalStatusMatch.hasCurrentGstCannotHold = true; // ✅ NEW
          if (site.rentalStatus.hasPastGstCannotHoldSite) rentalStatusMatch.hasPastGstCannotHold = true; // ✅ NEW

          if (site._overallSummary && !processedDocIds.has(docIdStr)) {
            if (site._overallSummary.hasTotalLedger) combinedLedger.hasTotalLedger = true;
            if (site._overallSummary.hasTotalGst) combinedLedger.hasTotalGst = true;
            if (site._overallSummary.hasPendingLedger) combinedLedger.hasPendingLedger = true;
            if (site._overallSummary.hasPendingGst) combinedLedger.hasPendingGst = true;
            if (site._overallSummary.hasCurrentMonthRentPending) combinedLedger.hasCurrentMonthRentPending = true;
            if (site._overallSummary.hasCurrentMonthGstPending) combinedLedger.hasCurrentMonthGstPending = true;
            if (site._overallSummary.hasCurrentMonthRentPaid) combinedLedger.hasCurrentMonthRentPaid = true;
            if (site._overallSummary.hasCurrentMonthGstPaid) combinedLedger.hasCurrentMonthGstPaid = true;
            if (site._overallSummary.hasPastRentPending) combinedLedger.hasPastRentPending = true;
            if (site._overallSummary.hasPastGstPending) combinedLedger.hasPastGstPending = true;
            // ✅ NEW — GST Hold pending only (current / past), for the *GstPendingSites filters
            if (Number(site._overallSummary.splitCurGstHoldRemaining || 0) > 0) combinedLedger.hasCurrentGstHoldPending = true;
            if (Number(site._overallSummary.splitPastGstHoldRemaining || 0) > 0 || siteHasPastGstOutstanding(site)) combinedLedger.hasPastGstHoldPending = true;
            if (site._overallSummary.hasCurrentMonthOverallDueAmount) combinedLedger.hasCurrentMonthOverallDueAmount = true;
            if (site._overallSummary.hasTotalOutstanding) combinedLedger.hasTotalOutstanding = true;
          }

          if (needsLedgerFields && !processedDocIds.has(docIdStr)) {
            const siteBucket = getLedgerBucketsForSite(
              docIdStr,
              group.ownerIds,
            );
            combinedLedger.currentMonthEntries.push(
              ...siteBucket.currentMonthEntries,
            );
            combinedLedger.pastMonthEntries.push(
              ...siteBucket.pastMonthEntries,
            );
            combinedLedger.currentPendingRentEntries.push(
              ...siteBucket.currentPendingRentEntries,
            );
            combinedLedger.pastRentalPendingEntries.push(
              ...siteBucket.pastRentalPendingEntries,
            );
            combinedLedger.currentGst += siteBucket.currentGst;
            combinedLedger.pastGst += siteBucket.pastGst;
            combinedLedger.currentGstPending += siteBucket.currentGstPending;
            combinedLedger.pastGstPending += siteBucket.pastGstPending;
            combinedLedger.currentRentPending +=
              siteBucket.currentRentPending || 0;
            combinedLedger.pastRentPending += siteBucket.pastRentPending || 0;
          }
          processedDocIds.add(docIdStr);
        });
      // }

      const entryPayload = {
        entryType: "shared",
        totalLandOwners: landOwners.length,
        totalSites: group.sites.reduce((sum, s) => sum + (s.mediaDetailsCount || 0), 0), // ✅ CHANGED
        gstApplicable: anyGstApplicable ? 1 : 0,
        ...amounts,
        landOwners,
        sites: group.sites.map((site) => toSiteResponseShape(site)),
        latestActivityAt, // ✅ ADDED — internal sort key, stripped before response
        hasApproved: rentalStatusMatch.hasApproved, // ✅ ADDED — internal sort key

      };

      // ✅ ADDED — attach requested ledger/GST fields, conditionally
      if (includeCurrentLedger || includeCurrentPendingRent) {
        entryPayload.currentMonthLedgerEntries = includeCurrentPendingRent
          ? combinedLedger.currentPendingRentEntries
          : combinedLedger.currentMonthEntries;
      }
      if (includePastLedger || includePastRentalPending) {
        entryPayload.pastMonthLedgerEntries = includePastRentalPending
          ? combinedLedger.pastRentalPendingEntries
          : combinedLedger.pastMonthEntries;
      }
      if (
        includeCurrentGst ||
        includePastGst ||
        includeCurrentGstPending ||
        includePastGstPending
      ) {
        entryPayload.gstSummary = {};
        if (includeCurrentGst || includeCurrentGstPending)
          entryPayload.gstSummary.currentGst = includeCurrentGstPending
            ? combinedLedger.currentGstPending
            : combinedLedger.currentGst;
        if (includePastGst || includePastGstPending)
          entryPayload.gstSummary.pastGst = includePastGstPending
            ? combinedLedger.pastGstPending
            : combinedLedger.pastGst;
      }

      // ✅ ADDED — was missing on shared/multi-owner entries; only the
      // single-owner block had this. Same reconciled rent-pending
      // totals, so shared sites now report currentPendingRent /
      // pastRentalPending consistently with single entries.
      if (includeCurrentPendingRent || includePastRentalPending) {
        entryPayload.rentPendingSummary = {};
        if (includeCurrentPendingRent)
          entryPayload.rentPendingSummary.currentRentPending =
            combinedLedger.currentRentPending;
        if (includePastRentalPending)
          entryPayload.rentPendingSummary.pastRentPending =
            combinedLedger.pastRentPending;
      }

      if (isAnyFilterActive) {
        // ✅ CHANGED — match against the reconciled numeric totals,
        // same as the single-owner block, instead of raw entry-array
        // length which came from the separate manual scan.
        const ledgerMatch = needsLedgerFields
          ? (includeCurrentLedger &&
              combinedLedger.currentMonthEntries.length > 0) ||
            (includePastLedger && combinedLedger.pastMonthEntries.length > 0) ||
            (includeCurrentGst && combinedLedger.currentGst > 0) ||
            (includePastGst && combinedLedger.pastGst > 0) ||
            (includeCurrentPendingRent &&
              combinedLedger.currentRentPending > 0) ||
            (includePastRentalPending && combinedLedger.pastRentPending > 0) ||
            (includeCurrentGstPending &&
              combinedLedger.currentGstPending > 0) ||
            (includePastGstPending && combinedLedger.pastGstPending > 0) ||
            (includeTotalLedgerAmount && combinedLedger.hasTotalLedger) ||
            (includeTotalLedgerGstAmount && combinedLedger.hasTotalGst) ||
            (includeTotalLedgerPendingAmount && combinedLedger.hasPendingLedger) ||
            (includeTotalGstPendingAmount && combinedLedger.hasPendingGst) ||
            (includeCurrentMonthRentPendingSites && combinedLedger.hasCurrentMonthRentPending) ||
            (includeCurrentMonthGstPendingSites && combinedLedger.hasCurrentGstHoldPending) || // ✅ CHANGED — GST Hold only
            (includeCurrentMonthRentPaidSites && combinedLedger.hasCurrentMonthRentPaid) ||
            (includeCurrentMonthGstPaidSites && combinedLedger.hasCurrentMonthGstPaid) ||
            (includePastRentPendingSites && combinedLedger.hasPastRentPending) ||
            (includePastGstPendingSites && combinedLedger.hasPastGstHoldPending) || // ✅ CHANGED — GST Hold only
            (includeCurrentMonthOverallDueAmountSites && combinedLedger.hasCurrentMonthOverallDueAmount) ||
            (includeTotalOutstandingSites && combinedLedger.hasTotalOutstanding)
          : false;

        const rentalMatch = needsRentalStatusFields
          ? (includeApprovalSite && rentalStatusMatch.hasApproved) ||
            (includePendingSites && rentalStatusMatch.hasPending) ||
            (includeOverDue && rentalStatusMatch.isOverDue) || // ✅ isOverDue now includes past pending
            (includeCmdApproval && rentalStatusMatch.hasCmdApproval) || // ✅ NEW
            (includeDueThisMonth && rentalStatusMatch.hasDueThisMonth) ||
            (includeCurrentGstCannotHold && rentalStatusMatch.hasCurrentGstCannotHold) || // ✅ NEW
            (includePastGstCannotHold && rentalStatusMatch.hasPastGstCannotHold) // ✅ NEW
          : false;

        if (!ledgerMatch && !rentalMatch) return;

        // Filter out sites that have no matching rental due entries under the active filter(s)
        entryPayload.sites = entryPayload.sites.filter(
          (s) => s.rentalDueEntries && s.rentalDueEntries.length > 0,
        );
        if (entryPayload.sites.length === 0 && !needsLedgerFields) return;
      }

      entries.push(entryPayload);
    });

    // ✅ ADDED — sort by latestActivityAt descending (most recently
    // touched — owner OR any of their sites — first). Previously
    // entries had no sort at all; order was purely insertion order.
    entries.sort((a, b) => {
      const aTime = a.latestActivityAt
        ? new Date(a.latestActivityAt).getTime()
        : 0;
      const bTime = b.latestActivityAt
        ? new Date(b.latestActivityAt).getTime()
        : 0;
      return bTime - aTime;
    });

    // ✅ ADDED — strip the internal sort key before sending the response
    const entriesForResponse = entries.map(
      ({ latestActivityAt,hasApproved, ...rest }) => rest,
    );

    // ✅ NEW — Filter relatedMediaDocs to only include those that passed the filters
    const filteredMediaIds = new Set();
    entries.forEach((entry) => {
      (entry.sites || []).forEach((site) => {
        if (site.mediaId) filteredMediaIds.add(String(site.mediaId));
      });
    });
    const filteredMediaDocs = relatedMediaDocs.filter((doc) =>
      filteredMediaIds.has(String(doc._id)),
    );

    const outstandingMonthYear = {
      year: referenceYear,
      month: referenceMonthIdx + 1,
    };

    // ✅ FIXED — Summary statistics (Overall Totals, Ledger Summary, and Status Counts)
    // now ALWAYS reflect the global system-wide totals for all active sites,
    // regardless of search filters or whether owners were found. This ensures
    // the "180000" and other header data mentioned in your prompt stays consistent.
  let summaryQuery = { "mediaDetails.status": 1 };
    if (city) {
      if (Array.isArray(city)) {
        summaryQuery["mediaDetails.city"] = {
          $in: city.map((c) => new RegExp(`^${escapeRegex(String(c).trim())}$`, "i")),
        };
      } else {
        summaryQuery["mediaDetails.city"] = new RegExp(`^${escapeRegex(String(city).trim())}$`, "i");
      }
    }

    const summaryDocs = await MediaOnboarding.find(
      summaryQuery,
      "status gstApplicableFlag mediaDetails updatedAt rentalPayment landOwners ledger ledgerHistory gstBalanceHistory rentalDue rentalDueEntries appraisal",
    ).lean();

    for (const media of summaryDocs) {
      await ensureRentalDueForCycles(
        media,
        parsedMonthFilter ? outstandingMonthYear : null,
        req.user?.userName || "Admin",
      );
    }

    const overallOutstandingTotals = summaryDocs.reduce(
      (acc, mediaDoc) => {
        const s = computeOutstandingSummary(mediaDoc, parsedMonthFilter ? outstandingMonthYear : null);
        acc.overallCurrentBaseRentDue += s.currentBaseRent;
        acc.overallCurrentGSTDue += s.currentGSTDue;
        acc.overallPreviousBaseRentDue += s.previousBaseRentDue;
        acc.overallPreviousGSTDue += s.previousGSTDue;
        acc.overallTotalOutstandingAmount += s.totalOutstandingAmount;
        return acc;
      },
      {
        overallCurrentBaseRentDue: 0,
        overallCurrentGSTDue: 0,
        overallPreviousBaseRentDue: 0,
        overallPreviousGSTDue: 0,
        overallTotalOutstandingAmount: 0,
      },
    );

    // ✅ FIXED — shared Rental Due stats (same rule as Dashboard and
    // admin/rental-due-list). Past months are now cycle-based from the ledger
    // summary, so stale rows of removed faces / per-face rows holding the full
    // site rent no longer inflate overDue; an approved month is never overdue;
    // overdue starts 1 day after the due date (IST).
    // ✅ NEW — billDate filter (5, 10, 15, 20, 25, 30): overDue / approved /
    // pending (+ landowner counts) cover only those sites, and an open (not
    // CMD-approved) bill is overdue once that month's bill date has passed.
    // Not sent → exactly as before.
    const billDateFilter = parseBillDateFilter(req.body?.billDate);
    const rentalDueStats = computeRentalDueStats(
      billDateFilter.length
        ? summaryDocs.filter((m) => billDateFilter.includes(siteBillDate(m)))
        : summaryDocs,
      {
        year: statsYear,
        month: statsMonth,
        targetRole,
        trackLandOwners: true, // ✅ NEW — landowner count + details per bucket
        // ✅ NEW — roleType: pending = waiting on that role (Executive → Manager → CMD)
        pendingAtRoleOnly: true,
        // ✅ NEW — a single-bill site's faces share one bill stage (same as dashboard/v2)
        singleBillAsSite: true,
        // ✅ NEW — roleType: overDue = past-due bills waiting on that role
        overdueByRole: true,
        // ✅ NEW — roleType: dueThisMonth = this month's bills waiting on that role
        dueThisMonthByRole: true,
        ...(billDateFilter.length
          ? {
              // ✅ FIXED — never before the bill's OWN due date: billDate slot 15 but
              // bill due 27-Oct → overdue only from 28-Oct (the later of the two)
              overdueFrom: (m, entry) => {
                const slotDate = billDateInMonth(statsYear, statsMonth, siteBillDate(m));
                const dueDate = entry?.dueDate ? new Date(entry.dueDate) : null;
                return dueDate && !Number.isNaN(dueDate.getTime()) && dueDate > slotDate ? dueDate : slotDate;
              },
            }
          : {}),
      },
    );
    const ownerStats = rentalDueStats.landOwners || { dueThisMonth: [], approved: [], pending: [], overdue: [] }; // ✅ NEW
    // ✅ CHANGED — the dueThisMonth HEADER is the same whatever the filters:
    // all sites (not by billDate) and every bill of the month (not by roleType).
    // The dueThisMonth SITE LIST filter still follows roleType.
    // No billDate and no roleType → the same stats object as before.
    const dueThisMonthStats =
      billDateFilter.length || targetRole
        ? computeRentalDueStats(summaryDocs, {
            year: statsYear,
            month: statsMonth,
            targetRole,
            trackLandOwners: true,
            pendingAtRoleOnly: true,
            singleBillAsSite: true,
          })
        : rentalDueStats;
    const dueThisMonthOwners = (dueThisMonthStats.landOwners || {}).dueThisMonth || [];
    const approvedCount = rentalDueStats.approvedCount;
    const approvedAmountTotal = rentalDueStats.approvedAmountTotal;
    const pendingCount = rentalDueStats.pendingCount;
    const pendingAmountTotal = rentalDueStats.pendingAmountTotal;
    const overdueSiteCount = rentalDueStats.overdueCount;
    const overdueAmountTotal = rentalDueStats.overdueAmountTotal;


const cityMatchQuery = city
      ? {
          "mediaDetails.city": Array.isArray(city)
            ? { $in: city.map((c) => new RegExp(`^${escapeRegex(String(c).trim())}$`, "i")) }
            : new RegExp(`^${escapeRegex(String(city).trim())}$`, "i"),
        }
      : {};

    const totalFacesAgg = await MediaOnboarding.aggregate([
      ...(city ? [{ $match: cityMatchQuery }] : []),
      { $unwind: "$mediaDetails" },
      { $match: { ...(city ? { "mediaDetails.city": Array.isArray(city) ? { $in: city.map((c) => new RegExp(`^${escapeRegex(String(c).trim())}$`, "i")) } : new RegExp(`^${escapeRegex(String(city).trim())}$`, "i") } : {}) } },
      { $count: "count" },
    ]);
    const totalSites = totalFacesAgg[0]?.count || 0;

    const siteCount = await MediaOnboarding.countDocuments(cityMatchQuery);

    const activeCountAgg = await MediaOnboarding.aggregate([
      { $unwind: "$mediaDetails" },
      { $match: { "mediaDetails.status": 1, ...(city ? { "mediaDetails.city": Array.isArray(city) ? { $in: city.map((c) => new RegExp(`^${escapeRegex(String(c).trim())}$`, "i")) } : new RegExp(`^${escapeRegex(String(city).trim())}$`, "i") } : {}) } },
      { $count: "count" },
    ]);
    const activeCount = activeCountAgg[0]?.count || 0;

    const allMediaForCityFilter = await MediaOnboarding.find(
      {},
      "mediaDetails.city",
    ).lean();
    const cityFilter = [
      ...new Set(
        allMediaForCityFilter.flatMap((item) =>
          (item.mediaDetails || []).map((d) => d.city),
        ),
      ),
    ].filter(Boolean).sort();

    const totalCount = entriesForResponse.length;
    const startIdx = (pageNumbers - 1) * pageSize;
    const pagedEntries = entriesForResponse.slice(
      startIdx,
      startIdx + pageSize,
    );

    const overallLedgerSummary = calculateOverallLedgerSummary(
      summaryDocs,
      parsedMonthFilter ? outstandingMonthYear : null,
      { includeLandOwnerCounts: true, includePastPaidAmounts: true }, // ✅ NEW — *LandOwners counts + past paid / remaining
    );

    // ✅ NEW — CMD Approval count (current + all past months up to the applied
    // month): dues waiting on CMD + dues approved by CMD. Counted per active
    // face like the other *Sites fields; one face's month is counted once even
    // if duplicate rows exist (an approved row wins over a waiting duplicate).
    const cmdApprovalSiteKeys = new Set();
    const cmdFaceMonthStatus = new Map(); // faceKey_month -> "approved" | "pending"
    const cmdMonthOwnerKeys = new Map(); // ✅ NEW — faceKey_month -> that site's landowner keys
    for (const media of summaryDocs) {
      const activeFaces = (media.mediaDetails || []).filter((d) => Number(d.status) === 1);
      // same landowner identity as the *LandOwners ledger counts
      const siteOwnerKeys = (media.landOwners || []).map((o) =>
        o.landOwnerMasterId ? String(o.landOwnerMasterId) : `${String(media._id)}_${String(o._id || o.name || "")}`,
      );
      for (const due of media.rentalDue || []) {
        if (!isDueInCmdApproval(due) || isCmdDueFullySettled(media, media.landOwners, due)) continue; // ✅ paid months drop out
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        const isUpToReference =
          parsed &&
          (parsed.year < referenceYear ||
            (parsed.year === referenceYear && parsed.monthIdx <= referenceMonthIdx));
        if (!isUpToReference) continue;
        const status = isDueApprovedByCmd(due) ? "approved" : "pending";
        activeFaces
          .filter((face) => !due.mediaDetailId || String(due.mediaDetailId) === String(face._id))
          .forEach((face) => {
            const faceKey = `${String(media._id)}_${String(face._id)}`;
            const monthKey = `${faceKey}_${due.dueMonth}`;
            cmdApprovalSiteKeys.add(faceKey);
            if (cmdFaceMonthStatus.get(monthKey) !== "approved") cmdFaceMonthStatus.set(monthKey, status);
            cmdMonthOwnerKeys.set(monthKey, siteOwnerKeys);
          });
      }
    }
    const cmdStatuses = Array.from(cmdFaceMonthStatus.values());
    overallLedgerSummary.cmdApprovalCount = cmdStatuses.length;
    overallLedgerSummary.cmdApprovalSites = cmdApprovalSiteKeys.size;
    overallLedgerSummary.cmdApprovalPendingCount = cmdStatuses.filter((s) => s === "pending").length;
    overallLedgerSummary.cmdApprovedCount = cmdStatuses.filter((s) => s === "approved").length;

    // ✅ NEW — distinct landowners of the sites behind the CMD approval counts
    const cmdOwnersFor = (wanted) => {
      const owners = new Set();
      cmdFaceMonthStatus.forEach((status, monthKey) => {
        if (wanted && status !== wanted) return;
        (cmdMonthOwnerKeys.get(monthKey) || []).forEach((k) => owners.add(k));
      });
      return owners.size;
    };
    overallLedgerSummary.cmdApprovalLandOwners = cmdOwnersFor(null);
    overallLedgerSummary.cmdApprovalPendingLandOwners = cmdOwnersFor("pending");
    overallLedgerSummary.cmdApprovedLandOwners = cmdOwnersFor("approved");

    return successResponse(
      res,
      "Billing summary fetched successfully",
      {
        pagination: {
          count: pageSize,
          pageNumber: pageNumbers,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
        },
        cityFilter,
        // ✅ ALWAYS echo back which month was actually applied
        monthFilterApplied,
        entries: pagedEntries,
        // ✅ NEW: Global Counts
        totalSites,
        siteCount,
        activeCount,
        // ✅ ALWAYS include overall outstanding totals, same shape as the
        // ledger APIs' summary block
        ...overallOutstandingTotals,
        overallLedgerSummary,
        // ✅ NEW — pure rent / pure GST (Total / Paid / Remaining), current + past.
        // Optional req.body.dueMonth ("MM-YYYY") changes ONLY this object's
        // month (that month = current, earlier months = past); everything
        // else in the response still follows monthFilter.
        newOverallLedgerSummary: calculateNewOverallLedgerSummary(
          summaryDocs,
          parseSiteFilterMonthParam(typeof req.body?.dueMonth === "string" ? req.body.dueMonth.trim() : "") ||
            // ✅ FIXED — no monthFilter → the CURRENT month (same month as
            // dueThisMonth), not each site's latest bill cycle (a yearly site
            // billed in Sep was counted as "current month" in October)
            outstandingMonthYear,
        ),
        // ✅ NEW: Rental Due Stats
        // ✅ CHANGED — not filtered by billDate (see dueThisMonthStats)
        dueThisMonth: {
          siteCount: dueThisMonthStats.dueThisMonthCount,
          amount: Math.round(dueThisMonthStats.dueThisMonthAmount),
          landOwnerCount: dueThisMonthOwners.length, // ✅ NEW
        },
        overDue: {
          siteCount: overdueSiteCount,
          amount: Math.round(overdueAmountTotal),
          landOwnerCount: ownerStats.overdue.length, // ✅ NEW
        },
        approvedCount: approvedCount,
        approvedAmountTotal: Math.round(approvedAmountTotal),
        pendingCount: pendingCount,
        pendingAmountTotal: Math.round(pendingAmountTotal),
        // ✅ NEW — landowner counts behind approvedAmountTotal / pendingAmountTotal
        approvedLandOwnerCount: ownerStats.approved.length,
        pendingLandOwnerCount: ownerStats.pending.length,
      },
      200,
    );

  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};
// ─────────────────────────────────────────────────────────────
// ✅ NEW — DELETE LANDOWNER (by landOwnerMasterId)
// Removes the landowner from every site's landOwners (+ landOwnerMasterIds,
// numberOfLandOwners), then permanently deletes the LandOwnerMaster record.
// Sites are updated with $pull only — no save hooks / recalculation run.
// ─────────────────────────────────────────────────────────────
const landOwnerDelete = async (req, res) => {
  try {
    const id = req.body?.landOwnerMasterId || req.body?.id || req.params?.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, "A valid landOwnerMasterId is required", null, 400);
    }

    const owner = await LandOwnerMaster.findById(id).select("name phone").lean();
    if (!owner) {
      return errorResponse(res, "LandOwner not found with this ID", null, 404);
    }

    // 1) Remove the landowner from every site that has them
    const sites = await MediaOnboarding.find(
      { "landOwners.landOwnerMasterId": owner._id },
      "mediaDetails.mediaCode landOwners.landOwnerMasterId",
    ).lean();

    const sitesUpdated = [];
    for (const site of sites) {
      const remainingOwners = (site.landOwners || []).filter(
        (o) => String(o.landOwnerMasterId) !== String(owner._id),
      ).length;

      await MediaOnboarding.updateOne(
        { _id: site._id },
        {
          $pull: {
            landOwners: { landOwnerMasterId: owner._id },
            landOwnerMasterIds: owner._id,
          },
          ...(remainingOwners > 0
            ? { $set: { numberOfLandOwners: remainingOwners } }
            : { $unset: { numberOfLandOwners: "" } }),
        },
        { timestamps: false },
      );

      sitesUpdated.push({
        mediaId: site._id,
        mediaCode: (site.mediaDetails || []).map((d) => d.mediaCode).join(" / "),
        remainingLandOwners: remainingOwners,
      });
    }

    // 2) The landowner itself
    await LandOwnerMaster.deleteOne({ _id: owner._id });

    return successResponse(res, "LandOwner deleted successfully", {
      landOwnerMasterId: owner._id,
      name: owner.name,
      sitesUpdated,
      // sites left without any landowner — owners must be added again in Media Onboarding
      sitesWithoutLandOwner: sitesUpdated.filter((s) => s.remainingLandOwners === 0),
    }, 200);
  } catch (error) {
    return errorResponse(res, error.message, null, 400);
  }
};

module.exports = {
  landOwnerSave,
  landOwnerList,
  landOwnerSiteFilter,
  landOwnerDelete, // ✅ NEW
  syncOrLinkMediaOwnerToMaster, // used by mediaOnboardingController.js — pass 1, before media.save()
  correctLinkedSiteAmounts, // used by mediaOnboardingController.js — pass 2, after media.save()
  removeLinkedSiteFromMaster, // used by mediaOnboardingController.js
  resolveMediaOwnerBankAccounts, // ✅ NEW — used by mediaOnboardingController.js, before any save
  seedLandOwnerBankAccounts, // ✅ NEW — run once at startup from server.js
};
