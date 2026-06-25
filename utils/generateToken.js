

// utils/generateToken.js
const jwt = require("jsonwebtoken");

const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id || user._id,
      userType: user.userType,
      userName: user.userName
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
};

module.exports = generateToken;