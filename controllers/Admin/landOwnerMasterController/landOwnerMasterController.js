
// const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema");
// const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
// const { successResponse, errorResponse } = require("../../../utils/response");
// const mongoose = require("mongoose");

// // ─────────────────────────────────────────────────────────────
// // IST HELPER — same pattern as mediaOnboardingController.js.
// // updatedAt is stamped manually with this, NOT mongoose's
// // { timestamps: true } (which stores UTC).
// // ─────────────────────────────────────────────────────────────
// const IST_OFFSET_MS = 330 * 60000; // 5h30m
// const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

// // ─────────────────────────────────────────────────────────────
// // FIND MASTER BY PRIORITY — phone, then panNumber, then aadhaar.
// // Only used on CREATE (no id in owner payload) to avoid creating
// // a duplicate Master when the same owner is being saved again.
// // ─────────────────────────────────────────────────────────────
// const findMasterByPriority = async (owner, session) => {
//   if (owner.phone && owner.phone.trim() !== "") {
//     const byPhone = await LandOwnerMaster.findOne({
//       phone: owner.phone.trim(),
//       // isDeleted: false,
//     }).session(session || null);
//     if (byPhone) return byPhone;
//   }

//   if (owner.panNumber && owner.panNumber.trim() !== "") {
//     const byPan = await LandOwnerMaster.findOne({
//       panNumber: owner.panNumber.trim().toUpperCase(),
//       // isDeleted: false,
//     }).session(session || null);
//     if (byPan) return byPan;
//   }

//   if (owner.aadharCardNumber && owner.aadharCardNumber.trim() !== "") {
//     const byAadhar = await LandOwnerMaster.findOne({
//       aadharCardNumber: owner.aadharCardNumber.trim(),
//       isDeleted: false,
//     }).session(session || null);
//     if (byAadhar) return byAadhar;
//   }

//   return null;
// };

// // ─────────────────────────────────────────────────────────────
// // PUSH UPDATED PROFILE FIELDS INTO EVERY MEDIA DOC THAT
// // REFERENCES THIS MASTER — matched via
// // media.landOwners[].landOwnerMasterId === landOwner._id
// // ─────────────────────────────────────────────────────────────
// const syncLandOwnerToMedia = async (landOwner, session) => {
//   const mediaDocs = await MediaOnboarding.find({
//     landOwnerMasterIds: landOwner._id,
//   }).session(session || null);

//   for (const media of mediaDocs) {
//     let changed = false;

//     media.landOwners.forEach((owner) => {
//       if (
//         owner.landOwnerMasterId &&
//         String(owner.landOwnerMasterId) === String(landOwner._id)
//       ) {
//         owner.name = landOwner.name;
//         owner.phone = landOwner.phone;
//         owner.bankName = landOwner.bankName;
//         owner.ifsc = landOwner.ifsc;
//         owner.accountNumber = landOwner.accountNumber;
//         owner.upiId = landOwner.upiId;
//         owner.panNumber = landOwner.panNumber;
//         owner.panCardImage = landOwner.panCardImage;
//         owner.aadharCardNumber = landOwner.aadharCardNumber;
//         owner.aadharCardImage = landOwner.aadharCardImage;
//         owner.paymentCategory = landOwner.paymentCategory;
//         owner.bankPassbook = landOwner.bankPassbook;
//         owner.cancelCheckLeaf = landOwner.cancelCheckLeaf;
//         owner.onlineMode = landOwner.onlineMode;
//         changed = true;
//       }
//     });

//     if (changed) {
//       await media.save({ session });
//     }
//   }
// };

// const upsertLinkedSite = (landOwnerMaster, mediaInfo, owner) => {
//   if (!mediaInfo || !mediaInfo.mediaId) return; // no site context — nothing to record

//   if (!Array.isArray(landOwnerMaster.linkedSites)) {
//     landOwnerMaster.linkedSites = [];
//   }

//   let existingIdx = landOwnerMaster.linkedSites.findIndex(
//     (site) => String(site.mediaId) === String(mediaInfo.mediaId),
//   );

//   if (existingIdx === -1 && mediaInfo.mediaCode) {
//     existingIdx = landOwnerMaster.linkedSites.findIndex(
//       (site) => site.mediaCode && site.mediaCode === mediaInfo.mediaCode,
//     );
//   }

