# In-app APK update (without Play Store)

## How it works

1. The Flutter app (Android only) calls `GET /admin/app-update/version` when it opens, on every page change
   (`AppNavigationShell` in `lib/main.dart`) and when it comes back to the foreground. It checks at most once every 30 seconds.
2. If the published `versionCode` is higher than the installed one, the app shows **"Update Available!"** on whatever
   page is open. **Every update is mandatory:** there is no "Later" button and the dialog cannot be dismissed, so
   `forceUpdate` / `minimumVersionCode` have no extra effect in the app today.
3. **Download & Update** saves the APK in the app cache (`<cache>/apk_update/`). The app then checks the size, the ZIP
   header and the **SHA-256** from the API. It also checks the package name, versionCode and signing certificate
   against the installed app. Only then does it open the Android package installer (PackageInstaller session). The
   user always confirms the install.
4. The installer reports success, cancellation or failure back to the app. The app never treats "installer opened"
   as "installed". When the app comes back to the foreground, it reads the installed version again.

If the API is down, returns 404 (nothing published) or returns invalid data, the app carries on normally.

## API

`GET /admin/app-update/version` is public: it returns release metadata only and needs no token.

```json
{
  "success": true,
  "statusCode": 200,
  "message": "A new version is available.",
  "data": {
    "latestVersion": "1.0.1",
    "versionCode": 2,
    "minimumVersion": "1.0.0",
    "minimumVersionCode": 1,
    "apkUrl": "https://adinntech.in/ooh-rms/api/public/apk/app-release-1.0.1-2.apk",
    "sha256": "<64 hex chars>",
    "apkSize": 83736117,
    "forceUpdate": false,
    "message": "A new version is available.",
    "releaseNotes": [],
    "publishedAt": "2026-10-14T10:00:00.000Z"
  }
}
```

| Status | Meaning |
|---|---|
| 200 | Release available (the app compares `versionCode`) |
| 404 | No release published (`config/appRelease.json` missing, or `enabled: false`) |
| 500 | Metadata invalid (the reasons are in `error[]` and the server log) or the download URL is not configured |
| 503 | The APK file is missing on the server, or it does not match the published `sha256` / `apkSize` |

The metadata is in `config/appRelease.json`. This file is server-specific and gitignored; see
`config/appRelease.example.json`. It is read on every request, so publishing a release needs **no restart**.
The APK is served by the existing `/public` static route from `public/apk/`. Directory listing is not enabled.

### Environment variables (add to the server's `.env`)

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `APP_UPDATE_PUBLIC_BASE_URL` | **Yes in production** | `https://adinntech.in/ooh-rms/api` | Public base URL used to build `apkUrl` (the API sits behind a reverse-proxy sub-path) |
| `APP_UPDATE_ALLOW_HTTP` | No | `1` | Allow a non-HTTPS `apkUrl` when `NODE_ENV=production`. Keep it unset in production |
| `APP_UPDATE_AUTO_PUBLISH` | No | `0` | Turn off auto-publishing of `public/apk/app-release.apk` (on by default) |
| `APP_RELEASE_FILE` | No | `/srv/ooh/appRelease.json` | Alternative location for the release metadata |

Outside production, a missing `APP_UPDATE_PUBLIC_BASE_URL` falls back to the request host, which is fine for LAN testing.

## Release workflow

> **Signing (read first).** Android installs an update in place only when the package name is the same
> (`com.outdoormedia.app`), the `versionCode` is higher, and the APK is signed with the **same certificate**.
> There is no `android/key.properties` today, so `flutter build apk --release` signs with the **debug keystore
> of the machine that builds it** (`%USERPROFILE%\.android\debug.keystore`). The APK currently published was
> signed with that key (certificate SHA-256 `a36eba92…a447c`). Back up that keystore. If it is lost, or you build
> on another PC, phones will reject the update and users will have to uninstall the app (losing local data).
> Moving to a dedicated release key also needs one uninstall/reinstall, unless you use APK Signature Scheme v3
> key rotation (Android 9+ only). Decide this before the next release.

1. **Change code** in `Outdoor_Media_Frontend`.
2. **Bump the version** in `pubspec.yaml`, for example `version: 1.0.2+4`. The number after `+` is the
   **versionCode** and must be higher than every build ever installed. The server APK is already `1.1.0+2`, so use **3 or higher**.
3. **Build** with the project's Flutter SDK (`android/local.properties` → `C:\Users\User\Flutter3.44.2\flutter`):
   ```
   cd Outdoor_Media_Frontend
   flutter build apk --release
   ```
   Output: `build\app\outputs\flutter-apk\app-release.apk`.
   Check that the release `ApiConstants.baseUrl` is the production HTTPS URL before you build.
