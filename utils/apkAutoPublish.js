// Auto-publish: watches public/apk/app-release.apk and publishes it (same as
// scripts/publish-apk-release.js) once a new, complete file is there. Polling (not fs.watch)
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

const createApkAutoPublisher = ({ apkDir = DEFAULT_APK_DIR, releaseFile = defaultReleaseFile(), log = console } = {}) => {
  const file = path.join(apkDir, WATCHED_FILE);
  let seenKey = null; // size:mtime from the previous check
  let handledKey = null; // last size:mtime already processed
  let running = false;

  /** One check; returns "published", "skipped", "waiting" or "idle". */
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
      if (key === handledKey) return "idle";
      if (key !== seenKey) {
        seenKey = key; // changed since last check: wait until it is stable
        return "waiting";
      }
      handledKey = key;

      const previous = readRelease(releaseFile);
      if (previous && previous.sha256 && previous.sha256 === (await sha256File(file))) return "idle";

      try {
        const { meta } = await publishApk({
          apk: file,
          apkDir,
          releaseFile,
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
  console.log(`[app-update] watching ${publisher.file} for new releases`);
  return () => clearInterval(timer);
};

module.exports = { createApkAutoPublisher, startApkAutoPublish };