//   const now = nowIST();

//   if (existingIdx !== -1) {
//     const site = landOwnerMaster.linkedSites[existingIdx];
//     site.mediaCode = mediaInfo.mediaCode ?? site.mediaCode;
//     site.mediaName = mediaInfo.mediaName ?? site.mediaName;
//     site.paymentCategory = Number(owner.paymentCategory || site.paymentCategory || 1);
//     site.shareAmount = Number(owner.shareAmount ?? site.shareAmount ?? 0);
//     site.cashAmount = Number(owner.cashAmount ?? site.cashAmount ?? 0);
//     site.onlineAmount = Number(owner.onlineAmount ?? site.onlineAmount ?? 0);
//     site.updatedAt = now;
//   } else {
//     landOwnerMaster.linkedSites.push({
//       mediaId: mediaInfo.mediaId,
//       mediaCode: mediaInfo.mediaCode || "",
//       mediaName: mediaInfo.mediaName || "",
//       paymentCategory: Number(owner.paymentCategory || 1),
//       shareAmount: Number(owner.shareAmount || 0),
//       cashAmount: Number(owner.cashAmount || 0),
//       onlineAmount: Number(owner.onlineAmount || 0),
//       updatedAt: now,
//     });
//   }

//   landOwnerMaster.linkedMediaCount = landOwnerMaster.linkedSites.length;
// };

// const syncOrLinkMediaOwnerToMaster = async (owner, userName, session, mediaInfo) => {
//   sanitizeOwnerFileFields(owner);

//   let landOwnerMaster = null;

//   if (owner.landOwnerMasterId) {
//     landOwnerMaster = await LandOwnerMaster.findOne({
//       _id: owner.landOwnerMasterId,
//       // isDeleted: false,
//     }).session(session || null);
//   }

//   // First-time onboarding — no id sent (or it pointed at nothing
//   // valid). Try to find an existing Master by phone/pan/aadhaar
//   // before creating a new one, so the same real-world person doesn't
//   // get duplicated just because they were re-typed on a new site.
//   if (!landOwnerMaster) {
//     landOwnerMaster = await findMasterByPriority(owner, session);
//   }

//   if (!landOwnerMaster) {
//     landOwnerMaster = new LandOwnerMaster({
//       name: owner.name,
//       phone: owner.phone,
//       bankName: owner.bankName,
//       ifsc: owner.ifsc,
//       accountNumber: owner.accountNumber,
//       upiId: owner.upiId,
//       panNumber: owner.panNumber,
//       panCardImage: owner.panCardImage,
//       aadharCardNumber: owner.aadharCardNumber,
//       aadharCardImage: owner.aadharCardImage,
//       paymentCategory: owner.paymentCategory,
//       eligibleMode: owner.eligibleMode,
//       bankPassbook: owner.bankPassbook,
//       cancelCheckLeaf: owner.cancelCheckLeaf,
//       onlineMode: owner.onlineMode,
//     });
//   } else {
//     // reuse the same complete field list as landOwnerSave's UPDATE
//     // branch — guarantees this stays in sync with that logic.
//     OWNER_UPDATABLE_FIELDS.forEach((field) => {
//       if (owner[field] !== undefined) {
//         landOwnerMaster[field] = owner[field];
//       }
//     });
//   }

//   // ✅ per-site record — THIS is what lets one landowner have
//   // Cash on Site A, Online on Site B, Cash+Online on Site C.
//   upsertLinkedSite(landOwnerMaster, mediaInfo, owner);

//   // ✅ same GST/TDS/netPayable calculation as landOwnerSave() —
//   // paymentCategory-driven base amount, .env-priority percentages.
//   computeFinancialFields(landOwnerMaster);

//   landOwnerMaster.updatedBy = userName;
//   landOwnerMaster.updatedAt = nowIST();

//   await landOwnerMaster.save({ session });

//   // ── OPTION B would go here if you want full cascade instead ──
//   // await syncLandOwnerToMedia(landOwnerMaster, session);

//   // write the resolved id back onto the Media-side owner object so
//   // the caller can persist it onto landOwners[i].landOwnerMasterId
//   owner.landOwnerMasterId = landOwnerMaster._id;

