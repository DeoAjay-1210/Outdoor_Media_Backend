// routes/mediaRoutes.js
const express = require("express");
const multer   = require("multer");
const router = express.Router();
const {mediaOnboarding,mediaList,uploadExcel,updateAgreement,getMediaById} = require("../../../controllers/Admin/MediaOnboardingController/MediaOnboardingController");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");
// Create uploader for media images
const { upload, processFile } = createUploader("mediaImages", {
  agreementPDF: "agreementPDF",
});
// Only TWO routes
router.post(
  "/media-onboarding",protect,
  upload.fields([
    { name: "agreementPDF", maxCount: 1 },
    { name: "frontView", maxCount: 1 },
    { name: "sideView", maxCount: 1 },
    { name: "locationView", maxCount: 1 },
    { name: "additionalImages", maxCount: 10 },
  ]),
  (req, res, next) => {
    req.processFile = processFile; // 👈 pass to controller
    next();
  },
  mediaOnboarding,
);

router.post("/media-list",protect, mediaList);
router.post("/update-agreement",protect, updateAgreement);
router.get("/media-details",protect, getMediaById);
const uploads = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
      "application/vnd.ms-excel",                                           // .xls
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only .xlsx / .xls files are accepted"), false);
    }
  },
});
router.post("/media-excel-upload",protect, uploads.single("file"), uploadExcel);
router.get("/profile", protect, async (req, res) => {
  console.log(req.user.userName);

  res.json({
    success: true,
    userName: req.user.userName
  });
});
module.exports = router;
