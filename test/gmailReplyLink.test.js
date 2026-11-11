// August + September CMD approval mails in ONE Gmail thread; finance replies carry only a UTR. The reply is tied to its bill by
// its In-Reply-To header. No network, no database: Gmail, Media, Registry, Log, Counter and the ledger saver are fakes.
// Run: node --test test/gmailReplyLink.test.js
process.env.JWT_SECRET = "test-secret";
process.env.GMAIL_UTR_RUN_LOG_FILE = require("path").join(require("os").tmpdir(), "gmail-reply-link-runs-" + process.pid + ".jsonl");
const test = require("node:test");
const assert = require("node:assert/strict");

const Gmail = require("../utils/gmailService");
const { scopeThreadToBill } = require("../utils/gmailReplyLink");
const { lookupUtrByBillNumber } = require("../utils/gmailUtrLookup");
const { createUtrProcessor } = require("../utils/utrProcessor");

const NOW = new Date("2026-11-10T06:00:00Z").getTime();
const AUG = "ADNOOHBILL09082026103";
const SEP = "ADNOOHBILL09092026104";
const UTR1 = "SBIN92023012200543116";
const UTR2 = "HDFC92023012200543117";

// ── thread fixtures (shape of the real inspected thread) ──
const approval = (id, bill, mid, at) => ({
  id, labelIds: ["INBOX"], from: "CMD Approved <noreply@x.com>", sentAt: at, date: at, subject: "CMD Payment Approved - Test1",
  messageIdHeader: `<${mid}@adinndigital.com>`, inReplyTo: "",
  bodyText: `Hello Team, Rental Payment Approved\nBill No: ${bill}\nOwner Name | Landlord 1 | Phone | 9 | Bank Name | SBI | Account No | 123456789012 |`,
});
const reply = (id, utr, parentMid, at) => ({
  id, labelIds: ["INBOX"], from: "Finance <fin@x.com>", sentAt: at, date: at, subject: "Re: CMD Payment Approved - Test1",
  messageIdHeader: `<${id}@mail.gmail.com>`, inReplyTo: parentMid ? `<${parentMid}@adinndigital.com>` : "",
  bodyText: `UTR : ${utr}`,
});
const A = () => approval("mA", AUG, "midA", "2026-11-10T03:54:47.000Z");
const B = () => approval("mB", SEP, "midB", "2026-11-10T03:57:55.000Z");
const R1 = (parent = "midA") => reply("mR1", UTR1, parent, "2026-11-10T04:55:27.000Z"); // Aug reply
const R2 = (parent = "midB") => reply("mR2", UTR2, parent, "2026-11-10T05:10:00.000Z"); // Sep reply

const stubGmail = (messages) => {
  const saved = { s: Gmail.searchThreads, g: Gmail.getThread };
  Gmail.searchThreads = async () => [{ id: "T1" }];
  Gmail.getThread = async () => ({ id: "T1", subject: "CMD Payment Approved - Test1", messages: messages.map((m) => ({ ...m })), ignoredMessages: [] });
  return () => { Gmail.searchThreads = saved.s; Gmail.getThread = saved.g; };
};

// ───────────────────────── pure helper ─────────────────────────
test("L1. the August reply is tied to the August approval mail only", () => {
  const s = scopeThreadToBill([A(), B(), R1()], AUG);
  assert.equal(s.status, "scoped");
  assert.deepEqual(s.messages.map((m) => m.id), ["mA", "mR1"]);
  assert.deepEqual(s.link, { mode: "in_reply_to", approvalMessageId: "mA", replyMessageIds: ["mR1"] });
});

test("L2. the same reply does not belong to the September bill", () => {
  const s = scopeThreadToBill([A(), B(), R1()], SEP);
  assert.equal(s.status, "scoped");
  assert.deepEqual(s.messages.map((m) => m.id), ["mB"]); // approval mail only, no reply of its own
});

