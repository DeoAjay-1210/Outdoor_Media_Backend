const mongoose = require("mongoose");

// Why a new collection: nothing in the existing schema records "Gmail found / could not decide /
// failed" per Bill Number, and the processor needs that to avoid re-searching Gmail every 10 minutes
// (cooldown), to show a manual-review list, and to audit what was auto-saved. One document per
// non-dry-run processing attempt. Auto-deleted after 180 days.
const gmailUtrLogSchema = new mongoose.Schema(
  {
    runId: { type: String, index: true },
    billNumber: { type: String, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: [
        "found_and_saved",
        "bill_not_found",
        "utr_not_found",
        "already_processed",
        "multiple_review_required",
        "ambiguous_mapping",
        "gmail_error",
        "database_error",
      ],
    },
    reason: { type: String, default: "" },
    mediaId: { type: String, default: "" },
    billKind: { type: String, default: "" }, // "newBill" | "advance" for arrearsDue bills; empty = Rental Bill
    dueMonth: { type: String, default: "" }, // target month of the Bill Number (rentalDue.dueMonth)
    rentalDueIds: [{ type: String }],
    landOwnerId: { type: String, default: "" },
    utr: { type: String, default: null },
    gmailThreadId: { type: String, default: "" },
    sourceMessageId: { type: String, default: "" },
    senderEmail: { type: String, default: "" },
    messageDate: { type: String, default: "" },
    savedAmount: { type: Number, default: 0 },
    splitPayments: { type: mongoose.Schema.Types.Mixed, default: null }, // GST on hold: [{ kind: rent|gst, utr, paidDate, … }]
    replyLink: { type: mongoose.Schema.Types.Mixed, default: null }, // multi-approval thread: reply -> approval mail by In-Reply-To
    landlordMappings: { type: mongoose.Schema.Types.Mixed, default: null }, // multi-landlord: [{ landlord, utr, paidDate, paidDateSource, … }]
    paidDate: { type: String, default: "" }, // YYYY-MM-DD saved as the Paid Date
    paidDateSource: { type: String, default: "" }, // email_payment_date | email_sent_date
    paymentType: { type: String, default: "" }, // cash | online_rent
    dryRun: { type: Boolean, default: false },
    triggeredBy: { type: String, default: "api" }, // api | cron
    createdAt: { type: Date, default: Date.now, expires: 180 * 24 * 3600 },
  },
  { versionKey: false },
);

gmailUtrLogSchema.index({ billNumber: 1, createdAt: -1 });

module.exports = mongoose.models.GmailUtrLog || mongoose.model("GmailUtrLog", gmailUtrLogSchema, "gmail_utr_logs");
