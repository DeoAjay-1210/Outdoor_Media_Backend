const express = require("express");
const router = express.Router();
const {
  registerSendOtp,
  verifyRegisterOtp,
  resendRegisterOtp,
  loginSendOtp,
  loginVerifyOtp,
  resendLoginOtp,
  //   listUsers,
  //   getUserById,
  //   updateUser,
  //   deleteUser,
} = require("../../../controllers/Admin/UserController/UserController");

// ============================================================
// AUTH ROUTES
// ============================================================

// Register
router.post("/register", registerSendOtp); // Step 1: Send OTP
router.post("/register-verify-otp", verifyRegisterOtp); // Step 2: Verify OTP & create user
router.post("/register-resend-otp", resendRegisterOtp); // Resend OTP if not received

// Login
router.post("/login", loginSendOtp); // Step 1: Send OTP
router.post("/login-verify-otp", loginVerifyOtp); // Step 2: Verify OTP & get token
router.post("/login-resend-otp", resendLoginOtp); // Resend login OTP

// ============================================================
// USER MANAGEMENT ROUTES (protect with auth middleware as needed)
// ============================================================

// router.get("/", listUsers); // GET /users?userType=1 (optional filter)
// router.get("/:id", getUserById); // GET /users/:id
// router.put("/:id", updateUser); // PUT /users/:id
// router.delete("/:id", deleteUser); // DELETE /users/:id

module.exports = router;
