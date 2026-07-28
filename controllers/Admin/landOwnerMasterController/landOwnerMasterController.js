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
      paymentCategory: Number(owner.paymentCategory || 1),
      shareAmount: Number(owner.shareAmount || 0),
      cashAmount: Number(owner.cashAmount || 0),
      onlineAmount: Number(owner.onlineAmount || 0),
      addedAt: now,
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

  // ── NET PAYABLE — the fix ───────────────────────────────
  // owner.totalAmountWithGst / netPayableToOwner / netPayable are
  // ALWAYS derived here now — they no longer silently stay 0 just
  // because the client didn't send them.
  landOwner.totalAmountWithGst = shareAmount + gstAmount;
  landOwner.netPayableToOwner = landOwner.totalAmountWithGst;
  landOwner.netPayable = landOwner.totalAmountWithGst;
};

// ─────────────────────────────────────────────────────────────
// ATTACH UPLOADED FILES FOR A SINGLE OWNER FROM req.files.
// Supports three fieldname shapes:
//   1) Single owner, flat:      "panCardImage"
//   2) Multi owner, bracket:    "landOwners[0][panCardImage]"
//   3) Multi owner, dot:        "landOwners[0].panCardImage"
// ─────────────────────────────────────────────────────────────
const OWNER_FILE_FIELDS = [
  "panCardImage",
  "bankPassbook",
  "cancelCheckLeaf",
  "aadharCardImage",
];

