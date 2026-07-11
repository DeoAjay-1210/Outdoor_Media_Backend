const User = require("../../../models/Admin/UserSchema/UserSchema");
const axios = require("axios");
const { successResponse, errorResponse } = require("../../../utils/response");
const generateToken = require("../../../utils/generateToken");

// ============================================================
// ENV VARIABLES
// ============================================================
const NETTYFISH_API_KEY = process.env.NETTYFISH_API_KEY;
const NETTYFISH_SENDER_ID = process.env.NETTYFISH_SENDER_ID;
const NETTYFISH_TEMPLATE_ID_REGISTER = process.env.NETTYFISH_TEMPLATE_ID_REGISTER;
const NETTYFISH_TEMPLATE_ID_LOGIN = process.env.NETTYFISH_TEMPLATE_ID_LOGIN;
const NETTYFISH_TEMPLATE_ID_RESEND = process.env.NETTYFISH_TEMPLATE_ID_RESEND;

const IS_PRODUCTION = process.env.NODE_ENV === "production";


const STAFF_REGISTER_PASSWORD = process.env.STAFF_REGISTER_PASSWORD;
const TEAMHEAD_REGISTER_PASSWORD = process.env.TEAMHEAD_REGISTER_PASSWORD;
// ============================================================
// USER TYPE LABELS
// 1 = Staff | 2 = Team Head | 3 = Owner
// ============================================================
const USER_TYPE_LABELS = {
  1: "Staff",
  2: "Team Head",
  3: "Owner",
};

// ============================================================
// IN-MEMORY OTP STORE
// ============================================================
const otpStore = {};

// ============================================================
// HELPER: SEND SMS
// ============================================================
async function sendSms(userPhone, message, templateId) {
  try {
    const mobileNumber = userPhone.toString().replace(/\D/g, "");
    const formattedNumber =
      mobileNumber.length === 10 ? `91${mobileNumber}` : mobileNumber;

    if (!formattedNumber || !message || !templateId) return false;

    const apiUrl = `https://retailsms.nettyfish.com/api/mt/SendSMS?APIKey=${NETTYFISH_API_KEY}&senderid=${NETTYFISH_SENDER_ID}&channel=Trans&DCS=0&flashsms=0&number=${formattedNumber}&dlttemplateid=${templateId}&text=${encodeURIComponent(message)}&route=17`;

    const response = await axios.get(apiUrl, { timeout: 10000 });

    if (typeof response.data === "object" && response.data.ErrorCode === "000") return true;
    if (typeof response.data === "string" && response.data.includes("Message Accepted")) return true;

    return false;
  } catch (err) {
    console.error("SMS Send Error:", err.message);
    return false;
  }
}

// ============================================================
// HELPER: GENERATE & STORE OTP
// ============================================================
function generateAndStoreOtp(key, userData) {
  const otp = Math.floor(1000 + Math.random() * 9000);
  otpStore[key] = {
    otp,
    expiresAt: Date.now() + 2 * 60 * 1000,
    userData,
  };
  return otp;
}

// ============================================================
// HELPER: VALIDATE OTP
// ============================================================
function validateOtp(key, otp) {
  const stored = otpStore[key];
  if (!stored) return "No OTP found";
  if (Date.now() > stored.expiresAt) {
    delete otpStore[key];
    return "OTP expired";
  }
  if (stored.otp.toString() !== otp.toString()) return "Invalid OTP";
  return null;
}


