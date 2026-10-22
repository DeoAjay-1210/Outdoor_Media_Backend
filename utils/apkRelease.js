// Shared "publish an APK release" logic, used by scripts/publish-apk-release.js (manual)
// and utils/apkAutoPublish.js (folder watcher). Writes config/appRelease.json (or APP_RELEASE_FILE)
// atomically. The APK is served from release/apk (no copy); an APK given from elsewhere is copied there
// under a versioned name (never overwrites a different file).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateRelease } = require("../controllers/Admin/AppUpdateController/AppUpdateController");
const { readApkManifest } = require("./apkManifest");

const ROOT = path.join(__dirname, "..");
const DEFAULT_APK_DIR = path.join(ROOT, "release", "apk");
const defaultReleaseFile = () => process.env.APP_RELEASE_FILE || path.join(ROOT, "config", "appRelease.json");
const DEFAULT_MESSAGE = "A new version of the application is available. Please update to continue.";

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });

const isZip = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // "PK\3\4" — APKs are ZIP archives
  } finally {
    fs.closeSync(fd);
  }
};

const readRelease = (releaseFile) => {
  try {
    return JSON.parse(fs.readFileSync(releaseFile, "utf8"));
  } catch (_) {
    return null;
  }
};

/**
 * Validates the APK, reads its version from the manifest and publishes it.
 * options: apk (required), releaseFile, apkDir, version, code (must match the APK when given),
 * minCode, minVersion, force, message, notes (array), apkUrl, dryRun,
 * allowSameVersionCode (replace a broken release that has the same versionCode).
 * Returns { meta, apk, inApk, dest, releaseFile }. Throws Error with a readable message.
 */
const publishApk = async (options) => {
  const releaseFile = path.resolve(options.releaseFile || defaultReleaseFile());
  const apkDir = options.apkDir || DEFAULT_APK_DIR;
  const apk = path.resolve(options.apk || "");
  if (!options.apk || !fs.existsSync(apk) || !fs.statSync(apk).isFile()) throw new Error(`APK not found: ${apk}`);
  if (!isZip(apk)) throw new Error("File is not a valid APK (ZIP header missing)");

  // The version shown by the API must be the one actually inside the APK.
  let inApk;
  try {
    inApk = readApkManifest(apk);
  } catch (err) {
    throw new Error(`Could not read version from the APK: ${err.message}`);
  }
  if (options.version && String(options.version) !== inApk.versionName) {
    throw new Error(`--version ${options.version} does not match the APK versionName ${inApk.versionName}`);
  }
  if (options.code != null && Number(options.code) !== inApk.versionCode) {
    throw new Error(`--code ${options.code} does not match the APK versionCode ${inApk.versionCode}`);
  }

  const previous = readRelease(releaseFile);
  if (previous && previous.packageName && previous.packageName !== inApk.packageName) {
    throw new Error(`APK package ${inApk.packageName} differs from the published package ${previous.packageName}`);
  }
  const previousCode = previous ? Number(previous.versionCode) : 0;
  if (previous && (previousCode > inApk.versionCode || (previousCode === inApk.versionCode && !options.allowSameVersionCode))) {
    throw new Error(`versionCode ${inApk.versionCode} must be greater than the published versionCode ${previous.versionCode}`);
  }

  const size = fs.statSync(apk).size;
  const hash = await sha256File(apk);
  const apkUrl = options.apkUrl || "";
  const inPlace = path.dirname(apk) === path.resolve(apkDir); // already in the served folder: no copy
  const apkFile = apkUrl ? "" : inPlace ? path.basename(apk) : `app-release-${inApk.versionName}-${inApk.versionCode}.apk`;
  const meta = {
    enabled: true,
    packageName: inApk.packageName,
    latestVersion: inApk.versionName,
    versionCode: inApk.versionCode,
    minimumVersion: options.minVersion || "",
    minimumVersionCode: options.minCode != null ? Number(options.minCode) : 0,
    apkFile,
    apkUrl,
    sha256: hash,
    apkSize: size,
    forceUpdate: options.force === true,
    message: options.message || DEFAULT_MESSAGE,
    releaseNotes: Array.isArray(options.notes) ? options.notes : [],
    publishedAt: new Date().toISOString(),
  };
  const { errors } = validateRelease(meta);
  if (errors) throw new Error(`Invalid release metadata:\n  - ${errors.join("\n  - ")}`);

  const dest = apkFile ? path.join(apkDir, apkFile) : null;
  const result = { meta, apk, inApk, dest, releaseFile };
  if (options.dryRun) return result;

  if (dest && !inPlace) {
    await fs.promises.mkdir(apkDir, { recursive: true });
    if (fs.existsSync(dest)) {
      if ((await sha256File(dest)) !== hash) throw new Error(`${dest} already exists with different content; refusing to overwrite`);
    } else {
      const tmp = `${dest}.uploading`;
      await fs.promises.copyFile(apk, tmp);
      if ((await sha256File(tmp)) !== hash) {
        await fs.promises.unlink(tmp);
        throw new Error("Copied APK checksum mismatch");
      }
      await fs.promises.rename(tmp, dest);
    }
  }

  await fs.promises.mkdir(path.dirname(releaseFile), { recursive: true });
  const tmpMeta = `${releaseFile}.tmp`;
  await fs.promises.writeFile(tmpMeta, JSON.stringify(meta, null, 2) + "\n");
  await fs.promises.rename(tmpMeta, releaseFile);
  return result;
};

module.exports = { publishApk, readRelease, sha256File, DEFAULT_APK_DIR, defaultReleaseFile };
