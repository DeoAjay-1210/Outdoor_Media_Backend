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
//       isDeleted: false,
//     }).session(session || null);
//     if (byPhone) return byPhone;
//   }

//   if (owner.panNumber && owner.panNumber.trim() !== "") {
//     const byPan = await LandOwnerMaster.findOne({
//       panNumber: owner.panNumber.trim().toUpperCase(),
//       isDeleted: false,
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

// // ─────────────────────────────────────────────────────────────
// // PUSH A MEDIA-SIDE OWNER EDIT INTO THE LINKED LandOwnerMaster.
// // Called from mediaOnboardingController.js when a landOwners[i]
// // entry that already has a landOwnerMasterId is saved/updated
// // inside a Media property's form.
// //
// // ── OPTION A (implemented here) ──────────────────────────────
// // Updates ONLY the one linked LandOwnerMaster document. Does NOT
// // cascade back out to other Media properties that share the same
// // owner — so editing the name on Property A does not silently
// // change what Property B/C show until someone opens/saves them
// // too, or you explicitly call syncLandOwnerToMedia() afterward.
// //
// // To switch to OPTION B (full cascade — every property showing
// // this owner updates immediately), call
// // `await syncLandOwnerToMedia(updatedMaster, session);`
// // right after `await landOwnerMaster.save({ session });` below.
// // ─────────────────────────────────────────────────────────────
// const syncMediaOwnerToMaster = async (owner, userName, session) => {
//   if (!owner.landOwnerMasterId) return null; // not linked to a Master — nothing to sync

//   // ✅ same fix as saveSingleLandOwner — strip empty-string/junk file
//   // values before they touch the Mongoose document.
//   sanitizeOwnerFileFields(owner);

//   const landOwnerMaster = await LandOwnerMaster.findOne({
//     _id: owner.landOwnerMasterId,
//     isDeleted: false,
//   }).session(session || null);

//   if (!landOwnerMaster) return null; // linked id points at a deleted/missing Master — skip silently

//   // profile fields
//   if (owner.name !== undefined) landOwnerMaster.name = owner.name;
//   if (owner.phone !== undefined) landOwnerMaster.phone = owner.phone;
//   if (owner.bankName !== undefined) landOwnerMaster.bankName = owner.bankName;
//   if (owner.ifsc !== undefined) landOwnerMaster.ifsc = owner.ifsc;
//   if (owner.accountNumber !== undefined)
//     landOwnerMaster.accountNumber = owner.accountNumber;
//   if (owner.upiId !== undefined) landOwnerMaster.upiId = owner.upiId;
//   if (owner.panNumber !== undefined) landOwnerMaster.panNumber = owner.panNumber;
//   if (owner.panCardImage !== undefined)
//     landOwnerMaster.panCardImage = owner.panCardImage;
//   if (owner.aadharCardNumber !== undefined)
//     landOwnerMaster.aadharCardNumber = owner.aadharCardNumber;
//   if (owner.aadharCardImage !== undefined)
//     landOwnerMaster.aadharCardImage = owner.aadharCardImage;
//   if (owner.paymentCategory !== undefined)
//     landOwnerMaster.paymentCategory = owner.paymentCategory;
//   if (owner.bankPassbook !== undefined)
//     landOwnerMaster.bankPassbook = owner.bankPassbook;
//   if (owner.cancelCheckLeaf !== undefined)
//     landOwnerMaster.cancelCheckLeaf = owner.cancelCheckLeaf;
//   if (owner.onlineMode !== undefined)
//     landOwnerMaster.onlineMode = owner.onlineMode;

