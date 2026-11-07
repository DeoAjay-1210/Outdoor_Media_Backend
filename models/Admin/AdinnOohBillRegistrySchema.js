const mongoose = require("mongoose");

// ✅ NEW — authoritative register of every ADINN OOH bill number
// (media.rentalDue[].adinn_ooh_bills, utils/adinnOohBills.js). One document per
// issued bill. Unique keys make sure that:
//   • one bill (groupKey) never gets two numbers (retries / concurrent approvals)
//   • one number / serial is never given to two bills
// The rentalDue rows hold a copy; if a row ever loses it, the same number is
// restored from here (never renumbered).
const adinnOohBillRegistrySchema = new mongoose.Schema(
  {
    adinn_ooh_bills: { type: String, required: true, trim: true },
    serial: { type: Number, required: true, min: 1 },
    // which bill: "<mediaId>|<dueMonth>" (single bill site),
    // "<mediaId>|row:<rentalDueId>" (separate bill face), + "|owner:<landOwnerId>"
    // (separate bill per landlord)
    groupKey: { type: String, required: true, trim: true },
    mediaId: { type: mongoose.Schema.Types.ObjectId, required: true },
    dueMonth: { type: String, trim: true, default: "" },
    billDate: { type: Date, required: true }, // date used inside the number
    rentalDueIds: [{ type: mongoose.Schema.Types.ObjectId }],
    landOwnerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    landOwnerMasterId: { type: mongoose.Schema.Types.ObjectId, default: null },
    landOwnerName: { type: String, trim: true, default: "" },
    billMode: { type: String, trim: true, default: "" }, // single | separate_site | separate_landlord
    source: { type: String, enum: ["approval", "backfill"], default: "approval" },
    assignedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

adinnOohBillRegistrySchema.index({ adinn_ooh_bills: 1 }, { unique: true });
adinnOohBillRegistrySchema.index({ serial: 1 }, { unique: true });
adinnOohBillRegistrySchema.index({ groupKey: 1 }, { unique: true });
adinnOohBillRegistrySchema.index({ mediaId: 1 });

module.exports =
  mongoose.models.AdinnOohBillRegistry ||
  mongoose.model("AdinnOohBillRegistry", adinnOohBillRegistrySchema, "adinn_ooh_bill_registry");
