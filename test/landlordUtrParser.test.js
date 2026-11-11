// Multi-landlord reply parsing, name matching, approval-mail landlord blocks and the Gmail landlord lookup.
// No network, no database. Run: node --test test/landlordUtrParser.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { nameTokens, matchLandlord, extractLandlordUtrLines, mapLandlords, parseApprovalMailLandlords, validateAgainstMail } = require("../utils/landlordUtrParser");
const { findUtrInLine } = require("../utils/utrExtractor");
const Gmail = require("../utils/gmailService");
const { lookupLandlordUtrs } = require("../utils/gmailUtrLookup");

const J = "SBIN92023012200543116";
const S = "HDFC92023012200543117";
const M = "ICIC92023012200543118";

test("P1. the finance format, with and without Paid Date, quoted history ignored", () => {
  const text = [
    `K. Jamuna - UTR: ${J} - Paid Date: 10-Nov-2026`,
    `K. Suresh - UTR: ${S} - Paid Date: 10-Nov-2026`,
    `K. Murali - UTR: ${M}`,
    "",
    "On Mon, Nov 9, 2026 at 6:58 PM CMD Approved <noreply@adinndigital.com> wrote:",
    `> Jamuna - UTR: SBIN00000000000000001`,
  ].join("\n");
  const lines = extractLandlordUtrLines(text);
  assert.deepEqual(lines.map((l) => [l.name, l.utr, l.dates.map((d) => d.date)]), [
    ["K. Jamuna", J, ["2026-11-10"]],
    ["K. Suresh", S, ["2026-11-10"]],
    ["K. Murali", M, []],
  ]);
});

test("P2. other ways to write a line: bullets, numbers, colon / dash separators, UTR Number label, no name", () => {
  const lines = extractLandlordUtrLines([`1. Jamuna : UTR Number: ${J}`, `- Suresh – UTR : ${S}`, `* Murali - Transaction Reference Number: ${M}`, `UTR : HDFC92023012200543999`].join("\n"));
  assert.deepEqual(lines.map((l) => l.name), ["Jamuna", "Suresh", "Murali", ""]);
  assert.equal(findUtrInLine("nothing here"), null);
  assert.equal(findUtrInLine("UTR: 12345"), null); // too short is not a UTR
});

test("P3. optional bank / account typed on the line are read", () => {
  const [l] = extractLandlordUtrLines(`Jamuna - UTR: ${J} - A/c: 43765128647 - Bank: SBI - Paid Date: 10-Nov-2026`);
  assert.equal(l.accountLast4, "8647");
  assert.equal(l.bank, "SBI");
  assert.equal(l.dates[0].date, "2026-11-10");
});

test("N1. names: brackets ignored, whole words, initials alone are not enough", () => {
  assert.deepEqual(nameTokens("K.Thilagam (Kingads)"), ["K", "THILAGAM"]);
  const ll = [{ landOwnerId: "1", name: "K. Jamuna" }, { landOwnerId: "2", name: "K. Suresh" }, { landOwnerId: "3", name: "SUNIL KUMAR SANCHETI" }];
  assert.equal(matchLandlord("Jamuna", ll).landlord.landOwnerId, "1");
  assert.equal(matchLandlord("Jamuna", ll).matchedBy, "first_name");
  assert.equal(matchLandlord("K. Jamuna", ll).matchedBy, "full_name");
  assert.equal(matchLandlord("sunil", ll).landlord.landOwnerId, "3");
  assert.equal(matchLandlord("Sun", ll).error, "landlord_name_not_found"); // not a whole word
  assert.equal(matchLandlord("K", ll).error, "landlord_name_too_short");
  assert.equal(matchLandlord("", ll).error, "unnamed_utr_line");
  assert.equal(matchLandlord("Ramesh", ll).error, "landlord_name_not_found");
});

test("N2. a shared first name is ambiguous; the exact full name still resolves it", () => {
  const ll = [{ landOwnerId: "1", name: "K. Suresh" }, { landOwnerId: "2", name: "R. Suresh" }, { landOwnerId: "3", name: "K. Suresh Kumar" }];
  assert.equal(matchLandlord("Suresh", ll).error, "landlord_name_ambiguous");
  assert.equal(matchLandlord("R. Suresh", ll).landlord.landOwnerId, "2");
  assert.equal(matchLandlord("K. Suresh", ll).landlord.landOwnerId, "1"); // exact words beat the longer name that merely contains them
  const twins = [{ landOwnerId: "1", name: "K. Suresh" }, { landOwnerId: "2", name: "K.SURESH" }];
  assert.equal(matchLandlord("K. Suresh", twins).error, "landlord_name_ambiguous"); // identical names can never be told apart
});

