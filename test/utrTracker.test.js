// UTR TRACKER (read-only Excel report): one row per Bill Number, month by month. No network, no database: Media and Log are in-memory fakes.
// Run: node --test test/utrTracker.test.js
process.env.JWT_SECRET = "test-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx-js-style");
const { buildUtrTracker, trackerWorkbook } = require("../utils/utrTracker");

const NOW = new Date("2026-11-11T06:00:00Z").getTime();
const BILL = "ADNOOHBILL0911202691";
const helpers = { isOwnerModePaidForCycle: () => false };
const owner = (id, name, over = {}) => ({ _id: id, landOwnerMasterId: "m" + id, name, paymentCategory: 2, onlineAmount: 5000, ...over });
const dueRow = (over = {}) => ({ _id: "r1", mediaDetailId: "f1", dueMonth: "November 2026", dueDate: new Date("2026-11-10T00:00:00Z"), approvalStatus: 3, mailSent: true, adinn_ooh_bills: BILL, withGst: 0, ownerApprovalDate: new Date("2026-11-09T05:00:00Z"), ...over });
const media = (over = {}) => ({
  _id: "s1", mediaName: "Site 1",
  mediaDetails: [{ _id: "f1", status: 1, mediaCode: "ADINCHN0188", mediaName: "Kasi Theatre" }],
  landOwners: [owner("o1", "Landlord1")],
  rentalDue: [dueRow()],
  ledger: [], ledgerHistory: [], withGst1Ledger: [], gstBalanceHistory: [], rentalPayment: { paymentFrequency: 2 },
  ...over,
});
const run = (docs, logs = [], o = {}) => buildUtrTracker({ from: "2026-11-01", to: "2026-11-30", ...o }, {
  Media: { find: () => ({ select: () => ({ lean: async () => docs }) }) },
  Log: { find: () => ({ sort: () => ({ select: () => ({ lean: async () => logs }) }) }) },
  helpers, now: NOW,
});
const paid = (ownerId, mode, utr) => ({ rentalDueId: "r1", landOwnerId: ownerId, paymentMode: mode, utrNumber: utr, isUtrEntry: false });

test("T1. an approved bill with no UTR yet: ONE row, Waiting, UTR dash, exact reply format and example", async () => {
  const { rows, summary } = await run([media()]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r["Month"], r["Approval Date"], r["Bill Type"], r["Bill Number"], r["Site Name"], r["Site Code"], r["Landlord Name"], r["Payment Category"], r["Payment Frequency"], r["GST Applicable"]],
    ["November 2026", "09 Nov 2026", "Normal Bill", BILL, "Kasi Theatre", "ADINCHN0188", "Landlord1", "Online", "Quarterly", "No"]);
  assert.deepEqual([r["Total Rental Amount"], r["GST Amount"], r["Total Amount"], r["Rent UTR"], r["GST UTR"], r["Status"]], [5000, 0, 5000, "-", "-", "Waiting for UTR"]);
  assert.equal(r["Reply Format (exact)"], "Landlord1 - UTR : <UTR>");
  assert.match(r["Reply Example"], /^Landlord1 - UTR : SBIN/);
  assert.equal("Last Checked" in r, false);
  assert.deepEqual(summary, { total: 1, saved: 0, partial: 0, waiting: 1, review: 0 });
});

