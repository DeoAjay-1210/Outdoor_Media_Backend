// Synthetic fixtures only — no network, no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractUtrFromThread, stripQuoted } = require("../utils/utrExtractor");
const { parseMessage, decodeBase64Url } = require("../utils/gmailService");

const msg = (id, bodyText, extra = {}) => ({ id, from: "Finance <f@x.com>", date: `2026-01-0${id}T10:00:00Z`, bodyText, ...extra });
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("finds the UTR in the final reply of a multi-reply thread and ignores other numbers", () => {
  const r = extractUtrFromThread([
    msg(1, "Payment approval\nInvoice No: 202601234567\nAmount: 150000\nAccount No: 50100123456789"),
    msg(2, "Payment uploaded. Bank: HDFC, Amount 150000, date 22-01-2023"),
    msg(3, "Bank approved the payment."),
    msg(4, "UTR Number: HDFC92023012200543116\n\nThanks"),
  ]);
  assert.equal(r.status, "found");
  assert.equal(r.utr, "HDFC92023012200543116");
  assert.equal(r.source.messageId, 4);
});

test("accepts label variants, separators and a value on the next line", () => {
  for (const body of [
    "UTR - HDFC92023012200543116",
    "utr no. HDFC92023012200543116",
    "Transaction Reference Number: HDFC92023012200543116",
    "UTR Number\n\nHDFC92023012200543116",
    "UTR Number | HDFC92023012200543116",
  ]) {
    const r = extractUtrFromThread([msg(1, body)]);
    assert.equal(r.utr, "HDFC92023012200543116", body);
  }
});

test("a quoted copy of the UTR in a later reply does not count twice or as a second UTR", () => {
  const r = extractUtrFromThread([
    msg(1, "UTR: HDFC92023012200543116"),
    msg(2, "Thanks received.\n\nOn Mon, 5 Jan 2026 at 10:00 AM, Finance <f@x.com> wrote:\n> UTR: HDFC92023012200543116"),
  ]);
  assert.equal(r.status, "found");
  assert.equal(r.source.messageId, 1);
});

test("two different UTRs are returned for review, none picked", () => {
  const r = extractUtrFromThread([msg(1, "UTR: HDFC92023012200543116"), msg(2, "Correction UTR: SBIN12345678901234")]);
  assert.equal(r.status, "multiple_review_required");
  assert.equal(r.utr, null);
  assert.equal(r.candidates.length, 2);
});

test("not found when only invoice / amount / account numbers or a bare label are present", () => {
  const r = extractUtrFromThread([
    msg(1, "Invoice No: 202601234567 Reference Number: 998877665544 Amount 150000"),
    msg(2, "UTR Number: \nThanks"),
    msg(3, "UTR will be shared tomorrow"),
    msg(4, ""),
  ]);
  assert.equal(r.status, "not_found");
  assert.equal(r.utr, null);
});

test("stripQuoted removes quoted lines and history headers", () => {
  const t = stripQuoted("Done\n> old\nOn 5 Jan 2026, A <a@b.c> wrote:\nhidden");
  assert.equal(t.trim(), "Done");
});