//   // ✅ "amount everything is change" — financial inputs also flow
//   // through, then get recomputed via computeFinancialFields() below,
//   // same as landOwnerSave() does. This keeps the Master's "last known
//   // snapshot" amounts in sync with whatever this Media property most
//   // recently computed for this owner.
//   if (owner.sharePercentage !== undefined)
//     landOwnerMaster.sharePercentage = owner.sharePercentage;
//   if (owner.shareAmount !== undefined)
//     landOwnerMaster.shareAmount = owner.shareAmount;
//   if (owner.onlineAmount !== undefined)
//     landOwnerMaster.onlineAmount = owner.onlineAmount;
//   if (owner.cashAmount !== undefined)
//     landOwnerMaster.cashAmount = owner.cashAmount;
//   if (owner.gstApplicable !== undefined)
//     landOwnerMaster.gstApplicable = owner.gstApplicable;
//   if (owner.gstNumber !== undefined) landOwnerMaster.gstNumber = owner.gstNumber;
//   if (owner.gstPercentage !== undefined)
//     landOwnerMaster.gstPercentage = owner.gstPercentage;
//   if (owner.tdsApplicable !== undefined)
//     landOwnerMaster.tdsApplicable = owner.tdsApplicable;
//   if (owner.tdsPercentage !== undefined)
//     landOwnerMaster.tdsPercentage = owner.tdsPercentage;

//   // ✅ same GST/TDS/netPayable calculation as landOwnerSave() —
//   // paymentCategory-driven base amount, .env-priority percentages.
//   computeFinancialFields(landOwnerMaster);

//   landOwnerMaster.updatedBy = userName;
//   landOwnerMaster.updatedAt = nowIST();

//   await landOwnerMaster.save({ session });

//   // ── OPTION B would go here if you want it (see comment above) ──
//   // await syncLandOwnerToMedia(landOwnerMaster, session);

//   return landOwnerMaster;
// };

// // ─────────────────────────────────────────────────────────────
// // COMPUTE GST + TDS + NET PAYABLE — mirrors the owner-level block
// // inside MediaSchema.pre("save") EXACTLY, so LandOwnerMaster and
// // the embedded Media owner always compute the same way:
// //
// //   paymentCategory 1 (Cash)         → TDS base = 0, GST base = 0
// //   paymentCategory 2 (Online)       → TDS base = shareAmount, GST base = shareAmount
// //   paymentCategory 3 (Cash+Online)  → TDS base = onlineAmount, GST base = onlineAmount
// //
// // tdsPercentage: process.env.TDS_PERCENTAGE if >0, else whatever
// // tdsPercentage the client sent (same fallback as MediaSchema).
// //
// // gstPercentage: owner's own gstPercentage if the client sent a
// // non-zero value, else falls back to process.env.GST_PERCENTAGE
// // (same `owner.gstPercentage || envGstPct` fallback as MediaSchema —
// // NOTE this is a fallback, not a forced override, matching the
// // pasted MediaSchema code exactly).
// //
// // netPayableToOwner / netPayable = totalAmountWithGst
// // (shareAmount + gstAmount) — TDS is tracked but not subtracted,
// // same convention MediaSchema already uses.
// // ─────────────────────────────────────────────────────────────
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

//   // ── NET PAYABLE — the fix ───────────────────────────────
//   // owner.totalAmountWithGst / netPayableToOwner / netPayable are
//   // ALWAYS derived here now — they no longer silently stay 0 just
//   // because the client didn't send them.
//   landOwner.totalAmountWithGst = shareAmount + gstAmount;
//   landOwner.netPayableToOwner = landOwner.totalAmountWithGst;
//   landOwner.netPayable = landOwner.totalAmountWithGst;
// };

// // ─────────────────────────────────────────────────────────────
// // ATTACH UPLOADED FILES FOR A SINGLE OWNER FROM req.files.
// // Supports three fieldname shapes:
// //   1) Single owner, flat:      "panCardImage"
// //   2) Multi owner, bracket:    "landOwners[0][panCardImage]"
// //   3) Multi owner, dot:        "landOwners[0].panCardImage"
// // ─────────────────────────────────────────────────────────────
// const OWNER_FILE_FIELDS = [
//   "panCardImage",
//   "bankPassbook",
//   "cancelCheckLeaf",
//   "aadharCardImage",
// ];

// const attachFilesToOwner = (owner, files, processFile, index) => {
//   OWNER_FILE_FIELDS.forEach((field) => {
//     let matchedFile = null;

