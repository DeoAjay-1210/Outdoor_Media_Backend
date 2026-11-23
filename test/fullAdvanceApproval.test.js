// Bill fully covered by a CMD approved advance → created approved with the advance's steps (fullAdvanceApprovalFor). No DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const RentRevision = require("../models/Admin/MediaOnboardingSchema/RentRevisionSchema");
const { fullAdvanceApprovalFor } = require("../controllers/Admin/MediaOnboardingController/RentalDueNew2Controller");

const revId = new mongoose.Types.ObjectId();
const billId = new mongoose.Types.ObjectId();
const re = new mongoose.Types.ObjectId();
const revision = {
  reason: "Owner asked advance",
  _id: revId,
  approvalSteps: [
    { role: 1, status: "Approved", by: "Praveenkumar M", byUserId: re, at: new Date("2026-10-18T10:00:00Z") },
    { role: 2, status: "Approved", by: "Chandra Mohan", at: new Date("2026-10-19T12:30:00Z") },
    { role: 3, status: "Approved", by: "CMD Approval", at: new Date("2026-10-20T11:05:00Z") },
  ],
};
RentRevision.findById = (id) => ({ select: () => ({ lean: async () => (String(id) === String(revId) ? revision : null) }) });

const media = (amount) => ({
  rentalPayment: { advanceAdjustments: [{ dueMonth: "November 2026", amount, advanceBillId: billId, rentRevisionId: revId, createdAt: new Date() }] },
  arrearsDue: [{ _id: billId, type: "advance", dueMonth: "October 2026" }],
});

test("F1 full advance (₹0 left) → approved via advance with RE / RM / CMD steps", async () => {
  const r = await fullAdvanceApprovalFor(media(206306), "November 2026", 0);
  assert.equal(r.approvalStatus, 3);
  assert.equal(r.status, 3);
  assert.equal(r.currentPendingRole, null);
  assert.equal(r.approvedVia, "advance");
  assert.deepEqual(r.approvalSteps.map((s) => [s.role, s.status, s.userName]), [[1, 2, "Praveenkumar M"], [2, 2, "Chandra Mohan"], [3, 2, "CMD Approval"]]);
  assert.equal(String(r.approvalSteps[0].userId), String(re));
  assert.equal(r.ownerApprovalDate.toISOString(), "2026-10-20T11:05:00.000Z");
  assert.equal(r.advanceApproval.advanceMonth, "October 2026");
  assert.equal(r.advanceApproval.advanceAmount, 206306);
  assert.equal(r.reason, "Owner asked advance");
});

test("F2 partial advance (balance left) / no advance / other month → null (normal flow)", async () => {
  assert.equal(await fullAdvanceApprovalFor(media(100000), "November 2026", 106306), null);
  assert.equal(await fullAdvanceApprovalFor({ rentalPayment: {} }, "November 2026", 0), null);
  assert.equal(await fullAdvanceApprovalFor(media(206306), "December 2026", 0), null);
});

test("F3 CMD skipped lower roles → status 3 (Skipped); CMD not approved → null", async () => {
  revision.approvalSteps[1].status = "Skipped";
  const r = await fullAdvanceApprovalFor(media(206306), "November 2026", 0);
  assert.equal(r.approvalSteps[1].status, 3);
  assert.equal(r.approvalSteps[1].approvedAt, null); // skipped → not shown as approved
  assert.equal(r.approvalSteps[1].docVerified, false);
  revision.approvalSteps[1].status = "Approved";
  revision.approvalSteps[2].status = "Pending";
  assert.equal(await fullAdvanceApprovalFor(media(206306), "November 2026", 0), null);
  revision.approvalSteps[2].status = "Approved";
});

// ── bill generated BEFORE the advance: CMD approves a full advance → that bill is approved via advance
const Media = require("../models/Admin/MediaOnboardingSchema/MediaOnboardingSchema");
const { applyAdvance } = require("../controllers/Admin/MediaOnboardingController/RentRevisionController");

