// Auto-publish: watches release/apk/app-release.apk (committed to git and deployed with the code)
// and publishes it (same as scripts/publish-apk-release.js) once a new, complete file is there:
// a versioned copy goes to public/apk (served for download) and config/appRelease.json is updated.
// Polling (not fs.watch)
// so it also works on Docker volumes / network drives. Disable with APP_UPDATE_AUTO_PUBLISH=0.
//
// A file is published only when:
//  - its size + modified time are unchanged between two checks (upload/copy finished),
//  - it differs from the published APK (SHA-256),
//  - its versionCode is higher than the published one and the package name matches.
// Kept from the previous release: minimumVersionCode / minimumVersion / message.
// forceUpdate and release notes are not set automatically; use the script for those.
const fs = require("fs");
const path = require("path");
const { publishApk, readRelease, sha256File, DEFAULT_APK_DIR, defaultReleaseFile } = require("./apkRelease");

const WATCHED_FILE = "app-release.apk";
const DEFAULT_WATCH_DIR = path.join(__dirname, "..", "release", "apk");

const createApkAutoPublisher = ({
  watchDir = DEFAULT_WATCH_DIR,
  apkDir = DEFAULT_APK_DIR,
  releaseFile = defaultReleaseFile(),
  log = console,
} = {}) => {
  const file = path.join(watchDir, WATCHED_FILE);
  let seenKey = null; // size:mtime from the previous check
  let handledKey = null; // last size:mtime already processed
  let running = false;

  // Published APK named in the metadata, or null when the release has no local file (external apkUrl).
  const publishedFile = (release) =>
    release && release.apkFile && !release.apkUrl ? path.join(apkDir, path.basename(String(release.apkFile))) : null;
  const exists = (f) => fs.promises.access(f).then(() => true, () => false);

  /** One check; returns "published", "restored", "skipped", "waiting" or "idle". */
  const check = async () => {
    if (running) return "idle";
    running = true;
    try {
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch (_) {
        return "idle"; // no APK dropped
      }
      const key = `${st.size}:${st.mtimeMs}`;
      if (key === handledKey) {
        // Already handled: re-check only if the published APK went missing (e.g. after a redeploy).
        const published = publishedFile(readRelease(releaseFile));
        if (!published || (await exists(published))) return "idle";
        handledKey = null;
        seenKey = key; // file is unchanged, so it is already stable
      }
      if (key !== seenKey) {
        seenKey = key; // changed since last check: wait until it is stable
        return "waiting";
      }
      handledKey = key;

      const previous = readRelease(releaseFile);
      const published = publishedFile(previous);
      const brokenRelease = !!published && !(await exists(published)); // metadata points to a missing APK
      const sha = await sha256File(file);

      if (previous && previous.sha256 === sha) {
        if (!brokenRelease) return "idle";
        // Same APK as published but its served copy is missing: restore it.
        const tmp = `${published}.uploading`;
        await fs.promises.mkdir(apkDir, { recursive: true });
        await fs.promises.copyFile(file, tmp);
        if ((await sha256File(tmp)) !== sha) {
          await fs.promises.unlink(tmp);
          log.error(`[app-update] could not restore ${path.basename(published)}: copy checksum mismatch`);
          return "skipped";
        }
        await fs.promises.rename(tmp, published);
        log.log(`[app-update] restored missing ${path.basename(published)} from ${WATCHED_FILE}`);
        return "restored";
      }

      try {
        const { meta } = await publishApk({
          apk: file,
          apkDir,
          releaseFile,
          // A release whose APK is missing cannot be served; let the same versionCode replace it.
          allowSameVersionCode: brokenRelease,
          minCode: previous ? previous.minimumVersionCode : undefined,
          minVersion: previous ? previous.minimumVersion : undefined,
          message: previous ? previous.message : undefined,
        });
        log.log(`[app-update] auto-published ${meta.latestVersion} (versionCode ${meta.versionCode}) from ${WATCHED_FILE}`);
        return "published";
      } catch (err) {
        log.error(`[app-update] ${WATCHED_FILE} not published: ${err.message}`);
        return "skipped";
      }
    } finally {
      running = false;
    }
  };

  return { check, file };
};

const startApkAutoPublish = ({ intervalMs = 5000, ...options } = {}) => {
  const publisher = createApkAutoPublisher(options);
  const tick = () => publisher.check().catch((err) => console.error("[app-update] auto-publish check failed:", err.message));
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  // console.log(`[app-update] watching ${publisher.file} for new releases`);
  return () => clearInterval(timer);
};

module.exports = { createApkAutoPublisher, startApkAutoPublish };