//     if (index === null) {
//       // single-owner payload — plain field name
//       matchedFile = files.find((f) => f.fieldname === field);
//     } else {
//       // multi-owner payload — bracket OR dot indexed field name
//       matchedFile = files.find(
//         (f) =>
//           f.fieldname === `landOwners[${index}][${field}]` ||
//           f.fieldname === `landOwners[${index}].${field}`,
//       );
//     }

//     if (matchedFile) {
//       owner[field] = processFile(matchedFile);
//     }
//   });
// };

// // ─────────────────────────────────────────────────────────────
// // SANITIZE OWNER FILE FIELDS.
// //
// // Root cause of "fileType: `` is not a valid enum value": when no
// // file is actually uploaded for panCardImage/bankPassbook/
// // cancelCheckLeaf/aadharCardImage, form-data clients (Postman,
// // browsers, some frontend libs) still send the KEY with an empty
// // string value — e.g. "landOwners[0][panCardImage]": "". That empty
// // string then gets copied straight onto the Mongoose subdocument
// // path, which tries to validate it against fileObjectSchema and
// // fails on fileType's enum (since "" !== "image").
// //
// // This strips out any of the 4 file fields that aren't a genuine
// // file object (must have fileName or filePath) BEFORE the owner
// // payload is ever assigned onto a LandOwnerMaster document — for
// // both CREATE (`new LandOwnerMaster(owner)`) and UPDATE (the
// // `if (owner.field !== undefined) landOwner.field = owner.field`
// // copy in saveSingleLandOwner). If the field is missing/empty, it's
// // simply deleted from the payload so Mongoose leaves whatever was
// // already stored (on update) or the schema default (on create)
// // untouched, instead of erroring.
// // ─────────────────────────────────────────────────────────────
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

// // ─────────────────────────────────────────────────────────────
// // SINGLE SOURCE OF TRUTH — every LandOwnerMaster field the client
// // is allowed to update via the UPDATE branch of saveSingleLandOwner.
// // This must mirror LandOwnerMasterSchema.js. Deliberately mirrors
// // EVERY schema field (profile + financial inputs + files) so
// // nothing is silently un-updatable the way `typeShare` previously
// // was (it exists in the schema, worked on CREATE via
// // `new LandOwnerMaster(owner)`, but was missing from the old
// // hand-picked UPDATE copy list).
// //
// // Intentionally EXCLUDED (always computed by computeFinancialFields,
// // never trusted from the client, even on update):
// //   gstAmount, totalAmountWithGst, tdsAmount, netPayableToOwner,
// //   netPayable
// // ─────────────────────────────────────────────────────────────
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
//   "onlineMode",
//   // files
//   "panCardImage",
//   "bankPassbook",
//   "cancelCheckLeaf",
//   "aadharCardImage",
//   // financial inputs
//   "typeShare", // ← this was the missing field
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
// // NORMALIZE "landOwners[0].name" DOT-NOTATION BODY KEYS INTO
// // A REAL req.body.landOwners ARRAY.
// //
// // multipart/form-data (and plain urlencoded) requests send flat
// // string keys — Postman's form-data with keys like
// // "landOwners[0].name", "landOwners[0].shareAmount",
// // "landOwners[1].name" arrive in req.body exactly as those
// // literal string keys, NOT as a nested array/object. This walks
// // every key on req.body, and for anything matching
// // landOwners[<index>].<field>, builds body.landOwners[<index>][<field>].
// //
// // Also works for a SINGLE owner sent the same way — e.g. only
// // "landOwners[0].name", "landOwners[0].phone", etc. — since a
// // single entry is just an array of length 1.
// //
// // Existing plain top-level fields (name, phone, id, ...) and an
// // already-proper body.landOwners array (e.g. from raw JSON) are
// // left untouched — this only fires when dot-notation keys exist.
// // ─────────────────────────────────────────────────────────────
// const normalizeLandOwnersBody = (body) => {
//   const dotKeyPattern = /^landOwners\[(\d+)\]\.(.+)$/;
//   const bracketKeyPattern = /^landOwners\[(\d+)\]\[(.+)\]$/;