test("L3. a reply to the September approval mail belongs to September, not August", () => {
  const msgs = [A(), B(), R2()];
  assert.deepEqual(scopeThreadToBill(msgs, SEP).messages.map((m) => m.id), ["mB", "mR2"]);
  assert.deepEqual(scopeThreadToBill(msgs, AUG).messages.map((m) => m.id), ["mA"]);
});

test("L4. reply order is never used: the first reply pointing at September is September's", () => {
  const first = reply("mR1", UTR1, "midB", "2026-11-10T04:55:00.000Z");
  const s = scopeThreadToBill([A(), B(), first], AUG);
  assert.deepEqual(s.messages.map((m) => m.id), ["mA"]);
  assert.deepEqual(scopeThreadToBill([A(), B(), first], SEP).messages.map((m) => m.id), ["mB", "mR1"]);
});

test("L5. a UTR reply without In-Reply-To cannot be linked -> manual review", () => {
  const s = scopeThreadToBill([A(), B(), R1("")], AUG);
  assert.equal(s.status, "unlinked");
  assert.equal(s.reason, "reply_not_linked_to_approval_mail");
  assert.deepEqual(s.replyMessageIds, ["mR1"]);
});

test("L6. a reply to another reply (not to an approval mail) cannot be linked -> manual review", () => {
  const second = reply("mR2", UTR2, "mR1", "2026-11-10T05:00:00.000Z");
  second.inReplyTo = "<mR1@mail.gmail.com>";
  const s = scopeThreadToBill([A(), B(), R1(), second], AUG);
  assert.equal(s.status, "unlinked");
  assert.deepEqual(s.replyMessageIds, ["mR2"]);
});

test("L7. In-Reply-To pointing at a message that is not in the thread cannot be linked", () => {
  assert.equal(scopeThreadToBill([A(), B(), R1("midUnknown")], AUG).status, "unlinked");
});

test("L8. an approval mail that prints several Bill Numbers is refused", () => {
  const both = approval("mAB", AUG, "midAB", "2026-11-10T03:54:00.000Z");
  both.bodyText += `\nBill No: ${SEP}`;
  const s = scopeThreadToBill([both, R1("midAB")], AUG);
  assert.equal(s.status, "unlinked");
  assert.equal(s.reason, "approval_mail_has_several_bills");
});

test("L9. a message without any UTR (thanks, question) never blocks the link", () => {
  const chat = reply("mC", "", "midB", "2026-11-10T04:00:00.000Z");
  chat.bodyText = "Thanks, will pay today";
  const s = scopeThreadToBill([A(), B(), chat, R1()], AUG);
  assert.equal(s.status, "scoped");
});

// ───────────────────────── lookup (Gmail stubbed) ─────────────────────────
test("K1. lookup: August Bill Number finds the August reply's UTR even though September's number is in the thread", async () => {
  const off = stubGmail([A(), B(), R1()]);
  try {
    const r = await lookupUtrByBillNumber(AUG);
    assert.equal(r.data.extractionStatus, "found");
    assert.equal(r.data.utr, UTR1);
    assert.equal(r.data.sourceMessageId, "mR1");
    assert.equal(r.data.replyLink.approvalMessageId, "mA");
  } finally { off(); }
});

test("K2. lookup: the September Bill Number does not take the August reply's UTR", async () => {
  const off = stubGmail([A(), B(), R1()]);
  try {
    const r = await lookupUtrByBillNumber(SEP);
    assert.equal(r.data.extractionStatus, "utr_not_found");
  } finally { off(); }
});

test("K3. lookup: both replies present -> each bill gets its own UTR", async () => {
  const off = stubGmail([A(), B(), R1(), R2()]);
  try {
    assert.equal((await lookupUtrByBillNumber(AUG)).data.utr, UTR1);
    assert.equal((await lookupUtrByBillNumber(SEP)).data.utr, UTR2);
  } finally { off(); }
});

test("K4. lookup: an unlinkable UTR reply in a multi-approval thread -> reply_not_linked, no UTR for either bill", async () => {
  const off = stubGmail([A(), B(), R1("")]);
  try {
    for (const bill of [AUG, SEP]) {
      const r = await lookupUtrByBillNumber(bill);
      assert.equal(r.data.extractionStatus, "reply_not_linked");
      assert.equal(r.data.utr, null);
    }
  } finally { off(); }
});

