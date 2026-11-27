// Single-bill site: approving one face's row approves the other faces' rows of the same month. No DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const OverDueHistory = require("../models/Admin/MediaOnboardingSchema/OverDueHistorySchema");
const { syncSingleBillSiblingApprovals } = require("../controllers/Admin/MediaOnboardingController/RentalDueNew2Controller");

// no database: overdue history lookups → nothing found, create → echo
OverDueHistory.findOne = async () => null;
OverDueHistory.create = async (x) => x;

const step = (role, status, userName = "") => ({ role, status, userName, userId: null, approvedAt: status === 2 ? new Date("2026-10-10") : null, docVerified: status === 2 });
const row = (id, face, month, o = {}) => ({
  _id: id, mediaDetailId: face, dueMonth: month, dueDate: new Date("2026-10-06"), netPayable: 1000, gstAmount: 0, withGst: 0,
  approvalFlow: 1, approvalStatus: 2, status: 2, currentPendingRole: 2,
  approvalSteps: [step(1, 2, "RE"), step(2, 1), step(3, 1)], ...o,
});
const site = (faces, rows) => ({
  _id: "m1", status: 1, mediaDetails: faces, rentalDue: rows, rentalDueHistory: [], landOwners: [], rentalPayment: {},
  markModified() {},
});
const f = (id, mode = 1, status = 1) => ({ _id: id, status, siteBillMode: mode, mediaCode: id });

test("SB1 single-bill: Manager approves face A → face B (same month) also approved by Manager; other month untouched", async () => {
  const a = row("a", "fA", "October 2026"), b = row("b", "fB", "October 2026"), c = row("c", "fB", "November 2026");
  const media = site([f("fA"), f("fB")], [a, b, c]);
  a.approvalSteps[1] = step(2, 2, "Vinoth"); a.currentPendingRole = 3; // A already approved by Manager in this request
  const synced = await syncSingleBillSiblingApprovals({ media, entry: a, userType: 2, userId: "u2", userName: "Vinoth" });
  assert.deepEqual(synced.map((x) => String(x.rentalDueId)), ["b"]);
  assert.equal(b.approvalSteps.find((s) => s.role === 2).status, 2);
  assert.equal(b.approvalSteps.find((s) => s.role === 2).userName, "Vinoth");
  assert.equal(b.currentPendingRole, 3);
  assert.equal(c.approvalSteps.find((s) => s.role === 2).status, 1); // November row not touched
});

test("SB2 single-bill: CMD approves face A → face B fully approved (status 3)", async () => {
  const a = row("a", "fA", "October 2026", { approvalStatus: 3, status: 3, currentPendingRole: null, approvalSteps: [step(1, 2), step(2, 2), step(3, 2, "CMD")] });
  const b = row("b", "fB", "October 2026");
  const media = site([f("fA"), f("fB")], [a, b]);
  const synced = await syncSingleBillSiblingApprovals({ media, entry: a, userType: 3, userId: "u3", userName: "CMD" });
  assert.equal(synced.length, 1);
  assert.equal(b.approvalStatus, 3);
  assert.equal(b.currentPendingRole, null);
  assert.equal(b.approvalSteps.find((s) => s.role === 3).status, 2);
});

test("SB3 nothing synced: separate-bill site / single face / inactive face / already approved / excluded", async () => {
  const mk = () => [row("a", "fA", "October 2026"), row("b", "fB", "October 2026")];
  let r = mk(); // separate bill
  assert.equal((await syncSingleBillSiblingApprovals({ media: site([f("fA", 2), f("fB", 2)], r), entry: r[0], userType: 2, userId: "u", userName: "M" })).length, 0);
  r = mk(); // face B inactive → only one active face
  assert.equal((await syncSingleBillSiblingApprovals({ media: site([f("fA"), f("fB", 1, 0)], r), entry: r[0], userType: 2, userId: "u", userName: "M" })).length, 0);
  r = mk(); r[1].approvalSteps[1] = step(2, 2, "X"); r[1].currentPendingRole = 3; // B already approved by Manager
  assert.equal((await syncSingleBillSiblingApprovals({ media: site([f("fA"), f("fB")], r), entry: r[0], userType: 2, userId: "u", userName: "M" })).length, 0);
  assert.equal(r[1].approvalSteps[1].userName, "X");
  r = mk(); // B sent in the same request
  assert.equal((await syncSingleBillSiblingApprovals({ media: site([f("fA"), f("fB")], r), entry: r[0], userType: 2, userId: "u", userName: "M", excludeIds: new Set(["b"]) })).length, 0);
});