//   const foundKeys = Object.keys(body).filter(
//     (key) => dotKeyPattern.test(key) || bracketKeyPattern.test(key),
//   );

//   if (foundKeys.length === 0) return body; // nothing to normalize

//   const landOwners = [];

//   foundKeys.forEach((key) => {
//     const dotMatch = key.match(dotKeyPattern);
//     const bracketMatch = key.match(bracketKeyPattern);
//     const match = dotMatch || bracketMatch;

//     const index = Number(match[1]);
//     const field = match[2];
//     const value = body[key];

//     if (!landOwners[index]) landOwners[index] = {};
//     landOwners[index][field] = value;

//     delete body[key]; // remove the flat key now that it's folded in
//   });

//   body.landOwners = landOwners.filter(Boolean); // drop any sparse holes
//   return body;
// };

// // ─────────────────────────────────────────────────────────────
// // SAVE OR UPDATE A SINGLE OWNER PAYLOAD.
// // Returns the saved LandOwnerMaster document.
// // ─────────────────────────────────────────────────────────────
// const saveSingleLandOwner = async (owner, userName, session) => {
//   // ✅ safety net — strips empty-string/junk values from the 4 file
//   // fields BEFORE anything is assigned onto a Mongoose document,
//   // regardless of which entry point (single/multi/dot/bracket) this
//   // owner payload came through. Fixes "fileType: `` is not a valid
//   // enum value" when a file field is sent but no actual file was
//   // uploaded for it.
//   sanitizeOwnerFileFields(owner);

//   let landOwner;

//   if (owner.id) {
//     // ── UPDATE ──────────────────────────────────────────────
//     landOwner = await LandOwnerMaster.findOne({
//       _id: owner.id,
//       isDeleted: false,
//     }).session(session);

//     if (!landOwner) {
//       const err = new Error(`LandOwner not found with id ${owner.id}`);
//       err.statusCode = 404;
//       throw err;
//     }

//     // ✅ ALL updatable owner fields, copied generically from a single
//     // list — replaces the old hand-picked if-statements, which had
//     // silently OMITTED `typeShare` (present in the schema, worked
//     // fine on CREATE via `new LandOwnerMaster(owner)`, but was never
//     // copied here on UPDATE). Using one shared list means every field
//     // in the schema is guaranteed to be updatable, and adding a new
//     // schema field later only requires adding it here once.
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
//     // netPayableToOwner/netPayable are ALL derived here — this is
//     // the fix for netPayable showing 0.
//     computeFinancialFields(landOwner);

//     // ✅ IST audit stamp — same nowIST() pattern as
//     // mediaOnboardingController.js. Set on EVERY update, regardless
//     // of which fields changed.
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

// // ═════════════════════════════════════════════════════════════
// // API 1 — SAVE / UPDATE (single owner OR multiple owners)
// // POST /api/landowner
// //
// // Single owner  → send owner fields directly in req.body
// //                 (id present = update, absent = create)
// //
// // Multiple owners → send req.body.landOwners = [ {...}, {...} ]
// //                 each entry independently create/update the
// //                 same way based on whether it has an `id`.
// // ═════════════════════════════════════════════════════════════
// const landOwnerSave = async (req, res) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     const body = normalizeLandOwnersBody(req.body);
//     const files = req.files || [];
//     const processFile =
//       typeof req.processFile === "function" ? req.processFile : null;

//     // same pattern as mediaOnboardingController.js
//     const userName = req.user?.userName || "Admin";

//     // ✅ After normalization, "landOwners[0].name" style keys become
//     // a real body.landOwners array. If it ends up with exactly ONE
//     // entry, treat it as a single-owner save (matches how the
//     // frontend is sending it — landOwners[0].xxx — but the response
//     // shape stays consistent with a plain single-owner call).
//     const isMultiple =
//       Array.isArray(body.landOwners) && body.landOwners.length > 1;

//     const isSingleViaArray =
//       Array.isArray(body.landOwners) && body.landOwners.length === 1;