4. **Verify the APK** (Android SDK build-tools):
   ```
   aapt2 dump badging build\app\outputs\flutter-apk\app-release.apk      # package name + versionCode/versionName
   apksigner verify --print-certs build\app\outputs\flutter-apk\app-release.apk   # signer must match the installed app
   certutil -hashfile build\app\outputs\flutter-apk\app-release.apk SHA256       # optional, the script computes it too
   ```
5. **Upload** the APK to the server, anywhere temporary (for example `~/app-release.apk`).
6. **Publish**. **Automatic:** while the backend runs, it checks `public/apk/app-release.apk` every 5 seconds
   (`utils/apkAutoPublish.js`). Copy or upload the new APK to that exact name. Once the file has stopped changing,
   the server publishes it by itself, with the same checks as the script. The previous `minimumVersionCode` /
   `minimumVersion` / `message` are kept; `forceUpdate` is off and there are no release notes. The server log shows
   `[app-update] auto-published …` or the reason it was not published. Set `APP_UPDATE_AUTO_PUBLISH=0` to turn this
   off. **Manual** (needed for `--force`, notes, or a different minimum): Run this on the server, in `Outdoor_Media_Backend`; try `--dry-run` first:
   ```
   node scripts/publish-apk-release.js --apk ~/app-release.apk --min-code 1 --dry-run
   node scripts/publish-apk-release.js --apk ~/app-release.apk --min-code 1 \
        --message "Bug fixes" --notes "Fixed ledger export|Faster dashboard"
   ```
   The script reads the package name, `versionName` and `versionCode` from the APK's `AndroidManifest.xml` in plain
   Node.js (`utils/apkManifest.js`; no Android SDK needed, works on the production server). `--version` / `--code` are
   optional and, if given, must match the APK. Simplest form:
   `node scripts/publish-apk-release.js --apk public/apk/app-release.apk --min-code 1`.
   The script checks the ZIP header and computes the SHA-256 and size. It refuses a versionCode that is not higher
   than the one already published. It copies the APK to `public/apk/app-release-<version>-<code>.apk`, verifies the
   copy, and only then switches `config/appRelease.json`, writing it atomically. Older APKs are left in place.
   Options: `--force` (mandatory update), `--min-version 1.0.0`, `--apk-url https://cdn…/x.apk` (external hosting:
   upload the identical file there first).
7. **Check the API**: `curl https://adinntech.in/ooh-rms/api/admin/app-update/version`.
   Confirm that `apkUrl` downloads (`curl -I <apkUrl>` returns 200).
8. Open the **old installed app**. The Home page shows "Update Available!".
9. Tap **Download & Update**. Watch the progress, then confirm **Install** in the Android installer. The first time,
   Android asks you to allow "Install unknown apps" for this app; the dialog's **Open Settings** button goes there.
10. The app restarts on the new version. Check the version and that the user is still logged in and the data is still there.

Rollback: you cannot install a lower versionCode over a higher one. To roll back, rebuild the old code with a
**new, higher** versionCode and publish it.

## Tests

- Backend: `npm test` (node:test). Covers a valid release, 404/500/503 cases, checksum mismatch, path traversal,
  HTTPS enforcement, and the publish script's versionCode / APK checks.
- Flutter: `flutter test test/app_update_service_test.dart`. Covers metadata parsing and validation, HTTPS rule,
  optional/mandatory logic, version comparison, SHA-256 / size / header checks and installer messages.

### Manual test matrix (on a device with an older build installed)

| Scenario | How | Expected |
|---|---|---|
| No update | publish versionCode = installed | No dialog |
| Update available | higher versionCode published | Dialog on any page; no Later; back button and outside tap do nothing |
| New release while app is open | publish while the user is on any page | Dialog appears on the next page change (30 s+ after the last check) |
| API unavailable | stop backend / airplane mode | No dialog, no crash |
| Invalid metadata | break `config/appRelease.json` | API 500, app shows no dialog |
| Download failure / interrupted | turn off Wi-Fi mid-download | "Download failed or was interrupted…" + Retry; partial file deleted |
| Wrong SHA-256 | edit `sha256` (the server returns 503 while the local file mismatches; to test on the client, host the APK externally via `apkUrl`) | "failed the security check (SHA-256 mismatch)" |
| Install permission off | deny "Install unknown apps" | "Open Settings"; returning with permission granted continues the install |
| Different package name | publish an APK of another app | "belongs to a different app" |
| Different signing key | APK built on another PC / other key | "signed with a different key…" (or the installer reports a conflict) |
| Lower / duplicate versionCode | APK versionCode ≤ installed | Publish script refuses; the app also refuses "not newer" |
| Installer cancelled | tap Cancel in the installer | "Installation was cancelled" + Retry |
| Successful in-place update | normal flow | App restarts on the new version, data kept |
