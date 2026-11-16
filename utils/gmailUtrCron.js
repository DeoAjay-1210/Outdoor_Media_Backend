/**
 * Gmail UTR cron wiring (every 10 minutes by default).
 *
 *   GMAIL_UTR_CRON_ENABLED=true    start the schedule (default off)
 *   GMAIL_UTR_CRON_DRY_RUN         default TRUE. The cron only reads Gmail + MongoDB and logs what it WOULD save.
 *                                  Set to the word false to let it save — that still also needs
 *                                  GMAIL_UTR_SAVE_ENABLED=true (and GMAIL_UTR_CASH_SAVE_ENABLED=true for Cash).
 *   GMAIL_UTR_CRON                 schedule override, default "*\/10 * * * *"
 *
 * Not started when SKIP_STARTUP_MAINTENANCE is on. Each process reads ITS OWN environment, so a local
 * backend and the live backend are configured independently.
 */
const flagOn = (v) => String(v || "").toLowerCase() === "true";

/** true unless GMAIL_UTR_CRON_DRY_RUN is explicitly the word "false". */
const cronDryRun = (env = process.env) => String(env.GMAIL_UTR_CRON_DRY_RUN ?? "true").trim().toLowerCase() !== "false";

function startGmailUtrCron(cron, { env = process.env, processor, logger = console, skipMaintenance = false } = {}) {
  if (skipMaintenance || !flagOn(env.GMAIL_UTR_CRON_ENABLED)) return null;
  const run = processor || require("./utrProcessor");
  const expr = env.GMAIL_UTR_CRON || "*/10 * * * *";

  // the same function the local script and the schedule call; never throws into the scheduler
  const runOnce = async () => {
    try {
      return await run.processPendingUtrs({ triggeredBy: "cron", dryRun: cronDryRun(env) });
    } catch (err) {
      logger.error("[gmail-utr cron] failed:", err.message);
      return null;
    }
  };

  cron.schedule(expr, runOnce);
  const mode = cronDryRun(env) ? "DRY RUN (nothing is saved)" : flagOn(env.GMAIL_UTR_SAVE_ENABLED) ? "LIVE — SAVING IS ON" : "dry run (GMAIL_UTR_SAVE_ENABLED is off)";
  logger.log(`[startup] Gmail UTR cron is ON (${expr}) — ${mode}`);
  return { expr, runOnce, dryRun: cronDryRun(env) };
}

module.exports = { startGmailUtrCron, cronDryRun };
