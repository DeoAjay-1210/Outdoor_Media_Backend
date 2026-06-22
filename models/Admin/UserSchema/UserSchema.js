const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    userName: { type: String, required: true },
    userEmail: { type: String },
    userPhone: { type: String, required: true, unique: true },
    lastLogin: { type: Date },
    userType: {
      type: Number,
      enum: [1, 2, 3],
      // 1 = Staff
      // 2 = Team Head
      // 3 = Owner
      required: true,
    },
      registerPassword: {
      type: String,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Users", userSchema);