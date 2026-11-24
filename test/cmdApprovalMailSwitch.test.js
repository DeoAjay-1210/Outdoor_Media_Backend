// CMD_APPROVAL_MAIL: one on / off switch for every CMD approval mail. No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isCmdApprovalMailOn, CMD_APPROVAL_MAIL_OFF_MESSAGE } = require("../utils/cmdApprovalMailSwitch");
const { sendRentalDueApprovalMail } = require("../controllers/Admin/MediaOnboardingController/RentalDueNew2Controller");

test("S1 on values → on; off / missing / other → off", () => {
  const old = process.env.CMD_APPROVAL_MAIL;
  for (const v of ["on", "ON", "1", "true", " yes "]) {
    process.env.CMD_APPROVAL_MAIL = v;
    assert.equal(isCmdApprovalMailOn(), true, v);
  }
  for (const v of ["off", "0", "false", "", "maybe"]) {
    process.env.CMD_APPROVAL_MAIL = v;
    assert.equal(isCmdApprovalMailOn(), false, v);
  }
  delete process.env.CMD_APPROVAL_MAIL;
  assert.equal(isCmdApprovalMailOn(), false);
  if (old !== undefined) process.env.CMD_APPROVAL_MAIL = old;
});

test("S2 normal bill mail: switch off → not sent, even with MAIL_MODE production", async () => {
  const old = { s: process.env.CMD_APPROVAL_MAIL, m: process.env.MAIL_MODE };
  process.env.CMD_APPROVAL_MAIL = "off";
  process.env.MAIL_MODE = "production";
  const media = { _id: "m1", mediaDetails: [{ _id: "f1", status: 1, mediaName: "S", mediaCode: "C1" }], landOwners: [], rentalPayment: {}, rentalDue: [] };
  const entry = { _id: "e1", dueMonth: "November 2026", dueDate: new Date("2026-11-10"), netPayable: 1000, gstAmount: 0, withGst: 0 };
  const r = await sendRentalDueApprovalMail(media, entry);
  assert.equal(r.sent, false);
  assert.equal(r.message, CMD_APPROVAL_MAIL_OFF_MESSAGE);
  if (old.s === undefined) delete process.env.CMD_APPROVAL_MAIL; else process.env.CMD_APPROVAL_MAIL = old.s;
  if (old.m === undefined) delete process.env.MAIL_MODE; else process.env.MAIL_MODE = old.m;
});