//   return landOwnerMaster;
// };

// const correctLinkedSiteAmounts = async (masterId, mediaId, savedOwner, session) => {
//   if (!masterId || !mediaId) return null;

//   const landOwnerMaster = await LandOwnerMaster.findOne({
//     _id: masterId,
//     // isDeleted: false,
//   }).session(session || null);

//   if (!landOwnerMaster) return null;

//   if (!Array.isArray(landOwnerMaster.linkedSites)) {
//     landOwnerMaster.linkedSites = [];
//   }

//   const site = landOwnerMaster.linkedSites.find(
//     (s) => String(s.mediaId) === String(mediaId),
//   );

//   if (site) {
//     site.shareAmount = Number(savedOwner.shareAmount || 0);
//     site.cashAmount = Number(savedOwner.cashAmount || 0);
//     site.onlineAmount = Number(savedOwner.onlineAmount || 0);
//     site.paymentCategory = Number(
//       savedOwner.paymentCategory || site.paymentCategory || 1,
//     );
//     site.updatedAt = nowIST();
//   }

//   // also refresh the Master's own "last known" amount snapshot with
//   // the same final figures, then recompute GST/TDS/netPayable so
//   // those aren't stuck at the stale pre-save values either.
//   landOwnerMaster.shareAmount = Number(savedOwner.shareAmount || 0);
//   landOwnerMaster.cashAmount = Number(savedOwner.cashAmount || 0);
//   landOwnerMaster.onlineAmount = Number(savedOwner.onlineAmount || 0);
//   landOwnerMaster.paymentCategory = Number(
//     savedOwner.paymentCategory || landOwnerMaster.paymentCategory || 1,
//   );

//   computeFinancialFields(landOwnerMaster);
//   landOwnerMaster.updatedAt = nowIST();

//   await landOwnerMaster.save({ session });

//   return landOwnerMaster;
// };

// const computeFinancialFields = (landOwner) => {
//   const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
//   const envTdsPercent = parseFloat(process.env.TDS_PERCENTAGE || "0");

//   const shareAmount = Number(landOwner.shareAmount || 0);
//   const onlineAmount = Number(landOwner.onlineAmount || 0);
//   const paymentCategory = Number(landOwner.paymentCategory || 1);

//   // ── TDS base amount — same paymentCategory rule as MediaSchema ──
//   let tdsBaseAmount = 0;
//   if (paymentCategory === 1) {
//     tdsBaseAmount = 0; // cash only — no TDS
//   } else if (paymentCategory === 2) {
//     tdsBaseAmount = shareAmount; // online only — full share
//   } else if (paymentCategory === 3) {
//     tdsBaseAmount = onlineAmount; // split — ONLY the online portion
//   }

//   const tdsApplicable = Number(landOwner.tdsApplicable || 0);
//   const tdsPercentage =
//     tdsApplicable === 1
//       ? envTdsPercent > 0
//         ? envTdsPercent
//         : Number(landOwner.tdsPercentage || 0)
//       : 0;
//   landOwner.tdsPercentage = tdsPercentage;

//   landOwner.tdsAmount =
//     tdsApplicable === 1 && tdsPercentage > 0
//       ? Math.round((tdsBaseAmount * tdsPercentage) / 100)
//       : 0;

//   // ── GST base amount — same paymentCategory rule as MediaSchema ──
//   let gstBaseAmount = 0;
//   if (paymentCategory === 1) {
//     gstBaseAmount = 0;
//   } else if (paymentCategory === 2) {
//     gstBaseAmount = shareAmount;
//   } else if (paymentCategory === 3) {
//     gstBaseAmount = onlineAmount;
//   }

//   const gstApplicable = Number(landOwner.gstApplicable || 0);
//   const gstPct = Number(landOwner.gstPercentage || 0) || envGstPct;

//   const gstAmount =
//     gstApplicable === 1 && gstBaseAmount > 0
//       ? Math.round((gstBaseAmount * gstPct) / 100)
//       : 0;

//   landOwner.gstPercentage =
//     gstApplicable === 1 && gstBaseAmount > 0 ? gstPct : 0;
//   landOwner.gstAmount = gstAmount;