const siteFor = () => {
  const face = new mongoose.Types.ObjectId();
  return {
    _id: new mongoose.Types.ObjectId(),
    mediaDetails: [{ _id: face, status: 1, mediaName: "f" }],
    rentalPayment: { paymentFrequency: 1, totalRentalAmount: 10000, billingStartDate: new Date("2026-08-25") },
    landOwners: [{ _id: new mongoose.Types.ObjectId(), name: "L", shareAmount: 10000, onlineAmount: 10000, cashAmount: 0, paymentCategory: 1 }],
    rentalDue: [{ _id: new mongoose.Types.ObjectId(), dueMonth: "September 2026", dueDate: new Date("2026-09-25"), mediaDetailId: face, netPayable: 10000, baseAmount: 10000, gstAmount: 0, withGst: 0, approvalStatus: 1 }],
    ledger: [],
  };
};
const advRevision = (amount) => ({
  _id: new mongoose.Types.ObjectId(),
  billType: "ADVANCE",
  fromDate: new Date("2026-09-01"),
  fromMonth: "September 2026",
  advanceAmount: amount,
  gstOnIncrease: 0,
  reason: "Sep advance",
  approvalSteps: [
    { role: 1, status: "Approved", by: "RE", at: new Date("2026-11-23T05:50:00Z") },
    { role: 2, status: "Skipped", at: new Date("2026-11-23T06:08:43Z") },
    { role: 3, status: "Approved", by: "cmd", at: new Date("2026-11-23T06:08:43Z") },
  ],
});
const captureUpdates = () => {
  const calls = [];
  Media.updateOne = async (filter, update) => {
    calls.push(update);
    return { acknowledged: true };
  };
  return calls;
};

test("F4 existing bill + full advance → bill set approved via advance (+ history approvalStatus 3)", async () => {
  const calls = captureUpdates();
  await applyAdvance(advRevision(10000), siteFor(), "cmd");
  const set = calls[0].$set;
  assert.equal(set["rentalDue.$[v0].netPayable"], 0);
  assert.equal(set["rentalDue.$[v0].approvalStatus"], 3);
  assert.equal(set["rentalDue.$[v0].currentPendingRole"], null);
  assert.equal(set["rentalDue.$[v0].approvedVia"], "advance");
  assert.equal(set["rentalDue.$[v0].advanceApproval"].advanceAmount, 10000);
  assert.equal(set["rentalDue.$[v0].advanceApproval"].advanceMonth, "September 2026");
  assert.deepEqual(set["rentalDue.$[v0].approvalSteps"].map((s) => [s.role, s.status, s.userName]), [[1, 2, "RE"], [2, 3, ""], [3, 2, "cmd"]]);
  assert.equal(calls[1].$set["rentalDueHistory.$[].months.$[].entries.$[h].approvalStatus"], 3);
  assert.equal(set["rentalDue.$[v0].reason"], "Sep advance");
  assert.equal(set["rentalDue.$[v0].approvalSteps"][1].approvedAt, null);
});

test("F5 existing bill + partial advance → only amounts change (approval untouched)", async () => {
  const calls = captureUpdates();
  await applyAdvance(advRevision(4000), siteFor(), "cmd");
  const set = calls[0].$set;
  assert.equal(set["rentalDue.$[v0].netPayable"], 6000);
  assert.equal(set["rentalDue.$[v0].approvalStatus"], undefined);
  assert.equal(set["rentalDue.$[v0].approvedVia"], undefined);
  assert.equal(calls[1].$set["rentalDueHistory.$[].months.$[].entries.$[h].approvalStatus"], undefined);
});

test("F6 GST still to pay → not approved via advance", async () => {
  assert.equal(await fullAdvanceApprovalFor(media(206306), "November 2026", 0, 500), null);
});
