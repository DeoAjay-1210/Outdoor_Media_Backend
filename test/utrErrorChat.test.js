// UTR error → Google Chat (utils/utrErrorChat.js). No network: post / findMedia / the log model are fakes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { notifyUtrErrorChat, buildUtrErrorMessage, isUserError } = require("../utils/utrErrorChat");

const URL = "https://chat.example.test/webhook";
const withEnv = async (env, fn) => {
  const keep = { UTR_ERROR_CHAT_URL: process.env.UTR_ERROR_CHAT_URL, GOOGLE_CHAT: process.env.GOOGLE_CHAT };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const media = {
  mediaDetails: [{ status: 1, mediaCode: "ADINCHN0045", mediaName: "Anna Nagar 2nd Avenue", city: "Chennai" }],
  landOwners: [{ name: "JESURAJA S", paymentCategory: 2 }],
  rentalDue: [{ _id: "r1", netPayable: 50000 }],
};
const log = (extra = {}) => ({
  _id: "L1",
  billNumber: "ADNOOHBILL25102026133",
  status: "ambiguous_mapping",
  reason: "landlord_name_not_found",
  mediaId: "m1",
  dueMonth: "October 2026",
  rentalDueIds: ["r1"],
  replyLines: ["JESURAJA - UTR : AXISP00860490864"],
  senderEmail: "accounts@example.test",
  messageDate: "2026-11-19T05:08:00.000Z",
  gmailThreadId: "abc123",
  sourceMessageId: "msg1",
  dryRun: false,
  ...extra,
});

// fake gmail_utr_logs model: records what was already notified
const fakeModel = () => {
  const notified = [];
  class Doc {
    constructor(data) { Object.assign(this, data); }
    toObject() { return { ...this }; }
    static find(q) {
      const hits = notified.filter((n) => n.billNumber === q.billNumber && n.reason === q.reason && (!q.sourceMessageId || n.sourceMessageId === q.sourceMessageId) && n._id !== q._id.$ne);
      return { select: () => ({ lean: async () => hits }) };
    }
    static async updateOne(filter) { notified.push(Doc._byId.get(filter._id)); }
  }
  Doc._byId = new Map();
  Doc.make = (data) => { const d = new Doc(data); Doc._byId.set(d._id, { ...data }); return d; };
  return Doc;
};

test("C1. only errors Finance can fix are posted (not system errors / no reply yet / dry run)", () => {
  assert.equal(isUserError(log()), true);
  assert.equal(isUserError(log({ reason: "invalid_utr", status: "utr_not_found" })), true);
  assert.equal(isUserError(log({ reason: "gmail_error" })), false);
  assert.equal(isUserError(log({ reason: "", status: "utr_not_found" })), false);
  assert.equal(isUserError(log({ reason: "cash_auto_save_disabled" })), false);
  assert.equal(isUserError(log({ reason: "registry_record_missing" })), false);
  assert.equal(isUserError(log({ dryRun: true })), false);
});

test("C2. the message holds bill, site, month, landlord, amount, reply lines, error, sender, IST time and mail link", () => {
  const text = buildUtrErrorMessage(log(), media);
  for (const part of [
    "ADNOOHBILL25102026133", "ADINCHN0045 – Anna Nagar 2nd Avenue (Chennai)", "October 2026",
    "JESURAJA S (Online)", "₹50,000", "• JESURAJA - UTR : AXISP00860490864",
    "landlord_name_not_found", "accounts@example.test", "19 Nov 2026, 10:38 AM",
    "https://mail.google.com/mail/u/0/#all/abc123", "SAME mail thread",
    "You wrote", "Reply like this", "JESURAJA S - UTR : <UTR number>",
  ]) assert.ok(text.includes(part), `missing: ${part}`);
});

test("C5. 'Reply like this' lines follow the bill: several landlords, GST hold, Cash and Cash + Online", () => {
  const { expectedReplyLines } = require("../utils/utrErrorChat");
  const owners = [
    { name: "JESURAJA S", paymentCategory: 2, gstApplicable: 1 },
    { name: "MURUGAN K", paymentCategory: 1 },
    { name: "RAVI P", paymentCategory: 3 },
  ];
  const holdRows = [{ withGst: 1, gstAmount: 9000 }];
  const r = expectedReplyLines({ landOwners: owners }, holdRows);
  assert.deepEqual(r.replyLines, [
    "JESURAJA S - UTR : <UTR number>",
    "JESURAJA S - GST - UTR : <UTR number>", // GST hold, GST landlord
    "RAVI P - UTR : <UTR number>", // Cash + Online → UTR line only
  ]);
  assert.ok(r.notes.some((n) => n.includes("MURUGAN K (Cash): no line needed") && n.includes("MURUGAN K - Cash - Paid Date")));
  assert.ok(r.notes.some((n) => n.includes("RAVI P: Cash part is automatic")));
  // no GST hold → no GST line
  assert.deepEqual(expectedReplyLines({ landOwners: [owners[0]] }, [{ withGst: 2, gstAmount: 9000 }]).replyLines, ["JESURAJA S - UTR : <UTR number>"]);
  // no site data → a generic line
  assert.deepEqual(expectedReplyLines(null, []).replyLines, ["<Landlord full name> - UTR : <UTR number>"]);
});

test("C3. posts once per bill + error + reply mail; a later run with the same error is not posted again", async () => {
  await withEnv({ UTR_ERROR_CHAT_URL: URL, GOOGLE_CHAT: "on" }, async () => {
    const Model = fakeModel();
    const posts = [];
    const deps = { post: async (u, body) => posts.push({ u, body }), findMedia: async () => media };
    assert.equal(await notifyUtrErrorChat(Model.make(log({ _id: "L1" })), deps), true);
    assert.equal(await notifyUtrErrorChat(Model.make(log({ _id: "L2" })), deps), false); // same reply, same error
    assert.equal(await notifyUtrErrorChat(Model.make(log({ _id: "L3", sourceMessageId: "msg2" })), deps), true); // new reply mail
    assert.equal(posts.length, 2);
    assert.equal(posts[0].u, URL);
    assert.ok(posts[0].body.text.includes("UTR Reply Error"));
  });
});

test("C6. catch-up posts only the newest unsent error of each bill, skips this run's logs, and nothing when the chat is off", async () => {
  const { notifyPendingUtrErrors } = require("../utils/utrErrorChat");
  const t = (min) => new Date(Date.now() - min * 60000);
  const rows = [
    { _id: "a1", billNumber: "B1", reason: "landlord_name_not_found", runId: "r0", createdAt: t(30) }, // newest of B1 → sent
    { _id: "a0", billNumber: "B1", reason: "invalid_utr", runId: "r0", createdAt: t(60) }, // older row of B1 → not sent
    { _id: "b1", billNumber: "B2", reason: "invalid_utr", runId: "r0", createdAt: t(20) }, // B2 saved later (newer log) → not sent
    { _id: "c1", billNumber: "B3", reason: "invalid_utr", runId: "rNow", createdAt: t(1) }, // this run → writeLog posts it
  ];
  const newestOf = { B1: "a1", B2: "b2-saved", B3: "c1" };
  const lastQuery = {};
  const Log = {
    find: (q) => {
      Object.assign(lastQuery, q);
      const list = rows.filter((r) => !(q.runId && r.runId === q.runId.$ne) && q.reason.test(r.reason));
      return { sort: () => ({ limit: async () => list }) };
    },
    findOne: (q) => ({ sort: () => ({ select: () => ({ lean: async () => ({ _id: newestOf[q.billNumber] }) }) }) }),
  };
  const sent = [];
  const notify = async (d) => (sent.push(d._id), true);
  await withEnv({ UTR_ERROR_CHAT_URL: URL, GOOGLE_CHAT: "on" }, async () => {
    assert.equal(await notifyPendingUtrErrors({ Log, notify, excludeRunId: "rNow" }), 1);
  });
  assert.deepEqual(sent, ["a1"]);
  assert.equal(lastQuery.chatNotifiedAt, null);
  assert.equal(lastQuery.reason.test("gmail_error"), false);
  await withEnv({ UTR_ERROR_CHAT_URL: URL, GOOGLE_CHAT: "off" }, async () => {
    assert.equal(await notifyPendingUtrErrors({ Log, notify }), 0);
  });
  assert.deepEqual(sent, ["a1"]);
});

test("C7. no reply id: a NEW wrong reply (other lines) is posted again; the same lines are not", async () => {
  await withEnv({ UTR_ERROR_CHAT_URL: URL, GOOGLE_CHAT: "on" }, async () => {
    const Model = fakeModel();
    const posts = [];
    const deps = { post: async (u, body) => posts.push(body.text), findMedia: async () => media };
    const noId = (id, lines) => Model.make(log({ _id: id, sourceMessageId: "", replyLines: lines }));
    assert.equal(await notifyUtrErrorChat(noId("N1", ["Dhoni - UTR : 1478454544"]), deps), true);
    assert.equal(await notifyUtrErrorChat(noId("N2", ["Dhoni - UTR : 1478454544"]), deps), false); // same reply
    assert.equal(await notifyUtrErrorChat(noId("N3", ["Dhoni - UTR : 1478454544", "Dhonii - UTR : 1478454545"]), deps), true); // new reply
    assert.equal(posts.length, 2);
    assert.ok(posts[1].includes("Dhonii - UTR : 1478454545"));
  });
});

test("C4. nothing is sent when UTR_ERROR_CHAT_URL is not set or GOOGLE_CHAT=off; a failing post never throws", async () => {
  const posts = [];
  const deps = { post: async () => posts.push(1), findMedia: async () => media };
  await withEnv({ UTR_ERROR_CHAT_URL: undefined, GOOGLE_CHAT: "on" }, async () => {
    assert.equal(await notifyUtrErrorChat(log(), deps), false);
  });
  await withEnv({ UTR_ERROR_CHAT_URL: URL, GOOGLE_CHAT: "off" }, async () => {
    assert.equal(await notifyUtrErrorChat(log(), deps), false);
  });
  assert.equal(posts.length, 0);
  await withEnv({ UTR_ERROR_CHAT_URL: URL, GOOGLE_CHAT: "on" }, async () => {
    const failing = { post: async () => { throw new Error("network down"); }, findMedia: async () => media };
    assert.equal(await notifyUtrErrorChat(log(), failing), false);
  });
});
