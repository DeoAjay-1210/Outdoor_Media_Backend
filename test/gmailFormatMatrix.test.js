// FULL FORMAT MATRIX: every reply format x every flow, through the real parsers / mappers. Pure: no network, no database.
// Run: node --test test/gmailFormatMatrix.test.js
process.env.JWT_SECRET = "test-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../utils/landlordUtrParser");
const { extractCashLines } = require("../utils/utrExtractor");
const { extractBillLines, billLinesAsReply } = require("../utils/billLines");

const U1 = "UTR111111111111";
const U2 = "UTR222222222222";
const G1 = "GST333333333333";
const lines = (t) => [{ messageId: "m", lines: P.extractLandlordUtrLines(t) }];
const keys = (m) => [...m.byKey.entries()].map(([k, v]) => `${k}=${v.map((x) => x.utr).join("+")}`).sort();

// ── 1. ONE landlord, no GST: the name check on the UTR line (any spacing / dash / colon) ──
test("F1. UTR line spellings: name + UTR is read with or without spaces, any dash, case; a value without a label or without a digit is not a UTR", () => {
  const ok = [
    "Aran - UTR : UTR132587456123", "Aran-UTR:UTR132587456123", "Aran – UTR: UTR132587456123", "aran - utr : UTR132587456123",
    "Aran : UTR = UTR132587456123", "Aran UTR UTR132587456123", "- Aran - UTR : UTR132587456123", "1. Aran - UTR No : UTR132587456123,",
    "Aran - Transaction Reference Number: UTR132587456123", "Aran - UTR : 1325ASD", "Aran - UTR : jfiew4343", "UTR : UTR7843274",
  ];
  for (const t of ok) assert.equal(P.extractLandlordUtrLines(t).length, 1, t);
  assert.equal(P.extractLandlordUtrLines("Aran - UTR : UTR132587456123")[0].name, "Aran");
  assert.equal(P.extractLandlordUtrLines("UTR : UTR132587456123")[0].name, "");
  for (const t of ["Aran - UTR : pending", "Aran - UTR : NA", "Aran - UTR : 12", "Aran 132587456123", "Aran-UTR132587456123x y"]) {
    assert.equal(P.extractLandlordUtrLines(t).filter((l) => /\d/.test(l.utr) && l.utr.length >= 5).length <= 1, true, t);
  }
  for (const t of ["Aran - UTR : pending", "Aran - UTR : NA", "Aran - UTR : 12", "Aran 132587456123"]) assert.equal(P.extractLandlordUtrLines(t).length, 0, t);
});

// ── 2. several landlords, no GST (mapLandlords: all-or-nothing, by name) ──
test("F2. several landlords, no GST: each name -> its own UTR; wrong / ambiguous / short / missing name = nothing; Cash-only landlord is not a UTR line", () => {
  const L = [{ landOwnerId: "a", name: "Multiple Landlord 1 Without GST", state: "pending" }, { landOwnerId: "b", name: "Multiple Landlord 2 Without GST", state: "pending" }];
  const m = (t) => P.mapLandlords(P.extractLandlordUtrLines(t), L);
  const good = m(`Multiple Landlord 2 Without GST  - UTR : ${U2},\nMultiple Landlord 1 Without GST  - UTR :  ${U1}`);
  assert.equal(good.ok, true);
  assert.deepEqual(good.mappings.map((x) => [x.landlord.landOwnerId, x.line.utr]).sort(), [["a", U1], ["b", U2]]);
  assert.equal(m(`Multiple Landlord 1 Without GST-UTR:${U1}\nMultiple Landlord 2 Without GST-UTR:${U2}`).ok, true); // no spaces
  assert.equal(m(`Landlord 1 - UTR : ${U1}\nLandlord 2 - UTR : ${U2}`).ok, true); // not the whole name but whole words of exactly one landlord each
  assert.equal(m(`Zed - UTR : ${U1}\nMultiple Landlord 2 Without GST - UTR : ${U2}`).ok, false); // unknown name
  assert.equal(m(`Multiple - UTR : ${U1}\nMultiple Landlord 2 Without GST - UTR : ${U2}`).reasons[0].reason, "landlord_name_ambiguous");
  assert.equal(m(`M - UTR : ${U1}\nMultiple Landlord 2 Without GST - UTR : ${U2}`).reasons[0].reason, "landlord_name_too_short");
  assert.equal(m(`UTR : ${U1}\nMultiple Landlord 2 Without GST - UTR : ${U2}`).ok, false); // nameless line
  assert.equal(m(`Multiple Landlord 1 Without GST - UTR : ${U1}`).ok, false); // a landlord has no line
  assert.equal(m(`Multiple Landlord 1 Without GST - UTR : ${U1}\nMultiple Landlord 2 Without GST - UTR : ${U1}`).ok, false); // same UTR for two landlords
});

