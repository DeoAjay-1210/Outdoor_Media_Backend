// Paid Date extraction + resolution, the Gmail lookup that feeds it, and the processor's use of it.
// No network, no database. Run: node --test test/utrPaidDate.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractExplicitPaymentDates, resolvePaidDate, istDay } = require("../utils/utrPaidDate");
const { parseMessage } = require("../utils/gmailService");

const NOW = Date.parse("2026-11-10T06:00:00Z"); // 10 Nov 2026, 11:30 IST

// ── istDay: India calendar day, never the server's zone ──
test("D1. istDay converts an instant to the India calendar day", () => {
  assert.equal(istDay("2026-11-09T20:00:00Z"), "2026-11-10"); // 01:30 IST next day
  assert.equal(istDay("2026-11-09T18:29:59Z"), "2026-11-09");
  assert.equal(istDay("2026-11-09T18:30:00Z"), "2026-11-10");
  assert.equal(istDay("not a date"), null);
});

test("D2. parseMessage keeps the Date header as sentAt, converted from the sender's offset", () => {
  const msg = {
    id: "m1", threadId: "t", internalDate: String(Date.parse("2026-11-09T12:00:00Z")),
    payload: { headers: [{ name: "Date", value: "Mon, 9 Nov 2026 23:50:00 +0530" }, { name: "Subject", value: "x" }], mimeType: "text/plain", body: { data: Buffer.from("hi").toString("base64url") } },
  };
  const p = parseMessage(msg);
  assert.equal(p.sentAt, "2026-11-09T18:20:00.000Z");
  assert.equal(istDay(p.sentAt), "2026-11-09"); // 23:50 IST is still the 9th
  assert.equal(p.dateHeader, "Mon, 9 Nov 2026 23:50:00 +0530");
  // no / broken Date header -> Gmail's own time
  const noHeader = parseMessage({ ...msg, payload: { ...msg.payload, headers: [] } });
  assert.equal(noHeader.sentAt, "2026-11-09T12:00:00.000Z");
});

// ── explicit payment dates ──
test("D3. labelled payment dates in the usual Indian formats", () => {
  const cases = [
    ["Payment Date: 05-11-2026", "2026-11-05"],
    ["Payment date - 5/11/2026", "2026-11-05"],
    ["Transaction Date : 05.11.2026", "2026-11-05"],
    ["Txn Date: 2026-11-05", "2026-11-05"],
    ["Paid on 5 Nov 2026", "2026-11-05"],
    ["Date of Payment: 05-Nov-2026", "2026-11-05"],
    ["Value Date: November 5, 2026", "2026-11-05"],
    ["Transferred on 05/11/26", "2026-11-05"],
    ["Credited on 5th November 2026", "2026-11-05"],
    ["payment made on 01-02-2026", "2026-02-01"], // day first, never month first
  ];
  for (const [text, want] of cases) {
    const r = extractExplicitPaymentDates(`Dear team,\n${text}\nThanks`);
    assert.deepEqual(r.map((x) => x.date), [want], text);
  }
});

test("D4. unlabelled dates, bill/due dates, impossible dates and look-alike words are NOT payment dates", () => {
  const none = [
    "Date: Mon, 9 Nov 2026",
    "Bill Date: 05-11-2026",
    "Due Date: 25-11-2026",
    "Approved on 05-11-2026",
    "UTR HDFC92023012200543116 on 05-11-2026",
    "Payment Date: 31-02-2026",
    "Payment Date: 13-13-2026", // month 13: rejected, not swapped to mm/dd
    "Payment Date: 05-Marketing-2026",
    "Amount 150000 paid",
  ];
  for (const t of none) assert.deepEqual(extractExplicitPaymentDates(t), [], t);
});