test("K5. lookup: a single-approval thread is unchanged (no header needed)", async () => {
  const off = stubGmail([A(), R1("")]);
  try {
    const r = await lookupUtrByBillNumber(AUG);
    assert.equal(r.data.extractionStatus, "found");
    assert.equal(r.data.utr, UTR1);
    assert.equal(r.data.replyLink, undefined);
  } finally { off(); }
});

// ───────────────────────── processor end to end ─────────────────────────
const owner = { _id: "o1", landOwnerMasterId: "m1", name: "Landlord 1", paymentCategory: 2 };
const dueRow = (id, month, date, bill) => ({ _id: id, dueMonth: month, dueDate: new Date(date), approvalStatus: 3, mailSent: true, adinn_ooh_bills: bill, withGst: 2 });
const makeSite = () => ({
  _id: "s1", mediaName: "Site 1",
  mediaDetails: [{ status: 1, mediaCode: "C1", siteBillMode: 1 }],
  landOwners: [owner],
  rentalDue: [dueRow("rAug", "August 2026", "2026-08-09T00:00:00Z", AUG), dueRow("rSep", "September 2026", "2026-09-09T00:00:00Z", SEP)],
  ledger: [], ledgerHistory: [],
});
const fakeCounter = () => {
  const docs = new Map();
  return {
    findOneAndUpdate: (q, upd) => ({ lean: async () => { const d = docs.get(q._id); if (d && d.seq < q.seq.$lt) { d.seq = upd.$set.seq; return { ...d }; } return null; } }),
    create: async (doc) => { if (docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 }); docs.set(doc._id, { ...doc }); },
    updateOne: async (q, upd) => { if (docs.has(q._id)) docs.get(q._id).seq = upd.$set.seq; },
  };
};
const setup = (registryOver) => {
  const db = new Map([["s1", makeSite()]]);
  const logRows = [];
  const saves = [];
  const clone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "dueDate" && typeof x === "string" ? new Date(x) : x));
  const Log = {
    create: async (d) => { logRows.push({ createdAt: new Date(), ...d }); },
    findOne: (q) => ({ sort: () => ({ lean: async () => logRows.filter((r) => r.billNumber === q.billNumber && r.dryRun === q.dryRun)[0] || null }) }),
    find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) }),
  };
  const Registry = {
    findOne: (q) => ({
      lean: async () => {
        if (registryOver) return registryOver(q.adinn_ooh_bills);
        const m = db.get("s1");
        const rows = m.rentalDue.filter((r) => r.adinn_ooh_bills === q.adinn_ooh_bills);
        return rows.length ? { mediaId: m._id, dueMonth: rows[0].dueMonth, rentalDueIds: rows.map((r) => r._id) } : null;
      },
    }),
  };
  const noHelpers = { isOwnerModePaidForCycle: () => false };
  const p = createUtrProcessor({
    Media: { findById: (id) => ({ lean: async () => clone(db.get(id)) }) },
    Registry, Log, Counter: fakeCounter(), helpers: noHelpers,
    saveEnabled: () => true, cashSaveEnabled: () => false, multiLandlordSaveEnabled: () => false, gstSaveEnabled: () => false,
    now: () => NOW,
    logger: { log() {}, error() {} },
    pendingDeps: { Media: { find: () => ({ select: () => ({ lean: async () => [clone(db.get("s1"))] }) }) }, Log: { find: Log.find }, helpers: noHelpers, now: NOW },
    saver: async (batch) => {
      saves.push(batch);
      db.get("s1").ledger.push({ rentalDueId: batch.payments[0].rentalDueId, landOwnerId: batch.payments[0].landOwnerId, paymentMode: batch.payments[0].paymentMode, utrNumber: batch.payments[0].utrNumber, status: 1, isUtrEntry: false });
      return { statusCode: 201, data: { sitesFailed: 0, savedEntries: [{ status: "saved", amount: 5000 }] } };
    },
  });
  return { p, db, saves, logRows };
};