//   // ── NET PAYABLE ──────────────────────────────────────────
//   // owner.totalAmountWithGst / netPayableToOwner / netPayable are
//   // ALWAYS derived here now — they no longer silently stay 0 just
//   // because the client didn't send them.
//   landOwner.totalAmountWithGst = shareAmount + gstAmount;
//   landOwner.netPayableToOwner = landOwner.totalAmountWithGst;
//   landOwner.netPayable = landOwner.totalAmountWithGst;
// };

// // ─────────────────────────────────────────────────────────────
// // ATTACH UPLOADED FILES FOR THE (single) OWNER FROM req.files.
// // Supports plain, flat fieldnames only, e.g. "panCardImage".
// // ─────────────────────────────────────────────────────────────
// const OWNER_FILE_FIELDS = [
//   "panCardImage",
//   "bankPassbook",
//   "cancelCheckLeaf",
//   "aadharCardImage",
// ];

// const attachFilesToOwner = (owner, files, processFile) => {
//   OWNER_FILE_FIELDS.forEach((field) => {
//     const matchedFile = files.find((f) => f.fieldname === field);
//     if (matchedFile) {
//       owner[field] = processFile(matchedFile);
//     }
//   });
// };

// const sanitizeOwnerFileFields = (owner) => {
//   OWNER_FILE_FIELDS.forEach((field) => {
//     if (owner[field] === undefined) return;

//     const val = owner[field];

//     // ✅ RELAXED — don't assume the uploaded-file object always has
//     // exactly `fileName`/`filePath` as property names (your actual
//     // req.processFile implementation may name them differently). A
//     // value counts as a valid file object if it's a plain, non-empty
//     // object containing AT LEAST ONE non-empty string value anywhere
//     // in it. Only real junk (empty string "", null, {}, []) gets
//     // stripped — a legitimately uploaded file object is never lost
//     // here regardless of its exact key names.
//     const isPlainNonEmptyObject =
//       val &&
//       typeof val === "object" &&
//       !Array.isArray(val) &&
//       Object.keys(val).length > 0;

//     const hasAnyNonEmptyStringValue =
//       isPlainNonEmptyObject &&
//       Object.values(val).some(
//         (v) => typeof v === "string" && v.trim() !== "",
//       );

//     const isValidFileObject = isPlainNonEmptyObject && hasAnyNonEmptyStringValue;

//     if (!isValidFileObject) {
//       delete owner[field];
//     }
//   });
// };

// const OWNER_UPDATABLE_FIELDS = [
//   // profile
//   "name",
//   "phone",
//   "bankName",
//   "ifsc",
//   "accountNumber",
//   "upiId",
//   "panNumber",
//   "aadharCardNumber",
//   "paymentCategory",
//   "eligibleMode",
//   "onlineMode",
//   // files
//   "panCardImage",
//   "bankPassbook",
//   "cancelCheckLeaf",
//   "aadharCardImage",
//   // financial inputs
//   "typeShare",
//   "sharePercentage",
//   "shareAmount",
//   "onlineAmount",
//   "cashAmount",
//   "gstApplicable",
//   "gstNumber",
//   "gstPercentage", // used as fallback input inside computeFinancialFields
//   "tdsApplicable",
//   "tdsPercentage", // used as fallback input inside computeFinancialFields
// ];

// // ─────────────────────────────────────────────────────────────
// // SAVE OR UPDATE THE (single) OWNER PAYLOAD.
// // Returns the saved LandOwnerMaster document.
// // ─────────────────────────────────────────────────────────────
// const saveSingleLandOwner = async (owner, userName, session) => {
//   // ✅ safety net — strips empty-string/junk values from the 4 file
//   // fields BEFORE anything is assigned onto a Mongoose document.
//   // Fixes "fileType: `` is not a valid enum value" when a file field
//   // is sent but no actual file was uploaded for it.
//   sanitizeOwnerFileFields(owner);

//   let landOwner;

//   if (owner.id) {
//     // ── UPDATE ──────────────────────────────────────────────
//     landOwner = await LandOwnerMaster.findOne({
//       _id: owner.id,
//       // isDeleted: false,
//     }).session(session);

//     if (!landOwner) {
//       const err = new Error(`LandOwner not found with id ${owner.id}`);
//       err.statusCode = 404;
//       throw err;
//     }