const registerSendOtp = async (req, res) => {
  const { userName, userEmail, userPhone, userType,registerPassword } = req.body;

  try {
    if (!userName) return errorResponse(res, "User name is required", null, 400);
    if (!userPhone) return errorResponse(res, "Mobile number is required", null, 400);
    if (!userType || ![1, 2, 3].includes(Number(userType))) {
      return errorResponse(res, "Valid userType is required: 1 (Staff), 2 (Team Head), 3 (Owner)", null, 400);
    }
    // Only Staff User (userType = 1)
    if (Number(userType) === 1) {
      if (!registerPassword) {
        return errorResponse(
          res,
          "Staff registration password is required",
          null,
          400
        );
      }

      if (registerPassword !== STAFF_REGISTER_PASSWORD) {
        return errorResponse(
          res,
          "Invalid staff registration password",
          null,
          400
        );
      }
    }
    // Only Team Head (userType = 2)
    if (Number(userType) === 2) {
      if (!registerPassword) {
        return errorResponse(
          res,
          "Team Head registration password is required",
          null,
          400
        );
      }

      if (registerPassword !== TEAMHEAD_REGISTER_PASSWORD) {
        return errorResponse(
          res,
          "Invalid Teamhead registration password",
          null,
          400
        );
      }
    }
    const normalizedPhone = String(userPhone).trim();
    const existingUser = await User.findOne({ userPhone: normalizedPhone });
    if (existingUser) {
      return errorResponse(res, "This mobile number is already registered. Please log in.", null, 400);
    }

    const otp = generateAndStoreOtp(normalizedPhone, {
      userName,
      userEmail,
      userPhone: normalizedPhone,
      userType: Number(userType),
    });

     const message = `Welcome to ADINN. Your Brand Activation Code is ${otp}. Use it to verify your brand owner account. Valid for 5 minutes.`;

    if (IS_PRODUCTION) {
      const smsSent = await sendSms(normalizedPhone, message, NETTYFISH_TEMPLATE_ID_REGISTER);
      if (!smsSent) {
        delete otpStore[normalizedPhone];
        return errorResponse(res, "Unable to send OTP. Please try again.", null, 500);
      }
      return successResponse(res, "OTP sent successfully", null, 200);
    }

    return successResponse(res, "OTP sent successfully", { testOtp: otp }, 200);
  } catch (err) {
    console.error("Register Send OTP Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

const verifyRegisterOtp = async (req, res) => {
  const { userPhone, otp } = req.body;

  try {
    if (!userPhone || !otp) {
      return errorResponse(res, "Phone number and OTP are required", null, 400);
    }

    const otpError = validateOtp(userPhone, otp);
    if (otpError) return errorResponse(res, otpError, null, 400);

    const storedData = otpStore[userPhone];
    if (!storedData) return errorResponse(res, "OTP data not found", null, 400);

    const { userName, userEmail, userPhone: storedPhone, userType } = storedData.userData;

    const newUser = new User({
      userName,
      userEmail,
      userPhone: storedPhone,
      userType,
    });

    await newUser.save();

    delete otpStore[userPhone];

    const token = generateToken(newUser);

    return successResponse(res, "Registration successful", {
      token,
      user: {
        _id: newUser._id,
        userName: newUser.userName,
        userEmail: newUser.userEmail,
        userPhone: newUser.userPhone,
        userType: newUser.userType,
        userTypeLabel: USER_TYPE_LABELS[newUser.userType],
      },
    });
  } catch (err) {
    console.error("Verify Register OTP Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

const resendRegisterOtp = async (req, res) => {
  const { userPhone } = req.body;

  try {
    if (!userPhone) return errorResponse(res, "Phone number is required", null, 400);

    const normalizedPhone = String(userPhone).trim();

    const existingUser = await User.findOne({ userPhone: normalizedPhone });
    if (existingUser) {
      return errorResponse(res, "This mobile number is already registered. Please log in.", null, 400);
    }

    const storedData = otpStore[normalizedPhone];
    if (!storedData || !storedData.userData?.userName) {
      delete otpStore[normalizedPhone];
      return errorResponse(res, "No active registration found. Please start the registration process again.", null, 400);
    }

    const newOtp = generateAndStoreOtp(normalizedPhone, storedData.userData);

        const message = `Your new ADINN Campaign Code is ${newOtp}. It is valid for 5 minutes. Please keep it private.`;

    if (IS_PRODUCTION) {
      const smsSent = await sendSms(normalizedPhone, message, NETTYFISH_TEMPLATE_ID_RESEND);
      if (!smsSent) return errorResponse(res, "Failed to resend OTP", null, 500);
      return successResponse(res, "OTP resent successfully", null, 200);
    }

    return successResponse(res, "OTP resent successfully", { testOtp: newOtp }, 200);
  } catch (err) {
    console.error("Resend Register OTP Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

const loginSendOtp = async (req, res) => {
  const { userPhone, userType } = req.body;

  try {
    if (!userPhone) return errorResponse(res, "Phone number is required", null, 400);
   if (!userType) {
      return errorResponse(res, "User type is required", null, 400);
    }
    const normalizedPhone = String(userPhone).trim();

    const user = await User.findOne({ userPhone: normalizedPhone, userType: Number(userType), });
    if (!user) return errorResponse(res, "User not found", null, 404);

    const otp = generateAndStoreOtp(normalizedPhone, {
      userId: user._id,
      login: true,
      userPhone: normalizedPhone,
       userType: user.userType,
    });

    const message = `Your ADINN Campaign Code is ${otp}. Use it to access your campaign dashboard. Valid for 5 minutes. Do not share this code.`;
    if (IS_PRODUCTION) {
      const smsSent = await sendSms(normalizedPhone, message, NETTYFISH_TEMPLATE_ID_LOGIN);
      if (!smsSent) return errorResponse(res, "Failed to send login OTP", null, 500);
      return successResponse(res, "Login OTP sent successfully", null, 200);
    }

    return successResponse(res, "Login OTP sent successfully", { testOtp: otp }, 200);
  } catch (err) {
    console.error("Login Send OTP Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

const loginVerifyOtp = async (req, res) => {
  const { userPhone, otp,userType  } = req.body;

  try {
    if (!userPhone || !otp || !userType) {
      return errorResponse(res, "Phone, OTP and userType are required", null, 400);
    }

    const otpError = validateOtp(userPhone, otp);
    if (otpError) return errorResponse(res, otpError, null, 400);

    const user = await User.findOne({ userPhone,userType: Number(userType), });
    if (!user) return errorResponse(res, "User not found", null, 404);

    user.lastLogin = new Date();
    await user.save();

    delete otpStore[userPhone];

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
    console.error("Login Verify OTP Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};

const resendLoginOtp = async (req, res) => {
  const { userPhone,userType  } = req.body;

  try {
    if (!userPhone) return errorResponse(res, "Phone number is required", null, 400);
  if (!userType) {
      return errorResponse(res, "User type is required", null, 400);
    }
    const normalizedPhone = String(userPhone).trim();

    const user = await User.findOne({ userPhone: normalizedPhone,  userType: Number(userType), });
    if (!user) return errorResponse(res, "User not found. Please register first.", null, 404);

    const storedData = otpStore[normalizedPhone];
    const userData = storedData?.userData || {
      userId: user._id,
      login: true,
      userPhone: normalizedPhone,
       userType: user.userType,
    };

    const newOtp = generateAndStoreOtp(normalizedPhone, userData);

   const message = `Your new ADINN Campaign Code is ${newOtp}. It is valid for 5 minutes. Please keep it private.`;

    if (IS_PRODUCTION) {
      const smsSent = await sendSms(normalizedPhone, message, NETTYFISH_TEMPLATE_ID_RESEND);
      if (!smsSent) return errorResponse(res, "Failed to resend login OTP", null, 500);
      return successResponse(res, "Login OTP resent successfully", null, 200);
    }

    return successResponse(res, "Login OTP resent successfully", { testOtp: newOtp }, 200);
  } catch (err) {
    console.error("Resend Login OTP Error:", err);
    return errorResponse(res, "Server error", null, 500);
  }
};


module.exports = {
  registerSendOtp,
  verifyRegisterOtp,
  resendRegisterOtp,
  loginSendOtp,
  loginVerifyOtp,
  resendLoginOtp,
};