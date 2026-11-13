// MULTIPLE MONTHS in ONE Gmail thread, ONE common UTR: reply lines that name the Bill Number. Pure, no network, no database.
// Run: node --test test/gmailMultiMonthUtr.test.js
process.env.JWT_SECRET = "test-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scopeThreadToBill } = require("../utils/gmailReplyLink");
const { extractBillLines } = require("../utils/billLines");
const { extractLandlordUtrLines, mapPaymentKinds, mapLandlordKinds, mapArrearsLines } = require("../utils/landlordUtrParser");
const { extractCashLines } = require("../utils/utrExtractor");
const { utrAlreadyUsed } = require("../utils/utrProcessor");

const B1 = "ADNOOHBILL0911202691";
const B2 = "ADNOOHBILL1011202692";
const B3 = "ADNOOHBILL1111202693";
const U = "UTR432423443";
const G = "UTR873247343";
const approval = (id, bill) => ({ id, messageIdHeader: `<${id}@x>`, inReplyTo: "", bodyText: `Owner Name | Landlord1 | Bank Name | SBI\nBill Number : ${bill}`, sentAt: "2026-11-05T05:00:00.000Z" });
const reply = (id, parent, text) => ({ id, messageIdHeader: `<${id}@x>`, inReplyTo: `<${parent}@x>`, bodyText: text, sentAt: "2026-11-10T05:00:00.000Z", from: "Finance <f@x.com>" });
const thread = (text) => [approval("a1", B1), approval("a2", B2), approval("a3", B3), reply("r1", "a3", text)]; // one reply, answering the LAST approval mail

test("MM1. one reply lists every bill: each bill gets ONLY its own line, as an ordinary reply line, whichever approval mail was answered", () => {
  const msgs = thread(`Landlord1 - ${B1} : ${U}\nLandlord1 - ${B2} : ${U}\nLandlord1 - ${B3} : ${U}`);
  for (const b of [B1, B2, B3]) {
    const s = scopeThreadToBill(msgs, b);
    assert.equal(s.status, "scoped");
    assert.equal(s.messages.length, 2);
    assert.equal(s.messages[1].bodyText, `Landlord1 - UTR : ${U}`);
    assert.equal(s.messages[1].explicitBill, true);
    assert.deepEqual(extractLandlordUtrLines(s.messages[1].bodyText).map((l) => [l.name, l.utr]), [["Landlord1", U]]);
    assert.deepEqual(s.link.commonUtrBills[U].sort(), [B1, B2, B3].map((x) => x.toLowerCase()));
  }
});

test("MM2. a bill that is NOT named in the reply gets nothing (no guessing, no 'unlinked')", () => {
  const msgs = thread(`Landlord1 - ${B1} : ${U}\nLandlord1 - ${B3} : ${U}`);
  const s = scopeThreadToBill(msgs, B2);
  assert.equal(s.status, "scoped");
  assert.equal(s.messages.length, 1); // only the approval mail
});

test("MM3. GST on hold: Rent and GST lines of each bill are kept apart; Cash line works; Paid Date text is kept", () => {
  const msgs = thread(`Landlord1 - ${B1} : ${U}\nLandlord1 - ${B2} : ${U}\nLandlord1 - GST - ${B1} : ${G}\nLandlord1 - GST - ${B2} : ${G}\nLandlord2 - ${B1} : Cash - Paid Date: 09-Nov-2026`);
  const s = scopeThreadToBill(msgs, B1);
  assert.equal(s.messages[1].bodyText, [`Landlord1 - UTR : ${U}`, `Landlord1 - GST - UTR : ${G}`, "Landlord2 - Cash - Paid Date: 09-Nov-2026"].join("\n"));
  assert.deepEqual(extractCashLines(s.messages[1].bodyText).map((c) => c.name), ["Landlord2 - Cash"]);
  assert.deepEqual(s.link.commonUtrBills[G].sort(), [B1, B2].map((x) => x.toLowerCase()));
});

test("MM4. only Bill Numbers of the thread's approval mails are recognised; an approval mail is never read as a reply", () => {
  assert.equal(extractBillLines(`Landlord1 - ADNOOHBILL9999999999 : ${U}`, [B1, B2]).length, 0);
  assert.equal(extractBillLines(`Bill Number : ${B2}`, [B1, B2]).length, 0); // no UTR after the Bill Number
  assert.deepEqual(extractBillLines(`Landlord1 - Bill No : ${B1} - UTR : ${U}`, [B1]).map((l) => [l.name, l.utr]), [["Landlord1", U]]);
});

