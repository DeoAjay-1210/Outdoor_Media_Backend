# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # nodemon server.js — local dev, auto-restart
npm start         # node server.js — production
```

There is no lint/test tooling configured (`npm test` is an unimplemented stub). There is no build step — plain CommonJS, run directly by Node.

Docker (see `Dockerfile`, `docker-compose.yml`, `docker-compose.prod.yml`):
```bash
docker compose up                                          # local dev, hot reload
docker compose -f docker-compose.prod.yml up -d --build     # production
```

## Architecture

Express 5 + Mongoose API for OOH (Out-of-Home / billboard) media rental management. Entry point is `server.js`, which wires in DB connection, cron jobs, and routes in one file — there is no app factory/router aggregator.

**Layering**: `routes/Admin/<Feature>Routes/` → `controllers/Admin/<Feature>Controller/` → `models/Admin/<Feature>Schema/`. All current features live under the `Admin` namespace even though routes are mounted at `/admin`, `/gstdetails`, etc. (not always `/admin/*`) — check `server.js` for actual mount paths rather than assuming from folder names.

**Domain core**: `models/Admin/MediaOnboardingSchema/MediaOnboardingSchema.js` (~1700 lines) is the central model — media/hoarding onboarding, rental billing cycles, GST/TDS calculation, and overdue tracking all live here as schema statics/methods. `MediaSchema.statics.syncBillingCycles` is invoked both at server startup and on a daily cron (`node-cron`, `5 0 * * *` in `server.js`) to roll forward billing cycles — if billing/rental-due logic seems wrong, start here before the controllers.

**Auth**: OTP-based, not password login for end users (`controllers/Admin/UserController`). `userType` is a numeric enum on the `Users` model: `1 = Staff, 2 = Team Head, 3 = Owner` — authorization logic keys off this number, not string roles. `middleware/authMiddleware.js` verifies a JWT bearer token and attaches `{ userId, userType, userName }` to `req.user`; route-level protection is opt-in per router, not global. Separate staff/team-head self-registration is gated by shared passwords (`STAFF_REGISTER_PASSWORD`, `TEAMHEAD_REGISTER_PASSWORD` env vars), not per-user credentials.

**File uploads**: `middleware/dynamicFileUpload.js` exports a `createUploader(folderName, fieldFolderMap)` factory used per-route, backed by either local disk (`multer.diskStorage`) or DigitalOcean Spaces (`multer-s3`), switched by `STORAGE_TYPE` env var (`local` | `space`). Indexed multipart fields (e.g. `entries[0][invoice]`) are unwrapped to their base fieldname to resolve the destination folder. Always go through `processFile()` from this module to get the `{ filePath, fileType, ... }` shape stored on documents — don't hand-roll file metadata elsewhere.

**External integrations**: DigitalOcean Spaces (S3-compatible, `config/spaces.js`) for file storage, Nettyfish for SMS OTP delivery, Cloudinary (partial), MEON (GST filing) credentials, and SMTP-based email (mode-switchable via `MAIL_MODE=development|production` — development skips actually sending mail but still updates status fields).

**Response convention**: `utils/response.js` exports `successResponse(res, message, data, statusCode)` / `errorResponse(res, message, error, statusCode)` — controllers should use these rather than calling `res.json()` directly, for a consistent `{ success, statusCode, message, data|error }` envelope.

**Excel import/export**: `xlsx` / `xlsx-js-style` plus `utils/excelHelper.js` back the Excel-based rental/ledger routes (`RentalOOHExcelRoutes`, `MediaOnboardingExcelSchema`) — bulk data entry and styled report export live here, separate from the JSON API paths.
