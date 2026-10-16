// Run: npm test   (node:test, no extra dependencies)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const express = require("express");
const { createVersionHandler, validateRelease } = require("../controllers/Admin/AppUpdateController/AppUpdateController");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-update-test-"));
const apkDir = path.join(tmp, "apk");
const releaseFile = path.join(tmp, "appRelease.json");
const apkBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(2048)]);
const apkSha = crypto.createHash("sha256").update(apkBytes).digest("hex");

const goodMeta = () => ({
  enabled: true,
  latestVersion: "1.0.1",
  versionCode: 2,
  minimumVersion: "1.0.0",
  minimumVersionCode: 1,
  apkFile: "app-release-1.0.1-2.apk",
  sha256: apkSha,
  apkSize: apkBytes.length,
  forceUpdate: false,
  message: "A new version is available.",
});
const writeMeta = (m) => fs.writeFileSync(releaseFile, JSON.stringify(m));

let server, base;
const savedEnv = { ...process.env };

before(async () => {
  fs.mkdirSync(apkDir);
  fs.writeFileSync(path.join(apkDir, "app-release-1.0.1-2.apk"), apkBytes);
  process.env.NODE_ENV = "development";
  delete process.env.APP_UPDATE_PUBLIC_BASE_URL;
  const app = express();
  app.get("/admin/app-update/version", createVersionHandler({ releaseFile, apkDir }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async () => {
  const res = await fetch(`${base}/admin/app-update/version`);
  return { status: res.status, body: await res.json() };
};

test("valid release returns metadata with download URL", async () => {
  writeMeta(goodMeta());
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.latestVersion, "1.0.1");
  assert.equal(body.data.versionCode, 2);
  assert.equal(body.data.minimumVersionCode, 1);
  assert.equal(body.data.sha256, apkSha);
  assert.equal(body.data.forceUpdate, false);
  assert.match(body.data.apkUrl, /\/public\/apk\/app-release-1\.0\.1-2\.apk$/);
});

test("APP_UPDATE_PUBLIC_BASE_URL is used for the APK URL (reverse proxy sub-path)", async () => {
  process.env.APP_UPDATE_PUBLIC_BASE_URL = "https://example.com/ooh-rms/api/";
  writeMeta(goodMeta());
  const { body } = await get();
  delete process.env.APP_UPDATE_PUBLIC_BASE_URL;
  assert.equal(body.data.apkUrl, "https://example.com/ooh-rms/api/public/apk/app-release-1.0.1-2.apk");
});

test("forceUpdate is passed through", async () => {
  writeMeta({ ...goodMeta(), forceUpdate: true });
  const { body } = await get();
  assert.equal(body.data.forceUpdate, true);
});

test("missing metadata file → 404", async () => {
  fs.rmSync(releaseFile, { force: true });
  const { status, body } = await get();
  assert.equal(status, 404);
  assert.equal(body.success, false);
});

test("disabled release → 404", async () => {
  writeMeta({ ...goodMeta(), enabled: false });
  assert.equal((await get()).status, 404);
});

test("malformed JSON → 500", async () => {
  fs.writeFileSync(releaseFile, "{ not json");
  assert.equal((await get()).status, 500);
});

test("invalid metadata → 500 with reasons", async () => {
  writeMeta({ ...goodMeta(), versionCode: 0, sha256: "abc" });
  const { status, body } = await get();
  assert.equal(status, 500);
  assert.ok(body.error.some((e) => e.includes("versionCode")));
  assert.ok(body.error.some((e) => e.includes("sha256")));
});

test("APK checksum mismatch on server → 503 (never advertise a wrong file)", async () => {
  writeMeta({ ...goodMeta(), sha256: "0".repeat(64) });
  assert.equal((await get()).status, 503);
});

test("missing APK file → 503", async () => {
  writeMeta({ ...goodMeta(), apkFile: "does-not-exist.apk" });
  assert.equal((await get()).status, 503);
});

test("path traversal in apkFile is rejected", () => {
  const { errors } = validateRelease({ ...goodMeta(), apkFile: "../../.env" });
  assert.ok(errors && errors.some((e) => e.includes("apkFile")));
});

test("production requires HTTPS apkUrl unless APP_UPDATE_ALLOW_HTTP", () => {
  process.env.NODE_ENV = "production";
  delete process.env.APP_UPDATE_ALLOW_HTTP;
  const http = { ...goodMeta(), apkFile: "", apkUrl: "http://example.com/a.apk" };
  assert.ok(validateRelease(http).errors);
  assert.ok(validateRelease({ ...http, apkUrl: "https://example.com/a.apk" }).release);
  process.env.APP_UPDATE_ALLOW_HTTP = "1";
  assert.ok(validateRelease(http).release);
  delete process.env.APP_UPDATE_ALLOW_HTTP;
  process.env.NODE_ENV = "development";
});

test("minimumVersionCode cannot exceed versionCode", () => {
  assert.ok(validateRelease({ ...goodMeta(), minimumVersionCode: 3 }).errors);
});

// Minimal APK (stored ZIP) whose AndroidManifest.xml is binary XML with package/versionCode/versionName.
const buildFakeApk = ({ pkg, versionCode, versionName }) => {
  const strings = ["versionCode", "versionName", "package", "manifest", versionName, pkg];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

  const data = strings.map((str) => Buffer.concat([u16(str.length), Buffer.from(str, "utf16le"), u16(0)]));
  const offsets = []; let o = 0;
  for (const d of data) { offsets.push(o); o += d.length; }
  const body = pad4(Buffer.concat(data));
  const poolHeader = 28 + strings.length * 4;
  const pool = Buffer.concat([u16(0x0001), u16(28), u32(poolHeader + body.length), u32(strings.length), u32(0), u32(0),
    u32(poolHeader), u32(0), ...offsets.map(u32), body]);
  const resMap = Buffer.concat([u16(0x0180), u16(8), u32(16), u32(0x0101021b), u32(0x0101021c)]);
  const attr = (name, raw, type, value) => Buffer.concat([u32(0xffffffff), u32(name), u32(raw), u16(8), Buffer.from([0, type]), u32(value)]);
  const attrs = Buffer.concat([attr(0, 0xffffffff, 0x10, versionCode), attr(1, 4, 0x03, 4), attr(2, 5, 0x03, 5)]);
  const ext = Buffer.concat([u32(0xffffffff), u32(3), u16(20), u16(20), u16(3), u16(0), u16(0), u16(0)]);
  const elem = Buffer.concat([u16(0x0102), u16(16), u32(16 + ext.length + attrs.length), u32(1), u32(0xffffffff), ext, attrs]);
  const axml = Buffer.concat([u16(0x0003), u16(8), u32(8 + pool.length + resMap.length + elem.length), pool, resMap, elem]);

  const name = Buffer.from("AndroidManifest.xml");
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(axml.length), u32(axml.length), u16(name.length), u16(0), name, axml]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(axml.length), u32(axml.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, eocd]);
};

test("readApkManifest reads package / versionCode / versionName", () => {
  const { readApkManifest } = require("../utils/apkManifest");
  const f = path.join(tmp, "manifest.apk");
  fs.writeFileSync(f, buildFakeApk({ pkg: "com.example.app", versionCode: 12, versionName: "2.3.4" }));
  assert.deepEqual(readApkManifest(f), { packageName: "com.example.app", versionCode: 12, versionName: "2.3.4" });
});

test("publish script: reads version from APK, writes metadata, refuses duplicate/lower/mismatch", () => {
  const script = path.join(__dirname, "..", "scripts", "publish-apk-release.js");
  const rf = path.join(tmp, "published.json");
  const src = path.join(tmp, "build.apk");
  const bytes = buildFakeApk({ pkg: "com.outdoormedia.app", versionCode: 2, versionName: "1.0.1" });
  fs.writeFileSync(src, bytes);
  const run = (args) => execFileSync(process.execPath, [script, ...args, "--release-file", rf, "--apk-url", "https://example.com/x.apk"], { encoding: "utf8" });

  assert.throws(() => run(["--apk", src, "--code", "3"]), /does not match the APK versionCode 2/);

  run(["--apk", src, "--min-code", "1"]);
  const meta = JSON.parse(fs.readFileSync(rf, "utf8"));
  assert.equal(meta.latestVersion, "1.0.1");
  assert.equal(meta.versionCode, 2);
  assert.equal(meta.packageName, "com.outdoormedia.app");
  assert.equal(meta.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(meta.apkSize, bytes.length);

  assert.throws(() => run(["--apk", src]), /must be greater/);

  const other = path.join(tmp, "other.apk");
  fs.writeFileSync(other, buildFakeApk({ pkg: "com.other.app", versionCode: 5, versionName: "9.9.9" }));
  assert.throws(() => run(["--apk", other]), /differs from the published package/);

  const notApk = path.join(tmp, "not.apk");
  fs.writeFileSync(notApk, "hello");
  assert.throws(() => run(["--apk", notApk]), /not a valid APK/);
  assert.throws(() => run(["--apk", path.join(tmp, "build-noversion.apk")]), /APK not found/);
});

test("auto-publish: waits for a stable file, publishes, then ignores the same file", async () => {
  const { createApkAutoPublisher } = require("../utils/apkAutoPublish");
  const dir = path.join(tmp, "auto");
  fs.mkdirSync(dir);
  const rf = path.join(tmp, "auto-release.json");
  const quiet = { log: () => {}, error: () => {} };
  const pub = createApkAutoPublisher({ watchDir: dir, apkDir: dir, releaseFile: rf, log: quiet });

  assert.equal(await pub.check(), "idle"); // nothing dropped yet
  fs.writeFileSync(path.join(dir, "app-release.apk"), buildFakeApk({ pkg: "com.outdoormedia.app", versionCode: 4, versionName: "1.2.0" }));
  assert.equal(await pub.check(), "waiting"); // first sighting
  assert.equal(await pub.check(), "published"); // stable → published
  const meta = JSON.parse(fs.readFileSync(rf, "utf8"));
  assert.equal(meta.latestVersion, "1.2.0");
  assert.equal(meta.versionCode, 4);
  assert.ok(fs.existsSync(path.join(dir, "app-release-1.2.0-4.apk")));
  assert.equal(await pub.check(), "idle");

  // lower versionCode dropped → not published, previous release kept
  fs.writeFileSync(path.join(dir, "app-release.apk"), buildFakeApk({ pkg: "com.outdoormedia.app", versionCode: 3, versionName: "1.1.9" }));
  await pub.check();
  assert.equal(await pub.check(), "skipped");
  assert.equal(JSON.parse(fs.readFileSync(rf, "utf8")).versionCode, 4);

  // a partial upload (not a complete ZIP) is skipped
  fs.writeFileSync(path.join(dir, "app-release.apk"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
  await pub.check();
  assert.equal(await pub.check(), "skipped");
  assert.equal(JSON.parse(fs.readFileSync(rf, "utf8")).versionCode, 4);
});

test("auto-publish: recovers when the metadata points to an APK missing on the server", async () => {
  const { createApkAutoPublisher } = require("../utils/apkAutoPublish");
  const watch = path.join(tmp, "heal-watch");
  const served = path.join(tmp, "heal-served");
  fs.mkdirSync(watch);
  const rf = path.join(tmp, "heal-release.json");
  const quiet = { log: () => {}, error: () => {} };
  const bytes = buildFakeApk({ pkg: "com.outdoormedia.app", versionCode: 2, versionName: "1.0.1" });
  fs.writeFileSync(path.join(watch, "app-release.apk"), bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");

  // 1) metadata committed from another machine: same APK, served copy missing → restored
  fs.writeFileSync(rf, JSON.stringify({ enabled: true, packageName: "com.outdoormedia.app", latestVersion: "1.0.1", versionCode: 2,
    apkFile: "app-release-1.0.1-2.apk", sha256: sha, apkSize: bytes.length }));
  const pub = createApkAutoPublisher({ watchDir: watch, apkDir: served, releaseFile: rf, log: quiet });
  await pub.check();
  assert.equal(await pub.check(), "restored");
  assert.ok(fs.existsSync(path.join(served, "app-release-1.0.1-2.apk")));

  // 2) served copy deleted later → noticed again and restored
  fs.rmSync(path.join(served, "app-release-1.0.1-2.apk"));
  assert.equal(await pub.check(), "restored");

  // 3) metadata with same versionCode but a different (missing) APK → republished from release/apk
  fs.writeFileSync(rf, JSON.stringify({ enabled: true, packageName: "com.outdoormedia.app", latestVersion: "1.0.1", versionCode: 2,
    apkFile: "app-release-other.apk", sha256: "0".repeat(64), apkSize: 1 }));
  const pub2 = createApkAutoPublisher({ watchDir: watch, apkDir: served, releaseFile: rf, log: quiet });
  await pub2.check();
  assert.equal(await pub2.check(), "published");
  assert.equal(JSON.parse(fs.readFileSync(rf, "utf8")).sha256, sha);
});
