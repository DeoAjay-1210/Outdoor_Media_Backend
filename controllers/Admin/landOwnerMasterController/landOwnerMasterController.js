const LandOwnerMaster = require("../../../models/Admin/LandOwnerMasterSchema/LandOwnerMasterSchema");
const MediaOnboarding = require("../../../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const mongoose = require("mongoose");
const {
  computeOutstandingSummary,
  dedupeGstBalanceHistory,
  getOwnerWiseOutstanding,
} = require("../../../controllers/Admin/MediaOnboardingController/LedgerNew2Controller");
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
      await media.save({ session, timestamps: false });
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
    site.paymentCategory = Number(
      owner.paymentCategory || site.paymentCategory || 1,
    );
    site.shareAmount = Number(owner.shareAmount ?? site.shareAmount ?? 0);
    site.cashAmount = Number(owner.cashAmount ?? site.cashAmount ?? 0);
    site.onlineAmount = Number(owner.onlineAmount ?? site.onlineAmount ?? 0);
    site.tdsApplicable = Number(owner.tdsApplicable ?? site.tdsApplicable ?? 0);
    site.tdsPercentage = Number(owner.tdsPercentage ?? site.tdsPercentage ?? 0);
    site.tdsAmount = Number(owner.tdsAmount ?? site.tdsAmount ?? 0);
    // ✅ FIX — GST applicable/percentage were never copied before, only gstAmount was
    site.gstApplicable = Number(owner.gstApplicable ?? site.gstApplicable ?? 0);
    site.gstPercentage = Number(owner.gstPercentage ?? site.gstPercentage ?? 0);
    site.gstAmount = Number(owner.gstAmount ?? site.gstAmount ?? 0); // ← ADDED
    site.netPayableToOwner = Number(
      owner.netPayableToOwner ?? site.netPayableToOwner ?? 0,
    ); // ← ADDED
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
      tdsApplicable: Number(owner.tdsApplicable || 0),
      tdsPercentage: Number(owner.tdsPercentage || 0),
      tdsAmount: Number(owner.tdsAmount || 0),
      gstApplicable: Number(owner.gstApplicable || 0),
      gstPercentage: Number(owner.gstPercentage || 0),
      gstAmount: Number(owner.gstAmount || 0), // ← ADDED
      netPayableToOwner: Number(owner.netPayableToOwner || 0), // ← ADDED
      updatedAt: now,
    });
  }

  landOwnerMaster.linkedMediaCount = landOwnerMaster.linkedSites.length;
  landOwnerMaster.totalShareAmount = landOwnerMaster.linkedSites.reduce(
    (sum, s) => sum + Number(s.shareAmount || 0),
    0,
  );
  landOwnerMaster.totalGstAmount = landOwnerMaster.linkedSites.reduce(
    (sum, s) => sum + Number(s.gstAmount || 0),
    0,
  );
  landOwnerMaster.totalNetPayableToOwner = landOwnerMaster.linkedSites.reduce(
    (sum, s) => sum + Number(s.netPayableToOwner || 0),
    0,
  );
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
  landOwnerMaster.totalShareAmount = landOwnerMaster.linkedSites.reduce(
    (sum, s) => sum + Number(s.shareAmount || 0),
    0,
  );
  landOwnerMaster.totalGstAmount = landOwnerMaster.linkedSites.reduce(
    (sum, s) => sum + Number(s.gstAmount || 0),
    0,
  );
  landOwnerMaster.totalNetPayableToOwner = landOwnerMaster.linkedSites.reduce(
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
    // if (existing) {
    //   const err = new Error(
    //     `LandOwner already exists with this phone/PAN/Aadhaar (id: ${existing._id})`,
    //   );
    //   err.statusCode = 400;
    //   throw err;
    // }

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
      const searchRegex = new RegExp(search.trim(), "i");
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
      const nameRegex = new RegExp(landOwnerName.trim(), "i");
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
      { $sort: { latestActivityAt: -1 } },
      { $skip: (pageNumbers - 1) * pageSize },
      { $limit: pageSize },
    ]);

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
//     if (landOwnerName && landOwnerName.trim() !== "") {
//       const nameRegex = new RegExp(landOwnerName.trim(), "i");
//       if (!filter.$and) filter.$and = [];
//       filter.$and.push({ name: nameRegex });
//     }