//     // ✅ ALL updatable owner fields, copied generically from a single
//     // list — every field in the schema is guaranteed to be
//     // updatable, and adding a new schema field later only requires
//     // adding it here once.
//     //
//     // EXCLUDED on purpose (always DERIVED by computeFinancialFields()
//     // below, never taken from the client): gstAmount,
//     // totalAmountWithGst, tdsAmount, netPayableToOwner, netPayable.
//     OWNER_UPDATABLE_FIELDS.forEach((field) => {
//       if (owner[field] !== undefined) {
//         landOwner[field] = owner[field];
//       }
//     });

//     // client-sent gstPercentage/tdsPercentage above are used only as
//     // FALLBACK inputs inside computeFinancialFields() — see that
//     // function for the exact .env-priority logic.

//     // ✅ gstPercentage/gstAmount/totalAmountWithGst/tdsAmount/
//     // netPayableToOwner/netPayable are ALL derived here.
//     computeFinancialFields(landOwner);

//     // ✅ IST audit stamp — same nowIST() pattern as
//     // mediaOnboardingController.js. Set on EVERY update.
//     landOwner.updatedBy = userName;
//     landOwner.updatedAt = nowIST();

//     await landOwner.save({ session });

//     // ✅ CASCADE — push the same profile fields into every Media
//     // document's embedded landOwners[] that references this Master.
//     await syncLandOwnerToMedia(landOwner, session);
//   } else {
//     // ── CREATE ──────────────────────────────────────────────
//     const existing = await findMasterByPriority(owner, session);
//     if (existing) {
//       const err = new Error(
//         `LandOwner already exists with this phone/PAN/Aadhaar (id: ${existing._id})`,
//       );
//       err.statusCode = 400;
//       throw err;
//     }

//     landOwner = new LandOwnerMaster(owner);

//     // ✅ same paymentCategory-based GST + TDS + netPayable computation
//     // as UPDATE — mirrors MediaSchema.pre("save") owner block exactly.
//     computeFinancialFields(landOwner);

//     // ✅ IST audit stamp on first-ever save too, so updatedBy/updatedAt
//     // are never null right after create.
//     landOwner.updatedBy = userName;
//     landOwner.updatedAt = nowIST();

//     await landOwner.save({ session });
//   }

//   return landOwner;
// };

// // ─────────────────────────────────────────────────────────────
// // SINGLE-OBJECT ONLY. req.body IS the owner payload directly.
// // No landOwners[] array, no multi-owner branch, no dot/bracket
// // key normalization.
// // ─────────────────────────────────────────────────────────────
// const landOwnerSave = async (req, res) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     const owner = req.body;
//     const files = req.files || [];
//     const processFile =
//       typeof req.processFile === "function" ? req.processFile : null;

//     // same pattern as mediaOnboardingController.js
//     const userName = req.user?.userName || "Admin";

//     const isNew = !owner.id;

//     if (processFile) {
//       attachFilesToOwner(owner, files, processFile);
//     }

//     const savedOwner = await saveSingleLandOwner(owner, userName, session);

//     await session.commitTransaction();

//     const message = isNew
//       ? "LandOwner created successfully"
//       : "LandOwner updated successfully";

//     return successResponse(res, message, savedOwner, isNew ? 201 : 200);
//   } catch (error) {
//     await session.abortTransaction();
//     return errorResponse(res, error.message, null, error.statusCode || 400);
//   } finally {
//     session.endSession();
//   }
// };

// const landOwnerList = async (req, res) => {
//   try {
//     const { pageNumber = 1, count = 10, search, landOwnerName } = req.body;

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;

//     const filter = {};

//     // Main search filter for the list
//     if (search && search.trim() !== "") {
//       const searchRegex = new RegExp(search.trim(), "i");
//       filter.$or = [
//         { name: searchRegex },
//         { phone: searchRegex },
//         { panNumber: searchRegex },
//         { aadharCardNumber: searchRegex },
//       ];
//     }

//     // Filter for landOwnerName autocomplete suggestions
//     const nameFilter = {};
//     if (landOwnerName && landOwnerName.trim() !== "") {
//       const nameRegex = new RegExp(landOwnerName.trim(), "i");
//       nameFilter.name = nameRegex;
//     }

//     // Get distinct landowner names for autocomplete
//     const landOwnerNameFilter = await LandOwnerMaster.distinct("name", nameFilter);

