const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  forgotPinVerify,
  resetPin,
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

module.exports = router;