test("T2. saved: the UTR column holds only the UTR, the format column the line with it; several landlords side by side; Cash shows a dash", async () => {
  const one = (await run([media({ ledger: [paid("o1", "Online", "SBIN92023012200543117")] })])).rows[0];
  assert.deepEqual([one["Rent UTR"], one["Status"], one["Reply Format (exact)"], one["Error"]], ["SBIN92023012200543117", "Saved", "Landlord1 - UTR : SBIN92023012200543117", ""]);
  const two = media({ landOwners: [owner("o1", "Landlord1"), owner("o2", "Landlord2")], ledger: [paid("o1", "Online", "UTR111111111111"), paid("o2", "Online", "UTR222222222222")] });
  const r = (await run([two])).rows[0];
  assert.equal(r["Landlord Name"], "Landlord1, Landlord2");
  assert.equal(r["Rent UTR"], "UTR111111111111, UTR222222222222");
  assert.equal(r["Reply Format (exact)"], "Landlord1 - UTR : UTR111111111111\nLandlord2 - UTR : UTR222222222222");
  assert.equal(r["Total Rental Amount"], 10000);
  const cash = media({ landOwners: [owner("o1", "Landlord1", { paymentCategory: 1, onlineAmount: 0, cashAmount: 5000 })], ledger: [paid("o1", "Cash", "")] });
  const c = (await run([cash])).rows[0];
  assert.deepEqual([c["Rent UTR"], c["Status"], c["Reply Format (exact)"], c["Payment Category"]], ["-", "Saved", "Cash", "Cash"]);
});

test("T3. the last Gmail error of the bill is shown with a readable message; a review reason makes it Needs review", async () => {
  const r = (await run([media()], [{ billNumber: BILL, status: "ambiguous_mapping", reason: "landlord_name_not_found", createdAt: new Date("2026-11-10T04:00:00Z") }])).rows[0];
  assert.equal(r["Status"], "Needs review");
  assert.equal(r["Error Code"], "landlord_name_not_found");
  assert.match(r["Error"], /landlord name/i);
  const w = (await run([media()], [{ billNumber: BILL, status: "utr_not_found", reason: "", createdAt: new Date("2026-11-10T04:00:00Z") }])).rows[0];
  assert.equal(w["Status"], "Waiting for UTR");
  assert.equal(w["Error Code"], "utr_not_found");
});

test("T4. GST on hold: Rent AND GST share ONE row (rent, GST, total, Rent UTR, GST UTR) for every landlord", async () => {
  const m = media({
    landOwners: [owner("o1", "Landlord1"), owner("o2", "Landlord2", { paymentCategory: 1, onlineAmount: 0, cashAmount: 3000 })],
    rentalDue: [dueRow({ withGst: 1 })],
    gstBalanceHistory: [{ _id: "g1", rentalDueId: "r1", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 900 }, { _id: "g2", rentalDueId: "r1", ownerId: "o2", isPaid: false, utrNumber: "", gstAmount: 540 }],
  });
  const { rows } = await run([m]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r["GST Applicable"], r["Total Rental Amount"], r["GST Amount"], r["Total Amount"], r["Rent UTR"], r["GST UTR"], r["Payment Category"]], ["Yes - On hold", 8000, 1440, 9440, "-, -", "-, -", "Online, Cash"]);
  const lines = r["Reply Format (exact)"].split("\n");
  assert.ok(lines.includes("Landlord1 - UTR : <UTR>"));
  assert.ok(lines.includes("Landlord1 - GST - UTR : <UTR>"));
  assert.ok(!lines.some((l) => /Cash/.test(l))); // Cash-only landlord: no Cash line to write (date from the "Approved through this bank" mail)
  assert.ok(lines.includes("Landlord2 - GST - UTR : <UTR>"));
  // rent saved, GST still open -> Partially saved: the rent UTR and an empty GST UTR
  const half = media({ landOwners: [owner("o1", "Landlord1")], rentalDue: [dueRow({ withGst: 1 })], ledger: [paid("o1", "Online", "UTR111111111111")], gstBalanceHistory: [m.gstBalanceHistory[0]] });
  const h = (await run([half])).rows[0];
  assert.deepEqual([h["Status"], h["Rent UTR"], h["GST UTR"]], ["Partially saved", "UTR111111111111", "-"]);
});

