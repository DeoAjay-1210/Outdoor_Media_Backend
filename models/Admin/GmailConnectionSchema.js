const mongoose = require("mongoose");

/**
 * The Gmail account connected through the "Connect Gmail" login (OAuth). One document (key "primary").
 * The refresh token is stored ENCRYPTED (AES-256-GCM, see utils/gmailService.js); it is never returned by an API.
 */
const gmailConnectionSchema = new mongoose.Schema(
  {
    key: { type: String, default: "primary", unique: true },
    email: { type: String, trim: true, default: "" },
    refreshTokenEnc: { type: String, default: "" },
    connectedBy: { type: String, default: "" },
    connectedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "gmail_connection" },
);

module.exports = mongoose.models.GmailConnection || mongoose.model("GmailConnection", gmailConnectionSchema);