test("parseMessage decodes Base64URL multipart, prefers text/plain, falls back to html, survives empty", () => {
  const multipart = parseMessage({
    id: "m1", threadId: "t1", internalDate: "1767261600000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "f@x.com" }, { name: "Subject", value: "Get UTR Number" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64u("UTR: HDFC92023012200543116 ✓") } },
        { mimeType: "text/html", body: { data: b64u("<p>html version</p>") } },
      ],
    },
  });
  assert.equal(multipart.bodySource, "text/plain");
  assert.match(multipart.bodyText, /HDFC92023012200543116 ✓/);
  assert.equal(multipart.subject, "Get UTR Number");

  const htmlOnly = parseMessage({
    id: "m2", payload: { mimeType: "text/html", headers: [], body: { data: b64u("<div>UTR Number</div><div>HDFC92023012200543116</div>") } },
  });
  assert.equal(htmlOnly.bodySource, "text/html");
  assert.equal(extractUtrFromThread([htmlOnly]).utr, "HDFC92023012200543116");

  const empty = parseMessage({ id: "m3", payload: { mimeType: "multipart/mixed", headers: [], parts: [{ mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x" } }] } });
  assert.equal(empty.bodyText, "");
  assert.equal(empty.bodySource, "empty");
  assert.equal(decodeBase64Url(undefined), "");
});

// ── Bill Number flow (Gmail mocked, no network / database) ──────────────────
const { extractBillNumbers } = require("../utils/utrExtractor");
const Gmail = require("../utils/gmailService");
const GmailController = require("../controllers/Admin/GmailController/GmailController");

test("extractBillNumbers reads the bill number dynamically and ignores unrelated numbers / quoted text", () => {
  assert.deepEqual(extractBillNumbers("Grand Total ₹ 15,000\n\nBill Number : adinn0511202601"), ["adinn0511202601"]);
  assert.deepEqual(extractBillNumbers("Bill No. XYZ-77/2026-09 paid"), ["XYZ-77/2026-09"]);
  assert.deepEqual(extractBillNumbers("Invoice No: 202601234567 Bill Number is pending"), []);
  assert.deepEqual(extractBillNumbers("Thanks\n> Bill Number : adinn0511202601"), []);
});

const runBillFlow = async (threads, query = { subject: "Test CMD Approved" }) => {
  const orig = { searchThreads: Gmail.searchThreads, getThread: Gmail.getThread };
  Gmail.searchThreads = async (q) => threads.filter((t) => t.match(q)).map((t) => ({ id: t.id }));
  Gmail.getThread = async (id) => {
    const t = threads.find((x) => x.id === id);
    return { id, subject: t.subject, messages: t.messages };
  };
  let out;
  const res = { status() { return this; }, json(b) { out = b; return this; } };
  try {
    await GmailController.testUtr({ user: { userType: 3 }, query }, res);
  } finally {
    Object.assign(Gmail, orig);
  }
  return out;
};
const approvedThread = (id = "T1", bill = "adinn0511202601") => ({
  id, subject: "Test CMD Approved",
  match: (q) => q.includes("subject:") ? q.includes("Test CMD Approved") : q.includes(bill),
  messages: [msg(1, `Grand Total 15,000\nBill Number : ${bill}`)],
});

test("bill flow: approved mail -> Bill Number -> UTR from the reply in the same thread", async () => {
  const t = approvedThread();
  t.messages.push(msg(2, "Paid.\nUTR Number: HDFC92023012200543116\n> Bill Number : adinn0511202601"));
  const r = (await runBillFlow([t])).data;
  assert.equal(r.extractionStatus, "found");
  assert.equal(r.billNumber, "adinn0511202601");
  assert.equal(r.utr, "HDFC92023012200543116");
  assert.equal(r.gmailThreadId, "T1");
  assert.equal(r.sourceMessageId, 2);
});

test("bill flow: UTR in a separate conversation is used only when it contains the exact Bill Number", async () => {
  const sep = { id: "T2", subject: "Payment done", match: (q) => q.includes("adinn0511202601"), messages: [msg(1, "Bill Number: adinn0511202601\nUTR: SBIN12345678901234")] };
  const other = { id: "T3", subject: "UTR", match: (q) => q.includes("adinn0511202601"), messages: [msg(1, "UTR: ICIC99999999999999 for some other bill")] };
  const r = (await runBillFlow([approvedThread(), sep, other])).data;
  assert.equal(r.extractionStatus, "found");
  assert.equal(r.utr, "SBIN12345678901234");
  assert.equal(r.gmailThreadId, "T2");
  assert.equal(r.matchedThreads.length, 2); // approved + T2; T3 lacks the Bill Number, so it is rejected
});

test("bill flow: clear statuses, never a guess", async () => {
  assert.equal((await runBillFlow([approvedThread()])).data.extractionStatus, "utr_not_found");
  assert.equal((await runBillFlow([], {})).statusCode, 400);
  assert.equal((await runBillFlow([])).data.extractionStatus, "approved_mail_not_found");
  const noBill = { id: "T9", subject: "Test CMD Approved", match: () => true, messages: [msg(1, "no number here")] };
  assert.equal((await runBillFlow([noBill])).data.extractionStatus, "bill_number_not_found");
  const two = [approvedThread("A"), approvedThread("B", "adinn0611202601")];
  assert.equal((await runBillFlow(two)).data.extractionStatus, "multiple_approved_mails");

  const t1 = approvedThread();
  t1.messages.push(msg(2, "UTR: HDFC92023012200543116"));
  const t2 = { id: "T2", subject: "again", match: (q) => q.includes("adinn0511202601"), messages: [msg(1, "adinn0511202601 UTR: SBIN12345678901234")] };
  const multi = (await runBillFlow([t1, t2])).data;
  assert.equal(multi.extractionStatus, "multiple_review_required");
  assert.equal(multi.utr, null);
});

// ── Direct Bill Number mode (?billNumber=) ──────────────────────────────────
const direct = (threads, query) => runBillFlow(threads, query);
const bt = (id, text, extra = {}) => ({ id, subject: extra.subject || "Payment", match: (q) => q.includes("adinn0511202601"), messages: [msg(1, text)] });

test("direct billNumber: no subject / approved-mail lookup, UTR returned with source details", async () => {
  let subjectSearched = false;
  const t = bt("D1", "Bill Number : adinn0511202601\nUTR Number: HDFC92023012200543116");
  const orig = Gmail.searchThreads;
  const r = await runBillFlow([{ ...t, match: (q) => { if (q.includes("subject:")) subjectSearched = true; return q.includes("adinn0511202601"); } }], { billNumber: "adinn0511202601" });
  Gmail.searchThreads = orig;
  assert.equal(subjectSearched, false);
  assert.equal(r.data.extractionStatus, "found");
  assert.equal(r.data.utr, "HDFC92023012200543116");
  assert.equal(r.data.gmailThreadId, "D1");
  assert.equal(r.data.sourceMessageId, 1);
  assert.ok(r.data.senderEmail && r.data.messageDate);
  assert.equal(r.data.approvedMail, undefined);
});

test("direct billNumber: bill_not_found, utr_not_found, exact match only", async () => {
  assert.equal((await direct([], { billNumber: "adinn0511202601" })).data.extractionStatus, "bill_not_found");
  // Gmail returns a thread, but it only contains a LONGER code -> not an exact match
  const longer = bt("D2", "Bill Number : adinn051120260123\nUTR: HDFC92023012200543116");
  assert.equal((await direct([longer], { billNumber: "adinn0511202601" })).data.extractionStatus, "bill_not_found");
  // landlord / subject alone never matches: thread lacks the bill number
  const unrelated = { id: "D3", subject: "UTR Number", match: () => true, messages: [msg(1, "Landlord Ravi paid. UTR: SBIN12345678901234")] };
  assert.equal((await direct([unrelated], { billNumber: "adinn0511202601" })).data.extractionStatus, "bill_not_found");
  assert.equal((await direct([bt("D4", "Bill Number : adinn0511202601 pending")], { billNumber: "adinn0511202601" })).data.extractionStatus, "utr_not_found");
});

test("direct billNumber: several threads / different UTRs -> review, nothing picked", async () => {
  const a = bt("D5", "adinn0511202601 UTR: HDFC92023012200543116");
  const b = bt("D6", "adinn0511202601 UTR: SBIN12345678901234");
  const diff = (await direct([a, b], { billNumber: "adinn0511202601" })).data;
  assert.equal(diff.extractionStatus, "multiple_review_required");
  assert.equal(diff.utr, null);
  assert.equal(diff.candidates.length, 2);
  const same = bt("D7", "adinn0511202601 UTR: HDFC92023012200543116");
  assert.equal((await direct([a, same], { billNumber: "adinn0511202601" })).data.extractionStatus, "multiple_review_required"); // two conversations: still manual
  const mixed = bt("D8", "Bill Number : adinn0511202601\nBill Number : adinn0611202602\nUTR: HDFC92023012200543116");
  assert.equal((await direct([mixed], { billNumber: "adinn0511202601" })).data.extractionStatus, "ambiguous_bill_numbers");
});

test("validation: billNumber cannot be combined with other modes; bad format rejected", async () => {
  for (const q of [{ billNumber: "adinn0511202601", subject: "Test CMD Approved" }, { billNumber: "adinn0511202601", query: "x" }, { billNumber: "adinn0511202601", threadId: "T" }]) {
    const r = await direct([], q);
    assert.equal(r.statusCode, 400);
    assert.match(r.error || r.message, /cannot be combined|one search mode/);
  }
  assert.equal((await direct([], { billNumber: "abc" })).statusCode, 400);
  assert.equal((await direct([], { billNumber: "no-digits-here" })).statusCode, 400);
});

test("existing query and threadId modes still work", async () => {
  const t = { id: "Q1", subject: "Get UTR Number", match: (q) => q.includes("Get UTR Number"), messages: [msg(1, "UTR Number: HDFC92023012200543116")] };
  const byQuery = (await runBillFlow([t], { query: 'subject:"Get UTR Number"' })).data;
  assert.equal(byQuery.extractionStatus, "found");
  assert.equal(byQuery.utr, "HDFC92023012200543116");
  const byThread = (await runBillFlow([t], { threadId: "Q1" })).data;
  assert.equal(byThread.threadId, "Q1");
  assert.equal(byThread.utr, "HDFC92023012200543116");
  const two = [t, { ...t, id: "Q2" }];
  const origSummary = Gmail.getThreadSummary;
  Gmail.getThreadSummary = async (id) => ({ threadId: id });
  try {
    assert.equal((await runBillFlow(two, { query: 'subject:"Get UTR Number"' })).data.extractionStatus, "multiple_threads");
  } finally {
    Gmail.getThreadSummary = origSummary;
  }
});