//     if (isSingleViaArray) {
//       const owner = body.landOwners[0];
//       const isNew = !owner.id;

//       if (processFile) {
//         attachFilesToOwner(owner, files, processFile, 0);
//       }

//       const savedOwner = await saveSingleLandOwner(owner, userName, session);

//       await session.commitTransaction();

//       const message = isNew
//         ? "LandOwner created successfully"
//         : "LandOwner updated successfully";

//       return successResponse(res, message, savedOwner, isNew ? 201 : 200);
//     }

//     if (isMultiple) {
//       // ── MULTIPLE OWNERS ─────────────────────────────────────
//       const owners = body.landOwners;
//       const savedOwners = [];

//       for (let index = 0; index < owners.length; index++) {
//         const owner = owners[index];

//         if (processFile) {
//           attachFilesToOwner(owner, files, processFile, index);
//         }

//         const saved = await saveSingleLandOwner(owner, userName, session);
//         savedOwners.push(saved);
//       }

//       await session.commitTransaction();

//       return successResponse(
//         res,
//         "LandOwners saved successfully",
//         savedOwners,
//         200,
//       );
//     } else {
//       // ── SINGLE OWNER ─────────────────────────────────────────
//       const owner = body;
//       const isNew = !owner.id;

//       if (processFile) {
//         attachFilesToOwner(owner, files, processFile, null);
//       }

//       const savedOwner = await saveSingleLandOwner(owner, userName, session);

//       await session.commitTransaction();

//       const message = isNew
//         ? "LandOwner created successfully"
//         : "LandOwner updated successfully";

//       return successResponse(res, message, savedOwner, isNew ? 201 : 200);
//     }
//   } catch (error) {
//     await session.abortTransaction();
//     return errorResponse(res, error.message, null, error.statusCode || 400);
//   } finally {
//     session.endSession();
//   }
// };

// // ═════════════════════════════════════════════════════════════
// // API 2 — LIST
// // POST /api/landowner/list
// // ═════════════════════════════════════════════════════════════
// const landOwnerList = async (req, res) => {
//   try {
//     const { pageNumber = 1, count = 10, search } = req.body;

//     const pageNumbers = parseInt(pageNumber) || 1;
//     const pageSize = parseInt(count) || 10;

//     const filter = { isDeleted: false };

//     if (search && search.trim() !== "") {
//       const searchRegex = new RegExp(search.trim(), "i");
//       filter.$or = [
//         { name: searchRegex },
//         { phone: searchRegex },
//         { panNumber: searchRegex },
//         { aadharCardNumber: searchRegex },
//       ];
//     }

//     const totalCount = await LandOwnerMaster.countDocuments(filter);

//     const landOwnerListData = await LandOwnerMaster.find(filter)
//       .sort({ updatedAt: -1 })
//       .skip((pageNumbers - 1) * pageSize)
//       .limit(pageSize)
//       .lean();

//     return successResponse(
//       res,
//       "LandOwner list fetched successfully",
//       {
//         pageNumber: pageNumbers,
//         count: pageSize,
//         totalCount,
//         totalPages: Math.ceil(totalCount / pageSize),
//         landOwnerList: landOwnerListData,
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
//   syncMediaOwnerToMaster, // used by mediaOnboardingController.js
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

