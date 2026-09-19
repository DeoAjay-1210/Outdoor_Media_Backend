const User = require("../../../models/Admin/UserSchema/UserSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const generateToken = require("../../../utils/generateToken");

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
// 1 = Staff | 2 = Team Lead | 3 = CMD
// ============================================================
const USER_TYPE_LABELS = {
  1: "Staff",
  2: "Team Lead",
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
      return errorResponse(res, "Valid userType is required: 1 (Staff), 2 (Team Lead), 3 (CMD)", null, 400);
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
        return errorResponse(res, "Staff registration password is required", null, 400);
      }
      if (registerPassword !== STAFF_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid staff registration password", null, 400);
      }
    }

    if (typeNum === 2 && TEAMHEAD_REGISTER_PASSWORD) {
      if (!registerPassword) {
        return errorResponse(res, "Team Lead registration password is required", null, 400);
      }
      if (registerPassword !== TEAMHEAD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid Team Lead registration password", null, 400);
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

    const newUser = new User({
      userName,
      userEmail,
      userPhone: normalizedPhone,
      userType: typeNum,
      pin: pinStr,
      registerPassword,
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
      return errorResponse(res, "Valid userType is required: 1 (Staff), 2 (Team Lead), 3 (CMD)", null, 400);
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
      isPinValid = (user.pin === inputPin);
    } else {
      // Fallback for legacy users
      if (typeNum === 1) isPinValid = (inputPin === String(STAFF_LOGIN_PIN).trim());
      else if (typeNum === 2) isPinValid = (inputPin === String(TEAMHEAD_LOGIN_PIN).trim());
      else if (typeNum === 3) isPinValid = (inputPin === String(CMD_LOGIN_PIN).trim());
    }

    if (!isPinValid) {
      return errorResponse(res, "Invalid 4-digit PIN", null, 400);
    }

    user.lastLogin = new Date();
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
      return errorResponse(res, "Valid userType is required: 1 (Staff), 2 (Team Lead), 3 (CMD)", null, 400);
    }
    if (!registerPassword) {
      return errorResponse(res, "Registration password is required", null, 400);
    }

    const typeNum = Number(userType);

    // Role-based password check
    if (typeNum === 1 && STAFF_REGISTER_PASSWORD) {
      if (registerPassword !== STAFF_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid staff registration password", null, 400);
      }
    } else if (typeNum === 2 && TEAMHEAD_REGISTER_PASSWORD) {
      if (registerPassword !== TEAMHEAD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid Team Lead registration password", null, 400);
      }
    } else if (typeNum === 3 && CMD_REGISTER_PASSWORD) {
      if (registerPassword !== CMD_REGISTER_PASSWORD) {
        return errorResponse(res, "Invalid CMD registration password", null, 400);
      }
    }

    const normalizedPhone = String(userPhone).trim();
    const user = await User.findOne({ userPhone: normalizedPhone, userType: typeNum });
    if (!user) {
      return errorResponse(res, "User not found with this mobile number and userType", null, 404);
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
// FORGOT PIN STEP 2: UPDATE 4-DIGIT PIN IN DB
// ============================================================
const resetPin = async (req, res) => {
  const { userPhone, userType } = req.body;
  const newPin = req.body.newPin || req.body.pin || req.body.loginPin || req.body.userPin;

  try {
    if (!userPhone) return errorResponse(res, "Mobile number is required", null, 400);
    if (!userType || ![1, 2, 3].includes(Number(userType))) {
      return errorResponse(res, "Valid userType is required: 1 (Staff), 2 (Team Lead), 3 (CMD)", null, 400);
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

    user.pin = pinStr;
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

module.exports = {
  registerUser,
  loginUser,
  forgotPinVerify,
  resetPin,
  // Backward compatibility exports
  registerSendOtp: registerUser,
  verifyRegisterOtp: registerUser,
  resendRegisterOtp: registerUser,
  loginSendOtp: loginUser,
  loginVerifyOtp: loginUser,
  resendLoginOtp: loginUser,
};