test("MM5. mappers: a bill-numbered line without GST is the RENT UTR of a GST-on-hold bill, with GST it is the GST UTR; wrong landlord is skipped", () => {
  const L = { landOwnerId: "o1", name: "Landlord1" };
  const rep = (text) => [{ messageId: "m", billExplicit: true, lines: extractLandlordUtrLines(text) }];
  const k = mapPaymentKinds(rep(`Landlord1 - UTR : ${U}\nLandlord1 - GST - UTR : ${G}`), L);
  assert.deepEqual([k.byKind.rent.utr, k.byKind.gst.utr], [U, G]);
  assert.equal(mapPaymentKinds(rep(`Stranger - UTR : ${U}`), L).byKind.rent, null);
  const mk = mapLandlordKinds(rep(`Landlord1 - UTR : ${U}\nLandlord1 - GST - UTR : ${G}`), [L]);
  assert.equal(mk.byKey.get("o1|rent")[0].utr, U);
  assert.equal(mk.byKey.get("o1|gst")[0].utr, G);
  const ma = mapArrearsLines(rep(`Landlord1 - UTR : ${U}`), [L], { billType: "newBill", gstHold: true });
  assert.equal(ma.byKey.get("o1|rent")[0].utr, U);
  // a line with NO name at all is still never used on a GST-hold bill
  const plain = mapArrearsLines([{ messageId: "m", lines: extractLandlordUtrLines(`UTR : ${U}`) }], [L], { billType: "newBill", gstHold: true });
  assert.equal(plain.byKey.size, 0);
});

test("MM6. the same UTR stored on another bill is NOT a duplicate only when the reply listed it for that bill; any other copy still is", () => {
  const media = {
    rentalDue: [{ _id: "d1", adinn_ooh_bills: B1 }, { _id: "d2", adinn_ooh_bills: B2 }, { _id: "d9", adinn_ooh_bills: "ADNOOHBILL0101202699" }],
    ledger: [{ rentalDueId: "d1", utrNumber: U }],
  };
  assert.equal(utrAlreadyUsed(media, U), true); // no list: unchanged behaviour
  assert.equal(utrAlreadyUsed(media, U, { allowBills: [B1.toLowerCase(), B2.toLowerCase()] }), false);
  media.ledger.push({ rentalDueId: "d9", utrNumber: U }); // also stored on an UNRELATED bill
  assert.equal(utrAlreadyUsed(media, U, { allowBills: [B1.toLowerCase(), B2.toLowerCase()] }), true);
});

test("MM7. a landlord whose OWN name ends in 'gst' ('L1 with gst'): its Rent line is never read as GST", () => {
  const L = [{ landOwnerId: "o1", name: "L1 with gst" }];
  const rep = (t) => [{ messageId: "m", lines: extractLandlordUtrLines(t) }];
  const keys = (m) => [...m.byKey.entries()].map(([k, v]) => [k, v.map((x) => x.utr)]);
  assert.deepEqual(keys(mapLandlordKinds(rep(`L1 with gst - Rent - UTR : ${U}\nL1 with gst - GST - UTR : ${G}`), L)), [["o1|rent", [U]], ["o1|gst", [G]]]);
  assert.deepEqual(keys(mapLandlordKinds(rep(`L1 with gst - UTR : ${U}`), L)), [["o1|rent", [U]]]); // named, no GST word: the RENT UTR, never GST
  assert.deepEqual(keys(mapArrearsLines(rep(`L1 with gst - Rent - UTR : ${U}\nL1 with gst - GST - UTR : ${G}`), L, { billType: "newBill", gstHold: true })), [["o1|rent", [U]], ["o1|gst", [G]]]);
  const k = mapPaymentKinds(rep(`L1 with gst - Rent - UTR : ${U}\nL1 with gst - GST - UTR : ${G}`), L[0]);
  assert.deepEqual([k.byKind.rent.utr, k.byKind.gst.utr], [U, G]);
});

test("MM8. the bank-approval mail is recognised in the ways Finance really writes it; approval mails and unrelated text are not", () => {
  const { APPROVED_BANK } = require("../utils/gmailUtrLookup");
  for (const t of ["Approved through this bank.", "Approved thro axis bank.", "Approved thru HDFC Bank", "approved through the bank", "Approved  through  Axis  Bank\n\nThanks"]) assert.equal(APPROVED_BANK.test(t), true, t);
  for (const t of ["Approved by the CMD", "Bank Reference NEFT", "Payment approved. Kindly pay", "Approved for payment of the bank charges"]) assert.equal(APPROVED_BANK.test(t), false, t);
});

test("MM9. correction check: a bill-numbered line (no GST word) is the RENT UTR - it is not 'several payments' when the landlord also has a GST payment", () => {
  const { mapLineToSlot } = require("../utils/utrCorrection");
  const L = [{ landOwnerId: "o1", name: "Aran" }];
  const stored = { flow: "rental", landlords: L, slots: new Map([["o1|rent", { key: "o1|rent", landOwnerId: "o1", kind: "rent", utrs: [U] }], ["o1|gst", { key: "o1|gst", landOwnerId: "o1", kind: "gst", utrs: [G] }]]) };
  const line = (name, explicit) => ({ name, message: { explicitBill: explicit } });
  assert.equal(mapLineToSlot(line("Aran", true), stored).slot.key, "o1|rent");
  assert.equal(mapLineToSlot(line("Aran - GST", true), stored).slot.key, "o1|gst");
  assert.equal(mapLineToSlot(line("Aran", false), stored).slot.key, "o1|rent"); // named, no GST word: Rent
  assert.equal(mapLineToSlot(line("", false), stored).error, "line_matches_several_payments"); // no name and no label: ambiguous
});

