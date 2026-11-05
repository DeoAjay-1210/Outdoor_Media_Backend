const mongoose = require("mongoose");

// ✅ NEW — running counters (atomic $inc). _id "billNo" → bill number sequence
// (utils/billNo.js); never reset, so a number is never given twice.
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

module.exports = mongoose.models.Counter || mongoose.model("Counter", counterSchema);
