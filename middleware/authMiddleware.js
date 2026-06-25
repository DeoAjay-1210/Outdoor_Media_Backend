const jwt = require("jsonwebtoken");

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
        id: decoded.id,
        userType: decoded.userType,
        userName: decoded.userName // Get name directly from token
      };
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token"
      });
    }
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No token provided"
    });
  }
};

module.exports = protect;