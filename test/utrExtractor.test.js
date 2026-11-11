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


// ── Bill Number-only API (Gmail mocked; no network, no database) ─────────────
const BILL = "adinn0511202601";
const gmailCalls = { search: [], getThread: [] };
// threads: [{ id, subject, messages }]. A thread is returned by search when its id is in `hitIds` (default: all).
const mockGmail = (threads, hitIds) => {
  const orig = { searchThreads: Gmail.searchThreads, getThread: Gmail.getThread };
  gmailCalls.search = [];
  gmailCalls.getThread = [];
  Gmail.searchThreads = async (q) => {
    gmailCalls.search.push(q);
    return threads.filter((t) => !hitIds || hitIds.includes(t.id)).map((t) => ({ id: t.id }));
  };
  Gmail.getThread = async (id) => {
    gmailCalls.getThread.push(id);
    const t = threads.find((x) => x.id === id);
    return { id, subject: t.subject, messages: t.messages };
  };
  return () => Object.assign(Gmail, orig);
};
const th = (id, ...bodies) => ({ id, subject: "Payment", messages: bodies.map((b, i) => msg(i + 1, b)) });

const call = async (query, threads = [], user = { userType: 3 }) => {
  const restore = mockGmail(threads);
  let out;
  const res = { status() { return this; }, json(b) { out = b; return this; } };
  try {
    await GmailController.testUtr({ user, query }, res);
  } finally {
    restore();
  }
  return out;
};

test("1. valid Bill Number returns the UTR with thread, message, sender and date; searches Gmail by the exact code only", async () => {
  const r = await call({ billNumber: BILL }, [th("T1", `Bill Number : ${BILL}\nTotal 15,000`, "Paid.\nUTR : HDFC92023012200543116")]);
  assert.equal(r.data.extractionStatus, "found");
  assert.equal(r.data.billNumber, BILL);
  assert.equal(r.data.utr, "HDFC92023012200543116");
  assert.equal(r.data.gmailThreadId, "T1");
  assert.equal(r.data.sourceMessageId, 2);
  assert.ok(r.data.senderEmail && r.data.messageDate);
  assert.deepEqual(gmailCalls.search, [`"${BILL}"`]); // one search: the exact Bill Number
});

test("10. no subject search and no approved-mail lookup happens internally", async () => {
  await call({ billNumber: BILL }, [th("T1", `Bill Number : ${BILL}`, "UTR: HDFC92023012200543116")]);
  assert.equal(gmailCalls.search.length, 1);
  assert.ok(gmailCalls.search.every((q) => !/subject:/i.test(q) && !/approved/i.test(q)));
  assert.deepEqual(gmailCalls.getThread, ["T1"]); // only threads returned by the Bill Number search are read
  assert.equal(typeof Gmail.getThreadSummary, "undefined"); // subject/query listing helper is gone
});

test("2. unknown Bill Number -> bill_not_found", async () => {
  assert.equal((await call({ billNumber: "adinn9999999999" }, [])).data.extractionStatus, "bill_not_found");
  // Gmail may return a thread, but if the code is not in any message body it is not a match
  const r = await call({ billNumber: BILL }, [th("T9", "Landlord Ravi paid. UTR: SBIN12345678901234")]);
  assert.equal(r.data.extractionStatus, "bill_not_found");
  assert.equal(r.data.utr, null);
});

test("3. exact matching: a longer similar Bill Number does not match", async () => {
  const r = await call({ billNumber: BILL }, [th("T2", "Bill Number : adinn051120260123\nUTR: HDFC92023012200543116")]);
  assert.equal(r.data.extractionStatus, "bill_not_found");
  const prefixed = await call({ billNumber: BILL }, [th("T3", "Bill Number : xadinn0511202601\nUTR: HDFC92023012200543116")]);
  assert.equal(prefixed.data.extractionStatus, "bill_not_found");
});