//     const landOwnerNameFilter = (
//       await LandOwnerMaster.aggregate([
//         { $group: { _id: "$name", latestUpdate: { $max: "$updatedAt" } } },
//         { $sort: { latestUpdate: -1 } },
//       ])
//     ).map((item) => item._id);

//     const totalCount = await LandOwnerMaster.countDocuments(filter);

//    const landOwnerListRaw = await LandOwnerMaster.aggregate([
//       { $match: filter },
//       {
//         $addFields: {
//           latestActivityAt: {
//             $max: [
//               "$updatedAt",
//               {
//                 $max: {
//                   $map: {
//                     input: { $ifNull: ["$linkedSites", []] },
//                     as: "site",
//                     in: "$$site.updatedAt",
//                   },
//                 },
//               },
//             ],
//           },
//         },
//       },
//       { $sort: { latestActivityAt: -1 } },
//       { $skip: (pageNumbers - 1) * pageSize },
//       { $limit: pageSize },
//     ]);

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

// const landOwnerSiteFilter = async (req, res) => {
//   try {
//     const {
//       landOwnerMasterIds,
//       search,
//       pageNumber = 1,
//       count = 10,
//     } = req.body || {};

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;

//     let ownerFilter = {};
//     if (Array.isArray(landOwnerMasterIds) && landOwnerMasterIds.length > 0) {
//       ownerFilter._id = { $in: landOwnerMasterIds };
//     } else if (search && search.trim() !== "") {
//       const searchRegex = new RegExp(search.trim(), "i");
//       ownerFilter.$or = [
//         { name: searchRegex },
//         { panNumber: searchRegex },
//         { aadharCardNumber: searchRegex },
//       ];
//     }
//     // no landOwnerMasterIds/search → empty filter → every landowner

//     const requestedOwners = await LandOwnerMaster.find(ownerFilter)
//       .select("name phone")
//       .lean();

//     if (requestedOwners.length === 0) {
//       return successResponse(
//         res,
//         "No landowners found",
//         {
//           pagination: { count: pageSize, pageNumber: pageNumbers, totalCount: 0, totalPages: 0 },
//           entries: [],
//         },
//         200,
//       );
//     }

//     const requestedOwnerIds = requestedOwners.map((o) => String(o._id));
//     const ownerNameById = {};
//     requestedOwners.forEach((o) => {
//       ownerNameById[String(o._id)] = o.name;
//     });

//     // ── ground truth — every Media property any of these owners is
//     // actually on, straight from MediaOnboarding (NOT the
//     // LandOwnerMaster.linkedSites cache, which can go stale) ──
//  const relatedMediaDocs = await MediaOnboarding.find(
//       { "landOwners.landOwnerMasterId": { $in: requestedOwnerIds } },
//       "mediaCode mediaName rentalPayment landOwners.landOwnerMasterId landOwners.name landOwners.paymentCategory landOwners.shareAmount landOwners.gstAmount landOwners.netPayableToOwner landOwners.onlineAmount landOwners.cashAmount landOwners.tdsAmount",
//     ).lean();
//    const allOwnerIdsFromMedia = new Set();
//     relatedMediaDocs.forEach((mediaDoc) => {
//       (mediaDoc.landOwners || []).forEach((o) => {
//         if (o.landOwnerMasterId) {
//           allOwnerIdsFromMedia.add(String(o.landOwnerMasterId));
//         }
//       });
//     });

//     // 🔥 FIX: Fetch names for ALL landowners found in media docs
//     const allOwnersFromMedia = await LandOwnerMaster.find(
//       { _id: { $in: Array.from(allOwnerIdsFromMedia) } },
//       "name"
//     ).lean();

//     // 🔥 FIX: Merge names into ownerNameById (preserve existing, add missing ones)
//     allOwnersFromMedia.forEach((o) => {
//       const id = String(o._id);
//       if (!ownerNameById[id]) {
//         ownerNameById[id] = o.name;
//       }
//     });