test("T5. dates outside the period are not listed; the Excel is month by month with totals, no Last Checked", async () => {
  assert.equal((await run([media()], [], { from: "2026-12-01", to: "2026-12-31" })).rows.length, 0);
  const oct = media({ _id: "s2", rentalDue: [dueRow({ _id: "r9", dueMonth: "October 2026", adinn_ooh_bills: "ADNOOHBILL0111202690", ownerApprovalDate: new Date("2026-11-03T05:00:00Z") })], landOwners: [owner("o9", "Landlord9")] });
  const data = await run([media(), oct]);
  assert.deepEqual(data.rows.map((r) => r["Month"]), ["October 2026", "November 2026"]);
  const wb = XLSX.read(trackerWorkbook(data), { type: "buffer" });
  assert.deepEqual(wb.SheetNames, ["UTR Tracker", "Waiting for UTR", "Needs Review"]);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets["UTR Tracker"], { header: 1, defval: "" });
  assert.match(aoa[0][0], /UTR TRACKER REPORT/);
  assert.equal(aoa[1][0], "Approval Period: 01 Nov 2026 to 30 Nov 2026");
  assert.equal(aoa[2][0], "Month");
  assert.ok(!aoa[2].includes("Last Checked"));
  assert.deepEqual(aoa.map((r) => r[0]).filter((x) => /TOTAL|^[A-Z]+ 20\d\d$/.test(x)), ["OCTOBER 2026", "OCTOBER 2026 TOTAL (1 bill)", "NOVEMBER 2026", "NOVEMBER 2026 TOTAL (1 bill)", "GRAND TOTAL (2 bills)"]);
  const grand = aoa.find((r) => String(r[0]).startsWith("GRAND TOTAL"));
  assert.deepEqual(grand.slice(10, 13), [10000, 0, 10000]);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["Needs Review"], { header: 1 }).some((r) => r[3] === BILL), false);
});

test("T6. New Bill with a Cash + Online landlord: ONE row, the Online line needs the UTR, Cash is automatic (no line for it)", async () => {
  const bill = {
    _id: "b1", type: "arrears", dueMonth: "November 2026", parentRentalDueId: "p1", adinn_ooh_bills: "ADNOOHBILL1011202692", approvalStatus: 3, mailSent: true, withGst: 2, gstAmount: 0, gstPaid: 0,
    owners: [{ landOwnerId: "o1", landOwnerMasterId: "mo1", landOwnerName: "Landlord1", onlineAmount: 2500, cashAmount: 1000, gstAmount: 0, paidOnline: false, paidCash: false }],
    payments: [], ownerApprovalDate: new Date("2026-11-05T03:00:00Z"), createdAt: new Date("2026-11-05T03:00:00Z"),
  };
  const rows = (await run([media({ rentalDue: [{ _id: "p1", withGst: 2 }], arrearsDue: [bill] })])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]["Bill Type"], rows[0]["Payment Category"], rows[0]["Total Rental Amount"], rows[0]["Reply Format (exact)"]], ["New Bill", "Cash + Online", 3500, "Landlord1 - UTR : <UTR>"]);
});

test("T7. several sites on one bill: site codes and names are written side by side", async () => {
  const m = media({
    mediaDetails: [{ _id: "f1", status: 1, mediaCode: "ADINCHN0188", mediaName: "Kasi Theatre A" }, { _id: "f2", status: 1, mediaCode: "ADINCHN0189", mediaName: "Kasi Theatre B" }],
    rentalDue: [dueRow(), dueRow({ _id: "r2", mediaDetailId: "f2" })],
  });
  const r = (await run([m])).rows[0];
  assert.equal(r["Site Code"], "ADINCHN0188, ADINCHN0189");
  assert.equal(r["Site Name"], "Kasi Theatre A, Kasi Theatre B");
});

test("T13. a bill that needs review shows the reply Finance ACTUALLY wrote (Dhoni - UTR : ...), not the expected format; others keep the expected format", async () => {
  const log = { billNumber: BILL, status: "ambiguous_mapping", reason: "landlord_name_not_found", createdAt: new Date("2026-11-10T04:00:00Z"), replyLines: ["Dhoni - UTR : UTR8437438443"] };
  const r = (await run([media()], [log])).rows[0];
  assert.equal(r["Status"], "Needs review");
  assert.equal(r["Reply Format (exact)"], "Dhoni - UTR : UTR8437438443");
  assert.match(r["Reply Example"], /^Landlord1 - UTR : SBIN/); // the example still shows the right way
  const w = (await run([media()], [{ ...log, status: "utr_not_found", reason: "", replyLines: undefined }])).rows[0];
  assert.equal(w["Reply Format (exact)"], "Landlord1 - UTR : <UTR>");
});