// ── 3. ONE landlord, GST on hold (mapPaymentKinds) ──
test("F3. single landlord, GST hold: 'Name - UTR' = Rent, 'Name - GST - UTR' = GST, 'Rent - UTR' / 'GST - UTR' too; 'gst' inside the name is never a label; nameless = unused", () => {
  for (const name of ["Aran", "Landlord with gst"]) {
    const L = { landOwnerId: "o", name };
    const k = (t) => P.mapPaymentKinds(lines(t), L).byKind;
    for (const t of [`${name} - UTR : ${U1}\n${name} - GST - UTR : ${G1}`, `${name}-UTR:${U1}\n${name}-GST-UTR:${G1}`, `${name} - Rent - UTR : ${U1}\n${name} - GST - UTR : ${G1}`, `Rent - UTR : ${U1}\nGST - UTR : ${G1}`]) {
      const r = k(t);
      assert.deepEqual([r.rent && r.rent.utr, r.gst && r.gst.utr], [U1, G1], t);
    }
    assert.equal(k(`UTR : ${U1}`).rent, null); // no name, no label: unused
    assert.equal(k(`Stranger - UTR : ${U1}`).rent, null); // other landlord
    assert.equal(k(`Stranger - GST - UTR : ${G1}`).gst, null);
  }
});

// ── 4. several landlords, GST hold (mapLandlordKinds) ──
test("F4. several landlords, GST hold: every landlord gets Rent and GST apart; wrong / short names are problems", () => {
  const L = [{ landOwnerId: "a", name: "Ravi Kumar" }, { landOwnerId: "b", name: "Suresh Babu" }];
  const m = (t) => P.mapLandlordKinds(lines(t), L);
  const t = `Ravi - UTR : ${U1}\nRavi - GST - UTR : ${G1}\nSuresh Babu - Rent - UTR : ${U2}\nSuresh-GST-UTR:GST444444444444`;
  assert.deepEqual(keys(m(t)), [`a|gst=${G1}`, `a|rent=${U1}`, `b|gst=GST444444444444`, `b|rent=${U2}`]);
  assert.equal(m(`Zed - UTR : ${U1}`).problems[0].reason, "landlord_name_not_found");
  assert.equal(m(`R - GST - UTR : ${G1}`).problems[0].reason, "landlord_name_too_short");
  assert.equal(m(`UTR : ${U1}`).byKey.size, 0);
});

