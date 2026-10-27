const User = require("../../../models/Admin/UserSchema/UserSchema");
const { successResponse, errorResponse } = require("../../../utils/response");
const { nowIST } = require("../../../utils/updatedAt");

class FcmController {
  /**
   * Save or update FCM registration token for logged-in user
   * POST /admin/fcm/token
   * Body: { fcmToken, deviceType }
   */
  static async saveFcmToken(req, res) {
    try {
      const userId = req.user?._id || req.user?.userId || req.user?.id;
      const { fcmToken, token, deviceType = "android" } = req.body;
      const targetToken = (fcmToken || token || "").trim();

      if (!userId) {
        return errorResponse(res, "User not authenticated", null, 401);
      }

      if (!targetToken) {
        return errorResponse(res, "FCM token is required", null, 400);
      }

      const validDeviceType = ["android", "ios", "web", "desktop"].includes(
        String(deviceType).toLowerCase()
      )
        ? String(deviceType).toLowerCase()
        : "android";

      const now = nowIST();

      // Remove this token from any other user to prevent sending notifications to previous user of same device
      await User.updateMany(
        { _id: { $ne: userId }, "fcmTokens.token": targetToken },
        { $pull: { fcmTokens: { token: targetToken } } }
      );

      // Check if user already has this token
      const user = await User.findById(userId);
      if (!user) {
        return errorResponse(res, "User record not found", null, 440);
      }

      const existingTokenIndex = (user.fcmTokens || []).findIndex(
        (t) => t.token === targetToken
      );

      if (existingTokenIndex !== -1) {
        user.fcmTokens[existingTokenIndex].updatedAt = now;
        user.fcmTokens[existingTokenIndex].deviceType = validDeviceType;
      } else {
        user.fcmTokens = user.fcmTokens || [];
        user.fcmTokens.push({
          token: targetToken,
          deviceType: validDeviceType,
          createdAt: now,
          updatedAt: now,
        });
      }

      await user.save();

      return successResponse(res, "FCM token saved successfully", {
        userId,
        deviceType: validDeviceType,
        fcmTokenCount: user.fcmTokens.length,
      });
    } catch (err) {
      console.error("saveFcmToken error:", err);
      return errorResponse(res, "Failed to save FCM token", err.message, 500);
    }
  }

  /**
   * Remove FCM registration token on user logout
   * POST /admin/fcm/remove-token
   * Body: { fcmToken }
   */
  static async removeFcmToken(req, res) {
    try {
      const userId = req.user?._id || req.user?.userId || req.user?.id;
      const { fcmToken, token } = req.body;
      const targetToken = (fcmToken || token || "").trim();

      if (!targetToken) {
        return errorResponse(res, "FCM token is required", null, 400);
      }

      if (userId) {
        await User.findByIdAndUpdate(userId, {
          $pull: { fcmTokens: { token: targetToken } },
        });
      } else {
        await User.updateMany(
          { "fcmTokens.token": targetToken },
          { $pull: { fcmTokens: { token: targetToken } } }
        );
      }

      return successResponse(res, "FCM token removed successfully");
    } catch (err) {
      console.error("removeFcmToken error:", err);
      return errorResponse(res, "Failed to remove FCM token", err.message, 500);
    }
  }
}

module.exports = FcmController;
