const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const User = require("../../../models/Admin/UserSchema/UserSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const generateToken = require("../../../utils/generateToken");
const { nowIST } = require("../../../utils/updatedAt");

// ============================================================
// ENV VARIABLES FOR REGISTER PASSWORDS & FALLBACK LOGIN PINS
// ============================================================
const STAFF_REGISTER_PASSWORD = process.env.STAFF_REGISTER_PASSWORD;
const TEAMHEAD_REGISTER_PASSWORD = process.env.TEAMHEAD_REGISTER_PASSWORD;
const CMD_REGISTER_PASSWORD = process.env.CMD_REGISTER_PASSWORD || process.env.OWNER_REGISTER_PASSWORD;

const STAFF_LOGIN_PIN = process.env.STAFF_LOGIN_PIN || "1234";
const TEAMHEAD_LOGIN_PIN = process.env.TEAMHEAD_LOGIN_PIN || "1234";
const CMD_LOGIN_PIN = process.env.CMD_LOGIN_PIN || process.env.OWNER_LOGIN_PIN || "1234";

// ============================================================
// USER TYPE LABELS
// 1 = Rental Executive | 2 = Rental Manager | 3 = CMD
// ============================================================
const USER_TYPE_LABELS = {
  1: "Rental Executive",
  2: "Rental Manager",
  3: "CMD",
};

// ============================================================
// REGISTER USER (DIRECT - NO OTP/SMS)
// ============================================================
const registerUser = async (req, res) => {
  const { userName, userEmail, userPhone, userType, registerPassword } = req.body;
  const userPin = req.body.pin || req.body.loginPin || req.body.userPin;

  try {
    if (!userName) return errorResponse(res, "User name is required", null, 400);
    if (!userPhone) return errorResponse(res, "Mobile number is required", null, 400);
    if (!userType || ![1, 2, 3].includes(Number(userType))) {
      return errorResponse(res, "Valid userType is required: 1 (Rental Executive), 2 (Rental Manager), 3 (CMD)", null, 400);
    }

    const typeNum = Number(userType);

    // Validate 4-digit PIN
    if (!userPin) {
      return errorResponse(res, "4-digit PIN is required", null, 400);
    }
    const pinStr = String(userPin).trim();
    if (!/^\d{4}$/.test(pinStr)) {
      return errorResponse(res, "PIN must be a 4-digit number", null, 400);
    }

    // Role-based register password check
    if (typeNum === 1 && STAFF_REGISTER_PASSWORD) {
      if (!registerPassword) {
        return errorResponse(res, "Rental Executive registration password is required", null, 400);
      }
      if (registerPassword !== STAFF_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid Rental Executive registration password", null, 400);
      }
    }

    if (typeNum === 2 && TEAMHEAD_REGISTER_PASSWORD) {
      if (!registerPassword) {
        return errorResponse(res, "Rental Manager registration password is required", null, 400);
      }
      if (registerPassword !== TEAMHEAD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid Rental Manager registration password", null, 400);
      }
    }

    if (typeNum === 3 && CMD_REGISTER_PASSWORD) {
      if (!registerPassword) {
        return errorResponse(res, "CMD registration password is required", null, 400);
      }
      if (registerPassword !== CMD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid CMD registration password", null, 400);
      }
    }

    const normalizedPhone = String(userPhone).trim();
    const existingUser = await User.findOne({ userPhone: normalizedPhone });
    if (existingUser) {
      return errorResponse(res, "This mobile number is already registered. Please log in.", null, 400);
    }

    // Encrypt PIN before storing in DB
    const hashedPin = await bcrypt.hash(pinStr, 10);

    const newUser = new User({
      userName,
      userEmail,
      userPhone: normalizedPhone,
      userType: typeNum,
      pin: hashedPin,
      registerPassword,
      createdAt: nowIST(),
      updatedAt: nowIST(),
    });

    await newUser.save();

    const token = generateToken(newUser);

    return successResponse(res, "User registered successfully", {
      token,
      user: {
        _id: newUser._id,
        userName: newUser.userName,
        userEmail: newUser.userEmail,
        userPhone: newUser.userPhone,
        userType: newUser.userType,
        userTypeLabel: USER_TYPE_LABELS[newUser.userType],
      },
    }, 200);
  } catch (err) {
    console.error("Register Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

// ============================================================
// LOGIN USER (DIRECT PIN-BASED - NO OTP/SMS)
// ============================================================
const loginUser = async (req, res) => {
  const { userPhone, userType } = req.body;
  const pin = req.body.pin || req.body.loginPin || req.body.userPin || req.body.password;

  try {
    if (!userPhone) return errorResponse(res, "Phone number is required", null, 400);
    if (!userType || ![1, 2, 3].includes(Number(userType))) {
      return errorResponse(res, "Valid userType is required: 1 (Rental Executive), 2 (Rental Manager), 3 (CMD)", null, 400);
    }
    if (!pin) {
      return errorResponse(res, "4-digit PIN is required", null, 400);
    }

    const normalizedPhone = String(userPhone).trim();
    const typeNum = Number(userType);

    const user = await User.findOne({ userPhone: normalizedPhone, userType: typeNum }).select("+pin");
    if (!user) return errorResponse(res, "User not found", null, 404);

    const inputPin = String(pin).trim();

    let isPinValid = false;
    if (user.pin) {
      if (user.pin.startsWith("$2a$") || user.pin.startsWith("$2b$") || user.pin.startsWith("$2y$")) {
        isPinValid = await bcrypt.compare(inputPin, user.pin);
      } else {
        // Plaintext fallback for legacy records
        isPinValid = (user.pin === inputPin);
      }
    } else {
      // Fallback for legacy users
      if (typeNum === 1) isPinValid = (inputPin === String(STAFF_LOGIN_PIN).trim());
      else if (typeNum === 2) isPinValid = (inputPin === String(TEAMHEAD_LOGIN_PIN).trim());
      else if (typeNum === 3) isPinValid = (inputPin === String(CMD_LOGIN_PIN).trim());
    }

    if (!isPinValid) {
      return errorResponse(res, "Invalid 4-digit PIN", null, 400);
    }

    user.lastLogin = nowIST();
    user.updatedAt = nowIST();
    await user.save();

    const token = generateToken(user);

    return successResponse(res, "Login successful", {
      token,
      user: {
        _id: user._id,
        userName: user.userName,
        userEmail: user.userEmail,
        userPhone: user.userPhone,
        userType: user.userType,
        userTypeLabel: USER_TYPE_LABELS[user.userType],
      },
    });
  } catch (err) {
    console.error("Login Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

// ============================================================
// FORGOT PIN STEP 1: VERIFY USER DETAILS & REGISTER PASSWORD
// ============================================================
const forgotPinVerify = async (req, res) => {
  const { userPhone, userType, registerPassword } = req.body;

  try {
    if (!userPhone) return errorResponse(res, "Mobile number is required", null, 400);
    if (!userType || ![1, 2, 3].includes(Number(userType))) {
      return errorResponse(res, "Valid userType is required: 1 (Rental Executive), 2 (Rental Manager), 3 (CMD)", null, 400);
    }
    if (!registerPassword) {
      return errorResponse(res, "Registration password is required", null, 400);
    }

    const typeNum = Number(userType);

    // Role-based password check
    if (typeNum === 1 && STAFF_REGISTER_PASSWORD) {
      if (registerPassword !== STAFF_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid Rental Executive registration password", null, 400);
      }
    } else if (typeNum === 2 && TEAMHEAD_REGISTER_PASSWORD) {
      if (registerPassword !== TEAMHEAD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid Rental Manager registration password", null, 400);
      }
    } else if (typeNum === 3 && CMD_REGISTER_PASSWORD) {
      if (registerPassword !== CMD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid CMD registration password", null, 400);
      }
    }

    const normalizedPhone = String(userPhone).trim();
    const user = await User.findOne({ userPhone: normalizedPhone, userType: typeNum });
    if (!user) {
      const roleLabel = USER_TYPE_LABELS[typeNum] || "selected role";
      return errorResponse(res, `User not found with this mobile number for ${roleLabel}`, null, 404);
    }

    return successResponse(res, "User details verified successfully. You can now reset your PIN.", {
      userPhone: user.userPhone,
      userType: user.userType,
      userName: user.userName,
      userTypeLabel: USER_TYPE_LABELS[user.userType],
    });
  } catch (err) {
    console.error("Forgot PIN Verify Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

// ============================================================
// FORGOT PIN STEP 2: UPDATE 4-DIGIT PIN IN DB (ENCRYPTED)
// ============================================================
const resetPin = async (req, res) => {
  const { userPhone, userType } = req.body;
  const newPin = req.body.newPin || req.body.pin || req.body.loginPin || req.body.userPin;

  try {
    if (!userPhone) return errorResponse(res, "Mobile number is required", null, 400);
    if (!userType || ![1, 2, 3].includes(Number(userType))) {
      return errorResponse(res, "Valid userType is required: 1 (Rental Executive), 2 (Rental Manager), 3 (CMD)", null, 400);
    }

    if (!newPin) {
      return errorResponse(res, "New 4-digit PIN is required", null, 400);
    }

    const pinStr = String(newPin).trim();
    if (!/^\d{4}$/.test(pinStr)) {
      return errorResponse(res, "New PIN must be a 4-digit number", null, 400);
    }

    const normalizedPhone = String(userPhone).trim();
    const typeNum = Number(userType);

    const user = await User.findOne({ userPhone: normalizedPhone, userType: typeNum });
    if (!user) {
      return errorResponse(res, "User not found", null, 404);
    }

    // Encrypt new PIN before storing in DB
    const hashedPin = await bcrypt.hash(pinStr, 10);
    user.pin = hashedPin;
    user.updatedAt = nowIST();
    await user.save();

    return successResponse(res, "PIN updated successfully. Please log in with your new PIN.", {
      userPhone: user.userPhone,
      userType: user.userType,
      userTypeLabel: USER_TYPE_LABELS[user.userType],
    });
  } catch (err) {
    console.error("Reset PIN Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

// ============================================================
// ============================================================
// FORGOT PIN (Generates 4-digit PIN & triggers PHP Mail)
// ============================================================
const forgotPin = async (req, res) => {
  const emailInput = req.body.userEmail || req.body.email || req.body.userPhone;

  try {
    if (!emailInput) {
      return errorResponse(res, "userEmail or registered mobile number is required", null, 400);
    }

    const normalizedInput = String(emailInput).trim();

    // Find user by email or phone
    let user = await User.findOne({
      $or: [
        { userEmail: new RegExp("^" + normalizedInput.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + "$", "i") },
        { userPhone: normalizedInput }
      ]
    });

    if (!user) {
      return errorResponse(res, "User not found", null, 404);
    }

    const targetEmail = user.userEmail || (normalizedInput.includes("@") ? normalizedInput : null);
    if (!targetEmail) {
      return errorResponse(res, "No registered email address found for this user account", null, 400);
    }

    // Generate random 4-digit PIN (1000 - 9999)
    const generatedPin = String(Math.floor(1000 + Math.random() * 9000));

    // Encrypt generated PIN with bcrypt before storing
    const hashedPin = await bcrypt.hash(generatedPin, 10);
    user.pin = hashedPin;
    user.updatedAt = nowIST();

    // Save to MongoDB before attempting email dispatch
    await user.save();

    // Prepare mail payload for PHP Mail API
    const phpMailUrl = process.env.PHP_MAIL_URL || "https://adinndigital.com/api/outdoormedia/forgotPinMail.php";
    const mailPayload = {
      mailtype: "forgotpin",
      to: [targetEmail],
      data: {
        userName: user.userName || "User",
        email: targetEmail,
        pin: generatedPin
      }
    };

    // Send request to PHP Mail service
    try {
      const mailRes = await axios.post(phpMailUrl, mailPayload, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
      });

      if (mailRes.data && mailRes.data.status === "success") {
        return successResponse(res, "A temporary PIN has been sent to your registered email", {
          userEmail: targetEmail,
          // email: targetEmail
        }, 200);
      } else {
        console.error("PHP Mail API Error:", mailRes.data);
        return errorResponse(res, mailRes.data?.message || "Failed to send PIN email via PHP mail service", mailRes.data, 500);
      }
    } catch (mailErr) {
      console.error("PHP Mail Request Failed:", mailErr.message);
      const errorDetails = mailErr.response?.data || mailErr.message || "Unable to reach PHP Mail service endpoint";
      return errorResponse(res, "Failed to connect to mail service. Email could not be sent.", errorDetails, 500);
    }
  } catch (err) {
    console.error("Forgot PIN Error:", err);
    return errorResponse(res, "Server error during forgot PIN request", null, 500);
  }
};

// ============================================================
// CHANGE PIN (Supports optional Bearer Token OR userPhone/email/userId in Body)
// ============================================================
const changePin = async (req, res) => {
  const { currentPin, newPin, confirmPin } = req.body;
  const userPhone = req.body.userPhone || req.body.phone;
  const userEmail = req.body.userEmail || req.body.email;
  const userId = req.body.userId;

  try {
    if (!currentPin) {
      return errorResponse(res, "Current PIN is required", null, 400);
    }

    if (!newPin) {
      return errorResponse(res, "New PIN is required", null, 400);
    }

    if (!confirmPin) {
      return errorResponse(res, "Confirm PIN is required", null, 400);
    }

    const currentPinStr = String(currentPin).trim();
    const newPinStr = String(newPin).trim();
    const confirmPinStr = String(confirmPin).trim();

    // Validate 4-digit numeric PIN format
    if (!/^\d{4}$/.test(newPinStr)) {
      return errorResponse(res, "New PIN must be a 4-digit number", null, 400);
    }

    // Validate newPin === confirmPin
    if (newPinStr !== confirmPinStr) {
      return errorResponse(res, "New PIN and Confirm PIN do not match", null, 400);
    }

    // Validate newPin !== currentPin
    if (newPinStr === currentPinStr) {
      return errorResponse(res, "New PIN cannot be the same as Current PIN", null, 400);
    }

    // Attempt to extract user from Authorization Bearer token if present
    if (!req.user && req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
      try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          req.user = { userId: decoded.id };
        }
      } catch (tokenErr) {
        // Token invalid or expired - proceed to body identifier fallback
      }
    }

    let user = null;

    // 1. Find user by decoded JWT user ID
    if (req.user && req.user.userId) {
      user = await User.findById(req.user.userId).select("+pin");
    }

    // 2. Fallback: Find user by body identifier (mobile phone, email, or userId)
    if (!user) {
      const identifier = userPhone || userEmail || userId;
      if (!identifier) {
        return errorResponse(
          res,
          "User identifier (mobile number, email, or Bearer token) is required",
          null,
          400
        );
      }

      const normalizedIdentifier = String(identifier).trim();

      if (mongoose.Types.ObjectId.isValid(normalizedIdentifier)) {
        user = await User.findById(normalizedIdentifier).select("+pin");
      }

      if (!user) {
        user = await User.findOne({
          $or: [
            { userPhone: normalizedIdentifier },
            { userEmail: new RegExp("^" + normalizedIdentifier.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + "$", "i") }
          ]
        }).select("+pin");
      }
    }

    if (!user) {
      return errorResponse(res, "User not found", null, 404);
    }

    // Verify current PIN
    let isCurrentPinValid = false;
    if (user.pin) {
      if (user.pin.startsWith("$2a$") || user.pin.startsWith("$2b$") || user.pin.startsWith("$2y$")) {
        isCurrentPinValid = await bcrypt.compare(currentPinStr, user.pin);
      } else {
        isCurrentPinValid = (user.pin === currentPinStr);
      }
    } else {
      // Fallback for legacy users
      const typeNum = user.userType;
      if (typeNum === 1) isCurrentPinValid = (currentPinStr === String(STAFF_LOGIN_PIN).trim());
      else if (typeNum === 2) isCurrentPinValid = (currentPinStr === String(TEAMHEAD_LOGIN_PIN).trim());
      else if (typeNum === 3) isCurrentPinValid = (currentPinStr === String(CMD_LOGIN_PIN).trim());
    }

    if (!isCurrentPinValid) {
      return errorResponse(res, "Current PIN is incorrect", null, 400);
    }

    // Hash and update new PIN
    const hashedNewPin = await bcrypt.hash(newPinStr, 10);
    user.pin = hashedNewPin;
    user.updatedAt = nowIST();
    await user.save();

    return successResponse(res, "PIN changed successfully", null, 200);
  } catch (err) {
    console.error("Change PIN Error:", err);
    return errorResponse(res, "Server error during PIN change", null, 500);
  }
};

module.exports = {
  registerUser,
  loginUser,
  forgotPinVerify,
  resetPin,
  forgotPin,
  changePin,
  // Backward compatibility exports
  registerSendOtp: registerUser,
  verifyRegisterOtp: registerUser,
  resendRegisterOtp: registerUser,
  loginSendOtp: loginUser,
  loginVerifyOtp: loginUser,
  resendLoginOtp: registerUser,
};