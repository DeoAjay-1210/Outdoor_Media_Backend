// const jwt = require("jsonwebtoken");

// const generateToken = (id) => {
//   return jwt.sign(
//     { id },
//     process.env.JWT_SECRET,
//     {
//       expiresIn: "7d"
//     }
//   );
// };

// module.exports = generateToken;



// utils/generateToken.js
const jwt = require("jsonwebtoken");

const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id || user._id,
      userType: user.userType,
      name: user.name || user.userName
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
};

module.exports = generateToken;