# Release APK

Put the signed release APK here as **`app-release.apk`**, then commit and push it with the backend.

When the backend runs (after deploy), it checks this file every 5 seconds. A new, higher
versionCode is published automatically: a versioned copy is written to `public/apk/` (served for
download) and `config/appRelease.json` is updated, so `GET /admin/app-update/version` returns it.

Only put an APK here that you have tested: every user gets it as a mandatory update.
See `docs/APP_UPDATE_RELEASE.md`.