test("D5. the same date repeated counts once; different dates are both reported", () => {
  assert.deepEqual(extractExplicitPaymentDates("Payment Date: 05-11-2026\nTransaction Date: 5 Nov 2026").map((x) => x.date), ["2026-11-05"]);
  assert.deepEqual(extractExplicitPaymentDates("Payment Date: 05-11-2026\nPayment Date: 06-11-2026").map((x) => x.date), ["2026-11-05", "2026-11-06"]);
});

// ── resolution ──
const resolve = (info, ctx = {}) => resolvePaidDate(info, { now: NOW, ...ctx });

test("D6. explicit payment date in the email wins over the sent date", () => {
  const r = resolve({ explicitDates: [{ date: "2026-11-05" }], sentDate: "2026-11-09" }, { approvalDate: "2026-11-02T10:00:00Z" });
  assert.equal(r.date, "2026-11-05");
  assert.equal(r.source, "email_payment_date");
  assert.deepEqual(r.rejected, []);
});

test("D7. no explicit date -> the email SENT date (not now); the note tells the user to check it", () => {
  const r = resolve({ explicitDates: [], sentDate: "2026-11-09" });
  assert.equal(r.date, "2026-11-09"); // today is the 10th: the run time is NOT used
  assert.equal(r.source, "email_sent_date");
  assert.match(r.note, /Check the Paid Date/);
});

test("D8. unusable explicit dates fall back to the sent date and are listed as rejected", () => {
  const ctx = { approvalDate: "2026-11-02T10:00:00Z" };
  const future = resolve({ explicitDates: [{ date: "2026-11-20" }], sentDate: "2026-11-09" }, ctx);
  assert.equal(future.date, "2026-11-09");
  assert.deepEqual(future.rejected, [{ date: "2026-11-20", reason: "in_the_future" }]);

  const afterSent = resolve({ explicitDates: [{ date: "2026-11-10" }], sentDate: "2026-11-09" }, ctx);
  assert.equal(afterSent.source, "email_sent_date");
  assert.equal(afterSent.rejected[0].reason, "after_email_sent_date");

  const beforeApproval = resolve({ explicitDates: [{ date: "2026-10-20" }], sentDate: "2026-11-09" }, ctx);
  assert.equal(beforeApproval.source, "email_sent_date");
  assert.equal(beforeApproval.rejected[0].reason, "before_approval_date");

  const several = resolve({ explicitDates: [{ date: "2026-11-05" }, { date: "2026-11-06" }], sentDate: "2026-11-09" }, ctx);
  assert.equal(several.date, "2026-11-09");
  assert.equal(several.source, "email_sent_date");
  assert.ok(several.rejected.every((x) => x.reason === "multiple_payment_dates_in_reply"));
});

test("D9. missing or invalid dates everywhere -> no date (the bill must stay manual)", () => {
  assert.equal(resolve({ explicitDates: [], sentDate: null }).date, null);
  assert.equal(resolve({}).date, null);
  assert.equal(resolve({ explicitDates: [], sentDate: "2026-11-20" }).date, null); // sent "in the future"
  assert.equal(resolve({ explicitDates: [], sentDate: "2026-10-01" }, { approvalDate: "2026-11-02T10:00:00Z" }).date, null); // before approval
});

test("D10. the approval day is the day RMS stored (nowIST: IST wall-clock kept as UTC); the approval day itself is allowed", () => {
  // stored 2026-11-07T23:30Z means 7 Nov 23:30 IST -> approval day 7 Nov (NOT shifted to the 8th)
  const ok = resolve({ explicitDates: [{ date: "2026-11-07" }], sentDate: "2026-11-09" }, { approvalDate: "2026-11-07T23:30:00Z" });
  assert.equal(ok.date, "2026-11-07");
  assert.equal(ok.source, "email_payment_date");
  // stored 2026-11-07T00:10Z means 7 Nov 00:10 IST -> 6 Nov is before approval
  const early = resolve({ explicitDates: [{ date: "2026-11-06" }], sentDate: "2026-11-09" }, { approvalDate: "2026-11-07T00:10:00Z" });
  assert.equal(early.source, "email_sent_date");
  assert.equal(early.rejected[0].reason, "before_approval_date");
});