test("T14. no 'Rent' word in the reply format: 'Name - UTR' (Rent) and 'Name - GST - UTR' (GST)", async () => {
  const m = media({ landOwners: [owner("o1", "Ajay")], rentalDue: [dueRow({ withGst: 1 })], gstBalanceHistory: [{ _id: "g1", rentalDueId: "r1", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 900 }] });
  const r = (await run([m])).rows[0];
  assert.deepEqual(r["Reply Format (exact)"].split("\n"), ["Ajay - UTR : <UTR>", "Ajay - GST - UTR : <UTR>"]);
  assert.ok(!/Rent/.test(r["Reply Format (exact)"]));
  assert.deepEqual(r["Reply Example"].split("\n"), ["Ajay - UTR : SBIN92023012200543117", "Ajay - GST - UTR : SBIN92023012200543118"]);
});

test("T15. Paid Date and Narration (the ledger 'remarks') of the saved payments; '-' when nothing is saved / no narration", async () => {
  const open = (await run([media()])).rows[0];
  assert.deepEqual([open["Paid Date"], open["Narration"]], ["-", "-"]);
  const saved = media({ landOwners: [owner("o1", "Landlord1"), owner("o2", "Landlord2")], ledger: [
    { ...paid("o1", "Online", "UTR111111111111"), date: new Date("2026-11-09T10:30:00Z"), remarks: "TEST NARRATION 1" },
    { ...paid("o2", "Online", "UTR222222222222"), date: new Date("2026-11-10T04:00:00Z"), remarks: "" },
  ] });
  const r = (await run([saved])).rows[0];
  assert.equal(r["Paid Date"], "09 Nov 2026, 10 Nov 2026");
  assert.equal(r["Narration"], "Landlord1: TEST NARRATION 1\nLandlord2: -");
  const one = media({ ledger: [{ ...paid("o1", "Online", "UTR111111111111"), date: new Date("2026-11-09T10:30:00Z"), remarks: "Bank narration" }] });
  assert.deepEqual([(await run([one])).rows[0]["Paid Date"], (await run([one])).rows[0]["Narration"]], ["09 Nov 2026", "Bank narration"]);
});

test("T16. Excel: Paid Date and Narration sit right after GST UTR; every empty cell shows '-' (Error, Error Code ...)", async () => {
  const data = await run([media({ ledger: [{ ...paid("o1", "Online", "UTR111111111111"), date: new Date("2026-11-09T10:30:00Z") }] })]);
  const wb = XLSX.read(trackerWorkbook(data), { type: "buffer" });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets["UTR Tracker"], { header: 1, defval: "" });
  const head = aoa[2];
  assert.deepEqual(head.slice(head.indexOf("GST UTR"), head.indexOf("GST UTR") + 4), ["GST UTR", "Paid Date", "Narration", "Status"]);
  const row = aoa.find((r) => r[3] === BILL);
  assert.equal(row[head.indexOf("Paid Date")], "09 Nov 2026");
  for (const col of ["Narration", "Error", "Reply Example", "Error Code"]) assert.equal(row[head.indexOf(col)], "-", col);
  assert.ok(row.every((v) => v !== ""), "no empty cell in a data row");
});