test("4. several conversations require manual review", async () => {
  const same = await call({ billNumber: BILL }, [th("A", `${BILL} UTR: HDFC92023012200543116`), th("B", `${BILL} UTR: HDFC92023012200543116`)]);
  assert.equal(same.data.extractionStatus, "multiple_review_required");
  assert.equal(same.data.utr, null);
  assert.equal(same.data.matchedThreads.length, 2);
});

test("5. several different UTRs require manual review", async () => {
  const across = await call({ billNumber: BILL }, [th("A", `${BILL} UTR: HDFC92023012200543116`), th("B", `${BILL} UTR: SBIN12345678901234`)]);
  assert.equal(across.data.extractionStatus, "multiple_review_required");
  assert.equal(across.data.candidates.length, 2);
  const within = await call({ billNumber: BILL }, [th("A", `${BILL}`, "UTR: HDFC92023012200543116", "UTR: SBIN12345678901234")]); // a different UTR WITHOUT correction wording stays manual (with wording see gmailUtrCorrection.test.js T18)
  assert.equal(within.data.extractionStatus, "multiple_review_required");
  assert.equal(within.data.utr, null);
});

test("6. several Bill Numbers in one conversation -> ambiguous_bill_numbers", async () => {
  const r = await call({ billNumber: BILL }, [th("A", `Bill Number : ${BILL}\nBill Number : adinn0611202602\nUTR: HDFC92023012200543116`)]);
  assert.equal(r.data.extractionStatus, "ambiguous_bill_numbers");
  assert.equal(r.data.utr, null);
  assert.deepEqual(r.data.matchedThreads[0].otherBillNumbers, ["adinn0611202602"]);
});

test("7. Bill Number found but no UTR -> utr_not_found", async () => {
  const r = await call({ billNumber: BILL }, [th("A", `Bill Number : ${BILL}`, "Approved, payment tomorrow.", "Invoice No: 202601234567")]);
  assert.equal(r.data.extractionStatus, "utr_not_found");
  assert.equal(r.data.utr, null);
});

test("8. missing / malformed Bill Number -> HTTP 400; removed search parameters rejected", async () => {
  for (const q of [{}, { billNumber: "" }, { billNumber: "abc" }, { billNumber: "no-digits-here" }, { billNumber: 'adinn"0511202601' }]) {
    const r = await call(q);
    assert.equal(r.statusCode, 400, JSON.stringify(q));
  }
  for (const extra of [{ subject: "Test CMD Approved" }, { query: "x" }, { threadId: "T" }, { approvedThreadId: "T" }]) {
    const r = await call({ billNumber: BILL, ...extra });
    assert.equal(r.statusCode, 400);
    assert.match(r.message, /Unsupported parameter/);
  }
  assert.equal(gmailCalls.search.length, 0); // rejected before any Gmail call
  assert.equal((await call({ billNumber: BILL }, [], { userType: 1 })).statusCode, 403); // CMD only
});

test("9. works over HTTP with CMD authentication (401 without a token, 403 for other roles)", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const express = require("express");
  const jwt = require("jsonwebtoken");
  const app = express();
  app.use("/api/gmail", require("../routes/Admin/GmailRoutes/GmailRoutes"));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const restore = mockGmail([th("H1", `Bill Number : ${BILL}`, "UTR : HDFC92023012200543116")]);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/gmail/test-utr?billNumber=${BILL}`;
    const token = (t) => "Bearer " + jwt.sign({ id: "u1", userType: t, userName: "t", userPhone: "9999999999" }, process.env.JWT_SECRET);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: token(1) } })).status, 403);
    const ok = await fetch(url, { headers: { Authorization: token(3) } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.data.extractionStatus, "found");
    assert.equal(body.data.utr, "HDFC92023012200543116");
    assert.equal((await fetch(url.replace(BILL, "abc"), { headers: { Authorization: token(3) } })).status, 400);
  } finally {
    restore();
    srv.close();
  }
});