test("D11. REGRESSION (real record): approved 9 Nov 18:56 IST (stored 2026-11-09T18:56:51Z), reply sent the same evening -> Paid Date 2026-11-09, not rejected", () => {
  const now = Date.parse("2026-11-09T13:54:00Z"); // 19:24 IST on 9 Nov
  const r = resolvePaidDate({ explicitDates: [], sentDate: istDay("2026-11-09T13:40:00Z") }, { approvalDate: "2026-11-09T18:56:51.960Z", now });
  assert.equal(r.date, "2026-11-09");
  assert.equal(r.source, "email_sent_date");
  assert.deepEqual(r.rejected, []);
});
// ── Gmail lookup: which message's date is used ──
const Gmail = require("../utils/gmailService");
const { lookupUtrByBillNumber } = require("../utils/gmailUtrLookup");
const BILL = "ADNOOHBILL0611202601";
const UTR = "HDFC92023012200543116";
const mail = (id, body, sentAt, extra = {}) => ({ id, from: "Finance <f@x.com>", to: "", subject: "Re: approval", date: sentAt, sentAt, bodyText: body, ...extra });
const withThread = async (messages, fn) => {
  const save = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "Re: approval", messages });
  try { return await fn(); } finally { Gmail.searchThreads = save.s; Gmail.getThread = save.g; }
};
const quoted = `Bill Number: ${BILL}\nSite: ABC\nAmount 35000`;

test("L1. the date evidence comes from the reply that states the UTR, not from the approval mail", async () => {
  const msgs = [
    mail("m1", `${quoted}\nDue Date: 25-11-2026\nBill Date: 06-11-2026`, "2026-11-06T08:00:00.000Z"), // our approval mail
    mail("m2", `Paid. UTR: ${UTR}\nPayment Date: 08-11-2026\n\n> ${quoted.split("\n").join("\n> ")}`, "2026-11-09T05:00:00.000Z"),
  ];
  const r = await withThread(msgs, () => lookupUtrByBillNumber(BILL));
  assert.equal(r.data.extractionStatus, "found");
  assert.deepEqual(r.data.paidDateInfo.explicitDates.map((d) => d.date), ["2026-11-08"]);
  assert.equal(r.data.paidDateInfo.sourceMessageId, "m2");
  assert.equal(r.data.paidDateInfo.sentDate, "2026-11-09");
});

test("L2. no explicit date -> sent date of the UTR reply (IST day), not the later unrelated reply", async () => {
  const msgs = [
    mail("m1", quoted, "2026-11-06T08:00:00.000Z"),
    mail("m2", `UTR: ${UTR}\n\n> ${quoted}`, "2026-11-09T19:30:00.000Z"), // 01:00 IST on the 10th
    mail("m3", "Thanks, received. Payment Date: 01-11-2026", "2026-11-12T05:00:00.000Z"), // unrelated: no UTR
  ];
  const r = await withThread(msgs, () => lookupUtrByBillNumber(BILL));
  assert.equal(r.data.paidDateInfo.explicitDates.length, 0);
  assert.equal(r.data.paidDateInfo.sentDate, "2026-11-10");
  assert.equal(r.data.paidDateInfo.sourceMessageId, "m2");
});

test("L3. several replies repeating the same UTR: their explicit dates are all considered", async () => {
  const msgs = [
    mail("m1", quoted, "2026-11-06T08:00:00.000Z"),
    mail("m2", `UTR: ${UTR}\nPayment Date: 08-11-2026`, "2026-11-09T05:00:00.000Z"),
    mail("m3", `Correction. UTR: ${UTR}\nPayment Date: 07-11-2026`, "2026-11-09T06:00:00.000Z"),
  ];
  const r = await withThread(msgs, () => lookupUtrByBillNumber(BILL));
  assert.deepEqual(r.data.paidDateInfo.explicitDates.map((d) => d.date), ["2026-11-08", "2026-11-07"]);
  // two different dates -> the resolver refuses to choose and uses the sent date
  const paid = resolvePaidDate(r.data.paidDateInfo, { now: NOW });
  assert.equal(paid.source, "email_sent_date");
});

