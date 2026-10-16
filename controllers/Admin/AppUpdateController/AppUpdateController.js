// Custom APK update (no Play Store): serves the latest Android release metadata.
// Metadata lives in config/appRelease.json (or APP_RELEASE_FILE) and is read on every request,
// so publishing a release needs no restart. The APK is a static file under public/apk
// (served by the existing /public static route) or any HTTPS URL set in "apkUrl".
// See docs/APP_UPDATE_RELEASE.md and scripts/publish-apk-release.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { successResponse, errorResponse } = require("../../../utils/response");

const DEFAULT_RELEASE_FILE = path.join(__dirname, "../../../config/appRelease.json");
const DEFAULT_APK_DIR = path.join(__dirname, "../../../public/apk");

const VERSION_NAME_RE = /^\d+(\.\d+){0,3}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const APK_FILE_RE = /^[A-Za-z0-9._-]+\.apk$/;

const isTrue = (v) => v === "1" || String(v).toLowerCase() === "true";
const allowHttp = () => process.env.NODE_ENV !== "production" || isTrue(process.env.APP_UPDATE_ALLOW_HTTP);

// Validates raw metadata. Returns { errors: [...] } or { release: {...} } (apkUrl / apkFile still unresolved).
const validateRelease = (meta) => {
  const errors = [];
  if (!meta || typeof meta !== "object") return { errors: ["metadata is not a JSON object"] };

  const latestVersion = String(meta.latestVersion || "").trim();
  const versionCode = Number(meta.versionCode);
  const minimumVersion = String(meta.minimumVersion || "").trim();
  const minimumVersionCode = meta.minimumVersionCode == null || meta.minimumVersionCode === "" ? 0 : Number(meta.minimumVersionCode);
  const sha256 = String(meta.sha256 || "").trim().toLowerCase();
  const apkSize = meta.apkSize == null || meta.apkSize === "" ? 0 : Number(meta.apkSize);
  const apkUrl = String(meta.apkUrl || "").trim();
  const apkFile = String(meta.apkFile || "").trim();

  if (!VERSION_NAME_RE.test(latestVersion)) errors.push("latestVersion must look like 1.0.1");
  if (!Number.isInteger(versionCode) || versionCode < 1) errors.push("versionCode must be a positive integer");
  if (minimumVersion && !VERSION_NAME_RE.test(minimumVersion)) errors.push("minimumVersion must look like 1.0.0");
  if (!Number.isInteger(minimumVersionCode) || minimumVersionCode < 0) errors.push("minimumVersionCode must be a non-negative integer");
  else if (Number.isInteger(versionCode) && minimumVersionCode > versionCode) errors.push("minimumVersionCode cannot exceed versionCode");
  if (!SHA256_RE.test(sha256)) errors.push("sha256 must be the 64-char hex SHA-256 of the APK");
  if (!Number.isInteger(apkSize) || apkSize < 0) errors.push("apkSize must be a non-negative integer (bytes)");
  if (!apkUrl && !apkFile) errors.push("either apkFile (file in public/apk) or apkUrl is required");
  if (apkFile && !APK_FILE_RE.test(apkFile)) errors.push("apkFile must be a plain file name ending in .apk");
  if (apkUrl) {
    let u = null;
    try { u = new URL(apkUrl); } catch (_) { /* invalid */ }
    if (!u || !["https:", "http:"].includes(u.protocol)) errors.push("apkUrl must be an absolute http(s) URL");
    else if (u.protocol !== "https:" && !allowHttp()) errors.push("apkUrl must use HTTPS");
  }
  if (meta.forceUpdate != null && typeof meta.forceUpdate !== "boolean") errors.push("forceUpdate must be true or false");

  if (errors.length) return { errors };
  return {
    release: {
      latestVersion,
      versionCode,
      minimumVersion: minimumVersion || null,
      minimumVersionCode,
      sha256,
      apkSize,
      apkUrl,
      apkFile,
      forceUpdate: meta.forceUpdate === true,
      message: String(meta.message || "A new version is available."),
      releaseNotes: Array.isArray(meta.releaseNotes) ? meta.releaseNotes.map(String) : [],
      publishedAt: meta.publishedAt ? String(meta.publishedAt) : null,
    },
  };
};

// SHA-256 of a local file, streamed and cached by path + mtime + size (APKs are large).
const hashCache = new Map();
const sha256OfFile = async (file) => {
  const st = await fs.promises.stat(file);
  const cached = hashCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const sha256 = await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });
  const v = { mtimeMs: st.mtimeMs, size: st.size, sha256 };
  hashCache.set(file, v);
  return v;
};

// Public base URL of this API (e.g. https://adinntech.in/ooh-rms/api). Needed behind a reverse proxy
// sub-path; falls back to the request origin outside production.
const publicBaseUrl = (req) => {
  const configured = String(process.env.APP_UPDATE_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return null;
  return `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
};

const createVersionHandler = ({ releaseFile, apkDir } = {}) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  const file = releaseFile || process.env.APP_RELEASE_FILE || DEFAULT_RELEASE_FILE;
  const dir = apkDir || DEFAULT_APK_DIR;

  let meta;
  try {
    meta = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return errorResponse(res, "No app release published", null, 404);
    console.error("[app-update] release metadata unreadable:", err.message);
    return errorResponse(res, "Release metadata is invalid", null, 500);
  }
  if (!meta || meta.enabled !== true) return errorResponse(res, "No app release published", null, 404);

  const { errors, release } = validateRelease(meta);
  if (errors) {
    console.error("[app-update] invalid release metadata:", errors.join("; "));
    return errorResponse(res, "Release metadata is invalid", errors, 500);
  }

  let apkUrl = release.apkUrl;
  if (!apkUrl) {
    const apkPath = path.join(dir, release.apkFile);
    let local;
    try {
      local = await sha256OfFile(apkPath);
    } catch (err) {
      console.error("[app-update] APK file missing:", release.apkFile);
      return errorResponse(res, "Release APK is not available on the server", null, 503);
    }
    // Never advertise a file that differs from the published checksum (partial upload / wrong file).
    if (local.sha256 !== release.sha256 || (release.apkSize && local.size !== release.apkSize)) {
      console.error("[app-update] APK on server does not match release sha256/apkSize:", release.apkFile);
      return errorResponse(res, "Release APK does not match its checksum", null, 503);
    }
    if (!release.apkSize) release.apkSize = local.size;
    const base = publicBaseUrl(req);
    if (!base) {
      console.error("[app-update] APP_UPDATE_PUBLIC_BASE_URL is not set");
      return errorResponse(res, "Release download URL is not configured", null, 500);
    }
    apkUrl = `${base}/public/apk/${encodeURIComponent(release.apkFile)}`;
    if (!apkUrl.startsWith("https://") && !allowHttp()) {
      return errorResponse(res, "Release download URL must use HTTPS", null, 500);
    }
  }

  return successResponse(res, release.message, {
    latestVersion: release.latestVersion,
    versionCode: release.versionCode,
    minimumVersion: release.minimumVersion,
    minimumVersionCode: release.minimumVersionCode,
    apkUrl,
    sha256: release.sha256,
    apkSize: release.apkSize,
    forceUpdate: release.forceUpdate,
    message: release.message,
    releaseNotes: release.releaseNotes,
    publishedAt: release.publishedAt,
  });
};

const getAppVersion = createVersionHandler();

module.exports = { getAppVersion, createVersionHandler, validateRelease, sha256OfFile };