// ─────────────────────────────────────────────────────────────
// PUSH A MEDIA-SIDE OWNER EDIT INTO THE LINKED LandOwnerMaster.
// Called from mediaOnboardingController.js when a landOwners[i]
// entry that already has a landOwnerMasterId is saved/updated
// inside a Media property's form.
//
// ── OPTION A (implemented here) ──────────────────────────────
// Updates ONLY the one linked LandOwnerMaster document. Does NOT
// cascade back out to other Media properties that share the same
// owner — so editing the name on Property A does not silently
// change what Property B/C show until someone opens/saves them
// too, or you explicitly call syncLandOwnerToMedia() afterward.
//
// To switch to OPTION B (full cascade — every property showing
// this owner updates immediately), call
// `await syncLandOwnerToMedia(updatedMaster, session);`
// right after `await landOwnerMaster.save({ session });` below.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// UPSERT ONE ENTRY IN landOwnerMaster.linkedSites — one entry per
// Media property this owner belongs to, keyed by mediaId. Called
// every time a Media-side owner (linked or newly-linked) is saved,
// so linkedSites always reflects the CURRENT paymentCategory/amounts
// for that specific site, independent of every other site the same
// owner is attached to (Site A = Cash, Site B = Online, etc).
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// PUSH A MEDIA-SIDE OWNER EDIT INTO THE LINKED LandOwnerMaster —
// AND, for first-time onboarding, FIND-OR-CREATE the Master too.
//
// Called from mediaOnboardingController.js for EVERY owner in
// mediaData.landOwners (not just already-linked ones):
//
//   owner.landOwnerMasterId present  → load that exact Master, update it
//   owner.landOwnerMasterId absent   → try findMasterByPriority()
//                                       (phone → pan → aadhaar) to
//                                       reuse an existing owner already
//                                       onboarded on another site;
//                                       if none found, CREATE a brand
//                                       new Master from this owner's
//                                       profile fields.
//
// Either way, `owner.landOwnerMasterId` is written back onto the
// Media-side owner object before this returns, so the caller can
// persist it onto mediaData.landOwners[i]/mediaData.landOwnerMasterIds
// before media.save().
//
// Also upserts a linkedSites entry (mediaId/mediaCode/mediaName/
// paymentCategory/amounts) so the SAME landowner can show up across
// MULTIPLE Media properties, each with its own Cash/Online/
// Cash+Online setup.
//
// ── OPTION A (implemented) ──────────────────────────────────
// Only the ONE linked Master document is updated. Does NOT cascade
// this owner's profile edit out to the OTHER Media properties that
// share the same owner — see syncLandOwnerToMedia() to opt into that.
// ─────────────────────────────────────────────────────────────
const syncOrLinkMediaOwnerToMaster = async (owner, userName, session, mediaInfo) => {
  // ✅ same fix as saveSingleLandOwner — strip empty-string/junk file
  // values before they touch the Mongoose document.
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

// ─────────────────────────────────────────────────────────────
// CORRECT linkedSites AMOUNTS AFTER media.save().
//
// ROOT CAUSE this fixes: syncOrLinkMediaOwnerToMaster() above runs
// BEFORE media.save() (it has to, so landOwnerMasterId can be
// written onto the Media document before it's persisted). But for
// percentage-based owners (typeShare === 1), the REAL shareAmount
// is only computed inside MediaSchema's own pre("save") hook —
// which only runs DURING media.save(), i.e. AFTER
// syncOrLinkMediaOwnerToMaster already ran. So the first pass often
// captures shareAmount as 0 (whatever the raw, not-yet-computed
// request had).
//
// This is a lightweight SECOND pass: call it after
// `await media.save()` (and re-fetching `media`), once per owner,
// using the now-final `savedOwner` object straight from the saved
// document. It only corrects amounts — profile fields were already
// synced correctly in pass 1, so they're not touched again here.
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// COMPUTE GST + TDS + NET PAYABLE — mirrors the owner-level block
// inside MediaSchema.pre("save") EXACTLY, so LandOwnerMaster and
// the embedded Media owner always compute the same way:
//
//   paymentCategory 1 (Cash)         → TDS base = 0, GST base = 0
//   paymentCategory 2 (Online)       → TDS base = shareAmount, GST base = shareAmount
//   paymentCategory 3 (Cash+Online)  → TDS base = onlineAmount, GST base = onlineAmount
//
// tdsPercentage: process.env.TDS_PERCENTAGE if >0, else whatever
// tdsPercentage the client sent (same fallback as MediaSchema).
//
// gstPercentage: owner's own gstPercentage if the client sent a
// non-zero value, else falls back to process.env.GST_PERCENTAGE
// (same `owner.gstPercentage || envGstPct` fallback as MediaSchema —
// NOTE this is a fallback, not a forced override, matching the
// pasted MediaSchema code exactly).
//
// netPayableToOwner / netPayable = totalAmountWithGst
// (shareAmount + gstAmount) — TDS is tracked but not subtracted,
// same convention MediaSchema already uses.
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// SANITIZE OWNER FILE FIELDS.
//
// Root cause of "fileType: `` is not a valid enum value": when no
// file is actually uploaded for panCardImage/bankPassbook/
// cancelCheckLeaf/aadharCardImage, form-data clients (Postman,
// browsers, some frontend libs) still send the KEY with an empty
// string value — e.g. "landOwners[0][panCardImage]": "". That empty
// string then gets copied straight onto the Mongoose subdocument
// path, which tries to validate it against fileObjectSchema and
// fails on fileType's enum (since "" !== "image").
//
// This strips out any of the 4 file fields that aren't a genuine
// file object (must have fileName or filePath) BEFORE the owner
// payload is ever assigned onto a LandOwnerMaster document — for
// both CREATE (`new LandOwnerMaster(owner)`) and UPDATE (the
// `if (owner.field !== undefined) landOwner.field = owner.field`
// copy in saveSingleLandOwner). If the field is missing/empty, it's
// simply deleted from the payload so Mongoose leaves whatever was
// already stored (on update) or the schema default (on create)
// untouched, instead of erroring.
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH — every LandOwnerMaster field the client
// is allowed to update via the UPDATE branch of saveSingleLandOwner.
// This must mirror LandOwnerMasterSchema.js. Deliberately mirrors
// EVERY schema field (profile + financial inputs + files) so
// nothing is silently un-updatable the way `typeShare` previously
// was (it exists in the schema, worked on CREATE via
// `new LandOwnerMaster(owner)`, but was missing from the old
// hand-picked UPDATE copy list).
//
// Intentionally EXCLUDED (always computed by computeFinancialFields,
// never trusted from the client, even on update):
//   gstAmount, totalAmountWithGst, tdsAmount, netPayableToOwner,
//   netPayable
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// NORMALIZE "landOwners[0].name" DOT-NOTATION BODY KEYS INTO
// A REAL req.body.landOwners ARRAY.
//
// multipart/form-data (and plain urlencoded) requests send flat
// string keys — Postman's form-data with keys like
// "landOwners[0].name", "landOwners[0].shareAmount",
// "landOwners[1].name" arrive in req.body exactly as those
// literal string keys, NOT as a nested array/object. This walks
// every key on req.body, and for anything matching
// landOwners[<index>].<field>, builds body.landOwners[<index>][<field>].
//
// Also works for a SINGLE owner sent the same way — e.g. only
// "landOwners[0].name", "landOwners[0].phone", etc. — since a
// single entry is just an array of length 1.
//
// Existing plain top-level fields (name, phone, id, ...) and an
// already-proper body.landOwners array (e.g. from raw JSON) are
// left untouched — this only fires when dot-notation keys exist.
// ─────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════
// API 1 — SAVE / UPDATE (single owner OR multiple owners)
// POST /api/landowner
//
// Single owner  → send owner fields directly in req.body
//                 (id present = update, absent = create)
//
// Multiple owners → send req.body.landOwners = [ {...}, {...} ]
//                 each entry independently create/update the
//                 same way based on whether it has an `id`.
// ═════════════════════════════════════════════════════════════
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

// ═════════════════════════════════════════════════════════════
// API 2 — LIST
// POST /api/landowner/list
// ═════════════════════════════════════════════════════════════
const landOwnerList = async (req, res) => {
  try {
    const { pageNumber = 1, count = 10, search } = req.body;

    const pageNumbers = parseInt(pageNumber) || 1;
    const pageSize = parseInt(count) || 10;

    const filter = { isDeleted: false };

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

    // ✅ NEW — totalSites + linkedSites (mediaName/mediaCode/
    // paymentCategory per site) already live on the document via
    // schema's linkedSites array; just surface a convenience count
    // alongside it so the frontend doesn't have to compute
    // linkedSites.length itself.
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