// ── 5. New Bill / Advance (mapArrearsLines): the NewBill / Advance word is optional ──
test("F5. New Bill / Advance: word optional, single / several landlords, GST hold or not; the OTHER type word is a problem", () => {
  const L1 = [{ landOwnerId: "o", name: "Aran" }];
  const L2 = [{ landOwnerId: "a", name: "Ravi Kumar" }, { landOwnerId: "b", name: "Suresh Babu" }];
  const m = (t, L, billType, gstHold) => P.mapArrearsLines(lines(t), L, { billType, gstHold });
  for (const bt of ["newBill", "advance"]) {
    const w = bt === "newBill" ? "NewBill" : "Advance";
    assert.deepEqual(keys(m(`Aran - UTR : ${U1}`, L1, bt, false)), [`o|rent=${U1}`]);
    assert.deepEqual(keys(m(`Aran - ${w} - UTR : ${U1}`, L1, bt, false)), [`o|rent=${U1}`]); // old format still works
    assert.deepEqual(keys(m(`UTR : ${U1}`, L1, bt, false)), [`o|rent=${U1}`]); // one landlord: nameless is his
    assert.deepEqual(keys(m(`Aran - UTR : ${U1}\nAran - GST - UTR : ${G1}`, L1, bt, true)), [`o|gst=${G1}`, `o|rent=${U1}`]);
    assert.equal(m(`UTR : ${U1}`, L1, bt, true).byKey.size, 0); // GST hold + nameless: unused
    assert.deepEqual(keys(m(`Ravi - UTR : ${U1}\nSuresh - UTR : ${U2}`, L2, bt, false)), [`a|rent=${U1}`, `b|rent=${U2}`]);
    assert.deepEqual(keys(m(`Ravi - UTR : ${U1}\nRavi - GST - UTR : ${G1}\nSuresh - UTR : ${U2}\nSuresh - GST - UTR : GST444444444444`, L2, bt, true)).length, 4);
    assert.equal(m(`Zed - UTR : ${U1}`, L2, bt, false).problems[0].reason, "landlord_name_not_found");
    assert.equal(m(`UTR : ${U1}`, L2, bt, false).problems[0].reason, "unnamed_utr_line");
  }
  assert.equal(m(`Aran - Advance - UTR : ${U1}`, L1, "newBill", false).problems[0].reason, "bill_type_mismatch");
  assert.equal(m(`Aran - NewBill - UTR : ${U1}`, L1, "advance", false).problems[0].reason, "bill_type_mismatch");
});

// ── 6. Cash lines ──
test("F6. Cash lines: with / without a name, with / without a date; a UTR line is never Cash; approval-mail text is never a Cash line", () => {
  const cash = (t) => extractCashLines(t).map((c) => [c.name, c.dates.map((d) => d.date)]);
  assert.deepEqual(cash("Aran - Cash - Paid Date: 10-Nov-2026"), [["Aran - Cash", ["2026-11-10"]]]);
  assert.deepEqual(cash("Aran-Cash"), [["Aran-Cash", []]]);
  assert.deepEqual(cash("Cash"), [["Cash", []]]);
  assert.deepEqual(cash("Aran - Rent - Cash"), [["Aran - Rent - Cash", []]]);
  assert.deepEqual(cash(`Aran - Cash - UTR : ${U1}`), []); // carries a UTR: a UTR line
  assert.deepEqual(cash("Payment Category: Cash Mode\nCash Amount ₹ 0"), []);
  assert.equal(P.splitCashName("Aran - Cash").landlord, "Aran");
});

// ── 7. several months, one thread, Bill Numbers in the reply ──
test("F7. Bill-numbered lines: Rent / GST / Cash, one common UTR for several bills, wrong bill number is ignored", () => {
  const B = ["ADNOOHBILL0911202691", "ADNOOHBILL1011202692", "ADNOOHBILL1111202693"];
  const t = [`Aran - ${B[0]} : ${U1}`, `Aran-${B[1]}:${U1}`, `Aran - GST - ${B[0]} : ${G1}`, `Aran - GST - ${B[1]} : ${G1}`, `Aran - ${B[2]} : Cash - Paid Date: 09-Nov-2026`, `Aran - ADNOOHBILL9999999999 : ${U2}`].join("\n");
  const all = extractBillLines(t, B);
  assert.equal(all.length, 5); // the unknown bill number is ignored
  assert.equal(billLinesAsReply(all.filter((l) => l.bill === B[0])), `Aran - UTR : ${U1}\nAran - GST - UTR : ${G1}`);
  assert.equal(billLinesAsReply(all.filter((l) => l.bill === B[2])), "Aran - Cash - Paid Date: 09-Nov-2026");
  assert.equal(all.filter((l) => l.kind === "utr" && l.utr === U1).length, 2); // same UTR on two bills is allowed
});

// ── 8. correction check keeps Rent and GST apart ──
test("F8. correction check: named line without GST = Rent, with GST = GST; a nameless line with two payments is ambiguous", () => {
  const { mapLineToSlot } = require("../utils/utrCorrection");
  const L = [{ landOwnerId: "o", name: "Landlord with gst" }];
  const stored = { flow: "rental", landlords: L, slots: new Map([["o|rent", { key: "o|rent", landOwnerId: "o", kind: "rent", utrs: [U1] }], ["o|gst", { key: "o|gst", landOwnerId: "o", kind: "gst", utrs: [G1] }]]) };
  const at = (name) => { const r = mapLineToSlot({ name, message: {} }, stored); return r.slot ? r.slot.key : r.error; };
  assert.equal(at("Landlord with gst"), "o|rent");
  assert.equal(at("Landlord with gst - GST"), "o|gst");
  assert.equal(at("Landlord with gst - Rent"), "o|rent");
  assert.equal(at(""), "line_matches_several_payments");
});