test("N3. mapLandlords is all-or-nothing and reports every problem", () => {
  const ll = [{ landOwnerId: "1", name: "K. Jamuna", state: "pending" }, { landOwnerId: "2", name: "K. Suresh", state: "pending" }, { landOwnerId: "3", name: "K. Murali", state: "settled", storedUtr: M }];
  const ok = mapLandlords(extractLandlordUtrLines(`Jamuna - UTR: ${J}\nSuresh - UTR: ${S}\nMurali - UTR: ${M}`), ll);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.mappings.map((m) => m.landlord.landOwnerId), ["1", "2", "3"]);
  const bad = mapLandlords(extractLandlordUtrLines(`Jamuna - UTR: ${J}\nJamuna - UTR: ${S}\nRamesh - UTR: ${M}`), ll);
  assert.deepEqual(bad.reasons.map((r) => r.reason).sort(), ["conflicting_utr_for_landlord", "landlord_name_not_found", "missing_landlord_utr"]);
  assert.equal(mapLandlords(extractLandlordUtrLines(`Jamuna - UTR: ${J}\nSuresh - UTR: ${J}`), ll).reasons[0].reason, "duplicate_utr");
});

// the real layout of the approval mail (HTML turned into text; digits shortened/masked)
const APPROVAL = `CMD Payment Approved Hello Team, Bill No: ADNOOHBILL1811202695
 LO
 Landlord Details (3)
 LAND OWNER 01 - K. Jamuna
 Owner and Bank Details
 S.No | 1 | Owner Name | K. Jamuna | Phone | 93******34 | Bank Name | SBI | IFSC Code | SBIN0000001 | Account No | 43765128647 | PAN Number | – | Payment Category | Online |
 LAND OWNER 02 - K. Suresh
 S.No | 2 | Owner Name | K. Suresh | Phone | 98******11 | Bank Name | HDFC | IFSC Code | HDFC0000002 | Account No | 50100779876355 | PAN Number | – | Payment Category | Online |
 LAND OWNER 03 - K. Murali
 S.No | 3 | Owner Name | K. Murali | Phone | 97******22 | Bank Name | ICICI | IFSC Code | ICIC0000003 | Account No | 240801506039 | PAN Number | – | Payment Category | Online |
 MD
 Media Details
 Media Code | ADINCHN0216 | Media Name | ECR Injambakkam |`;

test("A1. the landlord blocks of the original approval mail are parsed", () => {
  const l = parseApprovalMailLandlords(APPROVAL);
  assert.deepEqual(l, [
    { name: "K. Jamuna", bank: "SBI", accountLast4: "8647" },
    { name: "K. Suresh", bank: "HDFC", accountLast4: "6355" },
    { name: "K. Murali", bank: "ICICI", accountLast4: "6039" },
  ]);
  assert.deepEqual(parseApprovalMailLandlords("no landlord section"), []);
  // masked account numbers (02**********95) still give the last digits that are visible
  assert.equal(parseApprovalMailLandlords("Owner Name | X Y | Bank Name | PNB | Account No | 02**********95 | PAN").length, 1);
});

test("A2. approval mail vs RMS: name, bank, account must agree; a missing landlord is a mismatch; an unreadable mail is n/a", () => {
  const rms = [{ name: "K. Jamuna", bankName: "SBI", accountLast4: "8647" }, { name: "K. Suresh", bankName: "HDFC", accountLast4: "6355" }, { name: "K. Murali", bankName: "ICICI", accountLast4: "6039" }];
  assert.equal(validateAgainstMail(parseApprovalMailLandlords(APPROVAL), rms).status, "ok");
  assert.equal(validateAgainstMail(parseApprovalMailLandlords(APPROVAL), [{ ...rms[0], accountLast4: "1111" }, rms[1], rms[2]]).problems[0].reason, "account_mismatch_approval_mail");
  assert.equal(validateAgainstMail(parseApprovalMailLandlords(APPROVAL), [{ ...rms[0], bankName: "AXIS" }, rms[1], rms[2]]).problems[0].reason, "bank_mismatch_approval_mail");
  assert.equal(validateAgainstMail(parseApprovalMailLandlords(APPROVAL).slice(0, 2), rms).problems[0].reason, "not_listed_in_approval_mail");
  assert.equal(validateAgainstMail([], rms).status, "n/a");
});