//     // site map: mediaId -> { mediaCode, mediaName, amounts, ownerIds: [], ownersDetail: [] }
//     const siteMap = new Map();
//     relatedMediaDocs.forEach((mediaDoc) => {
//       const ownersOnThisSite = (mediaDoc.landOwners || []).filter(
//         (o) => o.landOwnerMasterId,
//       );
//       const ownerIdsOnThisSite = ownersOnThisSite.map((o) =>
//         String(o.landOwnerMasterId),
//       );

//       siteMap.set(String(mediaDoc._id), {
//         mediaId: mediaDoc._id,
//         mediaCode: mediaDoc.mediaCode,
//         mediaName: mediaDoc.mediaName,
//         totalRentalAmount: mediaDoc.rentalPayment?.totalRentalAmount || 0,
//         gstAmount: mediaDoc.rentalPayment?.gstAmount || 0,
//         gstApplicable: Number(mediaDoc.rentalPayment?.gstApplicable) || 0,
//         ownerIds: ownerIdsOnThisSite,
//         ownersDetail: ownersOnThisSite.map((o) => ({
//           landOwnerMasterId: String(o.landOwnerMasterId),
//           paymentCategory: o.paymentCategory,
//           shareAmount: o.shareAmount || 0,
//           gstAmount: o.gstAmount || 0,
//           netPayableToOwner: o.netPayableToOwner || 0,
//           onlineAmount: o.onlineAmount || 0,
//           cashAmount: o.cashAmount || 0,
//           tdsAmount: o.tdsAmount || 0,
//         })),
//       });
//     });

// const toSiteResponseShape = (site, ownerIdForGst) => {
//       if (ownerIdForGst) {
//         const ownerDetail = site.ownersDetail?.find(
//           (od) => od.landOwnerMasterId === ownerIdForGst,
//         );
//         return {
//           mediaId: site.mediaId,
//           mediaCode: site.mediaCode,
//           mediaName: site.mediaName,
//           baseRent: site.totalRentalAmount,
//           gstAmount: ownerDetail?.gstAmount || 0,
//           gstApplicable: ownerDetail?.paymentCategory ? (ownerDetail.gstAmount > 0 ? 1 : 0) : 0,
//         };
//       }

//       const combinedGstAmount = (site.ownersDetail || []).reduce(
//         (sum, od) => sum + Number(od.gstAmount || 0),
//         0,
//       );
//       const anyOwnerGstApplicable = (site.ownersDetail || []).some(
//         (od) => Number(od.gstAmount || 0) > 0,
//       );
//       return {
//         mediaId: site.mediaId,
//         mediaCode: site.mediaCode,
//         mediaName: site.mediaName,
//         baseRent: site.totalRentalAmount,
//         gstAmount: combinedGstAmount,
//         gstApplicable: anyOwnerGstApplicable ? 1 : 0,
//       };
//     };

//     const buildAmounts = (sites) => {
//       const totalBaseRent = sites.reduce((s, site) => s + site.totalRentalAmount, 0);
//       const gstHoldTotal = sites.reduce((s, site) => s + site.gstAmount, 0);
//       return {
//         totalBaseRent,
//         gstHoldTotal,
//         consolidatedPayable: totalBaseRent + gstHoldTotal,
//       };
//     };

//     // ── split sites: sole-owned (exactly 1 owner) vs multi-owned (2+) ──
//     const soleOwnedSitesByOwner = new Map(); // ownerId -> [site, ...]
//     const multiOwnerSites = []; // [site, ...]

//     siteMap.forEach((site) => {
//       if (site.ownerIds.length <= 1) {
//         const soloOwnerId = site.ownerIds[0];
//         if (soloOwnerId) {
//           if (!soleOwnedSitesByOwner.has(soloOwnerId)) {
//             soleOwnedSitesByOwner.set(soloOwnerId, []);
//           }
//           soleOwnedSitesByOwner.get(soloOwnerId).push(site);
//         }
//       } else {
//         multiOwnerSites.push(site);
//       }
//     });

//     // ── group multi-owner sites by EXACT owner-set signature ──
//     // (sorted, joined owner ids) — same signature repeated on 2+
//     // sites becomes "sharedGroup"; a signature appearing on only 1
//     // site stays "shared".
//     const signatureGroups = new Map(); // signature -> { ownerIds: [...], sites: [...] }