test("MM10. a reply that answers an OLDER non-approval mail of the thread is not about this bill: it is ignored, it does not block the bill", () => {
  const old = { id: "x0", messageIdHeader: "<x0@x>", inReplyTo: "", bodyText: "CMD Payment Approved - cancelled mail, no bill number" };
  const stray = reply("x1", "x0", `Dhoni - UTR : ${U}`);
  const msgs = [old, stray, approval("a3", B3)];
  const s = scopeThreadToBill(msgs, B3);
  assert.equal(s.status, "scoped");
  assert.equal(s.messages.length, 1); // only the approval mail: the stray UTR is not used for it
  // a reply with NO traceable parent still blocks (unknown)
  const lost = { ...reply("x2", "nope", `Dhoni - UTR : ${U}`) };
  assert.equal(scopeThreadToBill([old, lost, approval("a3", B3)], B3).status, "unlinked");
});

test("MM11. wrong landlord name first, right name later: the wrong-name UTR is dropped, the later correct one is taken; wrong names only = nothing", async () => {
  const Gmail = require("../utils/gmailService");
  const { lookupUtrByBillNumber } = require("../utils/gmailUtrLookup");
  const keep = [Gmail.searchThreads, Gmail.getThread, Gmail.isUsableMessage];
  const appr = { id: "a", messageIdHeader: "<a@x>", inReplyTo: "", bodyText: `Owner Name | TEST 1 | Bank Name | SBI\nBill Number : ${B3}`, sentAt: "2026-11-13T04:00:00.000Z" };
  const mk = (id, text, at) => ({ id, messageIdHeader: `<${id}@x>`, inReplyTo: "<a@x>", bodyText: text, sentAt: at, date: at, from: "F <f@x.com>" });
  const run = async (msgs) => {
    Gmail.searchThreads = async () => [{ id: "T" }];
    Gmail.getThread = async () => ({ id: "T", messages: [appr, ...msgs] });
    Gmail.isUsableMessage = () => true;
    return lookupUtrByBillNumber(B3, 10, { landlords: [{ landOwnerId: "o1", name: "TEST 1" }] });
  };
  try {
    const both = await run([mk("r1", "Dhoni - UTR : UTR1111111111", "2026-11-13T05:30:00.000Z"), mk("r2", "TEST 1 - UTR : UTR2222222222", "2026-11-13T05:40:00.000Z")]);
    assert.equal(both.data.extractionStatus, "found");
    assert.equal(both.data.utr, "UTR2222222222");
    const only = await run([mk("r1", "Dhoni - UTR : UTR1111111111", "2026-11-13T05:30:00.000Z")]);
    assert.equal(only.data.extractionStatus, "wrong_landlord_name");
  } finally { [Gmail.searchThreads, Gmail.getThread, Gmail.isUsableMessage] = keep; }
});

test("MM12. GST hold, ONE landlord ('Landlord with gst'): 'Name - UTR : X' is the Rent UTR and 'Name - GST - UTR : Y' the GST UTR; the correction check never turns the GST UTR into the Rent one", () => {
  const { mapLineToSlot } = require("../utils/utrCorrection");
  const L = { landOwnerId: "o1", name: "Landlord with gst" };
  const rep = (t) => [{ messageId: "m", lines: extractLandlordUtrLines(t) }];
  const k = mapPaymentKinds(rep(`Landlord with gst - UTR : RENT743847348\nLandlord with gst - GST - UTR : GST84397438434`), L);
  assert.deepEqual([k.byKind.rent.utr, k.byKind.gst.utr], ["RENT743847348", "GST84397438434"]);
  const stored = { flow: "rental", landlords: [L], slots: new Map([["o1|gst", { key: "o1|gst", landOwnerId: "o1", kind: "gst", utrs: ["GST84397438434"] }]]) };
  // only the GST payment is stored so far: the Rent line must NOT be matched to it
  assert.equal(mapLineToSlot({ name: "Landlord with gst", message: {} }, stored).error, "line_matches_no_paid_payment");
  assert.equal(mapLineToSlot({ name: "Landlord with gst - GST", message: {} }, stored).slot.key, "o1|gst");
});

test("MM13. the GST / Rent word is read only AFTER the landlord name: 'gst' inside the name is never a label", () => {
  const { splitNameKind } = require("../utils/landlordUtrParser");
  const L = [{ landOwnerId: "o1", name: "Landlord with gst" }, { landOwnerId: "o2", name: "A-B Traders" }];
  const k = (n) => { const r = splitNameKind(n, L); return [r.landlord, r.kind]; };
  assert.deepEqual(k("Landlord with gst"), ["Landlord with gst", null]);
  assert.deepEqual(k("Landlord with gst - GST"), ["Landlord with gst", "gst"]);
  assert.deepEqual(k("Landlord with gst-GST"), ["Landlord with gst", "gst"]);
  assert.deepEqual(k("Landlord with gst - Rent"), ["Landlord with gst", "rent"]);
  assert.deepEqual(k("Landlord with - GST"), ["Landlord with", "gst"]); // partial name + GST: still GST
  assert.deepEqual(k("A-B Traders"), ["A-B Traders", null]);
});