//     // Get paginated list with main search filter
//     const totalCount = await LandOwnerMaster.countDocuments(filter);

//     const landOwnerListRaw = await LandOwnerMaster.find(filter)
//       .sort({ updatedAt: -1 })
//       .skip((pageNumbers - 1) * pageSize)
//       .limit(pageSize)
//       .lean();

//     const landOwnerListData = landOwnerListRaw.map((owner) => ({
//       ...owner,
//       totalSites: Array.isArray(owner.linkedSites)
//         ? owner.linkedSites.length
//         : 0,
//     }));

//     return successResponse(
//       res,
//       "LandOwner list fetched successfully",
//       {
//         pageNumber: pageNumbers,
//         count: pageSize,
//         totalCount,
//         totalPages: Math.ceil(totalCount / pageSize),
//         landOwnerList: landOwnerListData,
//         landOwnerNameFilter,
//       },
//       200,
//     );
//   } catch (error) {
//     return errorResponse(res, error.message, null, 400);
//   }
// };

// module.exports = {
//   landOwnerSave,
//   landOwnerList,
//   syncOrLinkMediaOwnerToMaster, // used by mediaOnboardingController.js — pass 1, before media.save()
//   correctLinkedSiteAmounts, // used by mediaOnboardingController.js — pass 2, after media.save()
// };




const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema");
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// IST HELPER — same pattern as mediaOnboardingController.js.
// updatedAt is stamped manually with this, NOT mongoose's
// { timestamps: true } (which stores UTC).
// ─────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 330 * 60000; // 5h30m
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);

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
        owner.name = landOwner.name;
        owner.phone = landOwner.phone;
        owner.bankName = landOwner.bankName;
        owner.ifsc = landOwner.ifsc;
        owner.accountNumber = landOwner.accountNumber;
        owner.upiId = landOwner.upiId;
        owner.panNumber = landOwner.panNumber;
        owner.panCardImage = landOwner.panCardImage;
        owner.aadharCardNumber = landOwner.aadharCardNumber;
        owner.aadharCardImage = landOwner.aadharCardImage;
        owner.paymentCategory = landOwner.paymentCategory;
        owner.bankPassbook = landOwner.bankPassbook;
        owner.cancelCheckLeaf = landOwner.cancelCheckLeaf;
        owner.onlineMode = landOwner.onlineMode;
        changed = true;
      }
    });

    if (changed) {
      await media.save({ session });
    }
  }
};

const upsertLinkedSite = (landOwnerMaster, mediaInfo, owner) => {
  if (!mediaInfo || !mediaInfo.mediaId) return; // no site context — nothing to record

  if (!Array.isArray(landOwnerMaster.linkedSites)) {
    landOwnerMaster.linkedSites = [];
  }

   const existingIdx = landOwnerMaster.linkedSites.findIndex(
    (site) => String(site.mediaId) === String(mediaInfo.mediaId),
  );

  const now = nowIST();

  if (existingIdx !== -1) {
    const site = landOwnerMaster.linkedSites[existingIdx];
    site.mediaCode = mediaInfo.mediaCode ?? site.mediaCode;
    site.mediaName = mediaInfo.mediaName ?? site.mediaName;
    site.siteBillMode = mediaInfo.siteBillMode ?? site.siteBillMode;
    site.paymentCategory = Number(owner.paymentCategory || site.paymentCategory || 1);
    site.shareAmount = Number(owner.shareAmount ?? site.shareAmount ?? 0);
    site.cashAmount = Number(owner.cashAmount ?? site.cashAmount ?? 0);
    site.onlineAmount = Number(owner.onlineAmount ?? site.onlineAmount ?? 0);
    site.updatedAt = now;
  } else {
    landOwnerMaster.linkedSites.push({
      mediaId: mediaInfo.mediaId,
      mediaCode: mediaInfo.mediaCode || "",
      mediaName: mediaInfo.mediaName || "",
      siteBillMode: mediaInfo.siteBillMode || "",
      paymentCategory: Number(owner.paymentCategory || 1),
      shareAmount: Number(owner.shareAmount || 0),
      cashAmount: Number(owner.cashAmount || 0),
      onlineAmount: Number(owner.onlineAmount || 0),
      updatedAt: now,
    });
  }

  landOwnerMaster.linkedMediaCount = landOwnerMaster.linkedSites.length;
};

