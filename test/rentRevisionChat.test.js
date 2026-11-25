// New Bill / Advance Google Chat message (utils/googleChat.js). Pure, no DB, nothing posted.
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../utils/googleChat");

const media = { landOwners: [{ name: "M. Vidya" }], rentalPayment: { paymentFrequency: 1 }, mediaDetails: [] };
const bill = {
  billType: "BILL", revisionAction: "increase", mediaName: "ECR", mediaCode: "ADINCHN0070", oldRent: 70000, newRent: 80000,
  fromMonth: "September 2026", toMonth: "November 2026", gstPercentage: 18, nextBillFromMonth: "December 2026", reason: "Agreement",
  monthsDetail: [{ month: "September 2026", amount: 10000, gstAmount: 1800 }, { month: "October 2026", amount: 10000, gstAmount: 1800 }],
  requestedBy: "Kumar", requestedByRole: 1, currentPendingRole: 1, invoice: { filePath: "https://x/inv.pdf" },
};

test("RC1 New Bill message: months, rents, totals, reason, invoice, requested by", () => {
  const t = G.buildRentRevisionMessage({ revision: bill, media, event: "approved", role: 2, userName: "Ajay", remark: "ok" });
  assert.match(t, /^\*New Bill Approved\* — by Rental Manager \(Ajay\)/);
  assert.match(t, /Awaiting your approval\* \(CMD\)/);
  assert.match(t, /\*Bill Months:\* September 2026 to October 2026/);
  assert.match(t, /\*Old Rent:\* ₹70,000/);
  assert.match(t, /• October 2026 — ₹10,000 \+ GST ₹1,800/);
  assert.match(t, /\*Total Amount:\* ₹20,000/);
  assert.match(t, /\*GST Amount \(18%\):\* ₹3,600/);
  assert.match(t, /\*Total Net Payable:\* ₹23,600/);
  assert.match(t, /\*Landowner Name:\* M. Vidya/);
  assert.match(t, /\*Invoice:\* https:\/\/x\/inv.pdf/);
  assert.match(t, /\*Requested By:\* Rental Executive \(Kumar\)/);
  assert.match(t, /\*Remark:\* ok/);
});

test("RC2 Advance message + entered / rejected labels", () => {
  const adv = { billType: "ADVANCE", fromMonth: "January 2027", advanceAmount: 150000, advanceGstAmount: 0, adjustInMonth: "March 2027", requestedBy: "Kumar", requestedByRole: 1, currentPendingRole: 1 };
  const t = G.buildRentRevisionMessage({ revision: adv, media, event: "created" });
  assert.match(t, /^\*Advance Entered\* — by Rental Executive \(Kumar\)/);
  assert.match(t, /Awaiting your approval\* \(Rental Executive\)/);
  assert.match(t, /\*Advance Amount:\* ₹1,50,000/);
  assert.match(t, /\*Adjust In Month:\* March 2027/);
  assert.doesNotMatch(t, /GST Amount/);
  const r = G.buildRentRevisionMessage({ revision: adv, media, event: "rejected", role: 3, userName: "MD", remark: "no" });
  assert.match(r, /^\*Advance Rejected\* — by CMD \(MD\)/);
  assert.match(r, /\*Rejected by CMD\*/);
});

test("RC3 routing: spaces per event; NORMAL_BILL / CANCEL / chat off → none", () => {
  const env = { ...process.env };
  Object.assign(process.env, { RENTAL_EXECUTIVE_URL: "E", RENTAL_MANAGER_URL: "M", CMD_URL: "C", GOOGLE_CHAT: "on" });
  try {
    assert.deepEqual(G.rentRevisionChatUrls({ revision: bill, event: "created" }), ["E"]);
    assert.deepEqual(G.rentRevisionChatUrls({ revision: bill, event: "approved", role: 1 }), ["M"]);
    assert.deepEqual(G.rentRevisionChatUrls({ revision: bill, event: "approved", role: 2 }), ["C"]);
    assert.deepEqual(G.rentRevisionChatUrls({ revision: bill, event: "approved", role: 3 }), ["E", "M"]);
    assert.deepEqual(G.rentRevisionChatUrls({ revision: bill, event: "rejected", role: 2 }), ["E"]);
    assert.deepEqual(G.rentRevisionChatUrls({ revision: { ...bill, billType: "NORMAL_BILL" }, event: "approved", role: 3 }), []);
    assert.deepEqual(G.rentRevisionChatUrls({ revision: { ...bill, billType: "CANCEL" }, event: "created" }), []);
    process.env.GOOGLE_CHAT = "off";
    assert.deepEqual(G.rentRevisionChatUrls({ revision: bill, event: "created" }), []);
  } finally {
    for (const k of ["RENTAL_EXECUTIVE_URL", "RENTAL_MANAGER_URL", "CMD_URL", "GOOGLE_CHAT"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
});