test("L4. quoted history cannot supply a payment date", async () => {
  const msgs = [
    mail("m1", quoted, "2026-11-06T08:00:00.000Z"),
    mail("m2", `UTR: ${UTR}\n\nOn Mon, 2 Nov 2026 at 10:00, Rental <r@x.com> wrote:\n> Payment Date: 01-11-2026`, "2026-11-09T05:00:00.000Z"),
  ];
  const r = await withThread(msgs, () => lookupUtrByBillNumber(BILL));
  assert.equal(r.data.paidDateInfo.explicitDates.length, 0);
});

// ── drafts / trash / spam are never finance replies ──
test("X1. parseMessage keeps the Gmail labels; only sent mail is usable (DRAFT / TRASH / SPAM are not)", () => {
  const { isUsableMessage } = require("../utils/gmailService");
  const base = { id: "m", threadId: "t", internalDate: "1767261600000", payload: { headers: [], mimeType: "text/plain", body: { data: Buffer.from("x").toString("base64url") } } };
  assert.deepEqual(parseMessage({ ...base, labelIds: ["DRAFT"] }).labelIds, ["DRAFT"]);
  assert.deepEqual(parseMessage(base).labelIds, []);
  for (const l of ["DRAFT", "TRASH", "SPAM"]) assert.equal(isUsableMessage({ labelIds: ["INBOX", l] }), false, l);
  for (const l of [["INBOX"], ["SENT"], ["INBOX", "UNREAD"], []]) assert.equal(isUsableMessage({ labelIds: l }), true);
  assert.equal(isUsableMessage({}), true);
});

test("X2. an UNSENT draft reply in the thread is ignored by both lookups: no UTR, no landlord lines, no payment date", async () => {
  const { lookupLandlordUtrs } = require("../utils/gmailUtrLookup");
  const draftBody = `Rent - UTR : RENT7428347473\nGST - UTR : GSTT4832428443`;
  const msgs = (labels) => [
    mail("m1", `Bill No: ${BILL}\nSite: ABC`, "2026-11-06T08:00:00.000Z"),
    { ...mail("m2", draftBody, "2026-11-09T05:00:00.000Z"), labelIds: labels },
  ];
  for (const l of [["DRAFT"], ["TRASH"], ["SPAM"], ["DRAFT", "INBOX"]]) {
    const single = await withThread(msgs(l), () => lookupUtrByBillNumber(BILL));
    assert.equal(single.data.extractionStatus, "utr_not_found", l.join());
    const multi = await withThread(msgs(l), () => lookupLandlordUtrs(BILL));
    assert.equal(multi.data.extractionStatus, "utr_not_found", l.join());
    assert.deepEqual(multi.data.replies, []);
  }
  // the same text SENT (label SENT / INBOX) is read as before
  const sent = await withThread(msgs(["SENT"]), () => lookupLandlordUtrs(BILL));
  assert.equal(sent.data.extractionStatus, "found");
  assert.deepEqual(sent.data.replies[0].lines.map((x) => x.name), ["Rent", "GST"]);
  const sentSingle = await withThread([mail("m1", `Bill Number: ${BILL}`, "2026-11-06T08:00:00.000Z"), { ...mail("m2", `UTR: ${UTR}`, "2026-11-09T05:00:00.000Z"), labelIds: ["SENT"] }], () => lookupUtrByBillNumber(BILL));
  assert.equal(sentSingle.data.extractionStatus, "found");
});
