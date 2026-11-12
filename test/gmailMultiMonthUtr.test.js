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
  // an ordinary (not bill-numbered) unlabelled line is still never used on a GST-hold bill
  const plain = mapArrearsLines([{ messageId: "m", lines: extractLandlordUtrLines(`Landlord1 - UTR : ${U}`) }], [L], { billType: "newBill", gstHold: true });
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
  assert.deepEqual(keys(mapLandlordKinds(rep(`L1 with gst - UTR : ${U}`), L)), []); // unlabelled on a GST-hold bill: never GST, simply not used
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
  assert.equal(mapLineToSlot(line("Aran", false), stored).error, "line_matches_several_payments"); // an ordinary unlabelled line stays ambiguous
});
