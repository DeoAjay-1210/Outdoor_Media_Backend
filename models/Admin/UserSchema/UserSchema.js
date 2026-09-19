const mongoose = require("mongoose");
const { nowIST } = require("../../../utils/updatedAt");

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
      // 2 = Team Lead
      // 3 = CMD
      required: true,
    },
    pin: {
      type: String,
      select: false,
    },
    registerPassword: {
      type: String,
      select: false,
    },
    createdAt: { type: Date, default: nowIST },
    updatedAt: { type: Date, default: nowIST },
  },
  {
    timestamps: false,
  }
);

userSchema.pre("save", function () {
  const now = nowIST();
  this.updatedAt = now;
  if (this.isNew && !this.createdAt) {
    this.createdAt = now;
  }
});

module.exports = mongoose.model("Users", userSchema);