//     multiOwnerSites.forEach((site) => {
//       const signature = [...site.ownerIds].sort().join(",");
//       if (!signatureGroups.has(signature)) {
//         signatureGroups.set(signature, { ownerIds: site.ownerIds, sites: [] });
//       }
//       signatureGroups.get(signature).sites.push(site);
//     });

//     const entries = [];

//     // ── "single" entries — one per owner with 1+ sole-owned sites ──
//     requestedOwnerIds.forEach((ownerId) => {
//       const sites = soleOwnedSitesByOwner.get(ownerId);
//       if (!sites || sites.length === 0) return;

//       let totalShareAmount = 0;
//       let totalGstAmount = 0;
//       let totalNetPayableToOwner = 0;
//       let totalOnlineAmount = 0;
//       let totalCashAmount = 0;
//       let totalTdsAmount = 0;
//       let lastPaymentCategory = null;

//       sites.forEach((site) => {
//         const ownerDetail = site.ownersDetail?.find(
//           (od) => od.landOwnerMasterId === ownerId,
//         );
//         if (ownerDetail) {
//           totalShareAmount += ownerDetail.shareAmount;
//           totalGstAmount += ownerDetail.gstAmount;
//           totalNetPayableToOwner += ownerDetail.netPayableToOwner;
//           totalOnlineAmount += ownerDetail.onlineAmount;
//           totalCashAmount += ownerDetail.cashAmount;
//           totalTdsAmount += ownerDetail.tdsAmount;
//           lastPaymentCategory = ownerDetail.paymentCategory; // may differ per site; last one wins
//         }
//       });

//       entries.push({
//         entryType: "single",
//         landOwnerMasterId: ownerId,
//         // name: ownerNameById[ownerId] || "Unknown",
//         totalSites: sites.length,
//          totalLandOwners: 1,
//         ...buildAmounts(sites),
//         landOwners: [
//           {
//             landOwnerMasterId: ownerId,
//             name: ownerNameById[ownerId] || "Unknown",
//             paymentCategory: lastPaymentCategory,
//             totalShareAmount,
//             totalGstAmount,
//             totalNetPayableToOwner,
//             totalOnlineAmount,
//             totalCashAmount,
//             totalTdsAmount,
//           },
//         ],
//         sites: sites.map((site) => toSiteResponseShape(site, ownerId)), // ✅ CHANGED — pass ownerId
//       });
//     });

//     // ── "shared" (1 site) vs "sharedGroup" (2+ sites, same owner-set) ──
//     signatureGroups.forEach((group) => {
//       // sum each owner's OWN shareAmount/gstAmount/netPayableToOwner
//       // across every site in this group (not the site's total rent —
//       // this owner's actual slice of it).
//       const landOwners = group.ownerIds.map((id) => {
//         let totalShareAmount = 0;
//         let totalGstAmount = 0;
//         let totalNetPayableToOwner = 0;
//         let totalOnlineAmount = 0;
//         let totalCashAmount = 0;
//         let totalTdsAmount = 0;
//         let lastPaymentCategory = null;

//         group.sites.forEach((site) => {
//           const ownerDetail = site.ownersDetail?.find(
//             (od) => od.landOwnerMasterId === id,
//           );
//           if (ownerDetail) {
//             totalShareAmount += ownerDetail.shareAmount;
//             totalGstAmount += ownerDetail.gstAmount;
//             totalNetPayableToOwner += ownerDetail.netPayableToOwner;
//             totalOnlineAmount += ownerDetail.onlineAmount;
//             totalCashAmount += ownerDetail.cashAmount;
//             totalTdsAmount += ownerDetail.tdsAmount;
//             lastPaymentCategory = ownerDetail.paymentCategory; // may differ per site; last one wins
//           }
//         });

//         return {
//           landOwnerMasterId: id,
//           name: ownerNameById[id] || "Unknown",
//           paymentCategory: lastPaymentCategory,
//           totalShareAmount,
//           totalGstAmount,
//           totalNetPayableToOwner,
//           totalOnlineAmount,
//           totalCashAmount,
//           totalTdsAmount,
//         };
//       });

//       const amounts = buildAmounts(group.sites);
//       const anyGstApplicable = group.sites.some((s) => s.gstApplicable === 1);

