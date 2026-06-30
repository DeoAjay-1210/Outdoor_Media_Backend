// routes/rentalDue.routes.js
const express = require("express");
const router = express.Router();

// Controllers
const ctrl = require("../../../controllers/Admin/MediaOnboardingController/RentalDueController");
const {
  getRentalDueListWithStats,
  verifyAgreementDoc,
} = require("../../../controllers/Admin/MediaOnboardingController/RentalDueController");
// Middleware
// const  authenticate  = require("../../../middleware/authMiddleware");
const { createUploader } = require("../../../middleware/dynamicFileUpload");
const protect = require("../../../middleware/authMiddleware");
// Create uploader for rental due campaign proofs
const { upload, processFile } = createUploader("rentalDueProofs", {
  proofOfCampaign: "proofOfCampaign",
});

// All routes require authentication (role resolved inside middleware)
// router.use(authenticate);

// ─────────────────────────────────────────────────────────────
// STATS
// GET /rental-due/stats
// Returns: totalSites, dueThisMonth, overDue, pendingApproval breakdown
// Accessible by: all roles (1, 2, 3)
// ─────────────────────────────────────────────────────────────
router.post("/rental-due-list", protect, getRentalDueListWithStats);

// ─────────────────────────────────────────────────────────────
// LIST
// GET /rental-due/list
// Query params:
//   city        (string)
//   mediaType   (string)
//   frequency   (1-6)
//   dueMonth    (YYYY-MM)
//   status      (1=pending | 2=partiallyApproved | 3=approved | 4=overdue)
//   page        (default 1)
//   limit       (default 10)
// Accessible by: all roles
// ─────────────────────────────────────────────────────────────
// router.post("/list",protect, getRentalDueList);

// ─────────────────────────────────────────────────────────────
// SAVE RENTAL DUE ENTRY
// POST /rental-due/:mediaId/save
// Body (multipart/form-data):
//   campaignName        (string, required)
//   dueDate             (ISO string, required)
//   approvalFlow        (1 | 2 | 3, default 1)  — only Owner can set 2 or 3
//   verifyAgreementDoc  (0 | 1)
//   proofOfCampaign     (file, image)
// Accessible by: all roles (1=Staff, 2=TeamLead, 3=Owner)
// ─────────────────────────────────────────────────────────────
router.post(
  "/rental-due-save",protect,
  upload.single("proofOfCampaign"),
  (req, res, next) => {
    req.processFile = processFile;
    next();
  },
  ctrl.saveRentalDue,
);

// ─────────────────────────────────────────────────────────────
// GET SINGLE RENTAL DUE ENTRY
// GET /rental-due/:mediaId/:dueId
// Accessible by: all roles
// ─────────────────────────────────────────────────────────────
router.get("/:mediaId/:dueId", ctrl.getRentalDueById);

// ─────────────────────────────────────────────────────────────
// APPROVE RENTAL DUE
// PATCH /rental-due/:mediaId/:dueId/approve
// Body: { remarks? }
// Rules:
//   - Staff (1)    → can only approve when currentPendingRole === 1
//   - TeamLead (2) → can only approve when currentPendingRole === 2
//   - Owner (3)    → can approve at ANY step (skips pending lower steps)
// Accessible by: all roles (with role-based restrictions)
// ─────────────────────────────────────────────────────────────
router.patch("/:mediaId/:dueId/approve", ctrl.approveRentalDue);

// ─────────────────────────────────────────────────────────────
// VERIFY AGREEMENT DOCUMENT
// PATCH /rental-due/:mediaId/:dueId/verify-agreement
// Can be done before or after saving, by any role.
// Accessible by: all roles
// ─────────────────────────────────────────────────────────────
router.post("/verify-agreement", protect, verifyAgreementDoc);

// ─────────────────────────────────────────────────────────────
// APPROVAL GAP REPORT
// GET /rental-due/:mediaId/:dueId/approval-gap
// Tells you exactly who approved and who is still pending.
// Useful for identifying: "Staff approved, Team Lead hasn't" etc.
// Accessible by: all roles
// ─────────────────────────────────────────────────────────────
router.get("/:mediaId/:dueId/approval-gap", ctrl.getApprovalGap);

// ─────────────────────────────────────────────────────────────
// RENTAL DUE HISTORY (Year → Month buckets)
// GET /rental-due/:mediaId/history
// Query: year (e.g. 2026), month (e.g. "June")
// Accessible by: all roles
// ─────────────────────────────────────────────────────────────
router.get("/:mediaId/history", ctrl.getRentalDueHistory);

module.exports = router;