test("F9. Gmail wraps a long line: 'Name - <BillNo> :' with the UTR on the NEXT line is read like one line (bill-numbered and ordinary lines)", () => {
  const B = ["ADNOOHBILL0610202613", "ADNOOHBILL0609202614"];
  const t = `Multiple Landlord 1 With GST   -  ${B[0]}   :\nUTR1111111111111,\nMultiple Landlord 2 With GST   -  ${B[0]}   :  UTR222222222222,\nMultiple Landlord 1 With GST   -  ${B[1]}   :\nUTR1111111111111,`;
  assert.deepEqual(extractBillLines(t, B).map((l) => [l.bill, l.name, l.utr]), [[B[0], "Multiple Landlord 1 With GST", "UTR1111111111111"], [B[0], "Multiple Landlord 2 With GST", "UTR222222222222"], [B[1], "Multiple Landlord 1 With GST", "UTR1111111111111"]]);
  assert.deepEqual(P.extractLandlordUtrLines("Aran - UTR :\nUTR132587456123,\nThanks").map((l) => [l.name, l.utr]), [["Aran", "UTR132587456123"]]);
  assert.equal(P.extractLandlordUtrLines("Aran - UTR : UTR132587456123\nThanks\nRegards:\nDeo").length, 1); // a signature line is never joined
});

test("F10. every way a mail client may break / space the line is read as ONE line; signatures and other landlords' bullets are not joined", () => {
  const U = "UTR1111111111111";
  const B = ["ADNOOHBILL0610202613"];
  const one = (t) => P.extractLandlordUtrLines(t).map((l) => [l.name, l.utr]);
  for (const t of [`Aran - UTR :\n${U},`, `Aran -\nUTR : ${U}`, `Aran\n- UTR : ${U}`, `Aran\n: UTR ${U}`, `Aran\u00a0-\u00a0UTR\u00a0:\u00a0${U}`, `Aran\u202f-\u202fUTR : ${U}`, `Aran - UT\u200bR : ${U}`, `Aran - UTR :\n\n${U}`]) {
    assert.deepEqual(one(t), [["Aran", U]], JSON.stringify(t));
  }
  assert.deepEqual(one(`Ravi - UTR :\n${U}\nSuresh - UTR :\nUTR2222222222222`), [["Ravi", U], ["Suresh", "UTR2222222222222"]]);
  assert.deepEqual(one(`- Ravi - UTR : ${U}\n- Suresh - UTR : UTR2222222222222`), [["Ravi", U], ["Suresh", "UTR2222222222222"]]);
  assert.deepEqual(one(`Aran - UTR : ${U}\nRegards -\nDeo12345`), [["Aran", U]]);
  for (const t of [`Aran - ${B[0]} :\n${U}`, `Aran - ${B[0]}\n: ${U}`, `Aran -\n${B[0]} : ${U}`, `Aran - ${B[0]} :\nUTR : ${U}`]) {
    assert.deepEqual(extractBillLines(t, B).map((l) => [l.name, l.utr]), [["Aran", U]], JSON.stringify(t));
  }
});

test("F11. a SHORT value after the UTR label is still a UTR (963, 1489, 1325ASD): 3-30 characters with a digit; 2 characters or letters only are not", () => {
  for (const [t, utr] of [["Ajay - UTR : 963", "963"], ["Singh - UTR : 1489", "1489"], ["Ajay - UTR : 1325ASD", "1325ASD"], ["UTR : 7", null], ["Ajay - UTR : 96", null], ["Ajay - UTR : abc", null]]) {
    const l = P.extractLandlordUtrLines(t);
    assert.equal(l.length ? l[0].utr : null, utr, t);
  }
  const B = ["ADNOOHBILL0610202613"];
  assert.equal(extractBillLines(`Ajay - ${B[0]} : 963`, B)[0].utr, "963");
});