//             entries.push({
//         entryType: "shared",
//         totalLandOwners: landOwners.length,
//         totalSites: group.sites.length, // ✅ dynamic, not hardcoded
//         gstApplicable: anyGstApplicable ? 1 : 0,
//         ...amounts,
//         landOwners,
//         sites: group.sites.map((site) => toSiteResponseShape(site)), // ✅ CHANGED — no ownerId, combined across all owners on this site
//       });
//     });

//     // ── paginate the ENTRIES (not the raw owners) ──
//     const totalCount = entries.length;
//     const startIdx = (pageNumbers - 1) * pageSize;
//     const pagedEntries = entries.slice(startIdx, startIdx + pageSize);

//     return successResponse(
//       res,
//       "Billing summary fetched successfully",
//       {
//         pagination: {
//           count: pageSize,
//           pageNumber: pageNumbers,
//           totalCount,
//           totalPages: Math.ceil(totalCount / pageSize),
//         },
//         entries: pagedEntries,
//       },
//       200,
//     );
//   } catch (error) {
//     return errorResponse(res, error.message, null, 400);
//   }
// };
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
const landOwnerSiteFilter = async (req, res) => {
  try {
    const {
      landOwnerMasterIds,
      search,
      pageNumber = 1,
      count = 10,
      // ✅ ADDED — new request params
      monthFilter,
      currentMonthLedgerEntries: wantCurrentMonthLedger,
      pastMonthLedgerEntries: wantPastMonthLedger,
      currentGst: wantCurrentGst,
      pastGst: wantPastGst,
      // ✅ NEW: Rental Status Filters
      approvalSite: wantApprovalSite,
      pendingSite: wantPendingSite,
      pastPending: wantPastPending,
      overDue: wantOverDue,
      // ✅ NEW: Pending Payment Filters
      currentPendingRent: wantCurrentPendingRent,
      pastRentalPending: wantPastRentalPending,
      currentGstPending: wantCurrentGstPending,
      pastGstPending: wantPastGstPending,
    } = req.body || {};

    const today = nowIST();
    today.setUTCHours(0, 0, 0, 0);
    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    // ✅ ADDED — resolve the target month (defaults to "now")
    const parsedMonthFilter = parseSiteFilterMonthParam(monthFilter);
    const referenceDate = parsedMonthFilter
      ? new Date(parsedMonthFilter.year, parsedMonthFilter.month - 1, 1)
      : nowIST();
    const referenceYear = referenceDate.getFullYear();
    const referenceMonthIdx = referenceDate.getMonth();
    const monthFilterApplied = parsedMonthFilter
      ? monthFilter
      : `${String(referenceMonthIdx + 1).padStart(2, "0")}-${referenceYear}`;

    const includeCurrentLedger = Number(wantCurrentMonthLedger) === 1;
    const includePastLedger = Number(wantPastMonthLedger) === 1;
    const includeCurrentGst = Number(wantCurrentGst) === 1;
    const includePastGst = Number(wantPastGst) === 1;

    const includeApprovalSite = Number(wantApprovalSite) === 1;
    const includePendingSites = Number(wantPendingSite) === 1;
    const includePastPending = Number(wantPastPending) === 1;
    const includeOverDue = Number(wantOverDue) === 1;

    const includeCurrentPendingRent = Number(wantCurrentPendingRent) === 1;
    const includePastRentalPending = Number(wantPastRentalPending) === 1;
    const includeCurrentGstPending = Number(wantCurrentGstPending) === 1;
    const includePastGstPending = Number(wantPastGstPending) === 1;

    const needsLedgerFields =
      includeCurrentLedger ||
      includePastLedger ||
      includeCurrentGst ||
      includePastGst ||
      includeCurrentPendingRent ||
      includePastRentalPending ||
      includeCurrentGstPending ||
      includePastGstPending;
    const needsRentalStatusFields =
      includeApprovalSite ||
      includePendingSites ||
      includePastPending ||
      includeOverDue;
    const isAnyFilterActive = needsLedgerFields || needsRentalStatusFields;

    // let ownerFilter = {};
    const genericSearchRegex =
      search && search.trim() !== "" ? new RegExp(search.trim(), "i") : null;
    const mediaSearchRegex =
      req.body?.mediaSearch && req.body.mediaSearch.trim() !== ""
        ? new RegExp(req.body.mediaSearch.trim(), "i")
        : null;
    // combined regex used against media docs — either explicit
    // mediaSearch, or fall back to the generic `search` term
    const effectiveMediaSearchRegex = mediaSearchRegex || genericSearchRegex;

    let ownerFilter = {};
    if (Array.isArray(landOwnerMasterIds) && landOwnerMasterIds.length > 0) {
      ownerFilter._id = { $in: landOwnerMasterIds };
    } else if (genericSearchRegex) {
      // ✅ ADDED — first, find owner ids matching mediaName/mediaCode
      // (the "apprisal 11" case), so a media-name search still
      // resolves to the correct owner(s) instead of coming back empty.
      const mediaMatchDocs = await MediaOnboarding.find(
        {
          $or: [
            { mediaName: genericSearchRegex },
            { mediaCode: genericSearchRegex },
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
      return successResponse(
        res,
        "No landowners found",
        {
          pagination: {
            count: pageSize,
            pageNumber: pageNumbers,
            totalCount: 0,
            totalPages: 0,
          },
          entries: [],
        },
        200,
      );
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

    // ✅ CHANGED — project the extra fields needed for ledger/GST
    // computation ONLY when at least one of the new flags was
    // requested, so the query stays light for callers who don't ask
    // for any of this.
    const mediaProjection =
      "status gstApplicableFlag mediaCode mediaName updatedAt rentalPayment landOwners._id landOwners.landOwnerMasterId landOwners.name landOwners.paymentCategory landOwners.gstApplicable landOwners.shareAmount landOwners.gstAmount landOwners.netPayableToOwner landOwners.onlineAmount landOwners.cashAmount landOwners.tdsAmount rentalDue rentalDueEntries" +
      (needsLedgerFields || needsRentalStatusFields
        ? " ledger ledgerHistory gstBalanceHistory"
        : "");

    const relatedMediaDocs = await MediaOnboarding.find(
      {
        "landOwners.landOwnerMasterId": { $in: requestedOwnerIds },
        // ✅ CHANGED — uses effectiveMediaSearchRegex so a plain
        // `search` term (matched to media name/code) also narrows
        // which sites show up under the resolved owner(s), not just
        // an explicit `mediaSearch` param.
        ...(effectiveMediaSearchRegex
          ? {
              $or: [
                { mediaName: effectiveMediaSearchRegex },
                { mediaCode: effectiveMediaSearchRegex },
              ],
            }
          : {}),
      },
      mediaProjection,
    ).lean();

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
            return Math.round((base * envGstPct) / 100);
          };

          const rentalGst =
            Number(mediaDoc.rentalPayment?.gstApplicable) === 1
              ? Number(mediaDoc.rentalPayment?.gstAmount || 0) ||
                Math.round(
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

          // ✅ FIXED: Support both separated (1) and included (2) GST cycles
          if (Number(due.withGst) !== 1 && Number(due.withGst) !== 2) return;
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
        Math.round(
          (Number(mediaDoc.rentalPayment?.totalRentalAmount || 0) * envGstPct) /
            100,
        );
      const calcOwnerGst = (o) => {
        const pc = Number(o.paymentCategory || 1);
        let base = 0;
        if (pc === 2) base = Number(o.shareAmount || 0);
        else if (pc === 3) base = Number(o.onlineAmount || 0);
        return Math.round((base * envGstPct) / 100);
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
      const currentCycle = (rentalDue || []).find((due) => {
        const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
        return (
          parsed &&
          parsed.year === referenceYear &&
          parsed.monthIdx === referenceMonthIdx
        );
      });

      if (currentCycle) {
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
            cycleGstAmount = Math.round(net - net / (1 + envGstPct / 100));
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
        rentalDue.some((due) => {
          const status = due.approvalStatus ?? due.status ?? 1;
          const isPastDueDate = due.dueDate && new Date(due.dueDate) < today;
          return status === 4 || (isPastDueDate && status !== 3);
        });

      siteMap.set(String(mediaDoc._id), {
        mediaId: mediaDoc._id,
        mediaCode: mediaDoc.mediaCode,
        mediaName: mediaDoc.mediaName,
        totalRentalAmount: mediaDoc.rentalPayment?.totalRentalAmount || 0,
        gstAmount: resolvedSiteGstAmount,
        gstApplicable: resolvedSiteGstAmount > 0 ? 1 : 0,
        updatedAt: mediaDoc.updatedAt, // ✅ ADDED — needed for latestActivityAt sort below
        ownerIds: ownerIdsOnThisSite,
        rentalStatus: {
          hasApprovedSite,
          hasPendingSite,
          hasPastPendingSite,
          isOverDueSite,
        },
        ownersDetail: ownersOnThisSite.map((o) => {
          const pc = Number(o.paymentCategory || 1);
          const envGstPct = parseFloat(process.env.GST_PERCENTAGE || "18");
          const calcOwnerGst = (owner) => {
            let base = 0;
            if (pc === 2) base = Number(owner.shareAmount || 0);
            else if (pc === 3) base = Number(owner.onlineAmount || 0);
            return Math.round((base * envGstPct) / 100);
          };

          let oGst = Number(o.gstAmount || 0);

          // Strategy 1: Explicitly applicable
          if (oGst === 0 && Number(o.gstApplicable) === 1) {
            oGst = calcOwnerGst(o);
          }

          // Strategy 2: Site has GST but owner is missing it (e.g. site-level flag 1 or 0)
          if (oGst === 0 && resolvedSiteGstAmount > 0) {
            // If site-level GST, split it. If owner-level, re-calc if they are likely candidates
            if (siteGstFlag === 1 || siteGstFlag === 0) {
              oGst = Math.round(
                resolvedSiteGstAmount / (ownersOnThisSite.length || 1),
              );
            } else if (siteGstFlag === 2 && Number(o.gstApplicable) === 1) {
              oGst = calcOwnerGst(o);
            }
          }

          return {
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
        rentalDue: rentalDue, // ✅ STORE FOR RESPONSE
      });
    });

    const toSiteResponseShape = (site) => {
      // ✅ Filter rentalDue entries matching the requested monthFilter
      // (Matches RentalDueNew2 behavior: current month OR past pending)
      const filteredDues = (site.rentalDue || [])
        .filter((due) => {
          const parsed = parseSiteFilterDueMonthLabel(due.dueMonth);
          if (!parsed) return false;
          const isCurrent =
            parsed.year === referenceYear &&
            parsed.monthIdx === referenceMonthIdx;
          const isPast =
            parsed.year < referenceYear ||
            (parsed.year === referenceYear &&
              parsed.monthIdx < referenceMonthIdx);

          return isCurrent || (isPast && due.approvalStatus !== 3);
        })
        .map((due) => ({
          dueMonth: due.dueMonth,
          dueDate: due.dueDate,
          approvalStatus: due.approvalStatus,
          ownerApprovalDate: due.ownerApprovalDate,
          netPayable: due.netPayable,
          withGst: due.withGst,
          gstAmount: due.gstAmount,
          baseAmount: due.baseAmount,
        }));

      return {
        mediaId: site.mediaId,
        mediaCode: site.mediaCode,
        mediaName: site.mediaName,
        baseRent: site.totalRentalAmount,
        gstAmount: site.gstAmount,
        tdsAmount: (site.ownersDetail || []).reduce(
          (sum, od) => sum + (od.tdsAmount || 0),
          0,
        ),
        gstApplicable: site.gstApplicable,
        rentalDueEntries: filteredDues,
      };
    };

    const buildAmounts = (sites) => {
      const totalBaseRent = sites.reduce(
        (s, site) => s + site.totalRentalAmount,
        0,
      );
      const gstHoldTotal = sites.reduce((s, site) => s + site.gstAmount, 0);
      const tdsHoldTotal = sites.reduce((s, site) => {
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
      };
      // ✅ NEW: Rental Status accumulation
      const rentalStatusMatch = {
        hasApproved: false,
        hasPending: false,
        hasPastPending: false,
        isOverDue: false,
      };

      sites.forEach((site) => {
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
        // ✅ ADDED
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
        if (site.rentalStatus.hasPastPendingSite)
          rentalStatusMatch.hasPastPending = true;
        if (site.rentalStatus.isOverDueSite) rentalStatusMatch.isOverDue = true;

        if (needsLedgerFields) {
          const siteBucket = getLedgerBucketsForSite(String(site.mediaId), [
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
            siteBucket.currentRentPending || 0; // ✅ ADDED
          combinedLedger.pastRentPending += siteBucket.pastRentPending || 0; // ✅ ADDED
        }
      });

      const entryPayload = {
        entryType: "single",
        landOwnerMasterId: ownerId,
        totalSites: sites.length,
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
            (includePastGstPending && combinedLedger.pastGstPending > 0)
          : false;

        const rentalMatch = needsRentalStatusFields
          ? (includeApprovalSite && rentalStatusMatch.hasApproved) ||
            (includePendingSites && rentalStatusMatch.hasPending) ||
            (includePastPending && rentalStatusMatch.hasPastPending) ||
            (includeOverDue && rentalStatusMatch.isOverDue)
          : false;

        if (!ledgerMatch && !rentalMatch) return; // skip this owner — nothing to show for the requested flag(s)
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

        group.sites.forEach((site) => {
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
      };
      // ✅ NEW: Rental Status accumulation
      const rentalStatusMatch = {
        hasApproved: false,
        hasPending: false,
        hasPastPending: false,
        isOverDue: false,
      };

      if (needsLedgerFields || needsRentalStatusFields) {
        group.sites.forEach((site) => {
          if (site.rentalStatus.hasApprovedSite)
            rentalStatusMatch.hasApproved = true;
          if (site.rentalStatus.hasPendingSite)
            rentalStatusMatch.hasPending = true;
          if (site.rentalStatus.hasPastPendingSite)
            rentalStatusMatch.hasPastPending = true;
          if (site.rentalStatus.isOverDueSite)
            rentalStatusMatch.isOverDue = true;

          if (needsLedgerFields) {
            const siteBucket = getLedgerBucketsForSite(
              String(site.mediaId),
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
              siteBucket.currentRentPending || 0; // ✅ ADDED
            combinedLedger.pastRentPending += siteBucket.pastRentPending || 0; // ✅ ADDED
          }
        });
      }

      const entryPayload = {
        entryType: "shared",
        totalLandOwners: landOwners.length,
        totalSites: group.sites.length,
        gstApplicable: anyGstApplicable ? 1 : 0,
        ...amounts,
        landOwners,
        sites: group.sites.map((site) => toSiteResponseShape(site)),
        latestActivityAt, // ✅ ADDED — internal sort key, stripped before response
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
            (includePastGstPending && combinedLedger.pastGstPending > 0)
          : false;

        const rentalMatch = needsRentalStatusFields
          ? (includeApprovalSite && rentalStatusMatch.hasApproved) ||
            (includePendingSites && rentalStatusMatch.hasPending) ||
            (includePastPending && rentalStatusMatch.hasPastPending) ||
            (includeOverDue && rentalStatusMatch.isOverDue)
          : false;

        if (!ledgerMatch && !rentalMatch) return;
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
      ({ latestActivityAt, ...rest }) => rest,
    );

    let overallOutstandingTotals = null;
    if (needsLedgerFields) {
      // computeOutstandingSummary expects { year, month } with month
      // 1-indexed — referenceYear/referenceMonthIdx were already
      // resolved above (from monthFilter, or "now" as the default).
      const outstandingMonthYear = {
        year: referenceYear,
        month: referenceMonthIdx + 1,
      };

      overallOutstandingTotals = relatedMediaDocs.reduce(
        (acc, mediaDoc) => {
          const s = computeOutstandingSummary(mediaDoc, outstandingMonthYear);
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
    }

    const totalCount = entriesForResponse.length;
    const startIdx = (pageNumbers - 1) * pageSize;
    const pagedEntries = entriesForResponse.slice(
      startIdx,
      startIdx + pageSize,
    );

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
        // ✅ ADDED — echo back which month was actually applied
        ...(needsLedgerFields ? { monthFilterApplied } : {}),
        entries: pagedEntries,
        // ✅ ADDED — overall outstanding totals, same shape as the
        // ledger APIs' summary block
        ...(overallOutstandingTotals || {}),
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
  landOwnerSiteFilter,
  syncOrLinkMediaOwnerToMaster, // used by mediaOnboardingController.js — pass 1, before media.save()
  correctLinkedSiteAmounts, // used by mediaOnboardingController.js — pass 2, after media.save()
};