const syncOrLinkMediaOwnerToMaster = async (owner, userName, session, mediaInfo) => {
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
      bankPassbook: owner.bankPassbook,
      cancelCheckLeaf: owner.cancelCheckLeaf,
      onlineMode: owner.onlineMode,
    });
  } else {
    // reuse the same complete field list as landOwnerSave's UPDATE
    // branch — guarantees this stays in sync with that logic.
    OWNER_UPDATABLE_FIELDS.forEach((field) => {
      if (owner[field] !== undefined) {
        landOwnerMaster[field] = owner[field];
      }
    });
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

const correctLinkedSiteAmounts = async (masterId, mediaId, savedOwner, session) => {
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
    site.paymentCategory = Number(
      savedOwner.paymentCategory || site.paymentCategory || 1,
    );
    site.updatedAt = nowIST();
  }

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
      ? Math.round((tdsBaseAmount * tdsPercentage) / 100)
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
      ? Math.round((gstBaseAmount * gstPct) / 100)
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

const sanitizeOwnerFileFields = (owner) => {
  OWNER_FILE_FIELDS.forEach((field) => {
    if (owner[field] === undefined) return;

    const val = owner[field];

    // ✅ RELAXED — don't assume the uploaded-file object always has
    // exactly `fileName`/`filePath` as property names (your actual
    // req.processFile implementation may name them differently). A
    // value counts as a valid file object if it's a plain, non-empty
    // object containing AT LEAST ONE non-empty string value anywhere
    // in it. Only real junk (empty string "", null, {}, []) gets
    // stripped — a legitimately uploaded file object is never lost
    // here regardless of its exact key names.
    const isPlainNonEmptyObject =
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      Object.keys(val).length > 0;

    const hasAnyNonEmptyStringValue =
      isPlainNonEmptyObject &&
      Object.values(val).some(
        (v) => typeof v === "string" && v.trim() !== "",
      );

    const isValidFileObject = isPlainNonEmptyObject && hasAnyNonEmptyStringValue;

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

// ─────────────────────────────────────────────────────────────
// APPLY FILE FIELDS ON UPDATE ONLY.
//
// If a NEW valid file was sent this request (owner[field] is
// already sanitized by sanitizeOwnerFileFields() before this runs,
// so junk/empty values were already stripped off `owner`) —
// overwrite it.
//
// If a file field is MISSING from `owner` this request (e.g.
// bankPassbook wasn't re-uploaded on this update) — it is REMOVED
// from the DB entirely (landOwner[field] = undefined → mongoose
// $unsets that path on save). So an update that resends only 3 of
// the 4 files will delete the 4th one from the document, and it
// will no longer appear anywhere (list API, detail response, DB).
// ─────────────────────────────────────────────────────────────
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
// SAVE OR UPDATE THE (single) OWNER PAYLOAD.
// Returns the saved LandOwnerMaster document.
// ─────────────────────────────────────────────────────────────
const saveSingleLandOwner = async (owner, userName, session) => {
  // ✅ safety net — strips empty-string/junk values from the 4 file
  // fields BEFORE anything is assigned onto a Mongoose document.
  // Fixes "fileType: `` is not a valid enum value" when a file field
  // is sent but no actual file was uploaded for it.
  sanitizeOwnerFileFields(owner);

  let landOwner;

  if (owner.id) {
    // ── UPDATE ──────────────────────────────────────────────
    landOwner = await LandOwnerMaster.findOne({
      _id: owner.id,
      // isDeleted: false,
    }).session(session);

    if (!landOwner) {
      const err = new Error(`LandOwner not found with id ${owner.id}`);
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
    const existing = await findMasterByPriority(owner, session);
    if (existing) {
      const err = new Error(
        `LandOwner already exists with this phone/PAN/Aadhaar (id: ${existing._id})`,
      );
      err.statusCode = 400;
      throw err;
    }

    landOwner = new LandOwnerMaster(owner);

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

// ─────────────────────────────────────────────────────────────
// BUILD RESPONSE PAYLOAD — RESPONSE-ONLY, DOES NOT TOUCH THE DB.
//
// On UPDATE: any file field (panCardImage/bankPassbook/
// cancelCheckLeaf/aadharCardImage) that was NOT sent in THIS
// request is removed from the object we send back, even though it
// is still safely preserved in the database (via
// applyOwnerFileFields in saveSingleLandOwner).
//
// On CREATE: nothing is stripped — every file that was uploaded is
// returned as normal.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// BUILD RESPONSE PAYLOAD — RESPONSE-ONLY SAFETY NET.
//
// applyOwnerFileFields() above now actually REMOVES a file field
// from the DB when it isn't resent on update, so savedOwner.toObject()
// normally won't include it anyway. This just guarantees the
// response never echoes back a file field that wasn't part of THIS
// request, even if some future change makes DB removal optional again.
//
// On CREATE: nothing is stripped — every file that was uploaded is
// returned as normal.
// ─────────────────────────────────────────────────────────────
const buildResponsePayload = (savedOwner, owner, isNew) => {
  const responseData =
    typeof savedOwner.toObject === "function"
      ? savedOwner.toObject()
      : { ...savedOwner };

  if (!isNew) {
    OWNER_FILE_FIELDS.forEach((field) => {
      if (owner[field] === undefined) {
        delete responseData[field];
      }
    });
  }

  return responseData;
};

// ─────────────────────────────────────────────────────────────
// SINGLE-OBJECT ONLY. req.body IS the owner payload directly.
// No landOwners[] array, no multi-owner branch, no dot/bracket
// key normalization.
// ─────────────────────────────────────────────────────────────
const landOwnerSave = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const owner = req.body;
    const files = req.files || [];
    const processFile =
      typeof req.processFile === "function" ? req.processFile : null;

    // same pattern as mediaOnboardingController.js
    const userName = req.user?.userName || "Admin";

    const isNew = !owner.id;

    if (processFile) {
      attachFilesToOwner(owner, files, processFile);
    }

    const savedOwner = await saveSingleLandOwner(owner, userName, session);

    await session.commitTransaction();

    const message = isNew
      ? "LandOwner created successfully"
      : "LandOwner updated successfully";

    // ✅ response-only shaping — DB already has bankPassbook (etc.)
    // safely preserved via applyOwnerFileFields; this just keeps it
    // OUT of the response body when it wasn't part of this request.
    const responsePayload = buildResponsePayload(savedOwner, owner, isNew);

    return successResponse(res, message, responsePayload, isNew ? 201 : 200);
  } catch (error) {
    await session.abortTransaction();
    return errorResponse(res, error.message, null, error.statusCode || 400);
  } finally {
    session.endSession();
  }
};

const landOwnerList = async (req, res) => {
  try {
    const { pageNumber = 1, count = 10, search, landOwnerName } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};

    // Main search filter for the list
    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { panNumber: searchRegex },
        { aadharCardNumber: searchRegex },
      ];
    }

    // Filter for landOwnerName autocomplete suggestions
    const nameFilter = {};
    if (landOwnerName && landOwnerName.trim() !== "") {
      const nameRegex = new RegExp(landOwnerName.trim(), "i");
      nameFilter.name = nameRegex;
    }

    // Get distinct landowner names for autocomplete
    const landOwnerNameFilter = await LandOwnerMaster.distinct("name", nameFilter);

    // Get paginated list with main search filter
    const totalCount = await LandOwnerMaster.countDocuments(filter);

    const landOwnerListRaw = await LandOwnerMaster.find(filter)
      // ✅ exclude the 4 file fields from the LIST response — never
      // even fetched from the DB for this endpoint, keeps the
      // payload light. (Full file objects are still available via
      // the single-owner fetch/detail endpoint if you have one.)
      .sort({ updatedAt: -1 })
      .skip((pageNumbers - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const landOwnerListData = landOwnerListRaw.map((owner) => ({
      ...owner,
      totalSites: Array.isArray(owner.linkedSites)
        ? owner.linkedSites.length
        : 0,
    }));

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

module.exports = {
  landOwnerSave,
  landOwnerList,
  syncOrLinkMediaOwnerToMaster, // used by mediaOnboardingController.js — pass 1, before media.save()
  correctLinkedSiteAmounts, // used by mediaOnboardingController.js — pass 2, after media.save()
};