test("T17. New Bill: Paid Date and Narration come from the bill's saved payments (remarks); '-' for what is not saved", async () => {
  const bill = {
    _id: "b1", type: "arrears", dueMonth: "November 2026", parentRentalDueId: "p1", adinn_ooh_bills: "ADNOOHBILL1011202692", approvalStatus: 3, mailSent: true, withGst: 2, gstAmount: 0, gstPaid: 0,
    owners: [{ landOwnerId: "o1", landOwnerMasterId: "mo1", landOwnerName: "Landlord1", onlineAmount: 2500, cashAmount: 0, gstAmount: 0, paidOnline: true, paidCash: false }],
    payments: [{ _id: "pay1", type: "rental", landOwnerId: "o1", paymentMode: "Online", utrNumber: "UTR111111111111", amount: 2500, date: new Date("2026-11-11T09:00:00Z"), remarks: "NB narration" }],
    ownerApprovalDate: new Date("2026-11-05T03:00:00Z"), createdAt: new Date("2026-11-05T03:00:00Z"),
  };
  const rows = (await run([media({ rentalDue: [{ _id: "p1", withGst: 2 }], arrearsDue: [bill] })])).rows;
  assert.deepEqual([rows[0]["Rent UTR"], rows[0]["Paid Date"], rows[0]["Narration"]], ["UTR111111111111", "11 Nov 2026", "NB narration"]);
});

test("T18. Rent saved with the RIGHT name, GST only ever got a WRONG-name line: 'Partially saved' (not 'Needs review'), the Error says what it waits for, no Error Code", async () => {
  const m = media({ landOwners: [owner("o1", "Ajay")], rentalDue: [dueRow({ withGst: 1 })], ledger: [paid("o1", "Online", "1234UTR125")],
    gstBalanceHistory: [{ _id: "g1", rentalDueId: "r1", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 900 }] });
  const log = { billNumber: BILL, status: "ambiguous_mapping", reason: "landlord_name_not_found", createdAt: new Date("2026-11-10T04:00:00Z"), replyLines: ["Dhoni - GST - UTR : 14784545454"] };
  const r = (await run([m], [log])).rows[0];
  assert.deepEqual([r["Status"], r["Rent UTR"], r["GST UTR"], r["Error Code"]], ["Partially saved", "1234UTR125", "-", ""]);
  assert.match(r["Error"], /Waiting for the GST UTR/);
  assert.equal(r["Reply Format (exact)"], "Ajay - UTR : 1234UTR125\nAjay - GST - UTR : <UTR>"); // saved line + the line still needed
  // nothing saved yet + wrong name only: still "Needs review" with what Finance actually wrote
  const none = media({ landOwners: [owner("o1", "Ajay")], rentalDue: [dueRow({ withGst: 1 })], gstBalanceHistory: [{ _id: "g1", rentalDueId: "r1", ownerId: "o1", isPaid: false, utrNumber: "", gstAmount: 900 }] });
  const n = (await run([none], [{ ...log, replyLines: ["Dhoni - UTR : 14784545454"] }])).rows[0];
  assert.deepEqual([n["Status"], n["Reply Format (exact)"]], ["Needs review", "Dhoni - UTR : 14784545454"]);
});

test("T19. the life of one bill: wrong name -> Needs review (landlord_name_not_found); right name later -> Saved, the old review log no longer matters", async () => {
  const log = { billNumber: BILL, status: "ambiguous_mapping", reason: "landlord_name_not_found", createdAt: new Date("2026-11-10T04:00:00Z"), replyLines: ["Dhoni - UTR : 14784545454"] };
  const step1 = (await run([media()], [log])).rows[0]; // wrong name only, nothing saved
  assert.deepEqual([step1["Status"], step1["Error Code"], step1["Reply Format (exact)"]], ["Needs review", "landlord_name_not_found", "Dhoni - UTR : 14784545454"]);
  const step2 = (await run([media({ ledger: [{ ...paid("o1", "Online", "UTR111111111111"), date: new Date("2026-11-11T05:00:00Z") }] })], [log])).rows[0]; // right name arrived and was saved; the review log is still the latest row
  assert.deepEqual([step2["Status"], step2["Rent UTR"], step2["Error"], step2["Error Code"], step2["Paid Date"]], ["Saved", "UTR111111111111", "", "", "11 Nov 2026"]);
  assert.equal(step2["Reply Format (exact)"], "Landlord1 - UTR : UTR111111111111");
});
