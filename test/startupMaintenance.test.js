// Loads server.js with EVERY dependency stubbed: no database, no network, no port, no timers.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { skipStartupMaintenance } = require("../utils/startupFlags");

test("flag parsing: default off; only true/1 (any case, trimmed) turns it on", () => {
  assert.equal(skipStartupMaintenance({}), false);
  for (const v of [undefined, "", "false", "0", "no", "yes", "tru"]) {
    assert.equal(skipStartupMaintenance({ SKIP_STARTUP_MAINTENANCE: v }), false, String(v));
  }
  for (const v of ["true", "TRUE", " True ", "1"]) {
    assert.equal(skipStartupMaintenance({ SKIP_STARTUP_MAINTENANCE: v }), true, String(v));
  }
});

const SERVER = path.join(__dirname, "..", "server.js");
const CRON_ENV = ["SKIP_STARTUP_MAINTENANCE", "CMD_NOTIFICATION_PURGE_CRON", "APP_UPDATE_AUTO_PUBLISH"];

/** Runs server.js against stubs and returns what it tried to do. */
const bootServer = async (flag, purgeCron) => {
  const calls = { sync: 0, appraisals: 0, purge: 0, seed: 0, fixOverdue: 0, crons: [], connectDB: 0, listen: 0, apk: 0, dns: 0 };
  const noop = () => {};
  const router = () => ({ use: noop, get: noop, post: noop });
  const app = { use: noop, get: noop, listen: () => { calls.listen++; } };
  const express = Object.assign(() => app, { json: () => noop, static: () => noop, Router: router });

  const stubs = {
    dns: { setServers: () => { calls.dns++; } },
    "node-cron": { schedule: (expr, fn) => { calls.crons.push({ expr, fn }); } },
    dotenv: { config: noop },
    express,
    cors: () => noop,
    "config/db": () => { calls.connectDB++; },
    MediaOnboardingSchema: { syncBillingCycles: async () => { calls.sync++; return { checked: 0, updated: 0 }; } },
    "MediaOnboardingController/MediaOnboardingController": { applyDueAppraisals: async () => { calls.appraisals++; return { checked: 0, applied: 0, failed: 0, details: [] }; } },
    "NotificationController/CmdNotificationController": { purgeOldCmdNotifications: async () => { calls.purge++; return { deleted: 0 }; } },
    "MediaOnboardingController/RentalDueNew2Controller": { fixSingleBillOverdueAmounts: async () => { calls.fixOverdue++; return { checked: 0, fixed: 0 }; } },
    "landOwnerMasterController/landOwnerMasterController": { seedLandOwnerBankAccounts: async () => { calls.seed++; return { seeded: 0 }; } },
    "utils/apkAutoPublish": { startApkAutoPublish: () => { calls.apk++; } },
  };
  const routeStub = router();

  const saved = {};
  for (const k of CRON_ENV) saved[k] = process.env[k];
  if (flag === undefined) delete process.env.SKIP_STARTUP_MAINTENANCE; else process.env.SKIP_STARTUP_MAINTENANCE = flag;
  if (purgeCron === undefined) delete process.env.CMD_NOTIFICATION_PURGE_CRON; else process.env.CMD_NOTIFICATION_PURGE_CRON = purgeCron;

  const realLoad = Module._load;
  const logs = [];
  const realLog = console.log;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === SERVER) {
      if (request === "path" || request === "./utils/startupFlags") return realLoad.apply(this, arguments);
      const key = Object.keys(stubs).find((k) => request === k || request.replace(/\\/g, "/").endsWith(`/${k}`));
      if (key) return stubs[key];
      if (/\/routes\//.test(request.replace(/\\/g, "/"))) return routeStub;
      throw new Error(`unstubbed require from server.js: ${request}`);
    }
    return realLoad.apply(this, arguments);
  };
  console.log = (...a) => logs.push(a.join(" "));
  try {
    delete require.cache[SERVER];
    require(SERVER);
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget async calls start
  } finally {
    Module._load = realLoad;
    console.log = realLog;
    delete require.cache[SERVER];
    for (const k of CRON_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { calls, logs };
};

test("flag unset: all five routines run at startup and all three cron schedules are registered (unchanged behaviour)", async () => {
  const { calls, logs } = await bootServer(undefined);
  assert.deepEqual(
    { sync: calls.sync, appraisals: calls.appraisals, purge: calls.purge, seed: calls.seed, fixOverdue: calls.fixOverdue },
    { sync: 1, appraisals: 1, purge: 1, seed: 1, fixOverdue: 1 },
  );
  assert.deepEqual(calls.crons.map((c) => c.expr).sort(), ["10 0 * * *", "15 * * * *", "5 0 * * *"]);
  assert.equal(logs.some((l) => l.includes("SKIP_STARTUP_MAINTENANCE")), false);
});

test("flag=false behaves exactly like unset", async () => {
  const { calls } = await bootServer("false");
  assert.equal(calls.sync + calls.appraisals + calls.purge + calls.seed + calls.fixOverdue, 5);
  assert.equal(calls.crons.length, 3);
});

test("flag=true: none of the five routines runs and no maintenance cron is scheduled", async () => {
  const { calls, logs } = await bootServer("true");
  assert.deepEqual(
    { sync: calls.sync, appraisals: calls.appraisals, purge: calls.purge, seed: calls.seed, fixOverdue: calls.fixOverdue },
    { sync: 0, appraisals: 0, purge: 0, seed: 0, fixOverdue: 0 },
  );
  assert.equal(calls.crons.length, 0);
  assert.equal(logs.some((l) => l.includes("SKIP_STARTUP_MAINTENANCE is on")), true);
});

test("flag=true: the rest of startup is unchanged (DB connect, listen, APK watcher, DNS)", async () => {
  const { calls } = await bootServer("true");
  assert.equal(calls.connectDB, 1);
  assert.equal(calls.listen, 1);
  assert.equal(calls.apk, 1);
  assert.equal(calls.dns, 1);
});

test("flag=true: a custom purge cron expression is not scheduled either", async () => {
  assert.equal((await bootServer("true", "* * * * *")).calls.crons.length, 0);
  assert.deepEqual((await bootServer(undefined, "* * * * *")).calls.crons.map((c) => c.expr).sort(), ["* * * * *", "10 0 * * *", "5 0 * * *"]);
});
