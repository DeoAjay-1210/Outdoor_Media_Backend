// routes/landOwnerMasterRoutes.js
const express = require("express");
const router = express.Router();
const {
  landOwnerSave,
  landOwnerList,
} = require("../../../controllers/Admin/landOwnerMasterController/landOwnerMasterController");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");

// Same folder as mediaRoutes.js — "mediaImages" — not a new folder.
const { upload, processFile } = createUploader("mediaImages", {
  panCardImage: "mediaImages",
  bankPassbook: "mediaImages",
  cancelCheckLeaf: "mediaImages",
  aadharCardImage: "mediaImages",
});

// Only TWO routes
router.post(
  "/landowner/save",
  protect,
  upload.any(),
  (req, res, next) => {
    req.processFile = processFile; // 👈 pass to controller
    next();
  },
  landOwnerSave,
);

router.post("/landowner/list", protect, landOwnerList);

module.exports = router;