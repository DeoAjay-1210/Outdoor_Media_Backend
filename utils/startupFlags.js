/**
 * SKIP_STARTUP_MAINTENANCE — when "true" (or "1"), server.js skips the database
 * maintenance routines it normally runs at boot and on cron. Unset / anything
 * else keeps the current behaviour.
 */
const isTrue = (v) => ["true", "1"].includes(String(v ?? "").trim().toLowerCase());

const skipStartupMaintenance = (env = process.env) => isTrue(env.SKIP_STARTUP_MAINTENANCE);

module.exports = { skipStartupMaintenance };