// ── the Gmail landlord lookup on a realistic thread (Gmail mocked) ──
const BILL = "ADNOOHBILL1811202695";
const mail = (id, body, sentAt) => ({ id, from: "x", to: "", subject: "s", date: sentAt, sentAt, bodyText: body });
const withThread = async (messages, fn) => {
  const save = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "CMD Approved", messages });
  try { return await fn(); } finally { Gmail.searchThreads = save.s; Gmail.getThread = save.g; }
};
const quotedApproval = APPROVAL.split("\n").map((l) => "> " + l).join("\n");

test("L1. approval mail + ONE finance reply: lines, sent date and mail landlords come back; quoted approval text is not a second mail", async () => {
  const reply = `Jamuna - UTR: ${J} - Paid Date: 10-Nov-2026\nSuresh - UTR: ${S}\nMurali - UTR: ${M}\n\nOn Mon, Nov 9, 2026 at 6:58 PM CMD Approved wrote:\n${quotedApproval}`;
  const r = await withThread([mail("m1", APPROVAL, "2026-11-09T13:26:54.000Z"), mail("m2", reply, "2026-11-10T05:00:00.000Z")], () => lookupLandlordUtrs(BILL));
  assert.equal(r.data.extractionStatus, "found");
  assert.equal(r.data.approvalMailLandlords.length, 3);
  assert.equal(r.data.replies.length, 1);
  assert.equal(r.data.replies[0].messageId, "m2");
  assert.equal(r.data.replies[0].sentDate, "2026-11-10");
  assert.deepEqual(r.data.replies[0].lines.map((l) => l.name), ["Jamuna", "Suresh", "Murali"]);
});

test("L2. no reply yet, several conversations, other Bill Numbers, unknown bill", async () => {
  const none = await withThread([mail("m1", APPROVAL, "2026-11-09T13:26:54.000Z")], () => lookupLandlordUtrs(BILL));
  assert.equal(none.data.extractionStatus, "utr_not_found");
  const other = await withThread([mail("m1", APPROVAL + " Bill No: ADNOOHBILL1811202696", "2026-11-09T13:26:54.000Z")], () => lookupLandlordUtrs(BILL));
  assert.equal(other.data.extractionStatus, "ambiguous_bill_numbers");
  const missing = await withThread([mail("m1", "unrelated", "2026-11-09T13:26:54.000Z")], () => lookupLandlordUtrs(BILL));
  assert.equal(missing.data.extractionStatus, "bill_not_found");
  const save = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }, { id: "T2" }];
  Gmail.getThread = async (id) => ({ id, subject: "s", messages: [mail("m" + id, APPROVAL, "2026-11-09T13:26:54.000Z")] });
  try { assert.equal((await lookupLandlordUtrs(BILL)).data.extractionStatus, "multiple_review_required"); } finally { Gmail.searchThreads = save.s; Gmail.getThread = save.g; }
});

const { classifyPaymentLabel, mapPaymentKinds } = require("../utils/landlordUtrParser");

test("K1. payment labels: rent / gst spellings, anything else is not a kind", () => {
  for (const l of ["Rent", "rent", "Base Rent", "BASE RENT", "Rental", "Rent Amount"]) assert.equal(classifyPaymentLabel(l), "rent", l);
  for (const l of ["GST", "gst", "Gst Amount", "GST (18%)"]) assert.equal(classifyPaymentLabel(l), "gst", l);
  for (const l of ["", "UTR", "TDS", "Rent GST", "K. Jamuna", "Rented"]) assert.equal(classifyPaymentLabel(l), null, l);
});

test("K2. mapPaymentKinds: kinds across several replies, earliest reply wins, conflicts and duplicates reported", () => {
  const r = (id, text) => ({ messageId: id, sentDate: "2026-11-03", lines: extractLandlordUtrLines(text) });
  const a = mapPaymentKinds([r("1", `Rent - UTR: ${J}`), r("2", `GST - UTR: ${S}`), r("3", `Rent - UTR: ${J}`)]);
  assert.deepEqual([a.byKind.rent.utr, a.byKind.rent.reply.messageId, a.byKind.gst.utr, a.byKind.gst.reply.messageId], [J, "1", S, "2"]);
  assert.deepEqual([a.conflicts, a.dupBoth], [[], false]);
  const b = mapPaymentKinds([r("1", `Rent - UTR: ${J}`), r("2", `Rent - UTR: ${S}`)]);
  assert.deepEqual(b.conflicts, ["rent"]);
  assert.equal(b.byKind.rent, null);
  assert.equal(mapPaymentKinds([r("1", `Rent - UTR: ${J}\nGST - UTR: ${J}`)]).dupBoth, true);
  assert.deepEqual(mapPaymentKinds([r("1", `UTR : ${J}\nJamuna - UTR: ${S}`)]).ignored.map((x) => x.reason), ["unlabelled_utr_line", "label_is_not_rent_or_gst"]);
});