const attachFilesToOwner = (owner, files, processFile, index) => {
  OWNER_FILE_FIELDS.forEach((field) => {
    let matchedFile = null;

    if (index === null) {
      // single-owner payload — plain field name
      matchedFile = files.find((f) => f.fieldname === field);
    } else {
      // multi-owner payload — bracket OR dot indexed field name
      matchedFile = files.find(
        (f) =>
          f.fieldname === `landOwners[${index}][${field}]` ||
          f.fieldname === `landOwners[${index}].${field}`,
      );
    }

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
  "onlineMode",
  // files
  "panCardImage",
  "bankPassbook",
  "cancelCheckLeaf",
  "aadharCardImage",
  // financial inputs
  "typeShare", // ← this was the missing field
  "sharePercentage",
  "shareAmount",
  "onlineAmount",
  "cashAmount",
  "gstApplicable",
  "gstNumber",
  "gstPercentage", // used as fallback input inside computeFinancialFields
  "tdsApplicable",
  "tdsPercentage", // used as fallback input inside computeFinancialFields
];


const normalizeLandOwnersBody = (body) => {
  const dotKeyPattern = /^landOwners\[(\d+)\]\.(.+)$/;
  const bracketKeyPattern = /^landOwners\[(\d+)\]\[(.+)\]$/;

  const foundKeys = Object.keys(body).filter(
    (key) => dotKeyPattern.test(key) || bracketKeyPattern.test(key),
  );

  if (foundKeys.length === 0) return body; // nothing to normalize

  const landOwners = [];

  foundKeys.forEach((key) => {
    const dotMatch = key.match(dotKeyPattern);
    const bracketMatch = key.match(bracketKeyPattern);
    const match = dotMatch || bracketMatch;

    const index = Number(match[1]);
    const field = match[2];
    const value = body[key];

    if (!landOwners[index]) landOwners[index] = {};
    landOwners[index][field] = value;

    delete body[key]; // remove the flat key now that it's folded in
  });

  body.landOwners = landOwners.filter(Boolean); // drop any sparse holes
  return body;
};

// ─────────────────────────────────────────────────────────────
// SAVE OR UPDATE A SINGLE OWNER PAYLOAD.
// Returns the saved LandOwnerMaster document.
// ─────────────────────────────────────────────────────────────
const saveSingleLandOwner = async (owner, userName, session) => {
  // ✅ safety net — strips empty-string/junk values from the 4 file
  // fields BEFORE anything is assigned onto a Mongoose document,
  // regardless of which entry point (single/multi/dot/bracket) this
  // owner payload came through. Fixes "fileType: `` is not a valid
  // enum value" when a file field is sent but no actual file was
  // uploaded for it.
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
    // list — replaces the old hand-picked if-statements, which had
    // silently OMITTED `typeShare` (present in the schema, worked
    // fine on CREATE via `new LandOwnerMaster(owner)`, but was never
    // copied here on UPDATE). Using one shared list means every field
    // in the schema is guaranteed to be updatable, and adding a new
    // schema field later only requires adding it here once.
    //
    // EXCLUDED on purpose (always DERIVED by computeFinancialFields()
    // below, never taken from the client): gstAmount,
    // totalAmountWithGst, tdsAmount, netPayableToOwner, netPayable.
    OWNER_UPDATABLE_FIELDS.forEach((field) => {
      if (owner[field] !== undefined) {
        landOwner[field] = owner[field];
      }
    });

    // client-sent gstPercentage/tdsPercentage above are used only as
    // FALLBACK inputs inside computeFinancialFields() — see that
    // function for the exact .env-priority logic.

    // ✅ gstPercentage/gstAmount/totalAmountWithGst/tdsAmount/
    // netPayableToOwner/netPayable are ALL derived here — this is
    // the fix for netPayable showing 0.
    computeFinancialFields(landOwner);

    // ✅ IST audit stamp — same nowIST() pattern as
    // mediaOnboardingController.js. Set on EVERY update, regardless
    // of which fields changed.
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


const landOwnerSave = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const body = normalizeLandOwnersBody(req.body);
    const files = req.files || [];
    const processFile =
      typeof req.processFile === "function" ? req.processFile : null;

    // same pattern as mediaOnboardingController.js
    const userName = req.user?.userName || "Admin";

    // ✅ After normalization, "landOwners[0].name" style keys become
    // a real body.landOwners array. If it ends up with exactly ONE
    // entry, treat it as a single-owner save (matches how the
    // frontend is sending it — landOwners[0].xxx — but the response
    // shape stays consistent with a plain single-owner call).
    const isMultiple =
      Array.isArray(body.landOwners) && body.landOwners.length > 1;

    const isSingleViaArray =
      Array.isArray(body.landOwners) && body.landOwners.length === 1;

    if (isSingleViaArray) {
      const owner = body.landOwners[0];
      const isNew = !owner.id;

      if (processFile) {
        attachFilesToOwner(owner, files, processFile, 0);
      }

      const savedOwner = await saveSingleLandOwner(owner, userName, session);

      await session.commitTransaction();

      const message = isNew
        ? "LandOwner created successfully"
        : "LandOwner updated successfully";

      return successResponse(res, message, savedOwner, isNew ? 201 : 200);
    }

    if (isMultiple) {
      // ── MULTIPLE OWNERS ─────────────────────────────────────
      const owners = body.landOwners;
      const savedOwners = [];

      for (let index = 0; index < owners.length; index++) {
        const owner = owners[index];

        if (processFile) {
          attachFilesToOwner(owner, files, processFile, index);
        }

        const saved = await saveSingleLandOwner(owner, userName, session);
        savedOwners.push(saved);
      }

      await session.commitTransaction();

      return successResponse(
        res,
        "LandOwners saved successfully",
        savedOwners,
        200,
      );
    } else {
      // ── SINGLE OWNER ─────────────────────────────────────────
      const owner = body;
      const isNew = !owner.id;

      if (processFile) {
        attachFilesToOwner(owner, files, processFile, null);
      }

      const savedOwner = await saveSingleLandOwner(owner, userName, session);

      await session.commitTransaction();

      const message = isNew
        ? "LandOwner created successfully"
        : "LandOwner updated successfully";

      return successResponse(res, message, savedOwner, isNew ? 201 : 200);
    }
  } catch (error) {
    await session.abortTransaction();
    return errorResponse(res, error.message, null, error.statusCode || 400);
  } finally {
    session.endSession();
  }
};


const landOwnerList = async (req, res) => {
  try {
    const { pageNumber = 1, count = 10, search } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = {};

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { panNumber: searchRegex },
        { aadharCardNumber: searchRegex },
      ];
    }

    const totalCount = await LandOwnerMaster.countDocuments(filter);

    const landOwnerListRaw = await LandOwnerMaster.find(filter)
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