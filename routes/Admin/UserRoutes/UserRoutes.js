const express = require("express");
const router = express.Router();
const protect = require("../../../middleware/authMiddleware");
const {
  registerUser,
  loginUser,
  forgotPinVerify,
  resetPin,
  forgotPin,
  changePin,
} = require("../../../controllers/Admin/UserController/UserController");

// ============================================================
// AUTH ROUTES (Direct Registration & PIN-Based Login)
// ============================================================

// Register
router.post("/register", registerUser);
router.post("/register-verify-otp", registerUser); // Route alias for backward compatibility

// Login
router.post("/login", loginUser);
router.post("/login-verify-otp", loginUser); // Route alias for backward compatibility

// Forgot / Reset PIN
router.post("/forgot-pin-verify", forgotPinVerify); // Step 1: Verify phone, role & password
router.post("/reset-pin", resetPin);                 // Step 2: Update 4-digit PIN in DB

// New Forgot PIN (Generates 4-digit PIN & sends email via PHP Mail Service)
router.post("/forgot-pin", forgotPin);

// Change PIN (Requires JWT Token)
router.post("/change-pin", changePin);

module.exports = router;