test("E1. August reply saves the UTR against August only; September stays pending", async () => {
  const off = stubGmail([A(), B(), R1()]);
  try {
    const { p, saves, db } = setup();
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(saves.length, 1);
    assert.equal(saves[0].payments[0].rentalDueId, "rAug");
    assert.equal(saves[0].payments[0].utrNumber, UTR1);
    assert.equal(saves[0].date, "2026-11-10");
    const aug = r.results.find((x) => x.billNumber === AUG);
    const sep = r.results.find((x) => x.billNumber === SEP);
    assert.equal(aug.status, "found_and_saved");
    assert.equal(aug.dueMonth, "August 2026");
    assert.equal(aug.replyLink.approvalMessageId, "mA");
    assert.equal(sep.status, "utr_not_found");
    assert.equal(db.get("s1").ledger.some((e) => e.rentalDueId === "rSep"), false);
  } finally { off(); }
});

test("E2. a later September reply in the same thread is discovered and saved against September only", async () => {
  const { p, saves } = setup();
  let off = stubGmail([A(), B(), R1()]);
  try { await p.processPendingUtrs({ dryRun: false }); } finally { off(); }
  assert.equal(saves.length, 1);

  off = stubGmail([A(), B(), R1(), R2()]); // finance now replies to the September mail
  try {
    const r = await p.processPendingUtrs({ dryRun: false, force: true });
    assert.equal(saves.length, 2);
    assert.equal(saves[1].payments[0].rentalDueId, "rSep");
    assert.equal(saves[1].payments[0].utrNumber, UTR2);
    assert.equal(r.results.filter((x) => x.status === "found_and_saved").length, 1);
    assert.equal(r.results.find((x) => x.billNumber === SEP).dueMonth, "September 2026");
  } finally { off(); }
});

test("E3. only a September reply exists (to the September mail): September is saved, August is not touched", async () => {
  const off = stubGmail([A(), B(), R2()]);
  try {
    const { p, saves } = setup();
    await p.processPendingUtrs({ dryRun: false });
    assert.equal(saves.length, 1);
    assert.equal(saves[0].payments[0].rentalDueId, "rSep");
    assert.equal(saves[0].payments[0].utrNumber, UTR2);
  } finally { off(); }
});

test("E4. a reply that cannot be linked is never saved for either month (manual review)", async () => {
  const off = stubGmail([A(), B(), R1("")]);
  try {
    const { p, saves } = setup();
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(saves.length, 0);
    assert.deepEqual(r.results.map((x) => [x.status, x.reason]), [["ambiguous_mapping", "reply_not_linked_to_approval_mail"], ["ambiguous_mapping", "reply_not_linked_to_approval_mail"]]);
  } finally { off(); }
});

test("E5. registry still guards the linked bill: a registry month that differs from the row blocks the save", async () => {
  const off = stubGmail([A(), B(), R1()]);
  try {
    const { p, saves } = setup(() => ({ mediaId: "s1", dueMonth: "July 2026", rentalDueIds: ["rAug", "rSep"] }));
    const r = await p.processPendingUtrs({ dryRun: false });
    assert.equal(saves.length, 0);
    assert.equal(r.results.find((x) => x.billNumber === AUG).reason, "registry_month_mismatch");
  } finally { off(); }
});

test("E6. dry run shows the linked approval message and the month, saves nothing", async () => {
  const off = stubGmail([A(), B(), R1()]);
  try {
    const { p, saves } = setup();
    const r = await p.processPendingUtrs({});
    assert.equal(r.dryRun, true);
    assert.equal(saves.length, 0);
    const aug = r.results.find((x) => x.billNumber === AUG);
    assert.equal(aug.status, "found_and_saved");
    assert.equal(aug.dueMonth, "August 2026");
    assert.equal(aug.replyLink.approvalMessageId, "mA");
  } finally { off(); }
});
