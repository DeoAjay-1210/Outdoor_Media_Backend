const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost/cb";

// in-memory stand-in for the GmailConnection model, injected before gmailService loads it
const store = { doc: null };
const modelPath = require.resolve("../models/Admin/GmailConnectionSchema.js");
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: {
    findOne: () => ({ lean: async () => store.doc }),
    deleteOne: async () => { store.doc = null; },
    findOneAndUpdate: async (_q, upd) => { store.doc = { key: "primary", ...upd.$set }; return store.doc; },
  },
};
const Gmail = require("../utils/gmailService");

test("GC1. the login token is encrypted: round trip works, the stored text never contains the token", () => {
  const blob = Gmail.encrypt("1//refresh-token-abc");
  assert.ok(!blob.includes("refresh-token-abc"));
  assert.equal(Gmail.decrypt(blob), "1//refresh-token-abc");
  assert.notEqual(Gmail.encrypt("x"), Gmail.encrypt("x")); // random IV
});

test("GC2. nothing connected and no environment token: 409 'not connected'", async () => {
  delete process.env.GOOGLE_REFRESH_TOKEN;
  store.doc = null;
  await assert.rejects(() => Gmail.getThread("t1"), (e) => e.status === 409 && /not connected/i.test(e.message));
  const s = await Gmail.connectionStatus();
  assert.deepEqual([s.connected, s.source], [false, "none"]);
});

test("GC3. GOOGLE_REFRESH_TOKEN in the environment is NOT read any more: only the database token counts", async () => {
  process.env.GOOGLE_REFRESH_TOKEN = "env-token";
  store.doc = null;
  await Gmail.disconnect(); // clears the cache
  const s = await Gmail.connectionStatus();
  assert.deepEqual([s.connected, s.source], [false, "none"]);
  await assert.rejects(() => Gmail.getThread("t1"), (e) => e.status === 409);
  delete process.env.GOOGLE_REFRESH_TOKEN;
});

test("GC5. nothing is written to .env and no env token setter is exported", () => {
  assert.equal(Gmail.saveEnvValue, undefined);
  assert.equal(typeof Gmail.connectWithRefreshToken, "function");
});

test("GC4. a wrong key / corrupt value never crashes: it falls back to the environment", () => {
  assert.equal(Gmail.decrypt(""), "");
  assert.throws(() => Gmail.decrypt("a.b.c"));
});
