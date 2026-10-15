#!/usr/bin/env node
// Publishes a signed release APK for the in-app updater (GET /admin/app-update/version).
// 1. validates the APK file, 2. computes SHA-256 + size, 3. copies it to public/apk under a
// versioned name (never overwrites a different file), 4. writes config/appRelease.json atomically.
// The previous APK is left in place; the switch happens only when the metadata file is replaced.
// The same logic runs automatically when the server sees a new public/apk/app-release.apk
// (utils/apkAutoPublish.js); this script is the manual way, with extra options.
//
// versionName / versionCode / package are read from the APK's AndroidManifest.xml in plain Node.js
// (utils/apkManifest.js, no Android SDK needed), so --version / --code are optional; when given they
// must match the APK.
//
// Usage:
//   node scripts/publish-apk-release.js --apk <path/to/app-release.apk> [--version 1.0.1 --code 2]
//        [--min-code 1] [--min-version 1.0.0] [--force] [--message "..."] [--notes "fix A|fix B"]
//        [--apk-url https://cdn.example.com/app.apk] [--release-file <path>] [--dry-run]
const path = require("path");
const { publishApk } = require("../utils/apkRelease");

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (["force", "dry-run"].includes(key)) out[key] = true;
    else {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      out[key] = argv[++i];
    }
  }
  return out;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apk) throw new Error("--apk is required");
  const dryRun = args["dry-run"] === true;

  const { meta, apk, inApk, dest, releaseFile } = await publishApk({
    apk: args.apk,
    releaseFile: args["release-file"],
    version: args.version,
    code: args.code,
    minCode: args["min-code"],
    minVersion: args["min-version"],
    force: args.force === true,
    message: args.message,
    notes: args.notes ? args.notes.split("|").map((s) => s.trim()).filter(Boolean) : [],
    apkUrl: args["apk-url"],
    dryRun,
  });

  console.log(`APK          : ${apk}`);
  console.log(`Read from APK: ${inApk.packageName} ${inApk.versionName} (${inApk.versionCode})`);
  console.log(`Size         : ${meta.apkSize} bytes`);
  console.log(`SHA-256      : ${meta.sha256}`);
  console.log(`Version      : ${meta.latestVersion} (versionCode ${meta.versionCode})`);
  console.log(`Min code     : ${meta.minimumVersionCode}   forceUpdate: ${meta.forceUpdate}`);
  console.log(`Release file : ${releaseFile}`);
  console.log(dest ? `Server copy  : ${dest}` : `External URL : ${meta.apkUrl} (upload the same file there first)`);
  console.log(dryRun ? "\n--dry-run: nothing written." : "\nRelease published. Verify: GET <API_BASE>/admin/app-update/version");
};

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
