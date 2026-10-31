const jwt = require("jsonwebtoken");
const { blockReadOnlyPhone } = require("./readOnlyPhones");

const protect = (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET
      );

       req.user = {
        userId: decoded.id,
        userType: decoded.userType,
        userName: decoded.userName, // Get name directly from token
        userPhone: decoded.userPhone || "", // ✅ NEW
      };
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token"
      });
    }
    // ✅ NEW — view-only phones (READ_ONLY_PHONES) cannot save on live
    return blockReadOnlyPhone(req, res)
      .then((blocked) => {
        if (!blocked) next();
      })
      .catch(() => next());
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No token provided"
    });
  }
};

module.exports = protect;